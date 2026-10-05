/**
 * 竹雨庭(14) 小游戏：QTE 砍竹 —— 5 根竹子依次倒下，需在 1.2s 窗口内按空格。
 *
 * 键盘通路（必须完整可玩，鼠标只是加速）：**空格** = 砍，ESC 放弃。
 * 开局有 0.8s 引导期，**提前按也算数**（玩家看到遮罩第一反应就是按空格，那一下
 * 不能被静默吃掉）。砍完 5 根停留 1.6s 再结算。
 *
 * 原作把"窗口过期"也报成 CANCELLED。Web 侧分开：窗口过期 → 'lose'，
 * Esc → 'cancel'，五根砍完 → 'win'。
 *
 * **成功画面期间不给 ESC**：那 1.6s 是给玩家确认"是我砍赢的"，跳过它就回到
 * "小游戏凭空消失"那个老毛病（早先在 `_next_bamboo` 里直接结算 + 释放，
 * 遮罩在同一帧就没了，玩家分不清是砍赢了还是被踢出去）。
 */
import {
  barRectInto,
  cancelRectInto,
  drawBackdrop,
  drawCancel,
  drawPips,
  drawText,
  drawTextCentered,
  line,
  makeShell,
  fillRect,
  pointInRect,
  THEME,
  tf,
  type Rect,
  type Shell,
} from './chrome';
import type { MiniGame, MiniGameContext, MiniGameResult } from './types';

const BAMBOO_COUNT = 5;
const WINDOW_SEC = 1.2;
const INTRO_SEC = 0.8;
/** 砍完最后一根后停留在成功画面的时长。必须给一段停留（见文件头注释）。 */
const SUCCESS_HOLD_SEC = 1.6;
/** 砍掉一根到下一根冒头之间的空档。 */
const CUT_DELAY_SEC = 0.4;

/**
 * 五根竹子的摆法。
 *
 * 原来每根是一条 12px 宽的**等宽竖条**，竹节那四条线也是 12px 宽的——画在一条
 * 12px 的条上等于没有。所以这一屏上根本没有竹子，只有五根绿色的柱子和五个数字，
 * 而标题写的是"竹子一冒头就按空格"。
 */
const SPACING = 152.0;
const STALK_W_BASE = 30.0;
const STALK_W_TIP = 15.0;
const NODE_COUNT = 4;
/** 还没冒头那根笋的高度占比。太小的话剩四座就成四个点，这一屏读成"一根竹子 + 四粒灰"。 */
const SPROUT_FRAC = 0.20;
/** 砍倒之后画成什么样。
 *
 * 不把整根放平：五根按 `SPACING` 并排，一根 `h*0.52` 高的竹子倒下去要横跨好几列，
 * 五个全倒就是一片绿线团，谁也数不清自己砍了几根。留一截桩、上半截斜靠在桩上，
 * 是砍竹子本来就会有的样子，也老老实实待在自己那一列里。 */
const STUMP_FRAC = 0.16;
const FALL_DEG = 72.0;
/** 斜靠那截的横向伸出占列距的几成。这个数是**从"不许伸进邻居那一列"反解**出来的，
 *  不是窗口高度的百分比 —— 按高度取的话，720p 上量着刚好不压到邻居，1080p 上就压上
 *  去了（原作的判据在 1280 高的视口上量到 177px > 152px 就是这么翻的）。 */
const FALL_REACH_FRAC = 0.78;

/** 顶上那几片叶。每一项是 [根距竹梢的高度占比（负数）, 横向伸出, 垂下, 叶宽]，
 *  四个量都按 `bh` 计。左右各一片。
 *
 * **画笔和判据读的是同一张表**：另抄一份数字的话，改画不动测、测会一直绿，而
 * "叶宽只有竹身的四分之一"这件事正是这一版的正事。
 *
 * 叶是**窄条**。原来一片叶的三个顶点是根、朝外上方、斜下方各一个，于是一片叶横向
 * 伸到 `bh * 0.31`（116px）却只垂 `bh * 0.14`（52px）——比 30px 宽的竹身还大好
 * 几倍，两片一左一右读成一对翅膀或者龙舌兰。竹叶身上最认得出的是"长而窄"：
 * 叶宽大致是叶长的十五分之一。
 * 叶宽是**参数**，不是从别的量推出来的：把中点沿弦的垂直方向推开半个 `width`，
 * 量出来的最大宽度就正好是 `width`（等腰三角形）。 */
