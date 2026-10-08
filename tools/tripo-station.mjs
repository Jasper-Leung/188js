/**
 * Tripo 高模 → 游戏里的低模（9 座）。
 *
 * 源模型每座 6.2~7.0MB、约 18 万三角面，还带三张 JPEG（法线 + 基色 + MR）。
 * 直接扔进 `public/models/` 的话九座就是 58MB——比整个游戏本体还大两倍。
 * 这一步把它们压到"驿站该有的样子"：两三万面、零贴图、meshopt 压缩，
 * 九座合计 1~2MB。
 *
 * ## 三步，分两个进程
 *
 * 1. **烘顶点色，丢贴图**（子进程 `tripo-bake.mjs`）。零贴图是这个项目的
 *    一等约束，但直接丢掉 baseColor 等于把 Tripo 辛苦生成的配色一起扔了——
 *    建筑会退回"一块单色体积"，正是 `architecture.ts` 当初要解决的那个毛病。
 *    所以逐顶点采样基色写进 `COLOR_0`，再把三张贴图连同 `TEXCOORD_0` 删掉。
 *    **顺序不能反**：先简化再采样，105k 顶点会塌到 14k，颜色就只剩 14k 个点。
 *    这一步必须在子进程里，原因见那个文件的头注。
 * 2. **归一化单位**。`stations.ts` 加载时会乘 `cfg.scale`
 *    （`g.scale.set(scale*sx, scale*sy, scale*sx)`），所以
 *    **模型单位高 × scale = 场景米数**。Tripo 导出是"最长边归一化到 1"，
 *    而凉亭和亭灯的 scale 是 12 和 14 不是 10，按同一个倍率缩会压路面。
 *    真正的上限是两条里较小的那条：高度不许碰到 `label_y`，半宽不许超过 8m。
 *    岭台就是被半宽卡住的——按高度缩能到 11m，宽度就变成 19.8m，压到路面上了。
 * 3. **简化 + meshopt 压缩**。按目标面数反算 ratio，误差逐个模型给
 *    （相对包围盒，见 `JOBS` 下的注释）。驿楼这类要绕着骑的建筑留在两三万面；
 *    亭灯和两座远景的目标是一万面——实际落在 1.4~2.4 万，因为简化器
 *    先撞到误差上限就停手，宁可多留面也不让轮廓塌。
 *    meshopt 的理由与 `optimize-assets.mjs` 相同：解码器 20KB，
 *    比 Draco 的 250KB 小一个量级，首次解码也不卡。
 *
 * ## 为什么不并进 optimize-assets.mjs
 *
 * 那个脚本的输入是 `.cache/tex/`，由 `compress-textures.mjs` 从仓库之外的
 * Godot 源项目搬来——它压的是"贴图已经被压过"的模型。
 * 这里的输入在仓库里（`assets-src/tripo/`），而且第一步是**把贴图变成顶点色**，
 * 只有源模型带 baseColor 时才有意义。两者的输入和第一步都不同，
 * 并进同一个脚本只会让那个脚本背上两套互不相干的假设。
 *
 * 用 `--report` 只量不改。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BAKED = join(ROOT, '.cache/tripo-baked');
const OUT = join(ROOT, 'public/models');

const REPORT_ONLY = process.argv.includes('--report');

/**
 * 逐个模型的预算。三条约束来自 `assets-src/tripo/PROMPTS.md` 第 2 节，
 * 而 `scale / label_y` 是 `world.json` 的 `STATION_GLB_CONFIG`——两个都是既有事实，
 * 这里只决定"模型该长成什么样"：
 *
 * | 建筑 | scale | label_y | 目标高（单位） | 半宽上限（单位） | 目标面数 |
 * |---|---:|---:|---:|---:|---:|
 * | 驿楼 | 10 | 11m | 1.05 | 0.80 | 26000 |
 * | 茶寮 | 10 | 10m | 0.80 | 0.80 | 26000 |
 * | 岭台 | 10 | 12m | 1.10 | 0.80 | 26000 |
 * | 神苑 | 10 |  9m | 0.85 | 0.80 | 26000 |
 * | 凉亭 | 12 |  8m | 0.625 | 0.667 | 26000 |
 * | 廊   | 10 |  8m | 0.75 | 0.80 | 26000 |
 * | 亭灯 | 14 | 10m | 0.535 | 0.571 | 9000 |
 *
 * **半宽上限 = 8m ÷ scale**，凉亭和亭灯的除数是 12 / 14，
 * 按 0.80 去缩这两座就会压到路面上。
 *
 * 后两座远景走 `scenery.ts` 的区间，用 `setScalar(scale)`，不受 label_y 管：
 * 塔楼归一化到 1.0 单位（成品 34~44m）；圆屋压到 0.42 单位
 * （成品 4.6~6.7m——1.0 会变成 11~16m 的圆屋，一栋小屋）。
 * 不动 `scenery.ts` 的 `[11,16]`：那是源码，改它比改模型更自由，但没必要。
 */
