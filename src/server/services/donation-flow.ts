import { prisma } from '@/server/db';
import { newId, newOrderNo, newTransactionNo } from '@/lib/id';
import { decrypt, encrypt, maskPhone, normalizePhone, phoneHash as hashPhone } from '@/lib/crypto';
import { donorDisplayName } from '@/lib/donor-name';
import { logger } from '@/lib/logger';
import { env, allowLegacyConfirmLink } from '@/lib/env';
import type { MoInbound } from '@/server/adapters/mo';
import { getMtAdapter, decideMessageType } from '@/server/adapters/mt';
import { getPaymentAdapter, MockPaymentTimeout } from '@/server/adapters/payment';
import { filterContent, splitKeyword, type BannedWordRule } from './content-filter';
import { checkLimits, rollbackVelocity, commitCounters, rollbackCounters, registerFailure, clearFailures, resolvePolicy } from './limits';
import { acquireIdempotency } from './idempotency';
import { hasDirectTriggerWrittenApproval } from './financial-approval';
import { issueSecureLink, LINK_TTL_SEC } from './secure-link';
import * as tpl from './mt-templates';
import { calculateFees, postDonationSettlement } from './settlement';
import { notifySuperAdmins } from './notifications';
import { dispatchBroadcast } from './broadcast-dispatch';
import type { DonationStatus, MoProcessResult, PaymentMode } from '@/generated/prisma/enums';
import type { TemplateOutput } from './mt-templates';

/**
 * MO 수신 → 후원 거래 → 결제 → 방송 노출로 이어지는 핵심 흐름.
 *
 * 절대 원칙
 *  1) 결제 성공 건만 방송(유튜브/오버레이/TTS)에 노출한다.
 *  2) 결제 성공과 방송 전송 성공을 같은 상태로 취급하지 않는다.
 *  3) 같은 MO 가 재전송되어도 결제가 중복 승인되지 않는다.
 */

export interface MoHandleResult {
  result: MoProcessResult;
  moMessageId?: string;
  donationId?: string;
  status?: DonationStatus;
  message: string;
  /**
   * "지금은 중복으로 보이지만 확정된 결과가 아니다" 라는 표시 (E-3).
   *
   * 직전 수신 처리가 강제 종료로 중단되면 수신 로그가 PENDING 인 채 남는다. 그 상태에서
   * 같은 문자가 다시 들어오면 여기서 DUPLICATE 로 반려되는데, 호출부(EMMA 폴러)가 그것을
   * "처리 완료"로 받아들여 원본 행을 완료 처리해 버리면 **그 문자는 영영 재처리되지 않는다.**
   * 정리 배치(recoverStuckMoMessages)가 5분 뒤 PENDING 을 ERROR 로 풀어 주므로, 그때까지
   * 원본을 재처리 대상으로 남겨 두라고 호출부에 알린다.
   */
  retryLater?: boolean;
}

// ---------------------------------------------------------------------------
// 보조
// ---------------------------------------------------------------------------

/**
 * MT 문자 1건 발송 + 발송 이력(MtOutboundMessage) 기록.
 * 발송 성공 여부를 boolean 으로 돌려주며, 어댑터 예외는 내부에서 흡수해 이력만 FAILED 로 남긴다.
 * (MO 흐름 외에 PC 웹 가입 안내에서도 같은 이력 규칙을 쓴다 — 파일 하단에서 export)
 */
async function sendMt(input: {
  phone: string;
  template: TemplateOutput;
  donationId?: string | null;
  creatorId?: string | null;
}) {
  const adapter = getMtAdapter();
  // 관리자가 화면에서 저장한 본문이 있으면 그 문구로 바꿔 보낸다.
  // (조회 실패 시에는 원본 템플릿이 그대로 돌아오므로 발송 자체는 막히지 않는다)
  const template = await tpl.applyMtTemplateOverride(input.template);
  const row = await prisma.mtOutboundMessage.create({
    data: {
      id: newId(),
      phoneHash: hashPhone(input.phone),
      phoneEnc: encrypt(normalizePhone(input.phone)),
      phoneMasked: maskPhone(input.phone),
      fromNumber: env.mt.fromNumber,
      messageType: decideMessageType(template.text),
      templateCode: template.code,
      bodyMasked: template.masked,
      donationId: input.donationId ?? null,
      creatorId: input.creatorId ?? null,
    },
  });

  try {
    const res = await adapter.send({
      to: normalizePhone(input.phone),
      text: template.text,
      templateCode: template.code,
      // 장문으로 나갈 때만 쓰인다. 단문 어댑터는 무시한다.
      subject: tpl.mtSubjectFor(template.code),
    });
    await prisma.mtOutboundMessage.update({
      where: { id: row.id },
      data: {
        status: res.ok ? 'SENT' : 'FAILED',
        providerCode: adapter.info().provider,
        providerMessageId: res.data?.providerMessageId ?? null,
        resultCode: res.code ?? null,
        resultMessage: res.message ?? null,
        attempts: { increment: 1 },
        sentAt: res.ok ? new Date() : null,
      },
    });
    if (input.donationId) {
      await prisma.donation.update({
        where: { id: input.donationId },
        data: { mtStatus: res.ok ? 'SENT' : 'FAILED' },
      });
    }
    return res.ok;
  } catch (e) {
    await prisma.mtOutboundMessage.update({
      where: { id: row.id },
      data: { status: 'FAILED', resultMessage: (e as Error).message, attempts: { increment: 1 } },
    });
    logger.error('MT 발송 실패', { message: (e as Error).message });
    return false;
  }
}

/**
 * 결제 결과 미확인(UNKNOWN) 건을 관리자 확인 큐에 올린다.
 *
 * 출금이 실제로 일어났는지 앱이 알 수 없는 상태이므로, 사람이 결제사 원장과
 * 대사해서 승인/실패를 확정해야 한다. 같은 거래로 여러 번 올라오지 않도록
 * 미해결 건이 이미 있으면 새로 만들지 않는다.
 */
async function raiseUnknownPaymentAlert(
  donationId: string,
  transactionId: string,
  orderNo: string,
  amount: bigint,
) {
  try {
    const existing = await prisma.riskDetection.findFirst({
      where: { donationId, type: 'PAYMENT_UNKNOWN', resolved: false },
      select: { id: true },
    });
    if (existing) return;
    await prisma.riskDetection.create({
      data: {
        id: newId(),
        donationId,
        type: 'PAYMENT_UNKNOWN',
        level: 'CRITICAL',
        detail: {
          transactionId,
          orderNo,
          amount: amount.toString(),
          note: '결제 승인 결과를 확인하지 못했습니다. 결제사 원장과 대사한 뒤 승인/실패를 확정해 주세요.',
        } as object,
      },
    });

    // 화면을 열어보기 전에도 알 수 있도록 최고관리자 알림함에도 올린다.
    // 이 건은 후원자 통장에서 돈이 빠졌을 수 있어 대사가 늦을수록 손해가 커진다.
    await notifySuperAdmins({
      title: '결제 결과를 확인하지 못한 건이 있습니다',
      body: `주문번호 ${orderNo} · ${amount.toString()}원. 결제사 원장과 대사한 뒤 승인/실패를 확정해 주세요.`,
      linkUrl: '/admin/payments',
    });
  } catch (e) {
    // 알림 생성 실패가 결제 처리 흐름을 막으면 안 된다. 로그로만 남긴다.
    logger.error('결제 미확인 알림 생성 실패', { donationId, message: (e as Error).message });
  }
}

async function setStatus(donationId: string, to: DonationStatus, reason?: string, actor = 'system') {
  const cur = await prisma.donation.findUnique({ where: { id: donationId }, select: { status: true } });
  await prisma.$transaction([
    prisma.donation.update({ where: { id: donationId }, data: { status: to, statusReason: reason ?? null } }),
    prisma.donationStatusLog.create({
      data: { id: newId(), donationId, fromStatus: cur?.status ?? null, toStatus: to, reason: reason ?? null, actor },
    }),
  ]);
}

export async function loadBannedWords(creatorId: string): Promise<BannedWordRule[]> {
  const rows = await prisma.bannedWord.findMany({
    where: { active: true, OR: [{ scope: 'GLOBAL' }, { creatorId }] },
    select: { word: true, action: true },
  });
  return rows.map((r) => ({ word: r.word, action: r.action }));
}

/** 수신번호(+키워드)로 크리에이터를 찾는다. */

/**
 * 문자 본문 맨 앞의 "N원" 표기를 금액으로 해석하는 파서.
 *
 * 현재 MO 수신 흐름에서는 **호출하지 않는다.**
 * 모바일 문자 후원은 크리에이터가 설정한 고정 금액만 사용하며, 본문의 금액 표기가
 * 결제 금액을 덮어쓰지 않도록 processMoRow 의 호출부를 비활성화했다.
 * 금액을 직접 지정하는 후원은 PC 웹 경로(web-donation)에서 화면 입력값으로 처리한다.
 * 파서 자체는 향후 재도입·이력 분석을 위해 남겨 둔다.
 *
 * 예) "5000원 오늘도 화이팅" → amount 5000, rest "오늘도 화이팅"
 *     "1,000원" → amount 1000, rest ""
 */
