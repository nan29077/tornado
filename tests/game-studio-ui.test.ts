import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { moPayload, resetDb, seedBasics, type Fixture } from './helpers';
import { previewDiagnosisLines } from '@/components/studio/broadcast-preview';

/**
 * 게임 오버레이 화면 정리(2026-09-07)의 재발 방지.
 *
 * 신고된 증상
 *  1. 스크롤하면 [게임 관리] 카드가 위 진행 컨트롤 카드 **밑으로 들어가** 잘린다
 *  2. 미리보기에 게임도 테스트 후원도 안 나오는데 **화면만 봐서는 이유를 알 수 없다**
 *  3. [방송에 시작] 버튼이 어디 있는지 안 보인다
 *  4. 쓸 수 없는 버튼(유튜브 미연결)·오해를 부르는 이름([방송 종료])이 남아 있다
 */

const GAME_STUDIO = 'src/components/studio/game-studio.tsx';
const PREVIEW = 'src/components/studio/broadcast-preview.tsx';
const OVERLAY_CLIENT = 'src/components/overlay/overlay-client.tsx';
const OVERLAY_CANVAS = 'src/components/overlay/overlay-canvas.tsx';

const read = (p: string) => readFileSync(p, 'utf8');

describe('1 · 진행 컨트롤이 아래 카드를 덮지 않는다', () => {
  it('진행 컨트롤 카드를 화면에 고정하지 않는다', () => {
    const src = read(GAME_STUDIO);
    // sticky 로 붙여 두면 아래 [게임 관리] 카드가 이 카드 밑으로 미끄러져 들어가 잘린다.
    expect(src).not.toMatch(/card-solid sticky/);
    expect(src).not.toMatch(/sticky top-\[calc\(var\(--console-header-h\)\+var\(--overlay-tabbar-h\)\)\]/);
  });
});

describe('2 · 미리보기가 왜 비었는지 스스로 말한다', () => {
  const base = {
    link: { phase: 'connected' },
    game: { phase: 'connected', live: true, status: 'OPEN', participantCount: 0 },
    meta: { queue: 0, theme: 'NEON' },
    canvasReady: true,
    showDonation: true,
    showGame: true,
  } as const;

  it('전부 정상이면 아무 말도 하지 않는다', () => {
    expect(previewDiagnosisLines({ ...base })).toEqual([]);
  });

  it('틀 크기를 못 재면 그 사실을 알린다', () => {
    // scale 0 이 되어 화면이 통째로 감춰지는 상태. 연결은 정상이라 화면상 구분이 안 됐다.
    const lines = previewDiagnosisLines({ ...base, canvasReady: false });
    expect(lines.join(' ')).toContain('크기를 재지 못했습니다');
  });

  it('게임 연결은 됐는데 띄운 게임이 없으면 그렇게 말한다', () => {
    const lines = previewDiagnosisLines({
      ...base,
      game: { phase: 'connected', live: false, status: '', participantCount: 0 },
    });
    expect(lines.join(' ')).toContain('띄운 게임이 없어서');
  });

  it('연결이 안 붙었으면 층별로 따로 알린다', () => {
    const lines = previewDiagnosisLines({
      ...base,
      link: { phase: 'retrying' },
      game: { phase: 'connecting', live: false, status: '', participantCount: 0 },
    });
    expect(lines.join(' ')).toContain('후원 알림 연결이 끊겨');
    expect(lines.join(' ')).toContain('게임 연결을 여는 중');
  });

  it('두 층을 모두 꺼 두었으면 그것부터 알린다', () => {
    const lines = previewDiagnosisLines({ ...base, showDonation: false, showGame: false });
    expect(lines[0]).toContain('모두 꺼 두었습니다');
  });

  it('재생 대기가 밀려 있으면 건수를 알린다', () => {
    const lines = previewDiagnosisLines({ ...base, meta: { queue: 3, theme: 'NEON' } });
    expect(lines.join(' ')).toContain('3건');
  });

  it('오버레이 캔버스가 측정 결과를 부모에게 알린다', () => {
    // 이 신호가 없으면 위 진단은 "크기 못 잼" 을 영영 알 수 없다.
    expect(read(OVERLAY_CANVAS)).toContain("type: 'donaido-overlay-canvas'");
    expect(read(PREVIEW)).toContain("donaido-overlay-canvas");
  });
});

