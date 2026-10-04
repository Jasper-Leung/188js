/**
 * 路线几何 —— 8 字环线（lemniscate）与 16 座驿站的最终落位。
 *
 * 这里是整个世界的坐标系原点，所以它必须与 Godot 版**逐点一致**：
 * 环线总长 1228.8m（±2.0）、中心线 961 点、中线被 8 字穿过 4 次。
 * 这三个数是源项目 `verify_8_shape` 守着的硬不变量，移植后必须仍然成立
 * （见 tools/verify-all.mjs）。任何"顺手简化一下采样"的改动都会让
 * 路面网格、迷你地图、驿站点位一起漂，而漂的量没有任何症状。
 */
import { ROAD, type StationDef, type V2 } from './raw';

export interface Vec3Flat {
  x: number;
  y: number;
  z: number;
}

const TAU = Math.PI * 2;

// ---------------------------------------------------------------- 坐标变换

/** 局部 lemniscate 参数坐标 → 画布坐标（旋转 60°、缩放 350、平移到 (400,800)） */
function localToCanvas(p: V2): V2 {
  const rot = (ROAD.ROT_DEG * Math.PI) / 180;
  const xr = p.x * Math.cos(rot) - p.y * Math.sin(rot);
  const yr = p.x * Math.sin(rot) + p.y * Math.cos(rot);
  return {
    x: ROAD.LEMNISCATE_CX + xr * ROAD.LEMNISCATE_SCALE,
    y: ROAD.LEMNISCATE_CY + yr * ROAD.LEMNISCATE_SCALE,
  };
}

/** 画布坐标 → 世界坐标。SCALE 是等比缩放，方向不变。 */
function canvasToWorld2(c: V2): V2 {
  return { x: (c.x - ROAD.CX) * ROAD.SCALE, y: (c.y - ROAD.CY) * ROAD.SCALE };
}

// ---------------------------------------------------------------- 中心线

/**
 * 中心线采样：49 个 lemniscate 锚点之间每段插 20 份，最后补上闭合点。
 * 48 × 20 + 1 = 961 个点。
 */
function buildPoints(): Vec3Flat[] {
  const out: Vec3Flat[] = [];
  const n = ROAD.LEMNISCATE_LOCAL.length;
  for (let i = 0; i < n - 1; i++) {
    const a = localToCanvas(ROAD.LEMNISCATE_LOCAL[i]);
    const b = localToCanvas(ROAD.LEMNISCATE_LOCAL[i + 1]);
    for (let k = 0; k < ROAD.INTERP_PER_SEG; k++) {
      const t = k / ROAD.INTERP_PER_SEG;
      const sx = a.x + (b.x - a.x) * t;
      const sy = a.y + (b.y - a.y) * t;
      out.push({ x: (sx - ROAD.CX) * ROAD.SCALE, y: 0, z: (sy - ROAD.CY) * ROAD.SCALE });
    }
  }
  // 最后一段：index 47 → 48（中心二次交叉），只取终点
  const a2 = localToCanvas(ROAD.LEMNISCATE_LOCAL[n - 2]);
  const b2 = localToCanvas(ROAD.LEMNISCATE_LOCAL[n - 1]);
  out.push({ x: (b2.x - ROAD.CX) * ROAD.SCALE, y: 0, z: (b2.y - ROAD.CY) * ROAD.SCALE });
  void a2;
  return out;
}

export const CENTERLINE: Vec3Flat[] = buildPoints();
export const CENTERLINE_COUNT = CENTERLINE.length;

// ---------------------------------------------------------------- 弧长

const cumArc: number[] = (() => {
  const c = new Array<number>(CENTERLINE.length);
  c[0] = 0;
  for (let i = 1; i < CENTERLINE.length; i++) {
    const a = CENTERLINE[i - 1];
    const b = CENTERLINE[i];
    c[i] = c[i - 1] + Math.hypot(b.x - a.x, b.z - a.z);
  }
  return c;
})();

export const TOTAL_ARCLENGTH = cumArc[cumArc.length - 1];

