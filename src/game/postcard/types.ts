/**
 * 明信片：类型、配色、评级与主题的**纯函数**层。
 *
 * 这一层不碰画笔，也不碰 `document` —— 全部是可被单测/断言直接调的纯函数。
 * 原作把「算评级」放在 `PostcardVariant.gd`（`static`）、把「算纸面」放在
 * `Postcard._apply_paper_style()` 里；后者原本是 `_ready()` 的一次性副作用，
 * 这里把它提成纯函数，好让"四档纸色两两分得开""散件不会被档位挡掉"
 * 这几条在浏览器里也判得了。
 *
 * ## 三层来源（原作整合方案 §5.3），只有第一层是买的
 *
 *   纸面 = 纸面档位 `postcard_tier`（1 素笺 / 2 上笺 / 3 珍藏笺）+ 散件
 *          `paper`(宣纸) / `ink`(松烟墨) / `seal`(蜡封) / `env`(信封)
 *   正面 = 评级，五块碎片；商店里明列「无价」
 *   背面 = 终局抉择给的文案（由 UI 层塞进 `backText`）
 */
import {
  ACCENT_COL,
  FRAME_PLAIN,
  FRAME_RARE,
  INK_COL,
  INK_PINE,
  LAND_COL,
  MAX_VISITS_PER_STATION,
  PAPER_FINE,
  PAPER_NONE,
  PAPER_PLAIN,
  PAPER_RARE,
  t,
  tInt,
  WAX_COL,
} from './layout';
import type { Lang } from './layout';

export type { Lang };

/**
 * 导出用的正反面像素尺寸。
 *
 * 原作 `EndCard.gd` 把正面的 `PostcardExport` 和背面的 `SubViewport` 都设成
 * `Vector2(1920, 1080)`，**不是**按卡片内容算的，所以正反两面同尺寸、
 * 导出时两张 PNG 能直接拼成一张 1920×2160 的对折卡。
 * ⚠️ 别"优化"成 2× 或按 devicePixelRatio 放大：目标机器是 4GB 内存的核显
 * 笔记本，1080p 已经是原作定妆照验证过的尺寸。
 */
export const CARD_SIZE: { w: number; h: number } = { w: 1920, h: 1080 };

/**
 * 四档评级（对应原作 `PostcardVariant.compute_variant()` 的 0/1/2/3）。
 *
 * 原作其实有 **5 档**：0 初旅 / 1 探索者 / 2 朝圣者 / 3 大师 / 4 完满。
 * 本工程的 `CardTier` 只有四档，所以：
 *   · 大师 = 收了 4~5 件；
 *   · 完满（五件各刷满）是**大师之上的一枚金印**（右上角），不是第五档名。
 * 也就是说 `CardTier` 回答"你走到了哪一程"，金印回答"你有没有走完"，
 * 两者互不吞掉。`computeVariant()` 另外保留 0..4 的原口径，供版面表用。
 */
export type CardTier = 'journeyman' | 'explorer' | 'pilgrim' | 'master';

/**
 * 终局抉择。原作的 `ending_id`：
 *   · `keep`（留门）—— 背面预填那一句，蜡封完好；
 *   · `break`（放手）—— 背面留白，蜡被掰开。
 * 未竟（没走完流程就退出）时原作 `ending_id` 是空串，本工程用显式的两值，
 * 未竟的情形由 UI 层按"没选"处理（传 `leave_door` 并把 `backText` 置空）。
 */
export type EndingId = 'leave_door' | 'let_go';

/**
 * 存档里的 `ending_id` → 明信片用的两值结局。
 *
 * ## `'break'` 是一个已经害过人的陷阱
 *
 * 上面那段注释里的 `keep` / `break` 是**原作 Godot 侧的字段名**，
 * 而本工程存进存档的是 UI 按钮原样传上来的 `'leave_door' | 'let_go'`
 * （`endCard.ts` 两颗按钮 → `state.setEnding()` → `ending_id`）。
 *
 * 曾经有一处写成 `saved === 'break' ? 'let_go' : 'leave_door'`。
 * `'break'` 永远不等于存档里的任何一个值，于是那个三元的假分支恒中：
 * **选了「放手」的玩家，导出的那张 PNG 背面照样预填了「留门」那一句**，
 * 而屏幕上一切正常（屏幕那侧用的是 `let_go`）——抉择在产物上被静默还原，
 * 没有任何一条判据会红，`back_break` 就那样留在死字白名单里。
 *
 * 所以这个转换只允许写在这**一个**纯函数里：明信片、结算面板、断言都从它取。
 */
