import Link from 'next/link';
import { ArrowDown, ArrowUp, Crown, Minus, Trophy } from '@/components/brand/icons';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { cx } from '@/components/ui';
import { categoryLabel } from '@/lib/video-hub';
import { VoteButton, type VoteButtonProps } from './vote-button';

/**
 * 팬투표 랭킹 보드 (2026-11-17). 1~3위는 시상대, 4위부터는 목록.
 * 서버 컴포넌트 — 팬투표 버튼만 클라이언트.
 */

export interface BoardRow {
  rank: number;
  creatorId: string;
  code: string;
  displayName: string;
  avatarUrl: string | null;
  avatarIndex: number;
  category: string | null;
  votes: number;
  prevRank: number | null;
}

export type VoteContext = Omit<VoteButtonProps, 'creator' | 'className' | 'size' | 'label'>;

const nf = (n: number) => n.toLocaleString('ko-KR');

export function RankChange({ rank, prevRank, showNew = true }: { rank: number; prevRank: number | null; showNew?: boolean }) {
  if (prevRank == null) {
    return showNew ? <span className="rounded-full bg-warning-500/15 px-1.5 py-0.5 text-[10px] font-black text-accent-600">NEW</span> : null;
  }
  const diff = prevRank - rank;
  if (diff > 0) {
    return (
      <span className="inline-flex items-center text-[11px] font-black text-danger-600" aria-label={`${diff}계단 상승`}>
        <ArrowUp size={12} strokeWidth={2.4} aria-hidden />
        {diff}
      </span>
    );
  }
  if (diff < 0) {
    return (
      <span className="inline-flex items-center text-[11px] font-black text-[#2f6fd6]" aria-label={`${-diff}계단 하락`}>
        <ArrowDown size={12} strokeWidth={2.4} aria-hidden />
        {-diff}
      </span>
    );
  }
  return <Minus size={12} strokeWidth={2.2} className="text-ink-300" aria-label="변동 없음" />;
}

const PODIUM = [
  { place: 2, ring: 'ring-[#c9ccd6]', badge: 'bg-[#e6e8ee] text-[#4a4f5c]', height: 'h-16 sm:h-20', size: 'h-16 w-16 sm:h-20 sm:w-20' },
  { place: 1, ring: 'ring-brand-400', badge: 'bg-brand-400 text-ink-900', height: 'h-24 sm:h-28', size: 'h-20 w-20 sm:h-24 sm:w-24' },
  { place: 3, ring: 'ring-[#e3b48a]', badge: 'bg-[#f3dcc6] text-[#7a4a1e]', height: 'h-12 sm:h-14', size: 'h-14 w-14 sm:h-[4.5rem] sm:w-[4.5rem]' },
];

