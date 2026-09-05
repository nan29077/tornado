'use client';

import * as React from 'react';
import { CreditCard, ShieldCheck } from 'lucide-react';
import { Button, Card, CardTitle, Checkbox, Field, Input, Notice } from '@/components/ui';
import { registerCardBillKeyAction } from '@/app/actions/card-registration';
import { checkDonorName, DONOR_NAME_MAX } from '@/lib/donor-name';
import type { TermsItem } from './register-form';

/**
 * 카드 빌키 등록 폼 (코엠페이먼츠 DIRECTPAY).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **PCI-DSS 주의**
 *
 * 코엠은 호스팅 결제창이 없는 화이트리스트 방식이라 카드번호를 이 화면에서 직접 받는다.
 * 이 컴포넌트가 지키는 규칙
 *  1. 카드번호·비밀번호·생년월일을 **제출 직후 즉시 상태에서 비운다.**
 *  2. `autoComplete="off"`, `name` 미지정으로 브라우저 자동완성·저장을 막는다.
 *  3. 비밀번호·생년월일은 `type="password"` 로 화면에도 남기지 않는다.
 *  4. 콘솔·에러 메시지에 입력값을 넣지 않는다.
 *  5. localStorage·sessionStorage 에 저장하지 않는다.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** 4자리씩 끊어 보여 준다. 저장이 아니라 표시용이다. */
function formatCardNo(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 16);
  return digits.replace(/(.{4})/g, '$1 ').trim();
}

function formatExpiry(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 4);
  return digits.length <= 2 ? digits : `${digits.slice(0, 2)}/${digits.slice(2)}`;
}

