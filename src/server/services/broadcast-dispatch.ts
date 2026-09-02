import { prisma } from '@/server/db';
import { kv } from '@/server/redis';
import { newId } from '@/lib/id';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { kstDateKey } from '@/lib/datetime';
import { getYouTubeAdapter, formatChatMessage } from '@/server/adapters/youtube';
import { buildTtsText } from '@/server/adapters/tts';
import { publishOverlayEvent, type OverlayEventPayload } from './overlay-bus';
import { resolveOverlayTier, type ResolvedTier } from './overlay-tiers';
import { decrypt, encrypt } from '@/lib/crypto';
import { broadcastDonorName } from '@/lib/donor-name';
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

/**
 * 유튜브 일일 할당량 가드. 실측 전까지 보수적으로 막는다.
 * 게임 참여 링크 전송(game-share)도 같은 카운터를 쓴다. 후원 알림과 할당량을 나눠 쓰는 것이
 * 맞다 — 둘 다 같은 API(liveChatMessages.insert)를 소비한다.
 */
export async function reserveYouTubeQuota(cost: number): Promise<boolean> {
  const key = `yt:quota:${kstDateKey()}`;
  const used = Number((await kv.get(key)) ?? 0);
  if (used + cost > env.youtube.dailyQuota) return false;
  await kv.set(key, String(used + cost), 60 * 60 * 30);
  return true;
}

export async function getYouTubeQuotaUsage() {
  const key = `yt:quota:${kstDateKey()}`;
  const used = Number((await kv.get(key)) ?? 0);
  return {
    used,
    total: env.youtube.dailyQuota,
    insertCost: env.youtube.insertQuotaCost,
    remainingMessages: Math.max(0, Math.floor((env.youtube.dailyQuota - used) / env.youtube.insertQuotaCost)),
  };
}

export async function dispatchBroadcast(donationId: string): Promise<DispatchResult> {
  const donation = await prisma.donation.findUnique({
    where: { id: donationId },
    include: { creator: { include: { overlaySetting: true, ttsSetting: true, youtubeConnection: true } } },
  });
  if (!donation) return { overlay: false, youtube: false };

  await prisma.donation.update({ where: { id: donationId }, data: { status: 'BROADCAST_PENDING' } });

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
  }

  // 방송 게임의 후원 자동 참여 · 목표 게이지 갱신.
  // 게임은 부가 기능이므로 어떤 실패도 후원 처리에 영향을 주지 않는다(서비스 내부에서 삼킨다).
  await joinFromDonation(donationId);
  await refreshDonationGauge(donation.creatorId);

  const allOk = overlayOk && yt.ok;
  await prisma.donation.update({
    where: { id: donationId },
    data: {
      status: allOk ? 'BROADCASTED' : 'PARTIAL_DELIVERY_FAILED',
      broadcastedAt: new Date(),
      statusReason: allOk ? null : `overlay=${overlayOk} youtube=${yt.ok}${yt.reason ? ` (${yt.reason})` : ''}`,
    },
  });
  await prisma.donationStatusLog.create({
    data: {
      id: newId(), donationId, fromStatus: 'BROADCAST_PENDING',
      toStatus: allOk ? 'BROADCASTED' : 'PARTIAL_DELIVERY_FAILED', actor: 'system',
    },
  });

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

