/**
 * 阶段 A：只做贴图压缩。**这个脚本只 import sharp，一个 gltf-transform 都不碰。**
 *
 * 为什么要拆成两个进程：libvips（sharp 的底层）在初始化时按 CPU 数开线程池，
 * 而 @gltf-transform/core 与 meshoptimizer（WASM）在被 import 时也会吃掉一批
 * 线程。在同一个进程里，**只要 import 了它们，libvips 的线程池就拿不到
 * 正确的并发度**，于是每张图都在写文件那一步炸：
 *
 *   GLib-GObject-CRITICAL: value "32" of type 'gint' is invalid or out of range
 *   for property 'space' of type 'VipsInterpretation'
 *   Error: colourspace: parameter space not set
 *
 * 迷惑人的地方在于：把**完全相同的字节**用 `fs.readFileSync` 读出来、
 * 在一个只 import 了 sharp 的进程里喂进去，146KB 正常输出。
 * 排查方向一旦偏到"这张图有问题"上就会一直绕圈——图没有任何问题，
 * 有问题的是同进程里还有谁。
 *
 * 产物写到 .cache/tex/，由 optimize-assets.mjs 接着做几何。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { extractEmbeddedImages, replaceEmbeddedImages, imageSize } from './glb-image.mjs';
import { SRC_EXTRA, EXTRA_MODELS, isMassModel, splitTargetName, trimTargetName } from './extra-models.mjs';
import { splitGlb } from './split-glb.mjs';
import { trimGlb } from './trim-glb.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE = join(ROOT, '.cache/tex');

/**
 * 源资产从哪来。
 *
 * ## 为什么改成环境变量
 *
 * 原来这里是三条写死的绝对路径（`D:/code/20260926/no188/…`），
 * 指向**仓库之外**那台机器上的 Godot 源项目。后果有两层：
 *
 * 1. **干净克隆跑不了这条管线。** 换一台机器、或者过三个月再回来，
 *    `D:/code/20260926` 不在了。
 * 2. **更糟的是它不报错。** 原来 `existsSync(...) ? … : []` 这一支直接给了空数组，
 *    于是 `npm run assets:all` 跑完**一行警告都不打**，
 *    接着 `optimize-assets.mjs` 从空的 `.cache/tex/` 里找不到任何输入，
 *    也照样"成功"退出。而 `public/models/` 里那 16.84MB 仍然是**上一次**的产物——
 *    看起来一切正常，实际上整条资产管线已经空转。
 *
 * AGENTS.md 把 `npm run assets:all` 写在部署步骤里，README 的资产表也按
 * "22.3MB → 5.0MB" 描述这条管线；一条在干净克隆上静默空转的管线，
 * 等于那两个数字都失去了出处。
 *
 * 所以：**默认值保留**（本机还能用），但允许用环境变量指到别处，
 * 并且源不在时**直接退出并说清楚缺哪个**。
 *
 * ```bash
 * set GIFT188_SRC_MODELS=D:/work/no188/assets/models
 * set GIFT188_SRC_BIKE=D:/work/no188/assets/bike.glb
 * set GIFT188_SRC_EXTRA=D:/work/no188-extra
 * npm run assets:all
 * ```
 */
const SRC_MODELS = process.env.GIFT188_SRC_MODELS ?? 'D:/code/20260926/no188/assets/models';
const SRC_BIKE = process.env.GIFT188_SRC_BIKE ?? 'D:/code/20260926/no188/assets/bike.glb';

const MAX_TEX_HERO = 1024;
const MAX_TEX_MASS = 768;
const JPEG_QUALITY = 76;
/** 小于这个体积就不压了：二次有损的收益抵不上画质损失 */
const MIN_BYTES = 24 * 1024;

mkdirSync(CACHE, { recursive: true });

/**
 * 源不在就**停下**，而不是继续。
 *
 * 这是一个 `process.exit(1)`，不是警告：这条管线唯一的产物是
 * `.cache/tex/`，而它只被下一步 `optimize-assets.mjs` 读。
 * 源缺失时继续跑的唯一结果是"成功地什么都不做"——
 * 退出码 0、`public/models/` 原封不动、下一个人以为刚压过。
 * 宁可让 `npm run assets:all` 红灯：红灯说明"没压"，绿灯才说明"压过了"。
 */
if (!existsSync(SRC_MODELS)) {
  console.error(
    `[assets] 找不到源模型目录：${SRC_MODELS}\n` +
      `        源资产在**仓库之外**（Godot 源项目），不会被提交。用环境变量指过去：\n` +
      `          GIFT188_SRC_MODELS=<目录>   # 里面是一批 .glb\n` +
      `          GIFT188_SRC_BIKE=<文件>     # 自行车单独一条\n` +
      `          GIFT188_SRC_EXTRA=<目录>    # 松树 / 竹 / 现代建筑，见 tools/extra-models.mjs\n` +
      `        停下是因为继续跑会"成功"地产出一个空缓存，\n` +
      `        而 public/models/ 会保持上一次的旧体积——那正是它最难被发现的样子。`,
  );
  process.exit(1);
}

