import { env } from '@/lib/env';
import { hmac, safeEqual } from '@/lib/crypto';

/**
 * 후원샵 웹 PIN 진행 쿠키(webdon_pin) 값 서명 (PAY-J).
 *
 * 예전에는 후원 ID 원문을 그대로 담았다. HttpOnly 라 스크립트로는 못 읽지만, 쿠키는 누구나
 * 직접 만들어 보낼 수 있다. 다른 사람의 후원 ID 를 알면 그 값을 쿠키에 넣는 것만으로 남의
 * PIN 대기 후원을 **취소**하거나 진행 상태를 볼 수 있었다.
 *
 * 세션 비밀키로 만든 HMAC 을 붙이고 읽을 때 검증한다. 서명이 없거나 맞지 않는 값
 * (예전 형식 쿠키 포함)은 "진행 중인 후원 없음"으로 본다. 쿠키 수명이 짧아 예전 형식 호환은 두지 않는다.
 *
 * 이 모듈은 'use server' 파일(app/actions/web-donation-pin.ts)에 두지 않는다. 그 파일의 export 는
 * 모두 클라이언트가 부를 수 있는 서버 액션이 되므로, 서명 함수가 노출되면 아무 ID 나 서명받을 수 있다.
 */

function sign(donationId: string): string {
  return hmac(`webdon_pin:${donationId}`, env.crypto.sessionSecret);
}

export function encodePinCookie(donationId: string): string {
  return `${donationId}.${sign(donationId)}`;
}

/** 서명이 맞으면 후원 ID, 아니면 null. 예외를 던지지 않는다. */
export function decodePinCookie(value: string | null | undefined): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0 || dot === value.length - 1) return null;
  const id = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  return safeEqual(sig, sign(id)) ? id : null;
}
