/**
 * 明信片正反两面的绘制 —— Godot `Postcard.gd` / `PostcardBack.gd` 的逐笔移植。
 *
 * ## 坐标约定
 *
 * `drawFront` / `drawBack` 都画在**卡片空间**里：原点左上、宽高 = 画布的
 * `canvas.width / canvas.height`、**变换必须是单位矩阵**。所有尺寸再按
 * `k = w / 900` 缩放，于是"导出 1920 宽的那张"和"预览 450 宽的那张"
 * 走的是同一份相对关系——原作那句注释就在这儿：写死像素的话，同一段代码
 * 在两处的相对字号会差一倍以上。
 *
 * ## 零贴图（与原作同一条纪律）
 *
 * 纸纹、帘纹、纤维、五格画区的受光、路线图、五件剪影、蜡封、折角——
 * **没有一个 `drawImage` / `createPattern`**，全部是路径 + 渐变 + 少量矩形。
 * 这不是洁癖：原作 `Postcard.gd` 也是纯 `draw_*`。一旦引入贴图，导出 PNG
 * 就会依赖"贴图是否已加载"，而那正是原作 headless 回归测不到、Web 端最容易
 * 静默出错的地方。
 *
 * ## 确定性 —— 同一份输入必须画出逐像素相同的图
 *
 * 原作的 `_process` 每帧 `queue_redraw()`，画面里有两处随时间走的东西：
 *   · 画区底色的 shimmer：`sin(_t*1.5 + i*1.2)*0.04`
 *   · 飘叶粒子的位置：`phase = i*0.7 + _t*0.4`
 * 导出要的是**一帧静止的图**，而"同一份输入导出两次必须拿到同一个文件"
 * 是硬要求。所以这里把 shimmer 冻结为 0（`panelFill` 保留该参数，与原作同款
 * 签名），飘叶整体不画——那 8 片叶子在 PNG 里本来也留不下任何信息，
 * 而少掉的那 0.04 微闪肉眼不可辨。
 * 补颗粒用 `core/noise.ts` 的 mulberry32，**种子从 `input` 派生**，
 * 全程不碰 `Math.random()`。
 */
import { makeRng } from '../../core/noise';
import { CENTERLINE, STATIONS } from '../../data/route';
import { ROAD } from '../../data/raw';
import {
  ACCENT_COL,
  BACK_FONT_MAX,
  BACK_FONT_MIN,
  BACK_FONT_STEP,
  BACK_FROM_DX_FROM_RIGHT,
  BACK_FROM_DY_FROM_BOTTOM,
  BACK_FROM_SIZE,
  BACK_LINE_GAP,
  BACK_MAX_CHARS,
  BACK_MSG_PAD,
  BACK_SIGN_DY_FROM_BOTTOM,
  BACK_SIGN_H,
  BACK_SIGN_TEXT_DX,
  BACK_SIGN_TEXT_DY,
  BACK_SIGN_TEXT_SIZE,
  BACK_SIGN_W,
  BACK_SPLIT_FRAC,
  COMPLETE_SEAL_COL,
  COMPLETE_SEAL_R,
  COMPLETE_SEAL_TEXT_SIZE,
  COMPLETE_SEAL_TEXT_W,
  COMPLETE_SEAL_X_FROM_RIGHT,
  COMPLETE_SEAL_Y,
  ENVELOPE_FOLD_FRAC,
  FIBER_COUNT,
  FONT_HAND,
  FONT_UI,
  FRAGMENT_COLS,
  INK_COL,
  LAID_LINE_DIVISOR,
  LAID_LINE_MIN_STEP,
  LAND_COL,
  MAP_BAND_FRAC,
  MAP_INNER_INSET,
  MAP_INSET,
  MAP_RECT_SIZE_FRAC,
  MAP_RECT_Y_FRAC,
  PANEL_BOTTOM_FRAC,
  PANEL_FIBERS,
  PANEL_LABEL_BAND_ALPHA,
  PANEL_LABEL_BAND_DY,
  PANEL_LABEL_BAND_H,
  PANEL_LABEL_DY_FROM_BOTTOM,
  PANEL_LABEL_SIZE,
  PANEL_PAPER_MIX,
  PANEL_SHIMMER,
  PANEL_WASH_BANDS,
  PLACEHOLDER_DX,
  PLACEHOLDER_SIZE,
  ROAD_SIGN_H,
  ROAD_SIGN_TEXT_DX,
  ROAD_SIGN_TEXT_DY,
  ROAD_SIGN_TEXT_SIZE,
  ROAD_SIGN_W,
  ROAD_SIGN_Y_FRAC,
  SEAL_MARK_DY_FROM_BOTTOM,
  SEAL_MARK_R,
  SEAL_MARK_X,
  SIGNATURE_DX_FROM_RIGHT,
  SIGNATURE_DY_FROM_BOTTOM,
  SIGNATURE_SIZE,
  SIGNATURE_TIER_GAP,
  STATION_COUNT,
  t,
  tInt,
  VARIANT_LAYOUTS,
} from './layout';
import {
  computeVariant,
  css,
  darkened,
  GRAY,
  hex,
  isStationSeen,
  kitTierClamp,
  lerpC,
  lightened,
  paperTierName,
  paperTextureFlags,
  seenCountOf,
  themeRgb,
  type PostcardInput,
  type Rgb,
  type ThemeRgb,
} from './types';

const TAU = Math.PI * 2;

/** 卡上那一行路牌：正反两面都印它，所以它只是一串文字，不是文案。 */
export const ROAD_SIGN_TEXT = 'No.188';

// ══════════════════════════════════════════════════════════════════════
// 几何辅助
// ══════════════════════════════════════════════════════════════════════

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** GDScript 的 `fmod(a, b)`：取模结果跟 a 同号。 */
function fmod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

function grow(r: Rect, d: number): Rect {
  return { x: r.x - d, y: r.y - d, w: r.w + d * 2, h: r.h + d * 2 };
}

/**
 * 描边矩形。上游 `draw_rect(rect, color, false, width)` 的描边是**骑在**
 * 矩形边线上的，Canvas 的 `strokeRect` 同样如此——所以这里**不能再内缩半个
 * 线宽**（内缩了就变成"内描边"，框线整体偏内 2px，与原作对不上）。
 */
function strokeRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  width: number,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.strokeRect(x, y, w, h);
}

function line(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string,
  width: number,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/** 一个圆：填 / 描可以只给一个。 */
function dot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  fill: string | null,
  stroke: string | null,
  width = 1,
): void {
  if (fill !== null) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }
  if (stroke !== null) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.stroke();
  }
}

// ══════════════════════════════════════════════════════════════════════
// 文字工具
// ══════════════════════════════════════════════════════════════════════

/** 设定字号与字体。`family` 要带引号的家族名，见 layout.ts 的 FONT_UI / FONT_HAND。 */
function setFont(ctx: CanvasRenderingContext2D, family: string, size: number): void {
  ctx.font = `${size}px ${family}`;
}

/** 量一段文字的宽。用 `measureText`——矢量度量，换字号不用换写法。 */
function measure(ctx: CanvasRenderingContext2D, s: string): number {
  return ctx.measureText(s).width;
}

/** 字体行高（= 上伸 + 下伸），等价于 Godot `Font.get_height(fs)`。 */
function fontHeight(ctx: CanvasRenderingContext2D): number {
  const m = ctx.measureText('国Ag');
  const a = m.fontBoundingBoxAscent;
  const d = m.fontBoundingBoxDescent;
  if (Number.isFinite(a) && Number.isFinite(d) && a + d > 0) return a + d;
  // 某些浏览器拿不到 fontBoundingBox，回退到 1.16em。
  return parseFloat(ctx.font) * 1.16;
}

/** 基线上方的上伸，等价于 Godot `Font.get_ascent(fs)`。 */
function fontAscent(ctx: CanvasRenderingContext2D): number {
  const a = ctx.measureText('国Ag').fontBoundingBoxAscent;
  if (Number.isFinite(a) && a > 0) return a;
  return parseFloat(ctx.font) * 0.88;
}

/** 上游的 `draw_string` 把 pos 当**基线**原点，Canvas 也是 baseline。 */
function drawText(
  ctx: CanvasRenderingContext2D,
  x: number,
  baselineY: number,
  s: string,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(s, x, baselineY);
}

