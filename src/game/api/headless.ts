/**
 * AI 可游玩接口 —— **无头适配器**（Node 里那辆不碰 WebGL 的车）
 *
 * ## 它能玩到什么程度
 *
 * **能**：真的骑车——油门、刹车、转向、离路判定、极速、镜头切换、
 * 载具切换、沿环线的位置与累计公里数、脚下站点的距离与方向箭头，
 * 以及 `GameStateManager` 里那套**真的**经济与进度
 * （天、旅币、心神、每件乐事去了几次、还差几次刷满）。
 *
 * **不能**：打卡过场、对白、五个小游戏、商店、合成、结算屏、明信片。
 * 那些都要 DOM 与画布，而无头这一侧刻意一个都不引入。
 *
 * **所以它是"半个游戏"，而且必须被当成半个游戏用。**
 * 要玩完整的一局请走 `live.ts` 那个浏览器接口。
 * 这里存在的理由是另外两条：
 * · 策略可以在这里**跑几千步**去搜参数，不占显卡、不用等渲染；
 * · 真实接口里最容易坏的是**时序**（松手漏了、连点卡住），
 *   而这些恰好能在这里被无头地反复跑出来。
 *
 * ## 它为什么能跑
 *
 * `Terrain` / `Road` / `Stations` / `Ride` 只用 three 的向量、矩阵和
 * Object3D 树，不碰 WebGL——`verify/ride.ts` 早就靠这一点在 Node 里
 * 把车开起来了。存档那层 `GameStateManager.store` 是可注入的，
 * Node 里 `localStorage` 不存在时它自己退回内存实现。
 * 所以这里不需要任何桩，除了一个假相机。
 */

import { Object3D } from 'three';
import { Terrain } from '../../world/terrain';
import { Road } from '../../world/road';
import { Ride, roadSpawnPose } from '../../world/ride';
import { Stations } from '../../world/stations';
import { keyToVec } from '../../core/stick';
import { MODE_TUNE } from '../../world/vehicle';
import { demoAim, demoInput, unwrapArc } from '../phase';
import { PRESETS } from '../../core/settings';
import { RIDE, ROAD as ROAD_RAW, WORLD } from '../../data/raw';
import { STATIONS, TOTAL_ARCLENGTH, pointAtArcLength, nearestArcParam } from '../../data/route';
import { GameStateManager } from '../state';
import type { Phase } from '../phase';
import { getLang, initLang, stationNameOf, t } from '../../i18n';
import { AiSession, type AiAdapter } from './session';
import { arrowGlyph, keysOf, type AiAction, type AiEvent, type AiObservation } from './types';

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

/** 固定步长。宿主主循环也是 1/60，两边一致才谈得上"同一个游戏"。 */
export const HEADLESS_DT = 1 / 60;

/**
 * 无头侧要报的**界面状态**。
 *
 * ## 它为什么必须是可注入的
 *
 * 这一族本来把 `phase` / `dialogueOpen` / `minigame` / `panelOpen` **写死**
 * 在 `snapshot()` 里（全都是"什么都没有"），于是无头回归**只能**验
 * `roaming` 这一种相位。
 *
 * 而这个游戏 9 个相位里有 4 个 `available` 是**另一套**：
 * 暂停、商店、合成、结算的出路各不相同的键。
 * 写死的那一版回归压根问不到它们，所以第十轮那个死锁
 * （`paused` / `checkin` / `synthesis` 三屏 `available` 是空集）
 * 在无头这一侧**永远绿**。
 *
 * 也就是说：无头回归查不出这类 bug，不是因为它弱，
 * 是因为它只能看见游戏最普通的那一面。
 */
export interface HeadlessScreen {
  phase: Phase;
  dialogueOpen?: boolean;
  dialogueText?: string;
  minigame?: boolean;
  /** 正在跑哪一件乐事。给 `describeActions()` 算那一屏真正的键位用。 */
  minigameId?: string | null;
  panelOpen?: boolean;
  narrativeBusy?: boolean;
  /** 不给就按"脚下离驿站够近"算，和真实玩法一致。 */
  canCheckIn?: boolean;
}

