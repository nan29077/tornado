/**
 * 영상 허브 — 기본 노출 채널 목록 (미가입 크리에이터).
 *
 * 다음 단계(관리자 "채널 관리" 화면 + DB 테이블)가 생기기 전까지 임시로 여기서 관리한다.
 * 코드 수정 없이 시험하려면 .env 에 VIDEO_HUB_CHANNELS 를 쓴다 (둘 다 합쳐진다).
 *   VIDEO_HUB_CHANNELS="UCxxxxxxxxxxxxxxxxxxxxxx:mukbang,UCyyyyyyyyyyyyyyyyyyyyyy:humor"
 *
 * 채널 ID 는 유튜브 채널 주소 youtube.com/channel/UC… 의 UC 로 시작하는 24자다.
 * 카테고리 값은 src/lib/video-hub.ts 의 VIDEO_CATEGORIES slug 중 하나 (all·donaido 제외).
 *
 * 도네이도에 가입·승인되고 유튜브를 연동한 크리에이터는 여기 적지 않아도 자동으로 들어간다.
 */
import type { VideoCategorySlug } from '@/lib/video-hub';

/**
 * 기본 노출 채널 (2026-11-17). 모두 유튜브 공개 RSS 로 채널명·최근 업로드를 확인한 공식 채널이다.
 * 시사·정치는 한쪽으로 치우치지 않도록 지상파·종편·보도채널·통신사·국회/정부 공식 방송을 함께 넣었다.
 * 끄기: .env 에 VIDEO_HUB_DEFAULT_CHANNELS=false (가입 크리에이터·VIDEO_HUB_CHANNELS 만 노출)
 */