/**
 * 按 [x, x+width] 这段窗子对齐着画。
 *
 * ⚠️ **width < 0 时对齐一律失效**，文字从 x 开始画。上游在「画区标签」和
 * 「正面路牌」两处正是这么用的（`HORIZONTAL_ALIGNMENT_CENTER, -1, 28, ink`），
 * 那个 CENTER 是空转的。实测（量 `docs/shots/15_postcard_明信片.png` 的像素）：
 * 每格标签的字形中心比格子中心右移约 14px——正好半个字宽。
 *
 * 这里**原样保留**：修成真居中会让导出 PNG 和原作定妆照对不上，
 * 而那张定妆照是这条视觉线唯一的基准。
 * （另两处传了真实宽度，是真居中，照做。）
 */
function drawTextAligned(
  ctx: CanvasRenderingContext2D,
  x: number,
  baselineY: number,
  s: string,
  color: string,
  width: number,
  align: 'left' | 'center' | 'right',
): void {
  let x0 = x;
  if (width > 0) {
    const w = measure(ctx, s);
    if (align === 'center') x0 = x + (width - w) / 2;
    else if (align === 'right') x0 = x + width - w;
  }
  drawText(ctx, x0, baselineY, s, color);
}

// ══════════════════════════════════════════════════════════════════════
// 正文断行 / 自动字号
// ══════════════════════════════════════════════════════════════════════

/**
 * 一行按宽度断行：CJK 逐字断，西文尽量在词间断。
 *
 * 原作那一版是"先把 ch 放进去、再看超没超"，于是只在空格处检查的西文
 * **会冲出去一整个词**才收尾（实测一行 1969px，框只有 1792px，右端那一截
 * 被框沿吃掉）。改成"先试着放，放不下就收尾"——检查永远发生在越界之前，
 * 所以每一行都真的在 maxW 之内。
 *
 * 按**码点**而不是 UTF-16 码元迭代：GDScript 的 `String[i]` 是按字符取的，
 * 用码元会把一个 emoji 劈成两半、各占一个字宽。
 */
function wrapLine(
  ctx: CanvasRenderingContext2D,
  family: string,
  chars: string[],
  size: number,
  maxW: number,
): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (cur !== '') {
      setFont(ctx, family, size);
      if (measure(ctx, cur + ch) > maxW) {
        // 挪到下一行的那个词要比留下的那半行短，否则说明这段文字根本没有
        // 词结构（URL 之类），老实按字断。
        const sp = cur.lastIndexOf(' ');
        if (sp * 2 > cur.length) {
          out.push(cur.slice(0, sp));
          cur = cur.slice(sp + 1);
        } else {
          out.push(cur);
          cur = '';
        }
        if (ch === ' ') continue;
      }
    }
    cur += ch;
  }
  if (cur !== '') out.push(cur);
  return out;
}

/** 整段话按宽度断成行（先按 \n 分段，再逐段断）。 */
function wrapText(
  ctx: CanvasRenderingContext2D,
  family: string,
  text: string,
  size: number,
  maxW: number,
): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    for (const line of wrapLine(ctx, family, Array.from(para), size, maxW)) out.push(line);
  }
  return out;
}

/**
 * 正文字号：从 FONT_MAX 往下找第一个**整块放得下**的号（步长 4px）。
 *
 * 写死 36 的后果：200 字在框里只占四五行、留下大半张空纸；缩到编辑器预览的
 * 宽度里，那行字只剩八个像素高，玩家读不到自己写了什么。
 * 字最多和字最少因此是**两种排版**——看定妆照必须成对看 07 与 07b：
 * 只有 07 那一张，"字变大了"看着像是把默认那句排得好看。
 */
function messageFontSize(
  ctx: CanvasRenderingContext2D,
  family: string,
  text: string,
  maxW: number,
  maxH: number,
): number {
  if (text === '') return BACK_FONT_MIN;
  for (let fs = BACK_FONT_MAX; fs > BACK_FONT_MIN; fs -= BACK_FONT_STEP) {
    setFont(ctx, family, fs);
    const lines = wrapText(ctx, family, text, fs, maxW);
    if (lines.length * (fontHeight(ctx) + BACK_LINE_GAP) <= maxH) return fs;
  }
  return BACK_FONT_MIN;
}

// ══════════════════════════════════════════════════════════════════════
// 画区底色（纯函数）
// ══════════════════════════════════════════════════════════════════════

/**
 * 五格画区的底色。原作 `Postcard.panel_fill()`（static，回归直接调它）。
 *
 * 第四轮 P1-4：这里原来只是 `base_col.darkened(0.18)`，五块**满饱和**的色块
 * 占了整张卡最大的面积——在成图上它们是全卡最响的东西，而它们不带任何
 * 信息：玩家在抬头那列已经读过「云 3 次 / 茶 3 次 / …」，抬头才是真的有
 * 话说的那一块，却更安静。**响度是「饱和度 × 面积」，而面积改不动**
 * （五个格子是版式），所以动的是饱和度：往纸色 `lerp` 过去，
 * 色块变成**染过色的纸页**——仍然一件一个色（茶偏绿、禽偏橙，认得出来），
 * 但读成"这一格属于哪件"而不是"这里有一块颜色"。比例见 `PANEL_PAPER_MIX`。
 *
 * `is_placeholder` 走同一条路且走得更远：未收的那几格原来是
 * `Color.GRAY.darkened(0.3)`，**比收过的那几块还响**，
 * 而"还没拿到"应该比"拿到了"更安静。
 *
 * `shimmer` 保留在签名里（与原作同款），本工程恒传 0——见文件头。
 */
export function panelFill(
  base: Rgb,
  paper: Rgb,
  shimmer: number,
  isPlaceholder: boolean,
): Rgb {
  let tint = lerpC(base, paper, PANEL_PAPER_MIX);
  if (isPlaceholder) tint = lerpC(GRAY, paper, PANEL_PAPER_MIX + 0.18);
  return darkened(tint, PANEL_SHIMMER + shimmer * 0.3);
}

// ══════════════════════════════════════════════════════════════════════
// 碎片图标 —— 云/茶/琴/竹/禽
// ══════════════════════════════════════════════════════════════════════
//
// 这一族的历史是同一类事故反复发生：形状曾经有**三份**拷贝（顶栏小图标 /
// 单碎片放大图 / 明信片五格），云/茶/琴三件是三套**算法**、禽那三份里两份
// 各画各的。逐张放大看下来三件都读不出自己是什么：
//   · 云 = 一个几乎处处外凸的土包（相邻鼓包半径和远大于圆心距，凹口全被填平）
//   · 茶 = 上下两个**半径相同、圆心差 6px** 的半圆弧拼出来的透镜，不是杯子
//   · 琴 = 五个点对称分布的透镜 + 底边 = 一座山
// 而那时的断言全绿，因为它们量的是「不是多边形」——
// **判「是不是云」和判「是不是多边形」是两个量，那一族只写了后者。**
//
// 本文件把几何收成下面的**纯数据**（不碰画笔，好让断言直接量剪影本身），
// 画法只有这一份。规范空间：云半宽 43，琴/茶最大半径 ~20；
// 各调用方按自己要的显示大小给 `sc`——**别在别处再记一个魔数**，
// 记了就会漂，而漂了没有任何几何断言看得见。

type Pt = [number, number];

/**
 * 云的四个鼓包 `[x, y, r]`。
 *
 * **这四个数是量出来的，不是画出来的**：相邻两团的圆心距必须接近半径和，
 * 凹口才留得下来。原来那组（圆心距 17/19/14，半径和 32/34/24）量出来是
 * **2 个峰、1 个凹口、深 0.36**——也就是"几乎没有"。现在这组量出来是
 * **4 个峰、3 个凹口、深 2.9 / 3.3 / 4.3**。
 * 改任何一个数都要重跑一次凹口深度的测量，确认凹口还在。
 */
const CLOUD_BUMPS: readonly [number, number, number][] = [
  [-33, 0, 10], // 左鼓包
  [-11, 0, 16], // 主体，最高
  [11, 0, 13],
  [33, 0, 10], // 尾巴
];
/** 平底线。云的影子就在脚下，而**平底正是云和烟唯一的区别**——
 *  叠圆按定义接不出平底，所以这一行不是装饰。 */
const CLOUD_BASE = 16;

/**
 * 盖碗（茶烟小筑端的是盖碗，不是茶壶）。
 *
 * **这不是审美选择，是可辨识性的量**：壶的辨识特征是壶嘴和壶把两个小构件，
 * 而它们在 22px 的盘上必然消失（原来那个把手只占图标宽度的 5%、
 * 水位线占面积的 1.5%），剩下的就是「上下两个等半径的半圆弧」——一个透镜。
 * 盖碗的剪影是**盖 + 碗 + 圈足**，三样都是大块面，任何尺寸下都不会读错。
 *
 * 盖和碗之间那道缝是刻意的——连成一体就分不出哪是盖，
 * 而"分得出盖"正是盖碗区别于碗的地方。
 */
