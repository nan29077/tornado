/** 팬챗 음성 · 영상 파일 판정 (2026-11-18) */

export const TALK_UPLOAD_MAX = { VOICE: 15 * 1024 * 1024, VIDEO: 80 * 1024 * 1024 } as const;

type Kind = keyof typeof TALK_UPLOAD_MAX;

/** 컨테이너 판정. 같은 mp4 컨테이너라도 음성 요청이면 m4a 로 저장한다 */
export function sniffTalkMedia(buf: Buffer, kind: Kind): string | null {
  if (buf.length < 12) return null;
  const ascii = (a: number, b: number) => buf.subarray(a, b).toString('latin1');
  const isWebm = buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
  const isFtyp = ascii(4, 8) === 'ftyp';
  if (kind === 'VOICE') {
    if (ascii(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'mp3';
    if (isFtyp) return 'm4a';
    if (isWebm) return 'webm';
    if (ascii(0, 4) === 'OggS') return 'ogg';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
    return null;
  }
  if (isFtyp) return ascii(8, 10) === 'qt' ? 'mov' : 'mp4';
  if (isWebm) return 'webm';
  return null;
}

