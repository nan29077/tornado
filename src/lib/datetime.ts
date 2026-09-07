/**
 * 시간 유틸.
 * - DB 저장은 UTC(timestamptz)
 * - 화면 표시/집계 기준일은 Asia/Seoul (KST, UTC+9, 서머타임 없음)
 */

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function toKst(date: Date): Date {
  return new Date(date.getTime() + KST_OFFSET_MS);
}

/** KST 기준 YYYY-MM-DD */
export function kstDateKey(date = new Date()): string {
  const k = toKst(date);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, '0')}-${String(k.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 태평양시(America/Los_Angeles) 기준 YYYY-MM-DD.
 *
 * 구글 API 의 일일 할당량은 **태평양시 자정**에 리셋된다. 이를 KST 기준으로 세면
 * 태평양시 하루 안에 우리 카운터만 한 번 더 초기화되어 상한의 최대 두 배를 허용하고,
 * 실제로는 구글이 먼저 403 을 던진다. 서머타임 전환이 있으므로 고정 오프셋으로
 * 계산하면 안 되고 반드시 타임존 데이터를 쓴다.
 */
const PT_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function ptDateKey(date = new Date()): string {
  // en-CA 로케일의 날짜 포맷은 YYYY-MM-DD 다.
  return PT_FORMATTER.format(date);
}

/** KST 기준 YYYY-MM */
export function kstMonthKey(date = new Date()): string {
  const k = toKst(date);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * 해당 월의 마지막 날짜(YYYY-MM-DD).
 *
 * `${ym}-31` 로 쓰면 안 된다. JS 는 2026-02-31 을 2026-03-03 으로 굴려버려서
 * 다음 달 초 데이터가 이번 달 집계·원천징수 신고 자료에 섞여 들어간다.
 */
export function kstMonthEndKey(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return `${ym}-28`;
  // 다음 달 0일 = 이번 달 마지막 날
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(last).padStart(2, '0')}`;
}

/** KST 기준 하루의 시작(UTC Date 반환) */
export function kstStartOfDay(date = new Date()): Date {
  const k = toKst(date);
  const startKst = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate(), 0, 0, 0, 0);
  return new Date(startKst - KST_OFFSET_MS);
}

export function kstStartOfMonth(date = new Date()): Date {
  const k = toKst(date);
  const startKst = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), 1, 0, 0, 0, 0);
  return new Date(startKst - KST_OFFSET_MS);
}

export function formatKst(date: Date | null | undefined, withSeconds = true): string {
  if (!date) return '-';
  const k = toKst(date);
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
  return withSeconds ? `${base}:${p(k.getUTCSeconds())}` : base;
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/**
 * YYYY-MM 검증 후 KST 기준 월 시작/끝을 돌려준다.
 *
 * **연도까지 봐야 한다.** 예전에는 월(01~12)만 검사했다. `?month=9999-12` 로 들어오면
 * 다음 달 키가 `10000-01` 이 되고 `new Date('10000-01-01T00:00:00+09:00')` 는
 * Invalid Date 다. 그 값이 그대로 Prisma 조건에 들어가 **정산 화면 전체가 500** 이 났다.
 * 주소만 만지면 누구나 재현할 수 있고, 오류 화면으로는 원인을 알 수 없다.
 * 이상한 값은 막지 말고 **이번 달로 되돌린다** — 주소를 잘못 만졌다고 화면이 죽으면 안 된다.
 */
export const MIN_MONTH_YEAR = 2020;

export function kstMonthRange(ym: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  const now = kstMonthKey();
  const maxYear = Number(now.slice(0, 4)) + 1;
  const valid =
    m &&
    Number(m[1]) >= MIN_MONTH_YEAR &&
    Number(m[1]) <= maxYear &&
    Number(m[2]) >= 1 &&
    Number(m[2]) <= 12;
  const key = valid ? ym : now;
  const [y, mo] = key.split('-').map(Number);
  const start = new Date(`${key}-01T00:00:00+09:00`);
  const nextKey = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  const prevKey = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
  const end = new Date(`${nextKey}-01T00:00:00+09:00`);
  return { key, start, end, prevKey, nextKey, year: y, month: mo };
}
