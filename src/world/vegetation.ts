/**
 * 植被 —— 行道树、灌木、草皮。全部 InstancedMesh，按块（chunk）流式进出场景。
 *
 * ## 为什么按块而不是一个大 InstancedMesh
 *
 * three.js 只有一个 InstancedMesh 意味着**一次 draw call**，看起来最省。
 * 但它的代价是每帧要遍历全部实例矩阵做视锥剔除与距离排序——
 * 高档位附近 3000 株草皮时，那一趟遍历本身就要几毫秒，而且
 * **视锥剔除是 three 内部按整个 mesh 的包围球做的**：
 * 一块铺满全图的 InstancedMesh 包围球覆盖整个世界，一个三角面都剔不掉。
 *
 * 按中心线弧长切成 12m 一块之后：
 *   · 每块有自己的包围球，three 的视锥剔除真正生效；
 *   · 玩家动过 6m 才重算一次可见集，不是每帧；
 *   · 每块 1 个 draw call，可见 20 块 = 20 次调用，核显吃得下。
 *
 * ## 草皮为什么低档直接关
 *
 * 草皮是这一族里最贵的一项：铺满屏幕的半透明卡片是填充率杀手，
 * 在核显上比树和灌木加起来还贵。低档的做法不是"把草变稀"，
 * 而是把这份预算**整个挪给渲染分辨率**（0.6 倍 = 36% 的像素），
 * 换来的是整个画面都更顺，而不是只有草皮这一项降级。
 * 见 PRESETS[TIER_LOW].grassEnabled。
 */
import {
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  BufferGeometry,
  MeshStandardMaterial,
  Group,
  type Material,
} from 'three';
import { CENTERLINE, TOTAL_ARCLENGTH, STATIONS, distToCenterline, type Vec3Flat } from '../data/route';
import { hashGrid } from '../core/noise';
import type { Terrain } from './terrain';
import type { QualityPreset } from '../core/settings';

const CHUNK_LEN = 12; // 米，按中心线弧长
const CHUNK_COUNT = Math.ceil(TOTAL_ARCLENGTH / CHUNK_LEN);
/**
 * 上一轮的调查结论（保留下来，因为它是"为什么换成丛"的理由）：
 *
 * 株距原本取源项目 `TreeScatter.SPACING` 的 25m，于是
 * `TOTAL_ARCLENGTH / 25 = 49` 棵，左右错开 = **每侧 50m 一株**。
 * 真实的乡村公路是每侧 15~25m，所以密度只有真实值的三分之一，
 * 实机截屏上这条路读起来是"高速公路"而不是"乡道"——
 * 而且这不是档位问题：高档也是 49 株（高档只是看得更远）。
 *
 * **当时为什么不敢多种：一株树 35,461 三角面。** 49 株就 174 万面。
 * `tools/optimize-assets.mjs` 里那张给"量产道具"单独定预算的 `MASS_MODELS`
 * 表**声明了却从没被 `JOBS` 读过**，接上之后树 51K→32K、灌木 35K→17K，
 * 但简化器在 **32,924 面撞到硬底**（ratio 0.02 / error 0.15 / `lockBorder: false`
 * 全试过，一动不动——这类摄影测量网格 UV 接缝太多，几乎没有一条边能塌缩）。
 *
 * **当时的结论是"靠调参数到顶了，得换一棵低模树"。**
 * 现在低模树换进来了（`pine.glb`，6 棵/31,219 面 = 5,203 面/棵），
 * 结论随之变成"可以种满"——下面就是它怎么种的。
 */
/**
 * 行道树**丛**的株距（沿路弧长，米）。
 *
 * ## 一丛是 6 棵，量过了
 *
 * `pine+trees+3d+model.glb` 的 X 方向顶点直方图有**六个清晰的峰**
 * （40 个桶里的第 4/10/16/23/29/35 桶），确实是一行 6 棵。
 * 模型归一化到 1 单位，所以：
 *
 *   · 整丛宽 **1.0**、高 **0.467**、深 **0.238**
 *   · 单株宽约 **0.15**、高 **0.467**（长宽比 1:3.1，是正常树的比例）
 *   · **株距只有 0.15** —— 6 棵挨在一起
 *
 * ## 为什么缩放取 25~31 而不是更小
 *
 * 缩放 S 时单株高 0.467S、株距 0.15S，**两者永远同时放大**——
 * 所以「树有多高」和「树挨得多近」是绑死的，调节它们的是一个数：
 *
 *   S=17 时单株 8m、株距 2.6m → 六棵贴成一堵绿墙
 *   S=27 时单株 12.6m、株距 4.1m → 读作**一丛松**
 *
 * 想要单株 12m 就取 S≈26，整丛宽 26m，**株距必须跟着放到 28m 左右**，
 * 否则丛和丛互相穿插，路边那条绿带会变成一堵连续的墙。
 *
 * ## 密度与三角面
 *
 * 1228.8 / 28 = 44 丛 = **264 株树**，比源项目那版（49 株）多 5.4 倍。
 * 一丛 31,219 面，档次可见半径 160m → 约 11 丛 = 34 万面，
 * 与源项目高档的总量相当，**而画面上的树多了 5.4 倍**。
 *
 * ## 贴图这件事要说在前面
 *
 * 这一株的 baseColor 实测是**草地纹理**（平均 RGB 69/90/43，标准差只有 9，
 * 几乎是一整块平绿，见 `tools/` 里的取样）。所以它渲染出来是
 * **一片均匀的深绿树冠**，没有针叶的层次。
 * 远看（几十米以外）没问题，近看（贴着路肩 10m）会读成"绿色的柱子"。
 * 这一点是资产的现状，不是代码能补的——要真树冠层次需要换贴图或换模型。
 */
