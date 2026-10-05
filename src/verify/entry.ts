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
import { CENTERLINE, TOTAL_ARCLENGTH, STATIONS, shapeReport, nearestArcParam, pointAtArcLength } from '../data/route';
import { ROAD, ROADMESH, ECON, SHOPS, MINIGAMES, I18N, TERRAIN, WORLD, WATER } from '../data/raw';
import {
  createMiniGame,
  MINI_GAME_IDS,
  type MiniGameContext,
  type MiniGameResult,
} from '../game/minigames';
import { ARCH_BY_MODEL_IDX, archKindFor, buildStationArch, type ArchKind } from '../world/architecture';
import { auditSummary } from '../debug/probe';
import { planBasins, naturalHeightAt, basinDepthAt, getBasins, checkConsistency } from '../world/basins';
import { stickVector, keyToVec } from '../core/stick';
import { decideTouch } from '../core/touch';
import { groundOffsetFor, bottomOf, Vegetation } from '../world/vegetation';
import { Box3, BoxGeometry, CylinderGeometry, BufferAttribute, BufferGeometry, InterleavedBuffer, InterleavedBufferAttribute, Mesh, Object3D, Vector3, Group, AnimationClip, KeyframeTrack, Bone } from 'three';
import { Stations } from '../world/stations';
import { Scenery, sceneryPlacements, scenerySpec, distToRoad, type SceneryKind } from '../world/scenery';
import { Terrain } from '../world/terrain';
// `ROAD` 这个名字在 `data/raw` 已经被路面网格数据占用了，
// 这里要的是 `world/road` 里那组**派生**常量（铺面半宽、站脚半宽…），所以取别名。
import { Road, ROAD as ROAD_GEOM } from '../world/road';
import { verticalFovForAspect, horizontalFromVertical, FOV_BASE, FOV_REF_ASPECT, FOV_MIN_HORIZONTAL, FOV_MAX } from '../core/fov';
import { canRide, isInWorld, interactAt } from '../game/phase';
import { RIDE } from '../data/raw';
import { CAM_MODES, camParams, OFFROAD, offRoadFactorFor } from '../world/ride';
import { Vehicle, MODE_TUNE, RIDE_MODES, FOOT_LATERAL_OFFSET, autoScaleToHeight, collectClips, BICYCLE_YAW, MOTORCYCLE_YAW, CHAR_FACING_YAW, MODEL_HEADS, MODEL_AXLES, facingDir, motoLeanAt, bicycleScale, localUnion, type RideMode } from '../world/vehicle';import { assertRide } from './ride';
import { GameStateManager } from '../game/state';
import { PRESETS, clampTier } from '../core/settings';
import { TIER_LOW, TIER_MEDIUM, TIER_HIGH, type Tier } from '../core/capability';

