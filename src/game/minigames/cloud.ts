/**
 * 云影台(7) 小游戏：拖拽沿轨迹绘制云的形状。成功条件：完成 75% 以上路径。
 *
 * 键盘通路（必须完整可玩，鼠标只是加速）：
 *   方向键 / WASD 挪光标，按住**空格**落笔，松手结算，ESC 取消。
 * 走的还是鼠标那一条 `_updateDraw()`，判成功/失败的判据与鼠标完全共用——
 * 两套输入只负责「把一个点送到轨迹附近」，不各算各的进度。
 */
import {
  TAU,
  barRectInto,
  circle,
  cancelRectInto,
  drawBackdrop,
  drawBar,
  drawCancel,
  drawText,
  drawTextCentered,
  line,
  makeShell,
  fillRect,
  pointInRect,
  strokeRect,
  textAscent,
  textW,
  THEME,
  tickLabelBottom,
  tickLabelX,
  tickLabelY,
  TICK_LABEL_FONT,
  TICK_LABEL_W,
  tf,
  type Rect,
  type Shell,
} from './chrome';
import type { MiniGame, MiniGameContext, MiniGameResult } from './types';

// ---------------------------------------------------------------- 常量

/**
 * 云的形状：**几团圆叠在一起**，和背景里那五片云用的是同一套画法。
 * 每一项是 [圆心, 半径]（相对轮廓中心的 2D 坐标）。
 *
 * 原来这里是一串手抄的八边形顶点——玩家描的是"一个多边形"，而同一屏上背景
 * 里的云是几个圆叠出来的圆鼓鼓的一团。**同一件事两套画法**，于是"云"这个字
 * 在这一屏上没有任何东西指认。轮廓由这五团圆算出来，所以两处必然一致。
 * 这五团**不是画出来的，是量出来的**。
 *
 * 旧的一组是「主峰 + 左右肩 + 左右尾」这种按部位命名、随手摆的坐标，圆心距只有
 * 半径和的一半上下（主峰到左肩 28.6、半径和 54），于是五团叠成一坨：量出来
 * **上半圈只有 2 座峰、最深的凹口相对深度 0.9%**、剪影面积/凸包面积 = 0.9340。
 * 评审读到的「几乎处处外凸的土包」就是它。
 *
 * 凹口要留得下来，靠的是相邻圆心距压到**半径和的 0.75~0.9**。这一组是在一把量对了
 * 的尺子底下搜出来的：顶边上有 **2 个凹口**（最深的两个分别深 26.1 / 32.5）、
 * 离凸包最深 **16.4**、剪影/凸包 = **0.8942**、平底占全宽 **0.74**、长宽比 **1.79**。
 *
 * 长宽比是有理由的：板子是 2:1 的宽板，底下一行还要摆提示。云压得太方
 * （搜出来的那一档是 1.49）在 2:1 板上只能按高卡到 88%，横向剩 66% 两侧空一大片，
 * 而提示行是按云的**下沿**摆的——云一高就压上那行字。
 *
 * 顺带记两条**尺子的坑**，两次都量错了方向（这两条只写在尺子上，代码里看不出来，
 * 所以抄到常量上面，别再量错）：
 *   ① 凹口**不能**在 r(θ) 上去数谷。云底被压成一条直线，而直线的半径在 x=0 处
 *      最小，整条平边会被数成一个假凹口——第一版就是这么量出「2 峰 1 谷、深 4.74」
 *      的，那个 4.74 就是平底自己。
 *   ② 也不能在轮廓的 y 序列上数局部极大：θ=0 和 θ=180 附近 x 会掉头，顺序一折
 *      凹口就数错。正解是**按 x 分列的顶边剖面**。
 */
const CLOUD_CIRCLES: readonly (readonly [number, number, number])[] = [
  [-25.3, -20.8, 16.5], // 左上小峰
  [-7.4, 15.0, 21.4],   // 左身
  [18.6, -2.5, 32.0],   // 中峰（最高，压出中间那道谷）
  [30.2, -13.8, 18.9],  // 谷后的小峰
  [40.4, -15.5, 17.5],  // 右肩
  [58.8, 15.0, 21.2],   // 右尾
];

/** 轮廓采样数。相邻两点之间的间距必须显著大于 `KEY_STEP`(12px)，否则键盘光标整步走
 *  会在目标两侧横跳、`nextSeg` 卡死在没描到的那一段上。 */
