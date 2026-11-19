'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarCheck, Check, Copy, Gift, Loader2, Target, UserPlus } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import { checkAttendanceAction, claimMissionAction, redeemReferralAction } from '@/app/actions/fanvote';
import type { VoteActionState } from '@/app/actions/vote';

const initial: VoteActionState = { ok: false };

function useRefreshOnOk(state: VoteActionState) {
  const router = useRouter();
  React.useEffect(() => {
    if (state.ok && state.nonce) router.refresh();
  }, [state.ok, state.nonce, router]);
}

/** 출석 체크 (최근 7일 도장 + 버튼) */
export function AttendanceCard({ loggedIn, checkedToday, streak, totalDays, todayTickets, week, bonus }: {
  loggedIn: boolean;
  checkedToday: boolean;
  streak: number;
  totalDays: number;
  todayTickets: number;
  week: Array<{ dayKey: string; checked: boolean }>;
  bonus: Array<{ days: number; bonus: number }>;
}) {
  const [state, action, pending] = React.useActionState(checkAttendanceAction, initial);
  useRefreshOnOk(state);
  const done = checkedToday || state.ok;
  return (
    <section className="rounded-[22px] bg-white p-4 shadow-card">
      <div className="flex items-center gap-2.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-800">
          <CalendarCheck size={19} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-black text-ink-900">출석 체크</p>
          <p className="text-[12px] text-ink-500">
            {loggedIn ? `연속 ${streak}일 · 누적 ${totalDays}일` : '매일 출석하고 팬투표권 받기'}
            {bonus.length ? ` · ${bonus.map((b) => `${b.days}일마다 +${b.bonus}`).join(' · ')}` : ''}
          </p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-7 gap-1">
        {week.map((d, i) => {
          const today = i === week.length - 1;
          const checked = d.checked || (today && state.ok);
          return (
            <div key={d.dayKey} className={cx('flex flex-col items-center rounded-xl py-1.5', today ? 'bg-brand-50 ring-1 ring-brand-200' : 'bg-warm-50')}>
              <span className="text-[10px] font-bold text-ink-400">{Number(d.dayKey.slice(8))}일</span>
              <span className={cx('mt-1 grid h-7 w-7 place-items-center rounded-full', checked ? 'bg-ink-900 text-brand-300' : 'border border-dashed border-ink-200 text-ink-300')}>
                {checked ? <Check size={14} strokeWidth={2.6} aria-label="출석" /> : null}
              </span>
            </div>
          );
        })}
      </div>
      {!loggedIn ? (
        <Link href="/login?next=%2Fvote%2Fcharge" className="mt-3 grid h-11 place-items-center rounded-xl bg-ink-900 text-[13.5px] font-extrabold text-white">
          로그인하고 출석하기
        </Link>
      ) : (
        <form action={action} className="mt-3">
          <button type="submit" disabled={pending || done} className="flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-ink-900 text-[13.5px] font-extrabold text-white disabled:bg-ink-100 disabled:text-ink-400">
            {pending ? <Loader2 size={16} className="animate-spin" aria-hidden /> : null}
            {done ? '오늘 출석 완료 · 내일 또 만나요' : `출석하고 팬투표권 ${todayTickets}개 받기`}
          </button>
        </form>
      )}
      {state.message ? <p className={cx('mt-2 text-center text-[12px] font-bold', state.ok ? 'text-success-600' : 'text-danger-600')}>{state.message}</p> : null}
    </section>
  );
}

export interface MissionItem {
  key: string;
  title: string;
  desc: string;
  href: string;
  tickets: number;
  progress: number;
  goal: number;
  done: boolean;
  claimed: boolean;
}

/** 일일 미션 */
export function MissionList({ loggedIn, missions }: { loggedIn: boolean; missions: MissionItem[] }) {
  return (
    <section className="rounded-[22px] bg-white p-4 shadow-card">
      <div className="mb-2 flex items-center gap-2.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-warning-50 text-accent-600">
          <Target size={19} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-black text-ink-900">오늘의 미션</p>
          <p className="text-[12px] text-ink-500">매일 자정에 새로 시작돼요 · 완료 {missions.filter((m) => m.claimed).length}/{missions.length}</p>
        </div>
      </div>
      <ul className="divide-y divide-ink-100">
        {missions.map((m) => (
          <MissionRow key={m.key} m={m} loggedIn={loggedIn} />
        ))}
      </ul>
    </section>
  );
}

