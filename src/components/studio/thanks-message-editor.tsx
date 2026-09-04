'use client';

import * as React from 'react';
import { MousePointerClick } from 'lucide-react';
import { Badge, Field, Textarea, cx } from '@/components/ui';
import { SMS_BYTE_LIMIT, smsByteLength } from '@/lib/sms';
import { insertToken } from '@/lib/token-insert';

/**
 * 크리에이터가 직접 쓰는 후원 감사 문자 편집기.
 *
 * 이 화면을 쓰는 사람은 개발자가 아니다
 * -------------------------------------
 * 예전에는 "치환자", "치환 후 27바이트" 처럼 개발 용어를 그대로 내보냈다. 크리에이터는
 * 대부분 일반인이라 이 단어만 보고는 "{후원자} 자리에 실제 이름이 자동으로 들어간다"는
 * 뜻도, "27바이트가 90바이트 중 얼마인지"도 알 수 없었다. 그래서
 *  - 용어를 전부 일상어로 바꾸고,
 *  - 각 항목이 어떤 값으로 바뀌는지 예시를 함께 보여 주고,
 *  - 직접 타이핑하는 대신 버튼으로 넣게 했다.
 *
 * 왜 버튼으로 넣어야 하는가
 * -------------------------
 * 항목은 중괄호 + 한글이라 손으로 치면 `{후원자 }`(공백) `[후원자]`(대괄호)
 * `{후원인}`(오타)처럼 조금만 어긋나도 적용되지 않는다. 버튼으로 넣으면 이 실수가
 * 원천적으로 사라진다. 아래의 "없는 항목입니다" 경고는 그래도 손으로 친 경우를 위한
 * 안전장치로만 남겨 둔다.
 *
 * 왜 길이를 계속 보여 주는가
 * --------------------------
 * 문자는 글자 수가 아니라 **바이트**로 짧은 문자(SMS)/긴 문자(LMS)가 갈리고 건당 요금이
 * 3~4배 차이난다. 감사 문자는 **후원 한 건마다** 나가므로 여기서 몇 자를 더 쓰느냐가 곧
 * 원가다. 장문 자체는 허용하되(운영 결정), 모르고 넘어가는 일은 없도록 지금 어느 쪽인지
 * 계속 보여 준다. 다만 바이트라는 숫자는 일반인에게 의미가 없으므로 **막대와 문장**으로
 * 보여 주고, 정확한 수치는 막대에 마우스를 올렸을 때만 나오게 둔다.
 */

export interface ThanksVariable {
  token: string;
  label: string;
  /** 버튼에 적는 말 (예: "후원한 사람 이름") */
  button: string;
  /** 실제로 이 자리에 채워질 값의 예시 (예: "10,000원") */
  sample: string;
}

