import type { Metadata } from 'next';
import { GameOverlayClient } from '@/components/overlay/game-overlay-client';
import { OverlayCanvas } from '@/components/overlay/overlay-canvas';
import { authorizeOverlay } from '@/server/services/overlay-access';
import { buildSampleState } from '@/server/services/game-state';
import { clampOverlayLayout } from '@/lib/overlay-layout';

/**
 * 게임 오버레이 브라우저 소스.
 *
 * 후원 알림 오버레이(/overlay/{creatorId})와 **소스를 나눈다.**
 *  - 게임은 화면 가운데를 크게 쓰고, 후원 알림은 순간적으로 뜨는 배너다.
 *    한 소스로 묶으면 OBS 에서 크기·위치를 따로 잡을 수 없고, 게임만 잠깐 숨기는 것도 안 된다.
 *  - 토큰은 후원 알림과 **같은 값**을 쓴다. 크리에이터가 관리할 비밀은 하나뿐이다.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '도네이도 게임 오버레이',
  robots: { index: false, follow: false },
};

type Search = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export default async function GameOverlayPage({
  params,
  searchParams,
}: {
  params: Promise<{ creatorId: string }>;
  searchParams: Promise<Search>;
}) {
  const { creatorId } = await params;
  const sp = await searchParams;
  const token = one(sp.token);
  const preview = one(sp.preview) === '1';
  const debug = one(sp.debug) === '1';
  // 세로형(휴대폰) 미리보기 틀에서는 방송 화면을 위쪽에 붙인다.
  const align = one(sp.align) === 'top' ? 'top' : 'center';

  const { ok, setting } = await authorizeOverlay(creatorId, token, preview);

  if (!ok) {
    return (
      <div className="grid h-screen w-screen place-items-center bg-transparent">
        <div className="rounded-2xl bg-ink-900/85 px-5 py-4 text-center">
          <p className="text-[14px] font-bold text-white">접근 권한이 없습니다 (401)</p>
          <p className="mt-1 text-[12px] text-white/70">오버레이 주소와 토큰을 다시 확인해 주세요.</p>
        </div>
      </div>
    );
  }

  /**
   * 띄우기 전 미리보기.
   * 스튜디오에서 게임 하나를 골라 "띄우면 이렇게 보인다"를 확인하는 용도다.
   *
   * **세션으로 인증한 미리보기에서만 받는다.** 토큰으로 여는 방송용 소스에서는 무시한다.
   * 방송 소스가 실시간 상태 대신 고정 화면을 그리는 경로를 아예 만들지 않기 위해서다.
   */
  const sampleGameId = preview ? one(sp.sample) : '';
  const sample = sampleGameId ? await buildSampleState(creatorId, sampleGameId) : null;

  const overlay = (
    <GameOverlayClient
      creatorId={creatorId}
      token={token}
      preview={preview}
      debug={debug}
      sample={sample}
      sampleMode={Boolean(sampleGameId)}
      layout={clampOverlayLayout({
        offsetX: setting?.gameOffsetX,
        offsetY: setting?.gameOffsetY,
        scalePct: setting?.gameScalePct,
      })}
    />
  );

  // 미리보기는 1920x1080 으로 그린 뒤 틀 크기에 맞춰 통째로 축소한다.
  // 그래야 스튜디오에서 보는 화면과 OBS 에 나가는 화면이 픽셀 단위로 같아진다.
  return preview ? <OverlayCanvas align={align}>{overlay}</OverlayCanvas> : overlay;
}
