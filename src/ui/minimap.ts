/**
 * 小地图 —— 8 字环线 + 16 座驿站 + 玩家 + 「下一处」。
 *
 * ## 它为什么准，比它好不好看重要得多
 *
 * 原作把它叫成"唯一能看见全局的地方"（CLAUDE.md 原话）。顶栏只说"下一处
 * 84m"，脚下提示圈只在你已经站在驿站前面时出现——**除这一张图之外，
 * 玩家没有任何办法判断自己在环上的哪儿、离目标在哪个方向、8 字的两条环
 * 是不是都走过**。所以它一旦不准，坏的不是一张小图，是整个导航：
 * 玩家会照着一张说反了的图骑完整局，而且**永远不知道自己被误导了**。
 *
 * 由此有三条硬要求：
 *
 * 1. **环线用 `CENTERLINE` 全部 961 个点，一条不省。** 8 字是自交的，
 *    抽稀之后两条环在交叉点附近会连错，或者出现一段"跳线"。
 *    这里用全量点 + 一次性缓存（见下）换掉"每帧重画 961 段"的代价。
 * 2. **驿站用 `STATIONS[i].mapX/mapZ`（偏移之前的"原位"），不是 `x/z`。**
 *    `x/z` 是往路肩外推了 18m 的模型落位，用它画图的话 16 个点会整体
 *    偏出路面，贴着路的那一侧挤成一团——而"驿站贴着路"正是这张图
 *    要给玩家的空间直觉。`mapX/mapZ` 才是画布原位，见 route.ts 的注释。
 * 3. **投影只做等比缩放 + 平移，不做旋转也不做翻转。** 8 字本身已经
 *    旋转了 60°（`ROAD.ROT_DEG`），再转一次会让玩家把图上的上和世界上
 *    的上对不上；而 `mapZ` 直接当下标的 y，让世界 +z 朝屏幕下方，
 *    于是图上的下方 = 世界的 +z，和 three 的相机默认朝向（-Z 为前）
 *    是自洽的。
 *
 * ## 每帧只画两个东西
 *
 * 环线、驿站、到访填充、碎片进度弧 —— 这些**只在状态变化时变**，
 * 于是全部烘到一张离屏 canvas 上；每帧只做一次 `drawImage` 把它贴上来，
 * 再画玩家三角和目标指示。省下来的不是"一点路径运算"：961 段 `lineTo`
 * 加 16 个圆，在弱机上每帧重做一次会稳定吃掉一两毫秒，而那正是
 * 「一帧要留给物理」的预算。
 */
import { CENTERLINE, STATIONS } from '../data/route';
import { ECON } from '../data/raw';
import { t } from '../i18n';
import { el } from './dom';
import { ACCENT, INK, INK_FAINT, PAPER_DAY } from './theme';
import type { World } from '../world/world';
import type { GameStateManager } from '../game/state';

/** 基准边长（px）。下面所有绘制常量都是在这个尺寸下量的，缩放时乘 `u`。
 *  **故意不用 rem**：这是一个位图的像素尺寸，
 *  由 JS 读 rect 再乘 dpr 才能得到正确的后备缓冲，用 rem 反而多一层
 *  「布局定完没有」的时序依赖（构造时父节点可能还是 display:none）。 */
const BASE = 168;
/** 环线离画布边留的空白（px）。 */
const PAD = 10;

/**
 * 视口越大，图越大。
 *
 * 原来是**固定 168px**，而这一条是实机评审里玩家读不懂的东西：
 * 1920×1080 的屏幕角落里那个 168px 的方块上，环线只有 1.4px 宽、
 * 玩家三角只有 5px 高——"我现在在哪儿"要靠盯着一个比正文标点还小的
 * 图形去找。屏幕越大，这个方块占的比例越小，而它恰恰是**唯一**一张
 * 全局地图。
 *
 * 跟着视口走之后：手机 150、桌面 200、大屏 248。上限压在 248 是因为
 * 再大它就从"指示"变成"占地方"，而右下角还压着道具栏。
 */
function sizeFor(vw: number): number {
  if (vw >= 1700) return 248;
  if (vw >= 1200) return 200;
  if (vw >= 900) return 176;
  return 150;
}

// ---------------------------------------------------------------- 投影

/**
 * 世界 (x,z) → 画布 (px,py) 的等比映射。
 *
 * 包围盒取 `CENTERLINE` 而不是 `STATIONS`：驿站原位一定在环线上，
 * 而环线才是那个把整个 8 字撑满的形状。按驿站取包围盒会让图偏出去
 * 一圈，而玩家会以为"路比图短"。
 *
 * 边长会随视口变（`sizeFor`），所以它是**函数**而不是模块级常量——
 * 原来它算一次就固定，于是图只能有一个尺寸。
 */
