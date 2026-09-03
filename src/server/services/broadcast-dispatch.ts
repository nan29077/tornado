import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { getYouTubeAdapter, formatChatMessage } from '@/server/adapters/youtube';
import { buildTtsText } from '@/server/adapters/tts';
import { publishOverlayEvent, type OverlayEventPayload } from './overlay-bus';
import { resolveOverlayTier, type ResolvedTier } from './overlay-tiers';
import { broadcastDonorName } from '@/lib/donor-name';
import {
  ensureYouTubeAccessToken,
  resolveActiveBroadcast,
  upsertBroadcastRow,
  invalidateBroadcastCache,
} from './youtube-connection';
import { reserveYouTubeQuota, releaseYouTubeQuota, getYouTubeQuotaUsage } from './youtube-quota';
import { normalizeTtsProvider } from './tts/naver';
import { clampOverlayLayout } from '@/lib/overlay-layout';
import { joinFromDonation, refreshDonationGauge } from '@/server/services/games';

/**
 * 결제 성공 건의 방송 전송.
 *
 * 원칙
 *  - 결제 성공 이후에만 호출된다.
 *  - 유튜브 전송 실패가 결제 결과를 바꾸지 않는다.
 *  - 오버레이/유튜브/TTS 각각의 결과를 따로 기록한다.
 */

export interface DispatchResult {
  overlay: boolean;
  youtube: boolean;
  youtubeSkippedReason?: string;
}

// 할당량 관리는 services/youtube-quota.ts 로 옮겼다(원자적 가감산 · 태평양시 기준 · 실패 시 반환).
// 기존 호출부의 import 경로를 바꾸지 않아도 되도록 여기서 다시 내보낸다.
export { reserveYouTubeQuota, releaseYouTubeQuota, getYouTubeQuotaUsage };

/**
 * 송출 시작 전 상태 선점.
 *
 * 무조건 UPDATE 하면 안 된다. 유튜브 왕복(수 초~수십 초) 사이에 후원자가 환불을 요청하면
 * `requestRefund` 가 REFUND_REQUESTED 를 선점하는데, 그 뒤에 이 함수가 상태를 덮어써
 * "환불 요청이 접수됐는데 후원은 송출완료"인 모순이 생긴다.
 */
const DISPATCHABLE_FROM = ['SETTLEMENT_PENDING', 'BROADCAST_PENDING'] as const;

