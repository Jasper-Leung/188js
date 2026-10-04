/**
 * 路面 —— 沥青双车道 ribbon，8 字自交处做成真正的交叉口。
 *
 * 几何全部由中心线推导，零贴图：颗粒、胎痕、路缘起灰、潮斑、路肩泥土、
 * 白色路缘线、双黄虚线全在片元着色器里生成。
 *
 * 几个不能省的步骤：
 *
 * · **高斯平滑 ×3**。源采样点里有近 90° 的急弯和 <8m 内的 180° 折返，
 *   直接建横截面会让相邻截面旋转过大、连接三角形翻到路面下方（自相交）。
 *   三次窗口为 5 的高斯把急弯摊平到每个截面只转几度。
 *
 * · **0.5m 重采样**。同上，这是防自相交的第二道保险。
 *   它只影响路面网格，不影响 RoadData.points（迷你地图与驿站定位仍用原始点）。
 *
 * · **高度查询读 mesh 几何**。`getRoadRibbonHeight()` 找所有覆盖查询点的
 *   三角形并取最大高度。8 字交叉处多条三角形的 max 天然连续
 *   （max 函数在交点连续），直接读 mesh 与 GPU 深度缓冲一致，
 *   不需要梯度限制器；路面外返回 -Infinity，由调用方判。
 *
 * ## 交叉口：为什么不再盖一个圆盘
 *
 * 源项目在这里放了一个半径 12m 的圆盘。原因是 Godot 侧要给交叉口画路面，
 * 而两条 ribbon 在自交点只是**几何上叠在一起**，两件事都做不对：
 *
 * 1. **Z-fighting**。两条 ribbon 的高度来自各自的中心线采样点
 *    （`max(左中右三点地形) + ROAD_LIFT`），同一块地面被两组不同的点采样，
 *    差出来几厘米到几十厘米。叠着的两块沥青于是互相闪烁。
 * 2. **标线穿过路口**。中线虚线与路缘线是按每条 ribbon 自己的
 *    横向坐标画的，于是有两条白线笔直地横穿交叉口。
 *
 * 圆盘同时盖住了这两件事，但它是**盖**而不是**做**：路面在盘内变成一张
 * 直径 24m 的圆，看不出是两条路的交叉，而"这里是 188 号环线自己穿过自己"
 * 恰好是这个游戏唯一的地标性空间关系。玩家绕一圈回来，在盘上会完全
 * 意识不到自己走回了起点——那正是这个游戏要让人记住的事。
 *
 * 现在改成两件真事：
 *  · **压平**（`flattenJunction`）：把交叉口半径内的路面高度平滑地
 *    拉到一个共同平面上，两条 ribbon 因此完全共面，Z-fighting 从根上消失。
 *  · **抑制标线**（着色器里的 `mark`）：按到交叉口中心的**世界距离**
 *    淡出中线、路缘线与路肩过渡。沥青的颗粒、胎痕、潮湿斑块保留——
 *    那是路面本身，路口并没有把路面换掉。
 */
import { BufferGeometry, BufferAttribute, Mesh, MeshStandardMaterial } from 'three';
import { ROADMESH } from '../data/raw';
import { CENTERLINE, type Vec3Flat } from '../data/route';
import { patchStandard, ROAD_PATCH } from '../shaders/world';
import type { Terrain } from './terrain';

const {
  ROAD_HALF_WIDTH,
  TOTAL_HALF_WIDTH,
  TOTAL_WIDTH,
  ROAD_LIFT,
  SHOULDER_SINK,
  UV_SCALE,
  RESAMPLE_STEP,
  GRID_CELL,
  PLAZA_CENTER_X,
  PLAZA_CENTER_Z,
  PLAZA_RADIUS,
} = ROADMESH;

