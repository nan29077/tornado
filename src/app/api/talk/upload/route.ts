import { requireCreator } from '@/server/auth';
import { isSameOrigin } from '@/server/request-guard';
import { consumeRateLimit } from '@/server/rate-limit';
import { MEDIA_MIME, newObjectName, putObject } from '@/server/uploads';
import { sniffTalkMedia, TALK_UPLOAD_MAX as MAX } from '@/server/talk-media';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 팬챗 음성 · 영상 업로드 (2026-11-18). 크리에이터만 올린다.
 *
 * 안전장치
 *  - 크리에이터 로그인 + 동일 출처(CSRF) 검사 + 분당 횟수 제한
 *  - 형식은 확장자·MIME 이 아니라 파일 시그니처(매직바이트)로 판정한다
 *  - 용량: 음성 15MB · 영상 80MB
 */

type Kind = keyof typeof MAX;

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return Response.json({ ok: false, message: '허용되지 않은 요청입니다.' }, { status: 403 });
  const creator = await requireCreator().catch(() => null);
  if (!creator) return Response.json({ ok: false, message: '크리에이터 로그인이 필요합니다.' }, { status: 401 });
  const rl = await consumeRateLimit('talk:upload', creator.id, 20, 60);
  if (!rl.ok) return Response.json({ ok: false, message: '잠시 후 다시 올려 주세요.' }, { status: 429 });

  const form = await req.formData().catch(() => null);
  const kindRaw = form?.get('kind');
  const kind: Kind | null = kindRaw === 'VOICE' || kindRaw === 'VIDEO' ? kindRaw : null;
  const file = form?.get('file');
  if (!kind) return Response.json({ ok: false, message: '음성 또는 영상을 골라 주세요.' }, { status: 400 });
  if (!(file instanceof File)) return Response.json({ ok: false, message: '파일을 선택해 주세요.' }, { status: 400 });
  if (file.size > MAX[kind]) {
    return Response.json({ ok: false, message: `${kind === 'VOICE' ? '음성' : '영상'}은 ${Math.round(MAX[kind] / 1024 / 1024)}MB 이하만 올릴 수 있어요.` }, { status: 400 });
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const ext = sniffTalkMedia(buf, kind);
  if (!ext) {
    return Response.json(
      { ok: false, message: kind === 'VOICE' ? '지원하지 않는 형식입니다. MP3 · M4A · WEBM · OGG · WAV 음성만 올릴 수 있어요.' : '지원하지 않는 형식입니다. MP4 · MOV · WEBM 영상만 올릴 수 있어요.' },
      { status: 400 },
    );
  }
  // 구독자 전용 파일이라 공개 CDN 주소가 아니라 권한을 확인하는 /api/media 로만 서빙한다 (7차 P2-2)
  const url = await putObject(newObjectName(ext), buf, MEDIA_MIME[ext] ?? 'application/octet-stream', { private: true });
  return Response.json({ ok: true, url, kind });
}
