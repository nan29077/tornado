'use client';

import * as React from 'react';
import Link from 'next/link';
import { ShoppingBag } from '@/components/brand/icons';
import { Badge, cx } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { removeVideoTagAction, saveVideoTagAction } from '@/app/actions/studio-shop';
import { describeTagWindow, formatTagTime, supportsTimedTag } from '@/lib/video-product-time';

export interface TagProductOption {
  id: string;
  name: string;
  price: string;
  soldOut: boolean;
}

export interface CurrentVideoTag {
  productId: string;
  productName: string;
  startSec: number | null;
  endSec: number | null;
  clickCount: number;
  soldQuantity: number;
  visible: boolean;
}

/**
 * 스튜디오 > 도네이도 샵 > 영상: 영상 1개에 상품 1개 연결 (유튜브는 표시 시간대 지정 가능).
 * 내 샵에 진열 중인 상품만 고를 수 있다.
 */
export function VideoTagEditor({
  platform,
  externalId,
  videoTitle,
  products,
  current,
  defaultOpen = false,
}: {
  platform: string;
  externalId: string;
  videoTitle: string;
  products: TagProductOption[];
  current: CurrentVideoTag | null;
  defaultOpen?: boolean;
}) {
  const timedAllowed = supportsTimedTag(platform);
  const [timing, setTiming] = React.useState<'all' | 'range'>(current && (current.startSec != null || current.endSec != null) ? 'range' : 'all');
  const isLive = platform === 'LIVE';

  return (
    <details className="group mt-2 w-full rounded-xl border border-ink-100 bg-ink-50/60" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2 text-[12.5px] font-bold text-ink-700 [&::-webkit-details-marker]:hidden">
        <ShoppingBag size={15} strokeWidth={1.8} className="text-brand-700" aria-hidden />
        {current ? (
          <>
            <span className="min-w-0 truncate text-ink-900">{current.productName}</span>
            <Badge tone="brand">{isLive ? '방송 내내' : describeTagWindow(current.startSec, current.endSec)}</Badge>
            {!current.visible ? <Badge tone="warning">판매 중지·진열 해제로 숨김</Badge> : null}
            <span className="text-[11.5px] font-semibold text-ink-400">
              클릭 {current.clickCount.toLocaleString('ko-KR')} · 판매 {current.soldQuantity.toLocaleString('ko-KR')}개
            </span>
          </>
        ) : (
          <span>{isLive ? '라이브 방송에 상품 연결하기' : '이 영상에 상품 연결하기'}</span>
        )}
        <span className="ml-auto text-[11.5px] font-semibold text-brand-700 group-open:hidden">{current ? '변경' : '설정'}</span>
      </summary>
      <div className="border-t border-ink-100 px-3 pb-3 pt-2.5">
        {products.length === 0 ? (
          <p className="text-[12.5px] text-ink-500">
            내 샵에 진열 중인 판매 상품이 없습니다. <Link href="/studio/shop/products" className="font-bold text-brand-700 underline">상품 관리</Link>에서 먼저 진열해 주세요.
          </p>
        ) : (
          <ActionForm action={saveVideoTagAction} submitLabel={current ? '변경 저장' : '상품 연결'} size="sm">
            <input type="hidden" name="platform" value={platform} />
            <input type="hidden" name="externalId" value={externalId} />
            <input type="hidden" name="videoTitle" value={videoTitle.slice(0, 120)} />
            <label className="block">
              <span className="text-[12px] font-bold text-ink-600">상품 (영상 1개당 1개)</span>
              <select
                name="productId"
                defaultValue={current?.productId ?? ''}
                required
                className="mt-1 h-10 w-full rounded-lg border border-ink-200 bg-white px-2.5 text-[13.5px]"
              >
                <option value="" disabled>
                  상품을 골라 주세요
                </option>
                {products.map((p) => (
                  <option key={p.id} value={p.id} disabled={p.soldOut}>
                    {p.name} · {p.price}
                    {p.soldOut ? ' (품절)' : ''}
                  </option>
                ))}
              </select>
            </label>
            {timedAllowed ? (
              <fieldset className="mt-2.5">
                <legend className="text-[12px] font-bold text-ink-600">표시 시간</legend>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {(
                    [
                      ['all', '영상 내내'],
                      ['range', '시간 지정'],
                    ] as const
                  ).map(([v, label]) => (
                    <label
                      key={v}
                      className={cx(
                        'flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-[12.5px] font-bold',
                        timing === v ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-700',
                      )}
                    >
                      <input type="radio" name="timing" value={v} checked={timing === v} onChange={() => setTiming(v)} className="sr-only" />
                      {label}
                    </label>
                  ))}
                </div>
                {timing === 'range' ? (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="text-[11.5px] font-semibold text-ink-500">시작 (비우면 처음부터)</span>
                      <input
                        name="start"
                        defaultValue={formatTagTime(current?.startSec)}
                        placeholder="예: 1:20"
                        inputMode="numeric"
                        className="mt-1 h-10 w-full rounded-lg border border-ink-200 bg-white px-2.5 text-[13.5px] tabular-nums"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[11.5px] font-semibold text-ink-500">끝 (비우면 영상 끝까지)</span>
                      <input
                        name="end"
                        defaultValue={formatTagTime(current?.endSec)}
                        placeholder="예: 2:00"
                        inputMode="numeric"
                        className="mt-1 h-10 w-full rounded-lg border border-ink-200 bg-white px-2.5 text-[13.5px] tabular-nums"
                      />
                    </label>
                    <p className="col-span-2 text-[11.5px] leading-relaxed text-ink-400">
                      분:초(1:20) 또는 초(80)로 입력합니다. 영상 아래 [이 영상 속 상품]은 항상 보이고, 지정한 시간대에는 [지금 영상에 나와요]로 강조됩니다. (유튜브 정책상 영상 화면 위에는 겹쳐 띄우지 않습니다)
                    </p>
                  </div>
                ) : null}
              </fieldset>
            ) : (
              <>
                <input type="hidden" name="timing" value="all" />
                <p className="mt-2 text-[11.5px] leading-relaxed text-ink-400">
                  {isLive
                    ? '방송 중 샵 영상 탭의 라이브 화면 아래에 [이 영상 속 상품]으로 보입니다.'
                    : '틱톡·인스타그램·페이스북 영상은 재생 위치를 알 수 없어 영상 아래에 늘 표시됩니다.'}
                </p>
              </>
            )}
          </ActionForm>
        )}
        {current ? (
          <div className="mt-2 flex justify-end">
            <ActionForm action={removeVideoTagAction} submitLabel="연결 해제" variant="ghost" size="sm" confirmMessage="이 영상의 상품 연결을 해제할까요?">
              <input type="hidden" name="platform" value={platform} />
              <input type="hidden" name="externalId" value={externalId} />
            </ActionForm>
          </div>
        ) : null}
      </div>
    </details>
  );
}
