import type { Metadata } from 'next';
import { OverlayClient } from '@/components/overlay/overlay-client';
import { OverlayCanvas } from '@/components/overlay/overlay-canvas';
import { authorizeOverlay } from '@/server/services/overlay-access';
import { clampOverlayLayout } from '@/lib/overlay-layout';

/**
 * OBS / PRISM 브라우저 소스 오버레이.
 *  - 토큰이 없거나 틀리면 아무 정보도 노출하지 않고 거절한다.
 *  - preview=1 은 스튜디오 미리보기 전용 경로다(로그인한 본인만).
 *  - 검색엔진 색인을 차단한다.
 *  - 배경은 완전 투명이어야 한다.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '도네이도 오버레이',
  robots: { index: false, follow: false },
};

type Search = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export default async function OverlayPage({
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

  // 오버레이가 꺼져 있어도 클라이언트는 그대로 붙여 둔다.
  //  - 예전에는 여기서 빈 화면을 돌려주고 끝냈는데, 그러면 방송 중에 [오버레이 표시]를 다시 켜도
  //    OBS 브라우저 소스를 새로 고치기 전까지 영영 아무것도 나오지 않았다(SSE 를 아예 열지 않으므로).
  //  - 꺼진 동안 도착한 이벤트는 클라이언트가 페이로드의 enabled 값을 보고 무시한다.
  //    (미리보기는 설정 확인이 목적이므로 꺼져 있어도 재생한다)
  const overlay = (
    <OverlayClient
      creatorId={creatorId}
      token={token}
      preview={preview}
      position={setting?.position ?? 'BOTTOM_CENTER'}
      defaultDurationMs={setting?.durationMs ?? 7000}
      maxMessageLen={setting?.maxMessageLen ?? 80}
      theme={setting?.theme ?? 'TORNADO'}
      layout={clampOverlayLayout(setting)}
      debug={debug}
    />
  );

  // 미리보기는 방송 화면(1920x1080)을 그대로 그린 뒤 틀 크기에 맞춰 축소한다.
  // 방송용(토큰) 경로는 OBS 가 정한 크기를 그대로 채우므로 감싸지 않는다.
  return preview ? <OverlayCanvas align={align}>{overlay}</OverlayCanvas> : overlay;
}
