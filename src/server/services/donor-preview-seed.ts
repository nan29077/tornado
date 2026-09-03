import bcrypt from 'bcryptjs';
import { prisma } from '@/server/db';
import { isLocal } from '@/lib/env';
import { newId } from '@/lib/id';
import { encrypt, phoneHash, maskPhone } from '@/lib/crypto';

/** 로컬 전용. 기존 사용자·결제·원장은 변경하지 않고 없는 검수 데이터만 추가한다. */
export async function ensureDonorPreviewSeed() {
  if (!isLocal) throw new Error('APP_ENV=local 에서만 테스트 후원자를 만들 수 있습니다.');
  const email = 'donor@tornado.kr';
  const passwordHash = await bcrypt.hash('tornado1234!', 10);
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: { email },
      create: { id: newId(), email, name: '테스트후원자', role: 'DONOR', passwordHash },
      update: {},
    });
    if (user.role !== 'DONOR' || user.status !== 'ACTIVE') throw new Error('기존 테스트 계정의 역할·상태가 달라 자동 변경하지 않았습니다.');
    let donor = await tx.donorProfile.findUnique({ where: { userId: user.id } });
    if (!donor) {
      const phone = '01012345678';
      const existing = await tx.donorProfile.findUnique({ where: { phoneHash: phoneHash(phone) } });
      if (existing?.userId && existing.userId !== user.id) throw new Error('테스트 전화번호가 다른 계정에 연결되어 있습니다.');
      donor = existing
        ? await tx.donorProfile.update({ where: { id: existing.id }, data: { userId: user.id } })
        : await tx.donorProfile.create({ data: { id: newId(), userId: user.id, phoneHash: phoneHash(phone), phoneEnc: encrypt(phone), phoneMasked: maskPhone(phone), displayName: '테스트후원자' } });
    }
    const select = { id: true, code: true } as const;
    const creator = await tx.creatorProfile.findFirst({ where: { code: 'TOR-8K2M', status: 'APPROVED', user: { status: 'ACTIVE' } }, select })
      ?? await tx.creatorProfile.findFirst({ where: { status: 'APPROVED', user: { status: 'ACTIVE' } }, orderBy: { code: 'asc' }, select });
    if (!creator) return { userId: user.id, samples: 0 };
    for (const [index, message] of ['오늘도 즐거운 방송 감사합니다!', '도네이도와 함께 응원해요.', '다음 방송도 기다릴게요.'].entries()) {
      // 실패 상태의 검수용 내역: 결제 실행·한도 집계·정산·송출 대상이 아니다.
      const transactionNo = `PREVIEW-DONOR-REPLY-${index + 1}`;
      const sample = await tx.donation.upsert({
        where: { transactionNo }, update: {},
        create: { id: newId(), transactionNo, creatorId: creator.id, donorId: donor.id, channel: 'MO', displayName: '테스트후원자', amount: 3000n, message, isTest: true, status: 'PAYMENT_FAILED', statusReason: '화면 검수 전용. 결제·문자·방송 송출을 실행하지 않은 샘플입니다.', mtStatus: 'SKIPPED', youtubeStatus: 'SKIPPED', overlayStatus: 'SKIPPED' },
      });
      if (sample.donorId === donor.id && sample.isTest && index === 0) await tx.donationReply.upsert({
        where: { donationId: sample.id }, update: {},
        create: { id: newId(), donationId: sample.id, body: '따뜻한 응원 고마워요! 다음 방송에서도 만나요. (검수용 답글)' },
      });
    }
    return { userId: user.id, samples: 3, creatorCode: creator.code };
  });
}
