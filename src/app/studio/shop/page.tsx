import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ExternalLink } from '@/components/brand/icons';
import { Badge, Card, Checkbox, Field, Input, LinkButton, Notice, SectionTitle, Select, StatTile } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { ActionForm } from '@/components/studio/action-form';
import { ChannelRowsEditor } from '@/components/public/channel-rows-editor';
import {
  addShopVideoAction,
  saveSellerInfoAction,
  saveShopBasicsAction,
  saveShopChannelsAction,
  shopVideoOpAction,
} from '@/app/actions/studio-shop';
import { requireCreator } from '@/server/auth';
import { prisma } from '@/server/db';
import { getShopVideos } from '@/server/services/shop/videos';
import { sellerInfoMissing } from '@/server/services/shop/catalog';
import { SITE_IMAGE_PRESETS, CLASSIC_MARGIN_IMAGE } from '@/lib/site-images';
import { SHOP_VIDEO_PLATFORM_LABEL } from '@/lib/shop-video-embed';
import { formatNumber } from '@/lib/money';

export const dynamic = 'force-dynamic';

/** 크리에이터 관리자 > 도네이도 샵 > 샵 관리 */
export default async function StudioShopPage() {
  const { creatorId } = await requireCreator();
  const creator = await prisma.creatorProfile.findUnique({
    where: { id: creatorId },
    include: { channels: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] } },
  });
  if (!creator) notFound();
  const [videos, followers, displayCount, myProducts, openOrders] = await Promise.all([
    getShopVideos(creatorId, { includeHidden: true }),
    prisma.memberFollow.count({ where: { creatorId } }),
    prisma.creatorProduct.count({ where: { creatorId, active: true, blocked: false } }),
    prisma.product.count({ where: { creatorId, ownerType: 'CREATOR', deletedAt: null } }),
    prisma.shopOrder.count({ where: { sellerType: 'CREATOR', sellerCreatorId: creatorId, status: { in: ['PAID', 'PREPARING'] } } }),
  ]);
  const missing = sellerInfoMissing(creator);
  const channelRows = creator.channels.map((c) => ({ platform: c.platform, url: c.url, title: c.title ?? '', followers: c.followerCount != null ? String(c.followerCount) : '' }));
  const primaryIndex = Math.max(0, creator.channels.findIndex((c) => c.isPrimary));

  return (
    <>
      <PageHeader
        title="도네이도 샵"
        description="내 샵은 영상 · 쇼핑 · 문자후원 탭으로 구성됩니다. 팬은 내 샵에서 가입·로그인해도 도네이도 통합 회원으로 가입됩니다."
        action={
          <LinkButton href={`/c/${creator.code}`} target="_blank" variant="secondary">
            <ExternalLink size={15} strokeWidth={2} /> 내 샵 바로가기
          </LinkButton>
        }
      />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="팔로워" value={formatNumber(followers)} />
        <StatTile label="진열 상품" value={formatNumber(displayCount)} />
        <StatTile label="내 직접 상품" value={formatNumber(myProducts)} />
        <StatTile label="발송할 주문" value={formatNumber(openOrders)} tone={openOrders > 0 ? 'warning' : 'neutral'} />
      </div>

      <div className="space-y-6">
        <section>
          <SectionTitle title="기본 설정" />
          <Card>
            <ActionForm action={saveShopBasicsAction} submitLabel="저장">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="첫 화면 탭" hint="팬이 샵 주소로 들어왔을 때 먼저 보이는 탭">
                  <Select name="shopDefaultTab" defaultValue={creator.shopDefaultTab}>
                    <option value="VIDEO">영상</option>
                    <option value="SHOP">쇼핑</option>
                    <option value="DONATE">문자후원</option>
                  </Select>
                </Field>
                <Field label="PC 여백 이미지" hint="PC 화면 양옆 여백 그림. 비우면 사이트 기본값을 따릅니다.">
                  <Select name="shopMarginPreset" defaultValue={creator.shopMarginPreset ?? ''}>
                    <option value="">사이트 기본값</option>
                    <option value={CLASSIC_MARGIN_IMAGE}>클래식 도네이도</option>
                    {SITE_IMAGE_PRESETS.margin.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="영상 후원 최소 금액(원)">
                  <Input name="shopDonationMin" inputMode="numeric" defaultValue={creator.shopDonationMin.toString()} required />
                </Field>
                <Field label="영상 후원 추천 금액" hint="쉼표로 구분, 최대 6개 (예: 1000,3000,5000,10000)">
                  <Input name="shopDonationPresets" defaultValue={creator.shopDonationPresets ?? ''} placeholder="1000,3000,5000,10000" />
                </Field>
              </div>
              <Checkbox
                name="shopVideoDonation"
                defaultChecked={creator.shopVideoDonation}
                label="영상 탭에서 후원 받기"
                description="영상을 보던 팬이 바로 후원할 수 있습니다. 후원은 샵 라이브 피드 · 방송 오버레이 · 유튜브 채팅(연동 시)에 함께 표시됩니다."
              />
            </ActionForm>
          </Card>
        </section>

        <section>
          <SectionTitle title="운영 채널" description="유튜브 채널 주소(채널 ID 형식 /channel/UC…)를 넣으면 새 영상이 영상 탭에 자동으로 올라옵니다." />
          <Card>
            {creator.channels.some((c) => !c.verifiedAt) ? (
              <div className="mb-3">
                <Notice tone="warning" title="확인 대기 중인 채널이 있습니다">
                  {creator.channels.filter((c) => !c.verifiedAt).map((c) => c.title || c.url).join(', ')} — 운영팀이 본인 채널인지 확인한 뒤 샵 영상·채널 링크에 반영됩니다.
                </Notice>
              </div>
            ) : null}
            <ActionForm action={saveShopChannelsAction} submitLabel="채널 저장">
              <ChannelRowsEditor initial={channelRows} initialPrimary={primaryIndex} />
            </ActionForm>
          </Card>
        </section>

        <section>
          <SectionTitle title="영상" description="자동 수집된 유튜브 영상 외에 TikTok · Instagram · Facebook · YouTube 영상 주소를 직접 붙여 넣어 올릴 수 있습니다." />
          <Card>
            <ActionForm action={addShopVideoAction} submitLabel="영상 추가">
              <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
                <Field label="영상 주소" required>
                  <Input name="url" type="url" required placeholder="https://www.tiktok.com/@아이디/video/…" />
                </Field>
                <Field label="제목 (선택)">
                  <Input name="title" maxLength={100} />
                </Field>
              </div>
            </ActionForm>
            {videos.length === 0 ? (
              <p className="mt-4 text-[13px] text-ink-400">아직 영상이 없습니다.</p>
            ) : (
              <ul className="mt-4 divide-y divide-ink-100">
                {videos.map((v) => (
                  <li key={v.key} className="flex flex-wrap items-center gap-3 py-2.5">
                    {v.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={v.thumbnail} alt="" className="h-12 w-20 shrink-0 rounded-lg object-cover" loading="lazy" />
                    ) : (
                      <span className="flex h-12 w-20 shrink-0 items-center justify-center rounded-lg bg-ink-100 text-[11px] font-bold text-ink-500">
                        {SHOP_VIDEO_PLATFORM_LABEL[v.platform] ?? v.platform}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <a href={v.url} target="_blank" rel="noreferrer" className="line-clamp-1 text-[13px] font-semibold text-ink-900 hover:underline">
                        {v.title}
                      </a>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        <Badge>{SHOP_VIDEO_PLATFORM_LABEL[v.platform] ?? v.platform}</Badge>
                        <Badge>{v.source === 'AUTO' ? '자동 수집' : '직접 등록'}</Badge>
                        {v.pinned ? <Badge tone="brand">상단 고정</Badge> : null}
                        {v.hidden ? <Badge tone="warning">숨김</Badge> : null}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {(
                        [
                          v.pinned ? ['unpin', '고정 해제'] : ['pin', '상단 고정'],
                          v.hidden ? ['show', '다시 보이기'] : ['hide', '숨기기'],
                          ...(v.source === 'MANUAL' ? [['delete', '삭제']] : []),
                        ] as Array<[string, string]>
                      ).map(([op, label]) => (
                        <ActionForm key={op} action={shopVideoOpAction} submitLabel={label} variant={op === 'delete' ? 'ghost' : 'secondary'} size="sm" confirmMessage={op === 'delete' ? '이 영상을 샵에서 지울까요?' : undefined}>
                          <input type="hidden" name="platform" value={v.platform} />
                          <input type="hidden" name="externalId" value={v.externalId} />
                          <input type="hidden" name="op" value={op} />
                        </ActionForm>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>

        <section>
          <SectionTitle title="판매자 정보" description="직접 상품을 판매할 때 필요합니다. 상품 상세 하단에 표시되며, 도네이도는 통신판매중개자로 함께 표시됩니다." />
          <Card>
            {missing.length > 0 ? (
              <div className="mb-3">
                <Notice tone="warning">직접 상품을 올리려면 다음 정보가 필요합니다: {missing.join(', ')}</Notice>
              </div>
            ) : null}
            <ActionForm action={saveSellerInfoAction} submitLabel="판매자 정보 저장">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="상호 (개인은 이름)" required>
                  <Input name="sellerBizName" defaultValue={creator.sellerBizName ?? ''} maxLength={60} />
                </Field>
                <Field label="사업자등록번호" required>
                  <Input name="sellerBizNo" defaultValue={creator.sellerBizNo ?? ''} placeholder="000-00-00000" />
                </Field>
                <Field label="통신판매업 신고번호" hint="신고 대상이면 입력해 주세요">
                  <Input name="sellerMailOrderNo" defaultValue={creator.sellerMailOrderNo ?? ''} maxLength={40} />
                </Field>
                <Field label="고객센터 연락처" required>
                  <Input name="sellerCsPhone" defaultValue={creator.sellerCsPhone ?? ''} placeholder="010-0000-0000" />
                </Field>
                <Field label="반품 주소" required>
                  <Input name="sellerReturnAddress" defaultValue={creator.sellerReturnAddress ?? ''} maxLength={200} />
                </Field>
              </div>
            </ActionForm>
          </Card>
        </section>

        <p className="text-[12.5px] text-ink-500">
          상품 진열은 <Link href="/studio/shop/products" className="font-bold text-brand-700 underline">상품 관리</Link>, 주문 발송은{' '}
          <Link href="/studio/shop/orders" className="font-bold text-brand-700 underline">주문·수익</Link>에서 합니다.
        </p>
      </div>
    </>
  );
}