/** 把角度差折进 (−π, π]。朝向判据要用：0 与 2π 是同一个方向。 */
function wrapPi(a: number): number {
  let x = (a + Math.PI) % (Math.PI * 2);
  if (x < 0) x += Math.PI * 2;
  return x - Math.PI;
}

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
      : `16 座 / 5 碎片 / 槽位 云茶琴竹禽 / 程序化地标 ${archReport.length} 类 ${totalArchTris} 三角面 · 7 类全有真屋顶`,
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
    });
  }
  return out;
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

  return expect(probs.length === 0, probs.length ? probs.join('；') : `${zh.length} 条，中英完全一致`, asserts);
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

  // 自然高程的 clamp 必须真的生效。
  // 采样要走**二维网格**：早先用 `(i*37.1) % 800` 的一维伪随机取点，
  // 落点高度集中在一条斜线上，恰好一次都没压到 -3.0 的地板——
  // 于是"没有任何采样点在下限上"这条判据红了，而地形其实完全正常。
  // 一条只在特定采样方式下才成立的断言，等于没有断言。
  asserts++;
  const GRID = 33;
  let below = 0;
  let total = 0;
  for (let iz = 0; iz < GRID; iz++) {
    for (let ix = 0; ix < GRID; ix++) {
      const x = (ix / (GRID - 1)) * 800 - 400;
      const z = (iz / (GRID - 1)) * 800 - 400;
      const h = naturalHeightAt(x, z);
      if (!Number.isFinite(h) || h < -3.0 - 1e-9 || h > 6.0 + 1e-9) {
        probs.push(`自然高程越界：${h} @ (${x.toFixed(0)}, ${z.toFixed(0)})`);
        iz = GRID;
        break;
      }
      if (Math.abs(h + 3.0) < 1e-9) below++;
      total++;
    }
  }
  asserts++;
  const ratio = below / total;
  if (ratio < 0.05) {
    probs.push(`只有 ${(ratio * 100).toFixed(1)}% 的采样点压在 -3.0 下限上，clamp 可能没生效`);
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
    const wet = pts.filter((p) => p.y < WATER.WATER_LEVEL + 0.6);
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
  const BONES = [
    'mixamorig:Hips',
    'mixamorig:Spine',
    'mixamorig:LeftFoot',
    'mixamorig:RightFoot',
    'mixamorig:LeftToeBase',
    'mixamorig:RightToeBase',
  ];
  for (const b of BONES) {
    const bone = new Bone();
    bone.name = b;
    char.add(bone);
  }

  const times = new Float32Array([0, 0.5, 1]);
  /** 一条位置轨道；`drift` 是水平方向的根位移（要断言它被抹成 0）。 */
  const posTrack = (bone: string, drift: number) =>
    new KeyframeTrack(
      `${bone}.position`,
      times,
      Float32Array.from([0, 0, drift, 0, 0, drift, 0, 0, drift]),
    );
  /** 一条四元数轨道。三个轴一起转，用来凑满「每根骨都有归属」。 */
  const quatTrack = (bone: string) => {
    const n = times.length;
    const v = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) v.set([0, 0, 0, 1], i * 4);
    return new KeyframeTrack(`${bone}.quaternion`, times, v);
  };
  /** 移动三段：覆盖全部 6 根骨（含脚与分趾），并且带 3.2m 量级的根位移。 */
  const fullClip = (name: string, dur: number) =>
    new AnimationClip(name, dur, [
      posTrack('mixamorig:Hips', 3.2),
      ...BONES.slice(1).map((b) => quatTrack(b)),
    ]);
  /** 待机：按合片后的真实情况——**只覆盖 4 根，脚与分趾骨没有轨道**。 */
  const idleClip = () =>
    new AnimationClip('idle', 2, [
      posTrack('mixamorig:Hips', 0),
      quatTrack('mixamorig:Spine'),
      quatTrack('mixamorig:LeftFoot'),
      quatTrack('mixamorig:RightFoot'),
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
      fullClip('run', 0.7),
      fullClip('walk', 1.0),
      fullClip('骑自行车', 1.0),
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
  // `walk` / `run` / `骑自行车` 都带根位移（来源项目实测约 3.2m，且位移在
  // 骨架的祖先节点上）。不抹掉的话，动画把人往前拖、车把人往后拽，
  // 停下的那一刻根节点弹回原位 —— 玩家看到的就是**「停止走动的时候
  // 人就回来一段距离」**。
  asserts++;
  {
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
      const rootTrack = clip.tracks.find(
        (tr) => tr.name.endsWith('.position') && /(^|:)hips$/i.test(tr.name.slice(0, -'.position'.length)),
      );
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

  // 5. 朝向：徒步时角色必须**朝着自己走的方向**。
  //    原来是 `heading + π/2`（侧对路肩），用户要求方向与行走方向一致。
  asserts++;
  for (const h of [0, 0.7, -1.3, 2.4, Math.PI]) {
    run(1.5, 0.5, h);
    // ★ 期望值是 heading **+ CHAR_FACING_YAW**，不是 heading。
    //   人物模型正面朝 +Z、车头约定是 -Z，差 180°。原来的判据写的是
    //   char.rotation.y - h —— **它把 bug 写进了判据**，所以代码和判据
    //   一起错、一起绿：实机上人一直是倒着走的。
    const diff = Math.abs(wrapPi(char.rotation.y - (h + CHAR_FACING_YAW)));
    if (diff > 1e-6) {
      probs.push(`heading=${h.toFixed(2)} 时角色朝向是 ${char.rotation.y.toFixed(3)}，差 ${(diff * 57.3).toFixed(1)}°`);
    }
  }

  // 6. 滑板也要朝前进方向（同一个 bug 的另一半）
  asserts++;
  v.set('skate');
  for (const h of [0.5, -0.9, 2.0]) {
    run(2, 0.3, h);
    // ★ 期望值是 heading **+ CHAR_FACING_YAW**，不是 heading。
    //   人物模型正面朝 +Z、车头约定是 -Z，差 180°。原来的判据写的是
    //   char.rotation.y - h —— **它把 bug 写进了判据**，所以代码和判据
    //   一起错、一起绿：实机上人一直是倒着走的。
    const diff = Math.abs(wrapPi(char.rotation.y - (h + CHAR_FACING_YAW)));
    if (diff > 1e-6) {
      probs.push(`滑板 heading=${h.toFixed(2)} 时角色朝向差 ${(diff * 57.3).toFixed(1)}°`);
    }
  }

  run(1.2, 3);
  const walkMoving = v.footBlend.walk;
  // 存一份**站定**时的实测值给 detail 用。**不能现读**：
  // 上面第 2~4 条会把人跑起来，那时 idle 合法地是 0，
  // 现读出来的数字会写成 "idle=0.00" —— 一句和它所在那一刻的真实状态
  // 不符的话，下一个读的人会以为待机没接上。
  run(0, 2);
  const idleStanding = v.footIdleWeight;

  const summary = `站定 walk/run=0 且 idle=${idleStanding.toFixed(2)} · 走 walk ${walkMoving.toFixed(2)} · 朝向 = heading + π（人物正面朝 +Z）`;
  return expect(probs.length === 0, probs.length ? probs.join('；') : summary, asserts);
});

// ---------------------------------------------------------------- 小游戏能玩
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

  // 假 ctx：只要记录调用、不真的画。游戏不会去读像素。
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_t, k: string) {
      if (k === 'canvas') return { width: 960, height: 540 };
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

  const summary =
    `序章一次性 · 反派 ${ECON.VILLAIN_SCENE_COUNT} 集各一次 · 小游戏不锁操作`;
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

  return expect(probs.length === 0, probs.length ? probs.join('；') : '六个阶段 / 五个否决理由 / HUD 与可骑同源', asserts);
});

// ---------------------------------------------------------------- 骑行
check('verify_ride', () => {
  const r = assertRide();
  return { ok: r.ok, detail: r.detail, asserts: r.asserts };
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
    ['自行车', MODEL_AXLES.bicycle, BICYCLE_YAW],
    ['摩托车', MODEL_AXLES.motorcycle, MOTORCYCLE_YAW],
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
  if (motoLeanAt(0) >= 0) probs.push('侧倾方向为正 —— 侧撑在车的左边，符号反了就是往右倒');

  return {
    ok: probs.length === 0,
    detail:
      probs.length === 0
        ? `人物 +π / 自行车 −90° / 摩托车 +180° → 三者同为 (0, 0, −1)`
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

// ---------------------------------------------------------------- 跑
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
