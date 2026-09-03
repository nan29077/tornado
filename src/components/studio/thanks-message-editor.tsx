'use client';

import * as React from 'react';
import { MessageSquareText } from 'lucide-react';
import { Badge, Field, Textarea } from '@/components/ui';
import { SMS_BYTE_LIMIT, smsByteLength } from '@/lib/sms';

/**
 * 크리에이터가 직접 쓰는 후원 감사 문자 편집기.
 *
 * 왜 글자 수만으로는 부족한가
 * ---------------------------
 * 문자는 글자 수가 아니라 **바이트**로 SMS(단문)/LMS(장문)가 갈린다. 한글 한 자가 2바이트라
 * 100자만 넘어도 장문이 되고 건당 요금이 3~4배가 된다. 감사 문자는 **후원 한 건마다** 나가므로
 * 여기서 몇 자를 더 쓰느냐가 곧 원가다. 장문 자체는 허용하되(운영 결정), 크리에이터가
 * 모르고 넘어가는 일은 없도록 지금 어느 쪽인지 계속 보여 준다.
 *
 * 미리보기는 치환자에 예시 값을 넣은 결과다. 후원자 닉네임이나 메시지가 길면 실제 문자는
 * 이보다 길어질 수 있으므로 경계에 걸친 문구는 단문으로 확신하지 않도록 안내한다.
 */

export interface ThanksVariable {
  token: string;
  label: string;
}

const SENDER_TAG = '[도네이도]';

/** 미리보기용 예시 값. 실제 발송에서 나올 법한 길이로 잡는다. */
const SAMPLES: Record<string, string> = {
  '{후원자}': '구영',
  '{크리에이터}': '도네이도TV',
  '{금액}': '10,000원',
  '{메시지}': '오늘 방송 재밌어요',
  '{누적}': '52,000원',
};

const TOKEN_RE = /\{([^{}\s]{1,12})\}/g;

export function ThanksMessageEditor({
  defaultBody,
  variables,
  maxLength,
  defaultPreview,
}: {
  defaultBody: string;
  variables: ThanksVariable[];
  maxLength: number;
  /** 본문을 비웠을 때 실제로 나가는 문장 (최고관리자 설정이 반영된 값) */
  defaultPreview: string;
}) {
  const [body, setBody] = React.useState(defaultBody);

  const known = React.useMemo(() => new Set(variables.map((v) => v.token.replace(/[{}]/g, ''))), [variables]);

  const unknownTokens = React.useMemo(() => {
    const found = new Set<string>();
    for (const m of body.matchAll(TOKEN_RE)) {
      if (!known.has(m[1])) found.add(m[0]);
    }
    return [...found];
  }, [body, known]);

  const trimmed = body.trim();

  // 비워 두면 최고관리자 문구가 나간다. 그 문장을 그대로 미리보기에 보여 준다.
  const preview = React.useMemo(() => {
    if (trimmed === '') return defaultPreview;
    let out = body;
    for (const v of variables) out = out.split(v.token).join(SAMPLES[v.token] ?? v.token);
    return out.startsWith(SENDER_TAG) ? out : `${SENDER_TAG} ${out}`;
  }, [body, trimmed, variables, defaultPreview]);

  const bytes = smsByteLength(preview);
  const isLms = bytes > SMS_BYTE_LIMIT;

  return (
    <>
      <Field
        label="감사 문자 본문"
        hint={`${maxLength}자 이내. 비워두면 아래 기본 문구로 발송됩니다.`}
      >
        <Textarea
          name="thanksMtMessage"
          rows={4}
          maxLength={maxLength}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={'{후원자}님 감사합니다! {금액} 후원 잘 받았어요. 남겨주신 말: {메시지}'}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={isLms ? 'warning' : 'success'}>{isLms ? 'LMS (장문)' : 'SMS (단문)'}</Badge>
        <span className="text-[11.5px] tabular-nums text-ink-400">
          치환 후 {bytes}바이트 · 단문 기준 {SMS_BYTE_LIMIT}바이트 · {body.length}/{maxLength}자
        </span>
      </div>

      {isLms ? (
        <p className="text-[11.5px] leading-relaxed text-warning-600">
          후원자 이름·금액·메시지가 들어가면 단문 한도를 넘어 <strong>장문(LMS)</strong>으로 발송됩니다. 발송은
          정상적으로 되지만 후원 한 건마다 나가는 문자라 건당 요금이 올라갑니다. 짧게 쓰시려면 {'{메시지}'} 나
          {' {누적}'} 을 빼는 것이 가장 효과가 큽니다.
        </p>
      ) : (
        <p className="text-[11.5px] leading-relaxed text-ink-400">
          현재는 단문(SMS)으로 나갑니다. 후원자 닉네임이나 메시지가 예시보다 길면 장문으로 넘어갈 수 있습니다.
        </p>
      )}

      {unknownTokens.length > 0 ? (
        <p className="text-[11.5px] leading-relaxed font-semibold text-danger-500">
          {unknownTokens.join(', ')} 는 사용할 수 없는 치환자입니다. 이대로는 저장되지 않습니다.
        </p>
      ) : null}

      <div className="rounded-2xl border border-ink-100 bg-ink-50 px-4 py-3">
        <p className="flex items-center gap-1.5 text-[12.5px] font-extrabold text-ink-900">
          <MessageSquareText size={16} strokeWidth={1.7} className="text-brand-700" />
          사용할 수 있는 치환자
        </p>
        <ul className="mt-2 space-y-1">
          {variables.map((v) => (
            <li key={v.token} className="flex items-center gap-2 text-[12px] text-ink-700">
              <span className="rounded bg-white px-1.5 py-0.5 font-mono text-[11.5px] font-bold text-brand-700">
                {v.token}
              </span>
              {v.label}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="text-[13px] font-bold text-ink-900">
          {trimmed === '' ? '지금 발송되는 문자 (기본 문구)' : '지금 설정으로 발송되는 문자'}
        </p>
        <p className="mt-2 rounded-2xl bg-brand-50 px-4 py-3 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-900">
          {preview}
        </p>
      </div>
    </>
  );
}
