import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt, phoneHash, maskPhone, maskSecret, generateToken, tokenHash } from '@/lib/crypto';
import { resetMockPaymentState } from '@/server/adapters/payment';
import { clearMockOutbox } from '@/server/adapters/mt';
import { setMockLive } from '@/server/adapters/youtube';
import { clearMtTemplateOverrideCache } from '@/server/services/mt-templates';

/** 테스트마다 DB 를 비운다. 순서는 FK 역순. */
export async function resetDb() {
  const tables = [
    'admin_audit_log', 'webhook_log', 'consent_record', 'notification', 'report',
    'youtube_chat_delivery', 'youtube_broadcast', 'youtube_connection',
    'overlay_event', 'overlay_setting', 'tts_setting',
    'settlement_ledger', 'settlement_request', 'settlement_account', 'fee_policy',
    'payment_attempt', 'payment_transaction', 'refund',
    'donation_status_log', 'secure_link', 'mt_outbound_message', 'donation',
    'mo_inbound_message', 'donation_counter', 'risk_detection', 'blocked_donor',
    'donor_creator_link', 'payment_method_token', 'payment_registration', 'donor_profile',
    'creator_mo_number', 'creator_code', 'banned_word', 'donation_limit_policy', 'creator_profile',
    'admin_profile', 'user_session', 'app_user', 'terms_version', 'idempotency_key',
    'content_post', 'banner', 'system_setting',
    /**
     * MT 커스텀 본문. 이 표가 빠져 있어서 한 테스트가 저장한 문구가 다음 테스트까지 살아남았다.
     * (발송 문구는 전역 상태라 한 번 새면 관련 없는 테스트가 이유 없이 깨진다)
     */
    'mt_message_template',
  ];
  // 정산 원장은 append-only 트리거로 DELETE 가 막혀 있으므로 트리거를 잠시 끈다.
  await prisma.$executeRawUnsafe('ALTER TABLE settlement_ledger DISABLE TRIGGER settlement_ledger_append_only');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(', ')} CASCADE`);
  await prisma.$executeRawUnsafe('ALTER TABLE settlement_ledger ENABLE TRIGGER settlement_ledger_append_only');

  resetMockPaymentState();
  clearMockOutbox();
  setMockLive(true);
  // 커스텀 본문은 발송 경로에서 30초 캐싱된다. 표를 비웠으면 캐시도 함께 비워야 한다.
  clearMtTemplateOverrideCache();
}

export interface Fixture {
  creatorId: string;
  creatorUserId: string;
  moNumber: string;
  donorPhone: string;
  donorId?: string;
}

export async function seedBasics(options: { paymentMode?: 'CONFIRM_LINK' | 'DIRECT_TRIGGER' } = {}) {
  await prisma.donationLimitPolicy.create({ data: { id: newId(), scope: 'GLOBAL' } });
  await prisma.feePolicy.create({
    data: { id: newId(), scope: 'GLOBAL', pgFeeRate: '0.018', platformFeeRate: '0.15' },
  });
  // ALLOW_DIRECT_TRIGGER=true 만으로는 DIRECT_TRIGGER 가 열리지 않는다(M-3).
  // 테스트에서도 이 경로를 검증하므로 DB 서면승인 레코드를 함께 넣어 둔다.
  await prisma.systemSetting.upsert({
    where: { key: 'financial_direct_trigger_written_approval' },
    create: { key: 'financial_direct_trigger_written_approval', value: { approved: true, documentRef: 'TEST-FIXTURE' } },
    update: { value: { approved: true, documentRef: 'TEST-FIXTURE' } },
  });

  for (const t of ['TERMS_SERVICE', 'PRIVACY', 'E_FINANCE', 'WITHDRAWAL_AGREE', 'AGE_CONFIRM'] as const) {
    await prisma.termsVersion.create({
      data: {
        id: newId(), type: t, version: '1.0', title: `${t} 약관`, content: '테스트 약관',
        required: true, effectiveFrom: new Date('2026-01-01'),
      },
    });
  }

  const user = await prisma.user.create({
    data: { id: newId(), email: `creator-${newId()}@test.kr`, name: '테스트크리에이터', role: 'CREATOR' },
  });
  const creator = await prisma.creatorProfile.create({
    data: {
      id: newId(), userId: user.id, code: `TOR-${newId().slice(-4)}`, displayName: '테스트크리에이터',
      status: 'APPROVED', donationAmount: 3000n,
      paymentMode: options.paymentMode ?? 'DIRECT_TRIGGER',
    },
  });

  const moNumber = '168812341001';
  await prisma.creatorMoNumber.create({
    data: {
      id: newId(), phoneNumber: moNumber, mode: 'DEDICATED', status: 'ASSIGNED',
      creatorId: creator.id, providerId: 'mock', assignedAt: new Date(),
    },
  });

  const overlayToken = generateToken(16);
  await prisma.overlaySetting.create({
    data: {
      id: newId(), creatorId: creator.id,
      tokenHash: tokenHash(overlayToken), tokenMasked: maskSecret(overlayToken),
    },
  });
  await prisma.ttsSetting.create({ data: { id: newId(), creatorId: creator.id } });
  await prisma.youTubeConnection.create({
    data: {
      id: newId(), creatorId: creator.id, channelId: 'UCtest', channelTitle: '테스트채널',
      accessTokenEnc: encrypt('mock-access-token'), refreshTokenEnc: encrypt('mock-refresh-token'),
      scope: 'https://www.googleapis.com/auth/youtube.force-ssl',
      expiresAt: new Date(Date.now() + 3600_000), status: 'CONNECTED',
    },
  });
  await prisma.settlementAccount.create({
    data: {
      id: newId(), creatorId: creator.id, bankCode: '004', bankName: 'KB국민은행',
      accountEnc: encrypt('11122233344455'), accountTail4: '4455',
      holderNameEnc: encrypt('테스트'), holderMasked: '테*트', verified: true, verifiedAt: new Date(),
    },
  });

  return { creatorId: creator.id, creatorUserId: user.id, moNumber, donorPhone: '01012345678' } as Fixture;
}

/** 계좌 등록이 완료된 후원자를 만든다. */
export async function seedRegisteredDonor(phone = '01012345678') {
  const donor = await prisma.donorProfile.create({
    data: {
      id: newId(), phoneHash: phoneHash(phone), phoneEnc: encrypt(phone),
      phoneMasked: maskPhone(phone), displayName: '테스트후원자',
      ageVerified: true, registeredAt: new Date(),
      onboardingStatus: 'REGISTERED',
    },
  });
  await prisma.paymentMethodToken.create({
    data: {
      id: newId(), donorId: donor.id, provider: 'mock',
      billKeyEnc: encrypt('MOCKBILL-TEST-4455'), billKeyHint: maskSecret('MOCKBILL-TEST-4455'),
      bankCode: '004', bankName: 'KB국민은행', accountTail4: '4455',
    },
  });
  return donor;
}

let seq = 0;
export function moPayload(input: {
  to: string;
  from?: string;
  text?: string;
  messageId?: string;
  receivedAt?: Date;
}) {
  seq += 1;
  return {
    messageId: input.messageId ?? `MO-TEST-${Date.now()}-${seq}`,
    to: input.to,
    from: input.from ?? '01012345678',
    text: input.text ?? '오늘 방송 재미있어요',
    type: 'SMS',
    receivedAt: (input.receivedAt ?? new Date()).toISOString(),
  };
}
