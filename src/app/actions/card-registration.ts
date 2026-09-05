'use server';

import { headers } from 'next/headers';
import { startRegistration, completeRegistration } from '@/server/services/donor-registration';
import { clientIpFrom, consumeIpRateLimit } from '@/server/rate-limit';
import { logger } from '@/lib/logger';
import { toCardYm } from '@/lib/card';
import type { ConsentPayload } from './registration';

/**
 * 카드 빌키 등록 서버 액션 (코엠페이먼츠 DIRECTPAY).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **PCI-DSS 주의**
 *
 * 코엠은 호스팅 결제창이 없는 화이트리스트 방식이라, 카드번호가 후원자 브라우저에서
 * 우리 서버를 거쳐 코엠으로 간다. 이 경로는 PCI-DSS 범위에 들어간다.
 *
 * 이 파일이 지키는 규칙
 *  1. 카드번호·유효기간·비밀번호·생년월일을 **DB 에 저장하지 않는다.**
 *     빌키 발급 응답에서 받은 bill_key 와 끝 4자리만 저장된다
 *     (저장은 donor-registration.completeRegistration 이 담당).
 *  2. **로그에 남기지 않는다.** 이 파일에서 카드 관련 값을 logger 로 넘기지 않는다.
 *     실패 사유도 결제사 메시지만 남기고 입력값은 남기지 않는다.
 *  3. 함수 밖으로 내보내지 않는다. 반환값에 카드정보가 들어가지 않는다.
 *  4. 예외 메시지에 카드번호가 섞이지 않도록 입력값을 그대로 문자열에 넣지 않는다.
 *
 * 화면(card-register-form.tsx)도 같은 원칙을 지켜야 한다:
 * 카드번호를 상태에 오래 두지 않고, 제출 후 즉시 비운다.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface CardRegisterInput {
  token: string;
  consents: ConsentPayload[];
  /** 카드번호(하이픈 허용). 서버는 숫자만 남겨 전송하고 저장하지 않는다. */
  cardNo: string;
  /** 유효기간 MMYY 또는 MM/YY. 코엠 규격은 YYMM 이라 서버에서 변환한다. */
  expiry: string;
  /** 구매자명(카드 소유자). 필수. */
  buyerName: string;
  /** 카드 비밀번호 앞 2자리(선택) */
  cardPw?: string;
  /** 생년월일 6자리 또는 사업자번호 10자리(선택) */
  cardSsn?: string;
  /** 방송 표시 닉네임(선택) */
  nickname?: string;
  snsPlatform?: string;
}

export interface CardRegisterResult {
  ok: boolean;
  message?: string;
  cardIssuer?: string | null;
  cardTail4?: string | null;
}

/**
 * 동의 저장 → 등록 행 생성 → 코엠 빌키 발급 → 결제수단 저장.
 *
 * 결제창이 없으므로 startRegistration 은 `skipProviderSession` 으로 부르고,
 * 카드정보는 completeRegistration 의 providerPayload 로 어댑터에 그대로 넘긴다.
 * 저장 로직(기존 결제수단 폐기, 빌키 암호화 보관)은 기존 경로를 그대로 쓴다.
 */
export async function registerCardBillKeyAction(input: CardRegisterInput): Promise<CardRegisterResult> {
  const h = await headers();
  const ip = clientIpFrom((name) => h.get(name)) ?? undefined;
  const userAgent = h.get('user-agent') ?? undefined;

  // 카드번호 대입 시도를 막는다. 실패해도 계속 눌러 볼 수 있으면 안 된다.
  const limited = await consumeIpRateLimit('card-register', 10, 600);
  if (!limited.ok) {
    return { ok: false, message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' };
  }

  const cardNo = input.cardNo.replace(/\D/g, '');
  const cardYm = toCardYm(input.expiry);
  const buyerName = input.buyerName.trim();

  // 형식 검사는 통신 전에 끝낸다. (오류 메시지에 입력값을 넣지 않는다)
  if (cardNo.length < 15 || cardNo.length > 16) {
    return { ok: false, message: '카드번호를 다시 확인해 주세요.' };
  }
  if (!cardYm) {
    return { ok: false, message: '유효기간을 MM/YY 형식으로 입력해 주세요.' };
  }
  if (!buyerName) {
    return { ok: false, message: '카드 소유자명을 입력해 주세요.' };
  }

  try {
    const started = await startRegistration({
      token: input.token,
      consents: input.consents,
      method: 'CARD',
      nickname: input.nickname,
      snsPlatform: input.snsPlatform,
      // 코엠은 결제창이 없다.
      skipProviderSession: true,
      ip,
      userAgent,
    });

    const res = await completeRegistration({
      token: input.token,
      registrationId: started.registrationId,
      // 카드정보는 여기서 어댑터로 넘어가고, 응답을 받은 뒤 참조가 사라진다.
      providerPayload: {
        card_no: cardNo,
        card_ym: cardYm,
        buyer_nm: buyerName,
        ...(input.cardPw ? { card_pw: input.cardPw.replace(/\D/g, '') } : {}),
        ...(input.cardSsn ? { card_ssn: input.cardSsn.replace(/\D/g, '') } : {}),
      },
      ip,
      userAgent,
    });

    return { ok: true, cardIssuer: res.cardIssuer ?? null, cardTail4: res.cardTail4 ?? null };
  } catch (e) {
    // 결제사/검증 메시지만 남긴다. 입력값은 절대 로그로 내보내지 않는다.
    const message = (e as Error).message || '카드 등록에 실패했습니다.';
    logger.warn('카드 빌키 등록 실패', { message });
    return { ok: false, message };
  }
}
