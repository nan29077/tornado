import Link from 'next/link';
import { ChevronRight, Circle, CircleCheck, ListChecks } from 'lucide-react';
import { Card, cx } from '@/components/ui';
import { InlineActionForm } from '@/components/studio/action-form';
import { completeOnboardingStepAction } from '@/app/actions/studio';
import { prisma } from '@/server/db';

/**
 * 신규 크리에이터 온보딩 체크리스트.
 *
 * 대시보드 맨 위에 붙어 "지금 무엇을 더 해야 후원이 방송에 뜨는지" 를 보여준다.
 * 표시된 항목이 모두 끝나면 카드 자체가 사라진다.
 *
 * 판별 방식
 *   1~3) 기존 표(youtube_connection / creator_mo_number / overlay_setting+overlay_tier)로 자동 판별
 *   4~5) 서버가 알 수 없어 크리에이터가 직접 [완료했어요] 로 체크 (creator_profile 플래그)
 *
 * 4번(OBS 등록)은 3번(오버레이 효과 설정)이 끝나야 의미가 있으므로 그 전에는 줄 자체를 숨긴다.
 * 진행률의 분모는 "지금 화면에 보이는 항목 수" 로 맞춰 숨겨진 줄이 카운트에 섞이지 않게 한다.
 */

interface ChecklistItem {
  key: string;
  label: string;
  /** 미완료일 때 무엇을 하면 되는지 한 줄 안내 */
  hint: string;
  done: boolean;
  href: string;
  linkLabel: string;
  /** 크리에이터가 직접 체크하는 항목이면 서버 액션에 넘길 step 값 */
  manualStep?: string;
}

