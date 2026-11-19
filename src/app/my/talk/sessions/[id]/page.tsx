import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ChevronLeft } from '@/components/brand/icons';
import { Badge, Card } from '@/components/ui';
import { MiniAction } from '@/components/engage/mini-action';
import { SessionChat } from '@/components/talk/session-chat';
import { cancelSessionAction, reportNoShowAction } from '@/app/actions/talk';
import { getSessionUser } from '@/server/auth';
import { getTalkConfig } from '@/server/services/engagement/config';
import {
  SESSION_STATUS_LABEL, fanCancelRefund, formatKstShort, getSessionForViewer, listSessionMessages, sessionPhase, sweepSessions,
} from '@/server/services/talk/sessions';

export const dynamic = 'force-dynamic';

/** 마이페이지 > 1:1 채팅 예약 상세 · 대화방 */
export default async function MySessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // 비로그인은 로그인 화면으로 (예전에는 requireUser 가 예외를 던져 서버 로그에 오류가 남았다, 7차 P2-7)
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/my/talk/sessions/${id}`)}`);
  const talk = await getTalkConfig();
  await sweepSessions(new Date(), { userId: user.id }).catch(() => undefined);
  const found = await getSessionForViewer(id, { userId: user.id });
  if (!found || found.role !== 'FAN') notFound();
  const s = found.session;
  const now = new Date();
  const phase = sessionPhase(s, now);
  const msgs = await listSessionMessages(s.id);
  const st = SESSION_STATUS_LABEL[s.status] ?? { text: s.status, tone: 'neutral' as const };
  const cancel = fanCancelRefund(s, talk, now);
  const noShowAt = new Date(s.startsAt.getTime() + talk.sessionNoShowMinutes * 60_000);
  const creatorSpoke = msgs.some((m) => m.senderType === 'CREATOR');

  return (
    <div className="space-y-3">
      <Link href="/my/talk" className="inline-flex items-center gap-0.5 text-[13px] font-bold text-ink-500 hover:text-brand-800">
        <ChevronLeft size={15} aria-hidden />
        내 팬챗으로
      </Link>
      <Card>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[16px] font-black text-ink-900">{s.creator.displayName} 1:1 채팅</p>
            <p className="mt-0.5 text-[12.5px] text-ink-500">{formatKstShort(s.startsAt)} · {s.minutes}분 · {Number(s.price).toLocaleString('ko-KR')}원 · {s.sessionNo}</p>
          </div>
          <Badge tone={st.tone}>{st.text}</Badge>
        </div>
        {s.requestNote ? <p className="mt-2 rounded-xl bg-warm-100 px-3 py-2 text-[12.5px] text-ink-600">내 메모: {s.requestNote}</p> : null}
        {s.status === 'REQUESTED' ? <p className="mt-2 text-[12.5px] text-ink-500">크리에이터가 {formatKstShort(s.approvalDeadline)} 까지 수락하지 않으면 자동 취소 · 전액 환불돼요.</p> : null}
        {s.refundAmount > 0n ? <p className="mt-2 text-[12.5px] font-bold text-success-600">{Number(s.refundAmount).toLocaleString('ko-KR')}원 환불{s.cancelReason ? ` · ${s.cancelReason}` : ''}</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          {cancel.allowed ? (
            <MiniAction
              action={cancelSessionAction}
              fields={{ sessionId: s.id }}
              label={cancel.refund === s.price ? '예약 취소 (전액 환불)' : `예약 취소 (${Number(cancel.refund).toLocaleString('ko-KR')}원 환불)`}
              variant="light"
              confirm="예약을 취소할까요?"
            />
          ) : null}
          {s.status === 'ACCEPTED' && phase === 'LIVE' && now >= noShowAt && !creatorSpoke ? (
            <MiniAction action={reportNoShowAction} fields={{ sessionId: s.id }} label="크리에이터가 들어오지 않았어요 (전액 환불)" variant="danger" confirm="크리에이터 불참으로 처리하고 전액 환불받을까요?" />
          ) : null}
        </div>
      </Card>
      {s.status === 'ACCEPTED' || s.status === 'COMPLETED' ? (
        <SessionChat
          sessionId={s.id}
          role="FAN"
          otherName={s.creator.displayName}
          initial={msgs.map((m) => ({ id: m.id, senderType: m.senderType, body: m.body, createdAt: m.createdAt.toISOString() }))}
          phase={phase}
          startsAt={s.startsAt.toISOString()}
          endsAt={s.endsAt.toISOString()}
        />
      ) : null}
    </div>
  );
}
