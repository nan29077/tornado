'use client';
import { useActionState } from 'react';
import { testLogin } from '@/app/actions/auth';

export function DonorTestLogin({ nextPath }: { nextPath: string }) {
  const [state, action, pending] = useActionState(testLogin, {});
  return <form action={action} className="mt-5 rounded-2xl border border-brand-200 bg-brand-50 p-4">
    <input type="hidden" name="account" value="donor" /><input type="hidden" name="next" value={nextPath} />
    <p className="text-xs leading-relaxed text-ink-600">개발·검수 전용 · 테스트 후원자로 화면을 확인합니다. 실제 결제나 문자는 발송되지 않습니다.</p>
    <button disabled={pending} className="mt-3 min-h-12 w-full rounded-xl bg-ink-900 px-4 text-sm font-bold text-white disabled:opacity-50">{pending ? '로그인 중…' : '테스트 후원자로 바로 로그인'}</button>
    {state.message ? <p role="alert" className="mt-2 text-sm text-danger-500">{state.message}</p> : null}
  </form>;
}
