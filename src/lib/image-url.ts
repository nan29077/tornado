import { z } from 'zod';

/**
 * 아바타·배너 이미지 주소.
 *
 * `z.url()` 만으로는 부족하다
 * ---------------------------
 * `z.url()` 은 `new URL()` 이 통과하는지만 본다. 그래서 `javascript:...` 와
 * `data:image/...;base64,....` 도 그대로 저장됐다.
 *  - `javascript:` 는 이 값이 링크로 쓰이는 자리에서 스크립트가 된다.
 *  - `data:` 는 길이 제한이 없어 수 MB 짜리 값이 DB 에 들어가고, 프로필·후원 페이지를
 *    그릴 때마다 그 전체가 응답에 실려 나간다.
 * 스킴을 http(s) 로 잠그고 길이 상한도 둔다.
 */
export const MAX_IMAGE_URL_LEN = 500;

const LENGTH_MESSAGE = `이미지 주소는 ${MAX_IMAGE_URL_LEN}자 이내여야 합니다.`;
const SHAPE_MESSAGE = '이미지 주소는 http(s) 주소 또는 / 로 시작하는 경로여야 합니다.';

export const imageUrlSchema = z.union([
  z.literal(''),
  z
    .string()
    .max(MAX_IMAGE_URL_LEN, LENGTH_MESSAGE)
    .refine((v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'https:' || u.protocol === 'http:';
      } catch {
        return false;
      }
    }, SHAPE_MESSAGE),
  z.string().max(MAX_IMAGE_URL_LEN, LENGTH_MESSAGE).regex(/^\/[^\s]*$/u, SHAPE_MESSAGE),
]);