const SENDER_TAG = '[도네이도]';

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
  /** 버튼으로 넣으려 했지만 글자 수가 꽉 찼을 때만 잠깐 뜬다. */
  const [full, setFull] = React.useState(false);
  const boxRef = React.useRef<HTMLTextAreaElement>(null);

  const known = React.useMemo(() => new Set(variables.map((v) => v.token.replace(/[{}]/g, ''))), [variables]);

  const unknownTokens = React.useMemo(() => {
    const found = new Set<string>();
    for (const m of body.matchAll(TOKEN_RE)) {
      if (!known.has(m[1])) found.add(m[0]);
    }
    return [...found];
  }, [body, known]);

  const trimmed = body.trim();

  /**
   * 커서가 있던 자리에 항목을 넣는다.
   *
   * 맨 뒤에 붙이면 문장 중간에 넣고 싶을 때 쓸 수 없다. 넣은 뒤에는 커서를 항목 바로
   * 뒤로 옮기고 입력창에 포커스를 돌려주어, 버튼을 누른 뒤 곧바로 이어서 칠 수 있게 한다.
   */
  const insert = React.useCallback(
    (token: string) => {
      const el = boxRef.current;
      const start = el?.selectionStart ?? body.length;
      const end = el?.selectionEnd ?? body.length;
      const result = insertToken(body, start, end, token, maxLength);

      if (result.full) {
        setFull(true);
        return;
      }

      setFull(false);
      setBody(result.body);

      // setBody 로 값이 다시 그려진 뒤에 커서를 옮겨야 한다.
      requestAnimationFrame(() => {
        const box = boxRef.current;
        if (!box) return;
        box.focus();
        box.setSelectionRange(result.caret, result.caret);
      });
    },
    [body, maxLength],
  );

  // 비워 두면 최고관리자 문구가 나간다. 그 문장을 그대로 미리보기에 보여 준다.
  const preview = React.useMemo(() => {
    if (trimmed === '') return defaultPreview;
    let out = body;
    for (const v of variables) out = out.split(v.token).join(v.sample);
    return out.startsWith(SENDER_TAG) ? out : `${SENDER_TAG} ${out}`;
  }, [body, trimmed, variables, defaultPreview]);

  const bytes = smsByteLength(preview);
  const isLong = bytes > SMS_BYTE_LIMIT;
  /** 짧은 문자 한도를 얼마나 썼는지. 넘어가면 100% 로 채운다. */
  const usedPct = Math.min(100, Math.round((bytes / SMS_BYTE_LIMIT) * 100));

  return (
    <>
      <Field
        label="감사 문자 본문"
        hint={`${maxLength}자 이내. 비워두면 아래 기본 문구로 발송됩니다.`}
      >
        <Textarea
          ref={boxRef}
          name="thanksMtMessage"
          rows={4}
          maxLength={maxLength}
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            setFull(false);
          }}
          placeholder={'{후원자}님 감사합니다! {금액} 후원 잘 받았어요. 남겨주신 말: {메시지}'}
        />
      </Field>

      {/* ---------------- 눌러서 넣는 항목 버튼 ---------------- */}
      {/*
        Field 안에 두면 안 된다. Field 는 children 을 <label> 로 감싸므로 버튼을 눌렀을 때
        label 기본 동작으로 포커스가 엉킨다. 그래서 Field 바깥에 따로 둔다.
      */}
      <div className="rounded-2xl border border-ink-100 bg-ink-50 px-4 py-3.5">
        <p className="flex items-center gap-1.5 text-[12.5px] font-extrabold text-ink-900">
          <MousePointerClick size={16} strokeWidth={1.8} className="text-brand-700" />
          눌러서 넣는 항목
        </p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-ink-400">
          아래 버튼을 누르면 커서 자리에 들어갑니다. 문자를 보낼 때 실제 값으로 자동으로 바뀝니다.
        </p>

        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {variables.map((v) => (
            <button
              key={v.token}
              type="button"
              onClick={() => insert(v.token)}
              title={`${v.button} — 예) ${v.sample}`}
              className={cx(
                'inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-ink-200 bg-white px-2.5',
                'text-[12px] font-bold text-ink-700 transition-colors',
                'hover:border-brand-400 hover:bg-brand-50 active:bg-brand-100',
                'focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100',
              )}
            >
              {v.button}
              <span className="font-semibold text-ink-300">예) {v.sample}</span>
            </button>
          ))}
        </div>

        {full ? (
          <p className="mt-2 text-[11.5px] font-semibold text-danger-600">
            글자 수가 꽉 찼습니다. 문장을 조금 줄인 뒤 다시 눌러 주세요.
          </p>
        ) : null}
      </div>

      {/* ---------------- 길이 안내 ---------------- */}
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={isLong ? 'warning' : 'success'}>{isLong ? '긴 문자' : '짧은 문자'}</Badge>
          <span className="text-[11.5px] tabular-nums text-ink-400">{body.length}/{maxLength}자</span>
        </div>

        <div
          className="mt-2 h-2 w-full overflow-hidden rounded-full bg-ink-100"
          title={`짧은 문자 한도의 ${usedPct}% 사용 (정확히는 ${bytes}바이트 / ${SMS_BYTE_LIMIT}바이트)`}
          role="img"
          aria-label={`짧은 문자 한도의 ${usedPct}퍼센트를 썼습니다`}
        >
          <div
            className={cx('h-full rounded-full transition-[width]', isLong ? 'bg-warning-500' : 'bg-success-500')}
            style={{ width: `${usedPct}%` }}
          />
        </div>

        {isLong ? (
          <p className="mt-2 text-[11.5px] leading-relaxed text-warning-600">
            지금 길이면 <strong>긴 문자</strong>로 나갑니다. 발송은 정상적으로 되지만 <strong>문자 요금이 3~4배</strong>가
            됩니다. 이 문자는 후원 한 건마다 나가니 후원이 많아질수록 차이가 커집니다. 줄이시려면{' '}
            <strong>후원자가 남긴 말</strong>이나 <strong>누적 후원 금액</strong>을 빼는 것이 가장 효과가 큽니다.
          </p>
        ) : (
          <p className="mt-2 text-[11.5px] leading-relaxed text-ink-400">
            지금 길이면 <strong className="font-bold text-ink-700">짧은 문자</strong>로 나갑니다. (요금이 가장 쌉니다)
            후원자 이름이나 남긴 말이 예시보다 길면 긴 문자로 넘어갈 수 있어요.
          </p>
        )}
      </div>

      {unknownTokens.length > 0 ? (
        <p className="text-[11.5px] leading-relaxed font-semibold text-danger-600">
          {unknownTokens.join(', ')} 는 없는 항목입니다. 위 버튼에 있는 항목만 쓸 수 있어요. 이대로는 저장되지 않습니다.
        </p>
      ) : null}

      {/* ---------------- 미리보기 ---------------- */}
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
