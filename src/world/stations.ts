/**
 * 驿站 —— 16 座地标。按距离渐进加载，低档用剪影替身。
 *
 * 为什么要剪影替身（`stationSilhouette`）：低档的绘制预算要花在
 * 玩家脚下 50m 内的东西上，200m 外的亭子只需要一个**形状**在那儿挡着，
 * 不需要它的屋顶纹理和飞檐细节。替身是一个按模型包围盒生成的、
 * 烘焙了颜色的简单几何体，一次 draw call，零贴图。
 *
 * 但替身**必须在 120m 内换回真模型**——玩家是要在驿站前打卡、
 * 要看清它长什么样的。如果一直用替身，驿站就变成了几个色块，
 * 整个"收集与合成"的情绪线就没有落点。
 *
 * ## 16 座现在全部走同一条路
 *
 * 源项目 13 个站模型里有 7 个是作者搭的灰盒（驿楼/茶寮/岭台/神苑/凉亭/廊/亭灯，
 * 每个部件就是一个长方体，整站 24~84 个顶点）。这 7 座曾经由
 * `architecture.ts` 程序化生成，2026-10 换成了 Tripo 生成的真模型——
 * 那个模块连同它的判据已经删掉了，这里是**唯一**一条加载路径。
 *
 * 模型单位 × `cfg.scale` = 场景米数（驿楼 ×10、凉亭 ×12、亭灯 ×14），
 * 所以 `assets-src/tripo/` 里那份低模已经按这个表归一化过，
 * 改的时候别改 `world.json` 的 `scale`——那是 `extract-data.mjs` 的产物，
 * 手改会被下一次提取覆盖掉。硬约束由 `verify_station_models` 守着。
 */
import {
  Group,
  Object3D,
  Box3,
  Vector3,
  Mesh,
  MeshBasicMaterial,
  Color,
  OctahedronGeometry,
} from 'three';
import { WORLD } from '../data/raw';
import { STATIONS, type StationPlacement, CENTERLINE, TOTAL_ARCLENGTH, pointAtArcLength } from '../data/route';
import { loadModel, modelUrl, tintModel, type LoadedModel } from './assets';
import type { Terrain } from './terrain';
import type { QualityPreset } from '../core/settings';

export interface StationRuntime {
  index: number;
  placement: StationPlacement;
  /** 世界坐标（含模型高度） */
  worldPos: Vector3;
  /** 模型的水平包围半径（米），骑行时做 keepout */
  radius: number;
  modelIdx: number;
  loaded: boolean;
  /** 真模型 / 剪影 */
  object: Object3D | null;
  glowY: number;
  glowRange: number;
  labelY: number;
}

// ---------------------------------------------------------------- 比例修正
/**
 * **非等比缩放**修正表。键是 `model_idx`，值是 `[水平倍率, 竖直倍率]`。
 *
 * ## 为什么需要它
 *
 * 琴音林（`model_idx = 2`，`station_2.glb`）**不是一个亭子**——
 * 把它的贴图导出来看就清楚了：那是**从空中俯拍的一整片林冠**
 * （树冠、树下的地面、间杂的石头，全在一张 1024² 里）。
 * 所以它天然是一个 **10.0m 宽 × 9.0m 高的地块**，高宽比只有 0.903：
 * 摆在地上读出来是**一块扁平的绿毯**，而不是"林子"。
 *
 * 而"琴音林"这个名字、它那三句旁白（"林子里没有舞台，风一经过，
 * 树影就开始合奏"）要的恰恰是**站得高、遮得住人的树**。
 * 比例就是这里唯一对不上的地方。
 *
 * ## 为什么只拉 Y，不缩 XZ
 *
 * **水平尺寸是硬约束，不是审美数字**：驿站落在中心线外 18m，
 * `verify_stations` 钉着"离中心线 ≥ 路宽 6.5 + 0.9 × 站脚半宽 8 = 13.7m"。
 * 现在这块林冠地块半宽 5.0m（18 − 5.0 = 13.0m，**只剩 0.7m 余量**），
 * 所以 XZ 一动就顶穿那条判据。拉高不动占地，是唯一安全的自由度。
 *
 * ## 2.6 这个数怎么来的
 *
 * 目标是"读得出是高树"。`tree.glb`（榕树下那座地标）实测高宽比 **2.18**，
 * 是这个项目里已经被认成"树"的那一个；取 **2.6** 比它更瘦，
 * 因为琴音林是一整片林冠而不是单株，读成细高杆反而假。
 * 换算下来 9.0m → **23.4m**，与林冠的航拍尺度（俯视一片树梢）是自洽的。
 *
 * **`label_y` 必须跟着抬**：站名标签挂在 14m，而地块原本只有 9.0m 高；
 * 不抬的话标签会埋进树冠里——那正是 `verify_stations`
 * 对程序化地标那条"不许插进屋顶"要防的事，这里对 GLB 站同理。
 * 抬到 26m 之后标签浮在树冠之上 2.6m。
 */
