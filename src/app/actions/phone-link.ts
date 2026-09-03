'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { kv } from '@/server/redis';
import { getSessionUser } from '@/server/auth';
import { newId } from '@/lib/id';
import { encrypt, generateNumericCode, hmac, maskPhone, normalizePhone, phoneHash, safeEqual } from '@/lib/crypto';
import { getMtAdapter } from '@/server/adapters/mt';
import { applyMtTemplateOverride, tplPhoneLinkVerify } from '@/server/services/mt-templates';
import { env, isLocal } from '@/lib/env';
import { logger } from '@/lib/logger';
import { promoteSignupFan } from '@/server/services/creator-fans';

/**
 * 휴대폰 번호 인증 → DonorProfile 연결.
 *
 * 문자후원의 후원자 식별 기준은 휴대전화 번호(phoneHash)다. 회원가입은 이메일만 받으므로,
 * 웹 계정에서 후원/결제 내역을 보려면 본인 휴대폰 번호를 인증해 DonorProfile 과 연결해야 한다.
 *
 * 보안 설계
 *  - 인증 상태(코드 검증값·시도 횟수)는 전부 서버측 KV(Redis, 개발 환경은 인메모리 폴백)에만 둔다.
 *    클라이언트에는 어떤 검증값도 내려보내지 않는다 (오프라인 역산·시도 횟수 재사용 차단).
 *  - 인증번호 원문은 어디에도 저장하지 않는다. 서버 시크릿 기반 HMAC 만 보관한다.
 *  - 발송은 사용자당·번호당 속도 제한을 건다 (SMS 폭탄 방지).
 *  - 유효시간 5분, 검증 시도 5회 초과 시 폐기.
 * 인증번호 발송은 MT 어댑터를 사용한다. 실제 문자 사업자 계약 전이므로 mock 어댑터가
 * 개발용 수신함(outbox)에만 적재하며, 비운영 환경에서는 화면에 발송된 코드를 함께 안내한다.
 */

const TTL_SEC = 300;
const MAX_ATTEMPTS = 5;
/** 발송 속도 제한: 10분에 사용자당 3회 / 번호당 3회 */
const SEND_WINDOW_SEC = 600;
const SEND_MAX = 3;

export interface PhoneLinkState {
  ok: boolean;
  message?: string;
  /** 인증번호 발송 완료 → 코드 입력 단계 */
  codeSent?: boolean;
  /** 마스킹된 발송 대상 번호 */
  phoneMasked?: string;
  /** 비운영 환경에서만 화면에 노출하는 mock 인증번호 */
  devCode?: string;
  /** 연결 완료 */
  linked?: boolean;
}

interface VerifyRecord {
  ph: string; // phoneHash
  pe: string; // phoneEnc (연결 시 프로필 생성용)
  pm: string; // phoneMasked
  ch: string; // hmac(code, sessionSecret)
  at: number; // 남은 시도 횟수
}

const stateKey = (userId: string) => `phonelink:state:${userId}`;
const sendUserKey = (userId: string) => `phonelink:send:user:${userId}`;
const sendPhoneKey = (ph: string) => `phonelink:send:phone:${ph}`;

function codeDigest(code: string): string {
  return hmac(code, env.crypto.sessionSecret);
}

function randomCode(): string {
  // 000000 방지를 위해 100000~999999 (CSPRNG)
  return generateNumericCode(6);
}

// ---------------------------------------------------------------- 1단계: 인증번호 발송