const LEAVES: readonly (readonly [number, number, number, number])[] = [
  [-0.82, 0.24, 0.16, 0.035], // 长的那片甩出去
  [-0.70, 0.14, 0.30, 0.030], // 矮的那片垂下来
];

/** 竹子占屏的几成 + 序号条。 */
const BASE_Y_FRAC = 0.82;
const BH_FRAC = 0.52;
const BAR_Y_FRAC = 0.88;
const BAR_W_FRAC = 0.42;
const BAR_H = 14.0;

/** 砍倒那截该有多长。横向伸出 = 长度 × sin(FALL_DEG)，所以长度由列距反解。 */
function fallLen(spacing: number): number {
  return (spacing * FALL_REACH_FRAC) / Math.sin((FALL_DEG * Math.PI) / 180);
}

/** 第 i 根竹子该往哪边倒。左右交替：都往同一边倒的话，斜靠的那截会压在右边那根
 *  还立着的竹子上。交替之后每截只伸进自己那一列。 */
const fallDir = (i: number): number => (i % 2 === 0 ? 1 : -1);

/** 第 n 个竹节距底端的高度占比。竹节比竹身宽一点，是竹子身上最认得出来的一处。
 *  底端那个节贴着地不算数，从 1/count 开始往上排。 */
function nodeFrac(n: number): number {
  return (n + 1) / (NODE_COUNT + 1);
}

/** 一根竹子的四边形：底宽 `wBase`、顶窄 `wTip`，绕**底端**朝 `leanDeg` 倒过去。
 *  倒下的上半截和立着的那半截走的是同一个算式——它们本来就是同一根竹子，
 *  只是躺下了，所以上下两截必然接得上、宽窄也必然连续。
 *
 * 直接往画笔上打点，不建多边形数组（每帧 5 根 × 2~4 个多边形）。
 */
function stalkPath(
  g: CanvasRenderingContext2D,
  baseX: number, baseY: number,
  height: number, wBase: number, wTip: number, leanDeg: number,
): void {
  const a = (leanDeg * Math.PI) / 180;
  const dirX = Math.sin(a), dirY = -Math.cos(a);   // lean=0 时指向正上方
  const sideX = Math.cos(a), sideY = Math.sin(a);   // 与竹身垂直
  const tipX = baseX + dirX * height, tipY = baseY + dirY * height;
  g.beginPath();
  g.moveTo(baseX - sideX * (wBase * 0.5), baseY - sideY * (wBase * 0.5));
  g.lineTo(tipX - sideX * (wTip * 0.5), tipY - sideY * (wTip * 0.5));
  g.lineTo(tipX + sideX * (wTip * 0.5), tipY + sideY * (wTip * 0.5));
  g.lineTo(baseX + sideX * (wBase * 0.5), baseY + sideY * (wBase * 0.5));
  g.closePath();
  g.fill();
}

/** 顶上那片叶。把中点沿弦的垂直方向推开半个 `width`，量出来的最大宽度正好是 `width`。 */
function leafPath(
  g: CanvasRenderingContext2D,
  rx: number, ry: number,
  side: number, reach: number, drop: number, width: number,
): void {
  const tipX = rx + side * reach, tipY = ry + drop;
  const cdx = tipX - rx, cdy = tipY - ry;
  const len = Math.hypot(cdx, cdy);
  if (len <= 0) return;
  g.beginPath();
  g.moveTo(rx, ry);
  g.lineTo(rx + (cdx * 0.5 - (cdy / len) * (width * 0.5)), ry + (cdy * 0.5 + (cdx / len) * (width * 0.5)));
  g.lineTo(tipX, tipY);
  g.closePath();
  g.fill();
}

