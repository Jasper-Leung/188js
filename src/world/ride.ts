/**
 * 骑行 —— 自行车运动、跟随机位、贴地与碰撞。
 *
 * ## 跟随机位那几个数不是随便扫的
 *
 * 正后方 0 横向偏移时，一辆车在这个距离上正投影成一根竖条——
 * 车架三角、两个轮子全都侧对镜头，认不出是自行车。
 * `CAM_SIDE` 是唯一能把车读成"车"的自由度（源项目实测顶点投影宽高比
 * 0.30 → 0.86）。横向让开之后要相应把相机压低拉近，车的轮廓才铺得开，
 * 所以 `CAM_UP` / `CAM_BACK` 是跟着它一起扫出来的，不是独立调的两个数。
 *
 * ## 为什么车要吸在路面上而不是地形上
 *
 * 路面高程取的是它自己那张三角形网格（`road.getHeightAt`），
 * 场外才回落到地形。两者的差最大到 0.3m，肉眼看不出来，
 * 但车在 15m/s 下每帧走 0.25m，差值会变成持续的抖动或持续的浮空。
 * 路面外返回 -Infinity，调用方用 `Number.isFinite` 判——这条判据不能省，
 * 忘了判就会在 `lerp` 里把车一路吸到 -Infinity 去。
 */
import { Group, Vector3, type PerspectiveCamera } from 'three';
import { RIDE } from '../data/raw';
import { distToCenterline, pointAtArcLength, nearestArcParam, TOTAL_ARCLENGTH } from '../data/route';
import { Terrain } from './terrain';
import { Road, ROAD } from './road';
import { Vehicle, MODE_TUNE, type RideMode } from './vehicle';
import { Stations, type StationRuntime } from './stations';
import { clamp, damp } from '../core/math';

const {
  REVERSE_SPEED,
  CAM_BACK, CAM_UP, CAM_SIDE, CAM_LOOK_AHEAD, CAM_LOOK_UP,
} = RIDE;

const BIKE_RADIUS = 0.9; // 车轮半径，用于撞墙时算接触点

/** 相机跟随的指数衰减率。由原版每帧 lerp 0.12 折算：-ln(1-0.12)×60 ≈ 7.7 */
const CAM_DAMP = -Math.log(1 - 0.12) * 60;

/**
 * ## 路肩之外为什么要降速，以及为什么是"压极速"而不是"掉速度"
 *
 * 原来离路是**零后果**的：`onRoad()` 只被探针读，从没进过运动学。
 * 实测（按住 W 不打方向）离路只花 **2 秒**——`off` 从 0 涨到 4.3m、
 * `road=n`。而离路之后的画面是：相机钻进树冠（最近的植被块距玩家 0.5m、
 * 尺寸 45×60×45m），整屏变成没有地平线的绿色多边形。
 *
 * 也就是说玩家**察觉不到自己已经偏了**，等到发现时已经在草地里迷路。
 * 降速就是给这件事一个每帧都在说话的信号：偏出去，车立刻变慢。
 *
 * **压极速而不是乘一个阻尼系数**，理由是三件事同时成立：
 *
 * 1. **能开回来。** 阻尼（`speed *= 0.9`）在低速下会把车锁死在草地里——
 *    玩家想回路面，得多按一会儿 W 才攒得出速度，而"越乱越慢"会教玩家
 *    按 Esc。压极速不动已有的速度，只削掉"还能再快多少"。
 * 2. **回到路面立刻恢复。** 判据是同一个 `getHeightAt`，所以恢复是瞬时的，
 *    玩家得到一个干净的"上去了"反馈，而不是一段减速尾巴。
 * 3. **不会和碰撞打架。** 驿站禁入用的是 `dampSpeed()`（乘性），
 *    两种机制各管一件事，不会在同一帧里互相把速度清零。
 */
export const OFFROAD = {
  /** 路肩外多快开始吃惩罚（米）。留一点缓冲，别在路沿上就掉速。 */
  GRACE: 1.5,
  /** 从开始到吃满，额外走出去多远（米）。线性，不做悬崖。 */
  RAMP: 6,
  /** 吃满之后的极速系数。 */
  FACTOR: 0.45,
} as const;

