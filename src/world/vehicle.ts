/**
 * 载具 —— 自行车 / 滑板，以及踩在上面的那个角色。
 *
 * ## 为什么单独成文件
 *
 * 自行车原本是 `Ride` 的 `bikePivot` 上挂的一个模型，
 * 而 `Ride` 管的是**运动**（速度、转向、贴地、碰撞）。
 * 一旦要加第二种载具，这两件事就必须分开：
 *
 *   · **运动参数**（极速 / 加速度 / 转向率）随载具变 → 属于 `Ride`；
 *   · **模型与动画**（哪个模型可见、轮子转不转、角色播哪个动作）→ 属于这里。
 *
 * 混在一起的结果是第二种载具要把第一种的所有分支都改一遍，
 * 而那种改动永远漏掉一处。
 *
 * ## 三种运动参数，差别在哪
 *
 * | | 自行车 | 滑板 |
 * |---|---|---|
 * | 极速 | 15 m/s（源项目 `MAX_SPEED`） | 17 m/s |
 * | 加速 | 8 m/s²（有踩踏的爬升感） | 5.5 m/s²（滑行起步慢） |
 * | 转向 | 1.8 rad/s | 2.6 rad/s（站姿，重心高、转向快） |
 *
 * **这些是手感，不是玩法**：它们不进存档、不影响打卡、不改判定阈值。
 * 唯一的玩法影响是「换滑板之后回到十八驿那一段要重新适应」，
 * 而那一段本来就要重新适应。
 *
 * ## 角色动画
 *
 * `survivor_rigged_v2.glb` 自带 3 个动画：`run` / `walk` / `骑自行车`。
 * 这里按载具选：骑车播 `骑自行车`，滑板播 `run`。
 * 找不到就**不动**（bind pose）而不是播一个错的——
 * 一个站着不动的角色远好过一个滑行滑板的角色。
 *
 * ## 轮子
 *
 * 滑板的四个轮子节点叫 `wheel_FL` / `wheel_FR` / `wheel_RL` / `wheel_RR`，
 * 绕**本地 Z** 自转（`skate_glide/README.md` 里有实测：板身偏航已经烘进 GLB，
 * 轮轴正好落在本地 Z 上，所以**运行时不需要任何偏航补偿**——
 * 补了反而歪 31.7°）。
 *
 * 自转量按**里程**算而不是按时间，这样轮子不会在停下时还在转。
 */
import {
  Group,
  Object3D,
  AnimationMixer,
  type AnimationClip,
  LoopRepeat,
} from 'three';

export type VehicleId = 'bike' | 'skate';
export const VEHICLES: readonly VehicleId[] = ['bike', 'skate'];

/** 每种载具的运动参数。`Ride` 读它。 */
export const VEHICLE_TUNE: Record<
  VehicleId,
  { maxSpeed: number; accel: number; decel: number; turn: number }
> = {
  // 自行车那三个数直接取自源项目 RIDE，不许改——手感是原作定的
  bike: { maxSpeed: 15, accel: 8, decel: 12, turn: 1.8 },
  skate: { maxSpeed: 17, accel: 5.5, decel: 7, turn: 2.6 },
};

/** 模型归一化到 1 单位，乘这个得到米。 */
const SCALE = { bike: 1, skate: 0.82, char: 1.75 };

export interface VehicleModels {
  bike: Object3D | null;
  skate: Object3D | null;
  /** 角色根节点（已按米缩放） */
  char: Object3D | null;
  /** 角色的动画剪辑，按用途分好 */
  clips: { run?: AnimationClip; ride?: AnimationClip };
}

export class Vehicle {
  readonly group = new Group();
  private mixer: AnimationMixer | null = null;
  private anim: { action: ReturnType<AnimationMixer['clipAction']> | null } = { action: null };
  private wheels: Object3D[] = [];
  private models: VehicleModels = { bike: null, skate: null, char: null, clips: {} };
  private current: VehicleId = 'bike';
  /** 已经滚过的总里程（米），轮子自转量从它算出来 */
  private wheelSpin = 0;

  constructor() {
    this.group.name = 'vehicle';
  }