export function CardRegisterForm({
  token,
  terms,
  defaultName,
}: {
  token: string;
  terms: TermsItem[];
  defaultName: string;
}) {
  const required = terms.filter((t) => t.required);

  const [agreed, setAgreed] = React.useState<Record<string, boolean>>({});
  const [cardNo, setCardNo] = React.useState('');
  const [expiry, setExpiry] = React.useState('');
  const [buyerName, setBuyerName] = React.useState('');
  const [cardPw, setCardPw] = React.useState('');
  const [cardSsn, setCardSsn] = React.useState('');
  const [nickname, setNickname] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<{ issuer: string | null; tail4: string | null } | null>(null);
  const [pending, startTransition] = React.useTransition();

  const allRequiredAgreed = required.length > 0 && required.every((t) => agreed[t.type]);
  const cardDigits = cardNo.replace(/\D/g, '');
  const expiryDigits = expiry.replace(/\D/g, '');
  const nameCheck = checkDonorName(nickname);
  const nameError = nickname.trim().length > 1 && !nameCheck.ok ? nameCheck.message : null;

  const canSubmit =
    allRequiredAgreed &&
    cardDigits.length >= 15 &&
    expiryDigits.length === 4 &&
    buyerName.trim().length > 0 &&
    !pending;

  /** 카드정보를 상태에서 지운다. 성공·실패 모두에서 부른다. */
  function clearCardFields() {
    setCardNo('');
    setExpiry('');
    setCardPw('');
    setCardSsn('');
  }

  function submit() {
    if (!canSubmit) return;
    if (nickname.trim().length > 0 && !nameCheck.ok) {
      setError(nameCheck.message ?? '닉네임을 다시 입력해 주세요.');
      return;
    }
    setError(null);

    // 전송할 값만 지역 변수로 복사하고 상태는 즉시 비운다.
    const payload = {
      token,
      consents: terms.map((t) => ({ type: t.type as never, agreed: Boolean(agreed[t.type]) })),
      cardNo: cardDigits,
      expiry,
      buyerName: buyerName.trim(),
      cardPw: cardPw || undefined,
      cardSsn: cardSsn || undefined,
      nickname: nickname.trim() || undefined,
    };
    clearCardFields();

    startTransition(async () => {
      const res = await registerCardBillKeyAction(payload);
      if (!res.ok) {
        setError(res.message ?? '카드 등록에 실패했습니다.');
        return;
      }
      setDone({ issuer: res.cardIssuer ?? null, tail4: res.cardTail4 ?? null });
    });
  }

  if (done) {
    return (
      <Card>
        <div className="mb-2 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-success-50 text-success-600">
            <ShieldCheck size={17} strokeWidth={1.7} />
          </span>
          <CardTitle>카드 등록이 완료되었습니다</CardTitle>
        </div>
        <p className="text-[13px] leading-relaxed text-ink-700">
          {done.issuer ?? '카드'} {done.tail4 ? `(끝 4자리 ${done.tail4})` : ''} 로 후원 결제가 준비되었습니다.
          카드번호는 저장되지 않으며, 다음 후원부터 문자로 안내된 링크에서 바로 결제됩니다.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="mb-2 flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-700">
          <CreditCard size={17} strokeWidth={1.7} />
        </span>
        <CardTitle>카드 등록</CardTitle>
      </div>

      <div className="mb-3">
        <Notice tone="neutral" title="카드번호는 저장하지 않습니다">
          입력한 카드번호는 결제사에 전달된 뒤 즉시 폐기되며, 도네이도 서버에는 발급사명과 끝 4자리만
          남습니다. 본인 명의 카드로만 등록해 주세요.
        </Notice>
      </div>

      <div className="space-y-3">
        <Field label="카드번호" hint="숫자만 입력하면 자동으로 끊어 표시됩니다.">
          <Input
            value={cardNo}
            onChange={(e) => setCardNo(formatCardNo(e.target.value))}
            inputMode="numeric"
            autoComplete="off"
            placeholder="0000 0000 0000 0000"
            maxLength={19}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="유효기간" hint="MM/YY">
            <Input
              value={expiry}
              onChange={(e) => setExpiry(formatExpiry(e.target.value))}
              inputMode="numeric"
              autoComplete="off"
              placeholder="12/28"
              maxLength={5}
            />
          </Field>
          <Field label="카드 소유자명">
            <Input
              value={buyerName}
              onChange={(e) => setBuyerName(e.target.value)}
              autoComplete="off"
              placeholder="홍길동"
              maxLength={30}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="비밀번호 앞 2자리" hint="선택 입력">
            <Input
              type="password"
              value={cardPw}
              onChange={(e) => setCardPw(e.target.value.replace(/\D/g, '').slice(0, 2))}
              inputMode="numeric"
              autoComplete="off"
              maxLength={2}
            />
          </Field>
          <Field label="생년월일 6자리" hint="선택 입력 (사업자는 사업자번호 10자리)">
            <Input
              type="password"
              value={cardSsn}
              onChange={(e) => setCardSsn(e.target.value.replace(/\D/g, '').slice(0, 10))}
              inputMode="numeric"
              autoComplete="off"
              maxLength={10}
            />
          </Field>
        </div>

        <Field
          label="방송 닉네임"
          hint={`선택 입력. 비워두면 ${defaultName} 으로 표시됩니다.`}
          error={nameError ?? undefined}
        >
          <Input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            autoComplete="off"
            maxLength={DONOR_NAME_MAX}
          />
        </Field>
      </div>

      <div className="mt-4 space-y-2 border-t border-ink-100 pt-4">
        {terms.map((t) => (
          <Checkbox
            key={t.type}
            checked={Boolean(agreed[t.type])}
            onChange={(e) => setAgreed((prev) => ({ ...prev, [t.type]: e.target.checked }))}
            label={`${t.required ? '[필수]' : '[선택]'} ${t.title}`}
          />
        ))}
      </div>

      {error ? (
        <div className="mt-3">
          <Notice tone="danger">{error}</Notice>
        </div>
      ) : null}

      <div className="mt-4">
        <Button onClick={submit} disabled={!canSubmit} variant="primary" size="md" className="w-full">
          {pending ? '등록 중…' : '카드 등록하기'}
        </Button>
      </div>
    </Card>
  );
}
