/**
 * 琴音林 · **自由演奏**的古琴（三个八度）。
 *
 * ## 它不是第六件乐事
 *
 * `MINI_GAME_IDS` 仍然是云 / 茶 / 琴 / 竹 / 禽五件，轮换表一个字没动。
 * 这一屏是**琴音林多出来的一个交互**：不打分、不计时、不给旅币、
 * 弹错了不会有任何一句话说你弹错了——它只是**一张可以随便弹的琴**。
 * 所以它的结局只有 `cancel`（Esc 或点「离开」），而宿主那边
 * 走 `runFreePlay()`，**不进打卡、不扣旅币**。
 *
 * ## 为什么它值得做
 *
 * 序章给主角的本事是「东西坏了，我修，修之前我要先摸一遍」。
 * 五件旧物把"摸"做实了，而**琴音林这一站在原来的设计里是有名字的**
 * （三句旁白：「林子里没有舞台，风一经过，树影就开始合奏」）
 * ——可它上面的那件乐事是 Simon Says：一段背下来的四个音，
 * **和"林子里的风自己在合奏"是两件相反的事**。
 * 让人能在这儿自己弹一段，是把那三句旁白兑现了。
 *
 * ## 键位：三行 = 三个八度
 *
 * 键盘上相邻的三行正好是三个八度，而每一行七个键正好是一架琴的七根弦：
 *
 * ```
 *   高八度   1 2 3 4 5 6 7      ← 数字行
 *   中八度   Q W E R T Y U
 *   低八度   Z X C V B N M
 * ```
 *
 * 触屏则是 7×3 的格子，点哪根弦的哪个八度就响哪一下——
 * 两条通路走**同一个** `pluck()`，所以不存在"鼠标能弹某个音、键盘弹不到"这种事。
 */
import {
  cancelRectInto,
  circle,
  drawBackdrop,
  drawCancel,
  drawText,
  drawTextCentered,
  lightened,
  makeShell,
  pointInRect,
  rgba,
  THEME,
  tf,
  type Rect,
  type Rgb,
  type Shell,
} from './chrome';
import type { MiniGame, MiniGameContext, MiniGameResult } from './types';

// ---------------------------------------------------------------- 音列

/** 七根弦。三根弦 + 一个八度是古琴最常见的定弦，但这里**七个音一排**，
 *  是为了让「Z X C V B N M」正好占满键盘的一行——键位好记比音准在这个游戏里重要。 */
export const QIN_STRINGS = 7;
/** 三个八度。低 / 中 / 高。 */
export const QIN_OCTAVES = 3;
/** 总音数。`pluck()` 的入参上限，也是键位表与命中区表的长度。 */
export const QIN_NOTES = QIN_STRINGS * QIN_OCTAVES;

/**
 * 键位表。**三段，每段七个**，顺序是「低 → 中 → 高」，
 * 与 `note = octave * QIN_STRINGS + string` 的编号一致。
 *
 * 数字键同时收 `Numpad1..7`：笔记本没有小键盘，可外接键盘有，
 * 而这一屏的三个八度正好压在数字行上——不收小键盘等于外接键盘缺一整个八度。
 */
export const QIN_KEYS: readonly (readonly string[])[] = [
  ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM'],
  ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU'],
  ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7'],
];
/**
 * 小键盘。**只有高八度**（与数字行同一组音）。
 *
 * 三行键位里低/中两行用的是 `ZXCVBNM` 与 `QWERTYU`——小键盘没有对应的键，
 * 所以把 `Numpad1..7` 三行都填成同一串的话，`noteForKey()` 在第 0 个八度
 * 就把它认领走了，而**外接键盘上按小键盘弹出来的是低八度**——
 * 屏上写的是「高八度 1」，响的是最低那根弦，而判据里的键位表完全看不出来。
 * 所以这里是一维的：它只补高八度。
 */
export const QIN_KEYS_NUMPAD: readonly string[] = [
  'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5', 'Numpad6', 'Numpad7',
];

// ---------------------------------------------------------------- 几何

