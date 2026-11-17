'use client';

import { useMemo, useState } from 'react';
import { HubChipGrid, PlatformSelect, type HubChip } from '@/components/video-hub/hub-chip-grid';
import { VIDEO_CATEGORIES, videosHref, type VideoPlatformSlug } from '@/lib/video-hub';

/**
 * 메인 [구독자 전용] 탭 · 방송국 분류 (2026-11-17 정리판).
 *  1차 분류: 플랫폼 셀렉트 박스  /  2차 분류: 주제 카테고리 한 줄 칩(옆으로 넘김)
 *  PC는 한 줄에 나란히, 모바일은 셀렉트 아래에 칩 줄을 둔다. 칩을 누르면 고른 플랫폼을 유지한 채 방송국으로 간다.
 */
export function CategoryChips({ className }: { className?: string }) {
  const [platform, setPlatform] = useState<VideoPlatformSlug | 'all'>('all');
  const chips = useMemo<HubChip[]>(
    () =>
      VIDEO_CATEGORIES.map((c) => ({
        key: `c:${c.slug}`,
        href: videosHref({ c: c.slug, p: platform }),
        label: c.label,
        tone: c.slug === 'donaido' ? 'brand' : 'normal',
      })),
    [platform],
  );
  return (
    <div className={className}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <PlatformSelect value={platform} onChange={setPlatform} size="md" className="w-full sm:w-[150px]" />
        <HubChipGrid chips={chips} size="md" label="방송국 카테고리" className="min-w-0 flex-1" />
      </div>
    </div>
  );
}
