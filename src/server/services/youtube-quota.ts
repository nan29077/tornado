import { kv } from '@/server/redis';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { ptDateKey } from '@/lib/datetime';

/**
 * 유튜브 일일 할당량 관리.
 *
 * 반드시 지켜야 하는 세 가지
 *  1. **원자적 가감산.** `get` 뒤에 `set` 하면 동시 후원에서 서로의 증가분을 덮어써
 *     상한이 무력화되고, 구글 쪽 실제 할당량이 먼저 소진돼 403 이 온다.
 *  2. **태평양시 기준.** 구글의 일일 할당량은 PT 자정에 리셋된다. KST 로 세면
 *     PT 하루 안에 우리 카운터만 한 번 더 초기화되어 상한의 최대 두 배를 허용한다.
 *  3. **실패 시 반환.** 선점만 하고 전송이 실패했는데 되돌리지 않으면, 실제로는
 *     한 건도 못 보낸 장애 시간에 예산만 사라진다.
 *
 * 예산 구조
 *  - 전체(dailyQuota) 안에서 소비한다.
 *  - 게임 참여 링크 공유는 별도 하위 예산(shareDailyQuota)을 함께 넘지 못한다.
 *    후원 알림은 시청자 돈이 걸린 기능이므로 공유 버튼 연타가 잠식하지 못하게 한다.
 *  - 크리에이터별 상한(creatorDailyQuota)은 0 이면 적용하지 않는다.
 */

/** 카운터 TTL. PT 일자 키라 최대 24시간 + 여유를 둔다. */
const TTL_SEC = 60 * 60 * 30;

export type QuotaPurpose = 'donation' | 'share' | 'lookup';

export interface QuotaReserveInput {
  cost: number;
  creatorId?: string | null;
  purpose?: QuotaPurpose;
}

interface Bucket {
  key: string;
  limit: number;
}

function buckets(input: QuotaReserveInput): Bucket[] {
  const day = ptDateKey();
  const list: Bucket[] = [{ key: `yt:quota:${day}`, limit: env.youtube.dailyQuota }];
  if (input.purpose === 'share' && env.youtube.shareDailyQuota > 0) {
    list.push({ key: `yt:quota:share:${day}`, limit: env.youtube.shareDailyQuota });
  }
  if (input.creatorId && env.youtube.creatorDailyQuota > 0) {
    list.push({ key: `yt:quota:creator:${input.creatorId}:${day}`, limit: env.youtube.creatorDailyQuota });
  }
  return list;
}

/**
 * 할당량을 선점한다. 상한을 넘으면 이미 올린 카운터를 전부 되돌리고 false 를 돌려준다.
 *
 * "먼저 올리고 넘치면 되돌린다"가 "읽고 판단한 뒤 쓴다"보다 안전하다.
 * 후자는 동시 요청이 서로의 증가분을 못 보지만, 전자는 순간적으로만 초과가 보일 뿐
 * **상한을 넘겨 실제 전송이 나가는 일은 없다.**
 */
export async function reserveYouTubeQuota(input: number | QuotaReserveInput): Promise<boolean> {
  const req: QuotaReserveInput = typeof input === 'number' ? { cost: input } : input;
  if (req.cost <= 0) return true;

  const list = buckets(req);
  const applied: Bucket[] = [];
  try {
    for (const b of list) {
      const after = await kv.incrBy(b.key, req.cost, TTL_SEC);
      applied.push(b);
      if (after > b.limit) {
        // 이 버킷을 포함해 지금까지 올린 것을 전부 되돌린다.
        for (const done of applied) await kv.incrBy(done.key, -req.cost, TTL_SEC).catch(() => 0);
        return false;
      }
    }
    return true;
  } catch (e) {
    // 카운터 저장소 장애. 이미 올린 것은 되돌리고, 상한을 알 수 없으므로 보내지 않는다.
    // (전송은 결제와 분리돼 있어 막아도 결제 결과는 그대로다 — fail-closed 가 안전하다)
    for (const done of applied) await kv.incrBy(done.key, -req.cost, TTL_SEC).catch(() => 0);
    logger.warn('유튜브 할당량 카운터 실패로 전송 보류', { message: (e as Error)?.message });
    return false;
  }
}

/** 선점한 할당량을 되돌린다. 전송이 실제로 실패했을 때만 호출한다. */
export async function releaseYouTubeQuota(input: number | QuotaReserveInput): Promise<void> {
  const req: QuotaReserveInput = typeof input === 'number' ? { cost: input } : input;
  if (req.cost <= 0) return;
  for (const b of buckets(req)) {
    await kv.incrBy(b.key, -req.cost, TTL_SEC).catch(() => 0);
  }
}

export async function getYouTubeQuotaUsage() {
  const key = `yt:quota:${ptDateKey()}`;
  const used = Number((await kv.get(key)) ?? 0);
  return {
    used,
    total: env.youtube.dailyQuota,
    insertCost: env.youtube.insertQuotaCost,
    /** 리셋 기준 시간대. 화면에서 "KST 자정"으로 오해하지 않도록 함께 노출한다. */
    resetTimezone: 'America/Los_Angeles' as const,
    remainingMessages: Math.max(0, Math.floor((env.youtube.dailyQuota - used) / env.youtube.insertQuotaCost)),
  };
}
