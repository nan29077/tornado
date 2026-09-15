import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ConsoleShell, type NavGroup } from '@/components/layout/console-shell';
import { prisma } from '@/server/db';
import { requireAdmin, type SessionUser } from '@/server/auth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '통합 관리자 | 도네이도',
  robots: { index: false, follow: false },
};

/**
 * 통합 관리자 좌측 메뉴.
 *
 * 그룹 기준은 화면의 소재가 아니라 **"누가 언제 하는 일인가"** 다.
 * 예전 구성은 `회원·크리에이터` 안에 MO 번호가, `거래·결제` 안에 문자 발송이 섞여 있어서
 * 문자 사고 하나를 볼 때 두 그룹을 오가야 했고, 정산과 수수료가 서로 다른 그룹에 갈라져 있었다.
 *
 *   운영 현황       — 아침에 가장 먼저 여는 곳
 *   회원 관리       — 사람(회원·크리에이터·후원자)에 대한 일
 *   문자·번호       — 문자후원 경로(MO 수신 ~ MT 발송) 전체
 *   결제·거래       — 돈이 들어오는 쪽
 *   정산·세무       — 돈이 나가는 쪽과 신고
 *   방송·오버레이   — 크리에이터 방송 화면
 *   콘텐츠·고객지원 — 대외 노출물과 문의
 *   시스템·보안     — 권한과 기록
 *
 * 메뉴 라벨은 각 화면의 PageHeader 제목과 **같은 말**을 쓴다. 메뉴에서는 "회원",
 * 화면에서는 "회원 관리" 처럼 다르면 같은 화면인지 확신할 수 없다.
 */

/** 대기 건수 조회가 실패해도 메뉴는 떠야 한다. 배지는 부가 정보이지 화면의 조건이 아니다. */
async function loadPendingCounts() {
  try {
    const [creators, settlements, inquiries, unverifiedAccounts, riskOpen] = await Promise.all([
      prisma.creatorProfile.count({ where: { status: 'PENDING' } }),
      prisma.settlementRequest.count({ where: { status: { in: ['REQUESTED', 'REVIEWING'] } } }),
      prisma.supportInquiry.count({ where: { status: 'OPEN' } }),
      prisma.settlementAccount.count({ where: { verified: false } }),
      prisma.riskDetection.count({ where: { resolved: false } }),
    ]);
    return { creators, settlements, inquiries, unverifiedAccounts, riskOpen };
  } catch {
    return { creators: 0, settlements: 0, inquiries: 0, unverifiedAccounts: 0, riskOpen: 0 };
  }
}