/** 音名不用画。这一屏的导航是键位 + 八度名，弦序靠左侧 1..7 读。 */

const BOARD_W_FRAC = 0.80;
const BOARD_W_MIN = 260;
/** 平板上收窄。理由与 `cloud.ts` 的 `AREA_MAX` 同源：手大够不着大屏的边角。 */
const BOARD_W_MAX = 620;
const BOARD_Y_FRAC = 0.26;
const BOARD_H_FRAC = 0.46;
/** 板底给操作提示留多少。 */
const BOARD_BOTTOM_FRAC = 0.15;

/**
 * 矮视口的分界（CSS 像素）。
 *
 * **横屏手机只有 390 高**，而七行 × 44px = 308px 是硬底线，
 * 再加标题（28px 字）与底下那行操作提示就放不下了。
 * 所以矮视口走另一套落位：标题压到 14%，板底几乎不留，
 * 而那行操作提示**挪到板子上面去**（`hintY`）——
 * 与其把七根弦压成七条 26px 的细缝，不如让提示换个位置。
 */
const SHORT_H = 520;

/** 弦两端往木头里收多少。琴码与雁柱钉在木面上，弦得压在木头里一点。 */
const STRING_INSET = 10.0;
/** 徽。古琴最有辨识度的一处——嵌在琴面里的一排螺钿小圆点。 */
const HUI_COUNT = 13;
const HUI_R = 5.0;

const COL_BODY: Rgb = [0x4a / 255, 0x35 / 255, 0x24 / 255];
const COL_BODY_EDGE: Rgb = [0x2a / 255, 0x1c / 255, 0x12 / 255];
const COL_GEAR: Rgb = [0x3a / 255, 0x28 / 255, 0x18 / 255];
const COL_PEG: Rgb = [0x9a / 255, 0x7a / 255, 0x52 / 255];
const COL_HUI: Rgb = [0xd8 / 255, 0xcd / 255, 0xa8 / 255];
const COL_HUI_IN: Rgb = [0x6b / 255, 0x55 / 255, 0x35 / 255];
const COL_HUI_S = rgba(COL_HUI, 0.95);
const COL_HUI_IN_S = rgba(COL_HUI_IN, 0.9);

/** 七根弦的固有色。低到高由暖转冷，**音高读起来是"往上走"**。 */
const NOTE_COLS: readonly Rgb[] = [
  [0xc9 / 255, 0xa2 / 255, 0x6b / 255],
  [0xd6 / 255, 0xb8 / 255, 0x86 / 255],
  [0xb6 / 255, 0xc2 / 255, 0x7c / 255],
  [0x8f / 255, 0xb3 / 255, 0x5a / 255],
  [0x7f / 255, 0xa6 / 255, 0x60 / 255],
  [0x6e / 255, 0x9c / 255, 0x6b / 255],
  [0x88 / 255, 0xb0 / 255, 0xa4 / 255],
];
const NOTE_COLS_S: readonly string[] = NOTE_COLS.map((c) => rgba(c));
const NOTE_COLS_LIT_S: readonly string[] = NOTE_COLS.map((c) => rgba(lightened(c, 0.2)));

const RING_DECAY = 2.2;
const RING_FREQ = 30.0;
const RING_SEGMENTS = 14;

/**
 * 一格的最小边长（本地像素）。44 是触屏可点尺寸的下限。
 *
 * 为什么必须钉：七根弦七行，横屏手机上可用高度只有 230px，
 * 平分下来每行 33px——**比手指细**。判据量的是"最常见的那几种尺寸下每格多少"，
 * 而不是"看起来匀不匀"。
 */
export const QIN_CELL_MIN = 44;

/**
 * 琴身的收分多边形顶点数。琴额宽、琴尾窄，左右各三个折点。
 *
 * **首尾不闭合**（和 `zither.ts` 的 `BODY_N` 同一约定）：左边那道竖边不描，
 * 它是琴面的"开口"方向——描上就成了一个盒子。
 */
const BODY_N = 7;

