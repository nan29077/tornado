/**
 * 오버레이 효과 카탈로그.
 *
 * 서버 검증, 크리에이터 설정 화면, OBS 오버레이가 같은 값을 공유해야 한다.
 * 기존 파티클 값은 호환성을 위해 이름과 순서를 유지한다. 새 값은 **맨 뒤에만** 덧붙인다.
 */
export const OVERLAY_EFFECT_VALUES = [
  'NONE',
  'HEART',
  'STAR',
  'FIREWORK',
  'CONFETTI',
  'COIN',
  'DONAIDO_CHEER',
  'DONAIDO_HEART_HUG',
  'DONAIDO_GIFT_POP',
  'DONAIDO_MIC_DANCE',
  'DONAIDO_THANKS_BOW',
  // 2026-10-01 추가
  'DONAIDO_COIN_CLOUD',
  'DONAIDO_HEART_PEEK',
  'DONAIDO_LETTER_FLY',
  'DONAIDO_FRIENDS',
  'DONAIDO_PARADE',
] as const;

export type OverlayEffectValue = (typeof OVERLAY_EFFECT_VALUES)[number];

/**
 * 캐릭터 주변을 맴도는 소품 종류. 이모지를 쓰지 않으므로 모두 SVG 도형으로 그린다.
 *  - sparkle: 반짝이(4각 별)    - heart: 하트      - note: 음표
 *  - coin: 동전                 - ribbon: 리본 조각 - letter: 편지 봉투
 *  - star: 5각 별
 */
export type StickerAura = 'sparkle' | 'heart' | 'note' | 'coin' | 'ribbon' | 'letter' | 'star';

/** 캐릭터 뒤 배경 연출 색. `r,g,b` 형식(투명도는 컴포넌트가 정한다). */
export interface StickerPalette {
  /** 캐릭터 뒤 조명·빛줄기 */
  glow: string;
  /** 퍼져 나가는 고리·소품 강조색 */
  accent: string;
  /** 보조색(보케·반짝이) */
  soft: string;
}

export interface CharacterStickerDefinition {
  value: Extract<OverlayEffectValue, `DONAIDO_${string}`>;
  label: string;
  description: string;
  image: string;
  /** 등장 애니메이션(한 번) */
  animationClass: string;
  /** 등장 뒤 반복 동작(통통·좌우 흔들기 등). 등장이 끝난 뒤 시작된다. */
  idleClass: string;
  /** 주변 소품 */
  aura: StickerAura;
  /** 배경 연출 색 */
  palette: StickerPalette;
  /**
   * 여러 캐릭터가 함께 나오는 효과.
   *  - friends: 대표 캐릭터 양옆에 친구 둘이 튀어나온다
   *  - parade : 알림 반대쪽 가장자리로 캐릭터들이 줄지어 행진한다
   */
  ensemble?: 'friends' | 'parade';
}

const GOLD: StickerPalette = { glow: '255,206,74', accent: '255,170,0', soft: '255,236,160' };
const PINK: StickerPalette = { glow: '255,140,170', accent: '244,80,107', soft: '255,205,215' };
const PARTY: StickerPalette = { glow: '170,140,255', accent: '255,190,40', soft: '150,215,255' };
const MINT: StickerPalette = { glow: '120,225,190', accent: '255,196,50', soft: '210,250,230' };
const SKY: StickerPalette = { glow: '130,190,255', accent: '255,200,70', soft: '210,232,255' };

