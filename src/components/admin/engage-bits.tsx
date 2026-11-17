import { Switch } from '@/components/admin/switch';

/**
 * 켜기/끄기 (관리자 폼) — 켜면 'on' 이 전송된다.
 * 2026-11-18: 선택칸에서 스위치로 바꿨다. AdminField(라벨) 안에 넣으면 칸 어디를 눌러도 켜고 끈다.
 */
export function OnOff({ name, value, onLabel = '켜기', offLabel = '끄기' }: { name: string; value: boolean; onLabel?: string; offLabel?: string }) {
  return (
    <span className="flex h-9 items-center">
      <Switch name={name} defaultChecked={value} onLabel={onLabel} offLabel={offLabel} />
    </span>
  );
}

export const pctText = (r: number | null | undefined) => (r == null ? '' : String(Number((r * 100).toFixed(4))));
export const pctLabel = (r: number) => `${Number((r * 100).toFixed(2))}%`;
export const won = (n: number | bigint) => `${Number(n).toLocaleString('ko-KR')}원`;