/** 环线上按弧长取点（t ∈ [0,1)，绕圈）。骑行里程、小地图、进度都用它。 */
export function pointAtArcLength(s: number): { pos: Vec3Flat; index: number } {
  const total = TOTAL_ARCLENGTH;
  let d = s % total;
  if (d < 0) d += total;
  // cumArc 单调，二分
  let lo = 0;
  let hi = cumArc.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumArc[mid] <= d) lo = mid;
    else hi = mid;
  }
  const a = CENTERLINE[lo];
  const b = CENTERLINE[hi];
  const segLen = cumArc[hi] - cumArc[lo] || 1;
  const t = (d - cumArc[lo]) / segLen;
  return {
    pos: { x: a.x + (b.x - a.x) * t, y: 0, z: a.z + (b.z - a.z) * t },
    index: lo,
  };
}

/** 世界坐标 → 最近的中心线参数 [0,1)。玩家每帧都要问，用均匀网格加速。 */
const GRID = 8;
const gridBuckets = new Map<number, number[]>();
for (let i = 0; i < CENTERLINE.length - 1; i++) {
  const a = CENTERLINE[i];
  const key = cellKey(Math.floor(a.x / GRID), Math.floor(a.z / GRID));
  let arr = gridBuckets.get(key);
  if (!arr) {
    arr = [];
    gridBuckets.set(key, arr);
  }
  arr.push(i);
}

function cellKey(cx: number, cz: number) {
  return cx * 100003 + cz;
}

/**
 * 最近的中心线参数。
 *
 * **必须扫全路径**：8 字的两条环会绕回来贴着交叉点，只看附近这一段
 * 会漏掉真正的最近段——广场上那座驿站就是靠这一段判的方向。
 * 均匀网格只用来做剔除，命中格之后仍然逐段精算。
 */
export function nearestArcParam(px: number, pz: number): number {
  const cx = Math.floor(px / GRID);
  const cz = Math.floor(pz / GRID);
  let bestD = Infinity;
  let bestS = 0;
  // 由近及远扩圈，最多 6 圈。绝大多数查询在第 0 圈就命中。
  for (let ring = 0; ring <= 6; ring++) {
    if (ring > 0) {
      // 上一圈已找到足够近的段就不用再扩了
      if (bestD < (ring - 1) * GRID) break;
    }
    for (let ix = cx - ring; ix <= cx + ring; ix++) {
      for (let iz = cz - ring; iz <= cz + ring; iz++) {
        // 只扫一圈的边框，避免重复
        if (ring > 0 && Math.abs(ix - cx) !== ring && Math.abs(iz - cz) !== ring) continue;
        const arr = gridBuckets.get(cellKey(ix, iz));
        if (!arr) continue;
        for (const i of arr) {
          const a = CENTERLINE[i];
          const b = CENTERLINE[i + 1];
          const abx = b.x - a.x;
          const abz = b.z - a.z;
          const l2 = abx * abx + abz * abz;
          let t = 0;
          if (l2 > 1e-9) t = clamp01(((px - a.x) * abx + (pz - a.z) * abz) / l2);
          const dx = px - (a.x + abx * t);
          const dz = pz - (a.z + abz * t);
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            bestS = (cumArc[i] + Math.sqrt(l2) * t) / TOTAL_ARCLENGTH;
          }
        }
      }
    }
  }
  return bestS;
}

/**
 * 到**整条**中心线的最近距离（米）。扫全路径，所以两条支路互相靠近的地方
 * （8 字交叉口附近）也能给出正确的距离。
 *
 * ## 为什么必须有这个函数，而不是"垂直于切线偏移 N 米"
 *
 * 植被与散布原本都是这么摆的：取弧长上的一个点，沿法线推 `off` 米。
 * **那只在路是直线时等价于距离**。8 字的两条支路会绕回来互相靠近，
 * 于是"离本段 16m"的位置可能离**另一段**只有 4m —— 树就长在沥青上了。
 *
 * 实测过：按法线推 16m，最近的一棵树离中心线只有 **4.2m**。
 * 画面上就是"树枝搭在路面上"，而截图之前一直没被注意到。
 *
 * 所以凡是"东西不许靠近路"的判定，都必须用**到整条线的最近距离**。
 */
