/**
 * 花房·禽语湖湾(4) 小游戏：看清一只鸟的剪影，再从 4 只里把它认出来。
 *
 * 键盘通路（必须完整可玩，鼠标只是加速）：**1 / 2 / 3 / 4** 选，ESC 取消。
 * 选对 → 'win'；选错 → 'lose'；Esc → 'cancel'。观察阶段不能作答（数字键不接）。
 *
 * 原作把"选错"也报成 CANCELLED。Web 侧分开：'cancel' 只留给玩家主动按 Esc。
 */
import { makeRng } from '../../core/noise';
import {
  cancelRectInto,
  circle,
  drawBackdrop,
  drawCancel,
  drawText,
  drawTextCentered,
  ellipse,
  lightened,
  darkened,
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

const BIRD_COUNT = 4;
const CHOICE_COUNT = 4;
/**
 * 展示一只鸟要多久。原来是 0.8 秒——那是"看清 → 记住 → 再回头扫四个选项"这一串
 * 动作根本做不完的长度：阶段切换没有任何提示（没有响声、没有位移，只有画面整个
 * 换掉），于是玩家往往还盯着那只鸟，屏幕已经变成四个按钮，于是重新去看一眼被
 * 换掉的画面 —— 于是忘了。
 *
 * 也不加"点一下继续"：那就把记忆测试变成了走过场。四只鸟的剪影现在是四份真的
 * 不同（见 BIRD_SHAPES），1.6 秒认一个形状够用，而下面那条收缩的横带是玩家唯一的
 * 时间参照，说多少就是多少。
 */
const SHOW_DURATION = 1.6;

/** 键盘选第 i 个选项。取消按钮在 Godot 版里是 `_draw()` 画的假按钮，键盘够不着，
 *  所以键盘玩家原本唯一的出路是干等 30s 超时——而禽是 5 块碎片之一，拿不到就永远
 *  到不了 5/5，键盘玩家直接卡死在通关前。 */
const CHOICE_KEYS: readonly string[] = ['Digit1', 'Digit2', 'Digit3', 'Digit4'];
const CHOICE_KEYS_ALT: readonly string[] = ['Numpad1', 'Numpad2', 'Numpad3', 'Numpad4'];

/** 四张选项格的底色。它是"这只鸟认不认得出来"那把尺子，所以是常量而不是画笔里的
 *  一个字面量。 */
const CARD_BG: Rgb = [0.22, 0.22, 0.27];

/**
 * 四只鸟的本体色。
 * 乌鸦是四只里唯一的深色，**而且必须继续是深色**——把它提亮它就不再是乌鸦，
 * 玩家读出来的是"一只灰色的鸟"，题面就换了个问题。
 * 原来它是 (0.11, 0.11, 0.14)，压在 CARD_BG 上 WCAG 只有 1.47:1，也就是"黑底上的
 * 黑"：四只里认不出哪只是鸦，而这一局问的正是"刚才那只是哪一只"。现在抬到 0.17 档的
 * **深炭灰**（比卡底暗、比另三只暗得多），真正把它从卡底上分出来的是那圈浅描边。
 */
const BIRD_COLS: readonly Rgb[] = [
  [0.55, 0.4, 0.25],   // 麻雀
  [0.3, 0.35, 0.55],   // 燕子
  [0.9, 0.9, 0.85],    // 白鹭
  [0.17, 0.17, 0.20],  // 乌鸦
];

/** 每只鸟的描边色（外圈那一道亮线）。**四只都有**，不是只给乌鸦：
 * 一屏四个选项、四个底色，描边是唯一一条"对四张卡一视同仁"的分界线，而
 * "某一只身上有、另外三只身上没有"本身也是一条形状/颜色上的差别，记忆测试不该考这个。 */
const BIRD_RIM_COLS: readonly Rgb[] = [
  [0.80, 0.70, 0.52],  // 麻雀：暖浅褐，和本体同一个色系但提上去一档
  [0.66, 0.76, 0.95],  // 燕子：浅蓝
  [0.99, 0.98, 0.92],  // 白鹭：比本体还亮的米白
  [0.88, 0.89, 0.92],  // 乌鸦：浅冷灰——本体不能再亮，这是唯一能把深炭灰
                        //        从深藏青卡底上勾出来的办法
];
/** 描边宽度（sc=1 的本地像素）。放大画在本体底下，所以画出来的那一圈是它的两倍。 */
const RIM_W = 2.2;

/**
 * 四只鸟必须是**四个形状**，不能是同一个形状刷四种颜色。
 *
 * 原来四只鸟的头/身/翼/尾是同一套坐标，唯一的区别是填充色——于是这个"记住哪一只"
 * 的游戏考的是"记住一个色号"，而且那个色号只闪 SHOW_DURATION 秒。
 *
 * 所以形状搬进这张表：**颜色不在表里**，表里只有几何。画的时候按表遍历，判据的时候
 * 也按表遍历，于是"四只鸟真的长得不一样"这件事从"看图才知道"变成能断言的。
 * 坐标是"sc=1 时"的本地像素，绘制时统一乘一次 `sc`（漏一处就是一只大一倍的鸟）。
 *
 *   ['o', cx, cy, rx, ry]        椭圆（主色）
 *   ['c', cx, cy, r]             圆（主色）
 *   ['p', x1,y1, x2,y2, …]       多边形（主色）
 *   ['q', x1,y1, x2,y2, …]       多边形（暗一档/辅色）
 *   ['l', x1,y1, x2,y2, w]       线（辅色）
 *   ['L', x1,y1, x2,y2, …, w]    折线（主色）
 *
 * 白鹭那一组是**压过的**：第一版按"真比例"画，84px 高的身子在 144px 的选项格里顶出
 * 上沿、压到下面的名字上，而另外三只只有 45px 高，一眼过去就是"一只巨大的加三只
 * 小的"——那是尺寸在认人，不是形状在认人。
 */
type Prim = readonly [string, ...number[]];
const N = (a: Prim, i: number): number => a[i] as number;

const BIRD_SHAPES: readonly (readonly Prim[])[] = [
  [ // 麻雀：矮、圆、尾短 —— 一团紧凑的球
    ['o', 0, 0, 22.0, 18.0],
    ['c', 15, -12, 12.0],
    ['q', 26, -13, 39, -9, 26, -7],
    ['q', -19, 6, -37, 1, -37, 15],
    ['l', -4, 22, -9, 33, 2.0],
    ['l', 10, 22, 8, 33, 2.0],
  ],
  [ // 燕子：后掠长翼 + 深叉尾 —— 横着的一个叉
    ['o', 0, 2, 21.0, 10.0],
    ['c', 14, -7, 9.0],
    ['q', 5, -2, -17, -27, -31, -20, -13, 2],
    ['q', 26, -8, 41, -4, 26, -3],
    ['q', -16, 4, -54, 17, -30, 12],
    ['q', -16, 2, -54, -9, -30, 0],
  ],
  [ // 白鹭：长颈 + 长腿 —— 竖着的一条
    ['o', 0, 8, 15.0, 18.0],
    ['L', 2, -4, 12, -20, 8, -32, 15, -42, 6.0],
    ['c', 15, -44, 6.0],
    ['q', 21, -46, 38, -42, 21, -40],
    ['q', -13, 2, -31, -4, -13, 13],
    ['l', -4, 24, -6, 38, 2.5],
    ['l', 7, 24, 9, 38, 2.5],
  ],
  [ // 乌鸦：厚重、低头、钝喙 —— 一坨
    ['o', -2, 8, 27.0, 21.0],
    ['c', 19, -6, 14.0],
    ['q', 31, -10, 51, -3, 31, 2],
    ['q', -26, 8, -45, 1, -45, 23],
    ['l', -9, 29, -11, 37, 2.0],
    ['l', 10, 29, 10, 37, 2.0],
  ],
];

const ST_SHOW = 0;
const ST_CHOICE = 1;

/** 选项格：2×2 网格。 */
const CARD_W_FRAC = 0.2;
const CARD_H_FRAC = 0.4;
const CARD_GAP_FRAC = 0.06;
/** 卡内剪影的缩放。0.38 不是随手挑的：选项格是 `btn_h*0.5` 高，白鹭那一只是竖着
 *  长出来最高的，再大一点就顶出格子压到下面的名字上；燕子是最宽的，再大一点就压到
 *  旁边的格子。 */
const CARD_BIRD_SCALE = 0.38;

class BirdGame implements MiniGame {
  readonly id = 'bird' as const;

  private readonly c: MiniGameContext;
  private readonly sh: Shell;
  private finished = false;
  private firstStepDone = false;

  private state = ST_SHOW;
  private showTimer = 0;
  private seenBird = 0;
  private readonly options = new Int32Array(CHOICE_COUNT);
  private correctChoice = 0;

  private readonly cards: Rect[] = [0, 1, 2, 3].map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  private readonly cancelBtn: Rect = { x: 0, y: 0, w: 0, h: 0 };

  constructor(ctx: MiniGameContext) {
    this.c = ctx;
    this.sh = makeShell(ctx);
    ctx.audio.duckAmbient(true);
    // 原作是 `randi()`；现在走 seed 驱动的 mulberry32 —— 同一个驿站第几次到访 →
    // 固定 seed → 同一局出题（出哪只鸟、四个选项的排布）完全可复现。
    const rng = makeRng(ctx.seed ^ 0x77aa);
    this.seenBird = Math.floor(rng() * BIRD_COUNT) % BIRD_COUNT;
    this.buildOptions(rng);
    this.showTimer = SHOW_DURATION;
    this.layout(ctx.width, ctx.height);
  }

  /** 4 个选项、1 个正确，然后打乱。Fisher-Yates，不建临时数组。 */
  private buildOptions(rng: () => number): void {
    this.options[0] = this.seenBird;
    for (let i = 1; i < CHOICE_COUNT; i++) {
      let r = Math.floor(rng() * BIRD_COUNT) % BIRD_COUNT;
      let guard = 0;
      while (this.options.indexOf(r) >= 0 && guard++ < 64) {
        r = Math.floor(rng() * BIRD_COUNT) % BIRD_COUNT;
      }
      this.options[i] = r;
    }
    for (let i = CHOICE_COUNT - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1)) % (i + 1);
      const tmp = this.options[i];
      this.options[i] = this.options[j];
      this.options[j] = tmp;
    }
    this.correctChoice = this.options.indexOf(this.seenBird);
  }

  private layout(w: number, h: number): void {
    this.sh.w = w;
    this.sh.h = h;
    const btnW = w * CARD_W_FRAC;
    const btnH = h * CARD_H_FRAC;
    const gap = w * CARD_GAP_FRAC;
    const startX = w * 0.5 - (btnW * 2 + gap) * 0.5;
    const startY = h * 0.15;
    for (let i = 0; i < CHOICE_COUNT; i++) {
      const bx = startX + (i % 2) * (btnW + gap);
      const by = startY + Math.floor(i / 2) * (btnH * 0.6);
      this.cards[i].x = bx;
      this.cards[i].y = by;
      this.cards[i].w = btnW;
      this.cards[i].h = btnH * 0.5;
    }
    cancelRectInto(this.cancelBtn, w, h);
  }

  private finish(r: MiniGameResult): void {
    if (this.finished) return;
    this.finished = true;
    this.c.audio.duckAmbient(false);
    this.c.onDone(r);
  }

  /** 展示期还剩多少，0..1。**画出来的那条横带用的就是这个值**。 */
  private countdownFraction(): number {
    return Math.min(Math.max(this.showTimer / Math.max(SHOW_DURATION, 0.001), 0), 1);
  }

  private choose(i: number): void {
    this.finish(i === this.correctChoice ? 'win' : 'lose');
  }

  // ------------------------------------------------------------ 输入

  onKeyDown(key: string, _shift: boolean): boolean {
    if (this.finished) return false;
    if (key === 'Escape') { this.finish('cancel'); return true; }
    // 观察阶段没有可答的题，数字键先不接，等进入选项阶段再按。
    if (this.state !== ST_CHOICE) return false;
    for (let i = 0; i < CHOICE_COUNT; i++) {
      if (key === CHOICE_KEYS[i] || key === CHOICE_KEYS_ALT[i]) { this.choose(i); return true; }
    }
    return false;
  }

  onKeyUp(_key: string): boolean {
    return false;
  }

  onPointerDown(x: number, y: number): void {
    if (this.finished) return;
    if (this.state !== ST_CHOICE) return;
    // 取消。热区走画笔那一处，见 chrome.ts 取消按钮那段注释。
    // 这一屏原来**留了热区却没画**：那块矩形只写在点击处理里，右下角于是变成一块
    // 点得着、读不出是什么的地方——玩家在那一带点空了，小游戏就没了，
    // 而界面上没有任何东西告诉他那里能点。画出来，这块角落才是它自己声称的那样。
    if (pointInRect(this.cancelBtn, x, y)) { this.finish('cancel'); return; }
    for (let i = 0; i < CHOICE_COUNT; i++) {
      if (pointInRect(this.cards[i], x, y)) { this.choose(i); return; }
    }
  }

  onPointerMove(_x: number, _y: number): void {
    // 选择是"点一下"。
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
    if (!this.firstStepDone) {
      // Godot 版在 `_ready` 里就播那声鸟叫；这里放到第一帧，
      // 免得宿主还在做入场动画时声音就先响了。
      this.firstStepDone = true;
      this.c.audio.sfx('bird_call');
    }
    if (this.finished || this.state !== ST_SHOW) return;
    this.showTimer -= dt;
    if (this.showTimer <= 0) this.state = ST_CHOICE;
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
    drawBackdrop(g, w, h, THEME.BIRD);
    if (this.state === ST_SHOW) this.drawShow(g, w, h);
    else this.drawChoice(g, w, h);
  }

  private drawShow(g: CanvasRenderingContext2D, w: number, h: number): void {
    drawTextCentered(g, tf(this.sh, 'mg_bird_title'), w, h * 0.08, 30, this.sh.paper);
    drawTextCentered(g, tf(this.sh, 'mg_bird_sub'), w, h * 0.14, 22, this.sh.paper);

    this.drawBirdSilhouette(g, this.seenBird, w * 0.5, h * 0.45, Math.min(w, h) / 280);

    // 这条横带就是全部的"还剩多久"。原来这里画的是一个整数倒计时
    // `max(1, int(timer) + 1)`，而 SHOW_DURATION 只有 0.8 秒 —— int(0.8) 到
    // int(0.0) 一直是 0，+1 之后恒为 1。那个"1"从头到尾没动过，于是它不是倒计时，
    // 是**一个宣称自己在倒、其实钉死的数字**：玩家会一直等那个 1 变成 0，而它永远
    // 不会。所以改成一条按真实剩余时间收缩的横带——说多少就是多少。
    const barW = w * 0.4;
    const barH = 10;
    const barX = w * 0.5 - barW * 0.5;
    const barY = h * 0.78;
    g.fillStyle = 'rgba(255,255,255,0.16)';
    g.fillRect(barX, barY, barW, barH);
    g.fillStyle = 'rgba(255,204,102,0.9)';
    g.fillRect(barX, barY, barW * this.countdownFraction(), barH);
  }

  private drawChoice(g: CanvasRenderingContext2D, w: number, h: number): void {
    const sc = Math.min(w, h) / 280;
    drawTextCentered(g, tf(this.sh, 'mg_bird_question'), w, h * 0.08, 28, this.sh.paper);
    drawTextCentered(g, tf(this.sh, 'mg_key_hint'), w, h * 0.13, 20, this.sh.dim);

    const cardBgS = rgba(CARD_BG);
    for (let i = 0; i < CHOICE_COUNT; i++) {
      const r = this.cards[i];
      g.fillStyle = cardBgS;
      g.fillRect(r.x, r.y, r.w, r.h);
      g.strokeStyle = 'rgb(179,179,179)';
      g.lineWidth = 2;
      g.strokeRect(r.x, r.y, r.w, r.h);
      const birdIdx = this.options[i];
      // 中心抬到 0.22 是给下面那行名字让出位置。
      this.drawBirdSilhouette(g, birdIdx, r.x + r.w * 0.5, r.y + r.h * 0.44, sc * CARD_BIRD_SCALE);
      drawText(g, tf(this.sh, `mg_bird_${birdIdx}`), r.x, r.y + r.h * 0.92, 20,
        'rgb(230,230,230)', 'center', r.w);
      // 键位角标：键盘玩家看不见鼠标在哪，角标是「哪个键选这只」的唯一线索。
      drawText(g, String(i + 1), r.x + 8, r.y + 24, 20, 'rgba(255,255,255,0.75)');
    }

    drawCancel(g, this.cancelBtn, tf(this.sh, 'mg_cancel'));
  }

  /**
   * 一只鸟的剪影。**两遍**：先把每一笔放大 `RIM_W` 用描边色画一遍，再把本体压上去。
   * 外露的那半圈就是描边。之所以用"放大"而不是"加线宽"：多边形填充不吃线宽参数，
   * 而"这只鸦在深卡上看不见"恰恰是这一族里唯一不能靠线宽救的形状（本体比卡底还暗）。
   */
  private drawBirdSilhouette(
    g: CanvasRenderingContext2D, birdIdx: number, cx: number, cy: number, sc: number,
  ): void {
    const col = BIRD_COLS[birdIdx];
    const rim = rgba(BIRD_RIM_COLS[birdIdx]);
    // 辅色往**亮**里去还是往**暗**里去，看这只鸟本身有多深。原先一律乘 0.74，于是
    // 乌鸦身上的辅色（喙、脚、翅根）比身子还暗 0.11×0.74 = 0.08——压在 CARD_BG 上
    // 彻底没了，那只鸦就只剩一团看不出形状的墨。
    // 这不是配色偏好，是"辅色必须比本体更靠近底色以外的那一侧"。
    const lum = col[0] * 0.3 + col[1] * 0.59 + col[2] * 0.11;
    const shade = rgba(lum < 0.3 ? lightened(col, 0.34) : darkened(col, 0.26));
    this.paintSilhouette(g, birdIdx, cx, cy, sc, rim, rim, RIM_W * sc);
    this.paintSilhouette(g, birdIdx, cx, cy, sc, rgba(col), shade, 0);
  }

  /**
   * 按表走一遍剪影。`grow` 是**外扩的屏幕像素**（描边那遍传 `RIM_W * sc`，
   * 本体那遍传 0）；`accent` 是辅色（喙/翅根/脚）那一档颜色。
   * 拆成独立方法是因为两遍要遍历同一张表各画一次——把两遍写在一个循环里的话，
   * 第二遍会被第一遍的顺序问题带着走，而顺序正是辅色压在本体上那一层。
   */
  private paintSilhouette(
    g: CanvasRenderingContext2D, birdIdx: number,
    cx: number, cy: number, sc: number,
    bodyCol: string, accentCol: string, grow: number,
  ): void {
    const prims = BIRD_SHAPES[birdIdx];
    // 线宽本来是本地像素，而 grow 是屏幕像素，换算要除以 sc
    const wg = (grow * 2) / Math.max(sc, 0.001);
    for (let k = 0; k < prims.length; k++) {
      const a = prims[k];
      const kind = a[0];
      const cc = kind === 'q' || kind === 'l' ? accentCol : bodyCol;
      const ox = cx + N(a, 1) * sc;
      const oy = cy + N(a, 2) * sc;
      if (kind === 'o') {
        // ⚠ 单位不一致，**原样照抄**：`_oval(c, sc, rx, ry)` 内部是
        // `c + Vector2(cos*rx, sin*ry) * sc`，于是半轴 = `(rx + grow) * sc`。
        // 而 `grow` 在别处（多边形、圆、线）都是**屏幕像素**，只有椭圆这一路被
        // 又乘了一次 sc：观察阶段 sc ≈ 2.57，描边会宽到 RIM_W·sc² ≈ 14px，
        // 视觉上就是"那只鸟比选项格里那只胖一圈"。选项阶段 sc ≈ 0.98，看不出来。
        // 修它＝改观感，所以这里不动，列为待决项（见交付报告）。
        ellipse(g, ox, oy, (N(a, 3) + grow) * sc, (N(a, 4) + grow) * sc, cc);
      } else if (kind === 'c') {
        circle(g, ox, oy, (N(a, 3) + grow) * sc, cc);
      } else if (kind === 'l') {
        const ex = cx + N(a, 3) * sc;
        const ey = cy + N(a, 4) * sc;
        g.strokeStyle = cc;
        g.lineWidth = (N(a, 5) + wg) * sc;
        g.beginPath();
        g.moveTo(ox, oy);
        g.lineTo(ex, ey);
        g.stroke();
      } else {
        // p / q / L：坐标从下标 1 起成对；`L` 的最后一项是线宽不是坐标。
        const last = kind === 'L' ? a.length - 1 : a.length;
        g.beginPath();
        for (let i = 1; i < last; i += 2) {
          let px = cx + N(a, i) * sc;
          let py = cy + N(a, i + 1) * sc;
          if (grow > 0) {
            // 沿"离这只鸟中心的方向"把每个顶点往外推 `grow` 像素。
            // 按中心缩放（v * (1+k)）不行：喙在 x=+51、尾在 x=-45，离中心的距离差
            // 一倍，缩放出来的描边一头厚一头薄，而鸦那一头正好是它贴在卡底上
            // 认不出的那一头。
            const dx = px - cx, dy = py - cy;
            const l = Math.hypot(dx, dy);
            if (l > 0.001) { px += (dx / l) * grow; py += (dy / l) * grow; }
          }
          if (i === 1) g.moveTo(px, py); else g.lineTo(px, py);
        }
        if (kind === 'L') {
          g.strokeStyle = cc;
          g.lineWidth = (N(a, a.length - 1) + wg) * sc;
          g.stroke();
        } else {
          g.closePath();
          g.fillStyle = cc;
          g.fill();
        }
      }
    }
  }
}

export function createBirdGame(ctx: MiniGameContext): MiniGame {
  return new BirdGame(ctx);
}