async function sendYouTube(donationId: string): Promise<{ ok: boolean; reason?: string }> {
  const donation = await prisma.donation.findUnique({
    where: { id: donationId },
    include: { creator: { include: { youtubeConnection: true } } },
  });
  if (!donation) return { ok: false, reason: 'NOT_FOUND' };

  const conn = donation.creator.youtubeConnection;
  const delivery = await prisma.youTubeChatDelivery.create({
    data: { id: newId(), donationId, status: 'PENDING' },
  });

  const skip = async (reason: string) => {
    await prisma.youTubeChatDelivery.update({
      where: { id: delivery.id },
      data: { status: 'SKIPPED', errorCode: reason },
    });
    await prisma.donation.update({ where: { id: donationId }, data: { youtubeStatus: 'SKIPPED' } });
    return { ok: true, reason };
  };

  // EXPIRED 는 "이전 갱신이 한 번 실패했다"는 뜻일 뿐 영구 실패가 아니다.
  // (일시적인 네트워크 오류로 EXPIRED 가 되면 다시는 시도하지 않아 채팅 전송이 영영 멈춘다)
  // REVOKED / ERROR 는 사람이 다시 연결해야 하므로 시도하지 않는다.
  if (!conn || (conn.status !== 'CONNECTED' && conn.status !== 'EXPIRED')) return skip('NO_CONNECTION');

  const adapter = getYouTubeAdapter();

  // 액세스 토큰 만료 시 갱신. EXPIRED 상태면 만료 시각과 무관하게 한 번 더 갱신을 시도한다.
  let accessToken = decrypt(conn.accessTokenEnc);
  if (conn.status === 'EXPIRED' || conn.expiresAt.getTime() < Date.now() + 60_000) {
    const refreshed = await adapter.refresh(decrypt(conn.refreshTokenEnc));
    if (!refreshed.ok || !refreshed.data) {
      await prisma.youTubeConnection.update({
        where: { id: conn.id },
        data: { status: 'EXPIRED', lastError: refreshed.message ?? 'refresh 실패' },
      });
      return skip('TOKEN_REFRESH_FAILED');
    }
    accessToken = refreshed.data.accessToken;
    await prisma.youTubeConnection.update({
      where: { id: conn.id },
      data: {
        accessTokenEnc: encrypt(refreshed.data.accessToken),
        expiresAt: refreshed.data.expiresAt,
        status: 'CONNECTED',
        lastError: null,
      },
    });
  }

  // 조회 실패(API 오류)와 "방송 없음"은 원인이 완전히 다르다.
  //  - API_ERROR      : 우리 쪽/구글 쪽 문제. 로그와 lastError 로 추적해야 한다.
  //  - NO_ACTIVE_BROADCAST : 크리에이터가 방송 중이 아님. 정상 상황이다.
  const live = await adapter.findActiveBroadcast(accessToken);
  if (!live.ok) {
    await prisma.youTubeConnection
      .update({
        where: { id: conn.id },
        data: { lastError: live.message ?? '라이브 방송 조회 실패', lastCheckedAt: new Date() },
      })
      .catch(() => undefined);
    logger.warn('유튜브 라이브 방송 조회 실패', {
      donationId,
      code: live.code ?? null,
      message: live.message ?? null,
    });
    return skip('BROADCAST_LOOKUP_FAILED');
  }
  if (!live.data || !live.data.liveChatId) return skip('NO_ACTIVE_BROADCAST');

  const broadcast = await prisma.youTubeBroadcast.upsert({
    where: { creatorId_broadcastId: { creatorId: donation.creatorId, broadcastId: live.data.broadcastId } },
    create: {
      id: newId(),
      creatorId: donation.creatorId,
      broadcastId: live.data.broadcastId,
      liveChatId: live.data.liveChatId,
      title: live.data.title,
      lifeCycle: live.data.lifeCycleStatus,
      chatEnabled: live.data.chatEnabled,
      startedAt: live.data.startedAt ?? null,
    },
    update: { liveChatId: live.data.liveChatId, lifeCycle: live.data.lifeCycleStatus },
  });

  if (!(await reserveYouTubeQuota(env.youtube.insertQuotaCost))) {
    await prisma.youTubeChatDelivery.update({
      where: { id: delivery.id },
      data: { status: 'FAILED', broadcastId: broadcast.id, errorCode: 'QUOTA_EXCEEDED', errorMessage: '일일 할당량 초과' },
    });
    await prisma.donation.update({ where: { id: donationId }, data: { youtubeStatus: 'FAILED' } });
    logger.warn('유튜브 할당량 초과로 채팅 전송 보류', { donationId });
    return { ok: false, reason: 'QUOTA_EXCEEDED' };
  }

  const text = formatChatMessage({
    donorName: donation.displayName,
    amount: donation.amount,
    message: donation.message,
  });

  const res = await adapter.insertChatMessage(accessToken, live.data.liveChatId, text);
  await prisma.youTubeChatDelivery.update({
    where: { id: delivery.id },
    data: {
      status: res.ok ? 'SENT' : 'FAILED',
      broadcastId: broadcast.id,
      liveChatId: live.data.liveChatId,
      providerMessageId: res.data?.messageId ?? null,
      quotaUnits: res.data?.quotaUnits ?? env.youtube.insertQuotaCost,
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
