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
 * ## 七类地标不走 GLB
 *
 * 源项目 13 个站模型里有 7 个是作者搭的灰盒（驿楼/茶寮/岭台/神苑/凉亭/廊/亭灯，
 * 每个部件就是一个长方体）。这 7 类改由 `architecture.ts` **程序化生成**，
 * 构造时就建好，不进网络、不占 draw call 之外的任何预算。
 * 详见 `architecture.ts` 开头关于"为什么不找美术补模型"的说明。
 *
 * 生成的几何体**已经以米为单位**，所以这里不给它乘 `cfg.scale`——
 * 灰盒是"小模型 × 大缩放"（驿楼 ×10、凉亭 ×12、亭灯 ×14），
 * 两套缩放同时生效会把站撑到两倍宽，直接顶穿
 * `verify_stations` 的"离中心线 ≥ 路宽 + 0.9×foot_half"判据。
 */
import {
  Group,
  Object3D,
  Box3,
  Vector3,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Color,
  OctahedronGeometry,
  BufferGeometry,
  BufferAttribute,
} from 'three';
import { WORLD } from '../data/raw';
import { STATIONS, type StationPlacement, CENTERLINE, TOTAL_ARCLENGTH, pointAtArcLength } from '../data/route';
import { loadModel, modelUrl, tintModel, type LoadedModel } from './assets';
import { archKindFor, buildStationArch, type ArchKind } from './architecture';
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

export class Stations {
  readonly group = new Group();
  readonly list: StationRuntime[] = [];
  private preset: QualityPreset;
  private silhouetteGroup = new Group();
  /** 7 类程序化地标共用一份材质：7 次 draw call，1 个 program */
  private archMaterial: MeshStandardMaterial | null = null;

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
        labelY: cfg?.label_y ?? 10,
      };
      this.list.push(entry);
      // 剪影替身先摆上，玩家一进场就能看见路边的"东西在那儿"
      this.addSilhouette(i, placement, groundY, cfg);

      // 程序化地标：构造时一次建完，不进 `update()` 的渐进加载。
      // 灰盒只有 8~13KB，渐进加载那点"省"完全没有意义，
      // 而"建筑凭空冒出来"是玩家一眼就能看见的廉价感。
      const kind = archKindFor(entry.modelIdx);
      if (kind) this.buildArch(entry, kind, preset);
    }
  }

  /**
   * 屋顶细分。跟着渲染分辨率走而不是给每档单开一个字段：
   * 起翘屋面的价值全在曲率上，6 段已经读得出角部上扬，
   * 而这 7 座建筑加起来还不到 1 万个三角形，省这点细分不划算多一个旋钮。
   */
  private static archSeg(preset: QualityPreset): number {
    return preset.renderScale >= 1 ? 10 : preset.renderScale >= 0.8 ? 8 : 6;
  }

  private archMaterialFor(): MeshStandardMaterial {
    if (!this.archMaterial) {
      this.archMaterial = new MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.88,
        metalness: 0,
      });
    }
    return this.archMaterial;
  }

  private buildArch(entry: StationRuntime, kind: ArchKind, preset: QualityPreset) {
    const mb = buildStationArch(kind, Stations.archSeg(preset));
    const data = mb.build();
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(data.positions, 3));
    geo.setAttribute('normal', new BufferAttribute(data.normals, 3));
    geo.setAttribute('color', new BufferAttribute(data.colors, 3));
    geo.computeBoundingSphere();

    const mesh = new Mesh(geo, this.archMaterialFor());
    mesh.name = `station-arch-${entry.index}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const g = new Group();
    g.add(mesh);
    g.position.set(entry.placement.x, entry.worldPos.y, entry.placement.z);
    // 正面朝路。见 buildStationArch 的约定：本地 -Z 是正面。
    g.rotation.y = yawFacingRoad(entry.placement.x, entry.placement.z);
    g.updateMatrixWorld(true);

    // 半径按实际生成的几何量，而不是 cfg.scale——keepout 用它判"玩家撞进站里了"
    const box = new Box3().setFromObject(g);
    entry.radius = horizontalRadius(box);
    entry.object = g;
    entry.loaded = true;
    this.group.add(g);

    const sil = this.silhouetteGroup.getObjectByName(`station-silhouette-${entry.index}`);
    if (sil) sil.visible = false;
  }

  private addSilhouette(i: number, p: StationPlacement, groundY: number, cfg: { scale: number } | undefined) {
    if (!this.preset.stationSilhouette) return;
    // 替身尺寸按真模型的标称缩放估。原项目实测：最宽的模型脚底半宽 7.8m
    // （station_岭台 @ scale 10），所以按 7.8m 取半径不会显得瘦。
    const s = cfg?.scale ?? 10;
    const halfW = 7.8;
    const height = 13 * (s / 10);
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
    g.scale.setScalar(scale);
    g.rotation.y = ((cfg.rot_y ?? 0) * Math.PI) / 180;
    g.position.set(st.placement.x, 0, st.placement.z);
    // 用包围盒把底面贴到地面。Blender 导出的模型原点在底面中心，
    // 但不同导出器不保证，所以这里量一次。
    const box = new Box3().setFromObject(model.root);
    g.position.y = st.worldPos.y - box.min.y * scale;
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

