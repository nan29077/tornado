import Image from 'next/image';

/**
 * 상품이 하나도 없을 때 보여 주는 원형 스티커 — 도네이도 캐릭터 + "상품 준비 중".
 * 살짝 흔들리는 애니메이션은 동작 줄이기 설정이면 멈춘다(globals.css 의 motion-reduce 규칙).
 */
export function ComingSoonSticker({ title = '상품 준비 중이에요', description = '크리에이터 샵에 곧 멋진 상품이 들어와요.' }: { title?: string; description?: string }) {
  return (
    <div className="flex flex-col items-center py-4 text-center">
      <div className="relative grid h-[136px] w-[136px] place-items-center rounded-full border-2 border-dashed border-brand-300 bg-[radial-gradient(circle_at_35%_30%,#fffaf0_0%,#fff0c2_60%,#ffe29a_100%)] shadow-[0_8px_24px_rgba(240,170,38,0.22)]">
        <span className="absolute inset-[6px] rounded-full border border-white/80" aria-hidden />
        <Image
          src="/stickers/donaido/gift-pop.webp"
          alt=""
          width={112}
          height={112}
          className="relative h-[104px] w-[104px] origin-bottom animate-[donaido-wiggle_2.6s_ease-in-out_infinite] object-contain motion-reduce:animate-none"
        />
        <span className="absolute -bottom-2 rounded-full bg-ink-900 px-3 py-1 text-[11.5px] font-extrabold text-white shadow">준비 중</span>
      </div>
      <p className="mt-5 text-[15px] font-extrabold text-ink-900">{title}</p>
      <p className="mt-1 text-[12.5px] text-ink-500">{description}</p>
    </div>
  );
}
