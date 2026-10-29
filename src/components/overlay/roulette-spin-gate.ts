/**
 * 룰렛 회전을 "결과 하나당 한 번만" 일으키는 문지기 (P2-19).
 *
 * 예전에는 useRef 에 마지막으로 돌린 키를 적어 두고 같은 키면 건너뛰었다. 그런데 개발 모드의
 * React StrictMode 는 effect 를 [실행 → 정리 → 다시 실행] 한다. 첫 실행이 키를 적은 뒤 정리에서
 * 회전 타이머가 지워지고, 다시 실행은 "이미 돌린 키" 라며 건너뛰어 **룰렛이 끝내 돌지 않았다.**
 *
 * 그래서 회전이 끝나기 전에 정리되면(abort) 키를 지워, 다음 실행이 다시 회전을 걸게 한다.
 * 회전이 끝난 뒤(settle)에는 키를 남겨 같은 결과로 다시 돌지 않게 한다.
 */
export interface SpinGate {
  /** 이 키로 회전을 시작해야 하면 true */
  begin: (key: string) => boolean;
  /** 회전이 끝났다(같은 키로는 다시 돌지 않는다) */
  settle: (key: string) => void;
  /** effect 정리. 아직 끝나지 않은 회전이면 키를 지워 다음 실행이 다시 돌게 한다 */
  abort: (key: string) => void;
  /** 결과가 사라졌을 때(다음 회차 등) */
  reset: () => void;
}

export function createSpinGate(): SpinGate {
  let spunKey = '';
  let settled = false;
  return {
    begin(key) {
      if (spunKey === key) return false;
      spunKey = key;
      settled = false;
      return true;
    },
    settle(key) {
      if (spunKey === key) settled = true;
    },
    abort(key) {
      if (spunKey === key && !settled) spunKey = '';
    },
    reset() {
      spunKey = '';
      settled = false;
    },
  };
}
