import { prisma } from '@/server/db';
import { encrypt, decrypt, maskSecret } from '@/lib/crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import type { Prisma } from '@/generated/prisma/client';

/**
 * 플랫폼 전역 TTS 연동 설정.
 *
 * 왜 필요한가
 * -----------
 * 예전에는 클로바 Voice 키를 넣는 곳이 두 군데뿐이었다.
 *   1) `.env` 의 `NAVER_TTS_*` — 바꾸려면 파일을 고치고 **서버를 재시작**해야 한다.
 *   2) 크리에이터별 스튜디오 설정 — 크리에이터 한 명 한 명이 직접 키를 발급받아야 한다.
 * 그래서 "도네이도가 계약한 키 하나로 전 크리에이터에게 음성을 제공한다"는, 가장 흔한 운영
 * 방식을 화면에서 설정할 방법이 없었다. 관리자 TTS 화면에도 제공사를 고르는 칸이 아예 없어
 * 연동 자체가 불가능해 보였다.
 *
 * 이제 이 설정 하나로 전 크리에이터에게 즉시 적용된다. 서버 재시작이 필요 없다.
 *
 * 저장 위치
 * ---------
 * `system_setting` 테이블의 한 행(key = `tts.platform`)에 JSON 으로 넣는다.
 * 전역 설정 하나 때문에 테이블을 새로 만들지 않는다.
 *
 * 키 취급
 * -------
 * Client ID / Secret 은 **암호화해서만** 저장하고, 화면에는 마스킹 값만 돌려준다.
 * 이 모듈은 복호화된 값을 서버 안에서만 쓰고 절대 화면 응답에 담지 않는다.
 */

export const PLATFORM_TTS_KEY = 'tts.platform';

export type PlatformTtsProvider = 'browser' | 'naver';

/** 화면에 그대로 내보내도 안전한 형태 (원문 키 없음). */
export interface PlatformTtsView {
  provider: PlatformTtsProvider;
  /**
   * 크리에이터가 제공사·키를 따로 정할 수 있는지.
   *
   * false 로 두면 크리에이터 화면에서 무엇을 골랐든 **전역 설정이 이긴다.**
   * 크리에이터에게 남는 선택지는 음성(화자)·속도뿐이다.
   */
  allowCreatorOverride: boolean;
  /** 기본 화자 (클로바 speaker 이름) */
  speaker: string;
  /** 화면 표시용 마스킹 Client ID. 원문은 돌려주지 않는다. */
  clientIdMasked: string | null;
  /** 전역 키가 저장되어 있는지 */
  hasCredentials: boolean;
  /** 전역 설정이 저장된 적이 있는지. false 면 아래 값들은 환경변수에서 온 기본값이다. */
  configured: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface StoredPlatformTts {
  provider?: string;
  allowCreatorOverride?: boolean;
  speaker?: string;
  clientIdEnc?: string | null;
  clientSecretEnc?: string | null;
  clientIdMasked?: string | null;
  updatedAt?: string | null;
  updatedBy?: string | null;
}

function normalizeProvider(value: unknown): PlatformTtsProvider {
  return String(value ?? '').toLowerCase() === 'naver' ? 'naver' : 'browser';
}

async function readStored(): Promise<StoredPlatformTts | null> {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: PLATFORM_TTS_KEY } });
    if (!row) return null;
    // Json 컬럼이라 어떤 모양이든 들어올 수 있다. 객체가 아니면 없는 것으로 본다.
    if (typeof row.value !== 'object' || row.value === null || Array.isArray(row.value)) return null;
    return row.value as StoredPlatformTts;
  } catch (e) {
    // 설정 조회 실패로 TTS 화면 전체가 죽으면 안 된다. 환경변수 기본값으로 되돌아간다.
    logger.warn('전역 TTS 설정 조회 실패', { message: (e as Error).message });
    return null;
  }
}

/** 화면용 조회. 저장된 값이 없으면 환경변수(.env) 기준을 그대로 보여 준다. */
export async function getPlatformTtsView(): Promise<PlatformTtsView> {
  const stored = await readStored();

  if (!stored) {
    const envHasKey = Boolean(env.tts.naver.clientId && env.tts.naver.clientSecret);
    return {
      // 환경변수에 키가 있으면 지금도 클로바로 합성되고 있다는 뜻이다. 그대로 보여 준다.
      provider: envHasKey ? 'naver' : 'browser',
      allowCreatorOverride: true,
      speaker: env.tts.naver.speaker || 'nara',
      clientIdMasked: envHasKey ? maskSecret(env.tts.naver.clientId) : null,
      hasCredentials: envHasKey,
      configured: false,
      updatedAt: null,
      updatedBy: null,
    };
  }

  return {
    provider: normalizeProvider(stored.provider),
    allowCreatorOverride: stored.allowCreatorOverride !== false,
    speaker: stored.speaker || env.tts.naver.speaker || 'nara',
    clientIdMasked: stored.clientIdMasked ?? null,
    hasCredentials: Boolean(stored.clientIdEnc && stored.clientSecretEnc),
    configured: true,
    updatedAt: stored.updatedAt ?? null,
    updatedBy: stored.updatedBy ?? null,
  };
}

