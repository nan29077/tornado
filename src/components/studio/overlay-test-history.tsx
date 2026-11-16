'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { RotateCw } from '@/components/brand/icons';
import { Badge, Button, EmptyState, Table, Td, Th } from '@/components/ui';
import type { Tone } from '@/lib/labels';

/**
 * 테스트 전송 내역 (OverlayEvent 중 isTest=true).
 *
 * 규칙
 *  - 이모지를 쓰지 않는다. 아이콘은 lucide-react 라인 아이콘만 사용한다.
 *  - donation 테이블과 완전히 분리된 기록이다. 매출·정산에는 어떤 영향도 없다.
 *  - 표시값은 서버에서 모두 문자열로 만들어 넘긴다(BigInt·Date 를 클라이언트로 넘기지 않는다).
 *  - 테스트를 보낸 뒤 목록을 다시 읽어야 하므로 새로고침 버튼을 둔다.
 */

export interface OverlayTestHistoryRow {
  id: string;
  /** 전송 시각 (KST 포맷 완료) */
  sentAt: string;
  donorName: string;
  /** 금액 (원 단위 포맷 완료) */
  amount: string;
  /** 효과 이름 (한국어 라벨) */
  effect: string;
  /** 구간 이름. 구간을 쓰지 않았으면 빈 문자열 */
  tierLabel: string;
  statusText: string;
  statusTone: Tone;
}

export function OverlayTestHistory({ rows }: { rows: OverlayTestHistoryRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  return (
    <div className="space-y-2.5">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => startTransition(() => router.refresh())}
        >
          <RotateCw size={14} strokeWidth={1.7} />
          {pending ? '불러오는 중' : '새로고침'}
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="테스트 전송 내역이 없습니다"
          description="위에서 테스트 후원을 보내면 이곳에 기록이 남습니다."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>전송 시각</Th>
              <Th>후원자명</Th>
              <Th className="text-right">금액</Th>
              <Th>효과</Th>
              <Th>상태</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <Td className="whitespace-nowrap tabular-nums">{row.sentAt}</Td>
                <Td className="font-semibold text-ink-900">{row.donorName}</Td>
                <Td className="whitespace-nowrap text-right tabular-nums">{row.amount}</Td>
                <Td>
                  {row.effect}
                  {row.tierLabel ? <span className="ml-1.5 text-ink-400">· {row.tierLabel}</span> : null}
                </Td>
                <Td>
                  <Badge tone={row.statusTone}>{row.statusText}</Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
