'use server';

import { logger } from '@/lib/logger';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { requireCreator, writeAudit } from '@/server/auth';
import { newId } from '@/lib/id';
import { env } from '@/lib/env';
import { accountTail4, decrypt, encrypt, generateToken, isValidResident, maskName, maskSecret, normalizeResident, tokenHash } from '@/lib/crypto';
import { sendTestOverlay } from '@/server/services/broadcast-dispatch';
import { OVERLAY_EFFECTS } from '@/server/services/overlay-tiers';
import { resolvePolicy } from '@/server/services/limits';
import { createSettlementRequest } from '@/server/services/settlement';
import { notifySuperAdmins, notifyUser } from '@/server/services/notifications';
import { formatWon } from '@/lib/money';
import { loadBannedWords } from '@/server/services/donation-flow';
import { THANKS_MT_MAX_LENGTH, THANKS_MT_VARIABLES } from '@/server/services/mt-templates';
import { bannedNeedle, filterContent } from '@/server/services/content-filter';
import { getYouTubeAdapter } from '@/server/adapters/youtube';
import {
  ensureYouTubeAccessToken,
  resolveActiveBroadcast,
  upsertBroadcastRow,
  invalidateBroadcastCache,
  revokeYouTubeConnection,
} from '@/server/services/youtube-connection';
import { getPublicBaseUrl } from '@/server/public-base-url';
import { bankName } from '@/components/studio/banks';
import { SNS_PLATFORMS, deriveLiveState, type SnsLinkState } from '@/lib/sns-platforms';

/**
 * 크리에이터 관리자(/studio) 서버 액션.
 *
 * 공통 규칙
 *  - 모든 액션은 requireCreator() 로 로그인/권한을 확인한다.
 *  - 대상 레코드의 creatorId 가 본인 것인지 반드시 재검증한 뒤에만 변경한다.
 *  - 입력은 zod 로 검증하고, 실패 사유는 사람이 읽을 수 있는 한국어로 반환한다.
 *  - 후원자 전화번호 원문/금융정보는 어떤 경로로도 반환하지 않는다.
 */

export interface StudioActionState {
  ok: boolean;
  message?: string;
  /** 1회만 노출하는 비밀값(오버레이 URL, 스트림 키). 저장하지 않는다. */
  secret?: string;
  secretLabel?: string;
  secretHint?: string;
}

type Handler = (creatorId: string, userId: string) => Promise<StudioActionState>;

async function withCreator(fn: Handler): Promise<StudioActionState> {
  let creatorId: string;
  let userId: string;
  try {
    const user = await requireCreator();
    creatorId = user.creatorId;
    userId = user.id;
  } catch (e) {
    return { ok: false, message: (e as Error).message || '크리에이터 권한이 필요합니다.' };
  }
  try {
    return await fn(creatorId, userId);
  } catch (e) {
    return { ok: false, message: userFacingError(e) };
  }
}

/**
 * 서비스 계층이 던진 한국어 안내문은 그대로 보여 주고,
 * Prisma/복호화 등 내부 오류 메시지는 로그로만 남기고 일반 문구로 바꾼다.
 */
function userFacingError(e: unknown): string {
  const message = (e as Error)?.message ?? '';
  const internal = !message || /prisma|invocation|decrypt|ECONNREFUSED|ETIMEDOUT/i.test(message) || !/[가-힣]/.test(message);
  if (internal) {
    logger.error('스튜디오 액션 처리 오류', { message });
    return '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
  }
  return message;
}

function text(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function checked(formData: FormData, key: string): boolean {
  return formData.get(key) != null;
}

function parseAmount(input: string): bigint | null {
  const v = input.replace(/[,\s원]/g, '');
  if (!/^\d{1,12}$/.test(v)) return null;
  return BigInt(v);
}

// ===========================================================================
// 후원자 차단 / 해제
// ===========================================================================

/** 본인 채널과 실제로 연결된 후원자인지 확인한다. */
async function assertDonorLinked(creatorId: string, donorId: string) {
  const [donation, link] = await Promise.all([
    prisma.donation.findFirst({ where: { creatorId, donorId }, select: { id: true } }),
    prisma.donorCreatorLink.findUnique({
      where: { donorId_creatorId: { donorId, creatorId } },
      select: { id: true },
    }),
  ]);
  if (!donation && !link) throw new Error('본인 채널과 연결된 후원자가 아닙니다.');
}

export async function blockDonorAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId, userId) => {
    const parsed = z
      .object({ donorId: z.string().min(1), reason: z.string().max(200).optional() })
      .safeParse({ donorId: text(formData, 'donorId'), reason: text(formData, 'reason') || undefined });
    if (!parsed.success) return { ok: false, message: '차단할 후원자 정보가 올바르지 않습니다.' };

    const { donorId, reason } = parsed.data;
    await assertDonorLinked(creatorId, donorId);

    await prisma.blockedDonor.upsert({
      where: { creatorId_donorId: { creatorId, donorId } },
      create: { id: newId(), creatorId, donorId, reason: reason ?? null, blockedBy: userId },
      update: { reason: reason ?? null, blockedBy: userId },
    });

    revalidatePath('/studio/moderation');
    revalidatePath('/studio/donations');
    // 동적 경로는 목록 경로 무효화로 갱신되지 않는다. 상세 화면의 차단 버튼이
    // 누른 뒤에도 그대로 남아 있던 원인이다.
    revalidatePath('/studio/donations/[id]', 'page');
    revalidatePath('/studio/messages');
    return { ok: true, message: '해당 후원자를 차단했습니다. 이후 문자는 후원으로 접수되지 않습니다.' };
  });
}

export async function unblockDonorAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId) => {
    const donorId = text(formData, 'donorId');
    if (!donorId) return { ok: false, message: '후원자 정보가 올바르지 않습니다.' };

    const deleted = await prisma.blockedDonor.deleteMany({ where: { creatorId, donorId } });
    if (deleted.count === 0) return { ok: false, message: '차단 목록에 없는 후원자입니다.' };

    revalidatePath('/studio/moderation');
    revalidatePath('/studio/donations');
    revalidatePath('/studio/donations/[id]', 'page');
    return { ok: true, message: '차단을 해제했습니다.' };
  });
}

// ===========================================================================
// 후원 상세 - 오버레이 테스트 재생
// ===========================================================================

