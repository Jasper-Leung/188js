/**
 * 路边躲避挑战 —— **纯逻辑**，不碰 DOM、不碰 three。
 *
 * ## 为什么是「路肩上的木牌」而不是「路边随便哪个地方」
 *
 * 这条路已经有一族"停下来才够得着"的东西了：五件旧物
 * （`world/relics.ts`，离中心线 路肩 + 2m，2.8m 内按 F）。
 * 新的挑战必须是**同一种动词**——主角的手伸出去的东西：
 * 一块钉在路肩上的半截木牌，按 F 读它。
 * 而不是凭空在路上刷出一堆石头、也没有任何一句话解释它为什么在这儿。
 * 所以它落在旧物那条线上，落位算法也复用同一套（离中心线的米数）。
 *
 * ## 为什么判定在这里而不是 `world.ts`
 *
 * 和 `phase.ts` 把 `canRide` 抽成纯函数、`beat.ts` 把节拍抽出来，
 * 是同一个理由：这个游戏里栽得最狠的一类 bug 是
 * 「判定写在宿主里，无头回归问不到它」。绕圈进度与碰撞判定
 * 正好是那种"肉眼看不出、只有一整圈之后才知道对不对"的东西。
 *
 * ## 公平性：路**永远留得过去一条**
 *
 * 三条车道、任意时刻只放一个障碍物，所以横向至少还剩两条通路。
 * 而「正中」那一档是**故意**留的：只有石头落在正中时，
 * 骑中心线才会撞上——否则玩家一路贴中心线就蒙过去了，那就没有躲避可言。
 * 最外那档 2.3m 配最大半径 1.15m 之后离路沿（半宽 4.0m）还剩 0.55m，
 * 所以躲得开的代价是"贴边骑"，不是"掉出路面"。
 * `verify_dodge_layout` 守的就是这两条。
 */
import { makeRng } from '../core/noise';
import { STATIONS, TOTAL_ARCLENGTH, pointAtArcLength } from '../data/route';
import { ROAD } from '../world/road';

/**
 * 车在横向上占多宽（米，取半宽）。
 *
 * **刻意不是 `ride.ts` 的 `BIKE_RADIUS = 0.9`**：那一个量的是撞场界时的
 * 接触半径（拿车轮外缘去顶边界），拿来算撞石头的话每一块石头都宽了一倍——
 * 而路面总半宽只有 **4.0m**，用 0.9 的话四条车道怎么排都排不开，
 * 玩家会被判成"无路可走"。
 *
 * 0.45 是**车把半宽**（整车宽 0.9m），也是人和石头之间真正会擦上的那个量。
 */
export const BIKE_HALF_WIDTH = 0.45;

export const OBSTACLE = {
  /** 一圈放几个。1228.8m / 22 ≈ 每 56m 一个，十米每秒就是每 5.6 秒一次。 */
  COUNT: 22,
  /** 碰撞半径区间（米）。 */
  R_MIN: 0.8,
  R_MAX: 1.15,
  /**
   * 三条车道的横向偏移（米），正 = 右侧。
   *
   * **路面总半宽只有 4.0m**（`ROADMESH.TOTAL_HALF_WIDTH`，8m 宽的一条路），
   * 而车把半宽 0.45 + 石头半径 1.15 = 1.6m 要从旁边过去——
   * 也就是说躲一块石头需要 **3.2m** 的横向空档，路上一共才 8m。
   *
   * 所以是三条而不是四条：最外那档 2.3m 配最大半径 1.15 之后离路沿还剩
   * **0.55m**，而正中那档让"绕着一块石头走"成为**必须**——玩家不能一路骑
   * 中心线蒙过去，那就没有躲避可言了。
   */
  LANES: [-2.3, 0, 2.3] as readonly number[],
  /** 相邻两个障碍至少隔多远（米）。低于这个数它们会读成一道墙而不是几块石头。 */
  MIN_GAP: 42,
  /** 从木牌起算多远才放第一个。起手就贴脸的那一下不是挑战，是惊吓。 */
  LEAD_IN: 34,
} as const;

