/**
 * 크리에이터 신청·전환 (2026-11-17).
 *
 * 흐름
 *  - 처음부터 크리에이터로 가입(SIGNUP)하든, 일반회원이 전환 신청(CONVERT)하든
 *    **승인 전까지 계정은 일반회원(DONOR)** 이다. 그동안 마이페이지·후원·구독을 그대로 쓴다.
 *  - 최고관리자가 승인하면 같은 계정의 역할이 CREATOR 로 바뀐다(후원·구독·주문 내역 유지).
 *  - 보완요청은 심사 상태를 PENDING 으로 둔 채 사유(reviewNote)만 남긴다. 신청자가 고쳐서
 *    재제출하면 사유가 지워지고 다시 심사 대기로 돌아간다.
 */
import type { Prisma } from '@/generated/prisma/client';
import { newId } from '@/lib/id';
import {
  channelUrlKey,
  isChannelPlatform,
  MAX_CHANNELS,
  parseFollowerCount,
  validateChannelUrl,
  youtubeChannelIdFromUrl,
} from '@/lib/creator-channels';

export interface ChannelInput {
  platform: string;
  url: string;
  urlKey: string;
  title: string | null;
  followerCount: number | null;
  isPrimary: boolean;
  externalId: string | null;
}

/**
 * 폼의 채널 행들을 읽는다. 필드: channelPlatform[] / channelUrl[] / channelTitle[] / channelFollowers[] / primaryChannel(행 번호)
 * 빈 행은 건너뛴다. 오류가 있으면 사람이 읽을 문장을 던진다.
 */
export function parseChannelsFromForm(fd: FormData): ChannelInput[] {
  const platforms = fd.getAll('channelPlatform').map(String);
  const urls = fd.getAll('channelUrl').map(String);
  const titles = fd.getAll('channelTitle').map(String);
  const followers = fd.getAll('channelFollowers').map(String);
  const primaryRaw = Number.parseInt(String(fd.get('primaryChannel') ?? '0'), 10);

  const rows: ChannelInput[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < urls.length; i++) {
    const url = (urls[i] ?? '').trim();
    const platform = (platforms[i] ?? '').trim();
    if (!url && !platform) continue;
    if (!isChannelPlatform(platform)) throw new Error(`${i + 1}번째 채널의 플랫폼을 선택해 주세요.`);
    const err = validateChannelUrl(platform, url);
    if (err) throw new Error(`${i + 1}번째 채널: ${err}`);
    const key = channelUrlKey(url);
    if (seen.has(key)) throw new Error('같은 채널 주소를 두 번 입력했습니다.');
    seen.add(key);
    const fRaw = (followers[i] ?? '').trim();
    const followerCount = fRaw ? parseFollowerCount(fRaw) : null;
    if (fRaw && followerCount == null) throw new Error(`${i + 1}번째 채널의 구독자·팔로워 수를 숫자로 입력해 주세요. (예: 12000, 1.2만)`);
    rows.push({
      platform,
      url,
      urlKey: key,
      title: (titles[i] ?? '').trim().slice(0, 60) || null,
      followerCount,
      isPrimary: i === primaryRaw,
      externalId: platform === 'YOUTUBE' ? youtubeChannelIdFromUrl(url) : null,
    });
  }
  if (rows.length === 0) throw new Error('채널을 하나 이상 입력해 주세요.');
  if (rows.length > MAX_CHANNELS) throw new Error(`채널은 최대 ${MAX_CHANNELS}개까지 등록할 수 있습니다.`);
  if (!rows.some((r) => r.isPrimary)) rows[0].isPrimary = true;
  return rows;
}

/** 다른 크리에이터가 이미 등록한 채널인지 확인 (자기 채널은 제외) */
export async function findTakenChannel(
  tx: Prisma.TransactionClient,
  channels: ChannelInput[],
  ownCreatorId: string | null,
): Promise<string | null> {
  const taken = await tx.creatorChannel.findFirst({
    where: { urlKey: { in: channels.map((c) => c.urlKey) }, ...(ownCreatorId ? { creatorId: { not: ownCreatorId } } : {}) },
    select: { url: true },
  });
  return taken?.url ?? null;
}