/** 路面宽度常量，供植被/驿站偏移等处引用（唯一出处） */
export const ROAD = {
  LANE_WIDTH: ROADMESH.LANE_WIDTH,
  ROAD_HALF_WIDTH,
  SHOULDER_WIDTH: ROADMESH.SHOULDER_WIDTH,
  TOTAL_HALF_WIDTH,
  TOTAL_WIDTH,
  /**
   * 交叉口中心与半径。**沿用源项目的 `PLAZA_*` 数据**——
   * 那是原作从 8 字自交点上量出来的，位置和半径都不改。
   * 改的只是它的用途：以前是圆盘的圆心圆半径，现在是压平范围与
   * 标线抑制范围。同一个数，换一件真正把它做出来的事。
   */
  PLAZA_CENTER: { x: PLAZA_CENTER_X, z: PLAZA_CENTER_Z },
  PLAZA_RADIUS,
  /**
   * 压平范围与标线恢复距离。**都是绝对米数，不是 `PLAZA_RADIUS` 的倍数。**
   *
   * 倍数方案试过，行不通：`PLAZA_RADIUS = 12` 是"圆盘有多大"，
   * 不是"路面要平到多远"。按 12m 取基准高度时，半径内最高的那个采样点
   * 落在 11m 外（它已经在往坡上走了），于是低的那一支要被抬 **0.58m**——
   * 路口中央凭空鼓一个包，比 Z-fighting 更难看。
   *
   * 实测：以交叉点本身（半径 2m 内）为基准，两支只差 **0.16m**，
   * 而叠合区（沥青 ±4m、夹角 75.6°）沿分支只伸到 6.5m。
   * 16m 的过渡带把这 0.16m 摊开，坡度约 1.6%，看不出来。
   */
  JUNCTION_FLAT_RADIUS: 16,
  /** 完全共面的核心半径。1.5m 足够把两条 ribbon 的沥青压到同一个面上 */
  JUNCTION_CORE_RADIUS: 1.5,
  /**
   * 标线在多远处恢复：内圈之内完全不画，到外圈恢复完。
   * 比压平范围短——标线是平的东西，晚一点收尾更像"过路口了，线又画起来"。
   */
  JUNCTION_MARK_INNER: 0.72,
  JUNCTION_MARK_OUTER: 1.05,
  /**
   * 路口处沥青相对单边路面的加宽倍率（转角填角）。
   *
   * 1.35 而不是更大的数：更大的加宽确实能把两条路之间的角填满，
   * 但**同时把标线必须让开的半径也撑大了**（见下面 `JUNCTION_PAVED` 的推导），
   * 于是断口越来越长、"线重新画起来"的位置越来越远。
   * 1.35 是个平衡点：路面读成连续的一片，断口又只比铺面宽一点点。
   */
  JUNCTION_WIDE: 1.35,
  /** 铺面外再留 0.25m 余量，标线才允许重新出现 */
  JUNCTION_PAVED_MARGIN: 0.25,
  /** 中线 / 边线在越过 `JUNCTION_PAVED` 之后各自再花多少米恢复 */
  JUNCTION_CENTER_FADE: 2.0,
  JUNCTION_EDGE_FADE: 3.0,
};

/**
 * 标线必须让开多远——**由铺面宽度推出来，不单独手写**。
 *
 * 少写这一行推导是这一版 bug 的正身：铺面半宽是
 * `TOTAL_HALF_WIDTH × JUNCTION_WIDE = 6.5 × 1.35 = 8.775`，
 * 而标线只让开到 7.5，于是 7.5~8.775 这一段里白线仍然画在
 * 别人家的沥青上——玩家看到的就是"路口有条白线横穿过去"。
 *
 * 两个数各写各的时，早晚会有人只改其中一个。所以这里只让**一个**是自由的：
 * 铺面倍率。`JUNCTION_PAVED` 是从它算出来的，加宽一改，断口自动跟着变。
 */
