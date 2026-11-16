/**
 * 테스트용 더미 데이터 목록 (2026-11-17) — 배포 전 정리 대상.
 *
 * 켜기: .env  DEMO_DATA=true   (운영 APP_ENV=prod 에서는 값과 관계없이 꺼진다)
 * 정리: .env  DEMO_DATA=clean  → 다음 접속 때 demo- 로 시작하는 행을 모두 지운다
 *       또는  도구_데모데이터정리.bat
 *
 * 이 파일은 DB·env 를 import 하지 않는다 (스크립트와 서버가 함께 쓴다).
 *
 * 구분 원칙
 *  - 유명 크리에이터(실제 유튜브 채널)는 "미가입"으로만 노출한다. 후원 버튼을 달지 않는다.
 *  - "도네이도 크리에이터(후원 가능)"로 보이는 더미 가입 크리에이터는 모두 가상의 이름이다.
 *  - 더미 행의 ID 는 전부 demo- 로 시작한다. 정리할 때 이 접두사 하나로 찾는다.
 */
import type { VideoCategorySlug } from '@/lib/video-hub';

export const DEMO_ID_PREFIX = 'demo-';

/**
 * 추가 노출 채널 (미가입). 모두 2026-11-17 유튜브 공개 RSS 로 채널명과 최근 업로드를 확인했다.
 * 기본 채널 목록(video-hub-channels.ts)과 겹치지 않는다.
 */
export const DEMO_CHANNELS: Array<[string, VideoCategorySlug, string]> = [
  ['UC1B6SalAoiJD7eHfMUA9QrA', 'humor', '숏박스'],
  ['UCSc2DcSzzjHgBn8Hg0KG7PA', 'humor', '꼰대희'],
  ['UCXEKwWflysXu312NmIP_dlw', 'humor', '너덜트'],
  ['UCqsPmfRMm0AGTF3mw1VtCnw', 'humor', '빵송국'],
  ['UCwx6n_4OcLgzAGdty0RWCoA', 'entertain', '워크맨'],
  ['UCWYzc_p0GgfCepIWDHGFmEg', 'entertain', '디글'],
  ['UCYgUhR7EGKauFXgJS0pckGg', 'entertain', '와썹맨'],
  ['UCaKod3X1Tn4c7Ci0iUKcvzQ', 'entertain', '런닝맨'],
  ['UC69Z5Vd-Z6bdCC5LKM_lv_g', 'entertain', '덱스101'],
  ['UCg-p3lQIqmhh7gHpyaOmOiQ', 'entertain', '영국남자'],
  ['UCu9BCtGIEr73LXZsKmoujKw', 'talk', '보겸TV'],
  ['UCBkyj16n2snkRg1BAzpovXQ', 'game', '우왁굳'],
  ['UCD2YO_A_PVMgMDN9jpRrpVA', 'game', '랄로'],
  ['UCMki_UkHb4qSc0qyEcOHHJw', 'music', 'NewJeans'],
  ['UCLkAepWjdylmXSltofFvsYQ', 'music', 'BANGTANTV'],
  ['UCOmHUn--16B90oW2L6FRR3A', 'music', 'BLACKPINK'],
  ['UC-qYkzKFdekoEniRu_FS3zg', 'music', 'OH MY GIRL'],
  ['UCFbK0JW_N5RKajamSf5Cbcw', 'music', '딩고 스튜디오'],
  ['UCpcft4FJXgUjnxWoQYsl7Ug', 'movie', '고몽'],
  ['UCvW8norVMTLt7QN-s2pS4Bw', 'knowledge', '조승연의 탐구생활'],
  ['UC7F6UDq3gykPZHWRhrj_BDw', 'knowledge', '사물궁이 잡학지식'],
];

/** 더미 "지금 라이브"에 올릴 미가입 유명 채널 (동시 시청자 수는 더미) */
export const DEMO_LIVE_CHANNELS: Array<{ channelId: string; viewers: number }> = [
  { channelId: 'UCUj6rrhMTR9pipbAWBAMvUQ', viewers: 48_210 }, // 침착맨
  { channelId: 'UCD2YO_A_PVMgMDN9jpRrpVA', viewers: 21_640 }, // 랄로
  { channelId: 'UCfpaSruWW3S4dibonKXENjA', viewers: 17_380 }, // 쯔양
  { channelId: 'UCyHvSKT_bLDYpkv1JjjsLAg', viewers: 9_870 }, // 풍월량
  { channelId: 'UChlgI3UHCOnwUGzWzbJ3H5w', viewers: 31_520 }, // YTN
];