export function parseExplicitAmount(body: string): { amount: bigint | null; rest: string } {
  const m = body.match(/^\s*(\d{1,3}(?:,\d{3})+|\d{3,7})원(?=\s|$)/u);
  if (!m) return { amount: null, rest: body };
  const digits = m[1].replace(/,/g, '');
  try {
    return { amount: BigInt(digits), rest: body.slice(m[0].length).trim() };
  } catch {
    return { amount: null, rest: body };
  }
}

export async function routeCreator(receivedNumber: string, content: string) {
  const number = normalizePhone(receivedNumber) || receivedNumber;

  // 같은 번호에 걸린 배정 행을 한 번에 읽는다.
  // 전용(DEDICATED)과 대표번호공유(SHARED_PREFIX)가 같은 번호에 공존하면
  // 전용이 먼저 매칭돼 대표번호를 쓰던 모든 크리에이터의 후원이 전용 크리에이터
  // 1명에게 흘러들어간다. 후원자도 크리에이터도 알아챌 수 없는 사고이므로
  // 라우팅을 진행하지 않고 차단한 뒤 관리자에게 알린다.
  const rows = await prisma.creatorMoNumber.findMany({
    where: { phoneNumber: number, status: 'ASSIGNED', creatorId: { not: null } },
    include: { creator: true },
    orderBy: { assignedAt: 'desc' },
  });

  const dedicatedRows = rows.filter((r) => r.mode === 'DEDICATED');
  const sharedRows = rows.filter((r) => r.mode === 'SHARED_PREFIX');

  if (dedicatedRows.length > 1 || (dedicatedRows.length > 0 && sharedRows.length > 0)) {
    logger.error('MO 번호 라우팅 충돌 — 배정 설정을 정리해야 합니다', {
      phoneNumber: number,
      dedicated: dedicatedRows.length,
      shared: sharedRows.length,
      creators: rows.map((r) => r.creator?.code).filter(Boolean),
    });
    return null;
  }

  // 1) 전용번호 우선
  const dedicated = dedicatedRows[0];
  if (dedicated?.creator) {
    return { route: dedicated, creator: dedicated.creator, keyword: null as string | null, body: content };
  }

  // 2) 대표번호 + 키워드
  const { keyword, rest } = splitKeyword(content);
  if (keyword) {
    const shared = sharedRows.find((r) => r.keyword === keyword);
    if (shared?.creator) {
      return { route: shared, creator: shared.creator, keyword, body: rest };
    }
  }

  return null;
}

async function getOrCreateDonor(phone: string) {
  const ph = hashPhone(phone);
  return prisma.donorProfile.upsert({
    where: { phoneHash: ph },
    update: {},
    create: {
      id: newId(),
      phoneHash: ph,
      phoneEnc: encrypt(normalizePhone(phone)),
      phoneMasked: maskPhone(phone),
    },
  });
}

/** 같은 전화번호의 동시 MO 중 한 요청만 최초 가입 안내 발송권을 얻는다. */
async function claimRegistrationGuide(donorId: string) {
  const claimedAt = new Date();
  const claimed = await prisma.donorProfile.updateMany({
    where: { id: donorId, onboardingStatus: 'UNREGISTERED' },
    data: { onboardingStatus: 'LINK_SENT', registrationLinkSentAt: claimedAt },
  });
  return { claimed: claimed.count === 1, claimedAt };
}

async function releaseRegistrationGuideClaim(donorId: string, claimedAt: Date) {
  await prisma.donorProfile.updateMany({
    where: { id: donorId, onboardingStatus: 'LINK_SENT', registrationLinkSentAt: claimedAt },
    data: { onboardingStatus: 'UNREGISTERED', registrationLinkSentAt: null },
  });
}

export function resolvePaymentMode(
  creatorMode: PaymentMode | null,
  allowDirectTrigger: boolean = env.safety.allowDirectTrigger,
): PaymentMode {
  const desired = creatorMode ?? 'CONFIRM_LINK';
  if (desired === 'DIRECT_TRIGGER' && !allowDirectTrigger) {
    // 금융사 서면승인 등록 전에는 DIRECT_TRIGGER 를 사용할 수 없다.
    return 'CONFIRM_LINK';
  }
  return desired;
}

/**
 * resolvePaymentMode + DB 서면승인 확인 (M-3).
 *
 * ALLOW_DIRECT_TRIGGER 환경변수는 배포 단위로 켜고 끄는 스위치일 뿐이라, 실수로 켜 두면
 * 서면승인 없이도 즉시 결제가 열린다. 실제 결제(MO 수신 흐름)로 들어가는 지점에서는
 * 환경변수에 더해 DB 에 금융사 서면승인 레코드가 있는 경우에만 DIRECT_TRIGGER 를 허용한다.
 */
export async function resolvePaymentModeChecked(
  creatorMode: PaymentMode | null,
  allowDirectTrigger: boolean = env.safety.allowDirectTrigger,
): Promise<PaymentMode> {
  const desired = resolvePaymentMode(creatorMode, allowDirectTrigger);
  if (desired !== 'DIRECT_TRIGGER') return desired;
  return (await hasDirectTriggerWrittenApproval()) ? 'DIRECT_TRIGGER' : 'CONFIRM_LINK';
}

/**
 * CONFIRM_LINK 모드에서 후원자에게 무엇을 보낼지 결정한다.
 *
 *  - `PIN`(기본): 결제사(헥토/카드)가 발급한 PIN 입력 링크를 보낸다.
 *                 PIN 을 입력해야 결제사가 콜백을 보내고 그때 승인이 실행된다.
 *  - `LEGACY_LINK`(**deprecated**): 토네이도 자체 확인 페이지 링크를 보낸다.
 *                 확인 버튼을 누르면 빌키로 곧바로 승인한다.
 *                 되돌림이 필요한 경우에만 ALLOW_LEGACY_CONFIRM_LINK=true 로 연다.
 */
export type ConfirmChannel = 'PIN' | 'LEGACY_LINK';

export function resolveConfirmChannel(allowLegacy: boolean = allowLegacyConfirmLink()): ConfirmChannel {
  return allowLegacy ? 'LEGACY_LINK' : 'PIN';
}

// ---------------------------------------------------------------------------
// MO 수신 처리
// ---------------------------------------------------------------------------

export async function handleMoInbound(inbound: MoInbound): Promise<MoHandleResult> {
  const ph = hashPhone(inbound.fromNumber);

  // (1) 사업자 메시지 ID 기준 중복 차단
  const dup = await prisma.moInboundMessage.findUnique({
    where: { providerMessageId: inbound.providerMessageId },
    select: { id: true, result: true, donation: { select: { id: true, status: true } } },
  });
  // 이전 수신이 후원 생성 전에 예외로 끝난 건(result=ERROR, 후원 없음)은 사업자 재전송 시 다시 처리한다.
  // 그 외에는 모두 중복으로 막는다.
  const retryable = Boolean(dup && dup.result === 'ERROR' && !dup.donation);
  if (dup && !retryable) {
    /**
     * 아직 처리가 끝나지 않은(PENDING) 채 후원도 만들어지지 않은 행이면 결과가 확정된 것이
     * 아니다. 강제 종료로 중단된 흔적일 수 있다. 이 경우 "중복이니 끝"이 아니라
     * "나중에 다시 보라"고 알려 원본 수신 건을 재처리 대상으로 남긴다(E-3).
     */
    const unsettled = dup.result === 'PENDING' && !dup.donation;
    return {
      result: 'DUPLICATE',
      moMessageId: dup.id,
      donationId: dup.donation?.id,
      status: dup.donation?.status,
      retryLater: unsettled || undefined,
      message: unsettled
        ? '직전 처리가 아직 끝나지 않았습니다. 잠시 후 다시 처리됩니다.'
        : '이미 처리된 문자입니다. 중복 결제는 발생하지 않습니다.',
    };
  }

  const routed = await routeCreator(inbound.receivedNumber, inbound.content);

  let moRow;
  try {
    moRow = await createOrReuseMoRow(inbound, routed, ph, dup?.id ?? null);
  } catch {
    // 동시 재전송 경합
    const again = await prisma.moInboundMessage.findUnique({
      where: { providerMessageId: inbound.providerMessageId },
      select: { id: true },
    });
    return { result: 'DUPLICATE', moMessageId: again?.id, message: '중복 수신(경합)으로 무시되었습니다.' };
  }

  try {
    return await processMoRow(inbound, routed, ph, moRow);
  } catch (error) {
    // 예외로 끝난 행을 PENDING 으로 남기면 재전송이 영원히 DUPLICATE 로 막힌다.
    // 후원이 만들어지기 전에 실패한 행만 ERROR 로 표시해 관리자 화면에 드러내고 재전송을 허용한다.
    // (후원이 이미 생긴 뒤의 예외는 후원 상태·결제 기록이 진실이므로 수신 결과를 덮어쓰지 않는다)
    await prisma.moInboundMessage
      .updateMany({
        where: { id: moRow.id, donation: null },
        data: {
          result: 'ERROR',
          resultDetail: `처리 오류: ${(error as Error).message}`.slice(0, 500),
          processedAt: new Date(),
        },
      })
      .catch(() => undefined);
    throw error;
  }
}

