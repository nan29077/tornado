import { prisma } from '@/server/db';
import { decrypt } from '@/lib/crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { getPlatformTtsRuntime } from '@/server/services/tts-platform';

/**
 * 네이버 클로바 Voice(Premium) 서버 합성 어댑터.
 *
 * 규칙
 *  - 키가 없으면 성공 처리하지 않는다. 호출부는 실패 시 브라우저 합성으로 되돌아간다.
 *  - 키 원문은 로그에 남기지 않는다.
 *  - 결제/정산과 무관하다. 합성 실패가 후원 상태를 바꾸지 않는다.
 */

const ENDPOINT = 'https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts';

/** 합성 요청 타임아웃. 방송 알림이므로 오래 기다리지 않는다. */
const TIMEOUT_MS = 8000;

export interface NaverTtsCredentials {
  clientId: string;
  clientSecret: string;
}

export interface NaverTtsRequest {
  text: string;
  /** 클로바 화자 이름. 비우면 nara */
  speaker?: string;
  /** 도네이도 기준 배속(0.5 ~ 2.0) */
  speed?: number;
  /** 도네이도 기준 음량(0 ~ 1) */
  volume?: number;
  /** 도네이도 기준 피치(0 ~ 2, 1 이 기본) */
  pitch?: number;
}

export interface NaverTtsResult {
  ok: boolean;
  audio?: ArrayBuffer;
  code?: string;
  message?: string;
}

/** 클로바 파라미터 범위(-5 ~ 5)로 옮긴다. 값이 클수록 느리고/크고/높다. */
function toClovaScale(value: number, base: number, invert = false): number {
  if (!Number.isFinite(value)) return 0;
  const delta = (value - base) * 5;
  const scaled = Math.round(invert ? -delta : delta);
  return Math.min(5, Math.max(-5, scaled));
}

/**
 * 클로바 화자 이름만 통과시킨다.
 * TtsSetting.voice 에는 브라우저 음성 이름(예: "Microsoft Heami")이 들어 있을 수 있는데,
 * 그대로 speaker 로 보내면 합성이 통째로 실패한다. 형식이 다르면 기본 화자를 쓴다.
 */
export function normalizeSpeaker(value: string | null | undefined): string {
  const v = (value || '').trim();
  return /^[a-z][a-z0-9_-]{1,19}$/.test(v) ? v : '';
}

/**
 * 클로바 인증 정보 결정.
 *
 * 우선순위는 **전역 설정의 `개별 설정 허용` 스위치**가 정한다.
 *  - 허용 꺼짐 : 전역 키만 쓴다. 크리에이터가 넣어 둔 키가 있어도 무시한다.
 *    (도네이도가 계약한 키 하나로 전 채널을 운영하는 기본 형태)
 *  - 허용 켜짐 : 크리에이터 키 → 전역 키 → 환경변수 순으로 찾는다.
 *
 * 예전에는 크리에이터 키 → 환경변수 두 단계뿐이었다. 화면에서 설정할 수 있는 전역 키가
 * 아예 없었기 때문에, 관리자가 클로바를 연동하려면 `.env` 를 고치고 서버를 재시작해야 했다.
 */
export async function resolveNaverCredentials(creatorId: string): Promise<NaverTtsCredentials | null> {
  const platform = await getPlatformTtsRuntime();

  // 개별 설정을 막아 둔 경우, 크리에이터 키는 아예 읽지 않는다.
  if (!platform.allowCreatorOverride) {
    return platform.credentials;
  }

  const setting = await prisma.ttsSetting.findUnique({
    where: { creatorId },
    select: { naverClientIdEnc: true, naverClientSecretEnc: true },
  });

  if (setting?.naverClientIdEnc && setting.naverClientSecretEnc) {
    try {
      return {
        clientId: decrypt(setting.naverClientIdEnc),
        clientSecret: decrypt(setting.naverClientSecretEnc),
      };
    } catch (e) {
      logger.warn('클로바 Voice 키 복호화 실패', { creatorId, message: (e as Error).message });
    }
  }

  if (platform.credentials) return platform.credentials;

  const { clientId, clientSecret } = env.tts.naver;
  if (clientId && clientSecret) return { clientId, clientSecret };
  return null;
}

