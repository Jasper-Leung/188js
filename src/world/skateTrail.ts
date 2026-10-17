/**
 * 滑板尾迹 —— 板后那条跟着速度呼吸的火星带。
 *
 * ## 为什么是点精灵而不是网格拖尾
 *
 * 拖尾（ribbon / trail mesh）的做法是每帧把板尾位置缝进一条三角带，
 * 顶点色按寿命淡出。它确实连续，但这个项目里有三件事不让它过：
 *
 *   1. **缝带要 CPU 每帧重传整条带**，而滑板的横向摆动（`stance` 那套）
 *      会让带宽忽宽忽窄，UV 拉伸的接缝在暖色加色下看得见；
 *   2. **低配要的是"关掉大半也还剩个信号"**，点精灵的预算是一个整数
 *      （同时存活数），拖尾的预算却是"带长 × 段数 × 2 三角形"，
 *      按档位砍下来会突然从"一条带"变成"几个孤立的方块"；
 *   3. 这个项目的其余地表特效（风倒的草、水面碎光）全是程序化着色，
 *      点精灵是同一族手艺，复用同一支 `shaders/world.ts`。
 *
 * ## 数据结构：紧凑数组 + 交换删除
 *
 * 不是环形缓冲。环形缓冲里死掉的粒子要留着占位（否则写指针绕回来会
 * 覆盖还活着的），于是 `setDrawRange` 只能画满，每个死点都要白跑一次
 * 顶点着色器。紧凑数组把活粒子压在 `[0, alive)`，死掉的与末尾交换后
 * `alive--`，drawRange 之外的一个点都不传——GPU 只为活粒子干活。
 * 代价是死亡那次要复制 6 个属性，而死亡每秒最多发生几百次，
 * 每条是一次 7 个 float 的拷贝，比多画几百个点便宜得多。
 *
 * ## 性能分档
 *
 * 预算来自 `QualityPreset.trailParticles` / `trailEmitRate`（90/30 →
 * 480/180，三档差 5 倍）。数组按三档里的最大值一次性分配，
 * **切档不重新 malloc**——画质面板里拖滑块时不卡一下。
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { QualityPreset } from '../core/settings';
import { MODE_TUNE, type RideMode } from './vehicle';
import { SKATE_TRAIL_FRAG, SKATE_TRAIL_VERT } from '../shaders/world';

/**
 * `update()` 需要的骑行状态 —— **结构上** `Ride` 就满足它，
 * 所以这里不 import `Ride`：那样会为了一次类型检查把整个骑行模块
 * （地形、路、驿站、相机）拖进无头回归的依赖图里。
 * 假对象也能喂，于是发射逻辑可以在 Node 里直接量。
 */
export interface TrailSubject {
  readonly pos: Vector3;
  readonly forward: Vector3;
  readonly speedValue: number;
}

/**
 * 板尾到骑手的距离（米）。板全长约 1.31m（`SKATE_SCALE` 1.35 × 模型长），
 * 半板 0.655，再收 3cm 是让出生点别贴着轮子——贴太近的话粒子前几帧
 * 还压在板子几何里，加色混合下会看到一块方形的亮斑从板里钻出来。
 */
const TAIL_BACK = 0.62;

/** 出生点的离地高度区间（米）。贴着轮子而不是板面：火星是**刨**出来的。 */
const SPAWN_Y_LO = 0.04;
const SPAWN_Y_HI = 0.26;

/**
 * 低于这个速度不发射（m/s）。滑板起步那一下（加速度 5.5，约 0.25s
 * 就到 1.2m/s）如果就冒火，读起来像"点火装置"而不是"滑起来才有火星"。
 * 导出是因为回归要量它——"这个速度到底发不发"是这条特效的开关，
 * 而开关的值藏在私有常量里，量到的就只是"看起来对"。
 */
export const TRAIL_EMIT_MIN_SPEED = 1.2;

/** 粒子寿命区间（秒）。导出同上：池子够不够大要按寿命上限算。 */
export const TRAIL_LIFE_MIN = 0.34;
export const TRAIL_LIFE_MAX = TRAIL_LIFE_MIN + 0.42;

/** 重力。比真实的 9.8 轻：火星要飘一下，不是弹道。 */
const GRAVITY = -6.5;

/**
 * 同时存活粒子的硬上限 = 三档预算里的最大值（480）。
 *
 * 写死而不是取 `PRESETS[TIER_HIGH].trailParticles`：那个值归画质表管，
 * 而这里是**内存分配的担保**——表被谁调大了，数组不会悄悄越界。
 * 反过来表调小了只是预算用不满，没有正确性问题。
 * 导出是因为 `verify_quality` 要钉住"表里的三档都不许超过这个数"。
 */
