import type Redis from 'ioredis';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

/**
 * Redis 가 없는 환경에서 **로그를 조용히** 만든다.
 *
 * 왜 필요한가
 * -----------
 * 로컬 미리보기에는 Redis 가 없다. 그런데 `.env` 에 REDIS_URL 이 있으면 앱은 계속
 * 붙으려 하고, 붙지 못할 때마다 경고를 찍는다. 실제 로그가 이랬다.
 *
 * ```
 * warn  redis error            connect ECONNREFUSED 127.0.0.1:6379   ← 수십 줄
 * warn  overlay pub error      connect ECONNREFUSED 127.0.0.1:6379
 * warn  game sub error         connect ECONNREFUSED 127.0.0.1:6379
 * warn  게임 상태 Redis 전파 실패   Connection is closed.
 * warn  오버레이 이벤트 Redis 전파 실패. 다른 인스턴스의 오버레이는 이 알림을 받지 못한다.
 * ```
 *
 * **기능은 멀쩡하다.** 두 버스 모두 같은 프로세스 안에서 먼저 전달하고(emitter),
 * Redis 는 여러 대로 띄웠을 때만 쓰는 추가 경로다. 서버 한 대인 로컬에서는 없어도 된다.
 * 그런데 로그만 보면 **오버레이가 고장 난 것처럼 읽힌다.** 실제로 미리보기가 안 나오는
 * 문제를 쫓을 때 이 줄들이 계속 시선을 끌었다.
 *
 * 그래서 재접속을 포기한 시점에 **한 번만** 사람이 읽을 문장으로 알리고, 그 뒤로는
 * 조용히 인메모리 경로만 쓴다.
 */
export function quietRedisWhenUnavailable(
  client: Redis,
  label: string,
  onGiveUp: () => void,
): void {
  /**
   * **운영에서는 조용해지면 안 된다.**
   *
   * 조용히 포기하는 것은 "Redis 가 없어도 되는 환경" 에서만 옳다. 여러 대로 띄운 운영에서
   * Redis 가 끊기면 다른 인스턴스의 오버레이가 알림을 못 받으므로, 그 사실은 시끄럽게
   * 남아야 하고 클라이언트도 계속 살려 둬야 한다(붙으면 다시 쓴다).
   * 인메모리 폴백을 허용한 환경(로컬·테스트)에서만 조용해진다.
   */
  if (!env.allowInMemoryFallback) {
    client.on('error', (e: Error) => logger.warn(`redis error (${label})`, { message: e.message }));
    return;
  }

  let announced = false;

  const giveUp = () => {
    if (announced) return;
    announced = true;
    logger.info(
      `Redis 없이 동작합니다 (${label}). 서버가 한 대일 때는 문제가 없습니다 — ` +
        '실시간 전달은 이 프로세스 안에서 그대로 이뤄집니다. ' +
        '여러 대로 띄울 때만 Redis 가 필요합니다.',
    );
    onGiveUp();
    try {
      client.disconnect();
    } catch {
      /* 이미 끊긴 상태 */
    }
  };

  // 붙지 못한 채 재시도 한도를 다 쓰면 ioredis 가 'end' 를 낸다.
  client.on('end', giveUp);
  client.on('error', () => {
    // 개별 오류는 찍지 않는다. 같은 문장이 수십 줄 쌓이기만 한다.
    if (client.status === 'end') giveUp();
  });
}