/** hideChange: 이벤트 · 왕중왕전처럼 직전 순위가 없는 회차는 순위 변동(NEW) 표시를 숨긴다 */
export function Podium({ rows, vote, hideChange = false }: { rows: BoardRow[]; vote?: VoteContext | null; hideChange?: boolean }) {
  const byRank = new Map(rows.slice(0, 3).map((r, i) => [i + 1, r]));
  return (
    <div className="relative overflow-hidden rounded-[26px] bg-[radial-gradient(120%_90%_at_50%_0%,#fff3cf_0%,#fff9ec_45%,#ffffff_100%)] px-3 pb-4 pt-5 shadow-[0_14px_34px_rgba(160,106,0,0.12)] ring-1 ring-brand-100 sm:px-6">
      <span className="pointer-events-none absolute -left-10 -top-10 h-36 w-36 rounded-full bg-brand-200/40 blur-2xl" aria-hidden />
      <span className="pointer-events-none absolute -right-8 top-6 h-28 w-28 rounded-full bg-accent-400/20 blur-2xl" aria-hidden />
      <div className="relative grid grid-cols-3 items-end gap-2 sm:gap-4">
        {PODIUM.map((p) => {
          const r = byRank.get(p.place);
          return (
            <div key={p.place} className="flex min-w-0 flex-col items-center">
              {r ? (
                <>
                  {p.place === 1 ? <Crown size={22} strokeWidth={1.8} className="mb-1 text-brand-600" aria-hidden /> : <span className="mb-1 h-[22px]" aria-hidden />}
                  <Link href={`/vote/creator/${r.code}`} className="group flex min-w-0 flex-col items-center" prefetch={false}>
                    <span className={cx('rounded-full bg-white p-0.5 ring-[3px] transition-transform group-hover:-translate-y-0.5', p.ring)}>
                      <ProfileAvatar seed={r.code} avatarIndex={r.avatarIndex} name={r.displayName} imageUrl={r.avatarUrl} className={p.size} />
                    </span>
                    <span className="mt-2 w-full truncate text-center text-[13px] font-black tracking-[-0.02em] text-ink-900 sm:text-[14px]">{r.displayName}</span>
                  </Link>
                  <span className="mt-0.5 text-[12px] font-extrabold tabular-nums text-brand-800">{nf(r.votes)}표</span>
                  <span className="mt-0.5 h-4">{hideChange ? null : <RankChange rank={r.rank} prevRank={r.prevRank} />}</span>
                  {vote ? <VoteButton {...vote} creator={{ id: r.creatorId, name: r.displayName, code: r.code, avatarUrl: r.avatarUrl, avatarIndex: r.avatarIndex, category: r.category }} size="xs" className="mt-1.5" /> : null}
                </>
              ) : (
                <span className="mb-2 text-[12px] font-bold text-ink-300">비어 있음</span>
              )}
              <div className={cx('mt-2 flex w-full items-start justify-center rounded-t-2xl pt-1.5', p.height, p.place === 1 ? 'bg-gradient-to-b from-brand-300 to-brand-200' : p.place === 2 ? 'bg-gradient-to-b from-[#e6e8ee] to-[#f2f3f6]' : 'bg-gradient-to-b from-[#f3dcc6] to-[#faeee2]')}>
                <span className={cx('grid h-7 w-7 place-items-center rounded-full text-[13px] font-black', p.badge)}>{p.place}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function RankList({ rows, vote, startAt = 4, compact = false, hideChange = false }: { rows: BoardRow[]; vote?: VoteContext | null; startAt?: number; compact?: boolean; hideChange?: boolean }) {
  const list = rows.filter((r) => r.rank >= startAt);
  if (list.length === 0) return null;
  const max = Math.max(...rows.map((r) => r.votes), 1);
  return (
    <ol className="divide-y divide-ink-100 overflow-hidden rounded-[22px] bg-white shadow-card ring-1 ring-ink-100">
      {list.map((r) => (
        <li key={r.creatorId} className="relative flex items-center gap-3 px-3.5 py-3 sm:px-4">
          <span className="w-7 shrink-0 text-center">
            <span className="block text-[15px] font-black tabular-nums text-ink-800">{r.rank}</span>
            <span className="flex h-3.5 justify-center">{hideChange ? null : <RankChange rank={r.rank} prevRank={r.prevRank} showNew={!compact} />}</span>
          </span>
          <Link href={`/vote/creator/${r.code}`} prefetch={false} className="shrink-0">
            <ProfileAvatar seed={r.code} avatarIndex={r.avatarIndex} name={r.displayName} imageUrl={r.avatarUrl} className="h-11 w-11" />
          </Link>
          <div className="min-w-0 flex-1">
            <Link href={`/vote/creator/${r.code}`} prefetch={false} className="block truncate text-[14px] font-extrabold text-ink-900 hover:text-brand-800">
              {r.displayName}
            </Link>
            <div className="mt-1 flex items-center gap-2">
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-100">
                <span className="block h-full rounded-full bg-gradient-to-r from-brand-300 to-accent-500" style={{ width: `${Math.max(4, Math.round((r.votes / max) * 100))}%` }} />
              </span>
              <span className="shrink-0 text-[12px] font-bold tabular-nums text-ink-500">{nf(r.votes)}표</span>
            </div>
            {!compact && r.category ? <span className="mt-0.5 block text-[11px] text-ink-400">{categoryLabel(r.category)}</span> : null}
          </div>
          {vote ? <VoteButton {...vote} creator={{ id: r.creatorId, name: r.displayName, code: r.code, avatarUrl: r.avatarUrl, avatarIndex: r.avatarIndex, category: r.category }} size="sm" /> : null}
        </li>
      ))}
    </ol>
  );
}

export function EmptyRanking({ title = '아직 팬투표가 없어요', description = '첫 표를 보내 순위를 만들어 주세요.' }: { title?: string; description?: string }) {
  return (
    <div className="flex flex-col items-center rounded-[22px] border border-dashed border-brand-200 bg-brand-50/50 px-6 py-10 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-white text-brand-600 shadow-card">
        <Trophy size={22} strokeWidth={1.7} aria-hidden />
      </span>
      <p className="mt-3 text-[14px] font-extrabold text-ink-800">{title}</p>
      <p className="mt-1 text-[12.5px] text-ink-500">{description}</p>
    </div>
  );
}