/**
 * 후원 내용을 오버레이에 다시 띄운다.
 * 실제 송출 파이프라인(dispatchBroadcast)은 후원 상태를 다시 기록하므로 사용하지 않고,
 * 동일한 내용을 테스트 이벤트로만 재생한다.
 */
export async function replayOverlayTestAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId) => {
    const donationId = text(formData, 'donationId');
    if (!donationId) return { ok: false, message: '후원 정보가 올바르지 않습니다.' };

    const donation = await prisma.donation.findFirst({
      where: { id: donationId, creatorId },
      select: { amount: true, displayName: true, message: true, anonymous: true },
    });
    if (!donation) return { ok: false, message: '본인 채널의 후원 내역이 아닙니다.' };

    await sendTestOverlay(creatorId, {
      donorName: donation.anonymous ? '익명의 후원자' : donation.displayName,
      amount: donation.amount,
      message: donation.message,
    });

    return {
      ok: true,
      message: '오버레이에 테스트 재생을 보냈습니다. 실제 재송출이 아니며 후원 상태와 정산에는 반영되지 않습니다.',
    };
  });
}

// ===========================================================================
// 유튜브
// ===========================================================================

export async function disconnectYouTubeAction(
  _prev: StudioActionState,
  _formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId) => {
    const conn = await prisma.youTubeConnection.findUnique({ where: { creatorId } });
    if (!conn) return { ok: false, message: '연결된 유튜브 채널이 없습니다.' };

    // 상태만 REVOKED 로 바꾸면 구글 계정에는 권한이 그대로 남고 우리 DB 에도 복호화 가능한
    // 토큰이 남는다. 안내 문구("더 이상 사용되지 않습니다")와 실제 동작을 일치시킨다.
    const { providerRevoked } = await revokeYouTubeConnection({
      connectionId: conn.id,
      refreshTokenEnc: conn.refreshTokenEnc,
      reason: '크리에이터 연결 해제',
    });

    revalidatePath('/studio/youtube');
    revalidatePath('/studio');
    return {
      ok: true,
      message: providerRevoked
        ? '유튜브 채널 연결을 해제했습니다. 구글 쪽 권한도 회수했고 저장된 토큰은 폐기했습니다.'
        : '유튜브 채널 연결을 해제하고 저장된 토큰을 폐기했습니다. 구글 계정의 앱 권한은 구글 보안 설정에서 직접 해제해 주세요.',
    };
  });
}

export async function refreshYouTubeBroadcastAction(
  _prev: StudioActionState,
  _formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId) => {
    const conn = await prisma.youTubeConnection.findUnique({ where: { creatorId } });
    if (!conn) return { ok: false, message: '유튜브 채널이 연결되어 있지 않습니다.' };
    // EXPIRED 는 토큰 갱신이 한 번 실패했다는 뜻이다. 일시적인 오류였을 수 있으므로
    // 크리에이터가 이 버튼으로 직접 재시도할 수 있게 허용한다.
    // (REVOKED / ERROR 는 구글 쪽에서 권한이 회수된 상태라 재연결이 필요하다)
    if (conn.status === 'REVOKED' || conn.status === 'ERROR') {
      return { ok: false, message: '유튜브 연결 권한이 해제되었습니다. 채널을 다시 연결해 주세요.' };
    }

    const adapter = getYouTubeAdapter();

    // 갱신 로직은 services/youtube-connection.ts 한 곳에만 둔다.
    // 예전에는 이 화면·후원 송출·게임 공유 세 곳에 복제되어 있어, 동시에 호출되면
    // 서로의 액세스 토큰을 무효화했다.
    const token = await ensureYouTubeAccessToken(conn, adapter);
    if (!token.ok) {
      revalidatePath('/studio/youtube');
      return {
        ok: false,
        message: token.permanent
          ? '유튜브 연결 권한이 해제되었습니다. 채널을 다시 연결해 주세요.'
          : '액세스 토큰 갱신에 실패했습니다. 잠시 후 다시 시도해 보시고, 계속 실패하면 채널을 다시 연결해 주세요.',
      };
    }

    // 사용자가 직접 누른 조회다. 캐시를 비우고 실제로 다시 확인한다.
    await invalidateBroadcastCache(creatorId);
    const live = await resolveActiveBroadcast(creatorId, token.accessToken, adapter);
    if (!live.ok) {
      revalidatePath('/studio/youtube');
      if (live.reason === 'NO_ACTIVE_BROADCAST') {
        return { ok: true, message: '현재 진행 중인 라이브 방송이 없습니다.' };
      }
      if (live.reason === 'CHAT_DISABLED') {
        return { ok: false, message: '라이브 방송은 찾았지만 실시간 채팅이 꺼져 있습니다. 유튜브에서 채팅을 켜 주세요.' };
      }
      return { ok: false, message: `라이브 방송 조회에 실패했습니다. ${live.message ?? ''}`.trim() };
    }

    await prisma.youTubeConnection.update({
      where: { id: conn.id },
      data: { lastCheckedAt: new Date(), lastError: null },
    });
    await upsertBroadcastRow(creatorId, live.broadcast);

    revalidatePath('/studio/youtube');
    return {
      ok: true,
      message: `라이브 방송을 확인했습니다. 방송 ID ${live.broadcast.broadcastId}`,
    };
  });
}

// ===========================================================================
// 오버레이
// ===========================================================================

const POSITIONS = [
  'TOP_LEFT',
  'TOP_CENTER',
  'TOP_RIGHT',
  'BOTTOM_LEFT',
  'BOTTOM_CENTER',
  'BOTTOM_RIGHT',
] as const;

/** 음성 합성 제공사. browser = 오버레이 브라우저 음성, naver = 네이버 클로바 Voice 서버 합성 */
const TTS_PROVIDERS = ['browser', 'naver'] as const;

// ===========================================================================
// 온보딩 체크리스트 (수동 체크 항목)
// ===========================================================================

/** 크리에이터가 직접 체크하는 온보딩 항목. 서버가 자동 판별할 수 없는 두 가지다. */
const MANUAL_ONBOARDING_STEPS = {
  obsLinked: {
    field: 'onboardingObsLinked',
    done: 'OBS/프리즘에 오버레이 URL 등록을 완료로 표시했습니다.',
  },
  testDone: {
    field: 'onboardingTestDone',
    done: '테스트 후원 확인을 완료로 표시했습니다.',
  },
} as const;

type ManualOnboardingStep = keyof typeof MANUAL_ONBOARDING_STEPS;

