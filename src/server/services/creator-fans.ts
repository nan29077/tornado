import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { defaultDonorName } from '@/lib/donor-name';

/**
 * 크리에이터 팬(후원자 귀속).
 *
 * 귀속 규칙 — 후원자는 다음 중 하나면 그 크리에이터의 팬이다.
 *   1) 그 크리에이터의 전용 MO 번호로 후원했다  → donor_creator_link (joinedVia=DONATION)
 *   2) 그 크리에이터의 후원 페이지로 로그인·가입했다 → 아래 attributeFanToCreator()
 *
 * 신원이 두 가지라 저장 위치가 갈린다.
 *   - 문자후원은 **전화번호**(DonorProfile)로 식별된다. 회원가입이 필요 없다.
 *   - 카카오·네이버 가입자는 **계정**(User)만 있고, 휴대폰을 연결하기 전에는 DonorProfile 이 없다.
 * 그래서 번호가 있는 팬은 donor_creator_link 에, 아직 번호가 없는 팬은 user.signupCreatorId 에
 * 담고 목록에서 합친다. 번호를 연결하면 promoteSignupFan() 이 링크 행으로 승격시킨다.
 */

/** 한 번에 훑는 팬 수 상한. 넘어가면 서버 페이지네이션으로 바꿔야 한다. */
const FAN_SCAN_LIMIT = 2000;

/** 팬 목록 정렬 기준 */
export const FAN_SORTS = {
  amount: '후원금 많은 순',
  recent: '최근 후원 순',
  count: '후원 건수 순',
  joined: '가입일 최신 순',
  joinedAsc: '가입일 오래된 순',
  name: '이름 순',
} as const;
export type FanSort = keyof typeof FAN_SORTS;

export function isFanSort(v: string): v is FanSort {
  return v in FAN_SORTS;
}

export interface CreatorFan {
  key: string;
  /** 화면 표시 이름 (닉네임 → 계정 이름 → 번호 끝 4자리) */
  name: string;
  avatarIndex: number | null;
  /** 마스킹된 휴대폰 번호. 번호 미연결 팬은 null */
  phoneMasked: string | null;
  joinedVia: 'DONATION' | 'SIGNUP';
  joinedAt: Date;
  totalAmount: bigint;
  totalCount: number;
  lastDonatedAt: Date | null;
  /** 크리에이터가 이 후원자를 차단했는가 */
  blocked: boolean;
  /** 후원자가 이 크리에이터를 차단했는가 */
  blockedByDonor: boolean;
  /** 번호가 연결되어 후원 내역을 집계할 수 있는 팬인가 */
  linked: boolean;
}

/**
 * 후원 페이지로 로그인·가입한 계정을 그 크리에이터의 팬으로 귀속시킨다.
 *
 * - 이미 다른 크리에이터에게 귀속되어 있으면 **바꾸지 않는다.** "누구를 통해 들어왔는가"는
 *   사실 기록이라, 나중에 다른 페이지를 방문했다고 소급해 바꾸면 유입 경로가 사라진다.
 * - 번호가 이미 연결된 계정이면 링크 행까지 함께 만들어 후원 내역과 한자리에서 보이게 한다.
 * - 실패해도 로그인 자체를 막지 않는다(귀속은 부가 기록이다).
 */
export async function attributeFanToCreator(userId: string, creatorId: string): Promise<void> {
  try {
    /**
     * (1) 유입 실적 — "이 계정을 **처음 데려온** 크리에이터".
     * 계정당 하나뿐이고 한 번 정해지면 바꾸지 않는다. 나중에 다른 페이지를 봤다고
     * 소급해 바꾸면 누가 신규 회원을 데려왔는지가 사라진다.
     */
    await prisma.user.updateMany({
      where: { id: userId, signupCreatorId: null },
      data: { signupCreatorId: creatorId },
    });

    /**
     * (2) 팬 소속 — **크리에이터마다 따로** 생긴다.
     * A 페이지로 가입한 사람이 B 페이지에도 로그인하면 A 와 B 모두의 팬이다.
     * 그래서 (1)이 이미 채워져 있어도 여기서 멈추지 않는다.
     */
    const donor = await prisma.donorProfile.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (donor) {
      await ensureFanLink(donor.id, creatorId);
    } else {
      await ensureFanAccount(creatorId, userId);
    }
  } catch (e) {
    logger.warn('팬 귀속 실패', { userId, creatorId, message: (e as Error).message });
  }
}

/**
 * 번호 미연결 계정의 팬 소속을 만든다. 이미 있으면 아무것도 하지 않는다.
 * 유니크 제약(creatorId, userId)이 최종 방어선이라, 동시 요청으로 충돌하면 조용히 넘어간다.
 */
