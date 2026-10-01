'use client';

/**
 * 오버레이 세그먼트 에러 경계 (후원 알림·게임 화면 공통).
 *
 * 2026-10-01(OV-5): 방송용 화면에서는 **아무것도 보이지 않게(투명)** 두고 10초 뒤 스스로
 * 다시 불러온다. 예전에는 DB 가 잠깐 흔들려도 "오버레이를 불러오지 못했습니다" 상자가 방송 화면
 * 한가운데 계속 떠 있었고, OBS 안에서는 [다시 시도]를 누를 수도 없어 알림이 끊긴 채 남았다.
 *
 * 스튜디오 미리보기(preview=1)나 점검용(debug=1)에서만 안내 상자를 보여 준다.
 * 에러 경계에서는 훅을 쓰지 않는다(CLAUDE.md). 주소는 렌더 시점에 직접 읽는다.
 */
const RETRY_SEC = 10;

export default function OverlayError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const search = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const visible = Boolean(search && (search.get('preview') === '1' || search.get('debug') === '1'));

  return (
    <div className="grid h-screen w-screen place-items-center bg-transparent" suppressHydrationWarning>
      {/* 방송 화면이 스스로 복구되도록 일정 시간 뒤 새로 고친다(OBS 에서는 버튼을 누를 수 없다). */}
      <meta httpEquiv="refresh" content={String(RETRY_SEC)} />
      {visible ? (
        <div className="rounded-2xl bg-ink-900/90 px-6 py-5 text-center shadow-[0_8px_32px_rgba(0,0,0,0.5)]">
          <p className="text-[15px] font-bold text-white">오버레이를 불러오지 못했습니다</p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-white/70">
            {process.env.NODE_ENV !== 'production' && error?.message
              ? error.message
              : `서버 오류가 발생했습니다. ${RETRY_SEC}초 뒤 자동으로 다시 불러옵니다.`}
          </p>
          <p className="mt-1 text-[11.5px] text-white/50">방송 화면(OBS)에는 이 안내가 보이지 않습니다.</p>
          <button
            type="button"
            onClick={reset}
            className="mt-4 h-9 rounded-xl bg-white/15 px-4 text-[13px] font-semibold text-white hover:bg-white/25"
          >
            다시 시도
          </button>
        </div>
      ) : null}
    </div>
  );
}