function isManualOnboardingStep(v: string): v is ManualOnboardingStep {
  return Object.prototype.hasOwnProperty.call(MANUAL_ONBOARDING_STEPS, v);
}

/**
 * 온보딩 체크리스트의 수동 항목을 완료로 표시한다.
 * 화면 안내용 플래그일 뿐이며 결제·송출 동작에는 영향을 주지 않는다.
 */
export async function completeOnboardingStepAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId) => {
    const step = text(formData, 'step');
    if (!isManualOnboardingStep(step)) {
      return { ok: false, message: '알 수 없는 항목입니다. 화면을 새로고침한 뒤 다시 시도해 주세요.' };
    }

    const { field, done } = MANUAL_ONBOARDING_STEPS[step];
    await prisma.creatorProfile.update({ where: { id: creatorId }, data: { [field]: true } });

    revalidatePath('/studio');
    return { ok: true, message: done };
  });
}

/**
 * 브라우저 소스 URL 재발급.
 * tokenHash 만 저장하므로 원문 복구가 불가능하다. 발급 직후 1회만 전체 URL 을 반환한다.
 */
export async function regenerateOverlayTokenAction(
  _prev: StudioActionState,
  _formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId) => {
    const token = generateToken(24);
    const data = { tokenHash: tokenHash(token), tokenMasked: maskSecret(token) };

    await prisma.overlaySetting.upsert({
      where: { creatorId },
      create: { id: newId(), creatorId, ...data },
      update: data,
    });

    /**
     * 주소는 **요청 호스트 기준**으로 만든다.
     *
     * 예전에는 `env.baseUrl` 을 그대로 썼다. 터널(trycloudflare)이나 사내망 IP 로 접속해
     * 발급하면 `http://localhost:3025/...` 가 나와서 다른 PC 의 OBS 에서는 아예 열리지 않았다.
     * 후원 페이지 공유 URL 은 이미 요청 호스트를 반영하고 있어 기준도 서로 달랐다.
     */
    const baseUrl = await getPublicBaseUrl().catch(() => env.baseUrl);

    revalidatePath('/studio/overlay');
    return {
      ok: true,
      message: '새 브라우저 소스 URL을 발급했습니다. 기존 URL은 즉시 무효화되었습니다.',
      secret: `${baseUrl}/overlay/${creatorId}?token=${token}`,
      secretLabel: '브라우저 소스 URL (후원 알림)',
      secretHint: `이 값은 지금 한 번만 표시됩니다. 게임 오버레이는 같은 토큰으로 ${baseUrl}/overlay/${creatorId}/game?token=... 주소를 쓰면 됩니다.`,
    };
  });
}

export async function updateOverlaySettingAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId) => {
    const parsed = z
      .object({
        maxMessageLen: z.coerce.number().int().min(10).max(200),
        durationMs: z.coerce.number().int().min(2000).max(30000),
        position: z.enum(POSITIONS),
        theme: z.string().min(1).max(30),
        stickerSet: z.string().min(1).max(30),
        soundVolume: z.coerce.number().int().min(0).max(100),
      })
      .safeParse({
        maxMessageLen: text(formData, 'maxMessageLen'),
        durationMs: text(formData, 'durationMs'),
        position: text(formData, 'position'),
        theme: text(formData, 'theme'),
        stickerSet: text(formData, 'stickerSet'),
        soundVolume: text(formData, 'soundVolume') || '80',
      });
    if (!parsed.success) {
      return { ok: false, message: '입력값을 확인해 주세요. 최대 글자 수는 10~200자, 표시 시간은 2000~30000ms, 효과음 음량은 0~100 입니다.' };
    }

    const existing = await prisma.overlaySetting.findUnique({ where: { creatorId }, select: { id: true } });
    if (!existing) {
      return { ok: false, message: '오버레이 설정이 없습니다. 먼저 브라우저 소스 URL을 발급해 주세요.' };
    }

    await prisma.overlaySetting.update({
      where: { creatorId },
      data: {
        enabled: checked(formData, 'enabled'),
        showAmount: checked(formData, 'showAmount'),
        showMessage: checked(formData, 'showMessage'),
        anonymize: checked(formData, 'anonymize'),
        maxMessageLen: parsed.data.maxMessageLen,
        durationMs: parsed.data.durationMs,
        position: parsed.data.position,
        theme: parsed.data.theme,
        stickerSet: parsed.data.stickerSet,
        soundEnabled: checked(formData, 'soundEnabled'),
        soundVolume: parsed.data.soundVolume,
      },
    });

    // 간편 설정 폼에서만 TTS 값을 함께 보낸다(withTts=1).
    // 고급 설정 폼에는 이 필드가 없으므로 기존 동작은 그대로다.
    if (text(formData, 'withTts') === '1') {
      const tts = z
        .object({
          voice: z.string().max(120),
          speed: z.coerce.number().min(0.5).max(2),
          provider: z.enum(TTS_PROVIDERS),
        })
        .safeParse({
          voice: text(formData, 'ttsVoice'),
          speed: text(formData, 'ttsSpeed') || '1',
          provider: text(formData, 'ttsProvider') || 'browser',
        });
      if (!tts.success) {
        return { ok: false, message: '음성 설정값을 확인해 주세요. 속도는 0.5 ~ 2.0 사이입니다.' };
      }

      // 외부 TTS 인증 정보. 빈 칸으로 저장하면 기존 키를 그대로 둔다(원문은 다시 보여 주지 않는다).
      const naverClientId = text(formData, 'naverClientId').trim();
      const naverClientSecret = text(formData, 'naverClientSecret').trim();
      if ((naverClientId && !naverClientSecret) || (!naverClientId && naverClientSecret)) {
        return { ok: false, message: 'Client ID 와 Client Secret 을 함께 입력해 주세요.' };
      }
      if (naverClientId && !/^[A-Za-z0-9_-]{8,64}$/.test(naverClientId)) {
        return { ok: false, message: 'Client ID 형식을 확인해 주세요. 영문/숫자 8~64자입니다.' };
      }
      if (naverClientSecret && naverClientSecret.length > 200) {
        return { ok: false, message: 'Client Secret 이 너무 깁니다.' };
      }

      const existingTts = await prisma.ttsSetting.findUnique({
        where: { creatorId },
        select: { naverClientIdEnc: true },
      });
      if (tts.data.provider === 'naver' && !naverClientId && !existingTts?.naverClientIdEnc && !env.tts.naver.clientId) {
        return { ok: false, message: '네이버 클로바 Voice 를 쓰려면 Client ID 와 Client Secret 을 입력해 주세요.' };
      }

      const credential = naverClientId
        ? {
            naverClientIdEnc: encrypt(naverClientId),
            naverClientSecretEnc: encrypt(naverClientSecret),
            naverClientIdMasked: maskSecret(naverClientId),
          }
        : {};

      const ttsEnabled = checked(formData, 'ttsEnabled');
      await prisma.ttsSetting.upsert({
        where: { creatorId },
        // 간편 설정에는 최소 금액 항목이 없다. 새로 만들 때 0 으로 두어야
        // 화면의 [읽어주기] 스위치와 실제 동작이 어긋나지 않는다.
        // 이미 값이 있는 크리에이터의 최소 금액·글자수 설정은 건드리지 않는다.
        create: {
          id: newId(),
          creatorId,
          enabled: ttsEnabled,
          voice: tts.data.voice,
          speed: tts.data.speed,
          minAmount: 0n,
          provider: tts.data.provider,
          ...credential,
        },
        update: {
          enabled: ttsEnabled,
          voice: tts.data.voice,
          speed: tts.data.speed,
          provider: tts.data.provider,
          ...credential,
        },
      });
    }

    revalidatePath('/studio/overlay');
    return { ok: true, message: '오버레이 설정을 저장했습니다.' };
  });
}

