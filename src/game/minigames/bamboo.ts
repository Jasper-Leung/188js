/**
 * 竹雨庭(14) 小游戏：挥刀斩竹 —— 夜雨停后，庭里的老竹被风激起来，
 * 一段段往上抛。玩家**挥刀**把它们斩断，斩断的那一瞬竹节上会甩出雨水。
 *
 * ## 为什么是「挥刀」而不是「按空格」
 *
 * 原来是 QTE：五根竹子依次冒头，1.2s 内按空格。玩法上它和另外四件乐事
 * （按住注水、描云、弹琴、认鸟）没有任何区别——**都是"在正确的时刻按一下"**，
 * 于是竹雨庭这一屏既不读得出「这是砍竹」，也读不出这是哪座驿站。
 *
 * 改成水果忍者那一套之后，动词变成了**挥刀**：指针拖过的地方就是刀锋，
 * 竹段被斩开成两截、溅出水珠。玩家记住的是"我挥过去的那一刀"，
 * 而不是"我在某个时刻按了某个键"。
 *
 * ## 键盘通路仍然完整可玩（这一条不许退化）
 *
 * 指针不是唯一入口：← → / A D 移动**刀位**，**空格**在刀位上挥一刀。
 * 键盘玩家做的事和指针玩家是同一件事——选一个位置、把刀挥过去。
 * 两条通路共用同一个 `doSlash()`，所以命中判定只有一份。
 *
 * ## 胜负
 *
 * · 砍满 `TARGET` 段 → `win`
 * · 命（`LIVES`）耗尽，或时限到 → `lose`
 * · Esc / 取消热区 → `cancel`
 *
 * **砍竹刺掉一命，漏掉竹段不掉命**——漏掉的代价是"目标凑不齐"，
 * 时限到了自然就输了。把漏接也算掉命会让这一屏变成手速题，
 * 而这一站要讲的是"把光放出来"，不是"手要快"。
 *
 * ## 成功画面期间不给 ESC
 *
 * 那 1.6s 是给玩家确认"是我砍赢的"，跳过它就回到"小游戏凭空消失"
 * 那个老毛病（详见 `minigameHost.ts` 与云/茶那两屏的同类注释）。
 */
import {
  barRectInto,
  cancelRectInto,
  drawBackdrop,
  drawCancel,
  drawPips,
  drawText,
  drawTextCentered,
  fillRect,
  makeShell,
  pointInRect,
  THEME,
  tf,
  type Rect,
  type Shell,
} from './chrome';
import type { MiniGame, MiniGameContext, MiniGameResult } from './types';

// ---------------------------------------------------------------- 玩法常量

/** 砍够这么多段就算赢。时限 26s，每波 1~3 段，实际会抛出 16 段上下——
 *  也就是说**不能漏**。凑不齐就是超时，也就是 `lose`。 */
const TARGET = 12;
/** 命。砍到竹刺掉一命，三次就出局。 */
const LIVES = 3;
/** 一局时长。必须小于宿主那道 30s 兜底（`minigameHost.ts:29`），
 *  否则"自己计时结束"和"宿主收尸"会同时发生，玩家看到的是超时文案而不是输。 */
const ROUND_SEC = 26.0;
/** 砍完最后一刀后的停留。见文件头注释。 */
const SUCCESS_HOLD_SEC = 1.6;
/** 开场引导期。玩家第一反应多半是拖一下 / 按一下空格——那一下不算失手。 */
const INTRO_SEC = 0.9;

/** 两波之间的空档。会随剩余时间收窄（见 `waveGap()`）。 */
const WAVE_GAP_BASE = 0.95;
const WAVE_GAP_MIN = 0.52;
/** 每一波抛几段。1 段是"送分"，3 段是"手不够用"。 */
const WAVE_MAX = 3;
/** 第几波开始出现竹刺。前三波让人先学会"拖一下"。 */
const BURR_FROM_WAVE = 3;
/** 每波最多带一个竹刺。多了就不是"避开"而是"躲"。 */
const BURR_PER_WAVE_CHANCE = 0.42;

/** 重力。按**视口高**取而不是取一个绝对像素值：换分辨率时竹子飞的高度
 *  和滞空时间才是同一个比例，绝对值会让 1080p 上的竹子飞得比 720p 高两倍。 */
const GRAVITY_FRAC = 2.05;
/** 出膛的初速（视口高的几倍）。`-1.42` 配 `GRAVITY_FRAC = 2.05` 时，
 *  顶点约在 `vy²/(2g) = 0.49h`，也就是从屏下抛到接近中线——
 *  留在上面三分之一给标题和进度条。 */
const LAUNCH_VY_FRAC = -1.42;
const LAUNCH_VY_JITTER = 0.16;
/** 横向初速（视口宽的几倍）。不横着飞的话五段会叠在一条线上，
 *  玩家一路竖着划就能全收，张力为零。 */
const LAUNCH_VX_FRAC = 0.42;
const LAUNCH_VX_MIN_FRAC = 0.14;
/** 自转（弧度/秒）。竹段必须自己转——不转的话一段直直的绿柱飞过去，
 *  读起来像一根被丢出去的电线。 */
const SPIN_MIN = 1.4;
const SPIN_MAX = 4.2;

/** 竹段长度与粗细（视口高的几成）。 */
const CULM_LEN_MIN_FRAC = 0.15;
const CULM_LEN_MAX_FRAC = 0.27;
const CULM_W_FRAC = 0.042;
/** 竹刺球半径（视口高的几成）。比竹段粗一圈——"别砍我"要一眼看得出。 */
const BURR_R_FRAC = 0.055;

/** 判定带宽（px）。刀锋不是零宽的线，给一点厚度，
 *  否则差两像素擦过去会被读成"我明明砍到了"。 */
