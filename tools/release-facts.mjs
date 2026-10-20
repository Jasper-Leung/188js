/**
 * 公开数字的**唯一出处**。
 *
 * ## 它治的是哪一种病
 *
 * 这个项目里有一类反复发生的失败：加一个功能 → 回归从 124 条变成 125 条
 * → 于是**好几个文件**里写着的那几处「124 条 / 4197 条断言」全都不对了。
 * 而「不对了」这件事是**安静**的：没有断言会红，没有异常，控制台一个字都不报。
 * 第一次发现它的时候，`README.md` 写着 57 条 / 829 条断言，
 * `README.zh-CN.md` 写着 88 条 / 1424 条断言，
 * `.github/release-body.md` 写着 116 条 / 3774 条断言——
 * **三个文件，三个数，都是旧的，而且全绿。**
 *
 * 病根不是"忘了改"，是**同一件事被抄了三遍**。
 * 抄三遍的东西必然抄不齐，所以治法不是"记得改"（那是流程，不是机制），
 * 而是**只留一份**。
 *
 * ## 因此有了这个文件
 *
 * `docs/release-facts.md` 是**唯一**写着这些数字的地方。
 * 别处一律指向它：
 *
 *   · `README.md` / `README.zh-CN.md` → 指向它
 *   · `.github/release-body.md`（直接发到 GitHub Release 页面）→ 指向它
 *   · `AGENTS.md` → 指向它
 *   · `docs/v1.0.2-validation.md` → 指向它
 *   · 提交页 `submission/index.html` → 由构建**自动填**（`data-cfg`）
 *
 * 而"别处不许再写一遍"这件事不是靠自觉，是靠
 * `tools/verify-all.mjs` 里的那道门（`checkNoDuplicatedFacts()`）。
 *
 * ## 它是生成的，不是手写的
 *
 * 手写的单一来源仍然会漂——只是从"漂三个文件"变成"漂一个文件"。
 * 所以这一份由 `npm run facts` 生成（`verify-all.mjs --write-facts`），
 * 而门会拿它和**这一轮真实跑出来的**数对账。
 *
 * 生成物必须**稳定**：同样的代码跑两次要得到**逐字节相同**的文件，
 * 否则每跑一次 verify 都会脏一次工作区。所以这里不写时间戳、不写机器名。
 *
 * 用法：
 *   node tools/verify-all.mjs --write-facts   # 由回归跑完后写出这一份
 *   node tools/release-facts.mjs               # 只打印当前真实值（不给任何人用）
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 那一份文件。相对仓库根。 */
export const FACTS_REL = join('docs', 'release-facts.md');

/**
 * 事实键。
 *
 * **键名是机器读的**，所以它必须稳定——改一个键名等于让全世界的引用失效。
 * 表里的「含义」列是给人看的，可以改。
 */
export const FACT_ORDER = [
  ['version', '版本'],
  ['checks', '回归条数'],
  ['asserts', '断言条数'],
  ['entry_lines', '`src/verify/entry.ts` 行数'],
  ['i18n_keys', '文案键数（每种语言）'],
  ['js_raw_kb', 'JS 原始体积（KB）'],
  ['js_gzip_kb', 'JS gzip 体积（KB）'],
  ['css_raw_kb', 'CSS 原始体积（KB）'],
  ['css_gzip_kb', 'CSS gzip 体积（KB）'],
  ['payload_raw_mb', '游戏本体原始体积（MB）'],
  ['payload_gzip_mb', '游戏本体 gzip 体积（MB）'],
  ['models_mb', '模型合计（MB）'],
  ['model_count', '模型文件数'],
  ['audio_mb', '音频合计（MB）'],
  ['dist_total_mb', '整个 `dist/` 体积（MB，含提交页）'],
];

/** 需要 `dist/` 才有值的键。`dist/` 不在时它们写 `—`。 */
const DIST_KEYS = new Set([
  'js_raw_kb',
  'js_gzip_kb',
  'css_raw_kb',
  'css_gzip_kb',
  'payload_raw_mb',
  'payload_gzip_mb',
  'models_mb',
  'model_count',
  'audio_mb',
  'dist_total_mb',
]);

const kb = (bytes) => (bytes / 1024).toFixed(0);
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2);

/** 递归量一个目录。`skip` 里的顶层名字不计入。 */
function dirBytes(dir, skip = new Set()) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = join(dir, e.name);
    total += e.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return total;
}

