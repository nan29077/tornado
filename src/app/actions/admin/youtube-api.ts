'use server';

/**
 * 최고관리자 — 유튜브 연동 > API 키 관리 · 영상 수집 (2026-11-18)
 * 권한: API 키 등록·삭제 = 최고관리자(SUPER_ADMIN)만 / 수집 설정·채널·수집 실행 = 운영(OPERATION) 이상
 * 키 원문은 감사로그·화면·응답 어디에도 남기지 않는다(앞뒤 4자리 마스킹만).
 */
import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import { assertOperationAdmin, run, text, type AdminActionState } from './shared';
import {
  addApiChannel,
  clearYouTubeApiKey,
  collectAllApiChannels,
  collectApiChannel,
  getYouTubeApiSettings,
  saveYouTubeApiKey,
  testYouTubeApiKey,
  updateYouTubeApiSettings,
} from '@/server/services/youtube-api';
import { isPlausibleApiKey } from '@/server/services/youtube-api-parse';
import { isVideoCategory } from '@/lib/video-hub';

function assertSuperAdmin(admin: { adminPermission?: string | null }, what: string) {
  if (admin.adminPermission !== 'SUPER_ADMIN') throw new Error(`${what}은(는) 최고관리자만 할 수 있습니다.`);
}

function refresh() {
  revalidatePath('/admin/youtube');
  revalidatePath('/admin/youtube/api');
  revalidatePath('/admin/youtube/videos');
  revalidatePath('/videos');
  revalidatePath('/');
}

export async function saveYouTubeApiKeyAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertSuperAdmin(admin, 'YouTube API 키 등록');
    const key = text(fd, 'apiKey').replace(/\s+/g, '');
    if (!isPlausibleApiKey(key)) throw new Error('API 키 형식이 아닙니다. Google Cloud 콘솔 > 사용자 인증 정보에서 만든 키(보통 AIza로 시작)를 붙여 넣어 주세요.');
    const before = await getYouTubeApiSettings();
    const next = await saveYouTubeApiKey(key, admin.id);
    await writeAudit({
      adminUserId: admin.id,
      action: 'YOUTUBE_API_KEY_SAVE',
      targetType: 'SystemSetting',
      targetId: 'youtube.dataApi',
      before: { key: before.keyMasked },
      after: { key: next.keyMasked },
    });
    // 저장 직후 바로 확인한다 (1 unit)
    const test = await testYouTubeApiKey(admin.id);
    refresh();
    return test.ok ? `API 키를 저장했고 연결을 확인했습니다. (${next.keyMasked})` : `API 키는 저장했지만 확인에 실패했습니다: ${test.message}`;
  });
}

export async function clearYouTubeApiKeyAction(): Promise<AdminActionState> {
  return run(async (admin) => {
    assertSuperAdmin(admin, 'YouTube API 키 삭제');
    const before = await getYouTubeApiSettings();
    if (!before.keyEnc) throw new Error('관리자 화면에 등록된 키가 없습니다.');
    await clearYouTubeApiKey(admin.id);
    await writeAudit({ adminUserId: admin.id, action: 'YOUTUBE_API_KEY_CLEAR', targetType: 'SystemSetting', targetId: 'youtube.dataApi', before: { key: before.keyMasked }, after: { key: null } });
    refresh();
    return 'API 키를 삭제했습니다. 서버 환경변수(YOUTUBE_API_KEY)가 있으면 그 키를 씁니다.';
  });
}

export async function testYouTubeApiKeyAction(): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, 'API 키 연결 확인');
    const r = await testYouTubeApiKey(admin.id);
    refresh();
    if (!r.ok) throw new Error(r.message);
    return r.message;
  });
}

export async function saveYouTubeCollectSettingsAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '영상 수집 설정');
    const intervalHours = Number(text(fd, 'intervalHours'));
    const perChannel = Number(text(fd, 'perChannel'));
    if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 168) throw new Error('자동 수집 간격은 1~168시간 사이로 입력해 주세요.');
    if (!Number.isInteger(perChannel) || perChannel < 1 || perChannel > 50) throw new Error('채널당 영상 수는 1~50개 사이로 입력해 주세요.');
    const before = await getYouTubeApiSettings();
    const next = await updateYouTubeApiSettings(
      { enabled: text(fd, 'enabled') === 'on', autoCollect: text(fd, 'autoCollect') === 'on', intervalHours, perChannel },
      admin.id,
    );
    const pick = (s: typeof next) => ({ enabled: s.enabled, autoCollect: s.autoCollect, intervalHours: s.intervalHours, perChannel: s.perChannel });
    await writeAudit({ adminUserId: admin.id, action: 'YOUTUBE_COLLECT_SETTINGS', targetType: 'SystemSetting', targetId: 'youtube.dataApi', before: pick(before), after: pick(next) });
    refresh();
    return '영상 수집 설정을 저장했습니다.';
  });
}

