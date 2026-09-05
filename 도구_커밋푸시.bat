@echo off
chcp 65001 > nul
cd /d "E:\프로젝트\토네이도"

echo git lock 파일 확인 중...
if exist ".git\index.lock" (
    echo lock 파일 삭제 중...
    del /f ".git\index.lock"
    echo lock 파일 삭제 완료
)

echo.
echo 변경사항 스테이징...
git add -A

echo.
echo 커밋 중...
git commit -m "feat: 결제연동 P0 수정 및 제반 준비 작업

[P0] env.ts: PAYMENT_PROVIDER별 키 검증 분리
- koem/ongi/kakao/hecto 각자의 키만 검증, 타 provider 키 요구 안 함

[P0] donation-flow.ts: PIN_NOT_SUPPORTED 분기 추가
- 카드 빌키 결제 시 ALLOW_LEGACY_CONFIRM_LINK fallback 또는 안내 반환
- DIRECT_TRIGGER 미사용 (절대 규칙 7 준수)

[P0] 등록 복귀 payload 확장
- authNo(헥토), pg_token(카카오) searchParams 추출 후 전달

[보안] logger.ts: PAN 13-16자리 자동 마스킹 패턴 추가
[보안] donor-registration.ts: result_message DB 저장 전 scrubText 적용

[준비] kakao.ts: 어댑터 골격 및 내부 결함 2건 수정
[준비] ongi.ts: ONGI_SPEC 상세 TODO 주석
[준비] /api/webhooks/ongi: 501 stub 라우트 생성
[준비] hecto.ts: HECTO_SPEC 규격서 수령 후 채울 항목 TODO 상세화
[준비] .env.example: 전 결제수단 환경변수 정비
[준비] docs/결제연동_체크리스트.md 생성"

echo.
echo 푸시 중...
git push origin main

echo.
echo 완료!
pause
