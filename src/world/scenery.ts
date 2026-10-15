/**
 * 区域散布 —— 西北的竹丛，与东南那片**有人住的**新区。
 *
 * ## 为什么不是又一套"沿路摆放"
 *
 * `vegetation.ts` 是**沿中心线按弧长**摆的（行道树紧贴路肩）。
 * 这三样东西不一样：
 *
 *   · **竹**在西北（屏幕左上）成丛，离路 26~110m，的是"远处山坡上是竹林"；
 *   · **现代建筑**在东南（屏幕右下），代表**已经被开发过的地方**——
 *     它们的存在本身就是叙事：这个环线上其余地方没人来过，只有这一角动过土。
 *
 * 按弧长摆不出来（它们不在路边），所以这里用**粗网格分桶**：
 * 64m 一格，每格一个 InstancedMesh，每帧按距离开关 `visible`。
 * 这与 `vegetation.ts` 的块剔除是同一个套路，只是把"沿弧长的块"
 * 换成"平面上的格"——因为散布点是二维的，不是跟着路走的。
 *
 * ## 东南为什么是"聚落"而不是"散点"
 *
 * 这一角曾经读作**3 座孤塔 + 4 间散落的棚子**，原因是病根在挑选而不在数量：
 * 塔楼按离路最近（`near`）抱团，圆屋按散列（`hash`）乱撒，
 * **两套各自都"正确"，但彼此看不见对方** —— 圆屋根本没围着塔楼摆。
 * 于是"离路最近的 3 个点"可以是相距 16.1m 的两栋（塔楼底面就有 13~17m 宽，
 * 那是两栋楼穿在一起），也可以再隔 145m 摆第三栋。
 *
 * 现在三类东西共用一份**已放置名单**（见 `build()`）：
 * 塔楼先定种子（离路最近的候选），圆屋的种子改成**离已放置塔楼最近**的那个候选，
 * 于是"围着塔楼摆"从一句形容词变成了一句可以被执行的排序键。
 * 成品是 7 个东西落在 107m 见方的一片地上 —— 一个区，不是一堆点。
 *
 * ## 为什么每样只摆几个
 *
 * 这不是行道树，不能按密度撒：
 *
 *   · `mod_house` **24,264 面**——一栋就顶 6 丛竹（`bamboo_trim` 3,801 面），
 *     而它只有一个 draw call 却让整帧多 2.4 万面。所以东南只放 3 栋塔楼 + 4 栋圆屋，
 *     **而且它们必须是"远处才看得见的尺度"**：塔楼归一化到 1.0 单位高、圆屋 0.420，
 *     按 `scale` 的 34~44 / 11~16 放大才是 34~44m 的塔与 4.6~6.7m 的圆屋——
 *     读作"一片新区"而不是"两栋玩具屋"。
 *   · **竹**便宜，但要成丛才有意义：散着摆 40 丛是"草"，聚成几片才是"竹林"。
 *
 * 换句话说：**这一轮的"改善居住区"花的是位置，不是面数**——
 * `max` 一个没加，靠 `pick`/`spacing`/`clusterR` 把同样 7 个东西摆成一个区。
 *
 * ## 判定用的五个约束
 *
 * 每一个都对应一次"放错了看得出来"：
 *
 *   1. **离路太近** —— 建筑压在路面上比不放还糟；
 *   2. **在水下** —— `getHeightAt` 低于水位 + 0.6m 就丢，竹子泡在水里最出戏；
 *   3. **坡太陡** —— 四角采样算坡度，超过阈值就丢，否则建筑一半悬空；
 *   4. **压着驿站** —— 驿站有 keepout 半径，建筑骑在人家屋顶上是不允许的；
 *   5. **叠在一起 / 散得太开** —— 前四条管"这一栋能不能放这儿"，
 *      第五条管"这么放出来的东西算不算一个地方"。
 *
 * 全部**确定性**（`hashGrid`），和植被同一套随机源：
 * 同一个存档、同一个位置、同一个样子，没有"这次刷新换了片竹林"。
 */