/** `dist/assets/` 里的那一个 JS / CSS。 */
function assetOf(ext) {
  const dir = join(ROOT, 'dist', 'assets');
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir).find((f) => f.endsWith(ext));
  if (!hit) return null;
  return join(dir, hit);
}

/**
 * 从仓库里能直接读出来的那些事实。**不依赖 `dist/`。**
 */
export function repoFacts() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const i18n = JSON.parse(
    readFileSync(join(ROOT, 'src', 'data', 'generated', 'i18n.json'), 'utf8'),
  );
  const entry = readFileSync(join(ROOT, 'src', 'verify', 'entry.ts'), 'utf8');
  return {
    version: pkg.version,
    // 每种语言的键数取**中英两边的较小值**——两边不一致时，
    // 真正的"可对照条目数"是小的那个，报大的那个会骗人。
    i18n_keys: String(Math.min(Object.keys(i18n.zh || {}).length, Object.keys(i18n.en || {}).length)),
    // 按 `split('\n').length` 计——不能用只计非空行的工具（AGENTS.md §3）。
    entry_lines: String(entry.split('\n').length),
  };
}

/**
 * 从 `dist/` 量出来的那些事实。
 *
 * **产物没有时返回空**，而不是 0——「没量到」和「真的是 0」必须分得开。
 */
export function distFacts() {
  const dist = join(ROOT, 'dist');
  if (!existsSync(dist)) return null;
  const js = assetOf('.js');
  const css = assetOf('.css');
  const out = {};
  if (js) {
    const buf = readFileSync(js);
    out.js_raw_kb = kb(buf.length);
    out.js_gzip_kb = kb(gzipSync(buf).length);
  }
  if (css) {
    const buf = readFileSync(css);
    out.css_raw_kb = kb(buf.length);
    out.css_gzip_kb = kb(gzipSync(buf).length);
  }
  // 游戏本体 = 整个 dist/ 去掉提交页那一坨。
  const payloadBytes = dirBytes(dist, new Set(['submission']));
  out.payload_raw_mb = mb(payloadBytes);
  out.payload_gzip_mb = mb(gzipTree(dist, new Set(['submission'])));
  out.models_mb = mb(dirBytes(join(dist, 'models')));
  // 模型**个数**也会随"加一个模型"变——而它常常和体积一起出现在同一张表里。
  const modelsDir = join(dist, 'models');
  out.model_count = existsSync(modelsDir)
    ? String(readdirSync(modelsDir).filter((f) => f.endsWith('.glb')).length)
    : '—';
  out.audio_mb = mb(dirBytes(join(dist, 'audio')));
  out.dist_total_mb = mb(dirBytes(dist));
  return out;
}

/** 递归量一个目录的 gzip 体积。 */
function gzipTree(dir, skip = new Set()) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = join(dir, e.name);
    total += e.isDirectory() ? gzipTree(p) : gzipSync(readFileSync(p)).length;
  }
  return total;
}

/**
 * 这一轮的真实值。
 *
 * @param checks  这一轮跑过的回归条数
 * @param asserts 这一轮累计的断言条数
 */
export function computeFacts(checks, asserts) {
  const facts = { ...repoFacts() };
  facts.checks = String(checks);
  facts.asserts = String(asserts);
  const d = distFacts();
  for (const k of DIST_KEYS) facts[k] = d && d[k] !== undefined ? d[k] : '—';
  return facts;
}

/** 把事实渲染成那份文件。**逐字节稳定**——同样的输入必须得到同样的输出。 */
export function renderFacts(facts) {
  const rows = FACT_ORDER.map(([k, label]) => {
    const v = facts[k] ?? '—';
    return `| \`${k}\` | ${label} | \`${v}\` |`;
  }).join('\n');
  return `# 发布数字 / Release facts

<!--
  本文件由 \`npm run facts\` 生成（\`tools/verify-all.mjs --write-facts\`）。
  **请勿手改** —— 改了会被 \`npm run verify\` 的 [DOC] 门判红，
  因为门会拿它和这一轮真实跑出来的数对账。

  为什么要单独一份：以前同一个数字散在 README、README.zh-CN、
  release-body、AGENTS.md 和提交页里，加一个功能要改五处，
  而漏改任何一处都不会有人知道。改成**只留这一份**之后，
  改一个功能只需要重新生成这一个文件。

  **两类数，两种判法**（[DOC] 门照这个判）：

  · 语义值 —— 版本、回归条数、断言条数、键数、模型个数。
    **逐字校对**：代码变了它们就得跟着变，一个字都不能差。

  · 测量值 —— 体积类（带 KB / MB 的那些）。
    允许一点**构建环境噪声**：同一份源码在不同机器上构建，
    字节数可能差几 KB（压缩库版本、本地工作区里多出来的未跟踪文件）。
    容差是 ±0.02MB / ±2KB —— 比真实改动小两三个数量级，
    又比已知噪声大一倍以上。
-->

| 键 | 含义 | 值 |
|---|---|---|
${rows}

其余的公开数字（各别模型的大小、录屏时长、字体子集大小等）
是**资产自身的事实**，不随功能变，所以仍然留在各自的文档里。

看数字的人只需要看这一份；别处请指向它。
`;
}

