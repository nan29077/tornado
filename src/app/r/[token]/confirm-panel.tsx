'use client';

import * as React from 'react';
import { CircleCheck, CircleX, Clock, ShieldCheck } from 'lucide-react';
import { Button, Card, DataRow, Field, Input, Notice } from '@/components/ui';
import { confirmDonationAction, updateDonorNicknameAction, type ConfirmActionResult } from '@/app/actions/confirm';
import { checkDonorName, DONOR_NAME_MAX, isDefaultDonorName } from '@/lib/donor-name';
import { SNS_PLATFORMS, type SnsPlatform, SnsPlatformSelector } from '@/components/shared/sns-platform-selector';

/**
 * 문자후원 결제 확인 화면.
 * - 남은 유효시간을 카운트다운으로 표시한다.
 * - 확인 버튼은 1회만 눌리며, 서버에서도 1회용 보안링크로 중복 결제를 막는다.
 * - PIN 입력 전 SNS 닉네임을 선택 입력할 수 있다 (미등록자는 항상 노출, 등록자는 기존 값 표시 후 수정 허용).
 */

export function ConfirmPanel({
  token,
  creatorName,
  amountText,
  buttonText,
  message,
  expiresAtIso,
  donorId,
  donorNickname,
  donorSnsPlatform,
}: {
  token: string;
  creatorName: string;
  amountText: string;
  buttonText: string;
  message: string;
  expiresAtIso: string;
  donorId?: string;
  /** 기존에 저장된 닉네임 (없으면 undefined) */
  donorNickname?: string;
  /** 기존에 저장된 SNS 플랫폼 (없으면 undefined) */
  donorSnsPlatform?: string;
}) {
  const expiresAt = React.useMemo(() => new Date(expiresAtIso).getTime(), [expiresAtIso]);
  const [remainMs, setRemainMs] = React.useState(() => Math.max(0, expiresAt - Date.now()));
  const [pending, startTransition] = React.useTransition();
  const [result, setResult] = React.useState<ConfirmActionResult | null>(null);
  const submitted = React.useRef(false);

  // 닉네임 필드: 기존 값이 기본값(후원자XXXX)이면 비워두고, 직접 입력한 값이면 표시
  const hasRealNickname = donorNickname && !isDefaultDonorName(donorNickname);
  const [nickname, setNickname] = React.useState(hasRealNickname ? donorNickname : '');
  const [snsPlatform, setSnsPlatform] = React.useState<SnsPlatform | ''>(
    (donorSnsPlatform as SnsPlatform) || '',
  );
  const [nicknameError, setNicknameError] = React.useState<string | null>(null);
  const [nicknameSaved, setNicknameSaved] = React.useState(false);

  React.useEffect(() => {
    const id = setInterval(() => setRemainMs(Math.max(0, expiresAt - Date.now())), 500);
    return () => clearInterval(id);
  }, [expiresAt]);

  const expired = remainMs <= 0;
  const mm = String(Math.floor(remainMs / 60000)).padStart(2, '0');
  const ss = String(Math.floor((remainMs % 60000) / 1000)).padStart(2, '0');

  const nameCheck = checkDonorName(nickname);
  const nameErrorDisplay = nickname.trim().length > 1 && !nameCheck.ok ? nameCheck.message : null;

  function submit() {
    if (submitted.current || pending || expired) return;
    submitted.current = true;
    startTransition(async () => {
      // 닉네임 입력값이 있으면 먼저 저장
      if (donorId && nickname.trim()) {
        // donorId 를 서버로 보내지 않는다. 서버가 보안링크 토큰으로 대상을 정한다.
        const res = await updateDonorNicknameAction(token, nickname.trim(), snsPlatform || undefined);
        if (!res.ok) {
          setNicknameError(res.message ?? '닉네임 저장에 실패했습니다.');
          submitted.current = false;
          return;
        }
        setNicknameSaved(true);
      }
      const res = await confirmDonationAction(token);
      setResult(res);
    });
  }

  if (result?.ok) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-success-600">
          <CircleCheck size={20} strokeWidth={1.7} />
          <p className="text-[16px] font-extrabold text-ink-900">후원이 완료되었습니다</p>
        </div>
        <div className="mt-3">
          <DataRow label="크리에이터" value={creatorName} />
          <DataRow label="후원금" value={amountText} />
          {result.transactionNo ? <DataRow label="거래번호" value={result.transactionNo} /> : null}
        </div>
        <div className="mt-3">
          <Notice tone="brand" title="방송 노출 안내">
            결제가 완료된 후원만 방송 오버레이와 유튜브 라이브 채팅에 표시됩니다. 방송이 진행 중이 아니거나 채팅이
            제한된 경우 노출이 지연될 수 있습니다.
          </Notice>
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-ink-400">
          결제 결과는 문자로도 안내됩니다. 후원 취소·환불 문의는 고객센터로 접수해 주세요.
        </p>
      </Card>
    );
  }

  if (result && !result.ok) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-danger-600">
          <CircleX size={20} strokeWidth={1.7} />
          <p className="text-[16px] font-extrabold text-ink-900">후원이 완료되지 않았습니다</p>
        </div>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-700">{result.message}</p>
        <div className="mt-3">
          <Notice tone="warning" title="결제되지 않았습니다">
            이 요청으로는 계좌에서 출금이 발생하지 않았으며, 메시지도 방송에 표시되지 않습니다. 다시 후원하시려면
            크리에이터 번호로 문자를 새로 보내주세요.
          </Notice>
        </div>
      </Card>
    );
  }

  const platformLabel = SNS_PLATFORMS.find((p) => p.value === snsPlatform)?.label ?? '';

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex items-center justify-between">
          <p className="text-[13px] font-semibold text-ink-500">후원 확인</p>
          <span className="inline-flex items-center gap-1 rounded-md bg-ink-50 px-2 py-1 text-[12px] font-bold tabular-nums text-ink-700">
            <Clock size={14} strokeWidth={1.7} />
            {expired ? '00:00' : `${mm}:${ss}`}
          </span>
        </div>
        <p className="mt-2 text-[22px] font-extrabold tracking-tight text-ink-900">{amountText}</p>
        <div className="mt-3">
          <DataRow label="크리에이터" value={creatorName} />
          <DataRow label="메시지" value={message || '(내용 없음)'} />
        </div>
      </Card>

      {/* SNS 닉네임 (선택) */}
      {donorId ? (
        <Card>
          <p className="text-[13.5px] font-bold text-ink-900">
            방송에 표시될 닉네임 <span className="font-normal text-ink-400">(선택)</span>
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-500">
            {hasRealNickname
              ? '현재 저장된 닉네임입니다. 수정하거나 그대로 두세요.'
              : '닉네임을 입력하면 방송·채팅에 이름으로 표시됩니다. 입력하지 않으면 번호 끝자리로 표시됩니다.'}
          </p>
          <div className="mt-2.5">
            <SnsPlatformSelector value={snsPlatform} onChange={setSnsPlatform} />
          </div>
          <div className="mt-2">
            <Input
              value={nickname}
              onChange={(e) => {
                setNickname(e.target.value);
                setNicknameError(null);
              }}
              maxLength={DONOR_NAME_MAX + 4}
              placeholder={snsPlatform ? `${platformLabel} 닉네임` : '예: 밤톨이'}
              aria-label="방송에 표시될 닉네임"
            />
          </div>
          {nicknameError ?? nameErrorDisplay ? (
            <p className="mt-1.5 text-[12px] font-semibold text-danger-600">
              {nicknameError ?? nameErrorDisplay}
            </p>
          ) : nicknameSaved ? (
            <p className="mt-1.5 text-[12px] font-semibold text-success-600">닉네임이 저장되었습니다.</p>
          ) : null}
        </Card>
      ) : null}

      {expired ? (
        <Notice tone="warning" title="확인 시간이 지났습니다">
          확인 시간이 지나 후원이 자동 취소되었습니다. 결제는 진행되지 않았습니다. 다시 후원하시려면 크리에이터
          번호로 문자를 새로 보내주세요.
        </Notice>
      ) : (
        <Notice tone="brand" title="확인 시 즉시 출금됩니다">
          아래 버튼을 누르면 등록한 계좌에서 후원금이 출금됩니다. 확인하지 않으면 결제는 진행되지 않습니다.
        </Notice>
      )}

      <Button size="lg" onClick={submit} disabled={expired || pending || Boolean(nameErrorDisplay)}>
        <ShieldCheck size={18} strokeWidth={1.7} />
        {pending ? '처리 중' : buttonText}
      </Button>
    </div>
  );
}