type RoutedCreator = Awaited<ReturnType<typeof routeCreator>>;

async function createOrReuseMoRow(inbound: MoInbound, routed: RoutedCreator, ph: string, reuseId: string | null) {
  if (reuseId) {
    return prisma.moInboundMessage.update({
      where: { id: reuseId },
      data: {
        result: 'PENDING',
        resultDetail: null,
        processedAt: null,
        creatorId: routed?.creator.id ?? null,
        matchedKeyword: routed?.keyword ?? null,
      },
    });
  }
  return prisma.moInboundMessage.create({
      data: {
        id: newId(),
        providerMessageId: inbound.providerMessageId,
        providerCode: inbound.providerCode,
        receivedNumber: inbound.receivedNumber,
        phoneHash: ph,
        phoneEnc: encrypt(normalizePhone(inbound.fromNumber)),
        phoneMasked: maskPhone(inbound.fromNumber),
        messageType: inbound.messageType,
        contentEnc: encrypt(inbound.content),
        attachmentInfo: (inbound.attachments ?? []) as object,
        creatorId: routed?.creator.id ?? null,
        matchedKeyword: routed?.keyword ?? null,
        receivedAt: inbound.receivedAt,
      },
    });
}

async function processMoRow(
  inbound: MoInbound,
  routed: RoutedCreator,
  ph: string,
  moRow: { id: string },
): Promise<MoHandleResult> {
  // (2) 라우팅 실패
  if (!routed) {
    await prisma.moInboundMessage.update({
      where: { id: moRow.id },
      data: { result: 'UNKNOWN_ROUTE', resultDetail: '배정된 크리에이터 없음', processedAt: new Date() },
    });
    await sendMt({ phone: inbound.fromNumber, template: tpl.tplUnknownRoute() });
    return { result: 'UNKNOWN_ROUTE', moMessageId: moRow.id, message: '크리에이터를 찾을 수 없습니다.' };
  }

  const creator = routed.creator;
  if (creator.status !== 'APPROVED') {
    await prisma.moInboundMessage.update({
      where: { id: moRow.id },
      data: { result: 'BLOCKED', resultDetail: `크리에이터 상태: ${creator.status}`, processedAt: new Date() },
    });
    await sendMt({ phone: inbound.fromNumber, template: tpl.tplUnknownRoute() });
    return { result: 'BLOCKED', moMessageId: moRow.id, message: '이용할 수 없는 크리에이터입니다.' };
  }

  const donor = await getOrCreateDonor(inbound.fromNumber);

  // (3) 실제 활성 빌키가 있을 때만 후원 결제로 진행한다.
  const token = await prisma.paymentMethodToken.findFirst({
    where: { donorId: donor.id, status: 'ACTIVE' },
    orderBy: { registeredAt: 'desc' },
  });

  if (!token) {
    const current = await prisma.donorProfile.findUniqueOrThrow({ where: { id: donor.id } });
    await prisma.moInboundMessage.update({
      where: { id: moRow.id },
      data: {
        result: 'UNREGISTERED_DONOR',
        resultDetail:
          current.onboardingStatus === 'LINK_SENT' ? '가입 안내 발송 완료·가입 대기' : `가입 상태: ${current.onboardingStatus}`,
        processedAt: new Date(),
      },
    });

    // 이전 안내 링크(30분)가 만료됐는데도 LINK_SENT 에 머물면 이후 모든 문자가 영원히 안내 없이 끝난다.
    // 만료 뒤 첫 문자에서 UNREGISTERED 로 되돌려 새 링크를 한 번 더 보낸다.
    if (current.onboardingStatus === 'LINK_SENT' && current.registrationLinkSentAt) {
      const expiredAt = current.registrationLinkSentAt.getTime() + LINK_TTL_SEC.REGISTER_ACCOUNT * 1000;
      if (expiredAt < Date.now()) {
        await prisma.donorProfile.updateMany({
          where: { id: donor.id, onboardingStatus: 'LINK_SENT', registrationLinkSentAt: current.registrationLinkSentAt },
          data: { onboardingStatus: 'UNREGISTERED', registrationLinkSentAt: null },
        });
      }
    }

    const claim = await claimRegistrationGuide(donor.id);
    if (claim.claimed) {
      try {
        const link = await issueSecureLink({
          purpose: 'REGISTER_ACCOUNT',
          phoneHash: ph,
          creatorId: creator.id,
          payload: { moMessageId: moRow.id },
        });
        const sent = await sendMt({
          phone: inbound.fromNumber,
          template: tpl.tplRegisterGuide(creator.displayName, link.url),
          creatorId: creator.id,
        });
        if (!sent) await releaseRegistrationGuideClaim(donor.id, claim.claimedAt);
      } catch (error) {
        await releaseRegistrationGuideClaim(donor.id, claim.claimedAt);
        throw error;
      }
      return {
        result: 'UNREGISTERED_DONOR',
        moMessageId: moRow.id,
        message: '미등록 이용자입니다. 최초 가입 안내를 발송했습니다. 이 문자는 후원 처리되지 않습니다.',
      };
    }

    if (
      current.onboardingStatus === 'REGISTERED' ||
      current.onboardingStatus === 'SUSPENDED' ||
      current.onboardingStatus === 'WITHDRAWN'
    ) {
      if (current.onboardingStatus === 'REGISTERED') {
        await prisma.donorProfile.update({
          where: { id: donor.id },
          data: { onboardingStatus: 'SUSPENDED' },
        });
      }
      await sendMt({
        phone: inbound.fromNumber,
        template: tpl.tplAccountInactive(creator.displayName),
        creatorId: creator.id,
      });
      return {
        result: 'UNREGISTERED_DONOR',
        moMessageId: moRow.id,
        message: '내통장결제 이용이 중지된 번호입니다. 결제는 진행되지 않았습니다.',
      };
    }

    return {
      result: 'UNREGISTERED_DONOR',
      moMessageId: moRow.id,
      message: '가입 안내가 이미 발송된 번호입니다. 가입 완료 전 문자는 후원 처리되지 않으며 링크를 다시 보내지 않습니다.',
    };
  }

  // 기존 데이터 이관·복구 상황에서도 활성 빌키가 실제 결제 가능 상태의 기준이다.
  if (donor.onboardingStatus !== 'REGISTERED') {
    await prisma.donorProfile.update({
      where: { id: donor.id },
      data: { onboardingStatus: 'REGISTERED', registeredAt: donor.registeredAt ?? token.registeredAt },
    });
  }

  // (4) 콘텐츠 필터
  // 모바일 MO 후원은 "문자 한 통 = 크리에이터가 설정한 고정 금액" 이다.
  // 본문의 "5000원" 같은 표기를 금액으로 해석하지 않는다(parseExplicitAmount 호출 비활성화).
  // 금액을 직접 지정하는 후원은 화면에서 금액을 입력·확인하는 PC 웹 경로(web-donation)만 사용한다.
  const bannedWords = await loadBannedWords(creator.id);
  const overlay = await prisma.overlaySetting.findUnique({ where: { creatorId: creator.id } });
  const filtered = filterContent(routed.body, {
    bannedWords,
    maxLength: overlay?.maxMessageLen ?? 80,
  });

  const amount = creator.donationAmount;
  // 닉네임을 설정하지 않았으면 번호 끝 4자리로 만든 기본 이름을 쓴다 (예: 후원자5678).
  // 이 값은 후원 시점에 박제되므로, 나중에 닉네임을 바꿔도 과거 내역은 그대로 남는다.
  const displayName = donorDisplayName(donor.displayName, inbound.fromNumber);

  // (5) 후원 거래 생성 (멱등)
  const idem = await acquireIdempotency('donation', `${creator.id}:${inbound.providerMessageId}`);
  if (idem.status === 'DUPLICATE') {
    return {
      result: 'DUPLICATE',
      moMessageId: moRow.id,
      donationId: idem.resourceId ?? undefined,
      message: '이미 생성된 후원 거래입니다.',
    };
  }

  let donation;
  try {
    donation = await prisma.donation.create({
      data: {
        id: newId(),
        transactionNo: newTransactionNo(),
        creatorId: creator.id,
        donorId: donor.id,
        moMessageId: moRow.id,
        amount,
        displayName,
        message: filtered.clean,
        messageRawEnc: encrypt(routed.body),
        status: 'RECEIVED',
        paymentMode: await resolvePaymentModeChecked(creator.paymentMode),
      },
    });
  } catch (error) {
    // 후원 생성에 실패했는데 멱등키를 IN_PROGRESS 로 남기면 TTL(7일) 동안
    // 재전송이 전부 DUPLICATE 로 막혀 문자가 유실된다. 키를 지워 재시도를 허용한다.
    await idem.abort();
    throw error;
  }
  await idem.release(donation.id);

  await prisma.moInboundMessage.update({
    where: { id: moRow.id },
    data: { result: 'ROUTED', contentFiltered: filtered.clean, processedAt: new Date() },
  });

  // (6) 콘텐츠 차단
  if (filtered.action === 'BLOCK') {
    await setStatus(donation.id, 'CONTENT_BLOCKED', filtered.reasons.join(', '));
    await sendMt({
      phone: inbound.fromNumber,
      template: tpl.tplContentBlocked(creator.displayName),
      donationId: donation.id,
      creatorId: creator.id,
    });
    return { result: 'BLOCKED', moMessageId: moRow.id, donationId: donation.id, status: 'CONTENT_BLOCKED', message: '금칙어로 차단되었습니다.' };
  }

  // (7) 한도 확인
  const blocked = await prisma.blockedDonor.findUnique({
    where: { creatorId_donorId: { creatorId: creator.id, donorId: donor.id } },
  });
  const limit = await checkLimits({
    donor,
    creatorId: creator.id,
    amount,
    blockedByCreator: Boolean(blocked),
  });

  if (!limit.ok) {
    await setStatus(donation.id, 'LIMIT_BLOCKED', `${limit.code}: ${limit.message}`);
    await prisma.riskDetection.create({
      data: {
        id: newId(),
        donorId: donor.id,
        creatorId: creator.id,
        donationId: donation.id,
        type: limit.code === 'VELOCITY' || limit.code === 'COOLDOWN' ? 'VELOCITY' : 'DAILY_LIMIT',
        level: 'MEDIUM',
        detail: { code: limit.code, message: limit.message } as object,
      },
    });
    await sendMt({
      phone: inbound.fromNumber,
      template: tpl.tplLimitBlocked(creator.displayName, limit.message ?? '이용 한도'),
      donationId: donation.id,
      creatorId: creator.id,
    });
    return { result: 'BLOCKED', moMessageId: moRow.id, donationId: donation.id, status: 'LIMIT_BLOCKED', message: limit.message ?? '한도 초과' };
  }

  // (8) 결제 모드에 따른 분기
  if (donation.paymentMode === 'CONFIRM_LINK') {
    // 기본 경로: 결제사 PIN 인증 링크. 이 문자만으로는 출금이 일어나지 않는다.
    if (resolveConfirmChannel() === 'PIN') {
      const pin = await startPinAuthorization(donation.id);
      return {
        result: 'ROUTED',
        moMessageId: moRow.id,
        donationId: donation.id,
        status: pin.status,
        message: pin.message,
      };
    }

    // ── deprecated: 토네이도 자체 확인 링크 ────────────────────────────────
    // ALLOW_LEGACY_CONFIRM_LINK=true 일 때만 이 경로를 탄다.
    // 확인 버튼 클릭이 곧 출금이므로, PIN 인증 흐름이 안정화되면 제거한다.
    await setStatus(donation.id, 'PENDING_CONFIRM', '후원자 확인 대기');
    const link = await issueSecureLink({
      purpose: 'CONFIRM_PAYMENT',
      phoneHash: ph,
      creatorId: creator.id,
      donationId: donation.id,
    });
    await sendMt({
      phone: inbound.fromNumber,
      template: tpl.tplConfirmPayment(
        creator.displayName,
        amount,
        link.url,
        Math.floor(env.payment.confirmTtlSec / 60),
      ),
      donationId: donation.id,
      creatorId: creator.id,
    });
    return {
      result: 'ROUTED',
      moMessageId: moRow.id,
      donationId: donation.id,
      status: 'PENDING_CONFIRM',
      message: '결제 확인 링크를 발송했습니다.',
    };
  }

  // DIRECT_TRIGGER
  const paid = await executePayment(donation.id);
  return {
    result: 'ROUTED',
    moMessageId: moRow.id,
    donationId: donation.id,
    status: paid.status,
    message: paid.message,
  };
}