/** 一次挑战里的一块石头。 */
export interface Obstacle {
  index: number;
  /** 沿中心线的弧长（米） */
  s: number;
  /** 离中心线的横向偏移（米），正 = 右侧 */
  lateral: number;
  /** 世界坐标（XZ）。碰撞判定量的是这个，不是那两个。 */
  x: number;
  z: number;
  /** 碰撞半径（米） */
  radius: number;
}

/** 中心线在 `s` 处的右法向（单位向量）。 */
function rightAt(s: number): { x: number; z: number } {
  const a = pointAtArcLength(Math.max(0, s - 1.5)).pos;
  const b = pointAtArcLength(Math.min(TOTAL_ARCLENGTH, s + 1.5)).pos;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  return { x: dz / l, z: -dx / l };
}

/** 弧长差归一化到 `[-L/2, L/2]`。环线是闭合的，差值会绕过 0。 */
function wrapS(d: number): number {
  const half = TOTAL_ARCLENGTH / 2;
  let v = d % TOTAL_ARCLENGTH;
  if (v > half) v -= TOTAL_ARCLENGTH;
  if (v < -half) v += TOTAL_ARCLENGTH;
  return v;
}

/**
 * 按种子铺一圈石头。
 *
 * ## 相邻两块不许落在同一条车道
 *
 * 这是整套公平性里唯一真正承重的一条。三条车道、每次换一条，
 * 于是任何一块石头旁边至少还剩两条通路；而如果允许连着两块同侧，
 * 屏幕上就可能出现「左半边两块石头 + 车正好在左边」——
 * 那一刻玩家无论怎么打方向都过不去，而他不会读成"我开得不好"，
 * 会读成"这个游戏耍我"。
 *
 * ## 抖动上限是 MIN_GAP 算出来的，不是随手写的
 *
 * 间隔 = `TOTAL_ARCLENGTH / COUNT`，抖动 ±`(间隔 − MIN_GAP)/2 × 0.8`。
 * 最坏情况下两块之间的间距仍有 `间隔 − 0.8×(间隔 − MIN_GAP)`，
 * 实测 55.9m 落回 44.8m > 42m。
 */
export function planObstacles(seed: number, startS = 0): Obstacle[] {
  const rng = makeRng((seed ^ 0x51a7c3) >>> 0);
  const n = OBSTACLE.COUNT;
  const step = TOTAL_ARCLENGTH / n;
  const jitterAmp = Math.max(0, (step - OBSTACLE.MIN_GAP) * 0.5) * 0.8;
  const out: Obstacle[] = [];
  let lane = Math.floor(rng() * OBSTACLE.LANES.length) % OBSTACLE.LANES.length;

  for (let i = 0; i < n; i++) {
    // 第一块**不加抖动**：负抖动会把它拉到 LEAD_IN 以内，
    // 而那正是「起手就贴脸」——判据量的是 `min(s) ≥ LEAD_IN`。
    const jitter = i === 0 ? 0 : (rng() * 2 - 1) * jitterAmp;
    const s = (startS + OBSTACLE.LEAD_IN + i * step + jitter) % TOTAL_ARCLENGTH;
    // 换一条与上一块不同的车道
    let next = Math.floor(rng() * (OBSTACLE.LANES.length - 1)) % (OBSTACLE.LANES.length - 1);
    if (next >= lane) next++;
    lane = next;
    const lateral = OBSTACLE.LANES[lane];
    const p = pointAtArcLength(s).pos;
    const r = rightAt(s);
    out.push({
      index: i,
      s,
      lateral,
      x: p.x + r.x * lateral,
      z: p.z + r.z * lateral,
      radius: OBSTACLE.R_MIN + rng() * (OBSTACLE.R_MAX - OBSTACLE.R_MIN),
    });
  }
  return out;
}

export type DodgeState = 'idle' | 'running' | 'hit' | 'won';

export type DodgeEvent =
  /** 骑满一圈，一件没碰 */
  | { type: 'won' }
  /** 撞上了 */
  | { type: 'hit'; obstacle: Obstacle };

