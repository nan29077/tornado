import type { CSSProperties } from 'react';
import Image from 'next/image';
import { CLASSIC_MARGIN_IMAGE, CLASSIC_PUBLIC_MARGIN_URL, DEFAULT_SITE_IMAGE, isAiryMarginImage, siteImageUrl, siteMarginPanelUrl } from '@/lib/site-images';
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

/**
 * 여유로운 배경(airy-*)은 한 장(3:2)짜리 그림이라 화면 전체에 cover 로 깔면 화면 비율에 따라
 * 위·아래(와이드 모니터)가 잘려 장식·캐릭터가 사라졌다 (2026-11-17 수정).
 * 이제 좌우 여백 패널에 각각 "세로 높이에 맞춰" 깔고 바깥쪽 가장자리에 붙인다.
 * 위아래는 절대 잘리지 않고, 남는 폭은 그림의 바탕색으로 이어 칠한다.
 */
const AIRY_BASE: Readonly<Record<string, string>> = {
  'airy-cloud-post': '#fdf2e1',
  'airy-heart-ribbon': '#fbf0df',
  'airy-paper-stars': '#f6e9f0',
  'airy-retro-music': '#fceacc',
  'airy-watercolor-garden': '#fdeed8',
};

export function SiteMarginPreview({ preset }: { preset: string }) {
  if (preset === CLASSIC_MARGIN_IMAGE || isAiryMarginImage(preset)) {
    return (
      <span aria-hidden="true" className={styles.classicPreview}>
        <Image src={siteImageUrl('margin', preset) ?? CLASSIC_PUBLIC_MARGIN_URL} alt="" width={1536} height={1024} sizes="(max-width: 640px) 45vw, 192px" />
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
  const airy = isAiryMarginImage(preset);
  const fullScene = classicPublic;
  const animated = !classic && !airy && preset !== DEFAULT_SITE_IMAGE && !preset.startsWith('photo-');
  return (
    <div
      aria-hidden="true"
      data-donation-margin-scene={publicPage ? undefined : true}
      data-site-margin-preset={preset}
      className={[styles.scene, publicPage && styles.publicPage, classic && styles.classic, airy && styles.airy, animated && styles.animated].filter(Boolean).join(' ')}
      style={
        fullScene
          ? ({ '--site-margin-image': `url("${siteImageUrl('margin', preset)}")` } as CSSProperties)
          : airy
            ? ({ '--site-margin-base': AIRY_BASE[preset] ?? '#fdf2e1' } as CSSProperties)
            : undefined
      }
    >
      {!fullScene && SIDES.map((side, index) => (
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
