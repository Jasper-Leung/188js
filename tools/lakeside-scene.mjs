/**
 * 湖边场景 · 阶段 A（调度）：Marble HQ 贴图版 → 本项目能用的 `public/models/lakeside.glb`。
 *
 * ── 为什么单独一个工具，而不是往 `optimize-assets.mjs` 里加一条 ──
 * 那条管线的输入是 `.cache/tex` 里的一批模型，走「贴图降采样 → weld → simplify → meshopt」。
 * 本文件多出三件它不做的事：
 *   1. **裁剪**。HQ mesh 是 1022×1493 m、峰顶 509 m 的整条山谷，而本项目全世界只有
 *      800×800 m、`TERRAIN.MAX_HEIGHT = 25 m`。不裁就没有"湖边"可言。
 *   2. **烘顶点色**。见下面的两进程约束。
 *   3. **保留 unlit**。HQ 材质是 `KHR_materials_unlit`——图集里的颜色
 *      **已经是打好光的最终色**。喂给 `MeshStandardMaterial` 再被本项目的太阳照一次，
 *      等于照两遍，整个场景偏暗发灰。默认**保留 unlit**，让 `GLTFLoader`
 *      生成 `MeshBasicMaterial` 直接显示烘出来的颜色：零光照开销（低配优先），
 *      颜色也正好是用户在 Marble 里挑这个世界时看到的那一份。
 *      `--lit` 可以反过来拆掉它，代价是接受二次着色。
 *
 * ── ⚠ 两进程硬约束 ──
 * `node_modules/ndarray-pixels/node_modules/sharp@0.35.5` 是坏的。它一被 require
 * 就把顶层那个能用的 `sharp@0.33.5` 一起弄坏，症状是 `sharp is not a function`，
 * 而 `npm ls sharp` 看着一切正常。所以：**读图集在子进程里跑，
 * 本文件只碰 `@gltf-transform`**——而且 import 放在子进程之后，
 * 与 `tripo-station.mjs` 同一形状。
 *
 * ── 用法 ──
 *   node tools/lakeside-scene.mjs --report              # 只量不改
 *   node tools/lakeside-scene.mjs                       # 用默认裁剪框烘到 public/models/
 *   node tools/lakeside-scene.mjs --crop -414,-220,360   # x0,z0,边长（米，世界坐标）
 *   node tools/lakeside-scene.mjs --ratio 0.5 --error 0.0003
 *   node tools/lakeside-scene.mjs --lit                 # 拆 unlit，接受二次着色
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE = join(ROOT, '.cache', 'lakeside');
const OUT = join(ROOT, 'public', 'models', 'lakeside.glb');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};

/**
 * 默认裁剪框：`x0,z0,边长`，单位米，世界坐标。
 *
 * **这三个数是量出来的，不是拍的**（`.cache/glb-crop.mjs` 跑 150m 密度网格）：
 * 整片场地的形心密度峰值和湖盆（hmin ≈ −50 ~ −71 m 那片低洼）都落在
 * X ≈ −234、Z ≈ −40 附近，**而不是**几何中心（−173, −120）。
 * 按几何中心取框会切掉一半湖面、留下大半山体。
 * 360 m 见方对「站在岸边钓鱼看风景」是合适的尺度，且 1:1 保留真实尺寸，
 * 人在湖边的比例才对——缩放会把山压成缓坡，而本项目最不缺的就是缓坡。
 */
const CROP = opt('crop', '-414,-220,360').split(',').map(Number);
const RATIO = Number(opt('ratio', '0.5'));
const ERROR = Number(opt('error', '0.0003'));
const WELD_TOL = Number(opt('weld-tolerance', '0'));
const ATLAS_SIZE = Number(opt('atlas', '4096'));
const LIT = flag('lit');
const DOUBLE_SIDE = flag('double-side');
const REPORT_ONLY = flag('report');

const SRC = opt('src', process.env.GIFT188_SRC_LAKESIDE);
if (!SRC || !existsSync(SRC)) {
  console.error('[lakeside] 找不到源 GLB。指定 --src <路径> 或设 GIFT188_SRC_LAKESIDE。');
  console.error('           注意：Marble 的 HQ mesh 有 100~200MB，不进版本库。');
  process.exit(1);
}

