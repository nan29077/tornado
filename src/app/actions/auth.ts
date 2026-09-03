'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { createSession, hashPassword } from '@/server/auth';
import { isLocal } from '@/lib/env';
import { consumeIpRateLimit } from '@/server/rate-limit';
import { authReturnPath } from '@/lib/auth-return-path';
import { ensureDonorPreviewSeed } from '@/server/services/donor-preview-seed';

/**
 * 후원자 회원가입.
 * - 회원가입은 선택 기능이다. 문자후원 자체는 계좌 등록만으로 이용할 수 있다.
 * - 여기서는 전화번호를 수집하지 않는다. 후원자 프로필(DonorProfile)은 MO 수신 시 생성된다.
 */

export interface SignupFormState {
  ok: boolean;
  message?: string;
  /** 재입력 편의를 위한 값 (비밀번호는 보관하지 않는다) */
  values?: { email: string; name: string };
}

const schema = z
  .object({
    email: z.string().trim().toLowerCase().email('이메일 형식이 올바르지 않습니다.'),
    name: z
      .string()
      .trim()
      .min(1, '이름을 입력해 주세요.')
      .max(20, '이름은 20자 이내로 입력해 주세요.'),
    password: z
      .string()
      .min(8, '비밀번호는 8자 이상이어야 합니다.')
      .max(72, '비밀번호는 72자 이내로 입력해 주세요.'),
    passwordConfirm: z.string(),
    agreeTerms: z.string().optional(),
  })
  .refine((v) => v.password === v.passwordConfirm, {
    message: '비밀번호가 서로 일치하지 않습니다.',
    path: ['passwordConfirm'],
  })
  .refine((v) => v.agreeTerms === 'on', {
    message: '이용약관과 개인정보처리방침에 동의해 주세요.',
    path: ['agreeTerms'],
  });

export async function signupDonor(_prev: SignupFormState, formData: FormData): Promise<SignupFormState> {
  const raw = {
    email: String(formData.get('email') ?? ''),
    name: String(formData.get('name') ?? ''),
    password: String(formData.get('password') ?? ''),
    passwordConfirm: String(formData.get('passwordConfirm') ?? ''),
    agreeTerms: formData.get('agreeTerms') ? 'on' : undefined,
  };
  const values = { email: raw.email.trim(), name: raw.name.trim() };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? '입력값을 확인해 주세요.', values };
  }

  // 자동화 도구로 계정을 대량 생성하는 것을 막는다. (같은 IP 기준 분당 5회)
  const limited = await consumeIpRateLimit('signup', 5, 60);
  if (!limited.ok) {
    return { ok: false, message: '가입 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.', values };
  }

  const email = parsed.data.email;

  const exists = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (exists) {
    return { ok: false, message: '이미 가입된 이메일입니다. 로그인해 주세요.', values };
  }

  let userId: string;
  try {
    const user = await prisma.user.create({
      data: {
        id: newId(),
        email,
        name: parsed.data.name,
        role: 'DONOR',
        passwordHash: await hashPassword(parsed.data.password),
      },
      select: { id: true },
    });
    userId = user.id;
  } catch {
    return { ok: false, message: '가입 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.', values };
  }

  // 기존에 문자만으로 생성된 후원자 프로필이 있다면 이후 연결은 계좌 등록 흐름에서 처리한다.
  await createSession(userId);

  redirect('/my');
}

/* ---------------------------------------------------------------------------
 * 테스트 로그인 (개발·검수 전용)
 *
 * 비밀번호 없이 시드 계정으로 바로 로그인한다.
 * APP_ENV=local 에서만 동작하며, 그 외 환경에서는 화면과 서버 액션 양쪽에서 차단된다.
 * ------------------------------------------------------------------------- */

export interface TestLoginState {
  message?: string;
}

/** 테스트 로그인이 허용되는 환경인지 */
export async function isTestLoginAllowed(): Promise<boolean> {
  // 화이트리스트 방식: local 에서만 허용한다. (APP_ENV 오타/미설정은 env 로더가 prod 로 간주)
  return isLocal;
}

const TEST_ACCOUNTS = {
  admin: { email: 'admin@tornado.kr', label: '최고관리자', redirect: '/admin' },
  creator: { email: 'creator1@tornado.kr', label: '크리에이터', redirect: '/studio' },
  donor: { email: 'donor@tornado.kr', label: '후원자', redirect: '/my' },
} as const;

export type TestAccountKey = keyof typeof TEST_ACCOUNTS;

export async function testLogin(_prev: TestLoginState, formData: FormData): Promise<TestLoginState> {
  if (!isLocal) {
    return { message: '이 환경에서는 테스트 로그인을 사용할 수 없습니다. (APP_ENV=local 전용)' };
  }

  const key = String(formData.get('account') ?? '') as TestAccountKey;
  const account = TEST_ACCOUNTS[key];
  if (!account) return { message: '알 수 없는 테스트 계정입니다.' };

  if (key === 'donor') {
    try { await ensureDonorPreviewSeed(); }
    catch { return { message: '테스트 후원자 데이터를 준비하지 못했습니다. DB 마이그레이션과 테스트 계정 연결을 확인해 주세요.' }; }
  }

  const user = await prisma.user.findUnique({
    where: { email: account.email },
    select: { id: true, status: true, role: true },
  });

  if (!user) {
    return {
      message: `${account.label} 시드 계정(${account.email})이 없습니다. 도구_DB초기화.bat 으로 시드를 다시 생성해 주세요.`,
    };
  }
  if (user.status !== 'ACTIVE') {
    return { message: `${account.label} 계정이 활성 상태가 아닙니다.` };
  }

  if (key === 'donor' && user.role !== 'DONOR') return { message: '테스트 후원자 계정의 역할을 확인해 주세요.' };
  await createSession(user.id);
  redirect(key === 'donor' ? authReturnPath(formData.get('next'), account.redirect) : account.redirect);
}
