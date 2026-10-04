/**
 * 茶烟小筑(10) 小游戏：按住 3 秒把水注满，松手退回零重来。
 *
 * 键盘通路（必须完整可玩，鼠标只是加速）：按住**空格**注水，松手退回零，ESC 放弃。
 *
 * Godot 版这行注释原来写的是「松开失败」，而代码从来没有实现失败：松手只是把
 * `_hold_time` 清零，没有任何一个分支报 CANCELLED。文案（mg_tea_hint_release
 * 「松手就退回零」）说的都是后者，所以只有那行注释在讲一个不存在的东西——注释也会骗人。
 *
 * 茶因此是五个小游戏里唯一必然能过的：它也是五件乐事里的头一件（客至汲泉烹茶，
 * 朋友来了），本来就不该是一道关卡，而该是一次"按住三秒"的过场。代价是它比另外四个
 * 单薄——要不要给它加一道真的失手，留给产品决策（见交付报告）。
 * **结论：这一屏没有 'lose' 分支，只有 'win'（按满 3 秒）和 'cancel'（Esc）。**
 */
import {
  arcStroke,
  barRectInto,
  circle,
  drawBackdrop,
  drawBar,
  drawCancel,
  drawText,
  drawTextCentered,
  ellipse,
  lightened,
  makeShell,
  pointInRect,
  cancelRectInto,
  rgba,
  THEME,
  tf,
  type Rect,
  type Rgb,
  type Shell,
} from './chrome';
import type { MiniGame, MiniGameContext, MiniGameResult } from './types';

const HOLD_DURATION = 3.0;

/** 壶的几何。原来 rx/ry/壶心三个各写一份在 `_draw()` 里，回归就只能自己再抄一份
 *  （抄的那份迟早和画的漂）。抽出来之后，"水位线落在壶身之内"这条判据量的是
 *  **壶**和**水**共用的一组常量。 */
const POT_RX = 78.0;
const POT_RY = 60.0;
const POT_CY = 0.44;

/** 水面涨到最高时离壶心多远（壶半高 ry 的几成）。不到 1.0 是因为壶口那一圈留给了盖子。 */
const WATER_INSET = 0.86;

/** 水面线画几行。30 行时壶底那圈弧能看出台阶。 */
const WATER_ROWS = 64;

/** 进度条：y 0.72、宽 0.55、高 22px。 */
const BAR_Y_FRAC = 0.72;
const BAR_W_FRAC = 0.55;
const BAR_H = 22.0;

/** 水汽。**三颗随时间上浮、边飘边淡、一轮走完从底下重来**：
 *  原来那三颗是画在原地不动的灰圆点，alpha 也一路不变，读起来像壶身上溅了三滴
 *  脏水而不是蒸汽。alpha 跟着"飘了多高"走，飘得越高越淡。 */
const STEAM_COUNT = 3;
const STEAM_RISE = 46.0;   // 每秒上浮多少本地像素
const STEAM_SPAN = 96.0;   // 一颗飘完全程的高度（走完就从头再来）
const STEAM_A0 = 0.34;     // 刚冒头时的 alpha
/** 一轮里左右摆几个来回。**必须是整数**：原来摆幅那一项写的是 `sin(t * 2.2 + i)`，
 *  而 2.2 和"飘一轮要几秒"（STEAM_SPAN/STEAM_RISE = 2.09s）不通约，于是那一轮
 *  判据当场红，而图上的症状是"每颗水汽飘完一趟回来时横着跳一下"。取整之后摆动
 *  也是循环的一部分：u 走到 1 和回到 0 时 `sin(TAU*2·u)` 都落在 0，接得上。 */
const STEAM_SWAY_CYCLES = 2.0;