/**
 * 简化误差的单位是**包围盒对角线的比例**。
 * 裁剪后的包围盒对角线约 780 m，所以这里 error 0.0003 ≈ **0.23 m**。
 *
 * ⚠ **别照抄地标档的 `error: 0.0025`。** 那些模型包围盒只有 5~15 m，
 * 同样的数字才 2 cm；放到这个 360m 见方的地形上是 2 m —— 玩家站在 2m 内看地面，
 * 地面起伏比膝盖还大。这是把地标的参数搬到大地形上最容易踩的坑。
 */
console.log(`[lakeside] 源 ${SRC}`);
console.log(`[lakeside] 裁剪 x0=${CROP[0]} z0=${CROP[1]} 边长=${CROP[2]} m | ratio=${RATIO} error=${ERROR}`
  + ` | ${LIT ? '拆 unlit（会二次着色）' : '保留 unlit'} | 图集 ${ATLAS_SIZE}²`);

// ───────────────────────── 阶段 B：图集 → 顶点色（子进程） ─────────────────────────
mkdirSync(CACHE, { recursive: true });

// 下面才开始 import gltf-transform —— 见文件头的两进程说明。
const { NodeIO } = await import('@gltf-transform/core');
const { KHRDracoMeshCompression, EXTMeshoptCompression, KHRMaterialsUnlit } = await import('@gltf-transform/extensions');
const { weld, simplify, prune, dedup, meshopt, transformPrimitive, flatten } = await import('@gltf-transform/functions');
const { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } = await import('meshoptimizer');

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;

const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression, EXTMeshoptCompression, KHRMaterialsUnlit])
  .registerDependencies({
    'meshopt.encoder': MeshoptEncoder,
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.simplifier': MeshoptSimplifier,
  });

console.log('[lakeside] 读入 …');
const doc = await io.read(SRC);
const root = doc.getRoot();

// simplify 是黑盒：`MeshoptSimplifier.simplify()` 原样返回入参时，
// gltf-transform 既不警告也不报错，只是在 `logger.debug` 里报一行。
// 那行是唯一的诊断信号，所以排查收面问题时需要 --debug。
if (flag('debug')) {
  const { Logger, Verbosity } = await import('@gltf-transform/core');
  doc.setLogger(new Logger(Verbosity.DEBUG));
}

const prim = root.listMeshes()[0].listPrimitives()[0];

/** 属性在整条管线上会被好几个 transform 动过，而丢失是静默的。每一步都报一次。 */
const logSemantics = (label) => console.log(`[lakeside] ${label}: ${prim.listSemantics().join(' ') || '(空)'}`);

/**
 * accessor 的分量数组统一读成 float。
 *
 * 不能直接拿 `getArray()` 的返回值当米读：**simplify 之后 POSITION 可能被
 * 重新量化成 Uint16**，而 `getArray()` 给回的是原始整数（0~65535），
 * 量出来会是一个 65534m 宽的湖。`verify_station_models` 里那条注释记的
 * 是同一件事的另一个版本——那里要解 meshopt，这里要过一遍分量类型。
 */
const toFloat = (acc) => {
  const a = acc.getArray();
  if (a instanceof Float32Array) return a;
  const n = acc.getCount() * acc.getType().length;
  const out = new Float32Array(n);
  if (a instanceof Uint16Array) for (let i = 0; i < n; i++) out[i] = a[i] / 65535;
  else if (a instanceof Uint8Array) for (let i = 0; i < n; i++) out[i] = a[i] / 255;
  else for (let i = 0; i < n; i++) out[i] = a[i];
  return out;
};

const bbox = (p) => {
  const a = toFloat(p.getAttribute('POSITION'));
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) {
    const v = a[i + k];
    if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v;
  }
  return { lo, hi, size: [0, 1, 2].map((k) => hi[k] - lo[k]) };
};

