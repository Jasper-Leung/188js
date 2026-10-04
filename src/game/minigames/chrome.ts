/**
 * 五个小游戏共用的外壳 —— 对应 Godot 侧的 MiniGameBackdrop / MiniGameBar /
 * MiniGameChrome 三份文件，合成一个模块（这三个 RefCounted 全是纯绘制，
 * 没有状态，拆开反而要来回跳）。
 *
 * Godot `draw_*` → Canvas 2D 的映射约定（全项目统一，注释里不再重复）：
 *   draw_rect(r, c, true)            → fillRect
 *   draw_rect(r, c, false, w)        → lineWidth=w; strokeRect
 *   draw_line(a, b, c, w)            → beginPath/moveTo/lineTo/stroke
 *   draw_polyline(pts, c, w)         → 同上但**不** closePath
 *   draw_colored_polygon(pts, c)     → closePath + fill
 *   draw_circle(c, r, col)           → arc(0,TAU) + fill
 *   draw_arc(c, r, a0, a1, n, col, w)→ arc(a0, a1, false) + stroke
 *   draw_string(f, pos, s, al, wd, sz, col)
 *                                  → fillText，**pos.y 是基线**、不是行盒顶；
 *                                    `wd` 是**裁切宽度**，对齐在 [pos.x, pos.x+wd]
 *                                    这段里做（见 drawText）
 *
 * 零贴图：这里没有任何 drawImage/createPattern，五个小游戏的每一个像素都是
 * 路径 + 渐变，跟 Godot 版一样。
 */
import type { Lang } from '../../data/raw';
import type { MiniGameContext } from './types';

// ---------------------------------------------------------------- 基础类型

export const TAU = Math.PI * 2;

/** 一次性矩形对象。热路径里**不要**新建：每个小游戏各自持有一个可复用的成员。 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 0..1 的浮点三元组。对应 Godot 的 `Color(r, g, b)`（Godot 那边的分量也是 0..1）。 */
export type Rgb = readonly [number, number, number];

/**
 * 字体栈。宿主加载 `public/fonts/ui.woff2` 时写的 `@font-face { family: ... }`
 * 名字要和第一项一致；不一致不会坏功能（回落到系统字体），只会掉一点观感。
 * 原作是 `ThemeDB.fallback_font`，没有指定族，所以这里给的是"能出中文 +
 * 不依赖 webfont 也可读"的保守栈。
 */
export const FONT_STACK =
  '"188UI", "LXGW WenKai", system-ui, "Segoe UI", "Microsoft YaHei", "Noto Sans SC", sans-serif';

// ---------------------------------------------------------------- 文案

/**
 * 取文案并填位置参数。
 *
 * **占位符是 printf 风格的位置参数**（`%d` / `%s` / `%.1f` / `%.0f` / `%%`），
 * 整个 I18N 表 214 个 key 全是这个形态，表里没有任何一个具名占位符。
 * 所以 `vars` 的**键名没有意义，只有值的顺序有意义**；这里用下标字符串当键，
 * 纯粹是为了在调试器里读得出来。宿主实现 `t()` 时按值的出现顺序替换即可。
 *
 * 不写成 `(...vals)` 的 rest 参数：那是每帧一次的小数组分配，而这几个入口
 * （云的完成度、茶的倒计时、琴的回合、竹的进度）每帧都要走。
 */
export function tf(
  sh: Shell,
  key: string,
  a?: string | number,
  b?: string | number,
  c?: string | number,
): string {
  if (a === undefined) return sh.t(key);
  if (b === undefined) return sh.t(key, { '0': a });
  if (c === undefined) return sh.t(key, { '0': a, '1': b });
  return sh.t(key, { '0': a, '1': b, '2': c });
}

// ---------------------------------------------------------------- 颜色

/** `Color(r,g,b,a)` → css。Godot 的分量是 0..1，Canvas 要 0..255。 */
export function rgba(c: Rgb, a = 1): string {
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
}

