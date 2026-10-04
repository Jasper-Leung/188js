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

/** 画布的 CSS 边长（px）。**故意不用 rem**：这是一个位图的像素尺寸，
 *  由 JS 读 rect 再乘 dpr 才能得到正确的后备缓冲，用 rem 反而多一层
 *  「布局定完没有」的时序依赖（构造时父节点可能还是 display:none）。 */
const SIZE = 168;
/** 环线离画布边留的空白（px）。 */
const PAD = 10;

// ---------------------------------------------------------------- 投影

/**
 * 世界 (x,z) → 画布 (px,py) 的等比映射。
 *
 * 包围盒取 `CENTERLINE` 而不是 `STATIONS`：驿站原位一定在环线上，
 * 而环线才是那个把整个 8 字撑满的形状。按驿站取包围盒会让图偏出去
 * 一圈，而玩家会以为"路比图短"。
 */
const PROJ = (() => {
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
  const k = (SIZE - PAD * 2) / Math.max(spanX, spanZ);
  // 等比缩放之后在两个轴上各居中一次：8 字不是正方形，不居中就会有一边贴边
  const offX = PAD + (SIZE - PAD * 2 - spanX * k) * 0.5;
  const offZ = PAD + (SIZE - PAD * 2 - spanZ * k) * 0.5;
  return {
    x(wx: number): number {
      return offX + (wx - minX) * k;
    },
    z(wz: number): number {
      return offZ + (wz - minZ) * k;
    },
  };
})();

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
    this.canvas.width = SIZE;
    this.canvas.height = SIZE;
    this.canvas.style.width = SIZE + 'px';
    this.canvas.style.height = SIZE + 'px';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', t('postcard_map_title'));
    this.root.appendChild(this.canvas);
    parent.appendChild(this.root);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('小地图拿不到 2D 上下文');
    this.ctx = ctx;

    this.base = el('canvas');
    this.base.width = SIZE;
    this.base.height = SIZE;
    const bctx = this.base.getContext('2d');
    if (!bctx) throw new Error('小地图离屏层拿不到 2D 上下文');
    this.baseCtx = bctx;
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
    g.clearRect(0, 0, SIZE, SIZE);
    g.drawImage(this.base, 0, 0);

    const p = this.world.ride.pos;
    const px = PROJ.x(p.x);
    const py = PROJ.z(p.z);

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
    const g = this.baseCtx;
    g.clearRect(0, 0, SIZE, SIZE);

    // 纸
    g.fillStyle = `rgb(${PAPER_DAY[0]},${PAPER_DAY[1]},${PAPER_DAY[2]})`;
    g.fillRect(0, 0, SIZE, SIZE);

    // 环线。961 段一次画完，线宽取 1.4 —— 再细在 168px 的图上就断了
    g.strokeStyle = 'rgba(43,36,27,0.34)';
    g.lineWidth = 1.4;
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(PROJ.x(CENTERLINE[0].x), PROJ.z(CENTERLINE[0].z));
    for (let i = 1; i < CENTERLINE.length; i++) {
      g.lineTo(PROJ.x(CENTERLINE[i].x), PROJ.z(CENTERLINE[i].z));
    }
    g.closePath();
    g.stroke();

    // 中线自交点：小十字。这是 8 字唯一一处"路自己碰自己"的地方，
    // 而它恰好也是最容易骑错的一处（两条环在这里并排），所以画出来。
    g.strokeStyle = 'rgba(43,36,27,0.42)';
    g.lineWidth = 1.2;
    const cx = PROJ.x(CROSSING.x);
    const cz = PROJ.z(CROSSING.z);
    g.beginPath();
    g.moveTo(cx - 3, cz - 3);
    g.lineTo(cx + 3, cz + 3);
    g.moveTo(cx + 3, cz - 3);
    g.lineTo(cx - 3, cz + 3);
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
    const st = STATIONS[i];
    const x = PROJ.x(st.mapX);
    const y = PROJ.z(st.mapZ);
    const seen = this.game.seenStations.has(i);
    const isFrag = st.slot >= 0;
    const r = isFrag ? 4.2 : 2.6;

    if (isFrag) {
      const cnt = st.slot >= 0 ? this.game.getStationCount(i) : 0;
      const frac = Math.min(cnt / ECON.MAX_VISITS_PER_STATION, 1);
      // 弧的底：整圈淡灰，让"还差多少"有个参照
      g.strokeStyle = 'rgba(43,36,27,0.20)';
      g.lineWidth = 2.4;
      g.beginPath();
      g.arc(x, y, 6.2, 0, Math.PI * 2);
      g.stroke();
      if (frac > 0) {
        g.strokeStyle = ACCENT;
        g.lineWidth = 2.4;
        g.lineCap = 'round';
        g.beginPath();
        // 从 12 点方向顺时针走：和"一格一格点亮"的心智一致
        g.arc(x, y, 6.2, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
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
      g.lineWidth = 1.2;
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
    if (targetIdx < 0 || targetIdx >= STATIONS.length) return;
    const st = STATIONS[targetIdx];
    const tx = PROJ.x(st.mapX);
    const ty = PROJ.z(st.mapZ);

    g.strokeStyle = 'rgba(157,58,47,0.75)';
    g.lineWidth = 1.4;
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(px, py);
    g.lineTo(tx, ty);
    g.stroke();
    g.setLineDash([]);

    g.strokeStyle = ACCENT;
    g.lineWidth = 1.6;
    g.beginPath();
    g.arc(tx, ty, 8.5, 0, Math.PI * 2);
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
    g.save();
    g.translate(px, py);
    g.rotate(-heading);
    g.beginPath();
    g.moveTo(0, -5.2);
    g.lineTo(3.4, 3.6);
    g.lineTo(0, 1.8);
    g.lineTo(-3.4, 3.6);
    g.closePath();
    g.fillStyle = INK;
    g.fill();
    // 描一圈纸色边：玩家压在环线上时三角形不会和路面线糊在一起
    g.strokeStyle = `rgb(${PAPER_DAY[0]},${PAPER_DAY[1]},${PAPER_DAY[2]})`;
    g.lineWidth = 1.2;
    g.stroke();
    g.restore();
  }

  dispose(): void {
    this.root.remove();
  }
}
