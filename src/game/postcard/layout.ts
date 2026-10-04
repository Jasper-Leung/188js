/**
 * 明信片版面常量 —— Godot `Postcard.gd` / `PostcardBack.gd` 的逐值移植。
 *
 * ## 这一层为什么存在
 *
 * 原作把每一个尺寸都写在画笔里，于是"导出 1920 宽的那张"和"屏幕上 900 宽的
 * 那张"共用同一份相对关系，但**有几处故意不跟宽度走**（右下角完满金印、
 * 底部路牌、落款、左下蜡封位）。那些是原作 `verify_postcard_ending.gd` §3d
 * 逐条钉死的地方：金印圆心写死 `w - 90`、半径 32，所以它的左沿恒为
 * `w - 122`，与卡片多大无关；而抬头右半「五件乐事」那一列的右沿恒定在
 * `w - 150k`，就是**按金印不缩放这一点倒推出来的**。把金印改成缩放的，
 * 两列在 900px 那一档会真的压上（20px 的字身顶进 y 0..52 的金印里），
 * 1920 那一档离得开——所以不能"顺手改成缩放"。
 *
 * 这里把散在三个 GDScript 里的数字收成一处，纯常量、不碰画笔，
 * 好让"路有没有被框裁掉""信封折角有没有削掉框线"这类断言在 Web 版里
 * 仍然量得到（原作是靠 headless 不落盘、只能读纯函数才判的）。
 *
 * ## 色彩空间 —— 全程 sRGB，不要在中途做线性运算
 *
 * Godot 的 `Color("B0C4DE")` **不做线性化**：`Color` 只是 4 个通道，
 * 线性化发生在采样/输出那一侧（`source_color` 提示）。Canvas 2D 在
 * 非 display-p3 的画布上也是 sRGB 空间混合。所以本文件里 `darkened` /
 * `lightened` / `lerpC` 全部在 **0..255 的 sRGB 通道值**上算，
 * 与 Godot 的 `Color.darkened/lightened/lerp` 逐值等价。
 *
 * 一旦中途改成 0~1 线性再插值再转回 sRGB，暗部会明显变浅——
 * 那不是"更真实"，那是改原作。（Godot 渲染输出还有一层 AgX 视图变换，
 * Web 端没有，所以最终 PNG 会比原作截图更鲜艳一点，这是**渲染管线**的
 * 差别，不是明信片本身；不要拿截图的绝对色去对。）
 */
import { ECON, I18N } from '../../data/raw';
import type { Lang } from '../../data/raw';

export type { Lang };

/** 卡片背面/兜底用的米白。** 也是没买套餐时那张"还没上过纸"的底色。 */
export const LAND_COL = 'F4F2EA';
/** 默认墨色：木炭调，偏暖褐。 */
export const INK_COL = '4A3520';
/** 强调色：档位名、背面外框、封口位那圈金框都走它。 */
export const ACCENT_COL = 'C9A26B';

/**
 * 纸面档位（`postcard_tier`）三档纸色 + 未买套餐那一张。
 *
 * `F4F2EA` 是**没买套餐**那张「还没上过纸」的白；素笺比它沉一点、
 * 带点纸浆色。上笺帘纹细密、压得住墨；珍藏笺暖白托金边。
 * 四档必须两两分得开——"花了钱买了张素笺"和"没买套餐"在画面上是同一张纸，
 * 等于那 60 旅币白花（原作 `lookdev_postcard.gd` 01-04 就是钉这一条）。
 */
export const PAPER_PLAIN = 'E9E2CE';
export const PAPER_FINE = 'F2EAD8';
export const PAPER_RARE = 'F8F1DE';

/** 未买套餐的纸色 = LAND_COL（单列出来是为了让档位表读得懂）。 */
export const PAPER_NONE = LAND_COL;

/** 未买套餐 / 素笺 / 上笺 的框色。珍藏笺换金框（见 FRAME_RARE）。 */
export const FRAME_PLAIN = '8A6E4A';
/** 珍藏笺的金边。 */
export const FRAME_RARE = 'C9A22B';

/** 松烟墨比木炭黑更冷、更压帘纹。买了 `ink` 才换。 */
export const INK_PINE = '342E35';

/** 蜡封红。 */
export const WAX_COL = '9C3434';

/** 完满评级的金印。原作是 `D4AF37` 再 darkened(0.1)。 */
export const COMPLETE_SEAL_COL = 'D4AF37';

