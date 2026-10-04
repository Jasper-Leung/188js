/**
 * 把「一丛多棵」的 GLB 拆成多棵独立的。
 *
 * ## 为什么需要它
 *
 * `pine+trees+3d+model.glb` 是**一棵网格里排了 6 棵树**（X 方向顶点直方图
 * 有六个清晰的峰）。原本整丛当一个实例摆，于是 6 棵树共用一个 Y——
 * 而整丛宽 26m，地形在这 26m 里起伏明显，结果是**有的悬空、有的半埋**。
 *
 * 拆开之后每棵树是一个独立实例，各自取 `terrain.getHeightAt()`，
 * 悬空从根上消失，顺带还拿到两个好处：
 *
 *   · 株距与株高**解绑**（原来 0.15S 同时决定"多高"和"挨多近"）；
 *   · 可见集按**单株**算，剔除比按丛细。
 *
 * ## 三件事，逐条都有理由
 *
 * 1. **按直方图峰分簇**，不按等距切——等距切会把一棵树从中间劈成两半。
 * 2. **顶点压实**：不压实的话 6 个网格共用同一份 77,694 顶点的 POSITION，
 *    各自只引用约 13%。显存按 6 份算、`bottomOf()` 扫到整排的底面、
 *    包围球按整排算而剔除退化成"这一丛"。压实后三条同时解决。
 * 3. **逐属性重映射**：压实时 NORMAL / TEXCOORD_0 必须跟着走，
 *    漏掉任何一个都会让法线与 UV 错位。
 *
 * ## 输出
 *
 * 同一个 GLB 里放 N 个 mesh（一个树一个），共享同一张贴图，各自带节点。
 * 运行时用 `firstGeometry(root, i)` 取第 i 棵——比拆成 N 个文件少 N−1 次
 * 网络请求，也少 N−1 个解码器实例。
 *
 * 用法：
 *   node tools/split-glb.mjs <源.glb> <输出.glb>      # 命令行
 *   import { splitGlb } from './split-glb.mjs'        # 由 compress-textures 调用
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

/**
 * 按 X 的直方图峰把顶点分成若干簇。
 * @param {number[]} xs
 * @param {number} bins
 * @returns {{ edges: number[]; peaks: number } | null}
 */
export function clusterByX(xs, bins) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of xs) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  const hist = new Float64Array(bins);
  for (const x of xs) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor(((x - lo) / (hi - lo || 1)) * bins)));
    hist[b]++;
  }
  const maxV = Math.max(...hist);
  const peaks = [];
  const minSep = Math.max(2, Math.floor(bins / 14));
  for (let b = 1; b < bins - 1; b++) {
    if (hist[b] < maxV * 0.25) continue; // 树冠之间的空隙不算峰
    if (hist[b] < hist[b - 1] || hist[b] < hist[b + 1]) continue; // 不是局部极大
    if (peaks.length && b - peaks[peaks.length - 1] < minSep) continue;
    peaks.push(b);
  }
  if (peaks.length < 2) return null;
  // 簇边界取相邻两峰之间的谷底
  const edges = [lo];
  for (let i = 0; i < peaks.length - 1; i++) {
    let valley = peaks[i];
    for (let b = peaks[i]; b <= peaks[i + 1]; b++) if (hist[b] < hist[valley]) valley = b;
    edges.push(lo + ((valley + 0.5) / bins) * (hi - lo));
  }
  edges.push(hi);
  return { edges, peaks: peaks.length };
}

/**
 * 就地把一棵多簇的 mesh 拆成 N 个 mesh（各带节点）。
 * @param {import('@gltf-transform/core').Document} doc
 */
