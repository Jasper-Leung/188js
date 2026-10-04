/**
 * GLB 优化 —— 源项目 52MB 资产压到个位数 MB。
 *
 * 这一步是"低配兼容"里最实的一块：不是让画面变简单，而是让**同样的画面
 * 少占带宽、少占显存**。核显玩家和慢网络玩家卡的多半不是算力，是
 * 下载和上传——一张 2048 的贴图在 4K 屏上占 64MB 显存，在 3G 上要传 3 秒。
 *
 * 做四件事：
 *   1. 贴图降采样 + 重编码（PNG/JPEG → 有损 WebP/JPEG，mipmap 交给 GPU 生成）
 *   2. 顶点焊接（weld）—— 源模型是 Blender 出来的，重复顶点一堆，
 *      焊完顶点属性数据直接少一半
 *   3. 简化（simplify）—— 按误差阈值收面，视觉无损但顶点数大降
 *   4. Meshopt 压缩 —— 比 Draco 更快、运行时解码器只有 ~20KB，
 *      而 Draco 的 wasm 解码器是 250KB+ 且首次解码有卡顿。
 *      低配机上"解码卡一下"的代价比多 2MB 流量更难受。
 *
 * 用 --report 只量不改，先看清楚每个模型值不值得动。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { weld, simplify, prune, dedup, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import { imageSize } from './glb-image.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC_MODELS = join(ROOT, '.cache/tex');
const SRC_AUDIO = 'D:/code/20260926/no188/assets/audio';

const OUT_MODELS = join(ROOT, 'public/models');
const OUT_AUDIO = join(ROOT, 'public/audio');

const REPORT_ONLY = process.argv.includes('--report');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7);

// 贴图最大边。分档的依据是**这块皮在屏幕上能占多少像素**：
//   · 自行车与五座地标 —— 玩家会盯着看，1024 起步。
//   · 树与灌木 —— 同一个模型在屏幕上重复几十次，而单棵树最宽也就百来个像素，
//     1024 的细节没有一像素显示得出来，768 眼睛分辨不出，体积少四成。
// 其余 7 个手工地标只有 8~13KB，压不压都无所谓。
const MAX_TEX_HERO = 1024;
const MAX_TEX_MASS = 768;
const JPEG_QUALITY = 76;

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;

const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression, EXTMeshoptCompression])
  .registerDependencies({
    'meshopt.encoder': MeshoptEncoder,
    'meshopt.decoder': MeshoptDecoder,
  });

if (!existsSync(OUT_MODELS)) mkdirSync(OUT_MODELS, { recursive: true });
if (!existsSync(OUT_AUDIO)) mkdirSync(OUT_AUDIO, { recursive: true });

// ------------------------------------------------------------------ 音频
// 音频原样搬：已经是 ogg、体积合理（合计约 2.2MB），再压会伤环境声的质感。
function copyTree(src, dst) {
  let count = 0;
  let bytes = 0;
  const walk = (dir, rel = '') => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const s = join(dir, e.name);
      const d = join(dst, rel, e.name);
      if (e.isDirectory()) {
        mkdirSync(d, { recursive: true });
        walk(s, join(rel, e.name));
      } else {
        mkdirSync(dirname(d), { recursive: true });
        copyFileSync(s, d);
        count++;
        bytes += statSync(s).size;
      }
    }
  };
  if (existsSync(src)) walk(src);
  return { count, bytes };
}

const audio = copyTree(SRC_AUDIO, OUT_AUDIO);
console.log(`[assets] 音频 ${audio.count} 个文件 ${(audio.bytes / 1048576).toFixed(2)}MB → public/audio/`);

// ------------------------------------------------------------------ 模型
const files = existsSync(SRC_MODELS)
  ? readdirSync(SRC_MODELS).filter((f) => f.toLowerCase().endsWith('.glb'))
  : [];

// 自行车单独处理：它是玩家全程盯着看的那个物件，1.9MB 里绝大部分是
// 贴图与冗余顶点，值得和地标一起压。单独列出来是为了能对它用更松的
// 简化阈值——它离镜头最近，多留一点面数是划算的。
const MASS_MODELS = new Set(['tree.glb', 'bush.glb']);
// 自行车单独一档：它是玩家全程盯着看的那个物件，离镜头最近，
// 值得比地标多留一点面数。其余按「是不是量产道具」分两档：
//
// ## MASS_MODELS 这张表曾经是**不生效的**
//
// 简化误差是**相对包围盒**的。同一个 0.0025，对着一栋 15m 的驿楼是
// 肉眼无差别，对着一株 10m 的树同样是"无差别"——但**性价比**差得远：
// 驿楼在屏幕上占几百米，玩家绕着它骑、停在它前面打卡；
// 树是同一个模型重复几十次，单株最宽也就百来个像素，
// 贴图那边早已为此降到 768，几何再留 35,461 个三角形就是纯浪费。
//
// 它声明了却从没被下面的 `JOBS` 读过，于是树和灌木落进了
// 和飞檐地标同一档（0.6 / 0.0025）——
// **作者写下了「量产道具单独一档」的意图，管道没接上。**
// 后果不是报错，是世界看起来像高速公路而不是乡村：
// 一株行道树 35,461 面，49 株就是 174 万面，谁也不敢多种，
// 于是 1228.8m 的环线上只有 49 棵树。数字与取舍见 src/world/vegetation.ts。
const JOBS = files.map((f) =>
  f === 'bike.glb'
    ? { src: join(SRC_MODELS, f), name: f, ratio: 0.45, error: 0.0008 }
    : MASS_MODELS.has(f)
      // 量产道具：误差放到 0.01（地标的 4 倍）、面数压到约 1/10
      ? { src: join(SRC_MODELS, f), name: f, ratio: 0.1, error: 0.01 }
      : { src: join(SRC_MODELS, f), name: f, ratio: 0.6, error: 0.0025 },
);

if (JOBS.length === 0) {
  console.log('[assets] 没有找到源模型，跳过');
  process.exit(0);
}

let totalIn = 0;
let totalOut = 0;
const rows = [];

for (const job of JOBS) {
  const file = job.name;
  if (ONLY && !file.includes(ONLY)) continue;
  const srcPath = job.src;
  const raw = readFileSync(srcPath);
  totalIn += raw.length;

  // 贴图在**另一个进程**里压好了（tools/compress-textures.mjs）。
  // 这里一个字节的图都不碰——原因见那个脚本的文件头。
  let doc;
  try {
    doc = await io.readBinary(new Uint8Array(raw));
  } catch (e) {
    console.warn(`  ! ${file} 读不出来：${e.message}`);
    continue;
  }

  // ---- 量 ----
  const measured = countGeometry(doc);
  const vtx = measured.vtx;
  const tri = measured.tri;
  const meshCount = doc.getRoot().listMeshes().length;
  const texCount = doc.getRoot().listTextures().length;

  if (!REPORT_ONLY) {
    await doc.transform(
      prune(),
      dedup(),
      // 焊接容差 0（精确相同的位置才焊）。给容差会合并掉本该分开的面，
      // 建筑模型的直角会被磨圆——而这个项目的地标是靠轮廓认的。
      weld({ tolerance: 0 }),
      // 简化误差 0.0025（相对包围盒）。小于这个数肉眼无差别，
      // 大于它亭子的飞檐会塌。宁可多留 200KB 也不动轮廓。
      simplify({ simplifier: MeshoptSimplifier, ratio: job.ratio, error: job.error }),
    );
    await doc.transform(
      meshopt({ encoder: MeshoptEncoder, level: 'high' }),
    );
  }

  let outSize = 0;
  const after = countGeometry(doc);
  const outVtx = after.vtx;
  const outTri = after.tri;
  if (!REPORT_ONLY) {
    const glb = await io.writeBinary(doc);
    outSize = glb.byteLength;
    writeFileSync(join(OUT_MODELS, file), Buffer.from(glb));
  }
  totalOut += outSize;

  rows.push({
    file,
    in: raw.length,
    out: outSize,
    mesh: meshCount,
    tex: texCount,
    vtx,
    tri: Math.round(tri),
    outVtx,
    outTri: Math.round(outTri),
    texTable: doc.getRoot().listTextures().map((t) => { const im = t.getImage(); return { w: 0, h: 0, bytes: im ? im.length : 0 }; }),
  });
}

console.log('');
const HEAD = '  ' + '文件'.padEnd(24) + '原始'.padStart(9) + '优化后'.padStart(10) + '比例'.padStart(7) + '三角面'.padStart(15) + '贴图'.padStart(16);
console.log(HEAD);
console.log('  ' + '-'.repeat(81));
for (const r of rows.sort((a, b) => b.in - a.in)) {
  const pct = r.out > 0 ? `${((r.out / r.in) * 100).toFixed(0)}%` : '-';
  const t = r.outTri ? `${fmt(r.tri)}→${fmt(r.outTri)}` : `-(${fmt(r.tri)})`;
  const texes = (r.texTable ?? [])
    .map((x) => `${x.w}×${x.h}·${(x.bytes / 1024).toFixed(0)}K`)
    .join(' ');
  console.log(
    '  ' +
      r.file.padEnd(22) +
      fmt(r.in).padStart(9) +
      fmt(r.out).padStart(10) +
      pct.padStart(7) +
      t.padStart(15) +
      ('  ' + (texes || '—')).padStart(16),
  );
}
console.log('  ' + '-'.repeat(81));
console.log(
  '  ' +
    '合计'.padEnd(22) +
    fmt(totalIn).padStart(9) +
    fmt(totalOut).padStart(10) +
    (totalOut ? `${((totalOut / totalIn) * 100).toFixed(0)}%`.padStart(7) : ''),
);
console.log(REPORT_ONLY ? '\n[assets] --report 模式，未写入任何文件' : '\n[assets] 完成');

function fmt(n) {
  if (!n) return '0';
  if (n > 1048576) return (n / 1048576).toFixed(2) + 'M';
  if (n > 1024) return (n / 1024).toFixed(0) + 'K';
  return String(n);
}

/** 列出每张贴图的尺寸与体积（纯解析字节头，不经过 libvips）。 */
function listTextures(doc) {
  return doc.getRoot().listTextures().map((t) => {
    const im = t.getImage();
    if (!im) return { w: 0, h: 0, bytes: 0 };
    return { ...imageSize(Buffer.from(im)), bytes: im.length };
  });
}

/** 数顶点和三角面。一个 mesh 可能有多个 primitive，逐个加起来。 */
function countGeometry(doc) {
  let vtx = 0;
  let tri = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const n = pos ? pos.getCount() : 0;
      vtx += n;
      const idx = prim.getIndices();
      tri += (idx ? idx.getCount() : n) / 3;
    }
  }
  return { vtx, tri };
}