const JOBS = [
  { src: 'inn', out: 'station_驿楼.glb', scale: 10, labelY: 11, h: 1.05, half: 0.8, tris: 26000, err: 0.0025 },
  { src: 'teahut', out: 'station_茶寮.glb', scale: 10, labelY: 10, h: 0.8, half: 0.8, tris: 26000, err: 0.0025 },
  { src: 'terrace', out: 'station_岭台.glb', scale: 10, labelY: 12, h: 1.1, half: 0.8, tris: 26000, err: 0.0025 },
  { src: 'shrine', out: 'station_神苑.glb', scale: 10, labelY: 9, h: 0.85, half: 0.8, tris: 26000, err: 0.0025 },
  { src: 'pavilion', out: 'station_凉亭.glb', scale: 12, labelY: 8, h: 0.625, half: 8 / 12, tris: 26000, err: 0.0025 },
  { src: 'corridor', out: 'station_廊.glb', scale: 10, labelY: 8, h: 0.75, half: 0.8, tris: 26000, err: 0.0025 },
  // 亭灯和两座远景用更大的误差，理由与 optimize-assets.mjs 的量产档一样：
  // **误差是相对包围盒的**。同一个 0.0025 对着 15m 的驿楼是肉眼无差别，
  // 对着一盏 2m 的石灯就是"无差别"——但面数差着五倍。
  { src: 'lantern', out: 'station_亭灯.glb', scale: 14, labelY: 10, h: 0.535, half: 8 / 14, tris: 9000, err: 0.012 },
  { src: 'mod_tower', out: 'mod_tower.glb', h: 1.0, tris: 9000, err: 0.008 },
  { src: 'mod_house', out: 'mod_house.glb', h: 0.42, tris: 9000, err: 0.012 },
];

// 阶段 A 在子进程里跑，因为 sharp 与 @gltf-transform/functions 不能共存（见子进程文件头）
if (!REPORT_ONLY) {
  if (!existsSync(join(ROOT, 'assets-src/tripo'))) {
    console.error('[tripo] assets-src/tripo 不存在 —— 没有源模型，退出。');
    process.exit(1);
  }
  execFileSync(process.execPath, [join(__dirname, 'tripo-bake.mjs')], { stdio: 'inherit' });
}

const { NodeIO } = await import('@gltf-transform/core');
const { KHRDracoMeshCompression, EXTMeshoptCompression } = await import('@gltf-transform/extensions');
const { weld, simplify, prune, dedup, meshopt } = await import('@gltf-transform/functions');
const { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } = await import('meshoptimizer');

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;

const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression, EXTMeshoptCompression])
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const rows = [];
let totalIn = 0;
let totalOut = 0;

for (const job of JOBS) {
  const srcPath = join(BAKED, `${job.src}.glb`);
  if (!existsSync(srcPath)) {
    console.error(`[tripo] 缺少烘过色的中间产物 ${srcPath}——先跑 tools/tripo-bake.mjs`);
    process.exit(1);
  }
  const raw = readFileSync(srcPath);
  totalIn += raw.length;
  const doc = await io.readBinary(new Uint8Array(raw));

  const before = countGeometry(doc);
  const srcBox = bboxOf(doc);

  // ---- 归一化单位 ----
  // 倍率取两条上限里较小的那条：高度不许碰到 label_y，半宽不许超过 8m。
  const maxXZ = Math.max(srcBox.size[0], srcBox.size[2]);
  const fH = job.h / srcBox.size[1];
  const fW = job.half ? (job.half * 2) / maxXZ : Infinity;
  normalizePositions(doc, Math.min(fH, fW));
  const box = bboxOf(doc);

  // ---- 简化 + 压缩 ----
  const ratio = job.tris / before.tri;
  if (!REPORT_ONLY) {
    await doc.transform(
      prune(),
      dedup(),
      // 焊接容差 0：给容差会把建筑的直角磨圆，而这几座是靠轮廓认的。
      weld({ tolerance: 0 }),
      simplify({ simplifier: MeshoptSimplifier, ratio, error: job.err }),
      meshopt({ encoder: MeshoptEncoder, level: 'high' }),
    );
  }

  const after = countGeometry(doc);
  let outSize = 0;
  if (!REPORT_ONLY) {
    const glb = await io.writeBinary(doc);
    outSize = glb.byteLength;
    writeFileSync(join(OUT, job.out), Buffer.from(glb));
  }
  totalOut += outSize;

  rows.push({
    file: job.out,
    in: raw.length,
    out: outSize,
    tri: before.tri,
    outTri: after.tri,
    unitH: box.size[1],
    unitHalf: Math.max(box.size[0], box.size[2]) / 2,
    metres: box.size[1] * (job.scale ?? 1),
    labelY: job.labelY ?? '—',
    tex: doc.getRoot().listTextures().length,
  });
}