/** `#rrggbb` → Rgb。启动时用一次，拆主题表。 */
function hex(h: string): Rgb {
  return [
    parseInt(h.slice(1, 3), 16) / 255,
    parseInt(h.slice(3, 5), 16) / 255,
    parseInt(h.slice(5, 7), 16) / 255,
  ];
}

/**
 * `Color.lightened(amount)`。Godot 4 的实现是 `fposmod(c+1, 1) * amount + (1 - amount)`，
 * 而 c∈[0,1] 时 `fposmod(c+1,1) === c`，于是就是 `c*a + (1-a)`。
 * 注意**不是** `c + (1-c)*a` 的线性插值之外的任何东西——两者在这个式子上相等，
 * 但和 `darkened` 的写法不对称，别顺手写成一样的。
 */
export function lightened(c: Rgb, amt: number): Rgb {
  return [c[0] * amt + (1 - amt), c[1] * amt + (1 - amt), c[2] * amt + (1 - amt)];
}

/** `Color.darkened(amount)`。Godot 的实现是 `c * (1 - amount)`。 */
export function darkened(c: Rgb, amt: number): Rgb {
  return [c[0] * (1 - amt), c[1] * (1 - amt), c[2] * (1 - amt)];
}

/** 逐通道 lerp。`Color.lerp(to, w)`。 */
export function lerpRgb(a: Rgb, b: Rgb, w: number): Rgb {
  return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
}

// ---------------------------------------------------------------- 画笔

export function fillRect(g: CanvasRenderingContext2D, r: Rect, col: string): void {
  g.fillStyle = col;
  g.fillRect(r.x, r.y, r.w, r.h);
}

/**
 * `draw_rect(rect, col, false, width)`。Godot 的描边线宽是**跨在**矩形边上的
 * （一半在内一半在外），Canvas 的 `strokeRect` 也是，**不要**往里缩半个线宽。
 */
export function strokeRect(g: CanvasRenderingContext2D, r: Rect, col: string, width: number): void {
  g.strokeStyle = col;
  g.lineWidth = width;
  g.strokeRect(r.x, r.y, r.w, r.h);
}

export function line(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, col: string, width: number): void {
  g.strokeStyle = col;
  g.lineWidth = width;
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
}

export function circle(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, col: string): void {
  g.fillStyle = col;
  g.beginPath();
  g.arc(cx, cy, Math.max(r, 0.01), 0, TAU);
  g.fill();
}

/** 椭圆多边形（`fillColoredPolygon(_ellipse(...))`）。`arc` 的 0..TAU 走的是 Godot 同向。 */
export function ellipse(g: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, col: string): void {
  g.fillStyle = col;
  g.beginPath();
  g.ellipse(cx, cy, Math.max(rx, 0.01), Math.max(ry, 0.01), 0, 0, TAU);
  g.fill();
}

/** `draw_arc(center, radius, start, end, points, col, width)`。正角方向与 Godot 一致。 */
export function arcStroke(
  g: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
  a0: number, a1: number,
  col: string, width: number,
): void {
  g.strokeStyle = col;
  g.lineWidth = width;
  g.beginPath();
  g.arc(cx, cy, Math.max(r, 0.01), a0, a1, false);
  g.stroke();
}

// ---------------------------------------------------------------- 文字

function setFont(g: CanvasRenderingContext2D, sizePx: number): void {
  g.font = `${sizePx}px ${FONT_STACK}`;
}

/**
 * 画一行字。`y` 是**基线**（Godot 的 `draw_string` 也是），不是行盒顶。
 * `align` 参照 Godot 的 HORIZONTAL_ALIGNMENT_*，对齐区间是 `[x, x + boxW]`；
 * `boxW <= 0` 时退化成左对齐（Godot 传 -1 的效果）。
 */
export function drawText(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  sizePx: number,
  col: string,
  align: 'left' | 'center' | 'right' = 'left',
  boxW = 0,
): void {
  setFont(g, sizePx);
  g.fillStyle = col;
  g.textAlign = align === 'left' || boxW <= 0 ? 'left' : align;
  g.textBaseline = 'alphabetic';
  g.fillText(text, align === 'left' || boxW <= 0 ? x : x + (align === 'center' ? boxW * 0.5 : boxW), y);
}

