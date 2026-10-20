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
  BackSide,
  BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Texture,
  TextureLoader,
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
  RingGeometry,
} from 'three';
import type { PerspectiveCamera } from 'three';
import { WATER_VERT, WATER_FRAG } from '../shaders/world';
import { loadModel, modelUrl } from './assets';
import {
  castFish,
  createFishState,
  stepFish,
  tensionBand,
  xrHudState,
  STRIKE_PRELUDE_SEC,
  type FishOutcome,
  type FishState,
} from '../game/fishing';
import { clamp } from '../core/math';

/**
 * 头显读数里状态环的配色。
 *
 * **和 DOM 那一版用同一套色**（`ui/styles.css` 的
 * `.g-lakeside-bar-fill[data-band=...]` 与 `[data-state="strike"]`），
 * 于是同一件事在桌面与头显里长一个样——玩家在头显里学会的
 * "黄=紧、红=要断"，换到桌面上还是这个意思。
 */
const XR_RING_COLORS: Record<string, number> = {
  none: 0x6f8f88,
  ready: 0x6f8f88,
  strike: 0xffd98a,
  caught: 0x7fc7a8,
  snapped: 0xe07a5f,
  escaped: 0x9aa4a0,
  missed: 0x9aa4a0,
};

/** 张力档位配色。同样取自 DOM 那一版。 */
const XR_BAND_COLORS: Record<string, number> = {
  calm: 0x7fc7a8,
  tight: 0xe8c46a,
  danger: 0xe07a5f,
};

/** 地形模型。**只有这一处**知道它叫什么，改名时不会漏掉第二个字符串。 */
export const LAKESIDE_MODEL = 'res://models/lakeside.glb';

/**
 * 全景贴图（等距圆柱 / equirectangular，2:1）。
 *
 * ## 为什么这一屏要有它
 *
 * 地形模型是**照片重建 + 简化**出来的：320m 见方的台面、8.3 万顶点、
 * 顶点色、unlit。远看像样，**站在岸上（眼高 1.68m）看就是一面
 * 几十米宽的平涂色块**——实测：出生点前方 200m 处是一堵 400m 高的绿墙。
 * 这不是能靠调参数救的，是资产本身的分辨率。
 *
 * 所以这一屏的背景改用**全景照片本身**（也就是那块地形的来源图），
 * 地形只在 `buildHeightGrid()` / `placePlayer()` 里当"岸线和水位在哪"的
 * 依据，画面上不再出现。见 `buildPano()`。
 */
export const LAKESIDE_PANO = 'env/lakeside-pano.jpg';

/**
 * 全景里**地平线**所在的行（0 = 图顶，1 = 图底）。
 *
 * 量出来的：这张全景不是垂直居中的，水面与远岸的交线落在 v≈0.54
 * （也就是图中心往下 7°）。按标准等距圆柱映射贴上去，它的地平线就会
 * 落在**仰角 -7°**，和我们自己那块水面的地平线差 7°——中间会横着
 * 一条全景里的湖水，看着像两片湖接在一起。`buildPano()` 把这一行
 * 掰到赤道上。
 */
const PANO_HORIZON_V = 0.54;

/**
 * 水面的半边长（米）。
 *
 * 必须盖到远裁剪面附近（相机 `far = 900`）：水面边缘一露出来，就会
 * 看见"我们的湖"和"全景里的湖"接不上——那条缝比什么都显眼。
 * 780 是 `far` 的 0.87，边缘落在仰角 -0.17°，肉眼分不出来。
 */
const WATER_HALF = 780;

/** 眼高（米）。站起来的人。 */
const EYE_HEIGHT = 1.68;
/** 走多快（米/秒）。比骑车慢一个数量级——这一屏没有"赶路"这件事。 */
const WALK_SPEED = 3.2;
/** 转向灵敏度（弧度 / 像素）。 */
const LOOK_SENS = 0.0026;
/** 浮漂半径（米）。 */
const BOBBER_R = 0.06;