/**
 * 테스트 후원·구간 미리보기에 쓸 표시 문구를 만든다.
 *
 * 실제 후원은 결제 전에 반드시 filterContent 를 거쳐 저장된 결과만 송출한다.
 * 그런데 이 두 경로는 입력을 그대로 발행하고 있었고, 그 이벤트는 미리보기 전용 채널이 아니라
 * **실제 방송용 SSE 연결로도** 나간다. 방송 중에 테스트를 누르면 크리에이터가 직접 등록한
 * 금칙어나 전화번호가 OBS 화면과 음성에 그대로 나오게 된다.
 *
 * 저장은 하지 않고 필터만 통과시켜, 실제 후원과 같은 기준으로 보이게 한다.
 */
async function previewSafeText(creatorId: string, donorName: string, message: string) {
  const rules = await loadBannedWords(creatorId);
  const name = filterContent(donorName, { bannedWords: rules, maxLength: 20 });
  const body = filterContent(message, { bannedWords: rules, maxLength: 200 });

  if (name.action === 'BLOCK' || body.action === 'BLOCK') {
    return { blocked: true as const };
  }
  return {
    blocked: false as const,
    donorName: name.clean,
    // filterContent 는 빈 문자열을 "(내용 없음)" 으로 바꾼다. 미리보기에서는 그냥 비워 둔다.
    message: body.clean === '(내용 없음)' ? '' : body.clean,
  };
}

export async function testOverlayAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId) => {
    const donorName = text(formData, 'donorName') || '테스트 후원자';
    const message = text(formData, 'message').slice(0, 200);
    const amount = parseAmount(text(formData, 'amount'));

    if (donorName.length > 20) return { ok: false, message: '표시명은 20자 이내로 입력해 주세요.' };
    if (amount === null) return { ok: false, message: '금액은 숫자만 입력해 주세요.' };
    if (amount < 100n || amount > 1_000_000n) return { ok: false, message: '테스트 금액은 100원 ~ 1,000,000원 사이로 입력해 주세요.' };

    const safe = await previewSafeText(creatorId, donorName, message);
    if (safe.blocked) {
      return { ok: false, message: '등록한 금칙어가 들어 있어 보내지 않았습니다. 실제 후원도 같은 기준으로 차단됩니다.' };
    }

    await sendTestOverlay(creatorId, { donorName: safe.donorName, amount, message: safe.message });
    return { ok: true, message: '테스트 후원을 전송했습니다. 실제 결제와 정산에는 반영되지 않습니다.' };
  });
}

// ===========================================================================
// 금액 구간별 오버레이 효과
// ===========================================================================

/** 한 크리에이터가 만들 수 있는 구간 수. 화면과 재생 모두 이 이상은 의미가 없다. */
const MAX_TIERS = 6;

const tierSchema = z.object({
  minAmount: z.coerce.number().int().min(100).max(10_000_000),
  label: z.string().trim().min(1).max(20),
  effect: z.enum(OVERLAY_EFFECTS),
  banner: z.boolean(),
  durationMs: z.coerce.number().int().min(2000).max(30000),
  ttsEnabled: z.boolean(),
  ttsVoice: z.string().max(120),
  ttsSpeed: z.coerce.number().min(0.5).max(2),
  ttsPitch: z.coerce.number().min(0).max(2),
});

/**
 * 금액 구간 저장.
 * 화면에서 행을 자유롭게 추가/삭제하므로 전체 목록을 통째로 바꾼다(삭제 후 삽입).
 * 구간을 모두 지우면 전역 표시 설정만으로 동작하는 기존 방식으로 돌아간다.
 */
export async function saveOverlayTiersAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId) => {
    let raw: unknown;
    try {
      raw = JSON.parse(text(formData, 'tiers') || '[]');
    } catch {
      return { ok: false, message: '구간 정보를 읽지 못했습니다. 화면을 새로고침한 뒤 다시 시도해 주세요.' };
    }

    const parsed = z.array(tierSchema).max(MAX_TIERS).safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        message:
          '구간 입력값을 확인해 주세요. 금액은 100원~10,000,000원, 이름은 20자 이내, 지속시간은 2000~30000ms 입니다.',
      };
    }

    const tiers = parsed.data;
    const amounts = tiers.map((t) => t.minAmount);
    if (new Set(amounts).size !== amounts.length) {
      return { ok: false, message: '같은 시작 금액을 가진 구간이 두 개 이상입니다. 금액을 서로 다르게 입력해 주세요.' };
    }

    await prisma.$transaction(async (tx) => {
      await tx.overlayTier.deleteMany({ where: { creatorId } });
      if (tiers.length === 0) return;
      await tx.overlayTier.createMany({
        data: tiers.map((t) => ({
          id: newId(),
          creatorId,
          minAmount: BigInt(t.minAmount),
          label: t.label,
          effect: t.effect,
          banner: t.banner,
          durationMs: t.durationMs,
          ttsEnabled: t.ttsEnabled,
          ttsVoice: t.ttsVoice,
          ttsSpeed: t.ttsSpeed,
          ttsPitch: t.ttsPitch,
        })),
      });
    });

    revalidatePath('/studio/overlay');
    return {
      ok: true,
      message:
        tiers.length === 0
          ? '구간을 모두 삭제했습니다. 이제 전역 표시 설정으로만 재생됩니다.'
          : `금액 구간 ${tiers.length}개를 저장했습니다.`,
    };
  });
}