/**
 * 行道树株距（沿路弧长，米）。
 *
 * 拆成单棵之后株距与株高**解绑**了，可以单独调密度。
 * 7m 配左右错开 = **每侧 14m 一株**，接近真实乡村公路的行道树株距（15~25m）。
 * 再密三角面就吃不消：单株 5,200 面，高档可见半径 160m 对应 320m 走廊，
 * 9m 一株是 36 株 = 19 万面。
 */
const TREE_SPACING = 7;
/**
 * `pine.glb` 被 `tools/split-glb.mjs` 拆成了几棵独立的。
 *
 * 拆开之前是「一丛 6 棵」当**一个**实例摆，6 棵共用一个 Y——
 * 而整丛宽 26m，地形在这 26m 里起伏明显，于是**有的悬空、有的半埋**。
 * 拆开之后每棵各自取 `terrain.getHeightAt()`，这是"不悬空"的根上解法，
 * 而且顺带把株距与株高解绑了（原来 0.15S 同时决定"多高"和"挨多近"）。
 */
export const TREES_PER_COPE = 6;
/** 沉进地里的深度（米）。见下面 `TREE_SIDE_OFFSET` 旁边那段说明。 */
const TREE_BURY = 0.45;
/**
 * 树到中心线的横向距离下限（米）。
 *
 * **这是"树不许压在路面上"这条硬约束的落点**，不是一个审美数字。
 * 路面总半宽 `ROAD_HALF_WIDTH = 6.5m`，拆分后单棵最宽 0.261（模型单位），
 * 缩放上限 31 → 树冠半径 8.1m，理论下限 6.5 + 8.1 = **14.6m**。
 * 这里取 16m 再留 2m 抖动，于是**最坏情况下枝条离沥青仍有 3.4m**。
 *
 * 取 12.5m 会让缩放大的那几株（scale 31）压到路面上——
 * 而"树压在沥青上"是画面上一眼能看出的那种错。
 */
const TREE_SIDE_OFFSET = 16;
/**
 * 树到**整条**中心线的最近距离下限（米）。
 *
 * 路面总半宽 6.5m + 树冠半径最坏 8.1m = 14.6m 是理论下限，
 * 这里取 16m 留一点余量。**这不是审美数字，是「树不许压在路面上」的硬约束**，
 * 由 verify_veg_density 量实测值守住。
 */
const TREE_ROAD_CLEAR = 16;
/**
 * 驿站的**树冠让位半径**（米）。落在这个圈里的行道树直接不种。
 *
 * ## 为什么需要它
 *
 * 驿站落在中心线外 18m，而行道树的横向偏移下限是 16m——
 * **两者在同一条带上**。实测琴音林（station 13）最近的一株行道树
 * 离站中心只有 **5.7m**：树是种在林冠地块**里面**的。
 *
 * 画面的后果不是"树多了"，而是**那株树读不出是树**：
 * 它从一大片航拍林冠里穿出来，比例对不上、体量对不上，
 * 读作"林子里戳了一根杆子"。而琴音林的模型拉高到 23.4m 之后更明显——
 * 一根 12m 的行道树站在 23m 的林冠旁边，矮了一截。
 *
 * 20m 盖住的是"站脚半宽 8m + 树冠半径最坏 8.1m + 余量"，
 * 与 `TREE_ROAD_CLEAR` 那条路肩约束同一个量级。
 *
 * **只减株数，不改株距。** 株距是"路两边一排树的节奏"，
 * 在让位圈里挖空一圈，读出来是"驿站前面有个院子"；
 * 而把株距整体拉大，读出来是"这一段路不一样"，那是另一种错。
 */
const STATION_TREE_CLEAR = 20;
/**
 * 导出给回归用。判据要守的正是这个数本身——
 * "让位圈半径被改成 0"会立刻让最近树距离那条红，
 * 而中间值（比如被人调到 8m）只有直接比对这个常量才抓得住。
 */
export const STATION_TREE_CLEAR_R = STATION_TREE_CLEAR;

/** 世界坐标是否落在任意一座驿站的让位圈里。 */
function insideStationClear(x: number, z: number): boolean {
  for (const s of STATIONS) {
    if (Math.hypot(x - s.x, z - s.z) < STATION_TREE_CLEAR) return true;
  }
  return false;
}
/**
 * 灌木也埋一点，但比树浅。
 *
 * 灌木是"贴着地的"东西，沉 0.5m 就会变成半个球露在外面；
 * 而它同样受点采样的坑（`getHeightAt` 只给中心那一柱）。
 * 0.25m 是两边都能接受的折中。
 */
