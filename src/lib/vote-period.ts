/**
 * 팬투표 집계 기간 (2026-11-17). 모든 기준은 한국 시간(KST, UTC+9, 서머타임 없음).
 *
 *  DAY   YYYY-MM-DD    매일 00:00 시작
 *  WEEK  YYYY-Www      월요일 00:00 시작 (ISO 주차)
 *  MONTH YYYY-MM       매월 1일 00:00 시작
 *  ALL   ALL           누적
 *
 * 순수 함수만 둔다 (DB·env 를 import 하지 않는다) — 화면과 테스트에서 그대로 쓴다.
 */

/** 요청 시각(ms). 서버 컴포넌트에서 렌더 중 Date.now() 를 직접 부르지 않도록 감싼다 */
export function requestNowMs(): number {
  return Date.now();
}

export type VotePeriodType = 'DAY' | 'WEEK' | 'MONTH';
export type VoteTallyType = VotePeriodType | 'ALL' | 'ROUND';

const KST = 9 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

function kstParts(date: Date) {
  const k = new Date(date.getTime() + KST);
  return { y: k.getUTCFullYear(), m: k.getUTCMonth() + 1, d: k.getUTCDate(), wd: k.getUTCDay() };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** KST 자정(해당 날짜 00:00 KST)의 UTC 시각 */
function kstMidnight(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d) - KST);
}

/** ISO 주차 (월요일 시작, 그 해의 첫 목요일이 있는 주가 1주차) */
export function isoWeekOf(y: number, m: number, d: number): { year: number; week: number } {
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7; // 월=1 … 일=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // 그 주의 목요일
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return { year: date.getUTCFullYear(), week };
}

export function periodKey(type: VotePeriodType | 'ALL', at: Date = new Date()): string {
  if (type === 'ALL') return 'ALL';
  const p = kstParts(at);
  if (type === 'DAY') return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  if (type === 'MONTH') return `${p.y}-${pad(p.m)}`;
  const w = isoWeekOf(p.y, p.m, p.d);
  return `${w.year}-W${pad(w.week)}`;
}

/** 해당 기간의 [시작, 끝) — UTC Date */
export function periodRange(type: VotePeriodType, at: Date = new Date()): { start: Date; end: Date } {
  const p = kstParts(at);
  if (type === 'DAY') {
    const start = kstMidnight(p.y, p.m, p.d);
    return { start, end: new Date(start.getTime() + DAY_MS) };
  }
  if (type === 'MONTH') {
    const start = kstMidnight(p.y, p.m, 1);
    const end = p.m === 12 ? kstMidnight(p.y + 1, 1, 1) : kstMidnight(p.y, p.m + 1, 1);
    return { start, end };
  }
  const dayNum = p.wd || 7;
  const today = kstMidnight(p.y, p.m, p.d);
  const start = new Date(today.getTime() - (dayNum - 1) * DAY_MS);
  return { start, end: new Date(start.getTime() + 7 * DAY_MS) };
}

/** 바로 앞 기간의 키 */
export function previousPeriodKey(type: VotePeriodType, at: Date = new Date()): string {
  const { start } = periodRange(type, at);
  return periodKey(type, new Date(start.getTime() - 1000));
}

/** 키 → 그 기간 안의 한 시각 (시작 시각). 형식이 틀리면 null */
export function periodStartFromKey(type: VotePeriodType, key: string): Date | null {
  if (type === 'DAY') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    return m ? kstMidnight(Number(m[1]), Number(m[2]), Number(m[3])) : null;
  }
  if (type === 'MONTH') {
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    return m ? kstMidnight(Number(m[1]), Number(m[2]), 1) : null;
  }
  const m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  // 1월 4일이 들어 있는 주가 1주차
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = Date.UTC(year, 0, 4 - (jan4Day - 1));
  const monday = new Date(week1Monday + (week - 1) * 7 * DAY_MS);
  return kstMidnight(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
}

/** 화면 표기: 11월 17일 / 2026년 47주차(11.16~11.22) / 2026년 11월 */
export function periodLabel(type: VotePeriodType, key: string): string {
  const start = periodStartFromKey(type, key);
  if (!start) return key;
  const p = kstParts(start);
  if (type === 'DAY') return `${p.m}월 ${p.d}일`;
  if (type === 'MONTH') return `${p.y}년 ${p.m}월`;
  const end = kstParts(new Date(start.getTime() + 6 * DAY_MS));
  const wk = key.slice(-2).replace(/^0/, '');
  return `${p.y}년 ${wk}주차 (${p.m}.${p.d}~${end.m}.${end.d})`;
}

/** 남은 시간 "3시간 12분" / "2일 4시간" */
export function remainingText(end: Date, now: Date = new Date()): string {
  const ms = Math.max(0, end.getTime() - now.getTime());
  const min = Math.floor(ms / 60_000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const mm = min % 60;
  if (d > 0) return `${d}일 ${h}시간`;
  if (h > 0) return `${h}시간 ${mm}분`;
  return `${mm}분`;
}