const SKIN = 'rgb(77,158,82)';
const SKIN_LO = 'rgb(51,115,56)';
const NODE_COL = 'rgb(117,189,102)';
const SPROUT_COL = 'rgba(77,158,82,0.45)';
/** 序号条：五格。 */
const PIP_FILL = 'rgba(77,158,82,0.95)';
const PIP_EMPTY = 'rgba(36,51,41,0.75)';
const PIP_EDGE = 'rgb(255,230,128)';
/** 序号字的底色，闪烁时只改 alpha。 */
const NUM_COL = 'rgb(179,230,179)';

/** 状态：-1 未出现 / 0 可砍 / 1 已砍 */
const ST_HIDDEN = -1;
const ST_CUTTABLE = 0;
const ST_DOWN = 1;

class BambooGame implements MiniGame {
  readonly id = 'bamboo' as const;

  private readonly c: MiniGameContext;
  private readonly sh: Shell;
  private finished = false;

  private readonly states = new Int32Array(BAMBOO_COUNT).fill(ST_HIDDEN);
  private current = 0;
  private windowTimer = 0;
  private windowActive = false;
  private succeeded = false;
  private successTimer = 0;
  private t = 0;
  private introActive = true;
  private introTimer = INTRO_SEC;
  private cutDelay = 0;
  /** 空格当前是否按着。
   *
   * 原作靠 `not event.echo` 挡长按连发；浏览器的长按会连着发 `keydown`
   * （`event.repeat === true`），而 `MiniGame.onKeyDown` 的签名里没有 repeat 位。
   * 所以这里自己记一个"按着"：按住空格一路连发也只砍得到一根。
   * 不这么做的话，一直按住空格能秒过全部 5 根——这一屏的全部张力就没了。 */
  private spaceHeld = false;

  private readonly pbar: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private readonly cancelBtn: Rect = { x: 0, y: 0, w: 0, h: 0 };

  constructor(ctx: MiniGameContext) {
    this.c = ctx;
    this.sh = makeShell(ctx);
    ctx.audio.duckAmbient(true);
    this.layout(ctx.width, ctx.height);
  }

  private layout(w: number, h: number): void {
    this.sh.w = w;
    this.sh.h = h;
    barRectInto(this.pbar, w, h, BAR_Y_FRAC, BAR_W_FRAC, BAR_H);
    cancelRectInto(this.cancelBtn, w, h);
  }

  private finish(r: MiniGameResult): void {
    if (this.finished) return;
    this.finished = true;
    this.c.audio.duckAmbient(false);
    this.c.onDone(r);
  }

  private nextBamboo(): void {
    if (this.current >= BAMBOO_COUNT) {
      this.enterSuccess();
      return;
    }
    this.states[this.current] = ST_CUTTABLE;
    this.windowActive = true;
    this.windowTimer = WINDOW_SEC;
  }

  /** 进入成功画面并停留 SUCCESS_HOLD_SEC，期间不接受任何输入，然后才结算。 */
  private enterSuccess(): void {
    if (this.succeeded) return;
    this.succeeded = true;
    this.successTimer = SUCCESS_HOLD_SEC;
  }

  /** 砍掉当前这根：标记倒下，0.4s 后进入下一根。 */
  private cutCurrent(): void {
    if (!this.windowActive) return;
    this.windowActive = false;
    this.states[this.current] = ST_DOWN;
    this.current++;
    this.c.audio.sfx('bamboo_cut');
    this.cutDelay = CUT_DELAY_SEC;
  }

  // ------------------------------------------------------------ 输入

