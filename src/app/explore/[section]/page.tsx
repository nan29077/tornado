import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, ChevronLeft } from '@/components/brand/icons';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { Card, EmptyState, cx } from '@/components/ui';
import { ComingSoonSticker } from '@/components/home-fan/coming-soon-sticker';
import {
  ChannelAvatar, FanChannelCard, FanCreatorCard, FanLiveCard, FanProductCard, UnregisteredBadge,
} from '@/components/home-fan/parts';
import { categoryLabel } from '@/lib/video-hub';
import { getSessionUser } from '@/server/auth';
import { getFanHomeData } from '@/server/services/home-fan';

export const dynamic = 'force-dynamic';

/**
 * 메인 [구독자 전용] 탭 섹션별 [더보기] 전체 보기 (2026-11-17).
 * /explore/live · creators · channels · products · trending
 */
const SECTIONS = {
  live: { title: '지금 라이브', description: '지금 방송 중인 크리에이터와 채널이에요. 가입 크리에이터는 바로 후원할 수 있어요.' },
  creators: { title: '도네이도 크리에이터', description: '도네이도에 가입한 크리에이터예요. 문자 한 통으로 바로 후원할 수 있어요.' },
  channels: { title: '방송국 인기 채널', description: '아직 도네이도에 가입하지 않은 채널이에요. 영상만 볼 수 있어요.' },
  products: { title: '크리에이터 샵 인기 상품', description: '크리에이터가 직접 고른 상품을 샵에서 만나 보세요.' },
  trending: { title: '이번 주 주목받은 크리에이터', description: '후원이 많이 모인 크리에이터와 업로드가 활발한 채널이에요.' },
} as const;
type SectionKey = keyof typeof SECTIONS;

function isSection(v: string): v is SectionKey {
  return Object.hasOwn(SECTIONS, v);
}

export async function generateMetadata({ params }: { params: Promise<{ section: string }> }): Promise<Metadata> {
  const { section } = await params;
  if (!isSection(section)) return { title: '도네이도' };
  return { title: `${SECTIONS[section].title} | 도네이도`, description: SECTIONS[section].description };
}

/** 카드 고정 폭(가로 선반용)을 풀어 격자에 꽉 차게 */
const FLUID = '[&>article]:w-full';

export default async function ExploreSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!isSection(section)) notFound();
  const viewer = await getSessionUser().catch(() => null);
  const data = await getFanHomeData(viewer ? { id: viewer.id } : null, { full: true });
  const meta = SECTIONS[section];

  let body: React.ReactNode;
  let count = 0;
  if (section === 'live') {
    count = data.live.length;
    body = (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {data.live.map((l) => <FanLiveCard key={l.key} item={l} wide />)}
      </div>
    );
  } else if (section === 'creators') {
    const list = [...data.creators].sort((a, b) => b.subscribers - a.subscribers);
    count = list.length;
    body = (
      <div className={cx('grid grid-cols-2 gap-2.5 sm:grid-cols-3', FLUID)}>
        {list.map((c) => <FanCreatorCard key={c.id} creator={c} />)}
      </div>
    );
  } else if (section === 'channels') {
    count = data.channels.length;
    body = (
      <div className={cx('grid grid-cols-1 gap-2.5 min-[420px]:grid-cols-2', FLUID)}>
        {data.channels.map((c) => <FanChannelCard key={c.channelId} channel={c} />)}
      </div>
    );
  } else if (section === 'products') {
    count = data.products.length;
    body = data.products.length > 0 ? (
      <div className={cx('grid grid-cols-2 gap-x-2.5 gap-y-5 sm:grid-cols-3', FLUID)}>
        {data.products.map((p) => <FanProductCard key={p.id} product={p} />)}
      </div>
    ) : (
      <Card><ComingSoonSticker /></Card>
    );
  } else {
    count = data.trending.creators.length + data.trending.channels.length;
    body = (
      <div className="space-y-6">
        {data.trending.creators.length > 0 ? (
          <div>
            <p className="mb-2.5 text-[14px] font-extrabold text-ink-900">후원이 많이 모인 크리에이터</p>
            <div className={cx('grid grid-cols-2 gap-2.5 sm:grid-cols-3', FLUID)}>
              {data.trending.creators.map((c, i) => <FanCreatorCard key={c.id} creator={c} rank={i + 1} />)}
            </div>
          </div>
        ) : null}
        {data.trending.channels.length > 0 ? (
          <Card padded={false} className="divide-y divide-ink-100">
            <p className="px-4 pt-3 text-[13px] font-extrabold text-ink-700">업로드 활발한 채널</p>
            {data.trending.channels.map((c, i) => (
              <Link key={c.channelId} href={`/watch/${encodeURIComponent(c.latest.id)}`} prefetch={false} className="flex items-center gap-3 px-4 py-2.5 hover:bg-ink-50">
                <span className="w-5 text-center text-[12px] font-black text-ink-400">{i + 1}</span>
                <ChannelAvatar channel={c} className="h-9 w-9 text-xs" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1">
                    <span className="truncate text-[13.5px] font-extrabold text-ink-900">{c.title}</span>
                    <UnregisteredBadge />
                  </span>
                  <span className="block truncate text-[11.5px] text-ink-400">{categoryLabel(c.category)} · 최근 7일 업로드 {c.uploads7d}개</span>
                </span>
                <ArrowRight size={14} className="shrink-0 text-ink-300" aria-hidden />
              </Link>
            ))}
          </Card>
        ) : null}
      </div>
    );
  }

  return (
    <PublicShell>
      <Link href="/?tab=fan" className="mb-3 inline-flex items-center gap-0.5 text-[13px] font-bold text-ink-500 hover:text-brand-800">
        <ChevronLeft size={15} aria-hidden />
        구독자 전용으로 돌아가기
      </Link>
      <PageHeader eyebrow="전체 보기" title={meta.title} description={meta.description} />

      {/* 섹션 바로 전환 */}
      <nav aria-label="전체 보기 섹션" className="-mx-4 mb-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:-mx-6 sm:px-6 [&::-webkit-scrollbar]:hidden">
        {(Object.keys(SECTIONS) as SectionKey[]).map((k) => (
          <Link
            key={k}
            href={`/explore/${k}`}
            aria-current={k === section ? 'page' : undefined}
            className={cx(
              'shrink-0 rounded-full border px-3 py-1.5 text-[12.5px] font-bold',
              k === section ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-700 hover:border-brand-300 hover:bg-brand-50',
            )}
          >
            {SECTIONS[k].title}
          </Link>
        ))}
      </nav>

      {count > 0 || section === 'products' ? (
        <>
          {count > 0 ? <p className="mb-3 text-[12.5px] font-semibold text-ink-400">총 {count.toLocaleString('ko-KR')}개</p> : null}
          {body}
        </>
      ) : (
        <EmptyState title="아직 보여 드릴 내용이 없어요" description="곧 새로운 소식으로 채워질 예정이에요." />
      )}

      {data.demo ? (
        <p className="mt-6 text-center text-[11px] text-ink-300">테스트 데이터가 포함된 화면입니다.</p>
      ) : null}
    </PublicShell>
  );
}