async function ensureFanAccount(creatorId: string, userId: string): Promise<void> {
  try {
    await prisma.creatorFanAccount.create({ data: { id: newId(), creatorId, userId } });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== 'P2002' && code !== '23505') throw e;
  }
}

/**
 * 크리에이터 **코드**로 귀속시킨다. (로그인·가입 경로는 코드만 알고 있다)
 * 승인 상태가 아닌 채널이면 귀속하지 않는다 — 정지된 채널의 팬 목록이 늘어나면 안 된다.
 */
export async function attributeFanByCreatorCode(userId: string, code: string): Promise<void> {
  try {
    const creator = await prisma.creatorProfile.findFirst({
      where: { code, status: 'APPROVED' },
      select: { id: true },
    });
    if (creator) await attributeFanToCreator(userId, creator.id);
  } catch (e) {
    logger.warn('팬 귀속 실패(코드)', { userId, code, message: (e as Error).message });
  }
}

/**
 * 휴대폰을 연결해 DonorProfile 이 생긴 팬을 링크 행으로 승격시킨다.
 * (가입만 하고 후원은 아직 하지 않은 팬도 후원 내역 집계 대상에 들어온다)
 */
export async function promoteSignupFan(userId: string, donorId: string): Promise<void> {
  try {
    /**
     * 번호를 연결하면 그때까지 계정으로만 잡혀 있던 팬 소속을 **전부** 링크 행으로 옮긴다.
     * 여러 크리에이터의 팬일 수 있으므로 하나만 옮기면 나머지가 목록에서 사라진다.
     */
    const accounts = await prisma.creatorFanAccount.findMany({
      where: { userId },
      select: { id: true, creatorId: true },
    });
    for (const a of accounts) {
      await ensureFanLink(donorId, a.creatorId);
    }
    // 옮긴 뒤에는 지운다. 남겨 두면 같은 사람이 팬 목록에 두 번 나온다.
    if (accounts.length > 0) {
      await prisma.creatorFanAccount.deleteMany({ where: { id: { in: accounts.map((a) => a.id) } } });
    }

    // 계정 기록이 없어도 유입 크리에이터가 있으면 그쪽 링크는 보장한다(옛 데이터 대응).
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { signupCreatorId: true },
    });
    if (user?.signupCreatorId) await ensureFanLink(donorId, user.signupCreatorId);
  } catch (e) {
    logger.warn('팬 링크 승격 실패', { userId, donorId, message: (e as Error).message });
  }
}

/**
 * 링크 행이 없으면 만든다. **이미 있으면 손대지 않는다.**
 * 후원으로 먼저 생긴 행(joinedVia=DONATION)을 SIGNUP 으로 덮으면 유입 경로가 뒤집힌다.
 */
async function ensureFanLink(donorId: string, creatorId: string): Promise<void> {
  const existing = await prisma.donorCreatorLink.findFirst({
    where: { donorId, creatorId },
    select: { id: true },
  });
  if (existing) return;
  await prisma.donorCreatorLink.create({
    data: { id: newId(), donorId, creatorId, joinedVia: 'SIGNUP' },
  });
}

/** 정렬 비교 함수. 동률이면 이름으로 고정해 페이지마다 순서가 흔들리지 않게 한다. */
function comparator(sort: FanSort): (a: CreatorFan, b: CreatorFan) => number {
  const byName = (a: CreatorFan, b: CreatorFan) => a.name.localeCompare(b.name, 'ko');
  switch (sort) {
    case 'amount':
      return (a, b) => (b.totalAmount === a.totalAmount ? byName(a, b) : b.totalAmount > a.totalAmount ? 1 : -1);
    case 'count':
      return (a, b) => (b.totalCount === a.totalCount ? byName(a, b) : b.totalCount - a.totalCount);
    case 'recent':
      return (a, b) => {
        const av = a.lastDonatedAt?.getTime() ?? 0;
        const bv = b.lastDonatedAt?.getTime() ?? 0;
        return bv === av ? byName(a, b) : bv - av;
      };
    case 'joined':
      return (a, b) =>
        b.joinedAt.getTime() === a.joinedAt.getTime() ? byName(a, b) : b.joinedAt.getTime() - a.joinedAt.getTime();
    case 'joinedAsc':
      return (a, b) =>
        a.joinedAt.getTime() === b.joinedAt.getTime() ? byName(a, b) : a.joinedAt.getTime() - b.joinedAt.getTime();
    case 'name':
      return byName;
  }
}

export interface CreatorFanBoard {
  fans: CreatorFan[];
  /** 후원금 상위 10명 (후원 이력이 있는 팬만) */
  top: CreatorFan[];
  total: number;
  page: number;
  totalPages: number;
  /** 조회 상한에 걸려 일부가 빠졌는가 */
  truncated: boolean;
  summary: { fanCount: number; supporterCount: number; totalAmount: bigint; totalCount: number };
}