const DEFAULT_SCREEN: Required<Omit<HeadlessScreen, 'dialogueText' | 'minigameId'>> & {
  dialogueText: string;
  minigameId: string | null;
} = {
  phase: 'roaming',
  dialogueOpen: false,
  dialogueText: '',
  minigame: false,
  minigameId: null,
  panelOpen: false,
  narrativeBusy: false,
  canCheckIn: false,
};

export class HeadlessAdapter implements AiAdapter {
  readonly terrain: Terrain;
  readonly road: Road;
  readonly stations: Stations;
  readonly ride: Ride;
  readonly game: GameStateManager;

  private tick = 0;
  private t = 0;
  /** 和宿主同构：按键集合。接口的动作最终都落在这里。 */
  private readonly keys = new Set<string>();
  private readonly events: AiEvent[] = [];
  /** 累计骑行米数。和 `World.odometer` 同一个算法：每帧把位移累加进去。 */
  private odometer = 0;
  /** 当前报的界面状态。见 `HeadlessScreen` 为什么要它可注入。 */
  private screen: HeadlessScreen = { ...DEFAULT_SCREEN };
  /** 事件去抖用的上一帧影子。 */
  private prev: {
    day: number;
    lvbi: number;
    mood: number;
    onRoad: boolean;
    camera: string;
    vehicle: string;
    got: number;
  };

  constructor() {
    initLang();
    this.terrain = new Terrain();
    this.road = new Road(this.terrain);
    this.stations = new Stations(PRESETS[1], this.terrain);
    this.ride = new Ride(this.terrain, this.road, this.stations, fakeCamera());
    // 占位车模：`Vehicle.canEnter('bike')` 要求模型存在，而 Node 里没有 GLB。
    this.ride.vehicle.attach({ bike: new Object3D(), skate: null, char: null, clips: {} });
    this.ride.vehicle.set('bike');
    this.game = new GameStateManager();
    // 朝向必须顺着路。原来这里传 `0`，于是 `ai:play` 的 cruise 脚本
    // 在 t=1.90s 就 offRoadEnter——**无头会话教给 AI 的第一课就是
    // 「按油门会掉进草地」**，而真实游戏有同样的毛病（见 world.ts 构造）。
    // 一个用来回答「这游戏好不好骑」的接口，不能自己先骑错。
    const start = roadSpawnPose(pointAtArcLength(0).pos.x, pointAtArcLength(0).pos.z);
    this.ride.spawn(start.x, start.z, start.heading);
    this.ride.setCanMove(true);
    this.prev = {
      day: this.game.day,
      lvbi: this.game.lvbi,
      mood: this.game.mood,
      onRoad: !this.ride.offRoad,
      camera: this.ride.cameraMode,
      vehicle: this.ride.vehicleKind,
      got: this.game.getCollectedCount(),
    };
  }

  // ------------------------------------------------------------ 适配器

  /**
   * 一个动作 → 一次按键状态变更。
   *
   * 这里**不**直接调 `ride`：动作只是把 code 放进/拿出 `keys`，
   * 而 `keys` 怎么变成 `RideInput` 是 `frame()` 的事。
   * 把"意图"和"执行"分开，是为了让这一层和 `live.ts` 的形状一模一样——
   * 那边也是往 `keys` 里塞 code，由游戏自己的监听去消费。
   */
  send(action: AiAction, down: boolean): void {
    for (const code of keysOf(action)) {
      if (down) this.keys.add(code);
      else this.keys.delete(code);
    }
  }

  drain(): AiEvent[] {
    return this.events.splice(0, this.events.length);
  }

