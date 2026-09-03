import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { queueEmmaMms, queueEmmaMt } from '@/server/emma';
import type { AdapterInfo, ProviderResult } from '../types';
import { decideMessageType, type MtAdapter, type MtSendRequest, type MtSendResult } from './index';

/**
 * EMMA(인포뱅크 온프레미스 에이전트) MT 발송 어댑터.
 *
 * 다른 어댑터와 달리 HTTP 를 호출하지 않는다. EMMA 발송 큐 테이블(`em_smt_tran`)에 행을 넣으면
 * EMMA 데몬이 기본 2초 주기로 집어가 발송한다.
 *
 * "성공"의 의미
 * -------------
 * 이 어댑터의 ok=true 는 **큐 적재 성공**이다. 단말 수신은 물론이고 이통사 접수도 아직 아니다.
 * 최종 결과는 EMMA 가 `msg_status` / `mt_report_code_ib` 를 갱신하고 월별 로그 테이블로 옮긴다.
 * 그 결과로 결제 상태를 바꾸지 않는다(절대규칙 3: 발송 실패가 결제 결과를 바꾸지 않는다).
 *
 * 설치 측 전제 조건
 * -----------------
 * EMMA 설치 시 **SMS MT 서비스를 켜야 한다.** MO 만 켜 두면 큐에 쌓이기만 하고 한 통도 나가지 않는다.
 *   process.use.mtsender      = 1
 *   process.use.mtreceiver    = 1
 *   process.use.smtcollector  = 1
 *   process.use.mtdistributor = 1
 * (같은 계열 서비스인 나눔플러스가 MO 만 켜 둔 탓에 감사 문자가 전건 미발송 상태였다)
 *
 * 장문(LMS)은 MMS MT 서비스가 추가로 필요하다. `use.mmtsender` 계열까지 켜고 장문 큐
 * `em_mmt_tran` 이 만들어져 있어야 90byte 초과 본문이 나간다. 없으면 이 어댑터가 해당 문자를
 * 실패로 돌려주고, 부팅 경고(bootWarnings)로도 알린다.
 *
 * info() 는 동기 함수라 테이블 존재 여부(DB 조회)를 확인하지 않는다. 실제 확인은 발송 시점에
 * 일어나고, 큐가 없으면 그 자리에서 실패로 기록된다.
 */

function missingCredentials(): string[] {
  const missing: string[] = [];
  if (!env.emma.enabled) missing.push('EMMA_ENABLED');
  if (!env.mt.senderNumber) missing.push('MT_SENDER_NUMBER');
  return missing;
}

export const emmaMtAdapter: MtAdapter = {
  info(): AdapterInfo {
    const missing = missingCredentials();
    return { provider: 'emma', mode: missing.length > 0 ? 'mock' : 'live', missingCredentials: missing };
  },

  async send(req: MtSendRequest): Promise<ProviderResult<MtSendResult>> {
    const missing = missingCredentials();
    if (missing.length > 0) {
      // 설정이 덜 된 상태에서 "성공"을 돌려주면 문자가 안 나가는데 나갔다고 기록된다.
      return {
        ok: false,
        code: 'EMMA_NOT_CONFIGURED',
        message: `EMMA MT 설정이 완료되지 않았습니다. (미설정: ${missing.join(', ')})`,
      };
    }

    const started = Date.now();
    const messageType = decideMessageType(req.text, req.forceType);

    /**
     * EMMA 의 SMS 발송 큐(em_smt_tran)는 단문 전용이다(service_type='0').
     * 90byte 를 넘는 본문은 장문 큐(em_mmt_tran)로 넣어야 한다.
     *
     * 결제 흐름의 핵심 문자(PIN 인증 링크·등록 안내)는 대부분 90byte 를 넘으므로, 예전처럼
     * 무조건 실패로 돌려주면 EMMA 구성에서는 문자후원이 통째로 막힌다. 그래서 장문 큐가
     * 있으면(=MMS MT 를 계약·활성화한 설치) 그쪽으로 폴백한다.
     *
     * 장문 큐가 없으면 **조용히 잘라 보내지 않고 실패로 돌려준다.**
     * (잘린 문자로 결제 링크가 깨지면 후원자가 결제를 못 하고, 성공으로 기록되면 아무도 모른다)
     */
    if (messageType === 'LMS') {
      try {
        const queued = await queueEmmaMms({
          to: req.to,
          callback: env.mt.senderNumber,
          content: req.text,
        });
        logger.info('EMMA MT: 장문(LMS) 을 MMS 큐로 적재했습니다', {
          bytes: Buffer.byteLength(req.text, 'utf8'),
          template: req.templateCode,
          providerMessageId: queued.providerMessageId,
        });
        return {
          ok: true,
          data: { providerMessageId: queued.providerMessageId, messageType },
          latencyMs: Date.now() - started,
        };
      } catch (e) {
        const reason = (e as Error).message;
        logger.error('EMMA MT: 장문(LMS) 발송 불가', {
          bytes: Buffer.byteLength(req.text, 'utf8'),
          template: req.templateCode,
          message: reason,
        });
        return {
          ok: false,
          code: 'EMMA_LMS_UNSUPPORTED',
          message:
            '본문이 90바이트를 넘어 장문(LMS)으로 보내야 하는데 발송하지 못했습니다. EMMA 는 MMS MT 서비스를 ' +
            `별도로 계약·활성화해야 장문을 보낼 수 있습니다. 템플릿을 단문 길이로 줄이거나 MMS MT 를 계약하십시오. (사유: ${reason})`,
          latencyMs: Date.now() - started,
        };
      }
    }

    try {
      const queued = await queueEmmaMt({
        to: req.to,
        callback: env.mt.senderNumber,
        content: req.text,
      });
      return {
        ok: true,
        data: { providerMessageId: queued.providerMessageId, messageType },
        latencyMs: Date.now() - started,
      };
    } catch (e) {
      const message = (e as Error).message;
      logger.error('EMMA MT 큐 적재 실패', { message, template: req.templateCode });
      return {
        ok: false,
        code: 'EMMA_MT_QUEUE_FAILED',
        message,
        latencyMs: Date.now() - started,
      };
    }
  },
};
