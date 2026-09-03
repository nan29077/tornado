import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Bell, BellOff, CheckCheck } from 'lucide-react';
import { CreatorDonateShell } from '@/components/public/creator-donate-shell';
import { Badge } from '@/components/ui';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { loadCreatorDonateProfile } from '@/server/services/creator-donate-profile';
import { markCreatorPageNotificationsRead } from '@/app/actions/creator-page-notifications';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';
export const metadata = { title: '알림 | 도네이도', robots: { index: false, follow: false } };

/**
 * 후원 페이지 알림함.
 *
 * 알림의 linkUrl 은 서비스 전역 경로(예: /my/payments)가 들어올 수 있다. 후원 페이지는
 * 밖으로 나가는 길을 두지 않으므로, **이 페이지 안쪽 경로일 때만 링크로 만든다.**
 * 나머지는 본문만 보여 준다 — 링크를 지우는 대신, 눌러서 튕겨 나가는 일을 막는 쪽을 택했다.
 */
export default async function CreatorNotificationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ filter?: string }>;
}) {
  const creator = await loadCreatorDonateProfile((await params).code);
  const base = `/c/${creator.code}`;
  const path = `${base}/notifications`;

  const user = await getSessionUser();
  if (!user) redirect(`${base}/login?next=${encodeURIComponent(path)}`);

  const onlyUnread = (await searchParams).filter === 'unread';

  const [items, unread, total] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: user.id, channel: 'IN_APP', ...(onlyUnread ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, title: true, body: true, linkUrl: true, readAt: true, createdAt: true },
    }),
    prisma.notification.count({ where: { userId: user.id, channel: 'IN_APP', readAt: null } }),
    prisma.notification.count({ where: { userId: user.id, channel: 'IN_APP' } }),
  ]);

  const inPage = (url: string | null) =>
    url && new RegExp(`^${base}(/[a-z-]+)?/?$`).test(url) ? url : null;

  return (
    <CreatorDonateShell creator={creator} activeMenu="notifications">
      <section className="py-7 sm:py-9">
        <p className="mb-3 flex items-center gap-2 text-sm font-bold text-brand-700">
          <Bell size={19} strokeWidth={1.8} />
          알림함
        </p>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink-900">알림</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-600">
          후원 결제, 크리에이터 답글, 계정 관련 소식이 여기에 쌓입니다. 이 화면은 나에게만 보입니다.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Link
            href={path}
            aria-current={onlyUnread ? undefined : 'page'}
            className={`inline-flex min-h-10 items-center rounded-full px-3.5 text-[13px] font-bold transition-colors ${onlyUnread ? 'border border-warm-300 bg-white text-ink-600 hover:bg-warm-100' : 'bg-brand-400 text-ink-900'}`}
          >
            전체 {total}
          </Link>
          <Link
            href={`${path}?filter=unread`}
            aria-current={onlyUnread ? 'page' : undefined}
            className={`inline-flex min-h-10 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-bold transition-colors ${onlyUnread ? 'bg-brand-400 text-ink-900' : 'border border-warm-300 bg-white text-ink-600 hover:bg-warm-100'}`}
          >
            안 읽음
            {unread > 0 ? (
              <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[#e5342f] px-1 text-[10px] font-black text-white tabular-nums">
                {unread > 99 ? '99+' : unread}
              </span>
            ) : null}
          </Link>

          {unread > 0 ? (
            <form action={markCreatorPageNotificationsRead}>
              <input type="hidden" name="backTo" value={path} />
              <button
                type="submit"
                className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-warm-300 bg-white px-3.5 text-[13px] font-bold text-ink-600 transition-colors hover:bg-warm-100"
              >
                <CheckCheck size={15} strokeWidth={1.8} />
                모두 읽음
              </button>
            </form>
          ) : null}
        </div>
      </section>

      {items.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-warm-300 bg-white/70 px-6 py-12 text-center">
          <span className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-warm-100 text-ink-400">
            <BellOff size={20} strokeWidth={1.7} />
          </span>
          <p className="mt-3 text-[14px] font-bold text-ink-700">
            {onlyUnread ? '안 읽은 알림이 없습니다' : '아직 받은 알림이 없습니다'}
          </p>
          <p className="mt-1 text-[12.5px] text-ink-400">
            후원이 완료되거나 크리에이터가 답글을 남기면 여기에 표시됩니다.
          </p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {items.map((n) => {
            const href = inPage(n.linkUrl);
            const unreadItem = !n.readAt;
            return (
              <li
                key={n.id}
                className={`rounded-[1.5rem] border p-4 shadow-card transition-colors ${unreadItem ? 'border-brand-200 bg-brand-50/60' : 'border-warm-300/70 bg-white'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[14px] font-extrabold text-ink-900">{n.title}</p>
                  {unreadItem ? <Badge tone="brand">새 알림</Badge> : null}
                </div>
                <p className="mt-1.5 text-[13px] leading-relaxed whitespace-pre-line text-ink-700">{n.body}</p>
                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11.5px] text-ink-400">{formatKst(n.createdAt, false)}</span>
                  <span className="flex items-center gap-2">
                    {href ? (
                      <Link href={href} className="text-[12.5px] font-bold text-brand-700 underline underline-offset-2">
                        바로 가기
                      </Link>
                    ) : null}
                    {unreadItem ? (
                      <form action={markCreatorPageNotificationsRead}>
                        <input type="hidden" name="id" value={n.id} />
                        <input type="hidden" name="backTo" value={path} />
                        <button type="submit" className="text-[12.5px] font-bold text-ink-400 hover:text-ink-900">
                          읽음
                        </button>
                      </form>
                    ) : null}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </CreatorDonateShell>
  );
}