const DEFAULT_CHANNELS: Array<[string, VideoCategorySlug, string]> = [
  // 시사 (보도)
  ['UChlgI3UHCOnwUGzWzbJ3H5w', 'news', 'YTN'],
  ['UCcQTRi69dsVYHN3exePtZ1A', 'news', 'KBS News'],
  ['UCF4Wxdo3inmxP-Y59wXDsFw', 'news', 'MBCNEWS'],
  ['UCkinYTS9IHqOEwR1Sze2JTw', 'news', 'SBS 뉴스'],
  ['UCsU-I-vHLiaMfV_ceaYz5rQ', 'news', 'JTBC News'],
  ['UCTHCOPwqNfZ0uiKOvFyhGwg', 'news', '연합뉴스TV'],
  ['UCfq4V1DAuaojnr2ryvWNysw', 'news', '채널A News'],
  ['UCWlV3Lz_55UaX4JsMj-z__Q', 'news', '뉴스TVCHOSUN'],
  ['UCG9aFJTZ-lMCHAiO1KJsirg', 'news', 'MBN News'],
  ['UCnHyx6H7fhKfUoAAaVGYvxQ', 'news', '동아일보'],
  // 정치 (국회·정부 공식 방송)
  ['UCL-WOj1FxKR8Hlzg5tvnWKg', 'politics', 'NATV 국회방송'],
  ['UCIMOytYIzaUpoAM2bpT4JZQ', 'politics', 'KTV 국민방송'],
  // 경제
  ['UCsJ6RuBiTVWRX156FVbeaGg', 'economy', '슈카월드'],
  ['UChlv4GSd7OQl3js-jkLOnFA', 'finance', '삼프로TV'],
  ['UCQ2DWm5Md16Dc3xRwwhVE7Q', 'economy', 'EO Korea'],
  // 유머 · 예능 · 토크
  ['UCGX5sP4ehBkihHwt5bs5wvg', 'humor', '피식대학'],
  ['UChbE5OZQ6dRHECsX0tEPEZQ', 'humor', '장삐쭈'],
  ['UCj-durTg1W7uWsB8oq0u7kA', 'humor', '엔조이커플'],
  ['UCDNvRZRgvkBTUkQzFoT_8rA', 'entertain', '뜬뜬'],
  ['UCiBr0bK06imaMbLc8sAEz0A', 'entertain', 'MBCentertainment'],
  ['UCmjNKt6kITwaZTqvWuaSPLg', 'entertain', 'SBS Entertainment'],
  ['UCsRIHt5FkbGc6cQtCxt-ufA', 'entertain', 'tvN D ENT'],
  ['UCUj6rrhMTR9pipbAWBAMvUQ', 'talk', '침착맨'],
  // 먹방 · 요리
  ['UCfpaSruWW3S4dibonKXENjA', 'mukbang', '쯔양'],
  ['UCA6KBBX8cLwYZNepxlE_7SA', 'mukbang', '히밥'],
  ['UCyn-K7rZLXjGl7VXGweIlcA', 'cooking', '백종원'],
  ['UC0htUSwcxfSGNfK_5Q28JkA', 'cooking', '1분요리 뚝딱이형'],
  // 게임
  ['UCyHvSKT_bLDYpkv1JjjsLAg', 'game', '풍월량'],
  ['UCW945UjEs6Jm3rVNvPEALdg', 'game', '우정잉'],
  // 음악 · 댄스
  ['UCweOkPb1wVVH0Q0Tlj4a5Pw', 'music', '1theK'],
  ['UCbD8EppRX3ZwJSou-TVo90A', 'music', 'Mnet K-POP'],
  ['UC3IZKseVpdzPSBaWxBxundA', 'music', 'HYBE LABELS'],
  ['UCEf_Bc-KVd7onSeifS3py9g', 'music', 'SMTOWN'],
  ['UCw8ZhLPdQ0u_Y-TLKd61hGA', 'dance', '1MILLION Dance Studio'],
  // 영화 · 드라마 · 애니
  ['UCaHGOzOyeYzLQeKsVkfLEGA', 'movie', '지무비'],
  ['UChpjIaEgwtDZtmWEkzFulSA', 'drama', 'KBS Drama'],
  ['UCRuSxVu4iqTK5kCh90ntAgA', 'animation', '총몇명'],
  // 뷰티
  ['UC9kmlDcqksaOnCkC_qzGacA', 'beauty', 'RISABAE'],
  ['UCnekLiljel-Px4ClMC7b3mg', 'beauty', '회사원A'],
  // 여행 · 캠핑
  ['UCNhofiqfw5nl-NeDJkXtPvw', 'travel', '빠니보틀'],
  ['UClRNDVO8093rmRTtLe4GEPw', 'travel', '곽튜브'],
  ['UC4VoaWbC9pYxGCawDknpSXQ', 'camping', 'RYUCAMP'],
  // 반려동물
  ['UCee1MvXr6E8qC_d2WEYTU5g', 'pet', '강형욱의 보듬TV'],
  ['UCX3QAQPW30ZPpj39LJjJ_3g', 'pet', '설채현의 놀로와'],
  ['UCkuA_gDjISfGgbdp02BUwyQ', 'pet', '크집사'],
  // 운동
  ['UCdtRAcd3L_UpV4tMXCw63NQ', 'sports', '피지컬갤러리'],
  // 지식 · 과학 · IT · 자동차
  ['UCa6f4_8BzbREx1L99sOLGAw', 'knowledge', '역사왕 썬킴'],
  ['UCIk1-yPCTnFuzfgu4gyfWqw', 'science', '과학드림'],
  ['UCMc4EmuDxnHPc6pgGW-QWvQ', 'science', '안될과학'],
  ['UCdUcjkyZtf-1WJyPPiETF1g', 'tech', 'ITSub잇섭'],
  ['UCp0B9n0YYC8E8bJmS5i4oqw', 'car', '모터그래프'],
  // 낚시
  ['UCY2uWQDCzn_ZE-JpTfDRR2A', 'fishing', '입질의추억TV'],
];

export function defaultChannelsEnabled(): boolean {
  return (process.env.VIDEO_HUB_DEFAULT_CHANNELS ?? '').trim().toLowerCase() !== 'false';
}

export const SEED_CHANNELS: Array<{ channelId: string; category: VideoCategorySlug }> = DEFAULT_CHANNELS.map(([channelId, category]) => ({ channelId, category }));