export async function dispatchBroadcast(donationId: string): Promise<DispatchResult> {
  const donation = await prisma.donation.findUnique({
    where: { id: donationId },
    include: { creator: { include: { overlaySetting: true, ttsSetting: true, youtubeConnection: true } } },
  });
  if (!donation) return { overlay: false, youtube: false };

  const claimed = await prisma.donation.updateMany({
    where: { id: donationId, status: { in: [...DISPATCHABLE_FROM] } },
    data: { status: 'BROADCAST_PENDING' },
  });
  if (claimed.count === 0) {
    // 환불 요청 등으로 이미 다른 상태로 넘어갔다. 송출 상태를 건드리지 않는다.
    logger.warn('송출 시작 시점에 후원 상태가 이미 바뀌어 있어 건너뜁니다.', {
      donationId,
      status: donation.status,
    });
    return { overlay: false, youtube: false, youtubeSkippedReason: 'STATUS_CHANGED' };
  }
  const fromStatus = donation.status;

  // 각 송출은 독립이다. 한쪽이 예외를 던져도 나머지를 계속 시도하고,
  // 아래 상태 확정(BROADCASTED / PARTIAL_DELIVERY_FAILED)은 **반드시** 수행한다.
  // 예외가 그대로 새어 나가면 후원이 BROADCAST_PENDING 에 영구히 고착되어
  // 결제는 끝났는데 정산 대기로 넘어가지 않는다.
  let overlayOk = false;
  try {
    overlayOk = await sendOverlay(donationId);
  } catch (e) {
    logger.error('오버레이 송출 오류 (결제는 정상 완료)', { donationId, message: (e as Error).message });
    await prisma.donation
      .update({ where: { id: donationId }, data: { overlayStatus: 'FAILED' } })
      .catch(() => undefined);
  }

  let yt: { ok: boolean; reason?: string } = { ok: false, reason: 'NOT_ATTEMPTED' };
  try {
    yt = await sendYouTube(donationId);
  } catch (e) {
    logger.error('유튜브 송출 오류 (결제는 정상 완료)', { donationId, message: (e as Error).message });
    yt = { ok: false, reason: 'DISPATCH_ERROR' };
    await prisma.donation
      .update({ where: { id: donationId }, data: { youtubeStatus: 'FAILED' } })
      .catch(() => undefined);
    await prisma.youTubeChatDelivery
      .updateMany({
        where: { donationId, status: 'PENDING' },
        data: { status: 'FAILED', errorCode: 'DISPATCH_ERROR', errorMessage: (e as Error).message },
      })
      .catch(() => undefined);
  }

  const allOk = overlayOk && yt.ok;
  // 상태 확정도 조건부다. 송출 중에 환불 요청이 들어왔다면 그쪽이 이긴다.
  const finalized = await prisma.donation.updateMany({
    where: { id: donationId, status: 'BROADCAST_PENDING' },
    data: {
      status: allOk ? 'BROADCASTED' : 'PARTIAL_DELIVERY_FAILED',
      broadcastedAt: new Date(),
      statusReason: allOk ? null : `overlay=${overlayOk} youtube=${yt.ok}${yt.reason ? ` (${yt.reason})` : ''}`,
    },
  });
  if (finalized.count > 0) {
    await prisma.donationStatusLog.create({
      data: {
        id: newId(), donationId, fromStatus: 'BROADCAST_PENDING',
        toStatus: allOk ? 'BROADCASTED' : 'PARTIAL_DELIVERY_FAILED', actor: 'system',
      },
    });
  } else {
    logger.warn('송출 도중 후원 상태가 바뀌어 상태 확정을 건너뜁니다(송출 결과는 각 필드에 기록됨).', {
      donationId,
      fromStatus,
    });
  }

  // 방송 게임의 후원 자동 참여 · 목표 게이지 갱신.
  // 게임은 부가 기능이므로 어떤 실패도 후원 처리에 영향을 주지 않는다(서비스 내부에서 삼킨다).
  // **상태 확정 뒤에** 둔다. 참여자 수만 명인 회차에서 집계가 느려지면 그만큼
  // 후원 상태 확정이 밀리기 때문이다.
  await joinFromDonation(donationId);
  await refreshDonationGauge(donation.creatorId);

  return { overlay: overlayOk, youtube: yt.ok, youtubeSkippedReason: yt.reason };
}

/**
 * 오버레이·TTS 에 쓸 후원자 표시명.
 *
 * 규칙 자체는 lib/donor-name.ts 에 둔다. 닉네임 설정 화면의 "이렇게 표시됩니다"
 * 미리보기가 같은 함수를 봐야, 후원자가 화면에서 약속받은 이름과 실제 방송에
 * 뜨는 이름이 어긋나지 않는다. (후원 원장의 displayName 은 그대로 둔다)
 */
const overlayDonorName = broadcastDonorName;

/** 효과음 재생값. 설정이 없으면 기본(켜짐 / 80)으로 본다. */
function soundOf(overlay: { soundEnabled: boolean; soundVolume: number } | null) {
  return {
    soundEnabled: overlay?.soundEnabled ?? true,
    soundVolume: Math.min(100, Math.max(0, overlay?.soundVolume ?? 80)),
  };
}

/**
 * 배너 표시값(테마 · 위치 · 최대 글자 수 · 표시 스위치).
 *
 * 오버레이 페이지는 한 번 열면 방송이 끝날 때까지 그대로 떠 있으므로, 페이지를 열 때 읽은
 * 값만 쓰면 스튜디오에서 테마·위치를 바꿔 저장해도 새로 고침 전까지 반영되지 않는다.
 * 이벤트마다 현재 값을 실어 보내 브라우저 소스를 다시 로드하지 않아도 적용되게 한다.
 */
function displayOf(
  overlay:
    | {
        theme: string;
        position: string;
        maxMessageLen: number;
        enabled: boolean;
        offsetX: number;
        offsetY: number;
        scalePct: number;
      }
    | null,
) {
  const layout = clampOverlayLayout(overlay);
  return {
    theme: overlay?.theme || 'TORNADO',
    position: overlay?.position || 'BOTTOM_CENTER',
    maxMessageLen: overlay?.maxMessageLen ?? 80,
    enabled: overlay?.enabled ?? true,
    ...layout,
  };
}