// ---------------------------------------------------------------------------
// PIN 인증 링크 발급
// ---------------------------------------------------------------------------

export interface PinStartOutcome {
  ok: boolean;
  status: DonationStatus;
  message: string;
  /** 결제사 인증 세션 ID (있을 때만) */
  sessionId?: string;
  expiresAt?: Date;
  /** 결제사 실연동이 아닌 mock 링크인지 */
  mock?: boolean;
}

/** 링크 원문을 DB 에 남기지 않는다. 세션 토큰이 들어 있는 쿼리스트링을 지운다. */
function maskPinUrl(url: string): string {
  const cut = url.indexOf('?');
  return cut < 0 ? url : `${url.slice(0, cut)}?[마스킹]`;
}

/** 어댑터가 상대경로(mock 화면)를 주면 문자로 보낼 수 있게 절대 URL 로 바꾼다. */
function toAbsolutePinUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${env.baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * 결제사에 PIN 입력 링크를 요청하고, 받은 링크를 후원자에게 MT 로 보낸다.
 *
 * 이 함수는 **출금을 일으키지 않는다.** 후원자가 PIN 을 입력하면 결제사가
 * `/api/webhooks/pin-callback` 으로 통지하고, 그때 executePayment() 가 실행된다.
 *
 * 멱등: 후원 1건당 인증 세션은 1건(payment_pin_session.donation_id UNIQUE)이다.
 * 같은 후원으로 두 번 들어와도 링크를 두 장 발급하지 않는다.
 */
export async function startPinAuthorization(donationId: string): Promise<PinStartOutcome> {
  const donation = await prisma.donation.findUnique({
    where: { id: donationId },
    include: { creator: true, donor: true },
  });
  if (!donation) return { ok: false, status: 'PAYMENT_FAILED', message: '후원 거래를 찾을 수 없습니다.' };
  if (!donation.donor) return { ok: false, status: 'UNREGISTERED', message: '후원자 정보가 없습니다.' };
  if (!donation.donorId) return { ok: false, status: 'UNREGISTERED', message: '후원자 정보가 없습니다.' };
  const { donorId } = donation;

  // 이미 발급된 세션이 있으면 새로 만들지 않는다(문자 재수신 시 링크가 늘어나는 것을 막는다).
  const existing = await prisma.paymentPinSession.findUnique({ where: { donationId } });
  if (existing) {
    return {
      ok: existing.status === 'PENDING',
      status: donation.status,
      message:
        existing.status === 'PENDING'
          ? '이미 발송된 PIN 입력 링크가 있습니다. 받으신 문자에서 진행해 주세요.'
          : '이미 처리된 후원입니다.',
      sessionId: existing.sessionId,
      expiresAt: existing.expiresAt,
      mock: existing.mock,
    };
  }

  const token = await prisma.paymentMethodToken.findFirst({
    where: { donorId: donorId, status: 'ACTIVE' },
    orderBy: { registeredAt: 'desc' },
  });
  if (!token) {
    await setStatus(donationId, 'UNREGISTERED', '활성 결제수단 없음');
    return { ok: false, status: 'UNREGISTERED', message: '등록된 결제수단이 없습니다.' };
  }

  await setStatus(donationId, 'PENDING_PIN', 'PIN 인증 대기');

  const adapter = getPaymentAdapter();
  const phone = decrypt(donation.donor.phoneEnc);

  let issued: Awaited<ReturnType<typeof adapter.requestPinLink>>;
  try {
    issued = await adapter.requestPinLink(donationId, donation.amount, phone, token.method);
  } catch (e) {
    issued = { ok: false, code: 'ERROR', message: (e as Error).message };
  }

  if (!issued.ok || !issued.data) {
    // 링크 발급 실패는 출금이 없는 실패다. 한도 카운터도 아직 쓰지 않았다.
    const reason = issued.message ?? 'PIN 인증창을 생성하지 못했습니다.';
    await setStatus(donationId, 'PAYMENT_FAILED', `PIN 링크 발급 실패: ${reason}`);
    await sendMtForDonor(
      donorId,
      tpl.tplDonationFailed(donation.creator.displayName, reason),
      donationId,
      donation.creatorId,
    );
    logger.warn('PIN 링크 발급 실패', { donationId, code: issued.code, phone: donation.donor.phoneMasked });
    return { ok: false, status: 'PAYMENT_FAILED', message: reason };
  }

  const pinUrl = toAbsolutePinUrl(issued.data.pinUrl);
  const ttlMin = Math.max(1, Math.floor((issued.data.expiresAt.getTime() - Date.now()) / 60_000));

  try {
    await prisma.paymentPinSession.create({
      data: {
        id: newId(),
        donationId,
        provider: adapter.info().provider,
        method: token.method,
        sessionId: issued.data.sessionId,
        pinUrlMasked: maskPinUrl(pinUrl),
        amount: donation.amount,
        mock: issued.data.mock,
        expiresAt: issued.data.expiresAt,
      },
    });
  } catch {
    // 동시 요청 경합: donation_id UNIQUE 에 걸린 쪽은 링크를 또 보내지 않는다.
    const now = await prisma.paymentPinSession.findUnique({ where: { donationId } });
    return {
      ok: Boolean(now),
      status: 'PENDING_PIN',
      message: '이미 발송된 PIN 입력 링크가 있습니다. 받으신 문자에서 진행해 주세요.',
      sessionId: now?.sessionId,
      expiresAt: now?.expiresAt,
      mock: now?.mock,
    };
  }

  const sent = await sendMt({
    phone,
    template: tpl.tplPinRequest({
      creatorName: donation.creator.displayName,
      amount: donation.amount,
      pinUrl,
      ttlMin,
      mock: issued.data.mock,
    }),
    donationId,
    creatorId: donation.creatorId,
  });

  if (!sent) {
    // 링크를 받지 못한 후원자가 결제될 수는 없다. 세션을 닫고 실패로 확정한다.
    // (아직 승인 전이므로 출금은 발생하지 않았다)
    await prisma.paymentPinSession.updateMany({
      where: { donationId, status: 'PENDING' },
      data: { status: 'FAILED', resultNote: 'PIN 링크 문자 발송 실패' },
    });
    await setStatus(donationId, 'PAYMENT_FAILED', 'PIN 링크 문자 발송 실패');
    return { ok: false, status: 'PAYMENT_FAILED', message: 'PIN 입력 안내 문자를 보내지 못했습니다.' };
  }

  if (issued.data.mock) {
    logger.warn('[MOCK] PIN 인증 링크 발송 — 실제 결제사 연동이 아닙니다.', {
      donationId,
      provider: adapter.info().provider,
      phone: donation.donor.phoneMasked,
    });
  }

  return {
    ok: true,
    status: 'PENDING_PIN',
    message: issued.data.mock
      ? '[MOCK] PIN 입력 링크를 발송했습니다. PIN 입력 후 결제가 완료됩니다.'
      : 'PIN 입력 링크를 발송했습니다. PIN 입력 후 결제가 완료됩니다.',
    sessionId: issued.data.sessionId,
    expiresAt: issued.data.expiresAt,
    mock: issued.data.mock,
  };
}

// ---------------------------------------------------------------------------
// 결제 실행
// ---------------------------------------------------------------------------

export interface PaymentOutcome {
  ok: boolean;
  status: DonationStatus;
  message: string;
}

/** 결제가 이미 끝난 상태. 다시 승인하지 않는다. */
const COMPLETED_PAYMENT_STATUSES: DonationStatus[] = [
  'PAYMENT_SUCCESS',
  'BROADCAST_PENDING',
  'BROADCASTED',
  'PARTIAL_DELIVERY_FAILED',
  'SETTLEMENT_PENDING',
  'SETTLED',
];

/**
 * 결제를 실행하면 안 되는 종료 상태 (P-1).
 * 환불·차단·실패로 끝난 건이 어떤 경로로든 다시 승인되지 않게 막는다.
 */
const NON_PAYABLE_STATUSES: DonationStatus[] = [
  'REFUNDED',
  'REFUND_REQUESTED',
  'PAYMENT_FAILED',
  'LIMIT_BLOCKED',
  'CONTENT_BLOCKED',
  'UNREGISTERED',
];

export async function executePayment(donationId: string): Promise<PaymentOutcome> {
  const donation = await prisma.donation.findUnique({
    where: { id: donationId },
    include: { creator: true, donor: true },
  });
  if (!donation) return { ok: false, status: 'PAYMENT_FAILED', message: '후원 거래를 찾을 수 없습니다.' };
  if (!donation.donor) return { ok: false, status: 'UNREGISTERED', message: '후원자 정보가 없습니다.' };
  if (!donation.donorId) return { ok: false, status: 'UNREGISTERED', message: '후원자 정보가 없습니다.' };
  const donor = donation.donor;
  const { donorId } = donation;

  /**
   * 이미 결제가 끝난 상태. 다시 승인하지 않는다.
   */
  if (COMPLETED_PAYMENT_STATUSES.includes(donation.status)) {
    return { ok: true, status: donation.status, message: '이미 결제가 완료된 거래입니다.' };
  }

  /**
   * 결제를 실행하면 안 되는 종료 상태 가드 (P-1).
   *
   * 예전에는 "완료"만 걸렀다. 그래서 아래 상태에서도 승인이 다시 나갈 수 있었다.
   *  - REFUNDED / REFUND_REQUESTED : 환불했거나 환불 심사 중인 건을 **다시 출금**한다.
   *    같은 주문번호를 재사용하므로 PG 가 기존 승인을 돌려줄 수도 있는데, 그러면 이번엔
   *    환불된 거래가 성공으로 되살아나 정산 원장에 3분개가 한 번 더 쌓인다.
   *  - PAYMENT_FAILED / LIMIT_BLOCKED / CONTENT_BLOCKED / UNREGISTERED
   *    : 사유를 해소하지 않은 채 재시도해도 결과가 같거나, 차단 판정을 우회한다.
   *
   * 진입 경로가 여러 개(PIN 콜백·확인 링크·정리 배치·관리자 화면)이고 각자 상태를 따로
   * 확인하기 때문에, 실제 출금 직전인 이 지점에 마지막 방어선을 둔다.
   */
  if (NON_PAYABLE_STATUSES.includes(donation.status)) {
    logger.warn('결제를 실행할 수 없는 상태에서 executePayment 가 호출되었습니다.', {
      donationId,
      status: donation.status,
    });
    return {
      ok: false,
      status: donation.status,
      message: `현재 상태(${donation.status})에서는 결제를 실행할 수 없습니다.`,
    };
  }

  const token = await prisma.paymentMethodToken.findFirst({
    where: { donorId: donorId, status: 'ACTIVE' },
    orderBy: { registeredAt: 'desc' },
  });
  if (!token) {
    await setStatus(donationId, 'UNREGISTERED', '활성 결제수단 없음');
    return { ok: false, status: 'UNREGISTERED', message: '등록된 결제수단이 없습니다.' };
  }

  // 결제 직전 한도 재검사 + 결제 판정.
  // 카운터는 결제 성공 시에만 증가하므로, 확인 링크를 여러 장 받아 두었다가 한꺼번에 누르면
  // 접수 시점 검사만으로는 일/월 한도를 얼마든지 넘길 수 있다. 실제 출금 직전에 다시 확인한다.
  //
  // 재검사부터 결제 판정(집계 예약 + 결제 트랜잭션 확정)까지를 하나의 트랜잭션으로 묶고,
  // 그 안에서 후원자 행을 FOR UPDATE 로 잠근다. 같은 후원자가 동시에 두 번 눌러도
  // 뒤 요청은 앞 트랜잭션이 끝날 때까지 대기했다가, 예약이 반영된 집계를 보고 한도 판정을 받는다.
  const reservedAt = new Date();
  const decision = await prisma.$transaction(async (tx) => {
    const blockedNow = await tx.blockedDonor.findUnique({
      where: { creatorId_donorId: { creatorId: donation.creatorId, donorId: donor.id } },
    });
    const limit = await checkLimits({
      donor,
      creatorId: donation.creatorId,
      amount: donation.amount,
      blockedByCreator: Boolean(blockedNow),
      // 접수 시점에 이미 속도 제한 카운터를 소진했다. 여기서 또 올리면 1건이 2건으로 세어진다.
      consumeVelocity: false,
      tx,
    });
    if (!limit.ok) return { limit, txn: null, alreadyApproved: false };

    // 결제 트랜잭션은 거래당 1건만 생성한다(주문번호를 멱등키로 재사용).
    const existing = await tx.paymentTransaction.findFirst({
      where: { donationId },
      orderBy: { requestedAt: 'desc' },
    });
    if (existing?.status === 'APPROVED') return { limit, txn: existing, alreadyApproved: true };

    // 이 거래(주문번호)로 집계를 이미 예약해 뒀는지는 새 결제 트랜잭션 행을 만드는지 여부로 판단한다.
    // 기존 행을 재사용하는 경우는 이전 시도(승인 대기 중 크래시 등)가 이미 예약을 마친 뒤이므로,
    // 여기서 또 커밋하면 같은 후원이 두 번 집계된다(M-2: executePayment 재시도 시 집계 중복 방지).
    const isNewTxn = !existing;
    const row =
      existing ??
      (await tx.paymentTransaction.create({
        data: {
          id: newId(),
          donationId,
          orderNo: newOrderNo(),
          provider: env.payment.provider,
          amount: donation.amount,
        },
      }));

    if (isNewTxn) {
      // 승인 결과를 기다리지 않고 집계를 먼저 잡아둔다(예약).
      // 잠금 밖에서 승인 후에 반영하면, 그사이 들어온 같은 후원자의 요청이
      // 이 건이 빠진 집계를 읽고 함께 통과해 한도를 넘긴다. 실패하면 아래에서 되돌린다.
      await commitCounters(donor.id, donation.creatorId, donation.amount, reservedAt, tx);
    }
    return { limit, txn: row, alreadyApproved: false };
  }, {
    // 기본값(5초)에 기대지 않고 명시한다.
    // 이 트랜잭션은 후원자 행을 FOR UPDATE 로 잠그므로, 같은 후원자가 연속으로 누르면
    // 뒤 요청은 앞 트랜잭션이 끝날 때까지 줄을 선다. 잠금 대기와 실행 시간을 나눠서 잡아 둔다.
    maxWait: 5_000,
    timeout: 10_000,
  });
  // 집계 예약(commitCounters) 트랜잭션과 adapter.approve() 사이는 원자적이지 않다.
  // 두 작업 사이에 프로세스가 크래시하면 후원이 PENDING_PAYMENT 에 멈춘 채 집계만 예약된 상태로
  // 남을 수 있다. 위에서 집계 커밋을 결제 트랜잭션 신규 생성 시에만 실행하도록 만들어
  // executePayment 를 다시 불러도 안전(재예약되지 않음)하게 했으므로, 그 상태로 멈춘 건은
  // reconcileStuckPendingPayments(정리 배치, /api/cron/cleanup) 가 주기적으로 재시도한다(M-2).

  const limitNow = decision.limit;
  if (!limitNow.ok) {
    await setStatus(donationId, 'LIMIT_BLOCKED', `${limitNow.code}: ${limitNow.message}`);
    await prisma.riskDetection.create({
      data: {
        id: newId(),
        donorId: donorId,
        creatorId: donation.creatorId,
        donationId: donation.id,
        type: limitNow.code === 'VELOCITY' || limitNow.code === 'COOLDOWN' ? 'VELOCITY' : 'DAILY_LIMIT',
        level: 'MEDIUM',
        detail: { code: limitNow.code, message: limitNow.message, stage: 'PRE_PAYMENT' } as object,
      },
    });
    await sendMtForDonor(
      donorId,
      tpl.tplLimitBlocked(donation.creator.displayName, limitNow.message ?? '이용 한도'),
      donationId,
      donation.creatorId,
    );
    return { ok: false, status: 'LIMIT_BLOCKED', message: limitNow.message ?? '이용 한도를 초과했습니다.' };
  }

  if (decision.alreadyApproved) {
    return { ok: true, status: 'SETTLEMENT_PENDING', message: '이미 승인된 결제입니다.' };
  }
  const txn = decision.txn!;

  await setStatus(donationId, 'PENDING_PAYMENT', '결제 승인 요청');

  const adapter = getPaymentAdapter();
  const started = Date.now();
  let attemptNo = (await prisma.paymentAttempt.count({ where: { transactionId: txn.id } })) + 1;

  let approved: { providerTid: string; approvedAt: Date } | null = null;
  let failure: { code?: string; message?: string } | null = null;

  try {
    const res = await adapter.approve({
      orderNo: txn.orderNo,
      amount: donation.amount,
      billKey: decryptBillKey(token.billKeyEnc),
      productName: `${donation.creator.displayName} 문자후원`,
      buyerName: donation.displayName,
    });
    await prisma.paymentAttempt.create({
      data: {
        id: newId(), transactionId: txn.id, attemptNo, operation: 'APPROVE',
        responseMasked: { ok: res.ok, code: res.code ?? null, message: res.message ?? null } as object,
        latencyMs: Date.now() - started,
        errorCode: res.ok ? null : res.code ?? null,
        errorMessage: res.ok ? null : res.message ?? null,
      },
    });
    if (res.ok && res.data) approved = { providerTid: res.data.providerTid, approvedAt: res.data.approvedAt };
    else failure = { code: res.code, message: res.message };
  } catch (e) {
    // 타임아웃/네트워크 오류: 반드시 거래결과조회로 최종 상태를 확정한다.
    const isTimeout = e instanceof MockPaymentTimeout || /timeout|ETIMEDOUT|ECONNRESET/i.test((e as Error).message);
    await prisma.paymentAttempt.create({
      data: {
        id: newId(), transactionId: txn.id, attemptNo, operation: 'APPROVE',
        latencyMs: Date.now() - started, errorCode: isTimeout ? 'TIMEOUT' : 'ERROR',
        errorMessage: (e as Error).message,
      },
    });
    attemptNo += 1;
    await prisma.paymentTransaction.update({ where: { id: txn.id }, data: { status: 'TIMEOUT' } });

    // 거래결과조회 자체가 실패해도 예외를 밖으로 내보내지 않는다.
    // 여기서 throw 하면 후원이 PENDING_PAYMENT 로 영구히 멈춰 아무도 복구할 수 없다.
    // 조회 불가 = "결과 미확인(UNKNOWN)" 으로 확정하고 관리자 확인 큐로 보낸다.
    let inq: Awaited<ReturnType<typeof adapter.inquire>> | null = null;
    try {
      inq = await adapter.inquire(txn.orderNo);
    } catch (inqErr) {
      logger.error('거래결과조회 실패', { donationId, orderNo: txn.orderNo, message: (inqErr as Error).message });
    }
    await prisma.paymentAttempt.create({
      data: {
        id: newId(), transactionId: txn.id, attemptNo, operation: 'INQUIRE',
        responseMasked: { status: inq?.data?.status ?? 'UNKNOWN' } as object,
        errorCode: inq ? null : 'INQUIRE_ERROR',
      },
    });
    if (inq?.ok && inq.data?.status === 'APPROVED') {
      // 조회 결과에 금액이 있으면 반드시 대조한다.
      // 주문번호 오매칭이나 결제사 오류로 다른 금액이 승인됐는데 그대로 확정하면
      // 원장·정산이 실제 출금액과 어긋난 채 append-only 로 굳어 되돌릴 수 없다.
      const inquiredAmount = inq.data.amount;
      if (inquiredAmount != null && BigInt(inquiredAmount) !== donation.amount) {
        logger.error('거래결과조회 금액 불일치 — 수동 확인 필요', {
          donationId,
          orderNo: txn.orderNo,
          expected: donation.amount.toString(),
          inquired: String(inquiredAmount),
        });
        failure = { code: 'UNKNOWN', message: '결제 금액이 일치하지 않습니다. 관리자 확인이 필요합니다.' };
      } else {
        approved = { providerTid: inq.data.providerTid ?? txn.orderNo, approvedAt: new Date() };
      }
    } else if (inq?.ok && inq.data?.status === 'FAILED') {
      failure = { code: 'TIMEOUT_FAILED', message: '결제가 완료되지 않았습니다.' };
    } else {
      failure = { code: 'UNKNOWN', message: '결제 결과를 확인할 수 없습니다. 관리자 확인이 필요합니다.' };
    }
  }

  const phone = donation.donor.phoneMasked;

  if (!approved) {
    // ── 결과 미확인(UNKNOWN) ────────────────────────────────────────────
    // 출금이 실제로 일어났을 수 있으므로 "실패"로 확정하면 안 된다.
    // FAILED 로 덮으면 (1) 원장 분개가 없어 크리에이터에게 정산되지 않고
    // (2) 후원자에게 실패 문자가 나가며 (3) 실패 카운터로 정상 후원자가 잠기고
    // (4) 관리자 '확인 필요' 큐(status IN UNKNOWN,TIMEOUT)가 영구히 비어 대사 자체가 불가능해진다.
    // 따라서 UNKNOWN 은 UNKNOWN 그대로 남기고 사람이 판단하도록 넘긴다.
    if (failure?.code === 'UNKNOWN') {
      await prisma.paymentTransaction.update({
        where: { id: txn.id },
        data: { status: 'UNKNOWN', resultCode: 'UNKNOWN', resultMessage: failure.message ?? null },
      });
      // 후원 상태는 PENDING_PAYMENT 로 유지한다(실패 아님). 사유만 남긴다.
      await prisma.donation.update({
        where: { id: donationId },
        data: { statusReason: '결제 결과 미확인 — 관리자 확인 대기' },
      });
      await raiseUnknownPaymentAlert(donationId, txn.id, txn.orderNo, donation.amount);
      // 실패 카운터를 올리지 않는다. 실패 문자도 보내지 않는다(이중청구 오해 방지).
      // 예약해 둔 한도 집계도 되돌리지 않는다. 실제로 출금되었을 수 있으므로
      // 되돌렸다가 다시 후원이 통과하면 그날 한도를 넘겨 이중으로 빠져나간다.
      logger.error('결제 결과 미확인 — 수동 대사 필요', {
        donationId, transactionId: txn.id, orderNo: txn.orderNo, phone,
      });
      return {
        ok: false,
        status: 'PENDING_PAYMENT',
        message: '결제 결과를 확인하는 중입니다. 확인되는 대로 문자로 안내드립니다.',
      };
    }

    await prisma.paymentTransaction.update({
      where: { id: txn.id },
      data: { status: 'FAILED', resultCode: failure?.code ?? null, resultMessage: failure?.message ?? null },
    });
    await setStatus(donationId, 'PAYMENT_FAILED', failure?.message ?? '결제 실패');
    /**
     * 결제 판정 트랜잭션에서 잡아둔 집계 예약을 되돌린다(실패한 건은 한도를 쓰지 않는다).
     *
     * 기준 시각은 **예약한 시점**(거래 생성 시각)이어야 한다. 지금 시각으로 되돌리면
     * 자정을 넘겨 재시도된 건이 어제 집계는 부풀린 채 오늘 집계를 깎는다.
     * (수동 대사 경로 payment-reconcile.ts 도 txn.requestedAt 을 쓴다)
     */
    await rollbackCounters(donor.id, donation.creatorId, donation.amount, txn.requestedAt ?? reservedAt);
    const policy = await resolvePolicy(donation.creatorId, donation.donorId);
    // DB 집계만 되돌리고 Redis 속도 카운터를 남기면, 실패한 건이 계속 1건으로 세어져
    // 정상 후원자가 속도 제한·쿨다운에 걸린다.
    await rollbackVelocity(donor.id, policy, txn.requestedAt ?? reservedAt);
    const locked = await registerFailure(donorId, policy.failureLockThreshold);
    await sendMtForDonor(donorId, tpl.tplDonationFailed(donation.creator.displayName, failure?.message), donationId, donation.creatorId);
    logger.warn('결제 실패', { donationId, phone, locked, code: failure?.code });
    return { ok: false, status: 'PAYMENT_FAILED', message: failure?.message ?? '결제에 실패했습니다.' };
  }

  // ── 승인 성공 ──────────────────────────────────────────────────────
  // 승인 기록과 정산 원장 분개는 반드시 같은 트랜잭션이어야 한다.
  // 둘이 갈라져 있으면 그 사이에 프로세스가 죽었을 때
  // "후원은 성공인데 원장에는 없는" 상태가 되고, 앞쪽 조기 return 가드가
  // 재시도를 '이미 완료'로 되돌려 보내 크리에이터가 그 금액을 영영 못 받는다.
  const fees = await calculateFees(donation.creatorId, donation.amount);
  const committed = await prisma.$transaction(async (tx) => {
    /**
     * **조건부 갱신으로 선점한 뒤에만** 원장에 기록한다.
     *
     * 부분 유니크 인덱스(`payment_transaction_approved_uniq`)는 "같은 후원에 APPROVED 행이
     * 두 개"를 막는다. 그런데 여기서는 행 하나를 두 번 UPDATE 하는 것이라 인덱스가 발동하지
     * 않는다. 그 결과 같은 거래가 동시에 두 번 승인 처리되면 3분개와 누적 금액이 두 번 들어가고,
     * 원장은 append-only 라 되돌릴 수 없다.
     * (PIN 완료 처리와 정체 건 복구 배치가 겹칠 때 실제로 도달 가능한 경로다)
     */
    const claimed = await tx.paymentTransaction.updateMany({
      where: { id: txn.id, status: { not: 'APPROVED' } },
      data: { status: 'APPROVED', providerTid: approved!.providerTid, approvedAt: approved!.approvedAt },
    });
    if (claimed.count === 0) return false;
    await tx.donation.update({
      where: { id: donationId },
      data: {
        status: 'SETTLEMENT_PENDING',
        statusReason: '정산 대기',
        paidAt: approved!.approvedAt,
        pgFee: fees.pgFee,
        platformFee: fees.platformFee,
        feeVat: fees.vat,
        netAmount: fees.net,
      },
    });
    await tx.donationStatusLog.createMany({
      data: [
        { id: newId(), donationId, fromStatus: 'PENDING_PAYMENT', toStatus: 'PAYMENT_SUCCESS', actor: 'system' },
        { id: newId(), donationId, fromStatus: 'PAYMENT_SUCCESS', toStatus: 'SETTLEMENT_PENDING', reason: '정산 대기', actor: 'system' },
      ],
    });
    await tx.donorCreatorLink.upsert({
      where: { donorId_creatorId: { donorId: donorId, creatorId: donation.creatorId } },
      create: {
        id: newId(), donorId: donorId, creatorId: donation.creatorId,
        consentedAt: new Date(), totalAmount: donation.amount, totalCount: 1, lastDonatedAt: approved!.approvedAt,
      },
      update: {
        totalAmount: { increment: donation.amount },
        totalCount: { increment: 1 },
        lastDonatedAt: approved!.approvedAt,
      },
    });
    await postDonationSettlement(
      {
        creatorId: donation.creatorId,
        donationId,
        amount: donation.amount,
        fees,
        occurredAt: approved!.approvedAt,
      },
      tx,
    );
    return true;
  });

  if (!committed) {
    // 다른 요청이 먼저 승인 처리를 끝냈다. 이쪽에서는 아무것도 더 하지 않는다.
    logger.warn('승인 처리가 이미 완료되어 중복 기록을 건너뜁니다.', { donationId, transactionId: txn.id });
    return {
      ok: true,
      status: 'SETTLEMENT_PENDING',
      message: '후원이 완료되었습니다.',
    };
  }

  // 집계는 결제 판정 트랜잭션에서 이미 반영(예약)했다. 여기서 다시 더하면 두 번 세어진다.
  await clearFailures(donorId);

  // 누적 후원금 안내
  const link = await prisma.donorCreatorLink.findUnique({
    where: { donorId_creatorId: { donorId: donorId, creatorId: donation.creatorId } },
    select: { totalAmount: true },
  });
  await sendMtForDonor(
    donorId,
    tpl.tplDonationSuccess({
      donorName: donation.displayName,
      creatorName: donation.creator.displayName,
      amount: donation.amount,
      message: donation.message,
      cumulative: link?.totalAmount ?? donation.amount,
      // 크리에이터가 스튜디오에서 설정한 감사 문자 본문. 없으면 기본 문구가 쓰인다.
      custom: donation.creator.thanksMtMessage,
    }),
    donationId,
    donation.creatorId,
  );

  // 결제 성공 이후에만 방송 전송을 시도한다.
  // 송출(유튜브 댓글·오버레이·TTS) 실패가 결제 결과를 뒤집으면 안 된다.
  // 여기서 예외가 새면 결제는 승인·정산까지 끝났는데 후원자 화면에는 오류가 뜬다.
  try {
    await dispatchBroadcast(donationId);
  } catch (e) {
    logger.error('방송 송출 실패 (결제는 정상 완료)', { donationId, message: (e as Error).message });
  }

  return { ok: true, status: 'SETTLEMENT_PENDING', message: '후원이 완료되었습니다.' };
}

/**
 * 정리 배치(/api/cron/cleanup) 훅 포인트 (M-2).
 *
 * 집계 예약(commitCounters) 이후 PG 승인 완료 사이에 프로세스가 죽으면 후원이
 * PENDING_PAYMENT 에 멈춘다. executePayment 는 결제 트랜잭션을 주문번호로 재사용하고
 * 집계는 그 행을 새로 만들 때만 커밋하므로(위 isNewTxn 분기), 다시 불러도 집계가
 * 중복되지 않는다 — 그 성질을 이용해 멈춘 건을 그대로 재시도한다.
 * (PG 쪽 approve() 도 같은 주문번호 재요청에는 기존 승인 결과를 그대로 돌려주므로 이중 출금도 없다)
 */
export async function reconcileStuckPendingPayments(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 5 * 60_000);
  const stale = await prisma.donation.findMany({
    where: {
      status: 'PENDING_PAYMENT',
      paidAt: null,
      updatedAt: { lt: cutoff },
      // UNKNOWN/TIMEOUT 로 확정된 건은 이미 관리자 수동 대사 큐(admin/payments)로 올라가 있다.
      // 여기서는 결제사에 아직 결과를 확인하지 못한(REQUESTED) 순수 고착 건만 다룬다.
      transactions: { some: { status: 'REQUESTED' } },
    },
    select: { id: true },
  });

  let count = 0;
  for (const d of stale) {
    try {
      await executePayment(d.id);
      count += 1;
    } catch (e) {
      logger.error('PENDING_PAYMENT 고착 건 재시도 실패', { donationId: d.id, message: (e as Error).message });
    }
  }
  return count;
}

