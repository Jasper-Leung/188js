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
  BufferAttribute,
  MeshStandardMaterial,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  DoubleSide,
  Color,
  Group,
  type Material,
} from 'three';
import { CENTERLINE, TOTAL_ARCLENGTH, type Vec3Flat } from '../data/route';
import { hashGrid } from '../core/noise';
import { clamp } from '../core/math';
import type { Terrain } from './terrain';
import type { QualityPreset } from '../core/settings';
import { patchStandard } from '../shaders/world';

const CHUNK_LEN = 12; // 米，按中心线弧长
const CHUNK_COUNT = Math.ceil(TOTAL_ARCLENGTH / CHUNK_LEN);
/**
 * 株距（沿路弧长，米）。行道树的 25m 直接取自源项目 `TreeScatter.SPACING`。
 * 这个数决定"路看起来通不通透"——它是低配与高配**唯一不该变**的东西：
 * 降档砍的是株数，不是株距。
 */
const TREE_SPACING = 25;
const BUSH_SPACING = 11;
/**
 * 草皮沿路间距（米）。
 *
 * 原来是 2.4m——每两米四一簇，全环 512 簇。这个密度下**草皮等于不存在**：
 * 视野里几十米只有七八簇，读不出"草地"，只会在近处偶尔冒出一两根，
 * 而玩家多半把它当成 bug 而不是草。
 *
 * 0.55m 是"读得出连续草层、又不至于铺成一块绿毯"的值：
 * 全环 2234 簇，按画质档抽稀后每张卡 400~800 个实例。
 * 每簇 4 个三角形，所以 800 簇也只有 3200 个面——
 * **草皮贵在填充率（卡片铺满屏幕），不在面数**，
 * 而这个数比行道树 16m/株×8000 面的开销小一个量级。
 */