const OUTLINE_SAMPLES = 40;
/** 云底压平的那条线。团状轮廓的底是圆的，而画上的云一律坐在一条平边上——
 *  没有平底的那团东西读成"一团棉花"而不是"一片云"。 */
const FLAT_Y = 30.7;
const PATH_TOLERANCE = 45.0;
const SUCCESS_THRESHOLD = 0.75;

/** 游戏区（描边板）占屏的比例。轨迹的缩放和板子的位置都从它推出来，
 *  两处各写一份 `0.15 / 0.7` 必然漂。 */
const AREA_POS_FRAC = 0.15;
const AREA_SIZE_FRAC = 0.70;
/** 轮廓外接盒占板子的几成。留两成余量，免得描边线宽和落笔容差贴到板边。 */
const FIT_FRAC = 0.88;

const BAR_Y_FRAC = 0.88;
const BAR_W_FRAC = 0.5;
const BAR_H = 16.0;

/** 操作提示行（"方向键 / WASD 挪光标 · 按住空格落笔 · ESC 取消"）。 */
const HINT_FONT = 20;
/** 行盒高。比字号高一点，容得下字形的上下伸部——`draw_string` 的 position.y
 *  是**基线**不是行盒顶，量行盒量不出字形有没有探出去。 */
const HINT_LINE_H = 26.0;
/** 离前后两样东西各留多少空。 */
const HINT_GAP = 12.0;

/** 键盘光标每按一次方向键挪多远（像素）。按住会走浏览器的按键重复，
 *  一次长按能把光标从一头拉到另一头。 */
const KEY_STEP = 12.0;

/** 笔触音的节流。鼠标拖是每帧调一次，不节流就是一叠糊在一起的噪声。 */
const BRUSH_SFX_MIN_SEC = 0.3;

// ---------------------------------------------------------------- 板 / 条

const areaRectInto = (out: Rect, w: number, h: number): void => {
  out.x = w * AREA_POS_FRAC;
  out.y = h * AREA_POS_FRAC;
  out.w = w * AREA_SIZE_FRAC;
  out.h = h * AREA_SIZE_FRAC;
};

/**
 * 团状轮廓：绕中心每条射线上取**最远**的一处圆周。
 *
 * 取最远而不是去求这几圆真正的并集边界：这团东西对中心是星形的
 * （没有哪条射线先进后出两趟），于是射线最大值给出来的就是外圈那一串鼓包。
 * 底沿压平：落在平边以下的点抬上来，相邻两点之间自然连成一条直线。
 */
function cloudOutline(samples: number, flatY: number, out: Float32Array): void {
  for (let i = 0; i < samples; i++) {
    const th = (TAU * i) / samples;
    const dx = Math.cos(th);
    const dy = Math.sin(th);
    let far = 0;
    for (let c = 0; c < CLOUD_CIRCLES.length; c++) {
      const [px, py, r] = CLOUD_CIRCLES[c];
      // 射线 t·dir 与圆 (p, r) 相交：t² − 2t(dir·p) + (p·p − r²) = 0
      const b = dx * px + dy * py;
      const disc = b * b - (px * px + py * py - r * r);
      if (disc <= 0) continue;
      const t = b + Math.sqrt(disc);
      if (t > far) far = t;
    }
    out[i * 2] = dx * far;
    out[i * 2 + 1] = Math.min(dy * far, flatY);
  }
}

/**
 * 把轮廓铺进 `avail` 的缩放。**从外接盒量，不从某一个圆量**——
 * 原来写死 `minf(size.x, size.y) / 300.0`，而这个 300 是按 720p 窗口手调的：
 * 实测轮廓外接盒 130×67，1280×720 上缩放 2.4 得到 312px 宽，压在 896px 宽的板子
 * 正中间——板子四周空出一大片，描边区小到点不准。
 */
function fitScale(pts: Float32Array, n: number, availW: number, availH: number): number {
  if (n < 2 || availW <= 0 || availH <= 0) return 1;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], y = pts[i * 2 + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const sx = maxX - minX, sy = maxY - minY;
  if (sx <= 0 || sy <= 0) return 1;
  return Math.min((availW * FIT_FRAC) / sx, (availH * FIT_FRAC) / sy);
}