/** 더미 가입 크리에이터 (가상의 이름). liveViewers 가 있으면 방송 중 */
export interface DemoCreator {
  n: number;
  name: string;
  category: VideoCategorySlug;
  description: string;
  avatarIndex: number;
  liveViewers?: number;
  livePlatform?: 'YOUTUBE' | 'INSTAGRAM' | 'TIKTOK';
  /** 더미 구독자 수 · 이번 주 후원 건수 · 지난주 대비 증가율(%) */
  subscribers: number;
  weeklyDonations: number;
  growth: number;
}

export const DEMO_CREATORS: DemoCreator[] = [
  { n: 1, name: '하루먹방', category: 'mukbang', description: '매일 저녁 7시, 오늘의 한 끼를 함께 먹어요.', avatarIndex: 3, liveViewers: 6_240, livePlatform: 'YOUTUBE', subscribers: 284_000, weeklyDonations: 1_284, growth: 42 },
  { n: 2, name: '게임하는민트', category: 'game', description: '공포게임·인디게임 위주로 방송합니다.', avatarIndex: 11, liveViewers: 3_910, livePlatform: 'YOUTUBE', subscribers: 156_000, weeklyDonations: 932, growth: 27 },
  { n: 3, name: '노래하는소라', category: 'music', description: '신청곡 받아요. 통기타 라이브.', avatarIndex: 18, liveViewers: 2_480, livePlatform: 'INSTAGRAM', subscribers: 97_000, weeklyDonations: 611, growth: 35 },
  { n: 4, name: '캠핑가는곰', category: 'camping', description: '주말마다 전국 캠핑장 리뷰.', avatarIndex: 7, subscribers: 63_000, weeklyDonations: 214, growth: 12 },
  { n: 5, name: '댕댕이네집', category: 'pet', description: '골든리트리버 세 마리와 사는 일상.', avatarIndex: 24, subscribers: 412_000, weeklyDonations: 802, growth: 18 },
  { n: 6, name: '오늘의뷰티', category: 'beauty', description: '데일리 메이크업과 솔직한 제품 리뷰.', avatarIndex: 31, subscribers: 188_000, weeklyDonations: 377, growth: 9 },
  { n: 7, name: '경제한스푼', category: 'economy', description: '어려운 경제 뉴스를 쉽게 풀어 드립니다.', avatarIndex: 5, subscribers: 221_000, weeklyDonations: 456, growth: 21 },
  { n: 8, name: '요리왕김셰프', category: 'cooking', description: '10분 집밥 레시피.', avatarIndex: 14, subscribers: 134_000, weeklyDonations: 298, growth: 15 },
  { n: 9, name: '여행하는별', category: 'travel', description: '혼자 떠나는 세계 여행 브이로그.', avatarIndex: 40, subscribers: 75_000, weeklyDonations: 163, growth: 31 },
  { n: 10, name: '웃음연구소', category: 'humor', description: '콩트·상황극 채널.', avatarIndex: 22, subscribers: 342_000, weeklyDonations: 517, growth: 7 },
  { n: 11, name: '테크리뷰어J', category: 'tech', description: '신제품 언박싱과 실사용 리뷰.', avatarIndex: 9, subscribers: 119_000, weeklyDonations: 241, growth: 11 },
  { n: 12, name: '낚시하는삼촌', category: 'fishing', description: '바다·민물 낚시 실시간 방송.', avatarIndex: 46, subscribers: 58_000, weeklyDonations: 187, growth: 24 },
];

export function demoCreatorCode(n: number): string {
  return `TOR-DM${String(n).padStart(2, '0')}`;
}

export function demoCreatorId(n: number): string {
  return `${DEMO_ID_PREFIX}creator-${String(n).padStart(2, '0')}`;
}

/** 상품 사진은 Unsplash(무료·상업 이용·외부 링크 허용)의 실제 사진이다. 로고가 크게 보이는 사진은 뺐다. */
const unsplash = (id: string) => `https://images.unsplash.com/photo-${id}?w=800&q=75&auto=format&fit=crop`;

export interface DemoProduct {
  n: number;
  name: string;
  category: string;
  summary: string;
  image: string;
  price: number;
  listPrice?: number;
  soldCount: number;
  variants: string[];
}