console.log('');
console.log(
  '  ' +
    '输出'.padEnd(22) +
    '入'.padStart(9) +
    '出'.padStart(9) +
    '面数'.padStart(16) +
    '单位高'.padStart(8) +
    '成品m'.padStart(8) +
    'label_y'.padStart(9) +
    '半宽'.padStart(7) +
    '贴图'.padStart(6),
);
console.log('  ' + '-'.repeat(87));
for (const r of rows) {
  console.log(
    '  ' +
      r.file.padEnd(20) +
      fmt(r.in).padStart(9) +
      fmt(r.out).padStart(9) +
      `${fmt(r.tri)}→${fmt(r.outTri)}`.padStart(16) +
      r.unitH.toFixed(3).padStart(8) +
      r.metres.toFixed(1).padStart(8) +
      String(r.labelY).padStart(9) +
      r.unitHalf.toFixed(3).padStart(7) +
      String(r.tex).padStart(6),
  );
}
console.log('  ' + '-'.repeat(87));
console.log(
  '  ' +
    '合计'.padEnd(20) +
    fmt(totalIn).padStart(9) +
    fmt(totalOut).padStart(9) +
    (totalOut ? `  ${((totalOut / totalIn) * 100).toFixed(0)}%` : ''),
);
console.log(REPORT_ONLY ? '\n[tripo] --report 模式，未写入任何文件' : '\n[tripo] 完成');

function fmt(n) {
  if (!n) return '0';
  if (n > 1048576) return (n / 1048576).toFixed(2) + 'M';
  if (n > 1024) return Math.round(n / 1024) + 'K';
  return String(Math.round(n));
}

/**
 * 缩放并把模型摆正：原点在底面中心，底面贴 y=0。
 *
 * 缩放**烘进顶点**而不是挂到节点上：`stations.ts` 用 `Box3.setFromObject(model.root)`
 * 量包围盒，节点缩放虽然也进包围盒，但简化器工作在未归一化的局部空间，
 * 节点再带一层缩放会让误差阈值失去物理意义。
 */
function normalizePositions(doc, f) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  const prims = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const acc = prim.getAttribute('POSITION');
      if (!acc) continue;
      const arr = Float32Array.from(acc.getArray());
      prims.push({ prim, arr });
      for (let i = 0; i < arr.length; i += 3) {
        minX = Math.min(minX, arr[i]);
        maxX = Math.max(maxX, arr[i]);
        minY = Math.min(minY, arr[i + 1]);
        minZ = Math.min(minZ, arr[i + 2]);
        maxZ = Math.max(maxZ, arr[i + 2]);
      }
    }
  }
  const dx = -(minX + maxX) / 2;
  const dz = -(minZ + maxZ) / 2;
  for (const { prim, arr } of prims) {
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] = (arr[i] + dx) * f;
      arr[i + 1] = (arr[i + 1] - minY) * f;
      arr[i + 2] = (arr[i + 2] + dz) * f;
    }
    // min/max 由 Accessor 自己从数组算（`getMin` 就是这么写的），不用手动维护。
    prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(arr));
  }
}

/**
 * 整个文件的包围盒（节点变换之后）。
 *
 * 节点矩阵是列主序：缩放在 0 / 5 / 10，平移在 12 / 13 / 14。
 * 按 0 / 1 / 2 取缩放的话 Y 与 Z 会永远读到 0，包围盒高度变成 0。
 */
function bboxOf(doc) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  doc.getRoot().listNodes().forEach((node) => {
    const m = node.getMatrix();
    const mesh = node.getMesh();
    if (!mesh) return;
    for (const prim of mesh.listPrimitives()) {
      const acc = prim.getAttribute('POSITION');
      if (!acc) continue;
      const lo = acc.getMin([0, 0, 0]);
      const hi = acc.getMax([0, 0, 0]);
      for (let k = 0; k < 3; k++) {
        const s = m[k * 5];
        min[k] = Math.min(min[k], lo[k] * s + m[12 + k]);
        max[k] = Math.max(max[k], hi[k] * s + m[12 + k]);
      }
    }
  });
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/** 数顶点和三角面。一个 mesh 可能有多个 primitive，逐个加起来。 */
function countGeometry(doc) {
  let vtx = 0;
  let tri = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      vtx += pos.getCount();
      const idx = prim.getIndices();
      tri += (idx ? idx.getCount() : pos.getCount()) / 3;
    }
  }
  return { vtx, tri };
}