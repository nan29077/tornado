/**
 * 환경변수 로더.
 * - 모든 외부 연동 키는 여기서만 읽는다.
 * - 값이 없을 때 임의 기본값으로 "성공 처리"하지 않고, mock 모드로 명시 전환한다.
 */

function str(key: string, fallback = ''): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function bool(key: string, fallback = false): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function num(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
}

export type ProviderMode = 'mock' | string;

export type AppEnv = 'local' | 'staging' | 'prod';


const NODE_ENV = str('NODE_ENV', 'development');

/** dev/stage 같은 흔한 표기도 받아 준다. */
const APP_ENV_ALIASES: Record<string, AppEnv> = {
  local: 'local',
  dev: 'staging',
  development: 'staging',
  stage: 'staging',
  staging: 'staging',
  prod: 'prod',
  production: 'prod',
};

/**
 * APP_ENV 결정 규칙 (fail-closed).
 *
 * - 명시적으로 지정한 값이 있으면 그 값을 따른다.
 *   (로컬에서 `npm run build && npm run start` 로 미리보기를 돌리는 경우가 있으므로
 *    NODE_ENV=production 만으로 prod 로 단정하면 정상적인 로컬 검수가 막힌다)
 * - **미설정이거나 오타** 면 안전한 쪽으로 판정한다:
 *   NODE_ENV=production → 'prod', 그 외 → 'local'.
 *   즉 배포 시 APP_ENV 를 빠뜨려도 테스트 로그인·MO 시뮬레이터·개발 아웃박스가 열리지 않는다.
 */
function resolveAppEnv(): AppEnv {
  const raw = str('APP_ENV', '').trim().toLowerCase();
  const known = APP_ENV_ALIASES[raw];
  if (known) return known;
  return NODE_ENV === 'production' ? 'prod' : 'local';
}

const APP_ENV = resolveAppEnv();
const IS_LOCAL = APP_ENV === 'local';

/**
 * 운영/스테이징에서 반드시 있어야 하는 시크릿.
 * 로컬에서만 개발용 기본값을 허용하고, 그 외 환경에서는 모듈 로드 시점에 즉시 예외를 던진다.
 * (기본값으로 조용히 기동해 세션 위조·전화번호 해시 충돌이 발생하는 fail-open 을 막는다)
 */
function requiredSecret(key: string, devFallback: string): string {
  const v = process.env[key];
  if (v && v.trim() !== '') return v;
  if (IS_LOCAL) return devFallback;
  throw new Error(`[env] ${key} 가 설정되지 않았습니다. APP_ENV=${APP_ENV} 환경에서는 필수입니다.`);
}