  /**
   * 返回 true 表示"吃掉了这次按键"（宿主据此阻止空格继续走全局 interact）。
   * 顺序照抄原作：成功画面吞键 → ESC → 取消热区 → 引导期 → 空档期 → 砍。
   * **取消热区必须判在"当成砍"之前**，反了就变成点了取消反而挨一刀。
   */
  onKeyDown(key: string, _shift: boolean): boolean {
    if (key === 'Space' && this.spaceHeld) return true;
    if (this.finished) return false;
    // 成功画面期间什么都不做，但按键照样要吃掉：这段时间玩家多半还在惯性乱按。
    if (this.succeeded) {
      if (key === 'Space') this.spaceHeld = true;
      return key === 'Space';
    }
    // ESC 取消。成功画面期间不给 ESC（见文件头注释）。
    if (key === 'Escape') { this.finish('cancel'); return true; }
    if (key !== 'Space') return false;
    // 引导期提前按也算数——但**这一次按键不能顺手把"按住"也吃掉**。
    //
    // 原来 `spaceHeld = true` 写在引导期判断之前，于是：玩家从引导期就按住空格
    // （提示写着"竹子一冒头就按空格"，一直按着是最自然的打法），
    // 那一次 keydown 既结束引导、又置上了 held，于是浏览器后续的按键重复
    // 全被开头那句 `if (key === 'Space' && this.spaceHeld) return true;` 吞掉——
    // **第一根必定失手，而且界面上没有任何提示**。
    //
    // 现在引导期这一刀**不置 held**：继续按着，浏览器的按键重复会在窗口内
    // 补上这一刀；松开再按也一样。这一刀不再凭空消失，
    // 而"每根都要重新按一次"的手感仍然保留（held 只在这一刀之后才置上）。
    if (this.introActive) {
      this.introActive = false;
      this.spaceHeld = false;
      this.nextBamboo();
      return true;
    }
    this.spaceHeld = true;
    // 两根竹子之间的 0.4s 空档里窗口没开，按键砍不到东西。但照样要吃掉：
    // 空格同时是全局 interact 动作，放行的话这一次按键会漏到外面那一层。
    if (!this.windowActive) return true;
    this.cutCurrent();
    return true;
  }

  onKeyUp(key: string): boolean {
    if (key !== 'Space') return false;
    this.spaceHeld = false;
    return true;
  }

  onPointerDown(x: number, y: number): void {
    if (this.finished) return;
    if (this.succeeded) return;
    if (pointInRect(this.cancelBtn, x, y)) { this.finish('cancel'); return; }
    if (this.introActive) {
      this.introActive = false;
      this.nextBamboo();
      return;
    }
    if (!this.windowActive) return;
    this.cutCurrent();
  }

  onPointerMove(_x: number, _y: number): void {
    // 砍是点一下，不是拖。
  }

  onPointerUp(_x: number, _y: number): void {
    // 同上。
  }

  cancel(): boolean {
    // 成功画面期间不给 ESC。
    if (this.finished || this.succeeded) return this.finished;
    this.finish('cancel');
    return true;
  }