export async function requestPhoneVerification(
  _prev: PhoneLinkState,
  formData: FormData,
): Promise<PhoneLinkState> {
  const user = await getSessionUser();
  if (!user) return { ok: false, message: '로그인이 필요합니다.' };

  const phone = normalizePhone(String(formData.get('phone') ?? ''));
  if (!/^01[0-9]{8,9}$/.test(phone)) {
    return { ok: false, message: '휴대전화 번호 형식을 확인해 주세요. (예: 010-1234-5678)' };
  }

  const ph = phoneHash(phone);

  // 발송 속도 제한 (사용자·번호 각각)
  const [byUser, byPhone] = await Promise.all([
    kv.incr(sendUserKey(user.id), SEND_WINDOW_SEC),
    kv.incr(sendPhoneKey(ph), SEND_WINDOW_SEC),
  ]);
  if (byUser > SEND_MAX || byPhone > SEND_MAX) {
    return { ok: false, message: '인증번호 발송이 너무 잦습니다. 10분 후 다시 시도해 주세요.' };
  }

  // 이미 다른 계정에 연결된 번호는 발송 전에 차단한다.
  const existing = await prisma.donorProfile.findUnique({
    where: { phoneHash: ph },
    select: { userId: true },
  });
  if (existing?.userId && existing.userId !== user.id) {
    return { ok: false, message: '이미 다른 계정에 연결된 번호입니다. 고객센터로 문의해 주세요.' };
  }
  if (existing?.userId === user.id) {
    return { ok: false, message: '이미 이 계정에 연결된 번호입니다.' };
  }

  const code = randomCode();
  const masked = maskPhone(phone);

  const adapter = getMtAdapter();
  const template = await applyMtTemplateOverride(tplPhoneLinkVerify(code));
  const sent = await adapter.send({ to: phone, text: template.text, templateCode: template.code });
  if (!sent.ok) {
    return { ok: false, message: '인증번호 발송에 실패했습니다. 잠시 후 다시 시도해 주세요.' };
  }

  const record: VerifyRecord = { ph, pe: encrypt(phone), pm: masked, ch: codeDigest(code), at: MAX_ATTEMPTS };
  await kv.set(stateKey(user.id), JSON.stringify(record), TTL_SEC);
  logger.info('휴대폰 인증번호 발송', { userId: user.id, phone: masked });

  return {
    ok: true,
    codeSent: true,
    phoneMasked: masked,
    message: `${masked} 번호로 인증번호를 발송했습니다.`,
    // 실제 문자 발송 계약 전(mock 어댑터)이므로, 비운영 환경에서만 코드를 화면에 노출해 검증을 돕는다.
    devCode: isLocal && adapter.info().provider === 'mock' ? code : undefined,
  };
}

// ---------------------------------------------------------------- 2단계: 인증번호 확인 + 연결

