import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, Checkbox, EmptyState, Field, Input, Notice, Select, Textarea } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { GuideCard } from '@/components/engage/guide-card';
import { decideSessionAction, saveSlotRulesAction, saveTalkRoomAction } from '@/app/actions/studio-engage';
import { requireCreator } from '@/server/auth';
import { prisma } from '@/server/db';
import { getCreatorEngagement, getTalkConfig } from '@/server/services/engagement/config';
import { getOrCreateRoom } from '@/server/services/talk/talk';
import { SESSION_STATUS_LABEL, formatKstShort, formatRule, onlyPaidSessions, sweepSessions } from '@/server/services/talk/sessions';

export const dynamic = 'force-dynamic';

/** 크리에이터 관리자 > 팬 소통 > 1:1 채팅 (최고관리자가 1:1 을 켰을 때만 메뉴에 보인다) */
export default async function StudioSessionsPage() {
  const { creatorId } = await requireCreator();
  const talk = await getTalkConfig();
  if (!talk.enabled || !talk.sessionEnabled) {
    return (
      <div>
        <PageHeader title="1:1 채팅" />
        <Notice tone="neutral" title="1:1 채팅이 꺼져 있습니다">최고관리자가 1:1 채팅을 열면 이 메뉴에서 가능 시간과 신청을 관리할 수 있어요.</Notice>
      </div>
    );
  }
  await sweepSessions(new Date(), { creatorId }).catch(() => undefined);
  const now = new Date();
  const [room, eng, rules, requestsAll, upcoming, past] = await Promise.all([
    getOrCreateRoom(creatorId),
    getCreatorEngagement(creatorId, prisma, { talk }),
    prisma.talkSlotRule.findMany({ where: { creatorId, active: true }, orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }] }),
    prisma.talkSession.findMany({ where: { creatorId, status: 'REQUESTED' }, orderBy: { startsAt: 'asc' }, include: { user: { select: { name: true } } } }),
    prisma.talkSession.findMany({ where: { creatorId, status: 'ACCEPTED' }, orderBy: { startsAt: 'asc' }, include: { user: { select: { name: true } } } }),
    prisma.talkSession.findMany({ where: { creatorId, status: { notIn: ['REQUESTED', 'ACCEPTED'] } }, orderBy: { startsAt: 'desc' }, take: 30, include: { user: { select: { name: true } } } }),
  ]);
  // 결제가 끝난 신청만 보여 준다 (결제 진행 중·실패 건은 수락할 수 없다)
  const requests = await onlyPaidSessions(requestsAll);

  return (
    <div>
      <PageHeader title="1:1 채팅" description="팬이 일정표에서 시간을 골라 신청하면, 수락한 예약 시간에 1:1 로 대화해요." />
      <GuideCard
        title="1:1 채팅 안내"
        items={[
          { head: '가능 시간을 열어 두세요', body: '요일별 시간대를 등록하면 팬에게 앞으로 며칠간의 일정표가 열려요. 쉬는 날은 따로 막을 수 있어요.' },
          { head: '신청 → 수락', body: `팬이 결제하고 신청하면 "승인 대기"가 돼요. ${talk.sessionApprovalHours}시간 안에(시작 1시간 전까지) 수락하지 않으면 자동 취소 · 전액 환불돼요.` },
          { head: '예약 시간에 대화', body: `시작 시각에 대화방이 열리고 끝나는 시각에 자동으로 닫혀요. 시작 후 ${talk.sessionNoShowMinutes}분 안에 메시지를 보내지 않으면 팬이 불참 신고로 전액 환불받을 수 있어요.` },
          { head: '정산', body: `대화가 끝나면 ${eng.session.price.toLocaleString('ko-KR')}원에서 수수료 ${(eng.session.feeRate * 100).toFixed(1).replace(/\.0$/, '')}%를 뺀 금액이 정산 관리의 [1:1 채팅 정산]으로 적립돼요. 수락 후 내가 취소하면 전액 환불돼요.` },
        ]}
        footer="연락처 · 계좌 · 외부 메신저 아이디 · 링크는 양쪽 모두 자동으로 가려져요. 대화 기록은 신고 · 분쟁 시에만 운영팀이 확인해요."
      />
      {!eng.session.allowed ? <div className="mb-4"><Notice tone="warning" title="이 채널은 1:1 채팅이 제한되어 있습니다">최고관리자가 이 채널의 1:1 채팅을 막았습니다. 자세한 사항은 고객센터로 문의해 주세요.</Notice></div> : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardTitle>1:1 채팅 받기</CardTitle>
          <ActionForm action={saveTalkRoomAction} submitLabel="저장" className="mt-3">
            <input type="hidden" name="open" value={room.open ? 'on' : ''} />
            <input type="hidden" name="welcomeMessage" value={room.welcomeMessage ?? ''} />
            <input type="hidden" name="fanTitle" value={room.fanTitle ?? ''} />
            {room.subPrice ? <input type="hidden" name="subPrice" value={room.subPrice.toString()} /> : null}
            <Checkbox name="sessionEnabled" defaultChecked={room.sessionEnabled} label="1:1 채팅 신청 받기" description="끄면 내 샵에서 1:1 채팅 신청 버튼이 사라져요. 이미 잡힌 예약은 그대로예요." />
            <Field label="1회 시간">
              <Select name="sessionMinutes" defaultValue={String(room.sessionMinutes)}>
                {talk.sessionMinutesOptions.map((m) => <option key={m} value={m}>{m}분</option>)}
              </Select>
            </Field>
            {eng.session.mode === 'CREATOR' ? (
              <Field label={`1회 가격 (${eng.session.min.toLocaleString('ko-KR')}원 ~ ${eng.session.max.toLocaleString('ko-KR')}원)`} hint="비워 두면 기본 가격">
                <Input name="sessionPrice" inputMode="numeric" defaultValue={room.sessionPrice ? room.sessionPrice.toString() : ''} placeholder={String(eng.session.fixedPrice)} />
              </Field>
            ) : (
              <p className="rounded-lg bg-ink-50 px-3 py-2 text-[12.5px] text-ink-600">1회 가격: <b>{eng.session.price.toLocaleString('ko-KR')}원</b> (최고관리자 지정)</p>
            )}
            <Field label="쉬는 날" hint="2026-12-25 형식, 여러 날은 쉼표나 줄바꿈으로">
              <Textarea name="blockedDates" rows={2} defaultValue={(room.sessionBlockedDates ?? []).join(', ')} />
            </Field>
          </ActionForm>
        </Card>

        <Card>
          <CardTitle>가능 시간 (요일 반복)</CardTitle>
          <p className="mt-1 text-[12.5px] text-ink-500">한 줄에 하나씩 입력하세요. 예) 월 20:00-23:00</p>
          <ActionForm action={saveSlotRulesAction} submitLabel="가능 시간 저장" className="mt-3">
            <Textarea name="rules" rows={7} defaultValue={rules.map(formatRule).join('\n')} placeholder={'월 20:00-23:00\n수 20:00-22:00\n토 14:00-18:00'} />
          </ActionForm>
        </Card>
      </div>

      <h2 className="mb-2 mt-6 text-[15px] font-black text-ink-900">승인 대기 ({requests.length})</h2>
      {requests.length === 0 ? <EmptyState title="새 신청이 없어요" /> : (
        <div className="grid gap-3 lg:grid-cols-2">
          {requests.map((s) => (
            <Card key={s.id}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[15px] font-black text-ink-900">{formatKstShort(s.startsAt)} · {s.minutes}분</p>
                  <p className="text-[12.5px] text-ink-500">{s.user.name ?? '팬'} · {Number(s.price).toLocaleString('ko-KR')}원 · 승인 기한 {formatKstShort(s.approvalDeadline)}</p>
                </div>
                <Badge tone="warning">승인 대기</Badge>
              </div>
              {s.requestNote ? <p className="mt-2 rounded-lg bg-warm-100 px-3 py-2 text-[12.5px] text-ink-700">{s.requestNote}</p> : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <ActionForm action={decideSessionAction} submitLabel="수락" size="sm">
                  <input type="hidden" name="sessionId" value={s.id} />
                  <input type="hidden" name="decision" value="accept" />
                </ActionForm>
                <ActionForm action={decideSessionAction} submitLabel="거절 (전액 환불)" variant="secondary" size="sm" confirmMessage="거절하면 팬에게 전액 환불됩니다." confirmVariant="danger">
                  <input type="hidden" name="sessionId" value={s.id} />
                  <input type="hidden" name="decision" value="reject" />
                  <Input name="reason" placeholder="거절 사유 (팬에게 전달)" maxLength={100} />
                </ActionForm>
              </div>
            </Card>
          ))}
        </div>
      )}

      <h2 className="mb-2 mt-6 text-[15px] font-black text-ink-900">확정된 예약 ({upcoming.length})</h2>
      {upcoming.length === 0 ? <EmptyState title="확정된 예약이 없어요" /> : (
        <Card padded={false} className="divide-y divide-ink-100">
          {upcoming.map((s) => {
            const live = s.startsAt <= now && s.endsAt > now;
            return (
              <div key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-extrabold text-ink-900">{formatKstShort(s.startsAt)} · {s.minutes}분</p>
                  <p className="text-[12px] text-ink-500">{s.user.name ?? '팬'} · {Number(s.price).toLocaleString('ko-KR')}원</p>
                </div>
                <Link href={`/studio/talk/sessions/${s.id}`} className={live ? 'rounded-xl bg-danger-500 px-3 py-2 text-[12.5px] font-black text-white' : 'rounded-xl border border-ink-200 px-3 py-2 text-[12.5px] font-bold text-ink-700'}>
                  {live ? '지금 입장' : '대화방'}
                </Link>
                {s.startsAt > now ? (
                  <ActionForm action={decideSessionAction} submitLabel="예약 취소" variant="ghost" size="sm" confirmMessage="수락한 예약을 취소하면 팬에게 전액 환불됩니다." confirmVariant="danger">
                    <input type="hidden" name="sessionId" value={s.id} />
                    <input type="hidden" name="decision" value="reject" />
                    <input type="hidden" name="reason" value="크리에이터 사정" />
                  </ActionForm>
                ) : null}
              </div>
            );
          })}
        </Card>
      )}

      <h2 className="mb-2 mt-6 text-[15px] font-black text-ink-900">지난 기록</h2>
      {past.length === 0 ? <EmptyState title="아직 기록이 없어요" /> : (
        <Card padded={false} className="divide-y divide-ink-100">
          {past.map((s) => {
            const st = SESSION_STATUS_LABEL[s.status] ?? { text: s.status, tone: 'neutral' as const };
            return (
              <Link key={s.id} href={`/studio/talk/sessions/${s.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-warm-50">
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-bold text-ink-800">{formatKstShort(s.startsAt)} · {s.user.name ?? '팬'}</span>
                  <span className="block text-[12px] text-ink-400">{Number(s.price).toLocaleString('ko-KR')}원{s.status === 'COMPLETED' ? ` · 정산 ${Number(s.netAmount).toLocaleString('ko-KR')}원` : ''}</span>
                </span>
                <Badge tone={st.tone}>{st.text}</Badge>
              </Link>
            );
          })}
        </Card>
      )}
    </div>
  );
}