/** 水位判据里"算平"的带宽（米）。水面在重建里不是绝对平的，给 ±3m。 */
const FLAT_BAND = 3;
/** 扫候选水位的步长（米）。 */
const LEVEL_STEP = 2;
/** 四邻。连通块用，提到模块级免得每次 new。 */
const NEI4: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * 水位：**模型里最大的一块近似水平、且连通的区域**。
 *
 * ## 为什么不是分位数
 *
 * 原来这里是「高度分布的第 38 百分位」，注释说那个数是从实测直方图来的。
 * 问题是那次实测是在**归一化空间**里做的（见 `buildHeightGrid()`：
 * 整张网格曾经缩在跨度 1.1 的空间里），也就是说它是在一份错数据上试出来的。
 * 摆回米制之后它落在 `+39.4m`——湖面被抬到山腰上，出生点落进一个
 * 10m 宽的水坑，四周 10m 外就是 400m 的陡壁（实测：见下面那条注释）。
 *
 * ## 现在按"水是平的"来找
 *
 * 这一片水域是**照片重建**出来的：水面上没有起伏。所以湖面就是模型里
 * 最大的一块**近似水平**的连通区域。于是扫一遍候选高度，取
 * 「±`FLAT_BAND` 米以内的格子连成的最大连通块」最大的那一个。
 *
 * 这个模型实测落在 `-30m`，一块 192 格（约 4900 m²）的水面；
 * 而第 38 百分位那个值离它有 70m。
 *
 * 两个刻意的选择：
 *   · **从低往高扫、只在严格更大时才替换** —— 打平时取低的那个。
 *     山顶上也有平的地方，而湖在山谷里。
 *   · **候选步长 2m** —— 湖面是一整片，差 2m 不会换一个答案，
 *     但扫描量少一半。代价是水位精度 ±1m，肉眼看不出来。
 *
 * 代价说清楚：**这是启发式，不是标定**。换一个湖岸模型要重新看一眼。
 */
function pickWaterLevel(grid: Float32Array, N: number): number {
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < grid.length; k++) {
    const h = grid[k];
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  if (!Number.isFinite(lo)) return 0;

  const mark = new Uint8Array(N * N);
  const seen = new Uint8Array(N * N);
  const stack = new Int32Array(N * N);
  let bestLevel = lo, bestSize = 0;

  for (let y = lo; y <= hi; y += LEVEL_STEP) {
    let any = false;
    for (let k = 0; k < N * N; k++) {
      const on = Math.abs(grid[k] - y) <= FLAT_BAND ? 1 : 0;
      mark[k] = on;
      if (on) any = true;
    }
    if (!any) continue;
    seen.fill(0);
    let top = 0;
    for (let i = 0; i < N * N; i++) {
      if (!mark[i] || seen[i]) continue;
      let sp = 0, n = 0;
      stack[sp++] = i;
      seen[i] = 1;
      while (sp > 0) {
        const k = stack[--sp];
        n++;
        const ix = (k / N) | 0, iz = k % N;
        for (const [dx, dz] of NEI4) {
          const jx = ix + dx, jz = iz + dz;
          if (jx < 0 || jx >= N || jz < 0 || jz >= N) continue;
          const j = jx * N + jz;
          if (!mark[j] || seen[j]) continue;
          seen[j] = 1;
          stack[sp++] = j;
        }
      }
      if (n > top) top = n;
    }
    // 严格大于：打平取**低**的那个（湖在山谷里，不在山顶）。
    if (top > bestSize) { bestSize = top; bestLevel = y; }
  }
  return bestLevel;
}

/**
 * 复用的小对象。`applyCamera()` 每帧都要摆一次相机，
 * 而 `buildHeightGrid()` 要对 8.3 万个顶点各做一次变换——两处都不该 new。
 */
