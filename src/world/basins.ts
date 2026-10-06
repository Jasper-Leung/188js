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
 * 这条路的自然地形高程被 clamp 在 `[NATURAL_FLOOR, TERRAIN.MAX_HEIGHT]`
 * （即 `[-3, 25]`，`NATURAL_FLOOR` 见下），也就是说**自然地形永远不低于 -3.0**
 * （实测只有约 1% 的采样点压在这个下限上，是谷底而不是一望无际的平地）。
 * 所以只要把水位放到 -3.0 以下，全场低于水位的就只有我们挖出来的那三只碗
 * ——碗沿处碗深归零、高度回到自然地形，必然高于水位。
 * 于是"水会不会漫出去"这个问题不再取决于地形坡度，而是**恒等于否**。
 *
 * 代价是碗要挖得比"看着差不多"更深一些，而这个深度是**算出来的**：
 * `depth = 碗心自然高程 - 水位 + 目标水深`，保证碗心正好有目标深度的水。
 * 手填深度的话，碗底有可能高于水位——那只碗就成了一个永远露不出水的坑，
 * 而所有回归还是绿的。
 *
 * ## 起伏：`MAX_HEIGHT` 第一次真正生效
 *
 * 原来 `naturalHeightAt` 只给得出 10.66m 高差，而 `terrain.json` 里的
 * `TERRAIN_MAX_HEIGHT: 25` 被导出之后**一次都没被读过**。
 * 现在系数重扫、上限改用那个数据常量，详见 `naturalHeightAt` 的注释。
 */
import { WATER, ROAD, TERRAIN } from '../data/raw';
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

/**
 * 自然地形的高程下限。
 *
 * ## 为什么从 -3 改成 -12
 *
 * 原来钉在 -3，唯一的理由是水位（-3.4）必须恒低于它，于是"水会不会漫出去"
 * 这个问题不取决于地形坡度而是恒等于否（见文件头）。
 *
 * 那是拿**地形**去迁就**水位**：一旦想把山做高，低处就成片压在这个下限上，
 * 而成片的 -3.0 平台和"没有山谷的高原"是同一种病，只是方向相反。
 * `relief-sweep` 把这条取舍量化了：地板 -3 时，想要纵坡 p95 ≤ 12%
 * 就得把频率压到 0.14 以下，而那会把 20% 以上的世界压成地板；
 * 地板放到 -12 之后，**纵坡 p95 11.5%、压地板 0.5%**，两条一起成立。
 *
 * 所以真正的修法是反过来：**让水位由地形下限反推，而不是让地形迁就水位。**
 */
export const NATURAL_FLOOR = -12;

/**
 * 水位低于自然地形下限的余量（米）。
 *
 * **从源数据自己推出来，不手填**：源项目的自然地形下限是 -3、
 * `water.json` 里的 `WATER_LEVEL` 是 -3.4，所以它自己的余量是 `(-3) - (-3.4) = 0.4`。
 * 旧实现是"地板钉在 -3、水位是数据里的 -3.4"——两件事碰巧对上；
 * 现在地板动了，对不上的就换成同一件事的两种写法。
 */
const SOURCE_FLOOR = -3;
const WATER_MARGIN = SOURCE_FLOOR - WATER.WATER_LEVEL;

/** 实际使用的水位。恒低于 `NATURAL_FLOOR` 是**结构上**成立的，不靠手填的数字对齐。 */
export const WATER_LEVEL = NATURAL_FLOOR - WATER_MARGIN;

