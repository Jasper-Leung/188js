/**
 * 琴音林(13) 小游戏：Simon Says 记忆音符序列。
 *
 * 键盘通路（必须完整可玩，鼠标只是加速）：**1 / 2 / 3 / 4** 拨四根弦，ESC 取消。
 * 弹错音或 2.5 秒没弹 → 'lose'；照着弹完 → 'win'；Esc → 'cancel'。
 *
 * 原作把"失败"和"取消"都报成 CANCELLED。Web 侧必须分开：`cancel` 只留给玩家
 * 主动按 Esc（约定如此），玩法上的失败一律 'lose'，否则驿站的奖励/重玩判定
 * 没法区分"我放弃了"和"我弹错了"。
 */
import { makeRng } from '../../core/noise';
import {
  cancelRectInto,
  drawBackdrop,
  drawCancel,
  drawText,
  drawTextCentered,
  lightened,
  makeShell,
  rgba,
  pointInRect,
  circle,
  THEME,
  tf,
  type Rect,
  type Rgb,
  type Shell,
} from './chrome';
import type { MiniGame, MiniGameContext, MiniGameResult } from './types';

const SEQUENCE_LEN = 4;
const NOTE_COUNT = 4;
/** 每个音亮多久。 */
const SHOW_DELAY = 0.7;
/** 示范阶段两声之间的空档。原来这个 0.2 是散在协程末尾的一个字面量。 */
const SHOW_GAP = 0.2;
const INPUT_TIMEOUT = 2.5;
/** 首次显示延迟（`_ready` 里那个 0.5）。 */
const FIRST_DELAY = 0.5;

/** 弦的振动。四个音符原来只是四块纯色方块加数字——玩家看到的是"按 2"，
 *  不是"拨第二根弦"。这里给每根弦一份能量：拨下去瞬间置 1，每帧衰减，
 *  draw 把弦画成一条两端固定的驻波。示范阶段和玩家输入都会亮，同一根弦因此
 *  同时承担"现在该按谁"和"这是一件乐器"两件事。 */
const RING_DECAY = 2.6;
const RING_FREQ = 34.0;
const RING_SEGMENTS = 18;

/** 古琴身上那 13 个"徽"。它们是嵌在琴面里的螺钿小圆点，从琴额那头的岳山一路
 *  排向琴尾的雁足，标的是泛音的位置——**古琴最有辨识度的一处**。
 *
 * 原来这具琴身只有一块收分的木色多边形加四根弦，屏上又没有一处字提到"琴"
 * （标题是「记住音符顺序并重复」），于是这一屏读出来的是"一块有四根线的板子"。
 * 徽位、岳山、雁足三样一起摆上，那块板子才真的是一张琴。 */
const HUI_COUNT = 13;
const HUI_R = 6.0;
/** 徽只排在岳山与雁足之间，不铺满全长 */
const HUI_FROM = 0.16;
const HUI_TO = 0.88;

/** 弦两端往木头里收多少。琴码和雁柱是钉在木面上的，弦得压在木头里一点。 */
const STRING_INSET = 14.0;
/** 琴长上几成处挂雁足。古琴的雁足在琴尾那一段，挂在琴腹底下。 */
const FOOT_X_FRAC = 0.86;

const BOARD_X_FRAC = 0.10;
const BOARD_Y_FRAC = 0.24;
const BOARD_W_FRAC = 0.80;
const BOARD_H_FRAC = 0.40;

const COL_BODY: Rgb = [0x4a / 255, 0x35 / 255, 0x24 / 255];
const COL_BODY_EDGE: Rgb = [0x2a / 255, 0x1c / 255, 0x12 / 255];
const COL_GEAR: Rgb = [0x3a / 255, 0x28 / 255, 0x18 / 255];
const COL_PEG: Rgb = [0x9a / 255, 0x7a / 255, 0x52 / 255];
const COL_BRIDGE: Rgb = [0x8a / 255, 0x6a / 255, 0x4a / 255];
const COL_HUI: Rgb = [0xd8 / 255, 0xcd / 255, 0xa8 / 255];
const COL_HUI_IN: Rgb = [0x6b / 255, 0x55 / 255, 0x35 / 255];
const COL_HUI_S = rgba(COL_HUI, 0.95);
const COL_HUI_IN_S = rgba(COL_HUI_IN, 0.9);

