import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronLeft, Gift, ShoppingBag, Ticket, Trophy } from '@/components/brand/icons';
import { PublicShell } from '@/components/layout/public-shell';
import { cx } from '@/components/ui';
import { MockOfferwall, TicketShop } from '@/components/vote/charge-forms';
import { getSessionUser } from '@/server/auth';
import { getVoteConfig } from '@/server/services/engagement/config';
import { getBalance } from '@/server/services/vote/wallet';
import { listTicketProducts } from '@/server/services/vote/purchase';
import { MOCK_MISSIONS, OFFERWALL_PROVIDERS, completedMockMissionsToday, getOfferwallSettings, mockOfferwallAllowed } from '@/server/services/vote/offerwall';
import { isShopPaymentMock } from '@/server/adapters/shop-payment';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: '투표권 충전소 | 도네이도', robots: { index: false, follow: false } };

export default async function VoteChargePage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const sp = await searchParams;
  const user = await getSessionUser().catch(() => null);
  const [cfg, settings, products] = await Promise.all([getVoteConfig(), getOfferwallSettings(), listTicketProducts()]);
  const freeOn = cfg.enabled && cfg.offerwallEnabled;
  const buyOn = cfg.enabled && cfg.purchaseEnabled;
  const tab = sp.t === 'buy' || !freeOn ? 'buy' : 'free';
  const balance = user ? await getBalance(user.id) : null;
  const done = user ? await completedMockMissionsToday(user.id) : new Set<string>();
  const mockOn = settings.providers.mock.enabled && mockOfferwallAllowed();
  const ratio = settings.providers.mock.ratio;

  return (
    <PublicShell>
      <Link href="/vote" className="mb-3 inline-flex items-center gap-0.5 text-[13px] font-bold text-ink-500 hover:text-brand-800">
        <ChevronLeft size={15} aria-hidden />
        투표 랭킹으로
      </Link>

      <header className="relative mb-4 overflow-hidden rounded-[26px] bg-[linear-gradient(135deg,#ffcd4d_0%,#ffb648_55%,#ff9f1c_100%)] px-5 py-6 text-ink-900 shadow-[0_18px_36px_rgba(227,134,11,0.25)]">
        <span className="pointer-events-none absolute -right-6 -top-8 h-32 w-32 rounded-full bg-white/30 blur-2xl" aria-hidden />
        <p className="text-[11px] font-black tracking-[0.16em] text-ink-900/70">VOTE TICKET</p>
        <h1 className="mt-1 text-[26px] font-black tracking-[-0.04em]">투표권 충전소</h1>
        <p className="mt-1 text-[13px] font-semibold text-ink-900/75">광고 보고 무료로 받거나, 결제해서 한 번에 충전하세요.</p>
        {balance ? (
          <div className="mt-4 grid grid-cols-4 gap-1.5 rounded-2xl bg-white/85 p-3 text-center backdrop-blur">
            {[
              { l: '전체', v: balance.total, strong: true },
              { l: '무료', v: balance.free },
              { l: '유료', v: balance.paid },
              { l: '보너스', v: balance.bonus },
            ].map((x) => (
              <div key={x.l}>
                <p className="text-[11px] font-bold text-ink-500">{x.l}</p>
                <p className={cx('mt-0.5 font-black tabular-nums', x.strong ? 'text-[18px] text-ink-900' : 'text-[15px] text-ink-700')}>{x.v.toLocaleString('ko-KR')}</p>
              </div>
            ))}
            {balance.expiringSoon > 0 ? <p className="col-span-4 mt-1 text-[11.5px] font-bold text-danger-600">7일 안에 사라지는 투표권 {balance.expiringSoon.toLocaleString('ko-KR')}개가 있어요. 먼저 사용돼요.</p> : null}
          </div>
        ) : null}
      </header>

      <nav aria-label="충전 방법" className="mb-4 grid grid-cols-2 gap-1 rounded-2xl bg-white p-1 shadow-card">
        {[
          { key: 'free', label: '무료로 받기', Icon: Gift, on: freeOn },
          { key: 'buy', label: '구매하기', Icon: ShoppingBag, on: buyOn },
        ].map((t) => (
          <Link
            key={t.key}
            href={`/vote/charge?t=${t.key}`}
            aria-current={tab === t.key ? 'page' : undefined}
            className={cx('flex h-11 items-center justify-center gap-1.5 rounded-xl text-[13.5px] font-extrabold', tab === t.key ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-warm-100', !t.on && 'pointer-events-none opacity-40')}
          >
            <t.Icon size={16} aria-hidden />
            {t.label}
          </Link>
        ))}
      </nav>

      {!cfg.enabled ? <p className="rounded-2xl bg-white p-6 text-center text-[13.5px] font-bold text-ink-500 shadow-card">지금은 투표 기능을 쉬고 있어요.</p> : null}

      {cfg.enabled && tab === 'free' ? (
        <section>
          <p className="mb-3 text-[12.5px] text-ink-500">광고를 끝까지 보거나 퀴즈를 풀면 광고사 확인 후 투표권이 들어와요. 같은 광고는 하루에 한 번 참여할 수 있어요.</p>
          {mockOn ? (
            <>
              <p className="mb-2 rounded-xl bg-warning-50 px-3 py-2 text-[12px] font-bold text-warning-600">아래는 테스트 광고입니다. 실제 광고사(버즈빌 · 애드팝콘) 연동 전까지 흐름 확인용으로만 보여요.</p>
              <MockOfferwall
                loggedIn={Boolean(user)}
                missions={MOCK_MISSIONS.map((m) => ({
                  id: m.id,
                  kind: m.kind,
                  title: m.title,
                  advertiser: m.advertiser,
                  points: m.points,
                  tickets: Math.max(1, Math.floor(m.points * ratio)),
                  seconds: m.seconds,
                  quiz: m.quiz ? { question: m.quiz.question, options: m.quiz.options } : undefined,
                  done: done.has(m.id),
                }))}
              />
            </>
          ) : null}
          <div className="mt-4 space-y-2">
            {OFFERWALL_PROVIDERS.filter((p) => p.key !== 'mock').map((p) => (
              <div key={p.key} className="flex items-center gap-3 rounded-2xl border border-dashed border-ink-200 bg-white/70 px-4 py-3">
                <Ticket size={18} className="text-ink-300" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-extrabold text-ink-700">{p.label} 광고</p>
                  <p className="text-[11.5px] text-ink-400">곧 열려요 · 광고 시청 · 퀴즈 · 앱 체험 등</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {cfg.enabled && tab === 'buy' ? (
        <section>
          {products.length === 0 ? (
            <p className="rounded-2xl bg-white p-6 text-center text-[13.5px] font-bold text-ink-500 shadow-card">판매 중인 투표권 상품이 없어요.</p>
          ) : (
            <TicketShop
              loggedIn={Boolean(user)}
              mock={isShopPaymentMock()}
              packs={products.map((p) => ({ id: p.id, name: p.name, price: Number(p.price), tickets: p.tickets, bonus: p.bonus, badge: p.badge }))}
            />
          )}
        </section>
      ) : null}

      <Link href="/vote" className="mt-6 flex items-center justify-center gap-1.5 rounded-2xl bg-white py-3.5 text-[13.5px] font-extrabold text-ink-800 shadow-card">
        <Trophy size={16} className="text-brand-700" aria-hidden />
        투표하러 가기
      </Link>
    </PublicShell>
  );
}