const SLASH_PAD = 10.0;

/** 键盘挥刀的刀位移动速度（视口宽的几倍/秒）与加速度。 */
const BLADE_SPEED_FRAC = 1.15;
const BLADE_ACCEL_FRAC = 7.5;
/** 一刀的时长与跨度。跨度是视口宽的几成——0.1w 约等于四根竹段的宽度，
 *  够键盘玩家"对准了再砍"，又不至于一刀横扫全屏。 */
const CHOP_SEC = 0.17;
const CHOP_SPAN_FRAC = 0.05;
const CHOP_TOP_FRAC = 0.34;

/** 连斩窗口。上一刀之后这么久内再砍中，连击 +1。 */
const COMBO_WINDOW = 1.15;

/** 同屏最多几段。溢出就丢掉最早的一截——真机上不会发生，
 *  但判据会把 30 秒全速推进跑满，得给它一个上限。 */
const MAX_PIECES = 40;
/** 同屏最多几颗水珠。 */
const MAX_DROPS = 72;
/** 一刀甩出几颗水珠。 */
const DROPS_PER_CUT = 9;
/** 刀锋拖尾记几个点。 */
const TRAIL_N = 18;

// ---------------------------------------------------------------- 颜色

const SKIN = 'rgb(77,158,82)';
const SKIN_LO = 'rgb(51,115,56)';
const NODE_COL = 'rgb(117,189,102)';
const LEAF_COL = 'rgb(96,170,110)';
/** 竹刺球：干枯发暗，和翠绿的竹段必须在**色相**上就分得开，
 *  只靠"更圆一点"区分是不够的——飞起来的时候两帧里谁也没看清形状。 */
const BURR_HI = 'rgb(122,92,58)';
const BURR_LO = 'rgb(74,54,34)';
/** 夜雨留在竹节上的水。偏冷，和暖色的刀锋拉开。 */
const DROP_COL = 'rgba(198,226,232,0.85)';
/** 刀锋。亮到能压住背景那一层深绿。 */
const BLADE_COL = 'rgba(236,255,240,0.92)';
const BLADE_EDGE = 'rgba(150,226,170,0.55)';
/** 进度条：五格改成十二格（目标就是十二）。 */
const PIP_FILL = 'rgba(77,158,82,0.95)';
const PIP_EMPTY = 'rgba(36,51,41,0.75)';
const PIP_EDGE = 'rgb(255,230,128)';

// ---------------------------------------------------------------- 内部类型

/** 屏幕上的一段东西。整段被斩开后，`seg` 把它拆成两半各跑各的。 */
interface Piece {
  live: boolean;
  /** 竹刺球：砍到掉一命。它不计入进度，落地也不掉命。 */
  burr: boolean;
  x: number;
  y: number;
  /** 段的中心。段沿 (dirX,dirY) 展开，两端是中心 ± dir·len/2。 */
  dirX: number;
  dirY: number;
  len: number;
  vx: number;
  vy: number;
  spin: number;
  /** -1 整段 / 0 下半截 / 1 上半截。 */
  seg: number;
  /**
   * 斩开之后过了多久（秒）。整段为 0。
   *
   * **不能用 `age` 顶替**：`age` 从出膛就开始算，而一段竹子飞了两秒才被砍，
   *  那两秒不该让它在断口上立刻淡出——玩家看到的是"刚被斩开的那一下"。
   */
  splitT: number;
  /** 淡出。0~1，1 是完全不透明。 */
  alpha: number;
  /** 已经记过"漏掉"没有。漏判只该罚一次。 */
  judged: boolean;
  /** 抛出来多久了（秒）。用于"抛得越久越亮"的提示——不必要，但
   *  让玩家能读出"这截已经飞到顶了，正在往下掉"。 */
  age: number;
}

interface Drop {
  live: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  life: number;
  max: number;
}

interface Trail {
  x: number;
  y: number;
  /** 采样时的游戏时间（秒）。老过 `TRAIL_LIFE` 的点直接判死。 */
  t: number;
}

/** 一刀。落点是一段线段而不是一个点——指针是**拖**出来的，
 *  所以刀锋本身就是"上一帧到这一帧扫过的那一段"。 */
interface Slash {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 挥砍动画还剩多久。过期就不再参与判定（见 `slashActive`）。 */
  life: number;
}

const TRAIL_LIFE = 0.16;
/** 竹段飞出屏幕下沿多少算"漏了"。给一点余量，
 *  否则玩家明明看到它已经掉出画面却还没掉命。 */
const MISS_MARGIN = 0.06;

// ---------------------------------------------------------------- 小工具

/** 确定性随机。同一趟重玩是同一局（宿主的 `seed` 契约）。 */
class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = (seed >>> 0) || 1;
  }
  next(): number {
    // xorshift32
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  /** ±`m` */
  sym(m: number): number {
    return (this.next() * 2 - 1) * m;
  }
}

/** 点到线段的距离（`p` 是否落在 `a`~`b` 这条线上，加 `pad` 厚度）。 */
function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 <= 1e-6) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** 两条线段是否相交。竹段与刀锋都用线段表示，所以这是精确判定，
 *  不是"中心点进半径"那种近似——后者会让斜着飞的长竹段判不准。 */
function segsCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const r1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const r2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const r3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const r4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return ((r1 > 0) !== (r2 > 0)) && ((r3 > 0) !== (r4 > 0));
}

/** 一根竹子的四边形：底宽 `wBase`、顶窄 `wTip`，从 (bx,by) 往 (dirX,dirY) 长 `height`。
 *
 * 和原来那一版共用同一个算式——**那一版的收分与竹节是这一版能直接继承的
 * 全部资产**，而它当初被调对过一次（叶宽只有叶长的十五分之一那件事）。
 * 换玩法不该顺手把画法也换了：竹子长什么样与玩法无关，玩家认得出"这是竹子"
 *  靠的是同一套形状。 */
