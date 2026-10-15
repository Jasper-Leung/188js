/**
 * 湖边一屏 —— 一块独立的湖岸，玩家在这里钓鱼、看风景。
 *
 * ## 它为什么不另开一个 Scene
 *
 * `core/renderer.ts` 持有**一个** `Scene` 和**一个** `camera`（相机由 `World`
 * 创建后传进去，`Renderer` 不 new）。所以另开场景意味着要复制雾、色调映射、
 * 天空、渲染循环的分叉——而这一屏只值一块地形。
 *
 * 于是这里做的是：**同一个 Scene、同一台相机**，只换两件事——
 * 场景里哪些对象可见（`World.setWorldVisible`），以及这台相机由谁驱动。
 * 渲染循环一行没动。
 *
 * ## 判定在哪儿
 *
 * 钓鱼的输赢**不在这个文件里**，在 `game/fishing.ts`。这里只负责把它画出来。
 * 理由见 `fishing.ts` 文件头：判定写在宿主里，无头回归就问不到它。
 *
 * ## 输入
 *
 * 只有三个来源，全部沿用既有通道，一个新的都没有：
 *   · 移动 —— `WASD` / 方向键（宿主已经在派发这些键）
 *   · 转向 —— 画布上的指针拖动
 *   · 钓鱼 —— 确认键（`Space` / `Enter`），**点一下**与**按住**是同一个布尔量的两种用法
 *
 * 将来 VR 手柄接进来时走的是同一条路：扳机 → `act()` → 真 `KeyboardEvent`
 * → 宿主那个监听器。所以这里刻意**不**读手柄状态、也不自己 `addEventListener('keydown')`。
 */
import {
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  ShaderMaterial,
  Color,
  Vector3,
  DoubleSide,
  SphereGeometry,
  CylinderGeometry,
  TorusGeometry,
} from 'three';
import type { PerspectiveCamera } from 'three';
import { WATER_VERT, WATER_FRAG } from '../shaders/world';
import { loadModel, modelUrl } from './assets';
import {
  castFish,
  createFishState,
  stepFish,
  tensionBand,
  type FishOutcome,
  type FishState,
} from '../game/fishing';
import { clamp } from '../core/math';

/** 地形模型。**只有这一处**知道它叫什么，改名时不会漏掉第二个字符串。 */
export const LAKESIDE_MODEL = 'res://models/lakeside.glb';

/** 眼高（米）。站起来的人。 */
const EYE_HEIGHT = 1.68;
/** 走多快（米/秒）。比骑车慢一个数量级——这一屏没有"赶路"这件事。 */
const WALK_SPEED = 3.2;
/** 转向灵敏度（弧度 / 像素）。 */
const LOOK_SENS = 0.0026;
/** 浮漂半径（米）。 */
const BOBBER_R = 0.06;

/** 宿主每帧递给这一屏的输入。全是"这一刻是什么状态"，不含任何事件。 */
export interface LakesideInput {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  /** 本帧指针横移（像素，正 = 右） */
  yawDelta: number;
  /** 本帧指针纵移（像素，正 = 下） */
  pitchDelta: number;
  /** 确认键按住中 */
  hold: boolean;
  /** 确认键这一帧刚被按下（边沿） */
  press: boolean;
}

export interface LakesideFrame {
  fish: FishState;
  /** 当前该显示什么：张力读数 / 咬钩提示 / 结果 */
  hint: 'idle' | 'strike' | 'reel' | 'tension' | 'caught' | 'snapped' | 'missed' | 'escaped';
  tension: 'calm' | 'tight' | 'danger';
}

export class Lakeside {
  /** 加进 Scene 的根。进出这一屏只切它的 `visible`。 */
  readonly group = new Group();
  readonly fish: FishState = createFishState(0);

  /** 模型还在加载 / 加载失败。UI 要知道该不该让玩家进这一屏。 */
  ready = false;
  failed = false;

  private camera: PerspectiveCamera;
  private yaw = 0;
  private pitch = -0.08;
  private pos = new Vector3();