/**
 * 처리 도중 프로세스가 죽어 `PENDING` 으로 남은 수신 문자를 복구한다.
 *
 * 예외로 끝난 행은 위 catch 가 ERROR 로 표시하지만, 강제 종료(SIGKILL·컨테이너 교체)에는
 * 그 catch 가 실행되지 않는다. 그러면 행은 PENDING 인 채 남고 `retryable` 조건
 * (`result === 'ERROR' && !donation`)에 걸리지 않아 **사업자 재전송이 전부 DUPLICATE 로
 * 반려된다.** 후원자는 문자 요금을 냈는데 후원은 만들어지지 않고, 관리자 화면에도
 * "처리중"으로만 보인다.
 *
 * 후원이 만들어지지 않은 오래된 PENDING 행만 ERROR 로 승격해 재전송을 허용한다.
 */
export async function recoverStuckMoMessages(now = new Date(), staleMinutes = 5): Promise<number> {
  const cutoff = new Date(now.getTime() - staleMinutes * 60_000);
  const r = await prisma.moInboundMessage.updateMany({
    where: { result: 'PENDING', donation: null, receivedAt: { lt: cutoff } },
    data: {
      result: 'ERROR',
      resultDetail: '처리 중 중단된 것으로 판단해 재처리 대상으로 표시했습니다(정리 배치).',
      processedAt: now,
    },
  });
  if (r.count > 0) logger.warn('중단된 수신 문자 복구', { count: r.count });
  return r.count;
}