function stalkPath(
  g: CanvasRenderingContext2D,
  bx: number, by: number, dirX: number, dirY: number,
  height: number, wBase: number, wTip: number,
): void {
  const sideX = -dirY;
  const sideY = dirX;
  const tipX = bx + dirX * height;
  const tipY = by + dirY * height;
  g.beginPath();
  g.moveTo(bx - sideX * (wBase * 0.5), by - sideY * (wBase * 0.5));
  g.lineTo(tipX - sideX * (wTip * 0.5), tipY - sideY * (wTip * 0.5));
  g.lineTo(tipX + sideX * (wTip * 0.5), tipY + sideY * (wTip * 0.5));
  g.lineTo(bx + sideX * (wBase * 0.5), by + sideY * (wBase * 0.5));
  g.closePath();
  g.fill();
}

/** 顶上那片叶。把中点沿弦的垂直方向推开半个 `width`，量出来的最大宽度正好是 `width`。 */
function leafPath(
  g: CanvasRenderingContext2D,
  rx: number, ry: number,
  side: number, reach: number, drop: number, width: number,
): void {
  const tipX = rx + side * reach;
  const tipY = ry + drop;
  const cdx = tipX - rx;
  const cdy = tipY - ry;
  const len = Math.hypot(cdx, cdy);
  if (len <= 0) return;
  g.beginPath();
  g.moveTo(rx, ry);
  g.lineTo(rx + (cdx * 0.5 - (cdy / len) * (width * 0.5)), ry + (cdy * 0.5 + (cdx / len) * (width * 0.5)));
  g.lineTo(tipX, tipY);
  g.closePath();
  g.fill();
}

// ---------------------------------------------------------------- 游戏

class BambooGame implements MiniGame {
  readonly id = 'bamboo' as const;

  private readonly c: MiniGameContext;
  private readonly sh: Shell;
  private finished = false;

  private readonly rng: Rng;

  private t = 0;
  private introActive = true;
  private introTimer = INTRO_SEC;

  /** 已砍断的段数。目标 `TARGET`。 */
  private cut = 0;
  private lives = LIVES;
  private combo = 0;
  private comboTimer = 0;
  /** 掉命时的一次性提示字。`lifeFlash > 0` 时画出来。 */
  private lifeFlash = 0;

  private waveIndex = 0;
  private waveTimer = 0.9;
  private elapsed = 0;

  private succeeded = false;
  private successTimer = SUCCESS_HOLD_SEC;

  // ---- 输入通路
  /**
   * 用过指针吗。决定画**刀锋拖尾**还是**刀位光标**。
   *
   * 两条通路都留着，不是因为怕少一条，是因为**玩家自己会换**：
   *  一开始拖着玩，忽然发现用方向键更快，于是改用键盘——
   *  那一下不该让他去适应界面。切换到哪一种，就一直用那一种，
   *  免得两个光标叠在一起。
   */
  private usedPointer = false;
  private pointerDown = false;
  private pointerX = 0;
  private pointerY = 0;

  /** 键盘刀位（视口宽的 0~1）。 */
  private bladeU = 0.5;
  private bladeVel = 0;
  private leftHeld = false;
  private rightHeld = false;
  /** 空格按着。只认"新的一下"，否则长按连发会一路砍穿（见文件头）。 */
  private spaceHeld = false;
  /** 当前这一刀的动画进度 0~1，1 表示挥完。 */
  private chopT = 1;

  private readonly trail: Trail[] = [];
  private readonly slashes: Slash[] = [];
  private readonly pieces: Piece[] = [];
  private readonly drops: Drop[] = [];

  /** 屏幕外的余量。判定"出屏"要用它，不能直接拿 0。 */
  private pad = 0;

  private readonly pbar: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private readonly cancelBtn: Rect = { x: 0, y: 0, w: 0, h: 0 };

  constructor(ctx: MiniGameContext) {
    this.c = ctx;
    this.sh = makeShell(ctx);
    this.rng = new Rng(ctx.seed * 2654435761);
    // 对象池：一次局里抛几十段、溅几百颗水珠，
    // 每帧 new 的话 GC 会插在挥刀那一瞬间，表现为"砍着砍着顿一下"。
    for (let i = 0; i < MAX_PIECES; i++) {
      this.pieces.push({
        live: false, burr: false, x: 0, y: 0, dirX: 1, dirY: 0, len: 0,
        vx: 0, vy: 0, spin: 0, seg: -1, splitT: 0, alpha: 1, judged: false, age: 0,
      });
    }
    for (let i = 0; i < MAX_DROPS; i++) {
      this.drops.push({ live: false, x: 0, y: 0, vx: 0, vy: 0, r: 0, life: 0, max: 1 });
    }
    for (let i = 0; i < TRAIL_N; i++) {
      this.trail.push({ x: 0, y: 0, t: -1 });
    }
    for (let i = 0; i < 6; i++) {
      this.slashes.push({ x0: 0, y0: 0, x1: 0, y1: 0, life: 0 });
    }
    ctx.audio.duckAmbient(true);
    this.layout(ctx.width, ctx.height);
  }

  private layout(w: number, h: number): void {
    this.sh.w = w;
    this.sh.h = h;
    barRectInto(this.pbar, w, h, 0.925, 0.46, 12);
    cancelRectInto(this.cancelBtn, w, h);
    this.pad = h * 0.25;
  }

  private finish(r: MiniGameResult): void {
    if (this.finished) return;
    this.finished = true;
    this.c.audio.duckAmbient(false);
    this.c.onDone(r);
  }

