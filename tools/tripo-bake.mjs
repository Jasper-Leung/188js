/**
 * 阶段 A：把 Tripo 基色贴图烘成顶点色，然后**删掉全部贴图**。
 *
 * ## 这个文件为什么单独存在
 *
 * 因为 `sharp` 和 `@gltf-transform/functions` 在同一个进程里**不能共存**：
 * 后者依赖 `ndarray-pixels`，它带了一份嵌套的 `sharp@0.35`；那份原生模块在
 * Windows 上装不起来（`ERR_DLOPEN_FAILED`），一旦被拉进来，
 * 同进程里那份正常的 `sharp@0.33` 也跟着坏掉——
 * 症状是一句完全指不到病处的
 * `colourspace: parameter space not set`，而 `sharp.versions.vips` 还报得出版本号。
 *
 * 调换导入顺序救不了：先 functions 后 sharp，前者照样把原生库弄坏。
 * 所以烘色这一步**必须**单独一个进程，父进程 `tripo-station.mjs` 用
 * `child_process` 调它。这是唯一的解法，不是偏好。
 *
 * 本脚本不是独立工具，别单独跑：它写的是中间产物 `.cache/tripo-baked/`，
 * 下一步（归一化 / 简化 / 压缩）在父进程里。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'assets-src/tripo');
const OUT = join(__dirname, '..', '.cache/tripo-baked');

const NAMES = [
  'inn',
  'teahut',
  'terrace',
  'shrine',
  'pavilion',
  'corridor',
  'lantern',
  'mod_tower',
  'mod_house',
];

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const io = new NodeIO();

for (const name of NAMES) {
  const src = join(SRC, `${name}.glb`);
  const raw = readFileSync(src);
  const doc = await io.readBinary(new Uint8Array(raw));
  const ok = await bakeVertexColor(doc);
  const glb = await io.writeBinary(doc);
  writeFileSync(join(OUT, `${name}.glb`), Buffer.from(glb));
  console.log(`[bake] ${name}  顶点色 ${ok ? '已烘' : '无基色'}  ${(raw.length / 1024).toFixed(0)}K → ${(glb.byteLength / 1024).toFixed(0)}K`);
}

/**
 * 逐顶点采样基色写进 `COLOR_0`，然后把贴图、UV 一起删掉。
 *
 * ## 为什么颜色要存**线性**值
 *
 * `COLOR_0` 在 three.js 里被当作线性空间的颜色，而 baseColor 贴图是 sRGB 的。
 * 直接把贴图的字节搬过去，整座建筑会亮一大截（sRGB 0.5 的线性值是 0.21，
 * 直接用等于亮一倍多）。所以每个通道都要过一次 sRGB→线性。
 *
 * 存成 `Uint8 + normalized`：省一半顶点字节；建筑颜色区间里最暗的瓦顶
 * 线性值约 0.13，一个字节的量化误差是 0.4%，看不出来。
 *
 * ## 贴图和 UV 一起走
 *
 * UV 只被贴图用。留着 UV 而没有贴图，它只是白占顶点字节——
 * 而 meshopt 对没有对应贴图的 UV 一个字节也不会压。
 */
async function bakeVertexColor(doc) {
  let baked = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const uv = prim.getAttribute('TEXCOORD_0');
      const baseColorTex = prim.getMaterial()?.getBaseColorTexture();
      if (!uv || !baseColorTex) continue;
      const img = baseColorTex.getImage();
      if (!img) continue;

      let data;
      let info;
      try {
        ({ data, info } = await sharp(Buffer.from(img))
          .raw()
          .toBuffer({ resolveWithObject: true }));
      } catch (e) {
        throw new Error(`${mesh.getName()} 的 baseColor 解不开：${e.message}`);
      }

      const count = uv.getCount();
      const uvArr = uv.getArray();
      const out = new Uint8Array(count * 4);
      for (let i = 0; i < count; i++) {
        // glTF 的 UV 原点在左上，JPEG 解码出来的行序也是自上而下，两边一致。
        const x = Math.min(info.width - 1, Math.max(0, Math.round(uvArr[i * 2] * (info.width - 1))));
        const y = Math.min(info.height - 1, Math.max(0, Math.round(uvArr[i * 2 + 1] * (info.height - 1))));
        const o = (y * info.width + x) * info.channels;
        out[i * 4] = srgbToLinearByte(data[o]);
        out[i * 4 + 1] = srgbToLinearByte(data[o + 1]);
        out[i * 4 + 2] = srgbToLinearByte(data[o + 2]);
        out[i * 4 + 3] = 255;
      }
      prim.setAttribute('COLOR_0', doc.createAccessor().setType('VEC4').setArray(out).setNormalized(true));
      baked++;
    }
  }

  for (const mat of doc.getRoot().listMaterials()) {
    mat.setBaseColorTexture(null).setNormalTexture(null).setMetallicRoughnessTexture(null);
    mat.setBaseColorFactor([1, 1, 1, 1]);
    mat.setRoughnessFactor(0.9);
    mat.setMetallicFactor(0);
  }
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) prim.setAttribute('TEXCOORD_0', null);
  }
  return baked > 0;
}

/** sRGB → 线性，再塞进一个字节。 */
function srgbToLinearByte(c) {
  const s = c / 255;
  const lin = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  return Math.max(0, Math.min(255, Math.round(lin * 255)));
}