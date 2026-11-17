import { AdminSelect } from '@/components/admin/controls';

/** 켜기/끄기 선택칸 (관리자 폼) — 값 'on' 이면 켬 */
export function OnOff({ name, value, onLabel = '켜기', offLabel = '끄기' }: { name: string; value: boolean; onLabel?: string; offLabel?: string }) {
  return (
    <AdminSelect name={name} defaultValue={value ? 'on' : 'off'}>
      <option value="on">{onLabel}</option>
      <option value="off">{offLabel}</option>
    </AdminSelect>
  );
}

export const pctText = (r: number | null | undefined) => (r == null ? '' : String(Number((r * 100).toFixed(4))));
export const pctLabel = (r: number) => `${Number((r * 100).toFixed(2))}%`;
export const won = (n: number | bigint) => `${Number(n).toLocaleString('ko-KR')}원`;
