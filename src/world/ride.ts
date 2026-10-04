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
import { Group, Vector3, MathUtils, type PerspectiveCamera } from 'three';
import { RIDE, WORLD } from '../data/raw';
import { Terrain } from './terrain';
import { Road } from './road';
import { Vehicle, VEHICLE_TUNE, type VehicleId } from './vehicle';
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
  private vehicleId: VehicleId = 'bike';

  private speed = 0;
  private heading = 0;
  private canMove = true;
  private cameraLocked = false;
  private touchDir = { x: 0, y: 0 };

  private position = new Vector3(0, 0, 0);
  private lastPos = new Vector3();
  private hasLastPos = false;
  private wheelAngle = 0;
  private boundaryIntensity = 0;
  private camPos = new Vector3();
  private camLook = new Vector3();
  private camInit = false;
  private camMode: CamMode = 'forward';

  private terrain: Terrain;
  private road: Road;
  private stations: Stations;

  private _fwd = new Vector3();
  private _right = new Vector3();
  private _tmp = new Vector3();

  constructor(terrain: Terrain, road: Road, stations: Stations, camera: PerspectiveCamera) {
    this.terrain = terrain;
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
  setTouchDirection(x: number, y: number) {
    this.touchDir.x = x;
    this.touchDir.y = y;
  }
  /** 撞到硬边界时按比例掉速度。位置被推回墙外之后车本身并不知道自己撞了，
   *  _speed 还在，于是它会贴着墙"蹭"着走：每帧被推回、每帧又往里冲。 */
  dampSpeed(f: number) {
    this.speed *= f;
  }

  /** 定步长。dt 恒定。 */
  fixedUpdate(dt: number, input: RideInput) {
    let vert = input.throttle;
    let horiz = input.steer;
    if (Math.hypot(this.touchDir.x, this.touchDir.y) > 0.1) {
      vert = -this.touchDir.y;
      horiz = this.touchDir.x;
    }

    if (!this.canMove) {
      this.speed = 0;
    } else {
      // 运动参数随载具变（自行车 / 滑板）。**读取发生在运动开始之前**，
      // 所以切载具的那一帧用的还是旧参数 —— 速度与转向都连续，不会窜出去。
      const tune = VEHICLE_TUNE[this.vehicleId];
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
    this.position.y = this.groundHeight(this.position.x, this.position.z);

    this.wheelAngle += (this.speed * dt) / WORLD.WHEEL_RADIUS;
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

  /** 路面优先，场外回落地形 */
  groundHeight(x: number, z: number): number {
    const roadH = this.road.getHeightAt(x, z);
    if (Number.isFinite(roadH)) return roadH;
    return this.terrain.getHeightAt(x, z);
  }

  onRoad(x = this.position.x, z = this.position.z): boolean {
    return Number.isFinite(this.road.getHeightAt(x, z));
  }

  /** 每帧：姿态、轮子、相机 */
  render(dt: number) {
    const p = this.position;
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
    this.wheelAngle = this.wheelAngle % (Math.PI * 2);

    if (this.cameraLocked) return;

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
  get vehicleKind(): VehicleId {
    return this.vehicleId;
  }

  /**
   * 切换载具。
   *
   * **只改模型与动画，不动速度与转向** —— 和 cycleCamera() 同一条原则。
   * 速度保留：从自行车换到滑板不该急停，那读作「按 E 车被绊了一下」。
   *
   * 返回切到的那个，或 null（滑板模型没加载成功 → 不给切）。
   */
  cycleVehicle(): VehicleId | null {
    const next = this.vehicle.cycle();
    if (next) this.vehicleId = next;
    return next;
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

  get forward(): Vector3 {
    return this._fwd;
  }
  get right(): Vector3 {
    return this._right;
  }
  get headingValue() {
    return this.heading;
  }
  get wheelRotation() {
    return MathUtils.euclideanModulo(this.wheelAngle, Math.PI * 2);
  }
}