  // ------------------------------------------------------------ 生成

  private spawn(w: number, h: number, burr: boolean): void {
    const p = this.pieces.find((q) => !q.live);
    if (!p) return;
    const dirSign = this.rng.next() < 0.5 ? 1 : -1;
    const a = this.rng.range(-0.9, 0.9) + (dirSign > 0 ? 0 : Math.PI);
    p.live = true;
    p.burr = burr;
    p.x = w * this.rng.range(0.16, 0.84);
    p.y = h * 1.08;
    // 初始朝向：大致竖着但带一点斜。竖直的一柱飞上去读起来像被丢上去的电线，
    //  带 0.3~1.2 弧度的斜角才像被风激起来的。
    p.dirX = Math.cos(a);
    p.dirY = Math.sin(a);
    p.len = burr
      ? h * BURR_R_FRAC * 2
      : h * this.rng.range(CULM_LEN_MIN_FRAC, CULM_LEN_MAX_FRAC);
    p.vx = this.rng.sym(LAUNCH_VX_FRAC) * w;
    if (Math.abs(p.vx) < w * LAUNCH_VX_MIN_FRAC) {
      p.vx = (p.vx < 0 ? -1 : 1) * w * LAUNCH_VX_MIN_FRAC;
    }
    p.vy = h * (LAUNCH_VY_FRAC + this.rng.sym(LAUNCH_VY_JITTER));
    p.spin = (this.rng.next() < 0.5 ? -1 : 1) * this.rng.range(SPIN_MIN, SPIN_MAX);
    p.seg = -1;
    p.splitT = 0;
    p.alpha = 1;
    p.judged = false;
    p.age = 0;
  }

  /** 抛一波。1~3 段，可能夹一个竹刺。 */
  private spawnWave(w: number, h: number): void {
    const n = this.rng.next() < 0.34 ? 1 : this.rng.next() < 0.62 ? 2 : WAVE_MAX;
    for (let i = 0; i < n; i++) this.spawn(w, h, false);
    const late = this.elapsed / ROUND_SEC;
    if (this.waveIndex >= BURR_FROM_WAVE && this.rng.next() < BURR_PER_WAVE_CHANCE * (1 + late)) {
      this.spawn(w, h, true);
    }
    this.waveIndex++;
  }

  /** 越到后面空档越短。这是这一屏唯一的难度曲线。 */
  private waveGap(): number {
    const t = Math.min(Math.max(this.elapsed / ROUND_SEC, 0), 1);
    return WAVE_GAP_BASE + (WAVE_GAP_MIN - WAVE_GAP_BASE) * t;
  }

  // ------------------------------------------------------------ 命中

  /** 一段竹子的两端。 */
  private ends(
    p: Piece,
  ): [number, number, number, number] {
    const hx = (p.dirX * p.len) / 2;
    const hy = (p.dirY * p.len) / 2;
    return [p.x - hx, p.y - hy, p.x + hx, p.y + hy];
  }

  /**
   * 落一刀。指针拖过来和键盘挥刀都走这里——**命中判定只有一份**。
   * 两个入口各写一份的话，迟早两边会漂，而漂了以后的症状是
   * 「同一个位置，鼠标砍得到键盘砍不到」，没人说得清为什么。
   */
  private doSlash(x0: number, y0: number, x1: number, y1: number): void {
    const s = this.slashes.find((q) => q.life <= 0);
    if (!s) return;
    s.x0 = x0; s.y0 = y0; s.x1 = x1; s.y1 = y1;
    s.life = 0.13;
    for (const p of this.pieces) {
      if (!p.live || p.seg !== -1 || p.judged) continue;
      const [ax, ay, bx, by] = this.ends(p);
      const hit = segsCross(ax, ay, bx, by, x0, y0, x1, y1)
        || distToSeg(p.x, p.y, x0, y0, x1, y1) < SLASH_PAD;
      if (hit) this.slice(p, x0, y0, x1, y1);
    }
  }

  /**
   * 把一段竹子斩成两半。
   *
   * 断点取刀锋与竹身中线最近的投影点——不是几何中心。玩家挥一刀过去，
   * 期望看到的是"从我这一刀切下去"，而不是"从正中间断"。
   */
  private slice(p: Piece, x0: number, y0: number, x1: number, y1: number): void {
    const [ax, ay, bx, by] = this.ends(p);
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = 0.5;
    if (l2 > 1e-6) {
      t = ((x0 - ax) * dx + (y0 - ay) * dy) / l2;
      t = t < 0.12 ? 0.12 : t > 0.88 ? 0.88 : t;
    }
    const cxp = ax + dx * t;
    const cyp = ay + dy * t;

    if (p.burr) {
      // 竹刺不是竹段：不劈开，直接碎成几片水珠似的碎屑判负。
      p.live = false;
      this.burstDrops(cxp, cyp, 10, p.dirX, p.dirY);
      this.loseLife();
      this.c.audio.sfx('open');
      return;
    }

    // 下半截留在原处；上半截另起一个对象，从断点继续飞。
    const lowerLen = p.len * t;
    const upperLen = p.len * (1 - t);

    p.x = ax + (dx * t) / 2;
    p.y = ay + (dy * t) / 2;
    p.len = lowerLen;
    p.seg = 0;
    p.splitT = 0;
    p.judged = true;

    const up = this.pieces.find((q) => !q.live);
    if (up) {
      up.live = true;
      up.burr = false;
      up.seg = 1;
      up.splitT = 0;
      up.judged = true;
      up.alpha = 1;
      up.age = p.age;
      // 上半截接着原速度，再**沿刀锋方向**甩一下——断开的瞬间它是被刀
      //  挑出去的，不是自己继续走的。这一下是"手感"的主要来源。
      // 上半截的中心是断点 C 再往前挪**上半截自己那半个长度**，
      // 不是下半截的：写成 `lowerLen` 会把它放到 C 的另一侧，
      // 两截会在断口上交错穿过去，而那一下肉眼完全看不出来。
      up.x = cxp + (p.dirX * upperLen) / 2;
      up.y = cyp + (p.dirY * upperLen) / 2;
      up.len = upperLen;
      up.dirX = p.dirX;
      up.dirY = p.dirY;
      const sx = x1 - x0;
      const sy = y1 - y0;
      const sl = Math.hypot(sx, sy) || 1;
      const push = this.sh.h * 0.16;
      up.vx = p.vx + (sx / sl) * push;
      up.vy = p.vy + (sy / sl) * push;
      up.spin = p.spin * 1.35;
    }

    this.burstDrops(cxp, cyp, DROPS_PER_CUT, p.dirX, p.dirY);
    this.onCut();
  }

