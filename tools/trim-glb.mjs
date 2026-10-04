/**
 * 裁掉模型底部 ——「埋进地里的那段反正看不见」。
 *
 * ## 为什么需要它
 *
 * 竹子（`bamboo+stalks+3d+model.glb`）整株插进地里当竹丛用，
 * 但**地下的那一截永远看不见**。它不是"少画一点"的问题——
 * 它是实打实每帧都在算的面：3~4m 高的竹丛，地下的 1.5m 就是 40% 的三角面。
 *
 * 裁掉之后省下的预算直接换成**数量**：34 丛变 70+ 丛，
 * 而单丛更便宜。密度是玩家看得见的，地下那一截不是。
 *
 * ## 裁多少：按**归一化高度的比例**，不是绝对米数
 *
 * 同一个比例套到不同高度的模型上才对：
 * 摆的时候缩放会变，所以"裁掉 0.4 个模型高度"在任何缩放下都是同一段。
 *
 * ## 顺带把底面对齐到 0
 *
 * 裁完最低点不再是 0（原来 0.0），而 `bottomOf()` 会读到新的最小值并据此抬升，
 * 所以"裁掉一截"不会让整丛悬空——反而正好抵消埋地深度。
 *
 * 用法：
 *   node tools/trim-glb.mjs <源.glb> <输出.glb> <裁掉的高度比例 0..1>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

/** 裁掉底部。返回统计。 */
export async function trimGlb(src, dst, cut) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
  });
  const doc = await io.readBinary(new Uint8Array(readFileSync(src)));
  const root = doc.getRoot();

  let trisIn = 0;
  let trisOut = 0;
  let meshes = 0;

  for (const mesh of root.listMeshes()) {
    mesh.listPrimitives().forEach((prim) => {
      const pos = prim.getAttribute('POSITION');
      const idx = prim.getIndices();
      if (!pos) return;
      const arr = pos.getArray();
      const n = pos.getCount();
      const iarr = idx ? idx.getArray() : null;
      const triCount = iarr ? iarr.length / 3 : n / 3;
      trisIn += triCount;
      meshes++;

      // 高度范围
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < n; i++) {
        const y = arr[i * 3 + 1];
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
      const span = hi - lo;
      const threshold = lo + span * cut;

      // 顶点压实：只留被保留三角形用到的
      const keep = [];
      for (let t = 0; t < triCount; t++) {
        const a = iarr ? iarr[t * 3] : t * 3;
        const b = iarr ? iarr[t * 3 + 1] : t * 3 + 1;
        const c = iarr ? iarr[t * 3 + 2] : t * 3 + 2;
        // 用三角形的**最高点**判：只要有一根枝条露在地上，这个三角形就得留。
        // 用平均或最低点都会把探出地面的那一截切掉。
        const top = Math.max(arr[a * 3 + 1], arr[b * 3 + 1], arr[c * 3 + 1]);
        if (top >= threshold) keep.push(a, b, c);
      }
      trisOut += keep.length / 3;
      if (!keep.length) return; // 这个 primitive 全在地底下

      const remap = new Map();
      const newIdx = new Uint32Array(keep.length);
      const vx = [];
      const nAttr = prim.getAttribute('NORMAL');
      const tAttr = prim.getAttribute('TEXCOORD_0');
      const vn = [];
      const vt = [];
      const nArr = nAttr ? nAttr.getArray() : null;
      const tArr = tAttr ? tAttr.getArray() : null;
      const nSize = nAttr ? nAttr.getElementSize() : 0;
      const tSize = tAttr ? tAttr.getElementSize() : 0;
      for (let i = 0; i < keep.length; i++) {
        const v = keep[i];
        let nv = remap.get(v);
        if (nv === undefined) {
          nv = vx.length / 3;
          remap.set(v, nv);
          vx.push(arr[v * 3], arr[v * 3 + 1], arr[v * 3 + 2]);
          if (nAttr) vn.push(nArr[v * nSize], nArr[v * nSize + 1], nArr[v * nSize + 2]);
          if (tAttr) vt.push(tArr[v * tSize], tArr[v * tSize + 1]);
        }
        newIdx[i] = nv;
      }
      prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(vx)));
      if (nAttr) {
        prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(vn)));
      }
      if (tAttr) {
        prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(vt)));
      }
      prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(newIdx));
    });
  }

  writeFileSync(dst, Buffer.from(await io.writeBinary(doc)));
  return { trisIn, trisOut, meshes };
}

// 直接被 node 跑时才打表；被 compress-textures.mjs `import` 时只当库用。
//
// **判据必须用 pathToFileURL 比，不能用 `endsWith('trim-glb.mjs')`**：
// 后者在被 import 时也会为真（`process.argv[1]` 是入口脚本的路径，
// 但一旦这个判断写错，表现是"一 import 就打印用法然后 process.exit(1)"，
// 把调用方的整条管道掐死）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const IN = process.argv[2];
  const OUT = process.argv[3];
  const CUT = Number(process.argv[4] ?? 0.35);
  if (!IN || !OUT) {
    console.error('用法：node tools/trim-glb.mjs <源.glb> <输出.glb> <比例>');
    process.exit(1);
  }
  if (!(CUT > 0 && CUT < 0.95)) {
    console.error(`比例要在 0~1 之间（给的是 ${CUT}）。裁掉 95% 以上会把模型裁没了。`);
    process.exit(1);
  }
  trimGlb(IN, OUT, CUT)
    .then((r) => {
      const pct = r.trisIn ? Math.round((r.trisOut / r.trisIn) * 100) : 0;
      console.log(`  ${IN} 裁掉底部 ${(CUT * 100).toFixed(0)}%`);
      console.log(`  ${r.meshes} 个 primitive，三角面 ${r.trisIn} → ${r.trisOut}（剩 ${pct}%）`);
      console.log(`  → ${OUT}  ${(readFileSync(OUT).length / 1024 / 1024).toFixed(2)}MB`);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
