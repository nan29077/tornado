import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput, AdminSelect } from '@/components/admin/controls';
import { SwitchField } from '@/components/admin/switch';
import { YouTubeAdminTabs } from '@/components/admin/youtube-tabs';
import { requireAdminPage } from '@/server/admin-guard';
import { prisma } from '@/server/db';
import { MAX_API_CHANNELS, getYouTubeApiSettings, resolveYouTubeApiKey } from '@/server/services/youtube-api';
import {
  addYouTubeApiChannelAction,
  collectAllYouTubeAction,
  saveYouTubeCollectSettingsAction,
  youTubeApiChannelOpAction,
  youTubeApiVideoOpAction,
} from '@/app/actions/admin/youtube-api';
import { CONTENT_CATEGORY_SLUGS, categoryLabel, formatViews, youtubeWatchUrl } from '@/lib/video-hub';
import { formatKst } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';

export const dynamic = 'force-dynamic';

/** 최고관리자 > 유튜브 연동 > 영상 수집 (2026-11-18) */
export default async function AdminYouTubeVideosPage({ searchParams }: { searchParams?: Promise<{ ch?: string }> }) {
  await requireAdminPage('/admin/youtube/videos');
  const sp = (await searchParams) ?? {};
  const settings = await getYouTubeApiSettings();
  const [key, channels, videoTotal, hiddenTotal] = await Promise.all([
    resolveYouTubeApiKey(settings),
    prisma.youTubeApiChannel.findMany({
      orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
      take: MAX_API_CHANNELS,
      include: { _count: { select: { videos: true } } },
    }),
    prisma.youTubeApiVideo.count(),
    prisma.youTubeApiVideo.count({ where: { hidden: true } }),
  ]);
  const selected = channels.find((c) => c.id === sp.ch) ?? null;
  const videos = await prisma.youTubeApiVideo.findMany({
    where: selected ? { channelRowId: selected.id } : {},
    orderBy: { publishedAt: 'desc' },
    take: 60,
    select: { videoId: true, title: true, thumbnail: true, publishedAt: true, views: true, isShort: true, liveState: true, hidden: true, channel: { select: { title: true } } },
  });
  const noKey = key.source === 'none';

  return (
    <>
      <PageHeader
        title="유튜브 연동 관리"
        description="수집할 유튜브 채널을 등록하면 YouTube Data API 로 최신 영상을 가져와 방송국(영상 허브)에 조회수·채널 아바타와 함께 보여 줍니다."
      />
      <YouTubeAdminTabs active="videos" />

      {noKey ? (
        <div className="mb-4">
          <Notice tone="warning" title="API 키가 없습니다">
            먼저 <Link href="/admin/youtube/api" className="font-bold underline">API 키 관리</Link> 탭에서 YouTube Data API 키를 등록해 주세요. 키가 없어도 방송국은 기존 공개 피드(RSS)로 계속 동작합니다.
          </Notice>
        </div>
      ) : null}

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="수집 채널" value={`${formatNumber(channels.filter((c) => c.active).length)} / ${formatNumber(channels.length)}`} sub="수집 중 / 전체" tone="brand" />
        <StatTile label="수집 영상" value={formatNumber(videoTotal)} sub={hiddenTotal ? `숨김 ${formatNumber(hiddenTotal)}` : undefined} />
        <StatTile label="마지막 수집" value={settings.lastCollectAt ? formatKst(new Date(settings.lastCollectAt), false) : '-'} sub={settings.lastCollectSummary ?? undefined} />
        <StatTile label="자동 수집" value={settings.enabled && settings.autoCollect ? `${settings.intervalHours}시간마다` : '꺼짐'} sub={`채널당 최신 ${settings.perChannel}개`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>채널 추가</CardTitle>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">채널 주소, @핸들, UC로 시작하는 채널 ID 중 하나를 넣으면 채널을 확인한 뒤 최신 영상을 바로 가져옵니다. (약 3 units)</p>
          <ActionForm action={addYouTubeApiChannelAction} submitLabel="채널 추가하고 수집" className="mt-3" disabledReason={noKey ? 'API 키를 먼저 등록해 주세요.' : undefined}>
            <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
              <AdminField label="채널">
                <AdminInput name="channel" required maxLength={200} placeholder="https://www.youtube.com/@핸들" />
              </AdminField>
              <AdminField label="방송국 카테고리">
                <AdminSelect name="category" defaultValue="talk" required>
                  {CONTENT_CATEGORY_SLUGS.map((c) => (
                    <option key={c} value={c}>
                      {categoryLabel(c)}
                    </option>
                  ))}
                </AdminSelect>
              </AdminField>
            </div>
          </ActionForm>
          <div className="mt-3 border-t border-ink-100 pt-3">
            <ActionForm
              action={collectAllYouTubeAction}
              submitLabel="전체 채널 지금 수집"
              variant="secondary"
              compact
              disabledReason={noKey ? 'API 키를 먼저 등록해 주세요.' : channels.length === 0 ? '수집할 채널이 없습니다.' : undefined}
            />
          </div>
        </Card>

        <Card>
          <CardTitle>수집 설정</CardTitle>
          <ActionForm action={saveYouTubeCollectSettingsAction} submitLabel="설정 저장" className="mt-2">
            <div className="space-y-3">
              <SwitchField label="방송국에 수집 영상 보이기" name="enabled" value={settings.enabled} hint="끄면 수집 영상을 방송국에서 내리고 기존 공개 피드만 씁니다." />
              <SwitchField label="자동 수집" name="autoCollect" value={settings.autoCollect} hint="방송국을 누군가 열 때 간격이 지났으면 뒤에서 한 번 수집합니다. 하루 할당량 70%를 넘으면 멈춥니다." />
              <div className="grid grid-cols-2 gap-3">
                <AdminField label="자동 수집 간격(시간)">
                  <AdminInput name="intervalHours" inputMode="numeric" defaultValue={String(settings.intervalHours)} required />
                </AdminField>
                <AdminField label="채널당 최신 영상 수(1~50)">
                  <AdminInput name="perChannel" inputMode="numeric" defaultValue={String(settings.perChannel)} required />
                </AdminField>
              </div>
            </div>
          </ActionForm>
        </Card>
      </div>

      <div className="mt-5">
        <SectionTitle title="수집 채널" description={`최대 ${MAX_API_CHANNELS}개. 멈추면 그 채널 영상은 방송국에서 내려갑니다. 삭제하면 수집한 영상도 함께 지웁니다.`} />
        {channels.length === 0 ? (
          <EmptyState title="등록된 수집 채널이 없습니다" description="위에서 채널을 추가해 주세요." />
        ) : (
          <ul className="grid gap-2.5 md:grid-cols-2" aria-label="수집 채널 목록">
            {channels.map((c) => (
              <li key={c.id} className="rounded-[18px] border border-ink-100 bg-white p-3.5 shadow-[0_8px_24px_rgba(23,22,26,0.05)]">
                <div className="flex items-start gap-3">
                  {c.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.avatarUrl} alt="" className="h-11 w-11 shrink-0 rounded-full object-cover" loading="lazy" />
                  ) : (
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-ink-100 text-[13px] font-bold text-ink-500">{(c.title ?? 'Y').slice(0, 1)}</span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <a href={`https://www.youtube.com/channel/${c.channelId}`} target="_blank" rel="noopener noreferrer" className="truncate text-[14px] font-extrabold text-ink-900 hover:underline">
                        {c.title ?? c.channelId}
                      </a>
                      {c.active ? <Badge tone="success">수집 중</Badge> : <Badge>멈춤</Badge>}
                      <Badge tone="brand">{categoryLabel(c.category)}</Badge>
                    </div>
                    <p className="mt-0.5 truncate text-[11.5px] text-ink-400">
                      {c.handle ?? c.channelId}
                      {c.subscriberCount != null ? ` · 구독자 ${formatNumber(c.subscriberCount)}` : ''} · 영상 {formatNumber(c._count.videos)}개
                    </p>
                    <p className="mt-0.5 text-[11.5px] text-ink-400">마지막 수집 {c.lastFetchedAt ? formatKst(c.lastFetchedAt, false) : '-'}</p>
                    {c.lastError ? <p className="mt-1 break-words text-[12px] text-danger-600">{c.lastError}</p> : null}
                  </div>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <ActionForm action={youTubeApiChannelOpAction} submitLabel="지금 수집" variant="secondary" compact disabledReason={noKey ? 'API 키 필요' : undefined}>
                    <input type="hidden" name="id" value={c.id} />
                    <input type="hidden" name="op" value="collect" />
                  </ActionForm>
                  <ActionForm action={youTubeApiChannelOpAction} submitLabel={c.active ? '멈추기' : '다시 시작'} variant="secondary" compact>
                    <input type="hidden" name="id" value={c.id} />
                    <input type="hidden" name="op" value={c.active ? 'pause' : 'resume'} />
                  </ActionForm>
                  <ActionForm action={youTubeApiChannelOpAction} submitLabel="삭제" variant="danger" compact confirm={`${c.title ?? c.channelId} 채널과 수집한 영상을 삭제할까요?`}>
                    <input type="hidden" name="id" value={c.id} />
                    <input type="hidden" name="op" value="delete" />
                  </ActionForm>
                  <Link href={`/admin/youtube/videos?ch=${c.id}#videos`} className="ml-auto text-[12px] font-bold text-brand-700">
                    영상 보기
                  </Link>
                </div>
                <ActionForm action={youTubeApiChannelOpAction} submitLabel="카테고리 변경" variant="secondary" compact className="mt-2">
                  <input type="hidden" name="id" value={c.id} />
                  <input type="hidden" name="op" value="category" />
                  <AdminSelect name="category" defaultValue={c.category} aria-label="카테고리">
                    {CONTENT_CATEGORY_SLUGS.map((s) => (
                      <option key={s} value={s}>
                        {categoryLabel(s)}
                      </option>
                    ))}
                  </AdminSelect>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-5" id="videos">
        <SectionTitle
          title={selected ? `${selected.title ?? selected.channelId} 수집 영상` : '최근 수집 영상'}
          description="최근 60개. 숨긴 영상은 방송국에 나오지 않습니다."
        />
        {selected ? (
          <Link href="/admin/youtube/videos#videos" className="mb-2 inline-block text-[12.5px] font-bold text-brand-700">
            전체 채널 보기
          </Link>
        ) : null}
        {videos.length === 0 ? (
          <EmptyState title="수집한 영상이 없습니다" />
        ) : (
          <ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3" aria-label="수집 영상">
            {videos.map((v) => (
              <li key={v.videoId} className={`rounded-2xl border border-ink-100 bg-white p-2 ${v.hidden ? 'opacity-60' : ''}`}>
                <a href={youtubeWatchUrl(v.videoId)} target="_blank" rel="noopener noreferrer" className="block">
                  <span className="relative block aspect-video overflow-hidden rounded-xl bg-ink-100">
                    {v.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={v.thumbnail} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
                    ) : null}
                  </span>
                  <span className="mt-1.5 line-clamp-2 block px-1 text-[13px] font-bold leading-snug text-ink-900">{v.title}</span>
                </a>
                <div className="mt-1 flex flex-wrap items-center gap-1 px-1 text-[11.5px] text-ink-400">
                  <span className="truncate">{v.channel.title}</span>
                  <span>· {formatKst(v.publishedAt, false)}</span>
                  {formatViews(v.views) ? <span>· {formatViews(v.views)}</span> : null}
                  {v.isShort ? <Badge>쇼츠</Badge> : null}
                  {v.liveState === 'live' ? <Badge tone="danger">라이브</Badge> : v.liveState === 'upcoming' ? <Badge>예정</Badge> : null}
                  {v.hidden ? <Badge tone="warning">숨김</Badge> : null}
                </div>
                <div className="mt-1.5 px-1">
                  <ActionForm action={youTubeApiVideoOpAction} submitLabel={v.hidden ? '다시 보이기' : '방송국에서 숨기기'} variant="secondary" compact>
                    <input type="hidden" name="videoId" value={v.videoId} />
                    <input type="hidden" name="op" value={v.hidden ? 'show' : 'hide'} />
                  </ActionForm>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
