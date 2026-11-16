import Link from 'next/link';
import { Clapperboard, HeartHandshake, ShoppingBag } from '@/components/brand/icons';
import { cx } from '@/components/ui';

export type ShopTab = 'video' | 'shop' | 'donate';

export function resolveShopTab(param: string | undefined, fallback: string | null | undefined): ShopTab {
  const v = (param ?? '').toLowerCase();
  if (v === 'video' || v === 'shop' || v === 'donate') return v;
  const f = (fallback ?? '').toUpperCase();
  return f === 'SHOP' ? 'shop' : f === 'DONATE' ? 'donate' : 'video';
}

/** 도네이도 샵 탭: 영상 / 쇼핑 / 후원하기(기존 문자·웹 후원) */
export function ShopTabs({ code, active, live }: { code: string; active: ShopTab; live: boolean }) {
  const tabs: Array<{ key: ShopTab; label: string; icon: React.ReactNode }> = [
    { key: 'video', label: live ? '영상 · LIVE' : '영상', icon: <Clapperboard size={16} strokeWidth={1.85} /> },
    { key: 'shop', label: '쇼핑', icon: <ShoppingBag size={16} strokeWidth={1.85} /> },
    { key: 'donate', label: '문자 후원', icon: <HeartHandshake size={16} strokeWidth={1.85} /> },
  ];
  return (
    <nav aria-label="도네이도 샵 탭" className="sticky top-[64px] z-30 -mx-4 mt-5 bg-warm-50/95 px-4 py-2 backdrop-blur lg:static lg:mx-0 lg:px-0">
      <div className="grid grid-cols-3 gap-1 rounded-2xl bg-white p-1 shadow-card">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/c/${code}?tab=${t.key}`}
            scroll={false}
            aria-current={active === t.key ? 'page' : undefined}
            className={cx(
              'flex h-11 items-center justify-center gap-1.5 rounded-xl text-[13.5px] font-extrabold transition-colors',
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
