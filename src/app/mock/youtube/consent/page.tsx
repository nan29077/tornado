import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, KeyRound, MessageSquare, ShieldCheck } from 'lucide-react';
import { Card, CardTitle, Notice } from '@/components/ui';
import { Logo } from '@/components/brand/logo';
import { isMockYouTubeAllowed } from '@/server/mock-guard';

/**
 * Mock 구글 동의화면.
 *
 * 실제 연동 시
 *  - 이 화면은 제거되고 Google OAuth 2.0 동의화면으로 대체된다.
 *  - 동의화면 검증(민감 스코프 심사)이 완료되어야 외부 사용자에게 공개할 수 있다.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '테스트용 모의 동의 화면',
  robots: { index: false, follow: false },
};

type Search = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export default async function MockYouTubeConsentPage({ searchParams }: { searchParams: Promise<Search> }) {
  // 실제 구글 OAuth 가 연결된 환경에서는 존재하지 않는 화면으로 취급한다.
  if (!isMockYouTubeAllowed()) notFound();

  const sp = await searchParams;
  const state = one(sp.state);
  const q = `state=${encodeURIComponent(state)}`;

  return (
    <main className="min-h-screen bg-ink-50 px-4 pb-14 pt-6">
      <div className="app-column">
        <div className="mb-4 flex items-center justify-between">
          <Logo />
          <span className="text-[11px] font-semibold text-ink-300">모의 동의 화면</span>
        </div>

        <div className="space-y-3">
          <div className="rounded-2xl border-2 border-warning-500/50 bg-warning-50 px-4 py-4">
            <div className="flex items-start gap-2">
              <AlertTriangle size={20} strokeWidth={1.7} className="mt-0.5 shrink-0 text-warning-600" />
              <div>
                <p className="text-[15px] font-extrabold text-ink-900">
                  테스트용 모의 동의 화면입니다. 실제 구글 계정과 연결되지 않습니다.
                </p>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-700">
                  실제 서비스에서는 이 화면이 제거되고 구글 OAuth 동의화면으로 대체됩니다.
                </p>
              </div>
            </div>
          </div>

          <Card>
            <div className="mb-3 flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-700">
                <KeyRound size={17} strokeWidth={1.7} />
              </span>
              <div>
                <CardTitle>도네이도가 요청하는 권한</CardTitle>
                <p className="text-[12px] text-ink-400">유튜브 라이브 채팅 연동에 필요한 권한입니다.</p>
              </div>
            </div>

            <div className="rounded-xl border border-ink-200 px-4 py-3">
              <p className="text-[13px] font-bold text-ink-900">youtube.force-ssl</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
                https://www.googleapis.com/auth/youtube.force-ssl
              </p>
              <ul className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed text-ink-700">
                <li className="flex gap-2">
                  <MessageSquare size={15} strokeWidth={1.7} className="mt-0.5 shrink-0 text-brand-700" />
                  <span>진행 중인 라이브 방송의 채팅에 후원 메시지를 등록합니다.</span>
                </li>
                <li className="flex gap-2">
                  <ShieldCheck size={15} strokeWidth={1.7} className="mt-0.5 shrink-0 text-brand-700" />
                  <span>채널 정보와 진행 중인 방송 정보를 조회합니다.</span>
                </li>
              </ul>
            </div>

            <div className="mt-3">
              <Notice tone="neutral">
                도네이도는 유튜브 공식 슈퍼챗이 아닌 외부 후원으로 메시지를 등록합니다. 연결은 크리에이터 콘솔에서
                언제든지 해제할 수 있습니다.
              </Notice>
            </div>

            <div className="mt-4 space-y-2">
              <Link
                href={`/api/youtube/oauth/callback?code=mock-code&${q}`}
                prefetch={false}
                className="inline-flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand-400 text-[16px] font-extrabold text-ink-900 hover:bg-brand-500"
              >
                채널 연결 허용
              </Link>
              <Link
                href={`/api/youtube/oauth/callback?error=access_denied&${q}`}
                prefetch={false}
                className="inline-flex h-14 w-full items-center justify-center gap-2 rounded-2xl border border-ink-200 bg-white text-[16px] font-semibold text-ink-900 hover:bg-ink-50"
              >
                거부
              </Link>
            </div>
          </Card>
        </div>
      </div>
    </main>
  );
}
