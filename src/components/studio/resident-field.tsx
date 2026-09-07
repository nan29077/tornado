'use client';

import * as React from 'react';
import { Input, Notice } from '@/components/ui';

/**
 * 정산 요청 시 원천징수 신고용 주민등록번호 입력.
 *
 * - 원천징수 전용이며 신고 후 파기한다는 안내를 반드시 노출한다.
 * - 이미 등록해 둔(파기 전) 번호가 있으면 재입력 없이 재사용하고, "변경" 시에만 새로 입력받는다.
 * - 화면에는 원문을 두지 않고, 서버에서 암호화 저장 + 마스킹만 보관한다.
 * - 앞·뒤 칸을 합친 13자리를 숨은 입력칸에 다시 담지 않는다.
 *   숨은 칸에 담으면 뒤 7자리를 가려 둔 의미가 사라지고(개발자 도구·확장 프로그램·
 *   브라우저 자동완성이 그대로 읽는다) 전체 번호가 DOM 에 한 번 더 남는다.
 *   앞·뒤를 각각 보내고 서버에서 합친다.
 */
export function ResidentField({ priorMasked }: { priorMasked: string | null }) {
  const [editing, setEditing] = React.useState(!priorMasked);
  const [front, setFront] = React.useState('');
  const [back, setBack] = React.useState('');

  return (
    <div className="rounded-2xl border border-ink-100 bg-ink-50/60 p-4">
      <p className="text-[13px] font-extrabold text-ink-900">주민등록번호 (원천징수 신고용)</p>

      {!editing && priorMasked ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="rounded-lg border border-ink-200 bg-white px-3 py-2 font-mono text-[14px] tracking-wide text-ink-700">
            {priorMasked}
          </span>
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              setFront('');
              setBack('');
            }}
            className="rounded-lg border border-ink-200 px-3 py-2 text-[12px] font-bold text-ink-600 hover:bg-white"
          >
            변경
          </button>
        </div>
      ) : (
        <>
          <div className="mt-2 flex items-center gap-2">
            <Input
              inputMode="numeric"
              maxLength={6}
              name="residentFront"
              value={front}
              onChange={(e) => setFront(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="앞 6자리"
              className="w-28 text-center tabular-nums tracking-widest"
              autoComplete="off"
            />
            <span className="text-ink-300">-</span>
            <Input
              inputMode="numeric"
              maxLength={7}
              name="residentBack"
              type="password"
              value={back}
              onChange={(e) => setBack(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="뒤 7자리"
              className="w-32 text-center tabular-nums tracking-widest"
              autoComplete="off"
            />
            {priorMasked ? (
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-lg border border-ink-200 px-3 py-2 text-[12px] font-bold text-ink-500 hover:bg-white"
              >
                취소
              </button>
            ) : null}
          </div>
          <label className="mt-3 flex cursor-pointer items-start gap-2 text-[12.5px] leading-relaxed text-ink-600">
            <input type="checkbox" name="residentAgree" className="mt-0.5 h-4 w-4 accent-brand-400" />
            <span>
              주민등록번호 수집·이용에 동의합니다. (소득세법에 따른 원천징수 신고 목적, 신고 완료 후 즉시 파기)
            </span>
          </label>
        </>
      )}

      <div className="mt-3">
        <Notice tone="brand" title="주민등록번호는 원천징수 신고 목적으로만 사용됩니다">
          입력하신 주민등록번호는 소득세법에 따른 원천징수 신고에만 사용되며, <strong>신고 완료 후 즉시 파기</strong>됩니다.
          암호화되어 저장되고 어떤 화면에도 원문이 표시되지 않으며, 화면에는 마스킹된 값만 보관됩니다. (지급명세서 등
          세법상 보존 대상 서류는 주민등록번호를 제외하고 유지됩니다.)
        </Notice>
      </div>
    </div>
  );
}
