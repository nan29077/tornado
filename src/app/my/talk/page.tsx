import { redirect } from 'next/navigation';

/** 마이페이지 > 소통 → 하단 메뉴 [소통] 화면으로 통합 (2026-11-17) */
export default function MyTalkPage() {
  redirect('/talk');
}