const GRASS_SPACING = 0.55;

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
  readonly groupGrass = new Group();

  private chunks: Chunk[] = [];
  private treeMesh: InstancedMesh | null = null;
  private bushMesh: InstancedMesh | null = null;
  private grassMesh: InstancedMesh | null = null;

  private grassUniforms: { uTime: { value: number }; uWindStrength: { value: number } } | null = null;
  private grassAll: { offsets: Float32Array; params: Float32Array; start: Int32Array } | null = null;
  private grassOffAttr: InstanceBufferLike | null = null;
  private grassParAttr: InstanceBufferLike | null = null;
  private lastChunkIndex = -1;
  private windFrame = 0;
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
  stats = { chunksVisible: 0, trees: 0, bushes: 0, grass: 0, drawCalls: 0 };

  constructor(preset: QualityPreset, terrain: Terrain) {
    this.preset = preset;
    this.group.name = 'vegetation';
    this.group.add(this.groupTrees, this.groupBushes, this.groupGrass);
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

    // ---- 行道树：每 TREE_SPACING 米一株，左右错开（STAGGER）----
    const nTree = Math.floor(TOTAL_ARCLENGTH / TREE_SPACING);
    for (let i = 0; i < nTree; i++) {
      // 密度只决定"这一株放不放"，不决定放多远
      if (i % 2 === 1 && this.preset.treeDensity < 0.75) continue;
      if (i % 4 === 2 && this.preset.treeDensity < 0.5) continue;
      const t = (i * TREE_SPACING) / TOTAL_ARCLENGTH;
      const r1 = hashGrid(i, 1, 7717);
      const r2 = hashGrid(i, 2, 3313);
      const r3 = hashGrid(i, 3, 9091);
      const { p, tx, tz } = this.sampleAt(t);
      const side = i % 2 === 0 ? -1 : 1; // 左右错开
      // 11m 是源项目的 SIDE_OFFSET：路面总半宽 6.5m，留 4.5m 给树根与路肩
      const off = 11 + r3 * 1.5;
      const x = p.x + -tz * off * side;
      const z = p.z + tx * off * side;
      const y = terrain.getHeightAt(x, z);
      chunks[chunkAt(x, z)].tree.push({
        x, y, z,
        rotY: r2 * Math.PI * 2,
        scale: 6 + r1 * 3, // 源项目 SCALE_MIN 6 / SCALE_MAX 9
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

    // ---- 草皮：只铺近路的一条带，低档整项关掉 ----
    if (this.preset.grassEnabled) {
      const nGrass = Math.floor(TOTAL_ARCLENGTH / GRASS_SPACING);
      const want = Math.round(nGrass * this.preset.grassDensity);
      let placed = 0;
      for (let i = 0; i < nGrass && placed < want; i++) {
        const r1 = hashGrid(i, 11, 1201);
        const r2 = hashGrid(i, 12, 4409);
        const r3 = hashGrid(i, 13, 9931);
        // 用 r1 做稀疏采样：密度低时不是"均匀变稀"，而是随机跳过，
        // 后者在视觉上更自然（均匀变稀会看出规则的条纹）
        if (r1 > this.preset.grassDensity) continue;
        const t = (i * GRASS_SPACING) / TOTAL_ARCLENGTH;
        const { p, tx, tz } = this.sampleAt(t);
        const side = r2 < 0.5 ? -1 : 1;
        const off = 7.5 + r3 * 12;
        const x = p.x + -tz * off * side;
        const z = p.z + tx * off * side;
        const y = terrain.getHeightAt(x, z);
        chunks[chunkAt(x, z)].grass.push({ x, y, z, rotY: r2 * Math.PI * 2, scale: 0.7 + r3 * 0.8 });
        placed++;
      }
    }
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
    if (this.preset.grassEnabled) this.buildGrass();
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
   * 草皮：**一个** InstancedMesh，动态打包可见实例。
   *
   * 树和灌木用"每块一个 mesh"，草皮不这么做——草皮是密集小几何，
   * 一次 draw call 的收益远大于视锥剔除的收益（它太小，剔掉的三角形本来也不多）。
   * 做法是把可见块的实例**紧凑地填进同一份 buffer 的前段**，
   * 玩家跨过 12m 才重打包一次；`mesh.count` 决定画多少。
   *
   * 注意：实例属性必须是 InstancedBufferAttribute，而且**只有这一份 geometry**。
   * 早先按块各建一份 geometry、共用同一个 BufferGeometry 顶点的写法是错的——
   * `setAttribute` 是往同一个 geometry 上写，第二个块会把第一个块的
   * 偏移量覆盖掉，于是整片草皮长在最后一个块的位置上。
   */
  private buildGrass() {
    const geo = new BufferGeometry();
    const verts = new Float32Array([
      // 十字片 A
      -0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0,
      -0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0,
      // 十字片 B（转 90°）
      0, 0, -0.5, 0, 0, 0.5, 0, 1, 0.5,
      0, 0, -0.5, 0, 1, 0.5, 0, 1, -0.5,
    ]);
    const uvs = new Float32Array([
      0, 0, 1, 0, 1, 1,
      0, 0, 1, 1, 0, 1,
      0, 0, 1, 0, 1, 1,
      0, 0, 1, 1, 0, 1,
    ]);
    geo.setAttribute('position', new BufferAttribute(verts, 3));
    geo.setAttribute('uv', new BufferAttribute(uvs, 2));
    // **必须有 normal 属性。**
    // three 的 `beginnormal_vertex` 写的是 `vec3 objectNormal = vec3(normal);`——
    // 属性不存在时 WebGL 给默认的 (0,0,0)，于是 `vNormal = normalize(vec3(0))` 是 NaN，
    // 阴影那一路的 `inverseTransformDirection(transformedNormal, viewMatrix)` 同样是 NaN。
    // 结果是**通过 alphaTest 的每一个像素都算成黑色**，草皮变成一丛黑刺。
    // 这里的值随后会被顶点着色器按"卡片朝向相机"覆写，
    // 但它必须存在：缺失不是"用默认值"，是整条法线链路变成 NaN。
    geo.computeVertexNormals();

    // 所有块的草皮平铺成一条链，update 时按块号切片挑
    let total = 0;
    for (const c of this.chunks) total += c.grass.length;
    this.grassAll = { offsets: new Float32Array(total * 3), params: new Float32Array(total * 2), start: new Int32Array(CHUNK_COUNT + 1) };
    let k = 0;
    for (let ci = 0; ci < CHUNK_COUNT; ci++) {
      this.grassAll.start[ci] = k;
      for (const p of this.chunks[ci].grass) {
        this.grassAll.offsets[k * 3] = p.x;
        this.grassAll.offsets[k * 3 + 1] = p.y;
        this.grassAll.offsets[k * 3 + 2] = p.z;
        this.grassAll.params[k * 2] = (p.rotY / (Math.PI * 2)) % 1;
        this.grassAll.params[k * 2 + 1] = p.scale;
        k++;
      }
    }
    this.grassAll.start[CHUNK_COUNT] = k;

    const offAttr = new InstancedBufferAttribute(this.grassAll.offsets, 3);
    const parAttr = new InstancedBufferAttribute(this.grassAll.params, 2);
    offAttr.setUsage(DynamicDrawUsage);
    parAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute('aOffset', offAttr);
    geo.setAttribute('aParams', parAttr);
    this.grassOffAttr = offAttr;
    this.grassParAttr = parAttr;

    const mat = new MeshStandardMaterial({
      side: DoubleSide,
      roughness: 0.9,
      metalness: 0,
      // alphaTest 而不是 transparent：透明要排序要混合，
      // 在铺满屏幕的草皮上是核显的噩梦；alphaTest 直接剔像素，最便宜。
      alphaTest: 0.5,
      dithering: true,
    });
    this.grassUniforms = { uTime: { value: 0 }, uWindStrength: { value: 0.22 } };
    patchStandard(mat, {
      vertexHead: /* glsl */ `
        attribute vec3 aOffset;
        attribute vec2 aParams;
        uniform float uTime;
        uniform float uWindStrength;
        varying float vBlade;
        varying vec3 vGrassWorld;
        varying vec2 vUvG;
      `,
      vertexBody: /* glsl */ `
        vUvG = uv;
        vec3 instPos = aOffset;
        // 让卡片朝相机转：不做的话草丛会随视角露出纸片背面
        vec3 toCam = cameraPosition - instPos;
        float yaw = atan(toCam.x, toCam.z);
        float cy = cos(yaw), sy = sin(yaw);
        vec3 local = position;
        vec3 rotated = vec3(local.x * cy + local.z * sy, local.y, -local.x * sy + local.z * cy);
        float h = clamp(local.y, 0.0, 1.0);
        float wind = sin(uTime * 1.6 + aParams.x * 6.283) * uWindStrength * h * h;
        rotated.x += wind * 0.35;
        rotated.z += wind * 0.18;
        rotated.y *= aParams.y;
        vec3 world = instPos + rotated;
        vGrassWorld = world;
        vBlade = h;
        transformed = world;

        // 法线也必须跟着卡片转，而且**要重新算朝向**：
        // 草皮不是"一个有正确法线的物体被旋转了"，它是每帧按相机朝向重建的，
        // 所以几何体里那份法线只保证链路不 NaN，真正用的是下面这个。
        //
        // 取向规则：底部朝相机平躺（接住地面的反光），梢部逐渐朝上
        // （叶尖受太阳直射）。一刀切的"整片朝相机"会让整片草皮是一个亮度，
        // 而亮度渐变正是零贴图下唯一能读出"这是草不是纸板"的信号。
        vec3 flat3 = normalize(vec3(toCam.x, 0.0, toCam.z) + vec3(0.0, 0.0001, 0.0));
        vec3 gN = normalize(mix(flat3, vec3(0.0, 1.0, 0.0), 0.25 + 0.45 * h));
        // transformedNormal 喂阴影，vNormal 喂主光照。两处都要写，
        // 只写 vNormal 的话接阴影的那一路仍然是几何体里那份没转过的法线。
        transformedNormal = gN;
        vNormal = gN;
      `,
      fragmentHead: /* glsl */ `
        varying float vBlade;
        varying vec3 vGrassWorld;
        varying vec2 vUvG;
        uniform vec3 grass_color;
        uniform vec3 grass_dry;
      `,
      fragmentBody: /* glsl */ `
        // 叶形：三根偏转的窄条，末端收尖。程序化出形状而不是采贴图，
        // 卡片就能缩到 4 个顶点两个三角形。
        float blade = 0.0;
        for (int i = 0; i < 3; i++) {
          float fi = float(i);
          float off = (fi - 1.0) * 0.30;
          float bend = (vBlade - vBlade * vBlade * 0.55) * 0.34;
          float cx = vUvG.x + off + bend * (fi - 1.0) * 0.25;
          float halfW = 0.075 * (1.0 - vBlade * 0.92);
          blade = max(blade, 1.0 - smoothstep(halfW * 0.55, halfW, abs(vUvG.x - cx)));
        }
        float gvar = fbm2(vGrassWorld.xz * 1.7 + vBlade * 0.6);
        vec3 ggrass = mix(grass_color, grass_dry, smoothstep(0.35, 0.9, gvar) * 0.55);
        ggrass *= 0.72 + 0.42 * vBlade;   // 根部暗、梢部亮
        float galpha = clamp(blade * 1.25, 0.0, 1.0);
      `,
      colorExpr: /* glsl */ `
        diffuseColor.rgb *= ggrass;
        diffuseColor.a *= galpha;
      `,
    }, {
      ...this.grassUniforms,
      grass_color: { value: new Color(0.3, 0.5, 0.19) },
      grass_dry: { value: new Color(0.52, 0.56, 0.27) },
    });

    const mesh = new InstancedMesh(geo, mat, Math.max(total, 1));
    mesh.name = 'grass';
    const ident = new Matrix4();
    for (let i = 0; i < Math.max(total, 1); i++) mesh.setMatrixAt(i, ident);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.count = 0;
    mesh.castShadow = false; // 草皮不投影：省一整趟 shadow pass
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // 实例在动，包围球算不准，自己管可见性
    this.grassMesh = mesh;
    this.groupGrass.clear();
    this.groupGrass.add(mesh);
  }

  /** 把可见块的草皮紧凑地填进 buffer 前段 */
  private repackGrass(cur: number) {
    if (!this.grassMesh || !this.grassAll || !this.grassOffAttr || !this.grassParAttr) return;
    const g = this.grassAll;
    const cap = g.offsets.length / 3;
    let w = 0;
    // **d === 0 时 cur 只能取一次。**
    // 原来写的是 `[cur + d, cur - d]` 两个下标再 `if (d > 0 && idx === cur) continue`，
    // 于是 d=0 时两个下标都是 cur，判据里的 `d > 0` 不成立，
    // 玩家所在的那一块被塞了两遍——草皮凭空多出一倍实例，
    // 而画面上完全看不出（两簇草长在同一个位置，一个压着一个）。
    for (let d = 0; d <= Math.ceil(this.preset.grassRadius / CHUNK_LEN) + 1; d++) {
      const offsets = d === 0 ? [cur] : [cur + d, cur - d];
      for (const ci of offsets) {
        const idx = ((ci % CHUNK_COUNT) + CHUNK_COUNT) % CHUNK_COUNT;
        if (d > 0 && idx === cur) continue;
        const s = g.start[idx];
        const e = g.start[idx + 1];
        if (w + (e - s) > cap) break;
        g.offsets.copyWithin(w * 3, s * 3, e * 3);
        g.params.copyWithin(w * 2, s * 2, e * 2);
        w += e - s;
      }
    }
    this.grassOffAttr.needsUpdate = true;
    this.grassParAttr.needsUpdate = true;
    this.grassOffAttr.updateRanges = [{ start: 0, count: w * 3 }];
    this.grassMesh.count = w;
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

    // 心神系数**必须真的进半径**。它原来是算了 treeR/bushR/grassR 之后
    // 直接 `void` 掉，判定仍用 `preset.*Radius`——于是"心神低→看得更短"
    // 这条在整个游戏里从来没有生效过：灯笼、香囊、遮罩三样都在给一个
    // 没人读的数写账。verify_mood 守的是那条公式本身，守不到这里。
    const treeR = Math.max(this.preset.treeRadius * visibilityFactor, 1);
    const bushR = Math.max(this.preset.bushRadius * visibilityFactor, 1);
    const grassR = Math.max(this.preset.grassRadius * visibilityFactor, 1);

    let visibleChunks = 0;
    let treeCount = 0;
    let bushCount = 0;
    let grassCount = 0;
    let calls = 0;
    let grassChunks = 0;

    for (const c of this.chunks) {
      // 环线是闭合的，索引要绕圈
      let d = Math.abs(c.index - cur);
      d = Math.min(d, CHUNK_COUNT - d);
      const tTree = (d * CHUNK_LEN) / treeR;
      const showTree = tTree <= 1.12;
      const tBush = (d * CHUNK_LEN) / bushR;
      const showBush = tBush <= 1.12;
      const tGrass = (d * CHUNK_LEN) / grassR;
      const showGrass = this.preset.grassEnabled && tGrass <= 1.12;

      const iTree = this.treeOfChunk[c.index];
      const iBush = this.bushOfChunk[c.index];
      if (iTree) iTree.visible = showTree;
      if (iBush) iBush.visible = showBush;
      if (showGrass) grassChunks++;

      if (showTree) {
        visibleChunks++;
        treeCount += c.tree.length;
        calls++;
      }
      if (showBush) {
        bushCount += c.bush.length;
        calls++;
      }
      if (showGrass) grassCount += c.grass.length;
    }

    this.repackGrass(cur);
    void grassChunks;
    this.stats = { chunksVisible: visibleChunks, trees: treeCount, bushes: bushCount, grass: grassCount, drawCalls: calls };
  }

  /**
   * 风动。低档每 4 帧更新一次 uTime 就够了——
   * 风是缓慢的正弦，30fps 的正弦和 60fps 的正弦在视觉上分不出来，
   * 但 uniform 上传和整片草皮的顶点重算是实打实的 4 倍开销。
   */
  tickWind(time: number) {
    if (!this.grassUniforms) return;
    this.windFrame++;
    if (this.windFrame % this.preset.windInterval !== 0) return;
    this.grassUniforms.uTime.value = time;
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
    this.groupGrass.children.forEach((c) => (c as InstancedMesh).dispose());
  }
}

type InstanceBufferLike = { needsUpdate: boolean; updateRanges: { start: number; count: number }[] };

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
 * 扫不出东西时（几何体没有 position、属性为空）返回 0，
 * 也就是"不抬也不沉"——退化到旧行为，而不是把整片植被抬到天上去。
 */
function bottomOf(geo: BufferGeometry): number {
  const pos = geo.getAttribute('position');
  if (!pos || pos.count === 0) return 0;
  let minY = Infinity;
  for (let i = 1; i < pos.array.length; i += pos.itemSize) {
    const y = pos.array[i];
    if (y < minY) minY = y;
  }
  return Number.isFinite(minY) ? minY : 0;
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