function buildGroups(c: Awaited<ReturnType<typeof loadPendingCounts>>): NavGroup[] {
  return [
    {
      title: '운영 현황',
      items: [
        { href: '/admin', label: '대시보드', icon: 'dashboard' },
        { href: '/admin/system', label: '시스템 상태', icon: 'system' },
      ],
    },
    {
      title: '회원 관리',
      items: [
        { href: '/admin/users', label: '회원 관리', icon: 'users' },
        {
          href: '/admin/creators',
          label: '크리에이터 심사·관리',
          icon: 'creators',
          badge: c.creators,
          badgeTone: 'warning',
        },
        { href: '/admin/donors', label: '후원자 관리', icon: 'donors' },
        { href: '/admin/codes', label: '크리에이터 코드', icon: 'codes' },
      ],
    },
    {
      title: '문자·번호',
      items: [
        { href: '/admin/mo-numbers', label: 'MO 번호 관리', icon: 'numbers' },
        { href: '/admin/mo-messages', label: '수신 문자 (MO)', icon: 'messages' },
        { href: '/admin/mt-messages', label: '발송 문자 (MT)', icon: 'send' },
        { href: '/admin/mt-templates', label: '문자 템플릿', icon: 'templates' },
        { href: '/admin/simulator', label: 'MO 시뮬레이터', icon: 'simulator' },
      ],
    },
    {
      title: '결제·거래',
      items: [
        { href: '/admin/payments', label: '결제 내역', icon: 'payments' },
        { href: '/admin/refunds', label: '환불 처리', icon: 'refunds' },
        {
          href: '/admin/risk',
          label: '한도·이상거래',
          icon: 'risk',
          badge: c.riskOpen,
          badgeTone: 'danger',
        },
      ],
    },
    {
      title: '정산·세무',
      items: [
        {
          href: '/admin/settlements',
          label: '정산 관리',
          icon: 'settlement',
          // 정산 요청과 실명확인 대기는 둘 다 "지급이 막혀 있는" 상태라 한 숫자로 합친다.
          badge: c.settlements + c.unverifiedAccounts,
          badgeTone: 'brand',
        },
        { href: '/admin/tax', label: '세무 관리', icon: 'tax' },
        { href: '/admin/fees', label: '수수료 정책', icon: 'fees' },
        { href: '/admin/policies', label: '후원 한도 정책', icon: 'policies' },
        { href: '/admin/holidays', label: '공휴일 관리', icon: 'holidays' },
      ],
    },
    {
      title: '방송·오버레이',
      items: [
        { href: '/admin/tts', label: 'TTS·음성 연동', icon: 'tts' },
        { href: '/admin/youtube', label: '유튜브 연동', icon: 'youtube' },
        { href: '/admin/overlay', label: '오버레이 현황', icon: 'overlay' },
      ],
    },
    {
      title: '콘텐츠·고객지원',
      items: [
        { href: '/admin/banners', label: '배너 관리', icon: 'banners' },
        { href: '/admin/contents', label: '공지·FAQ', icon: 'contents' },
        { href: '/admin/moderation', label: '신고·금칙어', icon: 'moderation' },
        {
          href: '/admin/inquiries',
          label: '문의 관리',
          icon: 'inquiries',
          badge: c.inquiries,
          badgeTone: 'warning',
        },
        { href: '/admin/terms', label: '약관 버전', icon: 'terms' },
      ],
    },
    {
      title: '시스템·보안',
      items: [
        { href: '/admin/admins', label: '관리자 권한', icon: 'admins' },
        { href: '/admin/audit', label: '감사로그', icon: 'audit' },
      ],
    },
  ];
}

const permissionLabel: Record<string, string> = {
  SUPER_ADMIN: '최고 관리자',
  OPERATION: '운영',
  FINANCE: '재무',
  SUPPORT: '고객지원',
  READ_ONLY: '읽기 전용',
};

/**
 * 최고관리자에게만 보이는 메뉴.
 * 화면 자체의 권한 검사는 각 페이지가 하고, 여기서는 "보이지도 않게" 한 겹 더 둔다.
 * (세무 관리에는 사업자번호·지급명세서 자료가 들어간다)
 */
const SUPER_ADMIN_ONLY = new Set(['/admin/inquiries', '/admin/tax']);

/**
 * 최고관리자 + 운영 등급에게만 보이는 메뉴.
 * 감사로그의 변경 전/후 값에는 다른 화면에서 등급으로 가려 둔 값이 그대로 담긴다.
 * 시스템 상태에는 서비스 주소·MO 허용 IP 같은 운영 정보가 있다.
 */
const OPERATION_ONLY = new Set(['/admin/audit']);

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let admin: SessionUser | null = null;
  try {
    admin = await requireAdmin();
  } catch {
    admin = null;
  }
  if (!admin) redirect('/login?next=/admin');

  const counts = await loadPendingCounts();
  const isSuper = admin.adminPermission === 'SUPER_ADMIN';
  const isOperation = isSuper || admin.adminPermission === 'OPERATION';

  const visibleGroups = buildGroups(counts)
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          (!SUPER_ADMIN_ONLY.has(item.href) || isSuper) && (!OPERATION_ONLY.has(item.href) || isOperation),
      ),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <ConsoleShell
      title="도네이도 통합 관리자"
      groups={visibleGroups}
      user={{
        id: admin.id,
        name: admin.name ?? admin.email ?? '관리자',
        role: permissionLabel[admin.adminPermission ?? ''] ?? '권한 미지정',
        avatarIndex: admin.avatarIndex,
      }}
    >
      {children}
    </ConsoleShell>
  );
}