export async function confirmPhoneVerification(
  _prev: PhoneLinkState,
  formData: FormData,
): Promise<PhoneLinkState> {
  const user = await getSessionUser();
  if (!user) return { ok: false, message: '로그인이 필요합니다.' };

  const code = String(formData.get('code') ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, codeSent: true, message: '인증번호 6자리를 입력해 주세요.' };
  }

  const raw = await kv.get(stateKey(user.id));
  if (!raw) {
    return { ok: false, message: '인증 유효시간이 지났습니다. 인증번호를 다시 요청해 주세요.' };
  }
  let record: VerifyRecord;
  try {
    record = JSON.parse(raw) as VerifyRecord;
  } catch {
    await kv.del(stateKey(user.id));
    return { ok: false, message: '인증 정보가 손상되었습니다. 인증번호를 다시 요청해 주세요.' };
  }

  if (!safeEqual(codeDigest(code), record.ch)) {
    const remain = record.at - 1;
    if (remain <= 0) {
      await kv.del(stateKey(user.id));
      return { ok: false, message: '인증번호를 5회 잘못 입력했습니다. 처음부터 다시 시도해 주세요.' };
    }
    await kv.set(stateKey(user.id), JSON.stringify({ ...record, at: remain }), TTL_SEC);
    return { ok: false, codeSent: true, message: `인증번호가 일치하지 않습니다. (남은 시도 ${remain}회)` };
  }

  // 성공 → 인증 상태는 즉시 폐기 (재사용 차단)
  await kv.del(stateKey(user.id));

  // 연결 시점에 한 번 더 소유권을 검증한다 (발송~확인 사이의 상태 변화 대비).
  const existing = await prisma.donorProfile.findUnique({
    where: { phoneHash: record.ph },
    select: { id: true, userId: true, previousUserId: true },
  });
  if (existing?.userId && existing.userId !== user.id) {
    return { ok: false, message: '이미 다른 계정에 연결된 번호입니다. 고객센터로 문의해 주세요.' };
  }

  /**
   * **번호 재사용(통신사 재배정) 대응.**
   *
   * 국내는 해지 번호가 일정 기간 뒤 다른 사람에게 재배정된다. 예전 구현은 계정 연결이
   * 끊긴 프로필(userId = null)을 아무나 인증만 하면 그대로 가져갔다. 그러면 새 사용자의
   * 마이페이지에 **이전 이용자의 후원·결제·동의 내역이 전부 보이고**, 이전 이용자의 결제에
   * 환불 요청까지 할 수 있었다.
   *
   * 그래서 "이전에 다른 계정에 연결됐던 프로필"은 재사용하지 않는다. 그 프로필은 은퇴
   * 처리(phoneHash 를 폐기값으로 회전)하고 새 프로필을 만든다. 과거 이력은 이전 프로필에
   * 그대로 남아 분쟁 대응에 쓸 수 있고, 새 사용자에게는 노출되지 않는다.
   *
   * 계정에 연결된 적이 없는 프로필(문자후원만 하던 번호)은 지금 본인확인을 마친 사람이
   * 그 번호의 현재 사용자이므로 그대로 이어받는다 — 기존 동작을 유지한다.
   */
  const recycled = Boolean(existing && !existing.userId && existing.previousUserId && existing.previousUserId !== user.id);

  await prisma.$transaction(async (tx) => {
    // 이 계정에 연결돼 있던 다른 번호는 연결을 끊는다(계정당 번호 1개).
    await tx.donorProfile.updateMany({
      where: { userId: user.id, ...(existing ? { NOT: { id: existing.id } } : {}) },
      data: { userId: null, previousUserId: user.id, unlinkedAt: new Date() },
    });

    if (existing && !recycled) {
      await tx.donorProfile.update({ where: { id: existing.id }, data: { userId: user.id, unlinkedAt: null } });
      return;
    }

    if (existing && recycled) {
      // 은퇴 처리: phoneHash 는 유니크라 폐기값으로 회전시켜야 새 프로필이 같은 번호를 쓸 수 있다.
      await tx.donorProfile.update({
        where: { id: existing.id },
        data: {
          phoneHash: `retired:${existing.id}:${record.ph}`.slice(0, 200),
          retiredAt: new Date(),
          onboardingStatus: 'WITHDRAWN',
        },
      });
      logger.warn('번호 재사용 감지 — 이전 후원자 프로필을 분리했습니다.', { profileId: existing.id });
    }

    // 문자후원 이력이 없는 번호도 미리 연결해 두면 이후 후원이 자동으로 이 계정에 표시된다.
    await tx.donorProfile.create({
      data: {
        id: newId(),
        userId: user.id,
        phoneHash: record.ph,
        phoneEnc: record.pe,
        phoneMasked: record.pm,
        displayName: user.name ?? null,
      },
    });
  });

  logger.info('휴대폰 번호 연결 완료', { userId: user.id });

  /**
   * 후원 페이지로 가입만 해 두었던 팬을 링크 행으로 승격시킨다.
   * 번호가 붙어야 후원 내역을 집계할 수 있으므로, 연결이 끝난 지금이 그 시점이다.
   * 실패해도 번호 연결 자체는 되돌리지 않는다(귀속은 부가 기록이다).
   */
  const linkedDonor = await prisma.donorProfile.findUnique({
    where: { userId: user.id },
    select: { id: true },
  });
  if (linkedDonor) await promoteSignupFan(user.id, linkedDonor.id);

  revalidatePath('/my');
  revalidatePath('/my/account');

  return { ok: true, linked: true, message: '휴대폰 번호가 연결되었습니다. 이제 후원·결제 내역이 표시됩니다.' };
}

// ---------------------------------------------------------------- 연결 해제

export async function unlinkPhone(_prev: PhoneLinkState, _fd: FormData): Promise<PhoneLinkState> {
  const user = await getSessionUser();
  if (!user) return { ok: false, message: '로그인이 필요합니다.' };

  const updated = await prisma.donorProfile.updateMany({
    where: { userId: user.id },
    // 누가 마지막으로 쓰던 번호인지 남긴다. 나중에 다른 사람이 같은 번호를 인증하면
    // 이 값을 보고 프로필을 분리해, 이전 이용자의 이력이 새 사용자에게 넘어가지 않게 한다.
    data: { userId: null, previousUserId: user.id, unlinkedAt: new Date() },
  });
  if (updated.count === 0) return { ok: false, message: '연결된 휴대폰 번호가 없습니다.' };

  revalidatePath('/my');
  revalidatePath('/my/account');
  return { ok: true, message: '휴대폰 번호 연결을 해제했습니다. 후원 이력 자체는 삭제되지 않습니다.' };
}
