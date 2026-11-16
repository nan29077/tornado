import Link from 'next/link';
import { Badge, Card, EmptyState, Input, LinkButton, Notice, cx } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { ActionForm } from '@/components/studio/action-form';
import { moveDisplayAction, toggleDisplayAction } from '@/app/actions/studio-shop';
import { requireCreator } from '@/server/auth';
import { prisma } from '@/server/db';
import { PRODUCT_CATEGORIES, PRODUCT_STATUS_LABEL, REVIEW_STATUS_LABEL, sellerInfoMissing } from '@/server/services/shop/catalog';
import { rateToPercentText } from '@/server/services/shop/config';
import { formatWon } from '@/lib/money';

export const dynamic = 'force-dynamic';

const TABS = [
  { key: 'catalog', label: '도네이도 상품 고르기' },
  { key: 'display', label: '내 샵 진열' },
  { key: 'mine', label: '내 직접 상품' },
] as const;

function Thumb({ url }: { url: string | null }) {
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" className="h-14 w-14 shrink-0 rounded-xl object-cover" loading="lazy" />
  ) : (
    <span className="h-14 w-14 shrink-0 rounded-xl bg-ink-100" />
  );
}

/** 크리에이터 관리자 > 도네이도 샵 > 상품 관리 */
export default async function StudioShopProductsPage({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string; cat?: string }> }) {
  const { creatorId } = await requireCreator();
  const sp = await searchParams;
  const tab = TABS.find((t) => t.key === sp.tab)?.key ?? 'catalog';
  const q = (sp.q ?? '').trim().slice(0, 40);
  const cat = PRODUCT_CATEGORIES.includes(sp.cat as (typeof PRODUCT_CATEGORIES)[number]) ? sp.cat! : '';
  const [displays, creatorRate, productRates, creator] = await Promise.all([
    prisma.creatorProduct.findMany({ where: { creatorId }, select: { productId: true, active: true, blocked: true } }),
    prisma.creatorCommission.findUnique({ where: { creatorId }, select: { rate: true } }),
    prisma.creatorProductCommission.findMany({ where: { creatorId }, select: { productId: true, rate: true } }),
    prisma.creatorProfile.findUnique({ where: { id: creatorId }, select: { code: true, sellerBizName: true, sellerBizNo: true, sellerCsPhone: true, sellerReturnAddress: true } }),
  ]);
  const displayOf = new Map(displays.map((d) => [d.productId, d]));
  const rateOf = new Map(productRates.map((r) => [r.productId, r.rate]));
  const myRate = (p: { id: string; referralRate: unknown }) => rateOf.get(p.id) ?? creatorRate?.rate ?? p.referralRate;

  let body: React.ReactNode = null;
  if (tab === 'catalog') {
    const products = await prisma.product.findMany({
      where: { ownerType: 'ADMIN', deletedAt: null, reviewStatus: 'APPROVED', status: { in: ['ON_SALE', 'SOLD_OUT'] }, ...(cat ? { category: cat } : {}), ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      select: { id: true, name: true, category: true, price: true, thumbnailUrl: true, status: true, referralRate: true },
    });
    body = (
      <>
        <form className="mb-3 flex flex-wrap gap-2" action="/studio/shop/products">
          <input type="hidden" name="tab" value="catalog" />
          <Input name="q" defaultValue={q} placeholder="상품명 검색" className="max-w-[240px]" />
          <select name="cat" defaultValue={cat} className="rounded-xl border border-ink-200 px-3 text-[13px]">
            <option value="">전체 카테고리</option>
            {PRODUCT_CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <button className="rounded-xl bg-ink-900 px-4 text-[13px] font-bold text-white">찾기</button>
        </form>
        {products.length === 0 ? (
          <EmptyState title="고를 수 있는 상품이 없습니다" description="최고관리자가 상품을 등록하면 여기에 보입니다." />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {products.map((p) => {
              const d = displayOf.get(p.id);
              const on = Boolean(d?.active);
              return (
                <Card key={p.id} className="flex gap-3 p-3">
                  <Thumb url={p.thumbnailUrl} />
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-[13px] font-bold text-ink-900">{p.name}</p>
                    <p className="mt-0.5 text-[12px] text-ink-500">
                      {formatWon(p.price)} · 내 수익 {rateToPercentText(myRate(p))}
                      {p.status === 'SOLD_OUT' ? ' · 품절' : ''}
                    </p>
                    <div className="mt-2">
                      {d?.blocked ? (
                        <Badge tone="danger">관리자가 판매 중지</Badge>
                      ) : (
                        <ActionForm action={toggleDisplayAction} submitLabel={on ? '진열 중 · 내리기' : '내 샵에 진열'} variant={on ? 'secondary' : 'primary'} size="sm">
                          <input type="hidden" name="productId" value={p.id} />
                          <input type="hidden" name="on" value={on ? '0' : '1'} />
                        </ActionForm>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </>
    );
  } else if (tab === 'display') {
    const rows = await prisma.creatorProduct.findMany({
      where: { creatorId, active: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      include: { product: { select: { id: true, name: true, price: true, thumbnailUrl: true, status: true, ownerType: true, reviewStatus: true, deletedAt: true, referralRate: true } } },
    });
    body =
      rows.length === 0 ? (
        <EmptyState title="진열한 상품이 없습니다" description="도네이도 상품 고르기에서 내 샵에 올릴 상품을 고르세요." action={<LinkButton href="/studio/shop/products?tab=catalog">상품 고르기</LinkButton>} />
      ) : (
        <Card className="divide-y divide-ink-100 p-0">
          {rows.map((r, i) => {
            const p = r.product;
            const visible = !r.blocked && !p.deletedAt && p.reviewStatus === 'APPROVED' && (p.status === 'ON_SALE' || p.status === 'SOLD_OUT');
            return (
              <div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="w-6 text-center text-[12px] font-bold text-ink-400">{i + 1}</span>
                <Thumb url={p.thumbnailUrl} />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-1 text-[13px] font-bold">{p.name}</p>
                  <p className="text-[12px] text-ink-500">
                    {formatWon(p.price)} · {p.ownerType === 'ADMIN' ? `도네이도 상품 · 내 수익 ${rateToPercentText(myRate(p))}` : '내 직접 상품'}
                  </p>
                  {!visible ? <Badge tone="warning">{r.blocked ? '관리자 판매 중지' : p.reviewStatus !== 'APPROVED' ? REVIEW_STATUS_LABEL[p.reviewStatus] : PRODUCT_STATUS_LABEL[p.status]} · 샵에 안 보임</Badge> : null}
                </div>
                <div className="flex gap-1">
                  {(['up', 'down'] as const).map((dir) => (
                    <ActionForm key={dir} action={moveDisplayAction} submitLabel={dir === 'up' ? '위로' : '아래로'} variant="ghost" size="sm">
                      <input type="hidden" name="productId" value={p.id} />
                      <input type="hidden" name="dir" value={dir} />
                    </ActionForm>
                  ))}
                  <ActionForm action={toggleDisplayAction} submitLabel="내리기" variant="secondary" size="sm">
                    <input type="hidden" name="productId" value={p.id} />
                    <input type="hidden" name="on" value="0" />
                  </ActionForm>
                </div>
              </div>
            );
          })}
        </Card>
      );
  } else {
    const mine = await prisma.product.findMany({
      where: { ownerType: 'CREATOR', creatorId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, name: true, price: true, thumbnailUrl: true, status: true, reviewStatus: true, rejectReason: true },
    });
    const missing = creator ? sellerInfoMissing(creator) : [];
    body = (
      <>
        <Notice tone="brand">
          직접 상품은 크리에이터님이 판매 당사자이며 도네이도는 통신판매중개자입니다. 등록·수정하면 최고관리자 검수 후 샵에 노출됩니다. 구매 확정된 판매 대금에서 중개 수수료를 뺀 금액이 정산됩니다.
        </Notice>
        {missing.length > 0 ? (
          <div className="mt-3">
            <Notice tone="warning">
              먼저 <Link href="/studio/shop" className="font-bold underline">샵 관리 &gt; 판매자 정보</Link>를 입력해 주세요: {missing.join(', ')}
            </Notice>
          </div>
        ) : null}
        <div className="my-3 flex justify-end">
          <LinkButton href="/studio/shop/products/new">직접 상품 등록</LinkButton>
        </div>
        {mine.length === 0 ? (
          <EmptyState title="등록한 직접 상품이 없습니다" />
        ) : (
          <Card className="divide-y divide-ink-100 p-0">
            {mine.map((p) => (
              <Link key={p.id} href={`/studio/shop/products/${p.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-ink-50">
                <Thumb url={p.thumbnailUrl} />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-1 text-[13px] font-bold">{p.name}</p>
                  <p className="text-[12px] text-ink-500">
                    {formatWon(p.price)} · {PRODUCT_STATUS_LABEL[p.status]}
                  </p>
                  {p.reviewStatus === 'REJECTED' && p.rejectReason ? <p className="text-[12px] text-danger-600">반려 사유: {p.rejectReason}</p> : null}
                </div>
                <Badge tone={p.reviewStatus === 'APPROVED' ? 'success' : p.reviewStatus === 'REJECTED' ? 'danger' : 'warning'}>{REVIEW_STATUS_LABEL[p.reviewStatus]}</Badge>
              </Link>
            ))}
          </Card>
        )}
      </>
    );
  }

  return (
    <>
      <PageHeader title="상품 관리" description="도네이도가 판매하는 상품을 골라 내 샵에 진열하면 팔릴 때마다 수익을 받습니다. 직접 만든 상품도 올릴 수 있습니다." />
      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link key={t.key} href={`/studio/shop/products?tab=${t.key}`} className={cx('rounded-full px-3.5 py-1.5 text-[13px] font-bold', t.key === tab ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-700')}>
            {t.label}
          </Link>
        ))}
      </div>
      {body}
    </>
  );
}
