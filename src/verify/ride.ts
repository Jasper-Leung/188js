/**
 * 骑行链路的端到端自检 —— **在 Node 里真的把车跑起来**。
 *
 * ## 为什么需要这一条
 *
 * 曾经出过一个 bug：引导页的「开始骑行」直接调了 UI 自己的 `enterWorld()`，
 * 没通知宿主，于是宿主 `phase` 停在 `'onboarding'`，
 * `canRide = phase === 'roaming'` 恒为假，`setCanMove(false)` 把车速钉在 0。
 *
 * 它的症状极具欺骗性：HUD 在、小地图在、世界在转、演示能自己骑，
 * **只有"玩家推摇杆、按 W，车不动"**。而键盘与摇杆走同一条链路，
 * 所以两个都失效，看起来像"输入系统坏了"。
 *
 * 而这一类 bug 有一个共同点：**所有断言都是绿的**。
 * 8 字形状对、经济对、文案对、画质档对——只有"动词"没了。
 * 所以必须有一条**真的把动词跑一遍**的断言，而不是靠人肉去玩一下。
 *
 * ## 为什么能在 Node 里跑
 *
 * `Terrain` / `Road` / `Stations` / `Ride` 都不碰 WebGL：
 * 它们只用 three 的向量、矩阵和 Object3D 树。所以可以在没有浏览器的
 * 情况下构造出完整的一辆车，喂 60 帧油门，然后看它有没有真的动。
 */
import { Terrain } from '../world/terrain';
import { Road, JUNCTION, ROAD } from '../world/road';
import { Stations } from '../world/stations';
import { Ride } from '../world/ride';
import { PRESETS } from '../core/settings';
import { RIDE, WORLD, ROADMESH } from '../data/raw';
import { canRide } from '../game/phase';
import { CENTERLINE, TOTAL_ARCLENGTH, pointAtArcLength } from '../data/route';
import { Object3D } from 'three';

/** 一个不碰 WebGL 的相机替身。骑行只写它的 position / lookAt。 */
function fakeCamera() {
  return {
    position: { x: 0, y: 0, z: 0, set() {}, copy() {} },
    lookAt() {},
    rotateZ() {},
    name: '',
    matrixAutoUpdate: true,
    updateMatrix() {},
    updateMatrixWorld() {},
  } as never;
}

function build() {
  const preset = PRESETS[1];
  const terrain = new Terrain();
  const road = new Road(terrain);
  const stations = new Stations(preset, terrain);
  const ride = new Ride(terrain, road, stations, fakeCamera());
  // **显式切到自行车**再量。
  // 游戏的默认模式是 `foot`（用户要求：起始没有载具，只有角色），
  // 而徒步的极速是 6 m/s、加速度 4 —— 不切的话这里量到的全是徒步的手感，
  // 然后**每一秒都会红**，而红的原因写着"应为 ACCEL=8"，看着像加速度被改坏了。
  // 实际上被量错了对象。
  //
  // 必须先挂一个**占位车模**：`Vehicle.canEnter('bike')` 要求模型存在
  // （这是"不给切到空载具"那条规则的落点），而 Node 里没有 GLB 可加载。
  ride.vehicle.attach({ bike: new Object3D(), skate: null, char: null, clips: {} });
  ride.vehicle.set('bike');
  const start = pointAtArcLength(0).pos;
  ride.spawn(start.x, start.z, 0);
  return { terrain, road, stations, ride, start };
}

/**
 * 骑行链路的断言部分。**这是"车到底能不能动"的唯一一条自动化保证。**
 *
 * 数值全部对着 `RIDE` 里的常量算，而不是对着"看起来差不多"：
 * 一秒满油门必须正好是 ACCEL m/s，满舵 0.5 秒必须正好是 TURN 角度，
 * 极速必须正好是 MAX_SPEED。差一点点就说明有人改了一边没改另一边。
 */
