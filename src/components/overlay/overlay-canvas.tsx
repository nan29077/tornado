'use client';

import * as React from 'react';

/**
 * 오버레이 고정 캔버스.
 *
 * 왜 필요한가
 *  - 오버레이는 OBS 브라우저 소스 1920x1080 을 기준으로 크기가 잡혀 있다(배너 420px 등).
 *  - 스튜디오 미리보기 틀은 훨씬 작아서(휴대폰에서 322x180) 같은 px 값이 화면을 뚫고 나간다.
 *    실측: 배너가 좌우로 각각 49px 잘리고, 캐릭터 스티커는 위쪽 71px 이 잘렸다.
 *  - 그래서 미리보기에서는 항상 1920x1080 으로 그린 다음, 틀 크기에 맞춰 통째로 축소한다.
 *    이러면 미리보기가 실제 방송 화면과 픽셀 단위로 같아지고 잘림이 구조적으로 불가능해진다.
 *
 * 방송용(토큰) 경로는 이 컴포넌트를 쓰지 않는다. OBS 가 정한 크기를 그대로 채운다.
 *
 * 안쪽 좌표계
 *  - 이 컴포넌트의 자식은 `transform` 이 걸린 요소 안에 들어간다.
 *    CSS 규칙상 transform 이 걸린 조상은 `position: fixed` 의 기준이 되므로,
 *    오버레이 본체의 `fixed inset-0` 은 화면이 아니라 이 1920x1080 상자를 채운다.
 *  - 뷰포트 단위(vh)는 축소와 무관하게 실제 화면 기준으로 계산되므로 쓰면 안 된다.
 *    대신 `--ovh`(오버레이 기준 높이)를 내려보내고 애니메이션은 이 값을 쓴다.
 *  - `--ovs` 는 적용된 축소 배율이다. 축소되면 안 되는 요소(디버그 배지)가 역보정에 쓴다.
 */

export const OVERLAY_CANVAS_WIDTH = 1920;
export const OVERLAY_CANVAS_HEIGHT = 1080;

/**
 * 세로 배치 방식.
 *  - center : 틀 한가운데 (기본. PC 16:9 틀에서는 여백이 거의 없다)
 *  - top    : 틀 위쪽에 붙임. 세로형(휴대폰) 틀에서 쓴다.
 *             유튜브 모바일은 영상이 화면 위쪽에 붙고 아래에 제목·채팅이 온다.
 *             가운데에 놓으면 위아래가 똑같이 비어 실제와 다르게 보이고,
 *             화면 왼쪽 위에 그린 요소가 휴대폰 화면 한가운데에 있는 것처럼 보인다.
 */
export type OverlayCanvasAlign = 'center' | 'top';

