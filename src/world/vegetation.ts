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
import { CENTERLINE, TOTAL_ARCLENGTH, type Vec3Flat } from '../data/route';
import { hashGrid } from '../core/noise';
import { clamp } from '../core/math';
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
const TREE_SPACING = 28;
/** `pine.glb` 一丛几棵。回归用它把"丛数"换算成玩家看得见的"株数"。 */
export const TREES_PER_COPE = 6;
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
}

interface Chunk {
  index: number;
  /** 中心线参数区间 [0,1) */
  t0: number;
  t1: number;
  /** 该块的中心（用于粗判距离） */
  cx: number;
  cz: number;
  tree: Placement[];
  bush: Placement[];
  grass: Placement[];
}

export class Vegetation {
  readonly group = new Group();
  readonly groupTrees = new Group();
  readonly groupBushes = new Group();
  private chunks: Chunk[] = [];
  private treeMesh: InstancedMesh | null = null;
  private bushMesh: InstancedMesh | null = null;
  private lastChunkIndex = -1;
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
  private treeOfChunk: (InstancedMesh | null)[] = [];
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

    // ---- 行道树：一"丛" = 模型里的 6 棵，整丛沿路摆放 ----
    //
    // 源项目那株单棵行道树是 **32,929 三角面**，而 `pine.glb` 是
    // **6 棵合成一个网格、31,219 面，折合 5,203 面/棵**——便宜 6.3 倍。
    // 所以这里摆的不再是"一株一株"，而是"一丛一丛"，一丛 = 6 棵。
    //
    // **丛的行必须与路平行**（`rotY` 对齐切线），否则一丛 17m 宽的树
    // 横着插在路边，内侧那几棵会直接压在路面上——路面总半宽 6.5m，
    // 而丛深 0.238×17 ≈ 4m，横向摆的话内缘会到 11−8.5 = 2.5m。
    // 平行摆时内缘在 11−2 = 9m，离路缘还有 2.5m。
    const nTree = Math.floor(TOTAL_ARCLENGTH / TREE_SPACING);
    for (let i = 0; i < nTree; i++) {
      if (i % 2 === 1 && this.preset.treeDensity < 0.75) continue;
      if (i % 4 === 2 && this.preset.treeDensity < 0.5) continue;
      const t = (i * TREE_SPACING) / TOTAL_ARCLENGTH;
      const r1 = hashGrid(i, 1, 7717);
      const r2 = hashGrid(i, 2, 3313);
      const r3 = hashGrid(i, 3, 9091);
      const { p, tx, tz } = this.sampleAt(t);
      const side = i % 2 === 0 ? -1 : 1; // 左右错开
      // 横向偏移：路面总半宽 6.5m，丛半深 0.119×27 ≈ 3.2m，
      // 所以 13m 留出 3.3m 的净空，再加一点抖动免得整条路像用尺子量过。
      const off = 13 + r3 * 2.0;
      const x = p.x + -tz * off * side;
      const z = p.z + tx * off * side;
      const y = terrain.getHeightAt(x, z);
      chunks[chunkAt(x, z)].tree.push({
        x, y, z,
        // 模型的长轴是本地 +X；绕 Y 转 θ 把 +X 映到 (cosθ, 0, −sinθ)，
        // 要它等于切线 (tx, 0, tz) 就是 θ = atan2(−tz, tx)。
        // 再叠一点随机朝向，否则整条路的树带像用直尺排的。
        rotY: Math.atan2(-tz, tx) + (r2 - 0.5) * 0.1,
        // 0.467 是单株高度（模型单位），×27 ≈ 12.6m 的松
        scale: 25 + r1 * 6,
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
      chunks[chunkAt(x, z)].bush.push({ x, y, z, rotY: r1 * Math.PI * 2, scale: 0.5 + r2 * 0.5 });
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
  }

  /**
   * 装上模型网格。树与灌木各一个 InstancedMesh，**每块一次 draw call**。
   * 草皮是一个自定义的交叉双面片，顶点着色器做风摆。
   */
  attachMeshes(treeGeo: BufferGeometry, treeMat: Material | null, bushGeo: BufferGeometry, bushMat: Material | null) {
    this.treeMesh = new InstancedMesh(treeGeo, treeMat ?? defaultVegMaterial(), 1);
    this.bushMesh = new InstancedMesh(bushGeo, bushMat ?? defaultVegMaterial(), 1);
    this.treeMesh.castShadow = true;
    this.treeMesh.receiveShadow = true;
    this.bushMesh.castShadow = true;
    this.bushMesh.receiveShadow = true;
    this.treeMesh.frustumCulled = true;
    this.bushMesh.frustumCulled = true;
    // 树的矩阵每块单独一份（一个 InstancedMesh = 一块），
    // 但用同一个 geometry/material，所以显存不翻倍
    this.groupTrees.clear();
    this.groupBushes.clear();
    this.treeOfChunk = new Array<InstancedMesh | null>(CHUNK_COUNT).fill(null);
    this.bushOfChunk = new Array<InstancedMesh | null>(CHUNK_COUNT).fill(null);
    // 模型的最低点。GLB 里的 accessor min/max 不可信（见 tools/glb-inspect.mjs
    // 的说明：它们被按 int16 写，读出来是垃圾），所以现在从顶点算。
    const treeBottom = bottomOf(treeGeo);
    const bushBottom = bottomOf(bushGeo);
    for (const c of this.chunks) {
      // 树的 p.scale 已经是**绝对**缩放（6~9，取自源项目 SCALE_MIN/MAX），
      // 所以这里不要再乘一个模型缩放——乘两次的话树会变成 48 倍，
      // 而那正是"相机一进世界就埋在树冠里"的量级。
      if (c.tree.length) {
        const m = this.makeInstanced(this.treeMesh, c.tree, 1.0, treeBottom, 'tree');
        this.treeOfChunk[c.index] = m;
        this.groupTrees.add(m);
      }
      if (c.bush.length) {
        const m = this.makeInstanced(this.bushMesh, c.bush, 4.0, bushBottom, 'bush');
        this.bushOfChunk[c.index] = m;
        this.groupBushes.add(m);
      }
    }
  }

  private makeInstanced(
    proto: InstancedMesh,
    placements: Placement[],
    modelScale: number,
    modelBottom: number,
    kind: 'tree' | 'bush',
  ): InstancedMesh {
    const m = new InstancedMesh(proto.geometry, proto.material, placements.length);
    // 名字里带上块号。`?dump=1` 的场景自检要靠它把"画面左边那个黑方块"
    // 对应到具体对象上——没有名字时自检只能报"一个 InstancedMesh"，
    // 等于没有回答问题。名字里也带上落地抬升量：
    // 下次再有人看见"树埋在土里"，一眼就能看出偏移是不是 0。
    m.name = `veg-${kind}-${placements.length}@${groundOffsetFor(modelBottom, modelScale, 1).toFixed(2)}`;
    const mat4 = new Matrix4();
    const q = new Quaternion();
    const pos = new Vector3();
    const scl = new Vector3();
    const up = new Vector3(0, 1, 0);
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      q.setFromAxisAngle(up, p.rotY);
      const s = modelScale * p.scale;
      // 抬升量跟着**这一株**的最终缩放走（见 groundOffsetFor 的说明）
      pos.set(p.x, p.y + groundOffsetFor(modelBottom, modelScale, p.scale), p.z);
      scl.setScalar(s);
      mat4.compose(pos, q, scl);
      m.setMatrixAt(i, mat4);
    }
    m.instanceMatrix.needsUpdate = true;
    m.count = placements.length;
    m.castShadow = proto.castShadow;
    m.receiveShadow = true;
    return m;
  }
  /**
   * 每帧更新可见块。
   *
   * 只有当玩家跨过块边界时才重算可见集——每帧重算是纯粹的浪费。
   * 半径由画质档给，再乘以心神带来的可见系数。
   */
  update(playerX: number, playerZ: number, visibilityFactor: number) {
    // 找到玩家所在的块
    const t = nearestChunkT(playerX, playerZ);
    const cur = clamp(Math.floor(t * CHUNK_COUNT), 0, CHUNK_COUNT - 1);
    if (cur === this.lastChunkIndex) return;
    this.lastChunkIndex = cur;

    // 心神系数**必须真的进半径**。它原来是算了 treeR/bushR 之后
    // 直接 `void` 掉，判定仍用 `preset.*Radius`——于是"心神低→看得更短"
    // 这条在整个游戏里从来没有生效过：灯笼、香囊、遮罩三样都在给一个
    // 没人读的数写账。verify_mood 守的是那条公式本身，守不到这里。
    const treeR = Math.max(this.preset.treeRadius * visibilityFactor, 1);
    const bushR = Math.max(this.preset.bushRadius * visibilityFactor, 1);

    let visibleChunks = 0;
    let treeCount = 0;
    let bushCount = 0;
    let calls = 0;

    for (const c of this.chunks) {
      // 环线是闭合的，索引要绕圈
      let d = Math.abs(c.index - cur);
      d = Math.min(d, CHUNK_COUNT - d);
      const tTree = (d * CHUNK_LEN) / treeR;
      const showTree = tTree <= 1.12;
      const tBush = (d * CHUNK_LEN) / bushR;
      const showBush = tBush <= 1.12;

      const iTree = this.treeOfChunk[c.index];
      const iBush = this.bushOfChunk[c.index];
      if (iTree) iTree.visible = showTree;
      if (iBush) iBush.visible = showBush;

      if (showTree) {
        visibleChunks++;
        treeCount += c.tree.length;
        calls++;
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
    this.lastChunkIndex = -1;
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

function nearestChunkT(x: number, z: number): number {
  let best = 0;
  let bestD = Infinity;
  // 每 4 个点采一次，够用了：块是 12m，960/4=240 个采样点对应约 5m 精度
  for (let i = 0; i < CENTERLINE.length; i += 4) {
    const p = CENTERLINE[i];
    const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best / (CENTERLINE.length - 1);
}
