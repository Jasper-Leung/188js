/**
 * 交付族：提交页 / 资产源 / 文本编码。
 *
 * ## 为什么它从 `entry.ts` 里搬出来
 *
 * 四条判据有一个共同点：**它们量的不是运行时，是交付出去的东西。**
 * 提交页是评委唯一直接看到的页面，自行车源在不在版本库里，
 * 源码里有没有 U+FFFD，湖边场景那块地形有没有被换成没裁过的整条山谷——
 * 这四条坏了构建不报错、CI 不报错，
 * 只有真正去 clone、去点开、去读注释的人才会撞上。
 * 把它们和 ride / 场景那几族混在一个 9,400 行的文件里，
 * 「改游戏」和「验收游戏」就再也分不开了。
 *
 * ## 为什么是「导出 register 函数」而不是「模块顶层就 check」
 *
 * **因为 ESM 的 import 会被提升。** 如果这里在模块顶层直接 `check(...)`，
 * 它会在 `entry.ts` 的任何一行之前全部注册，于是**注册顺序变了**。
 * 而 `entry.ts` 里 `verify_toast_reply` 的注释写死了这件事有语义：
 * 「判据按注册顺序跑，谁先装上 DOM 桩后面那条就会拿到残桩」。
 *
 * 所以这一族导出 `registerDeliveryChecks(check)`，由 `entry.ts` 在**原来的位置**调用一次。
 * 顺序因此逐字不变，搬移对判据而言不可见。
 *
 * ## 依赖口径
 *
 * 这一族只用到 `node:fs` / `node:path`、`@gltf-transform`（只有湖边那条要，
 * 用来解 meshopt 量真实包围盒）、`./submission` 的 `assertSubmission`，
 * 以及 `./harness` 的 `expect`。`entry.ts` 里其余的 `existsSync` /`statSync` /
 * `readdirSync` / `sep` 在别处仍被大量使用，**那些 import 一行都没动**——
 * 搬走的只有 `extname` 与 `assertSubmission` 这两个仅此一族在用的符号。
 *
 * 搬移的验收口径：**`npm run verify` 的条数与断言数一条都不许变**。
 * 少一条就是漏搬了——这是唯一能证伪「机械搬移」的东西。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { assertSubmission } from './submission';
import { expect, type CheckFn } from './harness';

/**
 * 湖边场景模型的量法 —— 只为 `verify_lakeside` 服务。
 *
 * ## 为什么这里自己读，而不是复用 `entry.ts` 的 `readGlbGeometry`
 *
 * 因为**把判据写进 `registerDeliveryChecks` 内部，`entry.ts` 一行都不用动**，
 * 而 AGENTS.md §3 明确写着「等本批在途改动提交之前不要动 `entry.ts` 的结构」。
 * `readGlbGeometry` 住在 `entry.ts` 里，而这一族只拿得到 `check`，
 * 搬它就等于动 `entry.ts`。抄一份进来代价更小。
 *
 * ## 顶层 await 为什么在这儿
 *
 * `check()` 只收**同步**返回值，而 `NodeIO.read()` 是异步的。
 * `entry.ts` 处理 meshopt 时用的就是同一个办法（顶层 `await MeshoptDecoder.ready`），
 * 这里只是再往前一步：顶层把文件读完，`verify_lakeside` 里全是同步断言。
 */
const LAKESIDE_REL = join('public', 'models', 'lakeside.glb');

type LakesideStats = {
  tris: number;
  verts: number;
  images: number;
  semantics: string[];
  meshopt: boolean;
  unlit: boolean;
  bytes: number;
  /** 逐分量统计；非有限值另计 */
  finite: boolean;
  size: [number, number, number];
  min: [number, number, number];
};

let lakesideStats: LakesideStats | null = null;

