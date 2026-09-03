import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { kv } from '@/server/redis';
import { createSession, verifyPassword } from '@/server/auth';
import { isSameOrigin } from '@/server/request-guard';
import { clientIpFromRequest, consumeRateLimit } from '@/server/rate-limit';

export const runtime = 'nodejs';

const schema = z.object({
  email: z.string().email('이메일 형식이 올바르지 않습니다.'),
  password: z.string().min(1, '비밀번호를 입력해 주세요.'),
});

export async function POST(req: Request) {
  // CSRF 방어: 외부 사이트에서 강제로 로그인시키는(세션 고정) 공격을 막는다.
  if (!isSameOrigin(req)) {
    return NextResponse.json({ ok: false, message: '허용되지 않은 요청입니다.' }, { status: 403 });
  }

  // 본문은 한 번만 읽을 수 있으므로 Content-Type 으로 분기한다.
  const contentType = req.headers.get('content-type') ?? '';
  const isForm = contentType.includes('form-data') || contentType.includes('x-www-form-urlencoded');

  let payload: { email?: string; password?: string } = {};
  let nextPath: string | null = null;
  if (isForm) {
    const form = await req.formData().catch(() => null);
    payload = {
      email: String(form?.get('email') ?? ''),
      password: String(form?.get('password') ?? ''),
    };
    nextPath = safeNextPath(form?.get('next'));
  } else {
    payload = (await req.json().catch(() => ({}))) as typeof payload;
  }

  // HTML 폼 제출은 JSON 대신 로그인 화면으로 되돌려 오류를 안내한다.
  // (로그인 페이지의 ERROR_MESSAGES 키와 맞춘다: required / ratelimit / invalid / suspended)
  const fail = (code: 'required' | 'ratelimit' | 'invalid' | 'suspended', message: string, status: number) => {
    if (isForm) {
      const url = new URL('/login', req.url);
      url.searchParams.set('error', code);
      if (nextPath) url.searchParams.set('next', nextPath);
      return NextResponse.redirect(url, 303);
    }
    return NextResponse.json({ ok: false, message }, { status });
  };

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return fail('required', parsed.error.issues[0]?.message ?? '입력값을 확인해 주세요.', 400);
  }

  // 브루트포스 방어: 계정 단위 + 발신 IP 단위(계정을 바꿔가며 시도하는 크리덴셜 스터핑 차단)
  // IP 를 알 수 없으면(프록시 없이 직접 접근) 모든 클라이언트가 한 버킷을 공유해 서로를 잠그므로
  // 계정 단위 제한만 적용한다.
  const ip = clientIpFromRequest(req);
  /**
   * 카운터 저장소 장애 시 **막는 쪽**으로 처리한다(fail-closed).
   * 예전에는 kv.incr 를 직접 불러 Redis 장애가 그대로 500 이 됐고, 다른 입구(가입·재설정)는
   * 반대로 제한이 통째로 열렸다. 같은 장애에서 정반대로 동작하던 것을 공통 유틸로 통일한다.
   */
  const [accountLimit, ipLimit] = await Promise.all([
    consumeRateLimit('login', parsed.data.email.toLowerCase(), 10, 600, { failClosed: true }),
    consumeRateLimit('login-ip', ip, 50, 600, { failClosed: true }),
  ]);
  if (!accountLimit.ok || !ipLimit.ok) {
    return fail('ratelimit', '로그인 시도가 많습니다. 잠시 후 다시 시도해 주세요.', 429);
  }

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
  /**
   * 계정이 없어도 **비밀번호 비교를 똑같이 수행**한다.
   *
   * verifyPassword 는 hash 가 없으면 bcrypt 를 건너뛰고 즉시 false 를 돌려준다. 그러면
   * 존재하지 않는 이메일은 응답이 눈에 띄게 빨라져, 문구가 같아도 **응답 시간만으로
   * 가입 여부를 판별**할 수 있었다. 더미 해시로 같은 비용을 치른다.
   */
  const passwordOk = user?.passwordHash
    ? await verifyPassword(parsed.data.password, user.passwordHash)
    : await burnPasswordCompare(parsed.data.password);
  if (!user || !passwordOk) {
    return fail('invalid', '이메일 또는 비밀번호가 올바르지 않습니다.', 401);
  }
  if (user.status !== 'ACTIVE') {
    return fail('suspended', '이용이 제한된 계정입니다.', 403);
  }

  await createSession(user.id);
  await kv.del(`rl:login:${parsed.data.email.toLowerCase()}`).catch(() => undefined);

  const home = user.role === 'ADMIN' ? '/admin' : user.role === 'CREATOR' ? '/studio' : '/my';
  const redirect = nextPath ?? home;
  if (isForm) return NextResponse.redirect(new URL(redirect, req.url), 303);
  return NextResponse.json({ ok: true, redirect });
}

/** 같은 사이트 내부 경로만 로그인 후 이동 대상으로 허용한다 (오픈 리다이렉트 방지). */
function safeNextPath(value: FormDataEntryValue | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  if (!/^\/(?![\/\\])/.test(value)) return null;
  if (value.startsWith('/api/') || value.startsWith('/login')) return null;
  return value.length > 512 ? null : value;
}

/**
 * 계정이 없을 때도 같은 시간을 쓰기 위한 더미 비교.
 * 결과는 항상 false 다. (bcrypt cost 10 짜리 고정 해시)
 */
const DUMMY_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8.7HqTQ0ZLrqf3M1z2ZQd9C0nHhs5W';
async function burnPasswordCompare(plain: string): Promise<boolean> {
  await verifyPassword(plain, DUMMY_HASH).catch(() => false);
  return false;
}
