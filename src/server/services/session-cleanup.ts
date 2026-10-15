import { prisma } from '@/server/db';

/**
 * [SESSION-CLEANUP] 만료·폐기된 로그인 세션 정리 (정리 배치에서 호출한다).
 *
 * user_session 은 로그인할 때마다 한 줄씩 늘고, 로그아웃·비밀번호 변경·관리자 회수로
 * 폐기(revokedAt)되거나 만료돼도 지워지지 않았다. 행에는 접속 IP·User-Agent 가 남아 있어
 * 필요 이상 오래 보관되는 개인정보이기도 하다.
 * 최근 기록은 보안 사고 조사용으로 남기고, 만료·폐기 후 일정 기간이 지난 행만 지운다.
 */
export const SESSION_RETENTION_DAYS = 30;

export async function purgeStaleSessions(now = new Date(), retentionDays = SESSION_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const r = await prisma.userSession.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
    },
  });
  return r.count;
}
