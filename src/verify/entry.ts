/**
 * 回归自检 —— 移植后这些数必须仍然成立。
 *
 * 源项目有一句方法论我原样搬过来了：
 *
 * > 每加一条新断言，都要先证明它会红 —— 故意弄坏、看它红、撤掉。
 *
 * 所以下面每条断言都写了**它凭什么会红**。一条永远绿的断言
 * 守不住任何东西，而一条"在它要守的那个漏洞上踩着跑"的断言
 * 更糟：它绿着，而漏洞也在。
 */
import { CENTERLINE, TOTAL_ARCLENGTH, STATIONS, FRAGMENT_STATIONS, shapeReport, nearestArcParam, pointAtArcLength } from '../data/route';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROAD, ROADMESH, ECON, SHOPS, MINIGAMES, I18N, TERRAIN, WORLD } from '../data/raw';
import {
  createMiniGame,
  MINI_GAME_IDS,
  type MiniGame,
  type MiniGameContext,
  type MiniGameId,
  type MiniGameResult,
} from '../game/minigames';
import { ARCH_BY_MODEL_IDX, archKindFor, buildStationArch, type ArchKind } from '../world/architecture';
import { auditSummary } from '../debug/probe';
import { planBasins, naturalHeightAt, naturalHeightRaw, basinDepthAt, getBasins, checkConsistency, NATURAL_FLOOR, WATER_LEVEL } from '../world/basins';
import { RELICS, Relics, relicSite, distToCenterline, RELIC_REACH, RELIC_FROM_ROAD, type RelicKind } from '../world/relics';
import { BambooBeats, BEAT_ARM_RADIUS, BEAT_CUE_RADIUS, BEAT_WINDOW, BEAT_GOAL } from '../game/beat';
import { stickVector, keyToVec } from '../core/stick';
import { decideTouch } from '../core/touch';
import { groundOffsetFor, bottomOf, Vegetation } from '../world/vegetation';
import { Box3, BoxGeometry, CylinderGeometry, BufferAttribute, BufferGeometry, InterleavedBuffer, InterleavedBufferAttribute, Mesh, Object3D, Vector3, Quaternion, Group, AnimationClip, KeyframeTrack, Bone, Scene } from 'three';
import { Sky } from '../world/sky';
import { Stations } from '../world/stations';
import { Scenery, sceneryPlacements, scenerySpec, distToRoad, type SceneryKind } from '../world/scenery';
import { Terrain } from '../world/terrain';
// `ROAD` 这个名字在 `data/raw` 已经被路面网格数据占用了，
// 这里要的是 `world/road` 里那组**派生**常量（铺面半宽、站脚半宽…），所以取别名。
import { Road, ROAD as ROAD_GEOM, sideAt } from '../world/road';
import { verticalFovForAspect, horizontalFromVertical, FOV_BASE, FOV_REF_ASPECT, FOV_MIN_HORIZONTAL, FOV_MAX } from '../core/fov';
import { canRide, isInWorld, interactAt, WorldVisibility, settleTextKey, settleMs, unwrapArc } from '../game/phase';
import { RIDE } from '../data/raw';
import { CAM_MODES, camParams, OFFROAD, offRoadFactorFor } from '../world/ride';
import { Vehicle, MODE_TUNE, RIDE_MODES, FOOT_LATERAL_OFFSET, autoScaleToHeight, collectClips, BICYCLE_YAW, MOTORCYCLE_YAW, CHAR_FACING_YAW, MODEL_HEADS, MODEL_AXES, facingDir, motoLeanAt, bicycleScale, localUnion, measureDriveBasis, measureWheelNode, rootBoneName, rootTrackOf, stripRootMotion, cadenceScale, standFoldAt, STAND_FOLD_ANGLE, BIKE_STEER_MAX, BIKE_GEAR_RATIO, BIKE_WHEEL_R, SKATE_DECK_Y, prepareRideClip, pedalCadence, PEDAL_CADENCE_MAX, type RideMode } from '../world/vehicle';
import { stancePoseOf, keyTimesOf, PoseSampler, FOOT_BONES, loopSeamOf, trimToSeam } from '../world/pose';
import { assertRide, assertDemoDrive } from './ride';
import { assertSubmission } from './submission';
import { GameStateManager } from '../game/state';
import { endingOf, prefilledBackKey, backCaptionKey } from '../game/postcard/types';
import { exportFileName } from '../game/postcard/export';
import { buildInputFromState, fragmentMapDot, layoutMap, type PostcardInput } from '../game/postcard';
import { MAP_BAND_FRAC } from '../game/postcard/layout';
import { readingMs, StoryCards, setNarrativeQuiet, ResultCard } from '../ui/storyCard';
import { splitNextTarget } from '../ui/hud';
import { PRESETS, clampTier } from '../core/settings';
import { DEFAULT_LANG, getLang, setLang, t } from '../i18n';
import { spaceKeyOwnedHere, setSpaceKeyOwner } from '../ui/hud';
import { EndCard } from '../ui/endCard';
import type { UIHooks } from '../ui';
import type { Toast } from '../ui/toast';
import { TIER_LOW, TIER_MEDIUM, TIER_HIGH, type Tier } from '../core/capability';

export interface Check {
  name: string;
  run: () => { ok: boolean; detail: string; asserts: number };
}

const results: Check[] = [];
function check(name: string, fn: () => { ok: boolean; detail: string; asserts: number }) {
  results.push({ name, run: fn });
}

function expect(cond: boolean, detail: string, asserts: number): { ok: boolean; detail: string; asserts: number } {
  return { ok: cond, detail, asserts };
}

// ---------------------------------------------------------------- 8 字形
check('verify_8_shape', () => {
  let asserts = 0;
  const probs: string[] = [];

  // 中心线点数 961（48 段 × 20 + 1）
  asserts++;
  if (CENTERLINE.length !== 961) probs.push(`中心线 ${CENTERLINE.length} 点，应为 961`);

  // 环路总长 1228.8m ±2.0
  asserts++;
  if (Math.abs(TOTAL_ARCLENGTH - 1228.8) > 2.0) {
    probs.push(`环路总长 ${TOTAL_ARCLENGTH.toFixed(1)}m，偏离 1228.8 超过 2.0m`);
  }

  // 闭合：最后一点回到起点
  asserts++;
  const gap = Math.hypot(CENTERLINE[0].x - CENTERLINE[CENTERLINE.length - 1].x, CENTERLINE[0].z - CENTERLINE[CENTERLINE.length - 1].z);
  if (gap > 1e-6) probs.push(`环路没闭合，首尾相距 ${gap.toFixed(4)}m`);

  // 8 字被中线穿过 4 处。判据是沿中线数 x 的符号变化：
  // "把每个环各数一遍"是 4 处，单参数看只有 2 处——所以不能用回绕次数判。
  asserts++;
  const shape = shapeReport();
  if (shape.crossings !== 4) probs.push(`交叉点 ${shape.crossings} 处，应为 4（左右 ${shape.leftCount} / ${shape.rightCount}）`);

  // 两环镜像对称
  asserts++;
  if (shape.symmetryError > 0.05) {
    probs.push(`两环不镜像对称，质心偏差 ${(shape.symmetryError * 100).toFixed(2)}%`);
  }

  // 外接矩形的长宽比
  asserts++;
  if (shape.aspect < 0.9 || shape.aspect > 1.25) {
    probs.push(`外接矩形长宽比 ${shape.aspect.toFixed(2)}，8 字转 60° 后两个环应当并排在 1.0 附近`);
  }

  // 弧长参数与最近点必须互为逆（采样密度的自检）
  asserts++;
  const probe = pointAtArcLength(TOTAL_ARCLENGTH * 0.37);
  const back = nearestArcParam(probe.pos.x, probe.pos.z);
  if (Math.abs(back - 0.37) > 0.02) probs.push(`弧长参数往返不自洽：0.37 → ${back.toFixed(4)}`);

  // 全部点必须有限（没有 NaN 混进几何）
  asserts++;
  for (const p of CENTERLINE) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) {
      probs.push('中心线里有非有限坐标');
      break;
    }
  }

  return expect(probs.length === 0, probs.length ? probs.join('；') : `961 点 / ${TOTAL_ARCLENGTH.toFixed(1)}m / 4 交叉`, asserts);
});

// ---------------------------------------------------------------- 驿站
check('verify_stations', () => {
  let asserts = 0;
  const probs: string[] = [];

  asserts++;
  if (STATIONS.length !== 16) probs.push(`驿站 ${STATIONS.length} 座，应为 16`);

  asserts++;
  const fragStations = STATIONS.filter((s) => s.hasFragment);
  if (fragStations.length !== 5) probs.push(`碎片驿站 ${fragStations.length} 座，应为 5`);

  // 碎片槽位顺序 云/茶/琴/竹/禽
  asserts++;
  const slots = ROAD.FRAGMENT_SLOT_STATION_IDX.map((i) => STATIONS[i].def.fragment);
  if (slots.join('') !== '云茶琴竹禽') probs.push(`碎片槽位顺序是 ${slots.join('')}，应为 云茶琴竹禽`);

  // 双向映射一致
  asserts++;
  for (const [stationIdxStr, slot] of Object.entries(ROAD.FRAGMENT_STATION_TO_SLOT)) {
    if (ROAD.FRAGMENT_SLOT_STATION_IDX[slot] !== Number(stationIdxStr)) {
      probs.push(`驿站→槽位映射与槽位→驿站不一致：${stationIdxStr}→${slot}`);
      break;
    }
  }

  // 驿站必须落在路肩之外，不能压在车道中间
  asserts++;
  for (const s of STATIONS) {
    const d = minDistToCenterline(s.x, s.z);
    if (d < ROADMESH.TOTAL_HALF_WIDTH + ROAD.STATION_FOOT_HALF * 0.9) {
      probs.push(`${s.def.name} 离中心线只有 ${d.toFixed(1)}m，会压在路面上`);
      break;
    }
  }

  // 又必须够得着：打卡半径 15m + 路宽
  asserts++;
  for (const s of STATIONS) {
    const d = minDistToCenterline(s.x, s.z);
    if (d > 15 + ROADMESH.TOTAL_HALF_WIDTH) {
      probs.push(`${s.def.name} 离路 ${d.toFixed(1)}m，玩家在路面上够不着`);
      break;
    }
  }

  // 颜色必须合法（碎片颜色两处副本逐值相同的那条在明信片模块里）
  asserts++;
  for (const s of STATIONS) {
    const c = s.def.color;
    if (c.length !== 4 || c.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) {
      probs.push(`${s.def.name} 的颜色非法`);
      break;
    }
  }

  // ---- 程序化地标的几何硬约束 ----
  //
  // 这几条守的是"建筑会不会压到路上 / 会不会长到标签里 / 会不会一个都没生成"。
  // 三条各自会红的理由：
  //   · 半宽：把 `inn` 的台基从 12.0 改成 20.0 → 半宽 10 > 8，红。
  //   · 高度：把 `lantern` 的竿从 3.1 改成 30 → 远高于 label_y，红。
  //   · 覆盖：`ARCH_BY_MODEL_IDX` 少映射一个下标 → 该站没有几何，红。
  //
  // 还有一个反向判据：**必须比灰盒更矮更省**。不守这条的话，
  // 将来有人把"程序化"改成"更精细"，很容易顺手把 7 座建筑膨胀到
  // 几十万个三角形，而这件事在画面上完全看不出来——只有这个数会红。
  const archReport = archGeometryReport();
  asserts++;
  for (const r of archReport) {
    if (r.halfWidth > ROAD.STATION_FOOT_HALF) {
      probs.push(`${r.name} 半宽 ${r.halfWidth.toFixed(1)}m > ${ROAD.STATION_FOOT_HALF}m，会压到路面上`);
      break;
    }
  }
  asserts++;
  for (const r of archReport) {
    if (r.minY < -0.01) {
      probs.push(`${r.name} 有 ${(-r.minY).toFixed(2)}m 埋在地面以下`);
      break;
    }
  }
  asserts++;
  for (const r of archReport) {
    if (r.height > r.labelY + 0.5) {
      probs.push(`${r.name} 高 ${r.height.toFixed(1)}m，而站名标签挂在 ${r.labelY}m，会插进屋顶`);
      break;
    }
  }
  asserts++;
  const totalArchTris = archReport.reduce((n, r) => n + r.triangles, 0);
  if (totalArchTris > 60000) {
    probs.push(`7 座程序化地标合计 ${totalArchTris} 三角面，超出 6 万的预算（灰盒总量不到 200）`);
  }

  // 每类地标都要有对应的驿站真的在用它，且数量对得上
  asserts++;
  const wantByKind = new Map<ArchKind, number>();
  for (const s of STATIONS) {
    const k = archKindFor(s.def.model_idx);
    if (k) wantByKind.set(k, (wantByKind.get(k) ?? 0) + 1);
  }
  if (wantByKind.size !== Object.keys(ARCH_BY_MODEL_IDX).length) {
    probs.push(`定义了 ${Object.keys(ARCH_BY_MODEL_IDX).length} 类程序化地标，实际被用到的只有 ${wantByKind.size} 类`);
  }

  // 每类都必须有**真屋顶**。
  // 会红的做法：把神苑的碑龛整段删掉——它的最高点就变成四根石灯柱的柱头
  // （实测屋顶带厚度只剩 0.2m），屏幕上读作"这站没有屋顶"。
  // 这不是假想：上一版的神苑真的漏了屋顶，是用户看出来的。
  asserts++;
  for (const r of archReport) {
    if (r.roofVerts < 12) {
      probs.push(`${r.name} 顶部几乎没有任何顶点（${r.roofVerts} 个），没有屋顶`);
    } else if (r.roofBand < 0.8) {
      probs.push(`${r.name} 屋顶带只有 ${r.roofBand.toFixed(2)}m 厚，那是一排柱头而不是屋顶`);
    }
  }

  /**
   * 屋面不许浮空 —— 每一座屋面的下表面都要压在某个支撑上。
   *
   * 这不是假想：用户报"西谷岭台凭空多了一个顶"，根因是 `posts()` 这个
   * helper 早先没有水平中心参数，岭台(`zc=3.4`)与神苑(`nicheZ=3.3`)的偏置小龛
   * 于是把柱子**留在原点**——屋面在 3.3m 外，下面空无一物。
   * 正视图因为投影重叠"像"是连着的，侧过来才看出是悬空的。
   *
   * 会红的做法：把 `posts` 的 `cz` 又去掉 → 立即复现，岭台实测悬空 3.67m。
   *
   * 判据用 `MeshBuilder.roofs` 的**解析**屋面参数算，不去网格里猜哪几条三角形
   * 是屋面——柱头、瓦当、宝顶都落在"顶部高度带"里，靠猜必然误判。
   * 采样时还要排除屋面自己的三角形：举折是凹曲面，平片小片的弦恒在曲面之下，
   * 不排除就会把屋面底面当成自己的支撑，量出来永远是 0.00m 的假接触。
   */
  asserts++;
  const worstRoofGap = Math.max(...archReport.flatMap((r) => r.roofGaps));
  for (const r of archReport) {
    for (const [i, gap] of r.roofGaps.entries()) {
      if (gap > ROOF_SEAT_TOL) {
        probs.push(`第 ${i + 1} 座屋面浮空 ${gap.toFixed(2)}m（判据上限 ${ROOF_SEAT_TOL}m），它下面没有支撑`);
      }
    }
    if (r.roofGaps.length === 0) {
      probs.push(`${r.name} 一座屋面都量不到支撑`);
    }
  }

  // 每座站的世界包围盒 Y 跨度必须等于它那一类本地几何的 Y 跨度。
  // 站会绕 Y 转向公路，绕 Y 的刚体变换**不改变 Y 跨度**——
  // 所以一旦对不上，就是模型被额外平移、缩放，或 attach 时出了问题。
  // 这一条专治"屋顶位置不对"：屋顶被抬歪/被埋，Y 跨度立刻就不对了。
  asserts++;
  {
    const terrain = new Terrain();
    const road = new Road(terrain);
    const stations = new Stations(PRESETS[1], terrain);
    for (const st of stations.list) {
      const kind = archKindFor(st.modelIdx);
      if (!kind || !st.object) continue;
      const local = archReport.find((r) => r.kind === kind);
      if (!local) continue;
      const box = new Box3().setFromObject(st.object);
      const worldH = box.max.y - box.min.y;
      if (Math.abs(worldH - local.height) > 0.05) {
        probs.push(`#${st.index} ${st.placement.def.name}（${kind}）世界高度 ${worldH.toFixed(2)}m ≠ 本地 ${local.height.toFixed(2)}m，屋顶位置不对`);
        break;
      }
    }
    void road;
  }

  return expect(
    probs.length === 0,
    probs.length
      ? probs.join('；')
      : `16 座 / 5 碎片 / 槽位 云茶琴竹禽 / 程序化地标 ${archReport.length} 类 ${totalArchTris} 三角面 · 7 类全有真屋顶且屋面全部落座（最差 ${worstRoofGap.toFixed(2)}m ≤ ${ROOF_SEAT_TOL}m）`,
    asserts,
  );
});

/** 每类程序化地标的实测尺寸。取自真实生成的几何体，不是设计意图里的数 */
function archGeometryReport() {
  const out: {
    name: string;
    kind: ArchKind;
    halfWidth: number;
    height: number;
    minY: number;
    triangles: number;
    labelY: number;
    /** 顶部 30% 高度带里的顶点：屋顶 */
    roofVerts: number;
    /** 屋顶带的厚度。0.2m 那种是一排柱头，不是屋顶 */
    roofBand: number;
    /** 每座屋面下表面到正下方支撑的最小间距（米）。判定"顶浮在空中" */
    roofGaps: number[];
  }[] = [];
  for (const [idxStr, kind] of Object.entries(ARCH_BY_MODEL_IDX)) {
    const idx = Number(idxStr);
    // 用这一类的站，取它们里最低的 label_y 当高度上限（最严的那座）
    const labelY = Math.min(
      ...STATIONS.filter((s) => s.def.model_idx === idx).map((s) => WORLD.STATION_GLB_CONFIG[s.def.model_idx]?.label_y ?? 10),
    );
    // seg 取 10：高档位才是最终画面，低档细分更少
    const mb = buildStationArch(kind, 10);
    const p = mb.build().positions;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      minX = Math.min(minX, p[i]);
      maxX = Math.max(maxX, p[i]);
      minZ = Math.min(minZ, p[i + 2]);
      maxZ = Math.max(maxZ, p[i + 2]);
      minY = Math.min(minY, p[i + 1]);
      maxY = Math.max(maxY, p[i + 1]);
    }
    const { roofVerts, roofBand } = measureRoofBand(p, minY, maxY);
    out.push({
      name: kind,
      kind,
      // 站会绕 Y 转向公路，两向都可能变成"横向"，所以取两向里更大的
      halfWidth: Math.max(maxX - minX, maxZ - minZ) / 2,
      height: maxY,
      minY,
      triangles: mb.triangleCount,
      labelY,
      roofVerts,
      roofBand,
      roofGaps: measureRoofGaps(mb, p),
    });
  }
  return out;
}

/**
 * 屋面落座判据的容差（米）。
 *
 * 0.25m 是照着修好之后的实测值定的：七类全在 **0.009~0.143m**，
 * 修复前的岭台是 3.67m。0.25m 既卡得住真悬空，又不会因为
 * 某次把 `seg` 从 10 降到 6（低画质档）就让判据误红。
 */
const ROOF_SEAT_TOL = 0.25;

/**
 * 量每座屋面"下表面 ↔ 正下方支撑顶面"的最小间距。
 *
 * 两件事必须做对，否则量出来的数没有意义：
 *
 * 1. **屋面下表面用解析公式算**，不在网格里找"哪几条三角形是屋面"。
 *    柱头、瓦当、宝顶都落在"顶部若干高度带"里，靠高度带分类必然误判。
 * 2. **排除屋面自己的三角形**。举折是凹曲面，而网格是 `seg×seg` 个平面小片，
 *    平片的弦恒定落在解析曲面**之下**——不排除的话每个屋面底面都会
 *    被当成"它正下方的支撑"，量出来永远是 0.00m 的假接触。
 *
 * 采样取屋面足迹上的格点，逐点向下找最高的支撑面；
 * 一座屋面的判据值 = 所有格点里**最小**的那个间距
 * （即"最接近贴合的那一点"）。取最小而不是取最大：
 * 一座屋面只要有一处实实在在压在支撑上就算落了座，
 * 而檐口下方本来就是空的（出檐悬空是造型，不是 bug）。
 */
function measureRoofGaps(mb: ReturnType<typeof buildStationArch>, p: Float32Array): number[] {
  const tri = p.length / 9;
  const gaps: number[] = [];
  const STEPS = 24;
  for (const part of mb.roofs) {
    const r = part.span;
    let best = Infinity;
    for (let i = 0; i <= STEPS; i++) {
      for (let j = 0; j <= STEPS; j++) {
        const u = (i / STEPS) * 2 - 1;
        const v = (j / STEPS) * 2 - 1;
        const x = r.cx + u * r.hw;
        const z = r.cz + v * r.hd;
        const soffit = r.soffitAt(u, v);
        let below = -Infinity;
        for (let t = 0; t < tri; t++) {
          // 跳过屋面自身
          if (t >= part.triFrom && t < part.triTo) continue;
          const y = triSurfaceYAt(p, t, x, z);
          if (y === null || y >= soffit - 1e-3) continue;
          if (y > below) below = y;
        }
        if (below === -Infinity) continue;
        const gap = soffit - below;
        if (gap < best) best = gap;
      }
    }
    gaps.push(best);
  }
  return gaps;
}

/**
 * 竖直射线 (x,z) 穿过第 `t` 个三角形时的高度；不穿过返回 null。
 *
 * 重心坐标判据，留一点容差（-1e-6）：顶点恰好落在边上时浮点会差一两个 ulp，
 * 而屋面足迹的格点经常正好压在支撑面的边界上。
 */
function triSurfaceYAt(p: Float32Array, t: number, x: number, z: number): number | null {
  const ax = p[t * 9];
  const ay = p[t * 9 + 1];
  const az = p[t * 9 + 2];
  const bx = p[t * 9 + 3];
  const by = p[t * 9 + 4];
  const bz = p[t * 9 + 5];
  const cx = p[t * 9 + 6];
  const cy = p[t * 9 + 7];
  const cz = p[t * 9 + 8];
  const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(d) < 1e-12) return null; // 退化（竖直三角形）
  const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
  const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
  const l3 = 1 - l1 - l2;
  if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) return null;
  return l1 * ay + l2 * by + l3 * cy;
}

/**
 * 屋顶带 = 顶部 30% 高度里的顶点。
 *
 * 为什么要单独量：起翘屋顶的**檐口低于脊**，所以这一带的厚度正好是
 * 「檐底到脊」的高度差。而**一排柱头**（比如某次漏掉屋顶的神苑）
 * 也会落在这条带子里——它的高度差只有 0.2m。
 * 于是"有没有屋顶"和"那到底是屋顶还是柱头"可以用同一个数分开。
 */
function measureRoofBand(p: Float32Array, minY: number, maxY: number) {
  const bandLo = minY + (maxY - minY) * 0.7;
  let bandHi = -Infinity;
  let bandLoY = Infinity;
  let n = 0;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i + 1] < bandLo) continue;
    n++;
    bandHi = Math.max(bandHi, p[i + 1]);
    bandLoY = Math.min(bandLoY, p[i + 1]);
  }
  return { roofVerts: n, roofBand: n > 0 ? bandHi - bandLoY : 0 };
}

function minDistToCenterline(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < CENTERLINE.length - 1; i++) {
    const a = CENTERLINE[i];
    const b = CENTERLINE[i + 1];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const l2 = abx * abx + abz * abz;
    let t = 0;
    if (l2 > 1e-9) t = clamp01(((x - a.x) * abx + (z - a.z) * abz) / l2);
    const dx = x - (a.x + abx * t);
    const dz = z - (a.z + abz * t);
    best = Math.min(best, dx * dx + dz * dz);
  }
  return Math.sqrt(best);
}
function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------- 文案
check('verify_i18n', () => {
  let asserts = 0;
  const probs: string[] = [];
  const zh = Object.keys(I18N.zh);
  const en = Object.keys(I18N.en);

  asserts++;
  if (zh.length !== en.length) probs.push(`zh ${zh.length} 条 / en ${en.length} 条`);

  asserts++;
  const missingEn = zh.filter((k) => !(k in I18N.en));
  const missingZh = en.filter((k) => !(k in I18N.zh));
  if (missingEn.length) probs.push(`en 缺：${missingEn.slice(0, 5).join(', ')}`);
  if (missingZh.length) probs.push(`zh 缺：${missingZh.slice(0, 5).join(', ')}`);

  // 空串一律可疑：它在界面上就是一块空白
  asserts++;
  const empties = zh.filter((k) => I18N.zh[k] === '' && I18N.en[k] !== '');
  if (empties.length) probs.push(`zh 侧有空文案：${empties.slice(0, 5).join(', ')}`);

  // 里程不许出现在任何面向玩家的文案里
  // （源项目栽过：一条 "已行 %dkm / 188km" 只存在于中文表，
  //   而世界只有 1228.8m 一圈，玩家三十秒就能算出 7200km/h）
  asserts++;
  const withKm = zh.filter((k) => /km|公里|千米/.test(I18N.zh[k]));
  if (withKm.length) probs.push(`文案里出现里程：${withKm.join(', ')}`);

  // 驿数文案不带分母
  asserts++;
  if (/\/\s*%d|%d\s*\//.test(I18N.zh.stations_seen ?? '')) {
    probs.push('stations_seen 带了分母，而驿数会变，抄死的分母早晚对不上');
  }

  // **英文侧一个字都不许有中文。**
  //
  // 这是"英文界面里出现中文"最省事的一条判据：它不需要知道
  // 哪句话在界面上、谁调了 `t()`，只要英文表里混进一个汉字就报。
  //
  // 它挡过真东西：`language` 这一条原来是「语言 / Language」——
  // 一个"看起来双语所以没问题"的按钮，而英文界面点下去看到的是中文。
  //
  // 只查汉字（不含标点 / emoji）：`·`、`…`、`🌐` 两侧都有，不该报。
  asserts++;
  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  const cjkInEn = en.filter((k) => CJK.test(I18N.en[k]));
  if (cjkInEn.length) probs.push(`en 侧含中文：${cjkInEn.slice(0, 5).join(', ')}`);

  // 默认语言必须是英语。
  //
  // 这不是"偏好"，是**可见性**：默认中文时，任何一处漏翻的中文
  // 在开发者自己机器上都不会露出来（他看的是自己那一份），
  // 于是漏翻能活到发版。默认英语之后，它在本地就现形。
  asserts++;
  if (DEFAULT_LANG !== 'en') {
    probs.push(`默认语言是 ${DEFAULT_LANG}，漏翻的中文在开发机上不会露出来`);
  }

  // `t(key, 数组)` 这条路径：档位判定理由的参数是在 `decideTier()` 里
  // 攒出来的数组（`cap_reason_memory: '设备内存 %dGB'`），
  // 走的是和命名参数**不同**的一段替换逻辑。
  //
  // 它坏掉的样子非常有迷惑性：不报错，只是 `%d` 消失，
  // 标题页上那行变成「Device memory GB」——一个读起来仍然像句话的东西。
  // 所以这里钉死两条：数组按出现顺序消费，两个 `%d` 都要落到。
  asserts++;
  setLang('en');
  const mem = t('cap_reason_memory', [2]);
  if (mem !== 'Device memory 2GB') probs.push(`数组参数替换坏了：「${mem}」不是 Device memory 2GB`);

  asserts++;
  const big = t('cap_reason_big', [16, 8]);
  if (big !== '16GB memory / 8 cores') probs.push(`两个数组参数替换坏了：「${big}」不是 16GB memory / 8 cores`);

  // 顺带钉住"缺键渲染成 ⟨key⟩"这个约定：它要是哪天变成返回 key 本身，
  // 界面上就会剩一个 `cap_reason_memory` 这样的符号名，比空串更难认。
  asserts++;
  if (t('definitely_not_a_key_zzz') !== '⟨definitely_not_a_key_zzz⟩') {
    probs.push('缺键不再渲染成 ⟨key⟩，界面上会剩下一个内部符号名');
  }

  return expect(probs.length === 0, probs.length ? probs.join('；') : `${zh.length} 条，中英完全一致，英文侧无中文`, asserts);
});

/**
 * 引导页教的词，必须和 HUD 用的 label 是**同一个名词**。
 *
 * ## 这条守的是哪一族 bug
 *
 * `verify_i18n` 守的是两侧 key 集合相等 + 英文侧没有汉字 + 占位符替换没坏。
 * 它**结构上抓不到**下面这一族：两个 key 都存在、两侧都翻了、都不是硬编码，
 * 但它们指的是同一样东西而英文用了两个词。
 *
 * 症状只有实机才看得见：引导页把旅币教成 `Coins`，HUD 上一路写 `Lvbi`；
 * 引导页教 `Heart`，HUD 写 `Composure`；碎片在同一个面板里同时出现
 * `Fragments`（表头）和 `Shards`（计数）。**玩家在引导页学会的那套词，
 * 到了 HUD 一个都不成立**——而这正是"我不知道这些数字是什么"的成因。
 * 数字本身是清楚的，清楚到没有余地让人猜它指的是别的东西。
 *
 * ## 判据怎么写才算数
 *
 * 把 HUD label 里的 printf 占位符剥掉，然后要求 glossary 那个词
 * 以**整词**形式出现在结果里。不写死英文，只写"两边指的是同一个词"，
 * 所以中文侧同样受约束（`旅币 %d` 必须含 `旅币`）。
 *
 * 会红的做法（每一条都实测过）：
 *   · `lvbi_label` 的英文改回 `Lvbi %d`  → 红「旅币：HUD 写 Lvbi，引导页教 Coins」
 *   · `mood_label` 改回 `Heart %d/%d`   → 红（与 GLOSSARY_PAIRS 里的 Composure 对不上）
 *   · `stations_seen` 改回 `Posts passed`→ 红
 *   · `fragments` 改回 `Shards %d/5`    → 红
 *   · 往 PAIRS 里加一个不存在的 key      → 红（而不是静默通过）
 *
 * ## 规范词改一个字，要同时改两处
 *
 * `GLOSSARY_PAIRS` 的 `en` 与下面的 `PINYIN` 是**一对**：前者是"应该叫什么"，
 * 后者是"不该再出现什么"。只改前者会被后者当场否掉（2026-10-07 心神改
 * Composure 时撞过一次），症状是"刚统一完就红了"，很像统一那步做错了。
 */
const GLOSSARY_PAIRS: { term: string; label: string; zh: string; en: string }[] = [
  { term: 'glossary_lvbi', label: 'lvbi_label', zh: '旅币', en: 'Coins' },
  // 心神：**原来是 Heart**。它是一个会被**消耗**的资源（收一块碎片掉一格），
  // 叫 Heart 会让英文玩家本能地以为要"攒"；而商店里清心茶的描述
  // （shops.json 的 desc_en）一直写的就是 Composure——两边本来就对不齐。
  // 现在三处统一成 Composure，`verify_first_run` 另外守着"别改回去"。
  { term: 'glossary_mood', label: 'mood_label', zh: '心神', en: 'Composure' },
  { term: 'glossary_station', label: 'stations_seen', zh: '驿', en: 'Stations' },
];

/** 剥掉 printf 占位符（%d / %s / %f / %.1f / %%），只留下人读的那部分 */
function stripPrintf(s: string): string {
  return s.replace(/%%|%(\.\d+)?[sdf]/g, '');
}

check('verify_i18n_glossary', () => {
  let asserts = 0;
  const probs: string[] = [];

  asserts++;
  if (GLOSSARY_PAIRS.length !== 3) {
    probs.push(`配对表有 ${GLOSSARY_PAIRS.length} 组，应为 3（旅币 / 心神 / 驿 三个复合成 label）`);
  }

  for (const p of GLOSSARY_PAIRS) {
    for (const lang of ['zh', 'en'] as const) {
      const side = I18N[lang];
      const term = side[p.term];
      const label = side[p.label];

      // key 必须真的存在——引用了没写是另一族（"相等地都缺" verify_i18n 抓不到）
      asserts++;
      if (typeof term !== 'string' || term.trim() === '') {
        probs.push(`${lang} 侧 ${p.term} 不存在或为空`);
        continue;
      }
      asserts++;
      if (typeof label !== 'string' || label.trim() === '') {
        probs.push(`${lang} 侧 ${p.label} 不存在或为空`);
        continue;
      }

      // 词本身两侧必须一致：同一个概念的术语，不该中英各叫一个
      asserts++;
      if (term !== p[lang]) {
        probs.push(`${lang} 侧 ${p.term} 是「${term}」，应为「${p[lang]}」`);
      }

      // 核心判据：HUD label 剥掉占位符之后必须含这个词，且是整词
      asserts++;
      const bare = stripPrintf(label);
      if (!new RegExp(`(^|[^A-Za-z0-9])${escapeRe(term)}([^A-Za-z0-9]|$)`).test(bare)) {
        probs.push(
          `${p.zh}：HUD 写「${label}」，引导页教「${term}」——` +
            `玩家在引导页学的那个词到了 HUD 不成立`,
        );
      }
    }
  }

  // 英文侧不许出现拼音直译。这三条是**具体值**判据，所以单列：
  // 上面的整词判据能抓住"教什么 HUD 写什么"对不上，抓不住
  // "两边一起换成了另一个更难懂的词"（比如两边都叫 Currency）。
  //
  // ⚠ 这张表是**当前不该出现的词**，不是**曾经出现过��词**。
  // 它原本含 `Composure`（源项目的直译），而 2026-10-07 心神统一成
  // Composure 之后必须摘掉——否则判据会开始拒绝**它自己的规范词**，
  // 而症状是"刚统一完就红了"，读起来像是统一那一步做错了。
  // 改规范词时这两处要一起改：GLOSSARY_PAIRS 的 `en`，和这里。
  asserts++;
  const PINYIN = ['Lvbi', 'lvbi', 'Shards', 'Posts passed'];
  for (const p of GLOSSARY_PAIRS) {
    const bare = stripPrintf(I18N.en[p.label] ?? '');
    const hit = PINYIN.find((w) => bare.includes(w));
    if (hit) probs.push(`英文侧 ${p.label} 仍带源项目直译「${hit}」`);
  }

  // ---- 碎片：面板表头带词，计数是纯数字 ----
  //
  // 第四个资源走的是**另一种结构**，所以单独判：碎片栏的表头直接用
  // `glossary_fragment`（canonical 词，已经天然一致），而旁边的计数
  // 是一个**数字**，不是第二个标签。
  //
  // 它原来叫 Shards，于是表头和计数是同一个面板里的两个词；
  // 把它统一成 Fragments 之后，两处都变成 Fragments ——
  // 从"两个词"变成"同一个词说两遍"。实机读作
  // `Fragments   Fragments 0/5`。所以计数必须退回纯 `%d/5`，
  // 让"碎片"这个词在整个面板里只出现一次。
  asserts++;
  for (const lang of ['zh', 'en'] as const) {
    const count = (I18N[lang].fragments ?? '').trim();
    if (!/^%d\s*\/\s*5$/.test(count)) {
      probs.push(`${lang}.fragments 是「${count}」，应为纯计数「%d/5」——碎片这个词由面板表头承担，不该在这里再说一遍`);
    }
  }
  // 表头必须真的用 canonical 词，而不是某个人顺手写死的另一个词
  asserts++;
  {
    const src = readFileSync(join(process.cwd(), 'src', 'ui', 'hud.ts'), 'utf8');
    if (!src.includes("t('glossary_fragment')")) {
      probs.push('碎片栏表头没有用 glossary_fragment——它和引导页教的词会各说各的');
    }
  }

  return expect(
    probs.length === 0,
    probs.length
      ? probs.join('；')
      : GLOSSARY_PAIRS.map((p) => `${p.zh}=${p.en}`).join(' / ') +
        ' · 碎片：表头用 canonical 词、计数是纯 %d/5',
    asserts,
  );
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 「下一处」拆两格之后，那一格距离**必须还在**。
 *
 * ## 为什么要拆
 *
 * 原来是 `setText(nextEl, t('hud_next_target', ...))` 一整句 + CSS 省略号，
 * 而距离在模板里排**最后**（`下一处 %s %s · %dm`）。于是站名一长，
 * 最先被吃掉的就是距离——实机在 726px 宽下读到的是
 * `Next Birdsong Cove Flower House ↗ · 1…`。距离是顶栏里**唯一**
 * 告诉玩家"我在靠近"的数，而它是可以整句消失的。
 *
 * 拆成 `.g-next-name` / `.g-next-meta` 两格之后，省略号只落在名字上。
 *
 * ## 判据分两层
 *
 * 1. **纯函数层**：`splitNextTarget()` 切出来的后半段必须真的带着数字，
 *    而且两段拼回去要**逐字等于**原句（分隔符留在后半段，所以界面上
 *    看起来和以前一模一样——这条是防止"顺手 trim 掉那个 `·`"）。
 * 2. **模板层**：四个模板各自必须恰好有一个 ` · `。有人把分隔符删了，
 *    切点就没了，`splitNextTarget()` 会退化成「整句进名字格、距离格空着」——
 *    界面上距离**静默**消失，而这里会红。
 *
 * 会红的做法：把 `hud_next_target` 的 ` · %dm` 改成 `%dm` → 红；
 * 把 `splitNextTarget` 改成按**第一个**分隔符切（站名里若出现 `·` 就切错）→ 红。
 */
check('verify_hud_next_split', () => {
  let asserts = 0;
  const probs: string[] = [];

  const TEMPLATES = ['hud_next_target', 'hud_revisit_target', 'hud_home_target', 'hud_all_done'];

  for (const key of TEMPLATES) {
    for (const lang of ['zh', 'en'] as const) {
      const tpl = I18N[lang][key] ?? '';
      asserts++;
      // 恰好一个分隔符。0 个 = 切点没了；2 个 = 切点会落在中间那一段上
      const n = tpl.split(' · ').length - 1;
      if (n !== 1) {
        probs.push(`${lang}.${key} 里有 ${n} 个「 · 」，应为 1（切点靠它定位）`);
        continue;
      }
      // 拼回去必须逐字相同
      asserts++;
      const rendered = tpl
        .replace('%s', '竹雨庭')
        .replace(/%[sdf]/g, '7');
      const [name, meta] = splitNextTarget(rendered);
      if (`${name}${meta}` !== rendered) {
        probs.push(`${lang}.${key} 切两段再拼回去不是原句：「${name}」+「${meta}」≠「${rendered}」`);
        continue;
      }
      // 后半段必须带数字：距离 / 余次 / "收尾中"这三个模板都该有一个数
      if (key !== 'hud_all_done') {
        asserts++;
        if (!/\d/.test(meta)) {
          probs.push(`${lang}.${key} 的后半段「${meta}」里没有数字——距离那一格可能没被切出来`);
        }
      }
      asserts++;
      if (name.trim() === '') probs.push(`${lang}.${key} 的前半段是空的`);
    }
  }

  // 没有分隔符时的退化形态必须是**可辨认的**，不是静默丢失
  asserts++;
  {
    const [name, meta] = splitNextTarget('Next Somewhere · 12m');
    if (name !== 'Next Somewhere' || meta !== ' · 12m') {
      probs.push(`切分结果不对：「${name}」/「${meta}」`);
    }
  }
  asserts++;
  {
    const [name, meta] = splitNextTarget('没有分隔符的一句');
    if (name !== '没有分隔符的一句' || meta !== '') {
      probs.push(`无分隔符时应整句进名字格且距离格为空，实得「${name}」/「${meta}」`);
    }
  }

  return expect(
    probs.length === 0,
    probs.length
      ? probs.join('；')
      : `${TEMPLATES.length} 个模板 × 中英 全部恰好一个分隔点 · 拼回原句 · 距离格带数字`,
    asserts,
  );
});

/**
 * 结算屏必须把这一局的**三件事**说出来：成了没有、拿到多少、为什么没成。
 *
 * ## 这一族为什么单独立一条
 *
 * 结算屏是玩家唯一确认"我刚才做到什么"的地方，而它原来只有一句大字
 * （成了 / 这次没有完成 / 先放一放）。于是：
 *
 * · **钱**：打卡与小游戏发的旅币只体现在顶栏那个跳了一下的数字上。
 *   玩家要自己把"顶栏数字变了"和"我刚赢了"两件事对上号。
 * · **是哪一件**：输了的时候副标题是空的，玩家不知道自己刚试的是茶还是琴。
 * · **超时还是玩砸**：宿主 30 秒兜底和"弹错一个音"共用同一句话，
 *   而这两件事该给的建议完全相反（"再来一次" vs "慢慢来"）。
 *
 * ## 怎么测
 *
 * 造一个真的 `ResultCard`（最小 DOM 桩），把四种收场各走一遍，
 * 读它真实写出去的文字。canvas 是假的，但这块屏全是 DOM。
 *
 * 会红的做法：把 `gain` 那行删掉 → 红「赢了 20 旅币，屏上找不到 +20 coins」；
 * 把 `mg_played` 从副标题里去掉 → 红；把 `timedOut` 分支去掉 → 红。
 */
check('verify_settle_feedback', () => {
  let asserts = 0;
  const probs: string[] = [];
  const dom = ensureStubDom();

  setLang('en');
  const card = new ResultCard(dom.parent());
  const read = (cls: string) => {
    const n = card.root.querySelector(`.${cls}`) as { textContent: string; classList: { contains(c: string): boolean } } | null;
    return { text: n?.textContent ?? '', shown: n ? !n.classList.contains('g-hidden') : false };
  };

  // 1. 成了 + 有到账 → 名字、旅币都在，安慰那行不画
  asserts++;
  {
    card.show('win', 0, 100, undefined, { gain: 20 });
    const big = read('g-result-big');
    const sub = read('g-result-sub');
    const gain = read('g-result-gain');
    const note = read('g-result-note');
    if (big.text !== t('result_win')) probs.push(`赢了的大字是「${big.text}」，应为 result_win`);
    if (!sub.text || !sub.text.includes(t('fragment_0'))) probs.push(`赢了没写出这件乐事：「${sub.text}」`);
    if (!gain.shown || !gain.text.includes('20')) probs.push(`赢了 20 旅币，屏上找不到：${JSON.stringify(gain)}`);
    if (note.shown) probs.push('赢了却画了安慰那一行');
  }

  // 2. 输了 → 必须说清是哪一件 + 安慰；旅币那一行按实际到账（输了也发 5）
  asserts++;
  {
    card.show('lose', 2, 100, undefined, { gain: 5 });
    const sub = read('g-result-sub');
    const note = read('g-result-note');
    if (!sub.text.includes(t('mg_played'))) probs.push(`输了没说是哪一件：「${sub.text}」`);
    if (!sub.text.includes(t('fragment_2'))) probs.push(`输了没写出乐事名：「${sub.text}」`);
    if (!note.shown || note.text !== t('mg_failed_hint')) probs.push(`输了没有安慰那一行：${JSON.stringify(note)}`);
  }

  // 3. 超时 → 那一行必须换成 mg_timeout，不能和玩砸共用一句
  asserts++;
  {
    card.show('lose', 2, 100, undefined, { gain: 5, timedOut: true });
    const note = read('g-result-note');
    if (note.text !== t('mg_timeout')) probs.push(`超时显示的是「${note.text}」，应为 mg_timeout`);
    if (t('mg_timeout') === t('mg_failed_hint')) probs.push('mg_timeout 与 mg_failed_hint 是同一句，超时和玩砸分不开');
  }

  // 4. 取消 → 什么都没拿到：不画旅币、不画安慰、也不说哪一件
  asserts++;
  {
    card.show('cancel', 2, 100, undefined, { gain: 0 });
    const sub = read('g-result-sub');
    const gain = read('g-result-gain');
    const note = read('g-result-note');
    if (sub.shown && sub.text !== '') probs.push(`取消了却还报了乐事名：「${sub.text}」`);
    if (gain.shown) probs.push('取消了却画了旅币那一行');
    if (note.shown) probs.push('取消了却画了安慰那一行——他没输');
  }

  // 5. 0 到账不画 "+0 coins"（earn 的 tag 幂等会让取消那一局发不出钱）
  asserts++;
  {
    card.show('win', 0, 100, undefined, { gain: 0 });
    if (read('g-result-gain').shown) probs.push('到账 0 仍然画了「+0」');
  }

  setLang(DEFAULT_LANG);
  return expect(
    probs.length === 0,
    probs.length
      ? probs.join('；')
      : '赢/输/超时/取消 四种收场都说清了：乐事名 · 到账 · 超时与玩砸分开',
    asserts,
  );
});

/**
 * 世界里的「重新开始」必须重播序章。
 *
 * ## 漏洞长什么样
 *
 * `restart()` 调 `resetRun()`，而 `resetRun()` 里的 `game.reset()` 把
 * `prologueDone` 清成 false **并落盘**（`verify_story` 另一条断言就守着
 * "重开就该再看一遍序章"）。但 `restart()` 的非标题页分支走的是
 * `toRoaming()`，**到不了 `enterWorld()`**——而序章住在那里。
 *
 * 于是玩家中途按一次「重新开始」，得到的是：进度全清、站回十八驿旁、
 * **一句故事都没有**。而"他是谁、替谁跑、代价是什么"这三句
 * 在这个游戏里只在序章出现过一次。补回来的唯一路径是退回标题页
 * 再点「继续旅程」，没有人会知道要这么做。
 *
 * ## 判据为什么读源码
 *
 * 这一条没法在 Node 里跑：`App` 要 WebGL。而它守的是**接线**，
 * 不是数值——"新的一条路进世界时会不会播序章"这件事只有连线图知道。
 * 项目里已有同族先例（`verify_minigame_resume` 用读 `main.ts` 源码
 * 的方式断言 `whenDialogueIdle()` 必须排在 `mg.run()` 之前），
 * 所以这里沿用同一个手法，并且**配一条行为断言**：
 * `playPrologue()` 自己必须带 `prologueDone` 的幂等闸。
 *
 * 会红的做法：把 `restart()` 里那行 `this.playPrologue()` 删掉 → 红；
 * 把 `playPrologue` 里的 `if (!game.prologueDone)` 闸去掉 → 红（幂等那条）。
 */
check('verify_restart_prologue', () => {
  let asserts = 0;
  const probs: string[] = [];

  // 1. 行为：reset 之后序章必须是"待播"状态
  asserts++;
  {
    const g = new GameStateManager();
    g.markPrologueDone();
    if (!g.prologueDone) probs.push('markPrologueDone() 没能把序章标成已播');
    g.reset();
    if (g.prologueDone) probs.push('reset() 之后序章仍标成已播——重开就不会再念一遍');
  }

  // 2. 连线：restart() 的非标题页分支必须调 playPrologue()
  asserts++;
  {
    const src = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
    const start = src.indexOf('  restart() {');
    if (start < 0) {
      probs.push('main.ts 里找不到 restart()');
    } else {
      // 取到下一个同缩进的方法为止
      const rest = src.slice(start + 12);
      const end = rest.search(/\n  [a-zA-Z]/);
      const body = end < 0 ? rest : rest.slice(0, end);
      if (!body.includes('this.playPrologue()')) {
        probs.push('restart() 的世界内分支没有调 playPrologue()——重开之后玩家看不到序章');
      }
      // 幂等闸必须在 playPrologue 里，否则三条进世界的路径会重播两次
      const pStart = src.indexOf('  private playPrologue()');
      if (pStart < 0) {
        probs.push('main.ts 里找不到 playPrologue()');
      } else {
        const pRest = src.slice(pStart + 24);
        const pEnd = pRest.search(/\n  [a-zA-Z]/);
        const pBody = pEnd < 0 ? pRest : pRest.slice(0, pEnd);
        if (!pBody.includes('if (!game.prologueDone)')) {
          probs.push('playPrologue() 没有 prologueDone 幂等闸——进世界三次会重播三次序章');
        }
        // 七句都要在，别只念了前四句
        for (const k of ['prologue_0_1', 'prologue_0_2a', 'prologue_0_2b', 'prologue_0_3', 'prologue_1', 'prologue_2', 'prologue_3']) {
          if (!pBody.includes(`'${k}'`)) probs.push(`playPrologue() 里没有 ${k}`);
        }
      }
    }
  }

  return expect(
    probs.length === 0,
    probs.length ? probs.join('；') : '重开清档后序章回到待播 · 世界内 restart 走 playPrologue · 七句齐全且有幂等闸',
    asserts,
  );
});

// ---------------------------------------------------------------- 经济
check('verify_economy', () => {
  let asserts = 0;
  const probs: string[] = [];
  const g = new GameStateManager();

  // 理想全清。
  //
  // 注意小游戏那一项：**只有 5 份，不是 15 份**。`on_mini_game` 的幂等 tag
  // 是按**驿站**给的（`mini_<站>_win`），一座驿站打三次都只发一次钱。
  // 写成 15 × 20 会得到 999，比真实值多 200——而这一条断言守的就是
  // 幂等账本，所以它必须按账本的口径算，而不是按局数算。
  const frags = 5;
  const repeats = 2;
  const kmIncome = Math.floor(ECON.TOTAL_ROUTE_KM) * ECON.LVBI_PER_KM;
  const passIncome = 16 * ECON.LVBI_PER_PASS;
  const firstCheckin = frags * ECON.LVBI_FIRST_CHECKIN;
  const repeatCheckin = frags * repeats * ECON.LVBI_REPEAT_CHECKIN;
  const miniAllWin = frags * ECON.LVBI_MINI_WIN;
  const frag = frags * ECON.LVBI_PER_FRAGMENT;
  const full = kmIncome + passIncome + firstCheckin + repeatCheckin + miniAllWin + frag;
  asserts++;
  if (full !== 799) probs.push(`全清收入 ${full}，源项目口径是 799（其中小游戏只有 ${miniAllWin}，按站幂等）`);

  // 只骑不打卡的"纯骑行"收入
  const rideOnly = kmIncome + passIncome;
  asserts++;
  if (rideOnly !== 424) probs.push(`纯骑行收入 ${rideOnly}，源项目口径是 424`);

  // 合理全购：**明信片套餐只买最高那一档**（互斥升级），其余按 max_own 叠满。
  // 早先按"每件买一件"求和会得到 965，比真实值少 45——因为灯笼能买两盏、
  // 清心茶能买三盏，而它们各少算了一份额度。
  let bestTier = 0;
  for (const gd of SHOPS.GOODS) {
    if (gd.grant === 'postcard_tier') bestTier = Math.max(bestTier, gd.tier_rank ?? 1);
  }
  let sensible = 0;
  for (const gd of SHOPS.GOODS) {
    if (gd.grant === 'postcard_tier') {
      if ((gd.tier_rank ?? 1) === bestTier) sensible += gd.price;
    } else {
      sensible += gd.price * (gd.max_own ?? 1);
    }
  }
  asserts++;
  if (sensible !== 1010) probs.push(`合理全购 ${sensible}，源项目口径是 1010`);

  // 缺口是正的：必须在视野和纸面之间做减法
  const gap = sensible - full;
  asserts++;
  if (gap !== 211) probs.push(`缺口 ${gap}，源项目口径是 211（两盏半灯笼）`);
  asserts++;
  if (gap <= 0) probs.push('缺口 ≤ 0，铺子里的东西全都买得起，选择就不存在了');

  // 素笺 0 旅币 =「明信片永远拿得到」的机器证明
  asserts++;
  const plain = SHOPS.GOODS.find((g2) => g2.id === 'kit_plain');
  if (!plain || plain.price !== 0) probs.push('素笺不是 0 旅币，「明信片永远拿得到」就没有保障');

  // 幂等：同一个 tag 只发一次
  asserts++;
  g.earn(10, 'x');
  g.earn(10, 'x');
  if (g.lvbi !== 10) probs.push(`幂等账本坏了：同一个 tag 发了 ${g.lvbi}`);

  // reset 必须真的清干净
  asserts++;
  g.checkIn(ROAD.FRAGMENT_SLOT_STATION_IDX[0]);
  g.earn(50, 'zzz');
  g.reset();
  asserts++;
  if (g.lvbi !== 0 || g.getStationCount(ROAD.FRAGMENT_SLOT_STATION_IDX[0]) !== 0) {
    probs.push('reset 没清干净');
  }
  asserts++;
  if (g.earnedTags.size !== 0 || g.seenStations.size !== 0) probs.push('reset 没清幂等账本或路过表');

  return expect(
    probs.length === 0,
    probs.length ? probs.join('；') : `全清 ${full} / 全购 ${sensible} / 缺口 ${gap} / 纯骑行 ${rideOnly}`,
    asserts,
  );
});

// ---------------------------------------------------------------- 水
check('verify_water', () => {
  let asserts = 0;
  const probs: string[] = [];
  planBasins();
  const basins = getBasins();

  asserts++;
  if (basins.length !== 3) probs.push(`碗 ${basins.length} 只，应为 3`);

  const c = checkConsistency();
  asserts++;
  if (!c.ok) probs.push(...c.problems);

  // 水位必须低于自然地形下限，否则水会漫出去
  asserts++;
  for (const b of basins) {
    if (b.level >= -3.0) probs.push(`碗 ${b.station} 的水位 ${b.level} 不低于 -3.0`);
  }

  // 碗深必须能挖出目标水深
  asserts++;
  for (const b of basins) {
    if (b.depth <= 0) probs.push(`碗 ${b.station} 深度 ${b.depth.toFixed(2)}，挖不出水`);
    const bottom = naturalHeightAt(b.cx, b.cz) - b.depth;
    if (bottom > b.level) probs.push(`碗 ${b.station} 碗底高于水位`);
  }

  // 岸线必须高出路面 0.35m 以上（源项目守的是这一条）
  asserts++;
  for (const b of basins) {
    // 沿碗心朝远离路的方向量到路面的距离
    let shoreClear = Infinity;
    for (let a = 0; a < Math.PI * 2; a += 0.2) {
      const px = b.cx + Math.cos(a) * b.radius;
      const pz = b.cz + Math.sin(a) * b.radius;
      shoreClear = Math.min(shoreClear, minDistToCenterline(px, pz));
    }
    if (shoreClear < 16) probs.push(`碗 ${b.station} 盆沿离路只有 ${shoreClear.toFixed(1)}m，行道树会站进湖里`);
  }

  // 碗之间不能连成一条
  asserts++;
  for (let i = 0; i < basins.length; i++) {
    for (let j = i + 1; j < basins.length; j++) {
      const d = Math.hypot(basins[i].cx - basins[j].cx, basins[i].cz - basins[j].cz);
      if (d < basins[i].radius + basins[j].radius) probs.push(`碗 ${i} 与 ${j} 重叠（${d.toFixed(1)}m）`);
    }
  }

  // clamp 必须真的生效，而"生效"只能由**不 clamp 就会越界**来证明。
  //
  // 原来这里写死 `h < -3.0 || h > 6.0`，又在下一条断言"≥5% 的采样点压在
  // -3.0 上"当作 clamp 生效的证据。两条都坏：
  //   · 区间写死：起伏放大之后上限不再是 6，判据开始报"自然高程越界"，
  //     而地形完全正常。**一个量错东西的判据比没有判据更坏。**
  //   · 那个代理方向是反的：地板上点越多，世界越像一块平台。
  //     `verify_relief` 要求地板占比 < 4% 正是为了治它——
  //     于是两条判据在互相对抗，治好一条另一条必红。
  //
  // 现在两句话各自独立成立：原始值确实越界（clamp 有活可干），
  // 返回值确实不越界（它干对了）。采样走二维网格，沿用原来的理由。
  asserts++;
  const GRID = 33;
  let rawOut = 0;
  let clampedOut = 0;
  for (let iz = 0; iz < GRID; iz++) {
    for (let ix = 0; ix < GRID; ix++) {
      const x = (ix / (GRID - 1)) * 800 - 400;
      const z = (iz / (GRID - 1)) * 800 - 400;
      const raw = naturalHeightRaw(x, z);
      if (raw < NATURAL_FLOOR - 1e-9 || raw > TERRAIN.MAX_HEIGHT + 1e-9) rawOut++;
      const h = naturalHeightAt(x, z);
      if (!Number.isFinite(h) || h < NATURAL_FLOOR - 1e-9 || h > TERRAIN.MAX_HEIGHT + 1e-9) {
        clampedOut++;
        probs.push(`自然高程越界：${h} @ (${x.toFixed(0)}, ${z.toFixed(0)})`);
        iz = GRID;
        break;
      }
    }
  }
  asserts++;
  if (rawOut === 0) {
    probs.push('原始高程一次都没越界，clamp 无事可做——系数与 [地板, 天花板] 已经脱节');
  }

  // 水位必须恒低于自然地形下限。这是 `WATER_LEVEL` 由下限反推的理由，
  // 单独再钉一遍：那条推导在 basins.ts 里，这里量的是**结果**。
  asserts++;
  if (WATER_LEVEL >= NATURAL_FLOOR) {
    probs.push(`水位 ${WATER_LEVEL} 不低于自然地形下限 ${NATURAL_FLOOR}，水会漫出去`);
  }

  asserts++;
  if (basinDepthAt(0, 0) < 0) probs.push('碗深为负');

  return expect(probs.length === 0, probs.length ? probs.join('；') : `3 只碗，水位 ${basins[0]?.level}m`, asserts);
});

// ---------------------------------------------------------------- 小游戏排布
check('verify_mini_game', () => {
  let asserts = 0;
  const probs: string[] = [];
  const sched = MINIGAMES.schedule;

  asserts++;
  if (sched.length !== 5) probs.push(`排布 ${sched.length} 行，应为 5`);

  asserts++;
  for (const row of sched) if (row.length !== 3) probs.push('有一行不是三次到访');

  // 第一趟的手感与配对关系一个字没变：第一次到访 = 自己那件
  asserts++;
  for (let slot = 0; slot < 5; slot++) {
    if (sched[slot][0] !== slot) probs.push(`槽位 ${slot} 的第一次到访不是自己那件`);
  }

  // 15 局里每件乐事正好各出现 3 次
  asserts++;
  const flat = sched.flat();
  for (let g = 0; g < 5; g++) {
    const n = flat.filter((x) => x === g).length;
    if (n !== 3) probs.push(`乐事 ${g} 出现了 ${n} 次，应为 3`);
  }

  // 同一座驿站连着两次到访绝不撞同一件
  asserts++;
  for (const row of sched) {
    for (let v = 0; v < row.length - 1; v++) {
      if (row[v] === row[v + 1]) {
        probs.push('同一座驿站连着两次到访撞上了同一件乐事');
        break;
      }
    }
  }

  return expect(probs.length === 0, probs.length ? probs.join('；') : '15 局，每件 3 次，首访=自己那件', asserts);
});

// ---------------------------------------------------------------- 画质分档
check('verify_quality', () => {
  let asserts = 0;
  const probs: string[] = [];
  const lo = PRESETS[0];
  const mid = PRESETS[1];
  const hi = PRESETS[2];

  // 低档必须真的低：这是整个项目对"低配电脑"承诺的兑现点
  asserts++;
  if (lo.renderScale >= mid.renderScale || mid.renderScale >= hi.renderScale) {
    probs.push('渲染分辨率没有随档位单调下降');
  }
  asserts++;
  if (lo.shadowMapSize !== 0) probs.push('低档没关阴影');

  // 地面细节必须随档位单调下降，而且**低档必须是 0**。
  // 它现在是着色器里的两项噪声（草丛斑块 + 方向性短纹），
  // 比几何体草皮便宜得多，但仍然是全屏的 fbm —— 低档该省还是得省。
  asserts++;
  if (!(lo.groundDetail < mid.groundDetail && mid.groundDetail < hi.groundDetail)) {
    probs.push(`地面细节没有随档位单调上升：${lo.groundDetail} / ${mid.groundDetail} / ${hi.groundDetail}`);
  }
  asserts++;
  if (lo.groundDetail !== 0) probs.push(`低档地面细节是 ${lo.groundDetail}，应当为 0`);

  // 植被半径单调
  asserts++;
  if (!(lo.treeRadius < mid.treeRadius && mid.treeRadius < hi.treeRadius)) probs.push('树半径不单调');
  asserts++;
  if (!(lo.groundDetailRadius < mid.groundDetailRadius && mid.groundDetailRadius < hi.groundDetailRadius)) {
    probs.push('地面细节半径不单调');
  }

  // 雾的远端必须盖过植被半径，否则会看见"从雾里长出来"的树
  asserts++;
  for (const [name, p] of [['低', lo], ['中', mid], ['高', hi]] as const) {
    if (p.fogFar < p.treeRadius) probs.push(`${name}档雾远 ${p.fogFar}m < 树半径 ${p.treeRadius}m`);
  }

  // 地标加载距离也要被雾盖住
  asserts++;
  for (const [name, p] of [['低', lo], ['中', mid], ['高', hi]] as const) {
    if (p.stationLoadDistance > p.fogFar) probs.push(`${name}档地标加载距离超过雾远`);
  }

  // 夹取
  asserts++;
  if (clampTier(9) !== 2 || clampTier(-3) !== 0) probs.push('tier 夹取坏了');
  asserts++;
  if (!(TIER_LOW === 0 && TIER_MEDIUM === 1 && TIER_HIGH === 2)) probs.push('档位常量不是 0/1/2');

  // 分档表必须正好三档，UI 的按钮是按这个数量摆的
  asserts++;
  if (Object.keys(PRESETS).length !== 3) probs.push(`画质预设 ${Object.keys(PRESETS).length} 档，应为 3`);

  return expect(probs.length === 0, probs.length ? probs.join('；') : `低 ${lo.renderScale}× / 高 ${hi.renderScale}×`, asserts);
});

// ---------------------------------------------------------------- 心神
check('verify_mood', () => {
  let asserts = 0;
  const probs: string[] = [];
  const g = new GameStateManager();

  // 初始 4
  asserts++;
  if (g.mood !== ECON.MOOD_INITIAL) probs.push(`初始心神 ${g.mood}`);

  // 收满五块碎片正好把 4 打到 1
  asserts++;
  for (const i of ROAD.FRAGMENT_SLOT_STATION_IDX) g.checkIn(i);
  if (g.mood !== 1) probs.push(`收满五块碎片后心神 ${g.mood}，应为 1`);

  // 遮罩不透明度：心神 1 → 0.34，心神 4 → 0.085 左右，且绝不盖满
  asserts++;
  const a1 = g.getMoodMaskAlpha();
  if (Math.abs(a1 - ECON.MOOD_MASK_MAX) > 1e-6) probs.push(`心神 1 的遮罩是 ${a1}，应为 ${ECON.MOOD_MASK_MAX}`);
  asserts++;
  if (a1 >= 1) probs.push('遮罩能盖满——那不是氛围，是看不清路');

  // 梯度单调
  asserts++;
  g.restoreMood(4);
  const a5 = g.getMoodMaskAlpha();
  if (a5 >= a1) probs.push('遮罩不随心神单调下降');

  // 上行口存在：收满五块之后必须能把心神买回来
  asserts++;
  const tea = SHOPS.GOODS.find((x) => x.grant === 'mood_up');
  if (!tea) probs.push('没有任何能恢复心神的商品——它是一条单向的下水道');

  // 视野下限：再差也不能看不见路
  asserts++;
  g.costMood(10);
  if (g.getVisibilityFactor() < ECON.VIS_FLOOR - 1e-9) probs.push('视野系数跌破下限');

  // 灯笼能撑回来，但封顶
  asserts++;
  const base = g.getVisibilityFactor();
  g.inv.set('lamp', 2);
  const withLamp = g.getVisibilityFactor();
  if (!(withLamp > base)) probs.push('买灯笼没把视野撑回来');
  asserts++;
  if (withLamp > ECON.VIS_CEIL + 1e-9) probs.push('灯笼把视野买到超过初始值了');

  return expect(probs.length === 0, probs.length ? probs.join('；') : `遮罩 0→${ECON.MOOD_MASK_MAX}，有上行口`, asserts);
});

// ---------------------------------------------------------------- 打卡进度
check('verify_checkin', () => {
  let asserts = 0;
  const probs: string[] = [];
  const g = new GameStateManager();
  const S = ROAD.FRAGMENT_SLOT_STATION_IDX;

  // "已经收过"和"不用再去"是两件事
  asserts++;
  g.checkIn(S[0]);
  if (!g.isCollected(S[0])) probs.push('首次打卡后不算已收');
  asserts++;
  if (!g.fragmentStationNeedsVisit(S[0])) {
    probs.push('首次到访之后就说"不用再去了"——最强的重玩钩子被自己掐死了');
  }

  // 刷满三次
  asserts++;
  g.checkIn(S[0]);
  g.checkIn(S[0]);
  if (!g.isStationExhausted(S[0])) probs.push('三次到访后没标记为刷满');
  asserts++;
  if (g.fragmentStationNeedsVisit(S[0])) probs.push('刷满之后仍然提示要再去');

  // 第四次不再计数
  asserts++;
  const before = g.getStationCount(S[0]);
  g.checkIn(S[0]);
  if (g.getStationCount(S[0]) !== before) probs.push('超过三次之后还在计数');

  // 非碎片驿站不记录
  asserts++;
  const nonFrag = 1;
  g.checkIn(nonFrag);
  if (g.getStationCount(nonFrag) !== 0) probs.push('非碎片驿站被记录了');

  // 全满 = 结束条件（不是"集齐"）
  asserts++;
  for (let i = 1; i < 5; i++) for (let k = 0; k < 3; k++) g.checkIn(S[i]);
  if (!g.allFragmentsMaxed()) probs.push('五座各三次之后没有判定为完满');
  asserts++;
  if (!g.allCollected()) probs.push('完满时应当也满足集齐');

  // 心神不会被扣到 0
  asserts++;
  if (g.mood < ECON.MOOD_FLOOR) probs.push(`心神掉到 ${g.mood}，低于下限`);

  return expect(probs.length === 0, probs.length ? probs.join('；') : '三次到访语义正确', asserts);
});

// ---------------------------------------------------------------- 地形
check('verify_terrain', () => {
  let asserts = 0;
  const probs: string[] = [];

  asserts++;
  if (TERRAIN.RES <= 0 || TERRAIN.SIZE <= 0) probs.push('地形参数非法');

  // 底色必须合法，且与草皮底色同源（草和地明显分家是最刺眼的一类错）
  asserts++;
  const c = TERRAIN.BASE_COLOR;
  if (c[1] <= c[0] || c[1] <= c[2]) probs.push('地面底色不是绿色系');

  // 网格格子不能太大也不能太小：太大则车会相对可见网格陷进去
  const cell = TERRAIN.SIZE / TERRAIN.RES;
  asserts++;
  if (cell < 2 || cell > 12) probs.push(`地形格 ${cell.toFixed(2)}m，超出 2~12m 的可用区间`);

  // 顶点量
  asserts++;
  const verts = (TERRAIN.RES + 1) * (TERRAIN.RES + 1);
  if (verts > 70000) probs.push(`地形顶点 ${verts} 太多，一整块 mesh 扛不住`);

  return expect(probs.length === 0, probs.length ? probs.join('；') : `${TERRAIN.SIZE}m / ${TERRAIN.RES} 格 / ${cell.toFixed(2)}m`, asserts);
});

// ---------------------------------------------------------------- 地形起伏
/**
 * ## 这条为什么必须存在，而 `verify_terrain` 为什么守不住它
 *
 * `verify_terrain` 钉的是**网格形状**（800m / 128 格 / 6.25m 一格），
 * 外加一个"高程在 clamp 范围内"。这两件事在"世界是一块台球桌"时全绿。
 *
 * 实测就是这么绿的：起伏公式给出原始高差 **10.66m**，
 * `terrain.json` 里的 `TERRAIN_MAX_HEIGHT: 25` 被 `raw.ts` 导出来之后
 * **全世界没有一处读过它**，于是 800m 见方里 10m 高差在每一帧里都读成
 * 一望无际的平地——地平线是一条直线。而副标题写的是"把家乡的**山水**
 * 装进行囊"。
 *
 * **"高程在范围内"和"看得出高低"是两件事。** 这条判据量的是后者。
 *
 * ## 它凭什么会红（逐条）
 *
 * | 断言 | 退回什么写法会红 |
 * |---|---|
 * | 高差 ≥ 20m | 把三个倍频改回 `8 / 2 / 0.5` → 红 `高差 10.66m` |
 * | 高差 ≤ 75m | 把 28 改成 280 → 红 `高差 300m` |
 * | 压地板 < 4% | 去掉偏置 / 把 `TERRAIN_FREQ` 调回 1 → 红 `压地板 x%` |
 * | 压顶 < 6% | 漏掉 hash2d 里那层 `fmod`（Godot 侧的原 bug）→ 均值 +0.99 → 红 `压顶 x%` |
 * | p10~p90 ≥ 8m | 同上，防"少数山峰 + 一片平台" |
 * | 占格 ≥ 10/16 | 收成单峰尖（把 fbm 换成单倍频）→ 红 `只占 n/16 格` |
 * | 最大纵坡 ≤ 20% | 只放大幅度不降频率（第一版就是这么写的）→ 红 `49.3%` |
 * | p95 纵坡 ≤ 12% | 同上 → 红 `32.4%` |
 * | 路拱离地 ≤ 1.5m | 给路面加纵向平滑而不降频率 → 红 `离地 6.70m`，路肩变悬崖 |
 * | 纵坡有正有负 | 去掉偏置 → 整圈只下坡 → 红 `没有上坡` |
 */
check('verify_relief', () => {
  let asserts = 0;
  const probs: string[] = [];

  // 41×41 覆盖整张 800m 地图。采样点与 probe.mjs 相同，两处读数可以直接对照。
  const N = 41;
  const hs: number[] = [];
  let min = Infinity;
  let max = -Infinity;
  let atFloor = 0;
  let atCeil = 0;
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const x = (ix / (N - 1)) * 800 - 400;
      const z = (iz / (N - 1)) * 800 - 400;
      const h = naturalHeightAt(x, z);
      hs.push(h);
      if (h < min) min = h;
      if (h > max) max = h;
      if (Math.abs(h - NATURAL_FLOOR) < 1e-9) atFloor++;
      if (Math.abs(h - TERRAIN.MAX_HEIGHT) < 1e-9) atCeil++;
    }
  }
  const total = hs.length;
  const relief = max - min;

  // 1. 高差必须真的达到数据里 MAX_HEIGHT 的量级
  //    留 20% 余量而不是死钉 25：判据要守"有没有山"，不是守"山有多高"，
  //    否则下一次调噪声微调一下就会红，而它并没有坏。
  asserts++;
  if (relief < TERRAIN.MAX_HEIGHT * 0.8) {
    probs.push(`高差 ${relief.toFixed(2)}m，低于 ${(TERRAIN.MAX_HEIGHT * 0.8).toFixed(0)}m（看不出来是山）`);
  }

  // 2. 反向：不能矫枉过正。起伏太大路面会变成过山车，驿站也会被甩到坡上。
  asserts++;
  if (relief > TERRAIN.MAX_HEIGHT * 3) {
    probs.push(`高差 ${relief.toFixed(2)}m，超过 ${(TERRAIN.MAX_HEIGHT * 3).toFixed(0)}m（路面会变成过山车）`);
  }

  // 3. 压下限：一望无际的 -3.0 平台。
  //    这是"下限版的高原"，和 hash2d 漏 fmod 那个 bug 是同一族病，只是方向相反。
  asserts++;
  const floorPct = (atFloor / total) * 100;
  if (floorPct >= 4) probs.push(`压在 ${NATURAL_FLOOR} 下限 ${floorPct.toFixed(1)}%，成片地板`);

  // 4. 压上限：山头被削平。Godot 侧漏 fmod 时是 79%，这里给 6% 的余量。
  asserts++;
  const ceilPct = (atCeil / total) * 100;
  if (ceilPct >= 6) probs.push(`压在 ${TERRAIN.MAX_HEIGHT} 上限 ${ceilPct.toFixed(1)}%，成片台地`);

  // 5. 主体分布必须铺开，而不是"平台 + 几座孤峰"。
  //    取 p10/p90 而不是 min/max：min/max 会被极少数点带着跑，
  //    而这条要问的是"玩家脚下这一片是不是有高有低"。
  const sorted = [...hs].sort((a, b) => a - b);
  const p10 = sorted[Math.floor(total * 0.1)];
  const p90 = sorted[Math.floor(total * 0.9)];
  asserts++;
  if (p90 - p10 < 8) probs.push(`p10~p90 只差 ${(p90 - p10).toFixed(2)}m，主体地形是平的`);

  // 6. 直方图占格数：防"收成一根尖"。
  //    分 16 格铺满 [NATURAL_FLOOR, MAX_HEIGHT]，要求至少 10 格有样本。
  asserts++;
  const bins = 16;
  const bw = (TERRAIN.MAX_HEIGHT - NATURAL_FLOOR) / bins;
  const occupied = new Set<number>();
  for (const h of hs) {
    occupied.add(Math.min(bins - 1, Math.max(0, Math.floor((h - NATURAL_FLOOR) / bw))));
  }
  if (occupied.size < bins * 0.625) {
    probs.push(`高程直方图只占 ${occupied.size}/${bins} 格，分布收成了一根尖`);
  }

  // 7~8. 路面纵坡。起伏是给玩家看的，纵坡是给车走的——这条量的是后者。
  //
  // 用 `naturalHeightAt` 沿中心线复算路面高度，抄的是 `road.ts:buildRoadYs`
  // 的"左中右三点取最高"，所以读数与真实路面同源（不是近似另一套算法）。
  const grades: number[] = [];
  const hw = ROADMESH.ROAD_HALF_WIDTH;
  const cl = CENTERLINE;
  const roadY = new Array<number>(cl.length);
  for (let i = 0; i < cl.length; i++) {
    const p = cl[i];
    const s = sideAt(cl, i);
    roadY[i] = Math.max(
      naturalHeightAt(p.x, p.z),
      naturalHeightAt(p.x + s.x * hw, p.z + s.z * hw),
      naturalHeightAt(p.x - s.x * hw, p.z - s.z * hw),
    );
  }
  for (let i = 0; i < cl.length; i++) {
    const a = cl[i];
    const b = cl[(i + 1) % cl.length];
    const ds = Math.hypot(b.x - a.x, b.z - a.z);
    if (ds < 1e-6) continue;
    grades.push(Math.abs(roadY[(i + 1) % cl.length] - roadY[i]) / ds);
  }
  grades.sort((x, y) => x - y);
  const maxGrade = grades[grades.length - 1] ?? 0;
  const p95Grade = grades[Math.floor(grades.length * 0.95)] ?? 0;

  asserts++;
  if (maxGrade > 0.2) probs.push(`最大纵坡 ${(maxGrade * 100).toFixed(1)}%，车会爬不动`);

  // p95 才是玩家真正天天遇到的那一段。只钉 max 的话，
  // 一处 20cm 的尖刺就能让整条判据失去意义。
  // 12% 是"山路"的量级而不是"过山车"：常见盘山公路 8~10%，12% 偏陡但能骑。
  asserts++;
  if (p95Grade > 0.12) probs.push(`95% 的路段纵坡 > ${(p95Grade * 100).toFixed(1)}%，这条路一直在爬`);

  // 路拱必须贴着地面。路面高度是"左中右三点取最高"再抬一点，
  // 它比地形高出太多时，路肩那两个外缘顶点（跟着地形走）会和沥青之间
  // 拉出一段几十度的斜面——画面上就是路肩变成了路堤的悬崖。
  asserts++;
  let gapMax = 0;
  for (let i = 0; i < cl.length; i++) {
    gapMax = Math.max(gapMax, Math.abs(roadY[i] - naturalHeightAt(cl[i].x, cl[i].z)));
  }
  if (gapMax > 1.5) probs.push(`路拱最高离地 ${gapMax.toFixed(2)}m，路肩会变成悬崖`);

  // 环线必须真的翻过山：整圈的累计爬升与累计下降都要够大。
  //
  // **用累计量，不用固定长度的窗口。**
  // 早先那版按"单个 1.28m 采样段升降 > 0.5m"判断，而纵坡 11.5% 下一段才
  // 0.15m——量的是采样密度不是地形，改采样密度就会让判据变色。
  // 换成 50m 窗口也不行：基频波长 893m 的丘，50m 只覆盖 5.6%，
  // 高度变化天然只有 5~6m（实测 6.0m），阈值怎么定都是在跟波长较劲。
  //
  // 累计爬升与地形形态无关：翻过一道 30m 的丘，累计爬升必然在 30m 以上。
  // 这是"环线翻过一座山"这件事唯一稳定的表述方式。
  asserts++;
  let ascent = 0;
  let descent = 0;
  for (let i = 0; i < cl.length; i++) {
    const d = roadY[(i + 1) % cl.length] - roadY[i];
    if (d > 0) ascent += d;
    else descent -= d;
  }
  // 阈值取"高差的一半"：要真的翻过一座山，累计爬升至少得有一个山那么高的一半
  const minClimb = relief * 0.5;
  if (ascent < minClimb) probs.push(`全环累计爬升 ${ascent.toFixed(1)}m，低于高差的一半 ${minClimb.toFixed(1)}m`);
  if (descent < minClimb) probs.push(`全环累计下降 ${descent.toFixed(1)}m，低于高差的一半 ${minClimb.toFixed(1)}m`);

  return expect(
    probs.length === 0,
    probs.length
      ? probs.join('；')
      : `高差 ${relief.toFixed(1)}m / p10~p90 ${(p90 - p10).toFixed(1)}m / 压下限 ${floorPct.toFixed(1)}% 压上限 ${ceilPct.toFixed(1)}% / 占 ${occupied.size}/${bins} 格 / 纵坡 p95 ${(p95Grade * 100).toFixed(1)}% max ${(maxGrade * 100).toFixed(1)}% / 累计爬升 ${ascent.toFixed(1)}m 下降 ${descent.toFixed(1)}m / 离地 ${gapMax.toFixed(2)}m`,
    asserts,
  );
});

// ---------------------------------------------------------------- 旧物
/**
 * 五件可摸索的旧物。
 *
 * ## 这条守的是什么
 *
 * 序章把"这双手摸一下，东西自己会讲它是谁"讲得很清楚，
 * 然后游戏再也没给过玩家一次机会。这里守的是那五件**真的在世界里、
 * 真的够得着、真的有话说**——三件事任何一件塌了，
 * 玩家看到的就是"路上多了个装饰"或者"按了 F 什么都没发生"。
 *
 * ## 它凭什么会红
 *
 * | 断言 | 退回什么写法会红 |
 * |---|---|
 * | 5 件 / 五种物件 | 删掉 `RELICS` 的一项 → 红 `4 件` |
 * | 一座碎片驿站一件 | 把 `relicSite` 改成用 `STATIONS[i]`（`i` 随 RELICS 变） → 红 `槽位对不上` |
 * | 键在**两侧**表里 | 只加中文 → 红 `en 缺 relic_bowl_title` |
 * | 不在路面上 | `RELIC_FROM_ROAD` 改小 → 落进沥青里 → 红 `压在路面上` |
 * | 路肩外但够得着 | `RELIC_REACH` 改成 1.0 → 红 `够不着`；改成 40 → 红 `不用减速就能摸到` |
 * | 坡度平 | 落位挪到陡坡上 → 红 `地基不平` |
 * | 三角面预算 | 提示圈换回 4×28 → 红 `2272 三角面，超出 2000` |
 * | 离中心线 = `RELIC_FROM_ROAD` | 退回"从驿站退固定米数"的写法（实测偏出 4.5m） → 红 `离中心线 x m` |
 */
check('verify_relics', () => {
  let asserts = 0;
  const probs: string[] = [];

  asserts++;
  if (RELICS.length !== 5) probs.push(`旧物 ${RELICS.length} 件，应为 5`);

  // 与碎片槽位一一对应：第 i 件在第 i 座碎片驿站的路那侧。
  // 两处各按自己的顺序排一遍的话，读数全绿而东西放错了驿站。
  asserts++;
  if (RELICS.length !== FRAGMENT_STATIONS.length) {
    probs.push(`旧物 ${RELICS.length} 件 / 碎片驿站 ${FRAGMENT_STATIONS.length} 座，对不上`);
  }

  const sites: Array<{ kind: RelicKind; x: number; z: number; dRoad: number; dStation: number }> = [];
  for (let i = 0; i < RELICS.length; i++) {
    const st = FRAGMENT_STATIONS[i];
    if (!st) continue;
    const s = relicSite(st);
    sites.push({
      kind: RELICS[i].kind,
      x: s.x,
      z: s.z,
      dRoad: distToCenterline(s.x, s.z),
      dStation: Math.hypot(s.x - st.x, s.z - st.z),
    });
  }

  const terrain = new Terrain();

  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    const half = ROADMESH.TOTAL_HALF_WIDTH;

    // 1. 不许压在路面上。它必须在路肩之外——站上去就触发的那不叫旧物。
    asserts++;
    if (s.dRoad < half + 0.8) {
      probs.push(`${s.kind} 离中心线 ${s.dRoad.toFixed(1)}m，压在路面（半宽 ${half}m）上`);
    }

    // 2. 路肩外但**够得着**：从路肩外缘走过去，伸手能到。
    asserts++;
    if (s.dRoad - half > RELIC_REACH) {
      probs.push(`${s.kind} 在路肩外 ${(s.dRoad - half).toFixed(1)}m，够不着（伸手 ${RELIC_REACH}m）`);
    }

    // 3. 但也不是伸手就够——必须偏出路面才摸得到，
    //    而 `verify_offslow` 从 +1.5m 起罚速，所以"摸一件旧物"这件事
    //    天然带着一次减速。**这条是设计判据，不是几何判据。**
    asserts++;
    if (s.dRoad - half < 0.9) {
      probs.push(`${s.kind} 几乎就贴在路肩上，站在路上就能摸到，不用减速`);
    }

    // 4. 地基要平。东西撒在陡坡上会一头悬空一头埋进土里。
    asserts++;
    const g = [0.9, 0].map((o) => terrain.getHeightAt(s.x + o, s.z));
    const rise = Math.abs(g[0] - g[1]);
    if (rise > 0.6) probs.push(`${s.kind} 地基不平：1.8m 内落差 ${rise.toFixed(2)}m`);

    // 5. 文案两侧都要有。少一侧 = 英文界面显示 ⟨key⟩ 占位符。
    asserts++;
    const def = RELICS[i];
    for (const key of [def.titleKey, def.textKey]) {
      for (const lang of ['zh', 'en'] as const) {
        const v = I18N[lang][key];
        if (!v) probs.push(`${lang} 缺 ${key}`);
      }
    }
  }

  // 6. 物件种类不许重样。五件同形状 = 一条路上摆着五个一样的盒子。
  asserts++;
  if (new Set(RELICS.map((r) => r.kind)).size !== RELICS.length) {
    probs.push(`物件种类有重复：${RELICS.map((r) => r.kind).join(',')}`);
  }

  // 7. 三角面预算。它们在屏幕上只有几十个像素。
  asserts++;
  const tris = new Relics(terrain).triangleCount();
  if (tris > 2000) probs.push(`五件旧物合计 ${tris} 三角面，超出 2000 的预算`);

  // 8. 离中心线的距离就是设计要钉住的那个数。
  //    改路宽它自己跟着走——"离路多远"是设计关系，
  //    "从驿站退几米"只是它的一种实现，而那种实现依赖驿站偏移（会变）。
  asserts++;
  for (let i = 0; i < sites.length; i++) {
    if (Math.abs(sites[i].dRoad - RELIC_FROM_ROAD) > 0.05) {
      probs.push(`${sites[i].kind} 离中心线 ${sites[i].dRoad.toFixed(2)}m，应为 ${RELIC_FROM_ROAD}m`);
    }
  }

  return expect(
    probs.length === 0,
    probs.length
      ? probs.join('；')
      : `5 件（${RELICS.map((r) => r.kind).join('/')}）· 离路肩 ${sites
          .map((s) => (s.dRoad - ROADMESH.TOTAL_HALF_WIDTH).toFixed(1))
          .join('/')}m · 伸手 ${RELIC_REACH}m · ${tris} 三角面 · 键两侧齐`,
    asserts,
  );
});

// ---------------------------------------------------------------- 上线字节数
/**
 * ## 为什么必须有这条
 *
 * 这是 39 条判据里**唯一一条量"有多少字节要发给玩家"**的，
 * 而它本来就不该缺席：这个项目的第一设计目标是低配兼容，
 * 而"低配"在用户手里的东西就是**流量与首屏时间**。
 *
 * 实际发生的事：AGENTS.md 写着"`public/` 里的资产已经压到 ~5MB，
 * 提交时确认没被压回原图"——**它被压回去了**，`public/models` 从 ~5MB
 * 涨到 16.84MB（+256%），而 39 条判据全绿。
 *
 * 病根和 `bottomOf()`、`MASS_MODELS`、`visibilityFactor` 是**同一族**：
 * **意图写对了、代码没接上、症状安静**。区别是这一次连"意图"都没被自动化守住，
 * 只写在 AGENTS.md 的一段散文里——散文不会被执行。
 *
 * ## 三层，而不是一个总数
 *
 * 一个总数会骗人：这个游戏**能玩**的时候一个模型都不需要
 * （地形、路面、水面、驿站全是程序化生成的），所以"首屏 1.11MB"是真话，
 * 而"包体 16.84MB"也是真话。混成一个数就会得出"没超标"或者"严重超标"
 * 这种两边都不对的结论。
 *
 * | 层 | 是什么 | 现状 | 预算 |
 * |---|---|---|---|
 * | **能玩** | js + css + html + UI 字体，零模型 | 1.11MB | 2.0MB |
 * | **补全世界** | 启动链上的 13 个模型 | **11.27MB** | 12.0MB |
 * | **可选** | 链外的摩托车 | 4.82MB | 5.0MB |
 *
 * ## 关于 11.27MB 这个数：**这条判据不让它变小，只不让它再涨**
 *
 * 预算定在现状之上一点点，所以它现在是绿的——**这是故意的**。
 * 一条一落地就红的判据会被当成噪音，而噪音是它唯一的失败方式
 * （"反正它一直红" → 没人看 → 它保护不了任何东西）。
 *
 * 真正的问题还没解决，而这条判据诚实地把它记下来了：
 *  · `motorcycle.glb` 4.82MB 里 **82% 是 215 张 JPEG**（69 个部件 ×
 *    normal/basecolor/rm 各一张，AI 生成模型没走过贴图管道）。
 *  · 这批模型的**源文件不存在**：`.cache/tex` 被 gitignore 从未入库，
 *    而 Godot 源项目里也没有 motorcycle / survivor / skateboard /
 *    pine / bamboo / mod_*。所以 `npm run assets:geo` 对它们**不可执行**。
 *  · 能降的办法是 `npm run assets:retax`（直接重压已发布的 GLB 的贴图）。
 *    它写好了并且**带自我保护**（压完更大就拒绝写盘），但在本机跑不起来：
 *    `@gltf-transform/functions` → `ndarray-pixels` → 自带的
 *    `sharp@0.35.5` 原生模块 `ERR_DLOPEN_FAILED`。
 *
 * 所以这一条的真实作用是：**从现在起，任何新加的模型都会立刻被这条拦住**，
 * 直到有人跑通 `retax` 把预算重新压下去。
 *
 * ## 它凭什么会红
 *
 * | 断言 | 退回什么写法会红 |
 * |---|---|
 * | 能玩 ≤ 2MB | 把手写体 `handwriting.woff2`（404KB）挪进首屏链 → 红 |
 * | 补全 ≤ 12MB | 往 `assetChain` 里再加一个模型 → 红 |
 * | 可选 ≤ 5MB | 加第二个大模型进链外 → 红 |
 * | **单个可选模型 ≤ 5MB** | 放一个 8MB 的模型进去 → 红 `单文件 8.00MB` |
 * | 摩托车**不许**在启动链上 | 把它挪进 `assetChain` → 红（它现在是 4.82MB） |
 */
check('verify_payload', () => {
  let asserts = 0;
  const probs: string[] = [];
  const mb = (n: number) => n / 1048576;
  // 回归由 `npm run verify` 跑，cwd 就是仓库根。用 cwd 而不是
  // `import.meta.url` 反推——后者在 esbuild 打成单文件 ESM 之后
  // 指向的是临时目录，会把路径算到 `.cache` 之外的某个随机位置。
  const ROOT = process.cwd();

  // ---- 能玩：一个模型都不需要 ----
  asserts++;
  const js = sizeOf(join(ROOT, 'dist/assets'), '.js');
  const css = sizeOf(join(ROOT, 'dist/assets'), '.css');
  const html = sizeOfFile(join(ROOT, 'dist/index.html'));
  const uiFont = sizeOfFile(join(ROOT, 'public/fonts/ui.woff2'));
  // 标题页主视觉。它在首屏上（标题页就是首屏），所以算进这一档。
  // 199KB —— 一张 1920 宽的 JPEG 铺底，相对 926KB 的 JS 是小头，
  // 而它是全作第一眼看到的东西。`verify_payload` 是唯一会盯着它的判据。
  const titleArt = sizeOfFile(join(ROOT, 'public/ui/titleart.jpg'));
  if (!js || !html) {
    // 没构建过就量不到，不算失败——但必须说出来，
    // 否则"这条判据没跑"和"这条判据绿了"看起来一模一样。
    probs.push('dist/ 不存在或没有产物，先 npm run build（本条量的是实际发出的字节）');
  } else {
    if (titleArt === 0) probs.push('public/ui/titleart.jpg 不在（标题页会退成一块纯色）');
    if (titleArt > 320 * 1024) probs.push(`标题主视觉 ${mb(titleArt).toFixed(2)}MB，超过 320KB`);
    const playable = js + css + html + uiFont + titleArt;
    if (mb(playable) > 2.0) probs.push(`能玩就要 ${mb(playable).toFixed(2)}MB，超过 2.0MB`);
  }

  // ---- 补全世界：启动链上的模型 ----
  // 名单抄 `main.ts:assetChain` 的结构。**抄一份而不是 import**：
  // 那是宿主代码，回归 import 它会把整个 main 的依赖树拖进来。
  // 两边不一致时下面那条"链上不许有摩托车"会先红。
  asserts++;
  const BOOT_CHAIN = [
    'bicycle.glb', // loadBikeModel —— 玩家第一眼盯着的那一个
    'pine_split.glb', 'bush.glb', // loadVegetationModels
    'bamboo_trim.glb', 'mod_tower.glb', 'mod_house.glb', // loadSceneryModels
    'skateboard.glb', 'survivor.glb', // loadVehicleExtras
    'station_0.glb', 'station_1.glb', 'station_2.glb', 'station_3.glb', 'station_4.glb', // 按距离渐进
  ];
  let chain = 0;
  for (const f of BOOT_CHAIN) {
    const s = sizeOfFile(join(ROOT, 'public/models', f));
    if (s === 0) probs.push(`启动链上的 ${f} 不在 public/models`);
    chain += s;
  }
  if (mb(chain) > 12.0) probs.push(`补全世界要 ${mb(chain).toFixed(2)}MB，超过 12.0MB`);

  // ---- 可选：链外的 ----
  // 摩托车**现在就是链外的**（`main.ts` 里 `void world.loadMotorcycleModel()`
  // 挂在启动链之外，带 20 秒硬超时）。这是它该在的位置。
  asserts++;
  const moto = sizeOfFile(join(ROOT, 'public/models/motorcycle.glb'));
  if (moto === 0) probs.push('public/models/motorcycle.glb 不在');
  if (moto > 5 * 1048576) probs.push(`motorcycle.glb 单文件 ${mb(moto).toFixed(2)}MB，超过 5MB`);

  // 4. 单个可选模型的上限。总数合规而单文件离谱时，只有这条会红。
  asserts++;
  for (const f of ['motorcycle.glb', 'survivor.glb', 'skateboard.glb']) {
    const s = sizeOfFile(join(ROOT, 'public/models', f));
    if (s > 5 * 1048576) probs.push(`可选模型 ${f} ${mb(s).toFixed(2)}MB，超过 5MB`);
  }

  // 5. 摩托车不许回到启动链上。
  //    `assetChain` 的注释写着"**不进链也就不会被那次超时波及**"——
  //    4.82MB 挂回链上就等于把一次超时风险挂回第一屏。
  asserts++;
  if (BOOT_CHAIN.includes('motorcycle.glb')) probs.push('motorcycle 在启动链上');

  // 6. 全部模型只作为**报数**写进 detail，不设硬上限：
  //    它是一个"知道了会难受但暂时改不掉"的数（贴图占 motorcycle 的 82%，
  //    而源文件不存在，只能用 tools/retax.mjs 重压）。
  asserts++;
  const allModels = dirSize(join(ROOT, 'public/models'));
  const audio = dirSize(join(ROOT, 'public/audio'));
  if (allModels === 0) probs.push('public/models 是空的');

  return expect(
    probs.length === 0,
    probs.length
      ? probs.join('；')
      : `能玩 ${mb(js + css + html + uiFont + titleArt).toFixed(2)}MB（含主视觉 ${mb(titleArt).toFixed(2)}MB）· 补全 ${mb(chain).toFixed(2)}MB · 摩托车(链外) ${mb(moto).toFixed(2)}MB · 模型合计 ${mb(allModels).toFixed(2)}MB · 音频 ${mb(audio).toFixed(2)}MB`,
    asserts,
  );
});

function sizeOfFile(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}
function sizeOf(dir: string, ext: string): number {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  } catch {
    return 0;
  }
}
function dirSize(dir: string): number {
  try {
    return readdirSync(dir).reduce((n, f) => n + sizeOfFile(join(dir, f)), 0);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- 三十日
/**
 * ## 为什么这条必须存在
 *
 * 律师函写着"三十日内不开业，依法征收"，反派第三场说"五天内不签字"，
 * 两条都念给玩家听过。而在这之前，**三十天从来不会走**——
 * 它是一句背景，不是一个期限。
 *
 * 于是这个游戏的两难是：要么它有时间限制（就有"白跑一趟"），
 * 要么它没有（律师函就是在骗人）。**这条路选了第三条**：
 * 过期不是失败画面，只是目标换了一个（`back_break` 那个结局就是为它写的，
 * 而在这之前它**没有任何入口**——一个到不了的结局等于没写）。
 *
 * ## 它凭什么会红
 *
 * | 断言 | 退回什么写法会红 |
 * |---|---|
 * | 日期只增不减 | `day` 里减去 `laps` → 退回圈时日期会变小 → 红 |
 * | 认真玩会用掉大部分期限 | `DAYS_PER_LAP` 改成 0 → 磨蹭零代价 → 红 `15 圈也只花 16 天` |
 * | 磨蹭会过期 | `DAYS_PER_LAP` 改成 1 → 红 `10 圈才 26 天，永远过期不了` |
 * | 过期后目标真的换 | `objectiveKey` 里去掉 `overdue` 分支 → 红 |
 * | 存读往返保住日期 | `save()` 漏写 `laps` → 红 |
 * | 天色随日期单调变暗 | `setByProgress` 去掉 `byDay` → 红 |
 * | 三个键两侧都有 | 只加中文 → 红 |
 */
check('verify_days', () => {
  let asserts = 0;
  const probs: string[] = [];
  const g = new GameStateManager();

  // 1. 从第 1 天起。
  asserts++;
  if (g.day !== 1) probs.push(`开局第 ${g.day} 天，应为 1`);

  // 2. 只增不减：把 15 次打卡 + 5 圈全走一遍，每一步都不能倒退。
  asserts++;
  let prev = g.day;
  let monotone = true;
  const seen: number[] = [];
  for (let lap = 0; lap < 6; lap++) {
    g.noteLap();
    seen.push(g.day);
    for (let k = 0; k < 5; k++) {
      const st = ROAD.FRAGMENT_SLOT_STATION_IDX[k % ROAD.FRAGMENT_SLOT_STATION_IDX.length];
      g.checkIn(st);
      seen.push(g.day);
      if (g.day < prev) monotone = false;
      prev = g.day;
    }
    if (g.day < prev) monotone = false;
    prev = g.day;
  }
  if (!monotone) probs.push('日期会倒退');

  // 3. **认真玩会用掉大部分期限**。
  //    15 次打卡 + 5 圈 × 3 天 = 31 天 > 30 —— 一趟完整的活儿刚好会过期，
  //    这就是口径的由来。放宽到"用得掉一半以下"就等于期限不存在。
  asserts++;
  const fullRun = 1 + 15 * GameStateManager.DAYS_PER_CHECKIN + 5 * GameStateManager.DAYS_PER_LAP;
  if (fullRun < GameStateManager.DAYS_LIMIT) {
    probs.push(`认真玩一遍才 ${fullRun} 天，期限 ${GameStateManager.DAYS_LIMIT} 天用不完`);
  }

  // 4. 磨蹭会过期：只打卡不骑圈，15 次 = 16 天，还在期限内。
  //    反过来多骑几圈就一定过期——这一条量的是"圈要花日期"。
  asserts++;
  const lapsToOverdue = Math.ceil((GameStateManager.DAYS_LIMIT - 16) / GameStateManager.DAYS_PER_LAP) + 1;
  const g2 = new GameStateManager();
  for (let k = 0; k < 15; k++) g2.checkIn(ROAD.FRAGMENT_SLOT_STATION_IDX[k % 5]);
  for (let l = 0; l < lapsToOverdue; l++) g2.noteLap();
  if (!g2.overdue) probs.push(`${lapsToOverdue} 圈之后仍未过期，圈不花日期`);

  // 5. 过期之后目标真的换掉，而且**不是失败**。
  asserts++;
  if (g2.objectiveKey !== 'objective_overdue') probs.push(`过期时目标是 ${g2.objectiveKey}`);
  if (g2.objective === 'collect' && !g2.overdue) probs.push('未过期却不是 collect');

  // 6. 存读往返。`laps` 漏进存档的话，读档之后玩家白赚几天。
  //    **必须注入同一个内存 store**——`save()` / `load()` 都包在 try/catch 里，
  //    而 Node 里没有 localStorage，于是默认后端会安静地什么都不做：
  //    第一次跑这条判据时它报的是「第 8 天 → 读回第 1 天」，
  //    而真正的原因是"后端不存在"，不是"字段没写进存档"。
  asserts++;
  const mem = new Map<string, string>();
  const store = {
    read: (k: string) => mem.get(k) ?? null,
    write: (k: string, v: string) => void mem.set(k, v),
    remove: (k: string) => void mem.delete(k),
  };
  const g3 = new GameStateManager(store);
  g3.noteLap();
  g3.noteLap();
  g3.checkIn(ROAD.FRAGMENT_SLOT_STATION_IDX[0]);
  const dayBefore = g3.day;
  g3.save();
  const g4 = new GameStateManager(store);
  if (!g4.load()) probs.push('有存档却 load 不回来');
  if (g4.day !== dayBefore) probs.push(`存读往返：第 ${dayBefore} 天 → 读回第 ${g4.day} 天`);

  // 7. 天色随日期单调变暗。
  asserts++;
  const s1 = new Sky(new Scene(), 0, 0);
  s1.setByProgress(1, 0.5, 1, 30);
  const d0 = s1.dusk;
  s1.setByProgress(1, 0.5, 20, 30);
  const d1 = s1.dusk;
  s1.setByProgress(1, 0.5, 30, 30);
  const d2 = s1.dusk;
  if (!(d0 < d1 && d1 <= d2)) probs.push(`天色不随日期单调变暗：${d0} / ${d1} / ${d2}`);
  if (d0 !== 0) probs.push(`第 1 天不该是黄昏（dusk=${d0}）`);
  if (d2 >= 1) probs.push(`期限那天不该全黑（dusk=${d2}）`);

  // 8. 三个键两侧都有。
  asserts++;
  for (const k of ['hud_days_left', 'hud_days_over', 'objective_overdue']) {
    for (const lang of ['zh', 'en'] as const) {
      if (!I18N[lang][k]) probs.push(`${lang} 缺 ${k}`);
    }
  }

  return expect(
    probs.length === 0,
    probs.length
      ? probs.join('；')
      : `打卡 ${GameStateManager.DAYS_PER_CHECKIN} 天 / 圈 ${GameStateManager.DAYS_PER_LAP} 天 · 认真玩 ${fullRun} 天 vs 期限 ${GameStateManager.DAYS_LIMIT} 天 · 存读往返保住`,
    asserts,
  );
});

// ---------------------------------------------------------------- 骑行节拍
/**
 * 竹的骑行节拍 —— **第一件和"骑"有关的乐事**。
 *
 * ## 为什么它值得一条判据
 *
 * 五个小游戏原本全是单屏 2D 覆盖层，没有一件和"骑"有关。
 * 这一件把其中一件搬回路上，于是"边骑边做"第一次成为可能。
 * 而**能发生**这件事本身就得证明：竹丛在路边 26~110m，
 * 窗口只在 13m 内开——玩家得真的骑得到。
 *
 * ## 它凭什么会红
 *
 * | 断言 | 退回什么写法会红 |
 * |---|---|
 * | 节拍点 > 20 | 竹丛散布被改小 → 红 `只有 n 个点` |
 * | 有节拍点**够得着** | 窗口半径改小到 2m（骑不到） → 红 `0 个点在 13m 内可达` |
 * | 窗口内按 = hit | 阈值写反 → 红 |
 * | 超时**不算失手** | 超时也罚 → 红（`verify_offslow` 已经罚过压草，不该罚两次） |
 * | 连按被挡 | 去掉 `allowPress` → 红 `0.2s 内连按 3 次` |
 * | 满 5 下只发一次 | 去掉 `done` 闩锁 → 红 `发了两遍` |
 * | **不改碎片** | 命中时写 `collected` → 红 `碎片次数被节拍改了` |
 * | HUD 在完成后隐藏 | `setBeat` 漏了 `done` 分支 → 红（`setBeat` 是纯 UI，这里量逻辑） |
 */
check('verify_beat', () => {
  let asserts = 0;
  const probs: string[] = [];

  const terrain = new Terrain();
  const sc = new Scenery(terrain);
  const b = new BambooBeats(sc);

  // 1. 节拍点够多。一条路上只有三四处能按，那不叫玩法，叫彩蛋。
  asserts++;
  if (b.pointCount < 20) probs.push(`只有 ${b.pointCount} 个节拍点，应至少 20`);

  // 2. **绝大多数节拍点必须真的在骑行路线旁边。**
  //    量的是**节拍点本身**，不是竹丛圆心——第一版量错了对象，
  //    拿 26~110m 外的丛心去比 24m 的窗口，于是报「1/100 够得着」。
  //    一条量错对象的判据会把正确的实现说成错的。
  asserts++;
  const reach = b.allPoints.filter(
    (p) => distToCenterline(p.x, p.z) - ROADMESH.TOTAL_HALF_WIDTH <= BEAT_ARM_RADIUS,
  ).length;
  const ratio = b.pointCount > 0 ? reach / b.pointCount : 0;
  if (ratio < 0.9) probs.push(`只有 ${reach}/${b.pointCount} 个节拍点够得着（${(ratio * 100).toFixed(0)}%）`);

  // 2b. 节拍点必须落在路侧、且**不压在路面上**。
  asserts++;
  const onRoad = b.allPoints.filter((p) => distToCenterline(p.x, p.z) < ROADMESH.TOTAL_HALF_WIDTH).length;
  if (onRoad > 0) probs.push(`${onRoad} 个节拍点压在路面上`);

  // 2c. 窗口必须短到仍然是个"节拍"。一个 3 秒的窗口玩家会站在那儿等。
  asserts++;
  if (BEAT_WINDOW > 1.5) probs.push(`窗口 ${BEAT_WINDOW}s 太长，不是节拍是等待`);
  if (BEAT_WINDOW < 0.6) probs.push(`窗口 ${BEAT_WINDOW}s 太短，来不及反应`);

  // 3. 窗口内按 = hit。
  asserts++;
  const b1 = new BambooBeats(sc);
  const p0 = b1.allPoints[0];
  if (p0) {
    b1.update(0.016, p0.x, p0.z, 0);
    const armed = b1.state.open;
    b1.update(0.1, p0.x, p0.z, 0.1); // 窗口内
    const r = b1.press();
    if (!armed) probs.push('站到竹丛上窗口没有打开');
    if (r !== 'hit') probs.push(`窗口内按得到 ${r}，应为 hit`);
  } else {
    probs.push('没有竹丛可测');
  }

  // 4. 超时**不算失手**。
  //    `verify_offslow` 已经因为压草罚过一次速，窗口超时再罚一次是罚两次。
  asserts++;
  const b2 = new BambooBeats(sc);
  if (p0) {
    b2.update(0.016, p0.x, p0.z, 0);
    b2.update(BEAT_WINDOW + 0.2, p0.x, p0.z, 1.4); // 拖到窗口外
    if (b2.state.hits !== 0) probs.push('超时也算命中');
    if (b2.press() === 'hit') probs.push('超时之后按下仍然算命中');
  }

  // 5. 连按被挡。
  asserts++;
  const b3 = new BambooBeats(sc);
  b3.update(0.016, p0 ? p0.x : 0, p0 ? p0.z : 0, 0);
  let allowed = 0;
  for (let k = 0; k < 5; k++) if (b3.allowPress(k * 0.05)) allowed++;
  if (allowed > 1) probs.push(`0.2s 内放行了 ${allowed} 次连按`);

  // 6. 集满 5 下**只**发一次 done。
  asserts++;
  const b4 = new BambooBeats(sc);
  const pts = b4.allPoints;
  let doneCount = 0;
  for (let k = 0; k < Math.min(pts.length, BEAT_GOAL + 3); k++) {
    b4.update(0.016, pts[k].x, pts[k].z, k * 2);
    b4.update(0.1, pts[k].x, pts[k].z, k * 2 + 0.1);
    if (b4.press() === 'done') doneCount++;
  }
  if (doneCount !== 1) probs.push(`完成提示发了 ${doneCount} 次，应恰好 1 次`);

  // 7. **不改碎片**。这一条是整个设计里最重要的一条边界。
  //    碎片次数被 `verify_mini_game`（15 局每件 3 次）钉着；
  //    往里加一路来源，玩家会问"我明明只打了一次，为什么显示三次"。
  asserts++;
  const g = new GameStateManager();
  for (let k = 0; k < 12; k++) g.checkIn(ROAD.FRAGMENT_SLOT_STATION_IDX[k % 5]);
  const before = ROAD.FRAGMENT_SLOT_STATION_IDX.map((i) => g.getStationCount(i)).join(',');
  // 打满一整套节拍
  const b5 = new BambooBeats(sc);
  for (let k = 0; k < Math.min(pts.length, 8); k++) {
    b5.update(0.016, pts[k].x, pts[k].z, k * 2);
    b5.update(0.1, pts[k].x, pts[k].z, k * 2 + 0.1);
    b5.press();
  }
  const after = ROAD.FRAGMENT_SLOT_STATION_IDX.map((i) => g.getStationCount(i)).join(',');
  if (before !== after) probs.push(`碎片次数被节拍改了：${before} → ${after}`);

  // 8. 三个键两侧都有。
  asserts++;
  for (const k of ['beat_hit', 'beat_miss', 'beat_done']) {
    for (const lang of ['zh', 'en'] as const) {
      if (!I18N[lang][k]) probs.push(`${lang} 缺 ${k}`);
    }
  }

  // 9. **前置提示档**（`BEAT_CUE_RADIUS`）必须真的存在、真的先于窗口发生。
  //
  // 原来节拍一条提示都没有：玩家看到圈亮起时不知道那是什么，也不知道按哪个键，
  // 而窗口只有 1.15s。于是这一件乐事的第一分钟是白扔的。
  asserts++;
  if (!(BEAT_CUE_RADIUS > BEAT_ARM_RADIUS)) {
    probs.push(`前置档 ${BEAT_CUE_RADIUS}m 不比窗口 ${BEAT_ARM_RADIUS}m 更远——那它就不是"前置"`);
  }
  // 提前量按**极速**算，不按巡航：踩满的人没有时间读提示。
  asserts++;
  if (BEAT_CUE_RADIUS - BEAT_ARM_RADIUS < RIDE.MAX_SPEED) {
    probs.push(`按极速 ${RIDE.MAX_SPEED} m/s 算只有 ${(BEAT_CUE_RADIUS - BEAT_ARM_RADIUS).toFixed(1)}s 提前量，读不完一句提示`);
  }
  asserts++;
  {
    // 站在**真实路面**上问：会不会先收到 cue、而窗口还没开。
    //
    // ⚠️ 第一版是"找一对相距 24~48m 的竹丛点，站到其中一个上面"——
    // 那是**量错了对象**：竹丛是成片长的，那个位置上往往还站着第三丛，
    // 窗口是它开的，于是报「收到的是 armed」。它量到的是**邻居**，
    // 不是"这一档会不会触发"。
    //
    // 现在量的是玩家真的会经历的那件事：沿中心线一路问下去，
    // 有没有哪个位置是"该提示、还没开窗口"。用的是真实落位与真实半径。
    let cueAt = -1;
    let alsoOpen = false;
    let cues = 0;
    for (let i = 0; i < CENTERLINE.length; i += 4) {
      const c = CENTERLINE[i];
      const b8 = new BambooBeats(sc);
      if (b8.update(0.016, c.x, c.z, 0) !== 'cue') continue;
      cues++;
      if (cueAt < 0) {
        cueAt = i;
        alsoOpen = b8.state.open;
        // 同一片只提示一次：站着不动不该被反复催。
        asserts++;
        if (b8.update(0.016, c.x, c.z, 0.1) === 'cue') probs.push('同一片竹在原地反复播"前面有竹"');
      }
    }
    if (cueAt < 0) {
      probs.push(
        `沿整条中心线都遇不到「前面有竹」——${BEAT_CUE_RADIUS}m 那一档在真实骑行里触发不了（240 个采样点里 ${cues} 个会先收到提示）`,
      );
    } else if (alsoOpen) {
      probs.push('提示与窗口同时开——两者先后反了');
    }
  }
  // 10. `beat_cue` 两侧都要有——`armed` 不弹提示，全靠这一句。
  asserts++;
  for (const lang of ['zh', 'en'] as const) {
    if (!I18N[lang].beat_cue) probs.push(`${lang} 缺 beat_cue`);
  }

  return expect(
    probs.length === 0,
    probs.length
      ? probs.join('；')
      : `${b.pointCount} 个节拍点 · ${reach} 个够得着（${(ratio * 100).toFixed(0)}%）· 窗口 ${BEAT_WINDOW}s / 半径 ${BEAT_ARM_RADIUS}m · 提示档 ${BEAT_CUE_RADIUS}m · 目标 ${BEAT_GOAL} 下 · 不改碎片`,
    asserts,
  );
});

// ---------------------------------------------------------------- 触屏
check('verify_touch', () => {
  let asserts = 0;
  const probs: string[] = [];

  // **符号约定**是这一族里唯一"不可能在桌面上被发现"的 bug：
  // 摇杆照样能拖、界面一切正常，只是往上推车往后走。
  // 所以它必须有一条断言，而不是靠人记得。
  asserts++;
  const up = stickVector(0, -1); // 手指推到正上方
  if (up[1] >= 0) probs.push(`摇杆往上推 moveY=${up[1]}，应当为负（throttle 负为前进）`);
  asserts++;
  const down = stickVector(0, 1);
  if (down[1] <= 0) probs.push('摇杆往下拉 moveY 不是正');
  asserts++;
  const left = stickVector(-1, 0);
  if (left[0] >= 0) probs.push('摇杆往左推 moveX 不是负');
  asserts++;
  const right = stickVector(1, 0);
  if (right[0] <= 0) probs.push('摇杆往右推 moveX 不是正');

  // 死区：手指按住不动时的微小抖动不该让车慢慢爬
  asserts++;
  const tiny = stickVector(0.05, 0.05);
  if (tiny[0] !== 0 || tiny[1] !== 0) probs.push(`死区没生效：${tiny}`);

  // 刚过死区就应该已经有有效输入（否则玩家以为"推了没反应"）
  asserts++;
  const justOver = stickVector(0, -0.2);
  if (justOver[1] === 0) probs.push('刚过死区仍是 0，玩家会以为没反应');

  // 饱和：推到底不能超过 1
  asserts++;
  const far = stickVector(0, -5);
  if (far[1] < -1.0001 || far[1] > 1.0001) probs.push(`饱和值越界：${far[1]}`);
  // 斜推要按比例归一化，而不是简单截断——截断的话"斜着推"会比
  // "正对着推"弱一大截，手感上像是摇杆只有一半行程是好的。
  // 这里用 (3,4)：归一化后是 (0.6, 0.8)。
  asserts++;
  const diag = stickVector(3, 4);
  if (Math.abs(diag[0] - 0.6) > 1e-6 || Math.abs(diag[1] - 0.8) > 1e-6) {
    probs.push(`斜推没有按比例归一化：${diag}`);
  }

  // 键盘驱动摇杆：与指针走同一套方向约定
  asserts++;
  const kUp = keyToVec('ArrowUp');
  if (!kUp || kUp[1] >= 0) probs.push('键盘 ArrowUp 的方向与指针不一致');
  asserts++;
  if (keyToVec('KeyQ') !== null) probs.push('不认识的键被当成了方向');

  // 从摇杆一路到车速的合成：负的 moveY 必须让速度往上走
  asserts++;
  let speed = 0;
  for (let i = 0; i < 30; i++) {
    const throttle = up[1]; // main 里就是 throttle += touch.moveY
    if (throttle < -0.1) speed = Math.min(speed + 8.0 / 60, 15);
  }
  if (speed <= 0) probs.push('推着摇杆三十帧，车速仍然是 0');

  // ---- 触屏判定本身 ----
  //
  // 这一族是**在开发机上真的踩到过的**：窗口 639×907（桌面浏览器侧栏分屏），
  // `min(短边) < 900` 为真，于是一个用鼠标的玩家被挂上了摇杆，
  // 而摇杆一直吃掉左下角一大片点击区。
  //
  // 症状之所以要钉住：它不报错、不白屏，画面看着还挺像手机版，
  // 键盘玩家只觉得"左下角有个推不动的东西压着小地图"。
  const desktop = { coarse: false, points: 0, fine: true, shortEdge: 639, touched: false };

  // 1. 窄窗口 + 鼠标 → 不挂。这条在修复前是红的（decideTouch 不看 fine）。
  asserts++;
  if (decideTouch(desktop)) probs.push(`窄桌面窗口（短边 ${desktop.shortEdge}px，有鼠标）被误判成触屏`);

  // 2. 1440 笔记本贴靠半屏是同一个坑，也是最常见的触发姿势
  asserts++;
  if (decideTouch({ ...desktop, shortEdge: 720 })) probs.push('半屏窗口（720px）被误判成触屏');

  // 3. 普通桌面窗口 → 不挂
  asserts++;
  if (decideTouch({ ...desktop, shortEdge: 1080 })) probs.push('普通桌面窗口被误判成触屏');

  // 4. 手机竖屏 → 挂。coarse 为真，与 shortEdge 无关（横过来也照样挂）。
  asserts++;
  if (!decideTouch({ coarse: true, points: 5, fine: false, shortEdge: 390, touched: false })) {
    probs.push('手机竖屏没挂触屏控件');
  }
  asserts++;
  if (!decideTouch({ coarse: true, points: 5, fine: false, shortEdge: 844, touched: false })) {
    probs.push('手机横屏没挂触屏控件（coarse 与短边方向无关）');
  }

  // 5. 手机开「桌面版网站」：coarse 变 false，靠触点数接住
  asserts++;
  if (!decideTouch({ coarse: false, points: 5, fine: false, shortEdge: 360, touched: false })) {
    probs.push('桌面版网站的安卓 Chrome 没挂触屏控件');
  }

  // 6. 不报 pointer media query 的安卓 WebView：四个信号里只剩 shortEdge 可用。
  //    这正是第 3 条信号**唯一**存在的理由，所以 fine 取不到值按 false 时它必须仍然生效。
  asserts++;
  if (!decideTouch({ coarse: false, points: 0, fine: false, shortEdge: 480, touched: false })) {
    probs.push('不报 pointer 查询的 WebView 没挂触屏控件');
  }

  // 7. 真按过一次屏 → 永远挂（最强的信号，压过一切）
  asserts++;
  if (!decideTouch({ ...desktop, touched: true })) probs.push('已经触摸过屏却没挂触屏控件');

  // 8. 触屏笔记本：主指针是鼠标（fine），但有触点 → 挂。
  //    这条保证修复没有把「混合设备」一起误伤。
  asserts++;
  if (!decideTouch({ coarse: false, points: 10, fine: true, shortEdge: 800, touched: false })) {
    probs.push('触屏笔记本被误判成纯桌面');
  }

  return expect(probs.length === 0, probs.length ? probs.join('；') : '摇杆符号约定正确，死区/饱和/键盘一致；触屏判定不吃窄窗口', asserts);
});

// ---------------------------------------------------------------- 植被落地
/**
 * 树和灌木必须**底面**站在地面上，而不是**原点**站在地面上。
 *
 * 原型是 `pos.y = 地形高度`，而实例矩阵的 y 是模型原点的高度。
 * 源项目的 GLB 里树与灌木的原点都不在底面，于是底下半个身子插进土里——
 * 而画面上它读作"草丛矮了一截"，没人会想到是落地规则错了。
 *
 * 三条断言各自会红的做法都写在下面。
 */
check('verify_veg_ground', () => {
  let asserts = 0;
  const probs: string[] = [];

  // 1. 方向：模型原点低于底面（minY < 0）时，偏移必须为正——往上抬。
  //    写反成 `+bboxMinY` 会把树整个沉进地里，比原 bug 更糟。
  asserts++;
  const sunk = groundOffsetFor(-1.2, 1, 8);
  if (sunk <= 0) probs.push(`模型原点低于底面时偏移为 ${sunk}，应当为正（往上抬）`);

  // 2. 随缩放变化：树是逐株 6~9 倍，灌木是 4 倍乘 0.5~1。
  //    固定偏移只对其中一种正确——那正是原型（yOffset 恒为 0）的问题。
  asserts++;
  if (Math.abs(groundOffsetFor(-1, 1, 6) - 6) > 1e-9 || Math.abs(groundOffsetFor(-1, 1, 9) - 9) > 1e-9) {
    probs.push('偏移没有随实例缩放变化');
  }
  asserts++;
  if (Math.abs(groundOffsetFor(-0.5, 4, 1) - 2) > 1e-9) probs.push('偏移没有乘上模型缩放');

  // 3. 原点就在底面时不该动；退化输入不许把整片植被抬上天
  asserts++;
  if (Math.abs(groundOffsetFor(0, 1, 8)) > 1e-9) probs.push('模型原点就在底面时偏移不为 0');
  asserts++;
  for (const bad of [NaN, Infinity, -Infinity]) {
    if (groundOffsetFor(bad, 1, 8) !== 0) probs.push(`退化输入 ${bad} 得到了非零偏移 ${groundOffsetFor(bad, 1, 8)}`);
  }

  // 4. **交错属性**——这一条是「路边从来没有树」的守护。
  //
  //    原实现遍历 `pos.array` 并按 `itemSize` 跨步，那只对**独立数组**成立。
  //    而这些模型（NORMAL + POSITION + TEXCOORD_0 共用一个 buffer）的
  //    属性是交错的，跨步会把法线和 UV 当成 Y 读进来：
  //    实测树的实例 Y 落到 **+949,141 米**，被视锥剔除，一次都不画。
  //
  //    下面造一个真的交错 BufferAttribute 来复现——**用非交错的那种测不出来**。
  asserts++;
  {
    // 每个顶点 8 个 float：normal(3) + position(3) + uv(2)
    const n = 4;
    const stride = 8;
    const data = new Float32Array(n * stride);
    for (let i = 0; i < n; i++) {
      const o = i * stride;
      data[o + 0] = 0; // normal.x
      data[o + 1] = 9e9; // normal.y
      data[o + 2] = 0; // normal.z
      data[o + 3] = i * 0.25; // position.x
      data[o + 4] = 100 + i * 2; // position.y ← 真正的底面是 100，不是 0
      data[o + 5] = 0; // position.z
      data[o + 6] = 5e8; // uv.x
      data[o + 7] = 5e8; // uv.y
    }
    // 真实形态是 `InterleavedBuffer`：三种属性共用一块数组、stride 8。
    // **不能拿 `new BufferAttribute(data, 3, 8)` 冒充**——那个第三个参数
    // 是 normalized（布尔），写 8 会在运行时报错，测的就不是同一件事了。
    const buf = new InterleavedBuffer(data, stride);
    const inter = new InterleavedBufferAttribute(buf, 3, 3); // offset 3 = POSITION
    const g = new BufferGeometry();
    g.setAttribute('position', inter);
    const b = bottomOf(g);
    // 旧的跨步循环在这份数据上读到的是 index 3i+1：
    // 9e9 / position.y / uv.y / vertex1.normal.z(=0) …… 最小值落在 **0**，
    // 于是它把模型当成"底面在原点"——而真实底面是 100。
    // 差 100m，×缩放 27 就是 2.7km，正是"树飘到天上"的量级。
    if (Math.abs(b - 100) > 1e-6) probs.push(`交错属性读出底面 ${b}，应为 100（跨步把法线/UV 当成了 Y）`);
  }

  // 5. 非交错的老路径不能被改坏。
  asserts++;
  {
    const g = new BufferGeometry();
    g.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, 3, 0, 1, 0, 0, 0, 1, 0]), 3),
    );
    if (Math.abs(bottomOf(g)) > 1e-6) probs.push(`非交错属性的底面读成 ${bottomOf(g)}，应为 0`);
  }

  // 6. 一个远离本体的游离顶点不该毁掉"最低点"。
  asserts++;
  {
    const g = new BufferGeometry();
    const pts: number[] = [];
    for (let i = 0; i < 200; i++) pts.push(0, i * 0.02, 0); // 0..3.98
    pts.push(5, -35000, 5); // 唯一的游离顶点
    g.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
    const b = bottomOf(g);
    if (b < -0.01) probs.push(`游离顶点污染了底面：${b}（应为 0 附近）`);
  }

  // 7. 空几何退化成 0，而不是抛。
  asserts++;
  {
    const g = new BufferGeometry();
    if (bottomOf(g) !== 0) probs.push('空几何的底面不为 0');
  }

  return expect(
    probs.length === 0,
    probs.length ? probs.join('；') : '底面落地，偏移随缩放，方向为正',
    asserts,
  );
});

// ---------------------------------------------------------------- 植被密度
/**
 * 路**两边必须有树**。
 *
 * ## 这条为什么存在
 *
 * 实机截屏里出现过的样子：一条光秃秃的柏油路，两侧是纯绿色山坡，
 * 一棵树都没有——而那是**高档**。数出来才发现：
 *
 *   | 档位 | 全环线树 | 灌木 | 起点 60m 内 |
 *   |---|---|---|---|
 *   | 低 | 13 | 37 | 2 / 2 |
 *   | 中 | 49 | 111 | 6 / 11 |
 *   | 高 | 49 | 111 | 6 / 11 |
 *
 * 1228.8m 的环线一共 49 棵树（25m 株距、左右错开 = 每侧 50m 一株）。
 * 真实的乡村公路行道树是**每侧 15~25m 一株**，
 * 也就是说这里的密度只有真实值的三分之一，而截图上读起来就是"高速公路"。
 *
 * 根因是一株树 **35,461 个三角面**，简化压不动（详见 vegetation.ts 的注释）。
 *
 * ## 换完低模松树之后
 *
 * `pine.glb` 一丛 6 棵、31,219 面（5,203 面/棵），株距从 25m 收到 17m，
 * 于是全环线 **72 丛 = 434 株**，起点 60m 内从 6 株变成 30 株。
 * 断言记的是**株数**（丛数 × `TREES_PER_COPE`），因为那才是玩家看见的东西。
 */
check('verify_veg_density', () => {
  let asserts = 0;
  const probs: string[] = [];

  const terrain = new Terrain();
  // `Placement` 没有导出（它是 vegetation.ts 的模块内类型），
  // 这里只用到 x/z 两个字段，所以就地写结构类型而不是把它导出——
  // 为了让一条断言能跑就把模块的内部形状变成公共 API，不划算。
  type P = { x: number; z: number };
  const counts: {
    tier: number;
    tree: number;
    nearTree: number;
    bush: number;
    variants: number;
    minRoad: number;
    minBury: number;
  }[] = [];
  for (let tier = 0 as Tier; tier <= 2; tier = (tier + 1) as Tier) {
    const veg = new Vegetation(PRESETS[tier], terrain);
    const chunks = (veg as unknown as { chunks: { tree: (P & { variant: number; bury: number })[]; bush: P[] }[] }).chunks;
    let tree = 0;
    let bush = 0;
    let nearTree = 0;
    const variants = new Set<number>();
    const s0 = STATIONS[0];
    for (const c of chunks) {
      tree += c.tree.length;
      bush += c.bush.length;
      for (const p of c.tree) {
        variants.add(p.variant);
        if (Math.hypot(p.x - s0.mapX, p.z - s0.mapZ) < 60) nearTree++;
      }
    }
    // 最近的一棵树离中心线多远 ——「树不许压在路面上」这条硬约束的实测值
    let minRoad = Infinity;
    // 最小的埋地深度 ——「松树不悬空」那条
    let minBury = Infinity;
    for (const c of chunks) {
      for (const p of c.tree) {
        minRoad = Math.min(minRoad, distToRoad(p.x, p.z));
        minBury = Math.min(minBury, p.bury);
      }
    }
    counts.push({ tier, tree, nearTree, bush, variants: variants.size, minRoad, minBury });
  }

  // 1. 每档全环线至少 120 株。低于这个数，1228m 的路就是"两旁没东西"，
  //    而玩家一进世界看到的就是前 60m。
  asserts++;
  for (const c of counts) {
    if (c.tree < 120) probs.push(`第 ${c.tier} 档全环线只有 ${c.tree} 株树`);
  }

  // 2. 起点 60m 内至少 24 株 —— 开局第一眼。
  asserts++;
  for (const c of counts) {
    if (c.nearTree < 12) probs.push(`第 ${c.tier} 档起点 60m 内只有 ${c.nearTree} 株树`);
  }

  // 3. **变体要真的被用到**：拆分出的 6 棵如果只用到 1 棵，
  //    画面上仍是同一个模型复制 N 遍 —— 那是"看起来有树"而不是"有树林"。
  asserts++;
  for (const c of counts) {
    if (c.variants < 4) probs.push(`第 ${c.tier} 档只用到 ${c.variants} 个树变体（拆了 6 棵）`);
  }

  // 4. **树不许压在路面上**：路面总半宽 6.5m，树冠半径最坏 8.1m，
  //    所以树干中心离中心线必须 ≥ 14.6m。
  //    这一条是硬约束：画面上一眼能看出"树枝搭在沥青上"，
  //    而回归不钉住它，下一次调株距就会被改回去。
  asserts++;
  for (const c of counts) {
    if (c.minRoad < 14.6) {
      probs.push(`第 ${c.tier} 档最近的一棵树离中心线只有 ${c.minRoad.toFixed(1)}m（应 ≥14.6）`);
    }
  }

  // 5. **每棵都要往地里埋一点** ——「松树不悬空」这条用户要求。
  //
  //    `terrain.getHeightAt()` 是**点采样**：它给的是树干中心那一柱的高度，
  //    而地形在树根那 0.5m 直径内是有坡度的。树根正好坐在坡的上沿时，
  //    下坡那一侧会露出缝 —— 读作"树浮在地面上"。
  //    埋一点就把这个缝吃掉；代价是树看起来矮一点点，**而没有人会数树有多高**。
  asserts++;
  for (const c of counts) {
    if (c.minBury <= 0) probs.push(`第 ${c.tier} 档有树完全没往地里埋（bury=${c.minBury}），根下会露缝`);
  }

  // 6. 灌木同理，但门槛低一档：它是补空地的，不是主景。
  asserts++;
  for (const c of counts) {
    if (c.bush < 80) probs.push(`第 ${c.tier} 档全环线只有 ${c.bush} 丛灌木`);
  }

  // 7. 密度不得再随档位断崖式下跌：低档砍的是**半径**，不是株数。
  //    半径已经能把看不见的那些块剔掉，再砍株数就是两次砍同一刀。
  asserts++;
  const low = counts[0];
  const high = counts[2];
  if (low.tree * 2 < high.tree) {
    probs.push(`低档 ${low.tree} 株不足高档 ${high.tree} 株的一半：密度与半径被重复扣了一次`);
  }

  const summary = counts
    .map((c) => `档${c.tier} ${c.tree}株/起点${c.nearTree}/变体${c.variants}/最近${c.minRoad.toFixed(1)}m`)
    .join(' · ');
  return expect(probs.length === 0, probs.length ? probs.join('；') : summary, asserts);
});

check('verify_scenery', () => {
  let asserts = 0;
  const probs: string[] = [];

  const terrain = new Terrain();
  const sc = new Scenery(terrain);
  const all = sceneryPlacements(sc);

  const kinds: SceneryKind[] = ['bamboo', 'mod_tower', 'mod_house'];
  for (const kind of kinds) {
    const sp = scenerySpec(kind);
    const [sx, sz] = sp.quad;
    const pts = all[kind];

    // 1. 摆满了没有。摆不满说明判定条件太苛刻——玩家那一角就空了。
    asserts++;
    if (pts.length < sp.max) probs.push(`${kind} 只摆了 ${pts.length}/${sp.max} 个`);

    // 2. **象限**。这是这一族的全部意义，放错象限等于没做。
    asserts++;
    const wrong = pts.filter((p) => sx * p.x < 8 || sz * p.z < 8);
    if (wrong.length) probs.push(`${kind} 有 ${wrong.length} 个落在象限外（首例 ${wrong[0].x.toFixed(0)},${wrong[0].z.toFixed(0)}）`);

    // 3. 不在水下。
    asserts++;
    const wet = pts.filter((p) => p.y < WATER_LEVEL + 0.6);
    if (wet.length) probs.push(`${kind} 有 ${wet.length} 个在水里`);

    // 4. 离路**落在区间内**。下限是别压路；上限是"玩家看得见"——
    //    这条是踩过坑才有的：最初没有上限，候选从象限角落开始贪心填，
    //    结果竹子全落在离路 460m 处，而雾距上限才 400m，一辈子看不见。
    asserts++;
    const offRoad = pts.filter((p) => {
      const d = distToRoad(p.x, p.z);
      return d < sp.road[0] || d > sp.road[1];
    });
    if (offRoad.length) probs.push(`${kind} 有 ${offRoad.length} 个离路不在 ${sp.road[0]}~${sp.road[1]}m 内`);

    // 5. 不骑在驿站上。
    asserts++;
    const onStation = pts.filter((p) => STATIONS.some((s) => Math.hypot(p.x - s.mapX, p.z - s.mapZ) < ROAD.STATION_OFFSET));
    if (onStation.length) probs.push(`${kind} 有 ${onStation.length} 个压在驿站 keepout 里`);

    // 6. 不在陡坡上（建筑一半悬空）。
    asserts++;
    const steep = pts.filter((p) => {
      const h = terrain.getHeightAt(p.x, p.z);
      return Math.max(Math.abs(terrain.getHeightAt(p.x + 6, p.z) - h), Math.abs(terrain.getHeightAt(p.x, p.z + 6) - h)) / 6 > 0.35;
    });
    if (steep.length) probs.push(`${kind} 有 ${steep.length} 个在陡坡上`);
  }

  // 7. 两样东西**不能同象限**：竹在西北、建筑在东南，
  //    放到一起就分不出"哪边是开发区"了。这条只需验一次。
  asserts++;
  const modInNW = all.mod_tower.filter((p) => p.x < 0 && p.z < 0).length + all.mod_house.filter((p) => p.x < 0 && p.z < 0).length;
  const bamInSE = all.bamboo.filter((p) => p.x > 0 && p.z > 0).length;
  if (modInNW > 0) probs.push(`${modInNW} 栋现代建筑落到了西北`);
  asserts++;
  if (bamInSE > 0) probs.push(`${bamInSE} 丛竹落到了东南`);

  const sum = kinds.map((k) => `${k}×${all[k].length}`).join(' ');
  return expect(probs.length === 0, probs.length ? probs.join('；') : sum, asserts);
});

// ---------------------------------------------------------------- 视角 / 载具
/**
 * 视角与载具：**切换绝不能影响移动**。
 *
 * 这是用户明确提的一条硬要求：「切换视角不影响移动操作」。
 * 它之所以要钉住，是因为这两件事**在代码上很容易互相污染**：
 * 视角和载具都读 `heading` / `_fwd`，顺手改一个，
 * 玩家的反应是「我按了 V 车突然往旁边走了」——而画面上完全看不出原因。
 *
 * 另外钉住自行车那三个数不许被改：那是源项目 `RIDE` 的手感，
 * 改它等于改原作。滑板可以有自己的一套，自行车不能。
 */
check('verify_controls', () => {
  let asserts = 0;
  const probs: string[] = [];

  // 1. 默认机位必须是**向前**那个（用户要求：斜的视角有人不习惯）
  asserts++;
  if (CAM_MODES[0] !== 'forward') probs.push(`默认机位是 ${CAM_MODES[0]}，应为 forward`);

  // 2. 三种机位都在，且没有重复
  asserts++;
  if (CAM_MODES.length !== 3) probs.push(`机位有 ${CAM_MODES.length} 种，应为 3`);
  asserts++;
  if (new Set(CAM_MODES).size !== CAM_MODES.length) probs.push('机位列表里有重复');

  // 3. 「向前」那个机位的**横向偏移必须是 0** —— 那正是"斜"的来源。
  //    写成 0.01 看着没区别，但玩家看得出地平线歪。
  asserts++;
  const cf = camParams('forward');
  if (Math.abs(cf.side) > 1e-9) probs.push(`forward 机位的横向偏移是 ${cf.side}，应为 0（那正是"斜"）`);

  // 4. 自行车那三个数必须**一字不改**地等于源项目的 RIDE
  asserts++;
  const bt = MODE_TUNE.bike;
  if (bt.maxSpeed !== RIDE.MAX_SPEED) probs.push(`自行车极速 ${bt.maxSpeed} ≠ 源项目 ${RIDE.MAX_SPEED}`);
  asserts++;
  if (bt.accel !== RIDE.ACCEL) probs.push(`自行车加速度 ${bt.accel} ≠ 源项目 ${RIDE.ACCEL}`);
  asserts++;
  if (bt.turn !== RIDE.TURN_SPEED) probs.push(`自行车转向率 ${bt.turn} ≠ 源项目 ${RIDE.TURN_SPEED}`);

  // 5. 滑板必须**真的不一样**，否则"切换载具"只是换了个模型
  asserts++;
  const st = MODE_TUNE.skate;
  if (st.maxSpeed === bt.maxSpeed && st.accel === bt.accel && st.turn === bt.turn) {
    probs.push('滑板与自行车的运动参数完全相同，切换就只剩换模型');
  }

  // 5a. 摩托车也必须**真的不一样**。理由同上：它要是照抄自行车，
  //     「切到摩托车」就只是个换模型的空动作。
  asserts++;
  const mt = MODE_TUNE.motorcycle;
  if (mt.maxSpeed === bt.maxSpeed && mt.accel === bt.accel && mt.turn === bt.turn) {
    probs.push('摩托车与自行车的运动参数完全相同，切换就只剩换模型');
  }
  asserts++;
  if (!(mt.maxSpeed > bt.maxSpeed)) {
    probs.push(`摩托车极速 ${mt.maxSpeed} 不大于自行车 ${bt.maxSpeed}，读作"换了个更慢的车"`);
  }
  asserts++;
  if (!(mt.decel < bt.decel && mt.accel < bt.accel)) {
    probs.push(`摩托车 加/减速度 ${mt.accel}/${mt.decel} 应都比自行车 ${bt.accel}/${bt.decel} 小（车更沉）`);
  }

  // 5b. **默认必须是徒步**（用户要求：起始没有载具，只有角色）。
  //     写错的表现很隐蔽：玩家一进世界已经在骑车，而他自己不知道。
  asserts++;
  if (RIDE_MODES[0] !== 'foot') probs.push(`默认模式是 ${RIDE_MODES[0]}，应为 foot（起始没有载具）`);
  asserts++;
  if (RIDE_MODES.length !== 4) probs.push(`模式有 ${RIDE_MODES.length} 种，应为 4（foot/bike/motorcycle/skate）`);

  // 5c. 缩放必须**算出来**，不能写死：模型是归一化到 1 单位的，
  //     换一批模型高度就变了，写死的数字会在下次换模型时悄悄失配。
  asserts++;
  {
    const g = new Object3D();
    g.add(new Mesh(new BoxGeometry(1, 1, 1)));
    const sc = autoScaleToHeight(g, 1.75);
    if (Math.abs(sc - 1.75) > 1e-6) probs.push(`autoScaleToHeight(1 单位高 → 1.75m) 得到 ${sc}`);
  }

  // 6. 没有滑板模型时不给切——而不是切过去发现是空的。
  //    **默认模式是 foot**，所以"切失败之后仍是原来那个"要验的是 foot。
  asserts++;
  const v = new Vehicle();
  v.attach({ bike: null, motorcycle: null, skate: null, char: null, clips: {} });
  if (v.canEnter('skate')) probs.push('没有滑板模型却报告"可以进"');
  asserts++;
  if (v.set('skate')) probs.push('没有滑板模型却切成功了');
  asserts++;
  if (v.id !== 'foot') probs.push(`切换失败之后模式却是 ${v.id}，应为 foot`);

  // 6b. 摩托车同理：**没模型就不给切**。3.4MB 的可选资产拉不到是常事，
  //     而"按 E 切到一个看不见的车"比"不切"糟得多。
  asserts++;
  if (v.canEnter('motorcycle')) probs.push('没有摩托车模型却报告"可以进"');
  asserts++;
  if (v.set('motorcycle')) probs.push('没有摩托车模型却切成功了');
  asserts++;
  if (v.id !== 'foot') probs.push(`摩托车切换失败之后模式却是 ${v.id}，应为 foot`);

  // 7. 有了滑板之后能进，而且进得去出得来
  asserts++;
  v.attach({ bike: new Object3D(), motorcycle: new Object3D(), skate: new Object3D(), char: new Object3D(), clips: {} });
  if (!v.canEnter('skate')) probs.push('有滑板模型却报告"不能进"');
  asserts++;
  if (v.id !== 'foot') probs.push('装上模型之后默认模式被改掉了');
  asserts++;
  if (!v.set('skate')) probs.push('有滑板模型却切不过去');
  asserts++;
  if (v.id !== 'skate') probs.push(`切过去之后 id 是 ${v.id}`);
  asserts++;
  if (!v.set('bike')) probs.push('切回自行车失败');
  asserts++;
  if (v.id !== 'bike') probs.push('切回自行车之后 id 不对');
  asserts++;
  if (!v.set('foot')) probs.push('切回徒步失败');
  asserts++;
  if (v.id !== 'foot') probs.push('切回徒步之后 id 不对');

  // 7b. 摩托车必须**进得去也出得来**，而且 cycle() 能转到它。
  //     `cycle` 是 `E` 键走的路：它只认 `canEnter`，
  //     所以"模型在但轮不到"是真实可能（枚举顺序写错就会这样）。
  asserts++;
  if (!v.canEnter('motorcycle')) probs.push('有摩托车模型却报告"不能进"');
  asserts++;
  if (!v.set('motorcycle')) probs.push('有摩托车模型却切不过去');
  asserts++;
  if (v.id !== 'motorcycle') probs.push(`切过去之后 id 是 ${v.id}，应为 motorcycle`);
  asserts++;
  if (!v.set('foot')) probs.push('从摩托车切回徒步失败');
  asserts++;
  if (v.id !== 'foot') probs.push(`从摩托车切回徒步之后 id 是 ${v.id}`);
  asserts++;
  {
    // cycle() 从 foot 出发必须能走到 motorcycle：走一圈看它落在哪
    const seen = new Set<RideMode>([v.id]);
    for (let i = 0; i < RIDE_MODES.length; i++) {
      const n = v.cycle();
      if (!n) break;
      seen.add(n);
    }
    if (!seen.has('motorcycle')) probs.push(`cycle() 转了一圈没经过 motorcycle（经过：${[...seen].join('/')}）`);
    // 转完一圈必须回到起点，否则 E 键按几次之后就困在某个模式里了
    asserts++;
    if (v.id !== 'foot') probs.push(`cycle() 转了一圈之后停在 ${v.id}，应回到 foot`);
  }

  // 7c. 摩托车模式下**外加的角色必须藏起来**。
  //     这个模型把骑手和车焊死了（Tripo 导出，0 骨骼 0 动画），
  //     不藏的话画面上是两个骑手叠在一起。
  asserts++;
  {
    const vc = new Vehicle();
    const char = new Object3D();
    char.name = 'char';
    vc.attach({ bike: new Object3D(), motorcycle: new Object3D(), skate: new Object3D(), char, clips: {} });
    vc.set('motorcycle');
    asserts++;
    if (char.visible) probs.push('摩托车模式下角色仍然可见，会与模型自带的骑手重叠');
    vc.set('foot');
    asserts++;
    if (!char.visible) probs.push('切回徒步之后角色仍然不可见，人不见了');
  }

  const summary =
    `模式 ${RIDE_MODES.join('/')}（默认 ${RIDE_MODES[0]}）· 机位 ${CAM_MODES.join('/')}（默认 ${CAM_MODES[0]}）· ` +
    `自行车 ${bt.maxSpeed}m/s 保持源项目 · 摩托车 ${mt.maxSpeed}m/s · 滑板 ${st.maxSpeed}m/s`;
  return expect(probs.length === 0, probs.length ? probs.join('；') : summary, asserts);
});

/**
 * 徒步动画：**停住不播，移动才播，且朝向跟着走的方向**。
 *
 * ## 为什么必须单独一条，而不是并进 verify_controls
 *
 * 这两条都是**用户明确提的要求**，而原来那条断言里没有它们——
 * 更要命的是，它们的失效**在所有其它断言里都是绿的**：
 * 参数对、路对、经济对，只有"人站在原地抖腿"。
 *
 * ## 判据怎么量
 *
 * `update` 收的是 `(dt, speed, heading)`，而动画权重由速度驱动。
 * 所以直接喂它几段速度，看 `footBlend` 的权重：
 *
 * · `speed = 0` 跑 2 秒 → walk/run 权重都必须是 **0**（待机不播）
 * · `speed = 1.2`（走路）→ walk 权重应显著高于 run
 * · `speed = 5`（跑步）→ run 权重应显著高于 walk
 * · 回到 0 再跑 2 秒 → 权重必须**重新归零**（不是只降下来就停住）
 *
 * 朝向那条量 `char.rotation.y`：它必须等于 heading，
 * 而**不能**是旧的 `heading + π/2`（那是"侧对路肩"的老行为）。
 */
check('verify_foot_anim', () => {
  let asserts = 0;
  const probs: string[] = [];

  const char = new Object3D();
  // ★ 断言 1a/1b/1c 问的是「处理之后的片段」，所以这里必须给一副**真的骨架**
  // 和**真的轨道**。用空 Object3D + 空轨的 clip 的话：
  //   · `restPoseOf()` 量不到任何骨 ⇒ `bindMissingBones()` 无从补
  //   · 根骨轨道根本不存在 ⇒ 「根骨还有没有水平位移」这一条永远绿
  // 那样的断言不测任何东西。
  //
  // ★★ 骨名必须是 **three 清洗之后**的 `mixamorigHips`（**没有冒号**）。
  //   这一条本身就是这个 bug 的墓碑：原来的 fixture 写的是 `mixamorig:Hips`，
  //   正好命中旧实现的正则 `/(^|:)hips$/`——而真实素材里 three 的
  //   `GLTFLoader` 会把 `:` **删掉**，轨道名是 `mixamorigHips.position`，
  //   那条正则**一条都匹配不上**。
  //   于是：实现对真素材是失效的，判据对假名字是绿的，两边一起绿了整整一轮。
  //   判据量自己造的数据时，必须确认那个数据**和素材一模一样**。
  const BONES = [
    'mixamorigHips',
    'mixamorigSpine',
    'mixamorigLeftFoot',
    'mixamorigRightFoot',
    'mixamorigLeftToeBase',
    'mixamorigRightToeBase',
  ];
  // ★ 另加一根**零子树的顶骨**，和真模型里的 `neutral_bone` 一样。
  //   它是「按名字猜根骨」会踩的坑：谁要是把 `rootBoneName()` 退化成
  //   「第一根顶骨」，在这里就会选中它 —— 于是根位移根本没被剥掉，
  //   而这一条断言**会红**。
  const decoy = new Bone();
  decoy.name = 'neutral_bone';
  char.add(decoy);
  for (const b of BONES) {
    const bone = new Bone();
    bone.name = b;
    char.add(bone);
  }

  const times = new Float32Array([0, 0.5, 1]);
  /** 一条位置轨道；`drift` 是水平方向的根位移（要断言它被抹成 0）。 */
  const posTrack = (bone: string, drift: number, y: number) =>
    new KeyframeTrack(
      `${bone}.position`,
      times,
      Float32Array.from([0, y, drift, 0, y, drift, 0, y, drift]),
    );
  /** 一条四元数轨道。三个轴一起转，用来凑满「每根骨都有归属」。 */
  const quatTrack = (bone: string) => {
    const n = times.length;
    const v = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) v.set([0, 0, 0, 1], i * 4);
    return new KeyframeTrack(`${bone}.quaternion`, times, v);
  };
  /**
   * 移动三段：覆盖全部 6 根骨（含脚与分趾），并且带根位移。
   *
   * ★ 根位移**沿 +Z 且单调递增**，和真素材一样（`survivor.glb` 的 `walk` /
   *   `run` / `骑自行车` 三段都是一条 z 单调上升的斜坡）。
   *   写成「位移在 x 上」的话，「根骨是不是找对了」这条就没法用步速交叉验证。
   *   `drift` 也就是**这一段自带的步速**（位移 ÷ 时长），
   *   播放倍率那条断言直接拿它当基准。
   *
   * ★ `y` 是骨盆高度、**`bob` 是它的上下起伏**，两者分开给：
   *   起伏留着才有走的感觉（x/z 必须清零、y 必须留着，是一对），
   *   而骨盆高度是骑行站位的输入（站位 = 鞍面 − 骨盆高度）。
   *   `骑自行车` 段取 `bob = 0`：`pelvisHeightOf` 取的是**均值**，
   *   给它一个带起伏的值，断言就得写 `y + 2/3·bob` 这种没法读的数。
   */
  const hipsTrack = (drift: number, y: number, bob: number) => {
    const v: number[] = [];
    for (let i = 0; i < times.length; i++) {
      v.push(0, y + (i % 2 === 0 ? bob : 0), drift * (i / (times.length - 1)));
    }
    return new KeyframeTrack('mixamorigHips.position', times, Float32Array.from(v));
  };
  const fullClip = (name: string, dur: number, drift: number, y: number, bob: number) =>
    new AnimationClip(name, dur, [
      hipsTrack(drift, y, bob),
      ...BONES.slice(1).map((b) => quatTrack(b)),
    ]);
  /** 待机：按合片后的真实情况——**只覆盖 4 根，脚与分趾骨没有轨道**。 */
  const idleClip = () =>
    new AnimationClip('idle', 2, [
      posTrack('mixamorigHips', 0, 0.5224),
      quatTrack('mixamorigSpine'),
      quatTrack('mixamorigLeftFoot'),
      quatTrack('mixamorigRightFoot'),
    ]);

  const v = new Vehicle();
  v.attach({
    bike: new Object3D(),
    motorcycle: new Object3D(),
    skate: new Object3D(),
    char,
    // 用**真的 clip 名**，因为 collectClips 是按名字挑的。
    // `idle` 这一段是这一版人物模型才有的（`survivor_rigged_v2_fullanim.glb`
    // 共 9 段：run · walk · 骑自行车 · clap · surf · dig · jump · idle · wait）。
    clips: collectClips([
      // 位移 / 时长 = 0.7 / 0.7 = 1.0 m/s、1.5 / 1.0 = 1.5 m/s、2.0 / 1.0 = 2.0 m/s
      // ——刻意取成三个**互不相同**的步速，好让下面「播放倍率对不对」能分辨
      // 「倍率算的是这一段自己的步速」还是「三条轨共用一个数」。
      // 骨盆高度取自真素材实测（walk 0.512 / 骑 0.504），`bob` 是它的起伏。
      fullClip('run', 0.7, 0.7, 0.4616, 0.017),
      fullClip('walk', 1.0, 1.5, 0.512, 0.011),
      fullClip('骑自行车', 1.0, 2.0, 0.504, 0),
      idleClip(),
    ]),
  });
  v.set('foot');

  const run = (speed: number, seconds: number, heading = 0) => {
    const frames = Math.round(seconds * 60);
    for (let i = 0; i < frames; i++) v.update(1 / 60, speed, heading);
  };

  // 1. 待机：**移动轨一帧都不许播，而且必须有东西接住**。
  //    这是用户提的第一条要求，原来的实现是切过去就在原地跑步。
  //
  //    而「有东西接住」这半句是这一版才加的：上一版人物只有 3 段动画，
  //    两条移动轨归零之后露出来的是 **bind pose**——张开双臂的站姿，
  //    而那是游戏的第一帧。现在模型有 `idle`，站定时它必须接过权重。
  asserts++;
  run(0, 2);
  {
    const b = v.footBlend;
    if (b.walk > 1e-6 || b.run > 1e-6) {
      probs.push(`站着不动 2 秒后动画权重仍是 walk=${b.walk.toFixed(4)} run=${b.run.toFixed(4)}，应为 0`);
    }
  }
  asserts++;
  if (v.footIdleWeight < 0.99) {
    probs.push(
      `站定时 idle 权重是 ${v.footIdleWeight.toFixed(3)}，应为 1 —— 没有它就露出 bind pose（张开双臂）`,
    );
  }

  // 1a. ★ **权重和必须恒为 1** —— 权重和不足 1 时，mixer 漏出来的那一份
  //     就是 **bind pose**（张开双臂），所以"权重和 = 1"是这一族故障的
  //     通用不变量。做法：待机权重 = `1 − walk − run`，**算出来而不是渐出来**。
  //
  // ⚠ **这条断言目前没有成功的红proof**。我试过把待机改回"阻尼渐入"，
  //   它**照样绿**——因为 walk/run 与 idle 用同一个时间常数、目标互补，
  //   指数上恰好抵消，和恒为 1。所以它防的是"将来有人改了阻尼常数或
  //   改了目标而不自知"，**不是**已知某个具体成因的复现。
  //   「松开方向键出现 T 字」的真正成因**尚未定位**。
  asserts++;
  {
    let worst = 0;
    let at = 0;
    for (let step = 0; step < 180; step++) {
      // 走 → 停 的过渡最容易漏：两条轨正在归零，待机正在接管
      const sp = step < 90 ? 1.6 : 0;
      v.update(1 / 60, sp, 0);
      const sum = v.footBlend.walk + v.footBlend.run + v.footIdleWeight;
      const dev = Math.abs(sum - 1);
      if (dev > worst) {
        worst = dev;
        at = step;
      }
    }
    if (worst > 1e-6) {
      probs.push(`走→停过渡中权重和偏离 1 达 ${worst.toExponential(1)}（第 ${at} 帧）—— 漏出来的那份是 bind pose`);
    }
  }

  // 1b. ★ **动画必须在原地播**：根骨的水平位移必须是 0。
  //
  // `walk` / `run` / `骑自行车` 都带根位移（实测 1.49 / 2.91 / 5.22 m），
  // 不抹掉的话，动画把人往前拖、车把人往后拽，停下的那一刻根节点弹回原位
  // —— 玩家看到的就是**「停止走动的时候人就回来一段距离」**。
  //
  // ★ 这里**问真代码算出来的根骨名**（`rootBoneName(char)`），
  //   不再自己写一条正则。原来的判据里那条 `/(^|:)hips$/i` 与旧实现是
  //   同一个表达式——「判据和实现认同一个错东西」时，两边一起绿。
  asserts++;
  {
    const rootName = rootBoneName(char);
    if (rootName !== 'mixamorigHips') {
      probs.push(`根骨认成了 "${rootName}"，应为 mixamorigHips —— 认错根骨就等于没剥根位移`);
    }
    const clips = v.rideClips;
    for (const [name, clip] of [
      ['walk', clips.walk],
      ['run', clips.run],
      ['ride', clips.ride],
      ['idle', clips.idle],
    ] as [string, AnimationClip | undefined][]) {
      if (!clip) {
        probs.push(`缺 ${name} 片段`);
        continue;
      }
      const rootTrack = rootTrackOf(clip, rootName);
      if (!rootTrack) {
        probs.push(`${name} 里找不到根骨的 position 轨道`);
        continue;
      }
      let maxX = 0;
      let maxZ = 0;
      for (let i = 0; i < rootTrack.values.length; i += 3) {
        maxX = Math.max(maxX, Math.abs(rootTrack.values[i]));
        maxZ = Math.max(maxZ, Math.abs(rootTrack.values[i + 2]));
      }
      if (maxX > 1e-6 || maxZ > 1e-6) {
        probs.push(`${name} 的根骨仍有水平位移（x ${maxX.toFixed(3)} / z ${maxZ.toFixed(3)}），动画会拖着人走`);
      }
    }
  }

  // 1b-2. ★ **根骨的 Y 必须留着** —— 那是走路的上下起伏。
  //
  // 与 1b 是一对：只清 x/z 是对的，把 y 一起清成人就变成一块板。
  // 这里量「处理后」的 y 跨度必须仍然是**非零的**，而夹具给的是 ±0.03 的 bob。
  asserts++;
  {
    const tr = rootTrackOf(v.rideClips.walk!, rootBoneName(char));
    let minY = Infinity;
    let maxY = -Infinity;
    if (tr) {
      for (let i = 1; i < tr.values.length; i += 3) {
        minY = Math.min(minY, tr.values[i]);
        maxY = Math.max(maxY, tr.values[i]);
      }
    }
    if (!(maxY - minY > 1e-3)) {
      probs.push(`walk 根骨的 y 起伏只有 ${(maxY - minY).toExponential(1)}，走路会没有起伏（y 被一起清掉了）`);
    }
  }

  // 1b-3. ★ **播放倍率必须按「这一段自己的步速」算**
  //
  // 这是「走和跑分不出来」的另一半：根位移剥掉之后，地面位移由玩家决定，
  // 而动画仍按 1× 播 —— 地面 6 m/s 而 `walk` 自带步速只有 0.64 m/s，
  // 脚就在地上滑行。倍率 = 当前速度 ÷ 该段步速。
  //
  // ★ 量的是 **Vehicle 自己存下来的那一份步速**，不是「读处理后的片段重算」：
  //   剥离之后水平位移已清零，重算必然得 0，于是「步速在剥离之前量」
  //   这条会永远绿 —— 而它正是这一族 bug 的根。
  //   夹具步速：walk 1.5/1.0 = 1.5、run 0.7/0.7 = 1.0、ride 2.0/1.0 = 2.0 m/s。
  asserts++;
  {
    const speeds = v.clipCadenceSpeeds;
    if (!(Math.abs(speeds.walk - 1.5) < 1e-3)) {
      probs.push(`walk 记下的自带步速是 ${speeds.walk.toFixed(3)} m/s，应为 1.50（量到 0 = 在剥离之后量的）`);
    }
    if (!(Math.abs(speeds.run - 1.0) < 1e-3)) {
      probs.push(`run 记下的自带步速是 ${speeds.run.toFixed(3)} m/s，应为 1.00`);
    }
    if (!(Math.abs(speeds.ride - 2.0) < 1e-3)) {
      probs.push(`骑行动画记下的自带步速是 ${speeds.ride.toFixed(3)} m/s，应为 2.00`);
    }
    // 三条轨的倍率在同一个速度下必须**互不相同**——
    // 「三条轨共用一个倍率」的写法会让这一条红。
    const at = (s: number) => [speeds.walk, speeds.run, speeds.ride].map((n) => cadenceScale(s, n));
    const w1 = at(1.2);
    if (!(w1[0] > 0.7 && w1[0] < 0.9)) {
      probs.push(`1.2 m/s 时 walk 倍率 ${w1[0].toFixed(3)}，1.2 ÷ 1.5 应约 0.80`);
    }
    if (!(w1[1] > 1.1 && w1[1] < 1.3)) {
      probs.push(`1.2 m/s 时 run 倍率 ${w1[1].toFixed(3)}，1.2 ÷ 1.0 应约 1.20（三条轨共用一个数就会错）`);
    }
    if (!(w1[2] > 0.5 && w1[2] < 0.7)) {
      probs.push(`1.2 m/s 时骑行动画倍率 ${w1[2].toFixed(3)}，1.2 ÷ 2.0 应约 0.60`);
    }
    // 上限：再快腿就是一片糊，而 6 m/s 本来已经是冲刺。
    if (cadenceScale(60, 1) > 2.5) {
      probs.push(`60 m/s 时倍率 ${cadenceScale(60, 1).toFixed(2)}，没有上限，腿会糊成一片`);
    }
    // 车停住时骑行那条必须 0：人定在踩到一半的姿势上，而不是原地空踩。
    if (cadenceScale(0, 2.0) !== 0) {
      probs.push(`车停住时骑行动画倍率是 ${cadenceScale(0, 2.0)}，应为 0`);
    }
  }

  // 1b-4. ★ **骨盆高度必须量得出来**（骑行站位的前提）
  //
  // 站位 = 鞍面 − 骨盆高度。少了骨盆高度就只能写死一个数，
  // 而写死的数与这台车、与这份动画都对不上——症状是「人不在自行车上」。
  // 夹具 ride 段取 `bob = 0`、骨盆 0.504（= 真素材实测值），所以就是 0.504。
  asserts++;
  if (!(Math.abs(v.pelvisHeight - 0.504) < 1e-4)) {
    probs.push(`骑手骨盆高度量到 ${v.pelvisHeight.toFixed(4)}，应为 0.504（站位靠它相减）`);
  }

  // 1c. ★ **idle 必须覆盖每一根骨**（含脚 / 分趾骨）。
  //
  // 合片时新片段只覆盖它自己有的 65 根（实测 195 条通道，而原有三段是 258 = 86 根），
  // 剩下 21 根没有任何轨道。`bindMissingBones()` 给它们补常量轨道，
  // 于是 idle 从此「每根骨都有归属」，权重和不足 1 时也没有脚可漏。
  asserts++;
  {
    const idle = v.rideClips.idle;
    if (idle) {
      const bound = new Set(idle.tracks.map((t) => t.name.split('.')[0]));
      const feet = ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'];
      const missing = feet.filter((f) => ![...bound].some((b) => b.endsWith(f)));
      if (missing.length) {
        probs.push(`idle 没有绑定脚部骨骼：${missing.join('、')}`);
      }
    }
  }

  // 2. 走路：walk 权重应明显高于 run
  asserts++;
  run(1.2, 3);
  {
    const b = v.footBlend;
    if (!(b.walk > 0.8 && b.run < 0.2)) {
      probs.push(`以 1.2 m/s 走 3 秒后权重 walk=${b.walk.toFixed(3)} run=${b.run.toFixed(3)}，应以走为主`);
    }
  }

  // 3. 跑步：run 权重应明显高于 walk
  asserts++;
  run(5, 3);
  {
    const b = v.footBlend;
    if (!(b.run > 0.8 && b.walk < 0.2)) {
      probs.push(`以 5 m/s 跑 3 秒后权重 walk=${b.walk.toFixed(3)} run=${b.run.toFixed(3)}，应以跑为主`);
    }
  }

  // 4. **停下之后权重必须重新归零**。
  //    只验第 1 条是不够的：切到徒步那一刻本来就是权重 0，
  //    而"跑过一段再停"这条路径能漏掉"权重卡在残值上不再下降"的实现。
  asserts++;
  run(0, 4);
  {
    const b = v.footBlend;
    if (b.walk > 1e-6 || b.run > 1e-6) {
      probs.push(`跑完停下 4 秒后权重仍是 walk=${b.walk.toFixed(4)} run=${b.run.toFixed(4)}，未归零`);
    }
  }

  // 5. ★ **世界**朝向：角色的正面必须指着前进方向。
  //
  // ## 为什么必须换成「世界朝向」，局部量看不见这个 bug
  //
  // 原来量的是 `char.rotation.y === heading + CHAR_FACING_YAW`，而实现写的
  // 正是 `heading + CHAR_FACING_YAW`——**判据和实现是同一个表达式**。
  // 于是一个更深的错误完全隐形：实机里 `Vehicle.group` 挂在
  // `ride.bikePivot` 下面，而 `bikePivot.rotation.y` **已经是 heading**，
  // 所以角色的世界朝向是 `2·heading + π`——**航向被算了两遍**。
  // 局部量恰好等于期望值，判据全绿；实机上 h=0 看不出任何异常，
  // 一转弯人却往反方向转、还转得是两倍。
  //
  // 现在把 `group` 挂进一个**带航向的父节点**（复现真实场景图），
  // 再量角色的**世界**正面（模型正面朝 +Z）是否等于前进方向
  // `(−sin h, 0, −cos h)`。这一条对「航向算两遍」是**真红**。
  asserts++;
  const pivot = new Group();
  pivot.add(v.group);
  const worldFacing = new Vector3();
  const quat = new Quaternion();
  const charFwd = (h: number) => {
    pivot.rotation.y = h;
    char.updateWorldMatrix(true, true);
    char.getWorldQuaternion(quat);
    return worldFacing.set(0, 0, 1).applyQuaternion(quat); // 人物模型正面
  };
  for (const h of [0, 0.7, -1.3, 2.4, Math.PI]) {
    run(1.5, 0.5, h);
    const f = charFwd(h);
    // 期望：世界正面 = 本作的前进方向 (−sin h, 0, −cos h)
    const want = new Vector3(-Math.sin(h), 0, -Math.cos(h));
    const diff = Math.acos(Math.min(1, Math.max(-1, f.dot(want))));
    if (diff > 1e-4) {
      probs.push(
        `heading=${h.toFixed(2)} 时角色世界朝向差 ${((diff * 180) / Math.PI).toFixed(1)}°` +
          `（局部 ${char.rotation.y.toFixed(3)}，父节点已带 heading —— 两者相加才是世界朝向）`,
      );
    }
  }

  // 6. 滑板同理（同一个 bug 的另一半），而且它是**唯一**会在实机上
  //    一眼看出「航向算两遍」的模式：滑板没有车挡着，板的朝向与人一起翻。
  asserts++;
  v.set('skate');
  for (const h of [0.5, -0.9, 2.0]) {
    run(2, 0.3, h);
    const f = charFwd(h);
    const want = new Vector3(-Math.sin(h), 0, -Math.cos(h));
    const diff = Math.acos(Math.min(1, Math.max(-1, f.dot(want))));
    if (diff > 1e-4) {
      probs.push(`滑板 heading=${h.toFixed(2)} 时角色世界朝向差 ${((diff * 180) / Math.PI).toFixed(1)}°`);
    }
  }
  v.set('foot');

  run(1.2, 3);
  const walkMoving = v.footBlend.walk;
  // 存一份**站定**时的实测值给 detail 用。**不能现读**：
  // 上面第 2~4 条会把人跑起来，那时 idle 合法地是 0，
  // 现读出来的数字会写成 "idle=0.00" —— 一句和它所在那一刻的真实状态
  // 不符的话，下一个读的人会以为待机没接上。
  run(0, 2);
  const idleStanding = v.footIdleWeight;

  const summary = `站定 walk/run=0 且 idle=${idleStanding.toFixed(2)} · 走 walk ${walkMoving.toFixed(2)} · 世界朝向 = 前进方向（父节点已带航向，局部只补 π）`;
  return expect(probs.length === 0, probs.length ? probs.join('；') : summary, asserts);
});

// ---------------------------------------------------------------- 滑板姿势
/**
 * 滑板姿势 = `run` 里**双脚张得最开的那一帧**，定格。
 *
 * ## 为什么必须单独一条
 *
 * 原来的滑板模式走的是徒步那条分支：站上板之后按速度混合 `walk` / `run`，
 * 而板的最大速度是 17 m/s（`MODE_TUNE.skate`）——一上板就是满速 `run`，
 * 于是**人站在板上原地跑步**。速度、轮子转角、站位、面数全部正常，
 * 画面上只是「姿势不对」，没有一条既有断言会红。
 *
 * 改成定格姿势之后，这一族里又冒出四个更安静的坑，各钉一条：
 *
 * | 坑 | 症状 | 断言 |
 * |---|---|---|
 * | 取的不是最宽那一帧 | 站姿「有点开」但说不清差在哪 | 1（对着**解析解**验）· 3（240 点密扫验「就是全局最大」） |
 * | 量的是**横向**那一维 | 跑步时两脚各在自己那侧，横向间距几乎是常数，取最大等于随便取一帧 | 2（钉住「横向退化」这个前提） |
 * | 定格片段把骨写成 0 | **滑板上没人** | 4（逐骨复现 `run`，且 t=0 与 t=0.999 完全一致） |
 * | 定格姿势带着根位移 | 人站在板上自己往前平移（板在动，看不出来） | 4b |
 * | 姿势定格了，脚却浮在板上面 | 人踩空气 | 5 / 8（站高 = 板面 − 实测落差） |
 * | 姿势轨被按速度的混合稀释 | 人有点抖，权重不足 1 时漏出来的是张开双臂 | 6 / 7 |
 *
 * ## 夹具为什么自带**解析解**
 *
 * 骨架只有 `hips → UpLeg → Foot(+ToeBase)`。左脚在**前后**方向上一条三角波，
 * 右脚固定在 0（支撑腿），键 9（t = 9/30 = 0.3）处到顶 0.25。
 * 判据量的是**水平面**距离，所以：
 *
 * ```
 * span(t) = hypot(横向 0.18, 前后 z(t))，峰值在 t = 0.3
 * span_max = hypot(0.18, 0.25) = 0.308220
 * ```
 *
 * ★ **横向那一维不能忘**：两根踝骨的 x 差恒为 0.18，而判据量的是水平面
 *   距离（`hypot`），所以峰值是 0.308 而不是 0.25。第一版夹具漏了它，
 *   解析解差 8%，判据红——而红的正是**夹具**，不是实现。
 *
 * ★ 峰值为什么放在**关键帧上**（而不是两帧之间）：glTF 的位置轨道是
 *   **分段线性**的，而**分段线性函数的极大值必在折点上**。所以
 *   「最宽的那一帧」本来就是关键帧，实现里不该有段内搜索；
 *   第 3 条改为「拿 240 点密扫整个片段，量到的最大值必须就是它」——
 *   那是**性质**，不是实现细节，换一种搜索策略也照样绿。
 *
 * ★ 三角波（而不是正弦）是为了峰值**唯一**：`|sin|` 一个周期里有两个
 *   等高极大，「最宽的那一帧」变成二选一，判据没法钉。
 *
 * 夹具用 31 帧 / 1.0 s，与真素材 `run`（31 帧 / 1.25 s）同一套帧结构。
 */
check('verify_skate_stance', () => {
  let asserts = 0;
  const probs: string[] = [];
  const notes: string[] = [];

  // ---- 夹具骨架。骨名必须是 **three 清洗之后**的名字（没有冒号），
  //      理由与 verify_foot_anim 里那条墓碑一样：写成 `mixamorig:LeftFoot`
  //      的话量到的是「一根都不存在」，而判据还是绿的。
  const char = new Object3D();
  const bone = (name: string, parent: Object3D, x: number, y: number, z: number): Bone => {
    const b = new Bone();
    b.name = name;
    b.position.set(x, y, z);
    parent.add(b);
    return b;
  };
  const hips = bone('mixamorigHips', char, 0, 0, 0);
  const LF = bone('mixamorigLeftFoot', bone('mixamorigLeftUpLeg', hips, 0, -0.02, -0.05), 0.09, -0.42, 0);
  const RF = bone('mixamorigRightFoot', bone('mixamorigRightUpLeg', hips, 0, -0.02, -0.05), -0.09, -0.42, 0);
  bone('mixamorigLeftToeBase', LF, 0, -0.02, 0.03);
  bone('mixamorigRightToeBase', RF, 0, -0.02, 0.03);

  const N = 30;
  const times = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) times[i] = i / N;
  const pos = (name: string, fn: (i: number) => [number, number, number]) => {
    const v: number[] = [];
    for (let i = 0; i <= N; i++) v.push(...fn(i));
    return new KeyframeTrack(`${name}.position`, times, Float32Array.from(v));
  };
  /** 摆幅。三角波在键 9 顶到 0.25，键 18 之后回 0。 */
  const SWING = 0.25;
  /** 三角波：0 → 0.25（键 9）→ 0（键 18）→ 0。**峰值唯一**。 */
  const swingZ = (i: number): number => (i >= 18 ? 0 : (Math.min(i, 18 - i) / 9) * SWING);
  /** 跑动：骨盆固定在 0.5 高、**带 1 m/s 的根位移**（真素材三段都带）。
   *  左腿前后摆、右腿固定当支撑——见文件头。 */
  const runClip = new AnimationClip('run', 1, [
    pos('mixamorigHips', (i) => [0, 0.5, i / N]),
    pos('mixamorigLeftFoot', (i) => [0.09, -0.42, swingZ(i)]),
    pos('mixamorigRightFoot', () => [-0.09, -0.42, 0]),
    pos('mixamorigLeftToeBase', () => [0, -0.02, 0.03]),
    pos('mixamorigRightToeBase', () => [0, -0.02, 0.03]),
  ]);
  /** 站平：骨盆 0.48，两脚并拢。最低脚点 = 0.48 − 0.02 − 0.42 − 0.02 = 0.02。 */
  const standClip = new AnimationClip('idle', 1, [
    pos('mixamorigHips', () => [0, 0.48, 0]),
    pos('mixamorigLeftFoot', () => [0.09, -0.42, 0]),
    pos('mixamorigRightFoot', () => [-0.09, -0.42, 0]),
    pos('mixamorigLeftToeBase', () => [0, -0.02, 0.03]),
    pos('mixamorigRightToeBase', () => [0, -0.02, 0.03]),
  ]);
  const WANT_T = 9 / N;
  /** 判据量的是**水平面**距离，所以横向那个恒定的 0.18 必须在里面。 */
  const WANT_SPAN = Math.hypot(0.18, SWING);
  const L = 'mixamorigLeftFoot';
  const R = 'mixamorigRightFoot';

  const pose = stancePoseOf(char, runClip, standClip);
  asserts++;
  if (!pose) {
    probs.push('stancePoseOf 返回 null —— 骨架里有左右踝骨，它不该返回 null');
    return expect(false, probs.join('；'), asserts);
  }

  // 1. 取的就是**最宽那一帧**：对着解析解 `t = 9/30` 验，容差 3ms。
  //    这一帧的三角波到顶 0.25，而前后 0.25 是唯一的，所以容差取宽一点
  //    也只会放过「差一格」的实现（相邻格是 0.2222 与 0.1944）。
  asserts++;
  if (Math.abs(pose.time - WANT_T) > 3e-3) {
    probs.push(`取到的时刻是 ${pose.time.toFixed(5)}s，应为 ${WANT_T.toFixed(5)}s（三角波顶点，键 9）`);
  }
  asserts++;
  if (Math.abs(pose.span - WANT_SPAN) > 2e-3) {
    probs.push(`张角是 ${pose.span.toFixed(5)}，解析解 hypot(0.18, 0.25) = ${WANT_SPAN.toFixed(5)}`);
  }

  // 2. ★ 横向那一维是**退化**的，所以判据只能量水平面。
  //    夹具里两条腿的横向间距恒为 0.18（一根常数）：谁把判据写成
  //    「按横向取最大」，取到的就是**第一个格点**，第 1 条立刻红。
  //    这条断言本身钉住「横向确实没有信息量」这个前提。
  asserts++;
  {
    const probe = new PoseSampler(char, runClip);
    const lateral = (t: number): number => {
      probe.seek(t);
      return Math.abs(boneWorld(probe, R).x - boneWorld(probe, L).x);
    };
    const base = lateral(0);
    let varies = 0;
    for (const t of keyTimesOf(runClip)) varies = Math.max(varies, Math.abs(lateral(t) - base));
    if (Math.abs(base - 0.18) > 1e-6 || varies > 1e-6) {
      probs.push(`夹具的横向间距不是常数（${base.toFixed(4)}，波动 ${varies.toExponential(1)}）—— 第 1 条就失去意义了`);
    }
  }

  // 3. ★ **性质**判据：它必须是**整个片段的最大值**。
  //    自己拿 240 点密扫一遍（不调 `stancePoseOf`，免得自己验自己）。
  //    这一条量的是「取的是最宽那一帧」这句话本身，
  //    所以换任何一种搜索策略（关键帧扫描 / 密扫 / 二分）都照样绿。
  asserts++;
  {
    const probe = new PoseSampler(char, runClip);
    let dense = -1;
    let denseT = 0;
    for (let k = 0; k <= 240; k++) {
      const t = (k / 240) * runClip.duration;
      probe.seek(t);
      const s = probe.span(L, R);
      if (s > dense) {
        dense = s;
        denseT = t;
      }
    }
    if (Math.abs(pose.span - dense) > 1e-6) {
      probs.push(
        `取到的张角 ${pose.span.toFixed(6)} 不是全片段最大（240 点密扫得 ${dense.toFixed(6)} @ ${denseT.toFixed(4)}s）`,
      );
    }
    notes.push(`密扫最大 ${dense.toFixed(6)} @ ${denseT.toFixed(4)}s`);
  }

  // 4. ★ 定格片段必须**逐骨复现** `run` 在那一刻的姿势。
  //    而它必须是**冻结**的：片段里写的是两个同值帧 + 离散插值，
  //    所以 mixer 自己夹取时（t=0.999）也必须是同一个姿势。
  asserts++;
  {
    const src = new PoseSampler(char, runClip);
    const still = new PoseSampler(char, pose.clip);
    src.seek(pose.time);
    still.seek(0);
    const first = FOOT_BONES.map((n) => boneWorld(still, n));
    still.seek(0.999);
    const late = FOOT_BONES.map((n) => boneWorld(still, n));
    let worstSame = 0;
    let worstSrc = 0;
    for (let i = 0; i < FOOT_BONES.length; i++) {
      worstSame = Math.max(worstSame, first[i].distanceTo(late[i]));
      worstSrc = Math.max(worstSrc, first[i].distanceTo(boneWorld(src, FOOT_BONES[i])));
    }
    if (worstSame > 1e-9) {
      probs.push(`定格片段在 t=0 与 t=0.999 的脚位差 ${worstSame.toExponential(1)} —— 它还在动`);
    }
    if (worstSrc > 1e-6) {
      probs.push(`定格片段的脚位与 run@${pose.time.toFixed(4)}s 差 ${worstSrc.toExponential(1)} —— 采样的不是那一帧`);
    }
  }

  // 5. ★ 落差是**量**出来的：跑姿最低脚点 0.04，站姿 0.02，差 0.02。
  asserts++;
  if (Math.abs(pose.rise - 0.02) > 1e-6) {
    probs.push(`落差是 ${pose.rise.toFixed(6)}，应为 0.02（跑姿 0.04 − 站姿 0.02）—— 站高算错人就浮在板上面`);
  }

  // 6. ★ 姿势轨：权重 1、冻结。权重不足 1 漏出来的是 bind pose（张开双臂）。
  const v = new Vehicle();
  v.attach({
    bike: null,
    motorcycle: null,
    skate: new Object3D(),
    char,
    clips: collectClips([runClip, standClip]),
  });
  if (!v.set('skate')) {
    asserts++;
    probs.push('切不进滑板模式');
    return expect(false, probs.join('；'), asserts);
  }
  asserts++;
  if (v.stanceWeight < 0.999) {
    probs.push(`滑板姿势轨权重 ${v.stanceWeight.toFixed(3)}，应为 1 —— 漏出来的那份是 bind pose（张开双臂）`);
  }
  asserts++;
  if (!v.stancePaused) {
    probs.push('滑板姿势轨没有冻结 —— 那还是一段动画，速度一变姿势就跟着变');
  }

  // 6b. ★ 剥离根位移**不改变张角**（两个脚一起被平移，差不变），
  //      所以 Vehicle 里量到的必须和上面直接量的同一个数。
  asserts++;
  {
    const s = v.stancePose;
    if (!s || Math.abs(s.span - pose.span) > 1e-6) {
      probs.push(`Vehicle 里量到的张角 ${s?.span.toFixed(5)} 与直接量的 ${pose.span.toFixed(5)} 不一致`);
    }
  }

  // 6c. ★ 定格姿势**不许带根位移**。夹具的 `run` 骨盆 z 走满 1.0m，
  //      而游戏里跑的是**剥离之后**的片段，所以这条查的是 `Vehicle` 的那一份
  //      （`prepareClips` 先 `stripRootMotion` 再定格）。
  //      带着的话人站在板上会自己往前平移——而板本来就在动，画面上看不出来。
  asserts++;
  {
    const s = v.stancePose;
    if (!s) {
      probs.push('Vehicle 里没有滑板姿势');
    } else {
      const still = new PoseSampler(char, s.clip);
      still.seek(0);
      const p = boneWorld(still, 'mixamorigHips');
      if (Math.abs(p.z) > 1e-6 || Math.abs(p.x) > 1e-6) {
        probs.push(`游戏用的定格姿势还带着根位移 (${p.x.toFixed(4)}, ${p.z.toFixed(4)}) —— 人会自己往前平移`);
      }
    }
  }

  // 7. ★ 姿势**不许被按速度的混合动过**，而且脚不许漂。
  //    原来的实现每帧按 17 m/s 调 `updateFootAnim`，`run` 权重拉满。
  asserts++;
  {
    for (let i = 0; i < 60; i++) v.update(1 / 60, MODE_TUNE.skate.maxSpeed, 0.7);
    const b = v.footBlend;
    if (b.walk > 1e-6 || b.run > 1e-6) {
      probs.push(`滑板模式下动画权重被按速度调动 walk=${b.walk.toFixed(4)} run=${b.run.toFixed(4)} —— 姿势会被冲掉`);
    }
  }
  asserts++;
  {
    const before = FOOT_BONES.map((n) => worldOf(char, n));
    for (let i = 0; i < 60; i++) v.update(1 / 60, MODE_TUNE.skate.maxSpeed, -0.3);
    const after = FOOT_BONES.map((n) => worldOf(char, n));
    let worst = 0;
    for (let i = 0; i < before.length; i++) worst = Math.max(worst, before[i].distanceTo(after[i]));
    if (worst > 1e-6) {
      probs.push(`滑板上骑 2 秒，脚位漂了 ${worst.toExponential(1)} —— 姿势没有定住`);
    }
  }

  // 8. ★ 站高 = 板面 − 实测落差。夹具角色没有网格，`autoScaleToHeight`
  //    返回 1，所以落差直接就是米。
  asserts++;
  {
    const want = SKATE_DECK_Y - pose.rise;
    if (Math.abs(char.position.y - want) > 1e-6) {
      probs.push(`角色站高 ${char.position.y.toFixed(5)}m，应为 ${want.toFixed(5)}m（板面 ${SKATE_DECK_Y} − 落差 ${pose.rise.toFixed(4)}）`);
    }
  }

  // 9. ★ 真素材：判据量的是**自己的数**，不是夹具的解析解。
  //    真 `run` 实测：水平面张角峰值 0.4310（= 0.757m），横向峰值只有
  //    0.0735（跑步时两脚各在自己那侧，横向那一维是退化的）。
  //    这条钉的是「换模型/换动画之后这个数仍然是个人能站的宽度」。
  if (!realModels) {
    asserts++;
    notes.push('真素材未加载（public/models 里没有 survivor.glb）：第 9 条**没量到**，不是通过');
  } else {
    asserts++;
    {
      const real = realModels.char.clone(true);
      const c = collectClips(realModels.charAnims);
      const run = c.run;
      const idle = c.idle;
      if (!run) {
        probs.push('真素材里没有 run 片段');
      } else {
        const p = stancePoseOf(real, stripRootMotion(run, rootBoneName(real)), idle ?? null);
        if (!p) {
          probs.push('真素材上 stancePoseOf 返回 null');
        } else {
          const cs = autoScaleToHeight(real, 1.75);
          const spanM = p.span * cs;
          notes.push(
            `真 run：t=${p.time.toFixed(3)}/${run.duration}s · 张角 ${p.span.toFixed(4)}（${spanM.toFixed(3)}m）· 落差 ${p.rise.toFixed(4)}（${(p.rise * cs).toFixed(3)}m）`,
          );
          asserts++;
          // 人的前后开度：实测 0.757m。低于 0.4m 就是没找到张开的帧
          // （或者量错了轴），高于 1.3m 那是量到了髋宽之类的别的东西。
          if (spanM < 0.4 || spanM > 1.3) {
            probs.push(`真素材的站姿开度 ${spanM.toFixed(3)}m 不在 0.4–1.3m —— 不是人的站姿宽度`);
          }
          asserts++;
          // 落差必须**非负且很小**：跑姿的脚比站姿低才是踩在板上的姿势。
          // 负值 = 「脚比站着还低」，那会把人插进板里。
          if (p.rise < -0.02 || p.rise * cs > 0.3) {
            probs.push(`真素材的落差 ${(p.rise * cs).toFixed(3)}m 不合理（应在 −0.035–0.3m）`);
          }
        }
      }
    }
  }

  const summary =
    `取 run 的 t=${pose.time.toFixed(5)}s（= 键 9，解析解 hypot(0.18,0.25)=${WANT_SPAN.toFixed(5)}）· ` +
    `落差 ${pose.rise.toFixed(4)} 模型单位 · 站高 = 板面 − 落差 · 姿势轨权重 1 且冻结 · 2 秒满速转向脚位零漂移` +
    (notes.length ? ` · ${notes.join(' · ')}` : '');
  return expect(probs.length === 0, probs.length ? probs.join('；') : summary, asserts);
});

/** PoseSampler 里某根骨的世界坐标。取私有字段是因为它只有这一处用途。 */
function boneWorld(probe: PoseSampler, name: string): Vector3 {
  const bones = (probe as unknown as { bones: Map<string, Bone> }).bones;
  const b = bones.get(name);
  if (!b) return new Vector3(NaN, NaN, NaN);
  b.updateWorldMatrix(true, false);
  return b.getWorldPosition(new Vector3());
}
/** 场景里某根骨的世界坐标。给回归量「脚漂没漂」用。 */
function worldOf(root: Object3D, name: string): Vector3 {
  const b = root.getObjectByName(name);
  if (!b) return new Vector3(NaN, NaN, NaN);
  b.updateWorldMatrix(true, false);
  return b.getWorldPosition(new Vector3());
}

// ---------------------------------------------------------------- 小游戏能玩
/**
 * 假 canvas ctx：只要记录调用、不真的画。五个小游戏都不读像素。
 *
 * 提成共用是因为**判据里最容易出的错就是环境不真**：第一版 `verify_minigame_playable`
 * 用的 ctx 在 `measureText` 上返回固定宽度，于是"这一句有多长"永远算错；
 * 而这类假 ctx 复制两份，就会有一个测试在假环境里绿、另一个不是。
 */
function fakeCtx(w = 960, h = 540): CanvasRenderingContext2D {
  return new Proxy({} as Record<string, unknown>, {
    get(_t, k: string) {
      if (k === 'canvas') return { width: w, height: h };
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') {
        return () => ({ addColorStop() {} });
      }
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return () => undefined; // 所有绘制指令都是 no-op
    },
    set() {
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

/**
 * 造一个小游戏实例，外加一个收集终局的盒子。
 *
 * 假的是 canvas，**真的是状态机、计时、命中判定与随机种子**——
 * 所以"玩家这么按会不会卡住"这类问题在这里是问得到真答案的。
 */
function newMiniGame(id: MiniGameId, w = 960, h = 540) {
  let result: MiniGameResult | null = null;
  const g: MiniGame = createMiniGame(id, {
    ctx: fakeCtx(w, h),
    width: w,
    height: h,
    lang: 'zh',
    palette: { ink: '#000', paper: '#fff', accent: '#a60', dim: '#888', ok: '#0a0', bad: '#a00' },
    audio: { sfx() {}, note() {}, duckAmbient() {} },
    t: (k: string) => k,
    seed: 12345,
    onDone: (r: MiniGameResult) => {
      result = r;
    },
  } as unknown as MiniGameContext);
  g.resize(w, h);
  return { g, result: () => result };
}

/**
 * **五件乐事真的能跑起来**。
 *
 * ## 为什么必须单独一条
 *
 * 原来的 `verify_mini_game` 只验**排布表**：哪一趟该出哪一件、
 * 15 局里每件各出现 3 次。那张表是对的，五件乐事也确实都在文件里。
 *
 * 但"排布对"和"能玩"是两回事，而这个项目整整一轮都栽在这中间：
 * 小游戏在浏览器里起不来，而 19 条回归没有一条会红——
 * 因为它们量的是**表**，不是**行为**。
 *
 * ## 这里怎么验
 *
 * 真造一个游戏，喂一个**假 canvas ctx**，然后按各种输入跑它：
 * 定时推进、按方向键、点/放指针、Esc。
 * 判据是「跑完这些不抛异常」+「至少能走到一个终局」。
 *
 * canvas ctx 是假的，但**游戏逻辑是真的**——
 * 状态机、计时、命中判定、随机种子全都在 JS 里，不碰 GPU。
 */
check('verify_minigame_playable', () => {
  let asserts = 0;
  const probs: string[] = [];

  const ctx = fakeCtx();

  const W = 960;
  const H = 540;
  for (const id of MINI_GAME_IDS) {
    asserts++;
    let result: MiniGameResult | null = null;
    let steps = 0;
    // 有没有真的给过输入。用于区分「自己判赢」与「玩家按对了」
    let gaveInput = false;
    try {
      const g = createMiniGame(id, {
        ctx,
        width: W,
        height: H,
        lang: 'zh',
        palette: { ink: '#000', paper: '#fff', accent: '#a60', dim: '#888', ok: '#0a0', bad: '#a00' },
        audio: { sfx() {}, note() {}, duckAmbient() {} },
        t: (k: string) => k,
        seed: 12345,
        onDone: (r: MiniGameResult) => {
          result = r;
        },
      } as unknown as MiniGameContext);
      g.resize(W, H);

      // 1. 纯定时推进 30 秒——超时兜底必须能把游戏收掉，
      //    否则玩家卡在一局出不来。
      for (let i = 0; i < 1800 && !result; i++) {
        g.step(1 / 60);
        if (i % 7 === 0) g.draw();
        steps++;
      }
      // 2. 一堆键与指针：打进去的东西不该让它抛异常。
      //    **必须"按住"而不是"点一下"**——茶要求持续按住 3 秒，
      //    而点一下只推进一帧。第一版这里写成 down→step→up，
      //    于是茶被判成"卡死"，而它其实好好的：
      //    **测不出来和坏了，在这一刻长得一模一样。**
      if (result === null) {
        gaveInput = true;
        for (const key of ['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown']) {
          g.onKeyDown(key, false);
          for (let i = 0; i < 20; i++) g.step(1 / 60);
          g.onKeyUp(key);
        }
      }
      if (!result) {
        // 真的按住空格与指针，走满 5 秒
        g.onKeyDown('Space', false);
        for (let i = 0; i < 300 && !result; i++) {
          g.step(1 / 60);
          if (i % 7 === 0) g.draw();
        }
        g.onKeyUp('Space');
      }
      if (result === null) {
        gaveInput = true;
        g.onPointerDown(W * 0.5, H * 0.5);
        for (let i = 0; i < 300 && !result; i++) {
          g.onPointerMove(W * 0.5 + i * 0.2, H * 0.5);
          g.step(1 / 60);
          if (i % 7 === 0) g.draw();
        }
        g.onPointerUp(W * 0.5 + 300, H * 0.5);
      }
      // 3. 还收不掉就 Esc——玩家至少有路可走
      if (!result) g.onKeyDown('Escape', false);
    } catch (e) {
      probs.push(`${id}: 跑起来抛异常 —— ${String((e as Error)?.message ?? e).split('\n')[0]}`);
      continue;
    }
    asserts++;
    if (!result) probs.push(`${id}: 30 秒 + 满键盘 + 满指针之后仍然收不到任何终局（卡死）`);
    // 「自己判赢」只在**一个字都没按**的时候才是问题。
    // 茶是按住 3 秒就成——测试真的按住了键，赢是**正确**的结果。
    // 第一版这里不区分，于是刚把测试改成"按住"就立刻反咬一口。
    asserts++;
    if (result === 'win' && gaveInput === false) probs.push(`${id}: 一个键都没按却自己判赢——玩家什么都不做就通关了`);
  }

  const summary = MINI_GAME_IDS.join('/') + ' 五件都能跑到终局';
  return expect(probs.length === 0, probs.length ? probs.join('；') : summary, asserts);
});

// ---------------------------------------------------------------- 剧情送达
/**
 * 剧情「送达」的规则——**不是它长什么样，是它什么时候不该出现**。
 *
 * ## 为什么这一族只能靠判据守
 *
 * 「黑底文字卡好不好看」是审美，判据管不了。
 * 但这一族里有几条是**明确的硬要求**，而且违反之后的症状
 * 全部是「玩家说不出哪里不对，只是不想玩了」：
 *
 *   · 序章**只能播一次**——读档重进再放一遍，玩家会觉得游戏在重复自己；
 *   · 路边的东西**不许锁操作**——过弯时被按住不能转向，是最容易招骂的一种打断；
 *   · 反派引子**不许结束乐事**——一局打了一半的茶没了，玩家不会说是引子的错，
 *     他会说是这个游戏做不完；
 *   · 结算屏**必须等它落幕**再走下一步——面板和下一步同时在屏幕上，
 *     玩家点到的和看到的不是同一件事。
 *
 * 这些都不需要浏览器：无头环境里 GameStateManager 是纯逻辑，
 * 判据可以直接量"播了几次""锁没锁"。
 */
check('verify_story', () => {
  let asserts = 0;
  const probs: string[] = [];

  /**
   * 内存版 localStorage。
   *
   * 无头环境里没有这个全局，而 `GameStateManager` 的 save/load 都自带
   * try/catch 兜底——**所以缺了它不会报错，只会静默不落盘**。
   * 后果是"读档后又被引一次路"这种 bug 在无头回归里测不出来：
   * 内存字段是对的，断言全绿，只有真机上重开一趟才会重播。
   *
   * 所以这里补一个最小实现，只要求 `getItem` / `setItem` / `removeItem`。
   * 装完再摘掉，免得它盖住别处"该不该落盘"的真实判断。
   */
  // 与下面的 `document` 同一个理由：不用 `typeof localStorage`，
  // 改走 globalThis 的间接属性，免得被 esbuild 折叠成常量。
  const gl = globalThis as { localStorage?: Storage };
  const hadStorage = gl.localStorage !== undefined;
  const mem = new Map<string, string>();
  if (!hadStorage) {
    gl.localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: (i: number) => [...mem.keys()][i] ?? null,
      get length() {
        return mem.size;
      },
    } as Storage;
  }

  /**
   * 最小 DOM 桩。
   *
   * 无头环境里没有 `document`，而 `StoryCards` 的 `el()` 一上来就调
   * `document.createElement`。**不补这个桩的话，上面两条关于卡片队列的
   * 判据就只能是注释**——而"静音后队列残留"恰好是个测不出来就等于
   * 没修的症状。
   *
   * 只实现被用到的四件事：建节点、挂子节点、classList、querySelector。
   * 不实现布局与事件派发——`click()` 走的是我们自己的 listener 列表，
   * 不经过真实事件系统，所以点击判据照样成立。
   *
   * ⚠️ 探测必须走 `globalThis` 的间接属性，**不能写 `typeof document`**：
   * esbuild 打包时会看见 bundle 里没有 `document` 这个全局标识符，
   * 于是把 `typeof document !== 'undefined'` **折叠成常量**——
   * 而它折叠的方向取决于作用域分析，猜不得。
   * 症状是桩被跳过、`stubParent()` 抛 `document is not defined`，
   * 而源码上那段 `if` 明明写得没问题。间接取一次就没这个问题。
   */
  const g = globalThis as { document?: Document };
  const hadDocument = g.document !== undefined;
  if (!hadDocument) {
    g.document = {
      createElement(tag: string) {
        const cls = new Set<string>();
        const kids: unknown[] = [];
        const listeners: Record<string, (() => void)[]> = {};
        const attrs: Record<string, string> = {};
        return {
          tagName: tag.toUpperCase(),
          className: '',
          style: {} as Record<string, string>,
          children: kids,
          textContent: '',
          get classList() {
            return {
              add: (c: string) => void cls.add(c),
              remove: (c: string) => void cls.delete(c),
              contains: (c: string) => cls.has(c),
              toggle: (c: string, on?: boolean) => {
                if (on === undefined) cls.has(c) ? cls.delete(c) : cls.add(c);
                else if (on) cls.add(c);
                else cls.delete(c);
              },
            };
          },
          appendChild: (n: unknown) => {
            kids.push(n);
            return n;
          },
          remove: () => {
            const i = kids.indexOf(this);
            if (i >= 0) kids.splice(i, 1);
          },
          addEventListener: (ev: string, fn: () => void) => {
            (listeners[ev] ??= []).push(fn);
          },
          /** `dom.ts` 的 setFlag 走的是 setAttribute，缺了它 setShown 会抛。 */
          setAttribute: (name: string, value: string) => {
            attrs[name] = value;
          },
          getAttribute: (name: string) => attrs[name] ?? null,
          /** 手工触发：绕开真实事件系统，只走我们自己挂的 listener。 */
          click: () => (listeners.click ?? []).forEach((f) => f()),
          querySelector: (sel: string) => {
            const want = sel.startsWith('.') ? sel.slice(1) : sel;
            const walk = (nodes: unknown[]): unknown => {
              for (const n of nodes) {
                const node = n as { classList: { contains(c: string): boolean }; children: unknown[] };
                if (node.classList?.contains(want)) return n;
                const hit = walk(node.children ?? []);
                if (hit) return hit;
              }
              return null;
            };
            return walk(kids);
          },
        };
      },
    } as unknown as Document;
  }

  /** 给 `StoryCards` 一个能挂东西的父节点。 */
  const stubParent = (): HTMLElement => {
    // 同样走 `g` 而不是裸 `document`——理由见上面 hadDocument 那段。
    const host = g.document!.createElement('div');
    // 桩的 appendChild 只是把子节点塞进数组，
    // 所以"父节点"本身也要能被 StoryCards 挂上去。
    (host as unknown as { children: unknown[] }).children = [];
    return host as unknown as HTMLElement;
  };
  try {
    gl.localStorage!.clear();
  } catch {
    /* 没有就跳过清空：新档本来也是空的 */
  }

  // 1. 序章只播一次：标记写进存档，第二次进世界必须看见它已经是 true
  asserts++;
  {
    const g = new GameStateManager();
    if (g.prologueDone) probs.push('新档的 prologueDone 竟然一开始就是 true');
    g.markPrologueDone();
    asserts++;
    if (!g.prologueDone) probs.push('markPrologueDone() 没有把标记置上');
    // 再调一次必须是幂等的——enterWorld() 的那条路径本来就会被走两次
    g.markPrologueDone();
    asserts++;
    if (!g.prologueDone) probs.push('重复 markPrologueDone() 把标记弄丢了');
  }

  // 2. 重开必须把序章重新放一遍，否则新玩家永远看不到它
  asserts++;
  {
    const g = new GameStateManager();
    g.markPrologueDone();
    g.reset();
    if (g.prologueDone) probs.push('reset() 没有清掉 prologueDone，重开就看不到序章');
  }

  // 2b. 辞职动机（`prologue_0_1..3`）与驿里那个声音。
  //
  // 序章从三句变成六句之后，"这个游戏为什么存在"有两半：
  // 为什么要回来（动机）和回来的代价是什么（原有三句）。
  // 只测"播过一次"测不到前一半——它和后一半走的是同一个标记。
  // 所以这里直接量**文案本身**：三条动机键必须存在且非空，
  // 否则退回去的读法是"序章照播，只是没人再提辞职这回事"，
  // 而现有断言一条都不会红。
  asserts++;
  {
    for (const k of ['prologue_0_1', 'prologue_0_2a', 'prologue_0_2b', 'prologue_0_3']) {
      const v = I18N.zh[k];
      if (typeof v !== 'string' || v.trim() === '') probs.push(`动机文案 ${k} 是空的`);
    }
  }
  asserts++;
  {
    // 中英两侧都必须有。`verify_i18n` 守的是两侧 key 集合相等，
    // 而**相等地都缺**这一条它抓不到——那正是"引用了没写"那一族。
    for (const k of ['prologue_0_1', 'prologue_0_2a', 'prologue_0_2b', 'prologue_0_3']) {
      if (!I18N.en[k]) probs.push(`动机文案 ${k} 缺英文侧`);
    }
  }

  // 2c. 声音的三句 + 说话人标题。它是**引路**，不是氛围：
  // 少了它，玩家的动词链仍然是"看到驿站→按完成乐事"，
  // 而"五件散在路上"这件事从头到尾没人对他说过。
  asserts++;
  {
    for (const k of ['voice_1', 'voice_2', 'voice_3', 'voice_speaker']) {
      const v = I18N.zh[k];
      if (typeof v !== 'string' || v.trim() === '') probs.push(`声音文案 ${k} 是空的`);
    }
  }
  asserts++;
  {
    // 声音念的五个名字必须与五件乐事对得上。
    // 顺序也钉住：云/茶/琴/竹/禽 = `FRAGMENT_SLOT_STATION_IDX` 的槽位序。
    // 写错一个音就是玩家照着找错方向，而这条断言会红。
    for (const [slot, word] of [
      [0, '云'],
      [1, '茶'],
      [2, '琴'],
      [3, '竹'],
      [4, '禽'],
    ] as [number, string][]) {
      if (!I18N.zh[`fragment_${slot}`]?.includes(word)) {
        probs.push(`声音说到的「${word}」与 fragment_${slot} 对不上`);
      }
    }
    asserts++;
    if (!I18N.zh.voice_2?.includes('云')) probs.push('voice_2 没有把五件乐事说出来');
  }

  // 2d. 声音**一次性**，而且必须落盘。
  //
  // 不落盘的读法：一个在十八驿门口每趟都报一遍菜名的声音。
  // 那个地方会从"有人在这儿"掉成"有个 UI 在循环"。
  asserts++;
  {
    const g = new GameStateManager();
    if (g.voiceDone) probs.push('新档的 voiceDone 竟然一开始就是 true');
  }
  asserts++;
  {
    const g = new GameStateManager();
    if (!g.claimVoiceGuide()) probs.push('第一次 claimVoiceGuide() 失败了');
    asserts++;
    if (g.claimVoiceGuide()) probs.push('同一个声音被引了两次路');
  }
  asserts++;
  {
    const g = new GameStateManager();
    g.claimVoiceGuide();
    g.reset();
    if (g.voiceDone) probs.push('reset() 没有清掉 voiceDone，重开就听不到那个声音');
  }
  asserts++;
  {
    // 落盘：写进去的字段名必须与 SaveBlob 里声明的一致。
    // 拼错一个字母的症状是"每次读档都重播"，而上面三条断言全绿。
    //
    // **必须走 `load()` 回读，不能直接摸 localStorage**：
    // 无头环境里没有 localStorage，`state.ts` 的 save/load 都自带
    // try/catch 兜底（所以别处能跑），而这里直接访问会在本条
    // 回归里抛 `localStorage is not defined` —— 症状是 NO-ASSERT，
    // 也就是"这一条其实没跑"。`expect` 看到的是崩溃而不是判据失败。
    const g = new GameStateManager();
    g.claimVoiceGuide();
    g.save();
    const h = new GameStateManager();
    asserts++;
    if (!h.load()) {
      probs.push('存档读不回来，落盘这条判据在无头环境里没法自证');
    } else if (!h.voiceDone) {
      probs.push('claimVoiceGuide() 没有真正落盘（读档后 voiceDone 仍为 false）');
    }
  }

  // 2c-2. 读卡时长必须按语言分流量。
  //
  // 实测序章两侧长度差 3.57 倍（中文 328 字 / 英文 232 词）。
  // 写死一个常数 = 必然腰斩其中一边，而腰斩**没有任何提示**：
  // 玩家看到卡片消失，只会以为"这段就这样了"。
  //
  // 所以这里量的是两件事：
  //   1. 同等**信息量**下英文必须给更多时间（否则英语玩家读不完）
  //   2. 每一段单独算之后必须**都低于单卡上限**——这才是不腰斩的充要条件。
  //      只做第 1 条会漏掉真正的问题：单张合并后撞上限。
  asserts++;
  {
    const zhLong = I18N.zh.prologue_0_2a;
    const enLong = I18N.en.prologue_0_2a;
    if (readingMs(enLong, true) <= readingMs(zhLong, false)) {
      probs.push('同等内容下英文没有比中文更长的停留时间');
    }
  }
  asserts++;
  {
    // 英文按**词**、中文按**字符**。用字符数算英文会高估约 1.6 倍。
    // 这条钉住"英文侧按词计量"：同样 100 个字符，
    // 拆成 20 个词必须比 1 个超长词给更多时间。
    const fiveWords = 'one two three four five';
    const oneLongWord = 'a'.repeat(50);
    asserts++;
    if (readingMs(fiveWords, true) <= readingMs(oneLongWord, true)) {
      probs.push('英文侧没有按词计量（5 个短词应比 1 个长词更久）');
    }
  }
  asserts++;
  {
    // 每一段都得能在上限内读完。这是"不腰斩"的真判据。
    // 退回"六句合并成一张"的写法时，这里会报出撞上限的段。
    const CAP = 22000;
    for (const k of [
      'prologue_0_1',
      'prologue_0_2a', 'prologue_0_2b',
      'prologue_0_3',
      'prologue_1',
      'prologue_2',
      'prologue_3',
      'voice_1',
      'voice_2',
      'voice_3',
    ]) {
      for (const [lang, isEn] of [
        ['zh', false],
        ['en', true],
      ] as [string, boolean][]) {
        const raw = I18N[lang as 'zh' | 'en'][k];
        if (readingMs(raw, isEn) >= CAP) {
          probs.push(`${k}(${lang}) 单段就要 ${readingMs(raw, isEn)}ms，撞上 ${CAP}ms 上限`);
        }
      }
    }
  }
  asserts++;
  {
    // 空文本与超长文本都要有界：空的不该是 NaN，
    // 超长的必须被封顶（否则深色底会长时间压住路面，而它不吃点击）。
    asserts++;
    if (!Number.isFinite(readingMs('', false)) || readingMs('', false) < 0) {
      probs.push('readingMs("") 返回了非法值');
    }
    asserts++;
    const huge = readingMs('x'.repeat(20000), false);
    if (huge > 22000) probs.push(`超长文本没有被封顶：${huge}ms`);
  }

  // 2d-2. 叙事静音（`?nocine` / `?clean`）必须真的什么都不留下。
  //
  // 这条守的是一个已经修过的坑，而且它的症状极其难查：
  // 静音时如果只在 `show()` 里提前 return，`showSequence()` 仍会把
  // 整组文字压进 `queue`，而 `pump()` 每取一条都被挡回去，
  // 于是 `queue` 永远非空 —— 取消静音后**整趟攒下来的旧卡一起冒出来**。
  // 只看"屏幕上有没有字"是测不出来的，必须量队列本身。
  asserts++;
  {
    setNarrativeQuiet(true);
    const sc = new StoryCards(stubParent());
    sc.showSequence(['一', '二', '三'], { title: 'x' });
    asserts++;
    if (sc.pending !== 0) probs.push(`静音后队列残留 ${sc.pending} 条（取消静音会一起冒出来）`);
    asserts++;
    if (sc.count !== 0) probs.push('静音后屏幕上仍有卡片');
    // 静音必须把**已经浮着的**也收掉
    setNarrativeQuiet(false);
    sc.show('先来一句', { ms: 20000 });
    asserts++;
    if (sc.count !== 1) probs.push('非静音时卡片没有正常浮出，这条判据自己失效了');
    setNarrativeQuiet(true);
    sc.clear();
    asserts++;
    if (sc.count !== 0) probs.push('静音没有收掉已经浮着的卡');
    setNarrativeQuiet(false);
  }

  // 2d-3. 可点掉的那几张才吃点击，路边的字仍然不吃。
  //
  // `.g-cards` 的 `pointer-events: none` 是文件头写死的硬要求。
  // 判据直接量**节点自己的 inline style**：CSS 类在无头环境里没有
  // 样式表可查，而 `pointer-events` 要么写在节点上、要么写在类上。
  // 这里改成量"有没有挂 is-dismissible 类"——它才是决定吃不吃点击的那一位。
  asserts++;
  {
    const sc = new StoryCards(stubParent());
    sc.show('路边的一块碑', { ms: 20000 });
    const plain = sc.root.querySelector('.g-card-line');
    asserts++;
    if (plain?.classList.contains('is-dismissible')) {
      probs.push('路边的字被标成了可点掉——过弯点一下会吞掉转向输入');
    }
    sc.show('驿里的声音', { ms: 20000, dismissible: true });
    const dis = sc.root.querySelector('.is-dismissible');
    asserts++;
    if (!dis) probs.push('dismissible 的卡没有挂上 is-dismissible 类（点了没反应）');
  }

  // 2d-4. 点掉一张，**队列必须接上下一张**。
  //
  // 这是"可点掉"这个功能本身的意义：驿里的声音三句是一组，
  // 点掉第一句却什么都不发生，玩家会以为点了没用，于是改回去干等 30 秒。
  //
  // 走的是和自动退场**同一条** `afterCardGone()`，所以这条同时钉住
  // "点击与自动推进行为一致"——两处各写一遍的读法迟早会分叉。
  asserts++;
  {
    const sc = new StoryCards(stubParent());
    sc.showSequence(['第一句', '第二句', '第三句'], { dismissible: true });
    asserts++;
    if (sc.count !== 1) probs.push(`序列开始时应该是 1 张，实际 ${sc.count} 张`);
    const first = sc.root.querySelector('.is-dismissible') as unknown as { click?: () => void };
    asserts++;
    if (typeof first?.click !== 'function') {
      probs.push('可跳过的卡上没有 click，点了不会退场');
    } else {
      first.click();
      asserts++;
      if (sc.count !== 1) probs.push(`点掉一张后没有接上下一张（当前 ${sc.count} 张）`);
      asserts++;
      if (sc.pending !== 1) probs.push(`点掉一张后队列应剩 1 条，实际 ${sc.pending} 条`);
    }
  }

  // 3. 反派场景**一次性**：claim 第二次必须失败，否则同一场戏会重复播
  asserts++;
  {
    const g = new GameStateManager();
    if (!g.claimVillainScene(1)) probs.push('第一次 claimVillainScene(1) 失败了');
    asserts++;
    if (g.claimVillainScene(1)) probs.push('同一场反派戏被 claim 了两次');
    asserts++;
    if (g.seenVillain !== 1) probs.push(`claim 之后 seenVillain 是 ${g.seenVillain}，应为 1`);
  }

  // 4. 走到最后一集之后不再 claim
  asserts++;
  {
    const g = new GameStateManager();
    for (let i = 1; i <= ECON.VILLAIN_SCENE_COUNT; i++) g.claimVillainScene(i);
    asserts++;
    if (g.claimVillainScene(ECON.VILLAIN_SCENE_COUNT + 1)) {
      probs.push('反派戏演完之后仍然能 claim 下一场');
    }
  }

  // 5. 小游戏期间**不许锁操作**：这是"一局茶被顶掉"的根
  asserts++;
  {
    // canRide 只认 phase / checkInPressed / narrativeBusy / checkInStage 四项。
    // 小游戏期间 phase 就是 'minigame'，它自己已经让车不动了；
    // 所以引子**不能**再去置 narrativeBusy —— 那会在乐事结束后仍然锁着。
    const ride = canRide({
      phase: 'minigame',
      checkInPressed: false,
      narrativeBusy: false,
      checkInStage: 'none',
    });
    if (ride) probs.push('小游戏进行中 canRide 竟然放行（说明阶段机没兜住）');
  }

  // 6. 反过来：`narrativeBusy` 一旦为真就必须挡住骑行
  asserts++;
  {
    const ok = canRide({
      phase: 'roaming',
      checkInPressed: false,
      narrativeBusy: true,
      checkInStage: 'none',
    });
    if (ok) probs.push('narrativeBusy 为真时竟然还能骑——路边字一旦锁上就解不开了');
  }

  // 2e. **序章必须开可点掉**，而路边那些字必须不开。
  //
  // 量的是**字面上那一句**：`main.ts` 里 `showStorySequence(...)` 的第三个参数。
  // 读源码是唯一诚实的量法——序章那七句是在宿主里排的队，
  // 无头环境里没有宿主，而"评审第一分钟能不能点掉它"这件事不能靠推断。
  //
  // 口径写在这里，免得它退化成"谁都能开"：
  // **"停下来读"的段落开（序章、驿里的声音），"骑过去顺便读"的不开（碑文、路口）。**
  asserts++;
  {
    const src = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
    const at = src.indexOf('showStorySequence(');
    asserts++;
    if (at < 0) {
      probs.push('main.ts 里找不到 showStorySequence 调用');
    } else {
      // 只量这一处调用的参数表：从 `(` 到第一个 `);`
      const call = src.slice(at, src.indexOf(');', at));
      if (!/dismissible:\s*true/.test(call)) {
        probs.push('序章没有开 dismissible —— 七句读完要一分半钟，评审在第一分钟就会想跳过');
      }
    }
  }

  // 摘掉临时桩。**必须放在本函数最后一条断言之后**——
  // 放早了的话，后面那些用桩的判据会读到 undefined，
  // 而症状是"桩看起来装了却没生效"，极难查。
  if (!hadStorage) {
    delete gl.localStorage;
  }
  if (!hadDocument) {
    delete g.document;
  }

  const summary =
    `序章一次性 · 动机三条中英齐全 · 声音五件对得上槽位且一次性落盘 · 读卡时长按语言分流量且单段不撞上限 · 静音不留队列残留 · 只有可跳过卡吃点击 · 序章可点掉 · 反派 ${ECON.VILLAIN_SCENE_COUNT} 集各一次 · 小游戏不锁操作`;
  return expect(probs.length === 0, probs.length ? probs.join('；') : summary, asserts);
});

check('verify_chapter', () => {
  let asserts = 0;
  const probs: string[] = [];
  const g = new GameStateManager();

  // 0. 十八驿就是 0 号驿站，且它**不是**碎片驿站
  //    （`runMiniGame` 遇到 slot < 0 会直接踢回 roaming，
  //      所以"回家"必须走独立分支，不能复用打卡那条）
  asserts++;
  if (GameStateManager.HOME_STATION !== 0) probs.push('十八驿不是 0 号驿站');
  asserts++;
  if (ROAD.FRAGMENT_SLOT_STATION_IDX.includes(GameStateManager.HOME_STATION)) {
    probs.push('十八驿被算成碎片驿站，回家会和打卡混成一条路');
  }
  asserts++;
  // 出生点必须在十八驿旁——否则"回家"是个玩家到不了的地方
  const home = STATIONS[GameStateManager.HOME_STATION];
  if (minDistToCenterline(home.x, home.z) < ROADMESH.TOTAL_HALF_WIDTH) {
    probs.push('十八驿压在路面上，回家触发点骑不到');
  }

  // 1. 一开始是"收集"，不是"回家"
  asserts++;
  if (g.objective !== 'collect') probs.push(`开局目标是 ${g.objective}，应为 collect`);

  // 2. 集齐五件之后目标变成"回家"，且此时任何地方都还不算完成
  asserts++;
  for (const idx of ROAD.FRAGMENT_SLOT_STATION_IDX) g.checkIn(idx);
  if (!g.allCollected()) {
    probs.push('把五座碎片站各打一次之后仍然不是集齐状态');
  } else if (g.objective !== 'return') {
    probs.push(`集齐后目标是 ${g.objective}，应为 return`);
  }
  asserts++;
  if (g.chapter1Done) probs.push('刚集齐就判定第一章完成，集齐不该直接等于结束');

  // 3. 到了十八驿才算完成；没到不算
  asserts++;
  const reach = WORLD.STATION_PASS_RADIUS + ROADMESH.TOTAL_HALF_WIDTH;
  if (g.atHome(GameStateManager.HOME_STATION, reach - 1, reach) !== true) {
    probs.push('站在十八驿门口却没被认成到家了');
  }
  asserts++;
  if (g.atHome(GameStateManager.HOME_STATION, reach + 5, reach) !== false) {
    probs.push('离十八驿还很远就被认成到家了');
  }
  asserts++;
  // 别的驿站即使在范围内也不算——满地图只有 0 号是家
  if (g.atHome(1, 0, reach) !== false) probs.push('1 号驿站被认成十八驿了');

  // 4. 完成是**一次性**的：重复调用不会把章节推到 3
  asserts++;
  if (!g.claimChapter1Complete()) probs.push('第一次 claimChapter1Complete() 返回了 false');
  asserts++;
  if (g.claimChapter1Complete()) probs.push('第二章完成被重复触发');
  asserts++;
  if (g.chapter !== 2) probs.push(`完成后章节是 ${g.chapter}，应为 2`);
  asserts++;
  if (g.objective !== 'collect') probs.push('第一章完成后目标仍是 return，会让玩家再跑一趟');

  return expect(
    probs.length === 0,
    probs.length ? probs.join('；') : '集齐→回家→第一章完成·解锁第二章，闩锁只放行一次',
    asserts,
  );
});

// ---------------------------------------------------------------- 建筑体检
/**
 * 16 座驿站的健康检查。**与调试面板跑的是同一个函数**（`auditBuildings`），
 * 所以面板上写的「正常/不正常」和这里的结果永远一致——
 * 这是这个检查有意义的前提：两处各判一次，早晚会有一处先改。
 *
 * 判据都对应一种"看起来不对"的具体读法：
 *   · 没加载        → 那个位置空着
 *   · 压路面        → 房子长在沥青里
 *   · 地基不平      → 一头悬空一头埋土
 *   · 悬空 / 埋土  → 底面离地 / 入地超过 1.5m
 *   · 尺寸离谱      → 半宽超过 `STATION_FOOT_HALF`、或高到超过站名锚点
 *
 * 入参只列 `stations` / `terrain` / `road` 三样（`AuditContext`），
 * 所以这里造的是**真的** Terrain / Road / Stations，不是一个假 World。
 */
check('verify_buildings', () => {
  let asserts = 0;
  const probs: string[] = [];
  const terrain = new Terrain();
  const road = new Road(terrain);
  const stations = new Stations(PRESETS[1], terrain);
  const sum = auditSummary({ stations, terrain, road });

  // 1. 16 座都在
  asserts++;
  if (sum.total !== 16) probs.push(`驿站 ${sum.total} 座，应为 16`);

  // 2. 一座都不能有 err。
  //    会红的做法：把某座驿站的 `worldPos.y` 抬高 3m（悬空），
  //    或者把它的 `radius` 改成 20（压路肩）。
  asserts++;
  if (sum.errs > 0) probs.push(`建筑体检有 ${sum.errs} 个 err：\n${sum.text}`);

  // 3. warn 也要清零。地基起伏是最容易被"看起来还行"掩盖的一类：
  //    一座房子站在 6° 的坡上，骑行视角看不出问题，
  //    走到它侧面才知道有一头悬空。
  asserts++;
  if (sum.warns > 0) probs.push(`建筑体检有 ${sum.warns} 个 warn：\n${sum.text}`);

  // 4. 程序化地标必须真的建出几何体。
  //    `loaded = true` 但 `object = null` 是"表看着正常、路上什么都没有"，
  //    而上面三条判据里没有一条能抓到它——它们查的是位置，不是"有没有东西"。
  asserts++;
  const archStations = stations.list.filter((s) => archKindFor(s.modelIdx) !== null);
  if (archStations.length === 0) {
    probs.push('一站程序化地标都没有，ARCH_BY_MODEL_IDX 的映射全丢了');
  } else {
    for (const s of archStations) {
      if (!s.object) {
        probs.push(`#${s.index} ${s.placement.def.name} 是程序化地标却没有几何体`);
        break;
      }
    }
  }

  return expect(
    probs.length === 0,
    probs.length ? probs.join('；') : `16 座全部正常（err 0 / warn 0）· 与 ?debug 面板同源`,
    asserts,
  );
});

// ---------------------------------------------------------------- 视野
/**
 * 视野必须是**画幅的连续函数**。
 *
 * 原来 `camera.fov = aspect < 0.8 ? 74 : 62` 有两个静默故障：
 *   · 0.8 处的**跳变**——转一下手机画面"咯哒"缩放一次；
 *   · 竖屏 9:19.5 的**水平视野只剩 31°**，而横屏是 94°。
 * 两者都不会让任何一行代码报错，也都不会让类型检查失败，
 * 只有拿比例扫一遍才看得见。所以这一族断言全是"扫"出来的。
 */
check('verify_fov', () => {
  let asserts = 0;
  const probs: string[] = [];

  // 1. 连续性：0.3 ~ 2.6 扫 400 个点，相邻差不得跳超过 1.5°。
  //    会红的做法：写回 `aspect < 0.8 ? 74 : 62`——那一步就是 12°。
  asserts++;
  let worstStep = 0;
  let worstAt = 0;
  let prev = verticalFovForAspect(0.3);
  for (let i = 1; i <= 400; i++) {
    const a = 0.3 + ((2.6 - 0.3) * i) / 400;
    const f = verticalFovForAspect(a);
    const step = Math.abs(f - prev);
    if (step > worstStep) {
      worstStep = step;
      worstAt = a;
    }
    prev = f;
  }
  if (worstStep > 1.5) probs.push(`FOV 在 aspect≈${worstAt.toFixed(2)} 处跳了 ${worstStep.toFixed(1)}°（转屏会闪一下）`);

  // 2. 横屏观感一字未改：16:9 必须还是 62°，21:9 / 4:3 也不能被动到
  asserts++;
  const wide = verticalFovForAspect(16 / 9);
  if (Math.abs(wide - FOV_BASE) > 0.01) probs.push(`16:9 的 FOV 变成 ${wide.toFixed(1)}°，横屏观感被改了`);
  asserts++;
  const tablet = verticalFovForAspect(4 / 3);
  if (Math.abs(tablet - FOV_BASE) > 0.01) probs.push(`4:3 的 FOV 变成 ${tablet.toFixed(1)}°，平板观感被改了`);
  asserts++;
  const ultrawide = verticalFovForAspect(21 / 9);
  if (Math.abs(ultrawide - FOV_BASE) > 0.01) probs.push(`21:9 的 FOV 变成 ${ultrawide.toFixed(1)}°，带鱼屏观感被改了`);

  // 3. 竖屏不许被饿死。
  //    水平下限与竖直上限**不能同时满足**——这是设计上的取舍，不是 bug：
  //    9:19.5 若真按 76° 水平去推，竖直要开 119°，那已经是鱼眼了。
  //    所以判据是二选一：**要么达到水平下限，要么已经顶到竖直上限**，
  //    而顶到上限时给出的水平必须正好是上限能给的最好的那个。
  //    少写一句"要么"就会把设计取舍误判成缺陷（第一版就写错过）。
  asserts++;
  let worstPortraitH = Infinity;
  for (const a of [9 / 19.5, 3 / 4, 1, 0.75, 0.6]) {
    const v = verticalFovForAspect(a);
    const h = horizontalFromVertical(v, a);
    worstPortraitH = Math.min(worstPortraitH, h);
    const capped = Math.abs(v - FOV_MAX) < 0.01;
    if (capped) {
      const best = horizontalFromVertical(FOV_MAX, a);
      if (h < best - 0.01) probs.push(`画幅 ${a.toFixed(2)} 已顶到竖直上限，水平却只有 ${h.toFixed(1)}°（上限能给 ${best.toFixed(1)}°）`);
    } else if (h < FOV_MIN_HORIZONTAL - 0.01) {
      probs.push(`画幅 ${a.toFixed(2)} 没顶到竖直上限，水平视野却只有 ${h.toFixed(1)}°（下限 ${FOV_MIN_HORIZONTAL}°）`);
    }
  }
  //    而且不能一路退化到"竖屏基本看不见路"：全谱最差水平至少 42°
  asserts++;
  if (worstPortraitH < 42) probs.push(`最差水平视野只有 ${worstPortraitH.toFixed(1)}°，竖屏已经不能用了`);

  // 4. 竖直不许变鱼眼：任何画幅都不得越过 V_MAX
  asserts++;
  let worstFov = 0;
  for (let i = 0; i <= 200; i++) {
    const a = 0.3 + ((2.6 - 0.3) * i) / 200;
    worstFov = Math.max(worstFov, verticalFovForAspect(a));
  }
  if (worstFov > FOV_MAX + 0.01) probs.push(`最大竖直 FOV ${worstFov.toFixed(1)}° 超过 ${FOV_MAX}°，已经成鱼眼了`);

  // 5. 非法输入不许炸：比例 0 / NaN / 负数都要退回参考值
  asserts++;
  for (const bad of [0, -1, NaN, Infinity]) {
    const f = verticalFovForAspect(bad);
    if (!Number.isFinite(f) || Math.abs(f - verticalFovForAspect(FOV_REF_ASPECT)) > 0.01) {
      probs.push(`非法画幅 ${bad} 得到了 FOV ${f}`);
    }
  }

  const portraitH = horizontalFromVertical(verticalFovForAspect(9 / 19.5), 9 / 19.5);
  return expect(
    probs.length === 0,
    probs.length
      ? probs.join('；')
      : `最大跳变 ${worstStep.toFixed(2)}° · 横屏 ${wide.toFixed(0)}° 不变 · 竖屏水平 ${portraitH.toFixed(0)}°（原 31°）`,
    asserts,
  );
});

// ---------------------------------------------------------------- 阶段机
check('verify_phase', () => {
  let asserts = 0;
  const probs: string[] = [];
  const base = { phase: 'roaming' as const, checkInPressed: false, narrativeBusy: false, checkInStage: 'none' as const };

  // 正常骑行
  asserts++;
  if (!canRide(base)) probs.push('roaming 且无任何占用时不能骑行');

  // 五个否决理由，逐个
  asserts++;
  if (canRide({ ...base, checkInPressed: true })) probs.push('打卡键按住时仍在骑行');
  asserts++;
  if (canRide({ ...base, narrativeBusy: true })) probs.push('剧情播放中仍在骑行');
  asserts++;
  if (canRide({ ...base, checkInStage: 'moving' })) probs.push('打卡过场中仍在骑行');
  asserts++;
  if (canRide({ ...base, phase: 'paused' })) probs.push('暂停中仍在骑行');
  asserts++;
  if (canRide({ ...base, phase: 'minigame' })) probs.push('小游戏里仍在骑行');

  // **这条是这个 bug 的本体**：
  // 引导页结束后如果宿主 phase 没切到 roaming，车就永远不动，
  // 而界面上没有任何东西会提示为什么。'onboarding' 必须在真表里。
  asserts++;
  if (canRide({ ...base, phase: 'onboarding' })) probs.push('onboarding 阶段竟然允许骑行');
  asserts++;
  if (canRide({ ...base, phase: 'title' })) probs.push('title 阶段竟然允许骑行');

  // HUD 可见 ⟺ isInWorld。两处判"在不在世界里"必须是同一个函数，
  // 否则就会重演"HUD 在、但宿主不认为能骑"那种脱节。
  asserts++;
  const inWorld: string[] = ['roaming', 'paused', 'checkin', 'synthesis'];
  for (const ph of inWorld) {
    if (!isInWorld(ph as never)) probs.push(`${ph} 应当显示世界 HUD`);
  }
  asserts++;
  for (const ph of ['boot', 'title', 'onboarding', 'minigame', 'endcard']) {
    if (isInWorld(ph as never)) probs.push(`${ph} 不该显示世界 HUD`);
  }

  // **不变式**：凡是 HUD 可见、又没有别的占用时，就必须能骑。
  // 这正是当初被违反的那一条——HUD 可见 + 玩家推摇杆 = 车不动。
  asserts++;
  for (const ph of inWorld) {
    const occupied = ph === 'paused' || ph === 'checkin' || ph === 'synthesis';
    if (occupied) continue;
    if (!canRide({ phase: 'roaming', checkInPressed: false, narrativeBusy: false, checkInStage: 'none' })) {
      probs.push('roaming 却不给骑');
    }
  }

  // 演示的弧长衔接。**三条都是契约，不是症状**——
  // `unwrapArc()` 在真实闭环里 45 秒触发零次（见 `verify_demo_drive`），
  // 所以这里量它"该放行什么、该挡什么"，而不是量它挡住了什么。
  asserts++;
  if (Math.abs(unwrapArc(0.3, 0.3002) - 0.3002) > 1e-9) probs.push('一帧内的正常前进被当成了跳变挡掉了');
  asserts++;
  if (unwrapArc(0.3, 0.8) !== 0.3) probs.push('半圈那种换支跳变没有被挡住（8 字自交口）');
  asserts++;
  if (Math.abs(unwrapArc(0.998, 0.002) - 0.002) > 1e-9) {
    probs.push('跨过环首尾的正常前进被当成了后退——那会让车在起终点原地倒一下');
  }

  return expect(probs.length === 0, probs.length ? probs.join('；') : '六个阶段 / 五个否决理由 / HUD 与可骑同源 / 演示弧长衔接三契约', asserts);
});

// ---------------------------------------------------------------- 自行车装配
/**
 * ## 自行车必须**装成一台车**，而不是一堆各自拧 `rotation` 的零件
 *
 * 这一族判据对应用户报的四件事：
 * 车轮倒着转 / 人不在车上 / 脚撑该折不折 / 车把不打方向。
 *
 * ### 为什么夹具要照抄真素材的**结构**，而不是随便造几个球
 *
 * `assembleBike()` 靠三件事认出这台车：**零件名**、**每个零件的轴向**、
 * **哪些零件够到地面**。三者错一个，装配就静默失效（`rig = null`），
 * 而那只是「少几个功能」，不报错。
 * 所以夹具按 `bicycle.glb` 的实测值建：
 *
 * | 零件 | 位置（车模本地） | 形状 |
 * |---|---|---|
 * | `tripo_part_0` 前轮 | (−0.305, 0.1998, 0.0737) | 圆柱，**轴 = 本地 Z**，R 0.1946 |
 * | `tripo_part_2` 后轮 | (0.2915, 0.1997, −0.0404) | 同上 |
 * | `tripo_part_7` 鞍面 | (0.1377, 0.5046, −0.0164) | 0.17×0.08×0.13，顶面 0.5446 |
 * | `tripo_part_11` 脚撑 | (0.2997, 0.0983, −0.0446) | 0.05×0.197×0.17，**底端到 y=0** |
 * | `crankAxle` / `crankArmL·R` / `pedalL·R` | 曲柄轴心 (0.0535, 0.1724, 0.005) | — |
 * | `tripo_part_8` / `_23` / `_25` / `_5` | 前端 | — |
 *
 * ★ 前轮**横向**比后轮偏 0.114（实测值）**故意保留**：
 *   判据不依赖它，但它证明装配用的是**量出来的轴心**而不是写死的数。
 *   脚撑底端**必须到 y = 0**——它是全车唯一碰地面的零件，
 *   「折角绕后轴」这条判据靠它成立。
 */
check('verify_bike_rig', () => {
  let asserts = 0;
  const probs: string[] = [];
  const notes: string[] = [];

  const R = 0.1946;
  const mk = (geo: BufferGeometry, name: string, x: number, y: number, z: number) => {
    const m = new Mesh(geo);
    m.name = name;
    m.position.set(x, y, z);
    return m;
  };
  // 轮：圆柱默认轴是 Y，转一下让**轮面落在 XY 平面、轴指向本地 Z**。
  // ⚠ `verify_calib` 的夹具把轴做成了 X（那是那份夹具自己的简化）；
  //   真素材是 Z，而**自转轴写错的话轮子会横着滚**——
  //   所以这里的夹具必须与素材一致，否则判据量的是一个不存在的轴。
  const wheelGeo = () => {
    const g = new CylinderGeometry(R, R, 0.089, 20);
    g.rotateX(Math.PI / 2);
    return g;
  };
  const FRONT = [-0.305, 0.1998, 0.0737] as const;
  const REAR = [0.2915, 0.1997, -0.0404] as const;
  const CRANK = [0.0535, 0.1724, 0.005] as const;

  const buildBike = () => {
    const root = new Group();
    root.add(
      mk(wheelGeo(), 'tripo_part_0', ...FRONT),
      mk(wheelGeo(), 'tripo_part_2', ...REAR),
      // 鞍面：顶面在 0.5446（实测 0.5441）
      mk(new BoxGeometry(0.17, 0.08, 0.13), 'tripo_part_7', 0.1377, 0.5046, -0.0164),
      // 脚撑：0.05 × 0.197 × 0.17，底端正好落地
      mk(new BoxGeometry(0.05, 0.197, 0.17), 'tripo_part_11', 0.2997, 0.0983, -0.0446),
      // 曲柄组：轴心 + 两条臂 + 两只踏板（左右相差 180°）
      mk(new BoxGeometry(0.024, 0.024, 0.054), 'crankAxle', ...CRANK),
      mk(new BoxGeometry(0.04, 0.198, 0.012), 'crankArmL', CRANK[0], CRANK[1] - 0.099, CRANK[2]),
      mk(new BoxGeometry(0.04, 0.198, 0.012), 'crankArmR', CRANK[0], CRANK[1] + 0.099, CRANK[2]),
      mk(new BoxGeometry(0.05, 0.02, 0.065), 'pedalL', CRANK[0] - 0.007, CRANK[1] - 0.083, CRANK[2] + 0.051),
      mk(new BoxGeometry(0.05, 0.02, 0.065), 'pedalR', CRANK[0] + 0.007, CRANK[1] + 0.083, CRANK[2] - 0.051),
      // 前端：车把 + 两只握把 + 前挡泥板（跟着前轮一起转向的那一坨）
      mk(new BoxGeometry(0.05, 0.03, 0.37), 'tripo_part_8', -0.104, 0.619, 0.004),
      mk(new BoxGeometry(0.08, 0.03, 0.03), 'tripo_part_23', -0.104, 0.619, 0.16),
      mk(new BoxGeometry(0.08, 0.03, 0.03), 'tripo_part_25', -0.104, 0.619, -0.16),
      mk(new BoxGeometry(0.1, 0.16, 0.06), 'tripo_part_5', -0.225, 0.357, 0.06),
    );
    return root;
  };

  // 角色：一根骨 + 一段骑行片段（骨盆高度 0.504 = 真素材实测值）
  //
  // ★ **必须带一个网格**，否则 `autoScaleToHeight()` 量到空盒、恒返回 1，
  //   「缩放幂等」那条断言就变成 1 === 1 的空转。
  //   网格高 **1.0**，与真素材归一化后的身高一致（实测包围盒 y 0..0.998），
  //   所以缩放应当是 1.75/1.0 = 1.75。
  const char = new Object3D();
  const hips = new Bone();
  hips.name = 'mixamorigHips';
  char.add(hips);
  // ★ **必须带左右踝骨**：自行车的摆位判据量的是「脚圈中心落在曲柄轴心上」
  //   （见下面第 6 条），而脚圈中心就是两踝中点绕着转的那个点。
  //   只挂一根髋骨的话量不到脚圈中心，摆位会退回鞍面法，那条断言就测不到
  //   它本来要测的东西了——**测不到 ≠ 通过**，所以这里要补上。
  //   位置取自真素材实测（角色本地、模型单位）。
  const lf = new Bone();
  lf.name = 'mixamorigLeftFoot';
  lf.position.set(0.1, 0.15, 0.06);
  char.add(lf);
  const rf = new Bone();
  rf.name = 'mixamorigRightFoot';
  rf.position.set(-0.07, 0.24, 0.06);
  char.add(rf);
  const body = new Mesh(new BoxGeometry(0.4, 1.0, 0.2));
  body.name = 'charBody';
  body.position.set(0, 0.5, 0);
  char.add(body);
  const rideTimes = new Float32Array([0, 1]);
  const rideClip = new AnimationClip('骑自行车', 1, [
    new KeyframeTrack('mixamorigHips.position', rideTimes, Float32Array.from([0, 0.504, 0, 0, 0.504, 0])),
  ]);

  const bike = buildBike();
  const v = new Vehicle();
  v.attach({
    bike,
    motorcycle: new Object3D(),
    skate: new Object3D(),
    char,
    clips: collectClips([rideClip]),
  });
  const ok = v.set('bike');

  // 1. 装配必须成功。`rig = null` 意味着转向 / 脚撑 / 曲柄**全部静默失效**。
  asserts++;
  if (!ok || v.id !== 'bike') {
    probs.push('切不到 bike 模式');
    return expect(false, probs.join('；'), asserts);
  }
  if (!v.hasBikeRig) {
    probs.push('自行车装配返回 null —— 转向 / 脚撑 / 曲柄全都静默失效');
    return expect(false, probs.join('；'), asserts);
  }

  // 1b. ★ **角色缩放必须幂等**
  //
  // `attach()` 与每次 `set()` 都会 `rebuild()`，而 `rebuild()` 会把量出来的
  // 缩放**写回同一个节点**。`Box3.setFromObject()` 量的是**世界**盒子，
  // 于是第二次量到的是自己的产物：`1.75 / (0.998×1.753) = 1.000` ——
  // **人矮 43%**。触发只需要按一下 `E`，或者摩托车模型晚到。
  //
  // 症状与「人不在车上」是同一个画面（人小一号），
  // 而画面上分不出是站位算错还是人被缩小了。
  asserts++;
  {
    const first = char.scale.x;
    asserts++;
    if (Math.abs(first - 1.75) > 0.01) {
      probs.push(`角色缩放 ${first.toFixed(4)}，身高 1.0 的模型应为 1.75 —— 量不到就是量到了空盒`);
    }
    v.set('foot');
    v.set('bike');
    asserts++;
    if (Math.abs(char.scale.x - first) > 1e-6) {
      probs.push(
        `角色缩放第一次 ${first.toFixed(4)}、切一轮载具后 ${char.scale.x.toFixed(4)} —— 量到了自己的产物（人缩小）`,
      );
    }
  }

  // 2. ★ **轮子必须往前转**（正负号）
  //
  // 不打滑要求 `v_中心 + ω × r = 0`：前进 −X、轴 +Z、接地点 (0,−R,0)
  // ⇒ **ω = +v/R**。原来三个载具都写成负号，于是轮子全在倒着转，
  // 而既有判据量的都是「转了多少」，没有一条量正负号。
  asserts++;
  const bikeScale = bike.scale.x;
  {
    for (let i = 0; i < 60; i++) v.update(1 / 60, 2, 0); // 1 秒，2 m/s
    const ang = v.bikeWheelAngle;
    if (!(ang > 0)) {
      probs.push(`前进 2m/s 一秒后后轮转角是 ${ang.toFixed(3)} rad，轮子在倒着转（应为正）`);
    }
    asserts++;
    // 不打滑：转过的角度 = 里程 ÷ 轮半径。半径用实测轮半径换算成车模单位。
    const want = 2 / (0.35);
    if (Math.abs(ang - want) > 0.02) {
      probs.push(`转角 ${ang.toFixed(3)} rad，里程 2m ÷ 轮半径 0.35m 应为 ${want.toFixed(3)}`);
    }
  }

  // 3. ★ **曲柄必须比轮子慢 `BIKE_GEAR_RATIO` 倍**（链盘比飞轮大）
  //
  // 少了传动比就是「链子在用减速把轮子往回驱」——那个机构不存在。
  //
  // ⚠ 判据写成 `crankAngle × gear === wheelAngle`，**不是**两者的比值：
  //   `wheelAngle = 里程 / 轮半径(米)`、`crankAngle = 里程 / 传动比`，
  //   两式相除会剩下一个**米**的量纲因子（0.35），而传动比是无量纲的。
  //   我第一版就写成了「比值 = 1/2.6」，量到 0.1346 = 0.35/2.6 ——
  //   **量出来的是对的，是判据把量纲漏了**。
  asserts++;
  {
    const geared = v.bikeCrankAngle * BIKE_GEAR_RATIO;
    if (!(v.bikeCrankAngle > 0)) {
      probs.push('曲柄没跟着轮子转（人在踩踏板而踏板不动）');
    }
    asserts++;
    if (Math.abs(geared - v.bikeWheelAngle) > 1e-3) {
      probs.push(
        `曲柄角×${BIKE_GEAR_RATIO} = ${geared.toFixed(3)}，轮角 ${v.bikeWheelAngle.toFixed(3)} —— 两者应相等（轮子比曲柄快 ${BIKE_GEAR_RATIO} 倍）`,
      );
    }
  }

  // 4. ★ **脚撑：停着放下来垂直于地面，骑起来折起**
  //
  // 用户明确要求的行为，而原来**没有任何**断言会红。
  // 纯函数先问一遍（阈值边界），再问装配后的实际角度。
  asserts++;
  {
    if (standFoldAt(0) !== 0) probs.push('停着时脚撑不是放下的（0 rad）');
    asserts++;
    if (standFoldAt(8) !== STAND_FOLD_ANGLE) {
      probs.push(`骑起来时脚撑不是折起角 ${STAND_FOLD_ANGLE.toFixed(3)}`);
    }
  }
  asserts++;
  {
    // 停住 3 秒（damp 收敛）
    for (let i = 0; i < 180; i++) v.update(1 / 60, 0, 0);
    const down = v.standAngle;
    if (Math.abs(down) > 0.02) {
      probs.push(`停住 3 秒后脚撑角度 ${down.toFixed(3)} rad，应为 0（垂直落地）`);
    }
    asserts++;
    // 起步 3 秒
    for (let i = 0; i < 180; i++) v.update(1 / 60, 3, 0);
    const up = v.standAngle;
    if (Math.abs(up - STAND_FOLD_ANGLE) > 0.05) {
      probs.push(`骑 3 秒后脚撑角度 ${up.toFixed(3)} rad，应折起到 ${STAND_FOLD_ANGLE.toFixed(3)}`);
    }
  }

  // 5. ★ **车把随转向打方向**，且方向要对
  //
  // 判据是**符号**：航向角增大 = 左转（`ride.ts` 的 `_fwd` 在 h 增大时偏向 −X，
  // 而 −X 是左），前轮应当**朝左**打。符号反了的话车会往弯外推。
  asserts++;
  {
    // 停住，先让转向角回到 0
    for (let i = 0; i < 180; i++) v.update(1 / 60, 4, 0);
    const straight = v.barAngle;
    // 左转：每帧 **0.9°**（= 54°/s），4 m/s。
    // δ = atan(ω·L / v)：ω = 0.94 rad/s、轴距 ≈ 1.10m、v = 4 ⇒ δ ≈ 14.5°，
    // 在 `BIKE_STEER_MAX`（11.5°）处被夹住——正好压着上限。
    // ⚠ 每帧增量是**弧度**（0.9° = 0.0157 rad），不是「度每秒」。
    const PER_FRAME = (0.9 * Math.PI) / 180;
    for (let i = 0; i < 60; i++) v.update(1 / 60, 4, i * PER_FRAME);
    const left = v.barAngle;
    asserts++;
    if (!(left > 0.02)) {
      probs.push(`左转 1 秒后车把角 ${left.toFixed(3)} rad（起手 ${straight.toFixed(3)}），轮子没往左打`);
    }
    asserts++;
    if (left > BIKE_STEER_MAX + 1e-6) {
      probs.push(`车把角 ${left.toFixed(3)} rad 超过上限 ${BIKE_STEER_MAX}，手会离开车把`);
    }
    // 右转必须反向（两倍角速度，方向相反）
    const hEnd = 59 * PER_FRAME;
    for (let i = 0; i < 120; i++) v.update(1 / 60, 4, hEnd - i * PER_FRAME * 2);
    asserts++;
    if (!(v.barAngle < left)) {
      probs.push(`右转后车把角 ${v.barAngle.toFixed(3)} 没有比左转的 ${left.toFixed(3)} 更小（方向没反过来）`);
    }
  }

  // 6. ★ **站位**：骨盆必须落在鞍面上
  //
  // 判据换过三次，每次都因为踩到同一个坑：
  //
  // ① 写死的 `SADDLE_H = 1.05` 与这台车的鞍面（实测 0.979m）和动画的骨盆高度
  //    （0.504 角色单位 = 0.882m）**都对不上**，所以那一版必然坐歪。
  // ② 「脚圈中心 = 曲柄轴心」让脚够得着踏板了，可是这套骑行动画的腿**相对**
  //    这台车太短（腿长/曲柄半径 3.93 vs 7.23），骑手被迫悬空 13.6cm——
  //    那是个**取舍**，画面上读作「车对 rider 偏小」。
  // ③ 现在两条腿的旋转轨道被**两骨 IK 重烘**过（`bakeRideToPedals`）：
  //    脚踝真的落在踏板圆上、整圈闭合，而烘焙的圆心由**鞍面**反推，
  //    于是骨盆同时落回鞍面——②那个取舍没有了。
  //
  // ★ 这里问**骨盆**而不是「脚在踏板上」：夹具角色的双脚是**静止**的
  //   （只有 quaternion 轨道，没有 position 轨道），它压根没有踏板圆可落。
  //   问「脚踩在踏板上」只能对**真素材**问——`verify_vehicle_real` 第 5 条在问。
  //   这里能问、也该问的是「人坐在车上了没有」。
  asserts++;
  {
    const seat = v.bikeSeat;
    if (!seat) {
      probs.push('量不到鞍面（saddleTopOf 返回空）—— 站位会退回写死的 1.05m');
    } else {
      const pelvisH = v.pelvisHeight;
      const seatWorldY = seat.y * bikeScale;
      // ★ 比的是**骨盆**，不是角色原点：原点在骨盆**下方** `pelvisHeight × 缩放`
      //   （实测 0.882m）处，拿它跟鞍面比量到的是 −0.75m 这种毫无意义的数。
      const pelvisY = char.position.y + pelvisH * char.scale.x;
      asserts++;
      if (Math.abs(pelvisY - (seatWorldY + 1.75 * 0.006)) > 0.03) {
        probs.push(
          `骨盆在 y=${pelvisY.toFixed(3)}m，鞍面 ${seatWorldY.toFixed(3)}m 上方 1.1cm 应为 ${(seatWorldY + 0.0105).toFixed(3)}m —— 人不在车上`,
        );
      }
      notes.push(`骨盆高于鞍面 ${((pelvisY - seatWorldY) * 100).toFixed(1)}cm`);
      // 重心必须在坐垫**后面**一点（车模 +X 是车尾，见 `PELVIS_BEHIND_SADDLE`）。
      // ★ 把骑手位置**变回车模空间**再比，而不是在 group 空间里比某个轴——
      //   「模型 x = group z」只在偏航**恰好是 −90°** 时成立，而实测行车基底
      //   是 −100.71°，按老约定去比会量到 −0.218m。
      const gotX = new Vector3().copy(char.position).applyMatrix4(bike.matrix.clone().invert()).x;
      const wantX = seat.x + 0.045 / bikeScale;
      asserts++;
      if (Math.abs(gotX - wantX) > 0.006) {
        probs.push(
          `骑手重心比鞍面靠后 ${((gotX - seat.x) * bikeScale).toFixed(3)}m，应为 0.045m` +
            `（比的是车模空间的 x，与偏航无关）`,
        );
      }
    }
  }

  // 9b. ★ 自行车的自转轴同样必须**水平且垂直于前进方向**
  asserts++;
  {
    for (let i = 0; i < 30; i++) v.update(1 / 60, 4, 0); // heading = 0 ⇒ 前进方向 -Z
    const axis = v.bikeSpinAxisWorld;
    asserts++;
    if (!axis) {
      probs.push('自行车没有自转层 —— 后轮压根不转');
    } else {
      asserts++;
      if (Math.abs(axis.y) > 0.02) {
        probs.push(
          `自行车自转轴不水平（y = ${axis.y.toFixed(4)}，${((Math.asin(Math.abs(axis.y)) * 180) / Math.PI).toFixed(2)}°）` +
            ' —— 轮子会一边滚一边蹭',
        );
      }
      asserts++;
      if (Math.hypot(axis.x, axis.z) < 0.99) {
        probs.push(
          `自行车自转轴是 (${axis.x.toFixed(3)}, ${axis.y.toFixed(3)}, ${axis.z.toFixed(3)})，` +
            '它没有垂直于前进方向 —— 轮子横着滚',
        );
      }
    }
  }

  // 10. 骑行轨的播放倍率：停住必须 0（人定住，不是原地空踩踏板）
  asserts++;
  {
    for (let i = 0; i < 60; i++) v.update(1 / 60, 0, 0);
    if (Math.abs(v.rideTimeScale) > 1e-6) {
      probs.push(`车停住时骑行动画倍率 ${v.rideTimeScale.toFixed(3)}，应为 0`);
    }
    asserts++;
    for (let i = 0; i < 60; i++) v.update(1 / 60, 3, 0);
    if (!(v.rideTimeScale > 0.5)) {
      probs.push(`骑 3 m/s 时骑行动画倍率 ${v.rideTimeScale.toFixed(3)}，踏板不动`);
    }
  }

  // 8. ★ **反复切载具不许堆积空节点**
  //
  // `attach()` 不重新加载模型，枢轴却每次新建。
  // 不清就会在车里一层层堆空 Group——每次切换泄漏几个，
  // 而「多几个空节点」没有任何症状，只有这条判据看得见。
  asserts++;
  {
    const count = () => bike.children.filter((c) => c.name.startsWith('rig:')).length;
    const before = count();
    v.set('foot');
    v.set('bike');
    v.set('foot');
    v.set('bike');
    asserts++;
    if (count() !== before || before === 0) {
      probs.push(`切 4 次载具后装配节点从 ${before} 变成 ${count()}（空节点在累积）`);
    }
  }

  const summary =
    `轮角 +${(2 / 0.35).toFixed(2)} rad/2m（不打滑）· 曲柄 = 轮角/${BIKE_GEAR_RATIO} · ` +
    `脚撑 0 ⇄ ${((STAND_FOLD_ANGLE * 180) / Math.PI).toFixed(0)}° · 车把 ≤ ${((BIKE_STEER_MAX * 180) / Math.PI).toFixed(1)}° · ` +
    `脚圈中心 = 曲柄轴心` +
    (notes.length ? ` · ${notes.join(' · ')}` : '');
  return expect(probs.length === 0, probs.length ? probs.join('；') : summary, asserts);
});

// ---------------------------------------------------------------- 骑行
check('verify_ride', () => {
  const r = assertRide();
  return { ok: r.ok, detail: r.detail, asserts: r.asserts };
});

/**
 * 演示模式那辆车自己往前骑。
 *
 * 独立成一条而不是塞进 `verify_ride`：它量的不是"车能不能动"，
 * 而是"没有人按键时车会不会自己开进草地"——那个按钮原来根本不开车。
 */
check('verify_demo_drive', () => {
  const r = assertDemoDrive();
  return { ok: r.ok, detail: r.detail, asserts: r.asserts };
});

// ---------------------------------------------------------------- 演示的 90 秒承诺
/**
 * **标题页上那句「演示 · 90 秒」，必须是代码里真会走到的一行。**
 *
 * ## 它守的是哪一族 bug
 *
 * `ECON.DEMO_BUDGET_SEC` 在 `economy.json` 里躺着，`raw.ts` 给它标了类型，
 * 但**整个代码库里从来没被读过一次**——只在 `main.ts` 一条注释里出现过。
 * `startDemo()` 只做解锁音频、放 BGM、对白自动推进，于是演示永远不会结束。
 * 实测无头跑 309 秒，天数、驿站、铜钱从 +238s 起到 +309s 一个都没变过。
 *
 * 一个兑现不了的按钮比没有按钮更糟：它把"我不知道自己要等多久"
 * 直接写在了界面上。
 *
 * ## 判据为什么是读源码
 *
 * 演示结束是一个 **UI 事件**（结算页弹出来），无头 Node 里既没有 DOM、
 * 也没有 90 秒的耐心。所以判据只问结构上可查的事：那一行读取还在不在，
 * 读到之后走到哪里去了。
 *
 * ## 会红的做法
 *   · 删掉 `demoTick()` 里那句 `if (this.demoT >= ECON.DEMO_BUDGET_SEC)`      → 红（第 1、2 条）
 *   · 把 `finishRun()` 换成只加秒表不收场                                        → 红（第 2 条）
 *   · 删掉 `render()` 里那行 `this.demoTick(dt)`                               → 红（第 2 条）
 *   · 从 i18n 里删掉 `demo_card_notice`                                          → 红（第 3 条）
 *   · 把 `DEMO_END_AT_SEC` 调到 ≥ `DEMO_BUDGET_SEC`                             → 红（第 4 条）
 */
check('verify_demo_budget', () => {
  let asserts = 0;
  const probs: string[] = [];
  const read = (rel: string): string =>
    readFileSync(join(process.cwd(), 'src', rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  const main = read('main.ts');

  // 1. 预算必须被真的读到。注释里提过不算——上面 read() 已经剥掉了注释。
  asserts++;
  if (!/ECON\.DEMO_BUDGET_SEC/.test(main)) {
    probs.push('main.ts 从未读取 ECON.DEMO_BUDGET_SEC —— 标题页上的「演示 · 90 秒」没有人执行');
  }

  // 2. 读到了之后必须真的收场，而且秒表真的在每帧被喂。
  //
  //    拆成两半是因为它们各自能独立坏掉：秒表存在但没人喂（演示照旧无限长），
  //    或者被喂了但到了点不收场（同上）。合在一起断言，红的时候分不清是哪一个。
  asserts++;
  const tickBody = (main.match(/demoTick\s*\([^)]*\)\s*:\s*void\s*\{([\s\S]*?)\n  \}/) || [, ''])[1];
  if (!tickBody) {
    probs.push('main.ts 里没有 demoTick(dt) —— 演示的秒表没人推进');
  } else {
    if (!/ECON\.DEMO_BUDGET_SEC/.test(tickBody)) {
      probs.push('demoTick() 没拿 ECON.DEMO_BUDGET_SEC 当阈值 —— 收场的时机不在这个预算上');
    }
    if (!/finishRun\s*\(\s*\)/.test(tickBody)) {
      probs.push('demoTick() 里没有 finishRun() —— 预算用掉了，演示却不会停');
    }
  }
  if (!/this\.demoTick\s*\(\s*dt\s*\)/.test(main)) {
    probs.push('没有地方调用 this.demoTick(dt) —— 秒表存在但没人喂它');
  }

  // 3. 收尾那句提示必须真的存在，不然玩家看到的是裸 key。
  asserts++;
  for (const lang of ['zh', 'en'] as const) {
    const v = I18N[lang]?.['demo_card_notice'];
    if (typeof v !== 'string' || v.length === 0) {
      probs.push(`文案缺 demo_card_notice（${lang}）—— 演示收尾那句提示会显示成裸 key`);
    }
  }

  // 4. 预算本身得像个 90 秒，而且小游戏跳过的时机必须落在收场之前。
  //
  //    第二条：`DEMO_END_AT_SEC` 是"演示里不玩小游戏"的开关。若它落在预算之后，
  //    演示会先弹出结算页、跳过逻辑再也没机会执行——那句
  //    "演示模式不玩小游戏"就成了只在非演示时才成立的废话。
  asserts++;
  if (!(ECON.DEMO_BUDGET_SEC > 0 && ECON.DEMO_BUDGET_SEC <= 120)) {
    probs.push(`DEMO_BUDGET_SEC = ${ECON.DEMO_BUDGET_SEC} —— 跟按钮上写的「90 秒」对不上`);
  }
  if (ECON.DEMO_END_AT_SEC >= ECON.DEMO_BUDGET_SEC) {
    probs.push(
      `DEMO_END_AT_SEC(${ECON.DEMO_END_AT_SEC}) ≥ DEMO_BUDGET_SEC(${ECON.DEMO_BUDGET_SEC})`
        + ' —— 小游戏的跳过时机落在演示结束之后，演示里根本没有跳过这一环',
    );
  }

  return expect(
    probs.length === 0,
    probs.length ? probs.join('；')
      : `演示预算 ${ECON.DEMO_BUDGET_SEC}s 被真读到、到点真的收场、提示文案在、跳过时机(${ECON.DEMO_END_AT_SEC}s)落在收场之前`,
    asserts,
  );
});

/**
 * ## 载具的标定必须**可重复**
 *
 * 两条都是实机抓出来的，而且都属于"第一次切换是对的、第二次开始错"那一族：
 *
 * 1. **缩放会漂。** `scaleByFrontWheel()` 原来用 `Box3.setFromObject()`——
 *    那是**世界**盒子，而 `rebuild()` 里 `group.clear()` 之后模型的
 *    `scale` 还留着上一轮的值。于是第二次量到的是**已经缩放过一遍的盒子**，
 *    返回 1，车缩成 56%。`bicycle.glb` 实测 1.798 → 掉到 1。
 * 2. **车把枢轴落错地方。** 同一个世界盒子被当成 `pivot.position` 喂进去
 *    （pivot 是子节点、坐标是本地的），车把一转就把**前轮甩出去**。
 *
 * 判据是**做两遍**：同一个模型挂两次、量两次，两个数必须一样。
 * 一遍看不出这类 bug——它只在"第二次"才发作。
 */
check('verify_calib', () => {
  let asserts = 0;
  const probs: string[] = [];

  /**
   * 造一个「前轮 + 车架 + 车把」的小模型，尺寸按 `bicycle_clean.glb` 的比例
   * （轮半径 0.1947、车架 0.98 长）。轮子**带自己的节点平移**，
   * 所以世界盒子与本地盒子的差别是真实存在的，不是造出来的。
   */
  const buildBike = () => {
    const root = new Group();
    const wheelGeo = new CylinderGeometry(0.09, 0.09, 0.05, 16);
    wheelGeo.rotateX(Math.PI / 2); // 轮面在 YZ 平面 → 轴是本地 X
    const frameGeo = new BoxGeometry(0.98, 0.12, 0.12);
    const front = new Mesh(wheelGeo);
    front.name = 'tripo_part_0';
    front.position.set(-0.311, 0.195, 0.0);
    const rear = new Mesh(wheelGeo.clone());
    rear.name = 'tripo_part_2';
    rear.position.set(0.287, 0.195, 0.0);
    const frame = new Mesh(frameGeo);
    frame.name = 'frame';
    frame.position.set(0, 0.3, 0);
    for (const m of [front, rear, frame]) root.add(m);
    return root;
  };

  // 1. 缩放可重复：挂一次、挂两次，两次必须给出同一个数
  asserts++;
  {
    const root = buildBike();
    const a = bicycleScale(root);
    // 模拟 rebuild()：只把模型摘下来，**不动它的 scale**
    root.scale.setScalar(a);
    const b = bicycleScale(root);
    if (Math.abs(a - b) > 1e-9) {
      probs.push(`缩放不可重复：第一次 ${a.toFixed(4)}，第二次 ${b.toFixed(4)}`);
    }
    asserts++;
    // 圆柱半径 0.09 ⇒ 竖直跨度 0.18 ⇒ 半径 0.09；0.35 / 0.09 = 3.889
    if (Math.abs(a - 0.35 / 0.09) > 0.01) {
      probs.push(`自行车缩放 ${a.toFixed(4)}，按轮半径 0.09 应为 ${(0.35 / 0.09).toFixed(4)}`);
    }
  }

  // 2. 缩放必须与「模型已经缩放过」无关：量的是**本地**盒子
  asserts++;
  {
    const root = buildBike();
    const before = bicycleScale(root);
    root.scale.setScalar(3.7); // 随便一个已经缩过的状态
    const after = bicycleScale(root);
    asserts++;
    if (Math.abs(before - after) > 1e-9) {
      probs.push(`缩放依赖模型当前的 scale（${before.toFixed(4)} vs ${after.toFixed(4)}）——量的是世界盒子`);
    }
  }

  // 3. 车把枢轴必须落在**前轮轴心**上
  asserts++;
  {
    const root = buildBike();
    root.position.set(-14, 0, 77); // 模拟 ride 位：世界坐标远不等于本地
    root.updateMatrixWorld(true);
    const frontLocal = localUnion(root, ['tripo_part_0']);
    asserts++;
    if (frontLocal.isEmpty()) {
      probs.push('量不到前轮包围盒');
    } else {
      const c = frontLocal.getCenter(new Vector3());
      asserts++;
      if (Math.abs(c.x - (-0.311)) > 0.02 || Math.abs(c.y - 0.195) > 0.02 || Math.abs(c.z) > 0.02) {
        probs.push(
          `前轮轴心量成了 (${c.x.toFixed(3)}, ${c.y.toFixed(3)}, ${c.z.toFixed(3)})，应为 (-0.311, 0.195, 0)`,
        );
      }
    }
  }

  return {
    ok: probs.length === 0,
    detail: probs.length === 0 ? '缩放可重复且与当前 scale 无关 · 前轮轴心在本地空间量对' : probs.join('；'),
    asserts,
  };
});

/**
 * ## 骑手必须**真的骑在车上**
 *
 * 这一条是被用户一句「滑板上要站人」逼出来的，而它抓到的 bug 比听上去严重：
 * **骑手在自行车上也不见了**，只是没人提，因为滑板那一眼最容易看出来。
 *
 * ## 成因：把世界坐标喂进了本地字段
 *
 * `Vehicle.update()` 里算骑手位置时写的是
 * `bike.localToWorld(p)` —— 它返回**世界**坐标；
 * 而 `char.position` 是在**父节点 `this.group` 的空间**里解读的。
 * `group` 自己已经平移到玩家位置（沿路几百米），两者一混，
 * 角色被放到「距原点两倍」的地方，实机上就是**人不见了**。
 *
 * `bike` 与 `char` 是**兄弟节点**，所以从车的本地空间走到 group 本地空间
 * 只需要乘 `bike.matrix`（含车自己的缩放与偏航），不需要任何世界坐标。
 *
 * ## 为什么这一族 bug 没人发现
 *
 * 症状是"画面里少个人"，而这一路上所有判据量的都是**别的东西**：
 * 速度、离地、面数、离路判定、朝向——全都正常。
 * 徒步分支用 `char.position.set()`（本来就是本地坐标）所以没事，
 * 于是"人在徒步时可见、在车上时不可见"这件事没有留下任何数字痕迹。
 *
 * ## 它会红的方式
 *
 * 把 `applyMatrix4(bike.matrix)` 换回 `localToWorld(p)` → 距离从 1m 变成 ~470m，红。
 */
check('verify_rider', () => {
  let asserts = 0;
  const probs: string[] = [];

  const char = new Object3D();
  const bike = new Object3D();
  const skate = new Object3D();
  const v = new Vehicle();
  v.attach({ bike, skate, char, clips: collectClips([]) });

  // 沿路的真实量级：路线坐标是几百米量级，所以「本地当成世界」会差出几百米。
  const RIDE_POS = new Vector3(-412, 0, 233);

  for (const mode of ['bike', 'skate'] as RideMode[]) {
    v.set(mode);
    v.group.position.copy(RIDE_POS);
    v.group.updateMatrixWorld(true);
    // 走两帧，让阻尼类的东西稳定下来。
    for (let i = 0; i < 2; i++) {
      v.group.position.copy(RIDE_POS);
      v.update(1 / 60, 8, 0);
    }
    v.group.updateMatrixWorld(true);

    asserts++;
    const deck = (mode === 'bike' ? bike : skate).getWorldPosition(new Vector3());
    const rider = char.getWorldPosition(new Vector3());
    const d = rider.distanceTo(deck);
    if (!(d <= 2)) {
      probs.push(
        `${mode}：骑手离车 ${d.toFixed(1)}m` +
          `（车在 (${deck.x.toFixed(0)}, ${deck.y.toFixed(1)}, ${deck.z.toFixed(0)})，` +
          `人在 (${rider.x.toFixed(0)}, ${rider.y.toFixed(1)}, ${rider.z.toFixed(0)})）`,
      );
    }

    // 车换了模式之后人也必须还在车上：单独量一次"人在不在原点附近"，
    // 能把"整体平移"这种错误和"坐标空间搞错"这种错误分开。
    asserts++;
    if (Math.abs(rider.z - RIDE_POS.z) > 2 || Math.abs(rider.x - RIDE_POS.x) > 2) {
      probs.push(`${mode}：骑手被甩离 ride 位，横向偏了 ${(rider.x - RIDE_POS.x).toFixed(1)}m / ${(rider.z - RIDE_POS.z).toFixed(1)}m`);
    }
  }

  // 徒步那条分支用 `char.position.set()`，本来就是本地坐标——
  // 顺手钉住它，免得有人"顺手统一"成 applyMatrix4 而弄坏徒步。
  asserts++;
  {
    v.set('foot');
    v.group.position.copy(RIDE_POS);
    v.update(1 / 60, 4, 0);
    v.group.updateMatrixWorld(true);
    const rider = char.getWorldPosition(new Vector3());
    const want = RIDE_POS.clone().add(new Vector3(FOOT_LATERAL_OFFSET, 0, 0));
    const d = rider.distanceTo(want);
    if (d > 0.5) {
      probs.push(`徒步：角色应在 ride 位，实际偏了 ${d.toFixed(2)}m`);
    }
  }

  return {
    ok: probs.length === 0,
    detail: probs.length === 0 ? '自行车 / 滑板 / 徒步三种模式下骑手都在车上（远点 470m 量级）' : probs.join('；'),
    asserts,
  };
});

/**
 * ## 三个载具的前方必须是**同一个方向**
 *
 * 这一条是被实机抓出来的：人物**倒着走**——玩家从背后看到的是他的脸。
 *
 * 之所以没有任何断言发现，是因为三个 `rotation.y` 是**三处各自独立的常数**：
 * 人物的 `heading + CHAR_FACING_YAW`、自行车的 `BICYCLE_YAW`、
 * 摩托车的 `MOTORCYCLE_YAW`。代码里没有任何东西把它们联系起来，
 * 所以「人正着走、车却横着跑」既不产生错误、也不改变任何被量的量
 * （速度、离地、面数、离路判定全都正常）。
 *
 * 判据是**算的**而不是看的：把每个模型的车头（本地空间，实测自轮子节点平移）
 * 加上它自己的偏航，算出世界前进方向，三个都必须是 `(0, 0, −1)`。
 *
 * ## 它会红的方式
 *
 * · 把 `CHAR_FACING_YAW` 去掉 → 人物算成 +Z，红
 * · 把 `BICYCLE_YAW` 写成 +90° → 自行车算成 +Z，红
 * · 把 `MODEL_HEADS.bicycle` 写成 +X → 自行车算成 +Z，红
 */
check('verify_facing', () => {
  let asserts = 0;
  const probs: string[] = [];
  // 本作的车头约定（ride.ts 的 _fwd 在 h=0 时指向 −Z）
  const FWD: readonly [number, number, number] = [0, 0, -1];

  const rows: [string, readonly number[], number][] = [
    ['人物', MODEL_HEADS.char, CHAR_FACING_YAW],
    ['自行车', MODEL_HEADS.bicycle, BICYCLE_YAW],
    ['摩托车', MODEL_HEADS.motorcycle, MOTORCYCLE_YAW],
  ];

  for (const [name, head, yaw] of rows) {
    asserts++;
    const d = facingDir(head, yaw);
    // 偏航是绕 Y 的，所以 y 分量恒为 0；只看水平面内的两个分量。
    const err = Math.hypot(d[0] - FWD[0], d[2] - FWD[2]);
    if (err > 1e-6) {
      probs.push(
        `${name}的车头算出来是 (${d.map((v) => v.toFixed(3)).join(', ')})，应为 (0, 0, -1)`,
      );
    }
  }

  // 三者必须**彼此**一致，而不只是各自都"看着对"——
  // 万一有人把约定整体改成 +Z，这条会红而上面三条不会。
  asserts++;
  const dirs = rows.map(([, head, yaw]) => facingDir(head, yaw));
  for (let i = 1; i < dirs.length; i++) {
    const e = Math.hypot(dirs[i][0] - dirs[0][0], dirs[i][2] - dirs[0][2]);
    if (e > 1e-6) probs.push(`${rows[i][0]}与${rows[0][0]}的前方不一致`);
  }

  // 车头单位向量归一化：忘了归一化的话方向对、长度不对，
  // 而"长度"在代码里没有任何地方用到，所以不会有人发现。
  asserts++;
  for (const [name, head] of rows) {
    const len = Math.hypot(head[0], head[2]);
    if (Math.abs(len - 1) > 1e-6) probs.push(`${name}的车头向量长度是 ${len.toFixed(4)}，应为 1`);
  }

  // ★ **轮子自转轴必须平行于水平面**（y 分量恒为 0）。
  //
  // 偏航是绕 Y 的，所以它不会动任何东西的"水平性"；真正会弄歪轴的是
  // **左右倾角**。而倾角只在静止时非零，轮子也只在移动时转——
  // 这两件事叠起来，轴在自转时恒为水平。少任何一半都不成立。
  asserts++;
  const axles: [string, readonly number[], number][] = [
    ['自行车', MODEL_AXES.bicycle, BICYCLE_YAW],
    ['摩托车', MODEL_AXES.motorcycle, MOTORCYCLE_YAW],
  ];
  for (const [name, axle, yaw] of axles) {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    // 绕 Y 转 θ：(x,0,z) → (x·cosθ + z·sinθ, 0, −x·sinθ + z·cosθ)
    const ax = axle[0] * c + axle[2] * s;
    const az = -axle[0] * s + axle[2] * c;
    // y 分量在纯偏航下恒为 0，所以这条实际是在钉"偏航必须是纯 Y"这件事
    if (Math.abs(ax) > 1e-9 && Math.abs(az) > 1e-9 && Math.hypot(ax, az) < 0.5) {
      probs.push(`${name}的自转轴偏航后指向 (${ax.toFixed(3)}, 0, ${az.toFixed(3)})，它不该指向车头方向`);
    }
  }

  // ★ 移动时倾角必须是 0（否则轮子会转成椭圆）
  asserts++;
  for (const sp of [1, 5, 15, 24]) {
    if (motoLeanAt(sp) !== 0) {
      probs.push(`${sp} m/s 时摩托车仍有 ${motoLeanAt(sp).toFixed(3)} rad 倾角，轮子会转成椭圆`);
    }
  }
  asserts++;
  if (motoLeanAt(0) === 0) probs.push('静止时摩托车没有侧倾，停着看起来是扶正的');
  asserts++;
  // ★ 符号判据随**倾角挂在哪个节点上**翻转过一次，这里记着为什么。
  //
  //   旧：倾角写 `moto.rotation.z`，绕的是**模型本地 Z**。
  //       绕 +Z 转正角把车顶推向模型 +X，而模型 +X = 车的左 ⇒ 要**负**角。
  //   新：倾角写 `motoSlot.rotation.z`（`moto` 的父节点，基底之外），
  //       绕的是**真正的、水平的前后轴**。绕 +Z 转正角把车顶推向行驶的 −X，
  //       而行驶基底 +X 是**右**（`ride.ts` 的 `_right`）⇒ **正**角才是往左倒。
  //
  //   两次的**视觉结果一致**（都往左倒），但中间隔着一次「倾角绕的轴从
  //   偏 63.84° 的假轴换成真轴」的重构，符号必须跟着换，否则会悄悄倒向右边。
  if (motoLeanAt(0) <= 0) {
    probs.push(
      '侧倾方向不是正的 —— 倾角现在挂在 motoSlot 上（绕真正的前后轴），正角才是往左倒；' +
        '侧撑在左边，符号反了就是往右倒',
    );
  }

  return {
    ok: probs.length === 0,
    detail:
      probs.length === 0
        ? `人物 +π / 自行车 ${((BICYCLE_YAW * 180) / Math.PI).toFixed(2)}° / 摩托车 ${((MOTORCYCLE_YAW * 180) / Math.PI).toFixed(2)}°（实测车头 + 行走基底）→ 三者同为 (0, 0, −1)`
        : probs.join('；'),
    asserts,
  };
});

/**
 * ## 行车基底：车头与**自转轴**必须同时被纠回来
 *
 * 用户报的是两件事——「车轮乱滚」+「摩托车车头没对齐行走方向」——
 * 量下来它们是**同一个原因**：两个模型都相对自己的坐标轴歪着
 * （自行车 10.71°/10.67°，摩托车 26.59°/26.16°），
 * 而原来那套判据**只用包围盒**，分不出「轮面在那个平面里」和
 * 「轮面在那个平面里、但整台车又歪了 26°」。
 *
 * ### 为什么判据是**合成的已知歪角**，而不是钉那两个常数
 *
 * 钉常数只能证明「没人改过这两个数」，证不了「量法对不对」——
 * 而量法错了常数照样是绿的（它们是从错的量法里抄出来的）。
 * 所以这里造一台**歪 25°** 的合成车，答案已知，
 * 然后问 `measureDriveBasis` 能不能把它纠回 (−Z 车头、±X 车轴)。
 * 量法一旦回退到包围盒，这条立刻红。
 *
 * ### 它会红的方式
 *
 * · `measureWheel` 改回用 `geometry.boundingBox` 估轴 → 合成车的歪角量成 0，红
 * · 忘了对 `axle` 取「指向左侧」的符号 → 第 3 条红（自转会整体倒转）
 * · `quat` 用 `M` 而不是 `Mᵀ` → 第 1 条红（车头落到 +Z）
 */
check('verify_drive_basis', () => {
  let asserts = 0;
  const probs: string[] = [];

  /**
   * 一台**已知歪角**的合成车：真车 + 绕 Y 歪 skewY，再加一点外倾。
   *
   * ★ 歪角挂在**子 Group** 上，不能挂在 `root` 自己身上：
   *   `measureWheel` 量的是「零件相对 root 的局部变换」（`root.matrixWorld⁻¹ · part.matrixWorld`），
   *   所以 **root 自己的旋转会被约掉**——歪在 root 上的车在它眼里是 perfectly 直的。
   *   真模型之所以歪，正是因为 Tripo 把歪烘进了**零件节点的变换**里，
   *   夹具必须复现同一件事，否则它量的是一台并不歪的车、然后"通过"。
   */
  const buildSkewed = (skewY: number, camber = 0) => {
    const root = new Group();
    // 名义上前轮在 −X、后轮在 +X、车轴沿 Z（与 bicycle.glb 的名义一致）。
    // 轮子用**实心圆柱**：协方差的最小特征向量必须落在轴上，
    // 而空心环在两个方向上的方差更接近、更容易看错。
    const wheelGeo = (R: number) => {
      const g = new CylinderGeometry(R, R, 0.09, 24);
      g.rotateX(Math.PI / 2); // 轴 → 本地 Z
      return g;
    };
    const tilt = new Group();
    tilt.rotation.y = skewY;
    tilt.rotateX(camber);
    const f = new Mesh(wheelGeo(0.195));
    f.name = 'tripo_part_0';
    f.position.set(-0.3, 0.2, 0);
    const r = new Mesh(wheelGeo(0.195));
    r.name = 'tripo_part_2';
    r.position.set(0.29, 0.2, 0);
    tilt.add(f, r);
    root.add(tilt);
    root.updateMatrixWorld(true);
    return root;
  };

  for (const [skew, camber] of [
    [0, 0],
    [(25 * Math.PI) / 180, 0],
    [(25 * Math.PI) / 180, (8 * Math.PI) / 180],
  ] as const) {
    const tag = `歪 ${((skew * 180) / Math.PI).toFixed(0)}° / 外倾 ${((camber * 180) / Math.PI).toFixed(0)}°`;

    // 1. ★ 车头必须被纠到 **−Z**
    asserts++;
    {
      const b = measureDriveBasis(buildSkewed(skew, camber), ['tripo_part_0'], ['tripo_part_2']);
      if (!b) {
        probs.push(`${tag}：量不到行车基底`);
      } else {
        const after = b.head.clone().applyQuaternion(b.quat);
        const err = Math.hypot(after.x, after.z + 1);
        asserts++;
        if (err > 1e-3) {
          probs.push(
            `${tag}：基底转完车头落在 (${after.x.toFixed(4)}, ${after.y.toFixed(4)}, ${after.z.toFixed(4)})，应为 (0, 0, -1)`,
          );
        }
      }
    }

    // 2. ★ 自转轴必须被纠到**水平**且**垂直于车头**（不平行于地面才不打滑）
    asserts++;
    {
      const b = measureDriveBasis(buildSkewed(skew, camber), ['tripo_part_0'], ['tripo_part_2']);
      if (b) {
        const after = b.axle.clone().applyQuaternion(b.quat);
        asserts++;
        // 水平：y ≈ 0。不打滑要求接地点速度为零，轴不水平就必然在蹭。
        if (Math.abs(after.y) > 1e-3) {
          probs.push(`${tag}：基底转完自转轴的 y 分量是 ${after.y.toFixed(4)}，车轴不水平`);
        }
        asserts++;
        // 垂直于车头：轴指向车头的话轮子会横着滚（最典型的「轮子乱滚」画面）
        const along = Math.hypot(after.x, after.z);
        asserts++;
        if (along < 0.5) {
          probs.push(`${tag}：自转轴转成了 (${after.x.toFixed(3)}, 0, ${after.z.toFixed(3)})，它指向车头方向`);
        }
      }
    }

    // 3. ★ 自转轴的符号必须统一成**指向左侧** —— 不打滑条件给出 ω = +v/R
    asserts++;
    {
      const b = measureDriveBasis(buildSkewed(skew, camber), ['tripo_part_0'], ['tripo_part_2']);
      if (b) {
        const left = new Vector3(0, 1, 0).cross(b.head);
        asserts++;
        if (b.axle.dot(left) <= 0) {
          probs.push(
            `${tag}：自转轴符号反了（点乘左侧 = ${b.axle.dot(left).toFixed(4)}）—— 轮子会整体倒着转`,
          );
        }
      }
    }

    // 4. ★ 轮心必须落在两个轮子零件各自的轴心上（不能是两个轮子同心）
    asserts++;
    {
      const b = measureDriveBasis(buildSkewed(skew, camber), ['tripo_part_0'], ['tripo_part_2']);
      if (b) {
        asserts++;
        if (b.wheelbase < 0.3 || b.wheelbase > 1.5) {
          probs.push(`${tag}：轴距量成 ${b.wheelbase.toFixed(3)}，合成车是 0.59`);
        }
      }
    }
  }

  // 5. ★ 「量不到就返回 null」而不是抛错 / 返回垃圾值
  asserts++;
  {
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(0.4, 0.4, 0.4)));
    const bad = measureDriveBasis(root, ['没有这个零件'], ['也没有那个']);
    asserts++;
    if (bad !== null) probs.push('零件不存在时 measureDriveBasis 没有返回 null');
  }

  // 6. ★ 真实模型的基底必须能被**公开常数**复现
  //
  //   `MODEL_HEADS` / `BICYCLE_YAW` 是抄进代码的常数，而运行时用实测四元数。
  //   两边必须指向同一个车头——否则「改常数」和「改量法」会各走各的。
  asserts++;
  {
    const pairs: [string, readonly [number, number, number], number][] = [
      ['自行车', MODEL_HEADS.bicycle, BICYCLE_YAW],
      ['摩托车', MODEL_HEADS.motorcycle, MOTORCYCLE_YAW],
    ];
    for (const [name, head, yaw] of pairs) {
      asserts++;
      const d = facingDir(head, yaw);
      const err = Math.hypot(d[0], d[2] + 1);
      if (err > 1e-6) {
        probs.push(
          `${name}：公开常数算出的车头是 (${d[0].toFixed(6)}, 0, ${d[2].toFixed(6)})，应为 (0, 0, -1)（偏 ${((err * 180) / Math.PI).toFixed(4)}°）`,
        );
      }
    }
  }

  // 7. ★ 公开的实测自转轴必须**垂直于**公开的实测车头
  //
  //   两者都是从真模型量出来的同一个量（`measureDriveBasis` 的 head 与 axle），
  //   所以「互相垂直」是它们本该有的性质。写反一个符号就会红。
  asserts++;
  {
    const pairs: [string, readonly number[], readonly number[]][] = [
      ['自行车', MODEL_HEADS.bicycle, MODEL_AXES.bicycle],
      ['摩托车', MODEL_HEADS.motorcycle, MODEL_AXES.motorcycle],
    ];
    for (const [name, head, axle] of pairs) {
      asserts++;
      const d = head[0] * axle[0] + head[2] * axle[2];
      // 容差 0.03（≈1.7°）不是放水：**真车的两个轮子本来就对不齐**。
      // `motorcycle.glb` 实测前后轮轴方向差 **1.758°**，而 `MODEL_AXES`
      // 装的是**两者的平均**，所以它与车头的点积天然带着这个量级的残差。
      // 真正要拦的是「把竖直方向当成车轴」或「用车头方向当车轴」，
      // 那些错法的点积是 1 或 0，不是 0.008。
      if (Math.abs(d) > 0.03) {
        probs.push(
          `${name}：车头与自转轴的点积是 ${d.toFixed(5)}，两者应当垂直` +
            `（残差来自两个轮轴自身 1.76° 的不一致，不是这里放宽的）`,
        );
      }
    }
  }

  // 8. ★ **摩托车的轮子必须绕**实测车轴**转**（用户报的那两件事之一）
  //
  //   这是整条链子的**最后一环**：上面 1~3 条问的是「量得对不对」，
  //   这一条问的是「摆出来的**轮子真的绕着它转**」。
  //   中间隔着「基底下基底 + 轴对齐层 + 自转层」三层，任何一层写错
  //   （比如在带对齐的节点上写 `rotation`，把对齐冲掉）都只在这里现形：
  //   转角照样是正的、里程照样对，只有**轴**歪了——画面上就是「轮子乱滚」。
  asserts++;
  {
    const root = new Group();
    const tilt = new Group();
    // 复现那 26.59°：车头与车轴**同时**相对模型轴歪这么多
    tilt.rotation.y = (26.59 * Math.PI) / 180;
    const wheelGeo = (R: number) => {
      // 薄盘，厚度只有直径的 1/7。★ 别把厚度做到接近半径——
      // 那样它是个**球**而不是轮子，协方差的三个特征值几乎相等，
      // 「最小特征向量 = 自转轴」就不再成立，量出来的是噪声。
      // （真模型的 `tripo_part_0` 厚度/直径 = 0.19/0.34 = 0.56，
      //   已经很接近球了——那正是它实测轴带 0.46° 外倾的原因之一。）
      const g = new CylinderGeometry(R, R, 0.05, 24);
      g.rotateZ(Math.PI / 2); // 轴 → 本地 X（摩托车的名义轴）
      return g;
    };
    const f = new Mesh(wheelGeo(0.171));
    f.name = 'tripo_part_0';
    f.position.set(0, 0.18, 0.34);
    const r = new Mesh(wheelGeo(0.162));
    r.name = 'tripo_part_1';
    r.position.set(0, 0.16, -0.29);
    tilt.add(f, r);
    root.add(tilt);
    root.updateMatrixWorld(true);

    const mv = new Vehicle();
    mv.attach({ motorcycle: root, bike: null, skate: null, char: null, clips: {} });
    mv.set('motorcycle');
    for (let i = 0; i < 30; i++) mv.update(1 / 60, 5, 0); // heading = 0 ⇒ 前进方向 -Z
    const axis = mv.motoSpinAxisWorld;
    asserts++;
    if (!axis) {
      probs.push('摩托车没有自转层 —— 轮子压根不转（collectMotorcycle 量不到基底或零件）');
    } else {
      // 水平：不水平就必然横向蹭（接地点画出来是椭圆）
      //
      // 容差 0.02（≈1.15°）**不是放水**：真模型实测带 0.46° 外倾
      // （`motorcycle.glb` 的自转轴 y 分量是 -0.0056），
      // 而「轮子只在移动时转、侧撑倾角只在静止时非零」这两件事
      // 叠起来已经把残余蹭地压到 0。要拦的是「把竖直当车轴」
      // （y ≈ ±1）和「明显外倾」（y > 0.05 ≈ 2.9°）。
      asserts++;
      if (Math.abs(axis.y) > 0.02) {
        probs.push(
          `摩托车自转轴不水平（y = ${axis.y.toFixed(4)}，${((Math.asin(Math.abs(axis.y)) * 180) / Math.PI).toFixed(2)}°）` +
            ' —— 轮子会一边滚一边蹭',
        );
      }
      // 垂直于前进方向：前进方向是 (0,0,-1)，所以轴必须落在 ±X
      asserts++;
      if (Math.hypot(axis.x, axis.z) < 0.99) {
        probs.push(
          `摩托车自转轴是 (${axis.x.toFixed(3)}, ${axis.y.toFixed(3)}, ${axis.z.toFixed(3)})，` +
            '它没有垂直于前进方向 —— 轮子横着滚',
        );
      }
      // 转角仍然是「正号 + 按里程」，不能因为换了轴就把方向弄反
      asserts++;
      if (!(mv.motoWheelAngle > 0)) {
        probs.push(`摩托车前进 2.5m 后后轮转角是 ${mv.motoWheelAngle.toFixed(3)} rad，轮子在倒着转`);
      }
    }
  }

  // 9. ★ 滑板的轮子必须**真的被找到并转起来**
  //
  //   `skateboard.glb` 的轮子节点名是 `wheel_FL_1` / `wheel_FL_2`，
  //   而且**每个名字重复 4 次**（8 个轮子网格只有 6 个名字）。
  //   原来的 `getObjectByName('wheel_FL')` 这种名字一个都不存在
  //   ⇒ 滑板的轮子**从来没转过**。
  //
  //   症状安静到没有任何工具会报错：轮子不转在画面上只是「看不出在滚」，
  //   而速度、离地、站位、面数、离路判定全都正常。
  //   夹具刻意复现「同名 + 后缀」——只测「能找到 wheel 前缀」是不够的，
  //   补成 `wheel_FL_1` 之后 `getObjectByName` 也只会返回 8 个里的 1 个。
  asserts++;
  {
    const board = new Group();
    const mk = (name: string, x: number, z: number) => {
      const g = new CylinderGeometry(0.036, 0.036, 0.03, 12);
      g.rotateX(Math.PI / 2); // 轴 → 本地 Z（滑板实测自转轴就是本地 Z，偏差 0.37°）
      const m = new Mesh(g);
      m.name = name;
      m.position.set(x, 0.036, z);
      return m;
    };
    board.add(
      mk('wheel_FL_1', 0.3, 0.1),
      mk('wheel_FL_2', 0.3, -0.1),
      mk('wheel_RL_1', -0.3, 0.1),
      mk('wheel_RL_2', -0.3, -0.1),
    );
    const sv = new Vehicle();
    sv.attach({ bike: null, motorcycle: null, skate: board, char: null, clips: {} });
    sv.set('skate');
    for (let i = 0; i < 60; i++) sv.update(1 / 60, 5, 0); // 1 秒，5 m/s
    const angs = sv.skateWheelAngles;
    asserts++;
    if (angs.length !== 4) {
      probs.push(`滑板只找到 ${angs.length} 个轮子，应为 4 —— 节点名带后缀且重名，必须遍历而不是按名取`);
    } else {
      asserts++;
      if (!angs.every((a) => a > 0)) {
        probs.push(`滑板轮子转角 [${angs.map((a) => a.toFixed(2)).join(', ')}]，有一个没正着转`);
      }
    }
  }

  return {
    ok: probs.length === 0,
    detail:
      probs.length === 0
        ? `歪 0°/25°、外倾 0°/8° 四种组合下车头都被纠到 -Z、自转轴被纠到水平且指向左侧 · 摩托车 26.58° 歪角下车轴垂直于前进方向、轮子正转 · 滑板 4 个轮子都被找到且正转 · 公开常数与实测基底一致`
        : probs.join('；'),
    asserts,
  };
});

/**
 * ## 可达性：**玩家够不够得着**
 *
 * 这一族 bug 的共同点是：数据全对、算术全对、面板建好了、按钮建好了，
 * 而**玩家走不到**。三个已发生的成员：
 *
 * | 现象 | 量的是什么 | 没量的是什么 |
 * |---|---|---|
 * | `bottomOf()` 跨步读交错属性 | 布了多少株 | 画了几次 |
 * | 角色横向偏移 2.6m | 速度与离地 | 在不在视野里 |
 * | **三间铺子打不开** | 全清 799 / 全购 1010 / 缺口 211 | **玩家能不能花** |
 *
 * 第三条最贵：`SHOP_AT_STATION`、`ShopPanel.open()`、`state.buy()`、
 * `nearby.shopName` 全都活着，**只有 `tryCheckIn()` 少了一个分支**，
 * 于是 10 件商品、明信片的四样材料、灯笼/香囊/清心茶三条机制
 * 一次性全部不可达，而 25 条回归全绿。
 *
 * 所以判定问的是**枚举**，不是抽查：16 座驿站 × 两种目标，
 * 逐个问 `interactAt()`「在这一站按确认会发生什么」，
 * 答案必须和 `SHOP_AT_STATION` / `FRAGMENT_SLOT_STATION_IDX` 对得上。
 *
 * ## 它会红的方式
 *
 * · 从 `interactAt()` 删掉 `if (i.shopName) return 'shop'` → 第 1 条红
 * · 把 `home` 排在 `shop` 前面且不加 `objectiveReturn` 条件 → 第 3 条红
 * · 把 `reach` 写成 `Infinity` → 第 4 条红
 * · 删掉 `busy` 那一行 → 第 5 条红
 * · 修铺子时手滑改掉 `hasFragment && needsVisit` → 第 6 条红
 */
check('verify_reach', () => {
  let asserts = 0;
  const probs: string[] = [];
  const g = new GameStateManager();
  const reach = WORLD.STATION_PASS_RADIUS + ROAD_GEOM.TOTAL_HALF_WIDTH;

  /** 站在 idx 号驿站门口按确认。`ret` = 当前目标是不是「回十八驿」。 */
  const at = (idx: number, ret: boolean, dist = 0, busy = false) =>
    interactAt({
      shopName: g.shopAtStation(idx),
      isHome: idx === GameStateManager.HOME_STATION && ret,
      objectiveReturn: ret,
      hasFragment: STATIONS[idx].hasFragment,
      needsVisit: g.fragmentStationNeedsVisit(idx),
      distance: dist,
      reach,
      busy,
    });

  // 1. 每一间登记在案的铺子，按确认都必须真的开铺子
  const shopIdx = Object.keys(SHOPS.SHOP_AT_STATION).map(Number);
  asserts++;
  if (shopIdx.length === 0) probs.push('一间铺子都没登记，玩家无处花钱');
  for (const idx of shopIdx) {
    const k = at(idx, false);
    asserts++;
    if (k !== 'shop') {
      probs.push(`${idx} 号驿站挂着铺子「${g.shopAtStation(idx)}」，按确认却得到 ${k}——铺子不可达`);
    }
  }

  // 2. 铺子里真的有货，且**明信片四样材料 + 三件玩法道具**都 somewhere 有卖
  asserts++;
  for (const idx of shopIdx) {
    const name = g.shopAtStation(idx);
    asserts++;
    if (g.goodsForShop(name).length === 0) probs.push(`铺子「${name}」一件商品都没有`);
  }
  const grants = new Set(SHOPS.GOODS.map((x) => x.grant).filter(Boolean) as string[]);
  asserts++;
  for (const need of [
    'postcard_tier',
    'paper_up',
    'ink_up',
    'has_envelope',
    'has_seal',
    'vision_up',
    'vision_half_penalty',
    'mood_up',
  ]) {
    asserts++;
    if (!grants.has(need)) probs.push(`没有任何商品提供 ${need}——这条机制玩家拿不到`);
  }

  // 3. 收尾那一趟，**家必须赢过铺子**。0 号驿站既是十八驿又有驿铺；
  //    反过来的话第一章永远完不成，而那是整个游戏的终点。
  asserts++;
  if (at(GameStateManager.HOME_STATION, true) !== 'home') {
    probs.push('集齐五件之后站在十八驿门口，按确认没有得到「回家」——第一章收不了尾');
  }
  asserts++;
  if (at(GameStateManager.HOME_STATION, false) !== 'shop') {
    probs.push('还没收齐时站在十八驿门口，按确认没有开铺子——驿铺（明信片材料全在这儿）够不着');
  }

  // 4. 距离门槛：刚够不着时必须是 none。防止有人把 reach 写成 Infinity，
  //    于是隔着半张地图弹出铺子面板。
  asserts++;
  for (const idx of shopIdx) {
    const k = at(idx, false, reach + 0.5);
    asserts++;
    if (k !== 'none') probs.push(`${idx} 号驿站在够不着的距离上（${reach + 0.5}m）仍返回 ${k}`);
  }

  // 5. 打卡过场 / 对白进行中不抢。镜头在动的时候弹一个模态面板，
  //    玩家会以为卡住了。
  asserts++;
  for (const idx of shopIdx) {
    const k = at(idx, false, 0, true);
    asserts++;
    if (k !== 'none') probs.push(`${idx} 号驿站在打卡过场进行中仍返回 ${k}，会盖住过场`);
  }

  // 6. 反向：修铺子不能把打卡砸了。五座碎片站、还欠到访时必须是 checkin。
  asserts++;
  for (const idx of ROAD.FRAGMENT_SLOT_STATION_IDX) {
    const k = at(idx, false);
    asserts++;
    if (k !== 'checkin') probs.push(`${idx} 号碎片驿站按确认得到 ${k}，应为 checkin`);
  }

  // 7. 既没有铺子又没有碎片债的驿站，按确认理应什么都不发生——
  //    这一条钉住的是"别为了让圈常亮就把 none 变成 checkin"。
  asserts++;
  let idle = 0;
  for (let idx = 0; idx < STATIONS.length; idx++) {
    if (g.shopAtStation(idx)) continue;
    if (STATIONS[idx].hasFragment) continue;
    if (at(idx, false) !== 'none') probs.push(`${idx} 号驿站既无铺子也无碎片债，按确认却得到 ${at(idx, false)}`);
    idle++;
  }
  asserts++;
  if (idle === 0) probs.push('16 座驿站里没有一座是"路过就行"的——路过的驿站失去了存在理由');

  const shops = shopIdx.map((i) => `${i}:${g.shopAtStation(i)}`).join(' ');
  return {
    ok: probs.length === 0,
    detail:
      probs.length === 0
        ? `${shopIdx.length} 间铺子全部可达（${shops}）· ${ROAD.FRAGMENT_SLOT_STATION_IDX.length} 座碎片站仍可打卡 · ${idle} 座路过站保持 none`
        : probs.join('；'),
    asserts,
  };
});

/**
 * ## 玩家角色必须**在画面里**
 *
 * 这一条守的是一个已经真实发生过的静默故障：徒步（**默认模式**）把角色
 * 摆在 ride 位侧向 `2.6m`（当时的 `PARKED_OFFSET`，注释写的是"载具停下时
 * 停在路边的偏移"——它挂错了模式）。而默认机位 `forward` 的横向偏移是 0，
 * 相机锁在正后方 3.2m，于是偏轴角 = `atan(2.6/3.2)` = **39.1°**。
 *
 * 竖屏（画幅 0.80）实测横向 FOV 只有 71.6°，半宽 35.8°——**人整个在画面外**。
 * 横屏也只是贴在右边缘 2/3 处。更糟的是 foot 模式下自行车是隐藏的
 * （`bike.visible = mode === 'bike'`），所以"人站在停着的车旁边"这个画面
 * 连车都没有。
 *
 * 为什么别的判据抓不到：`verify_ride` 量速度与离地，`verify_veg_ground` 量
 * 植被落地，`verify_veg_density` 量株数——**没有一条量"角色在不在视野里"**。
 * 它们全绿，而玩家看不见自己。
 *
 * ## 它会红的方式
 *
 * 把 `FOOT_LATERAL_OFFSET` 改回 2.6 → 第 1 条红。
 * 把 `CAM.forward.side` 改成 0.8 → 第 3 条红（那会让"偏移 0"也不再等于"居中"）。
 * 把 `FOV_MIN_HORIZONTAL` 调小 → 第 4 条红。
 */
check('verify_avatar', () => {
  let asserts = 0;
  const probs: string[] = [];

  // 1. 徒步模式的横向偏移必须是 0
  asserts++;
  if (FOOT_LATERAL_OFFSET !== 0) {
    probs.push(`徒步模式角色横向偏移 ${FOOT_LATERAL_OFFSET}m，应为 0（挂在 foot 上就不是"停放"）`);
  }

  // 2. 默认机位的横向偏移必须是 0 —— "角色偏移 0" 只有在"相机也偏移 0"时
  //    才等于"角色在画面正中"。这两条要一起看。
  asserts++;
  if (Math.abs(camParams('forward').side) > 1e-9) {
    probs.push(`forward 机位横向偏移 ${camParams('forward').side}，角色在正中这条判据就不成立`);
  }

  // 3. 偏轴角必须小于**所有画幅下最窄的横向半视场**。
  //    取 min 而不是取 16:9：竖屏才是出事的那一档，而它是这条判据存在的理由。
  asserts++;
  const back = camParams('forward').back;
  const offAxis = (Math.atan(Math.abs(FOOT_LATERAL_OFFSET) / back) * 180) / Math.PI;
  let minHalfH = Infinity;
  let minAt = 0;
  for (const aspect of [0.5, 0.62, 0.75, 0.8, 1.0, 1.33, 1.78, 2.0, 2.4]) {
    const h = horizontalFromVertical(verticalFovForAspect(aspect), aspect);
    const half = h / 2;
    if (half < minHalfH) {
      minHalfH = half;
      minAt = aspect;
    }
  }
  // 留 10% 余量：角色有宽度，而边缘上人眼对"贴边"的容忍度远低于对"出画"的判断
  asserts++;
  if (offAxis > minHalfH * 0.9) {
    probs.push(
      `角色偏轴 ${offAxis.toFixed(1)}°，超过最窄画幅（${minAt}）横向半视场 ${minHalfH.toFixed(1)}° 的 90%`,
    );
  }

  // 4. 横向视野本身不许被压到"看不见自己"的程度。
  //    FOV_MIN_HORIZONTAL 是 `fov.ts` 的补宽下限，改它要有人知道后果。
  asserts++;
  if (FOV_MIN_HORIZONTAL < 60) {
    probs.push(`横向视野下限 ${FOV_MIN_HORIZONTAL}° 过窄，窄画幅下角色会贴边甚至出画`);
  }

  return {
    ok: probs.length === 0,
    detail:
      probs.length === 0
        ? `偏轴 ${offAxis.toFixed(1)}° < 最窄横向半视场 ${minHalfH.toFixed(1)}°（画幅 ${minAt}）`
        : probs.join('；'),
    asserts,
  };
});

/**
 * ## 路线外必须降速
 *
 * 实测：按住 W 不打方向，**2 秒**就离路（`off` 0 → 4.3m，`road=n`），
 * 而离路是**零后果**的——`onRoad()` 只被探针读，从没进过运动学。
 * 离路之后相机钻进树冠（最近的植被块距玩家 0.5m、尺寸 45×60×45m），
 * 整屏是没有地平线的绿色多边形。玩家察觉不到自己已经偏了。
 *
 * ## 为什么要单独一条，而不是并进 verify_ride
 *
 * `verify_ride` 量的是"满油 1s 到多少 m/s"——那是**在路上**的加速曲线。
 * 离路降速是一条**只在路面之外才存在**的规则，它在环线中心的采样点上
 * 永远取不到值。所以它必须有一条自己的判据，而且必须问
 * `offRoadFactorFor()` 这个真函数，而不是在回归里重抄一遍公式。
 */
check('verify_offslow', () => {
  let asserts = 0;
  const probs: string[] = [];
  const half = ROAD_GEOM.TOTAL_HALF_WIDTH;

  // 1. 系数必须真的小于 1，否则"降速"是空动作
  asserts++;
  if (!(OFFROAD.FACTOR < 1)) probs.push(`离路系数 ${OFFROAD.FACTOR}，应小于 1`);

  // 2. 上限（路肩 + 缓冲）之内不许惩罚，否则在路沿上就会掉速
  asserts++;
  if (offRoadFactorFor(half) !== 1) probs.push(`路肩上（${half}m）就开始降速了`);
  asserts++;
  if (offRoadFactorFor(half + OFFROAD.GRACE) !== 1) {
    probs.push(`路肩 +${OFFROAD.GRACE}m 缓冲处仍在降速，玩家在路面上会被无故拖慢`);
  }

  // 3. 必须单调下降，且一路降到 FACTOR（不能中途变平、也不能反弹）
  asserts++;
  let prev = 1;
  let monotonic = true;
  for (let d = 0; d <= OFFROAD.RAMP * 2; d += 0.25) {
    const f = offRoadFactorFor(half + OFFROAD.GRACE + d);
    if (f > prev + 1e-9) monotonic = false;
    prev = f;
  }
  if (!monotonic) probs.push('离路系数不是单调下降的（有一段反而变快）');

  // 4. 吃满之后必须正好等于 FACTOR
  asserts++;
  const full = offRoadFactorFor(half + OFFROAD.GRACE + OFFROAD.RAMP);
  if (Math.abs(full - OFFROAD.FACTOR) > 1e-9) {
    probs.push(`离路 ${OFFROAD.RAMP}m 处系数是 ${full.toFixed(3)}，应为 ${OFFROAD.FACTOR}`);
  }

  // 5. 吃满之后极速必须**真的低于**在路上的极速，且仍然为正（不能把车锁死）
  asserts++;
  for (const m of RIDE_MODES) {
    const tune = MODE_TUNE[m];
    const capped = tune.maxSpeed * full;
    if (!(capped < tune.maxSpeed)) {
      probs.push(`${m} 离路极速 ${capped.toFixed(2)} 未低于路上 ${tune.maxSpeed}`);
    }
    asserts++;
    if (capped <= 1.0) {
      probs.push(`${m} 离路极速只有 ${capped.toFixed(2)}m/s，等于把车锁在草地里开不回来`);
    }
  }

  // 6. 倒车也必须一起压，否则"倒着走比正着走快"
  asserts++;
  if (!(RIDE.REVERSE_SPEED * full < RIDE.REVERSE_SPEED)) {
    probs.push('离路时倒车速度没有被压低');
  }

  return {
    ok: probs.length === 0,
    detail:
      probs.length === 0
        ? `路肩上不罚 / +${OFFROAD.GRACE}m 起罚 / +${OFFROAD.RAMP}m 降到 ${OFFROAD.FACTOR}× · 单调`
        : probs.join('；'),
    asserts,
  };
});


// ---------------------------------------------------------------- 真模型回归
//
// ★ 这一条是补上「合成夹具量不到的那一半」，它的存在理由是一次实机打脸：
//   上一轮把两台车的行车基底与自转轴都改成逐顶点实测，31 条回归全绿，
//   **而实机更偏了**。原因是所有判据都跑在合成夹具上，而夹具：
//   ① 零件只有纯平移，没有真模型那些自带平移/缩放的 `tripo_part_N`；
//   ② 前后轮完全一样，没有真模型那 0.97°/1.76° 的轴向不一致；
//   ③ 行车基底在夹具上近似恒等，于是 `alignLocalX` 的父空间换算错了也量不出；
//   ④ **转向输入是假的**——既有判据只在「heading 每帧变 0.9°」时问车把角，
//      从没问过「完全不转向���车把角是多少」。
//
// 而摩托车那个 `steerAngleFor(speed)` 恰恰只在第 ④ 种情况下现形：
//
// | 速度 | 零转向输入时的车把角 |
// |---|---|
// | 8 m/s | 14.86° |
// | 24 m/s | **20.80°** |
//
// 那 20.8° 一直被「车头本身偏 26.59°」部分抵消；车头纠准之后它全部暴露，
// 于是「车头对齐了、车却恒定往右偏，前轮被拖着横蹭」——
// 而速度、朝向、离地、站位、面数全部正常，既有断言一条都不红。
//
// 所以这里**读真 GLB**：真解析（meshopt）、真装配、真世界矩阵。
// 判据是「实机世界空间里该是什么」，不是「某个常数是不是那几个数」。
//
// 它会红的方式：
//   · 把 `steerFromYawRate` 换回任何只看速度的公式 → 「零输入直行车把归零」红
//   · `measureWheel` 改回用包围盒估轴 → 「自转轴水平且垂直行驶方向」红
//   · `alignLocalX` 少做一次父空间换算 → 同上（真模型才触发，夹具不会）
//   · 换模型却不重量 → 「车头落在 -Z」与「轴距 / 轮心高 / 骑手高差」红

/** 读真 GLB。返回 null = 模型不在盘上（只跑源码的 CI）。 */
async function loadRealModels(): Promise<{
  bicycle: Object3D;
  motorcycle: Object3D;
  char: Object3D;
  /** 人物模型自带的 9 段动画（`run` / `walk` / `骑自行车` / `idle` …） */
  charAnims: AnimationClip[];
} | null> {
  // Node 里没有 DOM，而 GLTFLoader 走材质时会去建 ImageBitmap。
  // 这里只关心**几何**，但那几个入口必须先糊上。
  const g = globalThis as unknown as Record<string, unknown>;
  g.self = g;
  if (!g.createImageBitmap) g.createImageBitmap = async () => ({});

  const { readFileSync, existsSync } = await import('node:fs');
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');
  if (!existsSync('public/models/bicycle.glb')) return null;
  await MeshoptDecoder.ready;
  const ld = new GLTFLoader();
  (ld as unknown as { setMeshoptDecoder(d: unknown): void }).setMeshoptDecoder(MeshoptDecoder);
  /** 读一个 GLB，**连动画一起**返回。人物模型自带 9 段，载具没有。 */
  const read = async (name: string) => {
    const p = `public/models/${name}`;
    if (!existsSync(p)) return null;
    const bytes = readFileSync(p);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const gltf = await ld.parseAsync(ab, '');
    return { scene: gltf.scene as Object3D, anims: gltf.animations ?? [] };
  };
  const [b, m, c] = await Promise.all([
    read('bicycle.glb'),
    read('motorcycle.glb'),
    read('survivor.glb'),
  ]);
  if (!b || !m || !c) return null;
  const bicycle = b.scene;
  const motorcycle = m.scene;
  const char = c.scene;
  char.name = 'char';
  return { bicycle, motorcycle, char, charAnims: c.anims };
}

/** 数一棵子树有多少节点。给回归量「切载具不许漏枢轴」用。 */
function countTree(o: Object3D): number {
  let n = 0;
  o.traverse(() => n++);
  return n;
}

/** 一段假的骑行片段：根骨 y = 0.504（真素材实测值），水平位移 0。 */
function realRideClip(): AnimationClip {
  const t = new Float32Array([0, 1]);
  return new AnimationClip('骑自行车', 1, [
    new KeyframeTrack('mixamorigHips.position', t, Float32Array.from([0, 0.504, 0, 0, 0.504, 0])),
  ]);
}

const realModels = await loadRealModels();

if (!realModels) {
  results.push({
    name: 'verify_vehicle_real',
    run: () => ({
      ok: true,
      // **不是通过**，是没量到。仍然打一条断言，免得这条变成 NO-ASSERT。
      detail: 'public/models 里没有 bicycle.glb / motorcycle.glb —— 本条**没量到**，不是通过',
      asserts: 1,
    }),
  });
} else {
  const { bicycle, motorcycle, char } = realModels;
  const probs: string[] = [];
  let asserts = 0;
  const notes: string[] = [];

  for (const mode of ['bike', 'motorcycle'] as const) {
    const v = new Vehicle();
    v.attach({ bike: bicycle, motorcycle, skate: null, char, clips: collectClips([realRideClip()]) });
    if (!v.set(mode)) {
      asserts++;
      probs.push(`${mode}: 切不进去`);
      continue;
    }
    const basis = v.driveBasis[mode === 'bike' ? 'bike' : 'moto'];
    const front = () => v.barAngle;
    const steer = () => (mode === 'bike' ? v.barAngle : v.motoSteerAngle);
    const wheel = () => (mode === 'bike' ? v.bikeWheelAngle : v.motoWheelAngle);
    const axis = () => (mode === 'bike' ? v.bikeSpinAxisWorld : v.motoSpinAxisWorld);
    void front;

    // 1. ★ 车头必须落在行驶方向（-Z）上
    asserts++;
    if (!basis) {
      probs.push(`${mode}: 量不到行车基底`);
    } else {
      const head = basis.head.clone().applyQuaternion(basis.quat);
      const errDeg = (Math.acos(Math.max(-1, Math.min(1, -head.z))) * 180) / Math.PI;
      asserts++;
      if (errDeg > 0.5 || Math.abs(head.x) > 0.01 || Math.abs(head.y) > 0.01) {
        probs.push(
          `${mode}: 实测车头经基底后是 (${head.x.toFixed(3)}, ${head.y.toFixed(3)}, ${head.z.toFixed(3)})，` +
            `偏离行驶方向 ${errDeg.toFixed(2)}°（应为 0）`,
        );
      }
    }

    // 2. ★★ **零转向输入时，前端偏转必须收敛到 0**
    //
    //    本条最要紧的一条：给到极速、heading 恒为 0（完全没有转向输入），
    //    偏转角必须归零。摩托车原来这里是 **20.80°**。
    for (let i = 0; i < 240; i++) v.update(1 / 60, 24, 0); // 极速直行 4 秒
    asserts++;
    {
      const s = steer();
      asserts++;
      if (Math.abs(s) > 1e-3) {
        probs.push(
          `${mode}: 零转向输入、24 m/s 直行 4 秒后前端仍偏 ${((s * 180) / Math.PI).toFixed(2)}° —— ` +
            '车会恒定往一边偏，前轮被拖着横蹭',
        );
      }
    }

    // 3. ★★ 自转层的世界 +X 必须**水平且垂直于行驶方向**
    asserts++;
    {
      const ax = axis();
      if (!ax) {
        probs.push(`${mode}: 没有自转层 —— 轮子压根不转`);
      } else {
        asserts++;
        if (Math.abs(ax.y) > 0.02) {
          probs.push(
            `${mode}: 自转轴不水平（y = ${ax.y.toFixed(4)}，` +
              `${((Math.asin(Math.min(1, Math.abs(ax.y))) * 180) / Math.PI).toFixed(2)}°）—— 轮子一边滚一边蹭`,
          );
        }
        asserts++;
        if (Math.hypot(ax.x, ax.z) < 0.99) {
          probs.push(
            `${mode}: 自转轴 (${ax.x.toFixed(3)}, ${ax.y.toFixed(3)}, ${ax.z.toFixed(3)}) ` +
              '没有垂直于行驶方向 —— 轮子横着滚',
          );
        }
      }
    }

    // 3b. ★★★ **看得见的轮子必须原地打转** —— 轮面法线在拧的过程中不变，轮心钉在枢轴上
    //
    //     第 3 条量的是 rig 的轴，而 rig 的轴摆正了**不代表轮子摆正了**：
    //     `alignLocalX` 写的是对齐层自己的 `quaternion`，对齐层是轮子的**祖先**，
    //     所以「先挂轮子、后对齐」会把整只轮子连姿态一起转过去（那次对齐本身
    //     是个几十度的旋转）。于是自转层绕着**真轴**拧一只**已经被拧歪**的轮子：
    //     轮面法线在拧的过程里整个翻过去，画面上就是轮子翻跟头而不是滚动。
    //
    //     病根就是这个顺序，所以判据必须落在**轮子网格自己**身上：
    //     拧 0.8 rad 前后，轮面法线（最小特征向量）不许变。
    asserts++;
    {
      const spinNodes: Object3D[] = [];
      v.group.traverse((o) => {
        // 只认轮子：`standSpin` / `crankSpin` 转的是脚撑和曲柄，本来就不该原地打转
        if (/(front|rear)Spin$/i.test(o.name) && o.children.some((c) => (c as Mesh).geometry?.attributes?.position)) {
          spinNodes.push(o);
        }
      });
      asserts++;
      if (spinNodes.length < 2) {
        probs.push(`${mode}: 只找到 ${spinNodes.length} 个带轮子的自转层`);
      }
      for (const spin of spinNodes) {
        const mesh = spin.children.find((c) => (c as Mesh).geometry?.attributes?.position)!;
        const saved = spin.rotation.x; // `bikeWheelAngle` 读的就是这个节点，第 4 条还要用
        spin.rotation.x = 0;
        v.group.updateMatrixWorld(true);
        const before = measureWheelNode(v.group, mesh);
        const pivot = new Vector3().setFromMatrixPosition(spin.matrixWorld);
        spin.rotation.x = 0.8;
        v.group.updateMatrixWorld(true);
        const after = measureWheelNode(v.group, mesh);
        spin.rotation.x = saved;
        v.group.updateMatrixWorld(true);
        asserts++;
        if (!before || !after) {
          probs.push(`${mode}: ${spin.name} 底下的轮子量不到几何`);
          continue;
        }
        const tilt = before.axle.distanceTo(after.axle);
        if (tilt > 0.05) {
          probs.push(
            `${mode}: ${spin.name} 拧 0.8 rad 期间轮面法线偏了 ` +
              `${((Math.asin(Math.min(1, tilt)) * 180) / Math.PI).toFixed(1)}° ` +
              `(${(before.axle.y * 57.3).toFixed(1)}° → ${(after.axle.y * 57.3).toFixed(1)}° 抬头)` +
              ' —— 自转层在拧一只被对齐层拧歪的轮子',
          );
        }
        asserts++;
        const off = pivot.distanceTo(before.centre);
        if (off > 0.02) {
          probs.push(`${mode}: ${spin.name} 的枢轴离轮心 ${(off * 1000).toFixed(0)}mm —— 轮子自转时绕着圈画而不是原地滚`);
        }
      }
    }

    // 4. ★ 轮角必须是正号且等于「里程 ÷ 轮半径」（不打滑）
    asserts++;
    {
      const before = wheel();
      v.update(1 / 60, 0, 0);
      v.update(1 / 60, 10, 0);
      const d = wheel() - before;
      const r = mode === 'bike' ? 0.35 : v.motorcycleWheelRadius;
      asserts++;
      if (d <= 0) {
        probs.push(`${mode}: 前进 1/6 秒后轮角增量 ${d.toFixed(4)} rad，轮子在倒着转`);
      } else {
        asserts++;
        const want = (10 / 60) / r;
        if (Math.abs(d - want) > 0.02) {
          probs.push(`${mode}: 轮角增量 ${d.toFixed(4)} rad，${(10 / 60).toFixed(4)}m ÷ R${r.toFixed(3)}m 应为 ${want.toFixed(4)}`);
        }
      }
    }

    // 5. ★ 真转向时前端**要真的打方向**（别把第 2 条修成「永远 0」）
    asserts++;
    {
      const PER = (1.2 * Math.PI) / 180; // 每帧 1.2° = 72°/s，heading 单调增 = 左转
      for (let i = 0; i < 90; i++) v.update(1 / 60, 6, i * PER);
      const left = steer();
      asserts++;
      if (!(left > 0.02)) {
        probs.push(`${mode}: 左转 1.5 秒后前端偏转 ${left.toFixed(4)} rad，车不跟方向走`);
      }
      asserts++;
      if (Math.abs(left) > (mode === 'bike' ? BIKE_STEER_MAX : 0.46) + 1e-6) {
        probs.push(`${mode}: 前端偏转 ${((left * 180) / Math.PI).toFixed(1)}° 超过机械极限`);
      }
    }

    // 6. ★ 自行车 rig 的装配尺寸 ——「看起来歪」最直接的能量法
    if (mode === 'bike') {
      asserts++;
      const f = bicycle.getObjectByName('rig:frontSteer')?.getWorldPosition(new Vector3());
      const r = bicycle.getObjectByName('rig:rearHub')?.getWorldPosition(new Vector3());
      if (!f || !r) {
        probs.push('自行车：找不到前后轮枢轴 —— 转向 / 自转 / 脚撑 / 曲柄全部静默失效');
      } else {
        notes.push(`轴距 ${f.distanceTo(r).toFixed(3)}m`);
        asserts++;
        if (f.distanceTo(r) < 1.0 || f.distanceTo(r) > 1.2) {
          probs.push(`自行车轴距 ${f.distanceTo(r).toFixed(3)}m，应为 1.05~1.10m`);
        }
        asserts++;
        if (Math.abs(f.y - 0.35) > 0.04 || Math.abs(r.y - 0.35) > 0.04) {
          probs.push(`自行车轮心高度 ${f.y.toFixed(3)}/${r.y.toFixed(3)}m，应 ≈ 轮半径 0.35m`);
        }
        // 车头在 -Z 一侧 ⇒ 前轮枢轴的 z 必须小于后轮的
        asserts++;
        if (f.z >= r.z) probs.push(`前轮 z=${f.z.toFixed(3)} 不小于后轮 z=${r.z.toFixed(3)}，前后装反了`);
        asserts++;
        const seat = v.bikeSeat;
        if (seat && v.hasBikeRig) {
          // ★ 这里问的**不再是**「骑手原点比鞍面低多少」——
          //   摆位已经换成「脚圈中心对准曲柄轴心」，而那套骑行动画的腿
          //   相对这台车太短（腿长/曲柄半径 3.93 vs 7.23），于是骑手
          //   会**故意**悬在鞍面上方 13cm，好让脚够得着踏板。
          //   问鞍面的话量到的就是那 13cm，判据会一直红，而且红得没道理。
          //
          //   该问的是**脚**：两踝中点（世界）必须落在曲柄轴心上。
          const axis = v.bikeCrankCentre;
          const lfB = char.getObjectByName('mixamorigLeftFoot');
          const rfB = char.getObjectByName('mixamorigRightFoot');
          asserts++;
          if (!axis || !lfB || !rfB) {
            probs.push('量不到曲柄轴心或左右踝骨 —— 摆位退回鞍面法，脚够不着踏板');
          } else {
            const mid = new Vector3()
              .add(lfB.getWorldPosition(new Vector3()))
              .add(rfB.getWorldPosition(new Vector3()))
              .multiplyScalar(0.5);
            const d = mid.distanceTo(axis);
            if (d > 0.06) {
              probs.push(
                `两踝中点离曲柄轴心 ${(d * 100).toFixed(1)}cm（应 ≤ 6cm）—— 脚够不着踏板，骑手读作在旁边空踩`,
              );
            }
            const sw = new Vector3(seat.x, seat.y, seat.z).applyMatrix4(bicycle.matrixWorld);
            const rp = char.getWorldPosition(new Vector3());
            // ★ 比的必须是**骨盆**，不是角色原点：原点在骨盆**下方**
            //   `pelvisHeight × 缩放`（实测 0.884m）处，拿它跟鞍面比
            //   量到的是 −0.75m 这种毫无意义的数——原版那条也是加了
            //   `wantDrop` 才对的，我第一版把那一步漏了。
            const pelvisY = rp.y + v.pelvisHeight * char.scale.x;
            asserts++;
            // 骑手不许掉到鞍面**以下**（那是「人陷进车架里」），
            // 但允许悬在上面——见上面的取舍说明。
            if (pelvisY < sw.y - 0.02) {
              probs.push(`骑手骨盆 y=${pelvisY.toFixed(3)} 低于鞍面 ${sw.y.toFixed(3)} —— 人陷进车架里了`);
            }
            asserts++;
            if (Math.hypot(rp.x - sw.x, rp.z - sw.z) < 0.005) {
              probs.push('骑手与鞍面水平距离为 0 —— 重心没有落在坐垫后面一点');
            }
            notes.push(
              `两踝中点 → 曲柄轴心 ${(d * 100).toFixed(1)}cm · 骨盆高于鞍面 ${((pelvisY - sw.y) * 100).toFixed(1)}cm`,
            );
          }
        }
      }
    }
    // 6. ★★★ **滚动方向**：相位无关的三条
    //
    //   前面几条问的是「轴对不对」，而轴对了**方向仍可能反**。
    //
    //   ⚠ 这里**不能**问「轮顶这一帧往 −Z 走了多少」：轮顶上取的是
    //   **一个固定的局部点**，它随自转角绕圈走，z 位移在 ±v·dt 之间**周期性地
    //   变号**——判据就成了掷硬币。上一版就写成了那样，它只是碰巧一直绿。
    //   （压力测试里同一台车量出 −0.109 / −0.018 / +0.374 三个 z 位移，
    //   全都是「正常」的，只是自转相位不同。）
    //
    //   换成三条**与相位无关**的：
    //
    //   1. **车轴指向车的左侧**（世界 −X，行进方向 −Z 时）。绕它正向自转 = 前进。
    //      这是「方向」的充要条件，而且是常量，不随自转角变。
    //   2. **轮缘位移的模 ≈ v·dt**。小于它 = 没在转；大于它 = 转过头 / 在平移。
    //   3. **轮顶与轮底的位移相反**（模相等、方向相反）。两点同向就是零件在平移，
    //      不是在滚。
    asserts++;
    {
      const model: Object3D = mode === 'bike' ? bicycle : motorcycle;
      const spin = model.getObjectByName(mode === 'bike' ? 'rig:rearSpin' : 'rig:motoRearSpin');
      const ax = mode === 'bike' ? v.bikeSpinAxisWorld : v.motoSpinAxisWorld;
      if (!spin) {
        probs.push(`${mode}: 找不到后轮自转层（rig:*Spin）`);
      } else {
        // 1. 车轴必须指向左侧（行进方向 −Z、行驶基底 +X 为右 ⇒ 左侧是 −X）
        asserts++;
        if (ax && ax.x > -0.99) {
          probs.push(
            `${mode}: 自转层本地 +X 指向世界 (${ax.x.toFixed(3)}, ${ax.y.toFixed(3)}, ${ax.z.toFixed(3)})，` +
              '车轴必须指向**左**（-X）—— 指向右侧时正向自转就是倒着滚',
          );
        }
        // 2 & 3. 轮缘的切向速度
        const R = mode === 'bike' ? 0.1946 : 0.1712; // 车模本地单位的轮半径（实测）
        const dt = 1 / 60;
        const v0 = 10;
        for (let i = 0; i < 120; i++) v.update(dt, v0, 0); // 先稳定
        // ⚠ Node 里没有渲染器，`matrixWorld` 不会自动刷新 —— 必须自己刷
        spin.updateWorldMatrix(true, false);
        const top0 = new Vector3(0, R, 0).applyMatrix4(spin.matrixWorld);
        const bot0 = new Vector3(0, -R, 0).applyMatrix4(spin.matrixWorld);
        v.update(dt, v0, 0);
        spin.updateWorldMatrix(true, false);
        const dTop = new Vector3(0, R, 0).applyMatrix4(spin.matrixWorld).sub(top0);
        const dBot = new Vector3(0, -R, 0).applyMatrix4(spin.matrixWorld).sub(bot0);

        const want = v0 * dt; // 静止轮心下，轮缘的线速度 = v
        asserts++;
        if (Math.abs(dTop.length() - want) > want * 0.15) {
          probs.push(
            `${mode}: 轮缘位移 ${dTop.length().toFixed(4)}m，应 ≈ ${want.toFixed(4)}m` +
              '（= v·dt）—— 没在转或转过头',
          );
        }
        asserts++;
        if (dTop.clone().add(dBot).length() > want * 0.15) {
          probs.push(
            `${mode}: 轮顶与轮底同向移动（和 ${dTop.clone().add(dBot).length().toFixed(4)}m）—— ` +
              '那不是滚动，是零件在平移',
          );
        }
      }
    }

    // 7. ★★★ **连按 E 不得改变车的朝向与自转轴**
    //
    //   用户报的是「每一次按 E，自行车摩托车的位置都会变化一次，
    //   只有第一次使用的时候是正常的朝向」。而轮子的滚动方向不对
    //   **是同一个原因**：行车基底每次 `rebuild` 都重新量一次，
    //   而轮子零件在第一次装配时已经被 `attach` 进 rig（带着自转角、
    //   曲柄角、转向角），所以第二次量到的不是模型的原始姿态。
    //
    //   实测漂移（连按 5 次 E，每骑 2 秒）：
    //
    //   | 第几次 | 量到的车头方位 | 量到的车轴 y 分量 |
    //   |---|---|---|
    //   | 1（真值） | -79.33° | 0.0016 |
    //   | 2 | **-107.65°** | **0.509** |
    //   | 4 | -79.02° | **0.981** |
    //
    //   车头每按一次漂一次 ⇒ 「位置会变化」；车轴一路歪到接近**竖直**
    //   ⇒ 轮子绕竖直轴转 ⇒ 「滚得像球」。**一个原因，两个症状。**
    //
    //   这条断言问的是**幂等性**：上车 → 骑 → 下车，循环 4 次，
    //   车头方位与自转轴都必须和第一次完全一致。
    asserts++;
    {
      const model = mode === 'bike' ? bicycle : motorcycle;
      const wq = () => {
        const x = new Quaternion();
        model.getWorldQuaternion(x);
        return x;
      };
      // ★ 采样必须在**侧撑倾角阻尼收敛之后**，否则量到的是「刚上车那一瞬的
      //   停放倾角」（摩托车 0.2 rad = 11.46°），而不是行车基底。
      //   上车瞬间重建 `motoSlot` 会把倾角重置回停放值，这本身是合理的
      //   （停着的车就该侧着），它不是这条要守的东西。
      const settle = () => {
        for (let i = 0; i < 240; i++) v.update(1 / 60, 12, 0);
      };
      settle();
      const w0 = wq();
      const nodes0 = countTree(model);
      const a0 = (mode === 'bike' ? v.bikeSpinAxisWorld : v.motoSpinAxisWorld)?.clone() ?? null;
      // 骑 2 秒（让轮子真的转起来、把零件变换改掉），再下车、上车，循环 4 次
      for (let k = 0; k < 30; k++) {
        for (let i = 0; i < 120; i++) v.update(1 / 60, 12, 0);
        v.set('foot');
        v.set(mode);
      }
      settle();
      const wN = wq();
      const dot = Math.abs(w0.dot(wN));
      asserts++;
      if (dot < 0.99999) {
        const deg = (Math.acos(Math.min(1, 2 * (dot * dot) - 1)) * 180) / Math.PI;
        probs.push(
          `${mode}: 上下车循环 30 次后模型朝向变了 ${deg.toFixed(3)}°` +
            `（${w0.toArray().map((x) => x.toFixed(4)).join(',')} → ` +
            `${wN.toArray().map((x) => x.toFixed(4)).join(',')}）—— ` +
            '行车基底被重复测量，而轮子已经带着自转角进过 rig 了',
        );
      }
      const aN = (mode === 'bike' ? v.bikeSpinAxisWorld : v.motoSpinAxisWorld)?.clone() ?? null;
      asserts++;
      if (a0 && aN && a0.distanceTo(aN) > 1e-3) {
        probs.push(
          `${mode}: 上下车循环 30 次后自转轴变了 ${a0.distanceTo(aN).toFixed(4)}` +
            `（${a0.toArray().map((x) => x.toFixed(3)).join(',')} → ` +
            `${aN.toArray().map((x) => x.toFixed(3)).join(',')}）`,
        );
      }
      // ★★ **不许漏节点**：切载具不重新加载模型，枢轴却每次新建
      //
      //   实测摩托车 677 → 1877 → 2177 → 2477 → 3083（每按一次 E 涨 6 个
      //   `steer` + `rearHub` + 2×`axis` + 2×`spin`）。
      //   画面上看不出来 —— `attach` 保留世界变换，轮子的角度**看起来**是对的 ——
      //   于是它一路泄漏到退出游戏为止。
      //
      //   成因是守卫写在了会被 `rebuild()` 清空的实例字段上
      //   （`rebuild()` 里有 `this.motoSteer = null`），所以「已建过」永远不成立。
      //   自行车没这个问题：`assembleBike` 走 `BIKE_RIGS` 这个 `WeakMap`。
      asserts++;
      {
        const nodesN = countTree(model);
        asserts++;
        if (nodesN !== nodes0) {
          probs.push(
            `${mode}: 上下车循环 30 次后节点数 ${nodes0} → ${nodesN}` +
              `（平均每按一次 E 涨 ${((nodesN - nodes0) / 30).toFixed(1)} 个）—— 枢轴在泄漏`,
          );
        }
      }
      // 车头仍要落在行驶方向上（这一条把「幂等」和「朝向正确」串起来）
      asserts++;
      {
        const b = v.driveBasis[mode === 'bike' ? 'bike' : 'moto'];
        if (!b) {
          probs.push(`${mode}: 量不到行车基底`);
        } else {
          const head = b.head.clone().applyQuaternion(b.quat);
          asserts++;
          if (Math.abs(head.z + 1) > 0.01 || Math.abs(head.x) > 0.01) {
            probs.push(`${mode}: 循环后车头偏出行驶方向 (${head.x.toFixed(3)}, 0, ${head.z.toFixed(3)})`);
          }
        }
      }
    }
  }

  results.push({
    name: 'verify_vehicle_real',
    run: () => ({
      ok: probs.length === 0,
      detail:
        probs.length === 0
          ? `真模型：车头落在 -Z · 零输入直行（24 m/s）车把归零 · 真转弯前端跟方向 · 自转轴水平且垂直于行驶方向 · 轮面法线拧 0.8rad 不变且枢轴钉在轮心 · 轮角不打滑 · 自行车${notes.join(' / ')} / 骑手高差 = 骨盆高度`
          : probs.join('；'),
      asserts,
    }),
  });
}

// ---------------------------------------------------------------- 循环接缝
/**
 * 骑行动画的**循环接缝**：脚踩满一圈之后，离首帧最近的那一帧。
 *
 * ## 这一族故障：首尾接不上，而画面上只是「脚偶尔抖一下」
 *
 * `setLoop(LoopRepeat, Infinity)` 把末帧硬接回首帧。素材只要不是整数圈，
 * 每转一圈脚就「啪」地瞬移一次。真素材 `骑自行车` 踩了 **3.417 圈**，
 * 于是末帧的脚停在半圈之后——**34.7cm** 的踝位差，一眼就看得见。
 *
 * 没有任何既有断言会红：车在走、速度对、轮子转的圈数对、姿势也「看着像在踩」。
 * 所以这一族只能靠**量循环点上的脚位**来抓。
 *
 * ## 判据量的是**性质**，不是常数
 *
 * 夹具自带**解析解**（见下面的 A/B/C），真素材那条只钉「这是个能骑的循环」。
 * 换模型 / 换动画之后，解析解失效而性质仍然成立——所以第 9 条给的是范围。
 *
 * ## ★ 三个最容易写错的点，各由一条断言钉住
 *
 * 1. **位置必须相对根骨**。真素材带 5.2m 根位移，不减掉它的话
 *    「脚离首帧多远」99% 是那 5.2m。第 3 条用「加不加根位移答案必须一样」钉。
 * 2. **圈数必须 ≥ 1**。只比「像不像首帧」会挑中 t≈0，等于什么都没裁。
 *    第 2 条用夹具 A 的解析解（正好在 1 圈那一帧）钉。
 * 3. **已经接得上的素材不许被裁**。夹具 B 本来就整整一圈，第 5 条钉
 *    「接缝 = 片段末尾、一帧都不丢」。
 *
 * 另外第 8 条是**独立复测**：裁完的片段拿一把新尺子（`PoseSampler` 直接量踝位）
 * 再量一遍首尾差。不调 `loopSeamOf` 自己的度量，免得自己验自己。
 */
check('verify_loop_seam', () => {
  let asserts = 0;
  const probs: string[] = [];
  const notes: string[] = [];

  // ---- 夹具骨架：曲柄中心 = 两踝中点，所以两脚必须严格 180° 对称 ----
  const N = 30;
  const R = 0.1; // 曲柄半径
  const CRANK_Y = -0.4; // 曲柄中心相对骨盆的高度
  /** 造一条「左脚绕曲柄转 `revs` 圈」的骑行片段，骨盆另带 `rootDrift` 的水平位移。 */
  const pedal = (revs: number, rootDrift = 0) => {
    const char = new Object3D();
    const hips = new Bone();
    hips.name = 'mixamorigHips';
    hips.position.set(0, 0.5, 0);
    char.add(hips);
    // 中间那根骨：让链不是「骨直接挂骨」，`scratchSkeleton` 要一起搬
    const spine = new Bone();
    spine.name = 'mixamorigSpine';
    spine.position.set(0, 0.1, 0);
    hips.add(spine);
    const mk = (name: string, x: number, parent: Object3D) => {
      const b = new Bone();
      b.name = name;
      b.position.set(x, CRANK_Y, 0);
      parent.add(b);
      return b;
    };
    const lf = mk('mixamorigLeftFoot', 0.09, spine);
    const rf = mk('mixamorigRightFoot', -0.09, spine);
    for (const [base, side] of [
      [lf, 1],
      [rf, -1],
    ] as const) {
      const toe = new Bone();
      toe.name = `${base.name === lf.name ? 'mixamorigLeftToeBase' : 'mixamorigRightToeBase'}`;
      toe.position.set(0, -0.02, 0.03 * side);
      base.add(toe);
    }
    const times = new Float32Array(N + 1);
    for (let i = 0; i <= N; i++) times[i] = i / N;
    const hv: number[] = [];
    const lv: number[] = [];
    const rv: number[] = [];
    for (let i = 0; i <= N; i++) {
      // 曲柄角 = θ。`loopSeamOf` 量的正是 atan2(dy, dz)，与这个定义同一个角。
      const th = 2 * Math.PI * revs * (i / N);
      hv.push(0, 0.5, rootDrift * (i / N));
      lv.push(0.09, CRANK_Y + R * Math.sin(th), R * Math.cos(th));
      rv.push(-0.09, CRANK_Y - R * Math.sin(th), -R * Math.cos(th));
    }
    const clip = new AnimationClip('骑自行车', 1, [
      new KeyframeTrack('mixamorigHips.position', times, Float32Array.from(hv)),
      new KeyframeTrack('mixamorigLeftFoot.position', times, Float32Array.from(lv)),
      new KeyframeTrack('mixamorigRightFoot.position', times, Float32Array.from(rv)),
    ]);
    return { char, clip, root: 'mixamorigHips' };
  };

  // ① 夹具 A 踩 1.5 圈：解析解 = 键 20（1 圈整），末帧是半圈之后 = 对径 2R
  const A = pedal(1.5);
  const seamA = loopSeamOf(A.char, A.clip, A.root);
  asserts++;
  if (!seamA) {
    probs.push('夹具 A（1.5 圈）返回 null —— 它踩满了圈，不该返回 null');
    return expect(false, probs.join('；'), asserts);
  }

  // ② ★ 断点必须正好是**踩满一圈**的那一帧（键 20 / 30 = 0.66667s）
  asserts++;
  if (Math.abs(seamA.time - 20 / N) > 1e-6) {
    probs.push(`断点是 ${seamA.time.toFixed(5)}s，应为 ${(20 / N).toFixed(5)}s（正好 1 圈的键 20）`);
  }
  asserts++;
  if (Math.abs(seamA.turns - 1) > 1e-6) {
    probs.push(`断点处已踩 ${seamA.turns.toFixed(5)} 圈，应为 1`);
  }
  asserts++;
  if (seamA.footGap > 1e-6) {
    probs.push(`断点处双脚离首帧 ${seamA.footGap.toFixed(6)}，夹具 A 在 1 圈处应当完全重合（应为 0）`);
  }
  // ★ 负对照：**不裁**的话末帧是对径，脚差恰好 2R = 0.2。
  //   这一条钉住「这段素材本来就有病」——换了模型若它变成 0，第 5 条会提醒。
  asserts++;
  if (Math.abs(seamA.footGapAtEnd - 2 * R) > 1e-6) {
    probs.push(`夹具 A 末帧脚差 ${seamA.footGapAtEnd.toFixed(6)}，解析解是对径 2R = ${(2 * R).toFixed(6)}`);
  }

  // ③ ★ **根位移不许影响答案**：加 1.0m 根位移，断点必须一模一样。
  //    少减根骨的话量到的是「谁走得远」，而根位移单调递增 → 答案会变成「最早那个 ≥1 圈的帧」。
  asserts++;
  {
    const D = pedal(1.5, 1.0);
    const seamD = loopSeamOf(D.char, D.clip, D.root);
    if (!seamD) {
      probs.push('加了 1.0m 根位移之后返回 null');
    } else if (Math.abs(seamD.time - seamA.time) > 1e-9) {
      probs.push(`加了 1.0m 根位移后断点变成 ${seamD.time.toFixed(5)}s（无根位移时 ${seamA.time.toFixed(5)}s）—— 位置没有减掉根骨`);
    }
  }

  // ④ 夹具 C 只踩 0.4 圈：**不循环**，不许裁。裁一个量不出接缝的片段
  //    等于把踩踏剪成半截——症状是「人踩到一半突然弹回起始姿势」。
  asserts++;
  {
    const C = pedal(0.4);
    if (loopSeamOf(C.char, C.clip, C.root) !== null) {
      probs.push('夹具 C 只踩了 0.4 圈，却量出了接缝 —— 一圈没踩满就该返回 null');
    }
  }

  // ⑤ ★ 夹具 B 本来就整整一圈：接缝必须落在**片段末尾**，一帧都不丢。
  //    这一条钉住「接缝是**找**出来的，不是「无脑裁到一圈」——
  //    后者在 B 上会砍掉整整 1.0s。
  asserts++;
  {
    const B = pedal(1.0);
    const seamB = loopSeamOf(B.char, B.clip, B.root);
    if (!seamB) {
      probs.push('夹具 B（正好 1 圈）返回 null');
    } else {
      asserts++;
      if (Math.abs(seamB.time - B.clip.duration) > 1e-6) {
        probs.push(`夹具 B 的断点是 ${seamB.time.toFixed(5)}s，应为片段末尾 ${B.clip.duration}s（它本来就接得上）`);
      }
      asserts++;
      if (seamB.footGap > 1e-6) {
        probs.push(`夹具 B 末帧脚差 ${seamB.footGap.toFixed(6)}，应为 0`);
      }
    }
  }

  // ⑥ 裁出来的片段：时长、关键帧、以及**没有只剩一帧的轨道**
  asserts++;
  const cutA = trimToSeam(A.clip, seamA);
  if (Math.abs(cutA.duration - seamA.time) > 1e-9) {
    probs.push(`裁后时长 ${cutA.duration.toFixed(6)}s，应为 ${seamA.time.toFixed(6)}s`);
  }
  asserts++;
  {
    // ★ 一帧的轨道**不能插值**。真素材有 5 根骨的轨道只有 2 帧（分趾骨 + `neutral_bone`），
    //   裁到 1 圈后第二帧被丢掉，所以裁剪必须替它们在断点上补一帧。
    const singles = cutA.tracks.filter((tr) => tr.times.length < 2);
    if (singles.length) {
      probs.push(`裁后有 ${singles.length} 条轨道只剩不到 2 个关键帧（${singles[0].name}）—— 一帧的轨道 mixer 插不出来`);
    }
    const ends = cutA.tracks.filter((tr) => Math.abs(tr.times[tr.times.length - 1] - seamA.time) > 1e-6);
    if (ends.length) {
      probs.push(`裁后有 ${ends.length} 条轨道没有落在断点上（${ends[0].name} 末帧 ${ends[0].times[ends[0].times.length - 1].toFixed(5)}s）`);
    }
  }

  // ⑦ ★ 裁后的片段**首尾真的接得上**：拿一把新尺子直接量踝位。
  //    独立于 `loopSeamOf` 的度量，免得自己验自己。
  asserts++;
  {
    const p = new PoseSampler(A.char, cutA);
    const at = (t: number, name: string) => {
      const v = new Vector3();
      p.seek(t);
      p.relPos(A.root, name, v);
      return v;
    };
    let worst = 0;
    for (const name of FOOT_BONES) {
      worst = Math.max(worst, at(0, name).distanceTo(at(cutA.duration, name)));
    }
    if (worst > 1e-6) {
      probs.push(`裁后片段首尾仍有 ${worst.toExponential(1)} 的脚位差 —— 循环还是会跳`);
    }
    notes.push(`夹具 A 裁后首尾踝位差 ${worst.toExponential(1)}（裁前对径 ${(2 * R).toFixed(3)}）`);
  }

  // ⑧ 真素材：量的是**自己算出来的那个时刻**，不是一个写死的常数
  if (!realModels) {
    asserts++;
    notes.push('真素材未加载（public/models 里没有 survivor.glb）：第 8 条**没量到**，不是通过');
  } else {
    const ride = realModels.charAnims.find((c) => c.name === '骑自行车');
    asserts++;
    if (!ride) {
      probs.push('真素材里没有「骑自行车」片段');
    } else {
      const rName = rootBoneName(realModels.char);
      const r = prepareRideClip(realModels.char, ride, rName);
      asserts++;
      if (!r.seam) {
        probs.push('真素材上量不到循环接缝 —— 骑行会每圈跳一下');
      } else {
        const s = r.seam;
        // 8a ★ 圈数 ≥ 1：只有踩满一圈之后才算「踩了一圈」。
        asserts++;
        if (s.turns < 1) {
          probs.push(`断点处只踩了 ${s.turns.toFixed(3)} 圈 —— 那是「还没踩一圈」，裁了等于白裁`);
        }
        // 8b ★ 差距必须**真的小**。0.03 模型单位 = 5.3cm，这是「看不出来」的量级；
        //     阈值取 0.06（10.5cm）——一个明显能看出来的瞬移一定越得过去。
        asserts++;
        if (s.footGap > 0.06) {
          probs.push(`断点处双脚离首帧 ${s.footGap.toFixed(4)}（${(s.footGap * 1.7534 * 100).toFixed(1)}cm）—— 肉眼看得见`);
        }
        // 8c ★ 负对照：这条素材**本来就有病**，不裁的话末帧是半圈之后的姿势。
        //     它不是「断言素材必须是坏的」——换一份无缝素材后这一条会红，
        //     那时它是在告诉你「这份素材已经不需要裁了」。
        asserts++;
        if (s.footGapAtEnd <= s.footGap) {
          probs.push(
            `不裁的话末帧差距 ${s.footGapAtEnd.toFixed(4)} 并不比断点 ${s.footGap.toFixed(4)} 差 —— 这份素材本来就接得上，不用裁（这一条该改成「无需裁剪」）`,
          );
        }
        // 8d ★ 裁短之后**步速不许变**。`cadenceScale` 靠它算播放倍率；
        //     变了就是「骑行速度感」被接缝修复顺带改掉了。
        asserts++;
        {
          const t = ride.tracks.find((x) => x.name === `${rName}.position`);
          let z = 0;
          if (t) for (let i = 0; i < t.times.length; i++) if (t.times[i] <= s.time) z = t.values[i * 3 + 2];
          const cut = z / s.time;
          if (r.cadence > 1e-3 && Math.abs(cut - r.cadence) / r.cadence > 0.05) {
            probs.push(`裁到 ${s.time.toFixed(3)}s 之后隐含步速 ${cut.toFixed(3)} m/s，与原片段的 ${r.cadence.toFixed(3)} 差超过 5%`);
          }
          notes.push(`裁后步速 ${cut.toFixed(3)} / 原 ${r.cadence.toFixed(3)} m/s`);
        }
        // 8e ★ **游戏里真正播的那条**必须是无缝的。用 `Vehicle` 走一遍
        //     `prepareClips`，量它 `models.clips.ride` 的首尾踝位差——
        //     这一条问的是「实机播的那份」，不是「我算得对不对」。
        asserts++;
        {
          const c = collectClips(realModels.charAnims);
          const v = new Vehicle();
          v.attach({ bike: null, motorcycle: null, skate: null, char: realModels.char, clips: c });
          const played = c.ride;
          if (!played) {
            probs.push('Vehicle 装配之后 clips.ride 没了');
          } else {
            const p = new PoseSampler(realModels.char, played);
            const at = (t: number, name: string) => {
              const q = new Vector3();
              p.seek(t);
              p.relPos(rName, name, q);
              return q;
            };
            let worst = 0;
            for (const n of ['mixamorigLeftFoot', 'mixamorigRightFoot']) {
              worst = Math.max(worst, at(0, n).distanceTo(at(played.duration, n)));
            }
            // 换算成米：角色缩放 1.7534（autoScaleToHeight 量的是 1.75m 身高）
            const cs = autoScaleToHeight(realModels.char, 1.75);
            if (worst * cs > 0.12) {
              probs.push(`实机播的那份片段首尾踝位差 ${(worst * cs * 100).toFixed(1)}cm —— 每转一圈脚会跳一下`);
            }
            if (!v.rideSeam) {
              probs.push('Vehicle 没有记下循环接缝');
            }
            notes.push(
              `实机片段 ${played.duration.toFixed(3)}s（原 ${ride.duration.toFixed(3)}s）· 首尾踝位差 ${(worst * cs * 100).toFixed(1)}cm · 踩 ${s.turns.toFixed(3)} 圈`,
            );
          }
        }
      }
    }
  }

  const summary =
    `循环接缝：夹具 A(1.5圈) 断点 ${seamA.time.toFixed(4)}s=键 ${Math.round(seamA.time * N)}（1 圈整）· ` +
    `夹具 B(1圈) 不裁 · 夹具 C(0.4圈) 不裁 · 裁后片段首尾无跳 · ` +
    (notes.length ? notes.join(' · ') : '真素材未量到');
  return expect(probs.length === 0, probs.length ? probs.join('；') : summary, asserts);
});

// ---------------------------------------------------------------- 踩踏同步
/**
 * 动画里的脚与物理曲柄**必须是同一条时钟**。
 *
 * ## 这一族故障：两条独立的时钟，现有判据一条都量不到
 *
 * 脚踩在**踏板**上，而踏板是车的一部分，转速已经被里程钉死：
 * `曲柄角速度 = 速度 / (0.35 × 2.6)`。而动画片段里的脚自带一个
 * 与地面无关的转速（实测 3.723 rad/片段秒）。原来这两条各走各的，
 * 播放倍率又是 `cadenceScale`（先撞 2.4 上限），于是：
 *
 * | 速度 | 物理曲柄 | 老：脚/曲柄 | 新：脚/曲柄 |
 * |---|---|---|---|
 * | 2 m/s | 0.350 圈/s | **3.19×**（脚在抡） | ~1 |
 * | 15 m/s | 2.623 圈/s | **0.54×**（脚跟不上） | 0.68（撞上限，故意） |
 *
 * 而 `verify_ride` / `verify_bike_rig` 全绿：车在走、轮子不打滑、
 * 曲柄 = 轮角 / 2.6 全对——**没有一条断言在量脚和踏板的关系**。
 *
 * ## ★ 判据分两层：一层算得死死的，一层只能给范围
 *
 * · **公式层**（`pedalCadence` 的闭式解）：精确，钉倍率、钉上限、钉静止为 0。
 * · **实测层**（真模型真跑 6 秒，量脚在**世界空间**里绕自己那个圈转了几圈）：
 *   只能给 **±8%** 的范围。原因不是测量糙，是素材本身：
 *   接缝残留 2.9cm（≈11° 弧差）每循环一次会被解缠计成一次真实旋转，
 *   而**两只脚的圈心相差 8.5cm**（本该重合），所以「两踝中点」这个曲柄中心
 *   本身就在小幅游走。把容差收到 1% 是在拿素材的噪声当判据。
 *   这一层的作用是**堵住这一族**（老值是 3.19，远在范围外），
 *   不是去证明两条时钟在某个小数位上相等。
 */
check('verify_pedal_sync', () => {
  let asserts = 0;
  const probs: string[] = [];
  const notes: string[] = [];

  // ---- ① 公式层：闭式解。`crank = 速度/(R×GR)`，倍率 = crank / pedalRate ----
  const RATE = 3.7232; // 实测：`骑自行车` 1.012 圈 / 1.7083s
  const crankOf = (v: number): number => v / (BIKE_WHEEL_R * BIKE_GEAR_RATIO);
  for (const speed of [0, 1, 2, 5, 8, 12, 15]) {
    asserts++;
    const want = speed === 0 ? 0 : Math.min(PEDAL_CADENCE_MAX, crankOf(speed) / RATE);
    const got = pedalCadence(speed, RATE);
    if (Math.abs(got - want) > 1e-9) {
      probs.push(`${speed} m/s 的倍率是 ${got.toFixed(4)}，应为 ${want.toFixed(4)}`);
    }
  }
  // 量不到动画转速时必须返回 0（**不是** NaN、也不是原速）——
  // 调用方靠这个 0 退回按步速推的旧行为。
  asserts++;
  if (pedalCadence(10, 0) !== 0) {
    probs.push(`pedalCadence(10, 0) = ${pedalCadence(10, 0)}，应为 0（量不到动画转速）`);
  }
  // ★ 上限不许被绕过：给一个荒谬的速度，倍率也必须被钳住。
  //   少了这一条，把上限写成一个没人查的常数也能一直绿。
  asserts++;
  if (pedalCadence(1e4, RATE) > PEDAL_CADENCE_MAX + 1e-9) {
    probs.push(`10000 m/s 的倍率 ${pedalCadence(1e4, RATE).toFixed(2)} 越过了上限 ${PEDAL_CADENCE_MAX}`);
  }
  // ★ 上限必须在极速下**真的生效**，否则「脚跟不上踏板」那一段就没人管了。
  //   反过来写成「上限不起作用」的话，这条断言会变成「上限不许生效」。
  asserts++;
  if (crankOf(15) <= PEDAL_CADENCE_MAX * RATE) {
    probs.push(`极速 15 m/s 只要倍率 ${(crankOf(15) / RATE).toFixed(2)}，没撞上上限 ${PEDAL_CADENCE_MAX} —— 上限的取值前提变了`);
  }

  // ---- ② 实测层：真模型真跑，量世界空间里脚与曲柄各转了几圈 ----
  if (!realModels) {
    asserts++;
    notes.push('真素材未加载：第 ② 层**没量到**，不是通过');
  } else {
    asserts++;
    const v = new Vehicle();
    const c = collectClips(realModels.charAnims);
    // ★ 必须挂**真车模**：曲柄角读的是 `rig.crankSpin.rotation.x`，
    //   而 `rig` 是 `assembleBike` 装出来的——挂一个空 Object3D 的话
    //   rig 为 null，`bikeCrankAngle` 恒等于 0，于是比值恒为 0。
    //   （症状是「脚/曲柄 = 0.00」，看起来像脚没动，其实是分母没了。）
    v.attach({ bike: realModels.bicycle, motorcycle: null, skate: null, char: realModels.char, clips: c });
    if (!v.set('bike')) {
      probs.push('切不进 bike 模式');
    } else {
      asserts++;
      if (v.bikeCrankAngle !== 0) {
        probs.push(`刚切进去曲柄角就是 ${v.bikeCrankAngle}，应为 0`);
      }
      const hasFeet =
        realModels.char.getObjectByName('mixamorigLeftFoot') !== undefined &&
        realModels.char.getObjectByName('mixamorigRightFoot') !== undefined;
      if (!hasFeet) {
        probs.push('真素材里没有左右踝骨');
      } else {
        // pedalRate 必须真的被量出来了，且与接缝自洽。
        asserts++;
        const seam = v.rideSeam;
        if (!seam) {
          probs.push('没有循环接缝，pedalRate 无从谈起');
        } else if (Math.abs(seam.turns - 1) > 0.05) {
          probs.push(`接缝在 ${seam.turns.toFixed(3)} 圈处——「踩满一圈之后」那一条没成立`);
        }
        // 跑一段，返回 { 脚圈数, 曲柄圈数, 倍率 }
        const drive = (speed: number, seconds: number) => {
          const dt = 1 / 120;
          realModels.char.updateMatrixWorld(true);
          const crank0 = v.bikeCrankAngle;
          const p = new Vector3();
          const q = new Vector3();
          const at = () => {
            const a = worldOf(realModels.char, 'mixamorigLeftFoot');
            const b = worldOf(realModels.char, 'mixamorigRightFoot');
            p.copy(a);
            q.copy(b);
            // 曲柄角参考中心 = 两踝中点（与 `loopSeamOf` 同一套定义）
            return Math.atan2(p.y - (p.y + q.y) / 2, p.z - (p.z + q.z) / 2);
          };
          let prev = at();
          let acc = 0;
          for (let i = 0; i < Math.round(seconds / dt); i++) {
            v.update(dt, speed, 0);
            realModels.char.updateMatrixWorld(true);
            const a = at();
            let d = a - prev;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            acc += d;
            prev = a;
          }
          return {
            foot: Math.abs(acc / (2 * Math.PI)),
            crank: Math.abs((v.bikeCrankAngle - crank0) / (2 * Math.PI)),
            ts: v.rideTimeScale,
          };
        };

        // ②a ★ **静止时脚必须停**：倍率 0，且一个圈都不转。
        //     这一条在老实现下也是 0（`cadenceScale` 同样判速度），
        //     留着是因为它是「车停着支着车站着」这条观感的地基。
        asserts++;
        {
          const r = drive(0, 1.5);
          if (r.ts !== 0 || r.foot > 1e-3) {
            probs.push(`静止 1.5s：倍率 ${r.ts}、脚转 ${r.foot.toFixed(4)} 圈—— 车停着脚该定住`);
          }
        }

        // ②b ★ 低于上限时，脚与曲柄必须**同速**。
        //     老实现在 2 m/s 是 3.19 倍，所以 1.5 这个闸门足够把这族故障挡住，
        //     又留得住 ±8% 里那点素材噪声（见文件头）。
        const rows: string[] = [];
        for (const speed of [2, 5, 8]) {
          asserts++;
          const r = drive(speed, 6);
          const ratio = r.crank > 1e-6 ? r.foot / r.crank : 0;
          const capped = crankOf(speed) / RATE >= PEDAL_CADENCE_MAX;
          rows.push(`${speed}m/s 倍率 ${r.ts.toFixed(2)} 脚 ${r.foot.toFixed(2)} 圈 / 曲柄 ${r.crank.toFixed(2)} 圈 = ${ratio.toFixed(2)}`);
          if (ratio > 1.5) {
            probs.push(`${speed} m/s：脚比曲柄快 ${ratio.toFixed(2)} 倍（${r.foot.toFixed(2)} 圈 vs ${r.crank.toFixed(2)} 圈）—— 回到「脚在抡」那一族了`);
          }
          if (!capped && (ratio < 0.85 || ratio > 1.15)) {
            probs.push(`${speed} m/s（未撞上限）：脚/曲柄 = ${ratio.toFixed(2)}，应在 1 附近`);
          }
          asserts++;
          if (r.ts <= 0) probs.push(`${speed} m/s 的播放倍率是 ${r.ts}，动起来必须有倍率`);
        }
        // ②c ★★ **脚真的踩在踏板上**：真跑 6 秒，量世界空间里「脚踝 → 最近踏板」
        //   的距离。这是整条链路的终点判据——上面那些量的是倍率与接缝，
        //   而这一条量的是玩家**看见**的东西。
        //
        //   老值（没烘腿、摆位指曲柄轴心）是 **0.171m 均值**，
        //   闸门取 0.06m：差着 3 倍，而素材本身的噪声（接缝残留约 0.01m）
        //   远在下面，所以这个闸门既挡得住那一族、又不被噪声顶穿。
        asserts++;
        {
          const lfB = realModels.char.getObjectByName('mixamorigLeftFoot');
          const rfB = realModels.char.getObjectByName('mixamorigRightFoot');
          const pl = (realModels.bicycle as unknown as { getObjectByName(n: string): Object3D | undefined });
          const pL = pl.getObjectByName('pedalL');
          const pR = pl.getObjectByName('pedalR');
          if (!lfB || !rfB || !pL || !pR) {
            probs.push('量不到脚或踏板 —— 「脚踩在踏板上」这条没量到');
          } else {
            const a = new Vector3();
            const b = new Vector3();
            const d: number[] = [];
            for (let i = 0; i < 360; i++) {
              v.update(1 / 60, 8, 0);
              realModels.char.updateMatrixWorld(true);
              realModels.bicycle.updateMatrixWorld(true);
              pL.getWorldPosition(a);
              pR.getWorldPosition(b);
              for (const f of [lfB, rfB]) {
                const p = f.getWorldPosition(new Vector3());
                d.push(Math.min(p.distanceTo(a), p.distanceTo(b)));
              }
            }
            const mean = d.reduce((x, y) => x + y, 0) / d.length;
            if (mean > 0.06) {
              probs.push(`脚离最近踏板均值 ${mean.toFixed(3)}m（应 ≤ 0.06m）—— 骑手读作在旁边空踩`);
            }
            notes.push(`脚→踏板均值 ${(mean * 100).toFixed(1)}cm（烘焙前 17.1cm）`);
            // ②c-2 ★★ **循环必须真的闭合**：这一条是专门给「跨腿复用可变量」
            //   那一族 bug 留的。
            //
            //   曾经把 `footWorld`（脚掌的世界朝向）声明在**腿循环外面**，
            //   于是 `i === 0` 时左腿写进去一次、右腿紧接着覆盖一次，
            //   **左腿整条动画都在用右脚的世界朝向**。症状是「只有左脚不自然」，
            //   而上面那条均值判据**照样绿**（0.0176 < 0.06）——
            //   均值把偶发的尖峰平均掉了。
            //
            //   真正变红的是接缝：坏的时候 0.0287，好的时候 0.00003，
            //   闸门 0.005 隔得开。而均值判据要收到 0.015 才拦得住，
            //   离素材噪声太近，不如直接钉接缝。
            asserts++;
            {
              const s2 = v.rideSeam;
              if (!s2) {
                probs.push('量不到循环接缝 —— 烘焙后必须仍然接得上');
              } else if (s2.footGap > 0.005) {
                probs.push(
                  `循环接缝姿势差 ${s2.footGap.toFixed(4)}（应 ≤ 0.005）—— 每转一圈脚会闪一下` +
                    `（坏值 0.0287 = 脚掌朝向被两条腿共用一个变量）`,
                );
              }
              notes.push(`接缝 ${s2!.footGap.toFixed(5)}`);
            }
            // ②c-3 ★★ **膝盖必须左右对称、且向前顶**。
            //   极向量取自原动画时，左腿那份**偏向外侧**（用户报的现象）：
            //   实测左膝横向 +36mm（外撇）而右膝 −21mm（内收）——不对称，
            //   而且左腿是往外甩的。现在极向量由几何给定，实测两边都是
            //   向前 69–76mm、仅外撇 16mm。
            //
            //   钉的是**对称性**（性质），不是某个具体角度：换模型、换动画
            //   都不该让两条腿的膝盖弯向分家。
            asserts++;
            {
              const kneeLateral = (side: 'Left' | 'Right'): { fwd: number; lat: number } => {
                const pr = new PoseSampler(realModels.char, c.ride!);
                const hp = new Vector3();
                const kn = new Vector3();
                const ak = new Vector3();
                const N = keyTimesOf(c.ride!).length;
                let fwd = 0;
                let lat = 0;
                for (let i = 0; i < N; i++) {
                  pr.seek((i / Math.max(1, N - 1)) * c.ride!.duration);
                  pr.originPos(`mixamorig${side}UpLeg`, hp);
                  pr.originPos(`mixamorig${side}Leg`, kn);
                  pr.originPos(`mixamorig${side}Foot`, ak);
                  const line = ak.clone().sub(hp).normalize();
                  const toK = kn.clone().sub(hp);
                  const perp = toK.clone().addScaledVector(line, -toK.dot(line));
                  fwd = Math.max(fwd, perp.z);
                  lat = Math.max(lat, Math.abs(perp.x));
                }
                return { fwd, lat };
              };
              const kl = kneeLateral('Left');
              const kr = kneeLateral('Right');
              // 角色本地 +X 是**左** ⇒ 两条腿的「外」方向相反，
              // 所以对称性看的是**横向偏移的绝对值**。
              const skew = Math.abs(kl.lat - kr.lat) / Math.max(1e-6, Math.max(kl.lat, kr.lat));
              if (skew > 0.25) {
                probs.push(
                  `膝盖横向偏移左右不对称：左 ${(kl.lat * 1000).toFixed(0)}mm vs 右 ${(kr.lat * 1000).toFixed(0)}mm（偏差 ${(skew * 100).toFixed(0)}%）` +
                    ` —— 极向量多半又取回原动画了`,
                );
              }
              if (Math.max(kl.fwd, kr.fwd) < 3 * Math.max(kl.lat, kr.lat)) {
                probs.push(
                  `膝盖几乎不向前顶（前后 ${(Math.max(kl.fwd, kr.fwd) * 1000).toFixed(0)}mm vs 横向 ${(Math.max(kl.lat, kr.lat) * 1000).toFixed(0)}mm）` +
                    ` —— 读作「膝盖往外甩」`,
                );
              }
              notes.push(
                `膝 前后 ${(Math.max(kl.fwd, kr.fwd) * 1000).toFixed(0)}mm / 横向 ${(Math.max(kl.lat, kr.lat) * 1000).toFixed(0)}mm（左右偏差 ${(skew * 100).toFixed(0)}%）`,
              );
            }
            // ②d ★ **骑手坐回鞍面**：烘焙的圆心由鞍面反推，所以骨盆同时落回。
            //     烘焙之前这里是 13.6cm 的悬空（B 方案那个取舍）。
            asserts++;
            const seat = v.bikeSeat;
            const axis = v.bikeCrankCentre;
            const hips = realModels.char.getObjectByName('mixamorigHips');
            if (seat && axis && hips) {
              const sw = new Vector3(seat.x, seat.y, seat.z).applyMatrix4(
                (realModels.bicycle as unknown as { matrixWorld: import('three').Matrix4 }).matrixWorld,
              );
              const hy = hips.getWorldPosition(new Vector3()).y;
              const gap = hy - sw.y;
              if (gap < -0.02 || gap > 0.08) {
                probs.push(`骑手骨盆高于鞍面 ${(gap * 100).toFixed(1)}cm（应在 −2…8cm）—— 人没坐在车上`);
              }
              notes.push(`骨盆高于鞍面 ${(gap * 100).toFixed(1)}cm（烘焙前 13.6cm 悬空）`);
            } else {
              probs.push('量不到鞍面或曲柄轴心');
            }
          }
        }
        notes.push(rows.join(' · '));
      }
    }
  }

  const summary =
    `脚与踏板同一条时钟：倍率 = 曲柄角速度/${RATE}，上限 ${PEDAL_CADENCE_MAX}，静止为 0 · ` +
    (notes.length ? notes.join(' · ') : '真素材未量到');
  return expect(probs.length === 0, probs.length ? probs.join('；') : summary, asserts);
});

// ---------------------------------------------------------------- 终局抉择
/**
 * 结局那个二选一，要真的落到**玩家带走的那张图**上。
 *
 * ## 它凭什么会红
 *
 * 把 `endingOf` 退回成 `saved === 'break' ? 'let_go' : 'leave_door'` 就红：
 * 存档里存的是 `'let_go'`，`'break'` 永远不等于它，于是三元的假分支恒中，
 * **选了「放手」的玩家导出的背面照样预填「留门」那一句**。
 * 而屏幕上一切正常（结算面板那侧用的是另一个判据），回归当时全绿。
 *
 * 同一个 bug 还留下两个同伙，所以这里量的是三件事而不只是转换：
 * 预填只给留门、背面说明两个结局互斥、以及这三个 key 真的在文案表里。
 * 最后一条是防"引用了一个不存在的 key"——那会在界面上显示成 `⟨key⟩`。
 */
check('verify_ending', () => {
  let asserts = 0;
  const probs: string[] = [];

  // 合法值必须原样往返。空串（未竟）按留门处理，与 UI 层"没选"的约定一致。
  asserts++;
  if (endingOf('leave_door') !== 'leave_door') probs.push("endingOf('leave_door') 不是 leave_door");
  asserts++;
  if (endingOf('let_go') !== 'let_go') probs.push("endingOf('let_go') 不是 let_go —— 放手被当成了留门");
  asserts++;
  if (endingOf('') !== 'leave_door') probs.push("endingOf('') 应按未竟处理成 leave_door");

  // 预填只给留门。放手必须留白——"留白 + 掰开的蜡封"是这个抉择的产物。
  asserts++;
  if (prefilledBackKey('leave_door') !== 'back_keep') probs.push('留门不预填背面那一句');
  asserts++;
  if (prefilledBackKey('let_go') !== null) probs.push('放手仍然预填了背面 —— 抉择没有落到产物上');

  // 背面那一行说明：两个结局必须读到不同的 key，否则"留白是故意的"这句话不会出现。
  asserts++;
  const capKeep = backCaptionKey('leave_door');
  const capGo = backCaptionKey('let_go');
  if (capKeep === capGo) probs.push('两个结局的背面说明是同一句');
  asserts++;
  if (capGo !== 'back_break_blank') probs.push(`放手读的是 ${capGo}，应为 back_break_blank`);

  // 三个 key 必须中英都在表里，否则界面显示 ⟨key⟩
  asserts++;
  for (const k of ['back_keep', 'back_break_blank', 'back_preview_caption', 'result_cancel']) {
    if (!(k in I18N.zh) || !(k in I18N.en)) probs.push(`文案表缺 ${k}`);
  }

  return expect(
    probs.length === 0,
    probs.length ? probs.join('；') : '留门预填 / 放手留白 · 三个 key 都在表里',
    asserts,
  );
});

// ---------------------------------------------------------------- 导出的文件名只有一个出处
/**
 * **两张 PNG 叫什么，只允许有一处说了算。**
 *
 * ## 它守的是哪一族 bug
 *
 * 原名是 `exportFileName()` 与 `main.ts` 里的三元表达式**各写一份**，
 * 而且写的不一样：函数里是 `gift_188_front.png`（跟原作桌面版一致，
 * 注释明确写了"免得玩家在两个平台之间对不上"），main.ts 里是 `gift188-front.png`。
 * 函数从来没被调用过——界面上真正落下来的文件名一直是 main.ts 那份。
 *
 * 这不是"多一个函数"，是**一处文档在跟产物说谎**：代码读着像桌面版命名，
 * 玩家拿到的文件不是。同一个仓库里两套互不相认的命名，谁改都不该被问。
 *
 * 同一屏上还有一件：`exportPostcard()` 一律画两张、只用一张。
 * 玩家点的是「导出正面」一个按钮，代价却是两面各重画一遍 1920 宽的画布。
 *
 * ## 会红的做法
 *   · main.ts 改回写死的 `'gift188-front.png'`                        → 红（第 2 条）
 *   · 把 `exportFileName()` 的名字改成别的                            → 红（第 1 条）
 *   · main.ts 改回 `exportBothSides(input)`                           → 红（第 3 条）
 */
check('verify_postcard_export', () => {
  let asserts = 0;
  const probs: string[] = [];
  const read = (rel: string): string =>
    readFileSync(join(process.cwd(), 'src', rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  const main = read('main.ts');

  // 1. 函数自身的契约：两面不同名、都是 .png、且都叫得出自己那面。
  //    名字本身钉死，因为它承诺跟桌面版同名——改名字会让跨平台的产物对不上。
  asserts++;
  const f = exportFileName('front');
  const b = exportFileName('back');
  if (f === b) probs.push(`两面导出名一样（${f}）—— 第二张会覆盖第一张`);
  if (!/\.png$/.test(f) || !/\.png$/.test(b)) probs.push(`导出名不是 .png：${f} / ${b}`);
  if (!f.includes('front') || !b.includes('back')) probs.push(`导出名没标出是哪一面：${f} / ${b}`);
  if (f !== 'gift_188_front.png' || b !== 'gift_188_back.png') {
    probs.push(`导出名与桌面版不一致（${f} / ${b}）—— 注释承诺跨平台同名，现在做不到`);
  }

  // 2. main.ts 必须走这个函数，不许再自己写一份。
  asserts++;
  if (!/exportFileName\s*\(\s*side\s*\)/.test(main)) {
    probs.push('main.ts 没调用 exportFileName(side) —— 下载名仍然在别处各写一份');
  }
  const hardCoded = main.match(/[`'"]gift(?:188|_188)[-_](?:front|back)\.png[`'"]/g);
  if (hardCoded && hardCoded.length) {
    probs.push(`main.ts 里仍写死文件名（${[...new Set(hardCoded)].join('、')}）—— 两处命名必然再次漂开`);
  }

  // 3. 只画被请求的那一面。
  asserts++;
  if (!/exportPostcardPng\s*\(\s*input\s*,\s*side\s*\)/.test(main)) {
    probs.push('main.ts 没有按 side 只导一面 —— 导出正面的代价是两面都重画');
  }
  if (/exportBothSides/.test(main)) {
    probs.push('main.ts 仍在用 exportBothSides() —— 玩家点一个按钮，两面被画掉');
  }

  return expect(
    probs.length === 0,
    probs.length ? probs.join('；')
      : `导出名只有一个出处（${f} / ${b}）· main.ts 不写死文件名 · 按 side 只画一面`,
    asserts,
  );
});

// ---------------------------------------------------------------- 明信片预览（中途）
/**
 * 三十天里玩家只有一条路能看见明信片：走完全程弹结算页。
 * 于是「碎片」这个词在整个过程中一直没有形状——
 * 直到最后一天那张卡第一次出现，他才知道自己在攒的到底是什么。
 *
 * 中途这一屏要成立，有四件各自能独立坏掉的事：
 *
 * 1. **圈必须落在卡上那颗点的正中间。** 判据不查「代码里有没有调
 *    fragmentMapDot()」——注释里提过也算通过，那就白查了。
 *    这里直接量五格各自的投影点，且用 `slotVisits` 全 0 的存档：
 *    **一次都没到过**那一格是这一屏最容易没有落点的情形
 *    （初旅的画区只有 4 格），全 0 量到的就是最坏情况。
 *
 * 2. 暂停面板上得有一个真的按钮。
 * 3. UI 宿主要接得住：构造、入口、关、刷——四处各能独立漏掉。
 * 4. 新写的这些 CSS 类必须都真有规则：缺一条不是难看，
 *    是那几块塌成行内文本，五格碎片挤成一行，圈没有地方落。
 *
 * 把它退回「只有一块画布、右边没侧栏、暂停面板上没按钮」就能红。
 */
check('verify_postcard_preview', () => {
  let asserts = 0;
  const probs: string[] = [];
  const read = (rel: string): string =>
    readFileSync(join(process.cwd(), 'src', rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  // 1. 五格 × 圈的位置 = 卡上那颗点，且那颗点确实在地图方框里。
  asserts++;
  const W = 960;
  const H = 540;
  const empty: PostcardInput = {
    slotVisits: [0, 0, 0, 0, 0],
    kitTier: 0,
    hasPaper: false,
    hasInk: false,
    hasSeal: false,
    hasEnvelope: false,
    ending: 'leave_door',
    backText: '',
    lang: 'zh',
  };
  // 方框用同一个 bandH 量：fragmentMapDot() 内部就是 `canvasH * MAP_BAND_FRAC`。
  // 自己另取一个高度量框，等于拿两套投影互相比。
  const rect = layoutMap(W, H * MAP_BAND_FRAC, false).rect;
  const dots: [number, number][] = [];
  for (let s = 0; s < 5; s++) {
    const p = fragmentMapDot(empty, s, W, H);
    if (!p) {
      probs.push(`第 ${s + 1} 件碎片查不到地图上的点 —— 点了它，圈无处可落`);
      continue;
    }
    dots.push(p);
    const inside =
      p[0] >= rect.x && p[0] <= rect.x + rect.w &&
      p[1] >= rect.y && p[1] <= rect.y + rect.h;
    if (!inside) {
      probs.push(
        `第 ${s + 1} 件碎片在 (${p[0].toFixed(0)}, ${p[1].toFixed(0)})，落在地图方框外`
          + ` (${rect.x.toFixed(0)}, ${rect.y.toFixed(0)}, ${rect.w.toFixed(0)}×${rect.h.toFixed(0)})`
          + ' —— 圈会钉到框外，而那颗点还在框里',
      );
    }
  }
  const distinct = new Set(dots.map(([a, b]) => `${Math.round(a)},${Math.round(b)}`)).size;
  if (dots.length === 5 && distinct !== 5) {
    probs.push(`五件碎片的投影点里只有 ${distinct} 个不同的 —— 点错了件会圈到别件的地方`);
  }

  // 2. 入口：暂停面板上得有一个真按钮。
  asserts++;
  const pause = read('ui/pausePanel.ts');
  if (!/t\s*\(\s*['"]postcard_look['"]\s*\)/.test(pause)) {
    probs.push('暂停面板上没有「看看明信片」这个按钮 —— 这一屏玩家永远发现不了');
  }
  if (!/onLookPostcard(\?\.)?\s*\(/.test(pause)) {
    probs.push('暂停面板没有触发 onLookPostcard —— 按钮点了不会开这一屏');
  }

  // 3. 宿主四处接线，各自独立。
  asserts++;
  const ui = read('ui/index.ts');
  if (!/new PostcardPanel\s*\(/.test(ui)) probs.push('UI 宿主没构造 PostcardPanel');
  if (!/onLookPostcard\s*:\s*\(\s*\)\s*=>\s*this\.lookPostcard\s*\(\s*\)/.test(ui)) {
    probs.push('UI 宿主没把暂停面板的入口接到 lookPostcard() —— 按钮点了没反应');
  }
  const hidePanels = (ui.match(/private hidePanels\s*\(\s*\)\s*:\s*void\s*\{([\s\S]*?)\n  \}/) || [, ''])[1];
  if (!/this\.postcard\.hide\s*\(\s*\)/.test(hidePanels)) {
    probs.push('hidePanels() 没关明信片预览 —— 回标题/引导时它会留在世界上面');
  }
  const sync = (ui.match(/syncFromState\s*\(\s*\)\s*:\s*void\s*\{([\s\S]*?)\n  \}/) || [, ''])[1];
  if (!/this\.postcard\.sync\s*\(\s*\)/.test(sync)) {
    probs.push('syncFromState() 不刷明信片预览 —— 路上收了一块碎片之后它显示的还是旧数');
  }
  const disp = (ui.match(/dispose\s*\(\s*\)\s*:\s*void\s*\{([\s\S]*?)\n  \}/) || [, ''])[1];
  if (!/this\.postcard\.dispose\s*\(\s*\)/.test(disp)) {
    probs.push('dispose() 不销毁明信片预览 —— 它的 Esc 捕获监听会一直挂着');
  }
  // `pause.show()` 只管把暂停亮起来，不负责收别人的屏。
  // 漏掉这一行就是「Esc 之后两张卡片叠在一起」。
  const ctor = (ui.match(/new PostcardPanel\s*\(\{([\s\S]*?)\}\s*\)/) || [, ''])[1];
  if (!/this\.postcard\.hide\s*\(\s*\)/.test(ctor)) {
    probs.push('关闭明信片预览时没有把它自己关掉 —— Esc 之后暂停面板和它叠在一起');
  }

  // 4. 点一格要同时动三处：卡上的圈、五格的状态、下面那句话。
  //    漏一处就是「圈挪了但字没动」，读起来像界面卡了一下。
  asserts++;
  const panel = read('ui/postcardPanel.ts');
  const focusBody = (panel.match(/private focusCell\s*\([^)]*\)\s*:\s*void\s*\{([\s\S]*?)\n  \}/) || [, ''])[1];
  if (!focusBody) probs.push('postcardPanel.ts 里没有 focusCell() —— 点了碎片没有反应');
  if (!/this\.paint\s*\(/.test(focusBody)) {
    probs.push('focusCell() 不重画画布 —— 点了碎片，卡上那道圈不会挪');
  }
  if (!/this\.paintFrags\s*\(/.test(focusBody)) {
    probs.push('focusCell() 不刷五格的状态 —— 圈挪了，选中态还停在原来那件');
  }
  if (!/paintTip\s*\(\s*\)/.test(focusBody)) {
    probs.push('focusCell() 不刷那句话 —— 圈跟着动了，下面的字还停在原来那一件');
  }

  // 5. CSS 覆盖。
  asserts++;
  const css = read('ui/styles.css');
  const cls = [...new Set(panel.match(/g-(?:pc|card-pc)[\w-]*/g) || [])];
  const noRule = cls.filter((c) => !new RegExp(`\\.${c}(?!\\w)`).test(css));
  if (cls.length === 0) probs.push('没从 postcardPanel.ts 里数到任何 g-pc* 类 —— 判据自己写空了');
  if (noRule.length) {
    probs.push(`styles.css 里缺这些类的规则：${noRule.join('、')} —— 那几块会塌成行内文本`);
  }

  // 6. 语言默认值。这一屏自己传 lang，但导出那条路不传——
  //    写死 'zh' 的话，英文玩家导出的是中文卡。断言取相对值：
  //    跟 getLang() 一致，而不是等于某个写死的字符串。
  asserts++;
  const langDefault = buildInputFromState({}).lang;
  if (langDefault !== getLang()) {
    probs.push(
      `buildInputFromState() 不传 lang 时得到 '${langDefault}'，而当前界面语言是 '${getLang()}'`
        + ' —— 不传 lang 的调用方（导出）会拿错语言',
    );
  }

  return expect(
    probs.length === 0,
    probs.length ? probs.join('；')
      : `五格（全未到访）的圈都落在地图方框里且互不重合 · 暂停面板有入口 · 宿主四处接住（关掉时自己先关） · 点一格同时动圈/状态/那句话 · ${cls.length} 个 CSS 类都有规则 · 语言默认值跟随界面`,
    asserts,
  );
});

// ---------------------------------------------------------------- 世界 HUD 可见性
/**
 * 冷启动时 HUD 必须**真的**被藏起来。
 *
 * ## 它凭什么会红
 *
 * 原来是 `private worldVisible = false` 加 `if (this.worldVisible === v) return;`，
 * 而 DOM 里的 HUD 构造出来就可见——于是 `showTitle()` 里的
 * `setWorldVisible(false)` 撞上同值直接返回，**一次都没隐藏过**。
 * 整套顶栏、碎片栏、小地图就那么透在标题卡后面，玩家第一眼像"这游戏已经开始了"。
 *
 * 把它退回 `private visible = false; private applied = true;` 就红——
 * 那正是原来那个 bug 的字面写法。
 */
check('verify_ui_visibility', () => {
  let asserts = 0;
  const probs: string[] = [];

  const v = new WorldVisibility();
  asserts++;
  if (v.value !== true) probs.push('初值应当是"可见"——DOM 里的 HUD 构造出来就在');
  asserts++;
  if (v.hasApplied) probs.push('刚构造出来就声称已经落过 DOM');

  // **第一次请求必须执行**，哪怕请求值与初值相同。这是整条判据的核心。
  asserts++;
  if (!v.set(false)) probs.push('冷启动的第一次 set(false) 没有执行 —— HUD 会透在标题页后面');
  asserts++;
  if (v.value !== false) probs.push('set(false) 之后当前值仍是 true');
  asserts++;
  if (!v.hasApplied) probs.push('set(false) 之后没有落到 DOM');

  // 同值第二次才允许早退：每帧路径上不能白跑 setShown。
  asserts++;
  if (v.set(false)) probs.push('同值第二次仍然执行了 —— 每帧都会白跑一次 setShown');

  // 进出世界一轮
  asserts++;
  if (!v.set(true) || v.value !== true) probs.push('进世界没有显示 HUD');

  return expect(probs.length === 0, probs.length ? probs.join('；') : '首次必生效 · 同值才早退', asserts);
});

/**
 * 压在画面上的次级文字，必须托得住它的底。
 *
 * ## 这个 bug 换了三个位置，三次的修法还不一样
 *
 * · **碎片栏**（`.g-frags`）：72% 的半透明纸 —— 底下的山透过字缝冒出来。
 * · **标题页那张卡**（`.g-card-title`）：0.55 的白纱压不住画面。
 *   主视觉不是均匀浅色，它有大片淡墨山体（最暗处约 rgb(45)），
 *   0.55 压上去只有 `236×0.55 + 45×0.45 ≈ 157` 的一片中灰——
 *   **卡上每一行字**都浮在上面，不只是某一块。上一轮只给画质组补了块实色底，
 *   于是"标题页部分文字还是看不清"：补一块底治的是那一个块，不是那张卡。
 * · **游戏内顶栏**（`.g-top`）：`--paper-85 → 透明` 平均铺满整条，
 *   字的底边落在全条 82% 处，那里只剩 0.15 的纸；压到山体（rgb≈60）上
 *   是 `236×0.15 + 60×0.85 ≈ 86`，`--ink-soft` 压上去 1.4:1。
 *
 * 三次都**不报错、别的判据全绿**，靠人眼第一眼。所以下面按机制分开钉，
 * 而不是笼统一句"要有底"：
 *
 * | 目标 | 要求 | 为什么是这一条 |
 * |---|---|---|
 * | `.g-frags` | 底必须**不透明** | 小方块压在世界画面上，没有"再垫一层"的地方 |
 * | `.g-card-title` | 必须**保持半透明**，且 alpha **≥ 0.8** | 整张卡压在主视觉上；0.8 是托住 `--ink-soft` 的下限，再低就回到中灰 |
 * | `.g-top` | 渐隐必须落在 `calc(100% - …em)` 里 | 顶栏会折成两行，按百分比写渐变的话第二行又落回透明区 |
 *
 * ## 为什么读源码，而不是算对比度
 *
 * 无头环境里没有样式表，`getComputedStyle` 量不到；而"这块底有多厚"
 * 恰恰就是这条判据本身。量的是 `styles.css` 里那几行字面量。
 *
 * "半透明"的三种写法都算输，因为它们是同一个错误的三种说法：
 * `rgba(…, 0.55)` / `var(--paper-72)`（令牌名里的数字就是它的 alpha）/
 * `rgb(… / 0.7)`。
 */
check('verify_paper_backing', () => {
  let asserts = 0;
  const probs: string[] = [];
  /**
   * **先剥注释再判。** 上一版就栽在这儿：`.g-top` 的规则体里那段解释写着
   * `calc(100% - 0.9em)`，而规则本身已经退回按百分比写——
   * 判据连同注释一起读，于是**注释里的字面量把判据自己喂饱了**，
   * 报出一个绿的、而顶栏其实已经坏掉的结果。
   *
   * 这条 CSS 里的注释写得比代码还长（这是本项目的规矩），
   * 所以"读规则体"和"读规则"是两回事。判据只认后者。
   */
  const src = readFileSync(join(process.cwd(), 'src', 'ui', 'styles.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

  /**
   * 取某个选择器的规则体。**必须按行首匹配**：
   *  loose 搜索会撞上注释里提到的那几个类名（`styles.css` 里那段注释
   *  就写着「`.g-frags` 与 `.g-title .g-group`」），命中注释会报假故障。
   *  `m` 标志让 `^` 落在每一行上，而真实选择器总是顶格写在行首。
   *
   * 调用方传**纯选择器字符串**（不要自己写正则）：转义在这里做一次。
   * 之前两边都转义了一次，`\.g-root` 变成 `\\\.g-root`，一条都匹配不到。
   */
  const ruleBodies = (selector: string): string[] => {
    const esc = selector
      .trim()
      .split(/\s+/)
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+');
    const re = new RegExp(`^\\s*${esc}\\s*\\{([^}]*)\\}`, 'gm');
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
    return out;
  };
  const bgOf = (body: string | null): string | null => {
    if (!body) return null;
    const m = /(^|[\s;])(background|background-color)\s*:\s*([^;]+)/.exec(body);
    return m ? m[3].trim() : null;
  };
  /**
   * 这个选择器**最后声明过**的那次 background。
   *
   * 不能只看最后一条规则：`.g-frags` 在文件尾的媒体查询里还有一条
   * （只改 `top` 与 `transform`），按"最后一条说了算"去读，一个有实色底的
   * 碎片栏会被读成"根本没有底"——假故障比没判据更费时间。
   * 但**后写的覆盖仍然算数**：谁最后写了 background，谁就是当前生效值。
   */
  const lastBg = (selector: string): string | null => {
    let v: string | null = null;
    for (const b of ruleBodies(selector)) {
      const x = bgOf(b);
      if (x) v = x;
    }
    return v;
  };
  /**
   * 这个底的实际 alpha。
   *
   * **读最后一个参数**（`, a)` 或 `/ a)` 收尾），不要去数逗号：
   * 标题卡那个值是 `rgba(var(--pw) calc(var(--pg) + 2) var(--pb), 0.86)`，
   * 而 `calc(var(--pg) + 2)` 内部就带右括号——第一版用 `[^)]*` 去匹配，
   * 在那个括号处就断了，于是取不到 alpha、落进"实色"那一支，
   * 把一张 0.86 的纱报成"被改成实色了"。**报错的判据比没判据更费时间。**
   *
   * 取不到就当它是 1——`var(--paper)` 这类实色令牌不写 alpha，
   * 而"不透明"正是我们要的判定。`color-mix()` 与渐变量不了（-1），
   * 交给调用方单独判：它们属于"写了就得多看一眼"的那种写法。
   */
  const alphaOf = (v: string | null): number => {
    if (!v) return 0;
    if (/gradient|color-mix\(/.test(v)) return -1;
    const tail = /[,/]\s*([\d.]+)\s*\)\s*$/.exec(v);
    if (tail) return Number(tail[1]);
    const tok = /var\(\s*--paper-(\d+)/.exec(v);
    if (tok) return Number(tok[1]) / 100;
    return 1;
  };

  // 1. 碎片栏：压在山与天上，必须实色。
  asserts++;
  {
    const bg = lastBg('.g-root .g-frags');
    if (!bg) {
      probs.push('碎片栏 .g-root .g-frags 根本没有 background —— 文字直接压在画面上');
    } else if (alphaOf(bg) < 1) {
      probs.push(`碎片栏的底是半透明的（${bg}）——外层那层纱兜不住`);
    }
  }

  // 2. 标题页那张卡：**保持半透明**，但不许薄过 0.9。
  //
  // 下限从 0.8 提到 0.9 是量出来的。底色是 `236×α + 45×(1-α)` 撑起来的
  // 浅色（45 是主视觉里淡墨山体实测的最暗处），而卡上最短的那一档字是
  // `--ink-soft` #6b5f4c：0.86 → 3.82:1，0.90 → 4.10:1，0.95 → 4.48:1。
  // 实机截图里「字浮在画上、发灰」就是 0.86 那一档。
  // 反过来 `--ink-faint` #9a8d76 在任何一档都只有 2.0–2.3:1，
  // **加厚纱救不了它**——所以标题页上"有意义"的字一律用 `--ink-soft`，
  // 那一档只留给版权与几何调试这类真正无关紧要的字。
  asserts++;
  {
    const bg = lastBg('.g-root .g-card-title');
    if (!bg) {
      probs.push('.g-card-title 没有 background —— 水墨主视觉会从整张卡底下漏出来');
    } else {
      const a = alphaOf(bg);
      if (a === 1) {
        probs.push(`.g-card-title 被改成实色了（${bg}）—— 主视觉会被一张纸盖住`);
      } else if (a === -1) {
        probs.push(`.g-card-title 用了 color-mix()（${bg}）—— 判据量不了它的浓度`);
      } else if (a < 0.9) {
        probs.push(
          `.g-card-title 的纱只有 ${a}：卡上最短的那档字（--ink-soft #6b5f4c）` +
            '压在淡墨山体（最暗处约 rgb(45)）上只有 3.8:1 上下，读不出来' +
            '（0.90 → 4.1:1，0.95 → 4.5:1）',
        );
      }
    }
  }

  // 3. 顶栏：渐隐必须是一个**固定高度**的空区，不是百分比。
  //
  // 按百分比写（`--paper-85 0%, transparent 100%`）时，字的底边落在全条 82% 处，
  // 那里只剩 0.15 的纸；而极窄屏（<=30rem）顶栏折成两行之后，第二行落回同一个
  // 透明区——**同一个 bug 换个宽度复活**，而那正是它现在的样子。
  asserts++;
  {
    const body = ruleBodies('.g-root .g-top').join('\n');
    if (!/linear-gradient/.test(body)) {
      probs.push('.g-top 的 background 不是渐变——顶栏底色被改掉了');
    } else if (!/calc\(\s*100%\s*-\s*[\d.]+em\s*\)/.test(body)) {
      probs.push(
        '.g-top 的渐隐不是固定高度（缺 calc(100% - …em)）——字底下那一段会淡到透明，' +
          '顶栏一折行第二行就跟着消失',
      );
    }
  }

  // 4. **不许用逗号语法写带通道变量的颜色函数**——那是本项目唯一一个
  //    「判据全绿、而页面上什么都不剩」的 bug。
  //
  //    `--pw` / `--pg` / `--pb` 是**裸 calc 值**（`calc(236 - var(--dusk) * 78)`）。
  //    裸 calc 通道只在**斜杠语法** `rgb(a b c / α)` 里能解析；写成逗号语法的
  //    `rgba(var(--pw) …, 0.86)` 时整条声明 invalid at computed-value time，
  //    `getComputedStyle` 读回来是 `rgba(0, 0, 0, 0)`。
  //
  //    标题卡的那层纱就是这么丢的：它从上线起**压根没有底**，
  //    而 `verify_paper_backing` 读到声明文本里的 `0.86` 判绿——
  //    `CSS.supports()` 对这条也返回 true（它只查语法，不查变量能否求值）。
  //
  //    静态判据看不见计算值，所以这里不判「浓度对不对」，只**禁掉会静默失效
  //    的那种写法**。正例：`rgb(var(--pw) calc(var(--pg) + 2) var(--pb) / 0.95)`。
  asserts++;
  {
    // 不能用 `[^)]*` 去够到逗号：`rgba(var(--pw) calc(var(--pg) + 2) var(--pb), 0.95)`
    // 里面有一层 `calc(...)`，第一个 `)` 就截断了，第一版判据因此**对真正的
    // bug 判绿**——和被它抓的那条 bug 是同一类毛病。所以老老实实配括号。
    const balanced = (open: number): number => {
      let depth = 0;
      for (let i = open; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')' && --depth === 0) return i;
      }
      return -1;
    };
    /** 顶层逗号（不在任何一层括号里）——它就是「用了旧式逗号语法」。 */
    const hasTopLevelComma = (body: string): boolean => {
      let depth = 0;
      for (const ch of body) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === ',' && depth === 0) return true;
      }
      return false;
    };
    const re = /\brgba?\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const open = m.index + m[0].length - 1;
      const close = balanced(open);
      if (close < 0) continue;
      const body = src.slice(open + 1, close);
      if (!/var\(\s*--(?:pw|pg|pb|paper)\b/.test(body)) continue;
      if (!hasTopLevelComma(body)) continue; // 斜杠语法，正例
      probs.push(
        `旧式逗号语法 ${m[0]}${body}) 不会生效：--pw/--pg/--pb 是裸 calc 值，` +
          '只能喂给斜杠语法 rgb(a b c / α)，否则整条声明 invalid at computed-value time、' +
          '底下等于没画',
      );
      re.lastIndex = close;
    }
  }

  return expect(
    probs.length === 0,
    probs.length
      ? probs.join('；')
      : '碎片栏实色 · 标题卡薄纱但 α≥0.9 · 顶栏渐隐落在固定高度的空区里 · 没有静默失效的逗号语法颜色',
    asserts,
  );
});

// ---------------------------------------------------------------- 档位说明不许说谎
/**
 * **面板上那一行说明，必须在描述玩家选中��一档。**
 *
 * ## 它守的是哪一族 bug
 *
 * 原来面板底下挂的是一句**静态**文案（`t('quality_hint')`），内容恒定在描述
 * **低档**：关阴影、树收到 95m、灌木 40m。玩家点了"高"，摘要三行诚实地写着
 * 2048px / 58m，紧跟着底下那句话仍然在说低档砍掉了什么——同一屏上两句互相
 * 拆台，而且玩家没有任何办法把它改对，因为那句话不随任何东西变。
 *
 * 这不是"文案写得不好"，是**面板在对自己的设置撒谎**，而标题页是评委看的第一屏。
 * 静态文案还有第二个代价：档位表一改，这句话就过期，而没有任何判据问过
 * "这句话现在还对不对"。
 *
 * ## 判据为什么是读源码
 *
 * 无头环境没有样式表也点不了按钮，量不到渲染结果。所以判据只问一件
 * 结构上可查的事：**那两个挂提示的位置，是不是从 `qualityHint(...)` 取的**。
 * 取了之后文案跟不跟得上，是 `qualityHint` 自己的事（下面第 2 条查那个）。
 *
 * ## 会红的做法
 *   · `titleScreen.ts` 改回 `note(t('quality_hint'), …)`   → 红
 *   · `pausePanel.ts` 改回 `note(t('quality_hint'), …)`     → 红
 *   · 从 supplement 里删掉 `quality_hint_high`              → 红（第 2 条）
 */
check('verify_quality_hint', () => {
  let asserts = 0;
  const probs: string[] = [];
  const read = (rel: string): string =>
    readFileSync(join(process.cwd(), 'src', rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  // 1. 两处提示都必须是 qualityHint(...) 的调用，不能是写死的 key。
  for (const rel of ['ui/titleScreen.ts', 'ui/pausePanel.ts']) {
    asserts++;
    const src = read(rel);
    // 剥掉 import 之后，剩下的 `quality_hint` 引用只可能来自 t('quality_hint')
    const stillCallsStatic = /t\(\s*['"`]quality_hint['"`]\s*\)/.test(src);
    if (stillCallsStatic) {
      probs.push(`${rel} 仍然用写死的 t('quality_hint') —— 面板上那一行说明不随档位变，选了高档也在说低档`);
    }
    if (!/qualityHint\s*\(/.test(src)) {
      probs.push(`${rel} 没有调用 qualityHint(...) —— 这一屏拿不到跟随档位的说明`);
    }
  }

  // 2. 三档的文案必须都在，且**互不相同**。
  //
  //    "都在"是显然的，"互不相同"才是这一条真正的判据：
  //    三条文案哪怕都存在，只要两条写得一样，选到那两档时面板上仍然是
  //    一句描述别人的说明——而这正是原来的 bug 缩小一号的版本。
  asserts++;
  const HINTS = ['low', 'medium', 'high'] as const;
  for (const lang of ['zh', 'en'] as const) {
    const side = I18N[lang];
    const seen: string[] = [];
    for (const h of HINTS) {
      const v = side[`quality_hint_${h}`];
      if (typeof v !== 'string' || v.length === 0) {
        probs.push(`文案缺 quality_hint_${h}（${lang}）—— 选到这一档时面板底下会空着`);
        continue;
      }
      seen.push(v);
    }
    if (new Set(seen).size !== seen.length) {
      probs.push(`${lang} 侧三档的说明有两条一模一样 —— 等于又变回一句恒定文案`);
    }
  }

  // 3. 文案里写的半径必须等于 PRESETS 里的真值。
  //
  //    这条是给"文案过期"准备的：档位表改了而文案没改，页面不会红，
  //    但玩家读到的是一句关于另一套数字的话。半径用 `(\d+)m` 抓出来比对。
  asserts++;
  const TIER_OF: Record<(typeof HINTS)[number], Tier> = {
    low: TIER_LOW,
    medium: TIER_MEDIUM,
    high: TIER_HIGH,
  };
  for (const h of HINTS) {
    for (const lang of ['zh', 'en'] as const) {
      const v = I18N[lang][`quality_hint_${h}`];
      if (typeof v !== 'string') continue;
      const truth = PRESETS[TIER_OF[h]];
      const nums = [...v.matchAll(/(\d+)\s*m\b/g)].map((m) => Number(m[1]));
      // 地面细节是**关**的那一档没有"半径"可写（写出来等于凭空多了一个数），
      // 所以只查它开着的那两档。
      const want = [truth.treeRadius, truth.bushRadius];
      if (truth.groundDetail !== 0) want.push(truth.groundDetailRadius);
      for (const n of want) {
        if (!nums.includes(n)) {
          probs.push(`quality_hint_${h}（${lang}）没提到 ${n}m —— 文案已经和 PRESETS 对不上了`);
        }
      }
    }
  }

  return expect(
    probs.length === 0,
    probs.length
      ? probs.join('；')
      : '标题页与暂停面板的档位说明都跟随选中档 · 三档文案互不相同 · 文案里的半径等于 PRESETS 真值',
    asserts,
  );
});

// ---------------------------------------------------------------- 结算三态
/**
 * **取消不是失败。**
 *
 * ## 它凭什么会红
 *
 * 退回 `o === 'win' ? 'mg_success' : 'mg_failed'` 就红：玩家按 Esc 退出，
 * 屏幕上弹的是「这次没有完成」。他没做错任何事，却读到了"我失败了"——
 * 而这一条曾经以注释的形式**声称自己已经修好了**（"中性的一句：它在被跳过"），
 * 传进去的却是 `false`。注释描述的意图和代码做的事不一致，没有任何判据问过。
 */
check('verify_settle', () => {
  let asserts = 0;
  const probs: string[] = [];

  asserts++;
  if (settleTextKey('win') !== 'mg_success') probs.push('成的那一局读的不是 mg_success');
  asserts++;
  if (settleTextKey('lose') !== 'mg_failed') probs.push('玩法失败读的不是 mg_failed');
  asserts++;
  if (settleTextKey('cancel') === 'mg_failed') probs.push('**取消被判成失败** —— 玩家按 Esc 退出会读到"我失败了"');
  asserts++;
  if (settleTextKey('cancel') !== 'result_cancel') probs.push(`取消读的是 ${settleTextKey('cancel')}，应为 result_cancel`);

  // 三个 key 互不相同，且都在表里（否则界面上是 ⟨key⟩）
  asserts++;
  const keys = [settleTextKey('win'), settleTextKey('lose'), settleTextKey('cancel')];
  if (new Set(keys).size !== 3) probs.push(`三个 key 有重复：${keys.join('/')}`);
  asserts++;
  for (const k of keys) if (!(k in I18N.zh) || !(k in I18N.en)) probs.push(`文案表缺 ${k}`);

  // 赢的那一屏要给得久一点：赢是这一刻唯一的高光，输只是路过的过程。
  asserts++;
  if (!(settleMs('win') > settleMs('lose'))) probs.push('赢的停留时间没有比输长');
  asserts++;
  if (settleMs('cancel') !== settleMs('lose')) probs.push('取消的停留时间与失败不一致');

  return expect(
    probs.length === 0,
    probs.length ? probs.join('；') : 'win/lose/cancel 三态互斥 · 取消不落回失败',
    asserts,
  );
});

// ---------------------------------------------------------------- 小游戏：松手与提前按
/**
 * **玩家中途松手 / 按早了，不该静默卡住。**
 *
 * ## 为什么单独一条
 *
 * `verify_minigame_playable` 问的是"能不能跑到一个终局"——
 * 而"卡住"和"跑不通"在它眼里是同一件事：Esc 收尾，所以它照样绿。
 * 它甚至有一条"一个键都没按却自己判赢"，却没有一条**「按对了能赢」**。
 *
 * 这一族两个 bug 都是同一个形状：**意图写对了，代码没接上，症状安静**。
 *
 * | 症状 | 为什么绿着 |
 * |---|---|
 * | 云描到一半松手，进度条冻结 | 进度只在"贴着起点重新起笔"之后才动，而这要求玩家回到起点；没有任何判据问过"松手之后还能不能描" |
 * | 竹在引导期就按住空格，第一根必丢 | 引导期那一次 keydown 顺手置上了 held，浏览器的按键重复被吞掉规则吃掉；而回归里没人"一直按着" |
 *
 * ## 它凭什么会红
 *
 * 云的判据跑的是**真的落笔路径**：在起点落笔 → 描一段 → 抬笔 → **在轮廓中段
 * 重新落笔** → 描完 → 抬笔。把 `canStartStrokeAt` 退回"只看起点热区"就红：
 * 第二次落笔武装不起来，`updateDraw` 再也不被调用，ratio 停在第一段，
 * 于是收不到 `win`。
 *
 * 竹的判据模拟的是浏览器的**按键重复**（连发 keydown，中间不 keyUp）：
 * 引导期按一次 → 等价于玩家从一开始就按住空格。
 * 把 `this.spaceHeld = false` 从引导期分支里删掉就红：第一次砍被吞掉，`current` 停在 0。
 */
check('verify_minigame_resume', () => {
  let asserts = 0;
  const probs: string[] = [];

  // ---------------- 云：抬笔之后还能续描 ----------------
  {
    const { g, result } = newMiniGame('cloud');
    // 私有字段只在这一条断言里用：轮廓点与进度是这个游戏唯一的可观测量。
    const c = g as unknown as {
      path: Float32Array;
      ratio: number;
      nextSeg: number;
      started: boolean;
    };
    const n = Math.floor(c.path.length / 2);
    const px = (i: number) => c.path[((i % n) + n) % n * 2];
    const py = (i: number) => c.path[((i % n) + n) % n * 2 + 1];

    // 第一笔：从起点起，描过前七点
    g.onPointerDown(px(0), py(0));
    for (let i = 1; i <= 6; i++) g.onPointerMove(px(i), py(i));
    g.onPointerUp(px(6), py(6));

    asserts++;
    if (c.nextSeg <= 0) probs.push('云：第一笔没有认领到任何段（测试驱动方式本身有问题）');

    // 抬笔之后，在**轮廓中段**重新落笔——离起点远得很，
    // 而这正是原来唯一无法恢复的位置。
    const mid = Math.floor(n / 2);
    g.onPointerDown(px(mid), py(mid));
    asserts++;
    if (!c.started) {
      probs.push('**抬笔之后无法续描** —— 落笔被起点热区挡住，进度条会静冻结着');
    } else {
      for (let i = mid + 1; i <= n; i++) g.onPointerMove(px(i), py(i));
      g.onPointerUp(px(n), py(n));
      asserts++;
      if (c.ratio < 0.75) probs.push(`云：续描之后完成度只有 ${(c.ratio * 100).toFixed(1)}%，未过 75%`);
      asserts++;
      if (result() !== 'win') probs.push(`云：续描到底没有判赢（收到 ${result() ?? '什么都没收到'}）`);
    }
  }

  // ---------------- 竹：引导期就按住，第一根不该丢 ----------------
  {
    const { g } = newMiniGame('bamboo');
    const b = g as unknown as { current: number; windowActive: boolean; introActive: boolean };

    asserts++;
    if (!b.introActive) probs.push('竹：开局不在引导期（测试驱动方式本身有问题）');

    // 引导期按一次（玩家从一开始就按住空格）
    g.onKeyDown('Space', false);
    asserts++;
    if (b.introActive) probs.push('竹：引导期没有被这一次按键结束');

    // 浏览器的按键重复：连发 keydown，中间**不** keyUp。
    g.onKeyDown('Space', false);
    asserts++;
    if (b.current < 1) {
      probs.push('**引导期按住空格的玩家丢掉第一根** —— 这一次砍被按键重复的吞键规则吃掉了');
    }
  }

  return expect(
    probs.length === 0,
    probs.length ? probs.join('；') : '云可续描到 win · 竹按住不丢第一根',
    asserts,
  );
});

// ---------------------------------------------------------------- 界面按键
/**
 * **面板页面的键盘归属，以及小游戏必须先等对白念完。**
 *
 * ## 这一族在还原什么
 *
 * 玩家报的症状是一句话：「小游戏按键玩的时候**部分**游戏玩不了」。
 * "部分"两个字是关键——它排除了"整个输入系统坏了"这种大改动的假设，
 * 指向一条**只挡空格**的通路。而空格正是三个小游戏（云落笔 / 茶注水 / 竹下刀）
 * 唯一的输入；琴和禽用数字键，数字键不在被挡的名单上，所以它们照常能玩。
 *
 * ## 它凭什么会红
 *
 * | 判据 | 怎么弄坏它 |
 * |---|---|
 * | 小游戏运行时 `spaceKeyOwnedHere()` 为 false | 把 `setSpaceKeyOwner` 装成 `() => true`（即恢复成"永远独占"） |
 * | 没有小游戏时为 true | 装成 `() => false`——面板上的按钮按空格就再也不会激活 |
 * | 五座碎片驿站的对白都长于打卡过场 | 数据改动让某站对白变短（那时 `whenDialogueIdle()` 才变成可删的空等） |
 * | 结算页有一颗可点的、不清档的「回到世界」 | 把那颗按钮删掉，或让它改调 `onRestart` |
 *
 * 最后两条量的都是**真东西**：第三条量的是两个常量之间的关系，而这两个常量
 * 正是那条时序的全部依据；第四条真的造一个 `EndCard` 并点它那颗按钮。
 */

// 打卡过场里，从 `moving` 结束（对白发出）到 `outro` 结束（小游戏开始）的时长。
// 抄自 `world.ts` 的 `advanceCheckIn`：holding 1.5s + outro 0.4s。
// **必须和 world.ts 一起改**——这是本条判据唯一的时序依据。
function checkInCutsceneSec(): number {
  return 1.5 + 0.4;
}

/** 一段对白念完要多久。对白是**逐字**显示的（`CHARS_PER_SEC`），且每句之间
 *  玩家要按一次键——那一次按键的犹豫时间不在数据里，所以这里只量下限。
 *  与 `dialogue.ts` 的 `CHARS_PER_SEC` 保持一致。 */
function dialogueSeconds(lines: readonly string[]): number {
  const CHARS_PER_SEC = 26;
  let t = 0;
  for (const l of lines) t += Math.max(l.length, 1) / CHARS_PER_SEC;
  return t;
}

check('verify_ui_keys', () => {
  let asserts = 0;
  const probs: string[] = [];

  // ---- 1. 空格的归属由宿主说了算，且默认安全 ----
  //
  // 默认值必须是 `true`（独占）：模块被单独 import 而宿主还没装判定时，
  // 宁可多拦一次（面板按钮仍然可用），也不能少拦一次
  // （空格漏到 main 的 `onConfirm` 会让暂停页的空格变成"确认"）。
  asserts++;
  if (!spaceKeyOwnedHere()) {
    probs.push('宿主还没装判定时，空格默认不归按钮所有——面板上的空格会漏给 main');
  }

  // ---- 2. 装上判定后，两种状态各自成立 ----
  setSpaceKeyOwner(() => false);
  asserts++;
  if (spaceKeyOwnedHere()) {
    probs.push('小游戏运行时空格仍然被按钮独占——云/茶/竹按空格会毫无反应');
  }

  setSpaceKeyOwner(() => true);
  asserts++;
  if (!spaceKeyOwnedHere()) {
    probs.push('没有小游戏时空格却没有归按钮所有——面板上的按钮按空格不再激活');
  }

  // ---- 3. 小游戏必须晚于对白结束 ----
  //
  // 五座碎片驿站每一座的首访对白都要念 ~4 秒，而小游戏在 1.9 秒后就开。
  // 这不是"可能会撞上"，是**必然撞上**——所以宿主那一句
  // `await whenDialogueIdle()` 是承重的，删掉它就红。
  const budget = checkInCutsceneSec();
  const late: string[] = [];
  for (const st of STATIONS) {
    if (st.slot < 0) continue;
    const lines = st.def.dialogue;
    if (!lines || !lines.length) continue;
    const need = dialogueSeconds(lines);
    asserts++;
    if (need > budget) {
      late.push(
        `${st.def.fragment ?? st.def.name} ${need.toFixed(1)}s>${budget.toFixed(1)}s`,
      );
    }
  }
  if (!late.length) {
    probs.push(
      `没有一站的对白超过打卡过场的 ${budget.toFixed(1)}s——` +
        '`whenDialogueIdle()` 那一行就变成了永不触发的空等（数据变了才合理）',
    );
  }

  // 上面那条量的是**数据事实**（对白确实长于过场），它本身守不住那行 await：
  // 把 `await` 删掉，数据一个字没变，它照样绿。
  // 所以这里再钉一条**真的会因为删掉 await 而红**的：宿主源码里
  // `mg.run()` 之前必须有那一等。
  //
  // 为什么读源码而不构造 `App`：`App` 的构造要 WebGL 上下文、要真 World，
  // 无头环境里根本起不来（这正是 `verify_ride` 只能测纯逻辑层的原因）。
  // 而这一条问的是"那行 await 在不在"，读源码是唯一诚实的量法——
  // 它量的是**字面上那一句**，不是我们对它的理解。
  asserts++;
  {
    const src = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
    // 只看 `runMiniGame` 这一个函数体：从它的声明切到下一个 `  private `。
    // 不切作用域的话，全文搜 `whenDialogueIdle` 会命中 `completeChapterOne`
    // 里那处**本来就有的**调用（它早就在等对白了），于是这一条永远绿。
    const fnStart = src.indexOf('private async runMiniGame(');
    const fnEnd = src.indexOf('\n  private ', fnStart + 1);
    asserts++;
    if (fnStart < 0 || fnEnd < 0) {
      probs.push('main.ts 里找不到 runMiniGame 的函数边界 —— 判据要跟着改');
    } else {
      const body = src.slice(fnStart, fnEnd);
      const runIdx = body.indexOf('this.mg.run(');
      const awaitIdx = body.indexOf('await this.ui.whenDialogueIdle()');
      asserts++;
      if (runIdx < 0) {
        probs.push('runMiniGame 里找不到 this.mg.run( —— 小游戏入口改名了，这条判据要跟着改');
      } else if (awaitIdx < 0) {
        probs.push(
          '`runMiniGame` 里没有等对白念完 —— 小游戏会盖在还没念完的对白上，' +
            '而对白在捕获阶段吃掉空格，云/茶/竹就再也按不动了',
        );
      } else if (awaitIdx > runIdx) {
        probs.push('`whenDialogueIdle()` 排在 `mg.run()` 之后 —— 等的是一场还没开的乐事');
      }
    }
  }

  // ---- 4. 结算页必须有一条"回到世界"的出口 ----
  //
  // `finishRun()` 会 `loop.suspend()`，而结算页原来唯一的动词是「重新开始」
  // ——它走 `resetRun()` 清档。于是玩家点完「结束这一趟 · 收下明信片」之后，
  // 只剩"清档重来"和"刷新页面"。
  //
  // 真造一个 `EndCard`（最小 DOM 桩），然后**点那颗按钮**：判据是
  // `onCloseEndCard` 被调到了、而 `onRestart` 没有。删掉按钮就红——
  // 这不是"接口上声明过"，是"玩家真的按得到"。
  asserts++;
  const dom = ensureStubDom();
  try {
    const calls: string[] = [];
    const card = new EndCard({
      parent: dom.parent(),
      game: new GameStateManager(),
      toast: { show() {} } as unknown as Toast,
      hooks: {
        onRestart: () => void calls.push('restart'),
        onCloseEndCard: () => void calls.push('close'),
        onWriteBack: () => {},
        onExportPostcard: () => {},
        onEndingPick: () => {},
      } as unknown as UIHooks,
    });
    card.show();
    const btns = card.root.querySelectorAll('button') as unknown as HTMLElement[];
    const label = (b: HTMLElement) => b.textContent ?? '';
    // 那颗"回到世界"的按钮，文案来自 `continue_explore`。
    const close = btns.find((b) => label(b).includes(t('continue_explore')));
    const restart = btns.find((b) => label(b).includes(t('restart_end')));
    if (!close) {
      probs.push('结算页上没有「回到世界」的按钮——那一页唯一的动词是清档的「重新开始」');
    } else {
      asserts++;
      if (close === restart) {
        probs.push('「回到世界」和「重新开始」是同一颗按钮——关掉一页会把这一趟清掉');
      }
      close.click();
      asserts++;
      if (!calls.includes('close')) probs.push('点了「回到世界」，onCloseEndCard 没有被调用');
      asserts++;
      if (calls.includes('restart')) {
        probs.push('点「回到世界」却触发了 onRestart——关掉一页会把这一趟清掉');
      }
    }

    // Esc 也必须能关。玩家在这一页能按的键不多，而 Esc 是唯一那个
    // "在任何面板上都成立"的键——它不成立的话，键盘玩家手里就没有出口了。
    calls.length = 0;
    dom.pressKey('Escape');
    asserts++;
    if (!calls.includes('close')) {
      probs.push('结算页上按 Esc 没有关掉这一页——键盘玩家手里就没有出口了');
    }
    card.dispose();
  } catch (e) {
    probs.push(`造 EndCard 抛异常：${String((e as Error)?.message ?? e).split('\n')[0]}`);
  }

  return expect(
    probs.length === 0,
    probs.length
      ? probs.join('；')
      : `空格归属随相位切换 · ${late.length} 座站点的对白长于过场（宿主会等） · 结算页有可点的「回到世界」`,
    asserts,
  );
});

/**
 * 最小 window 桩：只实现 `addEventListener` / `removeEventListener` 加一个
 * 手工触发入口。
 *
 * 为什么需要它：`EndCard.show()` 会在 window 的**捕获**阶段挂 Esc 监听。
 * 无头环境里没有 `window` 这个全局，`show()` 直接抛 —— 于是判据测的是
 * "桩够不够全"，而不是"结算页有没有出口"。**测不出来和坏了长得一模一样。**
 *
 * 监听按「捕获 / 冒泡」两档分开存，`pressKey()` 按 DOM 的真实顺序发：
 * 先捕获（window 上的监听器），再冒泡（元素上的监听器）。
 */
function ensureStubWindow(g: { window?: unknown }): void {
  if (g.window) return;
  const cap = new Map<string, ((e: unknown) => void)[]>();
  const bub = new Map<string, ((e: unknown) => void)[]>();
  g.window = {
    addEventListener: (ev: string, fn: (e: unknown) => void, opts?: { capture?: boolean }) => {
      const m = opts?.capture ? cap : bub;
      const list = m.get(ev) ?? [];
      list.push(fn);
      m.set(ev, list);
    },
    removeEventListener: (ev: string, fn: (e: unknown) => void, opts?: { capture?: boolean }) => {
      const m = opts?.capture ? cap : bub;
      const list = m.get(ev);
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    __press: (code: string, target?: unknown) => {
      const ev = {
        code,
        repeat: false,
        shiftKey: false,
        target: target ?? null,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {},
        stopImmediatePropagation() {},
      };
      // 捕获阶段（window 上挂的，如 EndCard 的 Esc）
      for (const fn of [...(cap.get('keydown') ?? [])]) fn(ev);
      // 冒泡阶段（元素上挂的，如 wireKeyActivate）
      for (const fn of [...(bub.get('keydown') ?? [])]) fn(ev);
    },
  };
}

/**
 * 最小 DOM 桩。装一次，全局复用，装完不摘。
 *
 * 为什么放在文件级而不是 `verify_story` 内部：现在有两条判据要造真的 DOM
 * （`StoryCards` 与 `EndCard`），而两份桩各写一套是这个项目明令禁止的
 * 「同一条判据在不同假环境里给出不同答案」的来源。理由见 `verify_story`
 * 里 `hadDocument` 那段（`globalThis` 间接属性，避开 esbuild 的常量折叠）。
 *
 * 刻意**不**实现布局与真实事件派发：`click()` 走自己的 listener 列表，
 * 所以点击判据照样成立。
 */
interface StubDom {
  doc: Document;
  parent(): HTMLElement;
  /** 触发一次 window 上的 keydown。`EndCard` 的 Esc 走这条。 */
  pressKey(code: string, opts?: { target?: unknown }): void;
}

let stubDom: StubDom | null = null;

function ensureStubDom(): StubDom {
  if (stubDom) return stubDom;
  const g = globalThis as { document?: Document; window?: Window & typeof globalThis };
  ensureStubWindow(g);
  if (!g.document) {
    g.document = {
      createElement(tag: string) {
        const cls = new Set<string>();
        const kids: unknown[] = [];
        const listeners: Record<string, (() => void)[]> = {};
        const attrs: Record<string, string> = {};
        const text = { v: '' };
        return {
          tagName: tag.toUpperCase(),
          /**
           * `className` 与 `classList` **必须共用一份**。
           *
           * `dom.ts` 的 `el()` 是 `createElement(tag)` 之后才 `node.className = cls`
           * ——它不把 cls 传给 createElement。所以这里如果只给 `className` 一个
           * 普通属性，桩上就会出现"className 有值、classList 是空的"，
           * 于是**类选择器永远找不到东西**：`querySelector('.g-result-gain')` 返回 null，
           * 读出来的 textContent 全是空串，而判据报的是"屏上找不到这句话"。
           *
           * 这不是判据写错了，是桩不像浏览器：真 DOM 上 `className = 'x'`
           * 之后 `classList.contains('x')` 必然为真。两个视图必须一致。
           */
          get className() {
            return [...cls].join(' ');
          },
          set className(v: string) {
            cls.clear();
            for (const c of v.split(/\s+/)) if (c) cls.add(c);
          },
          type: '',
          style: {} as Record<string, string>,
          children: kids,
          value: '',
          get textContent() {
            return text.v;
          },
          set textContent(v: string) {
            text.v = v;
          },
          focus() {},
          blur() {},
          contains: (n: unknown) => kids.includes(n),
          /** `EndCard` 构造里就要拿 2D 上下文，缺了它构造直接抛。
           *  给一个只记录调用、不真的画的（和 `fakeCtx` 同一套思路）。 */
          getContext: () => fakeCtx(),
          get classList() {
            return {
              add: (c: string) => void cls.add(c),
              remove: (c: string) => void cls.delete(c),
              contains: (c: string) => cls.has(c),
              toggle: (c: string, on?: boolean) => {
                if (on === undefined) cls.has(c) ? cls.delete(c) : cls.add(c);
                else if (on) cls.add(c);
                else cls.delete(c);
              },
            };
          },
          appendChild: (n: unknown) => {
            kids.push(n);
            return n;
          },
          remove: () => {
            const i = kids.indexOf(this);
            if (i >= 0) kids.splice(i, 1);
          },
          addEventListener: (ev: string, fn: () => void) => {
            (listeners[ev] ??= []).push(fn);
          },
          /** `dom.ts` 的 setFlag 走的是 setAttribute，缺了它 setShown 会抛。 */
          setAttribute: (name: string, value: string) => {
            attrs[name] = value;
          },
          getAttribute: (name: string) => attrs[name] ?? null,
          /** 手工触发：绕开真实事件系统，只走我们自己挂的 listener。 */
          click: () => (listeners.click ?? []).forEach((f) => f()),
          /** 标签选择器 + 类选择器，只这两种——判据只用到这两种。 */
          querySelector: (sel: string) => findAll(kids, sel)[0] ?? null,
          querySelectorAll: (sel: string) => findAll(kids, sel),
        };
      },
    } as unknown as Document;
  }

  /** 深度优先找匹配项。`sel` 形如 `.g-btn` 或 `button`。 */
  const findAll = (nodes: unknown[], sel: string): unknown[] => {
    const byClass = sel.startsWith('.');
    const want = byClass ? sel.slice(1) : sel.toUpperCase();
    const out: unknown[] = [];
    const walk = (list: unknown[]) => {
      for (const n of list) {
        const node = n as {
          tagName?: string;
          classList?: { contains(c: string): boolean };
          children?: unknown[];
        };
        if (!node) continue;
        const hit = byClass ? node.classList?.contains(want) : node.tagName === want;
        if (hit) out.push(n);
        walk(node.children ?? []);
      }
    };
    walk(nodes);
    return out;
  };

  stubDom = {
    doc: g.document,
    /** 一个能挂东西的父节点。 */
    parent: () => {
      const host = g.document!.createElement('div');
      (host as unknown as { children: unknown[] }).children = [];
      return host as unknown as HTMLElement;
    },
    pressKey: (code, opts) => {
      (g.window as unknown as { __press: (c: string, t?: unknown) => void }).__press(
        code,
        opts?.target,
      );
    },
  };
  return stubDom;
}

// ---------------------------------------------------------------- 跑
// ------------------------------------------------------- 参赛提交页
/**
 * 提交页是唯一直接给评委看的东西，而它的失效全是静默的：
 * 链接打错、媒体没跟仓库走、页面混进一句游戏里其实没有的卖点。
 *
 * 判据写在 `src/verify/submission.ts`（单独一个文件是因为它读的是**源码目录**
 * 而不是运行时数据，和 ride 那条一样该有自己的说明）。
 */
check('verify_submission', () => assertSubmission());

/**
 * 第一次玩的人撞得到、而回归套件一条都问不到的那一族：
 * **界面在"等"和"关不掉"这两件事上有没有出口。**
 *
 * ## 它守的是哪两个 bug
 *
 * **① 演示静默降级。** 自行车的 GLB 走启动屏之后的后台链，标题页不等它
 * （这是对的：能不能玩 ≠ 画得全不全）。但演示的第一辆车**必须是**自行车——
 * 模型没到时 `set('bike')` 被 `canEnter()` 挡掉，于是那 90 秒里出现的是一个
 * 背包在跑的人，**而界面上没有一个字说明为什么**。
 * 实测：每次开页都命中 20 秒硬超时，所以这不是边缘情况，是默认情况。
 *
 * 修法是把它从"静默"改成"看得见的等待"：按钮在到货前禁用 + 文案说在等什么。
 * 判据问的就是这两件事——**没有它们，这条 bug 可以被任何人悄悄改回来**。
 *
 * **② 商店关不掉。** 商店复用 `checkin` 相位，而 `Escape` 分支只认
 * `paused` / `roaming`。于是在铺子里按 Esc 什么都没发生，也没有提示。
 * Esc 是"我卡住了"的第一反应键，它必须有出口。
 *
 * ## 为什么读源码而不是跑一遍
 *
 * ①要判断"按钮在模型到货前是不是禁用的"，得让浏览器真的卡住网络；
 * ②要判断"Esc 在铺子里有没有被吃掉"，得先骑到一座有铺子的驿站。
 * 两条都是**在真机上才会遇到、而截图看不出来**的——所以读源码，
 * 并且用 `demo_loading` 这类**键名**当锚点，而不是某句具体的文案。
 *
 * ## 会红的做法
 *
 *   · titleScreen.ts 去掉 `setDisabled(this.demoBtn, true)`        → 红（①）
 *   · main.ts 的 `Escape` 分支去掉 `if (this.ui.shopOpen)`          → 红（②）
 *   · 删掉 `demo_loading` / `demo_loading_hint` 四个键里的任意一个   → 红（③）
 *   · 把 `Composure` 改回 `Heart`（任何一处）                     → 红（④）
 */
check('verify_first_run', () => {
  let asserts = 0;
  const probs: string[] = [];
  const read = (rel: string): string =>
    readFileSync(join(process.cwd(), 'src', rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  const title = read('ui/titleScreen.ts');
  const main = read('main.ts');

  // ① 演示按钮在模型到货前必须是**禁用**的。
  asserts++;
  if (!/setDisabled\s*\(\s*this\.demoBtn\s*,\s*true\s*\)/.test(title)) {
    probs.push('titleScreen.ts 没有在构造时禁用演示按钮 —— 车没到也能点开，于是那 90 秒是一个人在跑');
  }
  asserts++;
  if (!/setDemoReady\s*\(/.test(title)) {
    probs.push('titleScreen.ts 没有 setDemoReady —— 宿主无法把"车到了"告诉标题页');
  }
  asserts++;
  if (!/ui\.setDemoReady\s*\(/.test(main)) {
    probs.push('main.ts 没有在车到货时调 ui.setDemoReady —— 按钮会一直停在"正在装车"');
  }
  // 车到货时还要**把人放上车**，否则"开启旅程"仍然开局走路。
  asserts++;
  if (!/onAssetLoaded/.test(main) || !/vehicle\.set\s*\(\s*'bike'\s*\)/.test(main)) {
    probs.push("main.ts 没有在车到货时切自行车 —— 玩家开局仍然徒步");
  }
  // 自动切换必须让位于玩家的选择。
  asserts++;
  if (!/vehicleTouched/.test(main)) {
    probs.push('main.ts 没有 vehicleTouched —— 玩家自己按过 E 之后游戏还会替他换车');
  }

  // ② Esc 必须能关掉铺子。
  asserts++;
  if (!/shopOpen/.test(main) || !/closeShop\s*\(\s*\)/.test(main)) {
    probs.push("main.ts 的 Escape 分支没有先问 ui.shopOpen —— 在铺子里按 Esc 什么都不会发生");
  }

  // ③ 新文案两侧都要有（缺一条界面上就是 ⟨key⟩）。
  asserts++;
  for (const k of ['demo_loading', 'demo_loading_hint', 'fold_open', 'fold_close']) {
    for (const lang of ['zh', 'en'] as const) {
      if (typeof I18N[lang][k] !== 'string' || I18N[lang][k].length === 0) {
        probs.push(`文案缺 ${k}（${lang}）`);
      }
    }
  }
  // 等待态必须有**自己的说法**，不能复用 `demo_hint`。
  asserts++;
  if (I18N.en.demo_loading === I18N.en.demo_start) {
    probs.push('demo_loading 和 demo_start 是同一句 —— 按钮在等车时看不出在等什么');
  }

  // 折叠状态**不许进可见文字**。
  //
  // 上线后实机读到的是 `Quality · High show` ——「展开」两个字和右边的 ▾
  // 说的是同一件事，拼在一起却成了一句断掉的英文（中文侧同样别扭）。
  // 它能上线是因为两边都"有这条文案"，只是没人把它摆出来看过。
  // 判据：折叠的两个键只能经 `setAttr` 进 aria-label，不能经 `setText` 上屏。
  asserts++;
  {
    const setTextFold = /setText\s*\([^)]*fold_(?:open|close)/.test(title);
    const setAttrFold = /setAttr\s*\([^)]*fold_(?:open|close)/.test(title);
    if (setTextFold) {
      probs.push('titleScreen.ts 把 fold_open / fold_close 拼进了可见文字 —— 折叠线上会出现「Quality · High show」这种断句');
    }
    if (!setAttrFold) {
      probs.push('titleScreen.ts 没有把 fold_open / fold_close 放进 aria-label —— 读屏用户拿不到折叠状态');
    }
  }

  // ④ 心神三处同名，且不再是 Heart。
  //
  //    `verify_i18n_glossary` 已经钉住"引导页教的词 == HUD 用的 label"，
  //    这一条补的是另一半：**商店描述**（shops.json 的 desc_en）写的是 Composure，
  //    而 HUD 当时写的是 Heart。判据只比前两处，比不到商品描述那条。
  asserts++;
  {
    const g = I18N.en.glossary_mood;
    const m = I18N.en.mood_label;
    if (/heart/i.test(g) || /heart/i.test(m) || /heart/i.test(I18N.en.shop_mood_full)) {
      probs.push('心神 的英文名里还有 Heart —— 它是会被消耗的资源，叫 Heart 读作"要攒"');
    }
    if (!m.startsWith(g)) {
      probs.push(`引导页教的是「${g}」而 HUD 写的是「${m}」—— 同一个资源两个名字`);
    }
    const tea = read('data/generated/shops.json');
    if (new RegExp(`Composure back by one`).test(tea) && !/Composure/.test(m)) {
      probs.push('商店描述写 Composure 而 HUD 不写 —— 三处对不齐');
    }
  }

  return expect(
    probs.length === 0,
    probs.length
      ? probs.join('；')
      : '演示等车有明示 · Esc 关得掉铺子 · 心神三处同名',
    asserts,
  );
});

/**
 * 关键路径上的资产，源必须在仓库里。
 *
 * ## 它守的是哪一族
 *
 * 自行车是**玩家第一眼看到的东西**，也落在首屏关键路径上。
 * 它的源本来在 `D:/code/20261001/modelbone/…`，不提交，于是：
 *
 * · 干净克隆跑不了 `assets:all`（真正的原因不是"管线坏了"，是"输入不在"）；
 * · README 资产表里 `22.3MB → 5.0MB` 那一行**没有任何东西可以对照**——
 *   而它实际上压到的是 2.79MB，比承诺值大 3.4 倍，多年没人发现，
 *   因为**验证它的那条管线在干净克隆上报成功**。
 *
 * 把它收进 `assets-src/` 之后，上面第一、二条才成立。
 *
 * ## 为什么判的是"存在 + 指向正确"，而不是"跑一遍管线"
 *
 * 跑管线要 20MB 的读 + 两趟重编码，在每一条回归里做一遍不划算，
 * 而且它验的是当次结果、不是"下一个克隆能不能重跑"。
 * 不变式是那条**永久的**事实：**这个文件在版本库里，且清单指向它**。
 *
 * 顺带钉一个数量级：源必须明显大于产物。真压缩过一轮的 GLB
 * 不会比它的源更大——两者反过来就说明指错了文件，
 * 而"指错文件"的症状是压出来一台**轮子不转**的车（见 assets-src/README.md）。
 *
 * 会红的做法：
 *   · 从版本库删掉 `assets-src/vehicles/bicycle_clean.glb`   → 红
 *   · 把清单里那一项改回 `SRC_VEHICLE`                        → 红
 *   · 把某个几 KB 的占位文件放在那个路径上                     → 红（数量级）
 */
check('verify_assets_src', () => {
  let asserts = 0;
  const probs: string[] = [];

  const SRC_REL = join('assets-src', 'vehicles', 'bicycle_clean.glb');
  const OUT_REL = join('public', 'models', 'bicycle.glb');
  const srcPath = join(process.cwd(), SRC_REL);
  const outPath = join(process.cwd(), OUT_REL);

  // 1. 源在，而且是一个**真的高模**，不是占位文件。
  asserts++;
  let srcBytes = 0;
  if (!existsSync(srcPath)) {
    probs.push(`${SRC_REL} 不在仓库里 —— 干净克隆压不出自行车，而它在首屏关键路径上`);
  } else {
    srcBytes = statSync(srcPath).size;
    // 184,433 面 + 21 张贴图实际是 21.5MB。给一个 20MB 的地板：
    // 低了说明被换成了占位文件或者半截导出。
    if (srcBytes < 20 * 1024 * 1024) {
      probs.push(`${SRC_REL} 只有 ${(srcBytes / 1048576).toFixed(2)}MB —— 那不是 184,433 面那台车（应该 ≈21.5MB）`);
    }
  }

  // 2. 产物在。
  asserts++;
  if (!existsSync(outPath)) {
    probs.push(`${OUT_REL} 不在 —— 游戏缺车`);
  }

  // 3. 源必须明显大于产物：这是"指对了文件"的反向证据。
  asserts++;
  if (srcBytes > 0 && existsSync(outPath)) {
    const outBytes = statSync(outPath).size;
    if (srcBytes <= outBytes) {
      probs.push(
        `源（${(srcBytes / 1048576).toFixed(2)}MB）没有比产物（${(outBytes / 1048576).toFixed(2)}MB）大 —— ` +
          `清单多半指到了别的地方。压过一轮的 GLB 不可能比它的源更大`,
      );
    }
  }

  // 4. 清单里自行车那一项指向仓库内，不是仓库外。
  asserts++;
  {
    const src = readFileSync(join(process.cwd(), 'tools', 'extra-models.mjs'), 'utf8');
    // 只看那一条：'bicycle_clean.glb' 开头的数组项。
    const entry = src.match(/\[\s*'bicycle_clean\.glb'[^\]]*\]/)?.[0] ?? '';
    if (!entry) {
      probs.push("extra-models.mjs 里找不到 ['bicycle_clean.glb', …] 这一项 —— 自行车不在清单里");
    } else if (!/SRC_INREPO/.test(entry)) {
      probs.push(`自行车那一项没有指向 SRC_INREPO（现在是：${entry}）—— 干净克隆压不出它`);
    }
    // 外部那份车模还在被引用是正常的（GIFT188_SRC_EXTRA），但要留着注释提醒。
    asserts++;
    if (!/别和\s*`?D:\/code\/20260926/.test(src)) {
      probs.push('extra-models.mjs 里丢了「别和 D:/code/20260926 那台下载的车搞混」的提醒 —— 它和 SRC_BIKE 指向同一个文件名前缀，极易接错');
    }
  }

  return expect(
    probs.length === 0,
    probs.length
      ? probs.join('；')
      : `自行车源在仓库内（${(srcBytes / 1048576).toFixed(2)}MB → ${(existsSync(outPath) ? (statSync(outPath).size / 1048576).toFixed(2) : '?')}MB），清单指向它`,
    asserts,
  );
});

export function runAll(): { name: string; ok: boolean; detail: string; asserts: number }[] {
  return results.map((r) => {
    try {
      const res = r.run();
      return { name: r.name, ...res };
    } catch (e) {
      return { name: r.name, ok: false, detail: `抛异常：${(e as Error).message}`, asserts: 0 };
    }
  });
}

export function checkNames() {
  return results.map((r) => r.name);
}