  /** 推进一帧。`AiSession.frame()` 不传参时走这里。 */
  frame(): void {
    let mx = 0;
    let my = 0;
    for (const code of this.keys) {
      const v = keyToVec(code);
      if (!v) continue;
      mx += v[0];
      my += v[1];
    }
    mx = Math.max(-1, Math.min(1, mx));
    my = Math.max(-1, Math.min(1, my));

    const px = this.ride.pos.x;
    const pz = this.ride.pos.z;

    // 油门**直接取 `my`，不再取反**。
    // 权威是 `main.ts` 的 `readInput()`：`KeyW` → `throttle -= 1`，
    // 而 `keyToVec('KeyW')` 返回 `[0, -1]`，所以 `my` 天然就是那个 throttle。
    // 多取一次反的后果不会报错，只会让车**倒着开**（`-REVERSE_SPEED = -5` 封顶），
    // 而一个倒着开的车看起来仍然"会动"——这个 bug 能安静地活很久。
    this.ride.fixedUpdate(HEADLESS_DT, { throttle: my, steer: mx });
    this.applyTaps();

    this.odometer += Math.hypot(this.ride.pos.x - px, this.ride.pos.z - pz);
    // 和 `world.ts:340-341` 逐字一致：公里数是**位移累加**，不是沿环线投影。
    this.game.progressKm = this.odometer / 1000;
    this.game.earnKm(this.game.progressKm);

    this.t += HEADLESS_DT;
    this.tick++;
    // **不调 `stations.update()`。** 它会去 GLTF 加载驿站的真实模型，
    // 而 Node 里 `fetch('models/station_…glb')` 直接 `ERR_INVALID_URL` 抛掉——
    // 整场会话会在跑完之前死在一个跟"能不能玩"毫无关系的地方。
    // 这一侧的距离与方向本来就是拿 `STATIONS` 自己算的（见 `nearestFragmentStation()`），
    // 根本用不到 `Stations` 的运行时数据；构造它只是为了给 `new Ride(...)` 凑参数。
    this.detect();
  }

  snapshot(): Omit<AiObservation, 'available'> & { narrativeBusy?: boolean } {
    const p = this.ride.pos;
    const f = this.ride.forward;
    const target = this.nearestFragmentStation();
    const atHome = this.game.objective === 'return';
    const ref = atHome ? STATIONS[GameStateManager.HOME_STATION] : STATIONS[target.idx];
    const dist = ref ? Math.floor(Math.hypot(ref.x - p.x, ref.z - p.z)) : -1;
    const sc = { ...DEFAULT_SCREEN, ...this.screen };

    return {
      tick: this.tick,
      t: this.t,
      phase: sc.phase,
      chapter: this.game.chapter,
      day: this.game.day,
      daysLeft: this.game.daysLeft,
      coins: this.game.lvbi,
      lvbi: this.game.lvbi,
      mood: this.game.mood,
      fragmentsGot: this.game.getCollectedCount(),
      slotVisits: ROAD_RAW.FRAGMENT_SLOT_STATION_IDX.map((idx) => this.game.getStationCount(idx)),
      speed: this.ride.speedValue,
      maxSpeed: RIDE.MAX_SPEED,
      onRoad: !this.ride.offRoad,
      offRoad: this.offRoadMeters(),
      arc: this.arcFraction(),
      km: this.game.progressKm,
      vehicle: this.ride.vehicleKind,
      camera: this.ride.cameraMode,
      nextStation: atHome ? GameStateManager.HOME_STATION : target.idx,
      nextName: ref ? stationNameOf(ref.def) : '',
      nextDistance: dist,
      nextArrow: ref ? arrowGlyph(ref.x - p.x, ref.z - p.z, f.x, f.z) : '',
      canCheckIn: sc.canCheckIn || (dist >= 0 && dist <= WORLD.STATION_PASS_RADIUS),
      objective: t(this.game.objectiveKey),
      lang: getLang(),
      dialogueOpen: sc.dialogueOpen,
      dialogueText: sc.dialogueText,
      minigame: sc.minigame,
      minigameId: sc.minigameId,
      panelOpen: sc.panelOpen,
      narrativeBusy: sc.narrativeBusy,
    };
  }