/**
 * 路面系数：离中心线 `lateral` 米时，极速被压到原来的几倍。
 *
 * **导出来是为了让 `verify_offslow` 问真代码而不是问一份抄写**——
 * 这个项目栽过好几次"判据里重算一遍公式"的跟头（见文件头 hash2d 那条），
 * 而这一条如果只在回归里重算，回归就永远发现不了"实现改了、判据没改"。
 */
export function offRoadFactorFor(lateral: number): number {
  const over = lateral - ROAD.TOTAL_HALF_WIDTH - OFFROAD.GRACE;
  if (over <= 0) return 1;
  return 1 - Math.min(over / OFFROAD.RAMP, 1) * (1 - OFFROAD.FACTOR);
}

/**
 * ## 交叉口的"停一拍"
 *
 * 8 字自交点是全图唯一一个**空间本身就是台词**的位置（「路自此复」）。
 * 那句话不锁操作、不停车——这个游戏的力量在"你一直在路上"。
 * 但什么都不做地骑过去，它就只是地图上的一个岔。
 *
 * 所以车**停一拍**：极速被压到四分之一，半秒后放开。
 * 玩家得到的不是过场，是"车速忽然慢了半拍，而这三个字正好在屏幕上"——
 * 世界用运动学附和了那句话，然后放玩家继续走。
 *
 * 压极速而不 `speed = 0`：和离路惩罚同一条理由（`applyOffRoad` 注释）——
 * 刹停会把车钉在原地，玩家以为出了 bug；压极速松手就恢复。
 * 也不叠加：连拍两次取较长的那个（`Math.max`），不会越压越慢。
 */
export const MOMENT = {
  /** 一次停一拍持续多少秒。一秒以内：再长就从"一拍"变成"卡顿"。 */
  HOLD: 0.6,
  /** 停一拍期间极速的系数。0.25 ≈ 慢到 clearly 察觉得到，又不至于像撞墙。 */
  FACTOR: 0.25,
} as const;

/**
 * 把 (x, z) 投影到中心线，并给出**顺着这条路**的出生朝向。
 *
 * ## 为什么要它，而不是各处自己算
 *
 * `spawn(x, z, heading)` 里 `heading = 0` 表示车头朝 **(0, 0, −1)**，
 * 而 `fixedUpdate` 里前向是 `(−sin h, 0, −cos h)`。于是要让车头沿切向
 * `(dx, dz)`，必须解出 `h = atan2(−dx, −dz)`——**那个负号漏掉就是整整 180°**，
 * 而车仍然站在路面正中，`onRoad()` 照样返回 true，什么症状都看不出来。
 *
 * 这个换算原来在三个地方各写一遍，三遍都不对：
 *
 *   · `World` 构造（**玩家的真实起点**）传的是 `0`，与路面差 158.5°；
 *   · `teleportToStation` 同上；
 *   · `teleportToArc` 写了切向但漏了负号，正好朝反。
 *
 * 唯一算对的那一处在 `verify/ride.ts` 的测试夹具里——**回归在自己身上
 * 做了修正，于是它测的就不再是产品给玩家的东西**。
 * 所以这个函数放在 `Ride` 旁边：朝向和前向的换算是这一类的定义，
 * 让判据能问真代码，而不是再抄一份公式（抄的那份早晚和实现漂）。
 *
 * `verify_spawn_heading` 守它。
 */
export function roadHeadingAtArc(s: number): number {
  const a = pointAtArcLength(Math.max(0, s - 2)).pos;
  const b = pointAtArcLength(Math.min(TOTAL_ARCLENGTH, s + 2)).pos;
  // **负号不能少**：`fixedUpdate` 里前向是 (−sin h, 0, −cos h)，
  // 要让它等于切向 (dx, dz)，解出来的是 atan2(−dx, −dz)。
  return Math.atan2(-(b.x - a.x), -(b.z - a.z));
}

export function roadSpawnPose(x: number, z: number): { x: number; z: number; heading: number } {
  const s = nearestArcParam(x, z) * TOTAL_ARCLENGTH;
  const p = pointAtArcLength(s).pos;
  return { x: p.x, z: p.z, heading: roadHeadingAtArc(s) };
}

