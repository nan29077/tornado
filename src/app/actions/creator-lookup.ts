'use server';

import { prisma } from '@/server/db';
import { kv } from '@/server/redis';
import { headers } from 'next/headers';
import { normalizeCreatorCode } from '@/lib/id';
import { clientIpFrom } from '@/server/rate-limit';
import { getSessionUser } from '@/server/auth';
import { logger } from '@/lib/logger';

/**
 * 크리에이터 검색 / 코드 조회.
 * - 코드(TOR-XXXX)뿐 아니라 크리에이터 이름·유튜브 채널명으로도 검색할 수 있다.
 * - 무차별 탐색을 막기 위해 IP 단위 요청 제한을 유지하고, 결과는 최대 8건까지만 반환한다.
 * - 승인(APPROVED)된 크리에이터만 노출한다.
 */

const WINDOW_SEC = 60;
const MAX_TRIES = 20;

export interface CreatorSearchItem {
  code: string;
  userId: string;
  displayName: string;
  channelName: string | null;
  avatarUrl: string | null;
  avatarIndex: number;
}

const creatorSearchSelect = {
  code: true,
  userId: true,
  displayName: true,
  channelName: true,
  avatarUrl: true,
  user: { select: { avatarIndex: true } },
} as const;

function toSearchItem(creator: {
  code: string;
  userId: string;
  displayName: string;
  channelName: string | null;
  avatarUrl: string | null;
  user: { avatarIndex: number };
}): CreatorSearchItem {
  return {
    code: creator.code,
    userId: creator.userId,
    displayName: creator.displayName,
    channelName: creator.channelName,
    avatarUrl: creator.avatarUrl,
    avatarIndex: creator.user.avatarIndex,
  };
}

export interface LookupResult {
  ok: boolean;
  /** 검색 결과. 1명이더라도 자동 이동하지 않고 선택 목록으로 반환한다. */
  matches?: CreatorSearchItem[];
  message?: string;
}

export async function lookupCreatorCode(input: string): Promise<LookupResult> {
  const h = await headers();
  const ip = clientIpFrom((name) => h.get(name));
  /**
   * [RL-UNKNOWN] IP 를 알 수 없을 때 모든 요청이 `lookup:unknown` 한 버킷을 공유해, 한 명의 남용이
   * 전원의 검색을 막았다. 로그인 사용자는 계정 단위 버킷으로 분리하고, 비로그인만 별도의
   * `noip` 버킷을 공유한다(IP 버킷과 이름공간이 겹치지 않게). 프록시 설정 점검용 경고도 남긴다.
   */
  let bucket: string;
  if (ip) bucket = `ip:${ip}`;
  else {
    const user = await getSessionUser().catch(() => null);
    bucket = user ? `user:${user.id}` : 'noip';
    logger.warn('크리에이터 검색: 클라이언트 IP 를 알 수 없습니다(프록시 설정 확인)', { bucket: user ? 'user' : 'noip' });
  }

  const tries = await kv.incr(`lookup:${bucket}`, WINDOW_SEC);
  if (tries > MAX_TRIES) {
    return { ok: false, message: '조회 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' };
  }

  const raw = String(input ?? '').trim();
  if (raw.length < 2) {
    return { ok: false, message: '크리에이터 코드 또는 이름을 2자 이상 입력해 주세요.' };
  }

  // 1) 코드 형태면 코드 우선 조회
  const code = normalizeCreatorCode(raw);
  if (/^TOR-[A-Z0-9]{4,8}$/.test(code)) {
    const byCode = await prisma.creatorProfile.findFirst({
      where: { code, status: 'APPROVED' },
      select: creatorSearchSelect,
    });
    if (byCode) return { ok: true, matches: [toSearchItem(byCode)] };
    // 코드 형태인데 없으면 이름 검색으로 넘어가지 않고 바로 안내한다 (오타 가능성)
    return {
      ok: false,
      message: '해당 코드의 크리에이터를 찾을 수 없습니다. 코드를 다시 확인하거나 이름으로 검색해 보세요.',
    };
  }

  // 2) 이름 · 채널명 검색
  const matches = await prisma.creatorProfile.findMany({
    where: {
      status: 'APPROVED',
      OR: [
        { displayName: { contains: raw, mode: 'insensitive' } },
        { channelName: { contains: raw, mode: 'insensitive' } },
      ],
    },
    orderBy: { displayName: 'asc' },
    take: 8,
    select: creatorSearchSelect,
  });

  if (matches.length === 0) {
    return {
      ok: false,
      message: '검색 결과가 없습니다. 크리에이터 코드(예: TOR-8K2M) 또는 정확한 채널명·이름으로 다시 검색해 주세요.',
    };
  }
  return { ok: true, matches: matches.map(toSearchItem) };
}
