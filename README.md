# 도네이도 (DONAIDO)

문자 한 통으로 크리에이터를 후원하는 플랫폼. 시청자가 크리에이터별 MO 수신번호로 문자를 보내면 도네이도가 이를 수신해 후원 거래로 만들고, 결제가 완료된 건만 유튜브 라이브 채팅 · OBS/PRISM 오버레이 · TTS 로 방송에 노출합니다.

> **현재 상태: 1단계 Mock MVP.** 결제(헥토파이낸셜 내통장결제), MO/MT 문자, 유튜브, TTS, RTMPS 는 모두 **어댑터 인터페이스 + mock 구현**입니다. 실제 출금·문자 발송·유튜브 전송은 일어나지 않습니다.

---

## 빠른 시작 (Windows)

### A. 간편 미리보기 — `1_미리보기실행.bat` 하나만 실행 (권장)

**Node.js LTS 만 있으면 됩니다.** Docker 도, PostgreSQL 설치도 필요 없습니다.
내장 데이터베이스(PGlite — PostgreSQL 을 WASM 으로 빌드한 임베디드 엔진)를 사용하며, 실제 PostgreSQL 과 동일한 스키마·마이그레이션·트리거가 그대로 적용됩니다.

| 파일 | 설명 |
|---|---|
| `1_미리보기실행.bat` | 설치 → 내장 DB 기동 → 마이그레이션 → 시드 → 빌드 → 서버 실행 → 브라우저 자동 열기 |
| `3_서버종료.bat` | 창을 닫아도 남아 있는 서버 정리 |

주소는 **http://localhost:3025** 입니다. 데이터는 `.pglite` 폴더에 보관되어 다음 실행에도 유지됩니다.

> 첫 실행은 `npm install` 3~7분 + 화면 빌드 1~3분이 걸립니다. 멈춘 것처럼 보여도 정상이며, 두 번째부터는 30초 내외입니다.
> 코드를 고치면서 바로 확인하려면 `도구_수정즉시반영.bat` 을 쓰세요. 저장 즉시 화면에 반영됩니다(HMR).
> `EBADENGINE` 경고는 사용하지 않는 부가 패키지 경고이므로 무시해도 됩니다.

### B. 정식 개발 환경 — 실제 PostgreSQL 사용

운영과 동일한 조건으로 개발할 때 사용합니다. Docker Desktop 이 필요합니다.

| 순서 | 파일 | 설명 |
|---|---|---|
| 1 | `도구_DB시작.bat` | PostgreSQL + Redis 컨테이너 시작 |
| 2 | `도구_최초설치.bat` | 의존성 설치 → Prisma 생성 → 마이그레이션 → 시드 |
| 3 | `2_개발서버실행.bat` | 개발 서버 실행 + 준비 완료 후 브라우저 자동 열기 |

> Docker 없이 직접 설치한 PostgreSQL 을 쓰셔도 됩니다. `.env` 의 `DATABASE_URL` 만 바꾸고 `도구_최초설치.bat` 을 실행하세요.
> Redis 는 없어도 동작합니다. 연결에 실패하면 개발 환경에서는 인메모리로 자동 전환됩니다.

### 그 외

| 파일 | 설명 |
|---|---|
| `도구_수정즉시반영.bat` | 내장 DB + HMR 개발 모드. 저장하면 재시작 없이 화면에 반영 |
| `도구_환경점검.bat` | 환경 자동 점검 (Node·Docker·포트·DB 연결) — 문제가 생기면 이것부터 |
| `도구_상세진단.bat` | 상세 진단 로그 생성 (`logs\diag.log`) |
| `도구_설치복구.bat` | 깨진 node_modules 복구 (npm ci + 무결성 검사) |
| `도구_미리보기복구.bat` | `.next` 빌드 폴더가 잠겨 미리보기가 죽을 때 복구 실행 |
| `도구_DB초기화.bat` | 정식 개발 환경 DB 초기화 + 시드 |
| `도구_테스트실행.bat` | 통합 테스트 27개 실행 후 시드 재생성 |

