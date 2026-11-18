import Link from 'next/link';
import { Clapperboard, HeartHandshake, MessagesSquare, ShoppingBag } from '@/components/brand/icons';
import { cx } from '@/components/ui';

export type ShopTab = 'video' | 'shop' | 'donate' | 'talk';

export function resolveShopTab(param: string | undefined, fallback: string | null | undefined): ShopTab {
  const v = (param ?? '').toLowerCase();
  if (v === 'video' || v === 'shop' || v === 'donate' || v === 'talk') return v;
  const f = (fallback ?? '').toUpperCase();
  return f === 'SHOP' ? 'shop' : f === 'DONATE' ? 'donate' : 'video';
}

/** [후원하기] 탭 안의 후원 방식 (2026-11-17): 문자후원 / 신용카드 후원 / 간편계좌이체 후원 */
export type DonateMethod = 'sms' | 'card' | 'transfer';

export const DONATE_METHODS: Array<{ key: DonateMethod; label: string; short: string }> = [
  { key: 'sms', label: '문자후원', short: '문자' },
  { key: 'card', label: '신용카드 후원', short: '신용카드' },
  { key: 'transfer', label: '간편계좌이체 후원', short: '계좌이체' },
];

/** 주소의 ?m= 값. 없으면 문자 번호가 있으면 문자후원, 없으면 간편계좌이체 */
export function resolveDonateMethod(param: string | undefined, hasSmsNumber: boolean): DonateMethod {
  const v = (param ?? '').toLowerCase();
  if (v === 'sms' || v === 'card' || v === 'transfer') return v;
  return hasSmsNumber ? 'sms' : 'transfer';
}

/** 도네이도 샵 탭: 영상 / 쇼핑 / 후원하기(문자 · 신용카드 · 간편계좌이체) / 팬챗(2026-11-17, 팬챗 기능이 켜져 있을 때) */
export function ShopTabs({ code, active, live, talk = false }: { code: string; active: ShopTab; live: boolean; talk?: boolean }) {
  const tabs: Array<{ key: ShopTab; label: string; icon: React.ReactNode }> = [
    { key: 'video', label: live ? '영상 · LIVE' : '영상', icon: <Clapperboard size={16} strokeWidth={1.85} /> },
    { key: 'shop', label: '쇼핑', icon: <ShoppingBag size={16} strokeWidth={1.85} /> },
    { key: 'donate', label: '후원하기', icon: <HeartHandshake size={16} strokeWidth={1.85} /> },
    ...(talk ? [{ key: 'talk' as const, label: '팬챗', icon: <MessagesSquare size={16} strokeWidth={1.85} /> }] : []),
  ];
  return (
    <nav aria-label="도네이도 샵 탭" className="sticky top-[64px] z-30 -mx-4 mt-5 bg-warm-50/95 px-4 py-2 backdrop-blur lg:static lg:mx-0 lg:px-0">
      <div className={cx('grid gap-1 rounded-2xl bg-white p-1 shadow-card', tabs.length >= 4 ? 'grid-cols-4' : 'grid-cols-3')}>
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/c/${code}?tab=${t.key}`}
            scroll={false}
            aria-current={active === t.key ? 'page' : undefined}
            className={cx(
              'flex h-11 min-w-0 items-center justify-center gap-1 whitespace-nowrap rounded-xl text-[12.5px] font-extrabold transition-colors min-[400px]:gap-1.5 sm:text-[13.5px]',
              active === t.key ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-warm-100',
            )}
          >
            {t.icon}
            {t.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
