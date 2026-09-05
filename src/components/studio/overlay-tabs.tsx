import Link from 'next/link';
import { Gamepad2, Heart } from 'lucide-react';
import { cx } from '@/components/ui';

/**
 * 방송 오버레이 화면의 탭.
 *
 *  - 후원 오버레이 : 후원 알림 꾸미기 · 금액 구간 · 테스트
 *  - 게임 오버레이 : 게임 진행 컨트롤 · 참여 현황 · 이력
 *
 * 탭 상태를 주소(?tab=)에 둔다. 새로고침·뒤로가기·즐겨찾기가 그대로 동작하고,
 * 팝아웃 창이나 다른 화면에서 바로 게임 탭으로 들어올 수 있다.
 */
export function OverlayTabs({ active, gameLive }: { active: 'donation' | 'game'; gameLive?: boolean }) {
  const tabs = [
    { key: 'donation' as const, label: '후원 오버레이', Icon: Heart, href: '/studio/overlay?tab=donation' },
    { key: 'game' as const, label: '게임 오버레이', Icon: Gamepad2, href: '/studio/overlay?tab=game' },
  ];

  return (
    /*
      화면 맨 위 헤더 바로 아래에 붙는다.
      - 배경을 반투명으로 두면 뒤 내용이 비쳐 지저분하다. 불투명하게 깐다.
      - 아래 여백(pb-4)까지 이 바의 배경으로 덮는다. 그래야 바와 다음 카드 사이의 틈으로
        스크롤되는 내용이 비쳐 보이지 않는다.
      - z-index 는 진행 컨트롤(20)보다 높아야 컨트롤 카드가 이 바 밑으로 미끄러져 들어간다.
      높이(4.75rem)는 globals.css 의 --overlay-tabbar-h 와 맞춘다.
    */
    /* pb 는 --overlay-tabbar-h 와 함께 움직인다. 16px 로는 붙어 보여 20px 로 벌렸다. */
    <div className="overlay-tabbar sticky top-[var(--console-header-h)] z-30 -mx-1 px-1 pb-5 pt-2">
      <div className="flex gap-1.5 rounded-2xl border border-ink-100 bg-white p-1.5 shadow-[0_1px_2px_rgba(92,61,28,0.05)]">
        {tabs.map(({ key, label, Icon }) => {
          const on = active === key;
          return (
            <Link
              key={key}
              href={`/studio/overlay?tab=${key}`}
              scroll={false}
              className={cx(
                'inline-flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[14px] font-extrabold transition-colors',
                on ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-ink-50',
              )}
            >
              <Icon size={17} strokeWidth={1.8} />
              {label}
              {key === 'game' && gameLive ? (
                <span
                  className="ml-0.5 inline-block h-2 w-2 rounded-full bg-success-500"
                  aria-label="게임이 방송 화면에 떠 있습니다"
                />
              ) : null}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