export function assertRide(): { ok: boolean; detail: string; asserts: number } {
  const probs: string[] = [];
  let asserts = 0;
  const { ride, start } = build();

  asserts++;
  if (!ride.onRoad()) probs.push(`出生点 (${start.x.toFixed(1)}, ${start.z.toFixed(1)}) 不在路面上`);

  // 阶段机否决时，油门踩到底也不能动 —— 这正是当初那个 bug 的本体
  asserts++;
  ride.setCanMove(canRide({ phase: 'onboarding', checkInPressed: false, narrativeBusy: false, checkInStage: 'none' }));
  for (let i = 0; i < 60; i++) ride.fixedUpdate(1 / 60, { throttle: -1, steer: 0 });
  if (ride.speedValue !== 0) probs.push(`阶段机否决时车动了（${ride.speedValue} m/s）`);

  // 放行时：一秒满油门 = ACCEL，位移 = ACCEL/2（匀加速的半程）
  asserts++;
  ride.setCanMove(canRide({ phase: 'roaming', checkInPressed: false, narrativeBusy: false, checkInStage: 'none' }));
  const x0 = ride.pos.x;
  const z0 = ride.pos.z;
  for (let i = 0; i < 60; i++) ride.fixedUpdate(1 / 60, { throttle: -1, steer: 0 });
  if (Math.abs(ride.speedValue - RIDE.ACCEL) > 0.05) {
    probs.push(`一秒满油门车速 ${ride.speedValue.toFixed(2)}，应为 ACCEL=${RIDE.ACCEL}`);
  }
  asserts++;
  const moved = Math.hypot(ride.pos.x - x0, ride.pos.z - z0);
  const wantMoved = RIDE.ACCEL / 2;
  if (Math.abs(moved - wantMoved) > 0.1) {
    probs.push(`一秒位移 ${moved.toFixed(2)}m，应为 ${wantMoved.toFixed(2)}m`);
  }

  // 转向：0.5 秒满舵
  asserts++;
  const h0 = ride.headingValue;
  for (let i = 0; i < 30; i++) ride.fixedUpdate(1 / 60, { throttle: -1, steer: 1 });
  const turned = Math.abs(ride.headingValue - h0);
  const tf = Math.min(Math.abs(ride.speedValue) / 3, 1);
  const wantTurn = RIDE.TURN_SPEED * 0.5 * tf;
  if (Math.abs(turned - wantTurn) > 0.05) {
    probs.push(`满舵 0.5 秒转了 ${(turned * 57.3).toFixed(1)}°，应为 ${(wantTurn * 57.3).toFixed(1)}°`);
  }

  // 极速封顶：踩十秒也不能超过 MAX_SPEED
  asserts++;
  const onRoadTop = sprintOnRoad(ride, 10);
  if (Math.abs(onRoadTop - RIDE.MAX_SPEED) > 0.05) {
    probs.push(`在路上踩十秒车速 ${onRoadTop.toFixed(2)}，应为 MAX_SPEED=${RIDE.MAX_SPEED}`);
  }

  // 反过来：**不修正方向**地踩十秒，必须明显慢于极速。
  //
  // 这条守的是"离路降速真的接在链路上了"。它和上面那条是一对：
  // 上面量"在路上能开多快"，这条量"偏出去会被按住"。
  // 只写上面那条的话，把 `applyOffRoad()` 整段删掉回归照样全绿。
  asserts++;
  const drifted = sprintFree(ride, 10);
  if (drifted >= RIDE.MAX_SPEED - 0.5) {
    probs.push(`不修正方向踩十秒仍有 ${drifted.toFixed(2)} m/s（≈极速），离路没有被按住`);
  }
  asserts++;
  if (ride.onRoad()) {
    probs.push('不修正方向踩了十秒居然还在路上——离路判定或出生点朝向有问题');
  }

  // 松油门要能停下来（不能一路滑）
  asserts++;
  for (let i = 0; i < 600; i++) ride.fixedUpdate(1 / 60, { throttle: 0, steer: 0 });
  if (ride.speedValue > 0.1) probs.push(`松手十秒后还在滑（${ride.speedValue.toFixed(2)} m/s）`);

  asserts++;
  if (WORLD.RECHECK_IN_MIN_DIST <= 0) probs.push('打卡重入距离非法');

  // ---- 8 字交叉口 ----
  //
  // 交叉口是这个游戏唯一的地标性空间关系（"188 号环线自己穿过自己"），
  // 以前那里盖着一个圆盘，而圆盘把两件事都遮住了：两条 ribbon 的高度差
  // （Z-fighting）与笔直穿过路口的标线。现在改成压平 + 按世界距离抑制标线，
  // 于是这里必须守住三件事，三条各自会红的理由写在注释里。
  const j = assertJunction(probs);
  asserts += j.asserts;

  const detail = probs.length
    ? probs.join('；')
    : `1s 满油门 ${RIDE.ACCEL} m/s · 满舵 0.5s ${(wantTurn * 57.3).toFixed(0)}° · 极速 ${RIDE.MAX_SPEED} m/s · 交叉口 ${j.detail}`;
  return { ok: probs.length === 0, detail, asserts };
}