/** 도네이도 전용 투명 배경 캐릭터 스티커. */
export const DONAIDO_CHARACTER_STICKERS: readonly CharacterStickerDefinition[] = [
  {
    value: 'DONAIDO_CHEER',
    label: '응원 토네이도',
    description: '응원봉을 흔들며 통통 튀어요 · 빛줄기와 반짝이',
    image: '/stickers/donaido/cheer.webp',
    animationClass: 'animate-sticker-cheer',
    idleClass: 'animate-sticker-idle-hop',
    aura: 'sparkle',
    palette: GOLD,
  },
  {
    value: 'DONAIDO_HEART_HUG',
    label: '하트 포옹',
    description: '큰 하트를 안고 두근거려요 · 하트가 퐁퐁',
    image: '/stickers/donaido/heart-hug.webp',
    animationClass: 'animate-sticker-heart',
    idleClass: 'animate-sticker-idle-beat',
    aura: 'heart',
    palette: PINK,
  },
  {
    value: 'DONAIDO_GIFT_POP',
    label: '선물 팡',
    description: '선물 상자에서 힘차게 등장해요 · 리본이 팡팡',
    image: '/stickers/donaido/gift-pop.webp',
    animationClass: 'animate-sticker-gift',
    idleClass: 'animate-sticker-idle-hop',
    aura: 'ribbon',
    palette: PARTY,
  },
  {
    value: 'DONAIDO_MIC_DANCE',
    label: '마이크 댄스',
    description: '노래하며 좌우로 신나게 춤춰요 · 음표와 무대 조명',
    image: '/stickers/donaido/mic-dance.webp',
    animationClass: 'animate-sticker-dance',
    idleClass: 'animate-sticker-idle-sway',
    aura: 'note',
    palette: PARTY,
  },
  {
    value: 'DONAIDO_THANKS_BOW',
    label: '감사 인사',
    description: '두 손을 모아 꾸벅 인사해요 · 따뜻한 반짝이',
    image: '/stickers/donaido/thanks-bow.webp',
    animationClass: 'animate-sticker-bow',
    idleClass: 'animate-sticker-idle-nod',
    aura: 'star',
    palette: MINT,
  },
  {
    value: 'DONAIDO_COIN_CLOUD',
    label: '코인 구름',
    description: '구름을 타고 둥실 떠오르며 동전을 반짝여요',
    image: '/stickers/donaido/coin-cloud.webp',
    animationClass: 'animate-sticker-float-in',
    idleClass: 'animate-sticker-idle-float',
    aura: 'coin',
    palette: GOLD,
  },
  {
    value: 'DONAIDO_HEART_PEEK',
    label: '하트 메시지',
    description: '큰 하트 팻말을 들고 빼꼼 나타나요',
    image: '/stickers/donaido/heart-peek.webp',
    animationClass: 'animate-sticker-peek',
    idleClass: 'animate-sticker-idle-beat',
    aura: 'heart',
    palette: PINK,
  },
  {
    value: 'DONAIDO_LETTER_FLY',
    label: '편지 배달',
    description: '회오리를 타고 날아와 편지를 전해요',
    image: '/stickers/donaido/message-fly.webp',
    animationClass: 'animate-sticker-fly-in',
    idleClass: 'animate-sticker-idle-float',
    aura: 'letter',
    palette: SKY,
  },
  {
    value: 'DONAIDO_FRIENDS',
    label: '친구들 총출동',
    description: '응원·하트·댄스 친구가 한꺼번에 튀어나와요',
    image: '/stickers/donaido/cheer.webp',
    animationClass: 'animate-sticker-cheer',
    idleClass: 'animate-sticker-idle-hop',
    aura: 'star',
    palette: PARTY,
    ensemble: 'friends',
  },
  {
    value: 'DONAIDO_PARADE',
    label: '도네이도 퍼레이드',
    description: '캐릭터들이 화면 가장자리를 줄지어 행진해요',
    image: '/stickers/donaido/mic-dance.webp',
    animationClass: 'animate-sticker-dance',
    idleClass: 'animate-sticker-idle-sway',
    aura: 'note',
    palette: GOLD,
    ensemble: 'parade',
  },
];

/** 친구들·퍼레이드에 등장하는 캐릭터 이미지 (단독 캐릭터 순서). */
export const DONAIDO_CHARACTER_IMAGES: readonly string[] = [
  '/stickers/donaido/cheer.webp',
  '/stickers/donaido/heart-hug.webp',
  '/stickers/donaido/gift-pop.webp',
  '/stickers/donaido/mic-dance.webp',
  '/stickers/donaido/thanks-bow.webp',
  '/stickers/donaido/coin-cloud.webp',
  '/stickers/donaido/heart-peek.webp',
  '/stickers/donaido/message-fly.webp',
];

export function findCharacterSticker(effect: string): CharacterStickerDefinition | null {
  const normalized = effect.toUpperCase();
  return DONAIDO_CHARACTER_STICKERS.find((sticker) => sticker.value === normalized) ?? null;
}