export interface SavePlatformTtsInput {
  provider: PlatformTtsProvider;
  allowCreatorOverride: boolean;
  speaker: string;
  /** 빈 값이면 기존 키를 그대로 둔다(마스킹만 보고 다시 입력하게 만들지 않는다). */
  clientId: string | null;
  clientSecret: string | null;
  adminUserId: string;
}

export async function savePlatformTtsSetting(input: SavePlatformTtsInput): Promise<PlatformTtsView> {
  const prev = (await readStored()) ?? {};

  // 키를 비워 보내면 "지우기" 가 아니라 "그대로 두기" 다.
  // 지우려면 제공사를 브라우저로 되돌리면 된다. 마스킹만 보고 저장을 눌렀다가
  // 키가 사라져 전 크리에이터의 음성이 끊기는 사고를 막는다.
  const clientIdEnc = input.clientId ? encrypt(input.clientId) : (prev.clientIdEnc ?? null);
  const clientSecretEnc = input.clientSecret ? encrypt(input.clientSecret) : (prev.clientSecretEnc ?? null);
  const clientIdMasked = input.clientId ? maskSecret(input.clientId) : (prev.clientIdMasked ?? null);

  if (input.provider === 'naver' && !(clientIdEnc && clientSecretEnc)) {
    throw new Error(
      '클로바 Voice 로 전환하려면 Client ID 와 Client Secret 을 모두 입력해야 합니다. ' +
        '키 없이 전환하면 전 크리에이터의 음성이 즉시 끊깁니다.',
    );
  }

  const value: StoredPlatformTts = {
    provider: input.provider,
    allowCreatorOverride: input.allowCreatorOverride,
    speaker: input.speaker || 'nara',
    clientIdEnc,
    clientSecretEnc,
    clientIdMasked,
    updatedAt: new Date().toISOString(),
    updatedBy: input.adminUserId,
  };

  // Json 컬럼에는 undefined 를 넣을 수 없다. 위에서 모든 필드를 명시적으로 채웠으므로
  // 남는 undefined 는 없지만, 타입상 안전하게 InputJsonObject 로 좁혀서 넘긴다.
  const json = value as unknown as Prisma.InputJsonObject;

  await prisma.systemSetting.upsert({
    where: { key: PLATFORM_TTS_KEY },
    create: {
      key: PLATFORM_TTS_KEY,
      value: json,
      memo: '전역 TTS 연동 설정 (관리자 화면에서 관리)',
      updatedBy: input.adminUserId,
    },
    update: { value: json, updatedBy: input.adminUserId },
  });

  return getPlatformTtsView();
}

export interface PlatformTtsRuntime {
  provider: PlatformTtsProvider;
  allowCreatorOverride: boolean;
  speaker: string;
  credentials: { clientId: string; clientSecret: string } | null;
}

/**
 * 서버 합성 경로에서 쓰는 실효 설정. 복호화된 키가 들어 있으므로 **응답에 담지 말 것.**
 *
 * 저장된 전역 설정이 없으면 환경변수를 그대로 쓴다(기존 동작 유지).
 */
export async function getPlatformTtsRuntime(): Promise<PlatformTtsRuntime> {
  const stored = await readStored();
  const envCred =
    env.tts.naver.clientId && env.tts.naver.clientSecret
      ? { clientId: env.tts.naver.clientId, clientSecret: env.tts.naver.clientSecret }
      : null;

  if (!stored) {
    return {
      provider: envCred ? 'naver' : 'browser',
      allowCreatorOverride: true,
      speaker: env.tts.naver.speaker || 'nara',
      credentials: envCred,
    };
  }

  let credentials = envCred;
  if (stored.clientIdEnc && stored.clientSecretEnc) {
    try {
      credentials = {
        clientId: decrypt(stored.clientIdEnc),
        clientSecret: decrypt(stored.clientSecretEnc),
      };
    } catch (e) {
      // 암호화 키가 바뀌면 복호화가 깨진다. 환경변수 키로 되돌아가고 원문은 로그에 남기지 않는다.
      logger.warn('전역 TTS 키 복호화 실패', { message: (e as Error).message });
    }
  }

  return {
    provider: normalizeProvider(stored.provider),
    allowCreatorOverride: stored.allowCreatorOverride !== false,
    speaker: stored.speaker || env.tts.naver.speaker || 'nara',
    credentials,
  };
}
