'use client';

import * as React from 'react';
import { Download, Loader2, Share2 } from '@/components/brand/icons';
import { logShareAction } from '@/app/actions/fanvote';

/**
 * 팬투표 인증 카드 (2026-11-18). 브라우저에서 바로 그려 저장 · 공유한다(서버에 이미지를 남기지 않는다).
 * 저장하거나 공유하면 오늘의 [팬투표 인증 공유] 미션이 채워진다.
 */
export function ShareCard({ creatorId, creatorName, votes, roundTitle }: { creatorId: string; creatorName: string; votes: number; roundTitle?: string | null }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState('');

  React.useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const W = 1080;
    const H = 1350;
    c.width = W;
    c.height = H;
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#ffd257');
    g.addColorStop(0.55, '#f5b81a');
    g.addColorStop(1, '#ff9f1c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // 장식 원
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.arc(W - 120, 160, 220, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(140, H - 140, 180, 0, Math.PI * 2);
    ctx.fill();
    // 카드
    const pad = 90;
    ctx.fillStyle = '#17161a';
    roundRect(ctx, pad, 260, W - pad * 2, 820, 64);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd257';
    ctx.font = '800 44px "Pretendard", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
    ctx.fillText('DONAIDO 팬투표 인증', W / 2, 380);
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 92px "Pretendard", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
    ctx.fillText(fit(ctx, creatorName, W - pad * 2 - 120), W / 2, 560);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '700 46px "Pretendard", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
    ctx.fillText(roundTitle ? fit(ctx, roundTitle, W - pad * 2 - 120) : '님에게', W / 2, 650);
    ctx.fillStyle = '#ffd257';
    ctx.font = '900 150px "Pretendard", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
    ctx.fillText(`${votes.toLocaleString('ko-KR')}표`, W / 2, 850);
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = '600 40px "Pretendard", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
    ctx.fillText(new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric' }), W / 2, 980);
    ctx.fillStyle = '#17161a';
    ctx.font = '800 48px "Pretendard", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
    ctx.fillText('내 최애를 1위로, 함께 팬투표해요', W / 2, 1200);
  }, [creatorName, votes, roundTitle]);

  const toBlob = () =>
    new Promise<Blob | null>((resolve) => {
      const c = canvasRef.current;
      if (!c) return resolve(null);
      c.toBlob((b) => resolve(b), 'image/png');
    });

  const save = async () => {
    setBusy(true);
    const b = await toBlob();
    setBusy(false);
    if (!b) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `donaido-fanvote-${Date.now()}.png`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    await logShareAction(creatorId, 'download').catch(() => null);
    setNote('저장했어요. 오늘의 공유 미션 보상을 받을 수 있어요.');
  };

  const share = async () => {
    setBusy(true);
    const b = await toBlob();
    setBusy(false);
    if (!b) return;
    const file = new File([b], 'donaido-fanvote.png', { type: 'image/png' });
    const data: ShareData = { title: '팬투표 인증', text: `${creatorName} 님에게 ${votes.toLocaleString('ko-KR')}표! 함께 팬투표해요`, files: [file] };
    try {
      if (navigator.canShare?.(data)) await navigator.share(data);
      else if (navigator.share) await navigator.share({ title: data.title, text: data.text, url: window.location.origin + '/vote' });
      else {
        await save();
        return;
      }
      await logShareAction(creatorId, 'share').catch(() => null);
      setNote('공유했어요. 오늘의 공유 미션 보상을 받을 수 있어요.');
    } catch {
      /* 사용자가 공유를 닫음 */
    }
  };

  return (
    <div className="mt-4">
      <canvas ref={canvasRef} className="mx-auto w-full max-w-[220px] rounded-2xl shadow-card" aria-label="팬투표 인증 카드 미리보기" />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => void save()} disabled={busy} className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-ink-200 text-[13px] font-extrabold text-ink-700">
          {busy ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Download size={15} aria-hidden />}
          카드 저장
        </button>
        <button type="button" onClick={() => void share()} disabled={busy} className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-ink-900 text-[13px] font-extrabold text-white">
          <Share2 size={15} aria-hidden />
          공유하기
        </button>
      </div>
      {note ? <p className="mt-2 text-center text-[11.5px] font-bold text-success-600">{note}</p> : null}
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}