const BUSH_BURY = 0.25;
const BUSH_SPACING = 11;

/**
 * 把模型抬到地面上所需的垂直偏移。
 *
 * ## 为什么不能只放地形高度
 *
 * 实例矩阵的 `y` 是**模型原点**的高度，不是模型**底面**的高度。
 * 源项目的 GLB 里树和灌木的原点都不在底面（灌木尤其明显：
 * 它的模型高只有宽的一半，原点落在形心附近），所以
 * `pos.y = 地形高度` 会让底下半个身子插进土里。
 *
 * 驿站那边早就处理过同一件事（`stations.ts` 的 `box.min.y * scale`），
 * 植被这里漏了——同一批资产、两处不同的落地规则，结果只有一半站在地上。
 *
 * ## 为什么要乘这一株自己的缩放
 *
 * 树是"小模型 × 大缩放"（`modelScale = 1`，逐株 `p.scale` 6~9），
 * 灌木是 `modelScale = 4` 乘 0.5~1.0。偏移必须跟着**这一株**的最终缩放走；
 * 用一个固定的 `yOffset` 只会对其中一种正确——而这正是原来的写法。
 *
 * 抽成纯函数是为了能无头验：回归要守的正是"它随缩放变化，
 * 且方向永远是把底面抬到地面、而不是反过来把地面抬上去"。
 */
export function groundOffsetFor(bboxMinY: number, modelScale: number, instanceScale: number): number {
  if (!Number.isFinite(bboxMinY)) return 0;
  return -bboxMinY * modelScale * instanceScale;
}

export type VegKind = 'tree' | 'bush' | 'grass';

interface Placement {
  x: number;
  y: number;
  z: number;
  rotY: number;
  scale: number;
  /** 往地里埋的深度（米）。灌木是 0。 */
  bury: number;
  /** 用哪个模型变体（拆分出来的第几棵）。灌木恒为 0。 */
  variant: number;
}

interface Chunk {
  index: number;
  /** 中心线参数区间 [0,1) */
  t0: number;
  t1: number;
  /** 该块的中心（用于粗判距离） */
  cx: number;
  cz: number;
  /**
   * 这一块的**内容**离块心最远多远（米），树/灌木各一份。
   *
   * 剔除要判"内容离玩家多远"，而不是"块心离玩家多远"——
   * 一块 12m 加上 16m 的横向偏移，边缘的树能离块心 26m。
   * 少了这一项，块心刚出半径时里面最近的那株树其实还在半径里，
   * 于是它在玩家眼前凭空消失。见 `measureOuters`。
   */
  treeOuter: number;
  bushOuter: number;
  tree: Placement[];
  bush: Placement[];
  grass: Placement[];
}

/** 剔除判定需要的最小块信息。导出来是为了回归能在无头环境里直接调。 */
export interface CullChunk {
  cx: number;
  cz: number;
  treeOuter: number;
  bushOuter: number;
}

/**
 * 剔除余量（米）。
 *
 * 判的是**树干落点**到玩家的距离，而树冠比树干宽：拆分后单棵最宽 0.261
 * 模型单位，缩放上限 31 → 冠幅半径约 8m。所以树心刚进半径时，
 * 树冠还有几米在外面。6m 盖住冠幅与株距抖动。
 *
 * **它不是防抖。** 防抖在 `update()` 的重算门槛上（`RECULL_MOVE`）：
 * 块只在玩家真的走过 `RECULL_MOVE` 米之后才换一次可见性，
 * 于是边界上不会一帧一变。
 */
const CULL_MARGIN = 6;

/**
 * 重算门槛：玩家走过这么多米才换一次可见集（米）。
 *
 * 原来是"跨过块边界"（12m）。换成几何距离之后**不能沿用块号当门槛**，
 * 因为块号是"最近中心线点"推出来的，玩家横着开离路时它几乎不动，
 * 而画面里的树早该换了。4m 是取舍：一轮 103 块的判定不到 0.05ms，
 * 换来的重算粒度比原来的 12m 细三倍，边界上树的弹出位置也更贴近半径。
 */
const RECULL_MOVE = 4;
/** 心神系数变化超过这个数才重算（0.02 ≈ 半径变 4m 上下）。 */
const RECULL_VIS = 0.02;

/**
 * 哪些块该显示。**纯函数**，方便无头回归直接调。
 *
 * ## 为什么必须按几何距离判
 *
 * 原实现是 `|块号 − 玩家块号| × CHUNK_LEN <= 半径`，
 * 也就是**拿弧长差当距离**。这只在"路是一条不自交的曲线"时成立。
 *
 * 而这个世界是 **8 字**：中心线被自己穿过 4 次，两条支路在交叉口
 * **物理上重合**（实测中心线 #0 与 #480 相距 0.0m），
 * 弧长上却隔着整整半个环 —— 块号差 51，换算成 612m。
 *
 * 后果是：站在十字路口时，玩家**贴脸**的那一片树落在"612m 之外"的块上，
 * 于是被剔掉；而原地转圈时车身一漂，`nearestChunkT` 在两条支路之间
 * 反复跳，`cur` 在 #0 与 #51 之间来回翻，**整片树线一帧一帧地换**——
 * 症状就是"转圈时树和建筑在不断隐藏显示"。
 *
 * 几何距离没有这个问题：重合的两条支路本来就是同一个点。
 */