const JUNCTION_PAVED = ROADMESH.TOTAL_HALF_WIDTH * ROAD.JUNCTION_WIDE + ROAD.JUNCTION_PAVED_MARGIN;

/** 交叉口的几何事实。给回归、着色器与自检用 */
export const JUNCTION = {
  center: { x: PLAZA_CENTER_X, z: PLAZA_CENTER_Z },
  radius: PLAZA_RADIUS,
  flatRadius: ROAD.JUNCTION_FLAT_RADIUS,
  coreRadius: ROAD.JUNCTION_CORE_RADIUS,
  paved: JUNCTION_PAVED,
  planeY: Number.NaN,
  /**
   * 两条支路在路口处的**横向单位向量**（各自中心线的法线）。
   *
   * 标线抑制必须靠它们，不能靠到路口中心的距离。
   * 理由：到中心的距离对两条路是对称的，而两条边线要避开的是
   * **对方那条路的铺面**——那是一个横向量。
   * 用径向判据时，两条路各自算出来的"该在哪停笔"是同一个半径，
   * 而它们实际需要的半径不同（差一个 sin 夹角），于是总有一条画穿。
   *
   * 构造：找中心线上距路口最近的两段连续采样，各取中点处的切线，
   * 叉乘得到横向向量。夹角实测 75.6°。
   */
  axisA: { x: 1, z: 0 },
  axisB: { x: 0, z: 1 },
  /** 两条支路各自穿过路口的采样下标。回归拿它沿路走，量标线的断口 */
  branchA: -1,
  branchB: -1,
};

interface Tri {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  cx: number;
  cy: number;
  cz: number;
}

export class Road {
  readonly mesh: Mesh;
  /** 重采样后的主中心线 */
  readonly centerline: Vec3Flat[];
  /** 每个中心线点的路面高度（已含交叉口压平） */
  readonly roadYs: Float32Array;

  private tris: Tri[] = [];
  /** 8m 一格的空间哈希 */
  private grid = new Map<number, number[]>();
  private readonly uEdge = (ROAD_HALF_WIDTH + TOTAL_HALF_WIDTH) / TOTAL_WIDTH;
  /** 存一份地形，`groundHeightAt` 要用（`buildRoadYs` 之后地形就不再是参数了） */
  private readonly terrain: Terrain;

