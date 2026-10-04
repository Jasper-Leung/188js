/**
 * 三只水碗 —— 名字承诺了水的地方，地上就得真的有水。
 *
 * 「南溪茶寮」「花房·禽语湖湾」「西湾神苑」三个站名和它们写在文案里的
 * 那几句话都在讲水，而世界里原本连一滴水都没有：玩家骑到溪边，
 * 拿到的是一片和别处一模一样的草坡。这不是"不够精致"，是**名字在骗人**。
 *
 * 这一份是地形与水面共同的唯一出处：地形按它挖碗，水面按同一组碗找岸线。
 * 两边各算一次的话，碗和水面迟早对不上。
 *
 * ## 为什么水位是一个全场统一的常数，而不是"碗底 + 一点"
 *
 * 这条路的自然地形高程被 clamp 在 [-3, 6]，也就是说**自然地形永远不低于
 * -3.0**（实测约三成的采样点正好压在这个下限上，是一望无际的平地）。
 * 所以只要把水位放到 -3.0 以下，全场低于水位的就只有我们挖出来的那三只碗
 * ——碗沿处碗深归零、高度回到自然地形，必然高于水位。
 * 于是"水会不会漫出去"这个问题不再取决于地形坡度，而是**恒等于否**。
 *
 * 代价是碗要挖得比"看着差不多"更深一些，而这个深度是**算出来的**：
 * `depth = 碗心自然高程 - 水位 + 目标水深`，保证碗心正好有目标深度的水。
 * 手填深度的话，碗底有可能高于水位——那只碗就成了一个永远露不出水的坑，
 * 而所有回归还是绿的。
 */
import { WATER, ROAD } from '../data/raw';
import { STATIONS } from '../data/route';
import { fbm, noise2d } from '../core/noise';
import { clamp } from '../core/math';
import { CENTERLINE } from '../data/route';

export interface Basin {
  station: number;
  cx: number;
  cz: number;
  radius: number;
  /** 沿"顺路方向"的拉伸系数 */
  squash: number;
  /** 挖下去的深度（米） */
  depth: number;
  /** 碗心目标水深 */
  waterDepth: number;
  level: number;
  /** 拉伸轴（单位向量） */
  ax: number;
  az: number;
}

const basins: Basin[] = [];

/** 未挖碗的自然高程。`planBasins` 按它反推碗深，所以必须是**不含碗**的那一半。 */
export function naturalHeightAt(x: number, z: number): number {
  let h = 0;
  h += fbm(x * 0.008, z * 0.008, 3) * 8;
  h += fbm(x * 0.02, z * 0.02, 2) * 2;
  h += fbm(x * 0.06, z * 0.06, 1) * 0.5;
  return clamp(h, -3, 6);
}