import {
  Group,
  InstancedMesh,
  BufferGeometry,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type Material,
} from 'three';
import { CENTERLINE, STATIONS, TOTAL_ARCLENGTH, nearestArcParam } from '../data/route';
import { ROAD } from '../data/raw';
import { hashGrid } from '../core/noise';
import { bottomOf } from './vegetation';
import { WATER_LEVEL } from './basins';
import type { Terrain } from './terrain';

export type SceneryKind = 'bamboo' | 'mod_tower' | 'mod_house';

/** 东南住区的规划网格（米），见 `Scenery.planSettlement()` */
export const PLAN = { HOUSE_GAP: 27, ROW_GAP: 40, TOWER_GAP: 40, HOUSE_SCALE: 12 } as const;

/** 一个格子多少米。64m 是折中：小了 draw call 变多，大了剔除不干脆。 */
const CELL = 64;
/** 水位之上至少多高。 */
const MIN_DRY = 0.6;
/** 四角采样算出来的坡度上限（米/米）。0.35 ≈ 19°。 */
const MAX_SLOPE = 0.35;

interface Placement {
  x: number;
  y: number;
  z: number;
  rotY: number;
  scale: number;
}

interface Cell {
  kind: SceneryKind;
  cx: number;
  cz: number;
  items: Placement[];
  mesh: InstancedMesh | null;
}

/**
 * 每样东西的散布参数。
 *
 * `quad` 是象限：`-1,-1` = 西北（屏幕左上），`+1,+1` = 东南（屏幕右下）。
 * 地图的 X 向右、Z 向下（与 `ui/minimap.ts` 的 `PROJ` 同一套）。
 */