const STATION_STRETCH: Record<number, readonly [number, number]> = {
  2: [1, 2.6],
};
/** 站名标签要跟着竖直倍率一起抬，否则会埋进被拉高的树冠里。 */
const STATION_LABEL_LIFT = 26;

/**
 * 竖直拉伸后站名锚点该挂多高。
 *
 * 导出成纯函数是为了能无头验：回归要守的正是"琴音林被拉高之后，
 * 标签仍然浮在它上面"，而这件事在无头环境里没有 GLB 可加载，
 * 只能靠这张表 + 这条公式解析地算。
 */
export function labelYFor(modelIdx: number, baseLabelY: number): number {
  const sy = STATION_STRETCH[modelIdx]?.[1] ?? 1;
  return sy > 1 ? STATION_LABEL_LIFT : baseLabelY;
}

/** 水平倍率。拉高不占地，所以恒为 1；留着是为了 XZ 真要调时有落点。 */
export function stationStretch(modelIdx: number): readonly [number, number] {
  return STATION_STRETCH[modelIdx] ?? [1, 1];
}

/**
 * 本地 -Z 是正面、朝向由 `yawFacingRoad` 现场算的模型下标。
 *
 * 就是 Tripo 换上的那七座地标（`model_idx` 6~12）。`world.json` 给它们的
 * `rot_y` 全是 0，而这七座分布在整个 8 字上——不转向的话，
 * 七座里有大半把背面和山墙对着路，玩家看到的读不出来是什么。
 * 有 `rot_y` 的站不受影响，那是从源项目原样搬过来的数据。
 */
const FRONT_FACING_MODEL_IDX = new Set([6, 7, 8, 9, 10, 11, 12]);

export class Stations {
  readonly group = new Group();
  readonly list: StationRuntime[] = [];
  private preset: QualityPreset;
  private silhouetteGroup = new Group();

  constructor(preset: QualityPreset, terrain: Terrain) {
    this.preset = preset;
    this.group.name = 'stations';
    this.group.add(this.silhouetteGroup);

    for (let i = 0; i < STATIONS.length; i++) {
      const placement = STATIONS[i];
      const cfg = WORLD.STATION_GLB_CONFIG[placement.def.model_idx];
      const groundY = terrain.getHeightAt(placement.x, placement.z);
      const entry: StationRuntime = {
        index: i,
        placement,
        worldPos: new Vector3(placement.x, groundY, placement.z),
        radius: 8,
        modelIdx: placement.def.model_idx,
        loaded: false,
        object: null,
        glowY: cfg?.glow_y ?? 6,
        glowRange: cfg?.glow_range ?? 10,
        labelY: labelYFor(placement.def.model_idx, cfg?.label_y ?? 10),
      };
      this.list.push(entry);
      // 剪影替身先摆上，玩家一进场就能看见路边的"东西在那儿"
      this.addSilhouette(i, placement, groundY, cfg);
    }
  }