function MissionRow({ m, loggedIn }: { m: MissionItem; loggedIn: boolean }) {
  const [state, action, pending] = React.useActionState(claimMissionAction, initial);
  useRefreshOnOk(state);
  const claimed = m.claimed || state.ok;
  return (
    <li className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-extrabold text-ink-900">{m.title}</p>
        <p className="text-[11.5px] text-ink-500">{m.desc}</p>
        <div className="mt-1 flex items-center gap-2">
          <span className="h-1.5 w-24 overflow-hidden rounded-full bg-ink-100">
            <span className="block h-full rounded-full bg-brand-400" style={{ width: `${Math.round((m.progress / Math.max(m.goal, 1)) * 100)}%` }} />
          </span>
          <span className="text-[10.5px] font-bold tabular-nums text-ink-400">
            {m.progress}/{m.goal}
          </span>
        </div>
        {state.message && !state.ok ? <p className="mt-0.5 text-[11px] font-bold text-danger-600">{state.message}</p> : null}
      </div>
      {claimed ? (
        <span className="inline-flex h-9 items-center gap-1 rounded-full bg-ink-100 px-3 text-[12px] font-extrabold text-ink-400">
          <Check size={13} aria-hidden />
          받음
        </span>
      ) : !loggedIn ? (
        <Link href="/login?next=%2Fvote%2Fcharge" className="inline-flex h-9 items-center rounded-full border border-ink-200 px-3 text-[12px] font-extrabold text-ink-600">
          +{m.tickets}
        </Link>
      ) : m.done ? (
        <form action={action}>
          <input type="hidden" name="mission" value={m.key} />
          <button type="submit" disabled={pending} className="inline-flex h-9 items-center gap-1 rounded-full bg-brand-400 px-3.5 text-[12.5px] font-black text-ink-900">
            {pending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Gift size={13} aria-hidden />}
            {m.tickets}개 받기
          </button>
        </form>
      ) : (
        <Link href={m.href} className="inline-flex h-9 items-center rounded-full border border-ink-200 px-3 text-[12px] font-extrabold text-ink-600">
          하러 가기 +{m.tickets}
        </Link>
      )}
    </li>
  );
}

/** 친구 초대 */
export function ReferralCard({ code, invited, rewarded, canEnter, enteredCode, inviterTickets, inviteeTickets, codeDays, needPhone = false }: {
  code: string;
  invited: number;
  rewarded: number;
  canEnter: boolean;
  enteredCode: boolean;
  inviterTickets: number;
  inviteeTickets: number;
  codeDays: number;
  needPhone?: boolean;
}) {
  const [state, action, pending] = React.useActionState(redeemReferralAction, initial);
  useRefreshOnOk(state);
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    const text = `도네이도에서 함께 팬투표해요! 가입 후 ${codeDays}일 안에 초대 코드 ${code} 를 입력하면 팬투표권 ${inviteeTickets}개를 받아요. ${window.location.origin}/vote/charge`;
    try {
      if (navigator.share) await navigator.share({ title: '도네이도 팬투표 초대', text });
      else {
        await navigator.clipboard.writeText(text);
        setCopied(true);
      }
    } catch {
      /* 닫음 */
    }
  };
  return (
    <section className="rounded-[22px] bg-white p-4 shadow-card">
      <div className="flex items-center gap-2.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-success-50 text-success-600">
          <UserPlus size={19} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-black text-ink-900">친구 초대</p>
          <p className="text-[12px] text-ink-500">친구가 첫 팬투표를 하면 나는 {inviterTickets}개, 친구는 코드 입력 즉시 {inviteeTickets}개</p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 rounded-2xl bg-warm-50 px-4 py-3">
        <span className="text-[12px] font-bold text-ink-500">내 초대 코드</span>
        <span className="flex-1 text-[18px] font-black tracking-[0.12em] text-ink-900">{code}</span>
        <button type="button" onClick={() => void copy()} className="inline-flex h-9 items-center gap-1 rounded-full bg-ink-900 px-3 text-[12px] font-extrabold text-white">
          <Copy size={13} aria-hidden />
          {copied ? '복사됨' : '초대하기'}
        </button>
      </div>
      <p className="mt-1.5 text-[11.5px] text-ink-400">초대한 친구 {invited}명 · 보상 받은 초대 {rewarded}명</p>
      {canEnter && needPhone ? (
        <p className="mt-3 rounded-xl bg-warm-50 px-3 py-2.5 text-[12px] leading-relaxed text-ink-600">
          친구에게 받은 초대 코드는 휴대폰 번호를 연결한 뒤 입력할 수 있어요.{' '}
          <Link href="/my/account" className="font-bold text-brand-800 underline">
            내 정보에서 연결하기
          </Link>
        </p>
      ) : canEnter ? (
        <form action={action} className="mt-3 flex gap-2">
          <input name="code" maxLength={12} placeholder="친구에게 받은 초대 코드" className="h-10 min-w-0 flex-1 rounded-xl border border-ink-200 px-3 text-[13.5px] uppercase tracking-wider" />
          <button type="submit" disabled={pending} className="h-10 shrink-0 rounded-xl bg-brand-400 px-4 text-[13px] font-black text-ink-900 disabled:opacity-50">
            등록
          </button>
        </form>
      ) : enteredCode ? (
        <p className="mt-2 text-[11.5px] font-bold text-success-600">초대 코드를 이미 등록했어요.</p>
      ) : null}
      {state.message ? <p className={cx('mt-2 text-[12px] font-bold', state.ok ? 'text-success-600' : 'text-danger-600')}>{state.message}</p> : null}
    </section>
  );
}