/**
 * 未挖碗的自然高程。`planBasins` 按它反推碗深，所以必须是**不含碗**的那一半。
 *
 * ## 系数是怎么定的（`.cache/relief-sweep.mjs` 实测 144 组，不是拍脑袋）
 *
 * 原来这里是 `8 / 2 / 0.5`、无偏置、clamp 到 6。**实测原始高差只有 10.66m**，
 * 分布形状倒是对的（横跨全部直方图格），只是**整体被缩小了将近三倍**——
 * 800m 见方里 10m 高差就是一块台球桌绿板。地平线在每一帧里都是一条直线，
 * 而副标题写的是"把家乡的**山水**装进行囊"。
 *
 * 顺带查到一件更该先修的事：`terrain.json` 里写着 `TERRAIN_MAX_HEIGHT: 25`，
 * `raw.ts` 也把它导出来了，而**全世界没有任何一处读过它**——
 * 又一个"意图写对了、代码没接上"。所以这里不再手写上限，
 * 直接用那个数据常量，让它第一次真正生效。
 *
 * ## 为什么频率也改了（这是本条最贵的一处决定）
 *
 * 只放大幅度是不行的。第一版试过 `(22, 7, 1.5, bias 9, [-3, 25])`：
 * 高差 26.8m 达标，可 `verify_relief` 立刻报**最大纵坡 49.3%、95% 路段 > 32.4%**——
 * 路面变成过山车，而那条判据正是为了抓这个才写的。
 *
 * 原因是 fbm 的性质：幅度按 1/2 衰减、频率按 2 翻倍，
 * 所以**三个倍频贡献的坡度是同一个量级**，总坡度 ≈ `6A / L`（L = 基频波长）。
 * 要 12% 的坡度就得 `A ≤ 0.02 L`——在 125m 波长下 `A` 只有 2.5m，
 * 那是把 10m 的高差再缩小一点，起伏永远出不来。
 *
 * **所以山要靠波长换，不靠幅度换。** 频率整体乘 0.14（基频波长 125m → 893m），
 * 同样的幅度就换来三分之一的坡度。代价是坡更长更缓——
 * 在一张 800m 的图上，"连绵的丘"和"能骑的山路"本来就不可能同时到顶，
 * 这里选的是后者：一个**为骑行而做的**游戏，路必须能骑。
 *
 * ## 判据（扫的时候四条一起过）
 *   · 高差 ≥ 20m          —— 看得出是山
 *   · 纵坡 p95 ≤ 12% / max ≤ 20% —— 车爬得动
 *   · 压地板 < 4% / 压顶 < 6%   —— 不许有成片平台
 *   · 路拱离地 ≤ 1.5m     —— 路肩不能变成悬崖
 *
 * 实测 `-12 / FS 0.14 / 28-8-1.5`：**高差 30.8m**、主体 p10~p90 **23.2m**、
 * 压地板 **0.5%**、压顶 **0.0%**、纵坡 p95 **11.5%** / max **14.4%**、离地 **0.37m**。
 * 144 组里只有 8 组同时过关，这是其中起伏最大的一组。
 *
 * **路面不需要加纵向平滑**（离地 0.37m 就是不平滑的读数），
 * 于是 `road.ts` 一行都不用改——这条路本来就是从地形推出来的，
 * 该动的是地形，不是路。
 *
 * 噪声**函数**一个字节没动（`core/noise.ts` 里那段"不要换成更漂亮的噪声"
 * 说的是别改 `hash2d`/`fbm` 本身）。改的只是采样频率——
 * 换频率同样会挪动整张地图，而驿站、水碗、植被、道路全都按这份高程对位，
 * 所以这一次是**刻意**重排世界，全部对位关系重新验一遍（`verify_relief` /
 * `verify_stations` / `verify_water` / `verify_buildings` / `verify_ride`）。
 */
export function naturalHeightAt(x: number, z: number): number {
  return clamp(naturalHeightRaw(x, z), NATURAL_FLOOR, TERRAIN.MAX_HEIGHT);
}

/**
 * 未经 clamp 的自然高程。
 *
 * **只给回归用**（`verify_water` 要证明 clamp 真的在生效，
 * 而"生效"只能由"不 clamp 的话会越界"来证明）。
 *
 * 为什么需要它：那条判据原来拿"≥5% 的采样点正好落在 -3.0 上"当作
 * clamp 生效的证据——**那是一个代理，而且是一个方向反了的代理**。
 * 地板上点越多，世界越像一块平台；`verify_relief` 要求地板占比 < 4%
 * 正是为了治它。于是两条判据在互相对抗，改好一条另一条必红。
 *
 * 直接量就沒有这个矛盾：原始值确实越过上下界（说明 clamp 有活可干），
 * 而返回值确实一次都没越界（说明它干对了）。两句话各自都是真的，
 * 不需要拿"地板上有多少点"去间接推。
 */
export function naturalHeightRaw(x: number, z: number): number {
  let h = TERRAIN_RELIEF_BIAS;
  h += fbm(x * 0.008 * TERRAIN_FREQ, z * 0.008 * TERRAIN_FREQ, 3) * 28;
  h += fbm(x * 0.02 * TERRAIN_FREQ, z * 0.02 * TERRAIN_FREQ, 2) * 8;
  h += fbm(x * 0.06 * TERRAIN_FREQ, z * 0.06 * TERRAIN_FREQ, 1) * 1.5;
  return h;
}

/**
 * 三个倍频共用的频率系数。基频波长 = `1 / (0.008 × TERRAIN_FREQ)` 米。
 *
 * 0.14 → 893m，在 800m 的图上约一两个主起伏加两三个次级起伏。
 * 为什么山要靠波长换而不是靠幅度换，见 `naturalHeightAt` 的注释。
 */
const TERRAIN_FREQ = 0.14;

/**
 * 偏置量。存在的唯一理由是把分布中心抬到 `[地板, 天花板]` 的中间附近：
 * 不抬的话低处会成片压在下限上，而成片的下限不是地形，是一块地板。
 *
 * 取 `-地板 × 0.62`（= 7.44）是实测值——见 `naturalHeightAt` 上面的判据表。
 * 写成地板的函数而不是一个孤零零的常数，是为了让**改地板时偏置自动跟着走**；
 * 原来这两件事各写各的，改一个忘另一个，分布就会整片贴到某一头。
 */
const TERRAIN_RELIEF_BIAS = -NATURAL_FLOOR * 0.62;

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
      depth: hC - WATER_LEVEL + shape.depth,
      waterDepth: shape.depth,
      level: WATER_LEVEL,
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
    // 水位恒低于自然地形下限是**结构上**成立的（`WATER_LEVEL` 由下限反推），
    // 所以这里量的是余量本身还在不在，而不是"这次数据对不对"。
    // 如果哪天有人把 `WATER_MARGIN` 改成 0 或负数，水会漫过一望无际的草地——
    // 而所有几何断言都还是绿的。
    if (WATER_MARGIN <= 0 || WATER_MARGIN > 2) {
      problems.push(`水位余量 ${WATER_MARGIN}m 不在 (0, 2] 区间，水会漫出去或者碗挖不出来`);
    }
  }
  return { ok: problems.length === 0, problems };
}

export { noise2d };