function makeProj(size: number) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of CENTERLINE) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const spanX = Math.max(maxX - minX, 1e-3);
  const spanZ = Math.max(maxZ - minZ, 1e-3);
  const k = (size - PAD * 2) / Math.max(spanX, spanZ);
  // 等比缩放之后在两个轴上各居中一次：8 字不是正方形，不居中就会有一边贴边
  const offX = PAD + (size - PAD * 2 - spanX * k) * 0.5;
  const offZ = PAD + (size - PAD * 2 - spanZ * k) * 0.5;
  return {
    x(wx: number): number {
      return offX + (wx - minX) * k;
    },
    z(wz: number): number {
      return offZ + (wz - minZ) * k;
    },
  };
}

type Proj = ReturnType<typeof makeProj>;

/** 中心线在图上的自交点。`countCrossings()`（route.ts）就是拿 CENTERLINE[0]
 *  当这个点数的，所以这里用同一个来源而不是另算一遍。 */
const CROSSING = CENTERLINE[0];

// ---------------------------------------------------------------- 类

export class Minimap {
  readonly root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** 静态层：环线 + 驿站 + 进度弧。状态没变时一次都不重画。 */
  private base: HTMLCanvasElement;
  private baseCtx: CanvasRenderingContext2D;

  private world: World;
  private game: GameStateManager;

  /** 当前边长与投影。跟着视口走，改了就重画静态层。 */
  private size = BASE;
  private proj: Proj = makeProj(BASE);
  /** 绘制常量的缩放系数：`size / BASE`。所有 px 常量乘它。 */
  private u = 1;
  /** `applySize()` 已经跑过至少一次（用来区分"没定过尺寸"和"尺寸恰好没变"）。 */
  private sized = false;

  private onResize = () => this.applySize();

  private dirty = true;
  /**
   * 静态层当前画的是哪一份状态。
   *
   * 原来这一层靠 `UI.onWorldEvent('stationPassed')` 去 `markDirty()`。
   * 而 `main.ts` 并不把世界事件转发给 `UI.onWorldEvent`（它自己处理
   * 对白、黄昏、开铺子），于是**没有任何人**会去通知小地图：
   * 玩家一路骑过 16 座驿，那张图上的 16 个点会一直是开局那一份。
   * 「到过 = 实心」是这张图唯一的编码，停在开局就等于整局是错的。
   *
   * 所以改成**自己比对状态签名**。代价是每帧 5 次 map 查 + 1 次 set.size，
   * 一次字符串拼接——比一条事件链便宜，而且不依赖谁记得转发。
   */
  private lastSig = '';

  constructor(parent: HTMLElement, world: World, game: GameStateManager) {
    this.world = world;
    this.game = game;

    this.root = el('div', 'g-minimap');
    // canvas 上标一句，让屏幕阅读器知道这张图是什么（读不出来也比没有强）
    this.canvas = el('canvas', 'g-minimap-c');
    this.root.appendChild(this.canvas);
    parent.appendChild(this.root);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('小地图拿不到 2D 上下文');
    this.ctx = ctx;

    this.base = el('canvas');
    const bctx = this.base.getContext('2d');
    if (!bctx) throw new Error('小地图离屏层拿不到 2D 上下文');
    this.baseCtx = bctx;

    // **必须在两张画布都建好之后再定尺寸。**
    //
    // 上一版把 `applySize()` 放在建 `base` 之前，于是它去写
    // `this.base.width` 时 `this.base` 还是 undefined：
    // `TypeError: Cannot set properties of undefined (setting 'width')`
    // 从 `new UI()` 里抛出去，`ready()` 的 promise 拒绝，
    // **启动屏永远停在 62%，标题页出不来，游戏完全玩不了。**
    //
    // 这一条 bug 值得记下来，因为它通过了 typecheck、通过了 25 条 / 277 断言
    // 的全部回归、也通过了 `vite build`——所有只在**运行时**存在的判据
    // 都抓不到"构造函数里少建了一个对象"。唯一的证据来源是实机控制台。
    this.applySize();

    window.addEventListener('resize', this.onResize);
  }

  /**
   * 按视口定边长，重建两张画布的尺寸与投影。
   *
   * 静态层必须重画（`markDirty`）：投影变了，而静态层是**离屏缓存**，
   * 不重画的话玩家会看到"路还是那条路，但驿站全错位了"。
   *
   * `this.base` 存在性是被断言过的，不是防御性编程：它已经错过一次
   * （见构造函数里那段注释），而那一次的代价是**整个游戏起不来**。
   */
  private applySize(): void {
    const next = sizeFor(window.innerWidth);
    if (this.sized && next === this.size) return;
    this.sized = true;
    this.size = next;
    this.u = next / BASE;
    this.proj = makeProj(next);
    this.canvas.width = next;
    this.canvas.height = next;
    this.canvas.style.width = next + 'px';
    this.canvas.style.height = next + 'px';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', t('postcard_map_title'));
    if (!this.base) throw new Error('小地图：applySize() 早于离屏层建立');
    this.base.width = next;
    this.base.height = next;
    this.dirty = true;
  }

