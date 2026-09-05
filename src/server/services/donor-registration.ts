import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { decrypt, encrypt, maskSecret } from '@/lib/crypto';
import { logger, scrubText } from '@/lib/logger';
import { notifySuperAdmins } from './notifications';
import { env } from '@/lib/env';
import { getPaymentAdapter } from '@/server/adapters/payment';
import { resolveSecureLink, consumeSecureLink } from './secure-link';
import { validateDonorName } from './donor-name';
import type { ConsentType, PaymentMethodKind } from '@/generated/prisma/enums';

/**
 * 후원자 계좌 등록 (헥토 내통장결제 0원 인증 후 빌키 발급 흐름).
 *
 * 저장 규칙
 *  - 계좌번호 원문과 인증정보는 도네이도 DB 에 저장하지 않는다.
 *  - 은행명과 계좌 끝 4자리, 암호화된 빌키만 보관한다.
 */

export interface RegistrationContext {
  linkId: string;
  donorId: string;
  creatorId: string | null;
  creatorName: string | null;
  donationAmount: bigint;
  phoneMasked: string;
}

export async function loadRegistrationContext(token: string): Promise<
  { ok: true; ctx: RegistrationContext } | { ok: false; reason: string }
> {
  const res = await resolveSecureLink(token);
  if (!res.ok) {
    const reason =
      res.reason === 'EXPIRED' ? '가입 링크가 만료되었습니다. 크리에이터 번호로 문자를 다시 보내면 새 링크가 발송됩니다.'
      : res.reason === 'USED' ? '이미 사용된 링크입니다.'
      : '유효하지 않은 링크입니다.';
    return { ok: false, reason };
  }
  const link = res.link!;
  if (link.purpose !== 'REGISTER_ACCOUNT') return { ok: false, reason: '용도가 다른 링크입니다.' };

  const donor = await prisma.donorProfile.findUnique({ where: { phoneHash: link.phoneHash } });
  if (!donor) return { ok: false, reason: '후원자 정보를 찾을 수 없습니다.' };

  const creator = link.creatorId
    ? await prisma.creatorProfile.findUnique({ where: { id: link.creatorId } })
    : null;

  return {
    ok: true,
    ctx: {
      linkId: link.id,
      donorId: donor.id,
      creatorId: creator?.id ?? null,
      creatorName: creator?.displayName ?? null,
      donationAmount: creator?.donationAmount ?? 3000n,
      phoneMasked: donor.phoneMasked,
    },
  };
}

export interface ConsentInput {
  type: ConsentType;
  agreed: boolean;
}

/**
 * 결제창 세션 생성. 필수 동의가 모두 있어야 진행한다.
 *
 * `method` 로 계좌(ACCOUNT) / 카드(CARD) 빌키를 구분한다.
 * 카드 빌링키는 아직 실 연동 전이라 어댑터가 실패를 돌려주며, 여기서는 구조만 준비해 둔다.
 */