/**
 * **`flatten()` 和 `transformPrimitive()` 必须成对使用，少一步就全错。**
 *
 * 单独用 `flatten()`：它只把挂了 mesh 的节点重新挂到场景根上，
 * **变换仍留在节点里、顶点一个字节都不动**。裁剪框于是按局部坐标算，
 * 切出来的成品包围盒 54.7 × 206.7 × 83.5 m、起点 (-105.8, -96.7, -9.8)。
 *
 * 单独用 `transformPrimitive`：这份 GLB 的父节点叫 `Scene`，带着 6.4629 的
 * 缩放和 [0, 4.54, 0] 的平移。只复位挂 mesh 的那个叶子节点，父节点照样生效，
 * 于是**缩放被算两次**。实测后果：meshopt 量化时 Int16 直接饱和到 ±32767，
 * 读回来包围盒对称成 ±128、位置里带 NaN，而所有断言都还"绿"——
 * 因为它们量的不是这个文件。
 *
 * 正解：`flatten()` 先把 mesh 提到场景根（世界变换被保留在它自己身上，
 * 此时它不再有父节点），再 `transformPrimitive(prim, node.getWorldMatrix())`
 * 把世界变换烘进顶点，最后把节点复位成单位变换。
 *
 * 另外两点：
 *   · `transformPrimitive(prim, matrix)` **没有 document 参数**，matrix 直接吃
 *     列主序 Float32Array（`Node.getWorldMatrix()` 正是这个格式），
 *     而且法线走逆转置——这份数据带 6.4629 的非等比缩放，法线直接乘同一个
 *     矩阵是错的。它自己会判 `determinant < 0` 就翻转绕序；这里行列式是 +270。
 *   · 设 TRS 本身就会把节点从 matrix 模式切出来。**不要调 `setMatrix(null)`**——
 *     4.5.1 里它会拿 null 去 `MathUtils.decompose` 解矩阵，直接抛
 *     `Cannot read properties of null (reading '0')`。
 */
await doc.transform(flatten());
const meshNode = root.listNodes().find((n) => n.getMesh() != null);
if (!meshNode) {
  console.error('[lakeside] 找不到挂着 mesh 的节点');
  process.exit(1);
}
const parentName = meshNode.getParentNode()?.getName() ?? '(无父节点)';
if (parentName !== '(无父节点)') {
  console.error(`[lakeside] flatten 后 mesh 节点仍有父节点 ${parentName} —— 变换会算两次，停下。`);
  process.exit(1);
}
transformPrimitive(prim, meshNode.getWorldMatrix());
meshNode.setTranslation([0, 0, 0]);
meshNode.setRotation([0, 0, 0, 1]);
meshNode.setScale([1, 1, 1]);

const before = bbox(prim);
console.log(`[lakeside] 变换烘入后包围盒 ${before.size.map((v) => v.toFixed(1)).join(' × ')} m `
  + `| min ${before.lo.map((v) => v.toFixed(1)).join(', ')} | ${prim.getIndices().getCount() / 3} 面 | ${prim.getAttribute('POSITION').getCount()} 顶点`);
if (before.size[1] < 100) {
  console.error('[lakeside] 竖直方向不到 100m —— 节点变换多半没烘进去，停下。');
  process.exit(1);
}

// ── 烘顶点色 ──
// ⚠ REPORT 模式跳过，省掉 86MB 图集的一次解码。
if (!REPORT_ONLY) {
  const tex = prim.getMaterial().getBaseColorTexture();
  if (!tex) {
    console.error('[lakeside] 材质上没有 baseColorTexture —— 这是顶点色版，不用烘色。');
    console.error('           直接放进 public/models/ 跑 assets:geo 即可。');
    process.exit(1);
  }
  const png = join(CACHE, 'atlas.png');
  const uvBin = join(CACHE, 'uv.bin');
  const colBin = join(CACHE, 'col.bin');
  writeFileSync(png, Buffer.from(tex.getImage()));
  writeFileSync(uvBin, Buffer.from(new Float32Array(toFloat(prim.getAttribute('TEXCOORD_0'))).buffer));

  // 阶段 B：sharp 只在这个子进程里被加载。
  execFileSync(process.execPath,
    [join(__dirname, 'lakeside-color.mjs'), png, uvBin, colBin, String(ATLAS_SIZE)],
    { stdio: 'inherit' });

  const col = new Uint8Array(readFileSync(colBin).buffer);
  const nVerts = prim.getAttribute('POSITION').getCount();
  if (col.length !== nVerts * 4) {
    console.error(`[lakeside] 顶点色长度对不上：${col.length} vs ${nVerts * 4}`);
    process.exit(1);
  }
  prim.setAttribute('COLOR_0',
    doc.createAccessor().setType('VEC4').setArray(col).setNormalized(true));
  // 零贴图是一等约束：烘完就把图集整个扔掉，别留 86MB 在包里。
  prim.setAttribute('TEXCOORD_0', null);
  prim.getMaterial().setBaseColorTexture(null);
  for (const t of root.listTextures()) t.dispose();
  console.log('[lakeside] 顶点色烘完，贴图已丢弃');
}

