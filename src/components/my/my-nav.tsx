'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from '@/components/ui';
import { BellRing, Heart, HeartHandshake, MessagesSquare, Package, ReceiptText, Trophy, UserRound } from '@/components/brand/icons';

/**
 * 마이페이지 탭 (2026-11-17 도네이도 샵: 구독·주문·찜 추가).
 * 한도·차단·동의·배송지·크리에이터 전환 같은 설정은 "내 정보" 안에서 이동한다.
 * 모바일에서는 가로로 밀어서 본다.
 */
const TABS = [
  { href: '/my', label: '후원', icon: HeartHandshake, match: ['/my'] },
  { href: '/my/following', label: '구독', icon: BellRing, match: ['/my/following'] },
  // 2026-11-17 투표권 · 소통
  { href: '/my/votes', label: '투표', icon: Trophy, match: ['/my/votes'] },
  { href: '/talk', label: '소통', icon: MessagesSquare, match: ['/my/talk'] },
  { href: '/my/orders', label: '주문·배송', icon: Package, match: ['/my/orders'] },
  { href: '/my/wishlist', label: '찜', icon: Heart, match: ['/my/wishlist'] },
  { href: '/my/payments', label: '결제', icon: ReceiptText, match: ['/my/payments'] },
  { href: '/my/account', label: '내 정보', icon: UserRound, match: ['/my/account', '/my/limits', '/my/blocks', '/my/consents', '/my/addresses', '/my/creator'] },
];

function isActive(pathname: string, match: string[]) {
  return match.some((m) => (m === '/my' ? pathname === '/my' : pathname === m || pathname.startsWith(`${m}/`)));
}

export function MyNav() {
  const pathname = usePathname();
  return (
    <nav className="mb-4">
      <div className="flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden rounded-2xl bg-ink-100 p-1">
        {TABS.map((t) => {
          const active = isActive(pathname, t.match);
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? 'page' : undefined}
              className={cx(
                'flex min-w-[4.5rem] flex-1 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-xl px-2 py-2 text-center text-[12.5px] font-bold transition-colors',
                active ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-900',
              )}
            >
              <Icon size={16} strokeWidth={1.65} className="text-ink-800" />
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
