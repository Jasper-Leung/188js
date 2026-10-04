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
import { Stations, type StationRuntime } from './stations';
import { clamp, damp } from '../core/math';

const {
  MAX_SPEED, ACCEL, DECEL, REVERSE_SPEED, TURN_SPEED,
  CAM_BACK, CAM_UP, CAM_SIDE, CAM_LOOK_AHEAD, CAM_LOOK_UP,
} = RIDE;

const BIKE_RADIUS = 0.9; // 车轮半径，用于撞墙时算接触点
/** 相机跟随的指数衰减率。由原版每帧 lerp 0.12 折算：-ln(1-0.12)×60 ≈ 7.7 */
const CAM_DAMP = -Math.log(1 - 0.12) * 60;

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
      if (vert < -0.1) {
        this.speed = Math.min(this.speed + ACCEL * dt, MAX_SPEED);
      } else if (vert > 0.1) {
        this.speed = Math.max(this.speed - DECEL * dt, -REVERSE_SPEED);
      } else {
        if (this.speed > 0) this.speed = Math.max(this.speed - DECEL * 0.3 * dt, 0);
        else this.speed = Math.min(this.speed + DECEL * 0.3 * dt, 0);
      }

      // 转向随速度渐入：静止时打方向不生效，避免原地转圈
      let turnFactor = 0;
      if (Math.abs(this.speed) > 0.5) {
        turnFactor = clamp(Math.abs(this.speed) / 3, 0, 1);
      }
      this.heading += -horiz * TURN_SPEED * dt * turnFactor * Math.sign(this.speed);
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

    // 跟随机位。用指数 damp 而不是 lerp(0.12)：
    // 后者在低帧率下等效速度会变（30fps 时每帧 0.12，60fps 时每帧 0.12，
    // 前者实际跟随更慢），手感在低配机上会明显不同。
    const target = this._tmp.set(
      p.x - this._fwd.x * CAM_BACK + this._right.x * CAM_SIDE,
      p.y + CAM_UP,
      p.z - this._fwd.z * CAM_BACK + this._right.z * CAM_SIDE,
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