export function chunkVisibility(
  chunks: readonly CullChunk[],
  px: number,
  pz: number,
  treeR: number,
  bushR: number,
): { tree: boolean[]; bush: boolean[] } {
  const tree = new Array<boolean>(chunks.length);
  const bush = new Array<boolean>(chunks.length);
  const treeLimit = treeR + CULL_MARGIN;
  const bushLimit = bushR + CULL_MARGIN;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const d = Math.hypot(c.cx - px, c.cz - pz);
    tree[i] = d - c.treeOuter <= treeLimit;
    bush[i] = d - c.bushOuter <= bushLimit;
  }
  return { tree, bush };
}

export class Vegetation {
  readonly group = new Group();
  readonly groupTrees = new Group();
  readonly groupBushes = new Group();
  private chunks: Chunk[] = [];
  private bushMesh: InstancedMesh | null = null;
  /**
   * 上一次重算可见集时的玩家位置与心神系数。`null` = 还没算过。
   *
   * **原来是"上一次算的是哪一块"。** 那是弧长口径的配套写法，
   * 换成几何距离之后它就多余了：块号是"最近中心线点"推出来的，
   * 玩家横着开离路时它几乎不动，而画面里的东西早该换了。
   * 见 `RECULL_MOVE`。
   */
  private lastAt: { x: number; z: number; vis: number } | null = null;
  private preset: QualityPreset;

  /**
   * 块号 → 该块的 InstancedMesh（没有内容的块是 null）。
   *
   * 曾经这里写的是 `groupTrees.children[c.index * 3]` 这种"用块号当子节点下标"的写法，
   * 看着能跑，实际全错：`groupTrees.children` 只装**有树的块**，
   * 而 12m 一块、株距 25m，意味着将近一半的块根本没有树。
   * 于是第 37 号块会去拿第 111 个子节点（不存在，被 `if (child)` 吞掉），
   * 而本该隐藏的近处块从来没被隐藏过——**植被剔除从头到尾没有生效过**。
   *
   * 症状很安静：帧率只掉几个点，没有报错，也没有任何一条判据会红。
   * 所以这里显式维护映射表，而不是靠下标推算。
   */
  private treeOfChunk: InstancedMesh[][] = [];
  private bushOfChunk: (InstancedMesh | null)[] = [];

  /** 统计，给 FPS/调试面板 */
  stats = { chunksVisible: 0, trees: 0, bushes: 0, drawCalls: 0 };

  constructor(preset: QualityPreset, terrain: Terrain) {
    this.preset = preset;
    this.group.name = 'vegetation';
    this.group.add(this.groupTrees, this.groupBushes);
    this.buildPlacements(terrain);
  }

  /**
   * 中心线按参数取点，**带夹取**。
   *
   * 夹取不是防御性编程，是必需的：最后一个块覆盖到
   * `t1 = 103×12 / 1228.82 = 1.006`，于是 `floor(1.006 × 960) = 965`
   * 越过了数组末尾（961 个点，末位下标 960），读出来是 `undefined`，
   * 下一句取它的 `.x` 当场抛 `Cannot read properties of undefined`。
   * 症状是"植被一初始化整个世界就炸"，而栈顶在植被模块里，
   * 真正的原因是**块的数量**——所以这个坑很容易被当成"数据错了"重新查一遍。
   */
  private sampleAt(t: number): { p: Vec3Flat; tx: number; tz: number } {
    const f = Math.min(Math.max(t, 0), 1) * (CENTERLINE.length - 1);
    const fi = Math.min(Math.floor(f), CENTERLINE.length - 2);
    const p = CENTERLINE[fi];
    const pPrev = CENTERLINE[Math.max(0, fi - 1)];
    const pNext = CENTERLINE[Math.min(CENTERLINE.length - 1, fi + 1)];
    let tx = pNext.x - pPrev.x;
    let tz = pNext.z - pPrev.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    return { p, tx, tz };
  }