/** 四根弦的固有色。 */
const NOTE_COLS: readonly Rgb[] = [
  [0xc9 / 255, 0xa2 / 255, 0x6b / 255],
  [0x8f / 255, 0xb3 / 255, 0x5a / 255],
  [0x6e / 255, 0x9c / 255, 0x6b / 255],
  [0xb0 / 255, 0xc4 / 255, 0xde / 255],
];
const NOTE_COLS_S: readonly string[] = NOTE_COLS.map((c) => rgba(c));
const NOTE_COLS_LIT_S: readonly string[] = NOTE_COLS.map((c) => rgba(lightened(c, 0.15)));

/** 键盘选第 i 根弦。Godot 版是 KEY_1..KEY_4。 */
const NOTE_KEYS: readonly string[] = ['Digit1', 'Digit2', 'Digit3', 'Digit4'];
const NOTE_KEYS_ALT: readonly string[] = ['Numpad1', 'Numpad2', 'Numpad3', 'Numpad4'];

// ---------------------------------------------------------------- 状态

const ST_SHOW = 0;
const ST_INPUT = 1;

// ---------------------------------------------------------------- 琴身几何

const BODY_N = 6;

/**
 * 琴身的收分多边形。`head_h` / `tail_h` / 收分的起点是琴身、弦、雁足三样共用的
 * 尺寸。琴额（左）宽，琴尾（右）窄——照古琴的样子收分。
 *
 * 直接写 12 个数，不建中间数组：这条路径虽然只在 resize 时走，但它是"琴"的
 * 唯一定义处，读的人要能一眼对上图。
 */
function bodyPolyInto(b: Float32Array, bx: number, by: number, bw: number, bh: number): void {
  const cy = by + bh * 0.5;
  const headH = bh * 0.5;
  const tailH = bh * 0.34;
  b[0] = bx;                 b[1] = cy - headH;
  b[2] = bx + bw - bw * 0.1; b[3] = cy - tailH;
  b[4] = bx + bw;            b[5] = cy - tailH * 0.72;
  b[6] = bx + bw;            b[7] = cy + tailH * 0.72;
  b[8] = bx + bw - bw * 0.1; b[9] = cy + tailH;
  b[10] = bx;                b[11] = cy + headH;
}

/**
 * 琴身在某一行的左右沿。**纯几何，不碰画笔**。
 *
 * 四根弦原来按 `board` 的**全宽**画，而琴身是内收的多边形——于是在靠外的那两根
 * 弦上，弦从 `x ≈ 0.70·W` 之后就在木头外面了，那一段连同它两端的琴码和雁柱
 * 一起悬在半空，屏上读出来是"四条线加四个悬空的小方块"。
 * 判据钉的是这个函数量出来的**那一行的实际左右沿**。
 */
function bodySpanAt(b: Float32Array, y: number, out: Float32Array): boolean {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < BODY_N; i++) {
    const ax = b[i * 2], ay = b[i * 2 + 1];
    const j = (i + 1) % BODY_N;
    const bx = b[j * 2], by = b[j * 2 + 1];
    if (ay === by) {
      // 水平边：这一行若正落在它上面，两端都算进沿
      if (Math.abs(y - ay) <= 0.5) {
        lo = Math.min(lo, ax, bx);
        hi = Math.max(hi, ax, bx);
      }
      continue;
    }
    if (y >= Math.min(ay, by) && y <= Math.max(ay, by)) {
      const x = ax + (bx - ax) * ((y - ay) / (by - ay));
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
  }
  if (hi < lo) return false;
  out[0] = lo;
  out[1] = hi;
  return true;
}

