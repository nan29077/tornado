import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from '@/components/brand/icons';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card } from '@/components/ui';
import { SessionChat } from '@/components/talk/session-chat';
import { requireCreator } from '@/server/auth';
import { SESSION_STATUS_LABEL, formatKstShort, getSessionForViewer, listSessionMessages, sessionPhase, sweepSessions } from '@/server/services/talk/sessions';

export const dynamic = 'force-dynamic';

/** 크리에이터 1:1 대화방 */
export default async function StudioSessionRoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const u = await requireCreator();
  await sweepSessions(new Date(), { creatorId: u.creatorId }).catch(() => undefined);
  const found = await getSessionForViewer(id, { userId: u.id, creatorId: u.creatorId });
  if (!found || found.role !== 'CREATOR') notFound();
  const s = found.session;
  const msgs = await listSessionMessages(s.id);
  const st = SESSION_STATUS_LABEL[s.status] ?? { text: s.status, tone: 'neutral' as const };
  return (
    <div className="mx-auto max-w-[720px]">
      <Link href="/studio/talk/sessions" className="mb-2 inline-flex items-center gap-0.5 text-[13px] font-bold text-ink-500 hover:text-brand-800">
        <ChevronLeft size={15} aria-hidden />
        1:1 채팅 목록
      </Link>
      <PageHeader title={`${s.user.name ?? '팬'} 님과 1:1 채팅`} description={`${formatKstShort(s.startsAt)} · ${s.minutes}분 · ${s.sessionNo}`} action={<Badge tone={st.tone}>{st.text}</Badge>} />
      {s.requestNote ? <Card className="mb-3"><p className="text-[12.5px] text-ink-600">팬 메모: {s.requestNote}</p></Card> : null}
      {s.status === 'ACCEPTED' || s.status === 'COMPLETED' ? (
        <SessionChat
          sessionId={s.id}
          role="CREATOR"
          otherName={s.user.name ?? '팬'}
          initial={msgs.map((m) => ({ id: m.id, senderType: m.senderType, body: m.body, createdAt: m.createdAt.toISOString() }))}
          phase={sessionPhase(s, new Date())}
          startsAt={s.startsAt.toISOString()}
          endsAt={s.endsAt.toISOString()}
        />
      ) : (
        <p className="rounded-2xl bg-white p-6 text-center text-[13px] text-ink-500 shadow-card">{s.status === 'REQUESTED' ? '수락하면 예약 시간에 대화방이 열려요.' : '진행하지 않는 예약입니다.'}</p>
      )}
    </div>
  );
}