/**
 * 机位。
 *
 * ## 为什么默认是「向前」
 *
 * 原来的机位在**正后方加一个横向偏移**（`CAM_SIDE`）。那个偏移是有理由的：
 * 车在正后方投影成一根竖条，认不出是自行车，让开之后车才读成"车"。
 *
 * 但代价是**画面是斜的**——地平线歪、路面朝一个方向斜出去，
 * 习惯了第三人称的人觉得"车在画面里斜着跑"。
 * 所以把它降级成**可选机位**，默认换成居中向前的那个。
 *
 * ## 三种机位各自回答什么问题
 *
 * - `forward`（默认）居中、正前方。路面笔直伸向远处，车在画面正中。
 *   **看不出斜**，代价是车只剩后轮和车尾那一点。
 * - `chase` 原机位。**车最好看**，代价是画面斜。
 * - `first` 骑手视角，几乎第一人称。看路最清楚，代价是看不到自己的车。
 *
 * ## 切换**绝不影响移动**
 *
 * 机位只写 `camera.position` 与 `lookAt`，**不碰 `_fwd` / `_right` / 速度 / 转向**。
 * 这一点必须成立：切换瞬间如果动到了任何一个输入相关的量，
 * 玩家会觉得"我按了 V 车突然往旁边走了"。
 */
export type CamMode = 'forward' | 'chase' | 'first';
export const CAM_MODES: readonly CamMode[] = ['forward', 'chase', 'first'];

const CAM = {
  /** 居中机位：正后方一点点，抬高到骑手视线高度 */
  forward: { back: 3.2, up: 2.05, side: 0 },
  /** 原机位：横向让开让车读成车 */
  chase: { back: CAM_BACK, up: CAM_UP, side: CAM_SIDE },
  /** 骑手视角：几乎贴着头 */
  first: { back: 0.15, up: 1.62, side: 0 },
} as const;

/** 读某个机位的参数。回归要验「forward 的横向偏移是 0」，所以得能问。 */
export function camParams(mode: CamMode) {
  return CAM[mode];
}

export interface RideInput {
  /** -1..1，负为前进 */
  throttle: number;
  /** -1..1 */
  steer: number;
}

export class Ride {
  readonly root = new Group();
  readonly camera: PerspectiveCamera;
  /** 车模型容器（GLB 装进来） */
  readonly bikePivot = new Group();
  /** 载具模型 + 角色。运动参数在这里，模型与动画也在里面。 */
  readonly vehicle = new Vehicle();

  private speed = 0;
  private heading = 0;
  private canMove = true;
  private cameraLocked = false;
  /**
   * 强制隐藏角色，**与机位无关**。
   *
   * 第一视角下角色挡镜头（`first` 机位在头后 15cm），那是 `render()` 里
   * 按机位自动做的。但拍空镜时用的是自由机位，机位判断帮不上忙——
   * 绕拍也好、定机位也好，画面里都还有一个人。
   * 录风景素材要的是"没有人"，所以这个开关由外部（`?cine=1`）推进来。
   */
  private hideCharacter = false;
  private touchDir = { x: 0, y: 0 };

