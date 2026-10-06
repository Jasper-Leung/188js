/**
 * 区域散布 —— 竹丛与两栋现代建筑。
 *
 * ## 为什么不是又一套"沿路摆放"
 *
 * `vegetation.ts` 是**沿中心线按弧长**摆的（行道树紧贴路肩）。
 * 这三样东西不一样：
 *
 *   · **竹**在西北（屏幕左上）成丛，离路 30~90m，���的是"远处山坡上是竹林"；
 *   · **现代建筑**在东南（屏幕右下），代表**已经被开发过的地方**——
 *     它们的存在本身就是叙事：这个环线上其余地方没人来过，只有这一角动过土。
 *
 * 按弧长摆不出来（它们不在路边），所以这里用**粗网格分桶**：
 * 64m 一格，每格一个 InstancedMesh，每帧按距离开关 `visible`。
 * 这与 `vegetation.ts` 的块剔除是同一个套路，只是把"沿弧长的块"
 * 换成"平面上的格"——因为散布点是二维的，不是跟着路走的。
 *
 * ## 为什么每样只摆几个
 *
 * 这不是行道树，不能按密度撒：
 *
 *   · `mod_house` **86,386 面**——一栋就顶 3 丛竹（4,954 面），
 *     而它只有一个 draw call 却让整帧多 8.6 万面。所以东南只放 3 栋塔楼 + 4 栋圆屋，
 *     **而且它们必须是"远处才看得见的尺度"**：模型归一化到 1 单位，
 *     塔楼高 0.257、圆屋高 0.380，缩放到 40 / 14 才是 10m 与 5.3m 的房子，
 *     配 35m / 14m 的占地——读作"一片新区"而不是"两栋玩具屋"。
 *   · **竹**便宜，但要成丛才有意义：散着摆 40 丛是"草"，聚成几片才是"竹林"。
 *
 * ## 判定用的四个约束
 *
 * 每一个都对应一次"放错了看得出来"：
 *
 *   1. **离路太近** —— 建筑压在路面上比不放还糟；
 *   2. **在水下** —— `getHeightAt` 低于水位 + 0.6m 就丢，竹子泡在水里最出戏；
 *   3. **坡太陡** —— 四角采样算坡度，超过阈值就丢，否则建筑一半悬空；
 *   4. **压着驿站** —— 驿站有 keepout 半径，建筑骑在人家屋顶上是不允许的。
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
   * `near` = 就近优先（先挑离路最近的）——建筑要成"一片"，
   * 挑最近的正好让它们抱团读作一个开发区；
   * `hash` = 按散列打散——竹子要铺开，聚成一坨就变成"一丛草"而不是"竹林"。
   */
  pick: 'near' | 'hash';
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
  bamboo: { quad: [-1, -1], max: 100, step: 9, scale: [13, 22], road: [26, 110], pick: 'hash', radius: 150 },
  // 塔楼：离路 70~230m，抱团 = 一个新区。
  mod_tower: { quad: [1, 1], max: 3, step: 26, scale: [34, 44], road: [70, 230], pick: 'near', radius: 280 },
  // 圆屋：离路 60~200m，围着塔楼散开。
  mod_house: { quad: [1, 1], max: 4, step: 24, scale: [11, 16], road: [60, 200], pick: 'hash', radius: 240 },
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
    for (const kind of Object.keys(SPEC) as SceneryKind[]) {
      const sp = SPEC[kind];
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

      // 挑选：`near` 就近抱团（建筑读作一片新区），`hash` 按散列铺开（竹子读作竹林）
      if (sp.pick === 'near') cand.sort((a, b) => a.rd - b.rd);
      else cand.sort((a, b) => a.r3 - b.r3);

      for (const c of cand.slice(0, sp.max)) {
        this.stats[kind]++;
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
}

/**
 * 给回归与探针用：各类散布的落点。
 *
 * 返回**原始落点**而不是网格，因为回归要验的是"位置对不对"，
 * 网格只是绘制实现——`attachMeshes` 没调（无头环境里没有 GLB）时它照样成立。
 */
export function sceneryPlacements(sc: Scenery): Record<SceneryKind, { x: number; y: number; z: number; scale: number }[]> {
  const out = { bamboo: [], mod_tower: [], mod_house: [] } as Record<
    SceneryKind,
    { x: number; y: number; z: number; scale: number }[]
  >;
  const cells = (sc as unknown as { cells: Cell[] }).cells;
  for (const c of cells) {
    for (const it of c.items) {
      out[c.kind].push({ x: it.x, y: it.y, z: it.z, scale: it.scale });
    }
  }
  return out;
}

/** 每类散布的规格常量，回归要读 `quad` 与 `minRoad` 而不是把它们再抄一遍。 */
export function scenerySpec(kind: SceneryKind) {
  return SPEC[kind];
}
