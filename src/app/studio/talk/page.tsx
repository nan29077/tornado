import Link from 'next/link';
import { Clock3, ExternalLink, Eye, Heart, Mail, MessageCircle, Mic, Search, Video } from '@/components/brand/icons';
import { BroadcastComposer } from '@/components/talk/broadcast-composer';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, Checkbox, EmptyState, Field, Input, Notice, StatTile, Textarea, cx } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { GuideCard } from '@/components/engage/guide-card';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import {
  deleteTalkMessageAction, markInboxReadAction, saveTalkRoomAction, sendBroadcastAction, sendDirectAction, setTalkBlockAction, toggleHeartAction,
} from '@/app/actions/studio-engage';
import { formatKst } from '@/lib/datetime';
import { requireCreator } from '@/server/auth';
import { prisma } from '@/server/db';
import { getCreatorEngagement, getTalkConfig } from '@/server/services/engagement/config';
import { dispatchDueTalkNotifications, getCreatorInbox, getCreatorTalkStats, getCreatorTimeline } from '@/server/services/talk/talk';

export const dynamic = 'force-dynamic';

/** 크리에이터 관리자 > 팬챗 > 팬챗 관리 (팬챗방 설정 · 메시지 보내기 · 대화 · 구독자) */
export default async function StudioTalkPage({ searchParams }: { searchParams: Promise<{ f?: string; fan?: string; re?: string; q?: string }> }) {
  const sp = await searchParams;
  const { creatorId } = await requireCreator();
  const talk = await getTalkConfig();
  const filter = sp.f === 'unread' || sp.f === 'hearted' ? sp.f : 'all';
  const q = (sp.q ?? '').trim().slice(0, 40);
  await dispatchDueTalkNotifications(new Date(), { creatorId }).catch(() => 0);
  const [creator, eng, inbox, stats, tl, blocks, unreadLetters] = await Promise.all([
    prisma.creatorProfile.findUniqueOrThrow({ where: { id: creatorId }, select: { code: true, displayName: true, avatarUrl: true, user: { select: { avatarIndex: true } } } }),
    getCreatorEngagement(creatorId, prisma, { talk }),
    getCreatorInbox(creatorId, { filter, fanUserId: sp.fan ?? null, replyToId: sp.re ?? null, q }),
    getCreatorTalkStats(creatorId),
    getCreatorTimeline(creatorId),
    prisma.talkBlock.findMany({ where: { creatorId }, include: { user: { select: { name: true } } }, orderBy: { createdAt: 'desc' } }),
    prisma.talkLetter.count({ where: { creatorId, deletedAt: null, readAt: null } }),
  ]);
  const timeline = tl.sent;
  const replyTarget = sp.re ? timeline.find((m) => m.id === sp.re) ?? null : null;
  const room = inbox.room;
  const group = talk.roomMode === 'GROUP';

  return (
    <div>
      <PageHeader
        title="팬챗 관리"
        description="구독자와 대화하는 팬챗방을 관리합니다."
        action={<Link href={`/c/${creator.code}?tab=talk`} target="_blank" className="inline-flex items-center gap-1 text-[13px] font-bold text-brand-800">내 팬챗 탭 보기 <ExternalLink size={13} aria-hidden /></Link>}
      />

      <GuideCard
        title="팬챗 기능 안내"
        items={[
          { head: '구독자만 들어와요 (월 구독)', body: `팬이 도네이도 샵 [팬챗] 탭에서 ${talk.subPeriodDays}일 이용권(${eng.talkSub.price.toLocaleString('ko-KR')}원)을 결제하면 팬챗방에 들어와요.` },
          { head: group ? '1:N 단체방' : '버블형 대화', body: group ? '내가 보낸 메시지와 구독자 메시지가 팬챗방의 모든 구독자에게 함께 보여요. 크리에이터와 팬 여러 명이 함께 대화해요.' : `내가 보낸 메시지는 구독자마다 1:1 대화처럼 보이고, 구독자 답장은 나에게만 보여요.${talk.replyPerMessage > 0 ? ` 팬은 내 메시지 하나에 ${talk.replyPerMessage}번까지 답장할 수 있어서, 메시지를 보낼수록 대화가 이어져요.` : ''}` },
          { head: '{닉네임} 을 넣어 보세요', body: '메시지에 {닉네임} 을 넣으면 받는 팬마다 그 팬의 이름으로 바뀌어 보여요. 예) {닉네임}님 오늘 방송 와 줘서 고마워요!' },
          { head: '정산', body: `구독료에서 플랫폼 수수료 ${(eng.talkSub.feeRate * 100).toFixed(1).replace(/\.0$/, '')}%를 뺀 금액이 정산 관리의 [팬챗 구독 정산]으로 바로 적립돼요.${talk.sessionEnabled ? ' 1:1 채팅은 대화가 끝나면 적립돼요.' : ''}` },
        ]}
        footer="연락처 · 계좌 · 외부 메신저 아이디 · 링크는 팬 메시지에서 자동으로 가려져요. 불편한 팬은 차단할 수 있고, 운영 정책 위반 메시지는 신고하면 운영팀이 처리해요."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="구독 중인 팬" value={`${stats.subscribers.toLocaleString('ko-KR')}명`} tone="brand" />
        <StatTile label="최근 30일 새 구독" value={`${stats.newSubs30d.toLocaleString('ko-KR')}건`} />
        <StatTile label="최근 30일 정산 적립" value={`${Number(stats.net30d).toLocaleString('ko-KR')}원`} />
        <StatTile label="안 읽은 팬 메시지" value={`${inbox.unread.toLocaleString('ko-KR')}개`} tone={inbox.unread > 0 ? 'warning' : 'neutral'} />
      </div>

      {!talk.enabled ? <div className="mt-4"><Notice tone="warning" title="팬챗 기능이 꺼져 있습니다">최고관리자가 팬챗 기능을 잠시 껐습니다. 설정은 저장할 수 있지만 팬에게는 보이지 않아요.</Notice></div> : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_1.15fr]">
        <div className="space-y-4">
          <Card>
            <CardTitle>메시지 보내기</CardTitle>
            <p className="mt-1 text-[12.5px] text-ink-500">구독 중인 팬 모두에게 1:1 대화처럼 보내져요. 사진 · 음성 · 영상을 붙이거나 예약할 수 있어요.</p>
            <BroadcastComposer subscribers={stats.subscribers} roomOpen={room.open} voiceMaxSeconds={talk.voiceMaxSeconds} />
          </Card>

          {tl.scheduled.length > 0 ? (
            <Card>
              <CardTitle>예약된 메시지 ({tl.scheduled.length})</CardTitle>
              <ul className="mt-2 space-y-2">
                {tl.scheduled.map((m) => (
                  <li key={m.id} className="flex items-start gap-2 rounded-xl bg-warning-50 px-3 py-2">
                    <Clock3 size={15} className="mt-0.5 shrink-0 text-accent-600" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11.5px] font-bold text-accent-600">{formatKst(m.createdAt, false).slice(0, 16)} 발송 예정</p>
                      <p className="line-clamp-2 whitespace-pre-wrap break-words text-[13px] text-ink-800">{m.body || (m.mediaType === 'VOICE' ? '음성 메시지' : m.mediaType === 'VIDEO' ? '영상' : m.imageUrl ? '사진' : '')}</p>
                    </div>
                    <ActionForm action={deleteTalkMessageAction} submitLabel="예약 취소" variant="ghost" size="sm" confirmMessage="이 예약 메시지를 취소할까요?" confirmVariant="danger">
                      <input type="hidden" name="messageId" value={m.id} />
                    </ActionForm>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {talk.letterEnabled ? (
            <Link href="/studio/talk/letters" className="flex items-center gap-3 rounded-2xl border border-ink-100 bg-white px-4 py-3 shadow-card">
              <Mail size={18} className="text-brand-700" aria-hidden />
              <span className="min-w-0 flex-1 text-[13.5px] font-extrabold text-ink-900">팬레터함</span>
              {unreadLetters > 0 ? <Badge tone="brand">안 읽은 편지 {unreadLetters}</Badge> : <span className="text-[12px] text-ink-400">새 편지 없음</span>}
            </Link>
          ) : null}

          <Card>
            <CardTitle>팬챗방 설정</CardTitle>
            <ActionForm action={saveTalkRoomAction} submitLabel="저장" className="mt-3">
              <Checkbox name="open" defaultChecked={room.open} label="팬챗방 열기" description="열면 내 샵 [팬챗] 탭에서 팬이 구독할 수 있어요." />
              <Field label="팬챗방 안내 문구">
                <Input name="welcomeMessage" defaultValue={room.welcomeMessage ?? ''} maxLength={300} placeholder="예) 매일 밤 10시에 들를게요!" />
              </Field>
              <Field label="팬 호칭" hint="예) 민트즈 · 소라단">
                <Input name="fanTitle" defaultValue={room.fanTitle ?? ''} maxLength={20} />
              </Field>
              {eng.talkSub.mode === 'CREATOR' ? (
                <Field label={`월 구독 가격 (${eng.talkSub.min.toLocaleString('ko-KR')}원 ~ ${eng.talkSub.max.toLocaleString('ko-KR')}원)`} hint="비워 두면 기본 가격으로 판매돼요">
                  <Input name="subPrice" inputMode="numeric" defaultValue={room.subPrice ? room.subPrice.toString() : ''} placeholder={String(eng.talkSub.fixedPrice)} />
                </Field>
              ) : (
                <p className="rounded-lg bg-ink-50 px-3 py-2 text-[12.5px] text-ink-600">월 구독 가격: <b>{eng.talkSub.price.toLocaleString('ko-KR')}원</b> (최고관리자 지정 · 가격 변경 권한이 필요하면 고객센터로 문의해 주세요)</p>
              )}
            </ActionForm>
          </Card>

          {blocks.length > 0 ? (
            <Card>
              <CardTitle>차단한 팬 ({blocks.length})</CardTitle>
              <ul className="mt-2 divide-y divide-ink-100">
                {blocks.map((b) => (
                  <li key={b.id} className="flex items-center justify-between gap-2 py-2 text-[13px]">
                    <span className="truncate">{b.user.name ?? '팬'}{b.reason ? <span className="text-ink-400"> · {b.reason}</span> : null}</span>
                    <ActionForm action={setTalkBlockAction} submitLabel="차단 풀기" variant="secondary" size="sm">
                      <input type="hidden" name="userId" value={b.userId} />
                      <input type="hidden" name="block" value="0" />
                    </ActionForm>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card id="talk-inbox">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>팬 답장 {sp.fan || sp.re || q ? <Link href="/studio/talk" className="ml-1 text-[12px] font-bold text-brand-800">전체 보기</Link> : null}</CardTitle>
              <div className="flex items-center gap-1">
                <div className="flex gap-1 rounded-lg bg-ink-100 p-0.5 text-[12px] font-bold">
                  {[{ k: 'all', l: '전체' }, { k: 'unread', l: '안 읽음' }, { k: 'hearted', l: '하트' }].map((x) => (
                    <Link key={x.k} href={`/studio/talk?f=${x.k}`} className={cx('rounded-md px-2 py-1', filter === x.k ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500')}>{x.l}</Link>
                  ))}
                </div>
                <ActionForm action={markInboxReadAction} submitLabel="모두 읽음" variant="ghost" size="sm" />
              </div>
            </div>
            <form action="/studio/talk" className="mt-3 flex h-10 items-center gap-1.5 rounded-xl border border-ink-200 bg-white px-3">
              {sp.re ? <input type="hidden" name="re" value={sp.re} /> : null}
              <Search size={15} className="text-ink-400" aria-hidden />
              <input name="q" defaultValue={q} placeholder="답장 내용 검색" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
            </form>
            {replyTarget ? (
              <p className="mt-2 rounded-xl bg-brand-50 px-3 py-2 text-[12.5px] text-ink-700">
                <b>이 메시지에 온 답장</b> · {replyTarget.body ? replyTarget.body.slice(0, 40) : '첨부 메시지'}
              </p>
            ) : null}
            {inbox.messages.length === 0 ? (
              <div className="mt-3"><EmptyState title="아직 팬 답장이 없어요" description="메시지를 보내면 구독 중인 팬들이 답장할 수 있어요." /></div>
            ) : (
              <ul className="mt-3 space-y-2.5">
                {inbox.messages.map((m) => (
                  <li key={m.id} className={cx('rounded-2xl border p-3', m.isNew ? 'border-brand-200 bg-brand-50/50' : 'border-ink-100 bg-white')}>
                    <div className="flex items-start gap-2.5">
                      <ProfileAvatar seed={m.fanUserId ?? m.id} avatarIndex={m.avatarIndex} name={m.fanName} className="h-9 w-9 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                          <Link href={`/studio/talk?fan=${m.fanUserId}`} className="font-extrabold text-ink-900 hover:text-brand-800">{m.fanName}</Link>
                          {m.days > 0 ? <span className="rounded-full bg-ink-900 px-1.5 text-[10px] font-black leading-[17px] tabular-nums text-brand-200">D+{m.days}</span> : null}
                          <span className="text-ink-400">{formatKst(m.createdAt, false).slice(5, 16)}</span>
                          {m.isNew ? <Badge tone="brand">새 메시지</Badge> : null}
                          {m.blocked ? <Badge tone="danger">차단됨</Badge> : null}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink-800">{m.body}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <ActionForm action={toggleHeartAction} submitLabel={m.hearted ? '하트 취소' : '하트'} variant={m.hearted ? 'accent' : 'secondary'} size="sm">
                            <input type="hidden" name="messageId" value={m.id} />
                          </ActionForm>
                          <ActionForm action={deleteTalkMessageAction} submitLabel="지우기" variant="ghost" size="sm" confirmMessage="이 메시지를 지울까요? 팬챗방에서 사라집니다." confirmVariant="danger">
                            <input type="hidden" name="messageId" value={m.id} />
                          </ActionForm>
                          {m.fanUserId && !m.blocked ? (
                            <ActionForm action={setTalkBlockAction} submitLabel="차단" variant="ghost" size="sm" confirmMessage={`${m.fanName} 님을 차단할까요? 이 팬챗방에 메시지를 보낼 수 없게 됩니다.`} confirmVariant="danger">
                              <input type="hidden" name="userId" value={m.fanUserId} />
                              <input type="hidden" name="block" value="1" />
                            </ActionForm>
                          ) : null}
                          {m.hearted ? <Heart size={14} className="fill-danger-500 text-danger-600" aria-hidden /> : null}
                        </div>
                        {m.fanUserId ? (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-[12px] font-bold text-ink-500">이 팬에게만 답장</summary>
                            <ActionForm action={sendDirectAction} submitLabel="답장 보내기" size="sm" className="mt-2">
                              <input type="hidden" name="fanUserId" value={m.fanUserId} />
                              <Textarea name="body" rows={2} maxLength={1000} required placeholder={`${m.fanName} 님에게만 보여요`} />
                            </ActionForm>
                          </details>
                        ) : null}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card id="talk-timeline">
            <CardTitle>보낸 메시지</CardTitle>
            {timeline.length === 0 ? (
              <p className="mt-2 text-[13px] text-ink-500">아직 보낸 메시지가 없어요.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {timeline.map((m) => (
                  <li key={m.id} className="flex items-start gap-2">
                    <ProfileAvatar seed={creator.code} avatarIndex={creator.user.avatarIndex} name={creator.displayName} imageUrl={creator.avatarUrl} className="h-8 w-8 shrink-0" />
                    <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-warm-100 px-3 py-2">
                      <p className="text-[11px] text-ink-400">{formatKst(m.createdAt, false).slice(5, 16)} {m.kind === 'DIRECT' ? <Badge>한 팬에게만</Badge> : null}</p>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {m.imageUrl ? <img src={m.imageUrl} alt="" className="my-1 max-h-40 rounded-lg" /> : null}
                      {m.mediaType === 'VOICE' && m.mediaUrl ? <p className="my-1 inline-flex items-center gap-1 rounded-lg bg-white px-2 py-1 text-[12px] font-bold text-ink-600"><Mic size={13} aria-hidden />음성 {m.mediaDuration ? `${Math.floor(m.mediaDuration / 60)}:${String(m.mediaDuration % 60).padStart(2, '0')}` : ''}</p> : null}
                      {m.mediaType === 'VIDEO' && m.mediaUrl ? <p className="my-1 inline-flex items-center gap-1 rounded-lg bg-white px-2 py-1 text-[12px] font-bold text-ink-600"><Video size={13} aria-hidden />영상</p> : null}
                      {m.body ? <p className="whitespace-pre-wrap break-words text-[13px] text-ink-800">{m.body}</p> : null}
                      <p className="mt-1.5 flex flex-wrap items-center gap-2.5 text-[11px] font-bold text-ink-500">
                        {m.readCount != null ? <span className="inline-flex items-center gap-0.5"><Eye size={12} aria-hidden />읽음 {m.readCount}/{tl.subscribers}</span> : null}
                        <Link href={`/studio/talk?re=${m.id}#talk-inbox`} className="inline-flex items-center gap-0.5 hover:text-brand-800"><MessageCircle size={12} aria-hidden />답장 {m.replyCount}</Link>
                        <span className="inline-flex items-center gap-0.5"><Heart size={12} aria-hidden />{m.heartCount}</span>
                      </p>
                    </div>
                    <ActionForm action={deleteTalkMessageAction} submitLabel="지우기" variant="ghost" size="sm" confirmMessage="이 메시지를 지울까요?" confirmVariant="danger">
                      <input type="hidden" name="messageId" value={m.id} />
                    </ActionForm>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
      {talk.sessionEnabled ? (
        <p className="mt-4 text-[13px] text-ink-500">
          1:1 예약 채팅은 <Link href="/studio/talk/sessions" className="font-bold text-brand-800">1:1 채팅</Link> 메뉴에서 가능 시간과 신청을 관리해요.
        </p>
      ) : null}
    </div>
  );
}