export function endingOf(savedEndingId: string): EndingId {
  return savedEndingId === 'let_go' ? 'let_go' : 'leave_door';
}

/**
 * 「留门」才预填背面那一句；放手与未竟一律留白。
 *
 * **留白不是省事**——"留白 + 掰开的蜡封"是这个抉择真正落在产物上的东西；
 * 只改一句预填文案的话，玩家的收获和手抄一遍没区别。
 * 两个结局在这里必须**恰好一个**有值，`verify_ending` 守着。
 */
export function prefilledBackKey(ending: EndingId): 'back_keep' | null {
  return ending === 'leave_door' ? 'back_keep' : null;
}

/**
 * 背面那一行说明按结局分支。
 *
 * 选了「放手」就要把"留白是故意的"说出来：文案写着"背面留白，封口的蜡已经掰开"，
 * 而玩家点进背面只看到一片空白，读起来像**功能没做完**，不像一个抉择。
 */
export function backCaptionKey(ending: EndingId): 'back_break_blank' | 'back_preview_caption' {
  return ending === 'let_go' ? 'back_break_blank' : 'back_preview_caption';
}

export interface PostcardInput {
  /** 五块碎片各到访了几次，索引 0..4 = 云/茶/琴/竹/禽 */
  slotVisits: number[];
  /** 明信片套餐档位 0 = 没买（最素的一档），1..3 */
  kitTier: number;
  /** 已买的散件，影响纸面/墨/蜡封/信封 */
  hasPaper: boolean;
  hasInk: boolean;
  hasSeal: boolean;
  hasEnvelope: boolean;
  ending: EndingId;
  /** 玩家在背面写的字 */
  backText: string;
  lang: Lang;
  /** 档位覆盖（演示/测试用），不给就按进度算 */
  tierOverride?: CardTier;

  // ---- 下面这几个是抬头那块路线图要读的存档量 ----
  //
  // 它们不在最初的接口清单里，但**抬头那张图上"哪 16 个点是实心的"和
  // "已过 n 驿"的 n 就是这两个**。没有它们就只剩一条空路线，
  // 而那张图恰恰是玩家唯一带走的那张卡的抬头。
  //
  // 不给时的兜底：`seenStations` 取"到访过 >0 的碎片站"，
  // `seenCount` 取它的个数。**不是**全 0——只摆 collected 而不摆
  // seen 的话，图上会写着「已过 0 驿」配着一圈实心碎片站，
  // 那是一张玩家永远拿不到的卡。

  /** 16 座驿站里这一趟真经过的（按驿站下标 0..15）。 */
  seenStations?: boolean[];
  /** 「已过 n 驿」里的 n。默认 = seenStations 的 true 个数。 */
  seenCount?: number;
}

export interface PostcardTheme {
  /** 纸底色 */
  paper: string;
  /** 纸边（做旧） */
  paperEdge: string;
  /** 墨色 */
  ink: string;
  inkSoft: string;
  /** 强调 */
  accent: string;
  /** 蜡封红 */
  seal: string;
}

