import { MessageCircleHeart } from 'lucide-react';
import { formatKst } from '@/lib/datetime';

export function DonationReply({ body, updatedAt, name }: { body: string; updatedAt: Date; name: string }) {
  return <div className="mt-4 rounded-2xl border border-brand-200 bg-brand-50 p-4">
    <p className="flex items-center gap-2 text-[13px] font-bold text-brand-800"><MessageCircleHeart size={17} strokeWidth={1.7} />{name}님의 답글</p>
    <p className="mt-2 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink-800">{body}</p>
    <p className="mt-2 text-xs text-ink-500">{formatKst(updatedAt)} · 나에게만 보이는 답글</p>
  </div>;
}
