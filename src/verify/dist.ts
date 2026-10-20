/**
 * 产物洁净度 —— 「发出去的东西里不许混进本地垃圾」。
 *
 * ## 它治的是哪一种病
 *
 * 2026-10-20 这次发版，两条 CI 流水线（桌面端 Release、部署到 Pages）
 * 都在 `npm run verify` 上红了，而**本地是绿的**。原因不是代码，
 * 是这个工作区里躺着 17 个 Godot 的 `.import` 导入桩：
 *
 *   · 它们在 `public/audio/` 下面，`.gitignore` 里写着 `*.import`（**没进版本库**）
 *   · `vite build` 把 `public/` **原样**拷进 `dist/`，于是它们跟着上了产物
 *   · 本地量到的 payload 因此比"干净检出"多了 6,698 字节
 *   · 而 `docs/release-facts.md`（唯一那一份公开数字）正是**本地**量出来的
 *   · 于是 [DOC] 门在 CI 上判红：`payload_gzip_mb 写的是 19.46，实际 19.45`
 *
 * 也就是说：**基线被自己工作区里的垃圾污染了**。
 * 更难堪的是 README 里明明写着「`*.import` 忽略：那是 Godot 的导入桩，
 * 对 web 构建毫无用处」——**这句话是对的，可它同时在被发到网上**。
 *
 * ## 为什么光靠 [DOC] 门不够
 *
 * [DOC] 门能抓住"本地和 CI 说的不一样"，但它只说**数字**不一样，
 * 不会说**为什么**。这一族负责把原因指出来：产物里有本地垃圾。
 *
 * 治法是两条：
 *
 *   1. **已知垃圾类型直接点名**（`.import`）——精确、可操作。
 *   2. **一条不变量**：`dist/` = build 产物 + `public/` 逐个文件原样拷贝。
 *      于是**任何**来源不明的文件（上一轮 build 的残留、临时产物）
 *      都会被指出来，而不只是 `.import` 这一种。
 *
 * ## 它凭什么会红
 *
 * | 断言 | 退回什么写法会红 |
 * |---|---|
 * | `public/` 里没有 `.import` | 把 Godot 项目里的 `*.import` 拷回 `public/` → 红 |
 * | `dist/` 里没有 `.import` | 同上（build 之后）→ 红 |
 * | `public/` 每个文件都在 `dist/` 里且字节数相同 | 改 `vite.config` 的 `publicDir` → 红 |
 * | `dist/` 里除 build 产物外没有多余文件 | 往 `dist/` 塞临时文件 → 红 |
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, type CheckFn } from './harness';

/** 已知会混进产物的本地垃圾。Godot 的导入桩：web 构建里毫无用处。 */
const JUNK_SUFFIX = '.import';

/**
 * `dist/` 里**不是**从 `public/` 拷来的那些文件。
 *
 * · `assets/` —— vite 打包出来的 JS/CSS
 * · `index.html` —— vite 生成的入口
 * · `submission/` —— 提交页（`tools/build-submission.mjs` 拷的，不来自 `public/`）
 *
 * 除它们之外，`dist/` 里的每个文件都必须在 `public/` 里有一个同名同大的原件。
 */
const BUILD_OUTPUTS = ['assets', 'index.html', 'submission'];

/**
 * 递归列出目录里的文件（相对路径用 `/` 分隔，跨平台可比）。
 *
 * `root` **必须一直是最初那个目录**：递归时如果拿子目录当新的 root，
 * 子目录里的文件就会丢掉前缀（`models/bicycle.glb` 变成 `bicycle.glb`），
 * 于是"public/ 的文件有没有进 dist/"这条比对全线对不上。
 */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(root, p).split(sep).join('/'));
    }
  };
  walk(root);
  return out;
}

/**
 * 文件大小。**读不到返回 -1**，而不是 0——
 * "这个文件不在"和"这个文件是空的"必须分得开（0 字节的产物是可能的）。
 */