/**
 * 채널 목록을 통째로 교체하고, 대표 채널을 기존 단일 채널 컬럼에도 반영한다(기존 화면 호환).
 *
 * [6차 P1-4] 채널 확인(verifiedAt)
 *  - 가입·재제출(심사 전): 모두 확인 대기로 둔다. 최고관리자가 승인할 때 한꺼번에 확인된다.
 *  - 승인된 크리에이터가 스튜디오에서 바꿀 때(keepVerified): 원래 있던 주소는 확인 상태를 유지하고,
 *    새로 넣은 주소는 확인 대기가 된다. 확인 대기 채널은 샵 영상 자동 수집·공개 링크에 쓰지 않는다.
 *    (남의 채널을 등록해 영상을 자기 샵에 올리는 것을 막는다)
 *  - 대표 채널 컬럼(channelUrl 등)은 확인된 채널 중에서만 고른다. 확인된 채널이 없으면 바꾸지 않는다.
 */
export async function replaceCreatorChannels(
  tx: Prisma.TransactionClient,
  creatorId: string,
  channels: ChannelInput[],
  opts: { keepVerified?: boolean } = {},
): Promise<{ cols: { channelPlatform: string; channelName: string | null; channelUrl: string } | Record<string, never>; pending: number }> {
  const before = opts.keepVerified
    ? await tx.creatorChannel.findMany({ where: { creatorId }, select: { urlKey: true, verifiedAt: true } })
    : [];
  const verifiedMap = new Map(before.filter((b) => b.verifiedAt).map((b) => [b.urlKey, b.verifiedAt as Date]));
  await tx.creatorChannel.deleteMany({ where: { creatorId } });
  for (const c of channels) {
    await tx.creatorChannel.create({
      data: {
        id: newId(),
        creatorId,
        platform: c.platform,
        url: c.url,
        urlKey: c.urlKey,
        title: c.title,
        followerCount: c.followerCount,
        isPrimary: c.isPrimary,
        externalId: c.externalId,
        verifiedAt: verifiedMap.get(c.urlKey) ?? null,
      },
    });
  }
  const pending = channels.filter((c) => !verifiedMap.has(c.urlKey)).length;
  if (!opts.keepVerified) {
    const primary = channels.find((c) => c.isPrimary) ?? channels[0];
    return { cols: { channelPlatform: primary.platform, channelName: primary.title, channelUrl: primary.url }, pending };
  }
  const ok = channels.filter((c) => verifiedMap.has(c.urlKey));
  const primary = ok.find((c) => c.isPrimary) ?? ok[0];
  return { cols: primary ? { channelPlatform: primary.platform, channelName: primary.title, channelUrl: primary.url } : {}, pending };
}

/** 최고관리자 확인: 이 크리에이터의 확인 대기 채널을 모두(또는 하나만) 확인 처리하고 대표 채널 컬럼을 맞춘다 */
export async function verifyCreatorChannels(tx: Prisma.TransactionClient, creatorId: string, channelId?: string): Promise<number> {
  const r = await tx.creatorChannel.updateMany({ where: { creatorId, verifiedAt: null, ...(channelId ? { id: channelId } : {}) }, data: { verifiedAt: new Date() } });
  const primary = await tx.creatorChannel.findFirst({ where: { creatorId, verifiedAt: { not: null } }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] });
  if (primary) await tx.creatorProfile.update({ where: { id: creatorId }, data: { channelPlatform: primary.platform, channelName: primary.title, channelUrl: primary.url } });
  return r.count;
}

/** 심사 화면·마이페이지에 보여 줄 상태 (보완요청은 PENDING + reviewNote) */
export function applicationStage(p: { status: string; reviewNote: string | null }):
  | 'REVIEW'
  | 'REVISION'
  | 'APPROVED'
  | 'REJECTED'
  | 'SUSPENDED' {
  if (p.status === 'PENDING') return p.reviewNote ? 'REVISION' : 'REVIEW';
  return p.status as 'APPROVED' | 'REJECTED' | 'SUSPENDED';
}