/** 琴身的收分多边形（琴额宽、琴尾窄）。和 `zither.ts` 同一套画法。 */
function bodyPolyInto(b: Float32Array, bx: number, by: number, bw: number, bh: number): void {
  const cy = by + bh * 0.5;
  const headH = bh * 0.5;
  const tailH = bh * 0.4;
  b[0] = bx; b[1] = cy - headH;
  b[2] = bx + bw * 0.5; b[3] = cy - tailH * 0.94;
  b[4] = bx + bw - bw * 0.07; b[5] = cy - tailH;
  b[6] = bx + bw; b[7] = cy + tailH;
  b[8] = bx + bw - bw * 0.07; b[9] = cy + tailH;
  b[10] = bx + bw * 0.5; b[11] = cy + tailH * 0.94;
  b[12] = bx; b[13] = cy + headH;
}

/**
 * 板子的落位。**导出来**：判据要量的是最常见的那几种尺寸下
 * 「每格多少像素」「板子有没有超出视口」，不是抄一遍这里的算式。
 *
 * 上下两端都按**可用带**算而不是按屏高乘系数：
 * 横屏手机只有 390 高，按屏高乘会把七根弦压成七条 26px 的细缝。
 */
export function boardRectInto(out: Rect, w: number, h: number): void {
  const short = h < SHORT_H;
  const top = short ? h * 0.14 : h * BOARD_Y_FRAC;
  const availH = Math.max(h - top - (short ? h * 0.03 : h * BOARD_BOTTOM_FRAC), 0);
  const bw = Math.min(Math.max(w * BOARD_W_FRAC, BOARD_W_MIN), BOARD_W_MAX);
  // 先按"每格 ≥ QIN_CELL_MIN"倒推需要的板高，放不下就取满可用高度
  const needH = QIN_CELL_MIN * QIN_STRINGS;
  const bh = Math.min(Math.max(h * BOARD_H_FRAC, needH), Math.max(availH, h * 0.28));
  out.w = bw;
  out.h = bh;
  out.x = (w - bw) * 0.5;
  out.y = top + Math.max(0, availH - bh) * 0.5;
}

/**
 * 那行操作提示落在哪、是不是右对齐。
 *
 * 矮视口上板子已经吃掉了几乎全部高度，所以提示**挪到板子上面**，
 * 压在标题那一行右侧——而不是压到弦上。
 * 返回的是**基线**（和 `cloud.ts` 的提示行同一口径）。
 *
 * 两件事放一个函数里返回，是因为它们**必须同时成立**：
 * 只挪位置不换对齐，提示会横穿标题；只换对齐不挪位置，它会压在弦上。
 * 分成两个函数就会出现"只改了一个"的中间态，而中间态图上很难认。
 */
export function qinHintLayout(h: number, boardTop: number): { y: number; right: boolean } {
  if (h >= SHORT_H) return { y: h * 0.9, right: false };
  return { y: Math.min(22, boardTop - 6), right: true };
}

/** 一格（弦 × 八度）的命中区。**几何，不碰画笔**——键盘/触屏/回归读的是同一份。 */
export function cellRectInto(out: Rect, board: Rect, note: number): void {
  const oct = Math.floor(note / QIN_STRINGS);
  const str = note % QIN_STRINGS;
  const colW = board.w / QIN_OCTAVES;
  const rowH = board.h / QIN_STRINGS;
  out.x = board.x + colW * oct;
  out.y = board.y + rowH * str;
  out.w = colW;
  out.h = rowH;
}

/** 键位 → 音号。找不到返回 -1。纯函数，回归直接枚举全键盘验一遍。 */
export function noteForKey(key: string): number {
  for (let o = 0; o < QIN_OCTAVES; o++) {
    const i = QIN_KEYS[o].indexOf(key);
    if (i >= 0) return o * QIN_STRINGS + i;
  }
  // 小键盘只接高八度（理由见 `QIN_KEYS_NUMPAD`）。
  const j = QIN_KEYS_NUMPAD.indexOf(key);
  if (j >= 0) return (QIN_OCTAVES - 1) * QIN_STRINGS + j;
  return -1;
}

