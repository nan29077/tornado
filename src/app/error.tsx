'use client';

import Link from 'next/link';
import { CircleAlert } from 'lucide-react';

/**
 * 화면 오류 안내.
 *
 * 2026-10-01: 사용자에게는 짧은 안내와 [다시 시도] 만 보여 준다. 예전에는 실서비스에서도
 * `.bat` 실행 파일·DATABASE_URL·PostgreSQL 점검 목록을 그대로 보여 줘, 후원자·크리에이터가
 * 개발 도구 안내를 보고 서버 구성 정보까지 드러났다. 점검 목록은 로컬(APP_ENV=local)에서만 보인다.
 *
 * 에러 경계에서는 훅을 쓰지 않는다(/_global-error 프리렌더 실패 방지, CLAUDE.md).
 */
const SHOW_DEV_DIAGNOSTICS = process.env.NEXT_PUBLIC_DEV_DIAGNOSTICS === '1';

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const message = error?.message ?? '';
  const looksLikeDb =
    /database|prisma|ECONNREFUSED|connect|P1000|P1001|P2021|authentication|can't reach|relation .* does not exist/i.test(message);

  return (
    <div className="grid min-h-dvh place-items-center bg-ink-50 px-4 py-10">
      <div className="w-full max-w-[460px] rounded-[22px] border border-ink-100 bg-white p-6 shadow-[0_24px_60px_rgba(23,22,26,0.08)]">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-warning-50 text-warning-600">
          <CircleAlert size={20} strokeWidth={1.7} />
        </span>
        <h1 className="mt-3 text-[19px] font-extrabold tracking-tight text-ink-900">화면을 불러오지 못했습니다</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-600">
          일시적인 오류일 수 있습니다. 잠시 후 다시 시도해 주세요. 문제가 계속되면 고객센터로 알려 주세요.
        </p>
        {error?.digest ? (
          <p className="mt-2 text-[12px] text-ink-500">오류 번호: {error.digest}</p>
        ) : null}

        {SHOW_DEV_DIAGNOSTICS ? (
          <div className="mt-4 rounded-xl border border-dashed border-ink-200 bg-ink-50 p-3">
            <p className="text-[12px] font-bold text-ink-700">
              개발자용 점검 (로컬 환경에서만 보입니다){looksLikeDb ? ' — 데이터베이스 연결 문제로 보입니다' : ''}
            </p>
            <ol className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed text-ink-700">
              <li>간편 미리보기: 열려 있는 서버 창을 모두 닫고 <strong>1_미리보기실행.bat</strong> 하나만 다시 실행</li>
              <li>별도 PostgreSQL: <strong>도구_DB시작.bat</strong> 실행 후 <strong>도구_최초설치.bat</strong> 로 마이그레이션·시드 확인</li>
              <li>직접 설치한 PostgreSQL: <strong>.env</strong> 의 DATABASE_URL 확인</li>
              <li><strong>도구_환경점검.bat</strong> 으로 원인 자동 점검, 상태는 <a className="underline" href="/api/health">/api/health</a></li>
            </ol>
            {message ? (
              <pre className="mt-2 overflow-x-auto rounded-lg bg-white p-2.5 text-[11.5px] leading-relaxed text-ink-600">
                {message}
              </pre>
            ) : null}
          </div>
        ) : null}

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={reset}
            className="h-11 flex-1 rounded-xl bg-ink-900 px-4 text-[15px] font-semibold text-white hover:bg-ink-800"
          >
            다시 시도
          </button>
          <Link
            href="/"
            className="flex h-11 items-center justify-center rounded-xl border border-ink-200 px-4 text-[15px] font-semibold text-ink-900"
          >
            홈으로
          </Link>
        </div>
      </div>
    </div>
  );
}
