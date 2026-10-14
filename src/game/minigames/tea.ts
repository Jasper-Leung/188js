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

/**
 * 收尾动画时长（秒）。见 `drawPour`。
 *
 * 它是三段之和而不是一个拍脑袋的数：
 * 抬起倾倒 → 水流 → 扶正，而**扶正这一段不砍**——
 * 扶正的时候「成了」才浮出来，于是那一屏的因果是
 * 「水倒完了 → 才说成了」，而不是两件事同时发生。
 *
 * ⚠ **三段加起来必须留在 2.0 秒以内**。这不是审美：茶按满
 * `HOLD_DURATION`(3s) 之后还要走完这一段，而 `verify_minigame_playable`
 * 给"按住空格"的那个窗口正好 5.0 秒。3 + 2.0 = 5.0 刚好卡在边上，
 * 溢出一帧就会让茶看起来"收不到终局"，然后判据会误报成卡死。
 */
const TILT_IN = 0.40;
const POUR_HOLD = 1.20;
const TILT_OUT = 0.35;
const SETTLE_SEC = TILT_IN + POUR_HOLD + TILT_OUT;
const HOLD_DURATION = 3.0;

/** 倾到底的角度（弧度，约 62°）。再大壶嘴会翻到壶口上面去，读不出是"在倒"。 */
export const POUR_TILT = 1.08;

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

/** 壶嘴尖在壶身坐标系里的位置（`x` 是 rx 的几成，`y` 是 ry 的几成，y 向上为负）。
 *  画壶嘴与画水柱读的是**同一对**数：只在一处写的话，
 *  水柱会从壶嘴旁边那一小段缺口里漏出来，而图上只是"水没对上口"。 */
export const SPOUT_TIP_X = 1.42;
export const SPOUT_TIP_Y = -1.12;

/** 茶盏相对**倾到底的壶嘴尖**的落位。盏不是固定摆的，是从壶嘴那一点推出来的——
 *  固定摆的话，只要倾角一改，盏与水柱就对不上，而两者永远不会同时被看见，
 *  于是这个错能一直躺着。 */
export const CUP_DX = 0.06;
export const CUP_DY = 0.62;
export const CUP_W = 0.46;
export const CUP_H = 0.34;

/** 盏壁颜色：比壶身亮一档的釉白。这屏的底是暖褐，盏要跳出来才读得出"这是容器"。 */
const COL_CUP_S = 'rgba(226, 214, 190, 0.92)';

/**
 * 把一点绕支点转 `ang`（弧度）。canvas 的 `rotate` 在 y 向下的坐标系里
 * 是**顺时针为正**，所以这里用同一套符号——`draw()` 画的和这里算的必须一致。
 */
export function rotatePoint(
  x: number, y: number, px: number, py: number, ang: number,
): { x: number; y: number } {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const dx = x - px;
  const dy = y - py;
  return { x: px + dx * c - dy * s, y: py + dx * s + dy * c };
}

/** 壶倾 `ang` 之后，壶嘴尖真的在哪儿。`draw()` 的水柱与 `verify_tea_pour` 共用。 */
export function pourSpoutTip(
  cx: number, cy: number, rx: number, ry: number, ang: number,
): { x: number; y: number } {
  return rotatePoint(cx + rx * SPOUT_TIP_X, cy + ry * SPOUT_TIP_Y, cx, cy + ry * 0.85, ang);
}

/**
 * 茶盏的落位（`Rect`，y 是**盏口**）。
 *
 * 摆位用**倾到底**的壶嘴尖而不是当前角度：壶是从正位转过来的，
 * 盏若跟着一起动，水柱会跟着盏一起动——于是水永远落得进去，
 * 而那正是"倒不进盏"的另一种写法。
 */
