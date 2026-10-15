import { getSessionUser } from '@/server/auth';
import { rejectCrossOrigin } from '@/server/request-guard';
import { prisma } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getSessionUser();
  if (!user) return Response.json({ message: '로그인이 필요합니다.' }, { status: 401 });

  const [items, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: user.id, channel: 'IN_APP' },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, title: true, body: true, linkUrl: true, readAt: true, createdAt: true },
    }),
    prisma.notification.count({ where: { userId: user.id, channel: 'IN_APP', readAt: null } }),
  ]);

  return Response.json({
    unreadCount,
    items: items.map((item) => ({
      ...item,
      readAt: item.readAt?.toISOString() ?? null,
      createdAt: item.createdAt.toISOString(),
    })),
  });
}

export async function PATCH(request: Request) {
  // [CSRF] 쿠키 인증 상태 변경 라우트 — 다른 출처 요청은 거절한다.
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

  const user = await getSessionUser();
  if (!user) return Response.json({ message: '로그인이 필요합니다.' }, { status: 401 });

  const payload = await request.json().catch(() => ({})) as { id?: unknown; all?: unknown };
  if (payload.all === true) {
    await prisma.notification.updateMany({
      where: { userId: user.id, channel: 'IN_APP', readAt: null },
      data: { readAt: new Date() },
    });
  } else if (typeof payload.id === 'string' && payload.id.length <= 80) {
    await prisma.notification.updateMany({
      where: { id: payload.id, userId: user.id, channel: 'IN_APP', readAt: null },
      data: { readAt: new Date() },
    });
  } else {
    return Response.json({ message: '알림 식별값이 올바르지 않습니다.' }, { status: 400 });
  }

  return Response.json({ ok: true });
}
