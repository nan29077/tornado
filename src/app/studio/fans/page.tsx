import Link from 'next/link';
import { Crown, Users, HandCoins, UserPlus, Search, Ban } from 'lucide-react';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, StatTile, Table, Td, Th, Input, Select } from '@/components/ui';
import { Pager } from '@/components/admin/controls';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { requireCreator } from '@/server/auth';
import { listCreatorFans, FAN_SORTS, isFanSort, type FanSort, type CreatorFan } from '@/server/services/creator-fans';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

/**
 * 팬 관리.
 *
 * 팬 = 이 크리에이터의 MO 번호로 후원했거나, 이 크리에이터의 후원 페이지로 로그인·가입한 후원자.
 * 두 경로가 서로 다른 테이블에 담기므로(creator-fans.ts 주석 참고) 서비스가 합쳐서 돌려준다.
 *
 * 개인정보는 다른 화면과 같은 원칙을 지킨다 — **전화번호는 마스킹된 값만** 보여주고 원문은
 * 어디에도 싣지 않는다. 크리에이터에게도 마찬가지다.
 */
export default async function StudioFansPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; page?: string; q?: string }>;
}) {
  const { creatorId } = await requireCreator();
  const sp = await searchParams;

  const sort: FanSort = sp.sort && isFanSort(sp.sort) ? sp.sort : 'amount';
  const q = (sp.q ?? '').trim();
  const page = Math.max(1, Number(sp.page ?? 1) || 1);

  const board = await listCreatorFans(creatorId, { sort, page, q });

  return (
    <>
      <PageHeader
        title="팬 관리"
        description="내 후원 번호로 후원했거나 내 후원 페이지로 가입한 후원자입니다. 후원금 순위와 정렬로 살펴보세요."
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="전체 팬" value={`${formatNumber(board.summary.fanCount)}명`} tone="brand" />
        <StatTile
          label="후원한 팬"
          value={`${formatNumber(board.summary.supporterCount)}명`}
          sub={`가입만 ${formatNumber(board.summary.fanCount - board.summary.supporterCount)}명`}
        />
        <StatTile label="누적 후원금" value={formatWon(board.summary.totalAmount)} tone="brand" />
        <StatTile label="누적 후원 건수" value={`${formatNumber(board.summary.totalCount)}건`} />
      </div>

      {board.truncated ? (
        <div className="mb-4">
          <Notice tone="warning" title="팬이 많아 일부만 집계했습니다">
            한 번에 훑는 상한(2,000명)을 넘었습니다. 아래 숫자와 순위는 상한 안에서 계산된 값입니다.
            이 상태가 계속되면 서버 페이지네이션으로 바꿔야 합니다. 고객센터로 알려 주세요.
          </Notice>
        </div>
      ) : null}

      {/* ── 후원금 상위 10위 ─────────────────────────────────────── */}
      <section className="mb-6">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>후원금 상위 10위</CardTitle>
            <span className="text-[11.5px] text-ink-400">검색·정렬과 무관하게 전체 기준입니다</span>
          </div>

          {board.top.length === 0 ? (
            <p className="mt-3 rounded-2xl border border-dashed border-ink-200 px-4 py-8 text-center text-[13px] text-ink-400">
              아직 후원한 팬이 없습니다. 첫 후원이 들어오면 순위가 만들어집니다.
            </p>
          ) : (
            <ol className="mt-3 space-y-1.5">
              {board.top.map((fan, i) => (
                <li
                  key={fan.key}
                  className={`flex items-center gap-3 rounded-2xl px-3 py-2.5 ${i === 0 ? 'bg-brand-50' : 'bg-ink-50'}`}
                >
                  <span
                    className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] font-black ${
                      i === 0
                        ? 'bg-brand-400 text-ink-900'
                        : i < 3
                          ? 'bg-brand-100 text-brand-800'
                          : 'bg-white text-ink-500'
                    }`}
                  >
                    {i + 1}
                  </span>
                  {i === 0 ? <Crown size={15} strokeWidth={1.9} className="shrink-0 text-brand-600" /> : null}
                  <FanName fan={fan} />
                  <span className="ml-auto shrink-0 text-right">
                    <span className="block text-[14px] font-extrabold tracking-tight text-brand-700 tabular-nums">
                      {formatWon(fan.totalAmount)}
                    </span>
                    <span className="block text-[11px] text-ink-400 tabular-nums">
                      {formatNumber(fan.totalCount)}건
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </section>

      {/* ── 검색 · 정렬 ──────────────────────────────────────────── */}
      <form method="get" className="mb-3 flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="mb-1 block text-[12px] font-bold text-ink-500">이름·번호 검색</span>
          <span className="relative block">
            <Search
              size={15}
              strokeWidth={1.8}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-300"
            />
            <Input name="q" defaultValue={q} placeholder="닉네임 또는 번호 뒷자리" className="pl-9" />
          </span>
        </label>
        <label>
          <span className="mb-1 block text-[12px] font-bold text-ink-500">정렬</span>
          <Select name="sort" defaultValue={sort}>
            {(Object.keys(FAN_SORTS) as FanSort[]).map((k) => (
              <option key={k} value={k}>
                {FAN_SORTS[k]}
              </option>
            ))}
          </Select>
        </label>
        <button
          type="submit"
          className="inline-flex h-11 items-center rounded-xl bg-brand-400 px-4 text-[13.5px] font-extrabold text-ink-900 transition-colors hover:bg-brand-500"
        >
          적용
        </button>
        {q ? (
          <Link
            href="/studio/fans"
            className="inline-flex h-11 items-center rounded-xl border border-ink-200 px-4 text-[13.5px] font-bold text-ink-500 hover:bg-ink-50"
          >
            초기화
          </Link>
        ) : null}
      </form>

      {/* ── 팬 목록 ──────────────────────────────────────────────── */}
      {board.fans.length === 0 ? (
        <EmptyState
          title={q ? '조건에 맞는 팬이 없습니다' : '아직 팬이 없습니다'}
          description={
            q
              ? '검색어를 지우고 다시 확인해 보세요.'
              : '후원 페이지 주소를 방송에 안내하면 후원자가 모입니다. 문자후원을 하거나 후원 페이지로 로그인한 분이 여기에 쌓입니다.'
          }
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>팬</Th>
                <Th>귀속 경로</Th>
                <Th className="text-right">누적 후원금</Th>
                <Th className="text-right">건수</Th>
                <Th>최근 후원</Th>
                <Th>가입일</Th>
                <Th>상태</Th>
              </tr>
            </thead>
            <tbody>
              {board.fans.map((fan) => (
                <tr key={fan.key}>
                  <Td>
                    <FanName fan={fan} />
                  </Td>
                  <Td>
                    {fan.joinedVia === 'DONATION' ? (
                      <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-700">
                        <HandCoins size={14} strokeWidth={1.8} className="text-brand-700" />
                        문자후원
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-700">
                        <UserPlus size={14} strokeWidth={1.8} className="text-brand-700" />
                        후원페이지 가입
                      </span>
                    )}
                  </Td>
                  <Td className="text-right font-extrabold tabular-nums text-brand-700">
                    {formatWon(fan.totalAmount)}
                  </Td>
                  <Td className="text-right tabular-nums">{formatNumber(fan.totalCount)}</Td>
                  <Td className="text-[12.5px] text-ink-500">
                    {fan.lastDonatedAt ? formatKst(fan.lastDonatedAt, false) : '-'}
                  </Td>
                  <Td className="text-[12.5px] text-ink-500">{formatKst(fan.joinedAt, false)}</Td>
                  <Td>
                    <span className="flex flex-wrap gap-1">
                      {fan.blocked ? (
                        <Badge tone="danger">
                          <Ban size={11} strokeWidth={2} /> 내가 차단
                        </Badge>
                      ) : null}
                      {fan.blockedByDonor ? <Badge tone="neutral">후원자가 차단</Badge> : null}
                      {!fan.linked ? <Badge tone="neutral">번호 미연결</Badge> : null}
                      {!fan.blocked && !fan.blockedByDonor && fan.linked ? (
                        <Badge tone="success">정상</Badge>
                      ) : null}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <div className="mt-4">
            <Pager
              basePath="/studio/fans"
              params={{ sort, ...(q ? { q } : {}) }}
              page={board.page}
              lastPage={board.totalPages}
              total={board.total}
            />
          </div>
        </>
      )}

      <div className="mt-5">
        <Notice tone="neutral" title="팬은 이렇게 모입니다">
          <span className="flex items-start gap-2">
            <Users size={15} strokeWidth={1.8} className="mt-0.5 shrink-0 text-brand-700" />
            <span>
              내 전용 후원 번호로 <strong className="text-ink-900">문자후원</strong>을 했거나, 내 후원 페이지에서{' '}
              <strong className="text-ink-900">카카오·네이버로 로그인</strong>한 후원자가 자동으로 귀속됩니다.
              번호를 연결하지 않은 팬은 후원 내역 집계가 되지 않아 &lsquo;번호 미연결&rsquo;로 표시됩니다.
              후원자 보호를 위해 전화번호는 마스킹된 형태로만 보입니다.
            </span>
          </span>
        </Notice>
      </div>
    </>
  );
}

/** 아바타 + 이름 + 마스킹 번호 한 덩어리. 순위표와 목록이 같은 모양을 쓴다. */
function FanName({ fan }: { fan: CreatorFan }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ProfileAvatar seed={fan.key} avatarIndex={fan.avatarIndex} name={fan.name} className="h-8 w-8 shrink-0" />
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] font-bold text-ink-900">{fan.name}</span>
        {fan.phoneMasked ? (
          <span className="block truncate font-mono text-[11px] text-ink-400">{fan.phoneMasked}</span>
        ) : null}
      </span>
    </span>
  );
}