/**
 * 琴身在某一列的上下沿。`bodySpanAt` 的横向版本——雁足要挂在"某个 x 处的肚子
 * 底下"，而那个下沿只能横着求。
 *
 * 缺了它就会写出拿横向跨度当竖直落差的那种代码：第一版 `foot_anchor` 返回
 * `(span.y - 44, center.y)`，拿**右沿的 x** 减 44 当锚点、再用同一行的右沿减
 * 锚点 y 当"脚该垂多低"，于是 drop 算出来 590px——琴腹底下挂了两只各半米长的脚。
 */
function bodyVSpanAt(b: Float32Array, x: number, out: Float32Array): boolean {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < BODY_N; i++) {
    const ax = b[i * 2], ay = b[i * 2 + 1];
    const j = (i + 1) % BODY_N;
    const bx = b[j * 2], by = b[j * 2 + 1];
    if (ax === bx) {
      if (Math.abs(x - ax) <= 0.5) {
        lo = Math.min(lo, ay, by);
        hi = Math.max(hi, ay, by);
      }
      continue;
    }
    if (x >= Math.min(ax, bx) && x <= Math.max(ax, bx)) {
      const y = ay + (by - ay) * ((x - ax) / (bx - ax));
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
  }
  if (hi < lo) return false;
  out[0] = lo;
  out[1] = hi;
  return true;
}

/** 岳山与琴轸的落点。**和 draw 同源**——判据量的是画笔真的摆的那一处。
 * 锚点给琴额**内侧**：headgear 的背面从锚点往左退 0.22·head_h，锚点摆在 hx0 的话
 * 那道棱就整条戳在琴身之外（原来那块黑板就是这么冒出来的）。 */
function headAnchorX(board: Rect): number {
  return board.x + board.h * 0.12;
}

// ---------------------------------------------------------------- 本体

class ZitherGame implements MiniGame {
  readonly id = 'zither' as const;

  private readonly c: MiniGameContext;
  private readonly sh: Shell;
  private finished = false;

  private state = ST_SHOW;
  private readonly seq = new Int32Array(SEQUENCE_LEN);
  private playerLen = 0;
  private seqIndex = 0;
  private showTimer = FIRST_DELAY;
  private inputTimer = 0;
  private activeNote = -1;
  private readonly ring = new Float32Array(NOTE_COUNT);
  private ringT = 0;

  private readonly board: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private readonly body = new Float32Array(BODY_N * 2);
  /** 四根弦的命中区。**只算几何，不碰画笔**，所以键盘/鼠标/回归读的是同一份。 */
  private readonly stringRects: Rect[] = [0, 1, 2, 3].map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  private readonly cancelBtn: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private readonly spanTmp = new Float32Array(2);
  private readonly vspanTmp = new Float32Array(2);

  constructor(ctx: MiniGameContext) {
    this.c = ctx;
    this.sh = makeShell(ctx);
    ctx.audio.duckAmbient(true);
    // 序列随机。原来是 `randi() % NOTE_COUNT`；现在走 seed 驱动的 mulberry32：
    // 同一个驿站第几次到访 → 固定 seed → 同一局序列可复现（奖励判定要靠它）。
    const rng = makeRng(ctx.seed ^ 0x1a2b3c);
    for (let i = 0; i < SEQUENCE_LEN; i++) this.seq[i] = Math.floor(rng() * NOTE_COUNT) % NOTE_COUNT;
    this.layout(ctx.width, ctx.height);
  }

  private layout(w: number, h: number): void {
    this.sh.w = w;
    this.sh.h = h;
    this.board.x = w * BOARD_X_FRAC;
    this.board.y = h * BOARD_Y_FRAC;
    this.board.w = w * BOARD_W_FRAC;
    this.board.h = h * BOARD_H_FRAC;
    bodyPolyInto(this.body, this.board.x, this.board.y, this.board.w, this.board.h);
    // 命中区是整根弦所在的一条横带，比弦本身粗，玩家不必瞄准细线。
    const rowH = this.board.h / NOTE_COUNT;
    for (let i = 0; i < NOTE_COUNT; i++) {
      const sy = this.board.y + rowH * (i + 0.5);
      this.stringRects[i].x = this.board.x;
      this.stringRects[i].y = sy - rowH * 0.5;
      this.stringRects[i].w = this.board.w;
      this.stringRects[i].h = rowH;
    }
    cancelRectInto(this.cancelBtn, w, h);
  }

