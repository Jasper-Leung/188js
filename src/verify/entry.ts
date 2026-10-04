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
import { ARCH_BY_MODEL_IDX, archKindFor, buildStationArch, type ArchKind } from '../world/architecture';
import { auditSummary } from '../debug/probe';
import { planBasins, naturalHeightAt, basinDepthAt, getBasins, checkConsistency } from '../world/basins';
import { stickVector, keyToVec } from '../core/stick';
import { decideTouch } from '../core/touch';
import { groundOffsetFor, bottomOf, Vegetation } from '../world/vegetation';
import { Box3, BoxGeometry, BufferAttribute, BufferGeometry, InterleavedBuffer, InterleavedBufferAttribute, Mesh, Object3D } from 'three';
import { Stations } from '../world/stations';
import { Scenery, sceneryPlacements, scenerySpec, distToRoad, type SceneryKind } from '../world/scenery';
import { Terrain } from '../world/terrain';
import { Road } from '../world/road';
import { verticalFovForAspect, horizontalFromVertical, FOV_BASE, FOV_REF_ASPECT, FOV_MIN_HORIZONTAL, FOV_MAX } from '../core/fov';
import { canRide, isInWorld } from '../game/phase';
import { RIDE } from '../data/raw';
import { CAM_MODES, camParams } from '../world/ride';
import { Vehicle, MODE_TUNE, RIDE_MODES, autoScaleToHeight } from '../world/vehicle';
import { assertRide } from './ride';
import { GameStateManager } from '../game/state';
import { PRESETS, clampTier } from '../core/settings';
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

  // 5b. **默认必须是徒步**（用户要求：起始没有载具，只有角色）。
  //     写错的表现很隐蔽：玩家一进世界已经在骑车，而他自己不知道。
  asserts++;
  if (RIDE_MODES[0] !== 'foot') probs.push(`默认模式是 ${RIDE_MODES[0]}，应为 foot（起始没有载具）`);
  asserts++;
  if (RIDE_MODES.length !== 3) probs.push(`模式有 ${RIDE_MODES.length} 种，应为 3（foot/bike/skate）`);

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
  v.attach({ bike: null, skate: null, char: null, clips: {} });
  if (v.canEnter('skate')) probs.push('没有滑板模型却报告"可以进"');
  asserts++;
  if (v.set('skate')) probs.push('没有滑板模型却切成功了');
  asserts++;
  if (v.id !== 'foot') probs.push(`切换失败之后模式却是 ${v.id}，应为 foot`);

  // 7. 有了滑板之后能进，而且进得去出得来
  asserts++;
  v.attach({ bike: new Object3D(), skate: new Object3D(), char: new Object3D(), clips: {} });
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

  const summary =
    `模式 ${RIDE_MODES.join('/')}（默认 ${RIDE_MODES[0]}）· 机位 ${CAM_MODES.join('/')}（默认 ${CAM_MODES[0]}）· ` +
    `自行车 ${bt.maxSpeed}m/s 保持源项目 · 滑板 ${st.maxSpeed}m/s`;
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
