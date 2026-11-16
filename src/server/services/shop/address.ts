/**
 * 배송지. 받는 분·연락처·주소는 암호화 + 마스킹으로 나눠 저장한다(CLAUDE.md 규칙 6).
 * 복호화는 발주서·배송 처리 화면(판매자·최고관리자)과 본인 배송지 수정 화면에서만 한다.
 */
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { decrypt, encrypt, maskName, maskPhone, normalizePhone } from '@/lib/crypto';

export interface AddressInput {
  label?: string | null;
  recipient: string;
  phone: string;
  zipcode: string;
  address1: string;
  address2?: string | null;
}

export interface SealedAddress {
  recipientMasked: string;
  recipientEnc: string;
  phoneMasked: string;
  phoneEnc: string;
  zipcode: string;
  addressMasked: string;
  addressEnc: string;
}

export function validateAddress(a: AddressInput): string | null {
  if (!a.recipient.trim() || a.recipient.trim().length > 30) return '받는 분 이름을 확인해 주세요.';
  const phone = normalizePhone(a.phone);
  if (!phone || !/^01\d{8,9}$|^0\d{8,10}$/.test(phone)) return '연락처를 확인해 주세요.';
  if (!/^\d{5}$/.test(a.zipcode.trim())) return '우편번호 5자리를 입력해 주세요.';
  if (!a.address1.trim() || a.address1.trim().length > 200) return '주소를 입력해 주세요.';
  if ((a.address2 ?? '').length > 100) return '상세 주소가 너무 깁니다.';
  return null;
}

/** "서울특별시 강남구 테헤란로 123, 101동 202호" → "서울특별시 강남구 ***" */
export function maskAddress(full: string): string {
  const parts = full.trim().split(/\s+/);
  return parts.length <= 2 ? `${parts[0] ?? ''} ***` : `${parts.slice(0, 2).join(' ')} ***`;
}

export function sealAddress(a: AddressInput): SealedAddress {
  const phone = normalizePhone(a.phone) ?? a.phone.replace(/\D/g, '');
  const full = [a.address1.trim(), (a.address2 ?? '').trim()].filter(Boolean).join(', ');
  return {
    recipientMasked: maskName(a.recipient.trim()),
    recipientEnc: encrypt(a.recipient.trim()),
    phoneMasked: maskPhone(phone),
    phoneEnc: encrypt(phone),
    zipcode: a.zipcode.trim(),
    addressMasked: maskAddress(full),
    addressEnc: encrypt(full),
  };
}

export function openAddress(s: Pick<SealedAddress, 'recipientEnc' | 'phoneEnc' | 'addressEnc' | 'zipcode'>) {
  return { recipient: decrypt(s.recipientEnc), phone: decrypt(s.phoneEnc), address: decrypt(s.addressEnc), zipcode: s.zipcode };
}

export async function saveMemberAddress(userId: string, input: AddressInput, opts: { id?: string; makeDefault?: boolean } = {}) {
  const err = validateAddress(input);
  if (err) throw new Error(err);
  const sealed = sealAddress(input);
  return prisma.$transaction(async (tx) => {
    const count = await tx.memberAddress.count({ where: { userId } });
    if (!opts.id && count >= 10) throw new Error('배송지는 10개까지 저장할 수 있습니다.');
    const makeDefault = opts.makeDefault || count === 0;
    if (makeDefault) await tx.memberAddress.updateMany({ where: { userId }, data: { isDefault: false } });
    const data: Prisma.MemberAddressUncheckedCreateInput = {
      id: opts.id ?? newId(),
      userId,
      label: input.label?.trim().slice(0, 20) || null,
      ...sealed,
      isDefault: makeDefault,
    };
    if (opts.id) {
      const moved = await tx.memberAddress.updateMany({ where: { id: opts.id, userId }, data: { ...data, id: undefined, userId: undefined } });
      if (moved.count === 0) throw new Error('배송지를 찾을 수 없습니다.');
      return opts.id;
    }
    await tx.memberAddress.create({ data });
    return data.id;
  });
}

export async function deleteMemberAddress(userId: string, id: string) {
  await prisma.$transaction(async (tx) => {
    const row = await tx.memberAddress.findFirst({ where: { id, userId }, select: { isDefault: true } });
    if (!row) return;
    await tx.memberAddress.delete({ where: { id } });
    if (row.isDefault) {
      const next = await tx.memberAddress.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
      if (next) await tx.memberAddress.update({ where: { id: next.id }, data: { isDefault: true } });
    }
  });
}

export async function setDefaultAddress(userId: string, id: string) {
  await prisma.$transaction(async (tx) => {
    const row = await tx.memberAddress.findFirst({ where: { id, userId }, select: { id: true } });
    if (!row) throw new Error('배송지를 찾을 수 없습니다.');
    await tx.memberAddress.updateMany({ where: { userId }, data: { isDefault: false } });
    await tx.memberAddress.update({ where: { id }, data: { isDefault: true } });
  });
}
