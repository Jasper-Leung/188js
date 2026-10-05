/**
 * 画质分档 —— 这个项目为"低配电脑"做的所有旋钮，都在这一张表里。
 *
 * 与 Godot 版的关系：原作只有三档、切的是**阴影与植被半径**。
 * 那是当时的正确选择（Godot 没有可控的内部渲染分辨率，缩放反而更慢）。
 * 到了 Web 上这个判断不再成立——**浏览器端渲染分辨率缩放是唯一真正
 * 有效的那一刀**，对填充率受限的核显来说，把 1920×1080 画到 0.6 倍
 * 比关掉任何一项功能都管用。所以这里把渲染分辨率提为一等旋钮，
 * 并让它可被自适应调节（默认关，见 loop.ts）。
 *
 * 档位之间**不是"好看/更好看/最好看"**，是同一套程序化画面在不同硬件上
 * 的取舍。每一档的注释都写清楚"这一刀砍掉什么、为什么这台机器必须砍"。
 */
import { TIER_LOW, TIER_MEDIUM, TIER_HIGH, type Tier } from './capability';
import { t } from '../i18n';

export interface QualityPreset {
  /** 阴影贴图尺寸，0 = 关 */
  shadowMapSize: number;
  /** 阴影最远距离（米），0 = 不限 */
  shadowDistance: number;
  /** 内部渲染分辨率倍率。1 = 跟随 CSS 像素，0.6 = 画到 60% 再放大 */
  renderScale: number;
  /** devicePixelRatio 的上限。0.6 缩放 + DPR 2 是双重浪费 */
  pixelRatioCap: number;
  /**
   * 地面细节档：近处草丛质感的强度。0 = 关。
   *
   * **它替代了原来的 `grassEnabled` / `grassRadius` / `grassDensity`。**
   * 草皮是几何体（有交叉卡片、有 alphaTest、有剔除半径、有风摆），
   * 而它**读不成草**——近处是几片立着的绿矩形，远处叶片只有 12cm 宽，
   * 在一个像素里混成一块更绿的方块。两种距离下都不像草。
   * 草这个信号的**唯一价值就在于"像草"**，读不出来就不该留着。
   *
   * 现在草的质感做进地形着色器：同样的信息量，
   * **0 个额外三角形、0 次 alphaTest、0 个 draw call**，
   * 而且不会在近处变成纸片。低配把它降到 0 只是少算两项噪声。
   */
  groundDetail: 0 | 1 | 2;
  /** 地面细节的作用半径（米）。超出就只剩大尺度色块 */
  groundDetailRadius: number;
  /** 行道树半径 */
  treeRadius: number;
  /** 行道树密度系数 */
  treeDensity: number;
  /** 灌木半径 */
  bushRadius: number;
  /** 雾的远端距离。**植被半径必须小于它**，否则会看见"从雾里长出来"的树 */
  fogFar: number;
  /** 雾的起始距离 */
  fogNear: number;
  /** 地标模型的加载距离 */
  stationLoadDistance: number;
  /** 水面波纹的层数（片元里的循环次数） */
  waterDetail: 0 | 1 | 2;
  /** 植被风动的更新间隔（帧）。1 = 每帧，3 = 每 3 帧 */
  windInterval: number;
  /** 环境声层数：风 / 水 / 鸟 */
  ambientLayers: number;
  /** 纹理各向异性 */
  anisotropy: number;
  /** 远处地标是否降级成剪影（用简单的 box 代替 GLB） */
  stationSilhouette: boolean;
}

