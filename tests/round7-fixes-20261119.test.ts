import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { kv } from '@/server/redis';
import { UPLOAD_DIR, getObjectRange, mediaUrlVariants, newObjectName, putObject } from '@/server/uploads';
import { decideTalkMediaAccess } from '@/server/talk-media-access';
import type { SessionUser } from '@/server/auth';
import { DEFAULT_VOTE_CONFIG, normalizeVoteConfig, saveVoteConfig } from '@/server/services/engagement/config';
import { sendBroadcast, subscribeTalk } from '@/server/services/talk/talk';
import { getFanStats, getFanStatsMany, getOrCreateFanProfile, getReferralState, redeemReferralCode, rewardInviterOnFirstVote } from '@/server/services/vote/fan';
import { getBalance, grantTickets } from '@/server/services/vote/wallet';
import { castVote } from '@/server/services/vote/cast';
import { addApiChannel, collectAllApiChannels, saveYouTubeApiKey } from '@/server/services/youtube-api';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/auth', async (orig) => ({ ...(await orig<typeof import('@/server/auth')>()), getSessionUser: vi.fn(async () => null) }));

/**
 * 7차 전체 점검 수정 (2026-11-19)
 *  P1-1 저장소 전역 공유 · P2-1 미디어 구간 읽기 · P2-2 팬챗 첨부 권한 · P2-3 팬 레벨 일괄 계산
 *  P2-4 초대 보상 휴대폰 조건 · P2-5 수집 영상 자동 숨김/복구
 */

let fx: Fixture;

async function member(name = '팬', phone = false) {
  const u = await prisma.user.create({
    data: { id: newId(), email: `r7-${newId()}@test.kr`, name, role: 'DONOR', ...(phone ? { phoneHash: `ph-${newId()}` } : {}) },
  });
  return { id: u.id, name: u.name };
}

function session(u: { id: string; name: string | null }, extra: Partial<SessionUser> = {}): SessionUser {
  return { id: u.id, email: null, name: u.name, role: 'DONOR', avatarIndex: 0, ...extra } as SessionUser;
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
});

describe('P1-1 저장소는 프로세스 안에서 하나만 쓴다', () => {
  it('kv 는 전역에 보관되어 다른 번들 조각에서도 같은 저장소를 받는다', async () => {
    const g = globalThis as unknown as { kv?: unknown };
    expect(g.kv).toBe(kv);
    await kv.set('r7:shared', '1', 30);
    expect(await (g.kv as typeof kv).get('r7:shared')).toBe('1');
  });
});

describe('P2-1 미디어 구간 읽기', () => {
  it('요청한 바이트 구간만 읽고, 끝을 넘기면 파일 끝으로 줄인다', async () => {
    const name = newObjectName('mp4');
    const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    await putObject(name, body, 'video/mp4', { private: true });
    try {
      const part = await getObjectRange(name, 100, 199);
      expect(part?.size).toBe(1000);
      expect(part?.body?.length).toBe(100);
      expect(part?.body?.[0]).toBe(100);
      const tail = await getObjectRange(name, 990, 5000);
      expect(tail?.body?.length).toBe(10);
      const outside = await getObjectRange(name, 2000, 3000);
      expect(outside).toEqual({ size: 1000, body: null });
      expect(await getObjectRange(newObjectName('mp4'), 0, 10)).toBeNull();
    } finally {
      await fs.rm(path.join(UPLOAD_DIR, name), { force: true });
    }
  });

  it('구독자 전용 업로드는 공개 CDN 주소가 아니라 /api/media 주소를 돌려준다', async () => {
    const name = newObjectName('m4a');
    try {
      expect(await putObject(name, Buffer.from('ftypM4A '), 'audio/mp4', { private: true })).toBe(`/api/media/${name}`);
    } finally {
      await fs.rm(path.join(UPLOAD_DIR, name), { force: true });
    }
  });
});

