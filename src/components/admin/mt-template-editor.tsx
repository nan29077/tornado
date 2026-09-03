'use client';

import * as React from 'react';
import { AdminField, AdminTextarea } from '@/components/admin/controls';
import { Badge } from '@/components/ui';

/**
 * MT 문자 본문 편집기.
 *
 * 이 화면에서 저장한 문구가 **그대로 후원자 휴대폰에 찍힌다.** 그런데 기존 화면은
 * 글자 수 상한만 알려 줄 뿐, 저장 전에 확인할 방법이 아무것도 없었다.
 *
 *  - 문자는 글자 수가 아니라 **바이트**로 SMS/LMS 가 갈린다. 한글 한 자가 2바이트라
 *    "90자 이내" 감각으로 쓰면 LMS 로 넘어가 건당 요금이 3~4배가 된다. 실제 바이트를 센다.
 *  - 치환자를 `{금액}` 이 아니라 `{amount}` 나 `[금액]` 으로 잘못 쓰면 치환되지 않고
 *    그 글자가 문자에 그대로 나간다. 알려진 치환자 목록과 대조해 경고한다.
 *  - 값이 들어간 실제 모습(발신 표기 포함)을 미리 보여 준다.
 */

export interface TemplateVariable {
  token: string;
  label: string;
  /** 미리보기에 넣을 예시 값 */
  sample: string;
}

const SENDER_TAG = '[도네이도]';

/** SMS 단문 한계(바이트). 이 값을 넘으면 LMS 로 나간다. */
const SMS_BYTE_LIMIT = 90;

/**
 * EUC-KR 기준 문자 바이트 수. 국내 문자 사업자가 SMS/LMS 를 가르는 기준이다.
 * ASCII 는 1바이트, 그 밖(한글·전각기호·이모지)은 2바이트로 센다.
 */
function smsByteLength(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    bytes += ch.charCodeAt(0) < 128 ? 1 : 2;
  }
  return bytes;
}

const TOKEN_RE = /\{([^{}\s]{1,12})\}/g;
/** 대괄호로 잘못 쓴 치환자를 찾는다. `[보안링크]` 는 시스템이 채우는 자리라 제외한다. */
const BRACKET_RE = /\[([^\][\s]{1,12})\]/g;

export function MtTemplateEditor({
  code,
  defaultBody,
  variables,
  maxLength,
}: {
  code: string;
  defaultBody: string;
  variables: TemplateVariable[];
  maxLength: number;
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

  const bracketTokens = React.useMemo(() => {
    const found = new Set<string>();
    for (const m of body.matchAll(BRACKET_RE)) {
      // 시스템이 채우는 자리와 발신 주체 표기는 정상이다.
      if (m[1] === '보안링크' || m[1] === '도네이도') continue;
      if (known.has(m[1])) found.add(m[0]);
    }
    return [...found];
  }, [body, known]);

  const preview = React.useMemo(() => {
    let out = body;
    for (const v of variables) {
      out = out.split(v.token).join(v.sample);
    }
    out = out.split('[보안링크]').join('https://donaido.kr/r/AB12CD34');
    return out.startsWith(SENDER_TAG) ? out : `${SENDER_TAG} ${out}`;
  }, [body, variables]);

  const bytes = smsByteLength(preview);
  const isLms = bytes > SMS_BYTE_LIMIT;
  const overLength = body.length > maxLength;

  return (
    <>
      <input type="hidden" name="code" value={code} />
      <AdminField
        label="문자 본문"
        hint={`최대 ${maxLength}자. 비우고 저장할 수는 없으며, 기본 문구로 되돌리려면 아래 초기화를 사용하세요.`}
      >
        <AdminTextarea
          name="body"
          rows={5}
          maxLength={maxLength}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </AdminField>

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={isLms ? 'warning' : 'success'}>{isLms ? 'LMS (장문)' : 'SMS (단문)'}</Badge>
        <span className="text-[11px] tabular-nums text-ink-400">
          치환 후 {bytes}바이트 · 단문 기준 {SMS_BYTE_LIMIT}바이트 · {body.length}/{maxLength}자
        </span>
      </div>

      {isLms ? (
        <p className="text-[11px] leading-relaxed text-warning-600">
          치환값이 들어가면 단문 한도를 넘어 장문(LMS)으로 발송됩니다. 건당 요금이 올라가니 의도한 것인지 확인해
          주세요. 금액·닉네임이 길어지면 실제 문자는 이 미리보기보다 더 길어질 수 있습니다.
        </p>
      ) : null}

      {overLength ? (
        <p className="text-[11px] font-semibold text-danger-500">본문이 최대 길이를 넘었습니다.</p>
      ) : null}

      {unknownTokens.length > 0 ? (
        <p className="text-[11px] font-semibold leading-relaxed text-danger-500">
          모르는 치환자 {unknownTokens.join(', ')} 가 있습니다. 이대로 저장하면 값으로 바뀌지 않고 글자 그대로
          발송됩니다.
        </p>
      ) : null}

      {bracketTokens.length > 0 ? (
        <p className="text-[11px] font-semibold leading-relaxed text-danger-500">
          {bracketTokens.join(', ')} 는 대괄호라 치환되지 않습니다. 중괄호(
          {'{ }'})로 바꿔 주세요.
        </p>
      ) : null}

      <div className="rounded-xl border border-ink-100 bg-white p-3">
        <p className="text-[11px] font-semibold text-ink-500">실제 발송 미리보기 (예시 값)</p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-800">{preview}</p>
      </div>
    </>
  );
}