/** 整行居中（等价 `draw_string(..., (0, y), s, CENTER, w, ...)`）。 */
export function drawTextCentered(g: CanvasRenderingContext2D, text: string, w: number, y: number, sizePx: number, col: string): void {
  drawText(g, text, 0, y, sizePx, col, 'center', w);
}

/** 量的宽度。Godot 的 `Font.get_string_size(...).x`。 */
export function textW(g: CanvasRenderingContext2D, text: string, sizePx: number): number {
  setFont(g, sizePx);
  return g.measureText(text).width;
}

/**
 * 字形的 ascent。Godot 的 `Font.get_ascent(size)`。Canvas 侧的
 * `fontBoundingBoxAscent` 是同一件事；老浏览器没有这一项时退回 em 的 0.8 倍。
 *
 * **只有云那一屏真的用到**：提示行的落位要量"字形有没有探出行盒"，
 * 而 `draw_string` 的 position.y 是基线——量行盒量不出字形。
 */
export function textAscent(g: CanvasRenderingContext2D, sizePx: number): number {
  setFont(g, sizePx);
  const m = g.measureText('测Ag');
  return m.fontBoundingBoxAscent || sizePx * 0.8;
}

// ---------------------------------------------------------------- Shell

/**
 * 五个小游戏共用的上下文快照。
 *
 * 原作里这些是 `_draw()` 里的 `ThemeDB.fallback_font` + `Localization.t` + `size`，
 * Web 侧每帧都要伸手进 `MiniGameContext` 取三样东西太啰嗦，所以摊平成一层。
 * `w/h` 可变（resize 时原地改），其余只读。
 */
export interface Shell {
  readonly g: CanvasRenderingContext2D;
  w: number;
  h: number;
  readonly lang: Lang;
  readonly ink: string;
  readonly paper: string;
  readonly accent: string;
  readonly dim: string;
  readonly ok: string;
  readonly bad: string;
  readonly t: (key: string, vars?: Record<string, string | number>) => string;
}

export function makeShell(c: MiniGameContext): Shell {
  return {
    g: c.ctx,
    w: c.width,
    h: c.height,
    lang: c.lang,
    ink: c.palette.ink,
    paper: c.palette.paper,
    accent: c.palette.accent,
    dim: c.palette.dim,
    ok: c.palette.ok,
    bad: c.palette.bad,
    t: (key, vars) => c.t(key, vars),
  };
}

// ---------------------------------------------------------------- 景

/**
 * MiniGameBackdrop —— 五件乐事各自的"地方"。
 *
 * 原来五个小游戏都在一块 0.7 alpha 的黑幕上作画，于是「雨后台阶看云」「朋友来了
 * 先煮茶」「把风声听成琴音」全都长一个样：黑底 + 一个图形 + 一行字。
 * 这里给每件乐事一个**不透明**的景：天光渐变 + 两层远景 + 几样本地的东西。
 * 必须不透明 —— 底下若有 3D 世界透上来，那看着像没画完。
 *
 * 只画远景和底色，不画玩法元素：玩法元素还得压在最上面。
 *
 * 零分配：Godot 那边每个主题都要 `PackedVector2Array` 建几十个点，
 * 这里全部改成直接 `moveTo/lineTo/fill`，点数是常量而不是对象。
 */
const SKY = 4;

interface ThemeCfg {
  readonly top: Rgb;
  readonly bot: Rgb;
  readonly far: Rgb;
  readonly mid: Rgb;
  readonly farCol: string;
  readonly midCol: string;
  /** 茶：桌面压暗 0.10 */
  readonly midDark: string;
  /** 禽：湖面提亮 0.06 */
  readonly midLight: string;
  /** 琴：竹叶剪影用 */
  readonly midDark18: string;
  readonly midDark10: string;
}

