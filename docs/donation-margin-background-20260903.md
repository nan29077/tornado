# 도네이도 후원 페이지 좌우 여백 배경 — 2026-09-03

## 파일 / 적용 범위

- 왼쪽 이미지: `public/assets/donaido-donation-margin-left-v1.webp` (37,058 bytes)
- 오른쪽 이미지: `public/assets/donaido-donation-margin-right-v1.webp` (37,226 bytes)
- 이미지 크기: 각 1024 × 1536.
- 장식 컴포넌트: `src/components/public/creator-donate-backdrop.tsx`
- 격리 스타일: `src/components/public/creator-donate-backdrop.module.css`
- 기존 `creator-donate-shell.tsx`에 import 1줄과 컴포넌트 삽입만 추가.
- Claude의 후원 페이지 구성, 결제·문자후원 기능, 전역 CSS 및 데이터는 변경하지 않음.
- 고정 배경, 1024px 미만/인쇄 시 숨김. 본문+메뉴 824px와 추가 12px 여유를 보호.
- 장식은 접근성 트리에서 제외되며 포커스/클릭을 받지 않음.
- 원본 이미지 파일은 생성 도구 저장 위치에 보존. WebP 최적화본을 프로젝트에 저장.

## 최종 실행 반영 (후속 후원자 UI 작업)

- 2026-09-03 후속 요청에 따라 프로덕션 재빌드·재시작 완료. localhost:3025에서 양쪽 WebP HTTP 200 확인.
- 1440/1280/1024px PC와 768/390/320px 모바일 실제 Edge 브라우저에서 검증.
- 이미지 종횡비(2:3)에 맞는 영역에 마스크를 적용해 위아래 사각 경계를 제거.
- 후원 페이지·후원자 로그인·내 문자후원 내역에 같은 셸을 적용.
- 최종 브라우저 35항목 통과. 자세한 결과는 `donor-experience-20260903.md` 참고.

## 최초 정적 검증 기록 (당시 실행 반영 대기, 현재는 위와 같이 반영 완료)

- TypeScript `--noEmit --incremental false` 통과.
- 장식 컴포넌트 및 셸 ESLint 통과.
- CSS module 컴파일 및 정적 React 렌더링 통과.
- 390/768/1023px 숨김, 1024/1280/1440/1920/2560px 본문·메뉴 바깥 여백 계산 검증 통과.
- 이는 코드/정적 검증이며 실제 브라우저 화면 검증은 아님.
- 실행 중인 localhost:3025는 이전 프로덕션 빌드. 새 이미지 URL은 404, 새 장식 마크업도 아직 없음.
- Claude 병행 작업을 방해하지 않도록 실행 서버 재빌드·재시작은 사용자 승인 대기. 다음 실행 빌드에 위 컴포넌트 및 신규 public 자산을 함께 포함해야 함.
- 커밋·푸시 없음.

## 내장 이미지 생성 도구 / 최종 프롬프트

image_gen 내장 도구로 두 이미지를 각각 생성. CLI 폴백 미사용.
참조 이미지: `public/stickers/donaido/heart-hug.webp` (기존 캐릭터 외형 유지).

### 왼쪽

Use case: stylized-concept. Asset type: portrait decorative SIDE MARGIN wallpaper for a narrow centered creator donation webpage, NOT a main banner. Input image is character identity reference only. Preserve the same original DONAIDO cute golden-yellow fluffy tornado mascot: swept curl on its head, round smiling face, dark eyes, pink cheeks, tiny arms, cream spiral tapering body. Premium adorable 3D animation illustration with soft tactile plush textures. Vertical 2:3 canvas. Background pale ivory and light warm beige, airy soft cream clouds and only a few tiny pastel coral hearts and gold stars. The outer edges fade almost to plain warm ivory so the image can blend softly into a website. Spacious composition with LOTS of calm negative space; mascots are small accents, never enormous, each no wider than 45% of the canvas, placed close enough to the vertical center line to survive narrow responsive layouts. Clear silhouettes, gentle diffuse daylight, no heavy shadows, no text, no lettering, no logos, no watermarks, no borders, no collage frames. LEFT SIDE design: a small full-body tornado mascot near the upper third gently hugs a coral heart while sitting on a cream cloud; a second smaller version near the lower two-thirds joyfully holds a heart-sealed envelope. Surround with a few tiny floating hearts and faint soft golden swirl trails; keep the top and bottom 10% empty and fading into ivory. Sweet quiet supportive mood, not a busy repeating pattern.

### 오른쪽

Use case: stylized-concept. Asset type: portrait decorative SIDE MARGIN wallpaper for a narrow centered creator donation webpage, NOT a main banner. Input image is character identity reference only. Preserve the same original DONAIDO cute golden-yellow fluffy tornado mascot: swept curl on its head, round smiling face, dark eyes, pink cheeks, tiny arms, cream spiral tapering body. Premium adorable 3D animation illustration with soft tactile plush textures. Vertical 2:3 canvas. Background pale ivory and light warm beige, airy soft cream clouds and only a few tiny pastel coral hearts and gold stars. The outer edges fade almost to plain warm ivory so the image can blend softly into a website. Spacious composition with LOTS of calm negative space; mascots are small accents, never enormous, each no wider than 45% of the canvas, placed close enough to the vertical center line to survive narrow responsive layouts. Clear silhouettes, gentle diffuse daylight, no heavy shadows, no text, no lettering, no logos, no watermarks, no borders, no collage frames. RIGHT SIDE complementary design: a small full-body tornado mascot near the upper-middle waves with a miniature microphone, seated on a soft cloud; a second smaller version near the lower third peeks out of a tiny cream present tied with a pale coral ribbon. A few little warm stars and coral hearts, extremely sparse cream clouds and subtle golden swirl trails, keep the top and bottom 10% empty and fading into ivory. Match the soft supportive visual world of the reference, airy rather than crowded.