/**
 * 操作提示行的行盒（`textWpx` 是这串字量出来的宽度）。
 *
 * 原来这行字落在 `h * 0.8`，而 720p 上要描的云下缘在 563px、那行字的基线在
 * 576px——**玩家的字就横穿在要描的那条轮廓上**，描线时一直压着图形。
 * 所以判据是"两个 y 区间不相交"，不是"落在某个绝对位置"。
 *
 * 落位按顺序试，取第一个**整行都在屏内**的：
 *   ① 图形下缘与条上沿之间那段空白（题面要的那一段）
 *   ② 条与刻痕标签的下面
 *   ③ 板子上沿（title 之下）
 * ① 是常态。②③ 只在板子占满整屏高度的窄高视口上才轮得到——那时图形下缘离条
 * 太近，硬塞进去就压到条上，而压在条上和压在图形上是同一种毛病。
 */
function hintTop(h: number, boardBottomY: number, bar: Rect): number {
  const c1 = boardBottomY + HINT_GAP;
  const c2 = tickLabelBottom(bar) + HINT_GAP;
  const c3 = h * AREA_POS_FRAC - HINT_LINE_H - HINT_GAP;
  if (c1 >= HINT_GAP && c1 + HINT_LINE_H <= h - HINT_GAP) return c1;
  if (c2 >= HINT_GAP && c2 + HINT_LINE_H <= h - HINT_GAP) return c2;
  if (c3 >= HINT_GAP && c3 + HINT_LINE_H <= h - HINT_GAP) return c3;
  // 三处都塞不下（视口比这一屏该有的样子还矮）：贴中间，别掉出屏外。
  return Math.max(HINT_GAP, (h - HINT_LINE_H) * 0.5);
}

// ---------------------------------------------------------------- 本体

class CloudGame implements MiniGame {
  readonly id = 'cloud' as const;

  private readonly c: MiniGameContext;
  private readonly sh: Shell;
  private finished = false;

  /** 轮廓采样点（屏幕坐标，扁平成 x,y）。预先分配，绝不每帧重建。 */
  private readonly path = new Float32Array(OUTLINE_SAMPLES * 2);
  /** 相邻两点的距离。预先算好，`updateDraw` 里只做加法。 */
  private readonly segLen = new Float32Array(OUTLINE_SAMPLES);
  private readonly board: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private readonly bar: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private readonly cancelBtn: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private pathBottomY = 0;
  private totalLen = 0;
  private followedLen = 0;
  private ratio = 0;
  /** 下一个**还没记过分**的段序号。见 `_updateDraw` 里那段注释。 */
  private nextSeg = 0;

  private started = false;
  private dragging = false;

  /** 键盘光标。 */
  private kx = 0;
  private ky = 0;
  private kDown = false;
  private keyCursorInit = false;

  /** 跑表用的单调时钟（秒）。用来节流笔触音——`Date.now()` 每次调用都要过
   *  系统调用，而且它是墙上时间、暂停/恢复会跳。 */
  private clock = 0;
  private brushLast = -999;

  constructor(ctx: MiniGameContext) {
    this.c = ctx;
    this.sh = makeShell(ctx);
    ctx.audio.duckAmbient(true);
    this.layout(ctx.width, ctx.height);
  }

