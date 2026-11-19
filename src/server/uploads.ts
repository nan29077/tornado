import path from 'node:path';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

/**
 * 업로드 이미지 저장소.
 *
 * ── 왜 추상화했는가 ──────────────────────────────────────────────────────
 * 로컬 디스크 저장은 단일 서버에서만 성립한다. AWS(ECS/Fargate/EB)로 올리면
 *   - 인스턴스를 2대 이상 띄우는 순간 A에 올린 이미지가 B 요청에서 404
 *   - 재배포·오토스케일 축소 때 컨테이너 파일시스템과 함께 **전량 소실**
 * 이 두 가지가 반드시 발생한다. 그래서 저장소를 드라이버로 분리하고,
 * 환경변수 STORAGE_DRIVER=s3 로 바꾸면 코드 수정 없이 S3 로 전환되게 했다.
 *
 * 현재 기본값은 local (서버 로컬 디스크). AWS 이관 시 s3 로 전환한다.
 */

export type StorageDriver = 'local' | 's3';

export const STORAGE_DRIVER: StorageDriver =
  (process.env.STORAGE_DRIVER ?? 'local').toLowerCase() === 's3' ? 's3' : 'local';

/** 로컬 디스크 저장 경로. next start 는 빌드 후 public/ 에 추가된 파일을 서빙하지 않는다. */
export const UPLOAD_DIR = path.join(process.cwd(), 'var', 'uploads');

const S3_BUCKET = process.env.S3_BUCKET ?? '';
const S3_PREFIX = (process.env.S3_PREFIX ?? 'uploads').replace(/^\/+|\/+$/g, '');
/** CloudFront 등 공개 배포 도메인. 없으면 /api/media 라우트를 통해 서빙한다. */
const S3_PUBLIC_BASE = (process.env.S3_PUBLIC_BASE ?? '').replace(/\/+$/, '');

/** 업로드 파일의 공개 URL. */
export function mediaUrl(name: string): string {
  if (STORAGE_DRIVER === 's3' && S3_PUBLIC_BASE) {
    return `${S3_PUBLIC_BASE}/${S3_PREFIX}/${name}`;
  }
  return `/api/media/${name}`;
}

/** 예측 불가능한 저장 파일명. 크리에이터 식별자가 드러나지 않게 한다. */
export function newObjectName(ext: string): string {
  return `${crypto.randomBytes(16).toString('hex')}.${ext}`;
}

/**
 * 이미지 저장. 저장에 성공하면 공개 URL 을 돌려준다.
 * S3 드라이버는 @aws-sdk/client-s3 를 지연 로딩한다(로컬 환경에 패키지가 없어도 동작).
 */
export async function putObject(name: string, body: Buffer, contentType: string, opts: { private?: boolean } = {}): Promise<string> {
  // 팬챗 음성·영상처럼 구독자만 봐야 하는 파일은 공개 CDN 주소가 아니라 권한을 확인하는 /api/media 로만 서빙한다 (7차 P2-2)
  const urlOf = (n: string) => (opts.private ? `/api/media/${n}` : mediaUrl(n));
  if (STORAGE_DRIVER === 's3') {
    if (!S3_BUCKET) throw new Error('[storage] STORAGE_DRIVER=s3 인데 S3_BUCKET 이 설정되지 않았습니다.');
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({ region: env.crypto.awsRegion });
    await client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: `${S3_PREFIX}/${name}`,
        Body: body,
        ContentType: contentType,
        CacheControl: opts.private ? 'private, max-age=3600' : 'public, max-age=31536000, immutable',
      }),
    );
    return urlOf(name);
  }

  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, name), body);
  return urlOf(name);
}

/** 저장된 이미지 읽기 (/api/media 라우트에서 사용). */
export async function getObject(name: string): Promise<Buffer | null> {
  if (STORAGE_DRIVER === 's3') {
    if (!S3_BUCKET) return null;
    try {
      const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
      const client = new S3Client({ region: env.crypto.awsRegion });
      const res = await client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: `${S3_PREFIX}/${name}` }));
      const chunks: Buffer[] = [];
      for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    } catch (e) {
      logger.warn('S3 객체 읽기 실패', { name, message: (e as Error).message });
      return null;
    }
  }

  try {
    return await fs.readFile(path.join(UPLOAD_DIR, name));
  } catch {
    return null;
  }
}

/**
 * 저장된 파일의 일부(바이트 구간)만 읽는다 (7차 P2-1, 2026-11-19).
 *
 * 음성·영상은 브라우저가 구간 요청(Range)을 여러 번 보낸다. 예전에는 요청마다 파일 전체(영상 최대 80MB)를
 * 메모리에 읽은 뒤 일부만 잘라 보냈다. 이제 필요한 구간만 읽는다. end 를 넘기면 파일 끝으로 줄인다.
 * 반환: { size: 전체 크기, body: 요청 구간 } — 파일이 없으면 null, 구간이 파일 밖이면 body 없이 size 만.
 */