/**
 * 十秒满油门，**每一步都把车按回中心线**，返回末速。
 *
 * 原来这一步是"一直直着踩十秒"。而实测直着踩 **2 秒**就离路了
 * （`off` 从 0 涨到 4.3m、`road=n`），加上离路降速之后，那条判据量到的
 * 就不再是"极速"而是"草地上的极速"——它红了，而红的原因写着
 * `应为 MAX_SPEED=15`，看着像极速被改坏了。
 *
 * 它声称量的是极速，那就让它**真的在路上量**。
 * `ride.pos` 返回的就是模拟自己用的那个向量，直接改它即可；
 * 速度是独立字段，不会被这一下带走，而 `applyOffRoad()` 每步重读位置，
 * 于是它量到的确实是"在路上的极速上限"。
 */
function sprintOnRoad(ride: Ride, seconds: number): number {
  const p = pointAtArcLength(0).pos;
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) {
    ride.pos.set(p.x, ride.pos.y, p.z);
    ride.fixedUpdate(1 / 60, { throttle: -1, steer: 0 });
  }
  return ride.speedValue;
}

/** 十秒满油门，**不修正方向**——用来量"偏出去会被按住多少"。 */
function sprintFree(ride: Ride, seconds: number): number {
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) ride.fixedUpdate(1 / 60, { throttle: -1, steer: 0 });
  return ride.speedValue;
}

/**
 * 交叉口的三条硬判据。
 *
 * 这三条守的是"去掉圆盘之后路口还是不是路口"，而它们**都是量出来的**，
 * 不是看代码看出来的：
 *
 * 1. **共面**。半径 6m 之内所有中心线点的路面高度必须落在同一个值上。
 *    会红的做法：把 `flattenJunction` 里的 `planeY` 从 max 改成平均值，
 *    或者干脆不调它——两条 ribbon 会差出几厘米，深度缓冲开始打架。
 * 2. **连续**。沿中心线走过交叉口，路面高度每 0.5m 的变化必须小于 1%。
 *    会红的做法：把收尾的 `smoothstep` 换成线性插值，收尾带会出现折角。
 * 3. **骑得过去**。真的把车放进路口正中央，全油门冲过去，
 *    车必须一直 `onRoad()`，而且高度不能跳。
 *    会红的做法：压平只作用在高度、不作用在三角形的注册上，
 *    于是 `getHeightAt` 在叠合区返回旧值——画面上看着平，车却会陷进去。
 */