/**
 * 결제는 끝났는데 방송 송출이 시작되지 않은 건을 다시 송출한다.
 *
 * 승인 직후(상태 SETTLEMENT_PENDING) 프로세스가 죽으면 `dispatchBroadcast` 가 호출되지
 * 않는다. 그런데 재시도가 들어와도 `executePayment` 는 "이미 결제가 완료된 거래"로
 * 조기 return 하므로 송출은 영영 일어나지 않고, 오버레이·유튜브 상태가 PENDING 에
 * 고착된다. 관리자 화면 어디에도 이 건을 잡아내는 지표가 없었다.
 */
export async function redispatchMissedBroadcasts(now = new Date(), staleMinutes = 5): Promise<number> {
  const cutoff = new Date(now.getTime() - staleMinutes * 60_000);
  const stuck = await prisma.donation.findMany({
    where: {
      status: 'SETTLEMENT_PENDING',
      overlayStatus: 'PENDING',
      paidAt: { not: null, lt: cutoff },
      isTest: false,
    },
    select: { id: true },
    take: 100,
  });

  let count = 0;
  for (const d of stuck) {
    try {
      await dispatchBroadcast(d.id);
      count += 1;
    } catch (e) {
      logger.error('송출 누락 건 재시도 실패 (결제는 정상)', { donationId: d.id, message: (e as Error).message });
    }
  }
  if (count > 0) logger.warn('송출 누락 건 재송출', { count });
  return count;
}

