/**
 * 팬투표 화면 공통 — 보는 사람 기준 팬투표 버튼 정보 (2026-11-17)
 */
import { getVoteConfig } from '@/server/services/engagement/config';
import { getBalance } from './wallet';

export interface VoteViewer {
  loggedIn: boolean;
  balance: number;
  ticketsPerVote: number;
  quickVotes: number[];
  maxVotesPerAction: number;
  disabledReason: string | null;
}

export async function getVoteViewer(userId: string | null | undefined): Promise<VoteViewer & { enabled: boolean; rankingPublic: boolean; purchaseEnabled: boolean; offerwallEnabled: boolean }> {
  const cfg = await getVoteConfig();
  const balance = userId ? (await getBalance(userId).catch(() => null))?.total ?? 0 : 0;
  return {
    enabled: cfg.enabled,
    rankingPublic: cfg.rankingPublic,
    purchaseEnabled: cfg.purchaseEnabled,
    offerwallEnabled: cfg.offerwallEnabled,
    loggedIn: Boolean(userId),
    balance,
    ticketsPerVote: cfg.ticketsPerVote,
    quickVotes: cfg.quickVotes,
    maxVotesPerAction: cfg.maxVotesPerAction,
    disabledReason: cfg.enabled ? null : '지금은 팬투표를 받지 않습니다.',
  };
}

export function voteContextOf(v: VoteViewer) {
  return {
    loggedIn: v.loggedIn,
    balance: v.balance,
    ticketsPerVote: v.ticketsPerVote,
    quickVotes: v.quickVotes,
    maxVotesPerAction: v.maxVotesPerAction,
    disabledReason: v.disabledReason,
  };
}