// ---------------------------------------------------------------- 本体

class QinGame implements MiniGame {
  readonly id = 'qin' as const;

  private readonly c: MiniGameContext;
  private readonly sh: Shell;
  private finished = false;

  /** 每个音的振动能量。21 个，和 `QIN_NOTES` 同长。 */
  private readonly ring = new Float32Array(QIN_NOTES);
  private ringT = 0;
  /** 最近一次弹的是哪一个。-1 = 还没弹过。 */
  private lastNote = -1;

  private readonly board: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private readonly body = new Float32Array(BODY_N * 2);
  private readonly cells: Rect[] = Array.from({ length: QIN_NOTES }, () => ({ x: 0, y: 0, w: 0, h: 0 }));
  private readonly cancelBtn: Rect = { x: 0, y: 0, w: 0, h: 0 };

  constructor(ctx: MiniGameContext) {
    this.c = ctx;
    this.sh = makeShell(ctx);
    // 压低环境音：弹琴的时候那句「林子里没有舞台」的底噪不该盖过琴。
    ctx.audio.duckAmbient(true);
    this.layout(ctx.width, ctx.height);
  }

  private layout(w: number, h: number): void {
    this.sh.w = w;
    this.sh.h = h;
    boardRectInto(this.board, w, h);
    bodyPolyInto(this.body, this.board.x, this.board.y, this.board.w, this.board.h);
    for (let n = 0; n < QIN_NOTES; n++) cellRectInto(this.cells[n], this.board, n);
    cancelRectInto(this.cancelBtn, w, h);
    if (h < SHORT_H) Object.assign(this.cancelBtn, { x: w - 98, y: 4, w: 88, h: 44 });
  }

  private finish(r: MiniGameResult): void {
    if (this.finished) return;
    this.finished = true;
    this.c.audio.duckAmbient(false);
    this.c.onDone(r);
  }

  /**
   * 弹一下。**键盘与触屏唯一的汇合点**。
   *
   * 音在"手指落弦"这一刻就出，不等任何判定——自由演奏没有判定，
   * 而延迟半拍的回响会让人以为是自己没点到。
   */
  private pluck(note: number): void {
    if (note < 0 || note >= QIN_NOTES) return;
    this.ring[note] = 1;
    this.lastNote = note;
    if (this.c.audio.noteFree) this.c.audio.noteFree(note);
    else this.c.audio.note(note % 4);
  }

  // ------------------------------------------------------------ 输入

  onKeyDown(key: string, _shift: boolean): boolean {
    if (this.finished) return false;
    if (key === 'Escape') { this.finish('cancel'); return true; }
    const n = noteForKey(key);
    if (n < 0) return false;
    this.pluck(n);
    return true;
  }

  onKeyUp(_key: string): boolean {
    // 古琴是一拨即响，不按住。
    return false;
  }

  onPointerDown(x: number, y: number): void {
    if (this.finished) return;
    if (pointInRect(this.cancelBtn, x, y)) { this.finish('cancel'); return; }
    for (let n = 0; n < QIN_NOTES; n++) {
      if (pointInRect(this.cells[n], x, y)) { this.pluck(n); return; }
    }
  }

  onPointerMove(_x: number, _y: number): void {
    // 拨弦是"敲一下"，不是拖动。拖着划过七个音会响成一串机关枪。
  }

  onPointerUp(_x: number, _y: number): void {
    // 同上。
  }

  cancel(): boolean {
    if (this.finished) return true;
    this.finish('cancel');
    return true;
  }

  step(dt: number): void {
    this.ringT += dt;
    for (let n = 0; n < QIN_NOTES; n++) {
      this.ring[n] = Math.max(0, this.ring[n] - dt * RING_DECAY);
    }
  }

  resize(w: number, h: number): void {
    this.layout(w, h);
  }

  dispose(): void {
    this.finished = true;
    this.c.audio.duckAmbient(false);
  }

  // ------------------------------------------------------------ 绘制