/**
 * 발송 실패한 MT 문자를 다시 보낸다 (E-5, 정리 배치 훅).
 *
 * 왜 필요한가
 * ----------
 * MT 발송은 실패해도 이력만 FAILED 로 남기고 아무도 다시 시도하지 않았다(절대규칙 3 때문에
 * 결제 결과는 건드리지 않는 것이 맞지만, 그것이 "재시도하지 않는다"를 뜻하지는 않는다).
 * 이통사 일시 오류·EMMA 큐 순간 장애 한 번에 후원자는 결제됐다는 사실조차 통보받지 못한다.
 *
 * 무엇을 다시 보내는가 — **재발송해도 안전한 문자만** 보낸다.
 *  - 저장된 본문(bodyMasked)은 1회용 보안링크와 인증번호가 지워진 마스킹 본문이다.
 *    그런 문자는 원문을 복원할 수 없고, 복원할 수 있다 해도 유효시간(5분)이 지나 의미가 없다.
 *    잘못 보내면 `[보안링크]` 라는 글자가 그대로 찍힌 문자가 나간다.
 *  - 그래서 링크·인증번호가 없는 **안내 문자**(감사·실패·차단·환불 안내)만 대상으로 한다.
 *    이 문자들은 마스킹 본문과 원문이 같다.
 *
 * 재시도 정책
 *  - 최대 `maxAttempts` 회(기본 3). attempts 컬럼으로 센다.
 *  - 지수 백오프: 생성 후 2^attempts 분이 지난 건만 다시 시도한다(2분 → 4분 → 8분).
 *    (MtOutboundMessage 에는 마지막 시도 시각이 없어 createdAt 기준으로 누적 지연을 잡는다)
 *  - 24시간이 지난 건은 포기한다. 뒤늦게 도착한 안내는 오히려 혼란을 준다.
 */
