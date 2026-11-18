import { Clock } from 'lucide-react';

/**
 * [6차 P1-1] 유료 결제를 닫아 둔 상태(SHOP_PAYMENT_PROVIDER=off)에서 결제 폼 대신 보여 주는 안내.
 * 결제 버튼을 눌렀다가 거절되는 대신, 처음부터 "준비 중"임을 알린다.
 */
export function PaymentPreparing({ title, note, className }: { title: string; note?: string; className?: string }) {
  return (
    <div className={`rounded-2xl border border-warm-200 bg-warm-50 px-4 py-5 text-center ${className ?? ''}`}>
      <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-white text-ink-500 shadow-card">
        <Clock size={18} strokeWidth={1.7} />
      </span>
      <p className="mt-2.5 text-[14px] font-extrabold text-ink-900">{title}</p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">{note ?? '카드·간편결제를 준비하고 있어요. 열리는 대로 바로 이용하실 수 있습니다.'}</p>
    </div>
  );
}