/**
 * 一趟躲避挑战的状态机。
 *
 * ## 圈数为什么用**累加弧长差**而不是「起点 / 终点」
 *
 * 木牌钉在环上某处，玩家可能从任意弧长起算，所以不能用
 * 「起点 / 终点」这种写法。但也不能用「`arc` 跨过 0.5 就算一圈」——
 * 木牌如果正好落在 0.5 附近，起手那一帧就满足条件。
 *
 * 所以每帧取**带符号的弧长差**（归一化到 ±0.5），
 * 只把正的累加进 `travelled`：掉头不涨分，而骑满 1.0 就真的绕了一整圈。
 * 瞬移（读档、传送）会让差值跳出 ±0.5，那一帧的增量直接丢掉。
 */
export class DodgeRun {
  state: DodgeState = 'idle';
  /** 已经绕过的圈比例 0..1。HUD 的那根条读它。 */
  progress = 0;
  obstacles: Obstacle[] = [];
  /** 撞上的那一块（-1 = 没撞）。供结算文案指名道姓。 */
  hitIndex = -1;
  /** 绕了多远（米）。HUD 与结算屏都用它，它比比例好读。 */
  get travelledMeters(): number {
    return this.progress * TOTAL_ARCLENGTH;
  }

  private prevArc = 0;
  private travelled = 0;

  reset(): void {
    this.state = 'idle';
    this.progress = 0;
    this.obstacles = [];
    this.hitIndex = -1;
    this.travelled = 0;
  }

  /** 起跑。`arc` 是玩家当下的中心线参数（0..1）。 */
  start(arc: number, seed: number): void {
    this.state = 'running';
    this.progress = 0;
    this.hitIndex = -1;
    this.travelled = 0;
    this.prevArc = arc;
    this.obstacles = planObstacles(seed, arc * TOTAL_ARCLENGTH);
  }

  /**
   * 走一帧。**只有 `running` 时才可能返回事件**。
   *
   * `arc` 是中心线参数（0..1），`px/pz` 是玩家世界坐标。
   * 碰撞判定量的是 XZ 距离 —— 弧长只是用来做粗筛，
   * 因为环线自交，"弧长最近"和"直线最近"在交叉口附近不是一回事。
   */
  step(arc: number, px: number, pz: number): DodgeEvent | null {
    if (this.state !== 'running') return null;

    // 弧长进度
    let d = arc - this.prevArc;
    if (d > 0.5) d -= 1;
    if (d < -0.5) d += 1;
    this.prevArc = arc;
    // 只认前进。掉头不涨分，瞬移的那一帧（|d| > 0.5 之后剩下的残值）也涨不了。
    if (d > 0) this.travelled += d;
    this.progress = Math.min(this.travelled, 1);

    // 碰撞。粗筛用弧长环距 8m —— 15m/s 下每帧走 0.25m，8m 是 32 帧的余量，
    // 粗筛**只可能放过它，绝不会漏判**。
    const playerS = arc * TOTAL_ARCLENGTH;
    for (const o of this.obstacles) {
      if (Math.abs(wrapS(o.s - playerS)) > 8) continue;
      const dx = px - o.x;
      const dz = pz - o.z;
      const hit = BIKE_HALF_WIDTH + o.radius;
      if (dx * dx + dz * dz < hit * hit) {
        this.state = 'hit';
        this.hitIndex = o.index;
        return { type: 'hit', obstacle: o };
      }
    }

    if (this.travelled >= 1) {
      this.state = 'won';
      this.progress = 1;
      return { type: 'won' };
    }
    return null;
  }
}

/** 木牌钉在哪儿。离中心线的米数与旧物同一条线（路肩外 2.0m）。 */
export const SIGN_FROM_ROAD = ROAD.TOTAL_HALF_WIDTH + 2.0;

/** 伸手够得到木牌的距离（米）。与 `RELIC_REACH` 同一条口径。 */
export const SIGN_REACH = 3.0;

/**
 * 木牌落位：在弧长 `arcT` 处，沿右法向退到路肩外 `SIGN_FROM_ROAD` 米。
 *
 * 左侧也有一个对称的候选位（`side = -1`）——**取离玩家更近的那一侧**，
 * 否则玩家从环的另一边骑过来时木牌永远在路的另一侧，得掉头才够得着。
 * 判据在 `nearestSignSide()` 里，与这个函数同源。
 */
