import { cookies } from 'next/headers';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { INQUIRY_GUEST_COOKIE } from '@/server/services/inquiry';
import { PublicShellClient, type ShellViewer } from './public-shell-client';
import { SupportWidget } from '@/components/public/support-widget';
import { isServiceInMockMode } from '@/server/service-mode';
import { env } from '@/lib/env';
import { getSiteImageSelection } from '@/server/services/site-images';

/**
 * 공개 영역 레이아웃 (서버 래퍼).
 * 세션 사용자를 조회해 클라이언트 셸에 전달한다.
 * - 마이페이지 탭은 역할에 따라 통합 관리자(/admin), 크리에이터 스튜디오(/studio),
 *   후원자 마이페이지(/my)로 이동한다. 비로그인 시 /my 접근은 로그인으로 유도된다.
 */
export async function PublicShell({
  children,
  aside,
}: {
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  /**
   * [B-1] 쿠키를 **가장 먼저** 읽는다.
   *
   * cookies() 는 이 화면이 요청마다 그려져야 한다(동적)는 신호다. 예전에는 아래 getSessionUser()
   * 안에서 처음 불렸는데, `.catch(() => null)` 이 그 신호(빌드 중 던지는 예외)까지 삼켰다.
   * 그러면 Next 가 /reset-password 같은 공개 화면을 **빌드 시점에 미리 그리려 하면서 DB 를 조회**해,
   * DB 가 없는 빌드 환경(CI·Docker 이미지 빌드)에서 `npm run build` 가 실패했다.
   */
  const jar = await cookies();
  const [user, margin] = await Promise.all([getSessionUser().catch(() => null), getSiteImageSelection('margin')]);

  // 크리에이터는 프로필 캐릭터(아바타)를 우측 메뉴 프로필에도 그대로 보여준다.
  const creatorAvatar =
    user?.role === 'CREATOR' && user.creatorId
      ? (
          await prisma.creatorProfile.findUnique({
            where: { id: user.creatorId },
            select: { avatarUrl: true, code: true },
          })
        )
      : null;

  const viewer: ShellViewer | null = user
    ? {
        id: user.id,
        name: user.name,
        email: user.email,
        myHref: user.role === 'ADMIN' ? '/admin' : user.role === 'CREATOR' ? '/studio' : '/my',
        roleLabel: user.role === 'ADMIN' ? '관리자' : user.role === 'CREATOR' ? '크리에이터' : '후원자',
        avatarUrl: creatorAvatar?.avatarUrl ?? null,
        avatarSeed: creatorAvatar?.code ?? user.id,
        avatarIndex: user.avatarIndex,
      }
    : null;

  // 문의 위젯의 FAQ 탭에 보여줄 상위 FAQ (고정글 우선)
  const faqs = await prisma.contentPost.findMany({
    where: { type: 'FAQ', published: true },
    orderBy: [{ pinned: 'desc' }, { sortOrder: 'asc' }],
    take: 6,
    select: { id: true, title: true, body: true },
  });

  // 문의 이력이 있을 때만 배경 폴링을 돌린다.
  // (모든 방문자가 15초/5분마다 /api/inquiry 를 두드리면 공개 페이지 전체가 불필요한 DB 부하를 진다)
  const hasThread = Boolean(user) || Boolean(jar.get(INQUIRY_GUEST_COOKIE)?.value);

  return (
    <>
      <PublicShellClient aside={aside} viewer={viewer} mockMode={isServiceInMockMode()} business={env.business} marginPreset={margin}>
        {children}
      </PublicShellClient>
      <SupportWidget faqs={faqs} loggedIn={Boolean(user)} hasThread={hasThread} />
    </>
  );
}