export async function splitDoc(doc) {
  const root = doc.getRoot();
  const srcMesh = root.listMeshes()[0];
  if (!srcMesh) throw new Error('源文件没有 mesh');
  const prim = srcMesh.listPrimitives()[0];
  const pos = prim.getAttribute('POSITION');
  if (!pos) throw new Error('第一个 primitive 没有 POSITION');
  // gltf-transform 的 Accessor 没有 getX(getY/getZ)，但 POSITION 是非交错的
  // VEC3 float32，按 3 跨步读底层数组即可（与 three.js 那边不同，那边**不能**这么读）
  const arr = pos.getArray();

  const xs = [];
  for (let i = 0; i < pos.getCount(); i++) xs.push(arr[i * 3]);
  const cl = clusterByX(xs, 40);
  if (!cl) return null;
  const clusterOf = (x) => {
    let k = 0;
    while (k < cl.edges.length - 2 && x >= cl.edges[k + 1]) k++;
    return k;
  };
  const N = cl.edges.length - 1;

  const idx = prim.getIndices();
  const iarr = idx ? idx.getArray() : null;
  const triCount = iarr ? iarr.length / 3 : pos.getCount() / 3;
  const buckets = Array.from({ length: N }, () => []);
  for (let t = 0; t < triCount; t++) {
    const i0 = iarr ? iarr[t * 3] : t * 3;
    const i1 = iarr ? iarr[t * 3 + 1] : t * 3 + 1;
    const i2 = iarr ? iarr[t * 3 + 2] : t * 3 + 2;
    buckets[clusterOf((arr[i0 * 3] + arr[i1 * 3] + arr[i2 * 3]) / 3)].push(i0, i1, i2);
  }
  const kept = buckets.reduce((s, b) => s + b.length / 3, 0);

  // 兄弟属性：压实时必须逐个跟着重映射
  const nAttr = prim.getAttribute('NORMAL');
  const tAttr = prim.getAttribute('TEXCOORD_0');
  const nArr = nAttr ? nAttr.getArray() : null;
  const tArr = tAttr ? tAttr.getArray() : null;
  const nSize = nAttr ? nAttr.getElementSize() : 0;
  const tSize = tAttr ? tAttr.getElementSize() : 0;

  // 原节点的变换要继承（模型坐标不动，只改拓扑）
  const origNode = root.listNodes().find((n) => n.getMesh() === srcMesh) ?? null;
  const nodeT = origNode
    ? { t: origNode.getTranslation(), r: origNode.getRotation(), s: origNode.getScale() }
    : null;
  if (origNode) origNode.dispose();
  // mesh 是靠节点引用的，`root.addMesh()` 并不存在；
  // 没有父节点的节点会被 writer 当作根节点自动收集
  for (const m of root.listMeshes()) m.dispose();

  const info = [];
  buckets.forEach((tri, k) => {
    const remap = new Map();
    const newIdx = new Uint32Array(tri.length);
    const vx = [];
    const vn = [];
    const vt = [];
    let loY = Infinity;
    let hiY = -Infinity;
    for (let i = 0; i < tri.length; i++) {
      const v = tri[i];
      let nv = remap.get(v);
      if (nv === undefined) {
        nv = vx.length / 3;
        remap.set(v, nv);
        const x = arr[v * 3];
        const y = arr[v * 3 + 1];
        vx.push(x, y, arr[v * 3 + 2]);
        if (y < loY) loY = y;
        if (y > hiY) hiY = y;
        if (nAttr) vn.push(nArr[v * nSize], nArr[v * nSize + 1], nArr[v * nSize + 2]);
        if (tAttr) vt.push(tArr[v * tSize], tArr[v * tSize + 1]);
      }
      newIdx[i] = nv;
    }
    const mesh = doc.createMesh(`tree_${k}`);
    const p = doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(vx)))
      .setMaterial(prim.getMaterial());
    if (nAttr) p.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(vn)));
    if (tAttr) {
      p.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(vt)));
    }
    p.setIndices(doc.createAccessor().setType('SCALAR').setArray(newIdx));
    mesh.addPrimitive(p);
    // 真实包围盒写进名字：运行时的探针与调试面板能直接读出来
    mesh.setName(
      `tree_${k}@tris${tri.length / 3}@v${vx.length / 3}@h${(hiY - loY).toFixed(3)}@y${loY.toFixed(3)}`,
    );
    const node = doc.createNode(`tree_${k}`);
    node.setMesh(mesh);
    if (nodeT) {
      node.setTranslation(nodeT.t);
      node.setRotation(nodeT.r);
      node.setScale(nodeT.s);
    }
    // **必须挂到 scene 上。** 「没有父节点」不等于「会被自动收集」——
    // writer 收集的是 **scene 图**里的节点。孤儿节点会被下游的 `prune()`
    // 当成"无人引用的资源"整个删掉，症状是
    // `optimize-assets.mjs` 跑完输出 **0 个三角面、132 字节的空文件**，
    // 而拆分那一步自己看是成功的（6 棵、45,201 面）。
    //
    // （`root.addChild` 不存在，`scene.addChild` 才有：
    //   Root 与 Scene 都继承 GraphNode，但只有 Scene 是「场景」。）
    const scene = root.getDefaultScene() ?? root.listScenes()[0];
    if (scene) scene.addChild(node);
    info.push({ k, tris: tri.length / 3, verts: vx.length / 3, height: hiY - loY, bottom: loY, name: mesh.getName() });
  });

  return { clusters: N, trisIn: triCount, trisOut: kept, dropped: triCount - kept, info };
}

/**
 * 入口：把 src 拆成 dst。
 * @param {string} src
 * @param {string} dst
 */
export async function splitGlb(src, dst) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
  });
  const doc = await io.readBinary(new Uint8Array(readFileSync(src)));
  const res = await splitDoc(doc);
  writeFileSync(dst, Buffer.from(await io.writeBinary(doc)));
  return res;
}

// 直接被 node 跑时才打表；被 compress-textures.mjs `import` 时只当库用。
const isCli =
  process.argv[1] &&
  (process.argv[1].endsWith('split-glb.mjs') || process.argv[1].endsWith('split-glb.mjs'));
if (isCli) {
  const IN = process.argv[2];
  const OUT = process.argv[3];
  if (!IN || !OUT) {
    console.error('用法：node tools/split-glb.mjs <源.glb> <输出.glb>');
    process.exit(1);
  }
  splitGlb(IN, OUT)
    .then((r) => {
      if (!r) {
        console.log('  只找到 1 个峰，按"不拆"处理');
        return;
      }
      console.log(`  ${IN}`);
      console.log(`  分成 ${r.clusters} 簇，三角面 ${r.trisIn} → ${r.trisOut}（丢弃 ${r.dropped} 个跨界三角形）`);
      for (const i of r.info) console.log(`    ${i.name}`);
      console.log(`  → ${OUT}  ${(readFileSync(OUT).length / 1024 / 1024).toFixed(2)}MB`);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