/** 壶身不能是暖褐色。原来 col_pot = (0.40, 0.26, 0.15)，而茶烟小筑那屏的天光渐变
 *  在壶所在的高度上正好是 (0.31, 0.23, 0.16) —— 两者亮度差不到 0.09，图上那只壶
 *  是一团和背景同色的糊，连壶嘴壶把都找不着。景做完之后才暴露出来：这片景比原先
 *  那块 0.7 alpha 的黑幕亮，壶就得让开。改成深色剪影 + 一道亮口沿：亮边在暖底上
 *  一眼能认出轮廓，壶里的水也才亮得起来（深壶身配 0.74 的水，是这屏唯一的高对比处）。 */
const COL_POT: Rgb = [0.16, 0.10, 0.06];
const COL_EDGE: Rgb = [0.90, 0.66, 0.36];
const COL_WATER: Rgb = [0.74, 0.46, 0.14];
const COL_POT_S = rgba(COL_POT);
const COL_EDGE_S = rgba(COL_EDGE);
const COL_WATER_S = rgba(COL_WATER, 0.9);
/** 进度条底色：Color(0.15,0.12,0.08)，以及它 `lightened(0.22)` 之后的那一档
 *  （门槛之后那一截要亮一点，门槛在右端所以实际画不到，留着是为了条的几何不变）。 */
const TRACK_S = 'rgb(38,31,20)';
const TRACK_LIGHT_S = rgba(lightened([0.15, 0.12, 0.08], 0.22));

/** 壶身几成的位置上有水。**从壶底量起，占壶身全高（2×ry）的几成**，所以和壶画多大
 *  无关——注水 50% 就该落在 0.5 附近。壶里的水和屏幕下方的进度条读的是**同一个值**：
 *  两处各算一份的话，松手那一刻条退回零而壶里的水还满着，同一屏上两句话互相拆台
 *  （这一族 bug 的通用症状：每处单独看都对）。 */
function waterTopFrac(fill: number): number {
  return (1 - WATER_INSET) * 0.5 + WATER_INSET * Math.min(Math.max(fill, 0), 1);
}

/** 画面上水面的 y。`ry` 是壶半高。 */
function waterLineY(cy: number, ry: number, fill: number): number {
  return cy + ry - 2 * ry * waterTopFrac(fill);
}

const potScale = (w: number, h: number): number => Math.min(w, h) / 400;

/**
 * 第 i 颗水汽在 t 时刻的偏移 / 半径 / 透明度。
 * `u` 是"这一轮走到几成"，三颗各错开 1/3 轮——同相的话那就是同一个点画三遍。
 * 复用 out（`ox/oy/or/oa`）以免每帧建三个对象。
 */
function steamPuff(i: number, t: number, sc: number, out: Float32Array): void {
  const period = STEAM_SPAN / STEAM_RISE;
  let u = (t / Math.max(period, 0.001) + i / STEAM_COUNT) % 1;
  if (u < 0) u += 1;
  const rise = u * STEAM_SPAN;
  out[0] = (i - (STEAM_COUNT - 1) * 0.5) * 16 * sc + Math.sin(Math.PI * 2 * STEAM_SWAY_CYCLES * u + i) * 9 * sc;
  out[1] = -(rise + 1.3 * POT_RY) * sc;
  out[2] = (5 + rise * 0.05) * sc;
  out[3] = STEAM_A0 * (1 - u);
}

class TeaGame implements MiniGame {
  readonly id = 'tea' as const;

  private readonly c: MiniGameContext;
  private readonly sh: Shell;
  private finished = false;
  private holdTime = 0;
  private holding = false;
  private t = 0;

  private readonly bar: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private readonly cancelBtn: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** steamPuff 的复用输出：[ox, oy, r, a]。 */
  private readonly puff = new Float32Array(4);

  constructor(ctx: MiniGameContext) {
    this.c = ctx;
    this.sh = makeShell(ctx);
    ctx.audio.duckAmbient(true);
    this.layout(ctx.width, ctx.height);
  }

  private layout(w: number, h: number): void {
    this.sh.w = w;
    this.sh.h = h;
    barRectInto(this.bar, w, h, BAR_Y_FRAC, BAR_W_FRAC, BAR_H);
    cancelRectInto(this.cancelBtn, w, h);
  }

