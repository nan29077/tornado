'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import { env, isLocal } from '@/lib/env';
import { normalizePhone } from '@/lib/crypto';
import { formatMoNumber } from '@/server/emma';
import {
  ensureDevEmmaTables,
  insertDevMo,
  splitForCarrier,
  type MoSplitMode,
} from '@/server/emma/dev-schema';
import { runEmmaMoPolling } from '@/server/services/emma-mo-ingest';
import { moResultLabel, donationStatusLabel } from '@/lib/labels';
import type { AdminActionState } from '@/components/admin/state';
import { run, text, optText } from './shared';

/**
 * EMMA 수신 시뮬레이터 — **로컬 검수 전용**.
 *
 * 기존 MO 시뮬레이터(runMoSimulation)는 handleMoInbound 를 직접 부른다. 그것만으로는
 * **EMMA 경로 자체**(테이블 → 폴러 → 번호 복원 → 도메인)를 검증할 수 없다.
 * 이 액션은 EMMA 가 하는 일을 그대로 흉내낸다.
 *
 *   1) em_mo_log_YYYYMM 에 수신 행을 INSERT   ← EMMA 가 하는 일
 *   2) 폴러를 1회 실행                        ← /api/cron/emma-mo 가 하는 일
 *   3) 번호 복원 결과와 처리 결과를 보여 준다
 *
 * 사업자가 수신번호를 어디서 끊어 보내는지는 계약 후에야 확정된다. 그래서 세 가지 경우를
 * 골라 실행할 수 있게 했고, **어느 것을 골라도 같은 결과가 나와야 정상**이다.
 */
export async function runEmmaSimulation(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    if (!isLocal) throw new Error('이 환경에서는 EMMA 시뮬레이터를 사용할 수 없습니다. (APP_ENV=local 전용)');
    if (!env.emma.enabled) {
      throw new Error('EMMA 연동이 꺼져 있습니다. .env 에 EMMA_ENABLED=true 를 설정한 뒤 서버를 다시 시작해 주세요.');
    }

    const to = text(fd, 'to').replace(/[^0-9]/g, '');
    const fromRaw = text(fd, 'from');
    const content = text(fd, 'content');
    const splitModeRaw = optText(fd, 'splitMode') ?? 'BASE_SUB';
    const splitMode: MoSplitMode = ['BASE_SUB', 'PREFIX_REST', 'WHOLE'].includes(splitModeRaw)
      ? (splitModeRaw as MoSplitMode)
      : 'BASE_SUB';

    if (!to) throw new Error('수신번호를 선택해 주세요.');
    const from = normalizePhone(fromRaw);
    if (!/^01[0-9]{8,9}$/.test(from)) throw new Error('발신 휴대전화번호 형식을 확인해 주세요. (예: 010-1234-5678)');
    if (content.length < 1) throw new Error('문자 내용을 입력해 주세요.');
    if (content.length > 500) throw new Error('문자 내용은 500자 이내로 입력해 주세요.');

    // EMMA 가 아직 만들지 않았을 수 있으므로 테이블부터 확보한다(로컬 전용).
    await ensureDevEmmaTables();

    const inserted = await insertDevMo({ fullNumber: to, from, content, splitMode });

    // 폴러 1회 실행 — 운영에서 /api/cron/emma-mo 가 하는 것과 완전히 같은 코드 경로다.
    const poll = await runEmmaMoPolling();
    const mine = poll.details.find((d) => d.moKey === inserted.moKey);

    const moRow = await prisma.moInboundMessage.findUnique({
      where: { providerMessageId: inserted.moKey },
      select: {
        id: true,
        receivedNumber: true,
        result: true,
        creator: { select: { displayName: true } },
        donation: { select: { transactionNo: true, status: true, amount: true } },
      },
    });

    await writeAudit({
      adminUserId: admin.id,
      action: 'EMMA_SIMULATION_RUN',
      targetType: 'MoInboundMessage',
      targetId: moRow?.id,
      after: {
        moKey: inserted.moKey,
        splitMode,
        moRecipient: inserted.moRecipient,
        emoRecipient: inserted.emoRecipient,
        result: moRow?.result ?? mine?.outcome ?? 'UNKNOWN',
        appEnv: env.appEnv,
      },
    });

    revalidatePath('/admin/simulator');
    revalidatePath('/admin/mo-messages');
    revalidatePath('/admin/mt-messages');

    const resultCode = moRow?.result;
    return {
      message: resultCode
        ? `EMMA 경로로 처리했습니다. 결과: ${moResultLabel[resultCode].text}`
        : `폴러가 처리하지 않았습니다. (${mine?.detail ?? '사유 없음'})`,
      detail: {
        'EMMA 저장 형태': `mo_recipient="${inserted.moRecipient}" / emo_recipient=${
          inserted.emoRecipient === null ? 'NULL' : `"${inserted.emoRecipient}"`
        }`,
        '복원된 수신번호': moRow?.receivedNumber ? formatMoNumber(moRow.receivedNumber) : '(복원 실패 또는 미처리)',
        '폴러 결과': `가져옴 ${poll.fetched} / 처리 ${poll.handed} / 건너뜀 ${poll.skipped} / 실패 ${poll.failed}`,
        'mo_key': inserted.moKey,
        '크리에이터': moRow?.creator?.displayName ?? '-',
        '처리 결과': resultCode ? `${moResultLabel[resultCode].text} (${resultCode})` : (mine?.detail ?? '-'),
        '거래번호': moRow?.donation?.transactionNo ?? '-',
        '후원 상태': moRow?.donation?.status
          ? `${donationStatusLabel[moRow.donation.status].text} (${moRow.donation.status})`
          : '-',
      },
    };
  });
}

/**
 * 세 가지 분할 방식이 모두 같은 수신번호로 복원되는지 한 번에 확인한다.
 * 문자를 실제로 넣지 않고 계산만 하므로 후원이 생기지 않는다.
 */
export async function previewSplitModes(fullNumber: string) {
  const modes: MoSplitMode[] = ['BASE_SUB', 'PREFIX_REST', 'WHOLE'];
  return modes.map((mode) => {
    const { moRecipient, emoRecipient } = splitForCarrier(fullNumber, mode);
    return { mode, moRecipient, emoRecipient };
  });
}