  /**
   * 确定性布置。**按弧长间隔放，再分桶到块里做剔除**。
   *
   * 早先的写法是"每块撒 N 株随机"，看起来一样、结果差四倍：
   * 块长 12m、每块 2 株 = 每 6 米一棵树，而源项目是 `SPACING = 25m`
   * （约每 25 米一株，左右错开）。结果是骑行道树变成一堵绿墙，
   * 相机一进世界就埋在树冠里——而"路不见了""天太暗"这类症状
   * 都会指向别处去，因为几何本身完全合法。
   *
   * 所以这里照抄源项目的形状：沿线按间隔取点，位置由 (弧长序号, 侧) 决定，
   * 然后按它落在哪一块分桶。密度跟着画质档走，但**间隔不跟着走**——
   * 降档砍的是株数，不是株距，砍株距会让低档看起来像"树长在别处"。
   */
  private buildPlacements(terrain: Terrain) {
    const chunks: Chunk[] = [];
    for (let ci = 0; ci < CHUNK_COUNT; ci++) {
      chunks.push({
        index: ci,
        t0: (ci * CHUNK_LEN) / TOTAL_ARCLENGTH,
        t1: ci === CHUNK_COUNT - 1 ? 1 : ((ci + 1) * CHUNK_LEN) / TOTAL_ARCLENGTH,
        cx: 0,
        cz: 0,
        treeOuter: 0,
        bushOuter: 0,
        tree: [],
        bush: [],
        grass: [],
      });
    }
    this.chunks = chunks;

    /** 世界坐标落在哪一块 */
    const chunkAt = (x: number, z: number): number => {
      let best = 0;
      let bestD = Infinity;
      for (let ci = 0; ci < CHUNK_COUNT; ci++) {
        const c = chunks[ci];
        const d = (c.cx - x) * (c.cx - x) + (c.cz - z) * (c.cz - z);
        if (d < bestD) {
          bestD = d;
          best = ci;
        }
      }
      return best;
    };
    // 块心先算出来，chunkAt 要用
    for (const c of chunks) {
      const mid = this.sampleAt((c.t0 + c.t1) * 0.5).p;
      c.cx = mid.x;
      c.cz = mid.z;
    }

    // ---- 行道树：逐株摆放 ----
    //
    // 每一株**独立取地形高度**（`terrain.getHeightAt`），
    // 这是"树不悬空"的根上解法：之前整丛 6 棵共用一个 Y，
    // 而整丛宽 26m，地形在这 26m 里起伏明显——必然有的悬空、有的半埋。
    //
    // 变体来自 `tools/split-glb.mjs` 的拆分结果（6 棵不同大小的松），
    // 逐株随机取一个，避免整条路是同一棵树复制出来的。
    const nTree = Math.floor(TOTAL_ARCLENGTH / TREE_SPACING);
    for (let i = 0; i < nTree; i++) {
      if (i % 2 === 1 && this.preset.treeDensity < 0.75) continue;
      if (i % 4 === 2 && this.preset.treeDensity < 0.5) continue;
      const t = (i * TREE_SPACING) / TOTAL_ARCLENGTH;
      const r1 = hashGrid(i, 1, 7717);
      const r2 = hashGrid(i, 2, 3313);
      const r3 = hashGrid(i, 3, 9091);
      const r4 = hashGrid(i, 4, 5507);
      const { p, tx, tz } = this.sampleAt(t);
      const side = i % 2 === 0 ? -1 : 1; // 左右错开
      // 横向偏移。**下限是硬的**：路面总半宽 ROAD_HALF_WIDTH = 6.5m，
      // 加上树冠最宽处的半径，保证树**任何一根枝条都不会压在沥青上**。
      // 拆分后单棵宽 0.26（模型单位）× 缩放 27 ≈ 7m，半宽 3.5m，
      // 所以 6.5 + 3.5 = 10m 是理论下限；实际取 12.5m 留出抖动余量。
      const off = TREE_SIDE_OFFSET + r3 * 2.0;
      const x = p.x + -tz * off * side;
      const z = p.z + tx * off * side;
      // **硬约束：到整条中心线的最近距离必须够远。**
      // 上面那两行是"沿法线推 off 米"，那只在路是直线时等价于距离；
      // 8 字的两条支路会绕回来互相靠近，于是"离本段 16m"的位置
      // 可能离**另一段**只有 4m——树就长在沥青上了（实测过 4.2m）。
      // 所以这里必须量整条线，不够就丢弃这一株。
      if (distToCenterline(x, z) < TREE_ROAD_CLEAR) continue;
      // **驿站的让位圈**：不种在驿站身上。见 `STATION_TREE_CLEAR`。
      if (insideStationClear(x, z)) continue;
      const y = terrain.getHeightAt(x, z);
      chunks[chunkAt(x, z)].tree.push({
        x, y, z,
        // 单棵模型的长轴是本地 +X（6 棵排成一行时是这个方向）。
        // 绕 Y 转 θ 把 +X 映到 (cosθ, 0, −sinθ)，要它等于切线就是 θ = atan2(−tz, tx)。
        // 再叠一点随机朝向，否则整条路的树像用尺子排的。
        rotY: Math.atan2(-tz, tx) + (r2 - 0.5) * 0.9,
        // 0.463 是单棵高度（模型单位），×27 ≈ 12.5m 的松
        scale: 24 + r1 * 7,
        // 往地里埋一点：`getHeightAt` 是点采样，给的是树干中心那一柱的高度，
        // 而地形在树根那 0.5m 内有坡度——正好坐在坡的上沿时，
        // 下坡那一侧会露出缝，读作"树浮在地面上"。
        bury: TREE_BURY,
        variant: Math.floor(r4 * TREES_PER_COPE) % TREES_PER_COPE,
      });
    }

    // ---- 灌木：更稀、更远。16m 是硬下限（路面总半宽 6.5m）----
    const nBush = Math.floor(TOTAL_ARCLENGTH / BUSH_SPACING);
    for (let i = 0; i < nBush; i++) {
      if (i % 3 === 0 && this.preset.treeDensity < 0.75) continue;
      if (i % 2 === 0 && this.preset.treeDensity < 0.5) continue;
      const t = (i * BUSH_SPACING) / TOTAL_ARCLENGTH;
      const r1 = hashGrid(i, 7, 5501);
      const r2 = hashGrid(i, 8, 6619);
      const r3 = hashGrid(i, 9, 8821);
      const { p, tx, tz } = this.sampleAt(t);
      const side = i % 2 === 0 ? -1 : 1;
      const off = 16 + r3 * 22;
      const x = p.x + -tz * off * side;
      const z = p.z + tx * off * side;
      const y = terrain.getHeightAt(x, z);
      chunks[chunkAt(x, z)].bush.push({
        x, y, z,
        rotY: r1 * Math.PI * 2,
        scale: 0.5 + r2 * 0.5,
        bury: BUSH_BURY,
        variant: 0,
      });
    }

    // ---- 草皮：已移除 ----
    //
    // 原来是一层交叉双面片（1m × 1m × 4 三角形），顶点着色器里朝相机转，
    // 片元里程序化出三根叶片的叶形，靠 alphaTest 剔掉卡片其余部分。
    //
    // **移除的理由是它读不成草。** 用户实机看下来，
    // 近处是几片**立着的绿色矩形**，远处因为叶片只有 12cm 宽，
    // 在一次像素覆盖里混成一块更绿的方块——两种距离下都不像草，
    // 而草这个信号的**唯一价值就在于"像草"**，读不出来就该拿掉。
    // 留着它的代价还不止画面：铺满屏幕的半透明卡片是填充率杀手，
    // 比树和灌木加起来还贵。
    //
    // 草的质感搬进了地形着色器（`TERRAIN_PATCH` 的近场草丛）。
    // 同样的信息量，**0 个额外三角形**、0 次 alphaTest、0 个 draw call，
    // 而且不会在近处变成纸片——那才是零贴图路线上该有的做法。
    void 0;

    this.measureOuters();
  }