export const PRESETS: Record<Tier, QualityPreset> = {
  [TIER_LOW]: {
    shadowMapSize: 0,
    shadowDistance: 0,
    // 0.6 是这台档的核心。核显的瓶颈几乎永远是填充率：
    // 0.6² = 36% 的像素，帧率直接翻接近三倍，而雾把放大后的糊盖住了。
    renderScale: 0.6,
    pixelRatioCap: 1,
    groundDetail: 0,
    groundDetailRadius: 26,
    // 树半径**必须小于 fogFar**，否则会看见树从雾里长出来。
    // 调远可见半径 = 调远雾距，两者要一起动。
    treeRadius: 95,
    // **1 而不是 0.35。** 降档砍的是**半径**（52m，看不见的那 94% 已经被剔掉了），
    // 株数是第二刀：25m 株距 × 0.35 密度 = 每 100m 一棵树，
    // 实机截屏上这条路读起来就是"高速公路"，而玩家开局 60m 内只剩 2 株。
    // 半径已经按块剔掉了远处，密度再砍一次砍的是**近处**——
    // 也就是玩家唯一看得见的那部分。见 verify_veg_density。
    treeDensity: 1,
    bushRadius: 40,
    fogNear: 26,
    fogFar: 175,
    stationLoadDistance: 130,
    waterDetail: 0,
    windInterval: 4,
    ambientLayers: 1,
    anisotropy: 1,
    stationSilhouette: true,
  },
  [TIER_MEDIUM]: {
    shadowMapSize: 1024,
    shadowDistance: 55,
    renderScale: 0.85,
    pixelRatioCap: 1.25,
    groundDetail: 1,
    groundDetailRadius: 34,
    treeRadius: 150,
    // 同低档：半径是第一刀，株数不再挨第二刀。见 verify_veg_density。
    treeDensity: 1,
    bushRadius: 80,
    fogNear: 45,
    fogFar: 300,
    stationLoadDistance: 220,
    waterDetail: 1,
    windInterval: 2,
    ambientLayers: 2,
    anisotropy: 2,
    stationSilhouette: false,
  },
  [TIER_HIGH]: {
    shadowMapSize: 2048,
    shadowDistance: 130,
    renderScale: 1,
    pixelRatioCap: 2,
    groundDetail: 2,
    groundDetailRadius: 58,
    treeRadius: 220,
    treeDensity: 1,
    bushRadius: 140,
    fogNear: 80,
    fogFar: 420,
    stationLoadDistance: 320,
    waterDetail: 2,
    windInterval: 1,
    ambientLayers: 3,
    anisotropy: 4,
    stationSilhouette: false,
  },
};

export const TIER_KEYS = ['quality_low', 'quality_medium', 'quality_high'] as const;
export const TIER_COUNT = 3;

export interface SettingsData {
  tier: Tier;
  /** 自适应分辨率：目标帧率，0 = 关 */
  adaptiveTargetFps: number;
  /** 自适应分辨率的上下限倍率 */
  adaptiveMinScale: number;
  /** 是否已看过操作说明 */
  onboardingDone: boolean;
  /** 玩家是否手动动过画质（动过就不再被探测结果覆盖） */
  qualityTouched: boolean;
}

const STORAGE_KEY = 'gift188.settings.v1';

export function loadSettings(defaultTier: Tier): SettingsData {
  const fallback: SettingsData = {
    tier: defaultTier,
    adaptiveTargetFps: 0,
    adaptiveMinScale: 0.5,
    onboardingDone: false,
    qualityTouched: false,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<SettingsData>;
    return {
      tier: clampTier(parsed.tier ?? defaultTier),
      adaptiveTargetFps: typeof parsed.adaptiveTargetFps === 'number' ? parsed.adaptiveTargetFps : 0,
      adaptiveMinScale:
        typeof parsed.adaptiveMinScale === 'number'
          ? Math.min(Math.max(parsed.adaptiveMinScale, 0.35), 1)
          : 0.5,
      onboardingDone: !!parsed.onboardingDone,
      qualityTouched: !!parsed.qualityTouched,
    };
  } catch {
    // 存档坏了就当没有，不要让一个坏 JSON 卡在标题屏
    return fallback;
  }
}

export function saveSettings(s: SettingsData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* 无痕模式 / 存储满：设置不落盘，游戏照跑 */
  }
}

export function clampTier(v: unknown): Tier {
  const n = typeof v === 'number' ? Math.round(v) : TIER_MEDIUM;
  return (n < 0 ? 0 : n > 2 ? 2 : n) as Tier;
}

/**
 * 一张把"档位"翻译成人话的小表，UI 直接拿去显示。
 *
 * 档位是**开 / 关**的只有两项（阴影、地面细节），而原来这里写死英文 `'off'`。
 * 显示方拿到的就是这两个值之一，所以中文界面里那两格是"关 / off"混排——
 * 面板上一半中文一半英文的那种半成品感。
 * 现在关的那一格走 `t('off')`。
 */
export function tierSummary(tier: Tier): { renderScale: string; shadows: string; ground: string } {
  const p = PRESETS[tier];
  return {
    renderScale: `${Math.round(p.renderScale * 100)}%`,
    shadows: p.shadowMapSize === 0 ? t('off') : `${p.shadowMapSize}px / ${p.shadowDistance}m`,
    ground: p.groundDetail === 0 ? t('off') : `${p.groundDetailRadius}m`,
  };
}