  draw(): void {
    const g = this.sh.g;
    const w = this.sh.w;
    const h = this.sh.h;
    const b = this.board;

    drawBackdrop(g, w, h, THEME.ZITHER);
    if (h < SHORT_H) drawText(g, tf(this.sh, 'qin_title'), 18, 22, 18, this.sh.paper);
    else drawTextCentered(g, tf(this.sh, 'qin_title'), w, h * 0.1, 28, this.sh.paper);

    // 琴面
    g.fillStyle = rgba(COL_BODY);
    g.beginPath();
    g.moveTo(this.body[0], this.body[1]);
    for (let i = 1; i < BODY_N; i++) g.lineTo(this.body[i * 2], this.body[i * 2 + 1]);
    g.closePath();
    g.fill();
    g.strokeStyle = rgba(COL_BODY_EDGE);
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(this.body[0], this.body[1]);
    for (let i = 1; i < BODY_N; i++) g.lineTo(this.body[i * 2], this.body[i * 2 + 1]);
    g.stroke();

    const cy = b.y + b.h * 0.5;
    const headH = b.h * 0.5;

    // 岳山 + 琴轸（琴额那头）
    const hx = b.x + b.h * 0.1;
    g.fillStyle = rgba(COL_GEAR);
    g.beginPath();
    g.moveTo(hx - headH * 0.2, cy - headH * 0.6);
    g.lineTo(hx, cy - headH * 0.46);
    g.lineTo(hx, cy + headH * 0.46);
    g.lineTo(hx - headH * 0.2, cy + headH * 0.6);
    g.closePath();
    g.fill();
    g.fillStyle = rgba(COL_PEG);
    g.fillRect(b.x + 0.05 * headH, cy - headH * 0.42, 20, 5);
    g.fillRect(b.x + 0.05 * headH, cy + headH * 0.42 - 5, 20, 5);

    // 雁足挂在琴尾底下
    const footX = b.x + b.w * 0.86;
    const drop = b.h * 0.1;
    g.fillStyle = rgba(COL_GEAR);
    for (let k = 0; k < 2; k++) {
      const sgn = k === 0 ? -1 : 1;
      g.beginPath();
      g.moveTo(footX, cy + b.h * 0.4);
      g.lineTo(footX + sgn * drop * 0.5, cy + b.h * 0.4 + drop);
      g.lineTo(footX + sgn * drop * 1.0, cy + b.h * 0.4 + drop * 0.8);
      g.closePath();
      g.fill();
    }

    // 徽：钉在两条弦中间那条线上
    for (let i = 0; i < HUI_COUNT; i++) {
      const f = 0.12 + (0.88 - 0.12) * (i / (HUI_COUNT - 1));
      const hp = b.x + b.w * f;
      circle(g, hp, cy, HUI_R, COL_HUI_S);
      circle(g, hp, cy, HUI_R * 0.42, COL_HUI_IN_S);
    }

    // 三个八度的分界。徽落在弦**中间**那一行上，八度线要**穿过整块板子**——
    // 不然玩家读不出"这根弦被分成了三段"，于是七个格子像七个孤立的按钮。
    g.strokeStyle = 'rgba(216,205,168,0.28)';
    g.lineWidth = 1.5;
    for (let o = 1; o < QIN_OCTAVES; o++) {
      const x = b.x + (b.w / QIN_OCTAVES) * o;
      g.beginPath();
      g.moveTo(x, b.y + b.h * 0.04);
      g.lineTo(x, b.y + b.h * 0.96);
      g.stroke();
    }

    // 七根弦。每一根横贯整块板子，**三个八度分别是它的一段**——
    // 所以这屏读出来是"一张琴"，而不是"21 个按钮"。
    const rowH = b.h / QIN_STRINGS;
    const amp = rowH * 0.22;
    for (let s = 0; s < QIN_STRINGS; s++) {
      const sy = b.y + rowH * (s + 0.5);
      const lit = this.lastNote >= 0 && this.lastNote % QIN_STRINGS === s;
      const x0 = b.x + STRING_INSET;
      const x1 = b.x + b.w - STRING_INSET;
      g.strokeStyle = lit ? NOTE_COLS_LIT_S[s] : NOTE_COLS_S[s];
      g.lineWidth = lit ? 2.4 : 1.5;
      g.beginPath();
      g.moveTo(x0, sy);
      g.lineTo(x1, sy);
      g.stroke();
      // 弦两端的琴码与雁柱
      g.fillStyle = rgba(COL_PEG);
      g.fillRect(x0 - 11, sy - 6, 7, 12);
      g.fillRect(x1 + 4, sy - 5, 6, 10);
    }

    // 每一格里那一段弦的驻波 + 亮光。**先画静止的那一段**，
    // 再画振动的那一段——反过来的话静止段会盖掉正在响的那一段。
    for (let n = 0; n < QIN_NOTES; n++) {
      const e = this.ring[n];
      const r = this.cells[n];
      const x0 = r.x + STRING_INSET;
      const x1 = r.x + r.w - STRING_INSET;
      if (x1 <= x0) continue;
      const s = n % QIN_STRINGS;
      const col = NOTE_COLS[s];
      if (e > 0.02) {
        g.strokeStyle = rgba(lightened(col, 0.25 * e), 0.35 + 0.65 * e);
        g.lineWidth = 2.6;
        g.beginPath();
        for (let k = 0; k <= RING_SEGMENTS; k++) {
          const u = k / RING_SEGMENTS;
          const x = x0 + (x1 - x0) * u;
          const y = r.y + r.h * 0.5 + e * amp * Math.sin(this.ringT * RING_FREQ + u * 2.4) * Math.sin(Math.PI * u);
          if (k === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
        // 弦心的光点：余光能捕捉到"哪儿刚响过"
        circle(g, (x0 + x1) * 0.5, r.y + r.h * 0.5, (4 + 5 * e), rgba(lightened(col, 0.4), 0.3 + 0.5 * e));
      }
    }

    // 弦名 + 八度名。**这一屏没有进度**，所以唯一的导航是"我现在在哪儿"：
    // 八度名压在板子正上方，键名压在每一格的右上角。
    for (let o = 0; o < QIN_OCTAVES; o++) {
      const c = this.cells[o * QIN_STRINGS];
      drawText(g, tf(this.sh, `qin_oct_${o}`), c.x, b.y - (h < SHORT_H ? 6 : 26), h < SHORT_H ? 15 : 20, this.sh.paper, 'center', c.w);
    }
    const rowH2 = b.h / QIN_STRINGS;
    for (let o = 0; o < QIN_OCTAVES; o++) {
      for (let s = 0; s < QIN_STRINGS; s++) {
        const n = o * QIN_STRINGS + s;
        const r = this.cells[n];
        drawText(g, QIN_KEYS[o][s].replace(/^Key|^Digit/, ''),
          r.x, r.y + rowH2 * 0.34, 18, 'rgba(217,199,158,0.9)', 'right', r.w - 14);
      }
    }
    for (let s = 0; s < QIN_STRINGS; s++) {
      drawText(g, String(s + 1), 0, b.y + rowH2 * (s + 0.5) + 7, 20, 'rgba(217,199,158,0.85)', 'right', b.x - 14);
    }

    // 操作提示 + 离开。**这一屏没有倒计时、没有进度条**，
    // 而提示必须说清"弹多久都行、弹错了也没事"——
    // 否则自由演奏会被当成又一局有输赢的乐事。
    const hint = qinHintLayout(h, b.y);
    if (hint.right) {
      // 矮视口：提示挪到标题那一行右侧，免得压到弦上
      drawText(g, tf(this.sh, 'qin_touch_hint'), 220, hint.y, 12, this.sh.paper, 'right', Math.max(1, w - 340));
    } else {
      drawTextCentered(g, tf(this.sh, 'qin_hint'), w, hint.y, 20, this.sh.dim);
    }
    drawCancel(g, this.cancelBtn, tf(this.sh, 'qin_leave'));
  }
}

export function createQinGame(ctx: MiniGameContext): MiniGame {
  return new QinGame(ctx);
}
