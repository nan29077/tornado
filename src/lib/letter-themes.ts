/** 팬레터 편지지 테마 (2026-11-18) — 서버 화면과 클라이언트 화면이 함께 쓴다 */
export const LETTER_THEME_STYLE: Record<string, { label: string; paper: string; ink: string }> = {
  CREAM: { label: '크림', paper: 'bg-[#fff8e8] ring-[#f1dfb5]', ink: 'text-ink-900' },
  MINT: { label: '민트', paper: 'bg-[#eafaf3] ring-[#bfe8d6]', ink: 'text-ink-900' },
  PINK: { label: '핑크', paper: 'bg-[#fff0f4] ring-[#f6c9d6]', ink: 'text-ink-900' },
  NIGHT: { label: '밤하늘', paper: 'bg-[#1f2140] ring-[#3a3d6b]', ink: 'text-white' },
};
