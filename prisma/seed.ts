import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { newId } from '../src/lib/id';
import { encrypt, phoneHash, maskPhone, generateToken, tokenHash, maskSecret } from '../src/lib/crypto';
import { SEED_VERSION, SEED_VERSION_KEY } from './seed-version.mjs';

// 운영 환경 가드: 시드는 테스트 계정(admin@tornado.kr 등)과 샘플 데이터를 만들므로
// 운영 DB 에서는 절대 실행하지 않는다. (APP_ENV 별칭 규칙은 src/lib/env.ts 와 동일하게 prod/production 을 본다)
const appEnv = (process.env.APP_ENV ?? '').trim().toLowerCase();
const isProd = appEnv === 'prod' || appEnv === 'production' || process.env.NODE_ENV === 'production';
if (isProd) {
  console.log('[seed] 운영 환경에서는 관리자 시드 계정을 생성하지 않습니다.');
  process.exit(0);
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('도네이도 시드 데이터 생성 시작');

  // ---------------------------------------------------------------- 시스템 설정
  const settings: Array<[string, unknown, string]> = [
    ['payment.mode', 'CONFIRM_LINK', '전역 기본 결제 모드. DIRECT_TRIGGER 는 금융사 서면승인 후에만 허용'],
    ['payment.confirmTtlSec', 300, '결제 확인 링크 유효시간(초). 헥토 10분 제한보다 짧게 유지'],
    ['donation.defaultAmount', 3000, '문자 1건당 기본 후원금'],
    ['youtube.dailyQuota', 10000, 'YouTube Data API 일일 할당량(실측 후 조정)'],
    ['service.name', '도네이도', '서비스명'],
  ];
  for (const [key, value, memo] of settings) {
    await prisma.systemSetting.upsert({
      where: { key },
      create: { key, value: value as object, memo },
      update: { value: value as object, memo },
    });
  }

  // ---------------------------------------------------------------- 약관
  const terms: Array<{ type: 'TERMS_SERVICE' | 'PRIVACY' | 'E_FINANCE' | 'WITHDRAWAL_AGREE' | 'AGE_CONFIRM' | 'MARKETING'; title: string; content: string; required: boolean }> = [
    { type: 'TERMS_SERVICE', title: '도네이도 서비스 이용약관', content: '제1조(목적) 이 약관은 도네이도가 제공하는 문자후원 서비스의 이용조건 및 절차를 규정합니다. (샘플 문안 — 법률 검토 후 교체 필요)', required: true },
    { type: 'PRIVACY', title: '개인정보 수집 및 이용 동의', content: '수집항목: 휴대전화번호, 결제 관련 정보. 이용목적: 후원 처리 및 결과 안내. 보유기간: 관계 법령에 따름. (샘플 문안)', required: true },
    { type: 'E_FINANCE', title: '전자금융거래 이용약관', content: '전자금융거래의 이용조건, 거래내용 확인, 오류 정정 절차를 규정합니다. (샘플 문안)', required: true },
    { type: 'WITHDRAWAL_AGREE', title: '출금이체 동의', content: '문자후원 발생 시 등록한 계좌에서 후원금이 출금되는 것에 동의합니다. (샘플 문안)', required: true },
    { type: 'AGE_CONFIRM', title: '만 19세 이상 확인', content: '본인은 만 19세 이상이며 미성년자가 아님을 확인합니다.', required: true },
    { type: 'MARKETING', title: '마케팅 정보 수신 동의', content: '이벤트 및 혜택 안내를 받는 것에 동의합니다. (선택)', required: false },
  ];
  for (const t of terms) {
    await prisma.termsVersion.upsert({
      where: { type_version: { type: t.type, version: '1.0' } },
      create: { id: newId(), type: t.type, version: '1.0', title: t.title, content: t.content, required: t.required, effectiveFrom: new Date('2026-01-01T00:00:00Z') },
      update: {},
    });
  }

  // ---------------------------------------------------------------- 정책
  const existingPolicy = await prisma.donationLimitPolicy.findFirst({ where: { scope: 'GLOBAL' } });
  if (!existingPolicy) {
    await prisma.donationLimitPolicy.create({ data: { id: newId(), scope: 'GLOBAL' } });
  }

  const existingFee = await prisma.feePolicy.findFirst({ where: { scope: 'GLOBAL' } });
  if (!existingFee) {
    await prisma.feePolicy.create({
      data: { id: newId(), scope: 'GLOBAL', pgFeeRate: '0.018', platformFeeRate: '0.15', smsCost: 20 },
    });
  }

  // ---------------------------------------------------------------- 금칙어
  const words: Array<[string, 'BLOCK' | 'MASK']> = [
    ['도박', 'BLOCK'], ['불법', 'BLOCK'], ['사기', 'MASK'],
    ['씨발', 'MASK'], ['개새끼', 'MASK'], ['죽여', 'BLOCK'],
  ];
  for (const [word, action] of words) {
    const exists = await prisma.bannedWord.findFirst({ where: { word, creatorId: null } });
    if (!exists) await prisma.bannedWord.create({ data: { id: newId(), word, action, scope: 'GLOBAL' } });
  }

  // ---------------------------------------------------------------- 관리자
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@tornado.kr' },
    create: {
      id: newId(), email: 'admin@tornado.kr', name: '도네이도 관리자',
      role: 'ADMIN', passwordHash: await bcrypt.hash('tornado1234!', 10),
    },
    update: { role: 'ADMIN' },
  });
  await prisma.adminProfile.upsert({
    where: { userId: adminUser.id },
    create: { id: newId(), userId: adminUser.id, permission: 'SUPER_ADMIN' },
    update: { permission: 'SUPER_ADMIN' },
  });

  // ---------------------------------------------------------------- 크리에이터
  const creatorSeeds = [
    { email: 'creator1@tornado.kr', name: '바람소리', code: 'TOR-8K2M', mo: '05051001001', mode: 'DEDICATED' as const, keyword: null },
    { email: 'creator2@tornado.kr', name: '별하늘', code: 'TOR-3QP7', mo: '05059000000', mode: 'SHARED_PREFIX' as const, keyword: 'TOR3QP7' },
  ];

  for (const c of creatorSeeds) {
    const user = await prisma.user.upsert({
      where: { email: c.email },
      create: {
        id: newId(), email: c.email, name: c.name, role: 'CREATOR',
        passwordHash: await bcrypt.hash('tornado1234!', 10),
      },
      update: { role: 'CREATOR' },
    });

    const creator = await prisma.creatorProfile.upsert({
      where: { userId: user.id },
      create: {
        id: newId(), userId: user.id, code: c.code, displayName: c.name,
        channelName: `${c.name} 채널`, status: 'APPROVED', donationAmount: 3000,
        approvedAt: new Date(),
        description: '문자 한 통으로 응원을 보내주세요.',
        avatarUrl: null,
      },
      // 과거 시드에서는 25개 캐릭터가 합쳐진 스프라이트 전체를 저장해 잘못 보였다.
      // 테스트 계정은 URL을 비우고 userId 기반 자동 캐릭터를 사용한다.
      update: { status: 'APPROVED', avatarUrl: null },
    });

    const codeExists = await prisma.creatorCode.findUnique({ where: { code: c.code } });
    if (!codeExists) {
      await prisma.creatorCode.create({ data: { id: newId(), creatorId: creator.id, code: c.code, active: true } });
    }

    const moExists = await prisma.creatorMoNumber.findFirst({ where: { phoneNumber: c.mo, keyword: c.keyword } });
    if (!moExists) {
      await prisma.creatorMoNumber.create({
        data: {
          id: newId(), phoneNumber: c.mo, keyword: c.keyword, mode: c.mode,
          status: 'ASSIGNED', creatorId: creator.id, providerId: 'mock',
          assignedAt: new Date(), monthlyCost: c.mode === 'DEDICATED' ? 30000 : 0,
        },
      });
    }

    const overlayToken = generateToken(24);
    await prisma.overlaySetting.upsert({
      where: { creatorId: creator.id },
      create: {
        id: newId(), creatorId: creator.id,
        tokenHash: tokenHash(overlayToken), tokenMasked: maskSecret(overlayToken),
      },
      update: {},
    });
    console.log(`  오버레이 URL(${c.name}): /overlay/${creator.id}?token=${overlayToken}`);
    console.log(`  게임 오버레이 URL(${c.name}): /overlay/${creator.id}/game?token=${overlayToken}`);

    // 방송 게임 예시. 크리에이터가 바로 눌러 볼 수 있게 종류별로 하나씩 넣어 둔다.
    // 보상은 무형 보상(샤라웃 · 신청곡)의 이름일 뿐이며 금전 지급 수단이 아니다.
    const gameCount = await prisma.game.count({ where: { creatorId: creator.id } });
    if (gameCount === 0) {
      const sampleGames = [
        {
          type: 'ROULETTE',
          title: '오늘의 벌칙 룰렛',
          items: ['노래 한 곡', '물 한 컵', '성대모사', '춤 10초', '시청자 칭찬'],
          config: { prize: '' },
          entryMode: 'LINK',
          autoCloseSec: 0,
        },
        {
          type: 'VOTE',
          title: '다음 컨텐츠 정하기',
          items: [],
          config: { topic: '다음에 뭐 할까요?', choices: ['게임', '노래', '수다', '먹방'] },
          entryMode: 'LINK',
          autoCloseSec: 60,
        },
        {
          type: 'KEYWORD',
          title: '선착순 키워드 이벤트',
          items: [],
          config: { keyword: '도네이도', winnerCount: 3, prize: '샤라웃' },
          entryMode: 'BOTH',
          autoCloseSec: 30,
        },
        {
          type: 'GOAL_GAUGE',
          title: '오늘의 후원 목표',
          items: [],
          config: { target: 100000, reward: '목표 달성하면 노래 한 곡' },
          entryMode: 'LINK',
          autoCloseSec: 0,
        },
      ];

      for (const g of sampleGames) {
        await prisma.game.create({
          data: {
            id: newId(),
            creatorId: creator.id,
            type: g.type,
            title: g.title,
            items: g.items,
            config: g.config,
            entryMode: g.entryMode,
            autoCloseSec: g.autoCloseSec,
          },
        });
      }
    }

    await prisma.ttsSetting.upsert({
      where: { creatorId: creator.id },
      create: { id: newId(), creatorId: creator.id },
      update: {},
    });

    await prisma.youTubeConnection.upsert({
      where: { creatorId: creator.id },
      create: {
        id: newId(), creatorId: creator.id, channelId: `UCmock-${creator.id.slice(-8)}`,
        channelTitle: `${c.name} 채널`,
        accessTokenEnc: encrypt('mock-access-token'),
        refreshTokenEnc: encrypt('mock-refresh-token'),
        scope: 'https://www.googleapis.com/auth/youtube.force-ssl',
        expiresAt: new Date(Date.now() + 3600_000),
        status: 'CONNECTED',
      },
      update: {},
    });

    await prisma.settlementAccount.upsert({
      where: { creatorId: creator.id },
      create: {
        id: newId(), creatorId: creator.id, bankCode: '004', bankName: 'KB국민은행',
        accountEnc: encrypt('11122233344455'), accountTail4: '4455',
        holderNameEnc: encrypt(c.name), holderMasked: `${c.name[0]}*${c.name.slice(2)}`,
        verified: true, verifiedAt: new Date(),
      },
      update: {},
    });
  }

  // ---------------------------------------------------------------- 테스트 후원자 (계좌 등록 완료 상태)
  const testPhone = '01012345678';
  const donor = await prisma.donorProfile.upsert({
    where: { phoneHash: phoneHash(testPhone) },
    create: {
      id: newId(), phoneHash: phoneHash(testPhone), phoneEnc: encrypt(testPhone),
      phoneMasked: maskPhone(testPhone), displayName: '테스트후원자',
      ageVerified: true, registeredAt: new Date(), onboardingStatus: 'REGISTERED',
    },
    update: { onboardingStatus: 'REGISTERED' },
  });
  const tokenExists = await prisma.paymentMethodToken.findFirst({ where: { donorId: donor.id, status: 'ACTIVE' } });
  if (!tokenExists) {
    const billKey = 'MOCKBILL-SEED-4455';
    await prisma.paymentMethodToken.create({
      data: {
        id: newId(), donorId: donor.id, provider: 'mock',
        billKeyEnc: encrypt(billKey), billKeyHint: maskSecret(billKey),
        bankCode: '004', bankName: 'KB국민은행', accountTail4: '4455',
      },
    });
  }

  // 후원자 웹 계정 (테스트 로그인용) — DonorProfile 과 휴대폰 번호 기준으로 연결한다.
  const donorUser = await prisma.user.upsert({
    where: { email: 'donor@tornado.kr' },
    create: {
      id: newId(), email: 'donor@tornado.kr', name: '테스트후원자',
      role: 'DONOR', passwordHash: await bcrypt.hash('tornado1234!', 10),
    },
    update: { role: 'DONOR' },
  });
  if (!donor.userId) {
    await prisma.donorProfile.update({ where: { id: donor.id }, data: { userId: donorUser.id } });
  }

  // ---------------------------------------------------------------- 옛 번호 샘플 정리
  // 050 전환 이전 번호(1588…)로 들어가 UNKNOWN_ROUTE 로 실패한 샘플 수신문자를 지운다.
  // 지워야 아래 샘플 후원 블록이 다시 실행되어 정상 데이터가 만들어진다.
  await prisma.moInboundMessage.deleteMany({
    where: { providerMessageId: { startsWith: 'SEED-MO-' }, result: 'UNKNOWN_ROUTE' },
  });

  // ---------------------------------------------------------------- 샘플 후원 이력
  // 실제 서비스 흐름(handleMoInbound → executePayment)을 그대로 사용해 생성한다.
  // 수기 INSERT 가 아니므로 결제 트랜잭션·정산 원장·MT 발송 기록까지 일관되게 만들어진다.
  // (mock 어댑터 기준이며, 이미 이력이 있으면 건너뛴다)
  const donationCount = await prisma.donation.count({ where: { donorId: donor.id } });
  if (donationCount === 0) {
    try {
      const { handleMoInbound, executePayment } = await import('../src/server/services/donation-flow');
      const { completePinAuthorization } = await import('../src/server/services/pin-authorization');
      const { requestRefund } = await import('../src/server/services/refund');

      // 수신번호는 시드에 정의된 크리에이터 MO 번호를 그대로 사용한다.
      // (번호 체계를 바꿀 때 이 목록을 같이 고치지 않으면 전부 UNKNOWN_ROUTE 로 실패한다)
      const moA = creatorSeeds[0].mo;
      const moB = creatorSeeds[1].mo;
      const kwB = creatorSeeds[1].keyword ? `${creatorSeeds[1].keyword} ` : '';
      const samples: Array<{ to: string; content: string; pay: boolean }> = [
        { to: moA, content: '오늘 방송 너무 재밌어요! 항상 응원합니다', pay: true },
        { to: moA, content: '목 관리 잘 하세요. 다음 방송도 기대할게요', pay: true },
        { to: moA, content: '드디어 구독 1년! 축하드려요', pay: true },
        { to: moB, content: `${kwB}별하늘님 노래 최고예요`, pay: true },
        { to: moA, content: '이번 주도 수고 많으셨어요', pay: false }, // 결제 전 단계(확인 대기/한도 차단)로 남긴다
      ];

      let refundTarget: string | null = null;
      for (let i = 0; i < samples.length; i += 1) {
        const s = samples[i];
        const result = await handleMoInbound({
          providerMessageId: `SEED-MO-${String(i + 1).padStart(3, '0')}`,
          providerCode: 'mock',
          receivedNumber: s.to,
          fromNumber: testPhone,
          content: s.content,
          messageType: 'SMS',
          receivedAt: new Date(Date.now() - (samples.length - i) * 86_400_000),
        });
        if (s.pay && result.donationId) {
          // PIN 인증 흐름에서는 후원자가 PIN 을 입력한 것과 같은 경로로 결제를 마친다.
          // (직접 executePayment 를 부르면 인증 세션이 대기 상태로 남아 실제 데이터와 달라진다)
          if (result.status === 'PENDING_PIN') await completePinAuthorization({ donationId: result.donationId });
          else await executePayment(result.donationId);
          if (i === 1) refundTarget = result.donationId;
        }
      }

      // 환불 요청 상태 샘플 1건 (관리자 환불 큐 검수용)
      if (refundTarget) {
        await requestRefund({ donationId: refundTarget, reason: '실수로 중복 발송했습니다.', requestedBy: 'donor' });
      }
      console.log('  샘플 후원 이력 5건 생성 (결제 완료·환불 요청·한도 차단 등 실제 흐름 그대로)');
    } catch (e) {
      console.warn('  샘플 후원 이력 생성 건너뜀:', (e as Error).message);
    }
  }

  // ---------------------------------------------------------------- 콘텐츠
  const posts: Array<{ type: string; title: string; body: string; category?: string; sortOrder: number }> = [
    { type: 'FAQ', title: '문자후원은 어떻게 이용하나요?', body: '크리에이터의 후원 번호로 문자를 보내면 됩니다. 최초 1회 계좌 등록과 이용 동의가 필요하며, 최초 문자는 후원 처리되지 않습니다.', category: '이용방법', sortOrder: 1 },
    { type: 'FAQ', title: '최초 문자도 후원되나요?', body: '아니요. 최초 문자는 후원 처리되지 않고 계좌 등록 안내만 발송됩니다. 등록 완료 후 보내는 문자부터 후원이 접수됩니다.', category: '이용방법', sortOrder: 2 },
    { type: 'FAQ', title: '후원 한도가 있나요?', body: '기본 일일 100,000원, 1분 내 3건, 연속 5건 이후 대기시간이 적용됩니다. 한도는 마이페이지에서 더 낮게 설정할 수 있습니다.', category: '한도', sortOrder: 3 },
    { type: 'FAQ', title: '후원을 취소할 수 있나요?', body: '결제 직후 고객센터로 요청하시면 정산 전인 건에 한해 취소·환불이 가능합니다.', category: '환불', sortOrder: 4 },
    { type: 'FAQ', title: '유튜브 슈퍼챗과 같은 건가요?', body: '아닙니다. 도네이도 후원은 유튜브 공식 슈퍼챗이 아닌 외부 후원이며, 채팅에는 연결된 채널 계정으로 표시됩니다.', category: '방송', sortOrder: 5 },
    { type: 'NOTICE', title: '도네이도 베타 서비스 안내', body: '현재 도네이도는 준비 단계이며 실제 결제와 문자 발송은 비활성화되어 있습니다.', sortOrder: 1 },
  ];
  for (const p of posts) {
    const exists = await prisma.contentPost.findFirst({ where: { type: p.type, title: p.title } });
    if (!exists) {
      await prisma.contentPost.create({
        data: { id: newId(), type: p.type, title: p.title, body: p.body, category: p.category ?? null, sortOrder: p.sortOrder },
      });
    }
  }

  // ---------------------------------------------------------------- 050 번호 전환
  // 시드 v5: MO 수신번호를 050(0505) 체계로 전환한다. 기존 DB 의 옛 1588 번호를 갱신한다.
  await prisma.creatorMoNumber.updateMany({ where: { phoneNumber: '15881001' }, data: { phoneNumber: '05051001001' } });
  await prisma.creatorMoNumber.updateMany({ where: { phoneNumber: '15889000' }, data: { phoneNumber: '05059000000' } });

  // ---------------------------------------------------------------- 브랜드명 정리
  // 예전 시드로 만들어진 데이터에 남은 '토네이도' 를 '도네이도' 로 바꾼다.
  // (시드는 "이미 있으면 건너뛰기" 방식이라 기존 행은 자동 갱신되지 않기 때문)
  {
    const renamed: string[] = [];

    const users = await prisma.user.findMany({
      where: { name: { contains: '토네이도' } },
      select: { id: true, name: true },
    });
    for (const u of users) {
      await prisma.user.update({ where: { id: u.id }, data: { name: u.name!.replaceAll('토네이도', '도네이도') } });
    }
    if (users.length) renamed.push(`계정 이름 ${users.length}건`);

    const posts = await prisma.contentPost.findMany({
      where: { OR: [{ title: { contains: '토네이도' } }, { body: { contains: '토네이도' } }] },
      select: { id: true, title: true, body: true },
    });
    for (const c of posts) {
      await prisma.contentPost.update({
        where: { id: c.id },
        data: { title: c.title.replaceAll('토네이도', '도네이도'), body: c.body.replaceAll('토네이도', '도네이도') },
      });
    }
    if (posts.length) renamed.push(`콘텐츠 ${posts.length}건`);

    const termsRows = await prisma.termsVersion.findMany({
      where: { OR: [{ title: { contains: '토네이도' } }, { content: { contains: '토네이도' } }] },
      select: { id: true, title: true, content: true },
    });
    for (const t of termsRows) {
      await prisma.termsVersion.update({
        where: { id: t.id },
        data: { title: t.title.replaceAll('토네이도', '도네이도'), content: t.content.replaceAll('토네이도', '도네이도') },
      });
    }
    if (termsRows.length) renamed.push(`약관 ${termsRows.length}건`);

    const settings = await prisma.systemSetting.findMany({ where: { key: 'service.name' } });
    for (const st of settings) {
      if (JSON.stringify(st.value).includes('토네이도')) {
        await prisma.systemSetting.update({ where: { key: st.key }, data: { value: '도네이도' } });
        renamed.push('서비스명 설정');
      }
    }

    if (renamed.length) console.log(`  브랜드명 정리: ${renamed.join(', ')}`);
  }

  // 시드 버전 기록. 다음 실행 때 이 값으로 보충 시드 필요 여부를 판단한다.
  await prisma.systemSetting.upsert({
    where: { key: SEED_VERSION_KEY },
    create: { key: SEED_VERSION_KEY, value: SEED_VERSION, memo: '적용된 시드 데이터 버전' },
    update: { value: SEED_VERSION },
  });

  console.log('시드 완료');
  console.log('  관리자     : admin@tornado.kr / tornado1234!');
  console.log('  크리에이터 : creator1@tornado.kr / tornado1234! (코드 TOR-8K2M, MO 0505-100-1001)');
  console.log('  크리에이터 : creator2@tornado.kr / tornado1234! (코드 TOR-3QP7, MO 0505-900-0000 + 키워드 TOR3QP7)');
  console.log('  후원자     : donor@tornado.kr / tornado1234! (010-1234-5678, 계좌 등록·계정 연결 완료)');
}

main()
  .then(async () => {
    await prisma.$disconnect();
    // 샘플 후원 이력 생성 시 동적 import 된 앱 모듈(별도 Prisma 클라이언트/Redis)이
    // 이벤트 루프를 붙잡아 프로세스가 종료되지 않는 것을 방지한다.
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