if (existsSync(join(process.cwd(), LAKESIDE_REL))) {
  const { NodeIO } = await import('@gltf-transform/core');
  const { EXTMeshoptCompression, KHRMaterialsUnlit } = await import('@gltf-transform/extensions');
  const { MeshoptDecoder: GltfMeshopt } = await import('meshoptimizer');
  await GltfMeshopt.ready;
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMaterialsUnlit])
    .registerDependencies({ 'meshopt.decoder': GltfMeshopt });
  const doc = await io.read(join(process.cwd(), LAKESIDE_REL));
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  const posAcc = prim.getAttribute('POSITION');
  // strict 模式下 `getAttribute` 返回 `Accessor | null`。这里是模块顶层的量测，
  // 抛比吞掉好——它坏掉意味着文件根本不是一个可渲染的网格。
  if (!posAcc) throw new Error('verify_lakeside: lakeside.glb 的 primitive 上没有 POSITION');
  const raw = posAcc.getArray();

  /**
   * ⚠ **必须乘回节点缩放。**
   *
   * meshopt 把 16 位定点量化的 scale / translation 放在**节点**上，
   * accessor 本身是 [-1, 1] 的归一化值。直接拿 accessor 当米读，
   * 量出来会是一个对称的 ±128m 盒子——而文件其实完全正常。
   * 这和 `verify_station_models` 注释里记的是同一个坑（那里是 meshopt 没解码，
   * 这里是漏乘节点变换），两处都栽过一次，所以这一条在此钉死。
   */
  const node = doc.getRoot().listNodes().find((n) => n.getMesh() != null);
  const ns = node ? node.getScale() : [1, 1, 1];
  const nt = node ? node.getTranslation() : [0, 0, 0];
  const den = posAcc.getComponentType() === 5122 ? 32767 : posAcc.getComponentType() === 5123 ? 65535 : 1;

  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let finite = true;
  for (let i = 0; i < posAcc.getCount(); i++) {
    for (let k = 0; k < 3; k++) {
      const v = raw[i * 3 + k] / den * ns[k] + nt[k];
      if (!Number.isFinite(v)) { finite = false; continue; }
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }

  lakesideStats = {
    tris: prim.getIndices()!.getCount() / 3,
    verts: posAcc.getCount(),
    images: doc.getRoot().listTextures().length,
    semantics: [...prim.listSemantics()].sort(),
    meshopt: (doc.getRoot().listExtensionsUsed() as { extensionName?: string }[])
      .some((e) => e?.extensionName === 'EXT_meshopt_compression'),
    unlit: prim.getMaterial()!.getExtension('KHR_materials_unlit') != null,
    bytes: statSync(join(process.cwd(), LAKESIDE_REL)).size,
    finite,
    size: [0, 1, 2].map((k) => hi[k] - lo[k]) as [number, number, number],
    min: lo,
  };
}

