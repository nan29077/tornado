import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, DataRow, Notice, SectionTitle } from '@/components/ui';
import { AdminField, AdminTextarea } from '@/components/admin/controls';
import { ActionButton, ActionForm } from '@/components/admin/action-form';
import { replyInquiry, setInquiryStatus } from '@/app/actions/admin/inquiries';
import { markInquiryRead } from '@/server/services/inquiry';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatKst } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';
import { SUPPORT_CATEGORIES } from '@/components/public/support-options';
import { cx } from '@/components/ui';
import type { InquiryStatus } from '@/generated/prisma/enums';
import { headers } from 'next/headers';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<InquiryStatus, { text: string; tone: 'warning' | 'success' | 'neutral' }> = {
  OPEN: { text: '답변 대기', tone: 'warning' },
  ANSWERED: { text: '답변 완료', tone: 'success' },
  CLOSED: { text: '종결', tone: 'neutral' },
};

export default async function AdminInquiryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // 레이아웃과 페이지는 병렬로 렌더링되므로, 읽음 처리(쓰기)를 하는 이 페이지는 직접 관리자 인증을 확인한다.
  const admin = await requireAdmin();
  // 문의에는 문의자 연락처가 포함된다. 메뉴와 같은 기준(최고관리자)으로만 연다.
  if (admin.adminPermission !== 'SUPER_ADMIN') {
    return (
      <>
        <PageHeader title="1:1 문의" description="최고관리자 권한에서만 열람할 수 있습니다." />
        <Notice tone="danger" title="권한이 없습니다">문의 내용은 최고관리자만 확인할 수 있습니다.</Notice>
      </>
    );
  }

  const inquiry = await prisma.supportInquiry.findUnique({
    where: { id },
    select: {
      id: true, userId: true, guestName: true, contactMasked: true, status: true,
      category: true, source: true, transactionNo: true, donationId: true, creatorId: true,
      createdAt: true, lastMessageAt: true,
      messages: { orderBy: { createdAt: 'asc' }, take: 300, select: { id: true, sender: true, body: true, createdAt: true } },
    },
  });
  if (!inquiry) notFound();

  /**
   * **프리페치 요청에서는 읽음 처리를 하지 않는다.**
   *
   * 목록의 `<Link>` 는 화면에 보이는 것만으로 이 페이지를 미리 렌더한다. 그대로 두면
   * 목록을 스크롤하기만 해도 문의가 "읽음"으로 바뀌고, 상단 "읽지 않은 메시지" 타일이
   * 아무도 열지 않은 문의까지 0으로 떨어뜨려 미답변 문의를 놓치게 된다.
   * (정산 화면은 같은 이유로 `<a>` 를 쓰고 주석까지 남겨 두었는데 여기만 빠져 있었다)
   */
  const h = await headers();
  const isPrefetch =
    h.get('next-router-prefetch') === '1' ||
    (h.get('purpose') ?? h.get('sec-purpose') ?? '').toLowerCase().includes('prefetch');
  if (!isPrefetch) await markInquiryRead(inquiry.id);

  const user = inquiry.userId
    ? await prisma.user.findUnique({
        where: { id: inquiry.userId },
        select: { id: true, name: true, email: true, role: true, phoneMasked: true },
      })
    : null;

  const label = STATUS_LABEL[inquiry.status];
  const categoryLabel = SUPPORT_CATEGORIES.find((c) => c.value === inquiry.category)?.label ?? inquiry.category;

  // 거래번호로 연결된 후원이 있으면 처리 근거를 바로 볼 수 있게 요약을 함께 보여준다.
  const donation = inquiry.donationId
    ? await prisma.donation.findUnique({
        where: { id: inquiry.donationId },
        select: {
          transactionNo: true, amount: true, status: true, receivedAt: true,
          creator: { select: { displayName: true, code: true } },
        },
      })
    : null;

  return (
    <>
      <PageHeader
        title={`문의 상세 · ${user ? (user.name ?? user.email ?? '회원') : (inquiry.guestName || '비회원')}`}
        description={`접수 ${formatKst(inquiry.createdAt)} · 최근 활동 ${formatKst(inquiry.lastMessageAt)}`}
        action={
          <Link href="/admin/inquiries" className="rounded-lg border border-ink-200 px-3 py-1.5 text-[12px] font-semibold text-ink-700">
            목록으로
          </Link>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SectionTitle title="대화 내용" />
          <Card>
            {inquiry.messages.length === 0 ? (
              <p className="text-[13px] text-ink-400">메시지가 없습니다.</p>
            ) : (
              <div className="space-y-2.5">
                {inquiry.messages.map((m) => (
                  <div key={m.id} className={cx('flex', m.sender === 'ADMIN' ? 'justify-end' : 'justify-start')}>
                    <div
                      className={cx(
                        'max-w-[78%] rounded-2xl px-3.5 py-2.5',
                        m.sender === 'ADMIN' ? 'bg-brand-100 text-ink-900' : 'bg-ink-50 text-ink-900',
                      )}
                    >
                      <p className="whitespace-pre-line break-words text-[13px] leading-relaxed">{m.body}</p>
                      <p className="mt-1 text-[10.5px] tabular-nums text-ink-400">
                        {m.sender === 'ADMIN' ? '관리자' : '문의자'} · {formatKst(m.createdAt)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 border-t border-ink-100 pt-4">
              <ActionForm action={replyInquiry} submitLabel="답변 등록" confirm="답변을 등록합니다. 사용자 문의 창에 바로 표시됩니다.">
                <input type="hidden" name="inquiryId" value={inquiry.id} />
                <AdminField label="답변 내용">
                  <AdminTextarea name="body" rows={4} placeholder="답변을 입력해 주세요 (2,000자 이내)" required />
                </AdminField>
              </ActionForm>
            </div>
          </Card>
        </div>

        <div>
          <SectionTitle title="문의자 정보" />
          <Card>
            <div>
              <DataRow label="상태" value={<Badge tone={label.tone}>{label.text}</Badge>} />
              <DataRow label="문의 유형" value={categoryLabel} />
              <DataRow label="접수 경로" value={inquiry.source === 'FORM' ? '고객센터 접수 폼' : '문의 창(채팅)'} />
              <DataRow label="접수번호" value={<span className="font-mono text-[12px]">{inquiry.id}</span>} />
              {user ? (
                <>
                  <DataRow label="이름" value={user.name ?? '-'} />
                  <DataRow label="이메일" value={user.email ?? '-'} />
                  <DataRow label="연락처" value={user.phoneMasked ?? '-'} />
                  <DataRow label="역할" value={user.role} />
                </>
              ) : (
                <>
                  <DataRow label="구분" value="비회원 (게스트)" />
                  <DataRow label="이름" value={inquiry.guestName ?? '-'} />
                  <DataRow label="회신 연락처" value={inquiry.contactMasked ?? '미입력'} />
                </>
              )}
            </div>
            {inquiry.transactionNo ? (
              <div className="mt-3 rounded-xl border border-ink-100 bg-ink-50 px-3.5 py-3">
                <p className="text-[12px] font-bold text-ink-700">연결된 거래</p>
                <DataRow label="입력 거래번호" value={<span className="font-mono text-[12px]">{inquiry.transactionNo}</span>} />
                {donation ? (
                  <>
                    <DataRow label="후원 금액" value={`${formatNumber(donation.amount)}원`} />
                    <DataRow label="거래 상태" value={donation.status} />
                    <DataRow label="크리에이터" value={`${donation.creator.displayName} (${donation.creator.code})`} />
                    <DataRow label="수신 시각" value={formatKst(donation.receivedAt)} />
                  </>
                ) : (
                  <p className="mt-1 text-[12px] leading-relaxed text-ink-400">
                    입력한 거래번호로 후원 내역을 찾지 못했습니다. 오타 여부를 확인해 주세요.
                  </p>
                )}
              </div>
            ) : null}

            <div className="mt-3 flex flex-col gap-1.5">
              {inquiry.status !== 'CLOSED' ? (
                <ActionButton
                  action={setInquiryStatus}
                  values={{ inquiryId: inquiry.id, status: 'CLOSED' }}
                  label="문의 종결"
                  variant="danger"
                  confirm="이 문의를 종결 처리합니다. 사용자가 새 메시지를 보내면 다시 접수됩니다."
                />
              ) : (
                <ActionButton
                  action={setInquiryStatus}
                  values={{ inquiryId: inquiry.id, status: 'OPEN' }}
                  label="다시 열기"
                  confirm="이 문의를 다시 답변 대기 상태로 되돌립니다."
                />
              )}
            </div>
            <div className="mt-3">
              <Notice tone="neutral">
                회신 연락처는 마스킹된 값만 표시됩니다. 답변은 이 화면에서 등록하면 사용자 문의 창에 실시간으로
                전달됩니다.
              </Notice>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