export function signSite(arcT: number, side = 1): { x: number; z: number } {
  const s = signArcMeters(arcT);
  const p = pointAtArcLength(s).pos;
  const r = rightAt(s);
  const d = SIGN_FROM_ROAD * side;
  return { x: p.x + r.x * d, z: p.z + r.z * d };
}

/**
 * 弧长比例 → 米，并绕圈（`-0.1` 与 `0.9` 是同一个点）。
 *
 * 抽出来是因为 `signSite()` 与 `signYaw()` 必须落在**同一处弧长**上：
 * 一个定木牌站在哪，一个定它朝哪。两份各写一遍 `((t % 1) + 1) % 1`
 * 只要有一份少了个括号，症状是"木牌立在这儿、却扭过去看着别处"——
 * 两个函数各自都是对的，只有摆在一起才错。
 */
function signArcMeters(arcT: number): number {
  return (((arcT % 1) + 1) % 1) * TOTAL_ARCLENGTH;
}

/**
 * 木牌朝向哪一边（绕 Y 的弧度）。
 *
 * ## 朝向**路面**
 *
 * 木牌钉在路肩外 2m，正面（局部 +Z，字痕那一侧）必须对着中心线——
 * 玩家从路上骑过来要看到正面，而不是一块白板。
 *
 * ## 为什么它是一个独立的纯函数
 *
 * 原来这一行写在 `World.buildSign()` 里，算的是
 * `atan2(this.ride.pos.x - signX, this.ride.pos.z - signZ)`——拿**玩家出生点**
 * 当"路的方向"。两件事都不对：
 *
 *   · 出生点在 0 号驿站那一段，与木牌隔了小半圈。它碰巧落在木牌正面那一侧
 *     还是背面那一侧，完全取决于环线形状；落在背面时玩家只看到一块白板。
 *   · 更要命的是它把"木牌朝哪"绑到了 `this.ride` 的**赋值先后**上。
 *     `World` 构造里 `buildSign()` 跑在 `new Ride(...)` **之前**，那一句读的是
 *     `undefined.pos`，于是**每一次建世界**都抛
 *     `Cannot read properties of undefined (reading 'pos')`，
 *     玩家看到的是一屏 "World construction failed"。
 *     而无头回归从来抓不到它：`new World()` 要 WebGL，判据里没有过。
 *
 * 换成"木牌自己那一处的中心线点"之后，这个函数只依赖弧长，
 * 与谁先被构造无关。`verify_dodge_sign` 直接问它。
 */
export function signYaw(arcT: number, side: 1 | -1): number {
  const s = signArcMeters(arcT);
  const anchor = pointAtArcLength(s).pos;
  const site = signSite(arcT, side);
  return Math.atan2(anchor.x - site.x, anchor.z - site.z);
}

/**
 * 木牌离最近一座驿站多少米（不够远就换边）。
 *
 * 为什么要挑边：驿站本来就在路外 18m，木牌在路肩外 2m。
 * 而 8 字的两支在这里靠得很近——**钉错一侧，木牌就会落进某座驿站的院子里**，
 * 玩家远远看见的是"那儿有个亭子"，走过去才发现地上插了块板子。
 * 反过来另一侧可能正好是空地，木牌孤零零立在那儿，一眼就看见了。
 */
export function signStandoff(side: 1 | -1, arcT: number): number {
  const p = signSite(arcT, side);
  let best = Infinity;
  for (const st of STATIONS) {
    const d = Math.hypot(st.x - p.x, st.z - p.z);
    if (d < best) best = d;
  }
  return best;
}

/** 够独立的距离（米）。低于它就换边。 */
export const SIGN_STANDOFF = 14;

/**
 * 木牌该钉在哪一侧：离驿站更远的那一侧。
 *
 * 平手（两侧一样远）时固定取 `+1`，所以它是**纯函数**——
 * 判据要能被无头回归问"木牌离最近驿站几米"，而世界层每一次跑
 * 都必须得到同一个位置，否则玩家刷新一次页面木牌就搬家了。
 */
export function signSide(arcT: number): 1 | -1 {
  const a = signStandoff(1, arcT);
  const b = signStandoff(-1, arcT);
  // 两侧都够远就固定取 `+1`，平手也一样 —— 纯函数的另一半。
  if (a >= b) return 1;
  if (b >= SIGN_STANDOFF) return -1;
  return 1;
}