const MASS_MODELS = { has: isMassModel };
const jobs = readdirSync(SRC_MODELS)
  .filter((f) => f.toLowerCase().endsWith('.glb'))
  .map((f) => ({ src: join(SRC_MODELS, f), name: f, dst: f, maxTex: MASS_MODELS.has(f) ? MAX_TEX_MASS : MAX_TEX_HERO }));
if (existsSync(SRC_BIKE)) {
  jobs.push({ src: SRC_BIKE, name: 'bike.glb', dst: 'bike.glb', maxTex: MAX_TEX_HERO });
} else {
  console.warn(`  ! 自行车源缺失，跳过：${SRC_BIKE}`);
}
// 外部补充资产（松树 / 竹 / 两栋现代建筑）。清单见 tools/extra-models.mjs 的文件头：
// 松树是这一轮补上的关键——源项目那株行道树简化压不动，见那份文件的说明。
for (const [srcName, dstName, maxTex, split, trim, srcDir] of EXTRA_MODELS) {
  const p = join(srcDir ?? SRC_EXTRA, srcName);
  if (existsSync(p)) jobs.push({ src: p, name: dstName, dst: dstName, maxTex, split, trim });
  else console.warn(`  ! 补充资产缺失，跳过：${p}`);
}

let inBytes = 0;
let outBytes = 0;
let texIn = 0;
let texOut = 0;
let failed = 0;

for (const job of jobs) {
  const raw = readFileSync(job.src);
  const images = extractEmbeddedImages(raw);
  const replacements = [];

  for (const im of images) {
    texIn += im.bytes.length;
    if (im.bytes.length < MIN_BYTES) {
      // 还是计入输出（原样搬）
      texOut += im.bytes.length;
      continue;
    }
    try {
      const out = await sharp(im.bytes)
        .resize(job.maxTex, job.maxTex, { fit: 'inside', withoutEnlargement: true })
        .toColourspace('srgb')
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer();
      if (out.length < im.bytes.length) {
        replacements.push([im.index, out]);
        texOut += out.length;
        const d = imageSize(out);
        console.log(
          `  ${job.name} 图${im.index}  ${(im.bytes.length / 1024).toFixed(0)}K → ${(out.length / 1024).toFixed(0)}K  ${d.w}×${d.h}`,
        );
      } else {
        texOut += im.bytes.length;
      }
    } catch (e) {
      failed++;
      texOut += im.bytes.length;
      console.warn(`  ! ${job.name} 图${im.index} 压不动：${String(e.message).split('\n')[0]}`);
    }
  }

  const glb = replaceEmbeddedImages(raw, replacements);
  writeFileSync(join(CACHE, job.dst ?? job.name), glb);
  inBytes += raw.length;
  outBytes += glb.length;

  // 裁底部。**同样必须在贴图压完之后**：裁剪会重写 primitive 与索引。
  // 先裁再压的话，新生成的 bufferView 拿不到压缩过的图。
  if (job.trim) {
    const dst = join(CACHE, trimTargetName(job.dst ?? job.name));
    const r = await trimGlb(join(CACHE, job.dst ?? job.name), dst, job.trim);
    const pct = r.trisIn ? Math.round((r.trisOut / r.trisIn) * 100) : 0;
    console.log(
      `  ${job.dst} 裁掉底部 ${(job.trim * 100).toFixed(0)}%：${r.trisIn} → ${r.trisOut} 面（剩 ${pct}%）→ ${trimTargetName(job.dst ?? job.name)}`,
    );
  }

  // 拆簇。**必须在贴图压完之后**：拆开会重写 primitive 与索引。
  if (job.split) {
    const dst = join(CACHE, splitTargetName(job.dst ?? job.name));
    const r = await splitGlb(join(CACHE, job.dst ?? job.name), dst);
    if (r) {
      console.log(
        `  ${job.dst} 拆成 ${r.clusters} 棵：${r.trisIn} → ${r.trisOut} 面（丢弃 ${r.dropped}）→ ${job.dst.replace(/\.glb$/, '_split.glb')}`,
      );
    } else {
      console.warn(`  ! ${job.dst} 没拆成（只找到一个峰），沿用整丛`);
    }
  }
}

console.log('');
console.log(`[tex] ${jobs.length} 个模型  ${(inBytes / 1048576).toFixed(2)}MB → ${(outBytes / 1048576).toFixed(2)}MB`);
console.log(`[tex] 贴图合计 ${(texIn / 1048576).toFixed(2)}MB → ${(texOut / 1048576).toFixed(2)}MB`);
if (failed) console.log(`[tex] ${failed} 张图没压动，原样保留`);
console.log(`[tex] 中间产物 → ${CACHE}`);
