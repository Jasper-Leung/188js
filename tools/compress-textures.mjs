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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE = join(ROOT, '.cache/tex');

const SRC_MODELS = 'D:/code/20260926/no188/assets/models';
const SRC_BIKE = 'D:/code/20260926/no188/assets/bike.glb';

const MAX_TEX_HERO = 1024;
const MAX_TEX_MASS = 768;
const JPEG_QUALITY = 76;
/** 小于这个体积就不压了：二次有损的收益抵不上画质损失 */
const MIN_BYTES = 24 * 1024;

mkdirSync(CACHE, { recursive: true });

const MASS_MODELS = new Set(['tree.glb', 'bush.glb']);
const jobs = existsSync(SRC_MODELS)
  ? readdirSync(SRC_MODELS)
      .filter((f) => f.toLowerCase().endsWith('.glb'))
      .map((f) => ({ src: join(SRC_MODELS, f), name: f, maxTex: MASS_MODELS.has(f) ? MAX_TEX_MASS : MAX_TEX_HERO }))
  : [];
if (existsSync(SRC_BIKE)) {
  jobs.push({ src: SRC_BIKE, name: 'bike.glb', maxTex: MAX_TEX_HERO });
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
  writeFileSync(join(CACHE, job.name), glb);
  inBytes += raw.length;
  outBytes += glb.length;
}

console.log('');
console.log(`[tex] ${jobs.length} 个模型  ${(inBytes / 1048576).toFixed(2)}MB → ${(outBytes / 1048576).toFixed(2)}MB`);
console.log(`[tex] 贴图合计 ${(texIn / 1048576).toFixed(2)}MB → ${(texOut / 1048576).toFixed(2)}MB`);
if (failed) console.log(`[tex] ${failed} 张图没压动，原样保留`);
console.log(`[tex] 中间产物 → ${CACHE}`);