  private position = new Vector3(0, 0, 0);
  private lastPos = new Vector3();
  private hasLastPos = false;
  /**
   * 轮子角度**不在这里**。
   *
   * 原来这里还有一份 `wheelAngle += speed·dt / WORLD.WHEEL_RADIUS`，
   * 配一个没人读的 `get wheelRotation()`。它是**第二个真相来源**，
   * 而且半径是 `WORLD.WHEEL_RADIUS = 0.34`——既不是自行车的实测
   * 0.35，也不是滑板的 0.021，更不是摩托的 0.36。
   * 真正拧轮子的是 `Vehicle`（它按各自载具的实测半径算），
   * 所以这份积分只是躺在那儿，等哪天有人去读它就会拿到一个错的数。
   * 已删。
   */
  private boundaryIntensity = 0;
  /**
   * 当前路面系数：1 = 在路上，`OFFROAD.FACTOR` = 吃满离路惩罚。
   * HUD 的「已偏离」与 `verify_offslow` 都读它。
   */
  private offRoadFactor = 1;
  /** 本帧是否在路肩外。HUD 用它显示/隐藏提示，避免每帧比较浮点数。 */
  private offRoadNow = false;
  /**
   * 本帧偏出路面**多少米**（0 = 在路上）。
   *
   * 它和 `offRoadNow` **在同一个函数里赋值**，因为这两个数回答的是同一件事：
   * 分开算的时候它们已经骗过人一次——观测里同时出现
   * `onRoad: true` 和 `offRoad: 2.81`，一个布尔说在路上，一个数字说偏出去两米八。
   */
  private offRoadMetersValue = 0;
  /** 停一拍还剩多少秒（交叉口那一刹）。归零就恢复极速。 */
  private momentTimer = 0;
  private camPos = new Vector3();
  private camLook = new Vector3();
  private camInit = false;
  private camMode: CamMode = 'forward';

  private road: Road;
  private stations: Stations;

  private _fwd = new Vector3();
  private _right = new Vector3();
  private _tmp = new Vector3();

  // 地形不再直接查：地面高度统一走 `road.surfaceHeightAt`（路面 → 护坡 → 地形）
  constructor(_terrain: Terrain, road: Road, stations: Stations, camera: PerspectiveCamera) {
    this.road = road;
    this.stations = stations;
    // 相机是**渲染器用的那一个**，不是这里另建的一个。
    // 另建的后果：跟随机位写的是 A，渲染读的是 B，画面纹丝不动，
    // 而两边的代码都跑得好好的。
    this.camera = camera;
    this.camera.name = 'camera';
    this.root.add(this.bikePivot);
    this.bikePivot.add(this.vehicle.group);
  }

  /** 起点：第 0 座驿站旁的路面 */
  spawn(x: number, z: number, heading = 0) {
    this.position.set(x, this.groundHeight(x, z), z);
    this.heading = heading;
    this.speed = 0;
    this.momentTimer = 0;
    this.camInit = false;
    this.hasLastPos = false;
  }

  get pos() {
    return this.position;
  }
  get speedValue() {
    return this.speed;
  }
  get isCameraLocked() {
    return this.cameraLocked;
  }

  setCanMove(v: boolean) {
    this.canMove = v;
    if (!v) this.speed = 0;
  }
  setCameraLocked(v: boolean) {
    this.cameraLocked = v;
  }

  /** 强制不渲染角色（录空镜用）。`true` 之后任何机位都看不到人。 */
  setHideCharacter(v: boolean) {
    this.hideCharacter = v;
  }
  setTouchDirection(x: number, y: number) {
    this.touchDir.x = x;
    this.touchDir.y = y;
  }
  /** 撞到硬边界时按比例掉速度。位置被推回墙外之后车本身并不知道自己撞了，
   *  _speed 还在，于是它会贴着墙"蹭"着走：每帧被推回、每帧又往里冲。 */
  dampSpeed(f: number) {
    this.speed *= f;
  }

  /**
   * 停一拍（交叉口专用）。连次调用取较长的那次，不叠加。
   *
   * 语义是"让世界静半拍来附和一句话"，不是一个 debuff：
   * 计时器归零即恢复，没有减速尾巴，也不改任何输入状态。
   */
  holdMoment(seconds: number) {
    this.momentTimer = Math.max(this.momentTimer, seconds);
  }