/**
 * 팬 목록 한 판.
 *
 * 두 출처(링크 행 · 번호 미연결 가입자)를 합쳐야 해서 **메모리에서 정렬·페이징**한다.
 * 정렬 키가 다른 테이블에 흩어져 있어 SQL 한 방으로 묶기 어렵고, 팬 수가 상한(2,000) 안이면
 * 이 방식이 단순하고 결과가 정확하다. 상한을 넘으면 truncated 로 알리고 화면에 경고를 띄운다.
 */
export async function listCreatorFans(
  creatorId: string,
  options: { sort?: FanSort; page?: number; q?: string; perPage?: number } = {},
): Promise<CreatorFanBoard> {
  const sort: FanSort = options.sort ?? 'amount';
  const perPage = options.perPage ?? 20;
  const q = (options.q ?? '').trim();

  const [links, signupOnly, blocked] = await Promise.all([
    prisma.donorCreatorLink.findMany({
      where: { creatorId },
      take: FAN_SCAN_LIMIT + 1,
      select: {
        donorId: true,
        joinedVia: true,
        createdAt: true,
        totalAmount: true,
        totalCount: true,
        lastDonatedAt: true,
        donorBlockedAt: true,
        donor: {
          select: {
            displayName: true,
            phoneMasked: true,
            user: { select: { name: true, avatarIndex: true } },
          },
        },
      },
    }),
    // 번호를 아직 연결하지 않아 링크 행이 없는 팬 (크리에이터마다 따로 쌓인다)
    prisma.creatorFanAccount.findMany({
      where: { creatorId, user: { donorProfile: null, deletedAt: null } },
      take: FAN_SCAN_LIMIT + 1,
      select: {
        createdAt: true,
        user: { select: { id: true, name: true, avatarIndex: true } },
      },
    }),
    prisma.blockedDonor.findMany({ where: { creatorId }, select: { donorId: true } }),
  ]);

  const blockedSet = new Set(blocked.map((b) => b.donorId));
  const truncated = links.length > FAN_SCAN_LIMIT || signupOnly.length > FAN_SCAN_LIMIT;

  const fromLinks: CreatorFan[] = links.slice(0, FAN_SCAN_LIMIT).map((l) => ({
    key: `d:${l.donorId}`,
    name:
      l.donor.displayName?.trim() ||
      l.donor.user?.name?.trim() ||
      defaultDonorName(l.donor.phoneMasked),
    avatarIndex: l.donor.user?.avatarIndex ?? null,
    phoneMasked: l.donor.phoneMasked,
    joinedVia: l.joinedVia === 'SIGNUP' ? 'SIGNUP' : 'DONATION',
    joinedAt: l.createdAt,
    totalAmount: l.totalAmount,
    totalCount: l.totalCount,
    lastDonatedAt: l.lastDonatedAt,
    blocked: blockedSet.has(l.donorId),
    blockedByDonor: l.donorBlockedAt != null,
    linked: true,
  }));

  const fromSignup: CreatorFan[] = signupOnly.slice(0, FAN_SCAN_LIMIT).map((a) => ({
    key: `u:${a.user.id}`,
    name: a.user.name?.trim() || '후원자',
    avatarIndex: a.user.avatarIndex,
    phoneMasked: null,
    joinedVia: 'SIGNUP',
    joinedAt: a.createdAt,
    totalAmount: 0n,
    totalCount: 0,
    lastDonatedAt: null,
    blocked: false,
    blockedByDonor: false,
    linked: false,
  }));

  const all = [...fromLinks, ...fromSignup];

  const summary = all.reduce(
    (acc, f) => ({
      fanCount: acc.fanCount + 1,
      supporterCount: acc.supporterCount + (f.totalCount > 0 ? 1 : 0),
      totalAmount: acc.totalAmount + f.totalAmount,
      totalCount: acc.totalCount + f.totalCount,
    }),
    { fanCount: 0, supporterCount: 0, totalAmount: 0n, totalCount: 0 },
  );

  // 후원금 상위 10위는 **검색·페이지와 무관하게** 전체 기준으로 뽑는다.
  const top = [...all]
    .filter((f) => f.totalCount > 0)
    .sort(comparator('amount'))
    .slice(0, 10);

  const filtered = q ? all.filter((f) => f.name.includes(q) || (f.phoneMasked ?? '').includes(q)) : all;
  filtered.sort(comparator(sort));

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(1, options.page ?? 1), totalPages);
  const fans = filtered.slice((page - 1) * perPage, page * perPage);

  return { fans, top, total, page, totalPages, truncated, summary };
}