  /** 夜雨留在竹节上的水。一刀下去全甩出来。 */
  private burstDrops(x: number, y: number, n: number, dirX: number, dirY: number): void {
    let made = 0;
    for (const d of this.drops) {
      if (made >= n) break;
      if (d.live) continue;
      d.live = true;
      d.x = x;
      d.y = y;
      // 沿竹身法向甩开，再加一点随机——全沿刀锋方向的话像喷水枪，
      //  那读起来是"被打中"，不是"被斩开"。
      const nx = -dirY;
      const ny = dirX;
      const side = made % 2 === 0 ? 1 : -1;
      const spread = this.rng.range(0.35, 1.0);
      d.vx = nx * side * spread * this.sh.w * 0.42 + this.rng.sym(this.sh.w * 0.12);
      d.vy = ny * side * spread * this.sh.h * 0.42 + this.rng.sym(this.sh.h * 0.12) - this.sh.h * 0.1;
      d.r = this.rng.range(1.6, 3.6);
      d.max = this.rng.range(0.42, 0.8);
      d.life = d.max;
      made++;
    }
  }

  private onCut(): void {
    this.cut++;
    if (this.comboTimer > 0) this.combo++;
    else this.combo = 1;
    this.comboTimer = COMBO_WINDOW;
    this.c.audio.sfx('bamboo_cut');
    if (this.cut >= TARGET) this.enterSuccess();
  }

  private loseLife(): void {
    this.lives--;
    this.combo = 0;
    this.comboTimer = 0;
    this.lifeFlash = 0.9;
    if (this.lives <= 0) this.finish('lose');
  }

  /** 进入成功画面并停留，期间不接受任何输入。 */
  private enterSuccess(): void {
    if (this.succeeded) return;
    this.succeeded = true;
    this.successTimer = SUCCESS_HOLD_SEC;
  }

  // ------------------------------------------------------------ 输入

  /**
   * 返回 true 表示"吃掉了这次按键"（宿主据此阻止空格继续走全局 interact）。
   * 顺序：成功画面吞键 → ESC → 取消热区是**指针**的事 → 引导期 → 方向键 → 空格。
   */
  onKeyDown(key: string, _shift: boolean): boolean {
    if (key === 'Space' && this.spaceHeld) return true;
    if (this.finished) return false;
    if (this.succeeded) {
      if (key === 'Space') this.spaceHeld = true;
      return key === 'Space';
    }
    // ESC 取消。成功画面期间不给 ESC（见文件头注释）。
    if (key === 'Escape') { this.finish('cancel'); return true; }

    switch (key) {
      case 'ArrowLeft': case 'KeyA':
        this.usedPointer = false;
        this.leftHeld = true;
        return true;
      case 'ArrowRight': case 'KeyD':
        this.usedPointer = false;
        this.rightHeld = true;
        return true;
      default:
        break;
    }

    if (key !== 'Space') return false;
    // 引导期提前按也算数——而且**引导期这一刀是真的挥出去**的。
    //
    // **这里必须置 `spaceHeld = true`，与 QTE 那一版正好相反。**
    // 那一版刻意不置：它引导期按的那一下不算一刀（只是提前结束引导），
    // 得靠浏览器的按键重复把第一刀补上，否则引导期就按住空格的玩家
    // 会丢掉第一根。换成挥刀之后 `chopNow()` 照常执行，
    // 于是必须立刻置 held——否则按键重复会在 30ms 后递上第二刀，
    // 玩家一路按住空格就一路双刀，而界面上完全看不出多了一刀。
    this.spaceHeld = true;
    if (this.introActive) this.introActive = false;
    this.chopNow();
    return true;
  }

  onKeyUp(key: string): boolean {
    if (key === 'ArrowLeft' || key === 'KeyA') { this.leftHeld = false; return true; }
    if (key === 'ArrowRight' || key === 'KeyD') { this.rightHeld = false; return true; }
    if (key === 'Space') { this.spaceHeld = false; return true; }
    return false;
  }

  /** 键盘通路的那一刀：刀位上一道斜劈。 */
  private chopNow(): void {
    if (this.finished || this.succeeded) return;
    const w = this.sh.w;
    const h = this.sh.h;
    const bx = w * this.bladeU;
    const span = w * CHOP_SPAN_FRAC;
    const x0 = bx - span;
    const y0 = h * 1.02;
    const x1 = bx + span;
    const y1 = h * CHOP_TOP_FRAC;
    this.chopT = 0;
    this.doSlash(x0, y0, x1, y1);
    this.c.audio.sfx('cloud_brush');
  }

