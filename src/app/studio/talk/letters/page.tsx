import Link from 'next/link';
import { Heart, Mail } from '@/components/brand/icons';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, EmptyState, Notice, Textarea, cx } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { letterOpAction, markAllLettersReadAction } from '@/app/actions/studio-engage';
import { formatKst } from '@/lib/datetime';
import { requireCreator } from '@/server/auth';
import { getTalkConfig } from '@/server/services/engagement/config';
import { listCreatorLetters } from '@/server/services/talk/talk';

export const dynamic = 'force-dynamic';

/** 크리에이터 관리자 > 팬챗 > 팬레터 (2026-11-18) */
export default async function StudioLettersPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const sp = await searchParams;
  const { creatorId } = await requireCreator();
  const talk = await getTalkConfig();
  const filter = sp.f === 'unread' || sp.f === 'hearted' ? sp.f : 'all';
  const { letters, unread } = await listCreatorLetters(creatorId, { filter });

  return (
    <div>
      <PageHeader title="팬레터" description="구독자가 보낸 편지를 읽고 하트나 답장을 보낼 수 있어요. 답장은 보낸 팬에게만 보여요." />
      {!talk.letterEnabled ? (
        <div className="mb-4">
          <Notice tone="warning" title="팬레터 받기가 꺼져 있습니다">최고관리자가 팬레터를 잠시 껐습니다. 받은 편지는 그대로 볼 수 있어요.</Notice>
        </div>
      ) : null}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 rounded-lg bg-ink-100 p-0.5 text-[12px] font-bold">
          {[
            { k: 'all', l: '전체' },
            { k: 'unread', l: `안 읽음 ${unread > 0 ? unread : ''}` },
            { k: 'hearted', l: '하트' },
          ].map((x) => (
            <Link key={x.k} href={`/studio/talk/letters?f=${x.k}`} className={cx('rounded-md px-2.5 py-1', filter === x.k ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500')}>
              {x.l}
            </Link>
          ))}
        </div>
        {unread > 0 ? <ActionForm action={markAllLettersReadAction} submitLabel="모두 읽음" variant="ghost" size="sm" /> : null}
      </div>
      {letters.length === 0 ? (
        <EmptyState title="아직 받은 편지가 없어요" description="팬챗을 구독한 팬이 편지를 보내면 여기에 모여요." />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {letters.map((l) => (
            <Card key={l.id} className={cx(!l.readAt && 'ring-2 ring-brand-200')}>
              <div className="flex items-start gap-2.5">
                <ProfileAvatar seed={l.userId} avatarIndex={l.avatarIndex} name={l.fanName} className="h-9 w-9 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                    <span className="font-extrabold text-ink-900">{l.fanName}</span>
                    <span className="text-ink-400">{formatKst(l.createdAt, false).slice(0, 16)}</span>
                    {!l.readAt ? <Badge tone="brand">새 편지</Badge> : null}
                    {l.hearted ? <Heart size={13} className="fill-danger-500 text-danger-600" aria-hidden /> : null}
                  </p>
                  {l.title ? <p className="mt-1 text-[14px] font-black text-ink-900">{l.title}</p> : null}
                  <p className="mt-1 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink-800">{l.body}</p>
                  {l.replyBody ? (
                    <div className="mt-2 rounded-xl bg-brand-50 px-3 py-2 text-[12.5px] text-ink-700">
                      <p className="mb-0.5 flex items-center gap-1 font-black text-brand-800">
                        <Mail size={12} aria-hidden />
                        내 답장 · {l.repliedAt ? formatKst(l.repliedAt, false).slice(5, 16) : ''}
                      </p>
                      <p className="whitespace-pre-wrap break-words">{l.replyBody}</p>
                    </div>
                  ) : null}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {!l.readAt ? (
                      <ActionForm action={letterOpAction} submitLabel="읽음" variant="secondary" size="sm">
                        <input type="hidden" name="letterId" value={l.id} />
                        <input type="hidden" name="op" value="read" />
                      </ActionForm>
                    ) : null}
                    <ActionForm action={letterOpAction} submitLabel={l.hearted ? '하트 취소' : '하트'} variant={l.hearted ? 'accent' : 'secondary'} size="sm">
                      <input type="hidden" name="letterId" value={l.id} />
                      <input type="hidden" name="op" value="heart" />
                    </ActionForm>
                    <ActionForm action={letterOpAction} submitLabel="지우기" variant="ghost" size="sm" confirmMessage="이 편지를 지울까요?" confirmVariant="danger">
                      <input type="hidden" name="letterId" value={l.id} />
                      <input type="hidden" name="op" value="delete" />
                    </ActionForm>
                  </div>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[12px] font-bold text-ink-500">{l.replyBody ? '답장 고치기' : '답장 쓰기'}</summary>
                    <ActionForm action={letterOpAction} submitLabel="답장 보내기" size="sm" className="mt-2">
                      <input type="hidden" name="letterId" value={l.id} />
                      <input type="hidden" name="op" value="reply" />
                      <Textarea name="body" rows={3} maxLength={1000} required defaultValue={l.replyBody ?? ''} placeholder={`${l.fanName} 님에게만 보여요`} />
                    </ActionForm>
                  </details>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