  /** 定步长。dt 恒定。 */
  fixedUpdate(dt: number, input: RideInput) {
    let vert = input.throttle;
    let horiz = input.steer;
    if (Math.hypot(this.touchDir.x, this.touchDir.y) > 0.1) {
      vert = -this.touchDir.y;
      horiz = this.touchDir.x;
    }

    // 运动参数随载具变（自行车 / 滑板）。**读取发生在运动开始之前**，
    // 所以切载具的那一帧用的还是旧参数 —— 速度与转向都连续，不会窜出去。
    //
    // 声明提到 `if` 外面：`applyOffRoad()` 也要用 `maxSpeed`，
    // 而它跑在 `canMove` 为假的时候（那时速度被清零，但人还在路上）。
    const tune = MODE_TUNE[this.vehicle.id];
    if (!this.canMove) {
      this.speed = 0;
    } else {
      if (vert < -0.1) {
        this.speed = Math.min(this.speed + tune.accel * dt, tune.maxSpeed);
      } else if (vert > 0.1) {
        this.speed = Math.max(this.speed - tune.decel * dt, -REVERSE_SPEED);
      } else {
        if (this.speed > 0) this.speed = Math.max(this.speed - tune.decel * 0.3 * dt, 0);
        else this.speed = Math.min(this.speed + tune.decel * 0.3 * dt, 0);
      }

      // 转向随速度渐入：静止时打方向不生效，避免原地转圈
      let turnFactor = 0;
      if (Math.abs(this.speed) > 0.5) {
        turnFactor = clamp(Math.abs(this.speed) / 3, 0, 1);
      }
      this.heading += -horiz * tune.turn * dt * turnFactor * Math.sign(this.speed);
    }

    // 车头方向。-Z 为前，与 three 的相机默认朝向一致。
    const ch = Math.cos(this.heading);
    const sh = Math.sin(this.heading);
    this._fwd.set(-sh, 0, -ch);
    this._right.set(ch, 0, -sh);

    this.lastPos.copy(this.position);
    this.hasLastPos = true;
    this.position.addScaledVector(this._fwd, this.speed * dt);

    this.applyCollisions(dt);
    this.applyOffRoad(dt, tune);
    this.applyMoment(dt, tune);
    this.position.y = this.groundHeight(this.position.x, this.position.z);
  }

  /**
   * 停一拍：压极速，计时器归零就恢复（定义见 `MOMENT` 的注释）。
   *
   * 排在 `applyOffRoad()` 之后：两者都是"压极速"，而离路惩罚的判据
   * （`getHeightAt` 不可达）在这一帧已经问过一次——停一拍不看路面，
   * 只是在已经算好的 `tune.maxSpeed` 上再乘一个系数。谁也不会清零谁。
   */
  private applyMoment(dt: number, tune: { maxSpeed: number }) {
    if (this.momentTimer <= 0) return;
    this.momentTimer -= dt;
    const capF = tune.maxSpeed * MOMENT.FACTOR;
    const capR = REVERSE_SPEED * MOMENT.FACTOR;
    if (this.speed > capF) this.speed = capF;
    else if (this.speed < -capR) this.speed = -capR;
  }

  /**
   * 路肩之外压极速。**每固步长调一次**，判据是路面高度查询本身
   * （`getHeightAt` 在路面外返回 `-Infinity`）——它走 8m 一格的空间哈希，
   * 比"每帧算到中心线的距离"便宜得多，所以先用它分流，
   * 只有真的在路面外才去算横向距离。
   *
   * `offRoadFactor` 留给 HUD 与回归：1 = 在路上，0.45 = 吃满。
   */
  private applyOffRoad(_dt: number, tune: { maxSpeed: number }) {
    const p = this.position;
    if (Number.isFinite(this.road.getHeightAt(p.x, p.z))) {
      this.offRoadFactor = 1;
      this.offRoadNow = false;
      this.offRoadMetersValue = 0;
      return;
    }
    const lateral = this.lateralDistance(p.x, p.z);
    const k = offRoadFactorFor(lateral);
    if (k >= 1) {
      this.offRoadFactor = 1;
      this.offRoadNow = false;
      this.offRoadMetersValue = 0;
      return;
    }
    this.offRoadNow = true;
    this.offRoadFactor = k;
    this.offRoadMetersValue = Math.max(0, lateral - ROAD.TOTAL_HALF_WIDTH - OFFROAD.GRACE);
    const capF = tune.maxSpeed * k;
    const capR = REVERSE_SPEED * k;
    if (this.speed > capF) this.speed = capF;
    else if (this.speed < -capR) this.speed = -capR;
  }

