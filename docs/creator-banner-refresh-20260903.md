# 도네이도 후원 페이지 배너 교체 — 2026-09-03

## 작업 범위 / Claude 작업과의 분리

- 후원 페이지 및 설정 페이지, CSS, DB 데이터, 배너 선택 로직은 수정하지 않았다.
- 기존 파일 경로를 유지하여 `DEFAULT_BANNERS` 및 저장된 프리셋 URL 모두 새 이미지로 표시된다.
- 기본 경로: `public/banners/donaido-live-banner-01-v2.png` ~ `05-v2.png`.
- 이전 버전 호환 경로: `public/banners/donaido-banner-01.png` ~ `05.png`. 각 번호는 최신 배너와 동일한 이미지다.
- 개인 업로드 및 외부 URL 배너는 변경하지 않는다.
- 커밋, 푸시, 서버 재시작은 하지 않았다.
- 교체 직전 로컬 백업: `tmp/banner-backup-20260903/` (Git 제외).
- 생성 원본은 이미지 생성 도구 기본 저장 위치에 보존했다.

## 배너 구성

| 번호 | 콘셉트 | 스타일 |
| --- | --- | --- |
| 01 | 하트를 안고 인사하는 캐릭터의 방송 스튜디오 | 귀여운 3D 애니메이션풍 |
| 02 | 구름 위에서 하트 편지를 전하는 캐릭터 | 귀여운 3D 애니메이션풍 |
| 03 | 선물 상자에서 노래하는 캐릭터 | 귀여운 3D 애니메이션풍 |
| 04 | 햇살 드는 여성 크리에이터 방송 공간과 캐릭터 | 실사풍 공간 + 봉제 캐릭터 |
| 05 | 따뜻한 남성 크리에이터 팟캐스트 공간과 캐릭터 | 실사풍 공간 + 봉제 캐릭터 |

- 최종 크기: 1774 × 887, 2:1.
- 캐릭터 기준: `public/stickers/donaido/heart-hug.webp`.
- 정적 PNG 이미지다. '애니메이션풍'은 그림 스타일이며 움직이는 GIF가 아니다.
- 웹 전달 크기를 위해 PNG 색상 최적화를 적용했다.
- 이미지 자체에는 문구를 넣지 않았다. 프로필과 소개 문구는 기존 UI에서 표시한다.

## 적용 검증

- 일반 PostgreSQL 및 미리보기 DB: 각 2개 크리에이터 모두 `banner_url = null`로 기본 자동 배너 사용. DB 수정 없이 새 기본 배너 적용.
- 현재 배너 5개와 구버전 호환 배너 5개: 모두 HTTP 200, `image/png`, 실제 응답 바이트 SHA-256이 교체 파일과 일치.
- 캐시 헤더: `public, max-age=0` — 새 요청 시 재검증 가능한 상태.
- `/c/TOR-8K2M`: HTTP 200, `donaido-live-banner-05-v2.png` 참조 확인.
- 최종 기본 배너 5개 합계: 2,862,521 bytes.
- 생성된 5종의 이미지 자체는 시각 검수 완료. 현재 브라우저 연결이 없어 페이지 캡처 및 실제 모바일/PC 배치 검증은 미실시.
- Claude가 작업 중인 실행 서버를 중단하거나 다시 빌드하지 않았다.

## 생성 방식 및 최종 프롬프트

내장 image_gen 도구로 각 배너를 개별 생성했다. CLI/API 폴백은 사용하지 않았다.
각 프롬프트의 입력 이미지는 기존 캐릭터의 외형 참조이며, 기존 배너를 부분 수정하는 대상이 아니다.

### 01

Use case: ads-marketing. Asset type: an individual wide donation-page creator banner for the Korean fan-support livestream app DONAIDO. Input image is ONLY a character identity reference, not an edit target. Preserve the exact lovable mascot identity: sunny golden-yellow fluffy tornado creature, swept curl on top, cream spiral lower body tapering down, little rounded arms, expressive dark eyes, pink cheeks, warm smiling face. Create a new beautiful premium scene. Landscape 2:1 composition, no panels, no collage, no text, no letters, no logos, no watermark. Main character completely within the central 50% of the canvas, face in the central upper-middle, with roomy outer edges so responsive crops retain the character. Keep scene clear and gently detailed, no busy confetti over faces. Warm cream, golden yellow and soft coral accents matching the mascot. Style: gorgeous cute 3D animated feature-film illustration, tactile velvety textures. Scene: a welcoming cream-colored livestream studio; the mascot waves beside a compact microphone and hugs a coral heart, soft honey-colored light, small heart-shaped glow in the air, cozy pastel monitor and audio desk arranged at the side. Joyful gentle mood. The mascot is the hero, not a human.

### 02

