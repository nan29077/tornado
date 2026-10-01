import { getPaymentAdapter } from '@/server/adapters/payment';
import { getMtAdapter } from '@/server/adapters/mt';
import { logger } from '@/lib/logger';

/**
 * 결제·문자 발송이 모의(mock) 상태인지.
 *
 * 공개 화면의 "실제 결제와 문자 발송은 이루어지지 않습니다" 안내는 **이 값이 true 일 때만** 보여 준다
 * (2026-10-01). 예전에는 문구가 코드에 고정돼 있어, 실결제로 전환한 뒤에도 모든 공개 페이지에
 * "결제 비활성화" 가 보여 실제로 돈이 나가는데 테스트로 오해하게 만들었다.
 * 어댑터 조회가 실패하면(설정 오류 등) 안내를 숨기지 않고 보여 주는 쪽으로 판단한다.
 */
export function isServiceInMockMode(): boolean {
  try {
    return getPaymentAdapter().info().mode === 'mock' || getMtAdapter().info().mode === 'mock';
  } catch (e) {
    logger.warn('결제·문자 어댑터 상태 확인 실패 — 모의 안내를 표시합니다', { message: (e as Error).message });
    return true;
  }
}
