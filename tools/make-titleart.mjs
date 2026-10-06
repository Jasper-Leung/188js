/**
 * 标题页主视觉 —— 从水墨原稿压出一版能上线的 `public/ui/titleart.jpg`。
 *
 * ```bash
 * npm run assets:title          # 写入 public/ui/titleart.jpg
 * node tools/make-titleart.mjs  # 只报数，不写
 * ```
 *
 * ## 为什么标题页要用一张图，而不是渐变
 *
 * 原来标题页是**一个白色半透明方块**浮在 3D 世界上。
 * 它是全作最弱的视觉，也是第一印象——而 `promo/stills/keyart-loop.jpg`
 * 是同一件作品的水墨主视觉（群山、云海、架在云上的 8 字环线），
 * 本来就是为这一页画的。
 *
 * ## 压到多少、为什么
 *
 * 2752×1536 / 2.8MB → 1920 长边 / JPEG q78 = **199KB**。
 * 它是首屏的一部分（标题页就是首屏），所以算进 `verify_payload` 的
 * "能玩"那一档（上限 2.0MB，实测 1.31MB），并且单独有一条 320KB 的上限。
 *
 * ## 一个**已知且没解决**的复现问题
 *
 * 源图在 `promo/stills/`，而 `promo/` 整条被 `.gitignore`——
 * **换一台机器、或者 `promo/` 被清过，这个脚本就跑不出东西**。
 * 和 `assets:geo` 依赖的 `.cache/tex` 是同一类问题（AGENTS.md §3
 * 说 `assets:*` 会就地改写 `public/`，但没说它们的输入也在版本库里）。
 *
 * 真正的修法是把 1920 宽的原稿（未压缩的那版）纳入版本库。
 * 现在这一步没做，所以 `public/ui/titleart.jpg` 本身是**已提交的产物**，
 * 而它是唯一的出处。
 */
import sharp from 'sharp';
import { statSync, mkdirSync, writeFileSync } from 'node:fs';

const SRC = 'promo/stills/keyart-loop.jpg';
const OUT = 'public/ui/titleart.jpg';

const buf = await sharp(SRC)
  .resize({ width: 1920, withoutEnlargement: true })
  .jpeg({ quality: 78, mozjpeg: true, progressive: true })
  .toBuffer();

const m = await sharp(buf).metadata();
console.log(`${SRC}  ${(statSync(SRC).size / 1024).toFixed(0)}KB`);
console.log(`  → ${OUT}  ${m.width}×${m.height}  ${(buf.length / 1024).toFixed(0)}KB`);

if (process.argv.includes('--write')) {
  mkdirSync('public/ui', { recursive: true });
  writeFileSync(OUT, buf);
  console.log('  已写入');
} else {
  console.log('  （未写盘。加 --write 才落盘）');
}
