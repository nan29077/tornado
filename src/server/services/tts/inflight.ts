/**
 * 같은 키의 비동기 작업을 동시에 한 번만 실행한다 (OV-C).
 *
 * 왜 필요한가
 *   같은 후원 알림을 OBS 와 스튜디오 미리보기가 거의 동시에 받으면, 두 요청이 모두 합성 캐시를
 *   비켜 가(첫 합성이 끝나기 전이라 캐시가 비어 있다) 유료 TTS 제공사를 두 번 불렀다.
 *   진행 중인 작업을 키별로 기억해 두고, 뒤에 온 요청은 같은 결과를 기다리게 한다.
 *
 * 규칙
 *   - 작업이 끝나면(성공·실패 모두) 기록을 지운다. 실패 결과를 붙잡아 두지 않는다.
 *   - 결과 캐시는 호출부의 몫이다. 이 함수는 "동시에 겹친 요청"만 합친다.
 */
export function dedupeInFlight<T>(
  inflight: Map<string, Promise<T>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p: Promise<T> = Promise.resolve()
    .then(run)
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}