export const TRAIL_MAX_PARTICLES = 480;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class SkateTrail {
  readonly points: Points;

  private readonly geo = new BufferGeometry();
  private readonly mat: ShaderMaterial;

  // ---- 粒子状态。位置/寿命/尺寸/种子同时是缓冲属性，CPU 积分直接写在里面 ----
  private readonly posArr = new Float32Array(TRAIL_MAX_PARTICLES * 3);
  private readonly lifeArr = new Float32Array(TRAIL_MAX_PARTICLES * 2);
  private readonly sizeArr = new Float32Array(TRAIL_MAX_PARTICLES);
  private readonly seedArr = new Float32Array(TRAIL_MAX_PARTICLES);
  // ---- 下面几个只活在 CPU 侧，不上传 ----
  private readonly vel = new Float32Array(TRAIL_MAX_PARTICLES * 3);
  /** 每个粒子的"地面"：出生高度。见 `update()` 里回弹那段的取舍说明。 */
  private readonly birthY = new Float32Array(TRAIL_MAX_PARTICLES);

  /** 当前预算（同时存活上限）。0 = 特效关闭，`points.visible = false`。 */
  private cap = 0;
  /** 满速发射率（个/秒）。 */
  private rate = 0;
  /** 活粒子数。永远 ≤ `cap`，且活粒子只占 `[0, alive)`。 */
  private alive = 0;
  /** 发射累加器：不足一发的那部分时间攒到下一秒，而不是丢掉。 */
  private emitAcc = 0;
  /** 出生过的粒子总数（只增不减）。给回归数发射率用。 */
  private emittedTotal = 0;

  constructor() {
    this.geo.setAttribute('position', new BufferAttribute(this.posArr, 3));
    this.geo.setAttribute('aLife', new BufferAttribute(this.lifeArr, 2));
    this.geo.setAttribute('aSize', new BufferAttribute(this.sizeArr, 1));
    this.geo.setAttribute('aSeed', new BufferAttribute(this.seedArr, 1));
    this.geo.setDrawRange(0, 0);
    // 尾迹跟着玩家满世界跑，包围球每帧都在变。关掉剔除：
    // 一个点的包围球算错的结果是整条尾迹在某个角度突然消失，
    // 而这种 bug 只在转弯时才现形。
    this.geo.boundingSphere = null;

    this.mat = new ShaderMaterial({
      vertexShader: SKATE_TRAIL_VERT,
      fragmentShader: SKATE_TRAIL_FRAG,
      transparent: true,
      // 加色混合：火星是**光**，该把后面的画面点亮而不是糊上去。
      // 配 depthWrite=false——粒子之间不该互相遮挡，那会现出前后次序。
      blending: AdditiveBlending,
      depthWrite: false,
      uniforms: {
        uHalfH: { value: 450 },
        uHot: { value: new Color(1.0, 0.93, 0.72) },
        uCool: { value: new Color(1.0, 0.42, 0.1) },
        uOpacity: { value: 0.9 },
        fogColor: { value: new Color(0.72, 0.8, 0.9) },
        fogNear: { value: 40 },
        fogFar: { value: 260 },
      },
    });

    this.points = new Points(this.geo, this.mat);
    this.points.name = 'skate-trail';
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  /** 换档 / 开局时调用。同一个预设重复喂是廉价的（只改几个数）。 */
  setPreset(preset: QualityPreset) {
    this.cap = Math.max(0, Math.min(Math.round(preset.trailParticles), TRAIL_MAX_PARTICLES));
    this.rate = Math.max(0, preset.trailEmitRate);
    // 降档时多出来的活粒子当场消失：它们本来就是按高档的寿命出生的，
    // 留着只会让"切到低档"那一瞬的尾迹比低档预算还长。
    if (this.alive > this.cap) this.alive = this.cap;
    this.mat.uniforms.fogNear.value = preset.fogNear;
    this.mat.uniforms.fogFar.value = preset.fogFar;
    // 预算为 0 = 整个特效关掉，一个点都不传给 GPU。
    this.points.visible = this.cap > 0;
  }

  /**
   * 绘图缓冲区高度变了要告诉它 —— `gl_PointSize` 是按像素算的。
   *
   * 竖屏、改窗口、自适应分辨率都会改这个数。不给的话，
   * 尾迹的点会随着画布变大而**相对变小**（世界没变，像素基准变了）。
   */
  setViewport(bufferH: number) {
    this.mat.uniforms.uHalfH.value = Math.max(1, bufferH) * 0.5;
  }

  /**
   * 每帧一步：先积分活粒子，再按速度发射，最后上传。
   *
   * @param dt     帧步长（秒）
   * @param kind   当前载具。只有 `skate` 发射；换走之后剩的粒子自然烧完
   * @param s      骑手状态（位置 / 朝向 / 速度）
   */
  update(dt: number, kind: RideMode, s: TrailSubject) {
    this.integrate(dt);
    if (kind === 'skate') this.emit(dt, s);
    this.upload();
  }

  // ---------------------------------------------------------------- 积分
  private integrate(dt: number) {
    for (let i = 0; i < this.alive; ) {
      const i3 = i * 3;
      this.lifeArr[i * 2] -= dt;
      if (this.lifeArr[i * 2] <= 0) {
        // 把**末尾那个活粒子**挪进 i 槽，然后 alive--。
        // 方向写反过（`swapSlots(this.alive, i)`）：那一版把死粒子
        // 复制进末尾槽，于是 i 槽仍是死的——循环不推进，下一轮
        // 同一个死粒子再把 alive-- 一次，一路削到 i 为止。
        // 症状是"每死一个，后面的活粒子全体消失"，而 alive 的账
        // 面上只是慢慢变小，看不出是一次死亡吃掉一整排。
        // 挪过来之后 i 不加 1：换到位的那个粒子这一帧还没积分。
        this.alive--;
        if (i !== this.alive) this.swapSlots(i, this.alive);
        continue;
      }
      this.vel[i3 + 1] += GRAVITY * dt;
      // 空气阻力：不加的话远处的尾迹是一条等速的直线，读作"激光"而不是"火星"。
      const drag = 1 - 1.6 * dt;
      this.vel[i3] *= drag;
      this.vel[i3 + 2] *= drag;
      this.posArr[i3] += this.vel[i3] * dt;
      this.posArr[i3 + 1] += this.vel[i3 + 1] * dt;
      this.posArr[i3 + 2] += this.vel[i3 + 2] * dt;

      // 落地回弹。地面取**出生高度**而不是采样地形——
      // 粒子只活 0.34~0.76s、飞不出 3m，为这点距离接一份地形采样器
      // （还要处理路/野地两个高度源）不抵。代价是上下坡时反弹面
      // 与真实地形差几厘米，而火星在那种坡度上本来就该贴着地皮。
      const floor = this.birthY[i];
      if (this.posArr[i3 + 1] < floor) {
        this.posArr[i3 + 1] = floor;
        this.vel[i3 + 1] = -this.vel[i3 + 1] * 0.32;
        this.vel[i3] *= 0.72;
        this.vel[i3 + 2] *= 0.72;
      }
      i++;
    }
  }

  // ---------------------------------------------------------------- 发射
  private emit(dt: number, s: TrailSubject) {
    const speed = s.speedValue;
    const abs = Math.abs(speed);
    if (abs < TRAIL_EMIT_MIN_SPEED || this.rate <= 0 || this.cap <= 0) {
      // 停下来的时候把攒着的那半点清掉：不然再次起步时
      // 会突然补发一坨"停车前就该出来的火星"。
      this.emitAcc = 0;
      return;
    }

    // 速度比例用 smoothstep 而不是线性：线性的话 2m/s 就有 12% 的密度，
    // 而那是刚松刹车、还没"滑起来"的速度——那一下的点火读作 bug。
    // 分母取 MODE_TUNE 的滑板极速，速度表改了这里跟着改。
    const s01 = clamp01(abs / MODE_TUNE.skate.maxSpeed);
    const ramp = s01 * s01 * (3 - 2 * s01);

    this.emitAcc += dt * this.rate * ramp;
    while (this.emitAcc >= 1) {
      this.emitAcc -= 1;
      this.spawn(s, speed, abs);
    }
  }

  private spawn(s: TrailSubject, speed: number, absSpeed: number) {
    if (this.alive >= this.cap) return; // 池满：丢这一发
    const i = this.alive++;
    const i3 = i * 3;

    // 倒车时板尾在另一头（速度是负的）。滑板倒车极慢，
    // 这条分支主要是别让火星从板头前面冒出来。
    const back = speed >= 0 ? 1 : -1;
    const fx = s.forward.x;
    const fz = s.forward.z;
    // forward 是水平单位向量（`Ride._fwd` 就是 (−sin, 0, −cos)），
    // 右向 = (−fz, 0, fx)，与 `Ride._right` 同一公式。
    const rx = -fz;
    const rz = fx;

    // 横向撒开：滑板是左右晃着前进的，一条笔直的尾迹会读作"轨道"。
    const lateral = (Math.random() - 0.5) * 0.34;
    const x = s.pos.x - fx * TAIL_BACK * back + rx * lateral + (Math.random() - 0.5) * 0.1;
    const z = s.pos.z - fz * TAIL_BACK * back + rz * lateral + (Math.random() - 0.5) * 0.1;
    const y = s.pos.y + SPAWN_Y_LO + Math.random() * (SPAWN_Y_HI - SPAWN_Y_LO);
    this.posArr[i3] = x;
    this.posArr[i3 + 1] = y;
    this.posArr[i3 + 2] = z;
    this.birthY[i] = y;

    // 初速：向后刨（速度越快甩得越远）+ 向上抛 + 横向散。
    //
    // 后抛的速度压得比直觉小：默认机位（`forward`：退 3.2m、抬 2.05m、
    // 看向骑手前方 2.2m）是**俯视**，板后 1m 以内落在画面下三分之一，
    // 再远就出框了。甩太远的结果是"只看见板边炸一下，看不见尾迹"——
    // 而完整的拖尾在 `chase` 侧机位里才读得到。两个机位都要有戏。
    const backSpd = 0.4 + absSpeed * 0.1 + Math.random() * 0.7;
    this.vel[i3] = -fx * backSpd * back + rx * (Math.random() - 0.5) * 1.1;
    this.vel[i3 + 1] = 0.55 + Math.random() * 1.05;
    this.vel[i3 + 2] = -fz * backSpd * back + rz * (Math.random() - 0.5) * 1.1;

    const life = 0.34 + Math.random() * 0.42;
    this.lifeArr[i * 2] = life;
    this.lifeArr[i * 2 + 1] = life;
    // 低档颗数少了，单颗的存在感要补回来——按预算分三档放大。
    // 挂在 cap 上而不是另设一个预设字段：这两个数本来就是一回事的两面。
    const boost = this.cap <= 120 ? 1.35 : this.cap <= 300 ? 1.1 : 1;
    this.sizeArr[i] = (0.032 + Math.random() * 0.05) * boost;
    this.seedArr[i] = Math.random();
    this.emittedTotal++;
  }

  // ---------------------------------------------------------------- 上传
  private upload() {
    this.geo.setDrawRange(0, this.alive);
    if (this.alive === 0) return;
    (this.geo.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aLife') as BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aSize') as BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aSeed') as BufferAttribute).needsUpdate = true;
  }

  /** 把 src 槽的全部粒子状态复制到 dst 槽（交换删除用）。 */
  private swapSlots(dst: number, src: number) {
    const d3 = dst * 3;
    const s3 = src * 3;
    this.posArr[d3] = this.posArr[s3];
    this.posArr[d3 + 1] = this.posArr[s3 + 1];
    this.posArr[d3 + 2] = this.posArr[s3 + 2];
    this.vel[d3] = this.vel[s3];
    this.vel[d3 + 1] = this.vel[s3 + 1];
    this.vel[d3 + 2] = this.vel[s3 + 2];
    this.lifeArr[dst * 2] = this.lifeArr[src * 2];
    this.lifeArr[dst * 2 + 1] = this.lifeArr[src * 2 + 1];
    this.sizeArr[dst] = this.sizeArr[src];
    this.seedArr[dst] = this.seedArr[src];
    this.birthY[dst] = this.birthY[src];
  }

  // ---------------------------------------------------------------- 观测
  /** 活粒子数。回归量它来证明"发射了 / 死干净了 / 没超预算"。 */
  get aliveCount() {
    return this.alive;
  }
  /** 当前预算（同时存活上限）。 */
  get capacity() {
    return this.cap;
  }
  /** 当前满速发射率（个/秒）。 */
  get emitRate() {
    return this.rate;
  }
  /** 点尺寸基准（= 0.5 × 绘图缓冲区高度，像素）。回归量它。 */
  get pointScale() {
    return this.mat.uniforms.uHalfH.value as number;
  }
  /** 出生总数。 */
  get emitted() {
    return this.emittedTotal;
  }

  /** 第 i 个活粒子的位置（回归量出生点用）。越界返回 null。 */
  particlePos(i: number): Vector3 | null {
    if (i < 0 || i >= this.alive) return null;
    return new Vector3(this.posArr[i * 3], this.posArr[i * 3 + 1], this.posArr[i * 3 + 2]);
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}