const _v3 = new Vector3();
const _m4 = new Matrix4();
const _m4b = new Matrix4();

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
  /** 全景穹顶。跟着相机走，半径取远裁剪面的 0.9。 */
  private pano: Mesh | null = null;
  private time = 0;
  private loading: Promise<void> | null = null;

  /**
   * 头显里那套**世界空间**读数。
   *
   * ## 它挂在相机下面，不在场景里
   *
   * three 在 XR 会话里会**改写游戏相机的世界变换**——`WebXRManager` 的
   * `updateUserCamera()` 把相机的 `matrix` 换成头显位姿（见
   * `node_modules/three/src/renderers/webxr/WebXRManager.js`）。
   * 所以挂在相机上的东西天然跟着头走，而挂在场景里的会留在原地。
   *
   * 挂相机的另一个好处：`World.setWorldVisible()` **特意跳过相机和挂架**
   * （它要把湖边之外的都藏掉，但相机必须留着），
   * 所以这块 HUD 不会在退出湖边时被一起藏掉——它自己管自己的 `visible`。
   *
   * ## 为什么需要它
   *
   * 桌面与手机上的读数在 `ui/lakesidePanel.ts` 的 **DOM** 里，
   * 而沉浸式 VR 会话里 DOM **不会进头显**。
   * 扳机的输入是通的（`core/xr.ts` 派发成真的 `Space`），
   * 但没有这块几何，玩家就看不见该什么时候点、也看不见张力——
   * 而钓鱼的全部玩法就是这两件事。详见 `game/fishing.ts` 的 `xrHudState()`。
   */
  private xrHud = new Group();
  /** 状态环。咬钩窗口里快闪、空闲时慢呼吸、收场时是结果色。 */
  private xrRing!: Mesh;
  private xrRingMat!: MeshBasicMaterial;
  /** 张力条。轨道 + 填充；填充从左边缘往右长。 */
  private xrBarTrack!: Mesh;
  private xrBarFill!: Mesh;
  private xrBarFillMat!: MeshBasicMaterial;

  constructor(camera: PerspectiveCamera) {
    this.camera = camera;
    this.group.name = 'lakeside';
    this.group.visible = false;
    this.buildXrHud();
  }

  /**
   * 搭那块头显读数。
   *
   * **全是无光照的平面**（`MeshBasicMaterial`）：头显里那点光线下，
   * 受光照的材质会暗到看不见，而这块东西必须**永远读得出来**。
   * 几何也刻意做成最便宜的——两个平面加一个环，没有贴图、没有额外 draw call 负担。
   */
  private buildXrHud(): void {
    this.xrHud.name = 'lakeside-xr-hud';
    this.xrHud.visible = false;
    this.xrHud.renderOrder = 10;
    // 相机是**渲染相机**，而 `setWorldVisible()` 明确跳过它——
    // 所以挂在它下面不会被"藏掉世界"那一步一起带走。
    this.camera.add(this.xrHud);

    // 状态环。RingGeometry 躺在 XY 平面、法线朝 +Z，
    // 而相机朝 -Z 看——所以它**正对着脸**，不需要翻面。
    this.xrRingMat = new MeshBasicMaterial({ color: 0x6f8f88, transparent: true, opacity: 0.9 });
    this.xrRing = new Mesh(new RingGeometry(0.095, 0.135, 40), this.xrRingMat);
    this.xrRing.position.set(0, -0.17, -1.15);
    this.xrHud.add(this.xrRing);

    // 张力条。轨道是暗的，填充按张力往右长。
    const BAR_W = 0.42;
    const BAR_H = 0.03;
    const trackMat = new MeshBasicMaterial({ color: 0x10181a, transparent: true, opacity: 0.75 });
    this.xrBarTrack = new Mesh(new PlaneGeometry(BAR_W, BAR_H), trackMat);
    this.xrBarTrack.position.set(0, -0.34, -1.15);
    this.xrHud.add(this.xrBarTrack);

    // 填充从**左边缘**往右长，所以它挂在一个锚点下面、
    // 自己的原点偏在右端——缩放时左边缘不动。
    const anchor = new Group();
    anchor.position.set(-BAR_W / 2, -0.34, -1.15);
    this.xrHud.add(anchor);
    this.xrBarFillMat = new MeshBasicMaterial({ color: 0x7fc7a8, transparent: true, opacity: 0.95 });
    this.xrBarFill = new Mesh(new PlaneGeometry(BAR_W, BAR_H), this.xrBarFillMat);
    this.xrBarFill.position.set(BAR_W / 2, 0, 0);
    anchor.add(this.xrBarFill);
  }

  /**
   * 把这一帧的读数刷到那块几何上。
   *
   * **只有 XR 会话里才可见**：桌面上有 DOM 那一版，
   * 两套同时出现会变成"同一个东西画了两遍"。
   */
  private updateXrHud(inXR: boolean): void {
    if (!inXR) {
      this.xrHud.visible = false;
      return;
    }
    const st = xrHudState(this.fish);
    const showRing = st.ring !== 'none';
    this.xrRing.visible = showRing;
    this.xrBarTrack.visible = st.tensionVisible;
    this.xrBarFill.visible = st.tensionVisible;
    this.xrHud.visible = showRing || st.tensionVisible;
    if (!this.xrHud.visible) return;

    if (showRing) {
      this.xrRingMat.color.setHex(XR_RING_COLORS[st.ring]);
      // 脉动只做**缩放**：改颜色会让"亮=该点"这条语义在呼吸时被冲淡。
      const amp = st.ring === 'strike' ? 0.18 : 0.05;
      const s = 1 + amp * st.ringPulse;
      this.xrRing.scale.set(s, s, 1);
      this.xrRingMat.opacity = st.ringFade * (st.ring === 'strike' ? 0.55 + 0.45 * st.ringPulse : 0.9);
    }
    if (st.tensionVisible) {
      this.xrBarFillMat.color.setHex(XR_BAND_COLORS[st.band]);
      // 填充从左边缘往右长：缩放的是**宽度**。
      this.xrBarFill.scale.x = Math.max(0.0001, st.tension);
    }
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
      // 全景是这一屏**看得见**的那一层，所以等它。等不到也不阻断——
      // 没有全景时这一屏退回"水 + 天穹"，仍然能钓鱼。
      await this.buildPano();
      // 地形到此为止：它已经交出岸线、水位和可走面，画面交给全景。
      model.root.visible = false;
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
   * ## 顶点必须先过**各自的世界矩阵**（这里错过一次，代价是整屏）
   *
   * `lakeside.glb` 的缩放与平移挂在 **mesh 节点**上——`decimated_mesh`：
   * 平移 `(-234.8, 218.5, -41.0)`、缩放 `290.2`。那是 meshopt 量化把
   * 解量化变换写回节点的结果（顶点属性本身是归一化的：x/z ∈ ±0.55、
   * y ∈ ±1），**不是编辑器里的残留，删不掉**。
   *
   * 原来这里读的是 `getObjectByName('lakeside-terrain')` 的 `scale`/`position`，
   * 而那是**外面那层 Group**——它的 scale 恒为 1、position 恒为 0。于是整张
   * 高度网格、水位、出生点、水面全缩在归一化空间里（跨度 1.1 而不是 320m）：
   * 相机被摆在世界原点、水面是一块 1.54m 的方片、而 320m 外的湖岸成了
   * 天边一座浮岛。桌面和头显一起坏，因为两边读的是同一张错网格。
   *
   * 代价说清楚：**边界会漏**。格子之外返回最近格子的值，于是玩家可以贴着
   * 裁剪框边缘走出去、悬在模型外面。这一屏是独立的、有软边界的，
   * 所以用 `insideBounds` 把人拦在框内——靠 clamp 而不是靠物理。
   */
  private buildHeightGrid(meshes: Mesh[]): void {
    const N = 64;
    // 顶点 → **这一组**的坐标：先补上 mesh 自己的变换，再退掉 group 的。
    // 减掉 group 那一步今天等于空转（group 是单位变换），但它让 `pos`、
    // 水面、浮漂全部活在这一组的坐标系里，跟 `applyCamera()` 的口径一致。
    this.group.updateMatrixWorld(true);
    const toLocal = _m4.copy(this.group.matrixWorld).invert();

    // 第一遍：量包围盒。必须在**变换之后**量——归一化空间里的
    // 「0.4m 高出水面」是 0.0014，那条判据会永远不成立。
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const m of meshes) {
      const pos = m.geometry.getAttribute('position');
      if (!pos) continue;
      const mat = _m4b.multiplyMatrices(toLocal, m.matrixWorld);
      for (let i = 0; i < pos.count; i++) {
        _v3.fromBufferAttribute(pos, i).applyMatrix4(mat);
        if (_v3.x < minX) minX = _v3.x; if (_v3.x > maxX) maxX = _v3.x;
        if (_v3.z < minZ) minZ = _v3.z; if (_v3.z > maxZ) maxZ = _v3.z;
      }
    }
    if (!Number.isFinite(minX)) return;
    this.bounds = { minX, maxX, minZ, maxZ };

    // 网格步长取一格约 5m：足够走，又不至于让岸线在脚下"踩空"。
    const span = Math.max(maxX - minX, maxZ - minZ);
    this.gridN = N;
    this.gridMinX = minX;
    this.gridMinZ = minZ;
    this.gridStep = span / (N - 1);
    const grid = new Float32Array(N * N).fill(NaN);

    // 第二遍：填格子。取**最高**的那一个：重叠面里贴水面的那片才是玩家看得见的那片。
    for (const m of meshes) {
      const pos = m.geometry.getAttribute('position');
      if (!pos) continue;
      const mat = _m4b.multiplyMatrices(toLocal, m.matrixWorld);
      for (let i = 0; i < pos.count; i++) {
        _v3.fromBufferAttribute(pos, i).applyMatrix4(mat);
        const ix = Math.round((_v3.x - this.gridMinX) / this.gridStep);
        const iz = Math.round((_v3.z - this.gridMinZ) / this.gridStep);
        if (ix < 0 || ix >= N || iz < 0 || iz >= N) continue;
        const k = ix * N + iz;
        if (Number.isNaN(grid[k]) || _v3.y > grid[k]) grid[k] = _v3.y;
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
    this.waterLevel = pickWaterLevel(grid, N);
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
    const size = WATER_HALF * 2;
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

  /**
   * 全景穹顶。
   *
   * ## 三个必须说清楚的取舍
   *
   * 1. **地平线要掰到赤道上。** 标准等距圆柱映射把 `v = 0.5` 放在赤道，
   *    而这张全景的地平线在 `v = 0.54`。不掰的话它落在仰角 -7°，
   *    而我们那块水面（眼高 1.68m，地平线就在 0°）会在 0° 处收边——
   *    中间横着一条全景里的湖水，看着像两片湖叠在一起。
   *    所以按地平线把 UV 分成上下两段各自线性拉伸到半个球
   *    （天空那半是渐变，拉 1.08 倍看不出来）。
   *
   * 2. **`depthTest: false` + `renderOrder` 排在水面之前。** 它是个
   *    永远在远裁剪面上的壳，让它参与深度测试只会和别的物体抢。
   *    和 `Sky` 一样：先铺底，后面画上去的东西自然盖住它。
   *
   * 3. **`toneMapped = false`。** 渲染器开着 ACES（见 `core/renderer.ts`），
   *    而这是一张照片：再过一道色调映射等于把原图改色。玩家要的正是
   *    "和原图一样"。
   *
   * 贴图拿不到时**安静地不建**：这一屏仍然能钓鱼，只是背景退回天穹。
   */
  private async buildPano(): Promise<void> {
    const tex = await new Promise<Texture | null>((resolve) => {
      new TextureLoader().load(LAKESIDE_PANO, (t) => resolve(t), undefined, () => resolve(null));
    });
    if (!tex) return;
    tex.colorSpace = 'srgb';
    // 全景是 1:1 铺在球面上的，各向异性只帮到地平线那一圈，1 够用（低配优先）。
    tex.anisotropy = 1;

    const geo = new SphereGeometry(1, 48, 32);
    const uv = geo.getAttribute('uv') as BufferAttribute;
    // three 的球 UV 是 **y=1 在北极**，而贴图默认 flipY，所以
    // "图顶那一行"对应 uv.y = 1。先把 uv 翻成"离图顶多远"再掰。
    for (let i = 0; i < uv.count; i++) {
      const f = 1 - uv.getY(i);
      const g = f < PANO_HORIZON_V
        ? 0.5 * (f / PANO_HORIZON_V)
        : 0.5 + 0.5 * ((f - PANO_HORIZON_V) / (1 - PANO_HORIZON_V));
      uv.setY(i, 1 - g);
    }
    uv.needsUpdate = true;

    const mat = new MeshBasicMaterial({
      map: tex,
      side: BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    mat.toneMapped = false;
    const mesh = new Mesh(geo, mat);
    mesh.name = 'lakeside-pano';
    mesh.frustumCulled = false;
    // 天穹是 -1000，排在它后面一档：两个都是"先铺底"的东西，
    // 顺序定死免得换一处渲染顺序就把全景盖掉。
    mesh.renderOrder = -900;
    this.pano = mesh;
    this.group.add(mesh);
    this.applyPanoToCamera();
  }

  /** 穹顶永远跟着相机（和 `Sky.attachTo()` 同一套做法）。 */
  private applyPanoToCamera(): void {
    if (!this.pano) return;
    this.camera.getWorldPosition(_v3);
    this.pano.position.copy(_v3);
    this.pano.scale.setScalar(this.camera.far * 0.9);
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
    this.applyPanoToCamera();
  }

  exit(): void {
    this.group.visible = false;
    // 头显读数挂在**相机**下面，不在 `group` 里——
    // 所以退出这一屏时必须自己收起来，否则它会跟着相机留在主世界里。
    this.xrHud.visible = false;
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
    // `pos` 是**这一组里**的坐标，而相机挂在 scene（或 XR 挂架）下，
    // 所以过一道 `group.matrixWorld`。今天这一道是空转（group 恒为单位变换），
    // 写出来是为了以后谁挪了这个 group 也不会静默地站到别处去。
    this.group.updateMatrixWorld(true);
    _v3.set(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z).applyMatrix4(this.group.matrixWorld);
    this.camera.position.copy(_v3);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
  }

  /**
   * 这一屏的**站姿**：眼高处的世界坐标 + 朝向（弧度）。
   *
   * XR 会话拿它当参考空间的原点。为什么需要一个"原点"：
   * three 的 `WebXRManager` 把头显位姿当成 `camera.parent` 下的局部变换
   * （`WebXRManager.js` 的 `updateCamera()`：`matrixWorld = parent.matrixWorld × 位姿`），
   * 所以进会话之后**桌面那套 `applyCamera()` 就完全够不着相机了**。
   * 不摆挂架的话参考空间原点恒在 `(0,0,0)`，而湖岸在 320m 外——
   * 头显里看到的就是天边一座浮岛。桌面正常而 VR 坏，是必然的，不是偶然。
   */
  xrPose(out: Vector3): number {
    this.group.updateMatrixWorld(true);
    out.set(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z).applyMatrix4(this.group.matrixWorld);
    return this.yaw;
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
    this.applyPanoToCamera();
    this.updateXrHud(inXR);

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
    if (f.phase === 'bite') return f.biteLeft <= STRIKE_PRELUDE_SEC ? 'strike' : 'idle';
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
    this.pano?.geometry.dispose();
    const pm = this.pano?.material as MeshBasicMaterial | undefined;
    pm?.map?.dispose();
    pm?.dispose();
    this.pano = null;
    this.group.clear();
    this.group.visible = false;
    this.grid = null;
    this.ready = false;
  }
}