  private layout(w: number, h: number): void {
    this.sh.w = w;
    this.sh.h = h;
    areaRectInto(this.board, w, h);
    // 取消按钮的落位：画它和判它热区读的是同一份，见 onPointerDown 那条注释
    cancelRectInto(this.cancelBtn, w, h);
    cloudOutline(OUTLINE_SAMPLES, FLAT_Y, this.path);
    const sc = fitScale(this.path, OUTLINE_SAMPLES, this.board.w, this.board.h);
    // 按外接盒中心对位，不按原点。轮廓本身不对称（底被压平了），
    // 绕原点缩放再摆到板心，云会整体偏上，板子下沿空出一条。
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < OUTLINE_SAMPLES; i++) {
      const x = this.path[i * 2], y = this.path[i * 2 + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const cx = this.board.x + this.board.w * 0.5 - (minX + maxX) * (sc * 0.5);
    const cy = this.board.y + this.board.h * 0.5 - (minY + maxY) * (sc * 0.5);
    let bottom = -Infinity;
    let len = 0;
    for (let i = 0; i < OUTLINE_SAMPLES; i++) {
      const x = cx + this.path[i * 2] * sc;
      const y = cy + this.path[i * 2 + 1] * sc;
      this.path[i * 2] = x;
      this.path[i * 2 + 1] = y;
      if (y > bottom) bottom = y;
      if (i > 0) {
        const px = this.path[i * 2 - 2], py = this.path[i * 2 - 1];
        const d = Math.hypot(x - px, y - py);
        this.segLen[i - 1] = d;
        len += d;
      }
    }
    this.pathBottomY = bottom;
    this.totalLen = len;
    // 原作在 resize 里只重算总长、不重算完成度，于是中途拉一次窗口，条上的百分比
    // 就和 `_next_seg` 认领的那一段对不上号。这里跟着总长一起重算——门槛 0.75
    // 一个字没动，只是不让读数停在旧分辨率的份上。
    this.ratio = len > 0 ? Math.min(Math.max(this.followedLen / len, 0), 1) : 0;
    if (!this.keyCursorInit && OUTLINE_SAMPLES > 0) {
      this.kx = this.path[0];
      this.ky = this.path[1];
      this.keyCursorInit = true;
    }
  }

  // ------------------------------------------------------------ 结束

  private finish(r: MiniGameResult): void {
    if (this.finished) return;
    this.finished = true;
    this.c.audio.duckAmbient(false);
    this.c.onDone(r);
  }

  // ------------------------------------------------------------ 输入

  private distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const abx = bx - ax, aby = by - ay;
    const l2 = abx * abx + aby * aby;
    const t = l2 < 1e-12 ? 0 : Math.min(Math.max(((px - ax) * abx + (py - ay) * aby) / l2, 0), 1);
    return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
  }

  /**
   * 落笔推进。**鼠标拖和键盘挪都只在这一条路上汇合**，判成功/失败共用同一份进度。
   *
   * 这里就是原作最贵的一条教训：原来 `_update_draw` 每调一次就记 `段长 * 0.1`，
   * 而它不记得哪几段已经记过。于是"按住空格在原地左右晃"就能对同一段反复计分——
   * 实测在第 0 段中点来回晃 60 次，完成度就冲到 78.1%，越过 75% 的及格线：
   * 这是一个"描边"游戏，却不描边也能赢。（更早一版修的是"光标停着不动也涨"，
   * 那个是挂在 `_process` 上按帧累加的锅，晃一晃就绕过去了。）
   *
   * 只认"下一段"就够了，不必再开一个 claimed 数组：顺序推进天然保证每段至多记一次，
   * 而且描边本来就是一个顺序动作。允许**跳过**中间几段并把它们一起记上：鼠标甩得够快
   * 时一帧只送来终点，nearest 会直接落到后面两段，只认"下一段"的话 `nextSeg` 就卡死
   * 在没描到的那一段上，后面整条云再也描不完。往后跳不往前退，所以跳过也不给刷分的
   * 机会——想往前补就得真的把光标挪回去。
   */
  private updateDraw(px: number, py: number): void {
    if (OUTLINE_SAMPLES < 2) return;
    let minDist = Infinity;
    let segIdx = 0;
    for (let i = 0; i < OUTLINE_SAMPLES - 1; i++) {
      const d = this.distToSegment(px, py, this.path[i * 2], this.path[i * 2 + 1], this.path[i * 2 + 2], this.path[i * 2 + 3]);
      if (d < minDist) { minDist = d; segIdx = i; }
    }
    if (minDist >= PATH_TOLERANCE) return;
    if (segIdx < this.nextSeg) return;
    for (let i = this.nextSeg; i <= segIdx; i++) this.followedLen += this.segLen[i];
    this.nextSeg = segIdx + 1;
    this.ratio = this.totalLen > 0 ? Math.min(Math.max(this.followedLen / this.totalLen, 0), 1) : 0;
    // 笔触音挂在这里：两条输入路径只在这一处汇合，别在两处各放一个。
    if (this.clock - this.brushLast >= BRUSH_SFX_MIN_SEC) {
      this.brushLast = this.clock;
      this.c.audio.sfx('cloud_brush');
    }
  }

  onPointerDown(x: number, y: number): void {
    if (this.finished) return;
    // 热区判在"当成落笔"之前，顺序反了就变成点了取消反而落一笔。
    if (pointInRect(this.cancelBtn, x, y)) { this.finish('cancel'); return; }
    this.dragging = true;
    if (OUTLINE_SAMPLES > 0 && Math.hypot(x - this.path[0], y - this.path[1]) < PATH_TOLERANCE) {
      this.started = true;
    }
  }