  constructor(terrain: Terrain) {
    this.terrain = terrain;
    let pts = CENTERLINE;
    pts = smooth(pts, 5);
    pts = smooth(pts, 5);
    pts = smooth(pts, 5);
    this.centerline = resample(pts, RESAMPLE_STEP);
    this.roadYs = this.buildRoadYs(terrain);
    // **必须在建网格之前**压平：网格高度是直接读 `roadYs` 的，
    // 放到之后改就只剩一份和数据不一致的三角形索引了。
    this.flattenJunction();
    this.measureJunctionAxes();

    this.mesh = new Mesh(this.buildRibbonGeometry(terrain), makeRoadMaterial());
    this.mesh.name = 'road';
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  /** 加进场景。交叉口是路面自己的一部分，这里没有第二个网格了 */
  addTo(parent: import('three').Object3D) {
    parent.add(this.mesh);
  }

  /**
   * 量出两条支路在路口处的横向向量。
   *
   * 做法：把中心线上距路口 4m 以内的采样点收成**连续段**，每段挑离路口最近
   * 的那个点，在它两侧各取 6 个采样（约 3m）算切线，叉乘得到横向向量。
   *
   * 两个坑，都是踩过的：
   *
   * 1. **半径不能取 2m。** 实测两条支路各自距路口最近的采样点是 0.20m 与
   *    2.03m——2.0m 的圈只圈到一条支路，于是"数出两条"这个前提不成立，
   *    后面整套标线抑制全部失效（而画面上只是"边线照旧画穿路口"，
   *    看起来像没改）。4m 能稳定收齐两条。
   * 2. **合并绕圈段之后下标不再有序。** 索引是绕圈的，"结尾那一段"和
   *    "开头那一段"是同一段，合并后的数组形如 [2443…2447, 0…3]。
   *    取"中点"会取到 2448（不存在）。所以代表点按**离路口最近**来选，
   *    不依赖数组顺序。
   *
   * 数不到两条时**不抛异常**，保留默认的正交轴：那样标线抑制仍然有效果，
   * 只是不再随夹角自适应。路口画得不够干净，比游戏起不来好。
   */
  private measureJunctionAxes() {
    const cl = this.centerline;
    const n = cl.length;
    const near: number[] = [];
    for (let i = 0; i < n; i++) {
      const p = cl[i];
      if (Math.hypot(p.x - PLAZA_CENTER_X, p.z - PLAZA_CENTER_Z) < 4.0) near.push(i);
    }
    if (near.length < 8) return;

    // 收成连续段（索引差 ≤ 3 算同一段，中间的重采样点不算断）
    const runs: number[][] = [];
    for (const i of near) {
      const last = runs[runs.length - 1];
      if (last && (i - last[last.length - 1] <= 3 || n - last[last.length - 1] + i <= 3)) last.push(i);
      else runs.push([i]);
    }
    // 合并绕圈的首尾两段
    if (runs.length > 1) {
      const first = runs[0];
      const lastRun = runs[runs.length - 1];
      if (n - lastRun[lastRun.length - 1] + first[0] <= 3) {
        runs.pop();
        runs[0] = [...lastRun, ...first];
      }
    }
    if (runs.length < 2) return;
    runs.sort((a, b) => b.length - a.length);

    /** 该段里离路口最近的采样点，以及它两侧算出来的横向向量 */
    const axisOf = (run: number[]): { axis: { x: number; z: number }; idx: number } | null => {
      let idx = run[0];
      let bestD = Infinity;
      for (const i of run) {
        const d = Math.hypot(cl[i].x - PLAZA_CENTER_X, cl[i].z - PLAZA_CENTER_Z);
        if (d < bestD) {
          bestD = d;
          idx = i;
        }
      }
      const a = cl[(idx - 6 + n) % n];
      const b = cl[(idx + 6) % n];
      const tx = b.x - a.x;
      const tz = b.z - a.z;
      const l = Math.hypot(tx, tz);
      if (l < 1e-6) return null;
      // 横向单位向量 = 切线在 XZ 平面转 90°
      return { axis: { x: -tz / l, z: tx / l }, idx };
    };

    const a = axisOf(runs[0]);
    const b = axisOf(runs[1]);
    if (!a || !b) return;
    JUNCTION.axisA = a.axis;
    JUNCTION.axisB = b.axis;
    JUNCTION.branchA = a.idx;
    JUNCTION.branchB = b.idx;
  }

  // ---------------------------------------------------------------- 交叉口
  /**
   * 把交叉口半径内的路面拉到一个共同平面上。
   *
   * ## 基准高度取自交叉点本身
   *
   * 取的是半径 2m（`JUNCTION_CORE_RADIUS` 再加一点余量）内 `roadYs` 的最大值。
   * 实测这个范围内只有**两支**路面，它们相差 0.16m——那 0.16m 就是
   * Z-fighting 的全部来源，压平它就够了。
   *
   * 早先取的是整个 `PLAZA_RADIUS` 内的最大值，而 11m 外的采样点已经在爬坡，
   * 于是低的那一支要被抬 0.58m，路口中央凭空鼓一个包。
   * **半径要用来看"叠合区多大"，不能用来当"基准取多高"。**
   *
   * ## 权重的形状
   *
   * `w = 1 - smoothstep(0, 1, (d - core) / (flat - core))`：
   * 核心区 `w = 1`（完全共面），过渡带平滑收到 0。
   *
   * 核心半径只有 1.5m，是为了让"从自然高度到共面高度"这一步发生在
   * 1.5m 之内——那一段自然高度本身只变化 2cm，踩上去没有台阶。
   * 核心给大了（比如 6m）就会在核心边缘留下一道 0.16m 的坎。
   *
   * ## 只抬不降
   *
   * `max(ys, ...)` 保证压平不会把路面压到原地形以下。
   * 它在 `ys > planeY` 时不生效，而 `ys = planeY` 处两条分支连续，
   * 所以不会在高度曲线上留下折角。
   *
   * ## 剩下的不平整有多少
   *
   * `w` 在过渡带上不等于 1，所以两支在 `d = 3m` 处仍差
   * `(1-w) × 0.16m ≈ 2cm`。深度缓冲在 30m 处的精度约 0.2mm，
   * 2cm 是它的一百倍——Z-fighting 早就没了。
   */
  private flattenJunction() {
    const core = ROAD.JUNCTION_CORE_RADIUS;
    const R = ROAD.JUNCTION_FLAT_RADIUS;
    const cl = this.centerline;
    const ys = this.roadYs;

    // 基准：交叉点附近（core + 0.5m）两条支路的较高者
    let planeY = -Infinity;
    for (let i = 0; i < cl.length; i++) {
      const p = cl[i];
      if (Math.hypot(p.x - PLAZA_CENTER_X, p.z - PLAZA_CENTER_Z) <= core + 0.5 && ys[i] > planeY) {
        planeY = ys[i];
      }
    }
    if (!Number.isFinite(planeY)) {
      JUNCTION.planeY = Number.NaN;
      return;
    }
    JUNCTION.planeY = planeY;

    for (let i = 0; i < cl.length; i++) {
      const p = cl[i];
      const d = Math.hypot(p.x - PLAZA_CENTER_X, p.z - PLAZA_CENTER_Z);
      if (d >= R) continue;
      const t = Math.min(Math.max((d - core) / (R - core), 0), 1);
      const w = 1 - t * t * (3 - 2 * t);
      ys[i] = Math.max(ys[i], ys[i] + (planeY - ys[i]) * w);
    }
  }

  // ---------------------------------------------------------------- 高度
  private terrainH(terrain: Terrain, x: number, z: number) {
    return terrain.getHeightAt(x, z);
  }

  private buildRoadYs(terrain: Terrain): Float32Array {
    const n = this.centerline.length;
    const ys = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = this.centerline[i];
      const s = sideAt(this.centerline, i);
      // 取左中右三点地形的**最高**再加抬升：路面永远在地面上，
      // 但不能被某侧的坡切进去
      const hC = this.terrainH(terrain, p.x, p.z);
      const hL = this.terrainH(terrain, p.x + s.x * ROAD_HALF_WIDTH, p.z + s.z * ROAD_HALF_WIDTH);
      const hR = this.terrainH(terrain, p.x - s.x * ROAD_HALF_WIDTH, p.z - s.z * ROAD_HALF_WIDTH);
      ys[i] = Math.max(hC, hL, hR) + ROAD_LIFT;
    }
    return ys;
  }