  /** 装模型。缺哪个都**不抛**：滑板拉不到时游戏仍然可以骑车。 */
  attach(m: Partial<VehicleModels>): void {
    this.models = { ...this.models, ...m };
    this.group.clear();
    this.wheels = [];
    this.mixer = null;
    this.anim = { action: null };

    const pick = this.models[this.current] ?? this.models.bike;
    if (pick) this.group.add(pick);
    if (this.models.char) {
      this.group.add(this.models.char);
      this.startClip(this.models.char);
    }
    // 轮子按**节点名**找，不靠下标：GLB 里的节点顺序一变就全错
    if (this.current === 'skate') {
      for (const n of ['wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR']) {
        const o = pick?.getObjectByName(n);
        if (o) this.wheels.push(o);
      }
    }
    this.applyScale();
  }

  private applyScale(): void {
    const pick = this.models[this.current];
    if (pick) pick.scale.setScalar(SCALE[this.current]);
    if (this.models.char) this.models.char.scale.setScalar(SCALE.char);
  }

  private startClip(char: Object3D): void {
    const clip = this.current === 'bike' ? this.models.clips.ride : this.models.clips.run;
    if (!clip) return; // 找不到就保持 bind pose，见文件头
    this.mixer = new AnimationMixer(char);
    const action = this.mixer.clipAction(clip);
    action.setLoop(LoopRepeat, Infinity); // 循环播：一趟路 20 分钟，播一次站着不动比播错的更糟
    action.play();
    this.anim.action = action;
  }

  get id(): VehicleId {
    return this.current;
  }

  /** 当前载具能不能切（滑板模型没加载成功就不给切）。 */
  canSwitch(to: VehicleId): boolean {
    return to === 'bike' || this.models.skate !== null;
  }

  /**
   * 切换载具。
   *
   * **只改模型与动画，不碰运动状态** ——和切视角同一条原则：
   * 切换瞬间如果动到了速度或转向，玩家会觉得"我按了 E 车突然窜出去了"。
   * 速度**保留**（从自行车换到滑板不该急停），转向率下一帧才生效。
   */
  set(id: VehicleId): boolean {
    if (id === this.current || !this.canSwitch(id)) return false;
    this.current = id;
    const pick = this.models[id];
    this.group.clear();
    if (pick) this.group.add(pick);
    if (this.models.char) {
      this.group.add(this.models.char);
      this.mixer?.stopAllAction();
      this.startClip(this.models.char);
    }
    this.wheels = [];
    if (id === 'skate' && pick) {
      for (const n of ['wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR']) {
        const o = pick.getObjectByName(n);
        if (o) this.wheels.push(o);
      }
    }
    this.applyScale();
    return true;
  }

  /** 循环切换。返回切到的那个（或 null = 没切成）。 */
  cycle(): VehicleId | null {
    for (const v of VEHICLES) {
      const next = v === this.current ? VEHICLES[(VEHICLES.indexOf(v) + 1) % VEHICLES.length] : v;
      if (next !== this.current && this.set(next)) return next;
    }
    return null;
  }

  /** 每帧：推进动画、按里程转轮子。`speed` 米/秒，`dt` 秒。 */
  update(dt: number, speed: number, heading: number): void {
    this.mixer?.update(dt);

    // 轮子按**里程**转：停下就不转。这和真实一致，
    // 而按时间转的话松开油门轮子还在空转，一眼假。
    this.wheelSpin += speed * dt;
    if (this.wheels.length) {
      // 轮半径 0.028 模型单位 × 缩放 0.82 ≈ 0.023m
      const rad = 0.023;
      for (const w of this.wheels) w.rotation.z = -this.wheelSpin / rad;
    }

    const pick = this.models[this.current];
    if (pick) {
      pick.position.set(0, 0, 0);
      pick.rotation.y = 0;
    }
    if (this.models.char) this.models.char.rotation.y = heading;
  }
}

/** 从一个加载好的 GLB 场景里取出动画剪辑。找不到返回空表，不抛。 */
export function collectClips(clips: readonly AnimationClip[]): { run?: AnimationClip; ride?: AnimationClip } {
  const out: { run?: AnimationClip; ride?: AnimationClip } = {};
  for (const c of clips ?? []) {
    if (c.name === 'run') out.run = c;
    // 中文名「骑自行车」是这份模型里现成的，没有第二个可骑的动画
    else if (c.name === '骑自行车' || /cycl/i.test(c.name)) out.ride = c;
  }
  return out;
}