  private fillFraction(): number {
    return Math.min(Math.max(this.holdTime / Math.max(HOLD_DURATION, 0.001), 0), 1);
  }

  private finish(r: MiniGameResult): void {
    if (this.finished) return;
    this.finished = true;
    this.c.audio.duckAmbient(false);
    this.c.onDone(r);
  }

  // ------------------------------------------------------------ 输入

  private setHolding(on: boolean): void {
    if (on) {
      // 只在"从松开到按住"的那一下出声。原作每次 keydown（含 echo）都重放一遍，
      // 浏览器里按住空格就是机关枪连播，那一屏的音效也就没意义了。
      // 判定和胜负无关：按住就注水。
      if (!this.holding) this.c.audio.sfx('tea_pour');
      this.holding = true;
    } else {
      this.holding = false;
      this.holdTime = 0;
    }
  }

  onPointerDown(x: number, y: number): void {
    if (this.finished) return;
    if (pointInRect(this.cancelBtn, x, y)) { this.finish('cancel'); return; }
    this.setHolding(true);
  }

  onPointerMove(_x: number, _y: number): void {
    // 原作没有"拖到别处松手就不注了"这回事：按下即注，抬起即退。
  }

  onPointerUp(_x: number, _y: number): void {
    if (this.finished) return;
    if (this.holding) this.setHolding(false);
  }

  onKeyDown(key: string, _shift: boolean): boolean {
    if (this.finished) return false;
    // ESC 取消。取消按钮在 Godot 版里是 `_draw()` 画的假按钮，键盘点不到——不接 ESC
    // 的话键盘玩家既不能放弃、又没法失败（长按 3 秒必然成功），唯一的出路是干等
    // World3D 的 30s 超时。五个小游戏里只有茶原来是这副模样。
    if (key === 'Escape') { this.finish('cancel'); return true; }
    if (key === 'Space') { this.setHolding(true); return true; }
    return false;
  }

  onKeyUp(key: string): boolean {
    if (key !== 'Space') return false;
    if (this.finished) return true;
    this.setHolding(false);
    return true;
  }

  cancel(): boolean {
    if (this.finished) return true;
    this.finish('cancel');
    return true;
  }

