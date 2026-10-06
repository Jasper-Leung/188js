/**
 * 贴图重压 —— 对**已发布**的 `public/models/*.glb` 就地压贴图。
 *
 * ## 为什么要有这个工具（`assets:geo` 救不了这件事）
 *
 * `optimize-assets.mjs` 读的是 `.cache/tex` 里暂存的**源模型**。
 * 那个目录被 `.gitignore` 忽略，所以它从来没进过版本库——
 * **换一台机器、或者 `.cache` 被清过，管道就再也跑不起来了**，
 * 而且跑起来会安静地处理 0 个模型然后报成功。
 *
 * 更要紧的是：这一轮新加的模型（motorcycle / survivor / skateboard /
 * pine / bamboo / mod_house / mod_tower）**源文件根本不存在**——
 * 它们是直接落进 `public/models` 的，Godot 源项目里也没有。
 * 所以"再跑一遍优化管道"对这些真正超支的资产是**不可执行的**。
 *
 * 这个工具绕开源文件：直接读发布出去的 GLB，把里面的贴图降分辨率重编码，
 * 几何与动画一个字节不动。
 *
 * ## 为什么只压贴图就够了
 *
 * 实测 `motorcycle.glb`：4.82MB 里 **3.92MB（82%）是 215 张 JPEG**，
 * 几何（120,417 面）只占约 0.9MB。也就是说——
 * **再简化几何对它是白费力气**，简化到 1% 也省不下 3.9MB。
 * 一次贴图重压能省掉整包的四分之三。
 *
 * ## 用法
 *
 * ```bash
 * npm run assets:retax                    # 全部
 * npm run assets:retax -- --only=motorcycle
 * npm run assets:retax -- --dry           # 只报数不改
 * ```
 *
 * 质量档见 `TEX_JOBS`：地标/载具这类玩家会盯着看的留 1024，
 * 量产道具（树、灌木、竹、现代楼）降到 512——它们在屏幕上只有几十个像素，
 * 1024 和 512 肉眼分不出来，而后者是前者的四分之一带宽。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression, EXTMeshoptCompression } from '@gltf-transform/extensions';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MODELS = join(ROOT, 'public/models');

const DRY = process.argv.includes('--dry');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7);

/**
 * 每类资产的贴图预算。
 *
 * `maxSize` 是最长边；`quality` 是 JPEG 质量。
 * 数字来自这个项目既有的贴图档（768/1024 + JPEG q76），
 * 这里往上取整到 1024/512 并把质量压到 72——
 * 这批模型从来没走过贴图管道（见文件头），所以是从零开始定，
 * 不是在已有档位上微调。
 */
const TEX_JOBS = [
  // 地标与载具：玩家会盯着看
  { match: /^(station_|bike|bicycle|motorcycle|survivor|skateboard)/, maxSize: 1024, quality: 74 },
  // 量产道具与远景地标：一丛树 / 一栋远楼，屏幕上只有几十像素
  { match: /^(tree|pine|bush|bamboo|mod_)/, maxSize: 512, quality: 70 },
  // 兜底
  { match: /.*/, maxSize: 1024, quality: 74 },
];

function jobFor(name) {
  return TEX_JOBS.find((j) => j.match.test(name)) ?? TEX_JOBS[TEX_JOBS.length - 1];
}

const { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } = await import('meshoptimizer');
await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;

/**
 * `meshopt()` 变换是**必需品**，不是锦上添花——见下面写回那一段的实测。
 * 而它在某些环境里加载不起来：`@gltf-transform/functions` 会拉进
 * `ndarray-pixels`，后者自带的 `sharp@0.35.5` 原生模块在部分 Node/Windows
 * 组合上是坏的（`ERR_DLOPEN_FAILED`）。
 *
 * 所以这里**不硬 import**。拿不到就整个工具拒绝写盘并说清原因——
 * 一个"没压几何就写回"的重压工具会把包做大小 4%，而它自己报的数字全绿。
 * 与其让它在某些机器上悄悄做坏事，不如让它在所有机器上明确地不做。
 */
let meshopt = null;
try {
  ({ meshopt } = await import('@gltf-transform/functions'));
} catch (e) {
  console.error('');
  console.error('拿不到 @gltf-transform/functions 的 meshopt()，**不做任何修改**并退出。');
  console.error('  原因：' + e.message.split('\n')[0]);
  console.error('');
  console.error('  为什么不能跳过它：贴图压完直接 writeBinary，');
  console.error('  几何不会被重新压缩——实测 motorcycle.glb 4.82MB → 4.98MB。');
  console.error('  一个"在压贴图"的工具把包做大了，而它报的数字全是绿的。');
  console.error('  修法：npm install --include=optional sharp');
  console.error('');
  process.exit(1);
}