function makeTheme(top: string, bot: string, far: string, mid: string): ThemeCfg {
  const t = hex(top);
  const b = hex(bot);
  const f = hex(far);
  const m = hex(mid);
  return {
    top: t, bot: b, far: f, mid: m,
    farCol: rgba(f),
    midCol: rgba(m),
    midDark: rgba(darkened(m, 0.1)),
    midLight: rgba(lightened(m, 0.06)),
    midDark18: rgba(darkened(m, 0.18)),
    midDark10: rgba(darkened(m, 0.1)),
  };
}

/** 主题下标。**只在这一份**里定义，别在五个小游戏里各写一个数字——
 *  顺序和碎片槽位 0..4 一致，改一处漏一处的话那一屏会静默画成另一件乐事的景。 */
export const THEME = {
  CLOUD: 0,   // 云影台
  TEA: 1,     // 茶烟小筑
  ZITHER: 2,  // 琴音林
  BAMBOO: 3,  // 竹雨庭
  BIRD: 4,    // 花房·禽语湖湾
} as const;
export type Theme = (typeof THEME)[keyof typeof THEME];

/** 顺序 0..4 与碎片顺序 云/茶/琴/竹/禽 一致。改这里之前先看 MiniGamePicker 的轮换表。 */
const THEMES: readonly ThemeCfg[] = [
  // 0 云 · 云影台：雨后初霁，高台上一片被洗过的淡蓝
  makeTheme('9FC3DC', 'E4EEF2', '7E9DAF', '5E7D8C'),
  // 1 茶 · 茶烟小筑：灶上的暖黄，屋里比屋外亮
  makeTheme('3B2C20', '6B4E33', '8A6540', '4A3626'),
  // 2 琴 · 琴音林：林子里的暮色，风把叶子翻过来是亮的
  makeTheme('2A3A33', '546B52', '3E5647', '26362C'),
  // 3 竹 · 竹雨庭：夜雨，湿的、发亮的
  makeTheme('141C1E', '2E3A38', '222D2C', '161E1F'),
  // 4 禽 · 花房·禽语湖湾：天刚亮，湖面比天暗
  makeTheme('5C7A93', 'D9C9AE', '7E94A3', '4E6069'),
];

export function drawBackdrop(g: CanvasRenderingContext2D, w: number, h: number, theme: Theme): void {
  const t = THEMES[theme];
  // 天光渐变
  g.fillStyle = '#000';
  for (let i = 0; i < SKY; i++) {
    const k0 = i / SKY;
    const k1 = (i + 1) / SKY;
    g.fillStyle = rgba(lerpRgb(t.top, t.bot, k0));
    g.fillRect(0, h * k0, w, h * (k1 - k0) + 1);
  }
  // 两层远景：远的一层更淡（空气透视），近的一层更沉
  horizon(g, w, h, h * 0.62, t.farCol);
  horizon(g, w, h, h * 0.74, t.midCol);
  switch (theme) {
    case 0: clouds(g, w, h); break;
    case 1: steamScene(g, w, h, t); break;
    case 2: grove(g, w, h, t); break;
    case 3: rain(g, w, h, t); break;
    case 4: water(g, w, h, t); break;
  }
}

/** 一层起伏的地面/山脊剪影。振幅和波长都随高度走，换分辨率不会变形。 */
function horizon(g: CanvasRenderingContext2D, w: number, h: number, baseY: number, col: string): void {
  const steps = 48;
  g.fillStyle = col;
  g.beginPath();
  g.moveTo(0, baseY + Math.sin(baseY * 0.01) * h * 0.022 + Math.sin(0) * h * 0.010);
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    g.lineTo(w * k, baseY + Math.sin(k * 7.0 + baseY * 0.01) * h * 0.022 + Math.sin(k * 19.0) * h * 0.010);
  }
  g.lineTo(w, h);
  g.lineTo(0, h);
  g.closePath();
  g.fill();
}