describe('P2-2 팬챗 첨부 파일 권한', () => {
  async function openRoom() {
    await prisma.talkRoom.upsert({ where: { creatorId: fx.creatorId }, create: { id: newId(), creatorId: fx.creatorId, open: true }, update: { open: true } });
  }

  it('메시지에 붙은 음성은 구독자 · 그 크리에이터 · 관리자만, 비구독자 · 비로그인은 볼 수 없다', async () => {
    await openRoom();
    const name = newObjectName('m4a');
    const url = mediaUrlVariants(name)[0];
    const r = await sendBroadcast(fx.creatorId, '', { mediaType: 'VOICE', mediaUrl: url, mediaDuration: 5 });
    expect(r.ok).toBe(true);

    const sub = await member('구독자');
    expect((await subscribeTalk(sub, fx.creatorId, 'CARD')).ok).toBe(true);
    const outsider = await member('비구독자');

    expect(await decideTalkMediaAccess(name, null)).toBe('DENY');
    expect(await decideTalkMediaAccess(name, session(outsider))).toBe('DENY');
    expect(await decideTalkMediaAccess(name, session(sub))).toBe('ALLOW_PRIVATE');
    expect(await decideTalkMediaAccess(name, session({ id: fx.creatorUserId, name: '크리에이터' }, { role: 'CREATOR', creatorId: fx.creatorId } as Partial<SessionUser>))).toBe('ALLOW_PRIVATE');
    expect(await decideTalkMediaAccess(name, session({ id: newId(), name: '관리자' }, { role: 'ADMIN' } as Partial<SessionUser>))).toBe('ALLOW_PRIVATE');
    // 다른 크리에이터는 볼 수 없다
    expect(await decideTalkMediaAccess(name, session({ id: newId(), name: '다른' }, { role: 'CREATOR', creatorId: newId() } as Partial<SessionUser>))).toBe('DENY');
  });

  it('예약 메시지의 첨부는 공개 시각 전에는 구독자도 볼 수 없다', async () => {
    await openRoom();
    const sub = await member('구독자');
    await subscribeTalk(sub, fx.creatorId, 'CARD');
    const name = newObjectName('mp4');
    const r = await sendBroadcast(fx.creatorId, '곧 공개', { mediaType: 'VIDEO', mediaUrl: `/api/media/${name}`, scheduledAt: new Date(Date.now() + 3600_000) });
    expect(r.scheduled).toBe(true);
    expect(await decideTalkMediaAccess(name, session(sub))).toBe('DENY');
    expect(await decideTalkMediaAccess(name, session(sub), new Date(Date.now() + 2 * 3600_000))).toBe('ALLOW_PRIVATE');
  });

  it('팬챗 사진은 보호하고, 메시지에 붙지 않은 일반 사진(상품 · 배너)은 그대로 공개한다', async () => {
    await openRoom();
    const talkImage = newObjectName('jpg');
    await sendBroadcast(fx.creatorId, '사진', { imageUrl: `/api/media/${talkImage}` });
    expect(await decideTalkMediaAccess(talkImage, null)).toBe('DENY');
    expect(await decideTalkMediaAccess(newObjectName('png'), null)).toBe('PUBLIC');
    // 보내기 전 음성(미리 듣기)은 크리에이터만
    const draft = newObjectName('webm');
    expect(await decideTalkMediaAccess(draft, null)).toBe('DENY');
    expect(await decideTalkMediaAccess(draft, session({ id: fx.creatorUserId, name: 'c' }, { role: 'CREATOR', creatorId: fx.creatorId } as Partial<SessionUser>))).toBe('ALLOW_PRIVATE');
  });

  it('/api/media 라우트: 권한이 없으면 404, 공개 이미지는 구간 응답(206)', async () => {
    const { GET } = await import('@/app/api/media/[name]/route');
    await openRoom();
    const voice = newObjectName('m4a');
    await putObject(voice, Buffer.alloc(64, 1), 'audio/mp4', { private: true });
    await sendBroadcast(fx.creatorId, '', { mediaType: 'VOICE', mediaUrl: `/api/media/${voice}` });
    const img = newObjectName('png');
    await putObject(img, Buffer.alloc(300, 7), 'image/png');
    try {
      const denied = await GET(new Request(`http://localhost/api/media/${voice}`), { params: Promise.resolve({ name: voice }) });
      expect(denied.status).toBe(404);
      const part = await GET(new Request(`http://localhost/api/media/${img}`, { headers: { range: 'bytes=10-19' } }), { params: Promise.resolve({ name: img }) });
      expect(part.status).toBe(206);
      expect(part.headers.get('content-range')).toBe('bytes 10-19/300');
      expect((await part.arrayBuffer()).byteLength).toBe(10);
      const suffix = await GET(new Request(`http://localhost/api/media/${img}`, { headers: { range: 'bytes=-50' } }), { params: Promise.resolve({ name: img }) });
      expect(suffix.headers.get('content-range')).toBe('bytes 250-299/300');
      const bad = await GET(new Request(`http://localhost/api/media/${img}`, { headers: { range: 'bytes=900-' } }), { params: Promise.resolve({ name: img }) });
      expect(bad.status).toBe(416);
      const full = await GET(new Request(`http://localhost/api/media/${img}`), { params: Promise.resolve({ name: img }) });
      expect(full.status).toBe(200);
      expect(full.headers.get('cache-control')).toMatch(/public/);
    } finally {
      await fs.rm(path.join(UPLOAD_DIR, voice), { force: true });
      await fs.rm(path.join(UPLOAD_DIR, img), { force: true });
    }
  });
});