  private finish(r: MiniGameResult): void {
    if (this.finished) return;
    this.finished = true;
    this.c.audio.duckAmbient(false);
    this.c.onDone(r);
  }

  /**
   * 示范阶段只有这一个时钟。
   *
   * 原来这里是两套：`_show_next_note()` 既设了计时器，又 `await` 一个 0.7s 的
   * 定时器然后自己把灯灭掉、`_seq_index += 1`——而 `_process` 那边还在每帧把
   * 同一个计时器往下减，减到 0 就再调一次。两套时钟抢同一个 `_seq_index`。
   * 本机 280+ FPS 下协程稳定抢先，量出来是干净的 0.7s 节拍，所以**看不出问题**；
   * 帧率一低（低配核显笔记本正是这个场景）就可能两边同时到，于是同一个音播两遍、
   * `_seq_index` 一次跳两格——玩家听到的序列和屏上写的「第 n/4 个」对不上，照着弹
   * 必然错。这类"只在本机不复现"的竞态，改法是消灭竞态而不是加延时。
   */
  private advanceShow(): void {
    if (this.activeNote >= 0) {
      // 刚才那声弹完了：灭灯、记进度，再留一小段空档
      this.activeNote = -1;
      this.seqIndex++;
      this.showTimer = SHOW_GAP;
      return;
    }
    if (this.seqIndex >= SEQUENCE_LEN) {
      this.state = ST_INPUT;
      this.inputTimer = INPUT_TIMEOUT;
      return;
    }
    this.activeNote = this.seq[this.seqIndex];
    this.ring[this.activeNote] = 1;
    // 示范阶段这声比玩家敲的那几声更关键：整个小游戏就是"先听一段、再照着弹"，
    // 静音的时候玩家只能死盯高亮的那一格记住顺序。
    this.c.audio.note(this.activeNote);
    this.showTimer = SHOW_DELAY;
  }

  private hit(keyIdx: number): void {
    this.playerLen++;
    this.inputTimer = INPUT_TIMEOUT;
    this.ring[keyIdx] = 1;
    // 音在"敲下去"这一刻就出，不等对错判定——弹错音的反馈本来就该和手指落弦
    // 同时发生，等判完再响会慢半拍。
    this.c.audio.note(keyIdx);

    if (this.seq[this.playerLen - 1] !== keyIdx) { this.finish('lose'); return; }
    if (this.playerLen >= SEQUENCE_LEN) this.finish('win');
  }

  // ------------------------------------------------------------ 输入

  onKeyDown(key: string, _shift: boolean): boolean {
    if (this.finished) return false;
    // ESC 取消。取消按钮在 Godot 版里是 `_draw()` 画的假按钮，键盘点不到——不接 ESC
    // 的话键盘玩家在示范阶段完全出不去，只能看着它自己走完。
    if (key === 'Escape') { this.finish('cancel'); return true; }
    if (this.state !== ST_INPUT) return false;
    for (let i = 0; i < NOTE_COUNT; i++) {
      if (key === NOTE_KEYS[i] || key === NOTE_KEYS_ALT[i]) { this.hit(i); return true; }
    }
    return false;
  }

  onKeyUp(_key: string): boolean {
    return false;
  }

  onPointerDown(x: number, y: number): void {
    if (this.finished) return;
    // 取消按钮。热区走画笔那一处，见 chrome.ts 取消按钮那段注释
    if (pointInRect(this.cancelBtn, x, y)) { this.finish('cancel'); return; }
    if (this.state !== ST_INPUT) return;
    for (let i = 0; i < NOTE_COUNT; i++) {
      if (pointInRect(this.stringRects[i], x, y)) { this.hit(i); return; }
    }
  }