export const DEMO_PRODUCTS: DemoProduct[] = [
  { n: 1, name: '도네이도 오버핏 반팔 티셔츠', category: '패션·잡화', summary: '도톰한 20수 코튼, 남녀공용 오버핏', image: unsplash('1521572163474-6864f9cf17ab'), price: 29_000, listPrice: 39_000, soldCount: 1_284, variants: ['M', 'L', 'XL'] },
  { n: 2, name: '회오리 자수 후드 집업', category: '패션·잡화', summary: '기모 안감, 가을·겨울용', image: unsplash('1556821840-3a63f95609a7'), price: 59_000, listPrice: 79_000, soldCount: 642, variants: ['M', 'L', 'XL'] },
  { n: 3, name: '데일리 코튼 볼캡', category: '패션·잡화', summary: '사이즈 조절 가능한 워싱 코튼 캡', image: unsplash('1588850561407-ed78c282e89b'), price: 19_000, soldCount: 913, variants: ['화이트', '블랙'] },
  { n: 4, name: '캔버스 데일리 에코백', category: '패션·잡화', summary: '노트북까지 들어가는 넉넉한 크기', image: unsplash('1544816155-12df9643f363'), price: 15_900, soldCount: 1_570, variants: ['내추럴'] },
  { n: 5, name: '크리에이터 세라믹 머그컵', category: '생활·주방', summary: '전자레인지 사용 가능한 350ml 머그', image: unsplash('1514228742587-6b1558fcca3d'), price: 12_900, soldCount: 2_031, variants: ['화이트'] },
  { n: 6, name: '스테인리스 보온 텀블러 500ml', category: '생활·주방', summary: '12시간 보온·24시간 보냉', image: unsplash('1602143407151-7111542de6e8'), price: 24_900, listPrice: 32_000, soldCount: 1_102, variants: ['올리브', '블랙'] },
  { n: 7, name: '스페셜티 블렌드 원두 200g', category: '식품', summary: '고소한 견과류 향의 미디엄 로스트', image: unsplash('1559056199-641a0ac8b55e'), price: 14_900, soldCount: 3_412, variants: ['홀빈', '핸드드립용 분쇄'] },
  { n: 8, name: '수제 초코 퍼지 케이크', category: '식품', summary: '벨기에산 초콜릿을 듬뿍 넣은 홀케이크', image: unsplash('1578985545062-69928b1d9587'), price: 32_000, soldCount: 458, variants: ['1호'] },
  { n: 9, name: '블루베리 생크림 타르트', category: '식품', summary: '생블루베리를 올린 수제 타르트', image: unsplash('1618160702438-9b02ab6515c9'), price: 27_000, soldCount: 377, variants: ['6인치'] },
  { n: 10, name: '진한 돈코츠 라멘 밀키트 2인분', category: '식품', summary: '18시간 끓인 육수, 차슈·반숙란 포함', image: unsplash('1569718212165-3a8278d5f624'), price: 16_900, listPrice: 21_000, soldCount: 2_210, variants: ['2인분', '4인분'] },
  { n: 11, name: '화덕 나폴리 피자 2판', category: '식품', summary: '에어프라이어 8분, 냉동 화덕 피자', image: unsplash('1565299624946-b28f40a0ae38'), price: 19_800, soldCount: 1_847, variants: ['마르게리타+페퍼로니'] },
  { n: 12, name: '초코 쿠키 디저트컵 4개입', category: '식품', summary: '크림치즈와 초코 쿠키를 층층이', image: unsplash('1563805042-7684c019e1cb'), price: 13_500, soldCount: 966, variants: ['4개입'] },
  { n: 13, name: '데일리 메이크업 브러시 세트', category: '뷰티', summary: '부드러운 인조모 6종 + 파우치', image: unsplash('1596462502278-27bfdc403348'), price: 22_000, listPrice: 29_000, soldCount: 734, variants: ['6종 세트'] },
  { n: 14, name: '비타민C 브라이트닝 세럼 30ml', category: '뷰티', summary: '순한 비타민 유도체 세럼', image: unsplash('1608571423902-eed4a5ad8108'), price: 25_000, soldCount: 1_423, variants: ['30ml'] },
  { n: 15, name: '수분 스킨케어 3종 세트', category: '뷰티', summary: '토너·에센스·크림 기초 3종', image: unsplash('1571781926291-c477ebfd024b'), price: 45_000, listPrice: 58_000, soldCount: 512, variants: ['3종 세트'] },
  { n: 16, name: '시어버터 수분 핸드크림', category: '뷰티', summary: '끈적임 없는 데일리 핸드크림 50ml', image: unsplash('1620916566398-39f1143ab7be'), price: 9_900, soldCount: 2_688, variants: ['무향', '플로럴'] },
  { n: 17, name: '아로마 에센셜 오일 세트', category: '뷰티', summary: '라벤더·유칼립투스·오렌지 3종', image: unsplash('1612817288484-6f916006741a'), price: 28_000, soldCount: 341, variants: ['3종 세트'] },
  { n: 18, name: '플로럴 오 드 퍼퓸 50ml', category: '뷰티', summary: '은은한 장미와 머스크 향', image: unsplash('1592945403244-b3fbafd7f539'), price: 49_000, listPrice: 65_000, soldCount: 289, variants: ['50ml'] },
  { n: 19, name: '방송용 무선 헤드폰', category: '디지털·가전', summary: '저지연 블루투스, 40시간 재생', image: unsplash('1505740420928-5e560c06d30e'), price: 89_000, listPrice: 129_000, soldCount: 618, variants: ['블랙'] },
  { n: 20, name: '노이즈캔슬링 무선 이어폰', category: '디지털·가전', summary: 'ANC·투명 모드·무선 충전 케이스', image: unsplash('1606220588913-b3aacb4d2f46'), price: 69_000, soldCount: 1_045, variants: ['블랙'] },
  { n: 21, name: '미니멀 스마트워치', category: '디지털·가전', summary: '심박·수면 측정, 7일 배터리', image: unsplash('1523275335684-37898b6baf30'), price: 79_000, listPrice: 99_000, soldCount: 433, variants: ['화이트'] },
  { n: 22, name: '저소음 무선 마우스', category: '디지털·가전', summary: '클릭 소음 90% 감소, 2.4GHz 무선', image: unsplash('1527864550417-7fd91fc51a46'), price: 18_900, soldCount: 1_976, variants: ['그레이'] },
  { n: 23, name: '원터치 팝업 텐트 3인용', category: '스포츠·레저', summary: '펼치기만 하면 설치 끝, 자외선 차단', image: unsplash('1496545672447-f699b503d270'), price: 119_000, listPrice: 159_000, soldCount: 267, variants: ['3인용'] },
  { n: 24, name: '4인용 감성 돔 텐트', category: '스포츠·레저', summary: '방수 3000mm, 전실 포함', image: unsplash('1537905569824-f89f14cceb68'), price: 189_000, soldCount: 154, variants: ['4인용'] },
  { n: 25, name: '차박 자충 에어매트', category: '스포츠·레저', summary: '두께 8cm, 밸브만 열면 자동 충전', image: unsplash('1563299796-17596ed6b017'), price: 69_000, soldCount: 392, variants: ['싱글', '더블'] },
  { n: 26, name: '캠핑 체어·테이블 세트', category: '스포츠·레저', summary: '접이식 체어 2개 + 롤 테이블', image: unsplash('1445308394109-4ec2920981b1'), price: 99_000, listPrice: 129_000, soldCount: 211, variants: ['샌드'] },
  { n: 27, name: '강아지 기모 후드티', category: '반려동물', summary: '부드러운 기모 안감, 소·중형견', image: unsplash('1583337130417-3346a1be7dee'), price: 21_900, soldCount: 864, variants: ['S', 'M', 'L'] },
  { n: 28, name: '반려견 니트 넥워머', category: '반려동물', summary: '겨울 산책용 도톰한 니트', image: unsplash('1517849845537-4d257902454a'), price: 13_900, soldCount: 507, variants: ['S', 'M'] },
  { n: 29, name: '고양이 깃털 낚싯대 장난감', category: '반려동물', summary: '교체용 깃털 3개 포함', image: unsplash('1592194996308-7b43878e84a6'), price: 8_900, soldCount: 1_388, variants: ['기본'] },
  { n: 30, name: '퍼피 마시멜로 방석', category: '반려동물', summary: '세탁 가능한 푹신한 원형 방석', image: unsplash('1611003228941-98852ba62227'), price: 34_900, listPrice: 42_000, soldCount: 456, variants: ['M', 'L'] },
];

export function demoProductId(n: number): string {
  return `${DEMO_ID_PREFIX}product-${String(n).padStart(2, '0')}`;
}

/** 채널별 더미 구독자 수 — 같은 채널은 항상 같은 숫자 (화면이 새로고침마다 바뀌지 않게) */
export function demoSubscribersForChannel(channelId: string): number {
  let h = 2166136261;
  for (let i = 0; i < channelId.length; i++) {
    h ^= channelId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u = (h >>> 0) / 0xffffffff;
  // 12만 ~ 1,800만 사이, 큰 채널이 드물게 나오도록 제곱
  return Math.round((120_000 + u * u * 17_880_000) / 1000) * 1000;
}