describe('P2-3 팬 레벨 일괄 계산', () => {
  it('여러 회원을 한 번에 계산해도 회원별 계산과 같다', async () => {
    const a = await member('가', true);
    const b = await member('나', true);
    await grantTickets(prisma, { userId: a.id, bucket: 'FREE', amount: 50, source: 'ADMIN', ledgerType: 'ADMIN_GRANT', refType: 'TEST', refId: newId(), expiresInDays: 30, memo: 't' });
    expect((await castVote(a, { creatorId: fx.creatorId, votes: 7 })).ok).toBe(true);
    await prisma.voteAttendance.create({ data: { id: newId(), userId: a.id, dayKey: '2026-11-01', streak: 3, tickets: 3 } });
    const many = await getFanStatsMany([a.id, b.id, a.id]);
    expect(many.get(a.id)).toEqual(await getFanStats(a.id));
    expect(many.get(b.id)).toEqual(await getFanStats(b.id));
    expect(many.size).toBe(2);
  });
});

describe('P2-4 친구 초대 보상은 휴대폰 연결 회원만 (기본 켬)', () => {
  it('휴대폰을 연결하지 않은 회원은 코드를 입력할 수 없고 화면에 연결 안내가 뜬다', async () => {
    const inviter = await member('초대자', true);
    const code = (await getOrCreateFanProfile(inviter.id)).referralCode;
    const noPhone = await member('친구');
    expect((await getReferralState(noPhone.id)).needPhone).toBe(true);
    const r = await redeemReferralCode(noPhone.id, code);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/휴대폰/);
    const withPhone = await member('친구2', true);
    expect((await getReferralState(withPhone.id)).needPhone).toBe(false);
    expect((await redeemReferralCode(withPhone.id, code)).ok).toBe(true);
  });

  it('조건을 켜기 전에 입력한 코드라도, 휴대폰이 없는 친구의 첫 팬투표는 초대자 보상을 주지 않는다', async () => {
    const inviter = await member('초대자', true);
    const code = (await getOrCreateFanProfile(inviter.id)).referralCode;
    const friend = await member('친구');
    await saveVoteConfig(normalizeVoteConfig({ ...DEFAULT_VOTE_CONFIG, referralRequirePhone: false }));
    expect((await redeemReferralCode(friend.id, code)).ok).toBe(true);
    await saveVoteConfig(normalizeVoteConfig({ ...DEFAULT_VOTE_CONFIG, referralRequirePhone: true }));
    expect((await castVote(friend, { creatorId: fx.creatorId, votes: 1 })).ok).toBe(true);
    expect(await rewardInviterOnFirstVote(friend.id)).toBe(false);
    expect((await getBalance(inviter.id)).total).toBe(0);
    // 조건을 끄면 기존 방식대로 보상한다
    await saveVoteConfig(normalizeVoteConfig({ ...DEFAULT_VOTE_CONFIG, referralRequirePhone: false }));
    expect(await rewardInviterOnFirstVote(friend.id)).toBe(true);
    expect((await getBalance(inviter.id)).free).toBe(DEFAULT_VOTE_CONFIG.referralInviterTickets);
  });
});

