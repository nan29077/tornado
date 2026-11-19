import { getObject, getObjectRange, MEDIA_MIME } from '@/server/uploads';
import { getSessionUser } from '@/server/auth';
import { decideTalkMediaAccess, isAudioVideoName } from '@/server/talk-media-access';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 끝이 열린 구간 요청(bytes=0-)에 한 번에 보내는 최대 크기. 브라우저는 이어서 다음 구간을 요청한다 */
const OPEN_RANGE_CHUNK = 4 * 1024 * 1024;

/**
 * 업로드된 이미지 · 팬챗 음성/영상 서빙.
 *
 * next start 는 빌드 이후 public/ 에 추가된 파일을 서빙하지 않으므로,
 * 런타임 업로드 파일은 이 라우트로 직접 읽어 내려준다.
 * 저장 위치(로컬 디스크 / S3)는 server/uploads.ts 드라이버가 처리하므로
 * 이 라우트는 그대로 두고 STORAGE_DRIVER 만 바꾸면 된다.
 *
 * (2026-11-18) 음성 · 영상은 Range 요청을 지원한다 — iOS Safari 는 Range 응답(206)이 없으면 영상을 재생하지 않는다.
 * (2026-11-19 7차 점검)
 *  - P2-1 구간 요청은 파일 전체가 아니라 그 구간만 읽는다 (영상 80MB 를 요청마다 통째로 읽던 문제).
 *  - P2-2 팬챗 첨부 파일은 볼 권한이 있는 사람(구독자 · 크리에이터 · 관리자)에게만 내려준다.
 */
export async function GET(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;

  // 경로 조작 방지: 허용된 파일명 형식만 받는다.
  if (!/^[a-f0-9]{32}\.(jpg|jpeg|png|webp|gif|mp3|m4a|ogg|wav|webm|mp4|mov)$/i.test(name)) {
    return new Response('Not found', { status: 404 });
  }

  // 팬챗 첨부 권한 확인. 권한이 없으면 파일이 있는지도 알려 주지 않는다(404).
  let privateFile = false;
  try {
    const needUser = isAudioVideoName(name);
    const user = needUser ? await getSessionUser().catch(() => null) : null;
    let decision = await decideTalkMediaAccess(name, user);
    // 사진은 대부분 공개 이미지라 세션을 먼저 읽지 않는다. 팬챗 사진으로 확인됐을 때만 세션을 읽어 다시 판단한다
    if (decision === 'DENY' && !needUser) decision = await decideTalkMediaAccess(name, await getSessionUser().catch(() => null));
    if (decision === 'DENY') return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
    privateFile = decision === 'ALLOW_PRIVATE';
  } catch (e) {
    // 권한 확인이 실패하면 음성·영상은 닫고(구독자 전용일 수 있다), 사진은 그대로 보여 준다
    logger.warn('media: 팬챗 첨부 권한 확인 실패', { message: (e as Error).message });
    if (isAudioVideoName(name)) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
  }

  const ext = name.split('.').pop()!.toLowerCase();
  const type = MEDIA_MIME[ext] ?? 'application/octet-stream';
  const baseHeaders: Record<string, string> = {
    'Content-Type': type,
    // 구독자 전용 파일은 공유 캐시(CDN · 프록시)에 남기지 않는다
    'Cache-Control': privateFile ? 'private, max-age=3600' : 'public, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
  };
  if (privateFile) baseHeaders.Vary = 'Cookie';

  const range = req.headers.get('range');
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] || m[2])) {
    let start: number;
    let end: number;
    if (m[1]) {
      start = Number(m[1]);
      end = m[2] ? Number(m[2]) : start + OPEN_RANGE_CHUNK - 1;
    } else {
      // bytes=-N : 마지막 N 바이트. 전체 크기를 먼저 알아야 한다
      const probe = await getObjectRange(name, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      if (!probe) return new Response('Not found', { status: 404 });
      const suffix = Number(m[2]);
      start = Math.max(0, probe.size - suffix);
      end = probe.size - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
      const probe = await getObjectRange(name, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      if (!probe) return new Response('Not found', { status: 404 });
      return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${probe.size}` } });
    }
    const part = await getObjectRange(name, start, end);
    if (!part) return new Response('Not found', { status: 404 });
    if (!part.body || part.body.length === 0) {
      return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${part.size}` } });
    }
    const last = start + part.body.length - 1;
    return new Response(new Uint8Array(part.body), {
      status: 206,
      headers: { ...baseHeaders, 'Content-Range': `bytes ${start}-${last}/${part.size}`, 'Content-Length': String(part.body.length) },
    });
  }

  const buf = await getObject(name);
  if (!buf) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(buf), { status: 200, headers: { ...baseHeaders, 'Content-Length': String(buf.length) } });
}