const SPEC: Record<SceneryKind, {
  quad: readonly [number, number];
  /** 最多放几个 */
  max: number;
  /** 候选点的网格步长（米） */
  step: number;
  /** 缩放区间 */
  scale: readonly [number, number];
  /** 离路区间（米）。**下限是别压路，上限是"玩家看得见"** */
  road: readonly [number, number];
  /**
   * 怎么从合格候选里挑 `max` 个。
   *
   * `near` = 就近优先（先挑离路最近的）；
   * `hash` = 按散列打散——竹子要铺开，聚成一坨就变成"一丛草"而不是"竹林"；
   * `cluster` = **先定一个种子，再从种子里一圈圈长出去**，见下面 `clusterR`。
   *
   * `cluster` 是给建筑准备的。东南那一角以前是 `near` + `hash` 各管各的：
   * 塔楼按离路最近抱团、圆屋按散列乱撒，于是 3 塔 + 4 屋读成
   * 「两栋挤在一起的孤塔 + 一栋更远的孤塔 + 四间路边棚子」。
   * 两种挑法各自都"正确"，合起来不是聚落——**聚落是关系，不是各自的分布**。
   */
  pick: 'near' | 'hash' | 'cluster';
  /**
   * 与**同类**的最小中心距（米）。`cluster`/`near` 摆的时候逐个检查，穿模就跳过。
   *
   * 这是"东西不许叠在一起"那条底线，圆屋尤其要：成品 8~11m 宽，
   * 22m 中心距留出 11m 净空——低档雾里两间屋子并排站着是能看出缝的。
   */
  spacing: number;
  /**
   * 与**别类**的最小中心距（米）。异类之间取两边的较大者。
   *
   * `gap: 0` = 这一类**不参与净距检查**，也不记进"已放置"名单。
   * 竹丛就是：100 丛东西要的就是挤在一起算一片竹林，
   * 让它们互相让位只会把竹林拆成一排孤立的竹子。
   */
  gap: number;
  /**
   * 聚落半径（米）：同类的东西全部落在**第一个落点**的这个半径内。
   *
   * **为什么光有"挑最近的"还不够**——这是实测出来的：东南象限是整个平面的右下
   * 四分之一，里面裹着环路好长一段弧。离路 40~110m 的可用地是一条**贴着弧的窄带**，
   * 只按"离已放置的最近"去挑，塔 1 会顺着弧跑到别处去（实测塔间距 60~123m），
   * 于是又散成几堆。加上半径这一刀，聚落才是**紧凑**的——
   * 现在 7 个东西最远的一对相距 107m，读作一个新区。
   */
  clusterR: number;
  /** 半径（米），供剔除与探针使用 */
  radius: number;
}> = {
  // 竹：离路 26~110m。是"从路上看得见的山坡竹林"，不是地图角落里的植物。
  //
  // **数量为什么从 34 变成 100**：`bamboo.glb` 的底部 35% 被裁掉了
  // （`tools/trim-glb.mjs`）——整株插进地里，地下那一截永远看不见，
  // 却是实打实每帧在算的面。18,444 → 4,265 面（剩 23%），
  // 省下的预算直接换成密度：**密度是玩家看得见的，地下那一截不是。**
  //
  // 缩放也跟着调：裁完之后模型高 0.978 → 0.635，
  // 所以 [9,15] 改 [13,22]，成品高度仍是 8~14m。
  bamboo: { quad: [-1, -1], max: 100, step: 9, scale: [13, 22], road: [26, 110], pick: 'hash', spacing: 0, gap: 0, clusterR: 0, radius: 150 },
  // 塔楼：离路 40~110m，成片 = 一个新区。
  //
  // **离路区间为什么从 [70,230] 收到 [40,110]**：三件事叠在一起。
  //   · 收窄是为了**看得见**：档位雾距 175/300/420m，低档只有 175m（`core/settings.ts`），
  //     而旧配置里塔楼最远能落在离路 174m —— 低档玩家一辈子只看得见两栋。
  //   · 下限 40m 而不是 60m：路面半宽只有 4m（`ROADMESH.ROAD_HALF_WIDTH`），
  //     40m 离路心仍是路面的 10 倍，贴着放反而更像"沿路开发的那一片"。
  //   · 收窄同时**腾出了可选的点**：东南近路这一带原本只有 27 个合格点，
  //     而且分在三个互不相邻的"口袋"里（最小口袋只有 3 个点），
  //     塔楼挤进去必然两两重叠 —— 实测旧配置前两栋塔只隔 **16.1m**，
  //     而塔楼底面就有 13~17m 宽，那是两栋楼穿在一起。
  //
  // **step 从 26 减到 12** 只加候选、不加面数：步长就是候选网格的疏密，
  // 26m 时一个口袋只出 3~5 个点，净距要求根本无从谈起；12m 时同一片地出 113 个。
  // 面数由 `max` 决定，与步长无关。
  mod_tower: { quad: [1, 1], max: 3, step: 12, scale: [34, 44], road: [40, 110], pick: 'cluster', spacing: 40, gap: 40, clusterR: 55, radius: 280 },
  // 圆屋：离路 40~110m，**围着已经放好的塔楼摆**。
  //
  // 离路上限从 200 收到 110 与塔楼同一条线，是同一个理由（低档雾 175m）。
  // `clusterR` 同为 55：整片聚落 107m 见方，站在路边一眼能看全，
  // 不用骑过半圈才发现"哦，这儿是一堆房子"。
  mod_house: { quad: [1, 1], max: 4, step: 10, scale: [11, 16], road: [34, 110], pick: 'cluster', spacing: 22, gap: 40, clusterR: 55, radius: 240 },
};

/** 埋进地里的深度（米）。竹子尤其需要——裁完的底面是一个平面，不埋会露出来。 */
const BURY: Record<SceneryKind, number> = { bamboo: 0.6, mod_tower: 0, mod_house: 0 };