const GAIWAN = {
  lidCy: -6.5,
  lidRx: 16,
  lidRy: 10,
  knobX: 0,
  knobY: -17.5,
  knobR: 3,
  bowlCy: -5,
  bowlRx: 15,
  bowlRy: 17,
  bowlFlat: 11, // 碗底压平（圈足接在上面）
  footHalf: 7,
  footY: 17.5,
};

/**
 * 古琴的剪影。辨识特征是**不对称**：琴额（头）那端方而宽，琴尾那端收细，
 * 底下两只雁足。原来的五点 `(-18,3)(-10,-5)(0,-7)(10,-5)(18,3)` 是
 * 上下左右全对称的透镜，加一条底边之后读成**一座山**——三样特征一个都没有。
 */
const GUQIN_BODY: readonly Pt[] = [
  [-19, -5.5],
  [-12, -8],
  [-1, -9],
  [9, -7],
  [17, -3], // 上缘（弦面）：头高尾低
  [17, 0.5],
  [10, 4.5],
  [-1, 7.5],
  [-19, 3], // 下缘：也是头高尾低
];

/**
 * 雁足。四个点**逐个对过琴身下缘**——脚必须整个落在木头下面，而"落在下面"
 * 是相对的：下缘在 x=-8 处是 y≈5.8、在 x=6 处是 y≈5.6，写死一个 y 的话，
 * 改一次琴身形状脚就会重新爬到木头上去。
 */
const GUQIN_FEET: readonly Pt[][] = [
  [
    [-10.5, 6.6],
    [-10.5, 13.5],
    [-6, 14.5],
    [-6, 7.6],
  ],
  [
    [3.5, 6.6],
    [3.5, 13.5],
    [8, 13.5],
    [8, 6],
  ],
];
const GUQIN_STRINGS = 4;
const GUQIN_Y0 = -6;
const GUQIN_DY = 2.9;

/**
 * 禽的单位设计坐标。这一份同时是画法和不碰画笔的纯数据。
 *
 * 认得出鸟要三样同时在，缺一样就退回一块墨：
 *   · **尾**——楔子，往左下甩出去，和身子拉开角；没有它剪影上下左右对称，
 *     读成一颗圆。
 *   · **喙**——尖角，不是那根棍；棍状的东西接在圆上读成棒棒糖。
 *   · **栖枝**——脚下那条横线。它给了这只鸟一个"站着"的地面，缺了它
 *     剪影再对也读成一块漂浮的墨。
 * 另有两条量得到的：身子是**椭圆**（rx > ry，正圆读成球），
 * 翅是**留白**——墨色的翅压在墨色的身上等于没画，那正是明信片五格那份
 * 读不出来的原因，也是这一族要单独钉住的一条。
 */
type BirdPart =
  | { k: 'line'; a: Pt; b: Pt; w: number; c: 'ink' }
  | { k: 'poly'; p: readonly Pt[]; c: 'ink' | 'wing' }
  | { k: 'ellipse'; ctr: Pt; rx: number; ry: number; c: 'ink' }
  | { k: 'circle'; ctr: Pt; r: number; c: 'ink' | 'eye' };

const BIRD_PARTS: readonly BirdPart[] = [
  { k: 'line', a: [-14, 14], b: [14, 14], w: 2, c: 'ink' }, // 栖枝
  { k: 'line', a: [-2, 5], b: [-2, 13.5], w: 1.2, c: 'ink' }, // 腿
  { k: 'line', a: [3, 5], b: [3, 13.5], w: 1.2, c: 'ink' },
  {
    k: 'poly',
    p: [
      [3, 0],
      [-15, 12],
      [-14, 15],
      [5, 6],
    ],
    c: 'ink',
  }, // 尾
  { k: 'ellipse', ctr: [-1, -2], rx: 11, ry: 8.5, c: 'ink' }, // 身子
  { k: 'circle', ctr: [8, -9], r: 6, c: 'ink' }, // 头
  {
    k: 'poly',
    p: [
      [12, -11],
      [20, -8.5],
      [12, -6],
    ],
    c: 'ink',
  }, // 尖喙
  {
    k: 'poly',
    p: [
      [-7, -5],
      [-1, -8],
      [1, -1],
      [-6, 1],
    ],
    c: 'wing',
  }, // 翅：留白
  { k: 'circle', ctr: [9.5, -10], r: 1.4, c: 'eye' },
];

/**
 * 琴身**上缘**在某个 y 处能伸到多远。弦必须按这个裁：按整块 board 的全宽画的话，
 * 弦两头都戳在木头外面，而四个金色键位提示正好落在弦的末端上，
 * 看起来像琴上镶了四枚金属钉。
 */
function guqinStringHalf(y: number): number {
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < 4; i++) {
    const p = GUQIN_BODY[i];
    const q = GUQIN_BODY[i + 1];
    if (Math.min(p[1], q[1]) <= y && y <= Math.max(p[1], q[1])) {
      const t = p[1] === q[1] ? 0 : (y - p[1]) / (q[1] - p[1]);
      lo = Math.max(lo, Math.abs(p[0] + (q[0] - p[0]) * t));
    }
  }
  for (let i = 4; i < GUQIN_BODY.length - 1; i++) {
    const p = GUQIN_BODY[i];
    const q = GUQIN_BODY[i + 1];
    if (Math.min(p[1], q[1]) <= y && y <= Math.max(p[1], q[1])) {
      const t = p[1] === q[1] ? 0 : (y - p[1]) / (q[1] - p[1]);
      hi = Math.max(hi, Math.abs(p[0] + (q[0] - p[0]) * t));
    }
  }
  return Math.min(lo, hi);
}

/**
 * 云的单位轮廓：逐列取最上面的鼓包（min），拼出一条不自交的闭合线。
 *
 * 别改成「每团各画一段上半圆再首尾相连」：后一团的起点会落在前一团终点的
 * 左边，连出来的是一条自己压自己的线，三角化直接失败——第一版就是这么画成
 * 一根线的，而且不报任何错。
 */
function cloudOutline(samples: number): Pt[] {
  let rMax = 0;
  for (const b of CLOUD_BUMPS) rMax = Math.max(rMax, b[2]);
  const x0 = CLOUD_BUMPS[0][0] - rMax;
  const x1 = CLOUD_BUMPS[CLOUD_BUMPS.length - 1][0] + rMax;
  const poly: Pt[] = [];
  for (let i = 0; i <= samples; i++) {
    const x = x0 + ((x1 - x0) * i) / samples;
    let top = CLOUD_BASE;
    for (const b of CLOUD_BUMPS) {
      const dx = x - b[0];
      if (Math.abs(dx) < b[2]) top = Math.min(top, b[1] - Math.sqrt(b[2] * b[2] - dx * dx));
    }
    poly.push([x, top]);
  }
  poly.push([x1, CLOUD_BASE]);
  poly.push([x0, CLOUD_BASE]);
  return poly;
}

