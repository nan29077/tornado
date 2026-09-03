/**
 * 통합 관리자 공통 로딩 화면.
 *
 * 관리자 화면은 전부 `force-dynamic` 이고 한 화면에서 열 개 안팎의 쿼리를 돌린다.
 * 로딩 표시가 없으면 그 시간 동안 이전 화면이 그대로 멈춰 있어 "눌러도 반응이 없다"로 보인다.
 * 실제 레이아웃과 비슷한 자리에 회색 블록을 놓아 화면이 튀지 않게 한다.
 */
export default function AdminLoading() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-live="polite">
      <span className="sr-only">불러오는 중입니다</span>

      <div className="mb-5">
        <div className="h-6 w-40 rounded-lg bg-ink-100" />
        <div className="mt-2 h-4 w-72 rounded-lg bg-ink-50" />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[76px] rounded-2xl border border-ink-100 bg-white" />
        ))}
      </div>

      <div className="rounded-2xl border border-ink-100 bg-white p-4">
        <div className="h-4 w-32 rounded bg-ink-100" />
        <div className="mt-4 space-y-2.5">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-9 rounded-lg bg-ink-50" />
          ))}
        </div>
      </div>
    </div>
  );
}