  getRoadHeightAtIndex(idx: number): number {
    const n = this.roadYs.length;
    if (n === 0) return 0;
    const t = Math.min(Math.max(idx, 0), n - 1);
    const i = Math.floor(t);
    if (i >= n - 1) return this.roadYs[n - 1];
    const f = t - i;
    return this.roadYs[i] + (this.roadYs[i + 1] - this.roadYs[i]) * f;
  }

  /**
   * 路面高度（米）。**路面外返回 -Infinity**，调用方必须判。
   * 用法：`const h = road.getHeightAt(x,z); if (!Number.isFinite(h)) { ... }`
   */
  getHeightAt(wx: number, wz: number): number {
    const cx = Math.floor(wx / GRID_CELL);
    const cz = Math.floor(wz / GRID_CELL);
    let bestY = -Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const arr = this.grid.get((cx + dx) * 100003 + (cz + dz));
        if (!arr) continue;
        for (const ti of arr) {
          const t = this.tris[ti];
          const bx = t.bx - t.ax;
          const bz = t.bz - t.az;
          const cx2 = t.cx - t.ax;
          const cz2 = t.cz - t.az;
          const px = wx - t.ax;
          const pz = wz - t.az;
          const denom = bx * cz2 - bz * cx2;
          if (Math.abs(denom) < 1e-10) continue;
          const v = (px * cz2 - pz * cx2) / denom;
          const w = (bx * pz - bz * px) / denom;
          const u = 1 - v - w;
          if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
          const y = t.ay * u + t.by * v + t.cy * w;
          if (y > bestY) bestY = y;
        }
      }
    }
    return bestY;
  }

  /** 玩家在路面上？（比高度查询更宽松，含路肩） */
  isOnRoad(wx: number, wz: number): boolean {
    return Number.isFinite(this.getHeightAt(wx, wz));
  }

  /** 当地地面高度（不含路面抬升）。自检与调试用 */
  groundHeightAt(wx: number, wz: number): number {
    return this.terrain.getHeightAt(wx, wz);
  }

  // ---------------------------------------------------------------- 网格
  private buildRibbonGeometry(terrain: Terrain): BufferGeometry {
    const cl = this.centerline;
    const count = cl.length;
    const vertCount = count * 4;
    const positions = new Float32Array(vertCount * 3);
    const uvs = new Float32Array(vertCount * 2);

    let arc = 0;
    for (let i = 0; i < count; i++) {
      const p = cl[i];
      const s = sideAt(cl, i);
      const base = i * 4;
      if (i > 0) {
        arc += Math.hypot(p.x - cl[i - 1].x, p.z - cl[i - 1].z);
      }
      const roadY = this.roadYs[i];
      const v = arc / UV_SCALE;
      const sink = -SHOULDER_SINK;

      const lo = { x: p.x + s.x * TOTAL_HALF_WIDTH, z: p.z + s.z * TOTAL_HALF_WIDTH };
      const ro = { x: p.x - s.x * TOTAL_HALF_WIDTH, z: p.z - s.z * TOTAL_HALF_WIDTH };
      const li = { x: p.x + s.x * ROAD_HALF_WIDTH, z: p.z + s.z * ROAD_HALF_WIDTH };
      const ri = { x: p.x - s.x * ROAD_HALF_WIDTH, z: p.z - s.z * ROAD_HALF_WIDTH };

      // 4 点横截面：路肩外缘 / 左路缘 / 右路缘 / 路肩外缘
      // 路肩自然下沉到地面，沥青到泥土没有一刀切的接缝
      writeVert(positions, base + 0, lo.x, this.terrainH(terrain, lo.x, lo.z) + sink, lo.z);
      writeVert(positions, base + 1, li.x, roadY, li.z);
      writeVert(positions, base + 2, ri.x, roadY, ri.z);
      writeVert(positions, base + 3, ro.x, this.terrainH(terrain, ro.x, ro.z) + sink, ro.z);

      uvs[(base + 0) * 2] = 0;
      uvs[(base + 0) * 2 + 1] = v;
      uvs[(base + 1) * 2] = this.uEdge;
      uvs[(base + 1) * 2 + 1] = v;
      uvs[(base + 2) * 2] = 1 - this.uEdge;
      uvs[(base + 2) * 2 + 1] = v;
      uvs[(base + 3) * 2] = 1;
      uvs[(base + 3) * 2 + 1] = v;
    }

    const indices: number[] = [];
    for (let i = 0; i < count - 1; i++) {
      const b = i * 4;
      const n = b + 4;
      indices.push(b, n, b + 1, b + 1, n, n + 1);
      indices.push(b + 1, n + 1, b + 2, b + 2, n + 1, n + 2);
      indices.push(b + 2, n + 2, b + 3, b + 3, n + 2, n + 3);
    }

    // 逐三角形绕序修正：统一成法线朝上。
    //
    // 判据的符号很容易写反，这里记一笔：`n.y = abz*acx - abx*acz`
    // （ab = v1-v0, ac = v2-v0）。**这个值 > 0 就已经是朝上的了，不要翻。**
    // three 的正面是 CCW，而法线朝上 = 从 +Y 看过去是顺时针的顶点序
    // ——这两个说法指向同一个几何，翻转条件必须写成 `< 0`。
    // 写成 `> 0` 的后果很安静：整条路面向下，被背面剔除，地面上什么都不剩，
    // 而地形、车、小地图、驿站全都正常——于是"路不见了"看起来像是资产没加载。
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t];
      const b = indices[t + 1];
      const c = indices[t + 2];
      const abx = positions[b * 3] - positions[a * 3];
      const abz = positions[b * 3 + 2] - positions[a * 3 + 2];
      const acx = positions[c * 3] - positions[a * 3];
      const acz = positions[c * 3 + 2] - positions[a * 3 + 2];
      if (abz * acx - abx * acz < 0) {
        indices[t + 1] = c;
        indices[t + 2] = b;
      }
    }

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('uv', new BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    // 注册三角形到空间索引（车的高度查询用）
    for (let t = 0; t < indices.length; t += 3) {
      this.registerTri(indices[t], indices[t + 1], indices[t + 2], positions);
    }
    return geo;
  }

  private registerTri(a: number, b: number, c: number, positions: Float32Array) {
    const tri: Tri = {
      ax: positions[a * 3], ay: positions[a * 3 + 1], az: positions[a * 3 + 2],
      bx: positions[b * 3], by: positions[b * 3 + 1], bz: positions[b * 3 + 2],
      cx: positions[c * 3], cy: positions[c * 3 + 1], cz: positions[c * 3 + 2],
    };
    const ti = this.tris.length;
    this.tris.push(tri);
    const cx0 = Math.floor(Math.min(tri.ax, tri.bx, tri.cx) / GRID_CELL);
    const cx1 = Math.floor(Math.max(tri.ax, tri.bx, tri.cx) / GRID_CELL);
    const cz0 = Math.floor(Math.min(tri.az, tri.bz, tri.cz) / GRID_CELL);
    const cz1 = Math.floor(Math.max(tri.az, tri.bz, tri.cz) / GRID_CELL);
    for (let x = cx0; x <= cx1; x++) {
      for (let z = cz0; z <= cz1; z++) {
        const key = x * 100003 + z;
        let arr = this.grid.get(key);
        if (!arr) {
          arr = [];
          this.grid.set(key, arr);
        }
        arr.push(ti);
      }
    }
  }
}