/**
 * 구간 미리보기.
 * 저장된 구간을 금액으로 다시 찾아 재생하므로, 저장하지 않은 수정 내용은 반영되지 않는다.
 * 실제 결제/정산과는 무관한 테스트 이벤트다.
 */
export async function previewOverlayTierAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId) => {
    const amount = parseAmount(text(formData, 'amount'));
    if (amount === null) return { ok: false, message: '금액은 숫자만 입력해 주세요.' };
    if (amount < 100n || amount > 10_000_000n) {
      return { ok: false, message: '미리보기 금액은 100원 ~ 10,000,000원 사이로 입력해 주세요.' };
    }

    const donorName = text(formData, 'donorName').slice(0, 20) || '테스트 후원자';
    const message = text(formData, 'message').slice(0, 200) || '오늘 방송 재미있어요';

    const safe = await previewSafeText(creatorId, donorName, message);
    if (safe.blocked) {
      return { ok: false, message: '등록한 금칙어가 들어 있어 보내지 않았습니다. 실제 후원도 같은 기준으로 차단됩니다.' };
    }

    await sendTestOverlay(creatorId, { donorName: safe.donorName, amount, message: safe.message });
    return { ok: true, message: `${formatWon(amount)} 미리보기를 오버레이로 보냈습니다.` };
  });
}

// ===========================================================================
// 후원 설정
// ===========================================================================

export async function updateDonationSettingsAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId) => {
    const amount = parseAmount(text(formData, 'donationAmount'));
    if (amount === null) return { ok: false, message: '후원금은 숫자만 입력해 주세요.' };

    const [creator, policy] = await Promise.all([
      prisma.creatorProfile.findUnique({
        where: { id: creatorId },
        select: { minAmount: true, maxAmount: true },
      }),
      resolvePolicy(creatorId, null),
    ]);
    if (!creator) return { ok: false, message: '크리에이터 정보를 찾을 수 없습니다.' };

    // 유효 범위 = 관리자 지정 크리에이터 범위 ∩ 한도 정책 범위.
    // 정책 범위 밖 금액을 허용하면 후원 접수 시점에 AMOUNT_RANGE 로 전부 차단되므로 설정 단계에서 막는다.
    const effMin = creator.minAmount > policy.minAmount ? creator.minAmount : policy.minAmount;
    const effMax = creator.maxAmount < policy.maxAmount ? creator.maxAmount : policy.maxAmount;
    if (effMin > effMax) {
      return { ok: false, message: '관리자 설정과 한도 정책이 충돌해 설정할 수 있는 금액이 없습니다. 고객센터로 문의해 주세요.' };
    }
    if (amount < effMin || amount > effMax) {
      return {
        ok: false,
        message: `문자 1건당 후원금은 ${effMin.toString()}원 ~ ${effMax.toString()}원 사이에서만 설정할 수 있습니다.`,
      };
    }

    await prisma.creatorProfile.update({ where: { id: creatorId }, data: { donationAmount: amount } });
    revalidatePath('/studio/settings');
    revalidatePath('/studio');
    return { ok: true, message: '문자 1건당 후원금을 저장했습니다.' };
  });
}

// ===========================================================================
// 감사 문자 내용
// ===========================================================================

/** 감사 문자 본문에 허용하는 치환자 이름 */
const THANKS_TOKENS = THANKS_MT_VARIABLES.map((v) => v.token.slice(1, -1));

/**
 * 후원 감사 MT 문자 본문 저장.
 *
 * 검증 규칙
 *  - 200자 이내. 비우면 기본 문구로 돌아간다.
 *  - 링크(http/https/www) 금지. 감사 문자를 빌려 후원자를 외부로 유인하는 것을 막는다.
 *  - 정의되지 않은 치환자를 남기면 후원자에게 `{...}` 가 그대로 발송되므로 저장 단계에서 막는다.
 *  - 금칙어 필터는 후원자 메시지와 같은 규칙을 적용한다.
 */
export async function updateThanksMessageAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId) => {
    const raw = text(formData, 'thanksMtMessage');

    if (raw.length === 0) {
      await prisma.creatorProfile.update({ where: { id: creatorId }, data: { thanksMtMessage: null } });
      revalidatePath('/studio/settings');
      return { ok: true, message: '본문을 비워 두셔서 플랫폼 기본 문구로 발송됩니다.' };
    }

    if (raw.length > THANKS_MT_MAX_LENGTH) {
      return { ok: false, message: `감사 문자는 ${THANKS_MT_MAX_LENGTH}자 이내로 입력해 주세요. (현재 ${raw.length}자)` };
    }
    if (/https?:\/\/|www\./i.test(raw)) {
      return { ok: false, message: '감사 문자에는 링크를 넣을 수 없습니다. 링크가 포함된 문자는 스팸으로 차단됩니다.' };
    }

    const unknown = [...raw.matchAll(/\{([^{}]*)\}/g)]
      .map((m) => m[1])
      .filter((name) => !THANKS_TOKENS.includes(name));
    if (unknown.length > 0) {
      return {
        ok: false,
        // 크리에이터가 읽는 문구다. "치환자" 같은 개발 용어를 쓰지 않는다.
        message: `{${unknown[0]}} 는 없는 항목입니다. ${THANKS_MT_VARIABLES.map((v) => v.token).join(' ')} 만 쓸 수 있어요.`,
      };
    }

    // 후원자에게 발송되는 문구이므로 후원 메시지와 같은 금칙어 기준을 적용한다.
    const rules = await loadBannedWords(creatorId);
    const filtered = filterContent(raw, { bannedWords: rules, maxLength: THANKS_MT_MAX_LENGTH });
    if (filtered.action === 'BLOCK') {
      return {
        ok: false,
        message: `운영정책에 어긋나는 표현이 있어 저장할 수 없습니다.${filtered.reasons.length ? ` (${filtered.reasons.join(', ')})` : ''}`,
      };
    }
    if (filtered.containsPersonalInfo) {
      return { ok: false, message: '전화번호·계좌번호 등 개인정보는 감사 문자에 넣을 수 없습니다.' };
    }

    await prisma.creatorProfile.update({ where: { id: creatorId }, data: { thanksMtMessage: raw } });
    revalidatePath('/studio/settings');
    return { ok: true, message: '다음 후원부터 이 문구로 발송됩니다.' };
  });
}