/**
 * 五件碎片的颜色，顺序必须死扣 `fragment_%d`：0 云 / 1 茶 / 2 琴 / 3 竹 / 4 禽。
 *
 * ⚠️ **这份表在 Godot 的 `Postcard.gd` 与 `FragmentBar.gd` 里各有一份副本，
 * 上一版就是两份整体错位一格：标签对、颜色和图标属于下一件。两个表彼此
 * 自洽，缩略图一眼扫过去完全正常，可玩家存走的那张 PNG 一样是错的。**
 *
 * Web 版把它们收口成这一个数组并导出 `FRAGMENT_COLS`，任何画区、图标、
 * 抬头那一列都只许按下标取色——想在这儿"再抄一份"就是重犯这个 bug。
 * （另一处副本 `FragmentBar.gd` 的 `_draw_fragment_icon` 在本工程属于
 * 别人负责的文件；要对齐请改那边引用这份，而不是反过来。）
 */
export const FRAGMENT_COLS = [
  'B0C4DE', // 0 云
  '8FB35A', // 1 茶
  'C9A26B', // 2 琴
  '6E9C6B', // 3 竹
  'E8A04F', // 4 禽
] as const;

/** 驿站总数。抬头上「已过 n 驿」那行的**最宽情形**按它算，不按这一趟的实际值。 */
export const STATION_COUNT = 16;

// ══════════════════════════════════════════════════════════════════════
// 正面
// ══════════════════════════════════════════════════════════════════════

/**
 * 顶部路线图占卡片高度的比例。
 *
 * 8 字环接近正方（bbox 329×361m），所以这一块一旦压到 0.3 以下，
 * 地图就得按宽走、两侧各空掉一大片纸；0.38 是试下来地图还能按高走满、
 * 而下面五格画区还剩得下 46% 的那一个。
 */
export const MAP_BAND_FRAC = 0.38;

/** 画区 + 抬头一共占 85%。底下 15% 压着路牌、落款和封口位。 */
export const PANEL_BOTTOM_FRAC = 0.85;

/** 地图方框的左边距（相对宽度缩放）。买了信封要让开折角，见 layoutMap。 */
export const MAP_INSET = 16;

/** 路线铺进去的内框内缩量。路线是**正好**铺满 fit 区的（有一边一定顶死），
 *  留白不够的话 8 字的上凸和下凸会压在框线上，读成「图被裁了一刀」。 */
export const MAP_INNER_INSET = 10;

/** 买信封时地图左边距要让开折角：折角是从 (0,0) 切下来的等腰直角。 */
export const ENVELOPE_FOLD_FRAC = 0.16;

export const MAP_RECT_Y_FRAC = 0.09;
export const MAP_RECT_SIZE_FRAC = 0.82;

// ---- 五格画区 ----

/**
 * 画区底色往纸色 `lerp` 的比例。
 *
 * **响度是「饱和度 × 面积」，而面积改不动（五个格子是版式）**，所以动的是
 * 饱和度：把每件自己的颜色朝纸色拉过去，色块变成**染过色的纸页**——
 * 仍然一件一个色（茶偏绿、禽偏橙，认得出来），但读成"这一格属于哪件"
 * 而不是"这里有一块颜色"。
 *
 * 这个数是量出来的：sRGB 通道跨度（max-min）逐件在混色前是
 * 云46 / 茶89 / 琴122 / 竹62 / **禽153**，0.62 之后 11 / 39 / 42 / 24 / **64**
 * ——禽那一格最响（E8A04F 的橙本来就是五件里跨度最大的），降到原色 42%。
 * 原作回归钉的是**两条一起**：面板亮度 ≥ 0.76（读成纸）且通道跨度 ≤ 原色
 * 的一半。只钉绝对跨度的话，五件里最"好压"的云会留出一堆没人用的余量，
 * 而真正吵的那一件反而从缝里过去。
 */
export const PANEL_PAPER_MIX = 0.62;

/** 画区底色的固定压暗量（原作 `panel_fill` 里的 `PANEL_SHIMMER`）。 */
export const PANEL_SHIMMER = 0.012;

/** 顶部受光的竖向渐变分几段。 */
export const PANEL_WASH_BANDS = 5;

/** 画区纸感里的纸纤维根数。 */
export const PANEL_FIBERS = 5;

// ---- 底部五件（不缩放的那几个） ----
//
// ⚠️ 以下几处的尺寸在原作里是**写死的像素**，不乘 k。它们和 `w - 150k`
// 那条抬头右沿互为约束，改一处必须同时改另一处。

/** 完满金印：圆心离右边的距离、半径。原作是 `_draw()` 里的局部变量。 */
export const COMPLETE_SEAL_X_FROM_RIGHT = 90;
export const COMPLETE_SEAL_Y = 20;
export const COMPLETE_SEAL_R = 32;
/** 金印里那一个字（`postcard_seal`）的排版窗：宽 52 → 圆心两侧各 26。 */
export const COMPLETE_SEAL_TEXT_W = 52;
export const COMPLETE_SEAL_TEXT_SIZE = 28;

