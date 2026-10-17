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
import { DEFAULT_KEYMAP } from './keymap';
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
  /**
   * 滑板尾迹的同时存活粒子上限（个）。0 = 完全关掉这个特效。
   *
   * 它和阴影/植被那些旋钮是同一族：**按硬件分级，而不是按"想不想要"分级**。
   * 尾迹是填充率买家——一个加色混合的圆点就是一次 overdraw，而低配档
   * 刚刚把 renderScale 砍到 0.6 省下来的像素，不该被一把火花重新吃回去。
   * 所以三档之间差 5 倍：高档的火更密、活得更久，低档只剩"看得见在滑"。
   */
  trailParticles: number;
  /** 满速时每秒发射的尾迹粒子数（个/秒）。熄火时按速度比例缩水 */
  trailEmitRate: number;
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
    // 尾迹三档里最省的一档：90 个点、每秒 30 发。滑板极速 17m/s 下
    // 一条尾迹约 3 秒就拖完 90 个的预算——读起来是"轮子后面有火星"，
    // 而不是一条连续的光带。**低配要的是这个信号存在，不是它密。**
    trailParticles: 90,
    trailEmitRate: 30,
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
    trailParticles: 240,
    trailEmitRate: 96,
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
    // 高档：480 个点、每秒 180 发。17m/s 下约 2.7 秒注满池子，
    // 之后是最旧的粒子被挤掉——尾迹因此有了长度上限，不会无限拖。
    trailParticles: 480,
    trailEmitRate: 180,
    anisotropy: 4,
    stationSilhouette: false,
  },
};

export const TIER_KEYS = ['quality_low', 'quality_medium', 'quality_high'] as const;
export const TIER_COUNT = 3;

/**
 * 色觉友好的碎片配色。
 *
 * ## 为什么默认配色对某些读者不够用
 *
 * 五件乐事各有一个色（`hud.ts` 的 `FRAGMENT_COLORS`），而这个游戏里
 * 「碎片栏的那几个格子」和「五个图标」是**唯一的辨识线索**——没有文字标签，
 * 没有形状差异。所以「哪个是茶」这件事**完全由色相承担**。
 *
 * 默认五色里云与茶都在绿—青区间、竹与禽都在黄—绿区间，
 * 红绿色觉障碍者看到的相邻两格是同一个颜色。
 *
 * ## 这一套怎么改的
 *
 * 不是把色相乱换一遍，而是**换成亮度阶梯**：相邻两槽的明度差 ≥ 0.18，
 * 于是它们在**灰度**下也分得开。代价是这一套没那么"水墨"——
 * 所以它是**可选的**，不是替代默认。
 */
export const COLORBLIND_FRAGMENTS: readonly [number, number, number][] = [
  [0.36, 0.52, 0.72], // 云 · 深蓝
  [0.88, 0.76, 0.32], // 茶 · 亮黄
  [0.52, 0.38, 0.64], // 琴 · 紫
  [0.86, 0.52, 0.28], // 竹 · 橙
  [0.34, 0.36, 0.38], // 禽 · 深灰
];

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

  // ---- 无障碍 / 音量（下面五项都是**持久**的，AGENTS 早期版本一个都没有）----
  /** 音乐音量 0~1 */
  volBgm: number;
  /** 音效音量 0~1 */
  volSfx: number;
  mutedAll: boolean;
  mutedBgm: boolean;
  mutedSfx: boolean;
  /** 色觉友好配色 */
  colorblind: boolean;
  /** 减弱动效 */
  reduceMotion: boolean;
  /** 按住生效的键（云 / 茶 / 钓鱼）改为点一下切换 */
  holdToToggle: boolean;
  /** 键位重映射：动作 → `KeyboardEvent.code` */
  keymap: Record<string, string>;
}

const STORAGE_KEY = 'gift188.settings.v1';

const FALLBACK_SETTINGS = {
  volBgm: 1,
  volSfx: 1,
  mutedAll: false,
  mutedBgm: false,
  mutedSfx: false,
  colorblind: false,
  reduceMotion: false,
  holdToToggle: false,
};

/** 体积/颜色的取值范围钳制。设置来自 `localStorage`，那是个玩家可以手改的文件。 */
const clamp01 = (v: unknown, d: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(Math.max(n, 0), 1);
};

export function loadSettings(defaultTier: Tier): SettingsData {
  const fallback: SettingsData = {
    tier: defaultTier,
    adaptiveTargetFps: 0,
    adaptiveMinScale: 0.5,
    onboardingDone: false,
    qualityTouched: false,
    ...FALLBACK_SETTINGS,
    keymap: { ...DEFAULT_KEYMAP },
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
      volBgm: clamp01(parsed.volBgm, FALLBACK_SETTINGS.volBgm),
      volSfx: clamp01(parsed.volSfx, FALLBACK_SETTINGS.volSfx),
      mutedAll: !!parsed.mutedAll,
      mutedBgm: !!parsed.mutedBgm,
      mutedSfx: !!parsed.mutedSfx,
      colorblind: !!parsed.colorblind,
      reduceMotion: !!parsed.reduceMotion,
      holdToToggle: !!parsed.holdToToggle,
      // **逐项合并，不整体替换。** 手改过的存档可能只写了其中一个动作，
      // 而整体替换会把其余七个一起清成默认值——于是"我只改了一个键，
      // 回来发现其余的全没了"。
      keymap: { ...DEFAULT_KEYMAP, ...(parsed.keymap ?? {}) },
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

/**
 * 档位提示——**跟着当前选中的那一档走**。
 *
 * 原来这里是一句写死的 `t('quality_hint')`，内容恒定在描述**低档**
 * （关阴影、树收到 95m）。玩家选了"高"，面板底下仍然在说低档砍掉了什么，
 * 于是这一屏上出现一句自相矛盾的话。标题页是评委看的第一屏，
 * 这句话错在那里，代价最大。
 *
 * 三条文案是分开写的而不是拼出来的：拼接要把"关"还是"开到 N"、
 * 有没有半径这种分支写进代码，读起来比三句整话更难核对。
 */
export function qualityHint(tier: Tier): string {
  return t(`quality_hint_${['low', 'medium', 'high'][tier] as 'low' | 'medium' | 'high'}`);
}