  onPointerDown(x: number, y: number): void {
    if (this.finished || this.succeeded) return;
    this.usedPointer = true;
    // 取消热区**必须判在"当成落刀"之前**。反了就成了点取消反而先挨一刀，
    // 而那一刀还带音效——玩家读成"我不小心砍了一刀"。
    if (pointInRect(this.cancelBtn, x, y)) { this.finish('cancel'); return; }
    this.pointerDown = true;
    this.pointerX = x;
    this.pointerY = y;
    // 落刀本身也带一小段挥幅：否则玩家"点一下"永远砍不到东西，
    // 而水果忍者那套手势里点一下本来就该是最短的一刀。
    if (this.introActive) this.introActive = false;
    this.doSlash(x, y, x, y);
  }

  onPointerMove(x: number, y: number): void {
    if (this.finished || this.succeeded) return;
    if (!this.pointerDown) return;
    this.usedPointer = true;
    // 刀锋 = 上一帧到这一帧扫过的那一段。
    this.doSlash(this.pointerX, this.pointerY, x, y);
    this.pushTrail(x, y);
    this.pointerX = x;
    this.pointerY = y;
  }

  onPointerUp(_x: number, _y: number): void {
    this.pointerDown = false;
  }

  private pushTrail(x: number, y: number): void {
    // 环形推进，不用 shift。
    let oldest = 0;
    let oldestT = Infinity;
    for (let i = 0; i < this.trail.length; i++) {
      if (this.trail[i].t < oldestT) { oldestT = this.trail[i].t; oldest = i; }
    }
    this.trail[oldest] = { x, y, t: this.t };
  }

  cancel(): boolean {
    // 成功画面期间不给 ESC。
    if (this.finished || this.succeeded) return this.finished;
    this.finish('cancel');
    return true;
  }

  // ------------------------------------------------------------ 步进

  step(dt: number): void {
    this.t += dt;
    if (this.succeeded) {
      this.successTimer = Math.max(this.successTimer - dt, 0);
      if (this.successTimer <= 0) this.finish('win');
      return;
    }
    if (this.finished) return;

    // 键盘刀位永远在走，哪怕玩家在用鼠标——它只是没被画出来。
    this.stepBlade(dt);
    if (this.chopT < 1) this.chopT = Math.min(this.chopT + dt / CHOP_SEC, 1);
    for (const s of this.slashes) s.life = Math.max(s.life - dt, 0);
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 0;
    }
    if (this.lifeFlash > 0) this.lifeFlash = Math.max(this.lifeFlash - dt, 0);

    if (this.introActive) {
      this.introTimer -= dt;
      if (this.introTimer <= 0) this.introActive = false;
    } else {
      this.elapsed += dt;
      // 时限到 = 没凑齐目标，判负。
      if (this.elapsed >= ROUND_SEC) { this.finish('lose'); return; }
      this.waveTimer -= dt;
      if (this.waveTimer <= 0) {
        this.waveTimer = this.waveGap();
        this.spawnWave(this.sh.w, this.sh.h);
      }
    }

