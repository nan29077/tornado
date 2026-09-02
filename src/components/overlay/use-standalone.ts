'use client';

import * as React from 'react';

/**
 * 이 화면이 iframe 안이 아니라 단독 창인지.
 *
 * 스튜디오 미리보기(iframe) 안에서는 부모 화면이 연결 상태를 보여 주므로 오버레이가 배지를
 * 직접 그리지 않는다. 단독 창(새 탭에서 미리보기)에는 보여 줄 부모가 없어 직접 그려야 한다.
 *
 * 서버 렌더에서는 알 수 없으므로 false 로 시작하고, 하이드레이션 이후 실제 값이 된다.
 * (effect 안에서 setState 하면 렌더가 한 번 더 돌아 lint 규칙에도 걸린다 — Portal 과 같은 방식)
 */
const noSubscribe = () => () => {};

export function useStandalone(): boolean {
  return React.useSyncExternalStore(
    noSubscribe,
    () => typeof window === 'undefined' || window.parent === window,
    () => false,
  );
}