const MT_RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 마스킹 본문 그대로 다시 보내도 되는 템플릿 (1회용 링크·인증번호가 없다). */
const RETRYABLE_MT_TEMPLATES: ReadonlySet<string> = new Set<string>([
  tpl.MT_TEMPLATE.DONATION_SUCCESS,
  tpl.MT_TEMPLATE.DONATION_FAILED,
  tpl.MT_TEMPLATE.ACCOUNT_INACTIVE,
  tpl.MT_TEMPLATE.LIMIT_BLOCKED,
  tpl.MT_TEMPLATE.CONTENT_BLOCKED,
  tpl.MT_TEMPLATE.REFUND_DONE,
  tpl.MT_TEMPLATE.UNKNOWN_ROUTE,
]);

export async function retryFailedMtMessages(now = new Date(), maxAttempts = 3): Promise<number> {
  const rows = await prisma.mtOutboundMessage.findMany({
    where: {
      status: 'FAILED',
      attempts: { gt: 0, lt: maxAttempts },
      templateCode: { in: [...RETRYABLE_MT_TEMPLATES] },
      createdAt: { gt: new Date(now.getTime() - MT_RETRY_MAX_AGE_MS) },
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
    select: {
      id: true,
      phoneEnc: true,
      bodyMasked: true,
      templateCode: true,
      attempts: true,
      createdAt: true,
      donationId: true,
    },
  });

  const adapter = getMtAdapter();
  let sent = 0;

  for (const row of rows) {
    // 지수 백오프. 앞선 시도로부터 충분히 지나지 않았으면 다음 배치로 미룬다.
    const waitMs = 2 ** row.attempts * 60_000;
    if (now.getTime() - row.createdAt.getTime() < waitMs) continue;

    // 마스킹 흔적이 남은 본문은 절대 그대로 보내지 않는다(원문 복원 불가).
    if (row.bodyMasked.includes('[보안링크]') || row.bodyMasked.includes('[인증번호]')) continue;

    let phone: string;
    try {
      phone = decrypt(row.phoneEnc);
    } catch (e) {
      logger.error('MT 재발송 실패 — 수신번호 복호화 불가', { id: row.id, message: (e as Error).message });
      continue;
    }

    try {
      const res = await adapter.send({
        to: normalizePhone(phone),
        text: row.bodyMasked,
        templateCode: row.templateCode ?? undefined,
        subject: row.templateCode ? tpl.mtSubjectFor(row.templateCode) : undefined,
      });
      await prisma.mtOutboundMessage.update({
        where: { id: row.id },
        data: {
          status: res.ok ? 'SENT' : 'FAILED',
          providerCode: adapter.info().provider,
          providerMessageId: res.data?.providerMessageId ?? null,
          resultCode: res.code ?? null,
          resultMessage: res.message ?? null,
          attempts: { increment: 1 },
          sentAt: res.ok ? new Date() : null,
        },
      });
      if (row.donationId) {
        // 발송 결과는 결제 상태와 무관하다. 알림 상태(mtStatus)만 갱신한다.
        await prisma.donation
          .update({ where: { id: row.donationId }, data: { mtStatus: res.ok ? 'SENT' : 'FAILED' } })
          .catch(() => undefined);
      }
      if (res.ok) sent += 1;
    } catch (e) {
      await prisma.mtOutboundMessage
        .update({
          where: { id: row.id },
          data: { resultMessage: (e as Error).message, attempts: { increment: 1 } },
        })
        .catch(() => undefined);
      logger.error('MT 재발송 실패', { id: row.id, message: (e as Error).message });
    }
  }

  if (sent > 0) logger.info('실패 MT 재발송', { sent });
  return sent;
}

// ---------------------------------------------------------------------------

/** 빌키 복호화는 결제 실행 지점에서만 수행한다. 반환값은 로그에 남기지 않는다. */
function decryptBillKey(enc: string): string {
  return decrypt(enc);
}

async function sendMtForDonor(donorId: string, template: TemplateOutput, donationId?: string, creatorId?: string) {
  const donor = await prisma.donorProfile.findUnique({ where: { id: donorId } });
  if (!donor) return false;
  const phone = decrypt(donor.phoneEnc);
  return sendMt({ phone, template, donationId, creatorId });
}

export { sendMt, sendMtForDonor, setStatus };
