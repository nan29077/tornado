/**
 * 영상 상품 스티커 — 시간 표기 도우미 (브라우저·서버 공용, 2026-11-18).
 *
 *  "80" → 80초, "1:20" → 80초, "1:02:03" → 3723초. 빈 값은 null(시간 제한 없음).
 */

/** 표시 시간대를 둘 수 있는 최대 길이 (24시간) */
export const VIDEO_TAG_MAX_SEC = 24 * 3600;

/** 시간 지정이 가능한 플랫폼 — 재생 위치를 읽을 수 있는 유튜브만 */
export const TIMED_TAG_PLATFORMS = ['YOUTUBE'] as const;

export function supportsTimedTag(platform: string): boolean {
  return (TIMED_TAG_PLATFORMS as readonly string[]).includes(platform);
}

/** 사용자가 입력한 시간 문자열 → 초. 빈 값은 null, 형식이 틀리면 예외 */
export function parseTagTime(raw: string | null | undefined, label = '시간'): number | null {
  const v = String(raw ?? '').trim();
  if (!v) return null;
  let sec: number;
  if (/^\d{1,5}$/.test(v)) {
    sec = Number(v);
  } else {
    const m = v.match(/^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/);
    if (!m) throw new Error(`${label}은(는) 분:초(예: 1:20) 또는 초(예: 80)로 입력해 주세요.`);
    const [, h, mm, ss] = m;
    if (Number(ss) >= 60 || (h != null && Number(mm) >= 60)) throw new Error(`${label}의 분·초는 0~59 사이로 입력해 주세요.`);
    sec = Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss);
  }
  if (sec > VIDEO_TAG_MAX_SEC) throw new Error(`${label}은(는) 24시간을 넘을 수 없습니다.`);
  return sec;
}

/** 초 → "1:20" / "1:02:03" */
export function formatTagTime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/** 표시 시간대 설명 ("영상 내내" / "1:20 ~ 2:00" / "1:20부터" / "2:00까지") */
export function describeTagWindow(startSec: number | null, endSec: number | null): string {
  if (startSec == null && endSec == null) return '영상 내내';
  if (startSec != null && endSec != null) return `${formatTagTime(startSec)} ~ ${formatTagTime(endSec)}`;
  if (startSec != null) return `${formatTagTime(startSec)}부터 끝까지`;
  return `처음부터 ${formatTagTime(endSec)}까지`;
}

/** 지금 재생 위치(초)에서 스티커를 보여 줄지. 위치를 모르면(null) 시간 제한 없는 스티커만 보인다 */
export function isTagVisibleAt(tag: { startSec: number | null; endSec: number | null }, currentSec: number | null): boolean {
  if (tag.startSec == null && tag.endSec == null) return true;
  if (currentSec == null) return false;
  if (tag.startSec != null && currentSec < tag.startSec) return false;
  if (tag.endSec != null && currentSec >= tag.endSec) return false;
  return true;
}

/** 영상 키: "YOUTUBE:abc", 라이브는 "LIVE:LIVE" */
export function videoTagKey(platform: string, externalId: string): string {
  return `${platform}:${externalId}`;
}

export const LIVE_TAG_KEY = 'LIVE:LIVE';

const KEY_RE = /^(YOUTUBE|TIKTOK|INSTAGRAM|FACEBOOK|LIVE):[A-Za-z0-9_\-/]{1,60}$/;

export function isVideoTagKey(v: unknown): v is string {
  return typeof v === 'string' && KEY_RE.test(v);
}