  onPointerMove(x: number, y: number): void {
    if (this.finished) return;
    if (this.dragging && this.started) this.updateDraw(x, y);
  }

  onPointerUp(_x: number, _y: number): void {
    if (this.finished) return;
    this.dragging = false;
    if (this.started && this.ratio >= SUCCESS_THRESHOLD) this.finish('win');
    this.started = false;
  }

  onKeyDown(key: string, _shift: boolean): boolean {
    if (this.finished) return false;
    if (key === 'Escape') { this.finish('cancel'); return true; }
    if (key === 'Space') {
      this.kDown = true;
      // 落笔的起点要求和鼠标版一样贴着第一个点，否则一按空格进度就从中间起算
      if (OUTLINE_SAMPLES > 0 && Math.hypot(this.kx - this.path[0], this.ky - this.path[1]) < PATH_TOLERANCE) {
        this.started = true;
      }
      return true;
    }
    let dx = 0, dy = 0;
    if (key === 'ArrowLeft' || key === 'KeyA') dx = -1;
    else if (key === 'ArrowRight' || key === 'KeyD') dx = 1;
    else if (key === 'ArrowUp' || key === 'KeyW') dy = -1;
    else if (key === 'ArrowDown' || key === 'KeyS') dy = 1;
    else return false;
    // echo 不拦：按住方向键要能连着走，不然挪一格就得松一次
    this.kx = Math.min(Math.max(this.kx + dx * KEY_STEP, 0), this.sh.w);
    this.ky = Math.min(Math.max(this.ky + dy * KEY_STEP, 0), this.sh.h);
    // 进度只跟「光标真的挪了」挂钩。不能挂 step 上按帧累加：
    // updateDraw 每调一次就记一段路的长度，光标停着不动也会照样涨——
    // 键盘长按空格就能原地刷满，跟描边的本意完全相反。
    if (this.kDown && this.started) this.updateDraw(this.kx, this.ky);
    return true;
  }

  onKeyUp(key: string): boolean {
    if (key !== 'Space') return false;
    if (this.finished) return true;
    this.kDown = false;
    if (this.started && this.ratio >= SUCCESS_THRESHOLD) this.finish('win');
    this.started = false;
    return true;
  }

  cancel(): boolean {
    if (this.finished) return true;
    this.finish('cancel');
    return true;
  }