function polyPath(ctx: CanvasRenderingContext2D, pts: Pt[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

function xform(pts: readonly Pt[], c: Pt, sc: number): Pt[] {
  return pts.map((p) => [c[0] + p[0] * sc, c[1] + p[1] * sc] as Pt);
}

/**
 * 五件的**唯一 dispatch**。
 *
 * 颜色走 `FRAGMENT_COLS[slot]`、标签走 `fragment_%d`，两者必须同序。
 * 上一版颜色表和这里的 match 各错位一格而标签是对的，所以每处单看都成立、
 * 合起来全错。把 dispatch 收成一个函数就是为了让"slot 0 是云"只写一次。
 *
 * 三个 `sc` 系数把规范空间换算回这一格要的显示大小：云规范半宽 43、
 * 琴最大半径 19.8、茶 20.5，而明信片的格子是顶栏那个 22px 盘的两倍多，
 * 所以琴要 ×1.9 才和原来一样大。
 */
function drawFragmentIcon(
  ctx: CanvasRenderingContext2D,
  slot: number,
  c: Pt,
  col: Rgb,
  alpha: number,
  sc: number,
): void {
  switch (slot) {
    case 0:
      paintCloud(ctx, c, col, alpha, sc * 0.88);
      break;
    case 1:
      paintGaiwan(ctx, c, col, alpha, sc);
      break;
    case 2:
      paintGuqin(ctx, c, col, alpha, sc * 1.9);
      break;
    case 3:
      paintBamboo(ctx, c, col, alpha, sc);
      break;
    case 4:
      paintBird(ctx, c, col, alpha, sc);
      break;
    default:
      break;
  }
}

function paintCloud(
  ctx: CanvasRenderingContext2D,
  c: Pt,
  col: Rgb,
  a: number,
  sc: number,
): void {
  polyPath(ctx, xform(cloudOutline(96), c, sc));
  ctx.fillStyle = css(col, a);
  ctx.fill();
  // 主体左上一道留白，跟另外几个线描图标的高光笔触一致
  ctx.strokeStyle = `rgba(255,255,255,${a * 0.55})`;
  ctx.lineWidth = 2 * sc;
  ctx.beginPath();
  ctx.arc(c[0] - 11 * sc, c[1] - 6 * sc, 11 * sc, Math.PI * 1.12, Math.PI * 1.62);
  ctx.stroke();
}

function paintGaiwan(
  ctx: CanvasRenderingContext2D,
  c: Pt,
  col: Rgb,
  a: number,
  sc: number,
): void {
  const g = GAIWAN;
  const out = css(col, a);
  const steps = 28;
  // 盖：一个半椭圆
  const lid: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = Math.PI + (Math.PI * i) / steps;
    lid.push([Math.cos(t) * g.lidRx, g.lidCy + Math.sin(t) * g.lidRy]);
  }
  // 碗 + 圈足：弧到 bowlFlat 就压平，然后把圈足接在平底上
  const bowl: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (Math.PI * i) / steps;
    bowl.push([
      Math.cos(t) * g.bowlRx,
      Math.min(g.bowlCy + Math.sin(t) * g.bowlRy, g.bowlFlat),
    ]);
  }
  bowl.push([g.footHalf, g.bowlFlat]);
  bowl.push([g.footHalf, g.footY]);
  bowl.push([-g.footHalf, g.footY]);
  bowl.push([-g.footHalf, g.bowlFlat]);

  ctx.fillStyle = out;
  polyPath(ctx, xform(lid, c, sc));
  ctx.fill();
  dot(ctx, c[0] + g.knobX * sc, c[1] + g.knobY * sc, g.knobR * sc, out, null);
  polyPath(ctx, xform(bowl, c, sc));
  ctx.fill();

  // 碗里那道水面：一道**亮一截**的横线，跟着碗身的实际半宽走。
  // 旧版把它画成一个半径 3px 的小弧——占图标面积 1.5%，在 22px 的盘上不存在。
  const y = g.bowlCy + g.bowlRy * 0.45;
  ctx.strokeStyle = `rgba(255,255,255,${a * 0.5})`;
  ctx.lineWidth = 1.6 * sc;
  ctx.beginPath();
  ctx.moveTo(c[0] - g.bowlRx * 0.72 * sc, c[1] + y * sc);
  ctx.lineTo(c[0] + g.bowlRx * 0.72 * sc, c[1] + y * sc);
  ctx.stroke();
}