/**
 * ── 摘掉 NORMAL，然后 weld，然后重算法线 ──
 *
 * 这一段是**整个工具能不能收面**的关键，实测踩过：
 * Marble 的 HQ mesh 是 1,768,479 顶点 / 589,800 面 = **3.0007 顶点每面**，
 * 也就是完全展开、**没有任何一对顶点是重复的**。简化器塌缩的是共享边；
 * 没有共享边，`simplify()` 会在 0.0 秒里原样返回——实测确实 197,135 → 197,135。
 *
 * 而 `weld()` 默认按**全部属性**匹配，所以光调用它也没用：相邻三角形的
 * 位置一样、法线不一样（平滑着色的逐角插值），按全属性依然合并不了。
 * 解法是先把 NORMAL 摘掉，让 weld 只按 `POSITION + COLOR_0` 匹配——
 * 展开出来的重复顶点位置相同、UV 相同，烘出来的颜色自然也相同，
 * 于是正好合并的就是该合并的那些。合并完再按面积加权重算平滑法线。
 *
 * （REPORT 模式下没有 COLOR_0，weld 只按 POSITION 匹配，效果一样。）
 *
 * **tolerance 必须 > 0，这一点是实测出来的。** `tolerance: 0` 要求位置逐位相等，
 * 而这份数据里那些"重复"顶点是重建 + 抽取时产生的浮点级差异，并不同值——
 * 所以逐位 weld 只合并了 57%（1,768,479 → 767,280），剩下的近重合点照样堵着
 * 简化器。实测收面的天花板是 **170,080 面**，而且把 error 放到 4 米、
 * ratio 压到 0.15 都纹丝不动——限制完全在拓扑上，不在误差预算上。
 */
prim.setAttribute('NORMAL', null);
logSemantics('weld 前');
const preWeld = { tris: prim.getIndices().getCount() / 3, verts: prim.getAttribute('POSITION').getCount() };
// ⚠ **`doc.transform()` 必须 await。**
// `document.transform()` 返回 Promise，而它的回调体只保证**同步执行到第一个 await**：
// `weld` 的体是同步的，所以不 await 也能"看起来生效"；`simplify` 内部有
// `await simplifier.ready`，不 await 就等于在它开跑之前就去量结果，
// 拿到的是**上一帧的状态**。实测症状是 `simplify 197,135 → 197,135 (0.0s)`
// 外加一行 DEBUG 日志都没有——而这一轮 `--report` 紧接着 `process.exit(0)`，
// 把还挂在微任务队列里的简化器直接杀了。
// 这种"命令成功、文件该变没变"的绿灯比红灯贵得多。
await doc.transform(weld({ tolerance: WELD_TOL }));
const postWeld = { tris: prim.getIndices().getCount() / 3, verts: prim.getAttribute('POSITION').getCount() };
console.log(`[lakeside] weld ${preWeld.tris.toLocaleString()} 面 / ${preWeld.verts.toLocaleString()} 顶点 `
  + `→ ${postWeld.tris.toLocaleString()} 面 / ${postWeld.verts.toLocaleString()} 顶点`);

logSemantics('weld 后');