/**
 * 금액 구간과 전역 설정을 합쳐 오버레이 재생값을 정한다.
 * 구간이 없으면 전역 설정만으로 기존과 동일하게 동작한다.
 */
function mergeTier(
  tier: ResolvedTier | null,
  overlay: { durationMs: number; stickerSet: string } | null,
): { effect: string; banner: boolean; durationMs: number; tierLabel: string } {
  return {
    effect: tier?.effect ?? overlay?.stickerSet ?? 'DEFAULT',
    banner: tier ? tier.banner : true,
    durationMs: tier?.durationMs ?? overlay?.durationMs ?? 7000,
    tierLabel: tier?.label ?? '',
  };
}

/**
 * TTS 재생값.
 *  - 금액 구간이 있으면 구간의 on/off · 목소리 · 속도 · 피치를 따른다.
 *  - 구간이 없으면 기존처럼 TtsSetting 의 enabled + minAmount 로 판단한다.
 *  - 문장 구성 규칙(이름/금액 읽기, 최대 글자수)은 항상 TtsSetting 을 따른다.
 */
function buildTts(
  tier: ResolvedTier | null,
  tts: {
    enabled: boolean; voice: string; speed: number; volume: number;
    readAmount: boolean; readName: boolean; minAmount: bigint; maxChars: number;
  } | null,
  input: { donorName: string; amount: bigint; message: string },
): OverlayEventPayload['tts'] {
  const enabled = tier ? tier.ttsEnabled : Boolean(tts?.enabled) && input.amount >= (tts?.minAmount ?? 0n);
  if (!enabled) return null;

  return {
    enabled: true,
    text: buildTtsText({
      donorName: input.donorName,
      amount: input.amount,
      message: input.message,
      readAmount: tts?.readAmount ?? true,
      readName: tts?.readName ?? true,
      maxChars: tts?.maxChars ?? 80,
    }),
    voice: (tier?.ttsVoice || tts?.voice) ?? '',
    speed: tier?.ttsSpeed ?? tts?.speed ?? 1,
    pitch: tier?.ttsPitch ?? 1,
    volume: tts?.volume ?? 1,
  };
}

export async function buildOverlayPayload(donationId: string, isTest = false): Promise<OverlayEventPayload | null> {
  const donation = await prisma.donation.findUnique({
    where: { id: donationId },
    include: { creator: { include: { overlaySetting: true, ttsSetting: true } } },
  });
  if (!donation) return null;

  const overlay = donation.creator.overlaySetting;
  const tts = donation.creator.ttsSetting;
  const donorName =
    overlay?.anonymize || donation.anonymous ? '익명의 후원자' : overlayDonorName(donation.displayName);
  const message = overlay?.showMessage === false ? '' : donation.message;

  const tier = await resolveOverlayTier(donation.creatorId, donation.amount);
  const merged = mergeTier(tier, overlay);

  return {
    eventId: newId(),
    creatorId: donation.creatorId,
    donationId: donation.id,
    donorName,
    amount: overlay?.showAmount === false ? '' : donation.amount.toString(),
    message,
    sticker: overlay?.stickerSet ?? 'DEFAULT',
    effect: merged.effect,
    banner: merged.banner,
    tierLabel: merged.tierLabel,
    tts: buildTts(tier, tts, { donorName, amount: donation.amount, message }),
    ttsMode: normalizeTtsProvider(tts?.provider) === 'naver' ? 'server' : 'browser',
    ...soundOf(overlay),
    durationMs: merged.durationMs,
    ...displayOf(overlay),
    occurredAt: new Date().toISOString(),
    isTest,
  };
}

async function sendOverlay(donationId: string): Promise<boolean> {
  const payload = await buildOverlayPayload(donationId);
  if (!payload) return false;

  const setting = await prisma.overlaySetting.findUnique({ where: { creatorId: payload.creatorId } });
  if (setting && !setting.enabled) {
    await prisma.donation.update({ where: { id: donationId }, data: { overlayStatus: 'SKIPPED' } });
    return true;
  }

  await prisma.overlayEvent.create({
    data: {
      id: payload.eventId,
      creatorId: payload.creatorId,
      donationId,
      payload: payload as unknown as object,
      status: 'SENT',
      playedAt: new Date(),
    },
  });
  publishOverlayEvent(payload);
  await prisma.donation.update({ where: { id: donationId }, data: { overlayStatus: 'SENT' } });
  return true;
}

