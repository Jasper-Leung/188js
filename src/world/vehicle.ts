/**
 * 载具与角色 —— 自行车 / 滑板 / 徒步，以及站在上面的那个人。
 *
 * ## 三种状态
 *
 * | | 玩家 | 姿态动画 |
 * |---|---|---|
 * `foot` **默认** | 只有角色，两件载具停在路边 | `run` / `walk`（按速度混） |
 * `bike` | 角色跨在坐垫上 | `骑自行车` |
 * `skate` | 角色站在板上（左脚在前） | `run` |
 *
 * **默认是 `foot`**：这个游戏讲的是"一个人回到自己的家乡"，
 * 开头让玩家推着车走几步比一上来就骑更贴题，而且这样"没有车"这件事
 * 在界面上是看得见的——按 `E` 才有车，是玩家的选择而不是脚本给的。
 *
 * ## 缩放：**不能自己拍脑袋**
 *
 * 源项目的车模单位是乱的：`bike.glb` 的包围盒是 16762 × 37892 × 65534，
 * 靠 `WORLD.BIKE_SCALE = 0.012` 压回米制。
 *
 * **曾经把这个缩放写成 1**，结果车和角色一起消失——车变成 65 公里宽。
 * 所以这三个缩放值分别来自：**车 = 源项目的 `BIKE_SCALE`**、
 * 滑板与角色 = 按包围盒高度算出来的（`autoScaleToHeight`）。
 *
 * ## 滑板朝向：为什么是 `heading + π/2`
 *
 * `skate_glide/README.md` 写明：那个演示沿**本地 −X** 平移，轮子绕**本地 Z** 自转。
 * 我们要让板的本地 −X 对上世界的前进方向。
 * 绕 Y 转 θ 把 (x,0,z) 映到 (x cosθ + z sinθ, 0, −x sinθ + z cosθ)，代入 (−1,0,0)：
 *
 * ```
 * −cosθ = sin h     sinθ = cos h     →   θ = h + π/2
 * ```
 *
 * 板身的 31.7° 偏航**已经烘进 GLB**（同一个 README），
 * 所以这里**不需要**任何额外的偏航补偿——补了反而歪 31.7°。
 *
 * ## 轮子按里程转
 *
 * 按时间转的话松开油门轮子还在空转，一眼假。停下就不转，和真实一致。
 */
import { Group, Object3D, Vector3, Box3, AnimationMixer, type AnimationClip, LoopRepeat } from 'three';
import { WORLD, RIDE } from '../data/raw';

export type RideMode = 'foot' | 'bike' | 'skate';
export const RIDE_MODES: readonly RideMode[] = ['foot', 'bike', 'skate'];

/**
 * 每种模式的运动参数。
 *
 * `foot` 的极速刻意比车低（6 m/s）：走路比骑车慢是常识，
 * 而 6 m/s 已经是小跑——徒步时给 15 m/s 会读作"车凭空没了，人在飞"。
 *
 * **自行车那三个数直接取自源项目 `RIDE`，一个字都没改**——
 * 改它等于改原作的手感。`verify_controls` 把这件事钉住了。
 */
export const MODE_TUNE: Record<
  RideMode,
  { maxSpeed: number; accel: number; decel: number; turn: number }
> = {
  bike: { maxSpeed: RIDE.MAX_SPEED, accel: RIDE.ACCEL, decel: RIDE.DECEL, turn: RIDE.TURN_SPEED },
  skate: { maxSpeed: 17, accel: 5.5, decel: 7, turn: 2.6 },
  foot: { maxSpeed: 6, accel: 4, decel: 9, turn: 2.2 },
};


/**
 * 按目标高度（米）反推缩放。
 *
 * 不能写死：模型是「归一化到 1 单位」的（滑板高 0.121、角色高 1.0），
 * 换一批模型高度就变了，写死的数字会在下次换模型时悄悄失配。
 *
 * 扫的是**真实顶点**，不是 `geometry.boundingBox`——
 * GLB 里的 accessor min/max 不可信（见 vegetation.ts 的 bottomOf 注释）。
 */
export function autoScaleToHeight(root: Object3D, targetH: number): number {
  const box = new Box3().setFromObject(root);
  const h = box.max.y - box.min.y;
  if (!Number.isFinite(h) || h < 1e-6) return 1;
  return targetH / h;
}

/** 角色的目标身高（米）。成年男性约 1.75。 */
const CHAR_HEIGHT = 1.75;
/** 坐垫高度（米）。角色跨在车上时脚要落在这个高度附近。 */
const SADDLE_H = 1.05;

export interface VehicleModels {
  bike: Object3D | null;
  skate: Object3D | null;
  /** 角色根节点 */
  char: Object3D | null;
  clips: { run?: AnimationClip; ride?: AnimationClip };
}

/** 载具停下时停在路边的偏移（米）。正交于前进方向，避免压在路上。 */
const PARKED_OFFSET = 2.6;

export class Vehicle {
  readonly group = new Group();
  private mixer: AnimationMixer | null = null;
  private wheels: Object3D[] = [];
  private models: VehicleModels = { bike: null, skate: null, char: null, clips: {} };
  private mode: RideMode = 'foot';
  private wheelSpin = 0;
  /** 当前速度，用来在 run / walk 之间混合 */
  private speed = 0;
  private heading = 0;

  constructor() {
    this.group.name = 'vehicle';
  }

  get id(): RideMode {
    return this.mode;
  }

  /** 能不能进这个模式。没模型就不给进——而不是切过去发现是空的。 */
  canEnter(m: RideMode): boolean {
    if (m === 'foot') return true;
    if (m === 'bike') return this.models.bike !== null;
    return this.models.skate !== null;
  }

