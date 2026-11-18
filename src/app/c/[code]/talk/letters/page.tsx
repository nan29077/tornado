import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronLeft, Heart } from '@/components/brand/icons';
import { CreatorDonateShell } from '@/components/public/creator-donate-shell';
import { DeleteLetterButton, LetterComposer } from '@/components/talk/letter-forms';
import { LETTER_THEME_STYLE } from '@/lib/letter-themes';
import { cx } from '@/components/ui';
import { formatKst } from '@/lib/datetime';
import { getSessionUser } from '@/server/auth';
import { loadCreatorDonateProfile } from '@/server/services/creator-donate-profile';
import { getTalkConfig } from '@/server/services/engagement/config';
import { getComposerState, listMyLetters } from '@/server/services/talk/talk';

export const dynamic = 'force-dynamic';
export const metadata = { title: '팬레터 | 도네이도', robots: { index: false, follow: false } };

/** 팬레터 — 구독자가 크리에이터에게 긴 편지를 보낸다. 크리에이터만 읽고, 답장은 보낸 팬에게만 보인다 */
export default async function TalkLettersPage({ params }: { params: Promise<{ code: string }> }) {
  const creator = await loadCreatorDonateProfile((await params).code);
  const base = `/c/${creator.code}/talk`;
  const user = await getSessionUser();
  if (!user) redirect(`/c/${creator.code}/login?next=${encodeURIComponent(`${base}/letters`)}`);
  const talk = await getTalkConfig();
  if (!talk.enabled) redirect(`/c/${creator.code}`);
  const composer = await getComposerState(user.id, creator.id);
  if (!composer) redirect(`/c/${creator.code}?tab=talk`);
  const letters = await listMyLetters(user.id, creator.id);
  return (
    <CreatorDonateShell creator={creator} activeMenu="donate">
      <div className="py-5">
        <Link href={base} className="mb-3 inline-flex items-center gap-0.5 text-[13px] font-bold text-ink-500 hover:text-brand-800">
          <ChevronLeft size={15} aria-hidden />
          팬챗방으로
        </Link>
        <h1 className="mb-1 text-[20px] font-black tracking-[-0.03em] text-ink-900">{creator.displayName} 님에게 팬레터</h1>
        <p className="mb-4 text-[12.5px] text-ink-500">팬레터는 크리에이터만 읽어요. 7일에 {talk.letterPerWeek}통까지 보낼 수 있어요.</p>
        {talk.letterEnabled ? (
          <LetterComposer creatorId={creator.id} code={creator.code} creatorName={creator.displayName} maxLength={talk.letterMaxLength} left={composer.lettersLeft} />
        ) : (
          <p className="rounded-2xl bg-white p-6 text-center text-[13px] font-bold text-ink-500 shadow-card">지금은 팬레터를 받지 않아요.</p>
        )}

        <h2 className="mb-2 mt-7 text-[16px] font-black text-ink-900">보낸 편지 {letters.length > 0 ? letters.length : ''}</h2>
        {letters.length === 0 ? (
          <p className="rounded-2xl bg-white p-6 text-center text-[13px] text-ink-400 shadow-card">아직 보낸 편지가 없어요.</p>
        ) : (
          <ul className="space-y-3">
            {letters.map((l) => {
              const st = LETTER_THEME_STYLE[l.theme] ?? LETTER_THEME_STYLE.CREAM;
              return (
                <li key={l.id} className={cx('rounded-[22px] p-4 ring-1', st.paper)}>
                  <div className={cx('mb-1 flex items-center justify-between gap-2 text-[11.5px] font-bold opacity-70', st.ink)}>
                    <span>
                      {formatKst(l.createdAt, false).slice(0, 16)} · {l.readAt ? '읽음' : '아직 안 읽음'}
                    </span>
                    <div className="flex items-center gap-2">
                      {l.hearted ? <Heart size={14} className="fill-danger-500 text-danger-600" aria-label="크리에이터가 하트를 눌렀어요" /> : null}
                      <DeleteLetterButton letterId={l.id} code={creator.code} />
                    </div>
                  </div>
                  {l.title ? <p className={cx('mb-1 text-[14px] font-black', st.ink)}>{l.title}</p> : null}
                  <p className={cx('line-clamp-6 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed', st.ink)}>{l.body}</p>
                  {l.replyBody ? (
                    <div className="mt-3 rounded-2xl bg-white/90 p-3 text-ink-900">
                      <p className="mb-0.5 text-[11.5px] font-black text-brand-800">{creator.displayName} 님의 답장</p>
                      <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed">{l.replyBody}</p>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </CreatorDonateShell>
  );
}