/** 由 `entry.ts` 在原位调用一次，见文件头「为什么是导出函数」。 */
export function registerDeliveryChecks(check: CheckFn): void {
  // ------------------------------------------------------- 参赛提交页
  /**
   * 提交页是唯一直接给评委看的东西，而它的失效全是静默的：
   * 链接打错、媒体没跟仓库走、页面混进一句游戏里其实没有的卖点。
   *
   * 判据写在 `src/verify/submission.ts`（单独一个文件是因为它读的是**源码目录**
   * 而不是运行时数据，和 ride 那条一样该有自己的说明）。
   */
  check('verify_submission', () => assertSubmission());

  /**
   * 关键路径上的资产，源必须在仓库里。
   *
   * ## 它守的是哪一族
   *
   * 自行车是**玩家第一眼看到的东西**，也落在首屏关键路径上。
   * 它的源本来在 `D:/code/20261001/modelbone/…`，不提交，于是：
   *
   * · 干净克隆跑不了 `assets:all`（真正的原因不是"管线坏了"，是"输入不在"）；
   * · README 资产表里 `22.3MB → 5.0MB` 那一行**没有任何东西可以对照**——
   *   而它实际上压到的是 2.79MB，比承诺值大 3.4 倍，多年没人发现，
   *   因为**验证它的那条管线在干净克隆上报成功**。
   *
   * 把它收进 `assets-src/` 之后，上面第一、二条才成立。
   *
   * ## 为什么判的是"存在 + 指向正确"，而不是"跑一遍管线"
   *
   * 跑管线要 20MB 的读 + 两趟重编码，在每一条回归里做一遍不划算，
   * 而且它验的是当次结果、不是"下一个克隆能不能重跑"。
   * 不变式是那条**永久的**事实：**这个文件在版本库里，且清单指向它**。
   *
   * 顺带钉一个数量级：源必须明显大于产物。真压缩过一轮的 GLB
   * 不会比它的源更大——两者反过来就说明指错了文件，
   * 而"指错文件"的症状是压出来一台**轮子不转**的车（见 assets-src/README.md）。
   *
   * 会红的做法：
   *   · 从版本库删掉 `assets-src/vehicles/bicycle_clean.glb`   → 红
   *   · 把清单里那一项改回 `SRC_VEHICLE`                        → 红
   *   · 把某个几 KB 的占位文件放在那个路径上                     → 红（数量级）
   */
  check('verify_assets_src', () => {
    let asserts = 0;
    const probs: string[] = [];

    const SRC_REL = join('assets-src', 'vehicles', 'bicycle_clean.glb');
    const OUT_REL = join('public', 'models', 'bicycle.glb');
    const srcPath = join(process.cwd(), SRC_REL);
    const outPath = join(process.cwd(), OUT_REL);

    // 1. 源在，而且是一个**真的高模**，不是占位文件。
    asserts++;
    let srcBytes = 0;
    if (!existsSync(srcPath)) {
      probs.push(`${SRC_REL} 不在仓库里 —— 干净克隆压不出自行车，而它在首屏关键路径上`);
    } else {
      srcBytes = statSync(srcPath).size;
      // 184,433 面 + 21 张贴图实际是 21.5MB。给一个 20MB 的地板：
      // 低了说明被换成了占位文件或者半截导出。
      if (srcBytes < 20 * 1024 * 1024) {
        probs.push(`${SRC_REL} 只有 ${(srcBytes / 1048576).toFixed(2)}MB —— 那不是 184,433 面那台车（应该 ≈21.5MB）`);
      }
    }

    // 2. 产物在。
    asserts++;
    if (!existsSync(outPath)) {
      probs.push(`${OUT_REL} 不在 —— 游戏缺车`);
    }

    // 3. 源必须明显大于产物：这是"指对了文件"的反向证据。
    asserts++;
    if (srcBytes > 0 && existsSync(outPath)) {
      const outBytes = statSync(outPath).size;
      if (srcBytes <= outBytes) {
        probs.push(
          `源（${(srcBytes / 1048576).toFixed(2)}MB）没有比产物（${(outBytes / 1048576).toFixed(2)}MB）大 —— ` +
            `清单多半指到了别的地方。压过一轮的 GLB 不可能比它的源更大`,
        );
      }
    }

    // 4. 清单里自行车那一项指向仓库内，不是仓库外。
    asserts++;
    {
      const src = readFileSync(join(process.cwd(), 'tools', 'extra-models.mjs'), 'utf8');
      // 只看那一条：'bicycle_clean.glb' 开头的数组项。
      const entry = src.match(/\[\s*'bicycle_clean\.glb'[^\]]*\]/)?.[0] ?? '';
      if (!entry) {
        probs.push("extra-models.mjs 里找不到 ['bicycle_clean.glb', …] 这一项 —— 自行车不在清单里");
      } else if (!/SRC_INREPO/.test(entry)) {
        probs.push(`自行车那一项没有指向 SRC_INREPO（现在是：${entry}）—— 干净克隆压不出它`);
      }
      // 外部那份车模还在被引用是正常的（GIFT188_SRC_EXTRA），但要留着注释提醒。
      asserts++;
      if (!/别和\s*`?D:\/code\/20260926/.test(src)) {
        probs.push('extra-models.mjs 里丢了「别和 D:/code/20260926 那台下载的车搞混」的提醒 —— 它和 SRC_BIKE 指向同一个文件名前缀，极易接错');
      }
    }

    return expect(
      probs.length === 0,
      probs.length
        ? probs.join('；')
        : `自行车源在仓库内（${(srcBytes / 1048576).toFixed(2)}MB → ${(existsSync(outPath) ? (statSync(outPath).size / 1048576).toFixed(2) : '?')}MB），清单指向它`,
      asserts,
    );
  });

  // ---------------------------------------------------------- 湖边场景模型
  /**
   * `public/models/lakeside.glb` —— 由 Marble 的 HQ mesh 裁出来的一块湖岸。
   *
   * ## 它为什么值得单列一条
   *
   * 这个文件**不是从仓库里的源生成的**：源在仓库之外（Marble 的 HQ 导出，
   * 100~200MB），`tools/lakeside-scene.mjs` 靠 `--src` / `GIFT188_SRC_LAKESIDE` 读。
   * 于是 `verify_assets_src` 那条「源必须在仓库里」的口径套不到它身上——
   * 不套是对的，143MB 不该进版本库。但代价是**这份资产从此没有上游**：
   * 谁都可以把它换掉、换小、换成没裁过的整条山谷，而没有任何东西会响。
   *
   * ## 它守的六条全是「换掉才会红」
   *
   * · **零贴图** —— 图集 8192² 是 86MB。带上它，这一个文件比全站其余资产加起来还大。
   * · **`COLOR_0` 在** —— 贴图删了而顶点色没烘进去，它会退成一块单色体积。
   * · **`NORMAL` 在** —— `--lit` 时它接的是 `MeshStandardMaterial`，缺法线就没有平滑光照。
   *   这条**曾经真的红过**：`prune()` + `dedup()` 会静默删掉它。
   * · **meshopt 在** —— 和九座 Tripo 建筑同一条硬约束。
   * · **面数 / 体积有上限** —— 裁剪框放大是最容易犯的"顺手改一下"。
   * · **包围盒在预算内** —— 这条是专门防「把没裁过的整条山谷直接丢进来」的：
   *   那份源是 1022 × 1493 m、峰顶 509 m，而本项目全世界只有 800 × 800 m、
   *   `TERRAIN.MAX_HEIGHT = 25 m`。一个 1.5km 的湖岸摆在 800m 的世界里，
   *   没有任何几何断言会响，只有玩家看得见。
   *
   * ## 会红的做法
   *   · `--crop` 后面漏了边长、把整片场地切进来               → 红（包围盒）
   *   · 在 bake 之后忘了 `setAttribute('TEXCOORD_0', null)`    → 红（零贴图）
   *   · 把法线的重算挪回 `simplify()` 之前                     → 红（NORMAL）
   *   · 直接把 Marble 的 HQ mesh 复制进 `public/models/`       → 红（面数 + 包围盒）
   */
  check('verify_lakeside', () => {
    let asserts = 0;
    const probs: string[] = [];
    const where = LAKESIDE_REL.replace(/\\/g, '/');

    // 1. 文件在
    asserts++;
    if (!lakesideStats) {
      probs.push(`${where} 不在 —— 湖边场景没有地形可用`);
      return expect(false, probs.join('；'), asserts);
    }
    const s = lakesideStats;

    // 2. 零贴图
    asserts++;
    if (s.images > 0) {
      probs.push(`${where} 带着 ${s.images} 张贴图，零贴图是一等约束（配色要烘进顶点色）`);
    }

    // 3. 顶点色在
    asserts++;
    if (!s.semantics.includes('COLOR_0')) {
      probs.push(`${where} 没有 COLOR_0，丢掉贴图之后它会是一块单色体积`);
    }

    // 4. 法线在
    asserts++;
    if (!s.semantics.includes('NORMAL')) {
      probs.push(`${where} 没有 NORMAL —— 平滑光照没了（unlit 时看不出来，--lit 会立刻穿帮）`);
    }

    // 5. meshopt 在
    asserts++;
    if (!s.meshopt) {
      probs.push(`${where} 没有 EXT_meshopt_compression`);
    }

    // 6. 面数上限。当前 98,228；留一半余量给「换个裁剪框」。
    asserts++;
    const MAX_TRIS = 150_000;
    if (s.tris > MAX_TRIS) {
      probs.push(`${where} 有 ${s.tris.toLocaleString()} 面，超出 ${MAX_TRIS.toLocaleString()} 的预算`);
    }

    // 7. 体积上限。当前 1.12MB；`public/models` 其余全部加起来是 17.47MB。
    asserts++;
    const MAX_BYTES = 2 * 1024 * 1024;
    if (s.bytes > MAX_BYTES) {
      probs.push(`${where} 有 ${(s.bytes / 1048576).toFixed(2)}MB，超出 2MB 的预算`);
    }

    // 8. 位置全有限。
    //    这一条是给一次真实事故留的：节点变换算了两遍之后，meshopt 量化时
    //    Int16 打满 ±32767，读回来位置里全是 NaN——而工具一路打印成功。
    asserts++;
    if (!s.finite) {
      probs.push(`${where} 的位置里有 NaN/Inf —— 多半是节点变换算了两遍，meshopt 量化时饱和了`);
    }

    // 9. 包围盒在预算内：水平 ≤400m、竖直 ≤650m。
    asserts++;
    const [sx, sy, sz] = s.size;
    if (sx > 400 || sz > 400) {
      probs.push(`${where} 水平 ${sx.toFixed(0)} × ${sz.toFixed(0)}m，超出 400m —— 裁剪框放太大了`);
    }
    if (sy > 650) {
      probs.push(`${where} 竖直 ${sy.toFixed(0)}m，超出 650m —— 而本项目 TERRAIN.MAX_HEIGHT 只有 25m`);
    }

    return expect(
      probs.length === 0,
      probs.length
        ? probs.join('；')
        : `${s.tris.toLocaleString()} 面 · ${(s.bytes / 1048576).toFixed(2)}MB · `
          + `${sx.toFixed(0)}×${sy.toFixed(0)}×${sz.toFixed(0)}m · 零贴图 + 顶点色 + 法线 + meshopt`
          + `${s.unlit ? ' + unlit' : ''}`,
      asserts,
    );
  });

  // ------------------------------------------------------------ 替换字符
  /**
   * `U+FFFD` 这个码点是"这一段 UTF-8 解不出来"的记号。
   *
   * ## 它是怎么进来的
   *
   * PowerShell / `Set-Content` / 某些编辑器把 UTF-8 当本地代码页写回去，
   * 于是**原字被替换成 U+FFFD，写回文件的是替换字符本身**。
   * 后果不是"某行注释不好看"，而是那一句的意思**永远丢了**——
   * 中文注释里丢一个字，读者拿到的是一句语法都不通的话，
   * 而没有工具会告诉你它坏了，因为它在语法上完全合法。
   *
   * 这一族是**唯一在增长**的：评审第五轮量到 13 处，上一轮 12 处。
   * 两处最该点名：`.gitignore` 整行被洗掉、`tools/i18n-supplement.json`
   * 的 `_override` 说明（那是一个数据文件里的文档字段，而本工程正是靠
   * 这张表的口径在合并源项目文案）。
   *
   * ## 为什么不靠"人肉扫一遍"
   *
   * 扫一遍是一次性动作，下一次乱码落地时它不会响。
   * 变成判据之后它自己会响——这正是 `AGENTS.md` §2 第 1 条要的那种东西。
   *
   * ## 扫描范围
   *
   * `src/**`、`tools/**`、`index.html`、`.gitignore`。
   * **不含** `REVIEW-*.md`：那是记录"当时错在哪"的历史档案，
   * 它自己身上带着旧缺陷恰恰是它的用途（第四轮那一份就是这么写的）。
   *
   * ## 会红的做法
   *   · 在 `src/` 任何文件里写一个 `U+FFFD`（哪怕在注释里）  → 红
   *   · 把某个源文件的扩展名从 `FFFD_EXT` 里删掉            → 红（扫不到 = 没在扫）
   */
  const FFFD_EXT = new Set(['.ts', '.tsx', '.css', '.json', '.html', '.mjs', '.js', '.md']);
  const FFFD_ROOTS = ['src', 'tools', 'index.html', '.gitignore'];
  const FFFD_SKIP = new Set(['node_modules', 'dist', '.git', '.cache', 'target']);

  function walkText(dir: string, out: string[]): void {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.gitignore') continue;
      if (FFFD_SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walkText(p, out);
      else if (FFFD_EXT.has(extname(e.name))) out.push(p);
    }
  }

  check('verify_text_encoding', () => {
    let asserts = 0;
    const probs: string[] = [];
    const cwd = process.cwd();
    const files: string[] = [];
    for (const r of FFFD_ROOTS) walkText(join(cwd, r), files);

    // 1. 扫描范围本身必须是活的：源文件一个都不许漏。
    //    有人把某个目录从 FFFD_ROOTS 里拿掉、或者把扩展名从 FFFD_EXT 里拿掉，
    //    这个断言会立刻发现"扫的文件比工程少"——空跑是最难发现的失效。
    asserts++;
    if (files.length < 80) {
      probs.push(`只扫到 ${files.length} 个文件 —— 扫描范围被削了，这条判据在空跑`);
    }
    for (const must of ['src/main.ts', 'src/verify/entry.ts', 'tools/i18n-supplement.json']) {
      asserts++;
      if (!files.includes(join(cwd, must).replace(/\\/g, '/')) && !files.includes(join(cwd, must))) {
        probs.push(`没扫到 ${must} —— 它已经不在范围里了`);
      }
    }

    // 2. 逐文件扫。顺带盯一个**结构**问题：文件头有没有 BOM。
    //    带 BOM 的 JSON 能被 JSON.parse 读，但会让"这一行从哪开始"错位一格，
    //    而本工程自己写过一回（AGENTS.md 里记着：写提交信息别用 Set-Content）。
    let hit = 0;
    for (const f of files) {
      const s = readFileSync(f, 'utf8');
      const n = (s.match(/\uFFFD/g) || []).length;
      if (n) {
        hit++;
        const line = s.slice(0, s.indexOf('\uFFFD')).split('\n').length;
        probs.push(`${f.replace(cwd + sep, '').replace(/\\/g, '/')}:${line} 有 ${n} 个 U+FFFD`);
      }
      if (f.endsWith('.json') || f.endsWith('.ts')) {
        asserts++;
        if (s.charCodeAt(0) === 0xfeff) probs.push(`${f.replace(cwd + sep, '').replace(/\\/g, '/')} 带 UTF-8 BOM`);
      }
    }

    return expect(
      probs.length === 0,
      probs.length ? probs.join('；') : `${files.length} 个文本文件，0 个 U+FFFD、0 个 BOM`,
      asserts,
    );
  });
}