// ===========================================================================
// 금칙어
// ===========================================================================

const WORD_ACTIONS = ['BLOCK', 'MASK', 'FLAG'] as const;

export async function createBannedWordAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId) => {
    const parsed = z
      .object({ word: z.string().trim().min(1).max(40), action: z.enum(WORD_ACTIONS) })
      .safeParse({ word: text(formData, 'word'), action: text(formData, 'action') });
    if (!parsed.success) return { ok: false, message: '금칙어는 1~40자로 입력하고 처리 방식을 선택해 주세요.' };

    const word = parsed.data.word;
    // 공백·구두점처럼 비교에서 무시하는 문자만으로 된 단어는 금칙어 구실을 못 한다.
    // (예전 정규식 구현에서는 이런 단어가 서버를 멈추게 만드는 입력이기도 했다)
    if (!bannedNeedle(word)) {
      return { ok: false, message: '공백이나 기호(. _ - * ~ = + /)만으로는 금칙어를 만들 수 없습니다.' };
    }

    const exists = await prisma.bannedWord.findFirst({ where: { creatorId, word, scope: 'CREATOR' } });
    if (exists) return { ok: false, message: '이미 등록된 금칙어입니다.' };

    await prisma.bannedWord.create({
      data: { id: newId(), word, action: parsed.data.action, scope: 'CREATOR', creatorId, active: true },
    });

    revalidatePath('/studio/moderation');
    return { ok: true, message: `금칙어 "${word}"를 등록했습니다.` };
  });
}

export async function toggleBannedWordAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId) => {
    const id = text(formData, 'id');
    const row = await prisma.bannedWord.findUnique({ where: { id }, select: { creatorId: true, scope: true, active: true } });
    if (!row || row.creatorId !== creatorId || row.scope !== 'CREATOR') {
      return { ok: false, message: '본인이 등록한 금칙어만 변경할 수 있습니다.' };
    }

    await prisma.bannedWord.update({ where: { id }, data: { active: !row.active } });
    revalidatePath('/studio/moderation');
    return { ok: true, message: row.active ? '금칙어를 사용 중지했습니다.' : '금칙어를 다시 사용합니다.' };
  });
}

export async function deleteBannedWordAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId) => {
    const id = text(formData, 'id');
    const row = await prisma.bannedWord.findUnique({ where: { id }, select: { creatorId: true, scope: true } });
    if (!row || row.creatorId !== creatorId || row.scope !== 'CREATOR') {
      return { ok: false, message: '본인이 등록한 금칙어만 삭제할 수 있습니다.' };
    }

    await prisma.bannedWord.delete({ where: { id } });
    revalidatePath('/studio/moderation');
    return { ok: true, message: '금칙어를 삭제했습니다.' };
  });
}

/** 자주 쓰는 기본 금칙어 세트(비속어 위주). 마스킹으로 등록한다. */
const DEFAULT_BANNED_WORDS = [
  '씨발', '시발', '개새끼', '병신', '지랄', '좆', '존나', '썅', '엿먹어', '닥쳐',
  '창녀', '보지', '자지', '섹스', '느금마', '니미', '꺼져', '죽어', '새끼',
];

/**
 * 기본 금칙어 세트를 한 번에 추가한다.
 * 이미 등록된 단어는 건너뛴다. 등록 후 개별로 처리 방식·사용 여부를 조정할 수 있다.
 */
export async function addDefaultBannedWordsAction(
  _prev: StudioActionState,
  _formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId) => {
    const existing = new Set(
      (await prisma.bannedWord.findMany({ where: { creatorId, scope: 'CREATOR' }, select: { word: true } })).map((w) => w.word),
    );
    const toAdd = DEFAULT_BANNED_WORDS.filter((w) => !existing.has(w));
    if (toAdd.length === 0) return { ok: true, message: '기본 금칙어가 이미 모두 등록되어 있습니다.' };

    await prisma.bannedWord.createMany({
      data: toAdd.map((word) => ({ id: newId(), word, action: 'MASK' as const, scope: 'CREATOR' as const, creatorId, active: true })),
    });
    revalidatePath('/studio/moderation');
    return { ok: true, message: `기본 금칙어 ${toAdd.length}개를 마스킹으로 추가했습니다. 필요에 따라 차단으로 바꿀 수 있습니다.` };
  });
}

/**
 * 금칙어 미리보기 — 입력 문장에 내 금칙어/전역 금칙어를 적용한 결과를 돌려준다.
 * 실제 후원을 만들지 않고 필터 결과만 확인한다.
 */
export async function testBannedWordsAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId) => {
    const sample = text(formData, 'sample');
    if (!sample) return { ok: false, message: '테스트할 문장을 입력해 주세요.' };

    const rules = await loadBannedWords(creatorId);
    const result = filterContent(sample, { bannedWords: rules, maxLength: 200 });

    const verdict =
      result.action === 'BLOCK'
        ? '차단됨 (이 문장은 후원으로 접수되지 않습니다)'
        : result.action === 'MASK'
          ? '마스킹 적용됨 (일부가 가려집니다)'
          : '통과 (그대로 노출됩니다)';

    return {
      ok: true,
      message: `[${verdict}] 노출 결과: "${result.clean}"${result.reasons.length ? ` · 적용: ${result.reasons.join(', ')}` : ''}`,
    };
  });
}

// ===========================================================================
// 정산
// ===========================================================================