/** 读回那份文件里的事实。读不出来就是读不出来，不猜。 */
export function parseFacts(text) {
  const facts = {};
  for (const line of text.split('\n')) {
    // 键名里可能有数字（`i18n_keys`），所以字符类不能只收字母。
    const m = /^\|\s*`([a-z0-9_]+)`\s*\|[^|]*\|\s*`([^`]*)`\s*\|/.exec(line);
    if (m) facts[m[1]] = m[2];
  }
  return facts;
}

/**
 * 对账：文件里写的 vs 这一轮真实跑出来的。
 *
 * ## 两类数，两种判法
 *
 * · **语义值**（`version` / `checks` / `asserts` / `entry_lines` / `i18n_keys` /
 *   `model_count`）—— **逐字校对**。这些是"抄错就会算错"的数：
 *   回归从 125 条变成 124 条，是代码变了，文件必须跟着变，一个字都不能差。
 *
 * · **测量值**（体积类）—— 允许一个**窄容差**。
 *   理由是它们量的不是"仓库里写了什么"，而是"构建出来是多少字节"，
 *   而后者在同一份源码上**不一定逐字节相同**：
 *   压缩库版本不同、本地工作区里多出来几个未跟踪文件（2026-10-20 那次
 *   就是 17 个 Godot 的 `.import` 桩，6,698 字节），都会让结果差几 KB。
 *   一道会被几 KB 噪声打红的门，久了就只会被绕过——那比没有门更坏。
 *
 * 容差取 `*_mb` 差 ≤ 0.02MB（≈21KB）、`*_kb` 差 ≤ 2KB：
 * 都比"真实改动"小两三个数量级（加一个功能是 MB 级），
 * 又比已知的环境噪声大一倍以上。
 *
 * @returns {string[]} 不一致的地方。空数组 = 对得上。
 */
export function compareFacts(written, real) {
  const probs = [];
  for (const [k, label] of FACT_ORDER) {
    const said = written[k];
    if (said === undefined) {
      probs.push(`\`${k}\`（${label}）这一行不在 \`${FACTS_REL}\` 里`);
      continue;
    }
    const got = real[k];
    if (said === got) continue;
    if (!isMeasured(k)) {
      probs.push(`\`${k}\`（${label}）写的是 ${said}，实际 ${got}`);
      continue;
    }
    // 测量值：先分清"没量到"和"量歪了"。
    if (got === '—') {
      probs.push(
        `\`${k}\`（${label}）写的是 ${said}，这一轮**没量到**`
        + '（dist/ 不存在？先 npm run build）',
      );
      continue;
    }
    const a = Number(said);
    const b = Number(got);
    const tol = toleranceOf(k);
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol) continue;
    probs.push(
      `\`${k}\`（${label}）写的是 ${said}，实际 ${got}`
      + `（差 ${(Math.abs(a - b) ?? 0).toFixed(3)}，容差 ${tol}）`,
    );
  }
  return probs;
}

/** 这个键是测量值吗（体积类）。语义值一律逐字校对。 */
function isMeasured(key) {
  return key.endsWith('_mb') || key.endsWith('_kb');
}

/** 测量值的容差。 */
function toleranceOf(key) {
  return key.endsWith('_mb') ? 0.02 : 2;
}

// ---------------------------------------------------------------- 公开文档不许再写一遍

/**
 * 会被扫的公开文档。
 *
 * **历史档案不在里面**：`REVIEW-*.md` / `PLAN*.md` / `docs/lessons-archive.md` /
 * `docs/ui-*.md` 记的是"当时错在哪"，它们身上带着旧数字**恰恰是它们的用途**。
 * 把它们也扫进来，就等于要求历史档案永远跟着当前基线改——那会毁掉它们。
 */