/**
 * 유튜브 전송이 "다시 시도할 가치가 있는 실패"인지.
 * 일시적 실패만 재시도 대상으로 남기고, 영구 실패는 그대로 확정한다.
 */
export function isRetryableYouTubeFailure(code: string | null | undefined): boolean {
  const c = (code ?? '').toLowerCase();
  if (!c) return true;
  if (['quota_exceeded', 'ratelimitexceeded', 'backenderror', 'internalerror', 'servererror', 'dispatch_error', 'send_failed', 'broadcast_lookup_failed'].includes(c)) {
    return true;
  }
  // 권한/설정 문제는 사람이 고쳐야 한다.
  if (['forbidden', 'livechatdisabled', 'livechatended', 'livechatnotfound', 'invalid_grant', 'unauthorized'].includes(c)) {
    return false;
  }
  return true;
}

/**
 * 유튜브 라이브 채팅 전송.
 *
 * 반환값의 `ok` 는 **후원 상태 확정(BROADCASTED / PARTIAL_DELIVERY_FAILED)에 쓰인다.**
 * 그래서 "방송 중이 아님"처럼 정상적인 건너뜀만 ok:true 이고,
 * 조회 실패·토큰 갱신 실패 같은 **진짜 오류는 ok:false** 여야 한다.
 * (예전에는 오류도 ok:true 였고, 유튜브 장애가 나도 관리자 화면의 실패 건수가 0으로 보였다)
 */