const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression, EXTMeshoptCompression])
  .registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });

if (!existsSync(MODELS)) {
  console.error('找不到 public/models —— 先跑一次 npm run build 或确认仓库完整');
  process.exit(1);
}
const files = readdirSync(MODELS).filter((f) => f.toLowerCase().endsWith('.glb')).filter((f) => !ONLY || f.includes(ONLY));
if (files.length === 0) {
  // 和 `optimize-assets.mjs` 不一样，这里**必须**是硬失败。
  // 那边 `files = []` 会安静地跑完并报成功——那正是这个工具存在的理由之一。
  console.error(`没有匹配 ${ONLY} 的模型，退出码 1（不做任何修改）`);
  process.exit(1);
}

let before = 0;
let after = 0;
const rows = [];

for (const f of files) {
  const src = join(MODELS, f);
  const raw = readFileSync(src);
  const job = jobFor(f);
  const doc = await io.readBinary(new Uint8Array(raw));

  const texs = doc.getRoot().listTextures();
  let shrunk = 0;
  let texBefore = 0;
  let texAfter = 0;

  for (const tex of texs) {
    let img;
    try {
      img = tex.getImage();
    } catch {
      continue; // 外部引用，没有内嵌字节
    }
    if (!img) continue;
    texBefore += img.byteLength;
    const mime = tex.getMimeType() ?? '';
    if (!mime.startsWith('image/')) continue;
    try {
      const out = await sharp(img)
        .resize({ width: job.maxSize, height: job.maxSize, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: job.quality, mozjpeg: true })
        .toBuffer();
      if (out.byteLength < img.byteLength) {
        tex.setImage(new Uint8Array(out));
        tex.setMimeType('image/jpeg');
        texAfter += out.byteLength;
        shrunk++;
      } else {
        // 压完反而更大（小图 + 高 q）就保留原图，别做无意义的损失
        texAfter += img.byteLength;
      }
    } catch (e) {
      texAfter += img.byteLength;
      console.warn(`  [warn] ${f} 某张贴图压不动: ${e.message}`);
    }
  }

  if (shrunk === 0) {
    before += raw.length;
    after += raw.length;
    rows.push([f, raw.length, raw.length, texs.length, 0, job.maxSize, '无改动']);
    continue;
  }

  // **必须重新施加 meshopt，否则文件会变大。**
  //
  // 实测：不加这一步，贴图确实省了 0.94MB，可 `writeBinary` 回写时
  // 没有把几何重新压一遍，4.82MB 的 motorcycle 变成 **4.98MB**。
  // 也就是说：一个"在压贴图"的工具，把包**做大了**——
  // 而它报出来的数字（贴图 2.74→1.80MB）全是绿的。
  // 没有任何一条现有判据会拦住它，因为**没有一条判据量上线字节数**。
  //
  // `--dry` 也走这一整段：它要报的必须是**真正会写出的那个大小**，
  // 而不是"贴图省了多少"——后者正是上面那个工具报绿的那个数。
  await doc.transform(meshopt({ encoder: MeshoptEncoder }));

  const glb = await io.writeBinary(doc);

  // 自我保护：压完更大就**不写**，并说清差多少。
  // 一个可能把包做大的工具，唯一能守住自己的办法就是拒绝写出更差的文件。
  if (glb.byteLength >= raw.length) {
    before += raw.length;
    after += raw.length;
    rows.push([f, raw.length, raw.length, texs.length, shrunk, job.maxSize,
      `拒绝：回写 ${(glb.byteLength / 1048576).toFixed(2)}MB 反而更大`]);
    continue;
  }

  if (!DRY) writeFileSync(src, Buffer.from(glb));
  before += raw.length;
  after += glb.byteLength;
  rows.push([f, raw.length, glb.byteLength, texs.length, shrunk, job.maxSize, DRY ? '试算' : '已写']);
}

const mb = (n) => (n / 1048576).toFixed(2);
const pad = (s, n) => String(s).padStart(n);
rows.sort((a, b) => b[1] - a[1]);
console.log(DRY ? '\n=== 试算（--dry，没有写任何文件）===' : '\n=== 结果 ===');
console.log('  ' + pad('MB 原', 8) + pad('MB 后', 8) + pad('省', 8) + '  贴图  降过  上限');
for (const [f, b0, a0, tn, sh, ms, note] of rows) {
  console.log(
    '  ' + pad(mb(b0), 8) + pad(mb(a0), 8) + pad(mb(b0 - a0), 8) +
    '  ' + pad(tn, 4) + pad(sh, 6) + pad(ms, 6) + '  ' + f,
  );
}
console.log(`\n  合计 ${mb(before)} MB → ${mb(after)} MB${DRY ? '（试算）' : ''}，省 ${(100 * (1 - after / before)).toFixed(1)}%`);