**필요한 사전 설치**: [Node.js LTS](https://nodejs.org) (필수) · [Docker Desktop](https://www.docker.com/products/docker-desktop/) (B 방식만) · [Git](https://git-scm.com) (선택)

## 빠른 시작 (macOS / Linux)

```bash
npm install
cp .env.example .env
docker compose -p tornado up -d   # PostgreSQL + Redis
npm run db:deploy
npm run db:seed
npm run dev                       # http://localhost:3025
```

### 시드 계정

| 구분 | 계정 | 비밀번호 |
|---|---|---|
| 통합 관리자 | `admin@tornado.kr` | `tornado1234!` |
| 크리에이터 | `creator1@tornado.kr` | `tornado1234!` (코드 `TOR-8K2M`, 전용번호 `168812341001`) |
| 크리에이터 | `creator2@tornado.kr` | `tornado1234!` (코드 `TOR-3QP7`, 전용번호 `168812342002`) |
| 테스트 후원자 | `010-1234-5678` | 계좌 등록 완료 상태 |

---

## 전체 흐름 직접 확인하기

가장 쉬운 방법은 **관리자 → MO 시뮬레이터** (`/admin/simulator`) 입니다.

1. `admin@tornado.kr` 로 로그인 → `/admin/simulator`
2. 수신번호 `168812341001`, 발신번호 아무 번호, 문자 내용 입력 후 실행
3. 미등록 번호라면 계좌 등록 안내가 발송됩니다. 로컬에서는 `GET /api/dev/outbox` 로 발송된 문자와 보안링크 원문을 확인할 수 있습니다 (`APP_ENV=local` 에서만 동작).
4. 등록 링크 → 동의 → 모의 결제창에서 계좌 등록
5. 같은 번호로 다시 시뮬레이션 → 확인 링크 → `3,000원 후원하기`
6. 결제 성공 시 `/overlay/{creatorId}?token=...` 에 후원 알림이 뜨고, 정산 원장에 3분개가 쌓입니다.

MO Webhook 을 직접 호출하려면 HMAC 서명이 필요합니다.

```bash
BODY='{"messageId":"MO-1","to":"168812341001","from":"01012345678","text":"오늘 방송 재미있어요","type":"SMS"}'
SIG=$(node -e "const c=require('crypto');process.stdout.write(c.createHmac('sha256',process.env.MO_WEBHOOK_SECRET).update(process.argv[1]).digest('hex'))" "$BODY")
curl -X POST http://localhost:3025/api/webhooks/mo \
  -H 'Content-Type: application/json' \
  -H "x-tornado-signature: sha256=$SIG" \
  -d "$BODY"
```

---

## 명령어

| 명령 | 설명 |
|---|---|
| `npm run dev` | 개발 서버 |
| `npm run build` / `npm start` | 프로덕션 빌드 / 실행 |
| `npm run typecheck` | 타입 검사 |
| `npm test` | 핵심 흐름 통합 테스트 (Vitest, 실제 DB 사용) |
| `npm run db:migrate` | 마이그레이션 생성·적용 (개발) |
| `npm run db:deploy` | 마이그레이션 적용 (배포) |
| `npm run db:seed` | 시드 데이터 |
| `npm run db:reset` | DB 초기화 + 시드 |
| `npm run preview` | 내장 DB(PGlite) 로 미리보기 실행 |
| `npm run check:db` | DB 연결 점검 |

> `npm test` 는 실행 전후로 DB 를 비웁니다. 테스트 후에는 `npm run db:seed` 로 다시 채우세요.
> 미리보기 내장 DB(PGlite, 포트 5433)를 대상으로 테스트할 때는 연결 풀이 자동으로 1개로 고정됩니다. PGlite 는 연결을 하나의 세션에 다중화하므로 풀이 2개 이상이면 동시 요청이 서로 섞여 실패합니다.

---

## 화면 구조

```
공개        /  /how-it-works  /faq  /notice  /support  /terms  /privacy  /terms/e-finance
            /creator-apply  /login  /signup  /c/{크리에이터코드}
보안링크     /r/{token}                 계좌 등록 · 결제 확인 (1회용, 단기 만료)
후원자       /my                        후원내역 · 결제내역 · 등록계좌 · 한도 · 차단 · 동의이력
크리에이터   /studio                    대시보드 · 후원내역 · 문자관리 · 유튜브 · 오버레이 · TTS
                                       자체방송 · 후원설정 · 금칙어 · 신고 · 정산 · 프로필
통합 관리자  /admin                     23개 메뉴 (회원 · 크리에이터 · MO번호 · 거래 · 환불
                                       한도/이상거래 · 방송 · 정산 · 정책 · 콘텐츠 · 감사로그 · 시뮬레이터)
오버레이     /overlay/{creatorId}?token= OBS/PRISM 브라우저 소스
Mock        /mock/pg/register           헥토 결제창 대체 (실연동 시 제거)
            /mock/youtube/consent       구글 동의화면 대체
```

## API

| 엔드포인트 | 설명 |
|---|---|
| `POST /api/webhooks/mo` | MO 사업자 Webhook (HMAC 서명 + IP 허용 검증) |
| `GET /api/overlay/{creatorId}/stream` | 오버레이 실시간 이벤트 (SSE) |
| `POST /api/auth/login` `POST /api/auth/logout` | 인증 |
| `GET /api/youtube/oauth/callback` | 구글 OAuth 콜백 |
| `GET /api/health` | DB/캐시 상태, provider 모드, 운영 경고 |
| `POST /api/webhooks/pin-callback` | 결제사 PIN 인증 완료 콜백 (공유 비밀 + 결과코드 검증) |
| `GET /api/cron/cleanup` | 정리 배치 (외부 스케줄러가 1분 간격 호출). 아래 [정리 배치](#정리-배치-외부-크론) 참고 |
| `GET /api/dev/outbox` | **개발 전용** 모의 MT 발송함 (`APP_ENV=local` 에서만) |

---

## 정리 배치 (외부 크론)

앱 안에 스케줄러를 두지 않습니다. 다중 인스턴스에서 같은 작업이 동시에 도는 것을 막고,
컨테이너가 재시작돼도 일정이 유실되지 않게 하기 위해 **외부 스케줄러가 HTTP 로 호출**합니다.

```
GET  {APP_BASE_URL}/api/cron/cleanup
Authorization: Bearer {CRON_SECRET}
```

| 항목 | 값 |
|---|---|
| 주기 | **1분** |
| 인증 | `Authorization: Bearer ${CRON_SECRET}` (fail-closed) |
| 비밀 미설정 시 | `APP_ENV=local` 에서만 통과, 그 외 환경은 전건 401 |
| 동시 실행 | Redis 잠금으로 1개만 수행 (겹치면 `skipped: true` 응답) |

수행 작업

| 작업 | 내용 |
|---|---|
| `expireStalePinSessions` | PIN 을 입력하지 않아 TTL 이 지난 후원을 자동 취소한다. **결제사 콜백 미수신 건의 보정 경로**이기도 하다 |
| `expireStaleConfirmations` | 구 확인 링크(CONFIRM_LINK) 만료 건을 자동 취소한다 |
| `purgeExpiredIdempotencyKeys` | 만료된 멱등키를 지운다 |
| `purgeExpiredResetTokens` | 만료된 비밀번호 재설정 토큰을 지운다 |

### AWS EventBridge Scheduler 설정

1. **Secrets Manager** 에 `CRON_SECRET` 을 저장하고 앱 태스크에 주입합니다.
2. **EventBridge Scheduler** 에서 일정을 만듭니다.
   - 일정 유형: `rate(1 minute)`
   - 대상: **API destination** (또는 ALB 앞단 HTTP 엔드포인트)
   - HTTP 메서드: `GET`
   - 헤더: `Authorization: Bearer {CRON_SECRET}`
   - 재시도: 2회 / 최대 이벤트 수명 1분 (다음 주기가 이어서 처리하므로 길게 잡지 않습니다)
3. 응답 본문의 `steps` 로 각 작업 결과를 확인합니다. 한 작업이 실패해도 나머지는 계속 수행됩니다.

로컬에서는 비밀 없이 바로 호출해 확인할 수 있습니다.

```bash
curl http://localhost:3025/api/cron/cleanup
```

cron / Task Scheduler 등 다른 스케줄러를 써도 됩니다. 조건은 "1분 간격 GET + Bearer 헤더" 하나뿐입니다.

---

## 안전 스위치

| 환경변수 | 기본값 | 의미 |
|---|---|---|
| `SAFE_MODE` | `true` | 실제 결제 승인과 실제 MT 발송을 차단하고 mock 으로 대체 |
| `ALLOW_DIRECT_TRIGGER` | `false` | MO 수신 즉시 결제(`DIRECT_TRIGGER`) 허용 여부. 금융사 서면승인 등록 전에는 반드시 `false` |
| `PAYMENT_PIN_SUCCESS_CODES` | `0000,OK,SUCCESS,MOCK` | PIN 완료 콜백에서 인증 성공으로 인정할 결과코드. 목록 밖의 코드는 인증 실패로 확정되고 승인(출금)하지 않음 |
| `CRON_SECRET` | (없음) | 정리 배치 호출용 공유 비밀. 비어 있으면 `APP_ENV=local` 외 환경에서 배치가 전건 401 |
| `PAYMENT_PROVIDER` 외 | `mock` | 각 외부 연동의 실 사업자 전환 스위치 |

`GET /api/health` 와 `/admin` 대시보드에서 현재 상태를 항상 확인할 수 있습니다.

---

## 문서

| 문서 | 내용 |
|---|---|
| `docs/01_1차_분석_설계_보고서.md` | 사전 분석, 적용 범위, 필요 계약·키, 위험요소, 우선순위 |
| `docs/02_아키텍처.md` | 상태머신, 멱등성 4중 방어, 데이터 모델, 보안 설계 |
| `docs/03_AWS_배포_가이드.md` | RDS/Aurora, ElastiCache, Secrets Manager, 파티셔닝, 체크리스트 |
| `docs/04_1단계_완료보고서.md` | 구현 기능 / 테스트 결과 / Mock 인 기능 / 필요한 계약·키 / 다음 단계 |
| `CLAUDE.md` | 개발 규칙 |
