import bcrypt from 'bcryptjs';
import { prisma } from '@/server/db';

/**
 * [P2-14] 예전 시드가 만들던 최고관리자 계정과 비밀번호.
 *
 * 저장소가 공개되어 있어 이 조합은 비밀이 아니다. 시드는 이제 무작위 비밀번호를 쓰지만,
 * 예전에 시드를 돌린 스테이징·운영 DB 에는 이 계정이 그대로 남아 있을 수 있다.
 */
export const LEGACY_SEED_ADMIN_EMAIL = 'admin@tornado.kr';
const LEGACY_SEED_PASSWORD = 'tornado1234!';

/**
 * 공개된 기본 비밀번호로 로그인되는 시드 관리자 계정이 있으면 문제 문구를, 없으면 null 을 돌려준다.
 * 행 하나만 조회하고 bcrypt 비교도 한 번뿐이라 기동 지연은 수십 ms 수준이다.
 */
export async function findLegacySeedAdminProblem(): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { email: LEGACY_SEED_ADMIN_EMAIL },
    select: { status: true, passwordHash: true, deletedAt: true },
  });
  if (!user?.passwordHash || user.deletedAt || user.status !== 'ACTIVE') return null;
  if (!(await bcrypt.compare(LEGACY_SEED_PASSWORD, user.passwordHash))) return null;
  return (
    `시드 관리자 계정(${LEGACY_SEED_ADMIN_EMAIL})이 공개 저장소에 적힌 기본 비밀번호로 로그인됩니다. ` +
    '즉시 비밀번호를 바꾸거나 계정을 정지하십시오.'
  );
}

/**
 * 부팅 시 1회 (src/instrumentation.ts). local 은 검사하지 않는다(로컬 시드 계정은 의도된 것).
 *  - prod    : 기동을 중단한다.
 *  - staging : 크게 경고만 남긴다(검수 환경을 통째로 멈추지는 않는다).
 * DB 에 닿지 못하면 기동은 막지 않고 경고만 남긴다(점검 실패가 서비스 장애가 되지 않게).
 */
export async function assertNoLegacySeedAdmin(appEnv: string): Promise<void> {
  if (appEnv === 'local') return;
  let problem: string | null;
  try {
    problem = await findLegacySeedAdminProblem();
  } catch (e) {
    console.warn(`[boot] 시드 관리자 계정 점검을 하지 못했습니다: ${(e as Error)?.message ?? e}`);
    return;
  }
  if (!problem) return;
  if (appEnv === 'prod') throw new Error(`[boot] 운영 기동 중단 — ${problem}`);
  console.error(`[boot] 경고 ${'='.repeat(40)}\n[boot] ${problem}\n[boot] ${'='.repeat(46)}`);
}