  /** 粗高度网格：走上去不能靠射线，每帧一次 `Raycaster` 太贵。 */
  private grid: Float32Array | null = null;
  private gridMinX = 0;
  private gridMinZ = 0;
  private gridStep = 1;
  private gridN = 0;
  private bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };

  private water: Mesh | null = null;
  private waterMat: ShaderMaterial | null = null;
  private waterLevel = 0;
  private bobber: Group | null = null;
  private time = 0;
  private loading: Promise<void> | null = null;

  constructor(camera: PerspectiveCamera) {
    this.camera = camera;
    this.group.name = 'lakeside';
    this.group.visible = false;
  }

  /**
   * 载地形。**只载一次**，之后进出这一屏不重复走网络。
   *
   * 重复载的症状很轻：只是每次进都卡一下，而玩家未必会归因到"模型又下了一遍"。
   */
  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const model = await loadModel(modelUrl(LAKESIDE_MODEL));
      if (!model) {
        this.failed = true;
        return;
      }
      // 纹理在烘色那一步就已经扔掉了，所以这里只会拿到顶点色材质。
      // 不显式抹平 `castShadow`：一个连光照都不吃的材质投影是纯浪费。
      model.root.name = 'lakeside-terrain';
      this.group.add(model.root);
      this.buildHeightGrid(model.meshes);
      this.placePlayer();
      this.buildWater();
      this.buildBobber();
      this.ready = true;
    })();
    return this.loading;
  }

  /**
   * 从几何里烘一张粗高度网格。
   *
   * **为什么不用 `Raycaster`**：每帧对 5.9 万面的网格打一条射线是白扔的预算，
   * 而这一屏唯一的"碰撞"需求是"脚下多高"。把高度预先烘成 64×64 的格子，
   * 之后每帧只是一次双线性插值。
   *
   * 代价说清楚：**边界会漏**。格子之外返回最近格子的值，于是玩家可以贴着
   * 裁剪框边缘走出去、悬在模型外面。这一屏是独立的、有软边界的，
   * 所以用 `insideBounds` 把人拦在框内——靠 clamp 而不是靠物理。
   */
  private buildHeightGrid(meshes: Mesh[]): void {
    const N = 64;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxY = -Infinity;
    for (const m of meshes) {
      const pos = m.geometry.getAttribute('position');
      if (!pos) continue;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        if (y > maxY) maxY = y;
      }
    }
    if (!Number.isFinite(minX)) return;
    // 模型节点的缩放（meshopt 量化后挂在节点上）必须乘回来，否则整张网格是错的。
    const node = this.group.getObjectByName('lakeside-terrain');
    const s = node?.scale ?? { x: 1, y: 1, z: 1 };
    const p = node?.position ?? { x: 0, y: 0, z: 0 };
    minX = minX * s.x + p.x; maxX = maxX * s.x + p.x;
    minZ = minZ * s.z + p.z; maxZ = maxZ * s.z + p.z;
    this.bounds = { minX, maxX, minZ, maxZ };

    // 网格步长取一格约 5m：足够走，又不至于让岸线在脚下"踩空"。
    const span = Math.max(maxX - minX, maxZ - minZ);
    this.gridN = N;
    this.gridMinX = minX;
    this.gridMinZ = minZ;
    this.gridStep = span / (N - 1);
    const grid = new Float32Array(N * N).fill(NaN);

    for (const m of meshes) {
      const pos = m.geometry.getAttribute('position');
      if (!pos) continue;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i) * s.x + p.x;
        const y = pos.getY(i) * s.y + p.y;
        const z = pos.getZ(i) * s.z + p.z;
        const ix = Math.round((x - this.gridMinX) / this.gridStep);
        const iz = Math.round((z - this.gridMinZ) / this.gridStep);
        if (ix < 0 || ix >= N || iz < 0 || iz >= N) continue;
        const k = ix * N + iz;
        // 取**最高**的那一个：重叠面里贴水面的那片才是玩家看得见的那片。
        if (Number.isNaN(grid[k]) || y > grid[k]) grid[k] = y;
      }
    }
    // 没被任何面盖住的格子用邻居填：否则双线性插值会把 NaN 传出去，
    // 而 NaN 高度会让相机位置变成 NaN —— 画面直接黑屏，没有任何报错。
    for (let pass = 0; pass < 3; pass++) {
      for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
        const k = ix * N + iz;
        if (!Number.isNaN(grid[k])) continue;
        let sum = 0, n = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const jx = ix + dx, jz = iz + dz;
          if (jx < 0 || jx >= N || jz < 0 || jz >= N) continue;
          const v = grid[jx * N + jz];
          if (!Number.isNaN(v)) { sum += v; n++; }
        }
        grid[k] = n ? sum / n : 0;
      }
    }
    this.grid = grid;

    // 水位：取高度分布的低位分位。
    // 压得太低湖就缩成一个坑，压得太高就把岸也淹了——而这两种都只能靠肉眼看。
    // 38% 这条是从实测高度直方图来的（湖盆那一档正好占约五成）。
    const sorted = Array.from(grid).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    this.waterLevel = sorted.length ? sorted[Math.floor(sorted.length * 0.38)] : 0;
    void maxY;
  }

  /** 双线性高度查询。越界返回 NaN —— 由调用方决定怎么处理。 */
  heightAt(x: number, z: number): number {
    const g = this.grid;
    if (!g) return NaN;
    const fx = (x - this.gridMinX) / this.gridStep;
    const fz = (z - this.gridMinZ) / this.gridStep;
    const x0 = Math.floor(fx), z0 = Math.floor(fz);
    const x1 = Math.min(x0 + 1, this.gridN - 1), z1 = Math.min(z0 + 1, this.gridN - 1);
    if (x0 < 0 || z0 < 0 || x0 >= this.gridN || z0 >= this.gridN) return NaN;
    const tx = fx - x0, tz = fz - z0;
    const N = this.gridN;
    const a = g[x0 * N + z0], b = g[x1 * N + z0], c = g[x0 * N + z1], d = g[x1 * N + z1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  /** 水面高度。这一屏没有潮汐、没有波浪幅度差，湖面就是一个常数。 */
  get waterHeight(): number {
    return this.waterLevel;
  }

  /**
   * 出生点：从中心往外找第一个"刚高出水面"的格子。
   *
   * 为什么不能直接用包围盒中心：中心很可能在湖心，而人在水里。
   * 也不直接取包围盒的角：那是裁剪框的边，悬空。
   */
  private placePlayer(): void {
    const cx = (this.bounds.minX + this.bounds.maxX) * 0.5;
    const cz = (this.bounds.minZ + this.bounds.maxZ) * 0.5;
    let best: Vector3 | null = null;
    let bestD = Infinity;
    for (let r = 0; r <= 40 && !best; r++) {
      for (let a = 0; a < 24; a++) {
        const ang = (a / 24) * Math.PI * 2;
        const x = cx + Math.cos(ang) * r * 6;
        const z = cz + Math.sin(ang) * r * 6;
        const h = this.heightAt(x, z);
        if (!Number.isFinite(h)) continue;
        // 只要"高于水面一点点"：再高就是山上，再低就是水里。
        if (h > this.waterLevel + 0.4 && h < this.waterLevel + 6) {
          best = new Vector3(x, h, z);
          bestD = r;
          break;
        }
      }
    }
    this.pos.copy(best ?? new Vector3(cx, this.waterLevel + 2, cz));
    // 面朝湖心。第一眼看出去就该是水，而不是一堵山。
    this.yaw = Math.atan2(cx - this.pos.x, cz - this.pos.z);
    this.pitch = -0.08;
    void bestD;
  }

  /**
   * 水面。**复用主世界那一份着色器**（`shaders/world` 的 WATER_VERT/FRAG）。
   *
   * 那份着色器的三条约束在 `world/water.ts` 写得很清楚，而它们对这一屏同样成立：
   * 法线一直在动、有菲涅耳天空色、岸边淡。三条缺一条就变成一张蓝纸。
   * 抄一份第二版就意味着两份会漂。
   */
  private buildWater(): void {
    const size = Math.max(this.bounds.maxX - this.bounds.minX, this.bounds.maxZ - this.bounds.minZ) * 1.4;
    const geo = new PlaneGeometry(size, size, 24, 24);
    geo.rotateX(-Math.PI / 2);
    const mat = new ShaderMaterial({
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      side: DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        deep_color: { value: new Color(0.055, 0.13, 0.15) },
        shallow_color: { value: new Color(0.2, 0.36, 0.33) },
        sky_color: { value: new Color(0.52, 0.66, 0.86) },
        dusk_tint: { value: new Color(0.19, 0.17, 0.23) },
        // 浮漂落点相对岸边的半径，用来算"近岸要变浅"。
        center: { value: [this.pos.x, this.pos.z] },
        radius: { value: 40 },
        sun_dir: { value: [0.4, 0.8, 0.3] },
        ripple_scale: { value: 0.8 },
        ripple_speed: { value: 0.9 },
        ripple_amp: { value: 0.55 },
        shore_inner: { value: 0.5 },
        shore_outer: { value: 1.15 },
        sky_mix: { value: 0.42 },
        dusk_mix: { value: 0 },
        spec_power: { value: 96 },
        fogColor: { value: new Color(0.72, 0.8, 0.9) },
        fogNear: { value: 40 },
        fogFar: { value: 300 },
      },
    });
    const mesh = new Mesh(geo, mat);
    mesh.position.set(this.pos.x, this.waterLevel, this.pos.z);
    mesh.renderOrder = 1;
    this.water = mesh;
    this.waterMat = mat;
    this.group.add(mesh);
  }

  /** 浮漂 + 竿尖那一小段线。加起来不到 200 面，但它是"在钓鱼"的全部视觉证据。 */
  private buildBobber(): void {
    const g = new Group();
    const red = new MeshStandardMaterial({ color: 0xd24b3a, roughness: 0.7 });
    const white = new MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.7 });
    const body = new Mesh(new SphereGeometry(BOBBER_R, 8, 6), red);
    body.position.y = 0;
    const tip = new Mesh(new CylinderGeometry(BOBBER_R * 0.35, BOBBER_R * 0.35, BOBBER_R * 1.6, 6), white);
    tip.position.y = BOBBER_R * 1.1;
    const ring = new Mesh(new TorusGeometry(BOBBER_R * 2.4, BOBBER_R * 0.25, 4, 10), white);
    ring.rotation.x = Math.PI / 2;
    g.add(body, tip, ring);
    g.visible = false;
    this.bobber = g;
    this.group.add(g);
  }

  /**
   * 按玩家到湖边的位置定一局的种子。
   *
   * 用**位置**而不是时间：同一个湖边站反复进进出出拿到同一串结果，
   * 于是"这个钓点好不好钓"是玩家能学到的——而按时间的话每一局都不一样，
   * 玩家学不到任何东西，只觉得随机。
   */
  seedFor(x: number, z: number): void {
    const q = (v: number) => Math.round(v / 25) | 0;
    const next = createFishState((q(x) * 73856093) ^ (q(z) * 19349663));
    Object.assign(this.fish, next);
  }

  /** 进这一屏。相机交给这里驱动。 */
  enter(): void {
    this.group.visible = true;
    this.applyCamera();
  }

  exit(): void {
    this.group.visible = false;
    this.bobber?.parent?.remove(this.bobber ?? new Object3D());
    if (this.bobber) this.group.add(this.bobber);
    this.bobber && (this.bobber.visible = false);
  }

  /** 落点。收线时浮漂会朝这里收。 */
  private bobberTarget(): Vector3 {
    const d = new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(this.fish.range);
    return new Vector3(this.pos.x + d.x, this.waterLevel, this.pos.z + d.z);
  }

  private applyCamera(): void {
    this.camera.position.set(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z);
    const cp = Math.cos(this.pitch);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
    void cp;
  }

  /**
   * 推一帧。
   *
   * @param hold 确认键按住中
   * @param press 确认键这一帧刚按下
   */
  update(dt: number, input: LakesideInput, inXR = false): LakesideFrame {
    this.time += dt;

    /**
     * XR 会话里 three 接管了相机，所以走与看**整段让位**。
     *
     * 不让位的症状不是"视角歪"，而是**两套每帧打架**：
     * 桌面那套把相机摆到岸上，XR 那套按头显的实际位姿画，
     * 画面随两者的执行顺序闪，而没有任何一处报错。
     * 移动同理——真实位移来自玩家自己走动，不来自摇杆推着相机挪。
     */
    if (!inXR) {
    // ---- 走 ----
    const fwd = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
    const strafe = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    if (fwd || strafe) {
      const len = Math.hypot(fwd, strafe) || 1;
      const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
      // 前方 = (sin, 0, cos)。横向 = (cos, 0, -sin)。
      this.pos.x += ((fwd / len) * s + (strafe / len) * c) * WALK_SPEED * dt;
      this.pos.z += ((fwd / len) * c - (strafe / len) * s) * WALK_SPEED * dt;
      const h = this.heightAt(this.pos.x, this.pos.z);
      // 越界（NaN）就退回上一帧的位置，而不是把人放进 NaN——
      // 相机位置一旦是 NaN，画面直接黑屏，而界面上一提示都没有。
      if (Number.isFinite(h)) this.pos.y = Math.max(h, this.waterLevel);
      else {
        this.pos.x = clamp(this.pos.x, this.bounds.minX + 2, this.bounds.maxX - 2);
        this.pos.z = clamp(this.pos.z, this.bounds.minZ + 2, this.bounds.maxZ - 2);
        const hh = this.heightAt(this.pos.x, this.pos.z);
        if (Number.isFinite(hh)) this.pos.y = Math.max(hh, this.waterLevel);
      }
    }

    // ---- 看 ----
    this.yaw -= input.yawDelta * LOOK_SENS;
    this.pitch = clamp(this.pitch - input.pitchDelta * LOOK_SENS, -1.2, 0.6);
    this.applyCamera();
    } // if (!inXR)

    // ---- 钓鱼 ----
    const before = this.fish.phase;
    if (input.press && this.fish.phase === 'idle') castFish(this.fish);
    stepFish(this.fish, dt, input.hold);

    this.updateBobber(dt, before);

    return {
      fish: this.fish,
      hint: this.hint(),
      tension: tensionBand(this.fish.tension),
    };
  }

  private hint(): LakesideFrame['hint'] {
    const f = this.fish;
    if (f.phase === 'result') {
      return f.outcome === 'caught' ? 'caught' : f.outcome === 'snapped' ? 'snapped'
        : f.outcome === 'escaped' ? 'escaped' : 'missed';
    }
    if (f.phase === 'bite') return f.biteLeft <= 0.35 ? 'strike' : 'idle';
    if (f.phase === 'reeling') return 'tension';
    return 'idle';
  }

  private updateBobber(dt: number, prevPhase: string): void {
    const b = this.bobber;
    if (!b) return;
    const f = this.fish;
    const target = this.bobberTarget();

    if (f.phase === 'idle') {
      b.visible = false;
      return;
    }
    b.visible = true;

    if (f.phase === 'casting') {
      // 从手边飞到落点。用一条抛物线，中点抬高——直线飞过去不像抛投。
      const t = clamp(f.castT, 0, 1);
      const from = new Vector3(this.pos.x, this.pos.y + EYE_HEIGHT - 0.35, this.pos.z);
      b.position.lerpVectors(from, target, t);
      b.position.y += Math.sin(t * Math.PI) * 2.2;
      b.rotation.set(0, 0, 0);
      return;
    }

    if (f.phase === 'result' && prevPhase !== 'result') {
      // 钓上来了：把浮漂收到手边。
      b.position.lerp(new Vector3(this.pos.x, this.pos.y + EYE_HEIGHT - 0.35, this.pos.z), Math.min(1, dt * 6));
      return;
    }

    // waiting / bite / reeling：浮在落点上，bite 时猛点一下。
    const dip = f.phase === 'bite' ? Math.max(0, Math.sin((1.15 - f.biteLeft) * 26)) * 0.12 : 0;
    const idle = Math.sin(this.time * 2.2) * 0.03;
    b.position.set(target.x, this.waterLevel + BOBBER_R * 0.6 + dip + idle, target.z);
    // 收线时把浮漂往回拽一点，玩家看得见"在动"。
    if (f.phase === 'reeling') {
      const back = new Vector3(this.pos.x, this.waterLevel, this.pos.z);
      const pull = Math.sin(this.time * 7) * 0.05 * (0.4 + f.progress);
      b.position.lerp(back, pull * 0.5);
      b.position.y = this.waterLevel + BOBBER_R * 0.6 + idle;
    }
  }

  /** 结算文案交给 i18n 层，这里只给一个稳定的键。 */
  static outcomeKey(o: FishOutcome): string {
    return o === 'caught' ? 'lake_caught' : o === 'snapped' ? 'lake_snapped'
      : o === 'escaped' ? 'lake_escaped' : 'lake_missed';
  }

  dispose(): void {
    this.water?.geometry.dispose();
    this.waterMat?.dispose();
    this.group.clear();
    this.group.visible = false;
    this.grid = null;
    this.ready = false;
  }
}