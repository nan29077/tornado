'use client';

import * as React from 'react';
import { CheckCircle2, Send, Hash } from '@/components/brand/icons';
import { Button, Card, CardTitle, Checkbox, Field, Input, LinkButton, Notice, Select, Textarea, Badge } from '@/components/ui';
import { applyCreator, type CreatorApplyState } from '@/app/actions/creator-apply';
import { ChannelRowsEditor } from './channel-rows-editor';
import { VIDEO_CATEGORIES } from '@/lib/video-hub';

const initial: CreatorApplyState = { ok: false };

const STATUS_TEXT: Record<string, string> = {
  PENDING: '심사 대기 중입니다.',
  APPROVED: '이미 승인된 크리에이터 계정입니다.',
  REJECTED: '이전 신청이 반려되었습니다. 고객센터로 문의해 주세요.',
  SUSPENDED: '이용이 정지된 크리에이터 계정입니다. 고객센터로 문의해 주세요.',
};



export function CreatorApplyForm({
  loggedIn,
  sessionEmail,
  mockMode = false,
}: {
  loggedIn: boolean;
  sessionEmail?: string | null;
  /** 결제·문자 발송이 모의 상태일 때만 안내를 보여 준다. */
  mockMode?: boolean;
}) {
  const [state, formAction, pending] = React.useActionState(applyCreator, initial);
  const [isBusiness, setIsBusiness] = React.useState(false);

  // ------------------------------------------------------------ 신청 완료 화면
  if (state.ok && state.code) {
    return <ApplyDone code={state.code} displayName={state.displayName} mockMode={mockMode} />;
  }

  // ------------------------------------------------------------ 기신청 안내
  if (state.alreadyStatus && state.code) {
    return (
      <Card>
        <CardTitle>이미 신청 이력이 있습니다</CardTitle>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
          {STATUS_TEXT[state.alreadyStatus] ?? '신청 상태를 확인해 주세요.'}
        </p>
        <div className="mt-4 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3">
          <p className="text-[12px] font-semibold text-brand-700">크리에이터 코드</p>
          <p className="mt-1 font-mono text-[18px] font-extrabold tracking-[0.1em] text-ink-900">{state.code}</p>
        </div>
        <LinkButton href="/support" variant="secondary" size="md" className="mt-4 w-full">
          고객센터 문의
        </LinkButton>
      </Card>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <Card className="space-y-4">
        <CardTitle>크리에이터 정보</CardTitle>

        <Field label="표시명" required hint="후원 페이지와 방송 알림에 표시되는 이름입니다.">
          <Input name="displayName" required maxLength={30} defaultValue={state.values?.displayName} placeholder="바람소리" />
        </Field>

        <Field label="활동 카테고리" hint="영상 허브와 도네이도 샵에서 분류에 쓰입니다.">
          <Select name="contentCategory" defaultValue={state.values?.contentCategory ?? ''}>
            <option value="">선택 안 함</option>
            {VIDEO_CATEGORIES.filter((c) => c.slug !== 'all' && c.slug !== 'donaido').map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="소개" hint="후원 페이지에 표시할 짧은 소개입니다. (300자 이내)">
          <Textarea name="description" rows={4} maxLength={300} defaultValue={state.values?.description} placeholder="문자 한 통으로 응원을 보내주세요." />
        </Field>
      </Card>

      <Card className="space-y-3">
        <div>
          <CardTitle>운영 채널</CardTitle>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
            운영 중인 채널을 모두 등록해 주세요. 플랫폼, 채널 주소, 구독자·팔로워 수는 심사에 쓰이고, 승인 후 도네이도 샵 영상에도
            연결됩니다. 대표 채널 1개를 지정해 주세요.
          </p>
        </div>
        <ChannelRowsEditor />
      </Card>

      <Card className="space-y-4">
        <CardTitle>연락 및 정산 정보</CardTitle>

        <Field
          label="연락 이메일"
          required
          hint={loggedIn ? '심사 결과를 받을 이메일입니다.' : '이 이메일이 로그인 계정으로 사용됩니다.'}
        >
          <Input
            name="contactEmail"
            type="email"
            required
            inputMode="email"
            autoComplete="email"
            defaultValue={state.values?.contactEmail ?? sessionEmail ?? ''}
            placeholder="creator@example.com"
          />
        </Field>

        <Field label="사업자 여부" required>
          <Select
            name="isBusinessSelect"
            value={isBusiness ? 'Y' : 'N'}
            onChange={(e) => setIsBusiness(e.target.value === 'Y')}
          >
            <option value="N">개인 (사업자 아님)</option>
            <option value="Y">개인사업자 · 법인사업자</option>
          </Select>
        </Field>
        {/* Select 값을 서버 액션에 체크박스 형태로 전달 */}
        <input type="hidden" name="isBusiness" value={isBusiness ? 'on' : ''} />

        {isBusiness ? (
          <Field label="사업자등록번호" required hint="숫자 10자리를 입력해 주세요.">
            <Input
              name="businessNo"
              inputMode="numeric"
              maxLength={20}
              defaultValue={state.values?.businessNo}
              placeholder="1234567890"
            />
          </Field>
        ) : (
          <p className="text-[12px] leading-relaxed text-ink-400">
            개인으로 신청하면 정산 시 소득세 원천징수가 적용됩니다. 사업자는 승인 후 증빙 서류 확인이 필요합니다.
          </p>
        )}
      </Card>

      {!loggedIn ? (
        <Card className="space-y-4">
          <div>
            <CardTitle>로그인 계정 만들기</CardTitle>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
              입력한 연락 이메일로 도네이도 회원 계정이 만들어지고 자동으로 로그인됩니다. 승인되면 크리에이터 계정으로 바뀝니다.
            </p>
          </div>
          <Field label="비밀번호" required hint="8자 이상 입력해 주세요.">
            <Input type="password" name="password" required minLength={8} autoComplete="new-password" />
          </Field>
          <Field label="비밀번호 확인" required>
            <Input type="password" name="passwordConfirm" required minLength={8} autoComplete="new-password" />
          </Field>
        </Card>
      ) : (
        <Notice tone="brand">
          현재 로그인된 계정으로 신청합니다. 다른 계정으로 신청하려면 로그아웃 후 다시 시도해 주세요.
        </Notice>
      )}

      <Card>
        <Checkbox
          name="agree"
          label="크리에이터 이용 조건과 개인정보 수집·이용에 동의합니다. (필수)"
          description="심사 과정에서 채널 운영 정보와 본인 확인 자료를 요청할 수 있습니다."
        />
      </Card>

      {state.message ? <Notice tone="warning">{state.message}</Notice> : null}

      <Button type="submit" size="lg" disabled={pending}>
        {pending ? '신청 중' : '가입 신청하기'}
        <Send size={16} strokeWidth={1.7} />
      </Button>
    </form>
  );
}

function ApplyDone({ code, displayName, mockMode }: { code: string; displayName?: string; mockMode: boolean }) {
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-success-50 text-success-600">
            <CheckCircle2 size={18} strokeWidth={1.7} />
          </span>
          <div>
            <CardTitle>가입 신청이 접수되었습니다</CardTitle>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
              {displayName ? `${displayName} 님의 ` : ''}신청이 심사 대기 상태로 등록되었습니다. 승인 결과는 등록한
              이메일로 안내드립니다.
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-brand-200 bg-brand-50 px-4 py-4 text-center">
          <p className="flex items-center justify-center gap-1.5 text-[12px] font-semibold text-brand-700">
            <Hash size={14} strokeWidth={1.8} />
            크리에이터 코드
          </p>
          <p className="mt-1.5 font-mono text-[26px] font-extrabold tracking-[0.12em] text-ink-900">{code}</p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-ink-500">
            승인 후 시청자가 이 코드로 후원 페이지에 접속할 수 있습니다.
          </p>
        </div>
      </Card>

      <Card>
        <div className="mb-2 flex items-center gap-2">
          <CardTitle>다음 단계</CardTitle>
          <Badge tone="warning">심사 대기</Badge>
        </div>
        <ol className="space-y-2.5 text-[13px] leading-relaxed text-ink-700">
          <li>
            <span className="font-bold text-ink-900">1. 관리자 심사</span>
            <br />
            채널 운영 정보와 신청 내용을 확인합니다.
          </li>
          <li>
            <span className="font-bold text-ink-900">2. MO 후원 번호 배정</span>
            <br />
            문자 수신 번호는 관리자 승인 이후에 배정됩니다. 승인 전에는 후원 페이지가 공개되지 않고 문자후원도 접수되지
            않습니다.
          </li>
          <li>
            <span className="font-bold text-ink-900">3. 방송 연동 설정</span>
            <br />
            승인되면 같은 계정이 크리에이터 계정으로 바뀌고, 크리에이터 스튜디오에서 도네이도 샵·유튜브 연동·오버레이·정산을
            설정합니다. 심사 중에도 일반회원 기능(마이페이지·후원)은 그대로 쓸 수 있습니다.
          </li>
        </ol>
      </Card>

      {mockMode ? (
        <Notice tone="warning" title="테스트(모의) 모드 안내">
          도네이도는 현재 테스트(모의) 모드로 실제 문자 발송과 결제는 이루어지지 않습니다. 승인 및 번호 배정 일정은
          별도로 안내드립니다.
        </Notice>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <LinkButton href="/my/creator" variant="primary" size="md" className="w-full">
          신청 상태 보기
        </LinkButton>
        <LinkButton href="/support" variant="secondary" size="md" className="w-full">
          고객센터 문의
        </LinkButton>
      </div>
    </div>
  );
}