  /**
   * 到中心线的横向距离（米）。`applyOffRoad()` 判降速用的就是这一个值。
   *
   * ## 为什么是 `distToCenterline()` 而不是"弧长→点→量距离"
   *
   * 原来那一步是 `round(nearestArcParam(x, z) * (CENTERLINE.length - 1))`
   * 再取那个点——它**假设 961 个点在弧长上是均匀分布的**，而它们不是：
   * 这条中心线是 48 段曲线各插值 20 个点，加一条长直线，
   * 于是点距在几厘米到几十米之间差着两个数量级。
   * 拿弧长比例当下标，取到的点可以离真正最近的那个差好几米。
   *
   * 实测：车明明骑在沥青上，`lateral` 却报 **8.31m**，
   * 于是同一个观测里 `onRoad: true` 和 `offRoad: 2.81` 同时成立——
   * 一个布尔说在路上，一个数字说偏出去两米八，而它们问的是同一件事。
   *
   * `distToCenterline()` 本来就在 `data/route.ts` 里，逐段算垂足、扫全路径
   * （8 字的两支互相靠近时也正确），是给植被散布判定用的同一份。
   * 961 次投影是一次几千次的浮点运算，每帧调两次可以忽略，
   * 而省掉它换来的是一个**自己都不信**的数字。
   */
  private lateralDistance(x: number, z: number): number {
    return distToCenterline(x, z);
  }

  /**
   * 到中心线的横向距离（米）。`applyOffRoad()` 判降速用的就是这一个值。
   *
   * 导出来是因为 AI 观测要报「离路多少米」。**不许在接口那边重算一遍**：
   * 重算的那一份早晚会和这一份漂，而漂了以后 AI 会拿到一个
   * 和游戏实际降速依据**对不上**的数字——
   * 症状是"AI 觉得已经偏出去很远了，车却还是满速"，极难归因。
   */
  get lateral(): number {
    return this.lateralDistance(this.position.x, this.position.z);
  }