  /**
   * 量出每块的"内容半径"（见 `Chunk.treeOuter`）。
   *
   * 必须在所有落点都进桶之后跑——落点是边摆边分桶的，
   * 边摆边量只会量到当时已经摆进去的那几株。
   *
   * 12m 的块 + 16m 的横向偏移，最边缘那株树能离块心 26m；
   * 而剔除判的是"内容离玩家多远"，所以这个 26m 得减掉，
   * 否则树会在自己还在半径里的时候被剔掉。
   */
  private measureOuters() {
    for (const c of this.chunks) {
      let t = 0;
      let b = 0;
      for (const p of c.tree) t = Math.max(t, Math.hypot(p.x - c.cx, p.z - c.cz));
      for (const p of c.bush) b = Math.max(b, Math.hypot(p.x - c.cx, p.z - c.cz));
      c.treeOuter = t;
      c.bushOuter = b;
    }
  }

  /**
   * 装上**树**的模型网格。
   *
   * 拆簇后的松树有 6 个几何体，所以每一块要按变体分组：
   * 同一个变体的树共用一个 geometry，于是「一块 N 株」变成
   * 「一块最多 N 个 InstancedMesh」。块长 12m、株距 7m，
   * 一块平均 1.7 株、最多 3 个变体 —— **draw call 的增长是有界的**，不是 ×6。
   *
   * **树与灌木分开装**，是为了让加载失败时互不牵连：
   * 之前是 `if (tree && bush) { attachMeshes(...) }`，
   * 松树拉不到就表现成"树和灌木一起消失"，排查时完全指错了方向。
   */
  attachTrees(treeGeos: BufferGeometry[], treeMat: Material | null) {
    this.groupTrees.clear();
    this.treeOfChunk = new Array<InstancedMesh[]>(CHUNK_COUNT).fill(null as never);
    if (!treeGeos.length) return;
    for (const c of this.chunks) {
      if (!c.tree.length) continue;
      const byVariant = new Map<number, Placement[]>();
      for (const p of c.tree) {
        const v = Math.min(treeGeos.length - 1, Math.max(0, p.variant));
        const arr = byVariant.get(v);
        if (arr) arr.push(p);
        else byVariant.set(v, [p]);
      }
      const made: InstancedMesh[] = [];
      for (const [v, list] of byVariant) {
        const m = this.makeInstanced(treeGeos[v], treeMat, list, 1.0, bottomOf(treeGeos[v]), 'tree', v);
        made.push(m);
        this.groupTrees.add(m);
      }
      this.treeOfChunk[c.index] = made;
    }
    // **必须重算一次可见集**：`update()` 只在玩家真的走过一段才跑，
    // 而模型是异步到达的 —— 到达时那些网格的 `visible` 是默认的 true，
    // 于是全场 103 块的树会在同一帧全亮出来（一次几十万三角面）。
    this.lastAt = null;
  }