    this.stepPieces(dt);
    this.stepDrops(dt);
  }

  private stepBlade(dt: number): void {
    const w = this.sh.w;
    const dir = (this.rightHeld ? 1 : 0) - (this.leftHeld ? 1 : 0);
    const target = dir * w * BLADE_SPEED_FRAC;
    // 加速而不是直接置速度：一刀一停的键盘操作如果瞬时响应，
    // 刀位会在屏幕两端抽搐，反而更难对准抛上来的竹段。
    this.bladeVel += (target - this.bladeVel) * Math.min(BLADE_ACCEL_FRAC * dt, 1);
    this.bladeU += (this.bladeVel * dt) / w;
    if (this.bladeU < 0) { this.bladeU = 0; this.bladeVel = 0; }
    if (this.bladeU > 1) { this.bladeU = 1; this.bladeVel = 0; }
  }

  private stepPieces(dt: number): void {
    const h = this.sh.h;
    const g = h * GRAVITY_FRAC;
    for (const p of this.pieces) {
      if (!p.live) continue;
      p.age += dt;
      p.vy += g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      // 自转：直接改方向向量，省得另存一个 rot 字段再三角函数回去。
      const a = Math.atan2(p.dirY, p.dirX) + p.spin * dt;
      p.dirX = Math.cos(a);
      p.dirY = Math.sin(a);

      if (p.seg >= 0) {
        // 斩开的两截：转着往下掉，0.9s 里淡尽。给 0.9s 是因为
        // 水珠的寿命 0.42~0.8s——水珠要在断口还在的时候落完，
        // 那一下"斩开的地方在漏水"才连得上。
        p.splitT += dt;
        p.alpha = Math.max(0, 1 - p.splitT / 0.9);
      }

      // 出界回收。竹段（非竹刺）从**下沿**出去算漏掉——但**不罚命**：
      // 漏的代价是"目标凑不齐"，时限到了自然输。把漏接也算掉命
      // 会把这一屏变成手速题，而这一站要讲的是"把光放出来"。
      // 竹刺落地不罚，它是"别砍"，砍不到本来就没事。
      if (p.seg < 0 && !p.judged && p.y - p.len > h + h * MISS_MARGIN) {
        p.judged = true;
        p.live = false;
      }
      // 出界回收。左右也收，否则横着飞出去的会一直挂着。
      if (p.y - p.len > h + this.pad || p.x < -this.pad || p.x > this.sh.w + this.pad) {
        p.live = false;
      }
    }
  }

  private stepDrops(dt: number): void {
    const h = this.sh.h;
    const g = h * GRAVITY_FRAC * 0.62;
    for (const d of this.drops) {
      if (!d.live) continue;
      d.life -= dt;
      if (d.life <= 0) { d.live = false; continue; }
      d.vy += g * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      if (d.y > h + this.pad) d.live = false;
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

    drawTextCentered(g, tf(this.sh, 'mg_bamboo_title'), w, h * 0.085, 26, this.sh.paper);
    if (this.introActive) {
      drawTextCentered(g, tf(this.sh, 'mg_bamboo_intro'), w, h * 0.145, 19, this.sh.paper);
    }

    this.drawDrops(g);
    for (const p of this.pieces) {
      if (p.live) this.drawPiece(g, p, h);
    }
    this.drawTrail(g);
    this.drawBladeCursor(g, w, h);
    this.drawHud(g, w, h);

    drawCancel(g, this.cancelBtn, tf(this.sh, 'mg_cancel'));
  }

  /** 一段竹子（整段 / 下半截 / 上半截）或一个竹刺球。 */
  private drawPiece(g: CanvasRenderingContext2D, p: Piece, h: number): void {
    const prevAlpha = g.globalAlpha;
    g.globalAlpha = prevAlpha * p.alpha;
    if (p.burr) {
      const r = p.len / 2;
      // 干枯的刺球：几道朝外的刺 + 一个深色芯。
      g.fillStyle = BURR_LO;
      g.beginPath();
      g.arc(p.x, p.y, r, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = BURR_HI;
      g.lineWidth = Math.max(r * 0.22, 1.5);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + p.age * 1.6;
        const c = Math.cos(a);
        const s = Math.sin(a);
        g.beginPath();
        g.moveTo(p.x + c * r * 0.72, p.y + s * r * 0.72);
        g.lineTo(p.x + c * r * 1.28, p.y + s * r * 1.28);
        g.stroke();
      }
      g.fillStyle = BURR_HI;
      g.beginPath();
      g.arc(p.x - r * 0.22, p.y - r * 0.22, r * 0.34, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = prevAlpha;
      return;
    }

    const [ax, ay, bx, by] = this.ends(p);
    const wid = h * CULM_W_FRAC;
    // 竹身：从段的起点画到终点，宽窄沿长度收分。
    g.fillStyle = SKIN;
    stalkPath(g, ax, ay, p.dirX, p.dirY, p.len, wid, wid * 0.62);
    // 竹节：比竹身宽一点的一道亮环。整段两道，斩开后各留一道——
    // 断口上那道就是"刚被砍开"的现场。
    g.strokeStyle = NODE_COL;
    g.lineWidth = Math.max(wid * 0.16, 1.6);
    g.beginPath();
    for (let n = 0; n < 2; n++) {
      const f = p.seg === 0 ? (n === 0 ? 0.45 : 0.9) : p.seg === 1 ? (n === 0 ? 0.1 : 0.55) : n === 0 ? 0.3 : 0.7;
      const nx = ax + (bx - ax) * f;
      const ny = ay + (by - ay) * f;
      const nx2 = -p.dirY;
      const ny2 = p.dirX;
      const hw = wid * (0.62 + 0.18 * (1 - f)) * 0.5 + wid * 0.12;
      g.moveTo(nx - nx2 * hw, ny - ny2 * hw);
      g.lineTo(nx + nx2 * hw, ny + ny2 * hw);
    }
    g.stroke();
    // 断口
    if (p.seg >= 0) {
      g.strokeStyle = SKIN_LO;
      g.lineWidth = Math.max(wid * 0.2, 2);
      const ex = p.seg === 0 ? bx : ax;
      const ey = p.seg === 0 ? by : ay;
      const nx2 = -p.dirY;
      const ny2 = p.dirX;
      g.beginPath();
      g.moveTo(ex - nx2 * wid * 0.36, ey - ny2 * wid * 0.36);
      g.lineTo(ex + nx2 * wid * 0.36, ey + ny2 * wid * 0.36);
      g.stroke();
    }
    // 梢头那两片叶。只在**上半截还在**的时候画：下半截留着叶梢，
    //  读起来就像竹子倒着长。
    if (p.seg !== 0) {
      g.fillStyle = LEAF_COL;
      const rootX = p.seg === 1 ? bx : bx - (bx - ax) * 0.1;
      const rootY = p.seg === 1 ? by : by - (by - ay) * 0.1;
      for (let s = 0; s < 2; s++) {
        const side = s === 0 ? -1 : 1;
        leafPath(
          g, rootX, rootY,
          side, p.len * (s === 0 ? 0.30 : 0.18),
          p.len * (s === 0 ? 0.10 : 0.22),
          p.len * 0.035,
        );
      }
    }
    g.globalAlpha = prevAlpha;
  }

  private drawDrops(g: CanvasRenderingContext2D): void {
    g.fillStyle = DROP_COL;
    for (const d of this.drops) {
      if (!d.live) continue;
      // 水珠越接近落尽越小——一视同仁地画成同样大的点，
      //  读起来就是"一堆圆点"，不是"溅出来的水"。
      const k = d.life / d.max;
      g.globalAlpha = k * 0.9;
      g.beginPath();
      g.arc(d.x, d.y, d.r * (0.45 + 0.55 * k), 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  /** 指针的刀锋拖尾。 */
  private drawTrail(g: CanvasRenderingContext2D): void {
    if (!this.usedPointer) return;
    g.strokeStyle = BLADE_COL;
    g.lineCap = 'round';
    for (let i = 1; i < this.trail.length; i++) {
      const a = this.trail[i - 1];
      const b = this.trail[i];
      if (a.t < 0 || b.t < 0) continue;
      if (this.t - b.t > TRAIL_LIFE) continue;
      const k = 1 - (this.t - b.t) / TRAIL_LIFE;
      g.lineWidth = 2 + 9 * k * k;
      g.globalAlpha = 0.15 + 0.85 * k;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }
    g.globalAlpha = 1;
    g.lineCap = 'butt';
  }

  /**
   * 键盘刀位光标 + 挥刀动画。
   *
   * 指针玩家不需要它，所以 `usedPointer` 之后它就消失——
   * 两个光标叠在一起，玩家会不知道该看哪个。
   */
  private drawBladeCursor(g: CanvasRenderingContext2D, w: number, h: number): void {
    if (this.usedPointer) return;
    const bx = w * this.bladeU;
    const baseY = h * 0.92;
    // 收刀（rest）到劈出（chop）之间插值。
    const k = this.chopT >= 1 ? 0 : Math.sin(this.chopT * Math.PI);
    const tipX = bx + w * CHOP_SPAN_FRAC * (1 + k * 1.4);
    const tipY = baseY - h * (0.12 + k * 0.52);
    const gripX = bx - w * CHOP_SPAN_FRAC * 0.45;
    const gripY = baseY + h * 0.06;

    g.strokeStyle = BLADE_EDGE;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(gripX, gripY);
    g.lineTo(tipX, tipY);
    g.stroke();
    g.strokeStyle = BLADE_COL;
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo(gripX + (tipX - gripX) * 0.22, gripY + (tipY - gripY) * 0.22);
    g.lineTo(tipX, tipY);
    g.stroke();

    // 落点标记。键盘玩家全靠它对准抛上来的竹段，没有它就得靠猜。
    if (this.chopT >= 1) {
      g.strokeStyle = BLADE_EDGE;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(bx, h * CHOP_TOP_FRAC, 16, 0, Math.PI * 2);
      g.stroke();
    }
  }

  private drawHud(g: CanvasRenderingContext2D, w: number, h: number): void {
    // 命：三片竹叶。**不用文字**——"命 x3"读起来是数值，
    // 而掉一命那一下玩家要的是"少了"，不是"数字变了"。
    const lx = w * 0.045;
    const ly = h * 0.2;
    for (let i = 0; i < LIVES; i++) {
      const on = i < this.lives;
      g.fillStyle = on ? LEAF_COL : 'rgba(120,140,126,0.28)';
      g.beginPath();
      g.moveTo(lx + i * h * 0.055, ly);
      g.quadraticCurveTo(
        lx + i * h * 0.055 + h * 0.018, ly - h * 0.026,
        lx + i * h * 0.055 + h * 0.036, ly,
      );
      g.quadraticCurveTo(
        lx + i * h * 0.055 + h * 0.018, ly + h * 0.026,
        lx + i * h * 0.055, ly,
      );
      g.fill();
    }

    // 时限。倒计时是这一屏唯一的压力来源，不画出来它就只是"等太久"。
    const left = Math.max(ROUND_SEC - this.elapsed, 0);
    const urgent = left <= 5;
    drawText(g, tf(this.sh, 'mg_bamboo_time', Math.ceil(left)), w * 0.955, h * 0.095, 22,
      urgent ? 'rgba(255,150,120,0.95)' : this.sh.paper, 'right', w * 0.955);

    // 连斩
    if (this.combo >= 2) {
      drawTextCentered(g, tf(this.sh, 'mg_bamboo_combo', this.combo), w, h * 0.28, 30,
        'rgba(217,255,191,0.9)');
    }

    // 砍到竹刺的提示
    if (this.lifeFlash > 0) {
      const a = Math.min(this.lifeFlash / 0.4, 1);
      drawTextCentered(g, tf(this.sh, 'mg_bamboo_burr'), w, h * 0.36, 34,
        `rgba(255,150,130,${a})`);
    }

    // 目标：十二格。原版是五格（目标是五根），现在目标是十二段。
    drawPips(g, this.pbar, TARGET, this.cut, this.cut, PIP_FILL, PIP_EMPTY, PIP_EDGE);
    drawTextCentered(g, tf(this.sh, 'mg_progress', Math.min(this.cut, TARGET), TARGET),
      w, h * 0.965, 17, this.sh.paper);
  }

  /** 砍完之后的收尾画面。 */
  private drawSuccess(g: CanvasRenderingContext2D, w: number, h: number): void {
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(0, 0, w, h);

    // 庭里重新透进来的那道光。成功画面不画竹子——这一屏要回答的是
    // 「为什么砍」，所以给它一束光，比给一堆倒竹更对题。
    const fade = Math.min(Math.max(1 - this.successTimer / SUCCESS_HOLD_SEC, 0), 1);
    const a = Math.min(Math.max(0.3 + fade * 2.2, 0), 1);
    const grd = g.createLinearGradient(0, h, 0, h * 0.18);
    grd.addColorStop(0, `rgba(255,238,180,${0.22 * a})`);
    grd.addColorStop(1, 'rgba(255,238,180,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(w * 0.36, h);
    g.lineTo(w * 0.64, h);
    g.lineTo(w * 0.56, h * 0.18);
    g.lineTo(w * 0.46, h * 0.18);
    g.closePath();
    g.fill();

    drawTextCentered(g, tf(this.sh, 'mg_bamboo_done'), w, h * 0.4, 40, `rgba(217,255,191,${a})`);
    drawTextCentered(g, tf(this.sh, 'mg_progress', TARGET, TARGET), w, h * 0.49, 24,
      `rgba(204,255,204,${a})`);

    // 即将结算的进度条
    const barW = w * 0.3;
    const barX = w * 0.5 - barW * 0.5;
    const barY = h * 0.58;
    const left = Math.max(this.successTimer, 0);
    fillRect(g, { x: barX, y: barY, w: barW, h: 8 }, 'rgba(255,255,255,0.18)');
    fillRect(g, { x: barX, y: barY, w: (barW * left) / SUCCESS_HOLD_SEC, h: 8 }, 'rgba(153,230,128,0.8)');
  }
}

export function createBambooGame(ctx: MiniGameContext): MiniGame {
  return new BambooGame(ctx);
}