function paintGuqin(
  ctx: CanvasRenderingContext2D,
  c: Pt,
  col: Rgb,
  alpha: number,
  sc: number,
): void {
  const out = css(col, alpha);
  ctx.fillStyle = out;
  // 岳山
  line(ctx, c[0] - 17 * sc, c[1] - 5 * sc, c[0] - 17 * sc, c[1] + 3 * sc, out, 2.6 * sc);
  for (const foot of GUQIN_FEET) {
    ctx.fillStyle = out;
    polyPath(ctx, xform(foot, c, sc));
    ctx.fill();
  }
  polyPath(ctx, xform(GUQIN_BODY, c, sc));
  ctx.fill();
  // 琴轸
  for (const y of [1.5, 5]) dot(ctx, c[0] + 18 * sc, c[1] + y * sc, 1.8 * sc, out, null);
  // 四根弦，两端按**琴身在这一 y 处的实际半宽**收进去。
  // 亮一截的白弦：琴身是填实的，白弦压在它上面在深色盘和浅纸上都读得出。
  ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.55})`;
  ctx.lineWidth = 1.2 * sc;
  for (let j = 0; j < GUQIN_STRINGS; j++) {
    const y = GUQIN_Y0 + j * GUQIN_DY;
    const half = guqinStringHalf(y) - 1.2;
    ctx.beginPath();
    ctx.moveTo(c[0] - half * sc, c[1] + y * sc);
    ctx.lineTo(c[0] + half * sc, c[1] + y * sc);
    ctx.stroke();
  }
}

function paintBamboo(
  ctx: CanvasRenderingContext2D,
  c: Pt,
  col: Rgb,
  alpha: number,
  sc: number,
): void {
  const ink = css(col, alpha);
  ctx.fillStyle = ink;
  for (let s = -1; s <= 1; s++) {
    const bx = c[0] + s * 18 * sc;
    for (let n = 0; n < 4; n++) {
      const by = c[1] + (-28 + n * 20) * sc;
      // 竹节：节间要略窄一点，才看得出是一节一节长的
      line(ctx, bx, by - 20 * sc, bx, by + 8 * sc, ink, 4 * sc);
      line(ctx, bx - 8 * sc, by, bx + 8 * sc, by, ink, 2.5 * sc);
    }
    // 竹叶两片，认得出是竹而不只是一排竖条
    polyPath(ctx, [
      [bx + 2 * sc, c[1] - 48 * sc],
      [bx + 22 * sc, c[1] - 58 * sc],
      [bx + 5 * sc, c[1] - 36 * sc],
    ]);
    ctx.fill();
    polyPath(ctx, [
      [bx - 2 * sc, c[1] - 34 * sc],
      [bx - 22 * sc, c[1] - 44 * sc],
      [bx - 5 * sc, c[1] - 22 * sc],
    ]);
    ctx.fill();
  }
}

function paintBird(
  ctx: CanvasRenderingContext2D,
  c: Pt,
  col: Rgb,
  alpha: number,
  sc: number,
): void {
  for (const part of BIRD_PARTS) {
    let out = css(col, alpha);
    if (part.c === 'wing') out = `rgba(255,255,255,${alpha * 0.3})`;
    else if (part.c === 'eye') out = `rgba(255,255,255,${alpha * 0.9})`;
    switch (part.k) {
      case 'line':
        line(
          ctx,
          c[0] + part.a[0] * sc,
          c[1] + part.a[1] * sc,
          c[0] + part.b[0] * sc,
          c[1] + part.b[1] * sc,
          out,
          part.w * sc,
        );
        break;
      case 'poly':
        ctx.fillStyle = out;
        polyPath(ctx, xform(part.p, c, sc));
        ctx.fill();
        break;
      case 'ellipse': {
        const pts: Pt[] = [];
        for (let i = 0; i < 28; i++) {
          const t = (TAU * i) / 28;
          pts.push([
            c[0] + (part.ctr[0] + Math.cos(t) * part.rx) * sc,
            c[1] + (part.ctr[1] + Math.sin(t) * part.ry) * sc,
          ]);
        }
        ctx.fillStyle = out;
        polyPath(ctx, pts);
        ctx.fill();
        break;
      }
      case 'circle':
        dot(ctx, c[0] + part.ctr[0] * sc, c[1] + part.ctr[1] * sc, part.r * sc, out, null);
        break;
      default:
        break;
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// 路线图投影（纯函数，不碰画笔）
// ══════════════════════════════════════════════════════════════════════
//
// 顶部那一块是**这一趟的路线图**：真中心线 + 16 座驿站的真实落点 + 到访状态。
// 它换掉的是原先那段云天。原来那张正面是「云 + 五格色卡 + 路牌」，
// 谁拿出去都是同一张——五格只报**收了几件**，不报**在哪儿收的**。
// 而这张卡是玩家唯一带走的东西，正面却一点都不记得他骑过哪条路。
//
// 画的是真数据，现有 API 就够，**零新资产**。

/** 中心线的 XZ 包围盒。模块加载时量一次——原作在 `_ready()` 里建一次，
 *  注释明写着"别在 `_draw()` 里现建，那每帧重算一次包围盒"。 */
const MAP_MIN_XZ = (() => {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of CENTERLINE) {
    if (p.x < minX) minX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.x > maxX) maxX = p.x;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, minZ, maxX, maxZ };
})();

const MAP_SPAN = {
  x: MAP_MIN_XZ.maxX - MAP_MIN_XZ.minX,
  z: MAP_MIN_XZ.maxZ - MAP_MIN_XZ.minZ,
};

export interface MapLayout {
  rect: Rect;
  inner: Rect;
  scale: number;
  org: Pt;
}

/**
 * 地图方框落在卡片哪儿。不碰画笔——`paintFront` 和量它的断言读同一个函数，
 * 「路有没有被框裁掉」「买了信封以后方框还在不在卡片里」这两件事才判得了。
 *
 * · 方框按**高**定边长：8 字环的 bbox 接近正方（329×361m），按宽定会在
 *   上下各空掉一条，按高定才能把 `MAP_BAND_FRAC` 的高度吃满。
 * · 左边距在买了信封时要让开折角 —— 折角是一条从 (0,0) 切下来的等腰直角，
 *   方框照旧贴着左边上角放的话，正好被它削掉框线的一段和路的一角。
 *   （第一版没让开，而当时所有断言都是绿的。）
 */
export function layoutMap(w: number, bandH: number, hasEnvelope: boolean): MapLayout {
  const k = w / 900;
  const cardH = bandH / MAP_BAND_FRAC;
  let inset = MAP_INSET * k;
  if (hasEnvelope) {
    inset = Math.max(inset, Math.min(w, cardH) * ENVELOPE_FOLD_FRAC + 12 * k);
  }
  const rect: Rect = {
    x: inset,
    y: bandH * MAP_RECT_Y_FRAC,
    w: bandH * MAP_RECT_SIZE_FRAC,
    h: bandH * MAP_RECT_SIZE_FRAC,
  };
  // 路线铺进去的内框。内缩一点而不是贴着框线：路线是**正好**铺满 fit 区的
  // （有一边一定顶死），留白不够的话 8 字的上凸和下凸会压在框线上，
  // 读成「图被裁了一刀」。
  const inner = grow(rect, -Math.max(8, MAP_INNER_INSET * k));
  const scale = Math.min(inner.w / MAP_SPAN.x, inner.h / MAP_SPAN.z);
  const org: Pt = [
    inner.x + (inner.w - MAP_SPAN.x * scale) * 0.5,
    inner.y + (inner.h - MAP_SPAN.z * scale) * 0.5,
  ];
  return { rect, inner, scale, org };
}

/** 世界 XZ → 卡片坐标。中心线的 961 个点和 16 座驿站走的都是它。 */
function projectMap(l: MapLayout, wx: number, wz: number): Pt {
  return [
    l.org[0] + (wx - MAP_MIN_XZ.minX) * l.scale,
    l.org[1] + (wz - MAP_MIN_XZ.minZ) * l.scale,
  ];
}

/**
 * 某一格碎片所在驿站，落在**卡片地图**上的位置（画布像素坐标）。
 *
 * 中途预览要圈出"这一件在那儿"：圈的坐标必须和 `drawRouteMap()` 画那颗点
 * 用的是同一套投影，否则圈会钉在地图外、而点还在框里。所以这两个数
 * 只能从这个函数里出来——调用方拿到的是**已经投影过**的像素点。
 *
 * 为什么圈地图上的点、而不是五格画区里的那一格：
 * 画区随评级增减（`VARIANT_LAYOUTS` 里初旅只有 4 格），
 * **还没到过的那一件在卡上根本没有格子可圈**；
 * 但 16 座驿站在地图上一直都在——到过没有，只是实心还是空心。
 * 所以按地图圈，五种状态（没到 / 一到 / 两到 / 三到 / 五件齐）都有落点。
 *
 * @returns `null` 表示这一格查不到驿站（槽位下标越界），调用方不画圈。
 */
export function fragmentMapDot(
  input: PostcardInput,
  slot: number,
  canvasW: number,
  canvasH: number,
): [number, number] | null {
  const stIdx = ROAD.FRAGMENT_SLOT_STATION_IDX[slot];
  if (stIdx == null) return null;
  const st = STATIONS[stIdx];
  if (!st) return null;
  const l = layoutMap(canvasW, canvasH * MAP_BAND_FRAC, input.hasEnvelope);
  return projectMap(l, st.x, st.z);
}

// ══════════════════════════════════════════════════════════════════════
// 确定性噪点
// ══════════════════════════════════════════════════════════════════════

/**
 * 从 `input` 派生的固定种子。
 *
 * 原作的做旧纹理全是 `fmod(i * 173.3, w)` 这种**写死的公式**，所以同一份输入
 * 必然画出同一张图。这里再叠一层 mulberry32 噪点，补上"零贴图"缺的那点颗粒：
 * 种子同样由 `input` 派生，所以**同一份输入仍然逐像素相同**——玩家导出两次
 * 必须拿到同一个文件，改了进度才变。
 */
function seedOf(input: PostcardInput, salt: number): number {
  let h = 0x811c9dc5;
  const mix = (v: number): void => {
    h ^= Math.imul(v | 0, 0x01000193);
    h = (h << 13) | (h >>> 19);
  };
  mix(input.kitTier);
  mix(input.lang === 'zh' ? 0x9e37 : 0x85eb);
  mix(input.ending === 'leave_door' ? 0x27d4 : 0x1656);
  mix(input.hasPaper ? 1 : 0);
  mix(input.hasInk ? 1 : 0);
  mix(input.hasSeal ? 1 : 0);
  mix(input.hasEnvelope ? 1 : 0);
  for (let i = 0; i < input.slotVisits.length && i < 5; i++) mix(input.slotVisits[i]);
  mix(input.backText.length);
  mix(salt);
  return h >>> 0;
}

// ══════════════════════════════════════════════════════════════════════
// 正面
// ══════════════════════════════════════════════════════════════════════

/** 封口的蜡是不是裂开的。终局选【放手】就是裂的 —— 蜡封本来就是"把信按住了"，
 *  放手自然要把封口掰开。这是留门 / 放手之间唯一**画在正面**的差别，
 *  而正面才是玩家真正带走的那张 PNG；背面那句预填文案玩家随时能改，改不了。 */
export function sealBroken(input: PostcardInput): boolean {
  return input.ending === 'let_go';
}

/**
 * 画正面。**画布尺寸就是卡片尺寸、变换必须是单位矩阵**（见文件头）。
 * 这里不加任何 transform：所有尺寸都从 `canvas.width` 出发按 `k = w/900` 推，
 * 于是同一份代码在 1920 的导出和 450 的预览上相对关系一致。
 */
export function drawFront(ctx: CanvasRenderingContext2D, input: PostcardInput): void {
  paintFront(ctx, input, true);
}

function paintFront(ctx: CanvasRenderingContext2D, input: PostcardInput, detail: boolean): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const th = themeRgb(input);
  const variant = computeVariant(input);
  const layout = VARIANT_LAYOUTS[variant] ?? VARIANT_LAYOUTS[0];
  const bandH = h * MAP_BAND_FRAC;

  // 底色 + 纸面纹理 + 外框 + 内框
  ctx.fillStyle = css(th.paper);
  ctx.fillRect(0, 0, w, h);
  drawPaperTexture(ctx, input, w, h, detail);
  strokeRect(ctx, 0, 0, w, h, css(th.frame), th.frameWidth);
  strokeRect(ctx, 8, 8, w - 16, h - 16, css(th.ink), 1);

  // 顶部：这一趟的路线图（真中心线 + 16 驿 + 到访状态）
  drawRouteMap(ctx, input, w, bandH, th, detail);

  // 中段：五格碎片画区（按评级决定哪些是真实、哪些是占位灰）
  const sectY = bandH;
  const sectH = h * (PANEL_BOTTOM_FRAC - MAP_BAND_FRAC);
  const sectW = w / Math.max(layout.length, 1);
  for (let i = 0; i < layout.length; i++) {
    const entry = layout[i];
    const slot = entry.slot;
    const isPlaceholder = entry.placeholder;
    const baseCol = isPlaceholder ? GRAY : hex(FRAGMENT_COLS[slot] ?? FRAGMENT_COLS[0]);
    const rx = i * sectW;
    const panel: Rect = { x: rx, y: sectY, w: sectW, h: sectH };
    ctx.fillStyle = css(panelFill(baseCol, th.paper, 0, isPlaceholder));
    ctx.fillRect(rx, sectY, sectW, sectH);
    if (!isPlaceholder) drawPanelWash(ctx, panel, i, detail);
    strokeRect(ctx, rx, sectY, sectW, sectH, css(th.ink, 0.2), 1);

    const ctr: Pt = [rx + sectW * 0.5, sectY + sectH * 0.5];
    if (!isPlaceholder && slot >= 0) {
      // 图标要撑满画区才读得出来。旧值 /180 在 150px 宽的格子里只画出 40px，
      // 五个图标全缩在格子中央一小团——导出成 1920 宽的 PNG 之后更看不清。
      // 分母 82 是被最宽的琴（±38）压住的，再大就顶格。
      const sc = Math.min(sectW / 82, sectH / 210);
      // 图标走**墨色**而不是底色的浅色调。旧版拿 base_col.lightened(0.25) 压在
      // base_col.darkened(0.18) 的格子上，两者只差一档，读出来是"颜色深一点
      // 的方块"；换墨色之后才是一个剪影。
      drawFragmentIcon(ctx, slot, ctr, th.ink, 1, sc);

      const lposY = sectY + sectH - PANEL_LABEL_DY_FROM_BOTTOM;
      // 底下垫一条纸色的带：格子的底色每件都不一样，字要是不垫底
      // 就跟着那一件变深变浅，云那一格尤其读不出来。
      ctx.fillStyle = `rgba(255,255,255,${PANEL_LABEL_BAND_ALPHA})`;
      ctx.fillRect(ctr[0] - sectW * 0.5, lposY + PANEL_LABEL_BAND_DY, sectW, PANEL_LABEL_BAND_H);
      setFont(ctx, FONT_UI, PANEL_LABEL_SIZE);
      drawTextAligned(
        ctx,
        ctr[0],
        lposY - 6,
        t(input.lang, `fragment_${slot}`),
        css(th.ink),
        -1, // 宽 -1 → 对齐失效，文字从 ctr.x 起画（原作如此，见 drawTextAligned）
        'center',
      );
    } else {
      setFont(ctx, FONT_UI, PLACEHOLDER_SIZE);
      drawText(ctx, ctr[0] + PLACEHOLDER_DX, sectY + sectH * 0.5 + 10, '?', css(GRAY));
    }
  }

  // 完满评级的金印。**不缩放**：圆心写死 w-90、半径 32，所以它的左沿恒是
  // w-122、与卡片多大无关——抬头右半那一列的右沿恒定在 w-150k 就是按这一点
  // 倒推的。改成缩放的，900px 那一档两列会真的压上（金印落到 y 0..52，
  // 而列 B 第一行基线在带高 0.305 ≈ 38 处，20px 的字身往上就顶进金印）。
  if (variant === 4) {
    const sealX = w - COMPLETE_SEAL_X_FROM_RIGHT;
    dot(
      ctx,
      sealX,
      COMPLETE_SEAL_Y,
      COMPLETE_SEAL_R,
      css(darkened(hex(COMPLETE_SEAL_COL), 0.1)),
      null,
    );
    setFont(ctx, FONT_UI, COMPLETE_SEAL_TEXT_SIZE);
    drawTextAligned(
      ctx,
      sealX - COMPLETE_SEAL_TEXT_W * 0.5,
      COMPLETE_SEAL_Y + 10,
      t(input.lang, 'postcard_seal'),
      LAND_COL,
      COMPLETE_SEAL_TEXT_W,
      'center',
    );
  }

  // 封口位：珍藏笺自带一圈金框当「蜡封位」；真把口封上要灯铺那块蜡。
  // 选【放手】时这一块永远要画 —— 抉择在正面留下的唯一痕迹。
  if (kitTierClamp(input.kitTier) >= 3 || input.hasSeal || sealBroken(input)) {
    drawSealMark(ctx, input, h, th);
  }

  // 信封：左上角压一道折角，像还没从信封里抽出来
  if (input.hasEnvelope) drawEnvelope(ctx, w, h, th);

  // 底部路牌
  drawRoadSign(ctx, w, h, th);

  // 落款；买过纸套餐的在旁边标一档纸名
  setFont(ctx, FONT_UI, SIGNATURE_SIZE);
  const sigX = w - SIGNATURE_DX_FROM_RIGHT;
  const sigY = h - SIGNATURE_DY_FROM_BOTTOM;
  drawText(ctx, sigX, sigY, t(input.lang, 'postcard_signature'), css(th.ink));
  const tname = paperTierName(input);
  if (tname !== '') {
    const tw = measure(ctx, tname);
    drawText(ctx, sigX - tw - SIGNATURE_TIER_GAP, sigY, tname, css(th.frame));
  }
}

/**
 * 顶部那一块。
 *
 * 整块压一层比纸面稍深的底。直接画在纸面上，地图会读成一张浮着的剪贴画；
 * 给它一个「这一带是另一个东西」的地基才像印上去的。
 */
function drawRouteMap(
  ctx: CanvasRenderingContext2D,
  input: PostcardInput,
  w: number,
  bandH: number,
  th: ThemeRgb,
  detail: boolean,
): void {
  const k = w / 900;
  ctx.fillStyle = css(darkened(th.paper, 0.035));
  ctx.fillRect(0, 0, w, bandH);

  const l = layoutMap(w, bandH, input.hasEnvelope);

  // 底衬：一层比纸更浅的「空地」，路线浮在它上面
  ctx.fillStyle = css(lightened(th.paper, 0.35));
  ctx.fillRect(l.rect.x, l.rect.y, l.rect.w, l.rect.h);

  // 路基铺宽、路心压细：一条线粗细一致读成「画了一条线」，两段才像路。
  const step = detail ? 1 : 3; // 预览时每 3 点取 1：小尺寸下看不出差别
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = css(th.ink, 0.16);
  ctx.lineWidth = 7 * k;
  strokeCenterline(ctx, l, step);
  ctx.strokeStyle = css(th.ink, 0.85);
  ctx.lineWidth = 1.8 * k;
  strokeCenterline(ctx, l, step);

  // 16 座驿站。判据是**这一趟真的经过了没有**，碎片站再叠一层：
  // 到过访的用自己那件的颜色点实心，没到过是空心加一圈淡色外环——
  // 空心才和右边图例里那句「空心 = 未至」对得上。
  for (let i = 0; i < STATIONS.length; i++) {
    const p = projectMap(l, STATIONS[i].x, STATIONS[i].z);
    const slot = ROAD.FRAGMENT_STATION_TO_SLOT[String(i)] ?? -1;
    if (slot >= 0) {
      const col = hex(FRAGMENT_COLS[slot]);
      const visits = Math.floor(input.slotVisits[slot] ?? 0);
      dot(ctx, p[0], p[1], 5.4 * k, null, css(col, 0.45), 1.2 * k);
      dot(ctx, p[0], p[1], 3.4 * k, null, css(th.ink), Math.max(1, 1.2 * k));
      if (visits > 0) dot(ctx, p[0], p[1], 2.2 * k, css(darkened(col, 0.25)), null);
    } else if (isStationSeen(input, i)) {
      dot(ctx, p[0], p[1], 2.6 * k, css(th.ink), null);
    } else {
      dot(ctx, p[0], p[1], 2 * k, null, css(th.ink), Math.max(1, 1 * k));
    }
  }

  // 框：内外两道，取「一方图」的版式
  strokeRect(ctx, l.rect.x, l.rect.y, l.rect.w, l.rect.h, css(th.ink), Math.max(1, 1.6 * k));
  const f = grow(l.rect, -Math.max(3, 4 * k));
  strokeRect(ctx, f.x, f.y, f.w, f.h, css(th.ink), Math.max(1, 1 * k));

  drawMapCaption(ctx, input, w, bandH, k, l, th);
}

function strokeCenterline(ctx: CanvasRenderingContext2D, l: MapLayout, step: number): void {
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < CENTERLINE.length; i += step) {
    const p = projectMap(l, CENTERLINE[i].x, CENTERLINE[i].z);
    if (!started) {
      ctx.moveTo(p[0], p[1]);
      started = true;
    } else {
      ctx.lineTo(p[0], p[1]);
    }
  }
  const last = CENTERLINE[CENTERLINE.length - 1];
  const p = projectMap(l, last.x, last.z);
  ctx.lineTo(p[0], p[1]);
  ctx.stroke();
}

/**
 * 地图右边那一列字：一句标题、一句「已过 n 驿」、五件乐事各到访几次、外加图例。
 *
 * 数字全部现算自存档，一个字都不另存——明信片是在结束这一趟的那一刻现画的，
 * 玩家改了存档再导出，拿到的就该是改过的那张。
 */
function drawMapCaption(
  ctx: CanvasRenderingContext2D,
  input: PostcardInput,
  w: number,
  bandH: number,
  k: number,
  l: MapLayout,
  th: ThemeRgb,
): void {
  const x = l.rect.x + l.rect.w + 22 * k;
  const dim = css(th.ink, 0.62);
  const solid = css(th.ink);

  setFont(ctx, FONT_UI, Math.round(20 * k));
  drawText(ctx, x, bandH * 0.28, t(input.lang, 'postcard_map_title'), dim);

  setFont(ctx, FONT_UI, Math.round(28 * k));
  drawText(ctx, x, bandH * 0.56, tInt(input.lang, 'stations_seen', seenCountOf(input)), solid);

  drawJoysColumn(ctx, input, w, bandH, k, th, x + captionColW(ctx, input, k) + w * 0.05);

  // 图例：两个小圆点 + 一句话。图上一共十六个点，不说清楚实心空心的意思，
  // 看的人只会以为那是十六个一样的标记。
  const ly = bandH * 0.96;
  const dot0 = 4 * k;
  dot(ctx, x + dot0, ly - dot0 * 0.4, dot0, solid, null);
  dot(ctx, x + 30 * k, ly - dot0 * 0.4, dot0 * 0.8, null, solid, Math.max(1, 1 * k));
  setFont(ctx, FONT_UI, Math.round(14 * k));
  drawText(ctx, x + 44 * k, ly, t(input.lang, 'postcard_map_legend'), dim);
}

/**
 * 列 A（标题 / 已过 n 驿 / 图例）最宽的那一条有多宽。列 B 靠它起步，
 * 所以这一段必须**量出来**：英文那一列比中文长一截，写死一个间距的话
 * 英文界面下两列会压在一起。
 *
 * 驿数那一行拿**驿站总数**而不是这一趟的实际值：要的是这一列在**任何存档**下的
 * 最宽情形（走完全程时那个数最大）。按实际值起步的话，玩家到过的驿越多、
 * 后面的列离字越近。
 */
function captionColW(ctx: CanvasRenderingContext2D, input: PostcardInput, k: number): number {
  setFont(ctx, FONT_UI, Math.round(20 * k));
  const a = measure(ctx, t(input.lang, 'postcard_map_title'));
  setFont(ctx, FONT_UI, Math.round(28 * k));
  const b = measure(ctx, tInt(input.lang, 'stations_seen', STATION_COUNT));
  setFont(ctx, FONT_UI, Math.round(14 * k));
  const c = measure(ctx, t(input.lang, 'postcard_map_legend')) + 44 * k;
  return Math.max(a, Math.max(b, c));
}

/**
 * 五件乐事那一列占的那块矩形。不碰画笔，量的是它。
 *
 * 右沿停在 `w - 150k`，为的是**让开右上角那枚完满金印**（它不缩放）。
 * 宽出来的这一段是**名字和次数之间那份留白**，不是排不下的余量：
 * 名字左对齐、次数右对齐成一本账，两行之间拉得太开就读不成一对。
 *
 * 而这一列的**外侧**留白（1920 下是 16.7%）要小于两成宽，否则就是
 * "换了个地方继续空着"——和地图左边那 200px 的外边距大致对称。
 *
 * 宽度算出来是 0 也不画 —— 卡片窄到放不下这一列时，宁可少一列，
 * 也不要两列的字压在一起。
 */
export function joysColumnRect(w: number, bandH: number, k: number, x0: number): Rect {
  const rowH = bandH * 0.15;
  return { x: x0, y: bandH * 0.2, w: Math.max(0, w - 150 * k - x0), h: rowH * 5 };
}

function drawJoysColumn(
  ctx: CanvasRenderingContext2D,
  input: PostcardInput,
  w: number,
  bandH: number,
  k: number,
  th: ThemeRgb,
  x0: number,
): void {
  const r = joysColumnRect(w, bandH, k, x0);
  if (r.w <= 0) return;
  const dim = css(th.ink, 0.62);

  setFont(ctx, FONT_UI, Math.round(17 * k));
  drawText(ctx, r.x, bandH * 0.13, t(input.lang, 'postcard_joys_title'), dim);

  for (let slot = 0; slot < 5; slot++) {
    const visits = Math.floor(input.slotVisits[slot] ?? 0);
    const by = r.y + (r.h * (slot + 0.7)) / 5;
    // 名字用它自己那件的颜色 —— 和下面五格画区是同一把钥匙，玩家扫一遍就通
    setFont(ctx, FONT_UI, Math.round(20 * k));
    drawText(
      ctx,
      r.x,
      by,
      t(input.lang, `fragment_${slot}`),
      css(darkened(hex(FRAGMENT_COLS[slot]), 0.35)),
    );
    // 次数**右对齐在这一列的右沿**：五行的数字对不齐的话读起来像随手记的，
    // 而这一列现在替的是"玩家这一趟干了什么"这句话。
    setFont(ctx, FONT_UI, Math.round(17 * k));
    drawTextAligned(
      ctx,
      r.x,
      by,
      tInt(input.lang, 'postcard_visit_n', visits),
      dim,
      r.w,
      'right',
    );
  }
}

/** 画区里的纸感。五个画区原来是五块**平涂**的色卡，远看就是一份色板，
 *  而玩家带走的是一张纪念。补三层：顶部受光的竖向渐变、底部一道水色
 *  积聚的暗边、几根纸纤维。色块有了厚度，才不像 UI 的取色器。 */
function drawPanelWash(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  seedIdx: number,
  detail: boolean,
): void {
  for (let i = 0; i < PANEL_WASH_BANDS; i++) {
    const t0 = i / PANEL_WASH_BANDS;
    const y0 = r.y + r.h * t0;
    const hh = r.h * ((i + 1) / PANEL_WASH_BANDS - t0) + 1;
    ctx.fillStyle = `rgba(255,255,255,${0.11 * (1 - t0)})`;
    ctx.fillRect(r.x, y0, r.w, hh);
  }
  // (0.20, 0.16, 0.12) —— 水色积聚的暗边
  ctx.fillStyle = 'rgba(51,41,31,0.1)';
  ctx.fillRect(r.x, r.y + r.h * 0.86, r.w, r.h * 0.14);
  if (!detail) return;
  ctx.strokeStyle = 'rgba(64,51,38,0.1)'; // (0.25, 0.20, 0.15)
  ctx.lineWidth = 1;
  for (let i = 0; i < PANEL_FIBERS; i++) {
    const fx = r.x + fmod(seedIdx * 7 + i * 53, r.w);
    const fy = r.y + fmod(seedIdx * 11 + i * 31, r.h * 0.92);
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(fx + 5, fy - 1);
    ctx.stroke();
  }
}

function drawRoadSign(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  th: ThemeRgb,
): void {
  const x = w * 0.5 - ROAD_SIGN_W * 0.5;
  const y = h * ROAD_SIGN_Y_FRAC;
  ctx.fillStyle = css(th.paper);
  ctx.fillRect(x, y, ROAD_SIGN_W, ROAD_SIGN_H);
  strokeRect(ctx, x, y, ROAD_SIGN_W, ROAD_SIGN_H, css(th.ink), 1);
  setFont(ctx, FONT_UI, ROAD_SIGN_TEXT_SIZE);
  drawText(ctx, x + ROAD_SIGN_TEXT_DX, y + ROAD_SIGN_TEXT_DY, ROAD_SIGN_TEXT, css(th.ink));
}

/** 纸面纹理：帘纹是纵向细线（间距随宽度走，别让 1920 宽的导出图里挤几百条），
 *  宣纸再叠一层短纤维。alpha 都压得很低，只做「摸得着纸」，不抢五个画区的戏。 */
function drawPaperTexture(
  ctx: CanvasRenderingContext2D,
  input: PostcardInput,
  w: number,
  h: number,
  detail: boolean,
): void {
  const flags = paperTextureFlags(input);
  if (flags.laidLines) {
    const step = Math.max(LAID_LINE_MIN_STEP, w / LAID_LINE_DIVISOR);
    ctx.strokeStyle = 'rgba(107,92,71,0.045)'; // (0.42, 0.36, 0.28)
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }
  if (flags.fiber && detail) {
    ctx.strokeStyle = 'rgba(97,84,66,0.09)'; // (0.38, 0.33, 0.26)
    ctx.lineWidth = 1;
    for (let i = 0; i < FIBER_COUNT; i++) {
      const fx = fmod(i * 173.3, w);
      const fy = fmod(i * 97.7, h);
      const fl = 4 + fmod(i * 7, 9);
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(fx + fl, fy - 1);
      ctx.stroke();
    }
  }
  // 零贴图补的那点颗粒：种子固定 → 同一份输入逐像素相同。
  if (detail) {
    const rng = makeRng(seedOf(input, 0x5eed));
    const n = Math.min(360, Math.round((w * h) / 6000));
    for (let i = 0; i < n; i++) {
      const x = rng() * w;
      const y = rng() * h;
      ctx.fillStyle = rng() > 0.5 ? 'rgba(60,48,32,0.035)' : 'rgba(255,255,255,0.03)';
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

/**
 * 左下角封口位。珍藏笺自带一圈金框当「蜡封位」，真封住要靠灯铺那块蜡。
 * 两者互不依赖：有圈没蜡是空位，有蜡没圈照样盖得上。
 *
 * 选【放手】时这块封口是掰开的：没蜡也画一个开口的圈（否则"没买蜡封"的玩家
 * 看不到任何差别，抉择就又只剩背面那一句可改了），有蜡则蜡上带一道裂口、
 * 中心的压印方框去掉。留门 / 未竟一律画成完好的。
 */
function drawSealMark(
  ctx: CanvasRenderingContext2D,
  input: PostcardInput,
  h: number,
  th: ThemeRgb,
): void {
  const c: Pt = [SEAL_MARK_X, h - SEAL_MARK_DY_FROM_BOTTOM];
  const r = SEAL_MARK_R;
  const broken = sealBroken(input);
  const wax = th.seal;
  if (kitTierClamp(input.kitTier) >= 3 || broken) {
    dot(ctx, c[0], c[1], r + 4, null, css(th.frame), 2);
  }
  if (input.hasSeal) {
    dot(ctx, c[0], c[1], r, css(wax), null);
    dot(ctx, c[0] - 3, c[1] - 4, r - 5, css(lightened(wax, 0.14)), null);
    if (broken) {
      // 裂口：从左上缘贯到右下缘的一道折线，中心的压印方框不再画
      ctx.strokeStyle = css(darkened(wax, 0.55));
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(c[0] - r * 0.92, c[1] - r * 0.34);
      ctx.lineTo(c[0] - r * 0.18, c[1] + r * 0.1);
      ctx.lineTo(c[0] - r * 0.42, c[1] + r * 0.46);
      ctx.lineTo(c[0] + r * 0.1, c[1] + r * 0.7);
      ctx.stroke();
    } else {
      strokeRect(ctx, c[0] - 9, c[1] - 9, 18, 18, css(darkened(wax, 0.4)), 2);
    }
  } else if (broken) {
    // 没蜡：开口的圈 —— 一枚盖过又被揭开的封口
    ctx.strokeStyle = css(wax);
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(c[0], c[1], r, Math.PI * 0.16, Math.PI * 1.08);
    ctx.stroke();
  }
}

/**
 * 信封：左上角折角。卡片占满画布、画不到画布之外，
 * 所以只能在这道折角上暗示「还没取出来」，别试图画一个信封外框。
 * 地图方框的左边距也因此要让开（见 layoutMap）。
 */
function drawEnvelope(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  th: ThemeRgb,
): void {
  const d = Math.min(w, h) * ENVELOPE_FOLD_FRAC;
  polyPath(ctx, [
    [0, 0],
    [d, 0],
    [0, d],
  ]);
  ctx.fillStyle = 'rgba(117,97,71,0.22)'; // (0.46, 0.38, 0.28)
  ctx.fill();
  polyPath(ctx, [
    [d, 0],
    [d, d],
    [0, d],
  ]);
  ctx.fillStyle = css(th.paperEdge);
  ctx.fill();
  line(ctx, d, 0, d, d, css(th.ink), 2);
  line(ctx, d, d, 0, d, css(th.ink), 2);
}

// ══════════════════════════════════════════════════════════════════════
// 背面
// ══════════════════════════════════════════════════════════════════════

/** 正文框。抽出来是为了让尺寸断言量得到它 —— 画笔里写死的话
 *  任何尺寸断言都只能跟着抄一遍。 */
export function backMessageBox(w: number, h: number): Rect {
  const splitY = h * BACK_SPLIT_FRAC;
  return { x: 40, y: splitY + 24, w: w - 80, h: h - splitY - 160 };
}

/**
 * 画背面（导出路径）。玩家写的字用**手写体** `FONT_HAND`。
 *
 * 调用前必须已经 `await ensureHandwritingFont()`（见 export.ts）：
 * 字体没加载完就画会**静默回退成系统字体**——界面看着"能写字"，
 * 导出的 PNG 字形却是另一套。
 *
 * 背面**不吃纸面档位**：原作 `PostcardBack` 根本不知道套餐档位这件事，
 * 正反两面用同一套米白 / 墨 / 强调色。这不是遗漏，是"背面是另一张纸"。
 */
export function drawBack(ctx: CanvasRenderingContext2D, input: PostcardInput): void {
  paintBack(ctx, input, FONT_HAND);
}

/**
 * 供 UI 实时预览：小尺寸快速渲染。
 *
 * 调用的画布就是卡片尺寸（显示缩放由 CSS 负责），所以 `k` 自然变小。
 * 与导出路径的差别只有三处，都是"小尺寸上看不出来"的：
 *   · 中心线每 3 点取 1（961 → 321 段）；
 *   · 不画宣纸纤维、不画画区纤维、不撒噪点；
 *   · 背面正文走 UI 字体，**不触发 404KB 手写体的加载**。
 */
export function drawPreview(
  ctx: CanvasRenderingContext2D,
  input: PostcardInput,
  side: 'front' | 'back',
): void {
  if (side === 'front') paintFront(ctx, input, false);
  else paintBack(ctx, input, FONT_UI);
}

function paintBack(ctx: CanvasRenderingContext2D, input: PostcardInput, handFamily: string): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const ink = INK_COL;
  const accent = hex(ACCENT_COL);

  ctx.fillStyle = LAND_COL;
  ctx.fillRect(0, 0, w, h);

  // 外框 + 内框
  strokeRect(ctx, 0, 0, w, h, css(darkened(accent, 0.2)), 8);
  strokeRect(ctx, 16, 16, w - 32, h - 32, ink, 2);

  // 顶部标题
  setFont(ctx, FONT_UI, 44);
  drawText(ctx, 48, 84, t(input.lang, 'postcard_back_title'), ink);
  line(ctx, 40, 104, w - 40, 104, ink, 2);

  // 分割线
  const splitY = h * BACK_SPLIT_FRAC;
  line(ctx, 40, splitY, w - 40, splitY, css(darkened(accent, 0.3)), 2);

  // 背面文字区
  const msg = backMessageBox(w, h);
  ctx.fillStyle = css(hex(ink), 0.04);
  ctx.fillRect(msg.x, msg.y, msg.w, msg.h);
  strokeRect(ctx, msg.x, msg.y, msg.w, msg.h, ink, 1);

  drawMessage(ctx, input.backText, handFamily, msg);

  if (input.backText.slice(0, BACK_MAX_CHARS).length > 0) {
    // 底部落款
    setFont(ctx, FONT_UI, BACK_FROM_SIZE);
    drawText(
      ctx,
      w - BACK_FROM_DX_FROM_RIGHT,
      h - BACK_FROM_DY_FROM_BOTTOM,
      t(input.lang, 'postcard_back_from'),
      ink,
    );
  }

  // 底部路牌
  const sx = w * 0.5 - BACK_SIGN_W * 0.5;
  const sy = h - BACK_SIGN_DY_FROM_BOTTOM;
  ctx.fillStyle = LAND_COL;
  ctx.fillRect(sx, sy, BACK_SIGN_W, BACK_SIGN_H);
  strokeRect(ctx, sx, sy, BACK_SIGN_W, BACK_SIGN_H, ink, 2);
  setFont(ctx, FONT_UI, BACK_SIGN_TEXT_SIZE);
  drawText(ctx, sx + BACK_SIGN_TEXT_DX, sy + BACK_SIGN_TEXT_DY, ROAD_SIGN_TEXT, ink);
}

/**
 * 玩家写的正文。按宽度断行（中文可任意断，西文按空格断），
 * 字号从大往小找第一个整块放得下的号。
 *
 * 字号变大之后块矮了，顶在框的上沿会读成"上半张纸有字、下半张空着"，
 * 所以整块在框里**上下居中**。
 */
function drawMessage(
  ctx: CanvasRenderingContext2D,
  backText: string,
  family: string,
  msg: Rect,
): void {
  const text = backText.slice(0, BACK_MAX_CHARS);
  if (text === '') return;
  const maxW = msg.w - BACK_MSG_PAD * 2;
  const maxH = msg.h - BACK_MSG_PAD * 2;
  const fs = messageFontSize(ctx, family, text, maxW, maxH);
  setFont(ctx, family, fs);
  const lines = wrapText(ctx, family, text, fs, maxW);
  const lineH = fontHeight(ctx) + BACK_LINE_GAP;
  let y = msg.y + BACK_MSG_PAD + (maxH - lines.length * lineH) * 0.5 + fontAscent(ctx);
  for (const ln of lines) {
    drawText(ctx, msg.x + BACK_MSG_PAD, y, ln, INK_COL);
    y += lineH;
  }
}