export async function getObjectRange(name: string, start: number, end: number): Promise<{ size: number; body: Buffer | null } | null> {
  if (STORAGE_DRIVER === 's3') {
    if (!S3_BUCKET) return null;
    try {
      const { S3Client, GetObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3');
      const client = new S3Client({ region: env.crypto.awsRegion });
      const key = `${S3_PREFIX}/${name}`;
      const head = await client.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      const size = Number(head.ContentLength ?? 0);
      if (start >= size) return { size, body: null };
      const last = Math.min(end, size - 1);
      const res = await client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key, Range: `bytes=${start}-${last}` }));
      const chunks: Buffer[] = [];
      for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      return { size, body: Buffer.concat(chunks) };
    } catch (e) {
      logger.warn('S3 객체 구간 읽기 실패', { name, message: (e as Error).message });
      return null;
    }
  }

  let handle: import('node:fs/promises').FileHandle | null = null;
  try {
    handle = await fs.open(path.join(UPLOAD_DIR, name), 'r');
    const size = (await handle.stat()).size;
    if (start >= size) return { size, body: null };
    const last = Math.min(end, size - 1);
    const length = last - start + 1;
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    return { size, body: bytesRead === length ? buf : buf.subarray(0, bytesRead) };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** 같은 파일을 가리킬 수 있는 주소들 (/api/media 와 공개 CDN 주소) */
export function mediaUrlVariants(name: string): string[] {
  const out = [`/api/media/${name}`];
  if (S3_PUBLIC_BASE) out.push(`${S3_PUBLIC_BASE}/${S3_PREFIX}/${name}`);
  return out;
}

/**
 * 운영 환경에서 로컬 디스크 저장을 쓰고 있으면 경고한다.
 * (부팅 점검에서 호출. 다중 인스턴스·재배포 시 이미지가 사라지는 구성이다)
 */
export function storageWarnings(): string[] {
  if (STORAGE_DRIVER === 'local') {
    return [
      '이미지 저장이 서버 로컬 디스크(var/uploads)입니다. 다중 인스턴스에서는 이미지가 보이지 않고 재배포 시 사라집니다. STORAGE_DRIVER=s3 로 전환하세요.',
    ];
  }
  if (!S3_BUCKET) return ['STORAGE_DRIVER=s3 인데 S3_BUCKET 이 비어 있습니다.'];
  return [];
}

/**
 * 우리 업로드 저장소가 돌려준 이미지 주소인가 (5차 P2-12).
 * 팬챗방 사진처럼 다른 회원 화면에 그대로 뜨는 이미지는 외부 주소를 받지 않는다
 * (외부 서버가 보는 사람의 IP·접속 시각을 수집하는 추적 픽셀로 쓰일 수 있다).
 */
export function isOwnUploadUrl(url: string): boolean {
  const u = url.trim();
  if (/^\/api\/media\/[a-f0-9]{32}\.(jpg|png|gif|webp)$/.test(u)) return true;
  if (S3_PUBLIC_BASE && u.startsWith(`${S3_PUBLIC_BASE}/${S3_PREFIX}/`)) {
    const rest = u.slice(`${S3_PUBLIC_BASE}/${S3_PREFIX}/`.length);
    return /^[a-f0-9]{32}\.(jpg|png|gif|webp)$/.test(rest);
  }
  return false;
}


/** 팬챗 음성 · 영상 파일 확장자 (2026-11-18) */
export const TALK_MEDIA_EXT = {
  VOICE: ['mp3', 'm4a', 'webm', 'ogg', 'wav'],
  VIDEO: ['mp4', 'webm', 'mov'],
} as const;

export const MEDIA_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  webm: 'video/webm',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};

/** 우리 저장소가 돌려준 팬챗 음성 · 영상 주소인가 (외부 주소 · 다른 형식 거절) */
export function isOwnTalkMediaUrl(url: string, kind: 'VOICE' | 'VIDEO'): boolean {
  const u = url.trim();
  const exts = (TALK_MEDIA_EXT[kind] as readonly string[]).join('|');
  const re = new RegExp(`^[a-f0-9]{32}\\.(${exts})$`);
  if (u.startsWith('/api/media/')) return re.test(u.slice('/api/media/'.length));
  if (S3_PUBLIC_BASE && u.startsWith(`${S3_PUBLIC_BASE}/${S3_PREFIX}/`)) return re.test(u.slice(`${S3_PUBLIC_BASE}/${S3_PREFIX}/`.length));
  return false;
}