Use case: ads-marketing. Asset type: an individual wide donation-page creator banner for the Korean fan-support livestream app DONAIDO. Input image is ONLY a character identity reference, not an edit target. Preserve the exact lovable mascot identity: sunny golden-yellow fluffy tornado creature, swept curl on top, cream spiral lower body tapering down, little rounded arms, expressive dark eyes, pink cheeks, warm smiling face. Create a new beautiful premium scene. Landscape 2:1 composition, no panels, no collage, no text, no letters, no logos, no watermark. Main character completely within the central 50% of the canvas, face in the central upper-middle, with roomy outer edges so responsive crops retain the character. Keep scene clear and gently detailed, no busy confetti over faces. Warm cream, golden yellow and soft coral accents matching the mascot. Style: gorgeous cute 3D animation with a dreamy soft storybook finish. Scene: the mascot floating on a small cream cloud, lovingly delivering a heart-sealed message envelope between creator and fans, a few small golden star lights and soft coral hearts, expansive pastel peach and ivory sky, warm sunrise. Clear full mascot silhouette in the central crop-safe area. Do not add humans.

### 03

Use case: ads-marketing. Asset type: an individual wide donation-page creator banner for the Korean fan-support livestream app DONAIDO. Input image is ONLY a character identity reference, not an edit target. Preserve the exact lovable mascot identity: sunny golden-yellow fluffy tornado creature, swept curl on top, cream spiral lower body tapering down, little rounded arms, expressive dark eyes, pink cheeks, warm smiling face. Create a new beautiful premium scene. Landscape 2:1 composition, no panels, no collage, no text, no letters, no logos, no watermark. Main character completely within the central 50% of the canvas, face in the central upper-middle, with roomy outer edges so responsive crops retain the character. Keep scene clear and gently detailed, no busy confetti over faces. Warm cream, golden yellow and soft coral accents matching the mascot. Style: premium cute animated 3D film still. Scene: the mascot emerging joyfully from a cream gift box tied with a coral ribbon at a cozy mini music stage, holding a tiny microphone; warm soft stage lights, a few small hearts and musical-note shapes, cream and pale honey stage with coral details. Charming and celebratory but uncluttered. Mascot is the only character.

### 04

Use case: ads-marketing. Asset type: an individual wide donation-page creator banner for the Korean fan-support livestream app DONAIDO. Input image is ONLY a character identity reference, not an edit target. Preserve the exact lovable mascot identity: sunny golden-yellow fluffy tornado creature, swept curl on top, cream spiral lower body tapering down, little rounded arms, expressive dark eyes, pink cheeks, warm smiling face. Create a new beautiful premium scene. Landscape 2:1 composition, no panels, no collage, no text, no letters, no logos, no watermark. Main character completely within the central 50% of the canvas, face in the central upper-middle, with roomy outer edges so responsive crops retain the character. Keep scene clear and gently detailed, no busy confetti over faces. Warm cream, golden yellow and soft coral accents matching the mascot. Style: photorealistic editorial lifestyle photography with a beautifully integrated realistic plush-toy version of the reference mascot; preserve its shape, yellow plush texture, cream spiral and joyful face. Scene: sunlit real home creator's desk, a natural-looking young adult Korean female streamer with tasteful casual cream clothing is softly smiling beside a real microphone in the background; the plush mascot holding a small coral heart is the central foreground hero on a wood desktop, with real fabric fibers, soft contact shadows, realistic lens depth and skin texture. Bright cozy warm beige studio, no dramatic black areas, no pasted-on graphics.

### 05

Use case: ads-marketing. Asset type: an individual wide donation-page creator banner for the Korean fan-support livestream app DONAIDO. Input image is ONLY a character identity reference, not an edit target. Preserve the exact lovable mascot identity: sunny golden-yellow fluffy tornado creature, swept curl on top, cream spiral lower body tapering down, little rounded arms, expressive dark eyes, pink cheeks, warm smiling face. Create a new beautiful premium scene. Landscape 2:1 composition, no panels, no collage, no text, no letters, no logos, no watermark. Main character completely within the central 50% of the canvas, face in the central upper-middle, with roomy outer edges so responsive crops retain the character. Keep scene clear and gently detailed, no busy confetti over faces. Warm cream, golden yellow and soft coral accents matching the mascot. Style: photorealistic commercial lifestyle photograph with the same reference mascot as a high-quality tactile yellow-and-cream plush figure. Scene: a cozy real evening podcast studio; a young adult Korean male creator wearing casual neutral clothing sits softly out of focus beside a microphone, the adorable plush tornado mascot with a coral heart cushion occupies the central foreground on a warm wood tabletop; professional camera and headphones at outer edges, amber lamp glow, natural realistic textile and skin detail, friendly fan-community mood. Mascot remains visually dominant, no dark empty half-frame.
