import type { CSSProperties } from 'react';
import Image from 'next/image';
import { CLASSIC_MARGIN_IMAGE, CLASSIC_PUBLIC_MARGIN_URL, DEFAULT_SITE_IMAGE, siteMarginPanelUrl } from '@/lib/site-images';
import styles from './creator-donate-backdrop.module.css';

const SIDES = ['left', 'right'] as const;

// 좁은 화면에서 실사 테마는 왼쪽 인물과 오른쪽 마스코트 얼굴을 우선 보인다.
const NARROW_FOCUS: Readonly<Record<string, readonly [number, number]>> = {
  default: [60, 47],
  cafe: [62, 45],
  clouds: [56, 47],
  garden: [48, 56],
  stars: [52, 43],
  waves: [53, 48],
  'photo-park': [42, 74],
  'photo-library': [36, 42],
  'photo-market': [43, 32],
  'photo-beach': [42, 38],
  'photo-workshop': [47, 35],
};

export function SiteMarginPreview({ preset }: { preset: string }) {
  if (preset === CLASSIC_MARGIN_IMAGE) {
    return (
      <span aria-hidden="true" className={styles.classicPreview}>
        <Image src={CLASSIC_PUBLIC_MARGIN_URL} alt="" width={1717} height={916} sizes="(max-width: 640px) 45vw, 192px" />
      </span>
    );
  }

  return (
    <span aria-hidden="true" className={styles.preview}>
      {SIDES.map((side) => (
        <Image
          key={side}
          src={siteMarginPanelUrl(preset, side)}
          alt=""
          width={766}
          height={1024}
          sizes="(max-width: 640px) 24vw, 120px"
        />
      ))}
    </span>
  );
}

/** 공개 화면의 본문과 메뉴 바깥에 표시하는 장식. */
export function CreatorDonateBackdrop({ preset, publicPage = false }: { preset: string; publicPage?: boolean }) {
  const classic = preset === CLASSIC_MARGIN_IMAGE;
  const classicPublic = classic && publicPage;
  const animated = !classic && preset !== DEFAULT_SITE_IMAGE && !preset.startsWith('photo-');
  return (
    <div
      aria-hidden="true"
      data-donation-margin-scene={publicPage ? undefined : true}
      data-site-margin-preset={preset}
      className={[styles.scene, publicPage && styles.publicPage, classic && styles.classic, animated && styles.animated].filter(Boolean).join(' ')}
      style={classicPublic ? { '--site-margin-image': `url("${CLASSIC_PUBLIC_MARGIN_URL}")` } as CSSProperties : undefined}
    >
      {!classicPublic && SIDES.map((side, index) => (
        <span
          key={side}
          className={`${styles.panel} ${styles[side]}`}
          style={{
            '--site-margin-image': `url("${siteMarginPanelUrl(preset, side)}")`,
            '--site-margin-narrow-focus': `${NARROW_FOCUS[preset]?.[index] ?? 50}%`,
          } as CSSProperties}
        />
      ))}
    </div>
  );
}