export async function OnboardingChecklist({ creatorId }: { creatorId: string }) {
  const [profile, youtube, moNumber, overlay, account] = await Promise.all([
    prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      select: { onboardingObsLinked: true, onboardingTestDone: true },
    }),
    prisma.youTubeConnection.findUnique({ where: { creatorId }, select: { status: true } }),
    prisma.creatorMoNumber.findFirst({
      where: { creatorId, status: 'ASSIGNED' },
      select: { id: true },
    }),
    prisma.overlaySetting.findUnique({ where: { creatorId }, select: { id: true } }),
    prisma.settlementAccount.findUnique({ where: { creatorId }, select: { verified: true } }),
  ]);

  /**
   * 오버레이 준비 판정은 **URL(설정 행) 발급 여부**만 본다.
   *
   * 예전에는 금액 구간(overlayTier)이 1개 이상 있어야 완료로 쳤고, 안내도 "금액 구간을 최소
   * 한 개 만들어야 효과가 재생됩니다" 였다. 사실이 아니다 — 구간이 없어도 전역 설정으로
   * 효과가 재생된다. 없는 조건을 필수처럼 안내하면 다음 단계로 넘어가지 못한다.
   */
  const overlayReady = Boolean(overlay);

  const items: ChecklistItem[] = [
    {
      key: 'youtube',
      label: '유튜브 채널 연결',
      hint: '후원 메시지를 라이브 채팅으로 보내려면 채널 연결이 필요합니다.',
      done: youtube?.status === 'CONNECTED',
      href: '/studio/youtube',
      linkLabel: '연결하러 가기',
    },
    {
      key: 'moNumber',
      label: '후원 번호 배정',
      hint: '아직 배정된 후원 번호가 없습니다. 관리자에게 문의하세요.',
      done: Boolean(moNumber),
      href: '/support',
      linkLabel: '문의하기',
    },
    {
      key: 'overlay',
      label: '오버레이 URL 발급',
      hint: '방송에 띄울 브라우저 소스 주소를 발급받아야 후원 화면 효과가 재생됩니다. (금액 구간은 선택 사항입니다)',
      done: overlayReady,
      href: '/studio/overlay',
      linkLabel: '설정하러 가기',
    },
  ];

  // OBS 등록은 브라우저 소스 URL 이 발급된 뒤에만 안내한다 (등록할 URL 이 아직 없다).
  // 금액 구간은 선택 사항이므로 URL 발급 여부만 본다.
  if (overlay) {
    items.push({
      key: 'obsLinked',
      label: 'OBS/프리즘에 오버레이 URL 등록',
      hint: '방송 프로그램에 브라우저 소스로 오버레이 URL 을 추가해 주세요.',
      done: profile?.onboardingObsLinked ?? false,
      href: '/studio/overlay',
      linkLabel: 'URL 확인하기',
      manualStep: 'obsLinked',
    });
  }

  items.push({
    key: 'testDone',
    label: '테스트 후원으로 확인',
    hint: '테스트 후원을 보내 방송 화면에 실제로 표시되는지 확인해 주세요.',
    done: profile?.onboardingTestDone ?? false,
    href: '/studio/overlay',
    linkLabel: '테스트 보내기',
    manualStep: 'testDone',
  });

  /**
   * 정산 계좌 등록.
   *
   * 첫 정산까지 가는 경로가 체크리스트 어디에도 없었다. 계좌가 없으면 후원이 아무리
   * 쌓여도 돈을 받을 수 없고, 등록해도 관리자 실명확인 전에는 요청이 막힌다.
   * 그래서 "등록" 과 "실명확인 대기" 를 구분해 안내한다.
   */
  items.push({
    key: 'settlementAccount',
    label: '정산 계좌 등록',
    hint: account
      ? '계좌는 등록되었지만 예금주 실명확인이 끝나지 않아 아직 정산을 요청할 수 없습니다. 확인이 끝나면 알림으로 안내됩니다.'
      : '후원금을 받으려면 정산 계좌를 등록해야 합니다. 등록 후 관리자 실명확인을 거칩니다.',
    done: account?.verified ?? false,
    href: '/studio/settlement?tab=account',
    linkLabel: account ? '계좌 확인하기' : '계좌 등록하기',
  });

  const doneCount = items.filter((i) => i.done).length;
  if (doneCount === items.length) return null;

  return (
    <Card padded={false}>
      <div className="flex items-center justify-between gap-3 border-b border-ink-100 px-4 py-3">
        <p className="flex items-center gap-2 text-[13px] font-bold text-ink-900">
          <ListChecks size={17} strokeWidth={1.7} className="text-brand-700" />
          방송 시작 준비
          <span className="text-[11.5px] font-medium text-ink-400">
            남은 항목을 마치면 이 카드는 사라집니다
          </span>
        </p>
        <span className="shrink-0 text-[12px] font-extrabold tabular-nums text-brand-700">
          {doneCount}/{items.length} 완료
        </span>
      </div>

      <div className="h-1 w-full bg-ink-100">
        <div
          className="h-full bg-brand-700 transition-[width]"
          style={{ width: `${Math.round((doneCount / items.length) * 100)}%` }}
        />
      </div>

      <ul>
        {items.map((item) => (
          <li
            key={item.key}
            className="flex items-start justify-between gap-3 border-b border-ink-100 px-4 py-3 last:border-0"
          >
            <span className="flex min-w-0 items-start gap-2.5">
              {item.done ? (
                <CircleCheck size={17} strokeWidth={1.7} className="mt-0.5 shrink-0 text-success-600" />
              ) : (
                <Circle size={17} strokeWidth={1.7} className="mt-0.5 shrink-0 text-ink-300" />
              )}
              <span className="min-w-0">
                <span
                  className={cx(
                    'block text-[13.5px]',
                    item.done ? 'font-semibold text-ink-300' : 'font-bold text-ink-900',
                  )}
                >
                  {item.label}
                </span>
                {item.done ? null : (
                  <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-500">{item.hint}</span>
                )}
              </span>
            </span>

            {item.done ? null : (
              <span className="flex shrink-0 flex-col items-end gap-1.5">
                <Link
                  href={item.href}
                  className="flex items-center gap-0.5 text-[12.5px] font-semibold text-brand-700 hover:underline"
                >
                  {item.linkLabel}
                  <ChevronRight size={14} strokeWidth={1.8} />
                </Link>
                {item.manualStep ? (
                  <InlineActionForm
                    action={completeOnboardingStepAction}
                    submitLabel="완료했어요"
                    fields={{ step: item.manualStep }}
                  />
                ) : null}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