export const PUBLIC_DOCS = [
  'README.md',
  'README.zh-CN.md',
  'AGENTS.md',
  'index.html',
  join('.github', 'release-body.md'),
  join('submission', 'index.html'),
  join('submission', 'README.md'),
  join('docs', 'v1.0.2-validation.md'),
];

/**
 * 不许在公开文档里出现的数字形状。
 *
 * 每一条都只针对**会随功能变**的那几类量：回归条数、断言条数、
 * 文案键数、包体与 bundle 体积。**资产自身的大小不在这张表里**——
 * `bicycle.glb` 是 2.79 MB，那是资产的事实，不会因为加一个功能而变。
 */
const FORBIDDEN = [
  {
    re: /\b\d+\s*(?:checks?|suites?|assertions?)\b/gi,
    why: '回归条数 / 断言条数',
  },
  {
    re: /\bPASS\s+\d+/gi,
    why: '回归结果',
  },
  {
    re: /\d+\s*条\s*\/\s*\d+\s*条?断言/g,
    why: '回归条数 / 断言条数',
  },
  {
    re: /\d+\s*条断言/g,
    why: '断言条数',
  },
  {
    re: /\d+\s*条回归/g,
    why: '回归条数',
  },
  {
    re: /\b\d{3,}[-\s]*(?:i18n[-\s]+)?(?:keys?|strings?)\b/gi,
    why: '文案键数',
  },
  {
    // 中文那边的说法有好几种：「N 条文案」「N 条 key」「N 条中英一致」
    // 「N 个 key」「N 条每种语言」。这里**列全**，因为漏一种就等于留一个后门。
    re: /\d{3,}\s*条\s*(?:文案|key|每种语言|中英|两侧|一侧)/gi,
    why: '文案键数',
  },
  {
    re: /\d{3,}\s*个\s*(?:key|键)/gi,
    why: '文案键数',
  },
  {
    re: /\d{3,}\s*键/g,
    why: '文案键数',
  },
  {
    // 包体与 bundle 体积：只认**带标签**的那几处，
    // 因为别处的 MB（某个模型多大、录屏母版多大）是资产事实。
    re: /(?:JS\s*(?:bundle|包)|总\s*JS)[^\n]{0,40}?\d+(?:\.\d+)?\s*(?:KB|MB)/gi,
    why: 'JS 体积',
  },
  {
    re: /\|\s*CSS\s*\|[^\n]*?\d+(?:\.\d+)?\s*(?:KB|MB)/gi,
    why: 'CSS 体积',
  },
  {
    re: /(?:Total artifact|总体积|游戏包|产物合计|整个\s*dist)[^\n]{0,40}?\d+(?:\.\d+)?\s*MB/gi,
    why: '包体体积',
  },
  {
    re: /首屏[^\n]{0,40}?\d+(?:\.\d+)?\s*(?:KB|MB)/gi,
    why: '首屏体积',
  },
];

/**
 * 扫一遍公开文档，看有没有人又把那些数字写了一遍。
 *
 * @returns {string[]} 违规的地方。空数组 = 没有重复。
 */
export function checkNoDuplicatedFacts() {
  const probs = [];
  for (const rel of PUBLIC_DOCS) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    const lines = text.split('\n');
    for (const [i, line] of lines.entries()) {
      for (const f of FORBIDDEN) {
        f.re.lastIndex = 0;
        const m = f.re.exec(line);
        if (!m) continue;
        probs.push(
          `${rel}:${i + 1} 写了「${m[0].trim()}」（${f.why}）`
          + ` —— 那是会随功能变的数，唯一出处是 \`${FACTS_REL}\``,
        );
        break;
      }
    }
  }
  return probs;
}

/** 写那一份文件。 */
export function writeFacts(facts) {
  const p = join(ROOT, FACTS_REL);
  writeFileSync(p, renderFacts(facts), 'utf8');
  return p;
}

// 直接跑这个文件时，打印当前真实值（不给任何人用，只是看一眼）。
if (process.argv[1] && process.argv[1].endsWith('release-facts.mjs')) {
  const f = computeFacts('?', '?');
  console.log(f);
  console.log(relative(ROOT, join(ROOT, FACTS_REL)));
}