export async function requestSettlementAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId) => {
    const amount = parseAmount(text(formData, 'amount'));
    if (amount === null || amount <= 0n) return { ok: false, message: '정산 요청 금액을 숫자로 입력해 주세요.' };

    const memo = text(formData, 'memo').slice(0, 200) || undefined;

    // 개인(사업소득 3.3% 원천징수) 크리에이터는 신고용 주민등록번호가 필수다.
    const residentRaw = text(formData, 'resident');
    const agreed = checked(formData, 'residentAgree');
    // 마스킹만 전송되는 재사용 케이스(값에 * 포함)는 신규 입력으로 취급하지 않는다.
    const isNewResident = residentRaw && !residentRaw.includes('*');

    // 이미 등록해 둔(파기 전) 주민번호가 있으면 재입력 없이 진행할 수 있다.
    const prior = await prisma.settlementRequest.findFirst({
      where: { creatorId, residentEnc: { not: null } },
      orderBy: { requestedAt: 'desc' },
      select: { residentEnc: true },
    });

    let resident: string | null = null;
    if (isNewResident) {
      if (!agreed) return { ok: false, message: '주민등록번호 수집·이용에 동의해 주세요.' };
      const norm = normalizeResident(residentRaw);
      if (!norm) return { ok: false, message: '주민등록번호 13자리를 정확히 입력해 주세요.' };
      if (!isValidResident(norm)) return { ok: false, message: '주민등록번호가 올바르지 않습니다. 다시 확인해 주세요.' };
      resident = norm;
    } else if (prior?.residentEnc) {
      // 기존 등록분을 재사용한다.
      resident = decrypt(prior.residentEnc);
    } else {
      return {
        ok: false,
        message: '원천징수 신고를 위해 주민등록번호를 입력하고 수집·이용에 동의해 주세요.',
      };
    }

    const created = await createSettlementRequest(creatorId, amount, { memo, resident });

    // 최고관리자에게 알린다.
    // 요청은 /admin/settlements 목록에 뜨지만, 아무도 통보받지 못하면
    // 관리자가 화면을 열어보기 전까지 지급이 그대로 밀린다.
    // 알림 실패가 요청 접수 자체를 되돌리면 안 되므로 예외는 삼킨다.
    const profile = await prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      select: { displayName: true, code: true },
    });
    await notifySuperAdmins({
      title: '새 정산 요청이 접수되었습니다',
      body: `${profile?.displayName ?? '크리에이터'}(${profile?.code ?? creatorId}) · 요청금 ${formatWon(created.amount)} · 실지급 예정 ${formatWon(created.payoutAmount)}`,
      linkUrl: '/admin/settlements',
    }).catch(() => undefined);

    revalidatePath('/studio/settlement');
    revalidatePath('/studio');
    return {
      ok: true,
      message: `정산 요청을 접수했습니다. 요청금 ${created.amount.toString()}원, 원천징수 ${created.withholding.toString()}원, 실지급 예정 ${created.payoutAmount.toString()}원입니다.`,
    };
  });
}

export async function saveSettlementAccountAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId, userId) => {
    const parsed = z
      .object({
        bankCode: z.string().min(2).max(4),
        account: z.string().regex(/^[0-9]{8,20}$/u, '계좌번호 형식이 올바르지 않습니다.'),
        holderName: z.string().trim().min(2).max(30),
      })
      .safeParse({
        bankCode: text(formData, 'bankCode'),
        account: text(formData, 'account').replace(/[-\s]/g, ''),
        holderName: text(formData, 'holderName'),
      });
    if (!parsed.success) {
      return { ok: false, message: '은행, 계좌번호(숫자 8~20자리), 예금주(2~30자)를 정확히 입력해 주세요.' };
    }

    const name = bankName(parsed.data.bankCode);
    if (!name) return { ok: false, message: '지원하지 않는 은행입니다.' };

    const data = {
      bankCode: parsed.data.bankCode,
      bankName: name,
      accountEnc: encrypt(parsed.data.account),
      accountTail4: accountTail4(parsed.data.account),
      holderNameEnc: encrypt(parsed.data.holderName),
      holderMasked: maskName(parsed.data.holderName),
      // 계좌 실명확인은 아직 mock 이다. 임의로 인증 성공 처리하지 않는다.
      verified: false,
      verifiedAt: null,
    };

    const before = await prisma.settlementAccount.findUnique({
      where: { creatorId },
      select: { bankCode: true, bankName: true, accountTail4: true, holderMasked: true, verified: true },
    });

    await prisma.settlementAccount.upsert({
      where: { creatorId },
      create: { id: newId(), creatorId, ...data },
      update: data,
    });

    /**
     * 돈이 나가는 계좌가 바뀌었다는 사실은 **반드시 흔적을 남긴다.**
     *
     * `SettlementAccount` 는 이력 테이블 없이 그 자리에서 덮어쓰는 구조라, 기록하지 않으면
     * "언제 어떤 계좌에서 무엇으로 바뀌었는지"가 어디에도 남지 않는다. 같은 테이블을 만지는
     * 관리자 경로에는 감사로그가 있는데 정작 당사자 경로에는 없었다.
     * 저장하는 값은 마스킹된 것만이다(은행코드 · 끝 4자리 · 예금주 마스킹).
     */
    await writeAudit({
      action: 'SETTLEMENT_ACCOUNT_UPDATE_BY_CREATOR',
      targetType: 'SettlementAccount',
      targetId: creatorId,
      before: before ?? null,
      after: {
        bankCode: data.bankCode,
        bankName: data.bankName,
        accountTail4: data.accountTail4,
        holderMasked: data.holderMasked,
        verified: false,
      },
    }).catch(() => undefined);

    // 계정 탈취로 계좌가 바뀌는 상황을 본인이 알아챌 수 있도록 알림을 남긴다.
    await notifyUser({
      userId,
      title: '정산 계좌가 변경되었습니다',
      body: `${data.bankName} ****${data.accountTail4} (예금주 ${data.holderMasked}) 로 변경되었습니다. 본인이 하지 않았다면 즉시 비밀번호를 바꾸고 고객센터로 문의해 주세요.`,
      linkUrl: '/studio/settlement?tab=account',
    }).catch(() => undefined);

    revalidatePath('/studio/settlement/account');
    revalidatePath('/studio/settlement');
    return {
      ok: true,
      message: '정산 계좌를 저장했습니다. 예금주 실명확인은 통합 관리자 승인 후 완료됩니다. 변경 사실은 알림으로도 안내됩니다.',
    };
  });
}

// ===========================================================================
// 프로필
// ===========================================================================

/** http(s) 주소 또는 사이트 내 경로(/로 시작)를 허용하는 이미지 주소 검증 */
const imageUrlSchema = z.union([
  z.literal(''),
  z.url(),
  z.string().regex(/^\/[^\s]*$/u, '이미지 주소는 http(s) 주소 또는 / 로 시작하는 경로여야 합니다.'),
]);