  /** 装上灌木的模型网格。 */
  attachBushes(bushGeo: BufferGeometry, bushMat: Material | null) {
    this.bushMesh = new InstancedMesh(bushGeo, bushMat ?? defaultVegMaterial(), 1);
    this.bushMesh.castShadow = true;
    this.bushMesh.receiveShadow = true;
    this.bushMesh.frustumCulled = true;
    this.groupBushes.clear();
    this.bushOfChunk = new Array<InstancedMesh | null>(CHUNK_COUNT).fill(null);
    for (const c of this.chunks) {
      if (!c.bush.length) continue;
      const m = this.makeInstanced(bushGeo, bushMat, c.bush, 4.0, bottomOf(bushGeo), 'bush', 0);
      this.bushOfChunk[c.index] = m;
      this.groupBushes.add(m);
    }
    this.lastAt = null;
  }

  private makeInstanced(
    geo: BufferGeometry,
    mat: Material | null,
    placements: Placement[],
    modelScale: number,
    modelBottom: number,
    kind: 'tree' | 'bush',
    variant: number,
  ): InstancedMesh {
    const m = new InstancedMesh(geo, mat ?? defaultVegMaterial(), placements.length);
    // 名字里带上株数、变体号与沉地深度。`?dump=1` 的场景自检与 `?probe`
    // 都要靠它把"画面左边那个东西"对应回具体对象——没有名字时
    // 自检只能报"一个 InstancedMesh"，等于没有回答问题。
    m.name = `veg-${kind}-v${variant}-${placements.length}@bury${(placements[0]?.bury ?? 0).toFixed(2)}`;
    const mat4 = new Matrix4();
    const q = new Quaternion();
    const pos = new Vector3();
    const scl = new Vector3();
    const up = new Vector3(0, 1, 0);
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      q.setFromAxisAngle(up, p.rotY);
      const s = modelScale * p.scale;
      // 抬升量跟着**这一株**的最终缩放走（见 groundOffsetFor 的说明），
      // 再减去这一株要埋进地里的深度
      pos.set(p.x, p.y + groundOffsetFor(modelBottom, modelScale, p.scale) - p.bury, p.z);
      scl.setScalar(s);
      mat4.compose(pos, q, scl);
      m.setMatrixAt(i, mat4);
    }
    m.instanceMatrix.needsUpdate = true;
    m.count = placements.length;
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = true;
    return m;
  }
  /**
   * 每帧更新可见块。
   *
   * ## 判的是几何距离（`chunkVisibility`），不是弧长差
   *
   * 原实现是 `|块号 − 玩家块号| × CHUNK_LEN`，也就是拿弧长差当距离。
   * 在 8 字交叉口上，两条支路**物理重合而弧长隔半个环**（612m），
   * 于是玩家贴脸的树被判成"612m 外"剔掉；原地转圈时车身一漂，
   * `cur` 在两个支路之间来回跳，整片树线一帧一变。
   * 判据见 `verify_veg_cull`。
   *
   * ## 什么时候重算
   *
   * 每帧重算是浪费，但门槛必须是**位置**而不是块号：
   * 块号来自"最近中心线点"，玩家横着开离路时它几乎不动。
   * 所以按走过多少米（`RECULL_MOVE`）与心神系数变化来卡。
   *
   * 半径由画质档给，再乘以心神带来的可见系数。
   */
  update(playerX: number, playerZ: number, visibilityFactor: number) {
    // 心神系数**必须真的进半径**。它原来是算了 treeR/bushR 之后
    // 直接 `void` 掉，判定仍用 `preset.*Radius`——于是"心神低→看得更短"
    // 这条在整个游戏里从来没有生效过：灯笼、香囊、遮罩三样都在给一个
    // 没人读的数写账。verify_mood 守的是那条公式本身，守不到这里。
    const treeR = Math.max(this.preset.treeRadius * visibilityFactor, 1);
    const bushR = Math.max(this.preset.bushRadius * visibilityFactor, 1);

    const at = this.lastAt;
    if (
      at &&
      Math.hypot(playerX - at.x, playerZ - at.z) < RECULL_MOVE &&
      Math.abs(visibilityFactor - at.vis) < RECULL_VIS
    ) {
      return;
    }
    this.lastAt = { x: playerX, z: playerZ, vis: visibilityFactor };

    const vis = chunkVisibility(this.chunks, playerX, playerZ, treeR, bushR);

    let visibleChunks = 0;
    let treeCount = 0;
    let bushCount = 0;
    let calls = 0;

    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      const showTree = vis.tree[i];
      const showBush = vis.bush[i];

      const iTree = this.treeOfChunk[i];
      const iBush = this.bushOfChunk[i];
      // 一块可能有多个变体网格，逐个开关
      if (iTree) for (const m of iTree) m.visible = showTree;
      if (iBush) iBush.visible = showBush;

      if (showTree) {
        visibleChunks++;
        treeCount += c.tree.length;
        calls += iTree ? iTree.length : 0;
      }
      if (showBush) {
        bushCount += c.bush.length;
        calls++;
      }
    }

    this.stats = { chunksVisible: visibleChunks, trees: treeCount, bushes: bushCount, drawCalls: calls };
  }

  setPreset(preset: QualityPreset) {
    this.preset = preset;
  }

  /** 换档之后强制重算可见集 */
  invalidate() {
    this.lastAt = null;
  }

  dispose() {
    this.group.clear();
    this.groupTrees.children.forEach((c) => (c as InstancedMesh).dispose());
    this.groupBushes.children.forEach((c) => (c as InstancedMesh).dispose());
  }
}

function defaultVegMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
}

/**
 * 几何体的最低点（世界 = 模型单位）。
 *
 * **不能读 `geometry.boundingBox.min.y` 就完事**——那要靠 GLB 里的
 * accessor min/max，而源项目导出的那些值是按 int16 写的，读出来是垃圾
 * （`tools/glb-inspect.mjs` 能看到 `min=-32767` 这类值）。
 * 所以自己从顶点扫一遍。树 6.4 万顶点、灌木 4.2 万，只在挂载时各扫一次。
 *
 * ## 这里曾经有一个让「路边从来没有树」的 bug
 *
 * 原写法是：
 *
 * ```ts
 * for (let i = 1; i < pos.array.length; i += pos.itemSize) {
 *   const y = pos.array[i];
 * ```
 *
 * **它假定 `position` 是自己独立的一块数组。** 而 `pine.glb` / `tree.glb` /
 * `bush.glb` 的属性是**交错**的（NORMAL + POSITION + TEXCOORD_0 共用一个
 * buffer，stride 是 8 个 float 而不是 3）。于是这段按 3 跨步走，
 * 会把**法线分量和 UV 坐标当成 Y 读进来**——而摄影测量模型的 UV 可以是很大的数。
 *
 * 现场读数（`?probe`）：树的实例 Y 在 **+949,141 米**，灌木在 **+103,334 米**，
 * 包围球中心也在同一量级，于是**整批植被被视锥剔除，一次都不画**。
 * 而布置表说它们在那儿、剔除统计说它们可见、19 条回归没有一条会红——
 * 因为那些判据量的是"布了多少株"，不是"画了几次"。
 *
 * 改动前那株 `tree.glb` 也一样（读数 240,164 米），
 * 所以这是**从移植第一天就在的**，不是最近才有的。
 *
 * ## 正确写法
 *
 * `pos.getY(i)` 由 three.js 自己处理交错与非交错两种布局。
 * 另外加一道**离群剔除**：简化阶段会留下少数远离本体的顶点，
 * 一个 −35 公里的游离点就足以毁掉"最低点"这个问法（见 `safeBottom`）。
 *
 * 扫不出东西时返回 0（"不抬也不沉"），而不是把整片植被抬到天上去。
 */
export function bottomOf(geo: BufferGeometry): number {
  const pos = geo.getAttribute('position');
  if (!pos || pos.count === 0) return 0;

  // 先按 getY 取一遍（**不能碰 pos.array**，理由见文件头）
  const ys = new Float64Array(pos.count);
  let minY = Infinity;
  let maxY = -Infinity;
  let sum = 0;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    ys[i] = y;
    sum += y;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minY)) return 0;

  // 离群剔除：一个游离顶点就能毁掉绝对最小值。
  //
  // 判据用**中位数 + MAD**（median absolute deviation），不用 min/max 也不用 σ：
  //   · 用 min/max 求跨度的话，离群点自己把跨度撑大，
  //     cutoff = mean − 4×span 于是反而把离群点圈进来——自己给自己开门；
  //   · 用 σ 同理：σ 被离群点撑大之后判据就失效。
  // 中位数与 MAD 对少数离群点免疫，这是它被用来做这件事的原因。
  // 实测：200 个点在 0~3.98、外加一个 −35000 的游离点，
  // 中位数 ≈1.99、MAD ≈1.0 → cutoff ≈ −3.9 → 离群点被剔掉，底面读成 0。
  const sorted = Float64Array.from(ys).sort();
  const mid = pos.count >> 1;
  const median = pos.count % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const dev = new Float64Array(pos.count);
  for (let i = 0; i < pos.count; i++) dev[i] = Math.abs(ys[i] - median);
  dev.sort();
  const mad = pos.count % 2 ? dev[mid] : (dev[mid - 1] + dev[mid]) / 2;
  // MAD 为 0（大量重合顶点）时不剔，否则会把模型整体剔没
  const cutoff = mad > 1e-12 ? median - 4 * 1.4826 * mad : -Infinity;
  let lo = Infinity;
  let kept = 0;
  for (let i = 0; i < pos.count; i++) {
    const y = ys[i];
    if (y < cutoff) continue;
    kept++;
    if (y < lo) lo = y;
  }
  // 全被剔掉说明判据用错了，退回绝对最小值（返回 0 会让模型沉进地里，更糟）
  return kept > 0 && Number.isFinite(lo) ? lo : minY;
}