function assertJunction(probs: string[]): { asserts: number; detail: string } {
  const road = build().road;
  const c = JUNCTION.center;
  const plane = JUNCTION.planeY;
  let asserts = 0;

  asserts++;
  if (!Number.isFinite(plane)) {
    probs.push('交叉口公共平面高度不是有限数，压平没跑');
    return { asserts, detail: '压平未生效' };
  }

  // 1. 共面：核心半径 + 一点余量之内，所有中心线点的路面高度都应贴近 planeY。
  //    阈值 5cm：权重在过渡带上不为 1，两支在 3m 处仍差 (1-w)×0.16 ≈ 2cm。
  asserts++;
  let worstFlat = 0;
  let nFlat = 0;
  const core = JUNCTION.coreRadius + 1.5;
  for (const p of road.centerline) {
    if (Math.hypot(p.x - c.x, p.z - c.z) > core) continue;
    nFlat++;
    const y = road.getHeightAt(p.x, p.z);
    if (!Number.isFinite(y)) continue;
    worstFlat = Math.max(worstFlat, Math.abs(y - plane));
  }
  if (nFlat < 8) {
    probs.push(`交叉口核心区只取到 ${nFlat} 个中心线点，压平范围可能不对`);
  } else if (worstFlat > 0.05) {
    probs.push(`交叉口核心区路面不平：最大偏差 ${(worstFlat * 100).toFixed(1)}cm（压平后应当共面）`);
  }

  // 2. 不鼓包：交叉口平面不能离当地地面太远。
  //    这条守的是"基准高度取错了半径"这一类错。
  //    曾经按 `PLAZA_RADIUS = 12m` 取半径内的最高点，而 11m 外的采样点
  //    已经在爬坡，低的那一支于是被抬 0.58m——路口中央凭空鼓一个包。
  //    0.4m 的余量留给 `max(左中右)` 本身带来的填方（实测 0.32m），
  //    而鼓包那次是 0.89m，两者差得开。
  asserts++;
  const groundAtCore = road.groundHeightAt(c.x, c.z) + 0.15;
  const hump = plane - groundAtCore;
  if (hump > 0.4) {
    probs.push(`交叉口平面高出当地地面 ${hump.toFixed(2)}m，路口中央会鼓包`);
  }
  if (hump < -0.05) {
    probs.push(`交叉口平面低于当地地面 ${(-hump).toFixed(2)}m，路口中央会塌坑`);
  }

  // 3. 沿整条中心线走过路口：每一步都必须在路上，高度不能跳。
  //    做法是**逐点把车放上去**而不是真的开过去——
  //    真开的话 6.7 秒要跑 90m，弯道必然先冲出路面，
  //    于是在测"弯道能不能过"而不是"路口平不平"。
  asserts++;
  const { ride } = build();
  let jIdx = 0;
  let jBest = Infinity;
  for (let i = 0; i < road.centerline.length; i++) {
    const p = road.centerline[i];
    const d = Math.hypot(p.x - c.x, p.z - c.z);
    if (d < jBest) {
      jBest = d;
      jIdx = i;
    }
  }
  const span = Math.round(24 / 0.5); // 前后各 24m
  let offRoad = 0;
  let jump = 0;
  let prevY = NaN;
  const from = Math.max(1, jIdx - span);
  const to = Math.min(road.centerline.length - 1, jIdx + span);
  for (let i = from; i <= to; i++) {
    const p = road.centerline[i];
    const q = road.centerline[i + 1] ?? p;
    ride.spawn(p.x, p.z, Math.atan2(q.x - p.x, q.z - p.z));
    if (!ride.onRoad()) offRoad++;
    if (Number.isFinite(prevY)) jump = Math.max(jump, Math.abs(ride.pos.y - prevY));
    prevY = ride.pos.y;
  }
  const steps = to - from;
  if (offRoad > 0) probs.push(`路口前后 24m 内有 ${offRoad}/${steps + 1} 个点不在路面上`);
  // 一步 0.5m。这一带自然路面本身就有 24% 的坡（≈0.12m/步），
  // 所以阈值按"两倍自然坡度"给：0.30m。真台阶会是 1.9m 那个量级。
  if (jump > 0.3) probs.push(`沿路口走过时高度跳了 ${jump.toFixed(2)}m/步`);

  // 4. 标线断口必须**连续**。
  //    这是"路口那条白线横穿过去"那个 bug 的直接判据。
  //    做法：沿每条支路把自己的边线从头走一遍路口，算出每一段的可见度，
  //    然后要求"看不见的那一段"是一个**连续区间**、中间没有孤岛。
  //
  //    径向判据（`dCross`）在这里必然失败：它对两条路给出同一个停笔半径，
  //    而两条边线真正要避开的是对方的**横向**铺面，差了一个 sin(夹角)。
  //    于是靠内侧的那条会在断口中间留下一小截可见的线——正好是孤岛。
  // 4. 路口铺面上不许有标线。
  //    这条直接对应"路口有条白线横穿过去"，而且它不关心断口好不好看，
  //    只关心一条不变量：**只要本片元还压在另一条支路的铺面上，
  //    中线与边线就必须都是 0。**
  //    早先写的是"断口要连续、不许有孤岛"——那是另一个失效模式
  //    （径向判据留下的中间一小截），而真正的原因是**断口太短**：
  //    旧版让开到 7.5m，铺面却被加宽到 8.775m，于是中间 1.2m 里白线照旧。
  //    两种判据都留着会互相掩护，所以只留直接的那条。
  asserts++;
  const paved = JUNCTION.paved;
  /** 路口处沥青的实际半宽。`JUNCTION.paved` 必须 ≥ 它，否则标线会画上去 */
  const effPaved = ROADMESH.TOTAL_HALF_WIDTH * ROAD.JUNCTION_WIDE;
  const n = road.centerline.length;
  const sideLats = [ROADMESH.ROAD_HALF_WIDTH - 0.18, 0];
  let paintedOver = 0;
  let worstOver = 0;
  let gapLo = Infinity;
  let gapHi = -Infinity;
  let branches = 0;
  for (const [mid, selfAxis, otherAxis] of [
    [JUNCTION.branchA, JUNCTION.axisA, JUNCTION.axisB],
    [JUNCTION.branchB, JUNCTION.axisB, JUNCTION.axisA],
  ] as const) {
    if (mid < 0) continue;
    branches++;
    // 边线（横向 3.82）与中线（横向 0）各取两侧
    for (const lat of sideLats) {
      for (const side of [1, -1]) {
        let inGap = false;
        let entries = 0;
        for (let k = -70; k <= 70; k++) {
          const p = road.centerline[(mid + k + n) % n];
          const wx = p.x + selfAxis.x * lat * side - JUNCTION.center.x;
          const wz = p.z + selfAxis.z * lat * side - JUNCTION.center.z;
          const dSelf = Math.abs(wx * selfAxis.x + wz * selfAxis.z);
          const dOther = Math.abs(wx * otherAxis.x + wz * otherAxis.z);
          const dOff = Math.max(dSelf, dOther);
          // 边线恢复得比中线慢，取较严格的那个
          const vis = smoothstep01(paved, paved + ROAD.JUNCTION_EDGE_FADE, dOff);
          if (dOff < effPaved && vis > 0.02) {
            paintedOver++;
            worstOver = Math.max(worstOver, vis);
          }
          const isGap = vis < 0.5;
          if (isGap) {
            if (!inGap) {
              entries++;
              if (entries === 1) gapLo = k;
            }
            inGap = true;
            gapHi = k;
          } else {
            inGap = false;
          }
        }
        if (entries > 1) paintedOver++;
      }
    }
  }
  if (branches < 2) {
    probs.push('没能从中心线上找出两条穿过路口的支路，标线抑制无从验证');
  } else if (paintedOver > 0) {
    probs.push(
      `路口铺面上还有 ${paintedOver} 处标线可见（最深 ${(worstOver * 100).toFixed(0)}%）——` +
        `铺面半宽 ${effPaved.toFixed(2)}m，而标线只让开到 ${paved.toFixed(2)}m`,
    );
  } else if (!(gapLo <= 0 && gapHi >= 0)) {
    probs.push(`标线在路口没有断口（断口 ${gapLo}..${gapHi}），判据本身失效了`);
  }

  return {
    asserts,
    detail: `共面偏差 ${(worstFlat * 100).toFixed(1)}cm · 离地 ${hump.toFixed(2)}m · 走 48m 最大跳变 ${jump.toFixed(3)}m/步 · 离路 ${offRoad}/${steps + 1} · 铺面无标线(断口 ${(-gapLo * 0.5).toFixed(1)}..${(gapHi * 0.5).toFixed(1)}m)`,
  };
}