  step(dt: number): void {
    this.t += dt;
    if (this.succeeded) {
      // 成功画面：倒计时走完就结算。窗口/倒计时都不再动，避免玩家以为还能砍。
      this.successTimer = Math.max(this.successTimer - dt, 0);
      if (this.successTimer <= 0) this.finish('win');
      return;
    }
    if (this.introActive) {
      this.introTimer -= dt;
      if (this.introTimer <= 0) {
        this.introActive = false;
        this.nextBamboo();
      }
      return;
    }
    if (this.cutDelay > 0) {
      this.cutDelay -= dt;
      if (this.cutDelay <= 0) {
        this.cutDelay = 0;
        this.nextBamboo();
      }
      return;
    }
    if (this.windowActive) {
      this.windowTimer -= dt;
      if (this.windowTimer <= 0) {
        this.windowActive = false;
        // 窗口过期 = 失手，不是玩家主动放弃 → 'lose'
        this.finish('lose');
      }
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

    drawBackdrop(g, w, h, THEME.BAMBOO);

    if (this.succeeded) {
      this.drawSuccess(g, w, h);
      return;
    }

    drawTextCentered(g, tf(this.sh, 'mg_bamboo_title'), w, h * 0.1, 28, this.sh.paper);
    if (this.introActive) {
      // 引导期：告诉玩家提前按也可以，不用等倒计时
      drawTextCentered(g, tf(this.sh, 'mg_bamboo_intro'), w, h * 0.17, 20, this.sh.paper);
    }

    const startX = w * 0.5 - BAMBOO_COUNT * SPACING * 0.5;
    const baseY = h * BASE_Y_FRAC;
    const bh = h * BH_FRAC;

    for (let i = 0; i < BAMBOO_COUNT; i++) {
      const bx = startX + i * SPACING;
      const st = this.states[i];
      let alpha = 1;
      if (st === ST_CUTTABLE) {
        // 可砍（当前）：闪烁
        alpha = 0.7 + Math.sin(this.t * 12) * 0.3;
        // 倒计时：越急越红
        const urgency = 1 - this.windowTimer / WINDOW_SEC;
        const y = baseY - bh - 10;
        drawText(g, Math.max(this.windowTimer, 0).toFixed(1), bx - 5, y, 20,
          `rgba(255,${(urgency * 255) | 0},0,1)`);
      }
      this.drawStalk(g, i, bx, baseY, bh, st, alpha);
      // 序号
      drawText(g, String(i + 1), bx - 2, baseY + 26, 18, withAlpha(NUM_COL, alpha));
    }

    // 进度：五格。**原来只有一行"进度 0/5"的字，条都没有**——门槛写在了字里，
    // 画在屏上的却是一整屏竹子，玩家读不出还差几根。而竹子的进度是**五件互相
    // 独立的事**，所以分格而不是一根连续条：一根填到 60% 的条读成"有一根被砍掉了
    // 60%"，实际是三根倒了、两根还立着。
    drawPips(g, this.pbar, BAMBOO_COUNT, this.current, this.current, PIP_FILL, PIP_EMPTY, PIP_EDGE);

    drawCancel(g, this.cancelBtn, tf(this.sh, 'mg_cancel'));
  }

  /**
   * 一根竹子。`st`: 还没冒头 / 可砍 / 已砍。
   * 三种状态走的是同一套几何 —— 立着的时候是上下收分的竹身 + 竹节 + 顶上两片叶，
   * 砍倒之后底下一截桩、上半截斜靠着（leanDeg 就是那个斜度）。
   */
  private drawStalk(
    g: CanvasRenderingContext2D,
    i: number, baseX: number, baseY: number,
    bh: number, st: number, alpha: number,
  ): void {
    // 原作是把 alpha 直接乘进 Color(r,g,b,alpha) 的。这里用 globalAlpha 走一遍，
    // 于是每个状态用**不透明**的颜色，闪烁/收尾的 0.75 一次到位——
    // 每帧少拼四个 rgba 字符串。
    const prevAlpha = g.globalAlpha;
    g.globalAlpha = prevAlpha * alpha;
    if (st === ST_DOWN) {
      const sdir = fallDir(i);
      // 留在地上的那截桩
      g.fillStyle = SKIN;
      stalkPath(g, baseX, baseY, bh * STUMP_FRAC, STALK_W_BASE, STALK_W_BASE * 0.86, 0);
      // 斜靠在上半截：同一个四边形按 FALL_DEG 摆过去，所以上下两截必然接得上
      const topX = baseX;
      const topY = baseY - bh * STUMP_FRAC;
      stalkPath(g, topX, topY, fallLen(SPACING), STALK_W_BASE * 0.86, STALK_W_TIP, FALL_DEG * sdir);
      // 断口
      line(g, topX - STALK_W_BASE * 0.43, topY, topX + STALK_W_BASE * 0.43, topY, SKIN_LO, 3);
      g.globalAlpha = prevAlpha;
      return;
    }

    if (st === ST_HIDDEN) {
      // 还没冒头：地上一个笋尖。原来只画到 `bh * 0.10` 高，于是这一屏是一根立着的
      // 竹加四个几乎看不见的点，剩四座亭子空着——笋子要读得出"这里还有一根"，
      // 高度得够它自己被认成一株。
      g.fillStyle = SPROUT_COL;
      stalkPath(g, baseX, baseY, bh * SPROUT_FRAC, STALK_W_BASE * 0.62, STALK_W_TIP * 0.7, 0);
      g.globalAlpha = prevAlpha;
      return;
    }

    g.fillStyle = SKIN;
    stalkPath(g, baseX, baseY, bh, STALK_W_BASE, STALK_W_TIP, 0);
    // 竹节：比竹身宽一点的一道亮环
    g.strokeStyle = NODE_COL;
    g.lineWidth = 4;
    g.beginPath();
    for (let n = 0; n < NODE_COUNT; n++) {
      const f = nodeFrac(n);
      const ny = baseY - bh * f;
      const hw = (STALK_W_BASE + (STALK_W_TIP - STALK_W_BASE) * f) * 0.5 + 3;
      g.moveTo(baseX - hw, ny);
      g.lineTo(baseX + hw, ny);
    }
    g.stroke();
    // 顶上两片叶。竹子身上最认得出的一处，缺了它这条就是绿色的棍子。
    // 长的那片甩出去，矮的那片垂下来，两片错开一层。
    g.fillStyle = NODE_COL;
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      for (let k = 0; k < LEAVES.length; k++) {
        const L = LEAVES[k];
        leafPath(g, baseX, baseY + bh * L[0], side, bh * L[1], bh * L[2], bh * L[3]);
      }
    }
    g.globalAlpha = prevAlpha;
  }