// ── 裁剪 + 顶点压缩 ──
// gltf-transform 4.5.1 没有 `compact()`（实测 `typeof compact === 'undefined'`），
// 也没有 `Accessor.toFloat32Array()`，所以这一步自己写：
// 按三角形形心筛索引，再按"被引用的顺序"重建顶点数组。
// 不做这一步的话，被裁掉那 4/5 的面会带着顶点一起留在文件里，
// 而 `meshopt` 不会替你删。
//
// ⚠ 这一段**只搬 POSITION / COLOR_0 / indices，法线一概不碰**。
// 法线改到 simplify 之后重算，原因有二：
//   · `simplify()` 内部只把位置和索引喂给 meshoptimizer
//     （`simplifier.simplify(indices, positions, 3, …)`），法线不参与拓扑运算，
//     所以它完全没必要活着穿过 prune/dedup；
//   · 活着的代价很实在：实测法线在 `await doc.transform(prune(), dedup())`
//     之后**被静默删掉**（属性从 `POSITION NORMAL COLOR_0` 变成
//     `POSITION COLOR_0`）。在 simplify 之后重算，既躲开了这条坑，
//     也更正确——法线本来就应该在最终拓扑上算，而不是在简化前那张 1.17 万面的网格上。
const [cx, cz, cSize] = CROP;
const x1 = cx + cSize, z1 = cz + cSize;
const posA = toFloat(prim.getAttribute('POSITION'));
const colAcc = prim.getAttribute('COLOR_0');
const colA = colAcc ? colAcc.getArray() : null;
const idxA = prim.getIndices().getArray();

const remap = new Int32Array(posA.length / 3).fill(-1);
const keptIdx = [];
let v = 0;
for (let t = 0; t + 2 < idxA.length; t += 3) {
  const a = idxA[t] * 3, b = idxA[t + 1] * 3, c = idxA[t + 2] * 3;
  const mx = (posA[a] + posA[b] + posA[c]) / 3;
  const mz = (posA[a + 2] + posA[b + 2] + posA[c + 2]) / 3;
  if (mx < cx || mx > x1 || mz < cz || mz > z1) continue;
  for (const vi of [a / 3, b / 3, c / 3]) {
    if (remap[vi] < 0) remap[vi] = v++;
    keptIdx.push(remap[vi]);
  }
}
const keptTris = keptIdx.length / 3;
console.log(`[lakeside] 裁剪后 ${keptTris.toLocaleString()} / ${idxA.length / 3} 面 `
  + `(${(keptTris / (idxA.length / 3) * 100).toFixed(1)}%)，顶点 ${v.toLocaleString()} / ${posA.length / 3}`);

/**
 * ⚠ **写进 `remap[i]` 指定的槽位，不是"下一个空槽"。**
 *
 * `remap[]` 是按**首次被引用**的顺序分配的，而顶点数组是按 `i` 递增遍历的——
 * 这两个顺序不一样。把数据写到 `o++` 而索引写的是 `remap[vi]`，
 * 于是顶点整体错位，三角形被连成横跨几百米的碎片。
 *
 * 实测症状极具欺骗性：**所有数字都对**——面数、包围盒、顶点色全都没变
 * （同一个点集，只是索引乱了），所有几何断言都绿，而网格完全是垃圾。
 * 是渲染出来才看出来的。
 */
const pack = (src, comps) => {
  const out = new Float32Array(v * comps);
  for (let i = 0; i < remap.length; i++) {
    const r = remap[i];
    if (r < 0) continue;
    for (let k = 0; k < comps; k++) out[r * comps + k] = src[i * comps + k];
  }
  return out;
};
prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pack(posA, 3)));
if (colA) {
  const out = new Uint8Array(v * 4);
  for (let i = 0; i < remap.length; i++) {
    const r = remap[i];
    if (r < 0) continue;
    for (let k = 0; k < 4; k++) out[r * 4 + k] = colA[i * 4 + k];
  }
  prim.setAttribute('COLOR_0', doc.createAccessor().setType('VEC4').setArray(out).setNormalized(true));
}
prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from(keptIdx)));

logSemantics('裁剪后 / 收面前');
// ── 收面 ──
await doc.transform(prune(), dedup());
logSemantics('prune+dedup 后 / simplify 前');
const beforeSimplify = prim.getIndices().getCount() / 3;