/** 底部路牌（正面）。 */
export const ROAD_SIGN_W = 100;
export const ROAD_SIGN_H = 25;
export const ROAD_SIGN_Y_FRAC = 0.92;
export const ROAD_SIGN_TEXT_DX = 20;
export const ROAD_SIGN_TEXT_DY = 18;
export const ROAD_SIGN_TEXT_SIZE = 16;

/** 落款。买过纸套餐的在它左边标一档纸名。 */
export const SIGNATURE_DX_FROM_RIGHT = 380;
export const SIGNATURE_DY_FROM_BOTTOM = 18;
export const SIGNATURE_SIZE = 15;
export const SIGNATURE_TIER_GAP = 14;

/** 左下角封口位（蜡封 / 空位圈）。同样不缩放。 */
export const SEAL_MARK_X = 64;
export const SEAL_MARK_DY_FROM_BOTTOM = 64;
export const SEAL_MARK_R = 26;

/** 画区标签：底部那条纸色带 + 字号。注意标签**不是居中**的，见 render.ts。 */
export const PANEL_LABEL_DY_FROM_BOTTOM = 20;
export const PANEL_LABEL_BAND_H = 32;
export const PANEL_LABEL_BAND_DY = -26;
export const PANEL_LABEL_SIZE = 28;
/** 标签带底下的白色垫：不垫的话字跟着每格底色深浅变，云那格尤其读不出来。 */
export const PANEL_LABEL_BAND_ALPHA = 0.3;

/** 占位灰块上的问号。 */
export const PLACEHOLDER_SIZE = 48;
export const PLACEHOLDER_DX = -14;

// ══════════════════════════════════════════════════════════════════════
// 背面
// ══════════════════════════════════════════════════════════════════════

/** 正文区上沿（占卡片高度的比例）。上面那一带是标题。 */
export const BACK_SPLIT_FRAC = 0.22;
/** 正文框四边的留白。 */
export const BACK_MSG_PAD = 24;

/** 正文字号：从 FONT_MAX 往下找第一个**整块放得下**的号（步长 4px）。
 *  原来写死 36 —— 200 字在框里只占四五行、留下大半张空纸；缩到预览的
 *  宽度里，那行字只剩八个像素高，玩家读不到自己写了什么。 */
export const BACK_FONT_MIN = 36;
export const BACK_FONT_MAX = 84;
export const BACK_FONT_STEP = 4;
/** 行距（行高 = 字体高 + 这个）。 */
export const BACK_LINE_GAP = 10;

/** 背面正文上限。原作在 TextEdit 的 text_changed 里用 substr 兜住。 */
export const BACK_MAX_CHARS = 200;

/** 背面底部路牌。 */
export const BACK_SIGN_W = 200;
export const BACK_SIGN_H = 50;
export const BACK_SIGN_DY_FROM_BOTTOM = 110;
export const BACK_SIGN_TEXT_DX = 56;
export const BACK_SIGN_TEXT_DY = 36;
export const BACK_SIGN_TEXT_SIZE = 32;

/** 背面底部落款「—— 来自第188号路线」。 */
export const BACK_FROM_DX_FROM_RIGHT = 680;
export const BACK_FROM_DY_FROM_BOTTOM = 44;
export const BACK_FROM_SIZE = 36;

// ══════════════════════════════════════════════════════════════════════
// 纸张纹理 / 信封
// ══════════════════════════════════════════════════════════════════════

/** 帘纹：纵向细线。间距随宽度走——别让 1920 宽的导出图里挤几百条。 */
export const LAID_LINE_MIN_STEP = 6;
export const LAID_LINE_DIVISOR = 240;
/** 宣纸纤维：短划的根数。 */
export const FIBER_COUNT = 42;

// ══════════════════════════════════════════════════════════════════════
// 评级 → 画区布局
// ══════════════════════════════════════════════════════════════════════

export interface PanelSlot {
  /** 碎片下标；-1 = 占位灰块。 */
  slot: number;
  placeholder: boolean;
}

/**
 * 五格画区按评级排的表。
 *
 * 大师档（4 块碎片）**必须是 5 格、第 5 格是占位**：集了 4 块就走的「未竟」，
 * 正面得看得出还缺一件；只画 4 格的话缺的那件无处体现，未竟和满配的区别
 * 就只剩背面留白。
 *
 * 完满档第 5 格**必须是真碎片**（禽）：标成占位会画成灰底「?」——玩家集齐
 * 五件却看到一格问号，正好戳破「无价」那层承诺。
 */
