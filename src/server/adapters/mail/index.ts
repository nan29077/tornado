import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import type { AdapterInfo } from '../types';

/**
 * 이메일 발송 어댑터 (8차 점검, 2026-11-20).
 *
 * 비밀번호 재설정 메일을 보낼 수단이 없어, 운영에서는 "고객센터 문의" 로만 안내할 수 있었다.
 * 어댑터 인터페이스와 두 구현을 둔다.
 *  - mock : 아무것도 보내지 않는다. **성공으로 처리하지 않는다**(CLAUDE.md 규칙 2) — 화면은 "발송되지 않습니다" 를 그대로 안내.
 *  - ses  : Amazon SES(v2). MAIL_PROVIDER=ses, MAIL_FROM(SES 에서 인증한 보내는 주소)이 있어야 켜진다.
 *           자격 증명은 S3 와 같이 AWS 기본 자격 증명 체인(IAM 역할 · 환경변수)을 쓴다. 지역은 MAIL_SES_REGION 또는 AWS_REGION.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailAdapter {
  info(): AdapterInfo;
  /** 실제로 발송 요청이 받아들여졌을 때만 ok:true */
  send(msg: MailMessage): Promise<{ ok: true; messageId?: string } | { ok: false; reason: string }>;
}

function mailProvider(): string {
  return (process.env.MAIL_PROVIDER ?? 'mock').trim().toLowerCase() || 'mock';
}

function mailFrom(): string {
  return (process.env.MAIL_FROM ?? '').trim();
}

const mockMail: MailAdapter = {
  info: () => ({ provider: 'mock', mode: 'mock', missingCredentials: ['MAIL_PROVIDER=ses', 'MAIL_FROM'] }),
  async send() {
    return { ok: false, reason: '메일 발송이 연동되지 않았습니다 (mock).' };
  },
};

const sesMail: MailAdapter = {
  info: () => {
    const missing = mailFrom() ? [] : ['MAIL_FROM'];
    return { provider: 'ses', mode: missing.length ? 'mock' : 'live', missingCredentials: missing };
  },
  async send(msg) {
    const from = mailFrom();
    if (!from) return { ok: false, reason: 'MAIL_FROM 이 설정되지 않았습니다.' };
    try {
      const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
      const region = (process.env.MAIL_SES_REGION ?? '').trim() || env.crypto.awsRegion;
      const client = new SESv2Client({ region });
      const res = await client.send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: [msg.to] },
          Content: {
            Simple: {
              Subject: { Data: msg.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: msg.text, Charset: 'UTF-8' },
                ...(msg.html ? { Html: { Data: msg.html, Charset: 'UTF-8' } } : {}),
              },
            },
          },
        }),
      );
      return { ok: true, messageId: res.MessageId };
    } catch (e) {
      // 받는 주소는 로그에 남기지 않는다
      logger.warn('SES 메일 발송 실패', { message: (e as Error).message });
      return { ok: false, reason: '메일을 보내지 못했습니다.' };
    }
  },
};

export function getMailAdapter(): MailAdapter {
  return mailProvider() === 'ses' ? sesMail : mockMail;
}

/** 실제 메일을 보낼 수 있게 설정되었는가 (화면 안내 · 운영 점검용) */
export function isMailConfigured(): boolean {
  return mailProvider() === 'ses' && Boolean(mailFrom());
}