export async function addYouTubeApiChannelAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '수집 채널 추가');
    const row = await addApiChannel(text(fd, 'channel'), text(fd, 'category'));
    await writeAudit({ adminUserId: admin.id, action: 'YOUTUBE_API_CHANNEL_ADD', targetType: 'YouTubeApiChannel', targetId: row.id, after: { channelId: row.channelId, title: row.title, category: row.category } });
    // 추가한 채널은 바로 한 번 수집한다 (2 units)
    const settings = await getYouTubeApiSettings();
    const r = await collectApiChannel(row.id, { perChannel: settings.perChannel });
    refresh();
    return r.ok ? `${row.title ?? row.channelId} 채널을 추가하고 영상 ${r.saved}개를 가져왔습니다.` : `${row.title ?? row.channelId} 채널을 추가했지만 수집에 실패했습니다: ${r.message}`;
  });
}

export async function youTubeApiChannelOpAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '수집 채널 관리');
    const id = text(fd, 'id');
    const op = text(fd, 'op');
    const row = await prisma.youTubeApiChannel.findUnique({ where: { id }, select: { id: true, channelId: true, title: true, active: true, category: true } });
    if (!row) throw new Error('채널을 찾을 수 없습니다.');
    let message: string;
    if (op === 'collect') {
      const settings = await getYouTubeApiSettings();
      const r = await collectApiChannel(row.id, { perChannel: settings.perChannel });
      if (!r.ok) throw new Error(r.message);
      message = `${row.title ?? row.channelId}: 영상 ${r.saved}개를 가져왔습니다.`;
    } else if (op === 'pause' || op === 'resume') {
      await prisma.youTubeApiChannel.update({ where: { id }, data: { active: op === 'resume' } });
      message = op === 'resume' ? '수집·노출을 다시 시작했습니다.' : '수집을 멈추고 방송국에서 이 채널 영상을 내렸습니다.';
    } else if (op === 'category') {
      const category = text(fd, 'category');
      if (!isVideoCategory(category) || category === 'all' || category === 'donaido') throw new Error('카테고리를 골라 주세요.');
      await prisma.youTubeApiChannel.update({ where: { id }, data: { category } });
      message = '카테고리를 바꿨습니다.';
    } else if (op === 'delete') {
      await prisma.youTubeApiChannel.delete({ where: { id } });
      message = '채널과 수집한 영상을 삭제했습니다.';
    } else {
      throw new Error('알 수 없는 처리입니다.');
    }
    await writeAudit({ adminUserId: admin.id, action: `YOUTUBE_API_CHANNEL_${op.toUpperCase()}`, targetType: 'YouTubeApiChannel', targetId: row.id, before: { active: row.active, category: row.category }, after: { op } });
    refresh();
    return message;
  });
}

export async function collectAllYouTubeAction(): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '영상 수집');
    const r = await collectAllApiChannels({ adminUserId: admin.id });
    await writeAudit({ adminUserId: admin.id, action: 'YOUTUBE_API_COLLECT', targetType: 'SystemSetting', targetId: 'youtube.dataApi', after: { summary: r.summary } });
    refresh();
    if (!r.ok && r.results.every((x) => !x.ok)) throw new Error(r.summary);
    return r.summary;
  });
}

export async function youTubeApiVideoOpAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '수집 영상 관리');
    const videoId = text(fd, 'videoId');
    const hide = text(fd, 'op') === 'hide';
    // 관리자가 정한 숨김·보이기는 수집기가 되돌리지 않도록 자동 숨김 표시를 지운다 (7차 P2-5)
    const res = await prisma.youTubeApiVideo.updateMany({ where: { videoId }, data: { hidden: hide, autoHidden: false } });
    if (res.count === 0) throw new Error('영상을 찾을 수 없습니다.');
    await writeAudit({ adminUserId: admin.id, action: hide ? 'YOUTUBE_API_VIDEO_HIDE' : 'YOUTUBE_API_VIDEO_SHOW', targetType: 'YouTubeApiVideo', targetId: videoId });
    refresh();
    return hide ? '방송국에서 이 영상을 숨겼습니다.' : '영상을 다시 보이게 했습니다.';
  });
}
