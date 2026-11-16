import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, EmptyState, LinkButton, Table, Td, Th, cx } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminTextarea } from '@/components/admin/controls';
import { reviewCreatorProduct } from '@/app/actions/admin/shop';
import { prisma } from '@/server/db';
import { requireAdminPage } from '@/server/admin-guard';
import { PRODUCT_STATUS_LABEL, REVIEW_STATUS_LABEL } from '@/server/services/shop/catalog';
import { rateToPercentText } from '@/server/services/shop/config';
import { formatWon, formatNumber } from '@/lib/money';

export const dynamic = 'force-dynamic';

/** 최고관리자 > 도네이도 샵 > 상품 관리 (관리자 상품 / 크리에이터 직접 상품 검수) */
export default async function AdminShopProductsPage({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string }> }) {
  await requireAdminPage('/admin/shop/products');
  const sp = await searchParams;
  const tab = sp.tab === 'creator' ? 'creator' : 'admin';
  const q = (sp.q ?? '').trim().slice(0, 50);
  const [products, pendingReview] = await Promise.all([
    prisma.product.findMany({
      where: { ownerType: tab === 'admin' ? 'ADMIN' : 'CREATOR', deletedAt: null, ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) },
      orderBy: tab === 'creator' ? [{ reviewStatus: 'asc' }, { updatedAt: 'desc' }] : { updatedAt: 'desc' },
      take: 200,
      include: {
        supplier: { select: { name: true } },
        creator: { select: { displayName: true, code: true } },
        variants: { where: { active: true }, select: { stock: true } },
        _count: { select: { displays: true } },
      },
    }),
    prisma.product.count({ where: { ownerType: 'CREATOR', reviewStatus: 'PENDING', deletedAt: null } }),
  ]);

  return (
    <div>
      <PageHeader
        title="상품 관리"
        description="관리자 상품은 도네이도가 판매 당사자입니다. 크리에이터가 골라 자기 샵에 전시하면 레퍼럴 수익을 받습니다. 크리에이터 직접 상품은 검수 후 노출됩니다."
        action={<LinkButton href="/admin/shop/products/new" size="sm">관리자 상품 등록</LinkButton>}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {[
          { key: 'admin', label: '관리자 상품' },
          { key: 'creator', label: `크리에이터 직접 상품${pendingReview ? ` (검수 대기 ${pendingReview})` : ''}` },
        ].map((t) => (
          <Link key={t.key} href={`/admin/shop/products?tab=${t.key}`} className={cx('rounded-xl border px-3 py-2 text-[13px] font-bold', tab === t.key ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-100 bg-white text-ink-600')}>
            {t.label}
          </Link>
        ))}
        <form className="ml-auto flex gap-2">
          <input type="hidden" name="tab" value={tab} />
          <input name="q" defaultValue={q} placeholder="상품명 검색" aria-label="상품명 검색" className="h-9 rounded-xl border border-ink-200 px-3 text-[13px]" />
        </form>
      </div>

      {products.length === 0 ? (
        <EmptyState title="상품이 없습니다" description={tab === 'admin' ? '관리자 상품을 등록하면 크리에이터가 골라 자기 샵에 전시할 수 있습니다.' : '크리에이터가 직접 등록한 상품이 여기에 모입니다.'} />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>상품</Th>
              <Th>판매가</Th>
              <Th>재고</Th>
              <Th>{tab === 'admin' ? '공급처 · 수익률' : '판매자'}</Th>
              <Th>상태</Th>
              <Th>{tab === 'admin' ? '전시 샵' : '검수'}</Th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => {
              const stock = p.variants.reduce((s, v) => s + v.stock, 0);
              return (
                <tr key={p.id}>
                  <Td>
                    <Link href={`/admin/shop/products/${p.id}`} className="font-bold text-brand-700 underline">
                      {p.name}
                    </Link>
                    <span className="block text-[11px] text-ink-400">판매 {formatNumber(p.soldCount)}개{p.category ? ` · ${p.category}` : ''}</span>
                  </Td>
                  <Td className="tabular-nums">{formatWon(p.price)}</Td>
                  <Td className={cx('tabular-nums', stock <= 0 ? 'font-bold text-danger-600' : '')}>{formatNumber(stock)}</Td>
                  <Td>
                    {tab === 'admin' ? (
                      <>
                        {p.supplier?.name ?? <span className="text-warning-600">미지정</span>}
                        <span className="block text-[11px] text-ink-400">레퍼럴 {rateToPercentText(p.referralRate)}</span>
                      </>
                    ) : (
                      <>
                        {p.creator?.displayName ?? '-'}
                        <span className="block text-[11px] text-ink-400">{p.creator?.code}</span>
                      </>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={p.status === 'ON_SALE' ? 'success' : p.status === 'SOLD_OUT' ? 'danger' : 'neutral'}>{PRODUCT_STATUS_LABEL[p.status] ?? p.status}</Badge>
                  </Td>
                  <Td>
                    {tab === 'admin' ? (
                      `${formatNumber(p._count.displays)}개 샵`
                    ) : (
                      <div className="min-w-[220px] space-y-1">
                        <Badge tone={p.reviewStatus === 'APPROVED' ? 'success' : p.reviewStatus === 'REJECTED' ? 'danger' : 'warning'}>{REVIEW_STATUS_LABEL[p.reviewStatus]}</Badge>
                        {p.rejectReason ? <p className="text-[11px] text-danger-600">{p.rejectReason}</p> : null}
                        {p.reviewStatus !== 'APPROVED' ? (
                          <ActionForm action={reviewCreatorProduct} submitLabel="승인" compact>
                            <input type="hidden" name="id" value={p.id} />
                            <input type="hidden" name="decision" value="APPROVED" />
                          </ActionForm>
                        ) : null}
                        {p.reviewStatus !== 'REJECTED' ? (
                          <ActionForm action={reviewCreatorProduct} submitLabel="반려" variant="secondary" compact>
                            <input type="hidden" name="id" value={p.id} />
                            <input type="hidden" name="decision" value="REJECTED" />
                            <AdminTextarea name="reason" rows={2} maxLength={300} placeholder="반려 사유" aria-label="반려 사유" />
                          </ActionForm>
                        ) : null}
                      </div>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <Card className="mt-4 text-[12.5px] leading-relaxed text-ink-500">
        크리에이터 직접 상품은 크리에이터가 판매자이고 도네이도는 통신판매중개자입니다. 상품 화면·주문서에 판매자 정보와 중개자 고지가 자동으로 표시됩니다.
      </Card>
    </div>
  );
}