/** 값이 없거나 모르는 값이면 브라우저 합성으로 본다. */
export function normalizeTtsProvider(value: string | null | undefined): 'browser' | 'naver' {
  return (value || '').toLowerCase() === 'naver' ? 'naver' : 'browser';
}

/**
 * 이 크리에이터에게 **실제로 적용되는** TTS 제공사.
 *
 * 관리자 전역 설정이 개별 설정을 막아 두었으면 전역 값이 이긴다.
 * 화면 표시와 실제 합성 경로가 같은 함수를 봐야, "관리자 화면에는 클로바인데 실제로는
 * 브라우저 음성으로 나가는" 어긋남이 생기지 않는다.
 */
export async function resolveEffectiveTtsProvider(creatorId: string): Promise<'browser' | 'naver'> {
  const platform = await getPlatformTtsRuntime();
  if (!platform.allowCreatorOverride) return platform.provider;

  const setting = await prisma.ttsSetting.findUnique({
    where: { creatorId },
    select: { provider: true },
  });
  // 크리에이터가 아직 고르지 않았으면(기본값 browser) 전역 설정을 기본값으로 삼는다.
  if (!setting || !setting.provider || setting.provider === 'browser') return platform.provider;
  return normalizeTtsProvider(setting.provider);
}

/** 클로바 Voice 합성. 성공하면 mp3 바이너리를 돌려준다. */
export async function synthesizeWithNaver(
  cred: NaverTtsCredentials,
  req: NaverTtsRequest,
): Promise<NaverTtsResult> {
  const text = (req.text || '').trim();
  if (!text) return { ok: false, code: 'EMPTY_TEXT', message: '읽을 문장이 없습니다.' };
  if (!cred.clientId || !cred.clientSecret) {
    return { ok: false, code: 'NO_CREDENTIALS', message: '클로바 Voice 인증 정보가 없습니다.' };
  }

  const body = new URLSearchParams({
    speaker: normalizeSpeaker(req.speaker) || normalizeSpeaker(env.tts.naver.speaker) || 'nara',
    // 클로바는 값이 클수록 느리다. 도네이도 배속(클수록 빠름)과 방향이 반대다.
    speed: String(toClovaScale(req.speed ?? 1, 1, true)),
    volume: String(toClovaScale(req.volume ?? 1, 1)),
    pitch: String(toClovaScale(req.pitch ?? 1, 1, true)),
    format: 'mp3',
    text,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'X-NCP-APIGW-API-KEY-ID': cred.clientId,
        'X-NCP-APIGW-API-KEY': cred.clientSecret,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!res.ok) {
      // 오류 본문에는 키가 들어 있지 않다. 원인 파악을 위해 앞부분만 남긴다.
      const detail = await res.text().catch(() => '');
      logger.warn('클로바 Voice 합성 실패', { status: res.status, detail: detail.slice(0, 200) });
      return { ok: false, code: `HTTP_${res.status}`, message: '클로바 Voice 합성에 실패했습니다.' };
    }

    const audio = await res.arrayBuffer();
    if (audio.byteLength === 0) {
      return { ok: false, code: 'EMPTY_AUDIO', message: '합성 결과가 비어 있습니다.' };
    }
    return { ok: true, audio };
  } catch (e) {
    const message = (e as Error).name === 'AbortError' ? '클로바 Voice 응답 시간 초과' : (e as Error).message;
    logger.warn('클로바 Voice 호출 오류', { message });
    return { ok: false, code: 'REQUEST_FAILED', message };
  } finally {
    clearTimeout(timer);
  }
}
