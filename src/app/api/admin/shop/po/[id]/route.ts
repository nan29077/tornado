import { requireAdmin, writeAudit } from '@/server/auth';
import { purchaseOrderCsv } from '@/server/services/shop/purchase-orders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 발주서 CSV 다운로드 (2026-11-17).
 * 받는 분 실명·연락처·주소가 복호화되어 들어가므로 운영(OPERATION)·최고관리자만 허용한다.
 */
const ALLOWED_PERMISSIONS = new Set(['SUPER_ADMIN', 'OPERATION']);

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin().catch(() => null);
  if (!admin) return new Response('관리자 로그인이 필요합니다.', { status: 401 });
  if (!ALLOWED_PERMISSIONS.has(String(admin.adminPermission))) {
    return new Response('발주서는 운영 또는 최고관리자만 내려받을 수 있습니다.', { status: 403 });
  }
  const fetchSite = req.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return new Response('외부 사이트에서 직접 호출할 수 없습니다.', { status: 403 });
  }
  const purpose = req.headers.get('sec-purpose') ?? req.headers.get('purpose');
  if (purpose && purpose.toLowerCase().includes('prefetch')) {
    return new Response('프리페치로는 내려받을 수 없습니다.', { status: 403 });
  }
  const { id } = await params;
  let file: { filename: string; body: string };
  try {
    file = await purchaseOrderCsv(id);
  } catch {
    return new Response('발주서를 찾을 수 없습니다.', { status: 404 });
  }
  await writeAudit({ adminUserId: admin.id, action: 'SHOP_PO_DOWNLOAD', targetType: 'PurchaseOrder', targetId: id });
  return new Response(file.body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(file.filename)}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Cache-Control': 'no-store',
    },
  });
}