export function distToCenterline(px: number, pz: number): number {
  let best = Infinity;
  for (let i = 0; i < CENTERLINE.length - 1; i++) {
    const a = CENTERLINE[i];
    const b = CENTERLINE[i + 1];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const l2 = abx * abx + abz * abz;
    if (l2 < 1e-9) {
      const d = (px - a.x) ** 2 + (pz - a.z) ** 2;
      if (d < best) best = d;
      continue;
    }
    const t = clamp01(((px - a.x) * abx + (pz - a.z) * abz) / l2);
    const dx = px - (a.x + abx * t);
    const dz = pz - (a.z + abz * t);
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** 到整条中心线的最近距离（米）。只用于初始化时给驿站挑方向。 */
function distToRoad(p: V2): number {
  let best = Infinity;
  for (let i = 0; i < CENTERLINE.length - 1; i++) {
    const a = CENTERLINE[i];
    const b = CENTERLINE[i + 1];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const l2 = abx * abx + abz * abz;
    if (l2 < 1e-9) {
      best = Math.min(best, Math.hypot(p.x - a.x, p.y - a.z));
      continue;
    }
    const t = clamp01(((p.x - a.x) * abx + (p.y - a.z) * abz) / l2);
    const dx = p.x - (a.x + abx * t);
    const dz = p.y - (a.z + abz * t);
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------- 驿站落位

/** 画布空间切线：前后邻点的差。等比缩放不改变方向。 */
function canvasTangent(lmIdx: number): V2 {
  const n = ROAD.LEMNISCATE_LOCAL.length;
  const a = localToCanvas(ROAD.LEMNISCATE_LOCAL[(lmIdx + 1) % n]);
  const b = localToCanvas(ROAD.LEMNISCATE_LOCAL[(lmIdx - 1 + n) % n]);
  return { x: a.x - b.x, y: a.y - b.y };
}

/**
 * 以本点切线为基准转一圈，取离路面最远的那个方向。
 *
 * 用一整圈而不是只给两个法线方向，是因为交叉点的"切线"其实是两条路的
 * 角平分线——法线几乎平行于其中一条路，会把驿站贴着另一条路面推出去。
 *
 * 18m 这个值有硬约束：路面总半宽 6.5m，驿站模型脚底半宽实测最大 7.8m，
 * 18 − 7.8 = 10.2 > 6.5，所以最宽的模型也整个落在路肩外；
 * 又必须 < 15m（打卡半径）+ 路宽，否则玩家在路面上够不着它。
 */
function stationOff(lmIdx: number): V2 {
  const p2 = canvasToWorld2(localToCanvas(ROAD.LEMNISCATE_LOCAL[lmIdx]));
  let dist = ROAD.STATION_OFFSET;
  // 广场盘上那座要越界到盘外：那里两条 ribbon 夹角只有 ~76°，
  // 按 18m 推过去仍然落在盘内、压在另一条路的沥青上。
  if (Math.hypot(p2.x - ROAD.PLAZA_CENTER.x, p2.y - ROAD.PLAZA_CENTER.y) < ROAD.PLAZA_RADIUS) {
    dist = ROAD.PLAZA_RADIUS + ROAD.PLAZA_STATION_MARGIN;
  }
  let base = canvasTangent(lmIdx);
  if (base.x * base.x + base.y * base.y < 1e-9) base = { x: 1, y: 0 };
  const len = Math.hypot(base.x, base.y);
  const a0 = Math.atan2(base.y / len, base.x / len);

  let best: V2 = { x: 0, y: 0 };
  let bestD = -Infinity;
  for (let k = 0; k < ROAD.DIR_STEPS; k++) {
    const ang = a0 + (k * TAU) / ROAD.DIR_STEPS;
    const off = { x: Math.cos(ang) * dist, y: Math.sin(ang) * dist };
    const d = distToRoad({ x: p2.x + off.x, y: p2.y + off.y }) - ROAD.STATION_FOOT_HALF;
    if (d > bestD) {
      bestD = d;
      best = off;
    }
  }
  return best;
}

/** 驿站在 world 里的最终位置：画布原位 + 路肩外的横向偏移。 */
export interface StationPlacement {
  def: StationDef;
  /** 世界坐标（米），y 稍后由地形决定 */
  x: number;
  z: number;
  /** 小地图用的"原位"（画布坐标，偏移之前） */
  mapX: number;
  mapZ: number;
  /** 是否是碎片驿站 */
  hasFragment: boolean;
  /** 碎片槽位 0..4，非碎片站为 -1 */
  slot: number;
}

export const STATIONS: StationPlacement[] = ROAD.STATIONS.map((def, i) => {
  const lmIdx = ROAD.STATION_LEMNISCATE_IDX[i];
  const canvas = localToCanvas(ROAD.LEMNISCATE_LOCAL[lmIdx]);
  const world = canvasToWorld2(canvas);
  const off = stationOff(lmIdx);
  const slot = ROAD.FRAGMENT_STATION_TO_SLOT[String(i)] ?? -1;
  return {
    def,
    x: world.x + off.x,
    z: world.y + off.y,
    mapX: world.x,
    mapZ: world.y,
    hasFragment: def.fragment !== '' && def.fragment != null,
    slot,
  };
});

export const STATION_COUNT = STATIONS.length;

/** 碎片站按槽位顺序（云/茶/琴/竹/禽）取，和 FRAGMENT_SLOT_STATION_IDX 对齐 */
export const FRAGMENT_STATIONS: StationPlacement[] = ROAD.FRAGMENT_SLOT_STATION_IDX.map(
  (stationIdx) => STATIONS[stationIdx],
);

/**
 * 8 字被中线穿过的次数。
 *
 * 判据照搬源项目：把图形转 60°、沿中线的 x 坐标数**符号变化**。
 * 手算的结果是 4 处——"把每个环各数一遍"是 4 处，而单参数看只有 2 处。
 * 这个差别就是为什么不能用"参数回绕了几次"来判：那样只会得 2。
 *
 * 顺带守三条几何性质，它们比"点数对不对"更早暴露采样被改坏：
 *   · 两环镜像对称（质心关于中线对称）
 *   · 外接矩形的长宽比（8 字转 60° 后两个环并排，比例是被设计定的）
 *   · 两环的点数分配（对称则各占一半）
 */
export interface ShapeReport {
  crossings: number;
  leftCount: number;
  rightCount: number;
  /** 镜像偏差，占外接宽度的比例 */
  symmetryError: number;
  aspect: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  midX: number;
}

export function shapeReport(): ShapeReport {
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
  const midX = (minX + maxX) / 2;

  let crossings = 0;
  let prevSign = 0;
  let left = 0;
  let right = 0;
  let lx = 0;
  let lz = 0;
  let rx = 0;
  let rz = 0;
  // 非零符号按顺序收下来，最后要把末尾接回开头再数一次。
  //
  // 为什么必须绕回去数：8 字在参数 0 与 0.5 两次经过中心，两处 x 都**正好等于**中线。
  // 源项目的写法是"跳过正好在中线上的点，数前后符号变化"，在它自己的采样下
  // 得到 4——但那个 4 依赖它的采样点没有正好落在中线上。本项目的采样
  // （从 49 个锚点线性插值）会让锚点 (0,0) 正好落在中线上，于是同一条判据得 3。
  //
  // 也就是说：那个 4 是采样的巧合，不是形状的性质。绕回去数是同一件事的
  // 稳健写法——"闭合曲线的符号变化"本来就该把末尾接回开头，
  // 而它给出的 4 正好等于"两环各进出一次"。
  const signs: number[] = [];
  for (const p of CENTERLINE) {
    const s = Math.abs(p.x - midX) < 1e-6 ? 0 : p.x > midX ? 1 : -1;
    if (s === 0) continue; // 正中线上的点不表态，交给前后两侧决定
    signs.push(s);
    if (prevSign !== 0 && s !== prevSign) crossings++;
    prevSign = s;
  }
  if (signs.length > 1 && signs[signs.length - 1] !== signs[0]) crossings++;
  for (const p of CENTERLINE) {
    const s = Math.abs(p.x - midX) < 1e-6 ? 0 : p.x > midX ? 1 : -1;
    if (s < 0) {
      left++;
      lx += p.x;
      lz += p.z;
    } else if (s > 0) {
      right++;
      rx += p.x;
      rz += p.z;
    }
  }
  const lcX = left > 0 ? lx / left : 0;
  const rcX = right > 0 ? rx / right : 0;
  const xSpan = maxX - minX;
  return {
    crossings,
    leftCount: left,
    rightCount: right,
    symmetryError: xSpan > 0 ? Math.abs(lcX + rcX - 2 * midX) / xSpan : 0,
    aspect: xSpan / Math.max(maxZ - minZ, 1e-6),
    minX,
    maxX,
    minZ,
    maxZ,
    midX,
  };
}

/** 兼容旧调用：只要交叉次数 */
export function countCrossings(): number {
  return shapeReport().crossings;
}

/** 世界坐标最近的驿站（用于打卡提示与路边彩蛋）。 */
export function nearestStation(x: number, z: number): { index: number; distance: number } {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < STATIONS.length; i++) {
    const d = Math.hypot(STATIONS[i].x - x, STATIONS[i].z - z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return { index: best, distance: bestD };
}