  /**
   * 换一个界面状态。**只给要验的那几项**，其余保持原样。
   *
   * 判据用它把同一辆车推进九个相位，逐个问"此刻按什么"，
   * 而不用真的去把 DOM 点一遍——见 `HeadlessScreen` 的注释。
   */
  setScreen(patch: Partial<HeadlessScreen>): void {
    this.screen = { ...this.screen, ...patch };
  }

  /** 回到默认（`roaming` + 什么都没有）。一个用例跑完要复位，免得漏给下一个。 */
  resetScreen(): void {
    this.screen = { ...DEFAULT_SCREEN };
  }

  // ------------------------------------------------------------ 内部

  /** 只在这一帧真的落地的点按。`e.repeat` 的等价物是"刚被按下"。 */
  private applyTaps(): void {
    if (this.keys.has('KeyV')) this.ride.cycleCamera();
    if (this.keys.has('KeyE')) this.ride.vehicle.cycle();
  }

  private nearestFragmentStation(): { idx: number; dist: number } {
    const p = this.ride.pos;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < STATIONS.length; i++) {
      // 十八驿不在候选里：它是"回家收尾"那一站，不是"下一处乐事"。
      if (i === GameStateManager.HOME_STATION) continue;
      const s = STATIONS[i];
      const d = Math.hypot(s.x - p.x, s.z - p.z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return { idx: best, dist: bestD };
  }

  /** 离路**多少米**。直接读骑行侧算好的那一份（见 `Ride.offRoadMeters`）。 */
  private offRoadMeters(): number {
    return this.ride.offRoadMeters;
  }

  /** 沿环线的归一化位置 0..1。`nearestArcParam()` 的返回就是它，不用再乘。 */
  private arcFraction(): number {
    const s = nearestArcParam(this.ride.pos.x, this.ride.pos.z);
    return Number.isFinite(s) ? s : 0;
  }

  /** 环线总长（米）。给需要换算绝对距离的策略用。 */
  get routeLength(): number {
    return TOTAL_ARCLENGTH;
  }

  /** 影子比对：只发"这一帧变了的"。这是 `drain()` 取走即清的那一半。 */
  private detect(): void {
    const push = (kind: AiEvent['kind'], detail?: AiEvent['detail']) =>
      this.events.push({ tick: this.tick, t: this.t, kind, detail });

    const day = this.game.day;
    if (day !== this.prev.day) {
      push('day', day);
      this.prev.day = day;
    }
    const lvbi = this.game.lvbi;
    if (lvbi !== this.prev.lvbi) {
      push('coins', lvbi);
      this.prev.lvbi = lvbi;
    }
    const mood = this.game.mood;
    if (mood !== this.prev.mood) {
      push('mood', mood);
      this.prev.mood = mood;
    }
    const onRoad = !this.ride.offRoad;
    if (onRoad !== this.prev.onRoad) {
      push(onRoad ? 'offRoadExit' : 'offRoadEnter', Number(this.offRoadMeters().toFixed(2)));
      this.prev.onRoad = onRoad;
    }
    const cam = this.ride.cameraMode;
    if (cam !== this.prev.camera) {
      push('camera', cam);
      this.prev.camera = cam;
    }
    const veh = this.ride.vehicleKind;
    if (veh !== this.prev.vehicle) {
      push('vehicle', veh);
      this.prev.vehicle = veh;
    }
    const got = this.game.getCollectedCount();
    if (got !== this.prev.got) {
      push('fragment', got);
      this.prev.got = got;
    }
  }

  /**
   * 自己跟着路骑 N 秒，返回一份报告。
   *
   * ## 为什么是它
   *
   * 「这游戏好不好骑」这件事，此前每一轮评审都只能靠手感给一个分，
   * 而手感那一栏已经连续七轮沿用一个没人复核过的数。
   * **有了这个，它就是一个每次都能跑的数字**：`onRoadRatio`
   * （一直在路面上的帧占比）与 `worstLateral`（最远偏多少米）。
   *
   * 控制器直接复用 `demoAim` / `demoInput` —— 演示模式用的那一套，
   * 已经被 `verify_demo_drive` 在 Node 里闭环验过「不会自己开进草地」。
   * **不复用它等于再写一份，而两份控制器早晚会漂**：漂了以后症状是
   * 「跟车脚本说在路边、游戏说已经掉出去了」，几乎不可能被归因。
   *
   * ## 它仍然不证明什么
   *
   * 它证明的是**路面与转向**这一层：车能不能一直贴着路走。
   * 它证明不了**玩家能不能做到**——真人没有 `demoAim` 的预瞄，
   * 也没有逐帧 60Hz 的反应。所以它给的是上限，不是手感。
   *
   * ## 键码路径
   *
   * 每帧经 `send()` 下发，**不直接改 `keys`**：七个监听键盘的地方
   * （宿主 / 对白 / 结算 / 明信片 / 小游戏 / 触屏 / HUD）只认真事件，
   * 另开一条平行输入会让症状变成「小游戏坏了」。
   */
  followRoad(seconds: number): FollowReport {
    const steps = Math.max(1, Math.round(seconds * 60));
    let arc = this.arcFraction();
    let offRoadFrames = 0;
    let worstLateral = 0;
    let sumSpeed = 0;
    let minSpeed = Infinity;
    let maxSpeed = 0;

    try {
      for (let i = 0; i < steps; i++) {
        const p = this.ride.pos;
        const raw = this.arcFraction();
        arc = unwrapArc(arc, raw);
        const v = this.ride.speedValue;
        const d = demoInput(
          demoAim(p.x, p.z, this.ride.headingValue, arc, undefined, v),
          v,
          MODE_TUNE[this.ride.vehicleKind].maxSpeed,
        );
        this.send('throttle', d.throttle < -0.05);
        this.send('brake', d.throttle > 0.05);
        this.send('left', d.steer < -0.05);
        this.send('right', d.steer > 0.05);
        this.frame();

        if (this.ride.offRoad) offRoadFrames++;
        const lat = this.ride.lateral;
        if (lat > worstLateral) worstLateral = lat;
        const sp = this.ride.speedValue;
        sumSpeed += sp;
        if (sp < minSpeed) minSpeed = sp;
        if (sp > maxSpeed) maxSpeed = sp;
      }
    } finally {
      // 走完必须松手：不松的话车会带着一个键继续冲，
      // 而这一侧没有界面告诉人「有键卡住了」（同 session.ts 那条硬规则）。
      for (const a of ['throttle', 'brake', 'left', 'right'] as AiAction[]) this.send(a, false);
    }

    return {
      onRoadRatio: (steps - offRoadFrames) / steps,
      worstLateral,
      km: this.game.progressKm,
      avgSpeed: sumSpeed / steps,
      minSpeed: minSpeed === Infinity ? 0 : minSpeed,
      maxSpeed,
      frames: steps,
      offRoadFrames,
      seconds,
    };
  }
}

/** 开一个无头会话。CLI 与 `verify/ai.ts` 都从这里起步。 */
export function headlessSession(): AiSession {
  return new AiSession(new HeadlessAdapter());
}

/** `followRoad()` 的返回。一眼能当回归数字用的那几个放在前面。 */
export interface FollowReport {
  /** 在路面上的帧数占比。**这是「好不好骑」的那一个数。** */
  onRoadRatio: number;
  /** 最远偏出中心线多少米 */
  worstLateral: number;
  /** 里程（公里） */
  km: number;
  /** 平均 / 最低 / 最高速度（m/s） */
  avgSpeed: number;
  minSpeed: number;
  maxSpeed: number;
  frames: number;
  offRoadFrames: number;
  seconds: number;
}

/** 开一场「自己跟着路走」的会话。CLI 的 `--follow` 与 `verify/ai.ts` 共用。 */
export function followRoad(seconds: number): FollowReport {
  return new HeadlessAdapter().followRoad(seconds);
}