export function OverlayCanvas({
  children,
  align = 'center',
}: {
  children: React.ReactNode;
  align?: OverlayCanvasAlign;
}) {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const [box, setBox] = React.useState<{ w: number; h: number } | null>(null);

  React.useEffect(() => {
    const el = boxRef.current;
    if (!el) return;

    /**
     * 크기를 못 재면 화면을 통째로 감춘다(scale 0). 그래서 **한 번이라도 0 을 물면
     * 그대로 굳어 버리는 경로가 있으면 안 된다.**
     *
     * 실제로 0 이 나오는 상황
     *  - 미리보기 틀이 아직 접혀 있거나 display:none 인 채로 iframe 이 먼저 뜬 경우
     *  - 부모 창이 레이아웃을 잡기 전에 iframe 문서가 먼저 그려진 경우
     * 이때 ResizeObserver 가 뒤늦게 불러 주면 살아나지만, 브라우저·타이밍에 따라
     * 관찰 대상이 0x0 이라 변화로 잡히지 않는 경우가 있다. 그러면 미리보기가
     * **영영 빈 화면**이 된다. 화면에는 아무 오류도 뜨지 않아 원인을 짐작하기 어렵다.
     *
     * 그래서 아직 한 번도 재지 못했을 때만 짧게 다시 시도한다.
     * 한 번 재고 나면 이 재시도는 완전히 멈춘다(상시 폴링이 아니다).
     */
    let measured = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let tries = 0;
    /**
     * 처음에는 촘촘히, 나중에는 느슨하게 다시 잰다. **성공하면 완전히 멈춘다.**
     *
     * 예전에는 3초만 시도하고 포기했다. 그런데 미리보기 틀은 접혀 있거나 다른 탭에 있어
     * 3초보다 훨씬 뒤에 펼쳐지는 경우가 있다(브라우저가 배경 탭의 크기 변화를 늦게 알리는
     * 경우도 있다). 그때 포기해 버리면 **미리보기가 영영 빈 화면**으로 남고,
     * 화면에는 아무 오류도 뜨지 않아 원인을 짐작할 수 없다.
     * 재시도 비용은 getBoundingClientRect 한 번이라 느슨한 간격이면 사실상 공짜다.
     */
    const delayFor = (n: number) => (n < 10 ? 120 : n < 20 ? 500 : 2000);
    /**
     * 이만큼 연달아 실패하면(약 1초) 부모에게 "아직 못 쟀다"를 알린다.
     *
     * 처음 뜨자마자 false 를 보내면 정상적으로 뜨는 틀도 매번 잠깐 "재지 못했습니다" 가
     * 깜빡이고, 숨겨진 틀(다른 탭)의 false 가 보이는 틀의 true 를 덮어쓴다.
     * 잠깐의 0 은 정상이므로, 한동안 계속 0 일 때만 알린다. 재면 즉시 true 를 보낸다.
     */
    const NOTIFY_FAIL_AT = 8;

    const notifyParent = (ready: boolean, w: number, h: number) => {
      if (typeof window === 'undefined' || window.parent === window) return;
      try {
        window.parent.postMessage({ type: 'donaido-overlay-canvas', ready, w, h }, window.location.origin);
      } catch {
        /* ignore */
      }
    };

    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) {
        /**
         * 한 번 잰 뒤에 다시 0 이 되는 경우도 있다 — 탭을 옮겨 틀이 접히거나, 브라우저 창이
         * 그리기를 멈춘 상태(숨겨진 창·패널)에서 iframe 이 통째로 0x0 이 되는 경우다.
         * 그때는 ResizeObserver 가 다시 커지는 순간을 알려 주는 것이 원칙이지만, 그리기가 멈춘
         * 창에서는 그 알림이 늦거나 오지 않는 일이 있었다. 그래서 0 을 보면 언제든 재시도로
         * 되돌아간다. 성공하면 다시 멈추므로 상시 폴링은 아니다.
         */
        if (measured) {
          measured = false;
          tries = 0;
        }
        tries += 1;
        if (tries === NOTIFY_FAIL_AT) notifyParent(false, 0, 0);
        if (retry) clearTimeout(retry);
        retry = setTimeout(measure, delayFor(tries));
        return;
      }
      measured = true;
      tries = 0;
      if (retry) {
        clearTimeout(retry);
        retry = null;
      }
      notifyParent(true, r.width, r.height);
      setBox((prev) =>
        prev && Math.abs(prev.w - r.width) < 0.5 && Math.abs(prev.h - r.height) < 0.5
          ? prev
          : { w: r.width, h: r.height },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    // 배경 탭에서 앞으로 나올 때도 다시 잰다. 그동안 크기 변화가 보고되지 않았을 수 있다.
    document.addEventListener('visibilitychange', measure);
    // 뒤로가기 캐시에서 복원되거나 창이 다시 활성화될 때도 마찬가지다.
    window.addEventListener('pageshow', measure);
    window.addEventListener('focus', measure);
    return () => {
      if (retry) clearTimeout(retry);
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      document.removeEventListener('visibilitychange', measure);
      window.removeEventListener('pageshow', measure);
      window.removeEventListener('focus', measure);
    };
  }, []);

  /*
    부모(스튜디오 미리보기)에게 **틀 크기를 쟀는지**를 알리는 postMessage 는 위 measure 안에서
    보낸다. 크기를 못 재면 캔버스를 통째로 감추므로(scale 0) 화면이 완전히 비는데, 그 상태는
    "연결은 됐는데 아무것도 안 나온다" 와 화면상 구분이 되지 않아 원인을 짚는 데 매번 오래
    걸렸다. 어느 단계에서 멈췄는지 툴바가 바로 말해 줄 수 있어야 한다.
    (예전에는 box 상태가 바뀔 때마다 보냈는데, 그러면 마운트 직후 항상 false 가 한 번 나가서
     정상인 틀도 잠깐 "재지 못했습니다" 로 보였다)
  */

  const scale = box ? Math.min(box.w / OVERLAY_CANVAS_WIDTH, box.h / OVERLAY_CANVAS_HEIGHT) : 0;
  // 축소한 캔버스를 틀 한가운데에 놓는다. 좌표 계산을 직접 하므로 브라우저별 차이가 없다.
  const offsetX = box ? (box.w - OVERLAY_CANVAS_WIDTH * scale) / 2 : 0;
  const offsetY = box ? (align === 'top' ? 0 : (box.h - OVERLAY_CANVAS_HEIGHT * scale) / 2) : 0;

  return (
    <div ref={boxRef} className="fixed inset-0 overflow-hidden bg-transparent">
      <div
        className="absolute left-0 top-0"
        style={{
          width: OVERLAY_CANVAS_WIDTH,
          height: OVERLAY_CANVAS_HEIGHT,
          transformOrigin: 'top left',
          transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`,
          // 배율을 재기 전(첫 페인트)에는 1920x1080 원본이 잠깐 보이지 않도록 감춘다.
          visibility: scale > 0 ? 'visible' : 'hidden',
          ['--ovh' as string]: `${OVERLAY_CANVAS_HEIGHT}px`,
          ['--ovs' as string]: String(scale || 1),
        }}
      >
        {children}
      </div>
    </div>
  );
}