export async function sendYouTube(donationId: string): Promise<{ ok: boolean; reason?: string }> {
  const donation = await prisma.donation.findUnique({
    where: { id: donationId },
    include: { creator: { include: { youtubeConnection: true } } },
  });
  if (!donation) return { ok: false, reason: 'NOT_FOUND' };

  const conn = donation.creator.youtubeConnection;
  // 재시도 시 같은 후원에 delivery 행이 여러 개 생기지 않도록 후원당 1건으로 고정한다.
  const delivery = await prisma.youTubeChatDelivery.upsert({
    where: { donationId },
    create: { id: newId(), donationId, status: 'PENDING' },
    update: { status: 'PENDING', errorCode: null, errorMessage: null },
  });

  /** 정상적인 건너뜀. 결제·송출 상태를 오염시키지 않는다. */
  const skip = async (reason: string) => {
    await prisma.youTubeChatDelivery.update({
      where: { id: delivery.id },
      data: { status: 'SKIPPED', errorCode: reason },
    });
    await prisma.donation.update({ where: { id: donationId }, data: { youtubeStatus: 'SKIPPED' } });
    return { ok: true, reason };
  };

  /** 실제 오류. 실패로 기록하고 상위에서 PARTIAL_DELIVERY_FAILED 로 확정되게 한다. */
  const failure = async (reason: string, message?: string) => {
    await prisma.youTubeChatDelivery.update({
      where: { id: delivery.id },
      data: { status: 'FAILED', errorCode: reason, errorMessage: message ?? null },
    });
    await prisma.donation.update({ where: { id: donationId }, data: { youtubeStatus: 'FAILED' } });
    return { ok: false, reason };
  };

  if (!conn) return skip('NO_CONNECTION');

  const adapter = getYouTubeAdapter();

  const token = await ensureYouTubeAccessToken(conn, adapter);
  if (!token.ok) {
    // 연결이 아예 없거나 사람이 다시 연결해야 하는 상태는 "건너뜀"이 맞다.
    // 반면 일시적 갱신 실패는 실패로 남겨야 재시도 대상이 되고 지표에도 잡힌다.
    if (token.reason === 'NO_CONNECTION') return skip('NO_CONNECTION');
    if (token.permanent) return skip('TOKEN_REVOKED');
    return failure('TOKEN_REFRESH_FAILED', token.message);
  }

  const live = await resolveActiveBroadcast(donation.creatorId, token.accessToken, adapter);
  if (!live.ok) {
    // NO_ACTIVE_BROADCAST(방송 중 아님) · CHAT_DISABLED(채팅 꺼짐)는 정상 상황이다.
    if (live.reason === 'NO_ACTIVE_BROADCAST') return skip('NO_ACTIVE_BROADCAST');
    if (live.reason === 'CHAT_DISABLED') return skip('CHAT_DISABLED');
    // 방송 조회 자체가 할당량을 쓴다. 소진 상태에서는 조회 단계에서 먼저 걸리므로,
    // 이유를 조회 실패로 뭉개지 말고 그대로 올린다(재시도 판정과 운영 대응이 다르다).
    if (live.reason === 'QUOTA_EXCEEDED') return failure('QUOTA_EXCEEDED', live.message);
    return failure('BROADCAST_LOOKUP_FAILED', live.message);
  }

  const broadcast = await upsertBroadcastRow(donation.creatorId, live.broadcast);
  const liveChatId = live.broadcast.liveChatId!;

  const quota = { cost: env.youtube.insertQuotaCost, creatorId: donation.creatorId, purpose: 'donation' as const };
  if (!(await reserveYouTubeQuota(quota))) {
    await prisma.youTubeChatDelivery.update({
      where: { id: delivery.id },
      data: { status: 'FAILED', broadcastId: broadcast.id, errorCode: 'QUOTA_EXCEEDED', errorMessage: '일일 할당량 초과' },
    });
    await prisma.donation.update({ where: { id: donationId }, data: { youtubeStatus: 'FAILED' } });
    logger.warn('유튜브 할당량 초과로 채팅 전송 보류', { donationId });
    return { ok: false, reason: 'QUOTA_EXCEEDED' };
  }

  // 오버레이와 **같은 표시 규칙**을 적용한다.
  // 유튜브 라이브 채팅은 이 서비스에서 가장 공개적인 경로다. 익명 후원인데 실명이,
  // 금액·메시지 숨김인데 원문이 그대로 올라가면 되돌릴 수 없다.
  const overlay = await prisma.overlaySetting.findUnique({ where: { creatorId: donation.creatorId } });
  const donorName =
    overlay?.anonymize || donation.anonymous ? '익명의 후원자' : overlayDonorName(donation.displayName);
  const chatMessage = overlay?.showMessage === false ? '' : donation.message;
  const text = formatChatMessage({
    donorName,
    amount: donation.amount,
    message: chatMessage,
    hideAmount: overlay?.showAmount === false,
  });

  const res = await adapter.insertChatMessage(token.accessToken, liveChatId, text);
  if (!res.ok) {
    // 보내지 못했으면 선점한 예산을 되돌린다. 되돌리지 않으면 장애 시간 동안
    // 한 건도 못 보냈는데 그날 예산만 사라진다.
    await releaseYouTubeQuota(quota);
    // 채팅방 자체가 사라진 경우라면 캐시를 버려야 다음 건에서 새 방송을 찾는다.
    const code = (res.code ?? '').toLowerCase();
    if (code.includes('livechat')) await invalidateBroadcastCache(donation.creatorId);
  }

  await prisma.youTubeChatDelivery.update({
    where: { id: delivery.id },
    data: {
      status: res.ok ? 'SENT' : 'FAILED',
      broadcastId: broadcast.id,
      liveChatId,
      providerMessageId: res.data?.messageId ?? null,
      quotaUnits: res.ok ? res.data?.quotaUnits ?? env.youtube.insertQuotaCost : 0,
      attempts: { increment: 1 },
      errorCode: res.ok ? null : res.code ?? 'ERROR',
      errorMessage: res.ok ? null : res.message ?? null,
      sentAt: res.ok ? new Date() : null,
    },
  });
  await prisma.donation.update({
    where: { id: donationId },
    data: { youtubeStatus: res.ok ? 'SENT' : 'FAILED' },
  });

  return res.ok ? { ok: true } : { ok: false, reason: res.code ?? 'SEND_FAILED' };
}

/**
 * 일시적 사유로 실패한 유튜브 전송을 다시 시도한다.
 *
 * 예전에는 재시도가 **전혀 없었다.** 유튜브가 몇 분간 5xx/429 를 내면 그 시간대의 후원
 * 채팅이 통째로 유실됐고 `attempts` 는 영원히 1이었다. 결제는 정상이므로 후원자만 손해다.
 *
 * 원칙
 *  - 일시적 실패(할당량·5xx·네트워크)만 다시 시도한다. 권한·설정 문제는 사람이 고쳐야 한다.
 *  - 방송이 이미 끝났으면 다시 보내지 않는다(뒤늦게 다른 방송에 올라가면 더 나쁘다).
 *  - 시도 횟수 상한을 둔다. 무한 재시도는 할당량만 태운다.
 *  - 결제·정산 상태는 건드리지 않는다. 송출 축은 결제 축과 분리되어 있다.
 */
