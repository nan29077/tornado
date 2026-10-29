# 도네이도(DONAIDO) — 개발 가이드

문자 기반 크리에이터 후원 플랫폼. 이 문서는 이 저장소에서 작업할 때의 규칙입니다.

## 절대 규칙

1. **이모지를 사용하지 않는다.** 아이콘은 lucide-react 라인 아이콘만 사용한다 (size 16~20, strokeWidth 1.6~1.7). lucide-react v1 에는 브랜드 아이콘(Youtube 등)이 없다.
2. **실제 계약/키가 없는 외부 연동을 성공 처리하지 않는다.** 어댑터 인터페이스 + mock 구현으로만 처리하고, 화면에 mock 임을 명시한다.
3. **결제 성공과 방송 송출 성공을 같은 상태로 취급하지 않는다.** 유튜브 전송 실패가 결제 결과를 바꾸지 않는다.
4. **문자 한 건이 여러 번 결제되는 상황을 최우선으로 방지한다.** (멱등성 4중 방어 — `docs/02_아키텍처.md` 참고)
5. **정산 원장(`settlement_ledger`)은 append-only.** DB 트리거로 UPDATE/DELETE 가 차단되어 있다. 정정은 반대분개로 처리한다.
6. **개인정보/금융정보는 해시 + 암호화 + 마스킹 3분리 저장.** 화면과 로그에는 마스킹된 값만 노출한다.
7. `DIRECT_TRIGGER`(MO 수신 즉시 결제)는 `ALLOW_DIRECT_TRIGGER=true` 이면서 금융사 서면승인이 등록된 경우에만 사용한다. 기본값은 `CONFIRM_LINK`.

## 기술 스택

- Next.js 16 (App Router) / React 19 / TypeScript / Tailwind CSS v4
- Prisma 7 + PostgreSQL 16 (Amazon RDS / Aurora PostgreSQL 호환)
- Redis (ElastiCache) — 한도 카운터, 속도 제한, 오버레이 Pub/Sub
- Vitest (DB 통합 테스트)

## 디렉터리

```
prisma/            스키마, 마이그레이션, 시드
src/lib/           env, crypto, id, money, datetime, labels, logger
src/server/        db, auth, adapters/*, services/*
src/app/           라우트 (공개 / r / my / studio / admin / overlay / api)
src/components/    ui(공용), layout, brand, public, my, studio, admin, overlay
tests/             핵심 흐름 통합 테스트
docs/              분석·설계 보고서, 운영 문서
```

## 실행 방법

루트 배치 파일은 번호가 붙은 3개가 기본이고, 나머지는 `도구_` 접두사를 쓴다.

- **`1_미리보기실행.bat`** (또는 `npm run preview`) — Docker/PostgreSQL 설치 없이 내장 DB(PGlite)로 실행. 포트 3025.
  - 프로덕션 빌드 방식이라 소스가 바뀌면 재빌드(1~3분)를 한다. 실제 서비스와 같은 조건으로 최종 확인할 때 쓴다.
- **`2_개발서버실행.bat`** — 실제 PostgreSQL + Redis 를 쓰는 개발 서버. 처음에는 `도구_DB시작.bat` -> `도구_최초설치.bat` 순으로 준비한다.
- **`3_서버종료.bat`** — 창을 닫아도 남아 있는 서버를 정리한다. 창을 정상적으로 닫으면 서버도 함께 종료된다.
- **`도구_수정즉시반영.bat`** — 저장하면 서버 재시작 없이 화면에 바로 반영된다(HMR). 코드를 고치는 동안에는 이쪽을 쓴다. `1_미리보기실행.bat` 과 같은 실행기에 `PREVIEW_MODE=dev` 를 준 것이다.
- 문제가 생기면 `도구_환경점검.bat` 으로 원인을 먼저 점검하고, 로그가 필요하면 `도구_상세진단.bat` 을 쓴다.
- 그 밖의 도구: `도구_설치복구.bat`(node_modules 복구), `도구_미리보기복구.bat`(`.next` 잠김 복구), `도구_DB초기화.bat`, `도구_테스트실행.bat`.
- 공통 의존성 점검기는 `tools/ensure-deps.bat` 이다. 각 배치 파일이 `call` 로 부르므로 이름과 위치를 바꾸지 않는다.
- `.env` 에 `NODE_ENV` 를 넣지 않는다. 빌드/실행 모드가 뒤섞여 React 오류가 난다.
- `src/app/error.tsx` 등 에러 바운더리에서 훅(useEffect 등)을 쓰지 않는다. `/_global-error` 프리렌더가 실패한다.
- 서비스 포트는 **3025** 로 고정한다. 변경 시 package.json 의 dev/start, .env 의 PORT·APP_BASE_URL, 배치 파일을 함께 수정한다.

## 마이그레이션 주의

- 마이그레이션은 `prisma/migrations/` 아래 타임스탬프 순으로 40개가 넘게 쌓여 있다(첫 두 개가 `init_tornado` + `guards_and_indexes`, 2026-10-29 기준 48개). 새 마이그레이션은 기존 것을 고치지 말고 뒤에 추가한다. 순서에 의존하는 DROP 문을 넣지 말 것.
- 스키마를 바꾼 뒤에는 반드시 **빈 DB 에서 `npm run db:reset`** 으로 처음부터 적용되는지 확인한다.
- `prisma migrate reset` 대신 `npm run db:reset`(tools/db-reset.mjs)을 사용한다.

## 자주 쓰는 명령

```bash
npm run preview      # 내장 DB(PGlite)로 미리보기 (설치 불필요)
npm run dev          # 개발 서버 (외부 PostgreSQL 필요)
npm run build        # 프로덕션 빌드
npm run typecheck    # tsc --noEmit
npm test             # Vitest (DB 를 비우므로 실행 후 db:seed 필요)
npm run db:migrate   # prisma migrate dev
npm run db:seed      # 시드 데이터
npm run db:reset     # 초기화 + 시드
npm run check:db     # DB 연결 점검
```

## 공용 파일 수정 시 주의

`src/components/ui/index.tsx`, `src/lib/**`, `src/server/**`, `src/app/globals.css`, `prisma/schema.prisma` 는 전 화면이 공유한다. 변경 시 `npm run typecheck && npm test && npm run build` 를 모두 통과시킨다.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