export async function startRegistration(input: {
  token: string;
  consents: ConsentInput[];
  method?: PaymentMethodKind;
  /** 방송에 표시될 닉네임(선택). 빈 값이면 설정하지 않은 것으로 본다. */
  nickname?: string;
  /** SNS 플랫폼(선택). 닉네임과 세트로 저장한다. */
  snsPlatform?: string;
  /**
   * 결제창(호스팅 페이지) 생성을 건너뛴다.
   * 결제창이 없는 사업자(코엠 카드 빌키)에서만 true 로 준다.
   */
  skipProviderSession?: boolean;
  ip?: string;
  userAgent?: string;
}) {
  const loaded = await loadRegistrationContext(input.token);
  if (!loaded.ok) throw new Error(loaded.reason);
  const { ctx } = loaded;

  const requiredTerms = await prisma.termsVersion.findMany({ where: { active: true, required: true } });
  const agreedTypes = new Set(input.consents.filter((c) => c.agreed).map((c) => c.type));
  const missing = requiredTerms.filter((t) => !agreedTypes.has(t.type));
  if (missing.length > 0) {
    throw new Error(`필수 동의 항목이 누락되었습니다: ${missing.map((m) => m.title).join(', ')}`);
  }

  const donor = await prisma.donorProfile.findUnique({ where: { id: ctx.donorId } });
  if (!donor) throw new Error('후원자 정보를 찾을 수 없습니다.');

  // 방송 닉네임(선택). 결제창으로 넘어가기 전에 저장해 둔다.
  // 결제창에서 이탈해도 닉네임은 남으므로 다시 등록할 때 또 입력하지 않아도 된다.
  if (input.nickname !== undefined && input.nickname.trim().length > 0) {
    const checked = await validateDonorName(input.nickname);
    if (!checked.ok) throw new Error(checked.message ?? '닉네임을 다시 입력해 주세요.');
    await prisma.donorProfile.update({
      where: { id: donor.id },
      data: {
        displayName: checked.value,
        snsPlatform: input.snsPlatform?.trim() || null,
      },
    });
  }

  // 동의 이력 저장 (약관 버전 포함)
  const allTerms = await prisma.termsVersion.findMany({ where: { active: true } });
  for (const c of input.consents) {
    const terms = allTerms.find((t) => t.type === c.type);
    if (!terms) continue;
    await prisma.consentRecord.create({
      data: {
        id: newId(),
        phoneHash: donor.phoneHash,
        userId: donor.userId ?? null,
        termsId: terms.id,
        type: c.type,
        agreed: c.agreed,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  }

  const method: PaymentMethodKind = input.method ?? 'ACCOUNT';

  const registration = await prisma.paymentRegistration.create({
    data: {
      id: newId(),
      donorId: ctx.donorId,
      creatorId: ctx.creatorId,
      provider: env.payment.provider,
      method,
    },
  });

  /**
   * 결제창이 없는 사업자(코엠 카드 빌키 등)는 이 단계를 건너뛴다.
   *
   * 코엠 DIRECTPAY 는 호스팅 결제창 없이 카드번호를 우리 서버가 직접 받는 방식이라
   * 리다이렉트할 URL 자체가 존재하지 않는다. 그런 경우에도 등록 행(paymentRegistration)은
   * 필요하므로, 행만 만들고 redirectUrl 은 null 로 돌려준다.
   * 이후 completeRegistration() 이 카드정보를 받아 빌키를 발급한다.
   */
  if (input.skipProviderSession) {
    return { registrationId: registration.id, redirectUrl: null as string | null, ctx };
  }

  const adapter = getPaymentAdapter();
  const session = await adapter.createRegistrationSession({
    donorRef: registration.id,
    returnUrl: `${env.baseUrl}/r/${input.token}/complete`,
    notifyUrl: `${env.baseUrl}/api/payments/notify`,
    method,
  });
  if (!session.ok || !session.data) throw new Error(session.message ?? '결제창 생성에 실패했습니다.');

  await prisma.paymentRegistration.update({
    where: { id: registration.id },
    data: { status: 'AUTH_DONE', providerTid: session.data.providerTid },
  });

  return { registrationId: registration.id, redirectUrl: session.data.redirectUrl as string | null, ctx };
}

/** 결제창 콜백 처리 → 빌키 저장. 계좌 원문은 저장하지 않는다. */
export async function completeRegistration(input: {
  token: string;
  registrationId: string;
  providerPayload: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}) {
  const loaded = await loadRegistrationContext(input.token);
  if (!loaded.ok) throw new Error(loaded.reason);
  const { ctx } = loaded;

  // registrationId 는 클라이언트가 보낸 값이다. 링크 소유자(donorId)의 등록 건이 아니면 거절한다.
  // 사업자 호출보다 먼저 확인한다. 남의 등록번호로 빌키를 발급받아 버리고 나서 거절하면
  // 사업자 쪽에는 쓰지도 않을 빌키가 남는다.
  const owned = await prisma.paymentRegistration.findFirst({
    where: { id: input.registrationId, donorId: ctx.donorId },
    select: { id: true, status: true, method: true },
  });
  if (!owned) throw new Error('등록 요청 정보가 올바르지 않습니다. 처음부터 다시 진행해 주세요.');
  if (owned.status === 'COMPLETED') throw new Error('이미 완료된 등록 요청입니다.');

  const adapter = getPaymentAdapter();
  // 결제수단 종류는 결제창 응답이 아니라 우리가 시작할 때 기록한 값이 기준이다.
  // registrationId 를 함께 주입한다. 카카오 등 partner_order_id/partner_user_id 를
  // DB 에 저장하지 않고 재현해야 하는 어댑터에서 사용한다(kakao.ts 주석 참고).
  const res = await adapter.completeRegistration({ ...input.providerPayload, method: owned.method, registrationId: owned.id });

  if (!res.ok || !res.data) {
    await prisma.paymentRegistration.update({
      where: { id: input.registrationId },
      data: { status: 'FAILED', resultCode: res.code ?? null, resultMessage: res.message != null ? scrubText(res.message) : null },
    });
    throw new Error(res.message ?? '계좌 등록에 실패했습니다.');
  }

  // 기존 활성 결제수단은 폐기 (활성 1건 유지)
  await prisma.paymentMethodToken.updateMany({
    where: { donorId: ctx.donorId, status: 'ACTIVE' },
    data: { status: 'REVOKED', revokedAt: new Date() },
  });

  // 빌키 종류는 사업자 응답을 우선하고, 없으면 등록을 시작할 때 기록해 둔 값을 쓴다.
  const method: PaymentMethodKind = res.data.method ?? owned.method ?? 'ACCOUNT';

  const token = await prisma.paymentMethodToken.create({
    data: {
      id: newId(),
      donorId: ctx.donorId,
      provider: env.payment.provider,
      method,
      billKeyEnc: encrypt(res.data.billKey),
      billKeyHint: maskSecret(res.data.billKey),
      bankCode: res.data.bankCode ?? null,
      bankName: res.data.bankName ?? null,
      accountTail4: res.data.accountTail4 ?? null,
      // 카드 원문은 저장하지 않는다. 발급사명과 끝 4자리만 보관한다.
      cardIssuer: res.data.cardIssuer ?? null,
      cardTail4: res.data.cardTail4 ?? null,
    },
  });

  await prisma.paymentRegistration.update({
    where: { id: input.registrationId },
    data: { status: 'COMPLETED', providerTid: res.data.providerTid, completedAt: new Date() },
  });

  await prisma.donorProfile.update({
    where: { id: ctx.donorId },
    data: { registeredAt: new Date(), ageVerified: true, onboardingStatus: 'REGISTERED' },
  });

  if (ctx.creatorId) {
    await prisma.donorCreatorLink.upsert({
      where: { donorId_creatorId: { donorId: ctx.donorId, creatorId: ctx.creatorId } },
      create: { id: newId(), donorId: ctx.donorId, creatorId: ctx.creatorId, consentedAt: new Date() },
      update: { consentedAt: new Date() },
    });
  }

  // 링크는 1회만 사용 가능
  await consumeSecureLink(ctx.linkId, input.ip, input.userAgent);

  return {
    tokenId: token.id,
    donorId: ctx.donorId,
    method: token.method,
    bankName: token.bankName,
    accountTail4: token.accountTail4,
    cardIssuer: token.cardIssuer,
    cardTail4: token.cardTail4,
  };
}

/**
 * 사업자(PG) 빌키 해지를 한 번 시도하고 결과를 행에 남긴다.
 *
 * 성공하면 빌키 암호문까지 지운다. 해지된 빌키를 계속 보관할 이유가 없고,
 * 남겨 두면 유출 시 그대로 위험이 된다.
 * 실패하면 암호문을 **남겨 둔다.** 지우면 다시 시도할 방법이 사라지고,
 * 후원자는 해지한 줄 아는데 PG 쪽 빌키만 영원히 살아 있게 된다.
 */
async function attemptBillKeyRevoke(token: { id: string; donorId: string; billKeyEnc: string; revokeAttempts: number }) {
  const adapter = getPaymentAdapter();
  const revoked = await adapter
    .revokeBillKey(decrypt(token.billKeyEnc))
    .catch((e: unknown) => ({ ok: false as const, message: (e as Error)?.message }));

  if (revoked.ok) {
    await prisma.paymentMethodToken.update({
      where: { id: token.id },
      data: { billKeyEnc: '', revokeFailedAt: null, revokeLastError: null },
    });
    return true;
  }

  const attempts = token.revokeAttempts + 1;
  await prisma.paymentMethodToken.update({
    where: { id: token.id },
    data: {
      revokeFailedAt: new Date(),
      revokeAttempts: attempts,
      // 사유는 사고 조사용이다. 길게 남기면 응답 원문이 통째로 들어올 수 있어 자른다.
      revokeLastError: (revoked.message ?? '알 수 없는 오류').slice(0, 300),
    },
  });
  logger.error('빌키 해지 실패 (내부 상태는 폐기, 재시도 대상)', {
    donorId: token.donorId,
    tokenId: token.id,
    attempts,
    message: revoked.message,
  });
  return false;
}

/** 자동출금 동의 해지 = 등록 결제수단 폐기 */
export async function revokePaymentMethod(donorId: string) {
  const active = await prisma.paymentMethodToken.findFirst({ where: { donorId, status: 'ACTIVE' } });
  if (!active) return false;

  /**
   * 내부 상태를 먼저 폐기로 바꾼다. 사업자 해지가 실패해도 이 빌키로는 더 이상 출금하지 않는다.
   * 사업자 쪽 해지는 실패해도 여기서 되돌리지 않고 `retryFailedBillKeyRevocations` 가 이어받는다.
   * (해지 요청 자체가 실패로 보이면 후원자가 다시 눌러도 이미 REVOKED 라 아무 일도 일어나지 않는다)
   */
  await prisma.paymentMethodToken.update({
    where: { id: active.id },
    data: { status: 'REVOKED', revokedAt: new Date() },
  });
  await prisma.donorProfile.update({
    where: { id: donorId },
    data: { onboardingStatus: 'SUSPENDED' },
  });

  // 사업자에는 빌키 원문을 보내야 한다(암호문을 보내면 PG 측 빌키가 살아남는다).
  await attemptBillKeyRevoke(active);
  return true;
}

/** 재시도 상한. 넘으면 자동 재시도를 멈추고 관리자 확인 큐로 넘긴다. */
const BILLKEY_REVOKE_MAX_ATTEMPTS = 12;
/** 재시도 간격(분). 사업자 장애가 몇 시간 이어져도 따라붙을 만큼만 촘촘하게. */
const BILLKEY_REVOKE_RETRY_MINUTES = 30;

/**
 * 사업자 해지에 실패한 빌키를 다시 해지한다. (크론)
 *
 * 이 배치가 없으면 "동의를 해지한 후원자의 빌키가 PG 에 살아 있는" 상태가 아무도 모르게 쌓인다.
 * 상한을 넘긴 건은 자동 재시도를 멈추고 최고관리자에게 알린다 — 사업자 계약/키 문제라
 * 코드가 반복해도 풀리지 않고, 사람이 봐야 한다.
 */
export async function retryFailedBillKeyRevocations(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - BILLKEY_REVOKE_RETRY_MINUTES * 60_000);
  const targets = await prisma.paymentMethodToken.findMany({
    where: {
      revokeFailedAt: { not: null, lt: cutoff },
      revokeAttempts: { lt: BILLKEY_REVOKE_MAX_ATTEMPTS },
      billKeyEnc: { not: '' },
    },
    select: { id: true, donorId: true, billKeyEnc: true, revokeAttempts: true },
    orderBy: { revokeFailedAt: 'asc' },
    take: 50,
  });

  let recovered = 0;
  for (const t of targets) {
    // 한 건이 실패해도 나머지는 계속 시도한다.
    try {
      if (await attemptBillKeyRevoke(t)) recovered += 1;
    } catch (e) {
      logger.error('빌키 해지 재시도 중 예외', { tokenId: t.id, message: (e as Error).message });
    }
  }

  /**
   * 상한을 넘겨 자동 재시도가 멈춘 건을 알린다.
   * 조용히 포기하면 이 배치를 만든 의미가 없다.
   */
  const givenUp = await prisma.paymentMethodToken.count({
    where: { revokeFailedAt: { not: null }, revokeAttempts: { gte: BILLKEY_REVOKE_MAX_ATTEMPTS } },
  });
  if (givenUp > 0) {
    await notifySuperAdmins({
      title: '사업자 빌키 해지에 반복 실패한 건이 있습니다',
      body: `${givenUp}건이 자동 재시도 상한(${BILLKEY_REVOKE_MAX_ATTEMPTS}회)을 넘겼습니다. 후원자는 자동출금 동의를 해지했지만 결제사 빌키가 남아 있을 수 있습니다. 결제사에 직접 해지를 요청해 주세요.`,
      linkUrl: '/admin/donors',
    }).catch(() => undefined);
  }

  return recovered;
}
