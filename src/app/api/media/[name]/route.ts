import { getObject, MEDIA_MIME } from '@/server/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 업로드된 이미지 · 팬챗 음성/영상 서빙.
 *
 * next start 는 빌드 이후 public/ 에 추가된 파일을 서빙하지 않으므로,
 * 런타임 업로드 파일은 이 라우트로 직접 읽어 내려준다.
 * 저장 위치(로컬 디스크 / S3)는 server/uploads.ts 드라이버가 처리하므로
 * 이 라우트는 그대로 두고 STORAGE_DRIVER 만 바꾸면 된다.
 *
 * (2026-11-18) 음성 · 영상은 Range 요청을 지원한다 — iOS Safari 는 Range 응답(206)이 없으면 영상을 재생하지 않는다.
 */
export async function GET(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;

  // 경로 조작 방지: 허용된 파일명 형식만 받는다.
  if (!/^[a-f0-9]{32}\.(jpg|jpeg|png|webp|gif|mp3|m4a|ogg|wav|webm|mp4|mov)$/i.test(name)) {
    return new Response('Not found', { status: 404 });
  }

  const ext = name.split('.').pop()!.toLowerCase();
  const buf = await getObject(name);
  if (!buf) return new Response('Not found', { status: 404 });

  const type = MEDIA_MIME[ext] ?? 'application/octet-stream';
  const baseHeaders: Record<string, string> = {
    'Content-Type': type,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
  };

  const range = req.headers.get('range');
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] || m[2])) {
    const size = buf.length;
    let start: number;
    let end: number;
    if (m[1]) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    } else {
      const suffix = Number(m[2]);
      start = Math.max(0, size - suffix);
      end = size - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` } });
    }
    const chunk = buf.subarray(start, end + 1);
    return new Response(new Uint8Array(chunk), {
      status: 206,
      headers: { ...baseHeaders, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(chunk.length) },
    });
  }

  return new Response(new Uint8Array(buf), { status: 200, headers: { ...baseHeaders, 'Content-Length': String(buf.length) } });
}
