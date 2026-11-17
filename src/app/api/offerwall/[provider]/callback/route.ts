/**
 * 오퍼월 리워드 콜백 (광고사 서버 → 도네이도) (2026-11-17)
 *
 *  - mock      : 테스트 광고. HMAC(SESSION_SECRET) 서명이 맞을 때만 지급 (운영에서는 꺼짐)
 *  - buzzvil   : 계약 전 — 501 응답 (연동 규격을 받으면 서명 검증 · 파라미터 매핑을 구현한다)
 *  - adpopcorn : 계약 전 — 501 응답
 * 모든 요청은 webhook_log 에 남긴다. 같은 거래 고유값은 한 번만 지급한다.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { clientIpFromRequest } from '@/server/rate-limit';
import { grantOfferwallReward, revokeOfferwallReward, verifyMockCallback } from '@/server/services/vote/offerwall';

export const dynamic = 'force-dynamic';

async function log(provider: string, method: string, body: Record<string, string>, ok: boolean, ip: string | null, status: number, note: string) {
  await prisma.webhookLog
    .create({ data: { id: newId(), source: `offerwall:${provider}`, endpoint: `/api/offerwall/${provider}/callback`, method, bodyMasked: body, signatureOk: ok, ip, statusCode: status, responseNote: note.slice(0, 300) } })
    .catch(() => undefined);
}

async function readParams(req: Request): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  new URL(req.url).searchParams.forEach((v, k) => (out[k] = v));
  if (req.method === 'POST') {
    const type = req.headers.get('content-type') ?? '';
    try {
      if (type.includes('application/json')) {
        const j = (await req.json()) as Record<string, unknown>;
        for (const [k, v] of Object.entries(j)) out[k] = String(v);
      } else {
        const fd = await req.formData();
        fd.forEach((v, k) => (out[k] = typeof v === 'string' ? v : ''));
      }
    } catch {
      /* 본문 없음 */
    }
  }
  return out;
}

async function handle(req: Request, provider: string) {
  const ip = clientIpFromRequest(req);
  const p = await readParams(req);
  const masked = { ...p, sig: p.sig ? '***' : '' };
  if (provider !== 'mock') {
    await log(provider, req.method, masked, false, ip, 501, '계약 전 광고사 — 연동 대기');
    return NextResponse.json({ ok: false, code: 'NOT_INTEGRATED', message: '아직 연동되지 않은 광고사입니다.' }, { status: 501 });
  }
  const rewardKey = p.reward_key ?? '';
  const userId = p.user_id ?? '';
  const points = Number(p.points ?? '0');
  if (!verifyMockCallback(rewardKey, userId, points, p.sig ?? '')) {
    await log(provider, req.method, masked, false, ip, 401, '서명 불일치');
    return NextResponse.json({ ok: false, code: 'BAD_SIGNATURE' }, { status: 401 });
  }
  if (p.action === 'revoke') {
    const r = await revokeOfferwallReward('mock', rewardKey, p.reason || '광고사 취소');
    await log(provider, req.method, masked, true, ip, 200, `회수 ${r.revoked}`);
    return NextResponse.json({ ok: r.ok, revoked: r.revoked });
  }
  const r = await grantOfferwallReward({ provider: 'mock', rewardKey, userId, points, campaign: p.campaign ?? null, payloadMasked: masked, ip });
  await log(provider, req.method, masked, true, ip, r.ok ? 200 : 400, r.ok ? (r.duplicate ? '중복(이미 지급)' : `지급 ${r.tickets}`) : r.reason);
  return r.ok ? NextResponse.json({ ok: true, duplicate: r.duplicate, tickets: r.tickets }) : NextResponse.json({ ok: false, message: r.reason }, { status: 400 });
}

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  return handle(req, (await ctx.params).provider);
}

export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  return handle(req, (await ctx.params).provider);
}