export const env = {
  nodeEnv: NODE_ENV,
  appEnv: APP_ENV,
  baseUrl: str('APP_BASE_URL', 'http://localhost:3025'),
  timezone: str('APP_TIMEZONE', 'Asia/Seoul'),

  databaseUrl: str('DATABASE_URL'),
  directDatabaseUrl: str('DIRECT_DATABASE_URL'),

  redisUrl: str('REDIS_URL'),
  allowInMemoryFallback: bool('ALLOW_INMEMORY_FALLBACK', true),

  /**
   * 앞단에 놓인 **신뢰 프록시 단수**.
   *
   * X-Forwarded-For 는 "클라이언트, 프록시1, 프록시2" 순으로 쌓인다. 우리가 믿을 수 있는 것은
   * 우리 프록시가 붙인 값뿐이므로, 뒤에서 N번째(=신뢰 프록시 단수만큼 건너뛴 값)를 클라이언트로 본다.
   *  - ALB 단독            → 1 (기본값)
   *  - CloudFront + ALB    → 2
   * 값이 틀리면 MO 허용목록이 전건 실패하거나(너무 큼), 클라이언트가 IP 를 위조할 수 있다(너무 작음).
   */
  trustedProxyHops: Math.max(1, num('TRUSTED_PROXY_HOPS', 1)),

  crypto: {
    provider: str('CRYPTO_PROVIDER', 'local') as 'local' | 'aws-kms',
    masterKey: str('CRYPTO_MASTER_KEY'),
    phoneHashSecret: requiredSecret('PHONE_HASH_SECRET', 'dev-only-phone-hmac-secret'),
    sessionSecret: requiredSecret('SESSION_SECRET', 'dev-only-session-secret'),
    awsRegion: str('AWS_REGION', 'ap-northeast-2'),
    kmsKeyId: str('AWS_KMS_KEY_ID'),
    /**
     * KMS 계약 전 임시 운영을 명시적으로 허용하는 스위치.
     *
     * KMS provider 는 아직 구현되지 않았다(crypto-provider.ts). 그런데 운영 점검은
     * aws-kms 를 요구하므로, 이 스위치가 없으면 APP_ENV=prod 로는 기동 자체가 불가능하고
     * 담당자는 APP_ENV=staging 으로 우회하게 된다. 그러면 운영 점검 전체가 건너뛰어져
     * (허용 IP·웹훅 시크릿·https·S3·SAFE_MODE 검사까지 전부) 훨씬 위험해진다.
     * "위험을 알고 켠다"를 한 줄로 남기게 해서 그 우회를 막는다.
     */
    allowLocalInProd: bool('ALLOW_LOCAL_CRYPTO_IN_PROD', false),
  },

  payment: {
    provider: str('PAYMENT_PROVIDER', 'mock') as ProviderMode,
    /** 헥토파이낸셜 상점아이디 (mercntId). */
    hectoMid: str('HECTO_MID'),
    hectoLicenseKey: str('HECTO_LICENSE_KEY'),
    /** custCi / trPrice 암호화용 AES-256 키 (32byte). */
    hectoAesKey: str('HECTO_AES_KEY'),
    /** 위변조 검증 해시키 (SHA256 signature 재료). */
    hectoHashKey: str('HECTO_HASH_KEY'),
    /**
     * 내통장결제(EzAuth) 호스트는 결제창과 서버 API 가 서로 다르다.
     * - UI(결제창/SettlePay.js): https://ezauth.settlebank.co.kr
     * - 서버 API(승인/빌키): https://ezauthapi.settlebank.co.kr:8081
     * 하나로 합치면 승인 요청이 결제창 호스트로 나가 전건 실패한다.
     */
    hectoAuthUiBase: str('HECTO_AUTH_UI_BASE', 'https://ezauth.settlebank.co.kr'),
    hectoAuthApiBase: str('HECTO_AUTH_API_BASE', 'https://ezauthapi.settlebank.co.kr:8081'),
    /** 결제 결과 콜백을 받을 자사 URL. 결제창 hash 재료(호스트)에도 사용된다. */
    hectoCallbackUrl: str('HECTO_CALLBACK_URL'),

    // ---------------------------------------------------------------- 온기(Ongi) 결제
    /**
     * 온기 결제 REST API.
     *
     * 헥토 EzAuth 와는 **완전히 다른 구조**다. 계좌 인증창·빌키·AES/SHA256 서명이 없고,
     * 모든 요청은 `X-API-KEY` 헤더로 인증하는 JSON REST API 다.
     * (헥토 방식으로 착각해 서명을 만들어 보내면 전건 인증 실패한다)
     */
    ongiApiBase: str('ONGI_API_BASE', 'https://api.ongi.site'),
    /** 모든 요청 헤더 `X-API-KEY` 에 실린다. */
    ongiApiKey: str('ONGI_API_KEY'),
    /** 선택. 가맹점 식별 강화용 `X-API-MID` 헤더. 비어 있으면 헤더를 붙이지 않는다. */
    ongiApiMid: str('ONGI_API_MID'),
    /** 온기 정기결제 MID. 값은 `.env` 에서 주입한다. */
    ongiRecurringMid: str('ONGI_RECURRING_MID'),
    /**
     * 결제 노티(웹훅) 서명 검증용 공유 비밀.
     * 서명 = sha256=HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
     * 비어 있으면 웹훅을 신뢰할 수 없으므로 검증 자체를 실패시킨다(fail-closed).
     */
    ongiWebhookSecret: str('ONGI_WEBHOOK_SECRET'),

    // ---------------------------------------------------------------- 카카오페이 정기결제(빌키)
    /**
     * 카카오페이 어드민 키 (SECRET_KEY).
     * Authorization: SECRET_KEY ${KAKAO_SECRET_KEY} 헤더에 사용.
     * 카카오페이 계약 후 CID 환경변수와 함께 설정해야 한다.
     */
    kakaoSecretKey: str('KAKAO_SECRET_KEY'),
    /**
     * 카카오페이 가맹점 코드.
     * 정기결제(빌키) 전용 CID 는 일반 CID 와 다르므로 계약 시 별도 발급받아야 한다.
     */
    kakaoCid: str('KAKAO_CID'),

    // ---------------------------------------------------------------- 코엠페이먼츠 카드 빌키
    /** 상점ID (Fix 15자리). */
    koemMid: str('KOEM_MID'),
    /** 64자리 고유 암호키. HMAC-SHA256 서명 키로 쓴다. */
    koemApiKey: str('KOEM_API_KEY'),
    /** 개발기 https://183.111.29.87:39500 / 상용기 https://paycc.coam.co.kr */
    koemApiBase: str('KOEM_API_BASE'),

    /** 헥토 공식 제한은 결제인증 후 10분. 그보다 짧게 운용한다. */
    confirmTtlSec: num('PAYMENT_CONFIRM_TTL_SEC', 300),
    /** PIN 입력 링크 유효시간. 결제사 인증창 유효시간(10분)을 넘지 않게 잡는다. */
    pinTtlSec: num('PAYMENT_PIN_TTL_SEC', 300),
    /** PIN 완료 콜백 검증용 공유 비밀 (X-Pin-Secret). 실연동 시 결제사 서명 검증으로 대체한다. */
    pinCallbackSecret: str('PAYMENT_PIN_CALLBACK_SECRET'),
    /**
     * PIN 완료 콜백에서 "인증 성공"으로 인정할 결과코드 목록 (대문자, 콤마 구분).
     * 이 목록에 없는 코드는 인증 실패로 처리하고 승인(출금)을 실행하지 않는다.
     * 실연동 시 결제사 규격의 성공 코드로 교체한다.
     */
    pinSuccessCodes: str('PAYMENT_PIN_SUCCESS_CODES', '0000,OK,SUCCESS,MOCK')
      .split(',')
      .map((v) => v.trim().toUpperCase())
      .filter(Boolean),
    /**
     * PIN 완료 콜백을 받을 결제사 IP 허용목록 (콤마 구분).
     *
     * 공유 비밀 하나만으로는 부족하다. 비밀이 한 번 유출되면 누구나
     * `{donationId, resultCode:"0000"}` 만 보내 후원자가 PIN 을 입력하지 않은 채
     * 출금을 강제할 수 있다. MO 웹훅과 같은 수준(서명 + IP)으로 맞춘다.
     * 운영에서 비어 있으면 기동을 중단한다.
     */
    pinAllowedIps: str('PAYMENT_PIN_ALLOWED_IPS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    /** PIN 콜백 서명(타임스탬프 + 본문 HMAC)의 허용 시각 오차(초). 재생 공격 방어. */
    pinCallbackToleranceSec: num('PAYMENT_PIN_CALLBACK_TOLERANCE_SEC', 300),
  },

  mo: {
    provider: str('MO_PROVIDER', 'mock') as ProviderMode,
    webhookSecret: str('MO_WEBHOOK_SECRET'),
    allowedIps: str('MO_ALLOWED_IPS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    /** MTONET 050/MO 연동 값. */
    mtonetUserId: str('MTONET_USER_ID'),
    mtonetApiKey: str('MTONET_API_KEY'),
  },

  /**
   * EMMA (인포뱅크 온프레미스 SMS 에이전트) 연동.
   *
   * EMMA 는 웹훅을 보내지 않고 자기 DB 테이블에 읽고 쓴다. 그래서 MO 는 폴링으로 가져오고
   * MT 는 발송 큐 테이블에 적재하는 방식으로 붙는다.
   *
   * 활성 조건은 `EMMA_ENABLED=true` 하나로 모은다. MO_PROVIDER/MT_PROVIDER 와 따로 놀면
   * "수신은 EMMA, 발송은 mock" 같은 어긋난 조합이 조용히 만들어진다.
   */
  emma: {
    enabled: bool('EMMA_ENABLED', false),
    /**
     * EMMA 전용 DB 접속 URL. 비우면 앱과 같은 DB(DATABASE_URL)를 쓴다.
     * EMMA 는 테이블·프로시저 생성 권한을 요구하므로 **분리를 권장**한다.
     */
    dbUrl: str('EMMA_DB_URL'),
    poolMax: num('EMMA_DB_POOL_MAX', 4),
    /**
     * 계약한 대표번호(숫자만). 예: 1688 + 계약 4자리 = 16881234
     * 설정하면 이 대표번호로 들어온 수신만 처리한다. 한 EMMA 에 여러 서비스의 번호가 물린
     * 구성에서 서로의 문자를 가로채는 사고를 막는 안전판이다.
     */
    baseNumber: str('EMMA_MO_BASE_NUMBER'),
    /**
     * EMMA 이중화 인스턴스 ID(2자리). **이중화를 실제로 쓸 때만** 설정한다.
     * 값이 EMMA 설정과 다르면 MT 가 큐에 쌓이기만 하고 발송되지 않는다(mt-sender.ts 주석 참고).
     */
    emmaId: str('EMMA_ID'),
    /**
     * 장문(MMS) 발송 큐 `em_mmt_tran` 의 service_type 값.
     *
     * 단문 큐는 '0'(SMS) 으로 확정돼 있지만, 장문 큐 값은 설치본·계약 형태에 따라 다를 수 있다.
     * 코드를 고치지 않고 맞출 수 있도록 열어 둔다. 값이 틀리면 큐에 쌓이기만 하고 발송되지 않는다.
     */
    mmsServiceType: str('EMMA_MMS_SERVICE_TYPE', '0'),
    /**
     * 폴링 1회에 가져올 최대 건수.
     *
     * 0 이나 음수가 들어오면 `LIMIT 0` 이 되어 **문자가 들어와도 한 건도 처리되지 않는다.**
     * 그런데 배치는 성공(fetched=0)으로 끝나므로 아무도 알아채지 못한다. 오타 하나로
     * 후원 전건이 조용히 멈추는 것을 막기 위해 최솟값 1 을 강제한다.
     * 상한도 둔다(1000). 지나치게 크면 한 번의 폴링이 잠금 시간을 넘겨 중복 처리를 유발한다.
     */
    batchSize: Math.min(1000, Math.max(1, Math.trunc(num('EMMA_MO_BATCH_SIZE', 200)))),
    /**
     * 선점된 채 이 시간(초)을 넘긴 건은 중단된 것으로 보고 되살린다.
     * 너무 짧으면 정상 처리 중인 건을 다른 폴링이 가로채므로 최솟값 30초를 강제한다.
     */
    staleSec: Math.max(30, Math.trunc(num('EMMA_MO_STALE_SEC', 300))),
  },

  /** 문자 발송(MT). provider 는 mock | coolsms | emma 를 지원한다. */
  mt: {
    provider: str('MT_PROVIDER', 'mock') as ProviderMode,
    apiKey: str('MT_API_KEY'),
    apiSecret: str('MT_API_SECRET'),
    fromNumber: str('MT_FROM_NUMBER', '16881234'),
    /**
     * 사업자에 등록한 발신번호. 사업자 규격에서 부르는 이름이 sender 이므로 별도 변수로 받는다.
     * 미설정이면 기존 MT_FROM_NUMBER 를 그대로 쓴다 (두 값을 따로 관리하다 어긋나는 사고 방지).
     */
    senderNumber: str('MT_SENDER_NUMBER', str('MT_FROM_NUMBER', '16881234')),
  },

  youtube: {
    provider: str('YOUTUBE_PROVIDER', 'mock') as ProviderMode,
    clientId: str('GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: str('GOOGLE_OAUTH_CLIENT_SECRET'),
    redirectUri: str('GOOGLE_OAUTH_REDIRECT_URI'),
    apiKey: str('YOUTUBE_API_KEY'),
    dailyQuota: num('YOUTUBE_DAILY_QUOTA', 10000),
    insertQuotaCost: num('YOUTUBE_INSERT_QUOTA_COST', 50),
    /**
     * 라이브 방송 조회(liveBroadcasts.list) 1회 비용.
     * 후원 1건마다 조회가 일어나므로 계상하지 않으면 실제 소비가 항상 카운터보다 크다.
     */
    listQuotaCost: num('YOUTUBE_LIST_QUOTA_COST', 1),
    /**
     * 크리에이터 1명이 하루에 쓸 수 있는 상한. 0 이면 개별 상한 없음(전체 상한만 적용).
     * 전체 예산을 한 채널이 독점해 다른 채널의 채팅이 전부 막히는 상황을 막는 안전판이다.
     */
    creatorDailyQuota: num('YOUTUBE_CREATOR_DAILY_QUOTA', 0),
    /**
     * 게임 참여 링크 공유가 하루에 쓸 수 있는 하위 예산.
     * 후원 알림은 시청자 돈이 걸린 기능이므로, 공유 버튼 연타가 그 예산을 잠식하지 못하게
     * 별도 상한을 둔다(전체 예산 안에서 소비한다).
     */
    shareDailyQuota: num('YOUTUBE_SHARE_DAILY_QUOTA', 1000),
    /** 라이브 방송 조회 결과 재사용 시간(초). 후원이 몰릴 때 list 호출과 지연을 줄인다. */
    broadcastCacheSec: num('YOUTUBE_BROADCAST_CACHE_SEC', 90),
  },

  settlement: {
    /**
     * 최소 정산 요청 금액.
     *
     * 이체 1건마다 은행 수수료와 관리자 확인 공수가 고정으로 든다. 하한이 없으면
     * 100원짜리 요청이 들어와도 같은 비용이 나가고, 원천징수 소액부징수 구간(33,334원 미만)과
     * 겹쳐 "요청은 됐는데 실제로는 손해" 인 건이 쌓인다.
     * 기본값은 0(하한 없음)이다. 하한은 사업 정책이라 코드가 임의로 정할 수 없고,
     * 기존 동작을 조용히 바꾸지 않기 위해서다. 운영에서 정한 값을 환경변수로 넣어 켠다.
     */
    minRequestAmount: BigInt(num('SETTLEMENT_MIN_REQUEST_AMOUNT', 0)),
  },

  /** 소셜 간편 로그인 (카카오 / 네이버). 키가 없으면 준비 중 상태로 표시된다. */
  social: {
    kakao: {
      clientId: str('KAKAO_CLIENT_ID'),
      clientSecret: str('KAKAO_CLIENT_SECRET'),
      redirectUri: str('KAKAO_REDIRECT_URI'),
    },
    naver: {
      clientId: str('NAVER_CLIENT_ID'),
      clientSecret: str('NAVER_CLIENT_SECRET'),
      redirectUri: str('NAVER_REDIRECT_URI'),
    },
  },

  tts: {
    provider: str('TTS_PROVIDER', 'mock') as ProviderMode,
    apiKey: str('TTS_API_KEY'),
    /**
     * 네이버 클로바 Voice 기본 인증 정보(플랫폼 공용).
     * 크리에이터가 스튜디오에서 직접 키를 입력하면 그 값이 우선한다.
     */
    naver: {
      clientId: str('NAVER_TTS_CLIENT_ID'),
      clientSecret: str('NAVER_TTS_CLIENT_SECRET'),
      speaker: str('NAVER_TTS_SPEAKER', 'nara'),
    },
  },

  storage: {
    bucket: str('S3_BUCKET'),
    publicBase: str('S3_PUBLIC_BASE'),
  },

  /**
   * 정리 배치(/api/cron/cleanup) 호출용 공유 비밀.
   * 외부 스케줄러(AWS EventBridge Scheduler 등)가 Authorization: Bearer 로 보낸다.
   * 비어 있으면 로컬에서만 호출을 허용한다(fail-closed).
   */
  cron: {
    secret: str('CRON_SECRET'),
  },

  safety: {
    /** 금융사 서면승인 등록 전에는 DIRECT_TRIGGER 를 열지 않는다. */
    allowDirectTrigger: bool('ALLOW_DIRECT_TRIGGER', false),
    /** true 이면 실제 결제/실제 MT 발송을 차단한다. */
    safeMode: bool('SAFE_MODE', true),
  },
} as const;

/**
 * 구(舊) CONFIRM_LINK 경로(토네이도 자체 확인 페이지)를 계속 쓸지 여부. **deprecated**
 *
 * 기본값 false — CONFIRM_LINK 모드는 결제사 PIN 인증 링크를 사용한다.
 * 되돌림(롤백)이 필요할 때만 ALLOW_LEGACY_CONFIRM_LINK=true 로 연다.
 *
 * `env` 객체가 아니라 함수로 노출하는 이유: 이 값은 운영 중 전환 가능한 스위치이고,
 * 테스트에서 두 경로를 모두 검증하려면 호출 시점에 읽어야 한다.
 */
export function allowLegacyConfirmLink(): boolean {
  return bool('ALLOW_LEGACY_CONFIRM_LINK', false);
}

/**
 * 후원샵 PC 웹 후원에서 구(舊) 즉시 결제를 계속 쓸지 여부. **deprecated**
 *
 * 기본값 false — 웹 후원도 결제사 PIN 인증 링크를 문자로 보내고, PIN 입력 후에 결제된다.
 * 되돌림(롤백)이 필요할 때만 ALLOW_LEGACY_WEB_INSTANT_PAY=true 로 연다.
 * (allowLegacyConfirmLink 와 같은 이유로 함수로 노출한다)
 */
export function allowLegacyWebInstantPay(): boolean {
  return bool('ALLOW_LEGACY_WEB_INSTANT_PAY', false);
}

export const isProd = env.appEnv === 'prod';
/** 개발 전용 기능(테스트 로그인, MO 시뮬레이터, 개발 아웃박스)을 열어도 되는 환경인지. */
export const isLocal = env.appEnv === 'local';

/** 운영 배포 전 반드시 통과해야 하는 환경 점검 */
export function assertProductionSafety(): string[] {
  const problems: string[] = [];
  if (!isProd) return problems;
  if (env.crypto.provider !== 'aws-kms' && !env.crypto.allowLocalInProd) {
    problems.push(
      '운영에서는 CRYPTO_PROVIDER=aws-kms 여야 합니다. ' +
        '(KMS 계약 전이라면 위험을 인지한 상태에서 ALLOW_LOCAL_CRYPTO_IN_PROD=true 로 명시하십시오. ' +
        'APP_ENV 를 낮춰 우회하면 운영 점검 전체가 건너뛰어져 훨씬 위험합니다)',
    );
  }
  // KMS 키 ID 가 없으면 provider 주입이 실패해 암호화가 전건 예외가 된다.
  if (env.crypto.provider === 'aws-kms' && !env.crypto.kmsKeyId) {
    problems.push('CRYPTO_PROVIDER=aws-kms 인데 AWS_KMS_KEY_ID 가 비어 있습니다.');
  }
  // local provider 로 운영한다면 마스터키만이 유일한 방어선이다. 약한 값이면 기동을 막는다.
  if (env.crypto.provider === 'local') {
    const raw = env.crypto.masterKey;
    if (!raw) problems.push('CRYPTO_MASTER_KEY 가 비어 있습니다.');
    else if (Buffer.from(raw, 'base64').length < 32) {
      problems.push('CRYPTO_MASTER_KEY 가 너무 약합니다. base64 로 인코딩한 32바이트 난수를 사용하십시오.');
    }
  }
  if (env.crypto.sessionSecret.startsWith('dev-only')) problems.push('SESSION_SECRET 이 기본값입니다.');
  if (env.crypto.phoneHashSecret.startsWith('dev-only')) problems.push('PHONE_HASH_SECRET 이 기본값입니다.');
  if (env.allowInMemoryFallback) problems.push('운영에서는 ALLOW_INMEMORY_FALLBACK=false 여야 합니다.');
  /**
   * MO 수신 경로는 둘 중 하나다.
   *  - 웹훅(사업자가 우리를 호출) → IP 허용목록·서명 시크릿이 유일한 방어선이므로 필수다.
   *  - EMMA 폴링(우리가 EMMA DB 를 읽음) → 외부에서 들어오는 요청 자체가 없다.
   * EMMA 를 쓰는데 웹훅 값을 강제하면 있지도 않은 시크릿을 만들어 넣게 되어 오히려 관리가 나빠진다.
   * 다만 웹훅 엔드포인트는 그대로 살아 있고, 그쪽은 verifyMoRequest() 가 fail-closed 로 막는다.
   */
  if (!env.emma.enabled) {
    if (env.mo.allowedIps.length === 0) problems.push('MO_ALLOWED_IPS 가 비어 있습니다.');
    if (!env.mo.webhookSecret) problems.push('MO_WEBHOOK_SECRET 이 비어 있습니다.');
  }
  // 비어 있으면 PIN 완료 콜백이 전건 거절되어 결제가 영원히 완료되지 않는다.
  if (!env.payment.pinCallbackSecret) problems.push('PAYMENT_PIN_CALLBACK_SECRET 이 비어 있습니다.');
  if (env.payment.provider === 'mock') problems.push('PAYMENT_PROVIDER 가 mock 입니다.');
  // SAFE_MODE 는 기본값이 true 다. 실키를 모두 넣고 이 값만 빠뜨리면 결제 어댑터가
  // mock 으로 대체되어(adapters/payment/index.ts) "돈은 안 나갔는데 승인 성공"이 되고,
  // 정산 원장에 3분개까지 쌓인다. 경고가 아니라 기동 중단으로 막는다.
  if (env.safety.safeMode) problems.push('운영에서는 SAFE_MODE=false 여야 합니다. (mock 어댑터로 대체되어 가짜 승인이 기록됩니다)');
  // 아래 두 provider 도 기본값이 mock 이다. 빠뜨리면 "전송 성공"으로 기록되지만
  // 실제로는 유튜브 채팅에도, 후원자 휴대폰에도 아무것도 나가지 않는다.
  if (env.youtube.provider === 'mock') problems.push('YOUTUBE_PROVIDER 가 mock 입니다.');
  if (env.mt.provider === 'mock') problems.push('MT_PROVIDER 가 mock 입니다.');
  // EMMA 폴링을 쓰면 MO 사업자 어댑터(웹훅 파서)는 사용되지 않는다.
  if (!env.emma.enabled && env.mo.provider === 'mock') problems.push('MO_PROVIDER 가 mock 입니다.');
  if (env.emma.enabled) {
    // 대표번호가 비면 어떤 번호로 들어온 문자든 전부 받아들인다. 한 EMMA 에 여러 서비스의
    // 번호가 물린 구성에서 남의 서비스 후원까지 우리 쪽에 쌓이므로 운영에서는 필수로 둔다.
    if (!env.emma.baseNumber.replace(/\D/g, '')) {
      problems.push('EMMA_ENABLED=true 인데 EMMA_MO_BASE_NUMBER 가 비어 있습니다. (계약한 대표번호를 지정하십시오)');
    }
    // 폴링 배치가 돌지 않으면 문자가 들어와도 후원이 만들어지지 않는다. 조용히 멈추는 실패다.
    if (!env.cron.secret) {
      problems.push('EMMA_ENABLED=true 인데 CRON_SECRET 이 비어 있습니다. (MO 폴링 배치가 전건 401 로 거절됩니다)');
    }
  }
  // 기본값에 MOCK/OK/SUCCESS 가 들어 있어, 그대로 두면 결제사가 무엇을 보내든 성공 처리된다.
  if (env.payment.pinSuccessCodes.some((c) => c === 'MOCK')) {
    problems.push('PAYMENT_PIN_SUCCESS_CODES 에 기본값 MOCK 이 남아 있습니다. 결제사 규격 코드로 교체해 주세요.');
  }
  if (env.payment.pinAllowedIps.length === 0) {
    problems.push('PAYMENT_PIN_ALLOWED_IPS 가 비어 있습니다. (PIN 완료 콜백이 IP 제한 없이 열립니다)');
  }
  if (!env.baseUrl.startsWith('https://')) problems.push('운영에서는 APP_BASE_URL 이 https 여야 합니다.');
  // 로컬 디스크 저장은 다중 인스턴스에서 이미지가 안 보이고 재배포 때 사라진다.
  if ((process.env.STORAGE_DRIVER ?? 'local').toLowerCase() !== 's3') {
    problems.push('운영에서는 STORAGE_DRIVER=s3 여야 합니다. (로컬 디스크 저장은 재배포 시 이미지가 사라집니다)');
  } else if (!process.env.S3_BUCKET) {
    problems.push('STORAGE_DRIVER=s3 인데 S3_BUCKET 이 비어 있습니다.');
  }
  // 각 provider 가 설정된 경우에만 해당 provider 의 키를 검증한다.
  // 다른 provider 의 키는 요구하지 않는다.
  if (env.payment.provider === 'hecto') {
    if (!env.payment.hectoMid) problems.push('HECTO_MID 가 비어 있습니다.');
    if (!env.payment.hectoHashKey) problems.push('HECTO_HASH_KEY 가 비어 있습니다.');
    if (!env.payment.hectoAesKey) problems.push('HECTO_AES_KEY 가 비어 있습니다.');
    if (env.payment.hectoAuthUiBase === env.payment.hectoAuthApiBase) {
      problems.push('HECTO_AUTH_UI_BASE 와 HECTO_AUTH_API_BASE 는 서로 다른 호스트여야 합니다.');
    }
  }
  if (env.payment.provider === 'koem') {
    if (!env.payment.koemMid) problems.push('KOEM_MID 가 비어 있습니다.');
    if (!env.payment.koemApiKey) problems.push('KOEM_API_KEY 가 비어 있습니다.');
    if (!env.payment.koemApiBase) problems.push('KOEM_API_BASE 가 비어 있습니다.');
  }
  if (env.payment.provider === 'ongi') {
    if (!env.payment.ongiApiKey) problems.push('ONGI_API_KEY 가 비어 있습니다.');
  }
  if (env.payment.provider === 'kakao') {
    if (!env.payment.kakaoSecretKey) problems.push('KAKAO_SECRET_KEY 가 비어 있습니다.');
    if (!env.payment.kakaoCid) problems.push('KAKAO_CID 가 비어 있습니다.');
  }
  return problems;
}

/**
 * 기동을 막지는 않지만 운영자가 확인해야 하는 설정.
 *
 * "없으면 서비스가 위험한 값"은 assertProductionSafety() 에서 기동을 중단시키고,
 * "없으면 특정 기능만 멈추는 값"은 여기서 경고만 남긴다.
 */
export function bootWarnings(): string[] {
  const warnings: string[] = [];
  if (isProd && !env.cron.secret) {
    warnings.push(
      'CRON_SECRET 이 비어 있습니다. 정리 배치(/api/cron/cleanup)가 전건 401 로 거절되어 ' +
        '만료된 PIN 인증/확인 링크가 자동 취소되지 않습니다.',
    );
  }
  // provider=local 인데 마스터키가 없으면 개인정보 암호화가 호출 시점에 예외가 된다.
  if (env.crypto.provider === 'local' && !env.crypto.masterKey) {
    warnings.push('CRYPTO_MASTER_KEY 가 비어 있습니다. 개인정보 암호화가 호출 시점에 실패합니다.');
  }
  if (env.emma.enabled && !env.emma.dbUrl.trim()) {
    warnings.push(
      'EMMA_DB_URL 이 비어 있어 EMMA 가 앱과 같은 DB 를 쓰는 구성입니다. EMMA 는 테이블·프로시저 ' +
        '생성 권한을 요구하므로 전용 DB 분리를 권장합니다. (반대로 Prisma 작업이 em_* 테이블을 지울 수도 있습니다)',
    );
  }
  if (env.mt.provider === 'emma' && !env.emma.enabled) {
    warnings.push('MT_PROVIDER=emma 인데 EMMA_ENABLED 가 꺼져 있습니다. 문자 발송이 큐에 쌓이기만 하고 나가지 않습니다.');
  }
  if (env.emma.enabled && env.emma.emmaId.trim() !== '') {
    warnings.push(
      `EMMA_ID=${env.emma.emmaId} 가 설정되어 있습니다. 이 값은 EMMA 이중화 인스턴스 ID 이며, ` +
        'EMMA 설정과 정확히 일치하지 않으면 MT 가 큐에 쌓이기만 하고 발송되지 않습니다. 이중화를 쓰지 않는다면 비워 두십시오.',
    );
  }
  if (isProd && env.crypto.provider === 'local' && env.crypto.allowLocalInProd) {
    warnings.push(
      'ALLOW_LOCAL_CRYPTO_IN_PROD=true 로 운영 중입니다. 개인정보가 KMS 가 아닌 로컬 마스터키로 ' +
        '암호화됩니다. KMS 계약 후 반드시 CRYPTO_PROVIDER=aws-kms 로 전환하십시오.',
    );
  }
  /**
   * E-1. EMMA MT 는 단문 큐(em_smt_tran)만 확실하다.
   *
   * 90바이트를 넘는 본문(PIN 인증 링크·등록 안내 등 결제 흐름의 필수 문자 대부분)은 장문이라
   * MMS MT 서비스를 따로 계약·활성화해야 나간다. 활성화되어 있으면 어댑터가 장문 큐(em_mmt_tran)로
   * 폴백하지만, 그 테이블이 없으면 **해당 문자는 전건 실패한다.** 기동은 막지 않되(폴백이 성공할
   * 수도 있으므로) 반드시 눈에 띄게 남긴다.
   */
  if (env.mt.provider === 'emma') {
    warnings.push(
      'MT_PROVIDER=emma 설정 시 LMS(90바이트 초과 장문) 발송 불가 — 반드시 MMS MT 계약이 필요합니다. ' +
        'EMMA 에 MMS MT 서비스(장문 큐 em_mmt_tran)가 없으면 PIN 인증 링크·등록 안내 문자가 전건 실패합니다. ' +
        '계약이 어렵다면 MT 템플릿 본문을 90바이트 이내로 줄이십시오.',
    );
  }
  /**
   * E-2. 헥토 PIN 인증창은 아직 mock 이다(adapters/payment/hecto.ts requestPinLink).
   *
   * 실키를 모두 넣고 SAFE_MODE 까지 꺼도 이 경로만은 토네이도 내부의 모의 PIN 화면 주소를
   * 돌려준다. 문자에는 [MOCK] 이 붙지만, 운영자가 "결제 연동 완료"로 오인하기 쉬운 지점이다.
   */
  if (env.payment.provider === 'hecto' || (env.payment.provider !== 'mock' && env.payment.hectoMid)) {
    warnings.push(
      `PAYMENT_PROVIDER=${env.payment.provider} 이지만 PIN 인증창 발급(requestPinLink)은 아직 mock 입니다. ` +
        '헥토 PIN 인증창 연동규격서 수령 전까지는 실제 결제사 인증창이 아니라 토네이도 내부 모의 화면 주소가 ' +
        '발송됩니다(본문에 [MOCK] 표기). 규격 수령 후 실제 API 로 교체해야 실결제가 완료됩니다.',
    );
  }
  return warnings;
}

/**
 * 부팅 시 1회 호출한다 (src/instrumentation.ts).
 * 운영 환경에서 위 점검을 통과하지 못하면 기동 자체를 중단시킨다.
 * — 잘못된 설정으로 조용히 서비스가 뜨는 것이 가장 위험하다.
 */
export function assertBootSafety(): void {
  const problems = assertProductionSafety();
  if (problems.length > 0) {
    const msg = `[env] 운영 환경 설정 점검 실패\n- ${problems.join('\n- ')}`;
    throw new Error(msg);
  }
  // staging/prod 에서 local 암호화 공급자를 쓰면서 마스터키가 없으면 기동을 막는다.
  // 빈 키로 조용히 뜬 뒤 encrypt() 첫 호출에서 예외가 터지는 fail-open 을 방지한다.
  if (!IS_LOCAL && env.crypto.provider === 'local' && !env.crypto.masterKey) {
    throw new Error(
      `[env] CRYPTO_MASTER_KEY 가 설정되지 않았습니다. APP_ENV=${APP_ENV}, CRYPTO_PROVIDER=local 환경에서는 필수입니다.`,
    );
  }
}
