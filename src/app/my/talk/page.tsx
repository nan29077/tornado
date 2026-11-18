import { redirect } from 'next/navigation';

/** 마이페이지 > 팬챗 → 하단 메뉴 [팬챗] 화면으로 통합 (2026-11-17) */
export default function MyTalkPage() {
  redirect('/talk');
}