  step(dt: number): void {
    this.clock += dt;
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
    const paper = this.sh.paper;
    const dim = this.sh.dim;
    const accent = this.sh.accent;

    drawBackdrop(g, w, h, THEME.CLOUD);

    // 游戏区域。这块板子原来是近乎全黑的不透明矩形，压在一片雨后初霁的淡蓝天上
    // 像一块贴上去的补丁；改成半透明，让背景的天光透上来，描边提亮，
    // 轨迹的对比度靠板子的暗而不是靠"不透明"。
    fillRect(g, this.board, 'rgba(41,56,71,0.34)');
    strokeRect(g, this.board, 'rgba(255,255,255,0.55)', 2);

    drawTextCentered(g, tf(this.sh, 'mg_cloud_title'), w, h * 0.1, 28, paper);

    // 云本身：一层压淡的实心剪影。原来只有一圈点和虚线，中间是透出天光的空板子——
    // 玩家描的是"一个圈"，而"云"是这块圈围出来的**面**。
    g.fillStyle = 'rgba(240,247,255,0.22)';
    g.beginPath();
    g.moveTo(this.path[0], this.path[1]);
    for (let i = 1; i < OUTLINE_SAMPLES; i++) g.lineTo(this.path[i * 2], this.path[i * 2 + 1]);
    g.closePath();
    g.fill();

    // 描过的笔迹。一个"描边"游戏原本**一笔都不画**——进度只由那个百分比承担，
    // 而百分比是抽象的：玩家看不见自己画到哪儿了，只知道它在涨。
    // 笔迹就是 `nextSeg` 本身：段是顺序认领的，所以"已经描过的"恰好等于
    // 0..nextSeg 这一段前缀，不用另记一份数据。
    if (this.nextSeg >= 2 && this.nextSeg <= OUTLINE_SAMPLES - 1) {
      g.strokeStyle = 'rgba(140,219,255,0.95)';
      g.lineWidth = 5;
      g.beginPath();
      g.moveTo(this.path[0], this.path[1]);
      for (let i = 1; i <= this.nextSeg; i++) g.lineTo(this.path[i * 2], this.path[i * 2 + 1]);
      g.stroke();
    }

    // 目标轨迹（虚线）。板子现在是半透明的，底下是随高度变化的天光，纯白的点
    // 在天亮的那一段会淡掉 —— 每个点先压一道深色晕再点白心。
    for (let i = 0; i < OUTLINE_SAMPLES; i++) {
      const px = this.path[i * 2], py = this.path[i * 2 + 1];
      if (i < OUTLINE_SAMPLES - 1) {
        // 已经描过的那一段不再压虚线，免得笔迹被盖回去
        if (i < this.nextSeg) continue;
        line(g, px, py, this.path[i * 2 + 2], this.path[i * 2 + 3], 'rgba(26,36,46,0.35)', 4);
        line(g, px, py, this.path[i * 2 + 2], this.path[i * 2 + 3], 'rgba(255,255,255,0.72)', 2);
      }
      if (i > this.nextSeg) {
        circle(g, px, py, 7, 'rgba(26,36,46,0.40)');
        circle(g, px, py, 5, 'rgba(255,255,255,0.92)');
      }
    }

    // 进度条。**门槛要画在条上**：原来只把 75% 写在字里（"到 75% 算过"），而条是
    // 一条填到头就赢的槽——玩家看着 40% 不知道那是还有一半的路，还是差得远。
    // 刻痕跨在条外，门槛之后那一截底色也更亮。
    barRectInto(this.bar, w, h, BAR_Y_FRAC, BAR_W_FRAC, BAR_H);
    drawBar(g, this.bar, this.ratio, SUCCESS_THRESHOLD, accent, 'rgb(51,51,51)',
      'rgba(255,255,255,0.55)', 'rgb(255,217,89)', 'rgb(107,107,107)');
    // 把及格线一起报出来。原来只写"完成度 62%"，玩家不知道 62% 到底算不算赢，
    // 于是描到边缘也不知道是差一口还是早就能松手了 —— 一个没有任何参照的百分比。
    drawText(g, tf(this.sh, 'mg_complete', Math.floor(this.ratio * 100), Math.floor(SUCCESS_THRESHOLD * 100)),
      this.bar.x, this.bar.y - 8, 18, paper, 'left', this.bar.w);
    // 刻痕上的那个数。字里报了一次、条上报一次，两处是同一个常量——差一步就是
    // "刻痕在 75%、字里写 70%"，而那正是玩家会拿去做决定的那个数。
    // 落位走 tickLabelX/Y：宽度那个参数是**裁切宽度**，给窄了百分号被切掉，
    // 图上只剩「75」——这只有定妆照看得见。y 是**基线**（Godot 的 position.y 同理）。
    drawText(g, `${Math.floor(SUCCESS_THRESHOLD * 100)}%`, tickLabelX(this.bar, SUCCESS_THRESHOLD),
      tickLabelY(this.bar), TICK_LABEL_FONT, 'rgb(255,217,89)', 'center', TICK_LABEL_W);

    drawCancel(g, this.cancelBtn, tf(this.sh, 'mg_cancel'));

    // 键盘光标：没有它键盘玩家看不见自己在哪儿，只能盲按方向键
    line(g, this.kx - 9, this.ky, this.kx + 9, this.ky, accent, 2);
    line(g, this.kx, this.ky - 9, this.kx, this.ky + 9, accent, 2);

    // 操作提示行。落位走 `hintTop()`：原来它写死 `h * 0.8`，而 720p 上要描的云下缘
    // 在 563px、这行字的基线在 576px——**字横穿在要描的那条轮廓上**。
    const hintText = tf(this.sh, 'mg_cloud_hint');
    const hintW = Math.max(textW(g, hintText, HINT_FONT), 1) + 4;
    const top = hintTop(h, this.pathBottomY, this.bar);
    // 基线，不是行盒顶：字形要从行盒顶往下长
    drawText(g, hintText, (w - hintW) * 0.5, top + textAscent(g, HINT_FONT), HINT_FONT, dim);
  }
}

export function createCloudGame(ctx: MiniGameContext): MiniGame {
  return new CloudGame(ctx);
}
