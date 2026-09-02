-- PG 취소 API 타임아웃/네트워크 오류 시 환불이 APPROVED 에 영구 고착되던 문제(H-1) 수정.
-- 값 추가만 하고 같은 마이그레이션 안에서 그 값을 사용하지 않는다(PostgreSQL 제약).
ALTER TYPE "refund_status" ADD VALUE IF NOT EXISTS 'PENDING_RECOVERY' AFTER 'APPROVED';