  private addSilhouette(i: number, p: StationPlacement, groundY: number, cfg: { scale: number } | undefined) {
    if (!this.preset.stationSilhouette) return;
    // 替身尺寸按真模型的标称缩放估。原项目实测：最宽的模型脚底半宽 7.8m
    // （station_岭台 @ scale 10），所以按 7.8m 取半径不会显得瘦。
    const s = cfg?.scale ?? 10;
    const halfW = 7.8;
    // **竖直倍率必须跟真模型一致**：琴音林被拉高 2.6 倍后是 23.4m，
    // 替身还按 13m 摆就变成"树还没长出来先换了替身"——高度会跳。
    const [, sy] = stationStretch(p.def.model_idx);
    const height = 13 * (s / 10) * sy;
    // MeshBasicMaterial：不吃光照、不吃阴影、不吃贴图。
    // 200m 外的亭子只需要一个"在那儿挡着"的形状，它不需要被照亮。
    const mat = new MeshBasicMaterial({
      color: new Color(p.def.color[0] * 0.5, p.def.color[1] * 0.45, p.def.color[2] * 0.42),
      fog: true,
    });
    const m = new Mesh(new OctahedronGeometry(1, 0), mat);
    m.scale.set(halfW, height * 0.5, halfW);
    m.position.set(p.x, groundY + height * 0.48, p.z);
    m.name = `station-silhouette-${i}`;
    m.renderOrder = -1;
    this.silhouetteGroup.add(m);
  }

  /**
   * 按距离加载。**每 0.5 秒最多加一座**——
   * 16 座一次性涌进来会在弱机上造成一次明显的长卡顿，
   * 而玩家根本看不出"这一瞬间多了一座亭子"。
   */
  update(playerX: number, playerZ: number) {
    const d = this.preset.stationLoadDistance;
    let added = 0;
    for (const st of this.list) {
      if (st.loaded) continue;
      const dist = Math.hypot(st.worldPos.x - playerX, st.worldPos.z - playerZ);
      if (dist > d) continue;
      if (added >= 2) break;
      added++;
      void this.loadOne(st);
    }
  }

  private async loadOne(st: StationRuntime) {
    const cfg = WORLD.STATION_GLB_CONFIG[st.modelIdx];
    if (!cfg) {
      st.loaded = true;
      return;
    }
    const model = await loadModel(modelUrl(cfg.path));
    st.loaded = true;
    if (!model) return;

    const g = new Group();
    g.add(model.root);
    const scale = cfg.scale;
    // **非等比缩放**：琴音林那片林冠要拉高成"高的树"（见 STATION_STRETCH）。
    // 水平倍率恒为 1，所以 keepout 半径仍然是 `horizontalRadius(box) * scale`。
    const [sx, sy] = stationStretch(st.modelIdx);
    g.scale.set(scale * sx, scale * sy, scale * sx);
    // 朝向有两种来源。`world.json` 里显式给了 `rot_y` 的站（五座图集模型 +
    // 榕树下）用它；Tripo 换上的七座地标数据里 `rot_y` 都是 0，
    // 那等于七座建筑全部朝正北——环线上哪个方向都有站，
    // 于是大半座建筑把**背面**对着路。按本地 -Z 是正面的约定转向路。
    g.rotation.y = FRONT_FACING_MODEL_IDX.has(st.modelIdx)
      ? yawFacingRoad(st.placement.x, st.placement.z)
      : ((cfg.rot_y ?? 0) * Math.PI) / 180;
    g.position.set(st.placement.x, 0, st.placement.z);
    // 用包围盒把底面贴到地面。Blender 导出的模型原点在底面中心，
    // 但不同导出器不保证，所以这里量一次。
    //
    // **`box.min.y` 要乘竖直倍率**，不是 `scale`：等比缩放时两者相同，
    // 拉高之后按 `scale` 算会少抬 `min.y × (scale × (sy−1))`，
    // 症状是"树冠地块沉进地里一截"——而琴音林的模型原点恰好在底面，
    // 差值小到几乎看不出来，只在斜坡上露缝。
    const box = new Box3().setFromObject(model.root);
    g.position.y = st.worldPos.y - box.min.y * scale * sy;
    g.updateMatrixWorld(true);

    // 运行时染色：把七个手工地标压成一片"驻留在同一片阴翳里"的深色，
    // 让五座图集模型（更精细的那五座）在视觉上跳出来。
    this.applyRoofTint(model);

    // 剪影替身让位
    const sil = this.silhouetteGroup.getObjectByName(`station-silhouette-${st.index}`);
    if (sil) sil.visible = false;

    st.object = g;
    st.radius = horizontalRadius(box) * scale;
    this.group.add(g);
  }