export async function updateCreatorProfileAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId) => {
    // 소개(description)는 후원샵 관리에서만 수정한다.
    // 여기서 함께 저장하면 프로필만 저장했을 때 후원샵 소개가 지워진다.
    const parsed = z
      .object({
        displayName: z.string().trim().min(1).max(30),
        channelName: z.string().trim().max(50),
        avatarUrl: imageUrlSchema,
      })
      .safeParse({
        displayName: text(formData, 'displayName'),
        channelName: text(formData, 'channelName'),
        avatarUrl: text(formData, 'avatarUrl'),
      });
    if (!parsed.success) {
      return {
        ok: false,
        message:
          '표시명(1~30자), 채널명(50자 이내)을 확인하고 아바타 주소는 http(s) 주소 또는 / 로 시작하는 경로로 입력해 주세요.',
      };
    }

    await prisma.creatorProfile.update({
      where: { id: creatorId },
      data: {
        displayName: parsed.data.displayName,
        channelName: parsed.data.channelName || null,
        avatarUrl: parsed.data.avatarUrl || null,
      },
    });

    revalidatePath('/studio/profile');
    revalidatePath('/studio');
    return { ok: true, message: '프로필을 저장했습니다.' };
  });
}

/**
 * 후원 페이지 설정 (배너 · 소개).
 *
 * 라이브 링크와 방송중 스위치는 **SNS·라이브 탭**(updateSnsLinksAction)으로 분리했다.
 * 한 폼에 같이 두면 배너만 바꾸려고 저장했을 때 폼에 없는 라이브 필드가 함께 덮여 꺼진다.
 */
export async function updateDonationPageAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId) => {
    const bannerPreset = text(formData, 'bannerPreset');
    const parsed = z
      .object({
        bannerUrl: imageUrlSchema,
        description: z.string().trim().max(300),
      })
      .safeParse({
        bannerUrl: text(formData, 'bannerUrl'),
        description: text(formData, 'description'),
      });
    if (!parsed.success) {
      return {
        ok: false,
        message: '배너 주소는 http(s) 주소 또는 / 로 시작하는 경로, 소개는 300자 이내로 입력해 주세요.',
      };
    }

    // 기본 배너 프리셋을 골랐으면 프리셋을, '직접 입력'이면 입력한 주소를 사용한다.
    if (bannerPreset && bannerPreset !== 'custom' && !/^\/banners\/[a-z0-9-]+\.png$/.test(bannerPreset)) {
      return { ok: false, message: '배너 선택 값이 올바르지 않습니다.' };
    }
    const bannerUrl =
      bannerPreset === 'custom' ? parsed.data.bannerUrl || null : bannerPreset ? bannerPreset : null;

    await prisma.creatorProfile.update({
      where: { id: creatorId },
      data: { bannerUrl, description: parsed.data.description || null },
    });

    revalidatePath('/studio/settings');
    revalidatePath('/studio/profile');
    revalidatePath('/studio');
    revalidatePath('/c');
    return { ok: true, message: '후원페이지 설정을 저장했습니다.' };
  });
}

// ===========================================================================
// SNS 링크 · 플랫폼별 방송중 스위치
// ===========================================================================

/**
 * SNS 링크와 플랫폼별 "지금 방송 중" 스위치를 저장한다.
 *
 * 링크는 방송 여부와 무관하게 후원 페이지에 버튼으로 노출된다. 스위치를 켠 플랫폼은
 * 프로필에 ON AIR 배지가 붙고, 배지를 누르면 그 주소로 이동한다.
 * 유튜브와 인스타에 동시송출하는 크리에이터가 있으므로 스위치는 여러 개를 켤 수 있다.
 *
 * liveOn / livePlatform / liveUrl 은 여기서 파생시켜 함께 저장한다(deriveLiveState).
 * 네 컬럼을 매번 OR 로 묶게 하면 한 화면만 빠뜨려도 서로 어긋나기 때문이다.
 */
export async function updateSnsLinksAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withCreator(async (creatorId) => {
    const links: SnsLinkState[] = [];

    for (const platform of SNS_PLATFORMS) {
      const url = text(formData, platform.urlField);
      const live = checked(formData, platform.liveField);

      if (url.length > 300) {
        return { ok: false, message: `${platform.label} 링크가 너무 깁니다. 300자 이내로 입력해 주세요.` };
      }
      // 엉뚱한 주소가 저장되면 후원자가 빈 페이지로 이동한다. 호스트까지 확인한다.
      if (url && !platform.test(url)) {
        return { ok: false, message: `${platform.label} 링크는 ${platform.hostHint} 주소만 사용할 수 있습니다.` };
      }
      // 스위치만 켜고 주소가 없으면 배지가 갈 곳이 없다.
      if (live && !url) {
        return {
          ok: false,
          message: `${platform.label} 방송중 스위치를 켜려면 ${platform.label} 링크를 먼저 입력해 주세요.`,
        };
      }

      links.push({ platform, url, live });
    }

    const derived = deriveLiveState(links);
    const byField = (field: SnsLinkState['platform']['urlField']) =>
      links.find((l) => l.platform.urlField === field);

    await prisma.creatorProfile.update({
      where: { id: creatorId },
      data: {
        youtubeLiveUrl: byField('youtubeLiveUrl')?.url || null,
        instagramLiveUrl: byField('instagramLiveUrl')?.url || null,
        tiktokLiveUrl: byField('tiktokLiveUrl')?.url || null,
        facebookLiveUrl: byField('facebookLiveUrl')?.url || null,
        youtubeLive: Boolean(byField('youtubeLiveUrl')?.live),
        instagramLive: Boolean(byField('instagramLiveUrl')?.live),
        tiktokLive: Boolean(byField('tiktokLiveUrl')?.live),
        facebookLive: Boolean(byField('facebookLiveUrl')?.live),
        liveOn: derived.liveOn,
        livePlatform: derived.livePlatform,
        liveUrl: derived.liveUrl,
      },
    });

    revalidatePath('/studio/settings');
    revalidatePath('/studio/profile');
    revalidatePath('/studio');

    const liveLabels = links.filter((l) => l.live).map((l) => l.platform.label);
    return {
      ok: true,
      message:
        liveLabels.length > 0
          ? `SNS 링크를 저장했습니다. ${liveLabels.join(' · ')} 방송중 표시가 켜졌습니다.`
          : 'SNS 링크를 저장했습니다. 방송중 표시는 모두 꺼져 있습니다.',
    };
  });
}