/** 沿中心线的最短距离（米）。命中弧长之后在附近窗口里精算。 */
export function distToRoad(px: number, pz: number): number {
  const s = nearestArcParam(px, pz) * TOTAL_ARCLENGTH;
  const n = CENTERLINE.length;
  // 窗口 ±60m：够覆盖最近那一段，又不用扫全路径
  const c = Math.round((s / TOTAL_ARCLENGTH) * (n - 1));
  const span = Math.max(2, Math.round((60 / TOTAL_ARCLENGTH) * (n - 1)));
  let best = Infinity;
  for (let i = Math.max(0, c - span); i <= Math.min(n - 1, c + span); i++) {
    const p = CENTERLINE[i];
    const d = (p.x - px) ** 2 + (p.z - pz) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** 四角采样求坡度（米/米）。用真实高程，不用 `naturalHeightAt` 的解析式。 */
function slopeAt(terrain: Terrain, x: number, z: number, step: number): number {
  const h = terrain.getHeightAt(x, z);
  const dx = Math.abs(terrain.getHeightAt(x + step, z) - h);
  const dz = Math.abs(terrain.getHeightAt(x, z + step) - h);
  return Math.max(dx, dz) / step;
}

/** 离最近一座驿站够不够远。 */
function nearStation(x: number, z: number, margin: number): boolean {
  for (const s of STATIONS) {
    if (Math.hypot(x - s.mapX, z - s.mapZ) < ROAD.STATION_OFFSET + margin) return true;
  }
  return false;
}

export class Scenery {
  readonly group = new Group();
  private cells: Cell[] = [];
  private terrain: Terrain;
  private lastCellIndex = -1;

  /** 统计，给探针与调试面板 */
  stats = { bamboo: 0, mod_tower: 0, mod_house: 0, visibleCells: 0, drawCalls: 0 };

  /**
   * **不收 preset。** 这正是植被那一课：档位差异该由**半径**（剔除）承担，
   * 不该再叠一层密度系数砍第二刀。散布总共只有 41 个对象，
   * 而每个对象模型不同、面数差两个数量级——真正该管的是"什么时候看不见"，
   * 那在 `update()` 里，不在布置里。
   */
  constructor(terrain: Terrain) {
    this.terrain = terrain;
    this.group.name = 'scenery';
    this.build();
  }

  private build() {
    const t = this.terrain;
    /**
     * 已经放好的建筑中心，**跨 kind 共用一份**。
     *
     * 以前每一类各自取点、彼此看不见对方，于是塔楼不知道圆屋在哪儿、
     * 圆屋也不知道塔楼在哪儿 —— 两套各自正确的分布拼不出聚落。
     * 现在按 `Object.keys(SPEC)` 的顺序摆（竹 → 塔 → 屋），
     * 后摆的那类直接查这份名单，于是"围着塔楼摆"是一句可以被执行的话。
     *
     * `gap: 0` 的（竹）不进这份名单，见 `SPEC.gap` 的注释。
     */
    const placed: { kind: SceneryKind; x: number; z: number }[] = [];
    const plan = this.planSettlement();

    for (const kind of Object.keys(SPEC) as SceneryKind[]) {
      const sp = SPEC[kind];
      if (plan && kind !== 'bamboo') {
        for (const c of plan[kind]) {
          this.stats[kind]++;
          placed.push({ kind, x: c.x, z: c.z });
          this.cellAt(kind, c.x, c.z).items.push(c);
        }
        continue;
      }
      const [sx, sz] = sp.quad;

      // 世界包围盒（中心线扫一遍就够，植被全在这条线附近）
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of CENTERLINE) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
      }
      // 往象限外多扫 200m：离路上限 230m，候选点还得能落在路的外侧
      const x0 = sx > 0 ? 8 : minX - 200;
      const x1 = sx > 0 ? maxX + 200 : -8;
      const z0 = sz > 0 ? 8 : minZ - 200;
      const z1 = sz > 0 ? maxZ + 200 : -8;

      const cand: { x: number; z: number; y: number; rd: number; r3: number }[] = [];
      for (let z = z0; z <= z1; z += sp.step) {
        for (let x = x0; x <= x1; x += sp.step) {
          const gi = Math.round(x / sp.step);
          const gj = Math.round(z / sp.step);
          const r1 = hashGrid(gi, gj, 4441);
          const r2 = hashGrid(gi, gj, 8317);
          const r3 = hashGrid(gi, gj, 2251);
          const px = x + (r1 - 0.5) * sp.step * 1.6;
          const pz = z + (r2 - 0.5) * sp.step * 1.6;

          // 象限内（离交叉口至少 8m，免得全挤在原点附近）
          if (sx * px < 8 || sz * pz < 8) continue;
          // 离路**区间**：下限是别压路，上限是"玩家看得见"。
          // 这一条是踩过坑才有的：最初没有上限，候选从象限角落开始贪心填，
          // 结果竹子全落在离路 460m 处——而雾距上限才 400m，玩家一辈子看不见。
          const rd = distToRoad(px, pz);
          if (rd < sp.road[0] || rd > sp.road[1]) continue;
          // 水位
          const h = t.getHeightAt(px, pz);
          if (h < WATER_LEVEL + MIN_DRY) continue;
          // 坡度
          if (slopeAt(t, px, pz, 6) > MAX_SLOPE) continue;
          // 驿站
          if (nearStation(px, pz, kind === 'bamboo' ? 2 : 12)) continue;
          cand.push({ x: px, z: pz, y: h, rd, r3 });
        }
      }

      /**
       * 净距：同类看 `spacing`，异类看两边 `gap` 的较大者。
       * 这是 `slice()` 之前的一道闸 —— 以前是排序完直接切前 N 个，
       * 于是"最近的 3 个"可以是相距 16m 的两个点。
       */
      const farEnough = (x: number, z: number) =>
        placed.every((p) => {
          const need = p.kind === kind ? sp.spacing : Math.max(sp.gap, SPEC[p.kind].gap);
          return Math.hypot(x - p.x, z - p.z) >= need;
        });

      // 挑选
      if (sp.pick === 'near') cand.sort((a, b) => a.rd - b.rd);
      else if (sp.pick === 'hash') cand.sort((a, b) => a.r3 - b.r3);
      else {
        /**
         * `cluster`：排序键是**"这东西离聚落有多近"**，取完再过聚落半径的闸。
         *
         *   · **名单还是空的**（第一类建筑）→ 键是离路距离，于是聚落从路边开始长，
         *     而不是从象限最远的角落开始往回填；
         *   · **名单里已经有东西了**（圆屋排在塔楼后面）→ 键是到已放置建筑的**最近**距离，
         *     于是圆屋自动围到塔楼周围，而不是自己另找地方开一堆。
         *
         * "最近"而不是"平均"是有讲究的：键取最近距离时，一件东西只要能挨着
         * 任何一件已放置的就会被优先取用，于是聚落是**连成一片**的；
         * 取平均距离则会让新东西往中心挤，最后围出一个空心的环。
         *
         * 破平用 `rd` 再 `r3`，全程确定性。
         */
        const nearness = (x: number, z: number) =>
          placed.reduce((m, p) => Math.min(m, Math.hypot(x - p.x, z - p.z)), Infinity);
        cand.sort(
          (a, b) =>
            (placed.length === 0 ? a.rd : nearness(a.x, a.z)) - (placed.length === 0 ? b.rd : nearness(b.x, b.z)) ||
            a.rd - b.rd ||
            a.r3 - b.r3,
        );
      }

      /**
       * 聚落半径的闸：**同类**的东西不许跑出"这一类第一个落点"的 `clusterR`。
       *
       * 只对 `pick: 'cluster'` 生效 —— 竹子是 `hash`，它要的就是铺开，
       * 而 `clusterR: 0` 在这里会变成"第一丛之外全都不许放"（踩过：竹子只剩 1 丛）。
       *
       * 为什么半径要挂在"第一个落点"上而不是每次重算：它是这片聚落的**地心**，
       * 一旦换地心，扫过的候选集就变了，摆在哪儿也跟着变 ——
       * 那就成了"每次刷新换片开发区"，正是全篇要避免的。
       */
      let seed: { x: number; z: number } | null = null;

      // 逐个过净距与聚落半径的闸，凑满 `max` 为止
      let taken = 0;
      for (const c of cand) {
        if (taken >= sp.max) break;
        if (sp.pick === 'cluster' && seed && Math.hypot(c.x - seed.x, c.z - seed.z) > sp.clusterR) continue;
        if (!farEnough(c.x, c.z)) continue;
        taken++;
        if (!seed) seed = c;
        this.stats[kind]++;
        if (sp.gap > 0) placed.push({ kind, x: c.x, z: c.z });
        this.cellAt(kind, c.x, c.z).items.push({
          x: c.x,
          y: c.y,
          z: c.z,
          // 建筑正面大致朝着路；竹子随便转
          rotY: kind === 'bamboo' ? c.r3 * Math.PI * 2 : this.faceRoad(c.x, c.z, c.r3),
          scale: sp.scale[0] + c.r3 * (sp.scale[1] - sp.scale[0]),
        });
      }
    }
  }

  /**
   * 东南住区的**规划**布局：沿一段路排两列，前低后高，全部朝向同一个方向。
   *
   * 之前的 `cluster` 解决了「散」，没解决「乱」：每栋各自朝向最近的路点、
   * 各自叠一份随机偏转，三座塔楼转了 44° / −41° / 67°，四座圆屋挤成一团、
   * 彼此几乎相切——从路上看是「一堆楼」，不是「一个住区」。
   *
   * 现在在东南象限里按 5m × 15° 搜一个固定网格（`PLAN`）的落位与朝向：
   *   · 前排 4 座圆屋，间距 `HOUSE_GAP`，离路大致相等（与路平行）；
   *   · 后排 3 座塔楼，比前排远 `ROW_GAP`，间距 `TOWER_GAP`，中间那座最高。
   * 每个落点照样过离路区间 / 水位 / 坡度 / 驿站 / 象限这几道闸；
   * 合格的里取「地形高差最小 + 前排最平行 + 离路最近」的那一个。
   * 东南角是夹在两条支路之间的一条窄楔，圆屋的离路下限因此放到 34m
   * （圆屋直径约 17m，34m 外仍在行道树树冠之外）。
   * 找不到就返回 null，退回原来的 `cluster` 摆法——那仍然是合格的布局。
   */
  private planSettlement(): Record<'mod_tower' | 'mod_house', Placement[]> | null {
    const t = this.terrain;
    let maxX = -Infinity, maxZ = -Infinity;
    for (const p of CENTERLINE) { maxX = Math.max(maxX, p.x); maxZ = Math.max(maxZ, p.z); }
    // 离路距离先烘成 5m 一格的表：逐帧去问 `distToRoad` 要几亿次运算，开局等不起。
    // 表是近似值，所以搜索只用来排序，选中之后按顺序用精确值复核，第一个过的才算。
    const G = 5;
    const x0 = 8, z0 = 8;
    const nx = Math.ceil((maxX + 60 - x0) / G) + 1;
    const nz = Math.ceil((maxZ + 60 - z0) / G) + 1;
    const rdGrid = new Float32Array(nx * nz);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) rdGrid[j * nx + i] = distToRoad(x0 + i * G, z0 + j * G);
    const rdAt = (x: number, z: number) => {
      const gx = (x - x0) / G, gz = (z - z0) / G;
      const i = Math.floor(gx), j = Math.floor(gz);
      if (i < 0 || j < 0 || i >= nx - 1 || j >= nz - 1) return Infinity;
      const fx = gx - i, fz = gz - j;
      const r0 = rdGrid[j * nx + i] * (1 - fx) + rdGrid[j * nx + i + 1] * fx;
      const r1 = rdGrid[(j + 1) * nx + i] * (1 - fx) + rdGrid[(j + 1) * nx + i + 1] * fx;
      return r0 * (1 - fz) + r1 * fz;
    };
    type Slot = { kind: 'mod_tower' | 'mod_house'; x: number; z: number; y: number; u: number };
    const layout = (ax: number, az: number, th: number, margin: number, rd: (x: number, z: number) => number) => {
      const tx = Math.cos(th), tz = Math.sin(th);
      const ox = -tz, oz = tx;
      const slots: Slot[] = [];
      const rows: ['mod_tower' | 'mod_house', number, number, number, number][] = [
        ['mod_house', 0, PLAN.HOUSE_GAP, SPEC.mod_house.max, SPEC.mod_house.road[0]],
        ['mod_tower', PLAN.ROW_GAP, PLAN.TOWER_GAP, SPEC.mod_tower.max, SPEC.mod_tower.road[0]],
      ];
      let houseRd = 0, towerRd = 0, hLo = Infinity, hHi = -Infinity, fLo = Infinity, fHi = -Infinity;
      for (const [kind, v, gap, count, lo] of rows) {
        for (let k = 0; k < count; k++) {
          const u = (k - (count - 1) / 2) * gap;
          const x = ax + tx * u + ox * v;
          const z = az + tz * u + oz * v;
          const d = rd(x, z);
          if (x < 8 || z < 8 || d < lo + margin || d > SPEC[kind].road[1] - margin) return null;
          const y = t.getHeightAt(x, z);
          if (y < WATER_LEVEL + MIN_DRY || slopeAt(t, x, z, 6) > MAX_SLOPE || nearStation(x, z, 12)) return null;
          if (kind === 'mod_house') { houseRd += d / count; fLo = Math.min(fLo, d); fHi = Math.max(fHi, d); }
          else towerRd += d / count;
          hLo = Math.min(hLo, y);
          hHi = Math.max(hHi, y);
          slots.push({ kind, x, z, y, u });
        }
      }
      // 塔楼必须真的在后排；前排要与路大致平行（离路距离差小）
      if (towerRd < houseRd + 15) return null;
      return { slots, rot: Math.atan2(oz, -ox), score: hHi - hLo + (fHi - fLo) * 0.1 + (houseRd - 30) * 0.02 };
    };
    const found: { ax: number; az: number; th: number; score: number }[] = [];
    for (let az = 10; az <= maxZ + 40; az += 5) {
      for (let ax = 10; ax <= maxX + 40; ax += 5) {
        for (let k = 0; k < 24; k++) {
          const th = (k / 24) * Math.PI * 2;
          const l = layout(ax, az, th, 0, rdAt);
          if (l) found.push({ ax, az, th, score: l.score });
        }
      }
    }
    found.sort((p, q) => p.score - q.score || p.ax - q.ax || p.az - q.az || p.th - q.th);
    for (const f of found) {
      const l = layout(f.ax, f.az, f.th, 0, distToRoad);
      if (!l) continue;
      const out: Record<'mod_tower' | 'mod_house', Placement[]> = { mod_tower: [], mod_house: [] };
      for (const sl of l.slots) {
        const [s0, s1] = SPEC[sl.kind].scale;
        // 塔楼中间最高、两侧次之；圆屋统一取中值——一排同样大的房子才读得出「规划过」
        const scale = sl.kind === 'mod_house' ? PLAN.HOUSE_SCALE : Math.abs(sl.u) < 1e-6 ? s1 : (s0 + s1) / 2;
        out[sl.kind].push({ x: sl.x, y: sl.y, z: sl.z, rotY: l.rot, scale });
      }
      return out;
    }
    return null;
  }

  /** 让建筑的正面大致朝着路。`jitter` 是随机偏转，免得几栋排成一条直线。 */
  private faceRoad(px: number, pz: number, jitter: number): number {
    const s = nearestArcParam(px, pz);
    const n = CENTERLINE.length;
    const i = Math.max(0, Math.min(n - 1, Math.round(s * (n - 1))));
    const p = CENTERLINE[i];
    // 模型长轴是本地 +X，要它指向路心：(cosθ, 0, −sinθ) = normalize(p − v)
    const dx = p.x - px;
    const dz = p.z - pz;
    const l = Math.hypot(dx, dz) || 1;
    return Math.atan2(-dz / l, dx / l) + (jitter - 0.5) * 0.5;
  }

  private cellAt(kind: SceneryKind, x: number, z: number): Cell {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (const c of this.cells) {
      if (c.kind === kind && c.cx === cx && c.cz === cz) return c;
    }
    const cell: Cell = { kind, cx, cz, items: [], mesh: null };
    this.cells.push(cell);
    return cell;
  }

  /**
   * 装上模型网格。每格一个 InstancedMesh（每格一次 draw call）。
   *
   * 和植被一样，模型原点在底面之外时要抬——`pine.glb` / `bamboo.glb`
   * 的 min.y 都是 0，所以这里算出来是 0，但**不假设**它们是 0：
   * 换个来源的模型原点可能不在底面，而"建筑浮空"是画面上一眼能看出来的。
   */
  attachMeshes(meshes: Partial<Record<SceneryKind, { geo: BufferGeometry; mat: Material | null }>>) {
    for (const cell of this.cells) {
      const src = meshes[cell.kind];
      if (!src || cell.items.length === 0) continue;
      const m = new InstancedMesh(src.geo, src.mat ?? new MeshStandardMaterial({ roughness: 0.9 }), cell.items.length);
      const bottom = bottomOf(src.geo);
      const mat4 = new Matrix4();
      const q = new Quaternion();
      const pos = new Vector3();
      const scl = new Vector3();
      const up = new Vector3(0, 1, 0);
      for (let i = 0; i < cell.items.length; i++) {
        const p = cell.items[i];
        q.setFromAxisAngle(up, p.rotY);
        scl.setScalar(p.scale);
        pos.set(p.x, p.y - bottom * p.scale - BURY[cell.kind], p.z);
        mat4.compose(pos, q, scl);
        m.setMatrixAt(i, mat4);
      }
      m.instanceMatrix.needsUpdate = true;
      m.castShadow = true;
      m.receiveShadow = true;
      m.name = `scenery-${cell.kind}@${cell.cx},${cell.cz}x${cell.items.length}`;
      cell.mesh = m;
      this.group.add(m);
    }
  }

  /**
   * 每帧更新可见格。
   *
   * 只有玩家跨过格边界才重算——和植被同一个理由：每帧重算是纯粹的浪费。
   * 半径按每样东西自己的 `SPEC.radius`，再加心神带来的可见系数。
   */
  update(px: number, pz: number, visibilityFactor: number) {
    const cur = Math.floor(px / CELL) + Math.floor(pz / CELL) * 100003;
    if (cur === this.lastCellIndex) return;
    this.lastCellIndex = cur;

    let visibleCells = 0;
    let calls = 0;
    for (const c of this.cells) {
      const r = Math.max(SPEC[c.kind].radius * visibilityFactor, 1);
      // 格心与玩家的距离，按格心所在的环取
      const d = Math.hypot(c.cx * CELL + CELL / 2 - px, c.cz * CELL + CELL / 2 - pz);
      const show = d <= r + CELL;
      if (c.mesh) c.mesh.visible = show;
      if (show) {
        visibleCells++;
        calls++;
      }
    }
    this.stats.visibleCells = visibleCells;
    this.stats.drawCalls = calls;
  }

  invalidate() {
    this.lastCellIndex = -1;
  }

  /**
   * 离 (x, z) 最近的**景物建筑**有多远。附近一个都没有时返回 `Infinity`。
   *
   * ## 为什么不算竹子
   *
   * 这个查询存在的唯一目的是回答「玩家是不是以为站在一栋能进的地方旁边」。
   * 竹丛不是房子——站在竹子旁边按空格没有反应**完全合理**，
   * 而把它算进去会让每一片路边竹林都触发一句解释，而那句话和眼前的竹子对不上号。
   * 那正是当初把远处改成一概沉默时想避开的东西。
   *
   * ## 为什么在 `update()` 的缓存之外算
   *
   * `update()` 只在跨格时重算可见性，而这里的半径比剔除半径小得多，
   * 两者对不上——所以宁可每次问的时候直接扫一遍落点：`cells` 只有几十个，
   * 每帧一次平方根的开销可以忽略，而**复用错缓存的风险不能忽略**。
   */
  nearestBuilding(x: number, z: number): number {
    let best = Infinity;
    for (const c of this.cells) {
      if (c.kind === 'bamboo') continue;
      for (const p of c.items) {
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < best) best = d;
      }
    }
    return best;
  }
}

/**
 * 给回归与探针用：各类散布的落点。
 *
 * 返回**原始落点**而不是网格，因为回归要验的是"位置对不对"，
 * 网格只是绘制实现——`attachMeshes` 没调（无头环境里没有 GLB）时它照样成立。
 */
export function sceneryPlacements(sc: Scenery): Record<SceneryKind, { x: number; y: number; z: number; scale: number; rotY: number }[]> {
  const out = { bamboo: [], mod_tower: [], mod_house: [] } as Record<
    SceneryKind,
    { x: number; y: number; z: number; scale: number; rotY: number }[]
  >;
  const cells = (sc as unknown as { cells: Cell[] }).cells;
  for (const c of cells) {
    for (const it of c.items) {
      out[c.kind].push({ x: it.x, y: it.y, z: it.z, scale: it.scale, rotY: it.rotY });
    }
  }
  return out;
}

/** 每类散布的规格常量，回归要读 `quad` 与 `minRoad` 而不是把它们再抄一遍。 */
export function scenerySpec(kind: SceneryKind) {
  return SPEC[kind];
}
