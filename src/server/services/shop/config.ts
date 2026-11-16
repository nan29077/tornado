/**
 * 도네이도 샵 운영 설정 (최고관리자가 바꾼다). system_setting 에 JSON 으로 저장.
 */
import { prisma } from '@/server/db';

export const SHOP_SETTING_KEY = 'shop.config';

export interface ShopConfig {
  /** 크리에이터 직접 판매 중개 수수료율 (0.1 = 10%) */
  brokerFeeRate: number;
  /** 배송 완료(또는 발송) 후 자동 구매 확정까지 일수 */
  autoConfirmDays: number;
}

export const DEFAULT_SHOP_CONFIG: ShopConfig = { brokerFeeRate: 0.1, autoConfirmDays: 7 };

export async function getShopConfig(): Promise<ShopConfig> {
  const row = await prisma.systemSetting.findUnique({ where: { key: SHOP_SETTING_KEY } }).catch(() => null);
  const v = (row?.value ?? {}) as Partial<ShopConfig>;
  const rate = Number(v.brokerFeeRate);
  const days = Number(v.autoConfirmDays);
  return {
    brokerFeeRate: Number.isFinite(rate) && rate >= 0 && rate <= 0.5 ? rate : DEFAULT_SHOP_CONFIG.brokerFeeRate,
    autoConfirmDays: Number.isInteger(days) && days >= 1 && days <= 30 ? days : DEFAULT_SHOP_CONFIG.autoConfirmDays,
  };
}

export async function saveShopConfig(cfg: ShopConfig) {
  await prisma.systemSetting.upsert({
    where: { key: SHOP_SETTING_KEY },
    create: { key: SHOP_SETTING_KEY, value: cfg as unknown as object },
    update: { value: cfg as unknown as object },
  });
}

/** 퍼센트 입력("5", "2.5") → 소수 문자열("0.050000"). 범위 밖이면 null */
export function percentToRate(input: string, max = 100): string | null {
  const v = input.trim().replace(/%$/, '');
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return (n / 100).toFixed(6);
}

export function rateToPercentText(rate: unknown): string {
  const n = Number(rate);
  if (!Number.isFinite(n)) return '-';
  return `${(n * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/** floor(amount × rate) — 금액은 원 단위 BigInt, 요율은 소수 */
export function applyRate(amount: bigint, rate: unknown): bigint {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) return 0n;
  // 소수 6자리 고정소수점으로 계산해 부동소수점 오차를 피한다
  const micro = BigInt(Math.round(r * 1_000_000));
  return (amount * micro) / 1_000_000n;
}
