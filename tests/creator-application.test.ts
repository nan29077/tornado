import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { newId } from '@/lib/id';
import { channelUrlKey, parseFollowerCount, validateChannelUrl } from '@/lib/creator-channels';
import { applicationStage, parseChannelsFromForm } from '@/server/services/creator-application';

/**
 * 크리에이터 신청·전환·보완요청 (2026-11-17)
 * - 채널 여러 개 검증(플랫폼별 주소·중복·구독자 수)
 * - 승인 전까지 일반회원(DONOR), 승인하면 같은 계정이 CREATOR 로 전환
 * - 보완요청은 PENDING 유지 + 사유, 재제출하면 사유가 지워지고 다시 대기
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/rate-limit')>();
  return { ...actual, consumeIpRateLimit: vi.fn(async () => ({ ok: true })), clientIpFromHeaders: vi.fn(async () => '127.0.0.1') };
});
const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
vi.mock('@/server/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/auth')>();
  return {
    ...actual,
    requireAdmin: vi.fn(async () => ({ id: 'admin-ca', email: null, name: '운영', role: 'ADMIN', avatarIndex: 0, adminPermission: 'SUPER_ADMIN' })),
    writeAudit: vi.fn(async () => undefined),
    getSessionUser: vi.fn(async () => session.user),
  };
});

const { requestCreatorRevision, updateCreatorStatus } = await import('@/app/actions/admin/accounts');
const { resubmitCreatorApplication } = await import('@/app/actions/creator-apply');

function channelForm(rows: Array<[string, string, string?, string?]>, primary = 0) {
  const fd = new FormData();
  for (const [p, u, t, f] of rows) {
    fd.append('channelPlatform', p);
    fd.append('channelUrl', u);
    fd.append('channelTitle', t ?? '');
    fd.append('channelFollowers', f ?? '');
  }
  fd.set('primaryChannel', String(primary));
  return fd;
}

describe('채널 입력 검증', () => {
  it('여러 채널을 읽고 구독자 수·대표 채널·유튜브 채널 ID 를 해석한다', () => {
    const rows = parseChannelsFromForm(
      channelForm(
        [
          ['YOUTUBE', 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa', '먹방TV', '1.2만'],
          ['TIKTOK', 'https://www.tiktok.com/@mukbang', '', '35,000'],
          ['', '', '', ''],
        ],
        1,
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ platform: 'YOUTUBE', followerCount: 12000, isPrimary: false, externalId: 'UCaaaaaaaaaaaaaaaaaaaaaa', title: '먹방TV' });
    expect(rows[1]).toMatchObject({ platform: 'TIKTOK', followerCount: 35000, isPrimary: true });
  });

  it('플랫폼과 맞지 않는 주소·중복·빈 목록·잘못된 숫자를 거절한다', () => {
    expect(() => parseChannelsFromForm(channelForm([['YOUTUBE', 'https://www.tiktok.com/@x']]))).toThrow(/YouTube 주소가 아닙니다/);
    expect(() =>
      parseChannelsFromForm(channelForm([['TIKTOK', 'https://www.tiktok.com/@x'], ['TIKTOK', 'https://tiktok.com/@X/']])),
    ).toThrow(/두 번/);
    expect(() => parseChannelsFromForm(channelForm([]))).toThrow(/하나 이상/);
    expect(() => parseChannelsFromForm(channelForm([['INSTAGRAM', 'https://instagram.com/a', '', '많음']]))).toThrow(/숫자/);
    expect(validateChannelUrl('OTHER', 'ftp://x.com/a')).toMatch(/https/);
    expect(validateChannelUrl('YOUTUBE', 'https://youtube.com')).toMatch(/경로/);
  });

  it('주소 정규화와 숫자 해석', () => {
    expect(channelUrlKey('https://WWW.TikTok.com/@Abc/?lang=ko')).toBe('tiktok.com/@abc');
    expect(channelUrlKey('http://m.youtube.com/@abc')).toBe('youtube.com/@abc');
    expect(parseFollowerCount('3k')).toBe(3000);
    expect(parseFollowerCount('1억')).toBe(100_000_000);
    expect(parseFollowerCount('abc')).toBeNull();
  });

  it('심사 단계 표시', () => {
    expect(applicationStage({ status: 'PENDING', reviewNote: null })).toBe('REVIEW');
    expect(applicationStage({ status: 'PENDING', reviewNote: '보완' })).toBe('REVISION');
    expect(applicationStage({ status: 'APPROVED', reviewNote: null })).toBe('APPROVED');
  });
});

describe('전환 신청 → 보완요청 → 재제출 → 승인', () => {
  let fx: Fixture;
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
    session.user = null;
  });

  async function pendingMember() {
    const tag = newId().slice(-6).toLowerCase();
    const user = await prisma.user.create({ data: { id: newId(), email: `m-${newId()}@test.kr`, name: '회원', role: 'DONOR' } });
    const creator = await prisma.creatorProfile.create({
      data: { id: newId(), userId: user.id, code: `TOR-${newId().slice(-4)}`, displayName: '전환신청', status: 'PENDING', appliedVia: 'CONVERT' },
    });
    await prisma.creatorChannel.create({
      data: { id: newId(), creatorId: creator.id, platform: 'TIKTOK', url: `https://www.tiktok.com/@old${tag}`, urlKey: `tiktok.com/@old${tag}`, isPrimary: true },
    });
    return { user, creator };
  }

  it('보완요청은 PENDING 을 유지하고 사유를 남기며, 재제출하면 사유가 지워진다', async () => {
    const { user, creator } = await pendingMember();
    const fd = new FormData();
    fd.set('creatorId', creator.id);
    fd.set('note', '틱톡 주소가 열리지 않습니다');
    const r = await requestCreatorRevision({ ok: false }, fd);
    expect(r.ok).toBe(true);
    let p = await prisma.creatorProfile.findUniqueOrThrow({ where: { id: creator.id } });
    expect(p.status).toBe('PENDING');
    expect(p.reviewNote).toBe('틱톡 주소가 열리지 않습니다');
    const n = await prisma.notification.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
    expect(n?.linkUrl).toBe('/my/creator');

    session.user = { id: user.id, role: 'DONOR', email: user.email, name: user.name, avatarIndex: 0 };
    const re = channelForm([['TIKTOK', 'https://www.tiktok.com/@new', '새채널', '2만'], ['YOUTUBE', 'https://www.youtube.com/@new']], 0);
    re.set('displayName', '전환신청');
    const rr = await resubmitCreatorApplication({ ok: false }, re);
    expect(rr.ok, rr.message).toBe(true);
    p = await prisma.creatorProfile.findUniqueOrThrow({ where: { id: creator.id } });
    expect(p.reviewNote).toBeNull();
    expect(p.channelUrl).toBe('https://www.tiktok.com/@new');
    expect(await prisma.creatorChannel.count({ where: { creatorId: creator.id } })).toBe(2);
  });

  it('다른 크리에이터가 등록한 채널로는 재제출할 수 없다', async () => {
    const { user } = await pendingMember();
    await prisma.creatorChannel.create({
      data: { id: newId(), creatorId: fx.creatorId, platform: 'YOUTUBE', url: 'https://www.youtube.com/@taken', urlKey: 'youtube.com/@taken' },
    });
    session.user = { id: user.id, role: 'DONOR', email: user.email, name: user.name, avatarIndex: 0 };
    const re = channelForm([['YOUTUBE', 'https://youtube.com/@taken/']]);
    re.set('displayName', '전환신청');
    const rr = await resubmitCreatorApplication({ ok: false }, re);
    expect(rr.ok).toBe(false);
    expect(rr.message).toMatch(/이미 다른 크리에이터/);
  });

  it('승인하면 같은 계정이 일반회원 → 크리에이터로 바뀌고, 반려는 일반회원으로 남는다', async () => {
    const a = await pendingMember();
    const fd = new FormData();
    fd.set('creatorId', a.creator.id);
    fd.set('status', 'APPROVED');
    const r = await updateCreatorStatus({ ok: false }, fd);
    expect(r.ok, r.message).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } })).role).toBe('CREATOR');

    const b = await pendingMember();
    const fd2 = new FormData();
    fd2.set('creatorId', b.creator.id);
    fd2.set('status', 'REJECTED');
    fd2.set('reason', '채널 확인 불가');
    const r2 = await updateCreatorStatus({ ok: false }, fd2);
    expect(r2.ok, r2.message).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.user.id } })).role).toBe('DONOR');
    const n = await prisma.notification.findFirst({ where: { userId: b.user.id }, orderBy: { createdAt: 'desc' } });
    expect(n?.linkUrl).toBe('/my/creator');
  });
});
