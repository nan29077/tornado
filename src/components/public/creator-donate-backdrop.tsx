import styles from './creator-donate-backdrop.module.css';

/** 후원 페이지 전용 장식. 본문/메뉴 바깥에만 표시하며 클릭과 포커스를 받지 않는다. */
export function CreatorDonateBackdrop() {
  return (
    <div aria-hidden="true" data-donation-margin-scene className={styles.scene}>
      <div className={`${styles.side} ${styles.left}`} />
      <div className={`${styles.side} ${styles.right}`} />
    </div>
  );
}