describe('P2-5 수집 영상 자동 숨김 · 복구', () => {
  const KEY = 'AIzaSyTESTKEY0123456789abcdefghijklmn';
  const CH = 'UC0123456789abcdefghijkl';
  const privacy: Record<string, string> = {};

  beforeEach(() => {
    privacy.aaaaaaaaaaa = 'public';
    privacy.bbbbbbbbbbb = 'public';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/channels')) {
          return Response.json({ items: [{ id: CH, snippet: { title: '채널', thumbnails: {} }, statistics: { subscriberCount: '1' }, contentDetails: { relatedPlaylists: { uploads: `UU${CH.slice(2)}` } } }] });
        }
        if (url.pathname.endsWith('/playlistItems')) {
          return Response.json({ items: Object.keys(privacy).map((id) => ({ contentDetails: { videoId: id } })) });
        }
        if (url.pathname.endsWith('/videos')) {
          return Response.json({
            items: Object.keys(privacy).map((id) => ({
              id,
              snippet: { channelId: CH, title: id, publishedAt: '2026-11-10T00:00:00Z', thumbnails: {}, liveBroadcastContent: 'none' },
              contentDetails: { duration: 'PT5M' },
              statistics: { viewCount: '1' },
              status: { privacyStatus: privacy[id], embeddable: true },
            })),
          });
        }
        return new Response('{}', { status: 404 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('비공개로 바뀐 영상은 자동 숨김, 다시 공개되면 돌아온다. 관리자 숨김은 수집기가 건드리지 않는다', async () => {
    await saveYouTubeApiKey(KEY);
    await addApiChannel(CH, 'game');
    await collectAllApiChannels();
    const row = (id: string) => prisma.youTubeApiVideo.findUniqueOrThrow({ where: { videoId: id } });
    expect((await row('aaaaaaaaaaa')).hidden).toBe(false);

    // 관리자가 b 를 숨긴다
    await prisma.youTubeApiVideo.update({ where: { videoId: 'bbbbbbbbbbb' }, data: { hidden: true, autoHidden: false } });
    // a 가 비공개가 된다 → 자동 숨김
    privacy.aaaaaaaaaaa = 'private';
    await collectAllApiChannels();
    expect(await row('aaaaaaaaaaa')).toMatchObject({ hidden: true, autoHidden: true });
    expect(await row('bbbbbbbbbbb')).toMatchObject({ hidden: true, autoHidden: false });

    // a 가 다시 공개된다 → 복구, b 는 관리자 숨김 유지
    privacy.aaaaaaaaaaa = 'public';
    await collectAllApiChannels();
    expect(await row('aaaaaaaaaaa')).toMatchObject({ hidden: false, autoHidden: false });
    expect(await row('bbbbbbbbbbb')).toMatchObject({ hidden: true, autoHidden: false });

    // 관리자가 숨긴 영상이 비공개가 돼도 관리자 숨김으로 남는다(다시 공개돼도 자동으로 풀리지 않는다)
    privacy.bbbbbbbbbbb = 'private';
    await collectAllApiChannels();
    privacy.bbbbbbbbbbb = 'public';
    await collectAllApiChannels();
    expect(await row('bbbbbbbbbbb')).toMatchObject({ hidden: true, autoHidden: false });
  });
});
