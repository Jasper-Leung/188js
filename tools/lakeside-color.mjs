/**
 * 湖边场景 · 阶段 B：把 8192² 图集烘成顶点色。
 *
 * ⚠ **这个文件只能单独跑，不要和 @gltf-transform 放进同一个进程。**
 * `node_modules/ndarray-pixels/node_modules/sharp@0.35.5` 是坏的，
 * 它一被 require 就把顶层那个能用的 `sharp@0.33.5` 一起弄坏，
 * 症状是 `sharp is not a function`，而 `npm ls sharp` 看着一切正常。
 * 调度侧见 `lakeside-scene.mjs`，那边才是本项目唯一允许 import gltf-transform 的地方。
 *
 * 存在的理由只有一条：**零贴图是一等约束**（见 `verify_station_models` 里
 * 九座 Tripo 建筑那几条）。Marble 的 HQ 贴图版给的是一张 8192² PNG，
 * 直接进 `public/models/` 就是一次 86MB 的下载加一张常驻纹理；
 * 烘成 COLOR_0 之后纹理整个消失，这才是本项目要的东西。
 *
 * 输入输出全是 `.cache/` 下的裸二进制，这样两个进程之间只传数组、不传文档：
 *   uv.bin    Float32 × nv×2，glTF 约定的 UV（v=0 在贴图第一行）
 *   atlas.png 图集
 * 输出
 *   col.bin   Uint8 × nv×4
 *
 * 用法（一般不由人直接调，调度侧会 execFileSync 它）：
 *   node tools/lakeside-color.mjs <atlas.png> <uv.bin> <col.bin> [图集边长]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const [, , atlasPath, uvPath, outPath, sizeArg] = process.argv;
if (!atlasPath || !uvPath || !outPath) {
  console.error('用法: node tools/lakeside-color.mjs <atlas.png> <uv.bin> <col.bin> [图集边长]');
  process.exit(1);
}

/**
 * 烘焙时的取样边长，默认 4096 而不是源的 8192。
 *
 * 理由是**顶点数决定我们只需要多少颜色分辨率**：裁剪 + simplify 之后
 * 剩 15 万面上下、45 万顶点，从 8192² 里取 45 万个样本时，
 * 每 texel 平均覆盖 1.8 个顶点——8192 的分辨率在这一步买不到任何可见差别，
 * 却要把贴图解成 268MB 的裸像素。降到 4096 是 67MB，颜色精度反而更匹配
 * 我们真正保留的密度。需要像素级还原时传 8192。
 */
const SIZE = Number(sizeArg) || 4096;

const uv = new Float32Array(readFileSync(uvPath).buffer);
const nv = uv.length / 2;
if (!Number.isInteger(nv) || nv === 0) {
  console.error(`[lakeside] uv.bin 长度 ${uv.length} 不是合法的顶点数 × 2`);
  process.exit(1);
}

console.log(`[lakeside] 解图集 ${atlasPath} → ${SIZE}×${SIZE} 原始像素 …`);
const { data, info } = await sharp(atlasPath)
  .resize(SIZE, SIZE, { kernel: 'lanczos3', fit: 'fill' })
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

if (info.width !== SIZE || info.height !== SIZE || info.channels !== 4) {
  console.error(`[lakeside] 图集解出来是 ${info.width}×${info.height}×${info.channels}，与预期不符`);
  process.exit(1);
}
const W = info.width, H = info.height;

const col = new Uint8Array(nv * 4);
for (let i = 0; i < nv; i++) {
  const u = uv[i * 2];
  // glTF 的 v=0 对应贴图第一行；图集上下颠倒会让整个场景上下颠倒的配色。
  const v = uv[i * 2 + 1];
  let px = Math.round(u * (W - 1));
  let py = Math.round(v * (H - 1));
  if (px < 0) px = 0; else if (px >= W) px = W - 1;
  if (py < 0) py = 0; else if (py >= H) py = H - 1;
  const o = (py * W + px) * 4;
  col[i * 4] = data[o];
  col[i * 4 + 1] = data[o + 1];
  col[i * 4 + 2] = data[o + 2];
  col[i * 4 + 3] = 255;
}

writeFileSync(outPath, col);
console.log(`[lakeside] 顶点色 ${nv.toLocaleString()} 个 → ${outPath}`);
