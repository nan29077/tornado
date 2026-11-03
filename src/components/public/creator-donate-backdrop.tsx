import type { CSSProperties } from 'react';
import styles from './creator-donate-backdrop.module.css';

const SIDES = ['left', 'right'] as const;

const DEFAULT_MARGIN_ART = {
  left: '/assets/donaido-donation-margin-left-v1.webp',
  right: '/assets/donaido-donation-margin-right-v1.webp',
} as const;

function imageStyle(image: string): CSSProperties {
  return { '--site-margin-image': `url("${image}")` } as CSSProperties;
}

export function SiteMarginPreview({ image }: { image: string }) {
  return (
    <span aria-hidden="true" className={styles.preview} style={imageStyle(image)}>
      {SIDES.map((side) => <span key={side} className={`${styles.art} ${styles[side]}`} />)}
    </span>
  );
}

/** 공개 화면의 본문과 메뉴 바깥에 표시하는 장식. */
export function CreatorDonateBackdrop({ image, publicPage = false }: { image?: string; publicPage?: boolean }) {
  return (
    <div
      aria-hidden="true"
      data-donation-margin-scene={publicPage ? undefined : true}
      data-site-margin-image={image}
      className={`${styles.scene} ${publicPage ? styles.publicPage : ''}`}
    >
      {SIDES.map((side) => (
        <div
          key={side}
          className={`${styles.wing} ${styles[side]} ${image ? '' : styles.original}`}
          style={imageStyle(image ?? DEFAULT_MARGIN_ART[side])}
        >
          <div className={styles.art} />
        </div>
      ))}
    </div>
  );
}