  /** 状态变了（读档、买东西、打完卡）：静态层要重画。 */
  markDirty(): void {
    this.dirty = true;
  }

  /**
   * 每帧调。`targetIdx` 由 hud 传进来 —— **不自己找**。
   *
   * 「下一处」在顶栏、脚下提示圈、小地图三处都要指向同一座驿站，
   * 判据是 `GameManager.fragmentStationNeedsVisit()`。三处各找一次，
   * 玩家就会同时看到三块互相打架的指示牌（原作踩过，见 state.ts 文件头）。
   * 所以找目标的那份代码在 `hud.ts` 的 `nextFragmentTarget()` 里，
   * 这里只负责把它指出来。
   */
  update(_dt: number, targetIdx: number): void {
    // 状态签名变了就重画静态层。见 lastSig 的注释。
    const sig = this.signature();
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.dirty = true;
    }
    if (this.dirty) {
      this.paintBase();
      this.dirty = false;
    }
    const g = this.ctx;
    g.clearRect(0, 0, this.size, this.size);
    g.drawImage(this.base, 0, 0);

    const p = this.world.ride.pos;
    const px = this.proj.x(p.x);
    const py = this.proj.z(p.z);

    this.paintTarget(g, px, py, targetIdx);
    this.paintPlayer(g, px, py, this.world.ride.headingValue);
  }

  /**
   * 静态层依赖的全部状态：路过几座 + 五座碎片站各到访几次。
   * 铺子、旅币这些不进这张图，所以不进这个签名。
   */
  private signature(): string {
    let s = String(this.game.seenStations.size);
    for (let i = 0; i < 5; i++) {
      s += ':' + this.game.fragmentSlotVisitsLeft(i);
    }
    return s;
  }

  // ---------------------------------------------------------------- 静态层

  private paintBase(): void {
    const u = this.u;
    const g = this.baseCtx;
    g.clearRect(0, 0, this.size, this.size);

    // 纸
    g.fillStyle = `rgb(${PAPER_DAY[0]},${PAPER_DAY[1]},${PAPER_DAY[2]})`;
    g.fillRect(0, 0, this.size, this.size);

    // 环线。961 段一次画完，线宽取 1.4 —— 再细在 168px 的图上就断了
    g.strokeStyle = 'rgba(43,36,27,0.34)';
    g.lineWidth = 1.4 * u;
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(this.proj.x(CENTERLINE[0].x), this.proj.z(CENTERLINE[0].z));
    for (let i = 1; i < CENTERLINE.length; i++) {
      g.lineTo(this.proj.x(CENTERLINE[i].x), this.proj.z(CENTERLINE[i].z));
    }
    g.closePath();
    g.stroke();

    // 中线自交点：小十字。这是 8 字唯一一处"路自己碰自己"的地方，
    // 而它恰好也是最容易骑错的一处（两条环在这里并排），所以画出来。
    g.strokeStyle = 'rgba(43,36,27,0.42)';
    g.lineWidth = 1.2 * u;
    const cx = this.proj.x(CROSSING.x);
    const cz = this.proj.z(CROSSING.z);
    g.beginPath();
    g.moveTo(cx - 3 * u, cz - 3 * u);
    g.lineTo(cx + 3 * u, cz + 3 * u);
    g.moveTo(cx + 3 * u, cz - 3 * u);
    g.lineTo(cx - 3 * u, cz + 3 * u);
    g.stroke();

    for (let i = 0; i < STATIONS.length; i++) {
      this.paintStation(g, i);
    }
  }

  /**
   * 一座驿站。
   *
   * 三种形状分开，因为玩家要在 168px 上一眼分清三件事：
   * · **碎片站**：外面一圈**进度弧**，弧长 = 到访次数 / 上限。
   *   走到 2/3 时那条弧差一截就满，玩家不用凑近就知道"这里还得来第三次"。
   * · **到过**（`seenStations` 有它）：实心。图例是明信片上那句
   *   「实心 = 到过　空心 = 未至」，这张图沿用同一套编码。
   * · **没到过**：空心。
   *
   * 注意「到过」用的是 `seenStations`（路过就算），不是 `collected`
   * （打过卡才算）——11 座非碎片驿站不产生碎片，若按 collected 画，
   * 它们永远全是空心，玩家会以为那 11 座没有意义。
   */
  private paintStation(g: CanvasRenderingContext2D, i: number): void {
    const u = this.u;
    const st = STATIONS[i];
    const x = this.proj.x(st.mapX);
    const y = this.proj.z(st.mapZ);
    const seen = this.game.seenStations.has(i);
    const isFrag = st.slot >= 0;
    const r = (isFrag ? 4.2 : 2.6) * u;

    if (isFrag) {
      const cnt = st.slot >= 0 ? this.game.getStationCount(i) : 0;
      const frac = Math.min(cnt / ECON.MAX_VISITS_PER_STATION, 1);
      // 弧的底：整圈淡灰，让"还差多少"有个参照
      g.strokeStyle = 'rgba(43,36,27,0.20)';
      g.lineWidth = 2.4 * u;
      g.beginPath();
      g.arc(x, y, 6.2 * u, 0, Math.PI * 2);
      g.stroke();
      if (frac > 0) {
        g.strokeStyle = ACCENT;
        g.lineWidth = 2.4 * u;
        g.lineCap = 'round';
        g.beginPath();
        // 从 12 点方向顺时针走：和"一格一格点亮"的心智一致
        g.arc(x, y, 6.2 * u, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        g.stroke();
        g.lineCap = 'butt';
      }
    }

    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    if (seen) {
      g.fillStyle = isFrag ? ACCENT : INK;
      g.fill();
    } else {
      g.fillStyle = `rgb(${PAPER_DAY[0]},${PAPER_DAY[1]},${PAPER_DAY[2]})`;
      g.fill();
      g.strokeStyle = isFrag ? ACCENT : INK_FAINT;
      g.lineWidth = 1.2 * u;
      g.stroke();
    }
  }

  // ---------------------------------------------------------------- 动态层

  /** 从玩家指向「下一处」的一条虚线 + 目标站上的一圈。 */
  private paintTarget(
    g: CanvasRenderingContext2D,
    px: number,
    py: number,
    targetIdx: number,
  ): void {
    const u = this.u;
    if (targetIdx < 0 || targetIdx >= STATIONS.length) return;
    const st = STATIONS[targetIdx];
    const tx = this.proj.x(st.mapX);
    const ty = this.proj.z(st.mapZ);

    g.strokeStyle = 'rgba(157,58,47,0.75)';
    g.lineWidth = 1.4 * u;
    g.setLineDash([3 * u, 3 * u]);
    g.beginPath();
    g.moveTo(px, py);
    g.lineTo(tx, ty);
    g.stroke();
    g.setLineDash([]);

    g.strokeStyle = ACCENT;
    g.lineWidth = 1.6 * u;
    g.beginPath();
    g.arc(tx, ty, 8.5 * u, 0, Math.PI * 2);
    g.stroke();
  }

  /**
   * 玩家：一个朝向三角。
   *
   * 朝向用 `rotate(-heading)` 而不是手算三个顶点：`ride.ts` 里
   * 车头方向是 `(-sin h, 0, -cos h)`，而 canvas 里"朝上的三角"在
   * `rotate(θ)` 下变成 `(sin θ, -cos θ)`，令 θ = -h 两者正好对上。
   * 把这个等式抄成顶点坐标的话，改了骑行的朝向约定而没改这里，
   * 症状是"小地图上的箭头永远指着背面"——一个不会报错、很难被发现的 bug。
   */
  private paintPlayer(
    g: CanvasRenderingContext2D,
    px: number,
    py: number,
    heading: number,
  ): void {
    const u = this.u;
    g.save();
    g.translate(px, py);
    g.rotate(-heading);
    // 光晕：同一形状放大后实心铺一层纸色。
    // 原来只有一条 1.2px 的描边，而玩家压在环线上、压在碎片站的进度弧上、
    // 压在「下一处」那条虚线上时，三角形和背景会糊在一起——
    // 而「我在哪儿」这张图上只靠这一个符号回答。
    g.beginPath();
    g.moveTo(0, -7.6 * u);
    g.lineTo(5 * u, 5.3 * u);
    g.lineTo(0, 2.6 * u);
    g.lineTo(-5 * u, 5.3 * u);
    g.closePath();
    g.fillStyle = `rgba(${PAPER_DAY[0]},${PAPER_DAY[1]},${PAPER_DAY[2]},0.92)`;
    g.fill();
    // 本体
    g.beginPath();
    g.moveTo(0, -5.2 * u);
    g.lineTo(3.4 * u, 3.6 * u);
    g.lineTo(0, 1.8 * u);
    g.lineTo(-3.4 * u, 3.6 * u);
    g.closePath();
    g.fillStyle = INK;
    g.fill();
    g.strokeStyle = `rgb(${PAPER_DAY[0]},${PAPER_DAY[1]},${PAPER_DAY[2]})`;
    g.lineWidth = 1.2 * u;
    g.stroke();
    g.restore();
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
  }
}