// ---------------------------------------------------------------- 工具

function makeRoadMaterial(): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({
    roughness: 0.85,
    metalness: 0,
    dithering: true,
  });
  patchStandard(mat, ROAD_PATCH, {
    // 这三个常量带 source_color，所以它们是 **sRGB**。
    // 沥青的线性反照率大致 0.10~0.15，折回 sRGB 是 0.35~0.42。
    // 旧值 0.168 折成线性只有 0.023——比真实沥青暗四到五倍，
    // 近处路面读成蓝紫霉斑，而且黄昏把太阳压到 9° 时路面直接黑掉。
    asphalt_color: { value: [0.355, 0.35, 0.34] },
    grain_dark_color: { value: [0.215, 0.212, 0.206] },
    dirt_color: { value: [0.3, 0.256, 0.184] },
    edge_line_color: { value: [0.9, 0.9, 0.858] },
    center_line_color: { value: [0.928, 0.928, 0.898] },
    road_half_width: { value: ROAD_HALF_WIDTH },
    total_half_width: { value: TOTAL_HALF_WIDTH },
    total_width: { value: TOTAL_WIDTH },
    tile_size: { value: UV_SCALE },
    roughness_base: { value: 0.85 },
    // 交叉口：着色器按到**另一条支路中心线**的横向距离淡出标线。
    // 两条轴与铺面半宽由 `measureJunctionAxes()` 量出，不是写死的。
    junction_center: { value: [PLAZA_CENTER_X, PLAZA_CENTER_Z] },
    junction_axis_a: { value: [JUNCTION.axisA.x, JUNCTION.axisA.z] },
    junction_axis_b: { value: [JUNCTION.axisB.x, JUNCTION.axisB.z] },
    junction_paved: { value: JUNCTION.paved },
    junction_center_fade: { value: ROAD.JUNCTION_CENTER_FADE },
    junction_edge_fade: { value: ROAD.JUNCTION_EDGE_FADE },
    junction_wide: { value: ROAD.JUNCTION_WIDE },
  });
  return mat;
}