export const VARIANT_LAYOUTS: readonly (readonly PanelSlot[])[] = [
  // 0 初旅
  [
    { slot: 0, placeholder: false },
    { slot: -1, placeholder: true },
    { slot: -1, placeholder: true },
    { slot: -1, placeholder: true },
  ],
  // 1 探索者
  [
    { slot: 0, placeholder: false },
    { slot: 1, placeholder: false },
    { slot: -1, placeholder: true },
    { slot: -1, placeholder: true },
  ],
  // 2 朝圣者
  [
    { slot: 0, placeholder: false },
    { slot: 1, placeholder: false },
    { slot: 2, placeholder: false },
    { slot: -1, placeholder: true },
  ],
  // 3 大师
  [
    { slot: 0, placeholder: false },
    { slot: 1, placeholder: false },
    { slot: 2, placeholder: false },
    { slot: 3, placeholder: false },
    { slot: -1, placeholder: true },
  ],
  // 4 完满
  [
    { slot: 0, placeholder: false },
    { slot: 1, placeholder: false },
    { slot: 2, placeholder: false },
    { slot: 3, placeholder: false },
    { slot: 4, placeholder: false },
  ],
];

/** 碎片到访多少次算「刷满」——完满评级的唯一判据。取自经济常量，不许写死 3。 */
export const MAX_VISITS_PER_STATION = ECON.MAX_VISITS_PER_STATION;

// ══════════════════════════════════════════════════════════════════════
// 字体
// ══════════════════════════════════════════════════════════════════════

/**
 * 卡片上那些**印刷体**文字（抬头、标签、路牌、落款、评级名）。
 *
 * `GiftUI` 是 `public/fonts/ui.woff2` 的家族名——首屏就加载的那份子集，
 * 只含游戏里真正出现过的字符。后面几个是兜底，防止字体声明还没到位。
 */
export const FONT_UI =
  // 族名与 `src/index.css` 的 @font-face、`minigames/chrome.ts` 的 FONT_STACK
  // **必须一致**。三者指向同一个 `public/fonts/ui.woff2`，而它们写成三个名字
  // 的时候，每一处都"看起来是对的"——只有当某一处先加载、另一处后加载时，
  // 才会静默回退到系统字体，而界面上没有一处会报错。
  '"188UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif';

/**
 * 玩家自己在背面写的字。
 *
 * `GiftHand` 是 `public/fonts/handwriting.woff2`（常用 3500 汉字子集，
 * 约 404KB）。**只在明信片背面手写时加载**——玩家自己敲的字不在 ui 的
 * 字符集里，而把 3500 字全塞进首屏会把低配机器的首屏拖垮。
 *
 * 画布 2D 用这个字体必须先 `await document.fonts.load()`，
 * 字体没加载完就画会**静默回退成系统字体**：界面看着"能写字"，
 * 导出的 PNG 字形却是另一套（见 export.ts）。
 */
export const FONT_HAND =
  '"GiftHand", "Kaiti SC", "STKaiti", "KaiTi", "楷体", "Noto Serif SC", serif';

// ══════════════════════════════════════════════════════════════════════
// i18n 取字
// ══════════════════════════════════════════════════════════════════════

/**
 * 查不到就把 key 记进来并**原样返回 key**。
 *
 * 上游的 `Localization.t()` 查不到时返回 key 自己：既不报错也不返回空串，
 * 于是中文界面一路正常，只有切到英文的那一屏露出满屏 key。
 * 这里沿用"返回 key"的兜底（画面不至于崩），但把漏掉的 key 攒起来，
 * 让 `MISSING_KEYS` 能在控制台/测试里一眼看见，而不是靠人眼去找。
 */
export const MISSING_KEYS: string[] = [];

/** 取一条文案。`MISSING_KEYS` 里已出现过的不重复记。 */
export function t(lang: Lang, key: string): string {
  const table = I18N[lang] as Record<string, string> | undefined;
  const s = table?.[key];
  if (typeof s === 'string' && s !== '') {
    // 上游会在插值前把文案原样返回；这里挡掉"值恰好等于 key"这种没填的。
    if (s === key && !MISSING_KEYS.includes(key)) MISSING_KEYS.push(key);
    return s;
  }
  if (!MISSING_KEYS.includes(key)) MISSING_KEYS.push(key);
  return key;
}

/**
 * 取一条带 `%d` 的文案并填一个整数。
 *
 * 上游是 `Localization.t(key) % [n]`，只替换第一个 `%d`。
 * 注意「已过 %d 驿」那行**不带分母**——分母长在文案里的话，扩充驿站就得
 * 回来改字符串，改漏了顶栏就在说一个世界里已经没有的数。
 */
export function tInt(lang: Lang, key: string, n: number): string {
  return t(lang, key).replace('%d', String(n));
}