  onPointerMove(_x: number, _y: number): void {
    // 拨弦是"敲一下"，不是拖动。
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
    for (let i = 0; i < NOTE_COUNT; i++) {
      this.ring[i] = Math.max(0, this.ring[i] - dt * RING_DECAY);
    }
    if (this.finished) return;
    if (this.state === ST_SHOW) {
      this.showTimer -= dt;
      if (this.showTimer <= 0) this.advanceShow();
    } else {
      this.inputTimer -= dt;
      // 超时未输入 → 失败
      if (this.inputTimer <= 0) this.finish('lose');
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
    drawTextCentered(g, tf(this.sh, 'mg_zither_title'), w, h * 0.1, 28, this.sh.paper);

    // 琴面。原版是四块并排的纯色方块 + 数字，玩家读到的是"按 2"，不是"拨第二根弦"。
    // 这里给一块木色琴面 + 四根并排的弦。
    // 弦必须**顺着琴身的长边**走。古琴的弦平行于长轴，玩家是横着拨的；旧版把四根弦
    // 竖着插在一条又宽又短的琴身上，等于让玩家去拨一块 2.4m 宽的板子的短边——
    // 那不是琴，而且木面的宽高比和"琴"正好相反。
    const cy = b.y + b.h * 0.5;
    const headH = b.h * 0.5;
    g.fillStyle = rgba(COL_BODY);
    g.beginPath();
    g.moveTo(this.body[0], this.body[1]);
    for (let i = 1; i < BODY_N; i++) g.lineTo(this.body[i * 2], this.body[i * 2 + 1]);
    g.closePath();
    g.fill();
    // 描边是 `draw_polyline`：**不闭合**，左边那道（顶点 5 → 顶点 0）不描。
    g.strokeStyle = rgba(COL_BODY_EDGE);
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(this.body[0], this.body[1]);
    for (let i = 1; i < BODY_N; i++) g.lineTo(this.body[i * 2], this.body[i * 2 + 1]);
    g.stroke();

    // 琴身的三样附件：岳山+琴轸在琴额那头，雁足在琴尾，13 个徽排在当中。
    // 徽要压在弦**下面**一层（它们嵌在木面里），所以画在弦之前。
    const hx0 = b.x;
    const hx1 = b.x + b.w;
    // 岳山：背面从锚点往左退 0.22·head_h，所以整道棱压在琴面里。
    const ha = headAnchorX(b);
    g.fillStyle = rgba(COL_GEAR);
    g.beginPath();
    g.moveTo(ha - headH * 0.22, cy - headH * 0.58);
    g.lineTo(ha, cy - headH * 0.44);
    g.lineTo(ha, cy + headH * 0.44);
    g.lineTo(ha - headH * 0.22, cy + headH * 0.58);
    g.closePath();
    g.fill();
    // 琴轸：岳山两侧各一枚
    g.fillStyle = rgba(COL_PEG);
    g.fillRect(hx0 + 0.06 * headH, cy - headH * 0.4, 22, 5);
    g.fillRect(hx0 + 0.06 * headH, cy + headH * 0.4 - 5, 22, 5);
    // 雁足挂在**量出来的**琴腹下沿之下。原来写死 `tail_h * 0.55`，那是木头里面，
    // 两只脚整只被琴身盖住——画了，等于没画。
    const footX = b.x + b.w * FOOT_X_FRAC;
    if (bodyVSpanAt(this.body, footX, this.vspanTmp)) {
      const fy = this.vspanTmp[1];
      const drop = b.h * 0.16;
      g.fillStyle = rgba(COL_GEAR);
      for (let k = 0; k < 2; k++) {
        const s = k === 0 ? -1 : 1;
        g.beginPath();
        g.moveTo(footX, fy + 2);
        g.lineTo(footX + s * drop * 0.55, fy + drop);
        g.lineTo(footX + s * drop * 1.05, fy + drop * 0.82);
        g.closePath();
        g.fill();
      }
    }
    // 徽：排在正中线上——四根弦的两根中间正好空出一条，而徽本就该在这条线上
    for (let i = 0; i < HUI_COUNT; i++) {
      const f = HUI_FROM + (HUI_TO - HUI_FROM) * (i / (HUI_COUNT - 1));
      const hp = hx0 + (hx1 - hx0) * f;
      circle(g, hp, cy, HUI_R, COL_HUI_S);
      circle(g, hp, cy, HUI_R * 0.42, COL_HUI_IN_S);
    }

    const rowH = b.h / NOTE_COUNT;
    const amp = rowH * 0.26;
    for (let i = 0; i < NOTE_COUNT; i++) {
      const sy = this.stringRects[i].y + rowH * 0.5;
      this.drawStringH(g, i, sy, amp);
      // 键位提示压在琴尾之外，数字不再抢在弦前面
      drawText(g, String(i + 1), hx1 + 12, sy + 9, 26, 'rgb(217,199,158)');
    }

    // 状态文字
    let status = '';
    if (this.state === ST_SHOW) {
      status = tf(this.sh, 'mg_zither_watch', this.seqIndex + 1, SEQUENCE_LEN);
    } else {
      status = tf(this.sh, 'mg_zither_turn', this.playerLen + 1, SEQUENCE_LEN, Math.max(this.inputTimer, 0));
    }
    drawTextCentered(g, status, w, h * 0.88, 24, this.sh.dim);

    drawCancel(g, this.cancelBtn, tf(this.sh, 'mg_cancel'));
  }

  /**
   * 一根弦。**横向**的：沿着琴身长边从琴额拉到琴尾，振动方向是上下。
   * 振幅 = ring[i] 随时间衰减，位移是两端固定的驻波：sin(π·t) 保证两端钉死不动
   * （琴码和雁柱），sin(ringT·f) 给出振动。不振时退化成一条直线，但仍然画——
   * 四根弦必须在静止时也看得出来是四根。
   */
  private drawStringH(g: CanvasRenderingContext2D, i: number, sy: number, amp: number): void {
    const e = this.ring[i];
    const lit = this.activeNote === i;
    // 两端按**琴身在这一行的实际左右沿**裁，不要按 board 全宽。
    if (!bodySpanAt(this.body, sy, this.spanTmp)) return;
    const x0 = this.spanTmp[0] + STRING_INSET;
    const x1 = this.spanTmp[1] - STRING_INSET;
    g.strokeStyle = lit ? NOTE_COLS_LIT_S[i] : NOTE_COLS_S[i];
    g.lineWidth = lit ? 3 : 1.8;
    g.beginPath();
    for (let s = 0; s <= RING_SEGMENTS; s++) {
      const t = s / RING_SEGMENTS;
      const x = x0 + (x1 - x0) * t;
      const y = sy + e * amp * Math.sin(this.ringT * RING_FREQ + t * 3) * Math.sin(Math.PI * t);
      if (s === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    // 两端的弦轴：左端琴码、右端雁柱，把这条线钉在木面上，
    // 也顺便交代"这是弦不是划痕"
    g.fillStyle = rgba(COL_BRIDGE);
    g.fillRect(x0 - 12, sy - 7, 8, 14);
    g.fillRect(x1 + 4, sy - 6, 7, 12);
    // 拨响时弦心亮一下，驻波的包络比整条弦提亮更容易被余光捕捉
    if (e > 0.02) {
      const col = NOTE_COLS[i];
      const mid = x0 + (x1 - x0) * 0.5;
      circle(g, mid, sy, 4 + 6 * e, `rgba(${(col[0] * 255) | 0},${(col[1] * 255) | 0},${(col[2] * 255) | 0},${0.55 * e})`);
    }
  }
}

export function createZitherGame(ctx: MiniGameContext): MiniGame {
  return new ZitherGame(ctx);
}