// ══════════════════════════════════════════════════════════════════════
// 颜色工具 —— 全程 sRGB 0..255（理由见 layout.ts 顶部）
// ══════════════════════════════════════════════════════════════════════

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `Color("B0C4DE")` → 0..255 的 sRGB 通道值。**不做线性化**。 */
export function hex(h: string): Rgb {
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** CSS 颜色串。`a < 1` 时用 `rgba()`（逗号语法，兼容面最广）。 */
export function css(c: Rgb, a = 1): string {
  return a >= 1
    ? `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`
    : `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${a})`;
}

/** 等价于 Godot `Color.darkened(k)`：`c * (1 - k)`，sRGB 通道上算。 */
export function darkened(c: Rgb, k: number): Rgb {
  return { r: c.r * (1 - k), g: c.g * (1 - k), b: c.b * (1 - k) };
}

/** 等价于 Godot `Color.lightened(k)`：`c + (1 - c) * k`。 */
export function lightened(c: Rgb, k: number): Rgb {
  return { r: c.r + (255 - c.r) * k, g: c.g + (255 - c.g) * k, b: c.b + (255 - c.b) * k };
}

/** 等价于 Godot `Color.lerp(to, w)`。 */
export function lerpC(a: Rgb, b: Rgb, w: number): Rgb {
  return { r: a.r + (b.r - a.r) * w, g: a.g + (b.g - a.g) * w, b: a.b + (b.b - a.b) * w };
}

/** Godot `Color.GRAY` = (0.5, 0.5, 0.5)。 */
export const GRAY: Rgb = { r: 127.5, g: 127.5, b: 127.5 };

// ══════════════════════════════════════════════════════════════════════
// 评级
// ══════════════════════════════════════════════════════════════════════

function visitsOf(input: PostcardInput, slot: number): number {
  const v = input.slotVisits[slot];
  return typeof v === 'number' && v > 0 ? Math.floor(v) : 0;
}

/**
 * 原作 `PostcardVariant.compute_variant()`，0..4 的原口径。
 *
 * · **完满（4）只认「五件各刷满」一个判据** —— 就是"HUD 的下一处消失"的
 *   那一刻，也是这一趟结束的那一刻。
 *   原作这里自己算过一遍"任意一站到访 ≥3 次"，和那个判据不是一回事：
 *   玩家只把云影台刷满三次、另外四站各去一次，评级就已经是"完满"了，
 *   而导航还在指另外四站。两张互相打架的指示牌。
 * · 1 → 初旅 / 2 → 探索者 / 3 → 朝圣者 / 4~5 → 大师 / 一件没收 → 初旅。
 */
export function computeVariant(input: PostcardInput): number {
  const visits: number[] = [];
  for (let s = 0; s < 5; s++) visits.push(visitsOf(input, s));
  if (visits.every((v) => v >= MAX_VISITS_PER_STATION)) return 4;
  const count = visits.filter((v) => v > 0).length;
  if (count <= 1) return 0;
  if (count === 2) return 1;
  if (count === 3) return 2;
  return 3;
}

const VARIANT_TO_TIER: readonly CardTier[] = ['journeyman', 'explorer', 'pilgrim', 'master'];

/**
 * 四档评级。`tierOverride` 给了就用它（演示 / 定妆照用）。
 *
 * ⚠️ variant 4（完满）**在四档制里没有第五个名字**，它是"大师走到了头"：
 * 右上角那枚金印才是完满的标记，而金印已经在 `paintFront` 里按 variant 画了。
 * 所以这里要把 4 **夹到 3**——直接拿 variant 当下标会越界取到 `undefined`，
 * 然后被 `?? 'journeyman'` 兜成"初旅"：集齐五件的大师被说成刚开始那一趟。
 */
export function computeTier(input: PostcardInput): CardTier {
  if (input.tierOverride) return input.tierOverride;
  const v = Math.min(computeVariant(input), VARIANT_TO_TIER.length - 1);
  return VARIANT_TO_TIER[v] ?? 'journeyman';
}

/**
 * 纸面档位名对应的 i18n key。
 * 0 = 没买套餐：明信片照样产出，只是不打纸名（只剩落款）。
 */
export function paperTierNameKey(kitTier: number): string | null {
  switch (kitTier) {
    case 1:
      return 'tier_plain';
    case 2:
      return 'tier_fine';
    case 3:
      return 'tier_rare';
    default:
      return null;
  }
}

/** 纸面档位名（没买套餐返回空串）。 */
export function paperTierName(input: PostcardInput): string {
  const key = paperTierNameKey(kitTierClamp(input.kitTier));
  return key === null ? '' : t(input.lang, key);
}

/** 纸面档位夹到 0..3。存档里被改坏也要夹住，不然纸色表会取空。 */
export function kitTierClamp(kitTier: number): number {
  return Math.min(3, Math.max(0, Math.floor(kitTier)));
}

// ══════════════════════════════════════════════════════════════════════
// 主题
// ══════════════════════════════════════════════════════════════════════

/** 主题的 0..255 通道形态。画笔要的是它（要做 lerp / darken），不是 CSS 串。 */
export interface ThemeRgb {
  paper: Rgb;
  paperEdge: Rgb;
  ink: Rgb;
  accent: Rgb;
  seal: Rgb;
  /** 描边（外框）：珍藏笺换金边并加粗。 */
  frame: Rgb;
  frameWidth: number;
}

/**
 * 档位决定纸与框，散件各管自己那一笔，**互不覆盖**：
 * 上笺给帘纹，宣纸再叠一层纤维，松烟墨只换墨色，蜡封与信封各画各的角。
 *
 * 原作 `lookdev_postcard.gd` 的 06 号定妆照就是钉这一条：没买套餐、只买宣纸，
 * 散件的帘纹**不能**被档位挡掉。所以每一项都是独立的 if，不是 else 链。
 */
export function themeRgb(input: PostcardInput): ThemeRgb {
  const tier = kitTierClamp(input.kitTier);
  let paperHex = PAPER_NONE;
  if (tier === 1) paperHex = PAPER_PLAIN;
  else if (tier === 2) paperHex = PAPER_FINE;
  else if (tier === 3) paperHex = PAPER_RARE;

  const paper = hex(paperHex);
  const rare = tier >= 3;

  return {
    paper,
    // 纸边（做旧）：原作里 `paper.darkened(0.08)`，用在信封折角的内侧那一片。
    // 单独提出来是因为它是**主题量**——信封是一种纸的形态，不是另一种纸。
    paperEdge: darkened(paper, 0.08),
    ink: hex(input.hasInk ? INK_PINE : INK_COL),
    accent: hex(ACCENT_COL),
    seal: hex(WAX_COL),
    frame: hex(rare ? FRAME_RARE : FRAME_PLAIN),
    frameWidth: rare ? 6 : 4,
  };
}

/** 同一个主题的 CSS 串形态。给只需要调 `fillStyle` 的地方用。 */
export function computeTheme(input: PostcardInput): PostcardTheme {
  const c = themeRgb(input);
  return {
    paper: css(c.paper),
    paperEdge: css(c.paperEdge),
    ink: css(c.ink),
    // inkSoft = 抬头/图例那一档"压暗的字"。原作是 `Color(ink, 0.62)`，
    // 即 alpha 0.62 而不是"另一个更浅的颜色"——两者在叠字时不等价。
    inkSoft: css(c.ink, 0.62),
    accent: css(c.accent),
    seal: css(c.seal),
  };
}

/**
 * 纸面附加效果，各管各的：
 * · `laidLines` 帘纹：上笺及以上，**或**买了宣纸；
 * · `fiber` 纤维：只认宣纸。
 */
export function paperTextureFlags(input: PostcardInput): { laidLines: boolean; fiber: boolean } {
  const tier = kitTierClamp(input.kitTier);
  return { laidLines: tier >= 2 || input.hasPaper, fiber: input.hasPaper };
}

/** 「已过 n 驿」的 n。 */
export function seenCountOf(input: PostcardInput): number {
  if (typeof input.seenCount === 'number') return input.seenCount;
  if (input.seenStations) return input.seenStations.reduce((n, v) => n + (v ? 1 : 0), 0);
  let n = 0;
  for (let s = 0; s < 5; s++) if (visitsOf(input, s) > 0) n++;
  return n;
}

/** 这一站这一趟到过没有（读存档里那张 16 位表）。 */
export function isStationSeen(input: PostcardInput, stationIdx: number): boolean {
  if (input.seenStations) return !!input.seenStations[stationIdx];
  return false;
}

export { LAND_COL, t, tInt };