  /** 砍完 5 根后的收尾画面：5 根全倒 + 一句成功文案 + 结算前的停留倒计时。
   *  玩家需要这一屏来确认"是我砍赢的"，而不是小游戏被一脚踢掉。 */
  private drawSuccess(g: CanvasRenderingContext2D, w: number, h: number): void {
    // 收尾时把底色压暗一点，让文案跳出来
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(0, 0, w, h);

    // 5 根全部倒伏，位置/尺寸跟主画面保持一致
    const startX = w * 0.5 - BAMBOO_COUNT * SPACING * 0.5;
    const baseY = h * BASE_Y_FRAC;
    const bh = h * BH_FRAC;
    for (let i = 0; i < BAMBOO_COUNT; i++) {
      this.drawStalk(g, i, startX + i * SPACING, baseY, bh, ST_DOWN, 0.75);
    }

    // 成功文案，入场时轻微淡入
    const fade = Math.min(Math.max(1 - this.successTimer / SUCCESS_HOLD_SEC, 0), 1);
    const alpha = Math.min(Math.max(0.35 + fade * 2.5, 0), 1);
    drawTextCentered(g, tf(this.sh, 'mg_bamboo_done'), w, h * 0.38, 40, `rgba(217,255,191,${alpha})`);
    drawTextCentered(g, tf(this.sh, 'mg_progress', BAMBOO_COUNT, BAMBOO_COUNT), w, h * 0.47, 24,
      `rgba(204,255,204,${alpha})`);

    // 即将结算的进度条
    const barW = w * 0.3;
    const barX = w * 0.5 - barW * 0.5;
    const barY = h * 0.56;
    const left = Math.max(this.successTimer, 0);
    fillRect(g, { x: barX, y: barY, w: barW, h: 8 }, 'rgba(255,255,255,0.18)');
    fillRect(g, { x: barX, y: barY, w: barW * (left / SUCCESS_HOLD_SEC), h: 8 }, 'rgba(153,230,128,0.8)');
  }
}

/** `rgb(...)` → `rgba(..., alpha)`。只用于序号字那一行的闪烁。 */
function withAlpha(rgbStr: string, a: number): string {
  return rgbStr.replace('rgb(', 'rgba(').replace(')', `,${a})`);
}

export function createBambooGame(ctx: MiniGameContext): MiniGame {
  return new BambooGame(ctx);
}