const t0 = Date.now();
await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: RATIO, error: ERROR }));
const afterSimplify = prim.getIndices().getCount() / 3;
console.log(`[lakeside] simplify ${beforeSimplify.toLocaleString()} → ${afterSimplify.toLocaleString()} 面 `
  + `(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
if (afterSimplify === beforeSimplify && RATIO < 1) {
  console.error('[lakeside] simplify 一个面都没减 —— 检查 weld 是否真的合并了顶点。');
  process.exit(1);
}

// ── 最后才算平滑法线 ──
// 面积加权：叉积长度 = 2×面积，所以直接拿叉积当权重就是面积加权。
// 必须在 simplify 之后——简化会改拓扑，在简化前的网格上平均等于白算。
{
  const pos = toFloat(prim.getAttribute('POSITION'));
  const idx = prim.getIndices().getArray();
  const n = prim.getAttribute('POSITION').getCount();
  const acc = new Float32Array(n * 3);
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    acc[a] += nx; acc[a + 1] += ny; acc[a + 2] += nz;
    acc[b] += nx; acc[b + 1] += ny; acc[b + 2] += nz;
    acc[c] += nx; acc[c + 1] += ny; acc[c + 2] += nz;
  }
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]);
    if (l > 1e-12) { acc[i * 3] /= l; acc[i * 3 + 1] /= l; acc[i * 3 + 2] /= l; }
    else { acc[i * 3] = 0; acc[i * 3 + 1] = 1; acc[i * 3 + 2] = 0; }
  }
  prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(acc));
}

// DoubleSide 在大地形上是实打实的双份片元开销，而玩家永远在上方。
if (!DOUBLE_SIDE) for (const m of root.listMaterials()) m.setDoubleSided(false);
/**
 * unlit 的去留见文件头。默认**不动**——源材质本来就带着 `KHR_materials_unlit`，
 * `GLTFLoader` 会据此生成 `MeshBasicMaterial`，零光照开销，颜色即烘出来的颜色。
 * `--lit` 才拆掉它，换来进游戏光照周期、代价是二次着色。
 */
if (LIT) {
  for (const m of root.listMaterials()) m.setExtension('KHR_materials_unlit', null);
  console.log('[lakeside] 已拆 unlit —— 顶点色会再被本项目的太阳照一次，注意是否偏暗');
}

const after = bbox(prim);

// ── 收尾硬门 ──
// 这一段不是走过场。第一版产物就栽在"命令成功、文件坏掉"上：
// 包围盒对称成 ±128、位置里有 NaN、NORMAL 没了，而工具一路打印成功。
// 每一条都在这里变成**响亮的失败**。
const semantics = prim.listSemantics();
console.log(`[lakeside] 属性 ${semantics.join(' ')}`);
if (!semantics.includes('NORMAL')) {
  console.error('[lakeside] 产物丢了 NORMAL —— 平滑光照就没了（unlit 时看不出来，--lit 会立刻穿帮）。');
  process.exit(1);
}
if (!semantics.includes('COLOR_0')) {
  console.error('[lakeside] 产物丢了 COLOR_0 —— 零贴图是一等约束，丢了就退成一块单色体积。');
  process.exit(1);
}
{
  const P = toFloat(prim.getAttribute('POSITION'));
  let bad = 0;
  for (let i = 0; i < P.length; i++) if (!Number.isFinite(P[i])) bad++;
  if (bad) {
    console.error(`[lakeside] 产物位置里有 ${bad} 个非有限值（NaN/Inf）—— 多半是 meshopt 量化时 Int16 饱和。`);
    process.exit(1);
  }
}

/**
 * 边长分布不许失控 —— 用**分位数**而不是最大值。
 *
 * **这一条是为一个真实事故加的，而它抓的正是那种「所有数字都绿」的 bug。**
 * 顶点压缩时把数据写进了递增槽位、而索引用的是 `remap[]`——
 * 两者顺序不同，于是顶点整体错位，三角形被连成横跨几百米的碎片。
 * 症状是**面数对、包围盒对、顶点色对、非有限值为零**，所有已有断言全绿，
 * 而网格完全是垃圾。治它的那条证据也很干净：`simplify()` 从"几乎减不动"
 * 变成"正好减一半"——简化器在乱索引上根本无从下手。
 *
 * ## 为什么是 p99 而不是 max
 *
 * 裁剪框边界上的三角形有一条边横穿整个框是**正常的**（按形心选面，
 * 边界处切得很任意），所以最大值对少数离群点太敏感，第一版就误报过一次
 * （53.9m vs 47.3m 上限）。
 * 而错位是**系统性的**：索引随机化会让绝大多数三角形都变成巨大碎片。
 * 所以用 p99 量"普遍程度"，再用一条宽松的 max 兜底量"灾难程度"。
 */
{
  const P = toFloat(prim.getAttribute('POSITION'));
  const idx = prim.getIndices().getArray();
  const bb = bbox(prim);
  const horiz = Math.min(bb.size[0], bb.size[2]);
  const edges = [];
  for (let t = 0; t + 2 < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e] * 3, b = idx[t + ((e + 1) % 3)] * 3;
      edges.push(Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]));
    }
  }
  edges.sort((a, b) => a - b);
  const q = (f) => edges[Math.floor(f * (edges.length - 1))];
  const p50 = q(0.5), p99 = q(0.99), max = edges[edges.length - 1];
  console.log(`[lakeside] 边长 p50 ${p50.toFixed(2)}m · p99 ${p99.toFixed(1)}m · max ${max.toFixed(1)}m `
    + `（水平包围盒 ${horiz.toFixed(0)}m）`);
  if (p99 > horiz * 0.15) {
    console.error(`[lakeside] 99% 的边长超过水平包围盒的 15%（${p99.toFixed(1)}m > ${(horiz * 0.15).toFixed(1)}m）`
      + ' —— 顶点数组和索引错位了。');
    process.exit(1);
  }
  if (max > horiz * 0.6) {
    console.error(`[lakeside] 最长边 ${max.toFixed(1)}m 超过水平包围盒的 60% —— 网格里有横跨整块的碎片。`);
    process.exit(1);
  }
}
console.log(`[lakeside] 成品包围盒 ${after.size.map((x) => x.toFixed(1)).join(' × ')} m `
  + `| min ${after.lo.map((x) => x.toFixed(1)).join(', ')}`);
console.log(`[lakeside] 顶点色 ${prim.getAttribute('COLOR_0') ? '在' : '不在'} | `
  + `贴图 ${root.listTextures().length} 张 | 面 ${afterSimplify.toLocaleString()} | `
  + `顶点 ${prim.getAttribute('POSITION').getCount().toLocaleString()} | `
  + `着色 ${LIT ? 'MeshStandard（会二次着色）' : 'MeshBasic(unlit)'}`);

if (REPORT_ONLY) {
  console.log('[lakeside] --report：没有写任何文件。');
  process.exit(0);
}

/**
 * `--preview`：额外写一份**未压缩**的副本到 `.cache/lakeside/preview.glb`。
 *
 * ⚠ **必须在 `meshopt()` 之前写。** 写完之后再写一份"预览"，拿到的仍然是
 * 压缩过的文件——POSITION 是 16 位定点压在 EXT_meshopt buffer 里的，
 * 任何裸解 GLB 的小工具读它都会直接越界（实测 `ERR_OUT_OF_RANGE`），
 * 而文件本身完全正常。初版就踩了这个顺序坑。
 *
 * 存在的理由是**看得见**：产物过了 meshopt 之后，真实坐标只在节点变换里，
 * 裸读拿到的是 ±1 的归一化值。想看一眼成品长什么样，就得有一份不压缩的。
 *
 * 它写的是 `.cache/` 而不是 `public/models/`：给眼睛看的中间产物，不该跟版本库走。
 */
if (flag('preview')) {
  const previewPath = join(CACHE, 'preview.glb');
  await io.write(previewPath, doc);
  console.log(`[lakeside] 预览（未压缩，写在 meshopt 之前）→ ${previewPath} `
    + `(${(readFileSync(previewPath).length / 1048576).toFixed(2)} MB)`);
}

await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));

mkdirSync(dirname(OUT), { recursive: true });
await io.write(OUT, doc);
console.log(`[lakeside] → ${OUT} (${(readFileSync(OUT).length / 1048576).toFixed(2)} MB)`);