  /**
   * 碰撞：场界软回弹 + 驿站禁入。
   *
   * 用"推回 + 掉速"而不是硬 clamp：硬 clamp 在边界上会卡住车，
   * 玩家看到的是车顶住空气不动。软回弹给一个与侵入深度成正比的力，
   * 车会自然地被"顶"回来。
   */
  private applyCollisions(dt: number) {
    const half = Terrain.halfSize - 6;

    // 场界：中心向外推
    let bx = 0;
    let bz = 0;
    const overX = Math.abs(this.position.x) - half;
    const overZ = Math.abs(this.position.z) - half;
    if (overX > 0) bx = -Math.sign(this.position.x) * Math.min(overX, 4);
    if (overZ > 0) bz = -Math.sign(this.position.z) * Math.min(overZ, 4);
    if (bx !== 0 || bz !== 0) {
      this.position.x += bx * Math.min(dt * 8, 1);
      this.position.z += bz * Math.min(dt * 8, 1);
      this.boundaryIntensity = Math.min(1, this.boundaryIntensity + dt * 4);
      this.speed *= 1 - Math.min(dt * 3, 0.6);
    } else {
      this.boundaryIntensity = Math.max(0, this.boundaryIntensity - dt * 2);
    }

    // 驿站：把车推到模型外，撞上就掉速
    for (const st of this.stations.list) {
      // 模型没加载出来时 radius 还是初值，先不做禁入——
      // 否则玩家会在一座看不见的亭子前面被空气墙挡住。
      if (st.radius <= 0) continue;
      const r = st.radius + BIKE_RADIUS;
      const dx = this.position.x - st.worldPos.x;
      const dz = this.position.z - st.worldPos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r || d2 < 1e-8) continue;
      const d = Math.sqrt(d2);
      const push = (r - d) / d;
      this.position.x += dx * push;
      this.position.z += dz * push;
      this.dampSpeed(1 - Math.min((r - d) * 0.6, 0.5));
    }
  }

  /** 路面 → 护坡 → 地形（见 `EMBANK`）：骑出路面是顺着草坡下去，不是从路沿上掉下去 */
  groundHeight(x: number, z: number): number {
    return this.road.surfaceHeightAt(x, z);
  }

  onRoad(x = this.position.x, z = this.position.z): boolean {
    return Number.isFinite(this.road.getHeightAt(x, z));
  }

  /** 每帧：姿态、轮子、相机 */
  /**
   * @param driveCamera 这一帧由**本类**驱动相机吗。
   *
   * 湖边那一屏由 `Lakeside.applyCamera()` 摆机位，而它跑在**定步长**里，
   * 本类跑在**渲染**里——同一次 `Loop` 推进里定步长先走、渲染后走（`loop.ts`），
   * 所以渲染里不松手的话，**最后画出来的那一帧拿的是车的跟随机位**，
   * 湖岸的走位与转头全部没有视觉反馈，而日志里一行错都没有。
   *
   * 原来靠 `cameraLocked` 挡，而它只由打卡过场设置，湖边根本没碰过。
   * 与其让每个"相机被别人接管"的场景都记得去抢那个闩锁，
   * 不如把归属权做成**这一帧的显式参数**。
   */
  render(dt: number, driveCamera = true) {
    const p = this.position;
    // 第一视角要把角色藏起来。`first` 机位在 `back: 0.15 / up: 1.62`，
    // 也就是**贴在头后面**——而 `FOOT_LATERAL_OFFSET` 现在是 0，角色就坐在
    // 相机正前方。结果整个画面被后脑勺和背包挡死，骑手视角反而最没法看。
    //
    // 这一句必须在 `vehicle.update()` **之前**：update() 每帧都会重算
    // `char.visible`，晚一步写就被它覆盖回去。
    //
    // 两条来源：机位是 first（相机贴在头后），或者外部显式要求空镜。
    this.vehicle.setSelfHidden(this.camMode === 'first' || this.hideCharacter);
    // 载具动画与轮子。**在这里而不是 render() 里**：固步长下才是稳定的转速。
    this.vehicle.update(dt, this.speed, this.heading);

    this.bikePivot.position.copy(p);
    this.bikePivot.rotation.y = this.heading;
    // 车身随地形俯仰。只按前后取样，转弯时侧倾交给相机的 damp，
    // 两边都做会让车看起来在"漂"。
    const hF = this.groundHeight(p.x + this._fwd.x * 1.2, p.z + this._fwd.z * 1.2);
    const hB = this.groundHeight(p.x - this._fwd.x * 1.2, p.z - this._fwd.z * 1.2);
    const pitch = Math.atan2(hF - hB, 2.4);
    this.bikePivot.rotation.x = -pitch;

    if (this.cameraLocked || !driveCamera) return;

    // 机位参数。**这里只读不写**：切换机位绝不能动到任何输入相关的量
    // （见 CamMode 的注释）。
    const m = CAM[this.camMode];

    // 跟随机位。用指数 damp 而不是 lerp(0.12)：
    // 后者在低帧率下等效速度会变（30fps 时每帧 0.12，60fps 时每帧 0.12，
    // 前者实际跟随更慢），手感在低配机上会明显不同。
    const target = this._tmp.set(
      p.x - this._fwd.x * m.back + this._right.x * m.side,
      p.y + m.up,
      p.z - this._fwd.z * m.back + this._right.z * m.side,
    );
    if (!this.camInit) {
      this.camPos.copy(target);
      this.camInit = true;
    } else {
      // 原版是 `lerp(target, 0.12)`，也就是每帧吃掉 12% 的差距。
      // 换到定步长无关的指数逼近：每秒衰减率 = -ln(1-0.12) × 60 ≈ 7.7。
      // 直接写 `damp(rate=7.7)` 在 30fps 与 120fps 上得到**同一个**跟随手感，
      // 而照抄 0.12 的话低配机上相机会明显更迟钝——因为它每帧只跟 0.12，
      // 帧数少就意味着每秒跟得少。
      this.camPos.x = damp(this.camPos.x, target.x, CAM_DAMP, dt);
      this.camPos.y = damp(this.camPos.y, target.y, CAM_DAMP, dt);
      this.camPos.z = damp(this.camPos.z, target.z, CAM_DAMP, dt);
    }
    this.camera.position.copy(this.camPos);

    this.camLook.set(
      p.x + this._fwd.x * CAM_LOOK_AHEAD,
      p.y + CAM_LOOK_UP,
      p.z + this._fwd.z * CAM_LOOK_AHEAD,
    );
    this.camera.lookAt(this.camLook);
    // 相机的 roll 跟着车头转，不然转弯时地平线会跟着歪
    this.camera.rotateZ(0);
  }

  /** 相机瞬间就位（打卡过场、传送） */
  snapCamera() {
    this.camInit = false;
  }

  /** 当前载具。给 HUD 显示用。 */
  get vehicleKind(): RideMode {
    // **单一来源**：模式只存在 Vehicle 里。原来 Ride 自己还存了一份，
    // 于是 ehicle.set() 改了模式而 Ride 读的还是旧的——
    // verify_ride 量到的是徒步的手势却报「应为 ACCEL=8」，看着像加速度被改坏了。
    return this.vehicle.id;
  }

  /**
   * 切换载具。
   *
   * **只改模型与动画，不动速度与转向** —— 和 cycleCamera() 同一条原则。
   * 速度保留：从自行车换到滑板不该急停，那读作「按 E 车被绊了一下」。
   *
   * 返回切到的那个，或 null（滑板模型没加载成功 → 不给切）。
   */
  cycleVehicle(): RideMode | null {
    return this.vehicle.cycle();
  }

  /** 当前机位。给 HUD / 帮助面板显示用。 */
  get cameraMode(): CamMode {
    return this.camMode;
  }

  /**
   * 切换机位。**只改一个枚举值 + 重新对齐相机**，不碰任何运动状态。
   *
   * 为什么要 `snapCamera()`：切机位时 `camPos` 还停在旧机位的位子上，
   * 玩家会看到相机"飘"过去。重新对齐让它**当场跳到新机位**，
   * 而 `damp` 的跟随手感在切换之后立刻恢复。
   *
   * 返回新的机位（调用方拿它去刷 HUD）。
   */
  cycleCamera(): CamMode {
    const i = CAM_MODES.indexOf(this.camMode);
    this.camMode = CAM_MODES[(i + 1) % CAM_MODES.length];
    this.snapCamera();
    return this.camMode;
  }

  /** 直接指定机位（设置面板用）。 */
  setCameraMode(mode: CamMode): void {
    if (mode === this.camMode) return;
    this.camMode = mode;
    this.snapCamera();
  }

  /** 过场用的相机接管：把相机放到一个自由位置 */
  placeCamera(x: number, y: number, z: number, lookX: number, lookY: number, lookZ: number) {
    this.camera.position.set(x, y, z);
    this.camera.lookAt(lookX, lookY, lookZ);
    this.camPos.set(x, y, z);
    this.camInit = true;
  }

  /** 骑过的距离（米），给里程经济用 */
  travelled(): number {
    if (!this.hasLastPos) return 0;
    return Math.hypot(this.position.x - this.lastPos.x, this.position.z - this.lastPos.z);
  }

  nearestStation(): { index: number; distance: number } {
    let best = -1;
    let bestD = Infinity;
    for (const st of this.stations.list as StationRuntime[]) {
      const d = Math.hypot(st.worldPos.x - this.position.x, st.worldPos.z - this.position.z);
      if (d < bestD) {
        bestD = d;
        best = st.index;
      }
    }
    return { index: best, distance: bestD };
  }

  get boundary() {
    return this.boundaryIntensity;
  }

  /** 路面系数（1 = 在路上）。HUD 与回归读它。 */
  get surfaceFactor() {
    return this.offRoadFactor;
  }

  /** 路肩外（正在吃降速惩罚）。 */
  get offRoad() {
    return this.offRoadNow;
  }

  /**
   * 偏出路面多少米（0 = 在路上）。
   *
   * AI 观测要报「离路多远」，**只准读这里**：
   * 观测那边自己拿 `lateral` 重算一份的话，两份迟早漂，
   * 而漂了以后 AI 会拿到一个和游戏实际降速依据对不上的数字——
   * 症状是"AI 觉得已经偏出去很远了，车却还是满速"，极难归因。
   */
  get offRoadMeters(): number {
    return this.offRoadMetersValue;
  }

  get forward(): Vector3 {
    return this._fwd;
  }
  get right(): Vector3 {
    return this._right;
  }
  get headingValue() {
    return this.heading;
  }
}
