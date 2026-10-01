/**
 * 화면 하단 사업자 정보 (UI-6, 2026-10-01).
 *
 * 값은 서버의 환경변수(BUSINESS_*)에서 읽어 넘긴다. 채워진 항목만 보여 주며,
 * 하나도 없으면 아무것도 그리지 않는다. 서버·클라이언트 어디서든 쓸 수 있는 순수 표시 컴포넌트다.
 */
export interface BusinessInfoData {
  name: string;
  ceo: string;
  regNo: string;
  ecommerceNo: string;
  address: string;
  phone: string;
  email: string;
}

export function hasBusinessInfo(info: BusinessInfoData | null | undefined): info is BusinessInfoData {
  return Boolean(info && Object.values(info).some((v) => v && v.trim()));
}

export function BusinessInfo({ info, className = '' }: { info: BusinessInfoData | null | undefined; className?: string }) {
  if (!hasBusinessInfo(info)) return null;
  const items: Array<[string, string]> = [
    ['상호', info.name],
    ['대표', info.ceo],
    ['사업자등록번호', info.regNo],
    ['통신판매업 신고', info.ecommerceNo],
    ['주소', info.address],
    ['고객센터', info.phone],
    ['이메일', info.email],
  ].filter((pair): pair is [string, string] => Boolean(pair[1] && pair[1].trim()));
  return (
    <p className={`text-[11px] leading-relaxed text-ink-500 ${className}`}>
      {items.map(([label, value], i) => (
        <span key={label}>
          {i > 0 ? <span aria-hidden className="mx-1.5 text-ink-300">|</span> : null}
          {label} {value}
        </span>
      ))}
    </p>
  );
}