function sizeOf(abs: string): number {
  try {
    return statSync(abs).size;
  } catch {
    return -1;
  }
}

export function registerDistChecks(check: CheckFn): void {
  check('verify_dist_clean', () => {
    let asserts = 0;
    const probs: string[] = [];
    const cwd = process.cwd();
    const publicDir = join(cwd, 'public');
    const distDir = join(cwd, 'dist');

    // ---- 1. public/ 里不许有本地垃圾 ----
    asserts++;
    const publicFiles = listFiles(publicDir);
    const junkInPublic = publicFiles.filter((f) => f.endsWith(JUNK_SUFFIX));
    if (junkInPublic.length) {
      probs.push(
        `public/ 里有 ${junkInPublic.length} 个 ${JUNK_SUFFIX} 桩（${junkInPublic[0]} 等）`
        + ' —— 它们会被 vite 原样拷进 dist/ 发到网上，删掉再 build',
      );
    }

    // ---- 2. 反空跑：public/ 确实扫到了东西 ----
    //
    // 没有这条，"public/ 是空的"和"public/ 干净"看起来一模一样——
    // 而空跑是最难发现的失效（`verify_text_encoding` 里同一个道理）。
    asserts++;
    if (!publicFiles.length) {
      probs.push('public/ 一个文件都没扫到 —— 这条判据在空跑');
    }

    // ---- 3. dist/ 存在且扫到了东西 ----
    asserts++;
    const distFiles = listFiles(distDir);
    if (!distFiles.length) {
      probs.push('dist/ 不存在或没有产物，先 npm run build（这条判据量的是实际发出的东西）');
    }

    // ---- 4. dist/ 里不许有本地垃圾 ----
    asserts++;
    const junkInDist = distFiles.filter((f) => f.endsWith(JUNK_SUFFIX));
    if (junkInDist.length) {
      probs.push(
        `dist/ 里有 ${junkInDist.length} 个 ${JUNK_SUFFIX} 桩（${junkInDist[0]} 等）`
        + ' —— 它们会被发到网上，删掉 public/ 里的原件再 build',
      );
    }

    // ---- 5. public/ 的每个文件都原样进了 dist/ ----
    asserts++;
    const missing: string[] = [];
    const resized: string[] = [];
    for (const f of publicFiles) {
      const inDist = sizeOf(join(distDir, f));
      if (inDist === -1) {
        missing.push(f);
        continue;
      }
      if (inDist !== sizeOf(join(publicDir, f))) resized.push(f);
    }
    if (missing.length) {
      probs.push(
        `public/ 里的 ${missing.length} 个文件没进 dist/（${missing[0]} 等）`
        + ' —— vite 的 publicDir 被改过了？',
      );
    }
    if (resized.length) {
      probs.push(
        `public/ 里有 ${resized.length} 个文件进了 dist/ 但大小对不上（${resized[0]} 等）`
        + ' —— 拷贝过程动了内容',
      );
    }

    // ---- 6. dist/ 里除 build 产物外，没有多余的文件 ----
    //
    // 这条比前五条更一般：它不认"哪种扩展名是垃圾"，
    // 只问「这个文件是从 public/ 来的吗」。于是上一轮 build 的残留、
    // 手滑拷进去的临时文件，全都会被指出来。
    asserts++;
    const extra = distFiles.filter((f) => {
      if (BUILD_OUTPUTS.includes(f) || BUILD_OUTPUTS.some((b) => f.startsWith(`${b}/`))) return false;
      return !publicFiles.includes(f);
    });
    if (extra.length) {
      probs.push(
        `dist/ 里有 ${extra.length} 个既不是 build 产物、也不来自 public/ 的文件`
        + `（${extra[0]} 等）—— 删掉再 build`,
      );
    }

    const detail = probs.length
      ? probs.join('；')
      : `public/ ${publicFiles.length} 个文件全部原样进了 dist/（${distFiles.length} 个），无本地垃圾`;
    return expect(probs.length === 0, detail, asserts);
  });
}