/** 到整条中心线的最近距离（米）。用均匀网格加速，只在规划碗心时调用。 */
function distToCenterline(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < CENTERLINE.length - 1; i++) {
    const a = CENTERLINE[i];
    const b = CENTERLINE[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    let t = 0;
    if (l2 > 1e-9) t = clamp((x - a.x) * dx + (z - a.z) * dz, 0, l2) / l2;
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const d = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/**
 * 碗底足迹上的自然高程均值。
 *
 * 水面盖住的是"自然地形减去碗深之后低于水位"的那一圈，所以碗好不好看
 * 取决于**整片碗底的自然高程平不平**，而不是碗心那一点高不高。
 * 只挑最低的点会挑到陡坡的下缘：湖顺着下坡摊开、上坡一侧露成一大片干土，
 * 于是水面从 7m 一直拉到 29m（源项目实测的原始值）。
 */
function footprintMean(cx: number, cz: number, awayX: number, awayZ: number, alongX: number, alongZ: number, radius: number, squash: number): number {
  let total = 3 * naturalHeightAt(cx, cz);
  let n = 0;
  for (const frac of [0.55, 0.95]) {
    for (let k = 0; k < 8; k++) {
      const a = (Math.PI * 2 * k) / 8;
      const dx = alongX * (Math.cos(a) * squash) + awayX * Math.sin(a);
      const dz = alongZ * (Math.cos(a) * squash) + awayZ * Math.sin(a);
      total += naturalHeightAt(cx + dx * radius * frac, cz + dz * radius * frac);
      n++;
    }
  }
  return total / (3 + n);
}

/**
 * 碗心站哪儿 —— 这是"玩家看到的是湖还是土坑"的全部决定。
 *
 * 硬约束两条：整片碗沿离中心线至少 `radius + BASIN_ROAD_CLEAR`（碗不能压到路），
 * 以及和已经定下的碗隔开 `SITE_SEPARATION`（两片水别在中间连成一条）。
 * 离站太远则按 `SITE_STATION_PENALTY` 罚分——否则最优解永远是地图角落
 * 那片洼地，而玩家骑一圈都不会看见它。
 */
function bestSite(
  stx: number,
  stz: number,
  awayX: number,
  awayZ: number,
  alongX: number,
  alongZ: number,
  radius: number,
  squash: number,
): { x: number; z: number } {
  const n = Math.round(WATER.SITE_SEARCH_REACH / WATER.SITE_SEARCH_STEP);
  const need = radius + WATER.BASIN_ROAD_CLEAR + 2;
  let best = { x: stx + awayX * need, z: stz + awayZ * need };
  let bestScore = Infinity;
  for (let xi = -n; xi <= n; xi++) {
    for (let zi = -n; zi <= n; zi++) {
      const px = stx + awayX * (xi * WATER.SITE_SEARCH_STEP) + alongX * (zi * WATER.SITE_SEARCH_STEP);
      const pz = stz + awayZ * (xi * WATER.SITE_SEARCH_STEP) + alongZ * (zi * WATER.SITE_SEARCH_STEP);
      if (Math.hypot(px - stx, pz - stz) > WATER.SITE_SEARCH_REACH) continue;
      if (distToCenterline(px, pz) < need) continue;
      let clash = false;
      for (const b of basins) {
        if (Math.hypot(px - b.cx, pz - b.cz) < WATER.SITE_SEPARATION + b.radius) {
          clash = true;
          break;
        }
      }
      if (clash) continue;
      const score =
        footprintMean(px, pz, awayX, awayZ, alongX, alongZ, radius, squash) +
        WATER.SITE_STATION_PENALTY * Math.hypot(px - stx, pz - stz);
      if (score < bestScore) {
        bestScore = score;
        best = { x: px, z: pz };
      }
    }
  }
  return best;
}

/**
 * 按真实地形把三只碗定下来。**必须在建地形网格之前调一次**，
 * 因为地形网格本身要按碗深来挖，而碗深又取决于自然地形高程。
 * 顺序反过来的话碗深按"没挖过的地形"算，碗心就浅了，薄成一层贴在碗底的蓝。
 */
export function planBasins(): Basin[] {
  basins.length = 0;
  for (const shape of WATER.BASIN_SHAPES) {
    const st = STATIONS[shape.station];
    // 拉开方向 = 从最近中心线指向驿站，即"远离路"的方向
    let awayX = st.x;
    let awayZ = st.z;
    let bd = Infinity;
    let nx = 0;
    let nz = 0;
    for (const q of CENTERLINE) {
      const d = (q.x - st.x) * (q.x - st.x) + (q.z - st.z) * (q.z - st.z);
      if (d < bd) {
        bd = d;
        nx = q.x;
        nz = q.z;
      }
    }
    awayX = st.x - nx;
    awayZ = st.z - nz;
    const al = Math.hypot(awayX, awayZ);
    if (al < 1e-6) {
      awayX = 1;
      awayZ = 0;
    } else {
      awayX /= al;
      awayZ /= al;
    }
    // 拉伸轴 = 垂直于 away，即顺着路。溪因此与路平行，而不是戳向路。
    const alongX = -awayZ;
    const alongZ = awayX;

    const center = bestSite(st.x, st.z, awayX, awayZ, alongX, alongZ, shape.radius, shape.squash);
    const hC = naturalHeightAt(center.x, center.z);
    basins.push({
      station: shape.station,
      cx: center.x,
      cz: center.z,
      radius: shape.radius,
      squash: shape.squash,
      depth: hC - WATER.WATER_LEVEL + shape.depth,
      waterDepth: shape.depth,
      level: WATER.WATER_LEVEL,
      ax: alongX,
      az: alongZ,
    });
  }
  return basins;
}

export function isPlanned(): boolean {
  return basins.length > 0;
}

export function getBasins(): readonly Basin[] {
  return basins;
}

/**
 * 某个世界坐标被碗挖下去多少米。
 *
 * 碗形是 `k²`（k = 1-(d/r)²）：碗底平、碗壁在盆沿处一阶导归零，
 * 所以盆沿不会和周围地形之间留一道折痕。
 * 两个碗重叠时**相加**而不是取最大——相加的碗和相加的水位仍然自洽，
 * 取最大则两处碗的交界会鼓出一块台地。
 */
export function basinDepthAt(x: number, z: number): number {
  let total = 0;
  for (const b of basins) {
    const dx = x - b.cx;
    const dz = z - b.cz;
    const u = (dx * b.ax + dz * b.az) / b.squash;
    const v = -dx * b.az + dz * b.ax;
    const d = Math.hypot(u, v);
    if (d >= b.radius) continue;
    const k = 1 - (d / b.radius) * (d / b.radius);
    total += b.depth * k * k;
  }
  return total;
}

/** 地形高程（已挖碗）。 */
export function heightAt(x: number, z: number): number {
  return naturalHeightAt(x, z) - basinDepthAt(x, z);
}

// 广场常量在这一层也要一份：RoadData / TreeScatter 都要用，
// 但它们不该为了一个数去 import 世界层。值与 ROAD 一致，由 checkConsistency 守。
export const PLAZA_CENTER = ROAD.PLAZA_CENTER;
export const PLAZA_RADIUS = ROAD.PLAZA_RADIUS;

/** 启动时自检：两只碗不能落在同一处，水位必须低于自然地形下限。 */
export function checkConsistency(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (basins.length !== WATER.BASIN_SHAPES.length) {
    problems.push(`碗数不对：${basins.length} / ${WATER.BASIN_SHAPES.length}`);
  }
  for (const b of basins) {
    if (b.cx - b.radius < -400 || b.cx + b.radius > 400) {
      problems.push(`碗 ${b.station} 超出场界`);
    }
    if (b.depth <= 0) {
      problems.push(`碗 ${b.station} 深度为 ${b.depth}，挖不出水`);
    }
    if (WATER.WATER_LEVEL >= -3.0) {
      problems.push(`水位 ${WATER.WATER_LEVEL} 不低于自然地形下限 -3.0，水会漫出去`);
    }
  }
  return { ok: problems.length === 0, problems };
}

export { noise2d };