function writeVert(arr: Float32Array, i: number, x: number, y: number, z: number) {
  arr[i * 3] = x;
  arr[i * 3 + 1] = y;
  arr[i * 3 + 2] = z;
}

/** 每个中心线点的横向单位向量（法线方向） */
function sideAt(cl: Vec3Flat[], i: number): { x: number; z: number } {
  const n = cl.length;
  let tx: number;
  let tz: number;
  if (i === 0) {
    tx = cl[1].x - cl[0].x;
    tz = cl[1].z - cl[0].z;
  } else if (i === n - 1) {
    tx = cl[i].x - cl[i - 1].x;
    tz = cl[i].z - cl[i - 1].z;
  } else {
    tx = cl[i + 1].x - cl[i - 1].x;
    tz = cl[i + 1].z - cl[i - 1].z;
  }
  const l = Math.hypot(tx, tz);
  if (l < 1e-6) return { x: 1, z: 0 };
  tx /= l;
  tz /= l;
  return { x: -tz, z: tx };
}

/** 高斯加权平滑。窗口 5 抹掉抖动与急折返，中心点影响更大，保留真实弯道。 */
function smooth(pts: Vec3Flat[], window: number): Vec3Flat[] {
  const n = pts.length;
  if (n < window) return pts;
  const half = Math.floor(window / 2);
  const sigma = half / 2;
  const twoSigmaSq = 2 * sigma * sigma;
  const out: Vec3Flat[] = new Array(n);
  for (let i = 0; i < n; i++) {
    let ax = 0;
    let ay = 0;
    let az = 0;
    let ws = 0;
    for (let j = Math.max(0, i - half); j < Math.min(n, i + half + 1); j++) {
      const off = j - i;
      const w = Math.exp((-off * off) / twoSigmaSq);
      ax += pts[j].x * w;
      ay += pts[j].y * w;
      az += pts[j].z * w;
      ws += w;
    }
    if (ws > 1e-8) {
      ax /= ws;
      ay /= ws;
      az /= ws;
    }
    out[i] = { x: ax, y: ay, z: az };
  }
  return out;
}

/** 按固定间距重采样折线（线性插值）。只用于生成路面网格。 */
function resample(pts: Vec3Flat[], step: number): Vec3Flat[] {
  const out: Vec3Flat[] = [pts[0]];
  let nextAt = step;
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const segLen = Math.hypot(p1.x - p0.x, p1.z - p0.z, p1.y - p0.y);
    if (segLen < 1e-4) continue;
    const dx = (p1.x - p0.x) / segLen;
    const dy = (p1.y - p0.y) / segLen;
    const dz = (p1.z - p0.z) / segLen;
    while (nextAt <= acc + segLen) {
      const d = nextAt - acc;
      out.push({ x: p0.x + dx * d, y: p0.y + dy * d, z: p0.z + dz * d });
      nextAt += step;
    }
    acc += segLen;
  }
  out.push(pts[pts.length - 1]);
  return out;
}