  /**
   * 屋顶染色。
   *
   * 七个手工地标的原始 baseColor 偏亮、饱和度也压不下去，
   * 在场景里会跳成七块补丁。统一压到一片深色调（一个明显的深灰蓝），
   * 只保留"一片压得住屋檐的深色"这一个作用，让玩家的注意力
   * 落在有图集贴图的五座上。
   */
  private applyRoofTint(model: LoadedModel) {
    const tint = WORLD.STATION_ROOF_TINT;
    const roof = tint.roof?.__color;
    if (!roof) return;
    const target = new Color(roof[0], roof[1], roof[2]);
    tintModel(
      model.root,
      (mat) => (mat as { map?: unknown }).map != null,
      (mat) => {
        if (mat.color) mat.color.lerp(target, 0.72);
      },
    );
  }

  /** 站名标签锚点（世界坐标）。UI 用它摆 DOM 标签。 */
  labelAnchor(st: StationRuntime, out = new Vector3()): Vector3 {
    return out.set(st.worldPos.x, st.worldPos.y + st.labelY, st.worldPos.z);
  }

  setPreset(preset: QualityPreset) {
    this.preset = preset;
    this.silhouetteGroup.visible = preset.stationSilhouette;
  }

  /** 玩家是不是撞进站里了（水平距离 + 模型半径） */
  isInsideKeepout(st: StationRuntime, x: number, z: number, extra = 0): boolean {
    const dx = x - st.worldPos.x;
    const dz = z - st.worldPos.z;
    const r = st.radius + extra;
    return dx * dx + dz * dz < r * r;
  }
}

function horizontalRadius(box: Box3): number {
  const s = new Vector3();
  box.getSize(s);
  return Math.max(s.x, s.z) * 0.5;
}

/**
 * 让建筑正面（本地 -Z）朝向最近的路。
 *
 * 驿站在环线外侧 18m 处，而 16 座分布在整个 8 字上，朝向各不相同。
 * 随机朝向的亭子读不出"这是给路过的人用的"，
 * 而门面全部朝着骑行方向时，玩家一抬头就知道前面是什么。
 *
 * 旋转角这么算：绕 Y 转 `yaw` 把 (0,0,-1) 变成 (-sin yaw, 0, -cos yaw)，
 * 要它等于指向路的方向 (dx,dz)，于是 `yaw = atan2(-dx, -dz)`。
 *
 * 中心线每 4 个点采一次：8 字最近点用 961 点全扫是 961 次比较，
 * 而这只是构造期跑 16 次的东西，不需要更准。
 */
function yawFacingRoad(x: number, z: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < CENTERLINE.length; i += 4) {
    const p = CENTERLINE[i];
    const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const p = pointAtArcLength((best / (CENTERLINE.length - 1)) * TOTAL_ARCLENGTH).pos;
  const dx = p.x - x;
  const dz = p.z - z;
  if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) return 0;
  return Math.atan2(-dx, -dz);
}