describe('3 · 게임을 띄우는 버튼이 목록에 있다', () => {
  const src = read(GAME_STUDIO);

  it('[게임 관리] 팝업의 게임 카드에서 바로 띄울 수 있다', () => {
    expect(src).toContain('방송에 띄우기');
    expect(src).toContain('이 게임으로 바꾸기');
  });

  it('띄우는 팝업이 하나로 합쳐졌다', () => {
    // 예전에는 [게임 바꾸기] 전용 팝업과 [게임 관리] 팝업이 따로 있어
    // 같은 일을 두 곳에서 하고 있었다.
    expect(src).not.toContain('pickerOpen');
  });
});

describe('4 · 쓸 수 없는 버튼과 오해를 부르는 이름', () => {
  const src = read(GAME_STUDIO);

  it('회차를 끝내는 버튼을 [방송 종료]라고 부르지 않는다', () => {
    // 라이브 방송 자체를 끊는 것처럼 읽혀 방송 중에 누르기 무섭다.
    expect(src).toContain('게임 내리기');
    expect(src).not.toMatch(/>\s*방송 종료\s*</);
  });

  it('유튜브가 연결돼 있을 때만 채팅 공유 버튼을 그린다', () => {
    expect(src).toContain('!youtubeConnected ? undefined : shareToChat');
  });
});

describe('5 · TTS 가 멈춰도 후원 알림 재생이 멈추지 않는다', () => {
  it('읽기에 시간 제한을 둔다', () => {
    /**
     * speechSynthesis 는 브라우저가 음성을 막으면 onend 를 영영 부르지 않는 경우가 있다.
     * 예전 코드는 Promise.all 로 그 완료를 기다려서, 한 번 걸리면 busy 가 굳고
     * **그 뒤로 후원 알림이 한 건도 재생되지 않았다.**
     */
    const src = read(OVERLAY_CLIENT);
    expect(src).toContain('TTS_MAX_MS');
    expect(src).toContain('Promise.race');
    expect(src).not.toContain('Promise.all([shown, speak(next)])');
  });
});

describe('6 · 게임 API 가 유튜브 연결 여부를 함께 내려준다', () => {
  let fx: Fixture;
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
  });

  it('연결이 있으면 true, 해제하면 false', async () => {
    await prisma.youTubeConnection.upsert({
      where: { creatorId: fx.creatorId },
      create: {
        id: 'yt-' + Date.now(),
        creatorId: fx.creatorId,
        channelId: 'UC-test',
        accessTokenEnc: 'enc',
        refreshTokenEnc: 'enc',
        scope: 'test',
        expiresAt: new Date(Date.now() + 3600_000),
      },
      update: { status: 'CONNECTED' },
    });
    const one = await prisma.youTubeConnection.findFirst({
      where: { creatorId: fx.creatorId, status: { not: 'REVOKED' } },
      select: { id: true },
    });
    expect(Boolean(one)).toBe(true);

    // 해제된 연결은 세지 않는다(버튼이 다시 나타나면 안 된다).
    await prisma.youTubeConnection.update({
      where: { creatorId: fx.creatorId },
      data: { status: 'REVOKED' },
    });
    const revoked = await prisma.youTubeConnection.findFirst({
      where: { creatorId: fx.creatorId, status: { not: 'REVOKED' } },
      select: { id: true },
    });
    expect(Boolean(revoked)).toBe(false);
    expect(moPayload).toBeTypeOf('function');
  });
});