  step(dt: number): void {
    this.t += dt;
    if (this.finished) return;
    if (this.holding) {
      this.holdTime += dt;
      if (this.holdTime >= HOLD_DURATION) this.finish('win');
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

    drawBackdrop(g, w, h, THEME.TEA);
    drawTextCentered(g, tf(this.sh, 'mg_tea_title'), w, h * 0.12, 28, this.sh.paper);

    // 茶壶。原来这里是一个半圆弧 + 一根斜线 + 一个半圆环，落在深色背板上认不出是
    // 茶壶——五个小游戏里只有它没有可读的形象。壶身 + 壶盖 + 壶嘴 + 壶把，
    // 且壶里的水位跟着注水进度涨，进度条之外再有一处读数。
    const cx = w * 0.5;
    const cy = h * POT_CY;
    const sc = potScale(w, h);
    const rx = POT_RX * sc;
    const ry = POT_RY * sc;
    ellipse(g, cx, cy, rx, ry, COL_POT_S);

    // 水位。逐行取椭圆的半宽来填，所以水是贴着壶壁涨的，不会溢出一个方块。
    // 水面 y 与下面那条进度条**读同一个** `fillFraction()`。
    const held = this.fillFraction();
    const waterY = waterLineY(cy, ry, held);
    g.fillStyle = COL_WATER_S;
    for (let r = 0; r < WATER_ROWS; r++) {
      const y0 = cy - ry + (2 * ry * r) / WATER_ROWS;
      if (y0 < waterY) continue;
      const ny = (y0 - cy) / ry;
      if (Math.abs(ny) >= 0.999) continue;
      const hw = rx * Math.sqrt(1 - ny * ny);
      g.fillRect(cx - hw, y0, hw * 2, (2 * ry) / WATER_ROWS + 1);
    }
    // 口沿 + 壶盖口沿：只画右半圈（Godot 的 `_ellipse(open = true)`），
    // 正角方向与 Godot 一致（-90° 在上、+90° 在下）。
    g.strokeStyle = COL_EDGE_S;
    g.lineWidth = 3;
    g.beginPath();
    g.ellipse(cx, cy, rx, ry, 0, -Math.PI * 0.5, Math.PI * 0.5);
    g.stroke();
    // 壶盖 + 钮
    ellipse(g, cx, cy - ry * 0.94, rx * 0.62, ry * 0.2, COL_POT_S);
    g.strokeStyle = COL_EDGE_S;
    g.lineWidth = 2.5;
    g.beginPath();
    g.ellipse(cx, cy - ry * 0.94, rx * 0.62, ry * 0.2, 0, -Math.PI * 0.5, Math.PI * 0.5);
    g.stroke();
    circle(g, cx, cy - ry * 1.14, 7 * sc, COL_EDGE_S);
    // 壶嘴
    g.fillStyle = COL_POT_S;
    g.beginPath();
    g.moveTo(cx + rx * 0.72, cy - ry * 0.55);
    g.lineTo(cx + rx * 1.42, cy - ry * 1.12);
    g.lineTo(cx + rx * 1.3, cy - ry * 0.82);
    g.lineTo(cx + rx * 0.8, cy - ry * 0.2);
    g.closePath();
    g.fill();
    // 壶把
    arcStroke(g, cx - rx * 0.86, cy - ry * 0.1, ry * 0.52, Math.PI * 0.45, Math.PI * 1.55, COL_EDGE_S, 5 * sc);

    // 水汽：三颗从壶口往上飘，越飘越淡，一轮走完从壶口重新冒出来。
    for (let i = 0; i < STEAM_COUNT; i++) {
      steamPuff(i, this.t, sc, this.puff);
      circle(g, cx + this.puff[0], cy + this.puff[1], this.puff[2], `rgba(255,255,255,${this.puff[3]})`);
    }

    // 进度条。门槛在**条的右端**（按满 HOLD_DURATION 即成），原来这根条只有一条
    // 边框、什么标记都没有，而标题写的是"3秒后完成"——玩家盯着一个从 0% 爬到 100%
    // 的数，看不出"还差几秒"，而那正是这一屏的全部。
    // 松手时条不倒退是不行的：`holdTime` 立刻清零，刻痕要跟着往回退，不然条上留着
    // 一道满的刻痕而条是空的，两者在同一屏上互相拆台。
    const fillCol = this.holding ? 'rgb(153,89,26)' : 'rgb(89,51,20)';
    drawBar(g, this.bar, held, 1, fillCol, TRACK_S, TRACK_LIGHT_S, 'rgb(204,153,77)', 'rgb(255,209,115)');

    // 进度文字：百分比 + 还差几秒。只报百分比的话，玩家得自己乘一个他不知道是多少的
    // HOLD_DURATION 才算得出还差多久。
    drawText(g, `${Math.floor(held * 100)}%`, this.bar.x, this.bar.y - 12, 22, this.sh.paper);
    drawText(g, tf(this.sh, 'mg_tea_left', Math.max(HOLD_DURATION - this.holdTime, 0)),
      this.bar.x + this.bar.w - 130, this.bar.y - 12, 22, 'rgb(255,217,153)');

    // 提示
    const hint = this.holding
      ? tf(this.sh, 'mg_tea_hint_release')
      : tf(this.sh, 'mg_tea_hint_hold') + tf(this.sh, 'mg_tea_hint_esc');
    drawTextCentered(g, hint, w, h * 0.88, 22, 'rgb(255,217,153)');

    drawCancel(g, this.cancelBtn, tf(this.sh, 'mg_cancel'));
  }
}

export function createTeaGame(ctx: MiniGameContext): MiniGame {
  return new TeaGame(ctx);
}
