/**
 * 영상 허브 — 샘플 데이터.
 *
 * 실제 채널이 하나도 등록되지 않았거나 유튜브 피드에 닿지 못할 때만 쓴다(VIDEO_HUB_SAMPLE=auto 기본).
 * 실존 인물·채널을 쓰지 않으며, 화면에는 반드시 "샘플" 배지가 붙고 재생되지 않는다.
 * (CLAUDE.md 절대 규칙 2: 실제 연동이 아닌 것을 성공처럼 보이지 않는다)
 */
import type { VideoCategorySlug, VideoItem } from '@/lib/video-hub';

const SAMPLES: Array<[VideoCategorySlug, string]> = [
  ['humor', '퇴근길에 생긴 일 레전드 모음'],
  ['humor', '친구 몰래카메라 2탄 반응 정리'],
  ['talk', '오늘은 구독자 질문에 전부 답해 봤어요'],
  ['talk', '새벽 팬챗 방송 하이라이트'],
  ['news', '이번 주 주요 이슈 10분 정리'],
  ['news', '경제 뉴스 쉽게 읽는 법'],
  ['politics', '국회 본회의 쟁점 한눈에 보기'],
  ['politics', '정책 토론 하이라이트 요약'],
  ['mukbang', '매운 떡볶이 3단계 도전 먹방'],
  ['mukbang', '시장 투어하며 길거리 음식 전부 먹기'],
  ['game', '신작 RPG 첫 플레이 3시간 압축'],
  ['game', '랭크 게임 역전승 하이라이트'],
  ['music', '비 오는 날 듣기 좋은 커버곡 모음'],
  ['music', '라이브 노래방 신청곡 특집'],
  ['beauty', '5분 데일리 메이크업 루틴'],
  ['travel', '1박 2일 바다 여행 브이로그'],
  ['pet', '강아지 첫 산책 성공기'],
  ['sports', '집에서 하는 20분 전신 운동'],
  ['study', '같이 공부해요 50분 집중 타이머'],
  ['finance', '초보를 위한 투자 용어 정리'],
  ['fishing', '새벽 방파제 낚시 조과 공개'],
  ['fishing', '루어 고르는 법 기초편'],
  ['mukbang', '혼밥 브이로그 집밥 레시피'],
  ['game', '시청자 참여 게임 대결'],
];

/** 고정 기준 시각으로부터 몇 시간씩 이전으로 배치한다 (화면에서 "N시간 전"으로 보인다). */
export function sampleVideos(now: number = Date.now()): VideoItem[] {
  return SAMPLES.map(([category, title], i) => ({
    id: `sample-${String(i + 1).padStart(2, '0')}`,
    source: 'sample' as const,
    title,
    channelId: `sample-channel-${(i % 8) + 1}`,
    channelTitle: `샘플 채널 ${(i % 8) + 1}`,
    thumbnail: null,
    publishedAt: new Date(now - (i * 5 + 2) * 3600_000).toISOString(),
    views: 1200 + ((i * 7919) % 480_000),
    category,
    isShort: i % 9 === 4,
    creator: null,
  }));
}