/**
 * 背景的五片云 —— 和云影台小游戏里那朵**要描的云**用的是同一套画法（三团圆叠），
 * 那是 MiniGameCloud 里 `CLOUD_CIRCLES` 那段注释的由来：轮廓由这五团圆算出来，
 * 所以"背景里的云"和"要描的云"必然是同一个东西。
 */
function clouds(g: CanvasRenderingContext2D, w: number, h: number): void {
  for (let i = 0; i < 5; i++) {
    const cx = w * (0.08 + 0.21 * i) + Math.sin(i * 2.1) * w * 0.04;
    const cy = h * (0.12 + 0.07 * (i % 3));
    const r = h * (0.045 + 0.02 * (i % 2));
    circle(g, cx, cy, r, 'rgba(255,255,255,0.42)');
    circle(g, cx + r * 0.9, cy + r * 0.18, r * 0.74, 'rgba(255,255,255,0.30)');
    circle(g, cx - r * 0.85, cy + r * 0.26, r * 0.62, 'rgba(255,255,255,0.26)');
  }
}

/** 屋里另外两处灶烟。**避开正中**：茶壶在 w*0.5，中间那道从壶后面笔直穿上去，
 *  图上会读成三道划痕而不是烟。 */
function steamScene(g: CanvasRenderingContext2D, w: number, h: number, t: ThemeCfg): void {
  for (let i = 0; i < 2; i++) {
    const bx = w * (i === 0 ? 0.17 : 0.83);
    g.strokeStyle = `rgba(255,240,214,${0.1 - 0.03 * i})`;
    g.lineWidth = 3;
    g.beginPath();
    for (let s = 0; s < 13; s++) {
      const k = s / 12;
      const x = bx + Math.sin(k * 4.0 + i * 2.0) * w * 0.028 * k;
      const y = h * 0.58 - k * h * 0.26;
      if (s === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  // 桌面：一条暖色的横带，把下半截压住
  g.fillStyle = t.midDark;
  g.fillRect(0, h * 0.8, w, h * 0.2);
}

/** 几竿竹叶的剪影，从下往上斜着插进画面。 */
function grove(g: CanvasRenderingContext2D, w: number, h: number, t: ThemeCfg): void {
  for (let i = 0; i < 4; i++) {
    const bx = w * (0.06 + 0.26 * i);
    const lean = w * (i % 2 === 0 ? 0.05 : -0.04);
    line(g, bx, h, bx + lean, h * 0.52, t.midDark18, 5);
    for (let n = 0; n < 3; n++) {
      const ky = h * (0.86 - 0.10 * n);
      // Godot 的 `lerpf(bx, bx + lean, 1.0 - ky / h)`：叶子从**根部**往上插，
      // 所以离地越远（ky 越小）越往梢那一侧取。
      const kx = bx + lean * (1 - ky / h);
      line(g, kx, ky, kx + lean * 0.7 * (n % 2 === 0 ? 1 : -1), ky - h * 0.03, t.midDark10, 3);
    }
  }
}

/** 雨：一批斜线，按 y 错开，看起来是下着的而不是贴上去的。位置只由 i 决定 ⇒ 静态。 */
function rain(g: CanvasRenderingContext2D, w: number, h: number, t: ThemeCfg): void {
  g.strokeStyle = 'rgba(184,204,209,0.16)';
  g.lineWidth = 1;
  g.beginPath();
  for (let i = 0; i < 46; i++) {
    const rx = (i * 97.3) % w;
    const ry = (i * 61.7) % h;
    const len = h * 0.035;
    g.moveTo(rx, ry);
    g.lineTo(rx - len * 0.22, ry + len);
  }
  g.stroke();
  // 湿地面上一道反光
  g.fillStyle = rgba(t.mid);
  g.fillRect(0, h * 0.86, w, h * 0.14);
}

/** 湖面：比天暗一档，几道横向的反光条。 */
function water(g: CanvasRenderingContext2D, w: number, h: number, t: ThemeCfg): void {
  g.fillStyle = t.midLight;
  g.fillRect(0, h * 0.7, w, h * 0.3);
  g.fillStyle = 'rgba(255,250,235,0.14)';
  for (let i = 0; i < 7; i++) {
    const ry = h * (0.73 + 0.035 * i);
    g.fillRect(w * (0.12 + 0.1 * (i % 4)), ry, w * (0.1 + 0.09 * (i % 3)), 2);
  }
}

// ---------------------------------------------------------------- 进度条

/**
 * 三个小游戏共用的进度条。
 *
 * 原来三处各画各的：云画一根"完成度"、茶画一根"按住多久"、竹连条都没有、
 * 只写了一行"进度 0/5"。三处**都把门槛写在了字里**（"到 75% 算过" /
 * "3 秒后完成" / "0/5"），而**没有一处把门槛画在条上**——玩家盯着一条
 * 填到头就赢的条，看不出自己还差多远，而那个差距正是这一屏的全部张力。
 *
 * 几何抽成常量/纯函数的原因不是整洁：操作提示行的落位要从**量出来的**
 * 图形下缘和条上沿之间那段空白里取，而那个 y 分数要是只写在画笔里，
 * 提示和条迟早各按各的走。
 */

/** 刻痕要露出条外——画在条里面时它就是"条上的一道纹"。 */
export const TICK_OVERHANG = 5;
/** 门槛下面那个数字的落位。第一版写死了宽度 28，而 16px 的「75%」实测要 32px 宽——
 *  那是**裁切宽度**，多出来的半个百分号被切掉，图上只剩「75」。定妆照看见的。 */
export const TICK_LABEL_W = 64;
export const TICK_LABEL_FONT = 16;
/** 标签顶相对**条底**的下移。必须大于 `TICK_OVERHANG`，否则刻痕的下半截
 *  从这串字里穿过去（第一版 20 差 1px，图上「75%」中间竖着一根金线）。 */
export const TICK_LABEL_DY = 28;
/** 格与格之间的缝，占整条宽度的几成。缝按宽度取而不是按像素：固定 6px 的缝
 *  在一条 700px 的条上是 0.9%、在一条 300px 的条上是 2%，窄屏上就糊成一片。 */
export const PIP_GAP_FRAC = 0.012;

/** `y_frac` / `w_frac` 按视口算，`hPx` 是像素——高度按视口取的话换个分辨率就跟着变形，
 *  而一根 22px 的条在 720p 和 1080p 上本来是同一种东西。写进 `out` 以免每帧新建。 */
export function barRectInto(out: Rect, w: number, h: number, yFrac: number, wFrac: number, hPx: number): void {
  const bw = w * wFrac;
  out.x = w * 0.5 - bw * 0.5;
  out.y = h * yFrac;
  out.w = bw;
  out.h = hPx;
}

/** 门槛那一道刻痕的横坐标。**从条自己算**：把这条算式抄到画笔那一侧、
 * 或者从"视口宽乘一个数"另算一份，抄的那份和画的那条迟早漂。 */
export function thresholdX(r: Rect, threshold: number): number {
  return r.x + r.w * Math.min(Math.max(threshold, 0), 1);
}

/** 刻痕的上下端。刻痕比条高 `TICK_OVERHANG * 2`，是"跨在条上"不是"画在条里"。 */
export function tickTop(r: Rect): number {
  return r.y - TICK_OVERHANG;
}
export function tickBottom(r: Rect): number {
  return r.y + r.h + TICK_OVERHANG;
}

/** 刻痕标签的左上角。门槛贴住条的某一头时标签会掉出条外，夹回条内——
 *  夹了就不再以刻痕为中心，所以判据钉的是"标签完整落在条内"。 */
export function tickLabelX(r: Rect, threshold: number): number {
  const x = thresholdX(r, threshold) - TICK_LABEL_W * 0.5;
  return Math.min(Math.max(x, r.x), r.x + r.w - TICK_LABEL_W);
}
export function tickLabelY(r: Rect): number {
  return r.y + r.h + TICK_LABEL_DY - TICK_LABEL_FONT;
}
export function tickLabelBottom(r: Rect): number {
  return tickLabelY(r) + TICK_LABEL_FONT + 6;
}

/** 条 + 填充 + 门槛刻痕。门槛那一段底色要**比别处亮一点**：
 *  玩家真正要读的不是"到门槛了没有"，而是"离门槛还有多远"，所以过了门槛
 *  的那一截得看得出是另一块料。 */
export function drawBar(
  g: CanvasRenderingContext2D,
  r: Rect,
  ratio: number,
  threshold: number,
  fillCol: string,
  trackCol: string,
  edgeCol: string,
  tickCol: string,
  trackLightCol: string,
): void {
  const t = Math.min(Math.max(threshold, 0), 1);
  if (t < 1) {
    BAR_TAIL.x = thresholdX(r, t);
    BAR_TAIL.y = r.y;
    BAR_TAIL.w = r.w * (1 - t);
    BAR_TAIL.h = r.h;
    fillRect(g, BAR_TAIL, trackLightCol);
  }
  fillRect(g, r, trackCol);
  // 填充不许盖过门槛刻痕那一根竖线，所以画完刻痕再收一次边
  const f = Math.min(Math.max(ratio, 0), 1);
  if (f > 0) {
    BAR_FILL.x = r.x;
    BAR_FILL.y = r.y;
    BAR_FILL.w = r.w * f;
    BAR_FILL.h = r.h;
    fillRect(g, BAR_FILL, fillCol);
  }
  strokeRect(g, r, edgeCol, 2);
  const tickX = thresholdX(r, t);
  line(g, tickX, tickTop(r), tickX, tickBottom(r), tickCol, 3);
}

/** drawBar 内部用的两个临时矩形（每帧复用，不新建）。 */
const BAR_TAIL: Rect = { x: 0, y: 0, w: 0, h: 0 };
const BAR_FILL: Rect = { x: 0, y: 0, w: 0, h: 0 };

export function pipGap(r: Rect, n: number): number {
  return n > 1 ? r.w * PIP_GAP_FRAC : 0;
}
export function pipWidth(r: Rect, n: number): number {
  if (n <= 0) return 0;
  return (r.w - pipGap(r, n) * (n - 1)) / n;
}
export function pipX(r: Rect, n: number, i: number): number {
  return r.x + i * (pipWidth(r, n) + pipGap(r, n));
}

/**
 * 一格一格的进度（竹：五根）。
 *
 * 分格而不是一根连续条：竹子的"进度"是**五件互相独立的事**，一根填到 60%
 * 的连续条读成"有一根被砍掉了 60%"，而实际是三根倒了、两根还立着——
 * 数量本身是这一屏的信息。
 */
export function drawPips(
  g: CanvasRenderingContext2D,
  r: Rect,
  n: number,
  filled: number,
  current: number,
  fillCol: string,
  emptyCol: string,
  edgeCol: string,
): void {
  const pw = pipWidth(r, n);
  for (let i = 0; i < n; i++) {
    const x = pipX(r, n, i);
    g.fillStyle = i < filled ? fillCol : emptyCol;
    g.fillRect(x, r.y, pw, r.h);
    // 当前那根描一道白边——进度只报"几根倒了"，不报"现在轮到哪一根"
    if (i === current) {
      g.strokeStyle = edgeCol;
      g.lineWidth = 3;
      g.strokeRect(x, r.y, pw, r.h);
    }
  }
}

// ---------------------------------------------------------------- 取消按钮

/**
 * 小游戏那一屏的「取消」按钮。云/茶/琴三处各画了一份，连禽都在点击处理里留了
 * 同一块矩形当点击热区、却**什么都没画**——于是那个角落是一块看得见、点得着、
 * 但读不出是什么的地方。现在五个小游戏都画它（Web 侧宿主还会再放一个真 DOM 按钮）。
 *
 * 竹是最后补上的，而它原来的缺席理由写着"左键在这一屏是砍，画个按钮还得判
 * 点击落在哪、怕误砍"——那条只解释了难做，没解释不做：ESC 在那一屏是隐藏的，
 * 于是鼠标玩家看见的是一个点哪都能砍、哪也退不出去的黑幕。误砍的代价是零
 * （1.2 秒窗口自己会过），而"点取消挨一刀"的代价不是——所以**热区判在
 * "当成砍"之前**。移植时这条顺序必须照抄。
 *
 * 颜色原来一律是 `fill (0.4,0.3,0.3)` + `border (0.8,0.3,0.3)`，即**警报红**。
 * 而「取消」在这一屏是最不费事的一个动作：ESC 也能按，取消之后驿站还能再来
 * 一次。全工程真正在报警的红是边界警告那圈和竹子那根砍伐窗口的倒计时——
 * 玩家学会「红 = 出事了」之后，再在角落里看见一块红，读出来的是
 * 「取消这件事有代价」，而它没有。所以这块按钮是**中性**的。
 *
 * 不透明是刻意的：五个小游戏的背景亮度差得远（云那屏的天是亮的、竹那屏的底
 * 是暗的），半透明底板算出来的对比度随背景漂，而"这个字在五屏上都读得出来"
 * 只有让底板自己说了算才立得住。
 */
export const CANCEL_W = 140;
export const CANCEL_H = 44;
/** 右边留 20、下边留 16——离屏边近但没贴着，贴边会被读成系统按钮。 */
export const CANCEL_MARGIN_X = 20;
export const CANCEL_MARGIN_Y = 16;

const CANCEL_FILL = 'rgb(51,48,46)';
const CANCEL_BORDER = 'rgb(148,140,128)';
const CANCEL_LABEL = 'rgb(240,235,219)';
const CANCEL_FONT = 22;
/** 基线离按钮**下沿**有多远（按按钮高度取）。`draw_string` 的 y 是**基线**、
 *  不是行盒顶，而基线往上走一个字身、往下留一点降部——所以"基线放在按钮高度的
 *  68%"是错的：22px 的字身会从按钮顶沿上面探出去，而一个只看控件尺寸的断言
 *  量不到这件事（框还在按钮里，探出去的是字形）。 */
const CANCEL_BASELINE_UP = 0.30;

/** 落位。纯函数：热区和画笔读同一个结果，不各抄一份 `Rect2(w-160, ...)`。 */
export function cancelRectInto(out: Rect, w: number, h: number): void {
  out.x = w - CANCEL_W - CANCEL_MARGIN_X;
  out.y = h - CANCEL_H - CANCEL_MARGIN_Y;
  out.w = CANCEL_W;
  out.h = CANCEL_H;
}

/** `Rect2.has_point`。Godot 的右/下沿是**开**区间，这里照抄。 */
export function pointInRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

export function drawCancel(g: CanvasRenderingContext2D, r: Rect, label: string): void {
  fillRect(g, r, CANCEL_FILL);
  strokeRect(g, r, CANCEL_BORDER, 2);
  // 基线：离下沿 30% 按钮高（往上就是"字身"，往下留 20% 给降部）
  drawText(g, label, r.x, r.y + r.h - r.h * CANCEL_BASELINE_UP, CANCEL_FONT, CANCEL_LABEL, 'center', r.w);
}

// ---------------------------------------------------------------- 文案缺口

/**
 * I18N（214 个 key，中英完全一致）里**缺**、而结算屏需要的 key。
 *
 * 这几个不属于本目录——五个小游戏自己在 Godot 版里也都不画结算屏，
 * 一律 `onDone()` 交回 World3D，Web 侧同样交给宿主。
 * 现有的 `mg_failed` / `mg_failed_hint` 只能当"失败屏"用，胜利屏没有对应文案。
 * 按约定不往 `src/data/raw.ts` 里加，列在这里给宿主补表时照单抓。
 */
export const MISSING_KEYS: readonly string[] = [
  'result_win',   // 成功屏标题/正文（现无对应 key）
  'result_lose',  // 失败屏；`mg_failed` 可替代，但语义上是屏级文案
  'result_retry', // 「再来一次」按钮
];