  attach(m: Partial<VehicleModels>): void {
    this.models = { ...this.models, ...m };
    this.rebuild();
  }

  private rebuild(): void {
    this.group.clear();
    this.wheels = [];
    this.mixer?.stopAllAction();
    this.mixer = null;

    const bike = this.models.bike;
    const skate = this.models.skate;
    const char = this.models.char;

    // **车模的缩放来自各自的数据，不能统一写 1**：
    // bike.glb 的单位是乱的（包围盒 65534），靠 WORLD.BIKE_SCALE 压回米制；
    // 曾经这里写成 1，结果车和角色一起消失。
    if (bike) {
      bike.scale.setScalar(WORLD.BIKE_SCALE);
      bike.visible = this.mode === 'bike';
      this.group.add(bike);
    }
    if (skate) {
      // 滑板归一化到 1 单位、实测高 0.121 → 0.11m 的板，取 0.9 得 0.11m×8
      skate.scale.setScalar(SKATE_SCALE);
      // 板身的偏航已经烘进 GLB，这里只补"本地 −X 对上前进方向"那 90°。
      skate.rotation.y = Math.PI / 2;
      skate.visible = this.mode === 'skate';
      this.group.add(skate);
      if (this.mode === 'skate') this.collectWheels(skate);
    }
    if (char) {
      char.scale.setScalar(autoScaleToHeight(char, CHAR_HEIGHT));
      this.group.add(char);
      this.startClip(char);
    }
  }

  private collectWheels(board: Object3D): void {
    // 按**节点名**找，不靠下标：GLB 里的节点顺序一变就全错
    for (const n of ['wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR']) {
      const o = board.getObjectByName(n);
      if (o) this.wheels.push(o);
    }
  }

  private startClip(char: Object3D): void {
    const clip =
      this.mode === 'bike'
        ? this.models.clips.ride
        : this.models.clips.run ?? this.models.clips.ride;
    if (!clip) return; // 找不到就保持 bind pose：一个站着的角色好过一个滑行滑板的
    this.mixer = new AnimationMixer(char);
    const a = this.mixer.clipAction(clip);
    a.setLoop(LoopRepeat, Infinity);
    a.play();
  }

  /** 循环切换三种模式。返回切到的那个，或 null（模型没加载成功）。 */
  cycle(): RideMode | null {
    for (let i = 1; i <= RIDE_MODES.length; i++) {
      const next = RIDE_MODES[(RIDE_MODES.indexOf(this.mode) + i) % RIDE_MODES.length];
      if (next !== this.mode && this.canEnter(next)) {
        this.mode = next;
        this.rebuild();
        return next;
      }
    }
    return null;
  }

  set(m: RideMode): boolean {
    if (m === this.mode || !this.canEnter(m)) return false;
    this.mode = m;
    this.rebuild();
    return true;
  }

  /** 每帧：动画、轮子、站位。`speed` 米/秒。 */
  update(dt: number, speed: number, heading: number): void {
    this.speed = speed;
    this.heading = heading;
    this.mixer?.update(dt);

    const bike = this.models.bike;
    const skate = this.models.skate;
    const char = this.models.char;

    bike && (bike.visible = this.mode === 'bike');
    skate && (skate.visible = this.mode === 'skate');

    // 轮子按**里程**转：停下就不转
    this.wheelSpin += speed * dt;
    if (this.wheels.length) {
      const rad = 0.023 * SKATE_SCALE;
      for (const w of this.wheels) w.rotation.z = -this.wheelSpin / rad;
    }

    if (!char) return;

    if (this.mode === 'bike') {
      // 跨在坐垫上：位置由车的变换决定，**不自己算**，免得两处各算一套而漂移
      const p = new Vector3(0, SADDLE_H / WORLD.BIKE_SCALE, 0);
      bike?.localToWorld(p);
      char.position.copy(bike ? p : new Vector3(0, SADDLE_H, 0));
    } else if (this.mode === 'skate') {
      const p = new Vector3(0, 0.12 / SKATE_SCALE, 0);
      skate?.localToWorld(p);
      char.position.copy(skate ? p : new Vector3(0, 0.12, 0));
    } else {
      // 徒步：站在车旁边。`right` 由 heading 推出，负号表示让到路肩那侧。
      const rx = Math.cos(heading);
      const rz = -Math.sin(heading);
      char.position.set(rx * PARKED_OFFSET, 0, rz * PARKED_OFFSET);
    }
    // 角色朝向 = 前进方向；徒步时侧对，因为人是站在路肩上而不是在路上跑
    char.rotation.y = this.mode === 'foot' ? heading + Math.PI / 2 : heading;
  }

  /** 步行速度，用来决定 run 还是 walk（给 HUD 或调试读）。 */
  get currentSpeed(): number {
    return this.speed;
  }
  get currentHeading(): number {
    return this.heading;
  }
}

/** 滑板缩放。归一化模型高 0.121，乘 0.9 → 0.109m ≈ 一块真实滑板的高度。 */
const SKATE_SCALE = 0.9;

/** 从加载好的 GLB 里取出动画剪辑。找不到返回空表，不抛。 */
export function collectClips(clips: readonly AnimationClip[]): {
  run?: AnimationClip;
  ride?: AnimationClip;
} {
  const out: { run?: AnimationClip; ride?: AnimationClip } = {};
  for (const c of clips ?? []) {
    if (c.name === 'run') out.run = c;
    else if (c.name === '骑自行车' || /cycl/i.test(c.name)) out.ride = c;
  }
  return out;
}