export async function retryFailedYouTubeDeliveries(now = new Date()): Promise<number> {
  const MAX_ATTEMPTS = 3;
  const RETRY_AFTER_MS = 3 * 60_000;
  const GIVE_UP_AFTER_MS = 60 * 60_000;

  const candidates = await prisma.youTubeChatDelivery.findMany({
    where: {
      status: 'FAILED',
      attempts: { lt: MAX_ATTEMPTS },
      createdAt: { lt: new Date(now.getTime() - RETRY_AFTER_MS), gt: new Date(now.getTime() - GIVE_UP_AFTER_MS) },
    },
    select: { id: true, donationId: true, errorCode: true },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  let count = 0;
  for (const d of candidates) {
    if (!isRetryableYouTubeFailure(d.errorCode)) continue;
    try {
      const res = await sendYouTube(d.donationId);
      if (res.ok) count += 1;
    } catch (e) {
      logger.warn('유튜브 전송 재시도 실패', { donationId: d.donationId, message: (e as Error).message });
    }
  }
  if (count > 0) logger.info('유튜브 전송 재시도 성공', { count });
  return count;
}

/**
 * 테스트 후원: 실제 결제/정산에 반영하지 않고 화면과 TTS 만 확인한다.
 * 금액에 해당하는 금액 구간이 그대로 적용되므로, 구간별 미리보기는
 * 해당 구간의 최소 금액으로 이 함수를 호출하면 된다.
 */
export async function sendTestOverlay(
  creatorId: string,
  input: { donorName: string; amount: bigint; message: string },
) {
  const creator = await prisma.creatorProfile.findUnique({
    where: { id: creatorId },
    include: { overlaySetting: true, ttsSetting: true },
  });
  if (!creator) throw new Error('크리에이터를 찾을 수 없습니다.');

  const overlay = creator.overlaySetting;
  const tier = await resolveOverlayTier(creatorId, input.amount);
  const merged = mergeTier(tier, overlay);

  // 테스트는 "실제 방송에 나갈 화면"을 그대로 보여 주는 것이 목적이므로
  // 익명 처리 · 금액 표시 · 메시지 표시 설정을 실제 후원과 똑같이 적용한다.
  const donorName = overlay?.anonymize ? '익명의 후원자' : input.donorName;
  const message = overlay?.showMessage === false ? '' : input.message;

  const payload: OverlayEventPayload = {
    eventId: newId(),
    creatorId,
    donationId: null,
    donorName,
    amount: overlay?.showAmount === false ? '' : input.amount.toString(),
    message,
    sticker: overlay?.stickerSet ?? 'DEFAULT',
    effect: merged.effect,
    banner: merged.banner,
    tierLabel: merged.tierLabel,
    tts: buildTts(tier, creator.ttsSetting, { ...input, donorName, message }),
    ttsMode: normalizeTtsProvider(creator.ttsSetting?.provider) === 'naver' ? 'server' : 'browser',
    ...soundOf(overlay),
    durationMs: merged.durationMs,
    ...displayOf(overlay),
    occurredAt: new Date().toISOString(),
    isTest: true,
  };

  // 발행이 먼저다.
  //
  // 예전에는 overlay_event 기록을 먼저 await 했다. 그러면 DB 가 느린 환경(로컬 PGlite,
  // 디스크가 바쁜 윈도우 등)에서 그 쓰기 시간이 그대로 미리보기 지연으로 나타난다.
  // [테스트 후원 보내기]를 눌러도 한참 뒤에야 효과가 뜨는 원인이 이것이다.
  // SSE 발행은 메모리 연산이라 즉시 끝나므로 먼저 내보내고, 기록은 뒤에서 이어서 한다.
  publishOverlayEvent(payload);

  try {
    await prisma.overlayEvent.create({
      data: {
        id: payload.eventId, creatorId, payload: payload as unknown as object,
        status: 'SENT', isTest: true, playedAt: new Date(),
      },
    });
  } catch (e) {
    // DB 기록 실패해도 이미 발행된 SSE 이벤트는 유효하다.
    // 개발 DB 스키마 불일치 등으로 create 가 throw 해도 미리보기는 동작해야 한다.
    console.error('[overlay] overlayEvent 기록 실패 (SSE 발행은 완료됨)', e);
  }
  return payload;
}
