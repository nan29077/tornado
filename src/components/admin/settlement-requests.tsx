'use client';

import * as React from 'react';
import { Badge, Table, Td, Th, EmptyState, Notice, cx } from '@/components/ui';
import { initialAdminState } from '@/components/admin/state';
import { formatWon } from '@/lib/money';
import {
  bulkUpdateSettlementAction,
  applyPayoutResultsAction,
  fileWithholdingAction,
} from '@/app/actions/admin/settlement';

export interface SettlementRow {
  id: string;
  requestedAt: string;
  status: string;
  statusText: string;
  statusTone: 'warning' | 'brand' | 'success' | 'danger' | 'neutral';
  amount: string;
  withholding: string;
  payoutAmount: string;
  creatorName: string;
  creatorCode: string;
  bank: string | null;
  accountTail4: string | null;
  holderMasked: string | null;
  verified: boolean;
  adminMemo: string | null;
  memo: string | null;
  residentMasked: string | null;
  residentPurged: boolean;
  paidAt: string | null;
  failReason: string | null;
}

const SELECTABLE = new Set(['REQUESTED', 'REVIEWING', 'APPROVED', 'PAID']);

export function SettlementRequestsPanel({ rows }: { rows: SettlementRow[] }) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkState, bulkAction, bulkPending] = React.useActionState(bulkUpdateSettlementAction, initialAdminState);
  const [resultState, resultAction, resultPending] = React.useActionState(applyPayoutResultsAction, initialAdminState);
  const [fileState, fileAction, filePending] = React.useActionState(fileWithholdingAction, initialAdminState);
  /** 마지막으로 제출한 폼. 메시지와 색상은 이 폼의 결과만 보여 준다. */
  const [lastForm, setLastForm] = React.useState<'bulk' | 'result' | 'file' | null>(null);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectableIds = rows.filter((r) => SELECTABLE.has(r.status)).map((r) => r.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(selectableIds));

  const selectedIds = [...selected];
  const approvedSelected = rows.filter((r) => selected.has(r.id) && r.status === 'APPROVED').map((r) => r.id);
  const paidSelected = rows.filter((r) => selected.has(r.id) && r.status === 'PAID').map((r) => r.id);

  const hidden = (ids: string[]) =>
    ids.map((id) => <input key={id} type="hidden" name="requestId" value={id} />);

  const payoutUrl =
    approvedSelected.length > 0 ? `/api/admin/settlements/payout?ids=${approvedSelected.join(',')}` : null;

  const lastState = lastForm === 'bulk' ? bulkState : lastForm === 'result' ? resultState : lastForm === 'file' ? fileState : null;
  const anyMsg = lastState?.message ?? null;
  const anyOk = Boolean(lastState?.ok);

  const BULK_CONFIRM: Record<string, string> = {
    APPROVE: '선택한 정산 요청을 일괄 승인합니다. 계속할까요?',
    REJECT: '선택한 정산 요청을 일괄 반려합니다. 계속할까요?',
    PAY: '선택한 승인 건을 지급 완료로 처리합니다. 원장에 지급·원천징수 분개가 기록되며 되돌릴 수 없습니다. 계속할까요?',
  };

  return (
    <div className="space-y-3">
      {/* 지급대행 운영 툴바 */}
      <div className="rounded-2xl border border-ink-100 bg-white p-3.5 shadow-[0_8px_24px_rgba(23,22,26,0.05)]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-bold text-ink-700">선택 {selectedIds.length}건</span>

          {/* 일괄 승인/반려/지급 */}
          <form
            action={bulkAction}
            onSubmit={(e) => {
              const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
              const message = BULK_CONFIRM[submitter?.value ?? ''];
              if (message && !window.confirm(message)) {
                e.preventDefault();
                return;
              }
              setLastForm('bulk');
            }}
            className="flex flex-wrap items-center gap-1.5"
          >
            {/*
              승인/반려는 선택 전체를, 지급완료는 승인 건만 보낸다.
              예전에는 항상 선택 전체를 보내면서 버튼에는 승인 건수만 표시해,
              "일괄 지급완료 (3)" 을 눌러도 8건이 전송되고 5건이 오류로 되돌아왔다.
            */}
            {hidden(selectedIds)}
            <input
              name="memo"
              placeholder="반려/처리 사유"
              className="h-8 w-40 rounded-lg border border-ink-200 px-2 text-[12px] outline-none focus:border-brand-400"
            />
            <button
              name="bulkAction"
              value="APPROVE"
              disabled={bulkPending || selectedIds.length === 0}
              className="h-8 rounded-lg bg-brand-400 px-3 text-[12px] font-bold text-ink-900 disabled:opacity-50"
            >
              일괄 승인
            </button>
            <button
              name="bulkAction"
              value="REJECT"
              disabled={bulkPending || selectedIds.length === 0}
              className="h-8 rounded-lg border border-danger-500 px-3 text-[12px] font-bold text-danger-500 disabled:opacity-50"
            >
              일괄 반려
            </button>
            <button
              name="bulkAction"
              value="PAY"
              disabled={bulkPending || approvedSelected.length === 0}
              className="h-8 rounded-lg bg-ink-900 px-3 text-[12px] font-bold text-white disabled:opacity-50"
              title="승인 상태만 지급 완료됩니다"
            >
              일괄 지급완료 ({approvedSelected.length})
            </button>
          </form>

          <span className="mx-1 hidden h-5 w-px bg-ink-100 sm:block" />

          {/* 지급대행 파일 다운로드 (승인 건) */}
          <a
            href={payoutUrl ?? '#'}
            aria-disabled={!payoutUrl}
            onClick={(e) => {
              if (!payoutUrl) e.preventDefault();
            }}
            className={cx(
              'flex h-8 items-center rounded-lg border border-ink-200 px-3 text-[12px] font-bold text-ink-700',
              !payoutUrl && 'pointer-events-none opacity-50',
            )}
          >
            지급대행 파일 받기 ({approvedSelected.length})
          </a>

          {/* 원천징수 신고 완료 + 주민번호 파기 (지급완료 건) */}
          <form
            action={fileAction}
            onSubmit={(e) => {
              // 이 툴바에서 **유일하게 복구가 불가능한** 작업이다.
              // 전체 선택 체크박스로 PAID 건이 한꺼번에 잡히므로 오클릭 피해 범위가 페이지 전체다.
              if (
                !window.confirm(
                  `선택한 ${paidSelected.length}건의 주민등록번호를 영구 파기합니다.\n` +
                    '원천징수 신고를 마친 뒤에만 실행하세요. 파기하면 되돌릴 수 없고, 재신고가 필요하면 크리에이터에게 다시 받아야 합니다.\n\n계속할까요?',
                )
              ) {
                e.preventDefault();
                return;
              }
              setLastForm('file');
            }}
            className="inline"
          >
            {hidden(paidSelected)}
            <button
              disabled={filePending || paidSelected.length === 0}
              className="h-8 rounded-lg border border-ink-200 px-3 text-[12px] font-bold text-ink-700 disabled:opacity-50"
              title="지급완료 건의 주민등록번호를 파기합니다"
            >
              원천징수 신고·주민번호 파기 ({paidSelected.length})
            </button>
          </form>
        </div>

        {anyMsg ? (
          <p className={cx('mt-2 text-[12px]', anyOk ? 'text-success-500' : 'text-danger-500')}>
            {anyMsg}
          </p>
        ) : null}
      </div>

      {/* 지급대행 결과 반영 */}
      <details className="rounded-2xl border border-ink-100 bg-white p-3.5">
        <summary className="cursor-pointer text-[12.5px] font-bold text-ink-700">지급대행 결과 반영 (파일 내용 붙여넣기)</summary>
        <form
          action={resultAction}
          onSubmit={(e) => {
            if (
              !window.confirm(
                '붙여넣은 결과를 지급완료/지급실패로 반영합니다.\n원장에 분개가 기록되며 되돌릴 수 없습니다.\n\n배치번호가 이번에 내려받은 이체파일의 것인지 다시 확인해 주세요. 계속할까요?',
              )
            ) {
              e.preventDefault();
              return;
            }
            setLastForm('result');
          }}
          className="mt-2.5 space-y-2"
        >
          <p className="text-[11.5px] leading-relaxed text-ink-400">
            각 줄에 <code className="rounded bg-ink-50 px-1">요청ID,SUCCESS|FAIL,사유</code> 형식으로 입력합니다. 지급대행(쿠콘)
            결과 파일을 그대로 붙여넣어 성공/실패를 한 번에 반영할 수 있습니다.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              name="batchNo"
              required
              pattern="B[A-Za-z0-9]{6,20}"
              placeholder="배치번호 (예: B7K2M9X4QP)"
              className="h-8 w-56 rounded-lg border border-ink-200 px-2 font-mono text-[12px] outline-none focus:border-brand-400"
            />
            <span className="text-[11px] text-ink-400">
              <strong>필수.</strong> 이체파일을 내려받을 때 안내된 배치번호를 넣으면 그 배치 건에만 반영됩니다.
              지난 파일을 잘못 다시 붙여넣어 <strong>정상 지급건이 실패로 되돌아가는 사고</strong>를 막습니다.
            </span>
          </div>
          <textarea
            name="results"
            rows={4}
            placeholder={'01ABC...,SUCCESS\n01DEF...,FAIL,잔액부족'}
            className="w-full rounded-xl border border-ink-200 px-3 py-2 font-mono text-[12px] outline-none focus:border-brand-400"
          />
          <button
            disabled={resultPending}
            className="h-9 rounded-xl bg-ink-900 px-4 text-[12px] font-bold text-white disabled:opacity-50"
          >
            결과 반영
          </button>
        </form>
      </details>

      <Notice tone="neutral">
        지급대행 흐름: <strong>요청 선택 → 일괄 승인 → 지급대행 파일 받기 → 쿠콘에서 이체 실행 → 결과 반영</strong>. 지급이
        완료되면 원장에 지급·원천징수 분개가 기록되고, 신고 후 주민등록번호를 파기합니다.
      </Notice>

      {rows.length === 0 ? (
        <EmptyState title="조건에 맞는 정산 요청이 없습니다" />
      ) : (
      <Table className="min-w-[1200px]">
        <thead>
          <tr>
            <Th>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="전체 선택" className="h-4 w-4 accent-brand-400" />
            </Th>
            <Th>요청 시각</Th>
            <Th>크리에이터</Th>
            <Th>정산 계좌</Th>
            <Th className="text-right">요청 금액</Th>
            <Th className="text-right">원천징수</Th>
            <Th className="text-right">실지급</Th>
            <Th>주민번호</Th>
            <Th>상태</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={selected.has(r.id) ? 'bg-brand-50/40' : undefined}>
              <Td>
                {SELECTABLE.has(r.status) ? (
                  <input
                    type="checkbox"
                    checked={selected.has(r.id)}
                    onChange={() => toggle(r.id)}
                    aria-label={`${r.creatorName} 선택`}
                    className="h-4 w-4 accent-brand-400"
                  />
                ) : null}
              </Td>
              <Td className="whitespace-nowrap">{r.requestedAt}</Td>
              <Td>
                <span className="font-semibold text-brand-700">{r.creatorName}</span>
                <span className="mt-0.5 block text-[11px] text-ink-400">{r.creatorCode}</span>
              </Td>
              <Td className="text-[12px]">
                {r.bank ? (
                  <>
                    <span className="block">
                      {r.bank} ****{r.accountTail4}
                    </span>
                    <span className="block text-ink-400">{r.holderMasked}</span>
                    <Badge tone={r.verified ? 'success' : 'warning'}>{r.verified ? '인증 완료' : '미인증'}</Badge>
                  </>
                ) : (
                  <Badge tone="danger">계좌 미등록</Badge>
                )}
              </Td>
              <Td className="text-right tabular-nums">{formatWon(BigInt(r.amount))}</Td>
              <Td className="text-right tabular-nums">{formatWon(BigInt(r.withholding))}</Td>
              <Td className="text-right font-semibold tabular-nums">{formatWon(BigInt(r.payoutAmount))}</Td>
              <Td className="text-[12px]">
                {r.residentPurged ? (
                  <Badge tone="neutral">파기됨</Badge>
                ) : r.residentMasked ? (
                  <span className="font-mono text-ink-500">{r.residentMasked}</span>
                ) : (
                  <span className="text-ink-300">-</span>
                )}
              </Td>
              <Td>
                <Badge tone={r.statusTone}>{r.statusText}</Badge>
                {r.failReason ? (
                  <span className="mt-0.5 block max-w-[140px] break-words text-[11px] text-danger-500">{r.failReason}</span>
                ) : null}
                {r.adminMemo ? (
                  <span className="mt-0.5 block max-w-[140px] break-words text-[11px] text-ink-400">{r.adminMemo}</span>
                ) : null}
                {r.paidAt ? <span className="mt-0.5 block text-[11px] text-success-500">지급 {r.paidAt}</span> : null}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      )}
    </div>
  );
}