function smoothstep01(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

/** 供探针打印用 */
export function probeRide() {
  console.log('=== 骑行链路自检（Node，无 WebGL）===');

  const { ride, start } = build();
  console.log(`  出生点 (${start.x.toFixed(2)}, ${start.z.toFixed(2)})  在路上=${ride.onRoad()}`);

  // --- 1. 阶段机否决时，车必须不动 ---
  const blocked = canRide({ phase: 'onboarding', checkInPressed: false, narrativeBusy: false, checkInStage: 'none' });
  ride.setCanMove(blocked);
  for (let i = 0; i < 60; i++) ride.fixedUpdate(1 / 60, { throttle: -1, steer: 0 });
  console.log(`  phase=onboarding 时踩满油门 1 秒 → 车速 ${ride.speedValue.toFixed(3)} m/s`);
  if (ride.speedValue !== 0) console.log('  ✗ 阶段机否决失效：车居然动了');

  // --- 2. 阶段机放行时，车必须动 ---
  const allowed = canRide({ phase: 'roaming', checkInPressed: false, narrativeBusy: false, checkInStage: 'none' });
  console.log(`  canRide(roaming) = ${allowed}`);
  ride.setCanMove(allowed);
  const p0 = { x: ride.pos.x, z: ride.pos.z };
  for (let i = 0; i < 60; i++) ride.fixedUpdate(1 / 60, { throttle: -1, steer: 0 });
  const p1 = { x: ride.pos.x, z: ride.pos.z };
  const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  console.log(`  phase=roaming 时踩满油门 1 秒 → 车速 ${ride.speedValue.toFixed(2)} m/s，位移 ${moved.toFixed(2)} m`);
  if (ride.speedValue <= 0) console.log('  ✗ 油门没有生效');
  if (moved <= 0.1) console.log('  ✗ 位置没有变化');

  // --- 3. 转向 ---
  const h0 = ride.headingValue;
  for (let i = 0; i < 30; i++) ride.fixedUpdate(1 / 60, { throttle: -1, steer: 1 });
  console.log(`  满舵 0.5 秒 → 车头转了 ${((ride.headingValue - h0) * 180 / Math.PI).toFixed(1)}°`);
  if (Math.abs(ride.headingValue - h0) < 0.01) console.log('  ✗ 转向没有生效');

  // --- 4. 车必须始终留在路面上 ---
  let offRoad = 0;
  let maxLateral = 0;
  for (let i = 0; i < 600; i++) {
    ride.fixedUpdate(1 / 60, { throttle: -1, steer: 0.25 });
    if (!ride.onRoad()) offRoad++;
    let best = Infinity;
    for (let k = 0; k < CENTERLINE.length; k += 8) {
      const d = Math.hypot(CENTERLINE[k].x - ride.pos.x, CENTERLINE[k].z - ride.pos.z);
      if (d < best) best = d;
    }
    maxLateral = Math.max(maxLateral, best);
  }
  console.log(`  直行+微舵 10 秒：离开路面 ${offRoad}/600 帧，最大横向偏移 ${maxLateral.toFixed(2)} m（环线全长 ${TOTAL_ARCLENGTH.toFixed(0)} m）`);
  if (offRoad > 0) console.log('  ✗ 车掉出了路面');
  console.log(`  末速 ${ride.speedValue.toFixed(2)} m/s（极速 15）`);
}