export function pourCupRect(cx: number, cy: number, rx: number, ry: number): Rect {
  const tip = pourSpoutTip(cx, cy, rx, ry, POUR_TILT);
  const w = rx * CUP_W;
  return { x: tip.x + rx * CUP_DX - w * 0.5, y: tip.y + ry * CUP_DY, w, h: ry * CUP_H };
}

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
  /** 收尾动画走了多少秒。0 = 还在玩；>0 = 落幕中 */
  private settleT = 0;
  /** 收尾期间记着结果，等动画走完再交出去 */
  private pending: MiniGameResult | null = null;
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

  // ------------------------------------------------------------ 倒水时序
  //
  // 四个读数，**全部由 `settleT` 这一个钟推出来**。
  //
  // 原来这里没有第二个钟，于是倾角、水柱、茶盏水位各写一份自己的计时，
  // 改一个就要改三个——而它们不同步时的症状是"壶已经扶正了，水还在往下淌"，
  // 图上完全看不出是哪个数字慢了。

  /** 收尾整体进度 0..1。 */
  private pourProgress(): number {
    return Math.min(Math.max(this.settleT / SETTLE_SEC, 0), 1);
  }

  /** 当前倾角（弧度）。抬起 → 保持 → 扶正。 */
  private tiltAngle(): number {
    if (this.settleT <= 0) return 0;
    const ease = (u: number) => u * u * (3 - 2 * u);
    if (this.settleT < TILT_IN) return POUR_TILT * ease(this.settleT / TILT_IN);
    if (this.settleT < TILT_IN + POUR_HOLD) return POUR_TILT;
    const u = (this.settleT - TILT_IN - POUR_HOLD) / TILT_OUT;
    return POUR_TILT * (1 - ease(Math.min(Math.max(u, 0), 1)));
  }

  /**
   * 水柱强度 0..1。
   *
   * 两头各留一段淡入淡出（各 12% 的时长）：水柱不该凭空出现，
   * 也不该在壶还大张着嘴的时候凭空断掉。
   */
  private pourFlow(): number {
    const start = TILT_IN * 0.8;
    const end = TILT_IN + POUR_HOLD;
    if (this.settleT <= start || this.settleT >= end) return 0;
    const u = (this.settleT - start) / (end - start);
    return Math.min(Math.min(u / 0.12, (1 - u) / 0.12), 1);
  }

  /** 盏里的水位 0..1。水柱出的这段时间里一点点满上来。 */
  private cupFill(): number {
    const start = TILT_IN * 0.8;
    const span = TILT_IN + POUR_HOLD - start;
    return Math.min(Math.max((this.settleT - start) / span, 0), 1);
  }

  /**
   * 结束，但**不是立刻结束**。
   *
   * 原来 `finish()` 一被调用就 `onDone()`，宿主立刻把结算屏盖上来——
   * 于是"按满 3 秒"的最后一帧从来没被看见过，玩家得到的是
   * "我按了，然后什么也没发生"。
   *
   * 这一件本来就是**过场**而不是玩法，过场需要落幕。
   * 所以结果先记下，`step()` 里把收尾动画走完再真的交出去。
   * 期间**输入全部失效**（`setHolding` 与按键都先看 `finished`），
   * 所以那 0.9 秒里按什么都没用——这是对的：赢了之后还想接着按是误操作。
   *
   * 不加失败分支：这一屏本来就没有 `lose`。
   */
  private finish(r: MiniGameResult): void {
    if (this.finished) return;
    this.finished = true;
    this.settleT = 0;
    this.pending = r;
    this.holding = false;
    this.c.audio.duckAmbient(false);
  }

  /** 收尾动画走完就真的交出去。 */
  private flushSettle(dt: number): void {
    if (!this.finished || !this.pending) return;
    this.settleT += dt;
    if (this.settleT < SETTLE_SEC) return;
    const r = this.pending;
    this.pending = null;
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
    // 收尾动画自己也要时间往前走，否则它永远停在第 0 帧。
    // **必须在 `finished` 的早退之前**：早退是给"没在玩的时候"用的，
    // 而收尾期间恰恰是 `finished === true`。
    this.flushSettle(dt);
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
    this.settleT = 0;
    this.c.audio.duckAmbient(false);
  }

  // ------------------------------------------------------------ 绘制

  draw(): void {
    const g = this.sh.g;
    const w = this.sh.w;
    const h = this.sh.h;

    drawBackdrop(g, w, h, THEME.TEA);
    drawTextCentered(g, tf(this.sh, 'mg_tea_title'), w, h * 0.12, 28, this.sh.paper);

    const cx = w * 0.5;
    const cy = h * POT_CY;
    const sc = potScale(w, h);
    const rx = POT_RX * sc;
    const ry = POT_RY * sc;

    // 读数分两处：**玩的时候**是进度条，**倒的时候**是茶盏。
    //
    // 原来这里只有一个 `fillFraction()`，倒水时它恒等于 1，
    // 于是壶里满着、条也满着，而水正在往盏里流——同一屏上两句话互相拆台。
    // 倒水期间壶里的水位必须真的降下去（`potWater`），那才是"水倒出去了"。
    const held = this.fillFraction();
    const pouring = this.settleT > 0;
    const potWater = pouring ? Math.max(1 - this.pourProgress() * 1.25, 0) : held;

    // 茶盏。**先画它、再画壶**：壶倾过来时会盖住盏沿一点，
    // 顺序反过来就成了"壶浮在盏前面"。
    this.drawCup(g, cx, cy, rx, ry);

    // 整只壶绕一个**偏低的支点**转。支点摆在壶身下缘而不是正中心，
    // 转起来才像被人拎着把手倒水；绕正中心转的话壶像原地歪了一下，
    // 而那正是"倒不进去"的读法。
    const tilt = this.tiltAngle();
    const pivotX = cx;
    const pivotY = cy + ry * 0.85;
    g.save();
    g.translate(pivotX, pivotY);
    g.rotate(tilt);
    g.translate(-pivotX, -pivotY);
    this.drawPot(g, cx, cy, rx, ry, sc, potWater);
    g.restore();

    // 水流：从**转过之后**的壶嘴尖落到盏口。
    //
    // 算的是壶嘴现在真的在的那一点，而不是它静止时的位置——
    // 壶嘴静止时在 (cx+1.42rx, cy−1.12ry)，倾 62° 之后它落到了
    // (cx+156sc, cy+93sc)：用旧位置画，水会从半空中开始，往上穿过壶身。
    const flow = this.pourFlow();
    if (flow > 0) {
      const tip = pourSpoutTip(cx, cy, rx, ry, tilt);
      const cup = pourCupRect(cx, cy, rx, ry);
      this.drawStream(g, tip.x, tip.y, cup.x + cup.w * 0.5, cup.y, sc, flow);
    }

    // 水汽：三颗从壶口往上飘，越飘越淡，一轮走完从壶口重新冒出来。
    // 倒水时壶口已经不是朝上去了，水汽也该跟着散。
    const steamFade = pouring ? Math.max(1 - this.pourProgress() * 2.2, 0) : 1;
    if (steamFade > 0) {
      for (let i = 0; i < STEAM_COUNT; i++) {
        steamPuff(i, this.t, sc, this.puff);
        circle(g, cx + this.puff[0], cy + this.puff[1], this.puff[2], `rgba(255,255,255,${this.puff[3] * steamFade})`);
      }
    }

    if (!pouring) {
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
    } else {
      // 倒水那一下的一句旁白。
      //
      // 为什么这里要有台词：按满三秒 → 壶一歪 → 水进盏 → 退出，
      // 这一串全是动作。玩家看到的是"我按住了，然后壶自己动了一下"。
      // 而这一件在五件乐事里是**头一件**（客至汲泉烹茶），
      // 它该先把"水满了要干什么"讲完——一句话，就这一句。
      drawTextCentered(g, tf(this.sh, 'mg_tea_pour_line'), w, h * 0.88, 22, 'rgb(255,217,153)');
    }

    drawCancel(g, this.cancelBtn, tf(this.sh, 'mg_cancel'));

    // **落幕**。「成了」只在扶正那一段浮出来，于是因果是
    // 「水倒完了 → 才说成了」，而不是两件事同时发生。见 drawCurtain。
    this.drawCurtain(g, w, h);
  }

  /**
   * 壶身 + 壶盖 + 钮 + 嘴 + 把。**不含倾角**——
   * 倾角由 `draw()` 用 canvas 的 `rotate` 施加在外面，
   * 而这里画的每一样东西都会跟着一起转，包括壶嘴。
   */
  private drawPot(
    g: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, sc: number, water: number,
  ): void {
    ellipse(g, cx, cy, rx, ry, COL_POT_S);

    // 水位。逐行取椭圆的半宽来填，所以水是贴着壶壁涨的，不会溢出一个方块。
    // 水面 y 与下面那条进度条**读同一个** `fillFraction()`。
    const waterY = waterLineY(cy, ry, water);
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
    g.lineTo(cx + rx * SPOUT_TIP_X, cy + ry * SPOUT_TIP_Y);
    g.lineTo(cx + rx * 1.3, cy - ry * 0.82);
    g.lineTo(cx + rx * 0.8, cy - ry * 0.2);
    g.closePath();
    g.fill();
    // 壶把
    arcStroke(g, cx - rx * 0.86, cy - ry * 0.1, ry * 0.52, Math.PI * 0.45, Math.PI * 1.55, COL_EDGE_S, 5 * sc);
  }

  /** 茶盏。空盏从第一帧就在那儿——玩家按之前先看见"水将要倒进哪里"。 */
  private drawCup(g: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number): void {
    const c = pourCupRect(cx, cy, rx, ry);
    const halfW = c.w * 0.5;
    const hh = c.h;

    // 盏里的茶。**水面跟着壶倒出来的那一路下降**，所以两只容器
    // 在同一屏上是一件事的两头：壶空一点，盏满一点。
    const fill = this.cupFill();
    if (fill > 0) {
      const level = c.y + hh * (1 - fill);
      g.save();
      g.beginPath();
      g.rect(c.x - halfW, level, c.w, hh + 2);
      g.clip();
      g.fillStyle = COL_WATER_S;
      g.beginPath();
      // 0 → π 是**下半圈**（canvas 的 y 向下，π/2 落在下方），
      // closePath 补上口沿那条直线，于是这是一只碗。
      g.ellipse(c.x, c.y, halfW, hh, 0, 0, Math.PI, false);
      g.closePath();
      g.fill();
      g.restore();
    }
    // 盏壁：下半圈 + 口沿一条线
    arcStroke(g, c.x, c.y, halfW, 0, Math.PI, COL_CUP_S, Math.max(2, 3 * rx / 78));
    g.strokeStyle = COL_CUP_S;
    g.lineWidth = Math.max(2, 2.5 * rx / 78);
    g.beginPath();
    g.moveTo(c.x - halfW, c.y);
    g.lineTo(c.x + halfW, c.y);
    g.stroke();
  }

  /** 水柱。带一点外抛（二次曲线），落进盏口时散两圈小水花。 */
  private drawStream(
    g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, sc: number, strength: number,
  ): void {
    const mx = (x0 + x1) * 0.5;
    const my = (y0 + y1) * 0.5 + Math.abs(x1 - x0) * 0.1;
    g.strokeStyle = `rgba(214,150,48,${0.4 + 0.55 * strength})`;
    g.lineWidth = Math.max(2.5, 5 * sc);
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(x0, y0);
    g.quadraticCurveTo(mx, my, x1, y1);
    g.stroke();
    // 落点：水面被砸出的小坑 + 溅起的两滴
    g.fillStyle = `rgba(214,150,48,${0.35 + 0.4 * strength})`;
    g.beginPath();
    g.ellipse(x1, y1, 7 * sc * (0.7 + 0.3 * strength), 2.4 * sc, 0, 0, Math.PI * 2);
    g.fill();
    for (let i = 0; i < 2; i++) {
      const p = (this.t * 2.2 + i * 0.5) % 1;
      circle(g, x1 + (i === 0 ? -1 : 1) * (5 + 9 * p) * sc, y1 - 16 * p * sc,
        (1.6 + 1.4 * (1 - p)) * sc, `rgba(255,206,130,${0.5 * (1 - p) * strength})`);
    }
  }

  /**
   * 收尾那一下：**「成了」浮出来**。见 `draw()` 末尾的说明。
   *
   * 它从 `TILT_OUT` 那一段才开始，而不是从 `settleT = 0`。
   * 差别是因果：提前出现的话，玩家在壶还没倾、水还没落的时候
   * 就先看到"成了"，于是倒水那两秒读起来像一句附注；
   * 压在扶正这一段上，「成了」才是**水已经倒完**的意思。
   *
   * 水汽不再在这儿画——`draw()` 已经按 `pourProgress()` 淡出它了，
   * 两处各画一遍的话屏上是四颗水汽而不是三颗，而这种多一颗少一颗
   * 的事永远不会有人报。
   */
  private drawCurtain(g: CanvasRenderingContext2D, w: number, h: number): void {
    const t0 = TILT_IN + POUR_HOLD;
    if (this.settleT < t0) return;
    const p = Math.min((this.settleT - t0) / TILT_OUT, 1);

    // 从 0.6 倍缩放 + 透明，长成正常大小
    const ease = 1 - Math.pow(1 - p, 3);
    g.save();
    g.globalAlpha = Math.min(ease * 1.6, 1);
    g.translate(w * 0.5, h * 0.5);
    g.scale(0.6 + ease * 0.4, 0.6 + ease * 0.4);
    drawTextCentered(g, tf(this.sh, 'mg_success'), 0, 0, 64 * (w / 960 + 0.4), this.sh.paper);
    g.restore();
  }
}

export function createTeaGame(ctx: MiniGameContext): MiniGame {
  return new TeaGame(ctx);
}
