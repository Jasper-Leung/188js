/**
 * 官网 —— 把 `submission/` 原样拷进 `dist/submission/`，并把
 * `submission/site.json` 里的链接烘进 HTML。
 *
 * 这个仓库本身就是《188号礼物》的官网（兼参赛提交页），所以产物里
 * 根目录是游戏本体、`/submission/` 是这一页。
 *
 * ## 为什么是「拷贝」而不是 Vite 的第二个入口
 *
 * `vite.config.ts` 里 `base: './'`，产物引用全是相对的（GitHub Pages 跑在
 * `/no188-gift-web/` 子路径下，这是刻意的）。于是**任何放在子目录的页面**，
 * 它的 `./assets/xxx.js` 都会被解析到 `<子目录>/assets/`，也就是 404。
 * 把游戏挪进子目录去腾出根位置，会直接把线上打挂。
 *
 * 所以游戏留在 `dist/` 根（它的位置一个字没动），提交页走**不经打包**的路子：
 * 页面自己的 CSS/JS 用普通相对路径引用，谁构建都不碰它。
 * 代价是这几个文件不进 Vite 的哈希与压缩，收益是这一页**换个主机也能直接用**。
 *
 * ## 单一数据源
 *
 * 链接只在 `submission/site.json` 里定义。页面 HTML 里每个用到链接的地方都标了
 * `data-cfg="键名"`，本脚本按 site.json 覆写；`verify_submission` 反过来断言
 * HTML 里的默认值与 site.json 一致。两边不可能悄悄跑偏。
 *
 * 用法：
 *   node tools/build-submission.mjs            # 构建（拷文件 + 烘链接 + 打印清单）
 *   node tools/build-submission.mjs --check    # 只校验 site.json 并打印清单，不写文件
 *   node tools/build-submission.mjs --no-media # 不拷视频（只想看看页面长什么样时用）
 */
import { existsSync, mkdirSync, readFileSync, statSync, copyFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'submission');
const DIST = join(ROOT, 'dist');
const OUT = join(DIST, 'submission');

const argv = new Set(process.argv.slice(2));
const CHECK_ONLY = argv.has('--check');
const NO_MEDIA = argv.has('--no-media');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

/** site.json 允许 `_` 开头的键当注释用（见文件里那些 `_why` / `_media`）。 */
function readConfig() {
  const raw = JSON.parse(readFileSync(join(SRC, 'site.json'), 'utf8'));
  // 链接类键**允许为空**：空 = 这个地址还没定（占位）。
  // `demoHidden` 是唯一的布尔开关：还没开放的入口整块收起来。
  // 其余每个键都必须有值，否则页面上会出现一个说不清为什么是空的元素。
  const MAY_BE_EMPTY = new Set(['demoUrl', 'sourceZipUrl', 'releaseUrl']);
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    if (k === 'demoHidden') {
      if (typeof v !== 'boolean') throw new Error('site.json 的 "demoHidden" 必须是 true 或 false');
      continue;
    }
    if (typeof v !== 'string') throw new Error(`site.json 的 "${k}" 必须是字符串（没有就写 ""）`);
    if (MAY_BE_EMPTY.has(k)) continue;
    if (!v.trim()) throw new Error(`site.json 的 "${k}" 是空的，而它不允许为空`);
  }
  return raw;
}

/** 只有链接类的键必须是外链；媒体键允许是站内相对路径。 */
const LINK_KEYS = ['demoUrl', 'repoUrl', 'sourceZipUrl', 'devlogUrl', 'commitsUrl'];

function checkConfig(cfg) {
  const probs = [];
  for (const k of LINK_KEYS) {
    if (!cfg[k]) continue;
    if (!/^https:\/\//.test(cfg[k])) probs.push(`${k} 不是 https 链接：${cfg[k]}`);
  }
  if (cfg.releaseUrl && !/^https:\/\//.test(cfg.releaseUrl)) {
    probs.push(`releaseUrl 不是 https 链接：${cfg.releaseUrl}`);
  }
  for (const k of ['videoSrc', 'videoPoster']) {
    const v = cfg[k];
    if (!v) continue;
    // 站内相对路径（媒体）或站外 https 直链，两种都合法
    if (!/^https:\/\//.test(v) && v.startsWith('/')) {
      probs.push(`${k} 用的是绝对路径 "${v}"；产物跑在子路径下，必须写相对路径`);
    }
  }
  if (probs.length) {
    console.error(`${RED}site.json 有问题：${OFF}`);
    for (const p of probs) console.error(`  · ${p}`);
    process.exit(1);
  }
}

const isRemote = (v) => /^https?:\/\//.test(v);

/**
 * 把 data-cfg 标出来的位置按 site.json 覆写。
 *
 * 四类位置，四条规则。之所以不用 DOM 解析：这一页的 HTML 是我们自己写的，
 * 形状固定，而多引一个解析依赖不值得——CI 里 `npm ci` 装的东西越少越好。
 *
 * ## 空值 = 占位，不是空链接
 *
 * `site.json` 里某个链接留空，表示**那个地址还没定**（例如在线 Demo 的正式域名）。
 * 这时页面上要出现一个看得见的「待填」，而**不是**一个点了没反应的按钮：
 *
 *   · 有值 → 写 href，并摘掉源码里的 data-todo
 *   · 空值 → **摘掉 href**，打上 data-todo，CSS 把它画成虚线待填块
 *
 * 摘 href 而不是留 href=""，是因为无 href 的 `<a>` 在 HTML 里本来就不是链接：
 * 不可聚焦、不可点、不会被读屏念成链接，也进不了浏览器的历史。
 */
function bake(html, values) {
  const used = new Set();
  const unknown = [];
  const todo = [];

  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');

  const setAttr = (tag, name, value) => {
    const re = new RegExp(`${name}="[^"]*"`);
    if (re.test(tag)) return tag.replace(re, `${name}="${esc(value)}"`);
    return tag.replace(/\s*\/?>$/, ` ${name}="${esc(value)}">`);
  };
  const dropAttr = (tag, name) => tag.replace(new RegExp(`\\s${name}="[^"]*"`), '');

  /** 摘掉 href + 打上 data-todo。 */
  const asTodo = (tag, key) => {
    used.add(key);
    todo.push(key);
    let t = dropAttr(tag, 'href');
    if (!/data-todo="/.test(t)) t = setAttr(t, 'data-todo', key);
    return t;
  };

  /** 写 href + 摘掉 data-todo（源码里默认带着占位标记）。 */
  const asLink = (tag, key, value) => {
    used.add(key);
    return setAttr(dropAttr(tag, 'data-todo'), 'href', value);
  };

  // <a data-cfg="x">  →  有值给 href，空值变待填
  let out = html.replace(/<a\b[^>]*\bdata-cfg="([\w.]+)"[^>]*>/g, (tag, key) => {
    const v = values[key];
    if (v === undefined) {
      unknown.push(key);
      return tag;
    }
    return v ? asLink(tag, key, v) : asTodo(tag, key);
  });

  // <source data-cfg="videoSrc" src="...">  →  src（媒体永远有值，空了就是配置错了）
  out = out.replace(/<source\b[^>]*\bdata-cfg="([\w.]+)"[^>]*>/g, (tag, key) => {
    const v = values[key];
    if (v === undefined) {
      unknown.push(key);
      return tag;
    }
    used.add(key);
    if (!v) {
      console.error(`${RED}${key} 是空的，视频/海报不可能为空——检查 site.json${OFF}`);
      process.exit(1);
    }
    return setAttr(tag, 'src', v);
  });

  // <video poster="..." data-cfg="videoPoster">  →  poster
  out = out.replace(/<video\b[^>]*\bdata-cfg="videoPoster"[^>]*>/g, (tag) => {
    const v = values.videoPoster;
    if (v === undefined) {
      unknown.push('videoPoster');
      return tag;
    }
    used.add('videoPoster');
    return setAttr(tag, 'poster', v);
  });

  // <code|span data-cfg="x">文字</code|span>  →  正文（空值显示待填字样）
  out = out.replace(/<(code|span)\b([^>]*?)\bdata-cfg="([\w.]+)"([^>]*)>([\s\S]*?)<\/\1>/g, (m, tag, a1, key, a2) => {
    const v = values[key];
    if (v === undefined) {
      unknown.push(key);
      return m;
    }
    used.add(key);
    // 源码里默认带着 data-todo（占位状态），有值时要把这个标记摘掉，
    // 否则会出现「地址是真的，角标却还写着待填」。
    const rest = a2.replace(/\s*data-todo="[^"]*"/, '');
    if (!v) {
      todo.push(key);
      return `<${tag}${a1} data-cfg="${key}" data-todo="${key}"${rest}>${esc(values.todoText ?? 'TBD')}</${tag}>`;
    }
    return `<${tag}${a1} data-cfg="${key}"${rest}>${esc(v)}</${tag}>`;
  });

  if (unknown.length) {
    console.error(`${RED}HTML 里的 data-cfg 指向了 site.json 没有的键：${OFF} ${[...new Set(unknown)].join(', ')}`);
    process.exit(1);
  }
  if (out.includes('{{')) {
    console.error(`${RED}产物里还留着 {{...}} 占位符，说明烘链接漏了一处。${OFF}`);
    process.exit(1);
  }
  return { html: out, used: [...used], todo: [...new Set(todo)] };
}

function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

const cfg = readConfig();
checkConfig(cfg);

// ---- 媒体 ------------------------------------------------------------------
// 视频既可以是仓库里的文件（提交页要能在一台空机器上 build 出来），
// 也可以是站外直链（不想让仓库长 20MB 时）。两种都支持，页面不需要知道区别。

const missing = [];
const values = { ...cfg };

function resolveMedia(key) {
  const v = cfg[key];
  if (!v || isRemote(v)) return v ? { remote: true } : null;
  const abs = join(SRC, v);
  if (!existsSync(abs)) {
    missing.push(v);
    return null;
  }
  return { remote: false, abs, size: statSync(abs).size };
}

// `--no-media` 只针对**录屏**：海报和抬头主视觉都照发，否则页面会缺一块脸。
const video = NO_MEDIA ? null : resolveMedia('videoSrc');
const poster = resolveMedia('videoPoster');

// 片长写在 site.json 里（没装 ffprobe，脚本不去猜），体积是**量出来的**
values.videoSize = video && !video.remote ? mb(video.size) : (cfg.videoSize ?? '—');

// 视频不在的时候把页面标成缺媒体，CSS 会收起播放器、换成一句说明，
// 而不是给评委一个点了没反应的播放器。
const missingFlags = [];
if (!video) missingFlags.push('video');

// ---- 校验 + 烘链接 ----------------------------------------------------------

const htmlSrc = readFileSync(join(SRC, 'index.html'), 'utf8');
const { html, used, todo } = bake(htmlSrc, values);

let finalHtml = html;
// 缺媒体时给 <html> 挂标记（CSS 侧 [data-missing~="video"] 收起播放器）
if (missingFlags.length) {
  finalHtml = finalHtml.replace('<html lang="zh-Hans" data-lang="zh">', `<html lang="zh-Hans" data-lang="zh" data-missing="${missingFlags.join(' ')}">`);
}
// 发行包那一行：site.json 里填了才放出来，填了就绝不显示（不给访客死链）。
//
// 这里刻意写得啰嗦一点，因为两次踩坑都在这一行：
//   · 简单地"再加一个 hidden" → 烤出 `hidden hidden`
//   · 拼 `<li${attrs}>` 时忘了补空格 → 烤出 `<liclass=...>`，标签名整个废了，
//     而症状是"那一行不见了"，看起来像被 CSS 隐藏了
finalHtml = finalHtml.replace(/<li\b([^>]*?)\bdata-cfg-row="releaseUrl"([^>]*)>/, (_m, before, after) => {
  // `(?=[\s/>]|$)` 的 `$` 不能省：` hidden` 常常就在标签末尾，
  // 没有它时这条替换会一条都匹配不到，然后 attrs 首尾的空格也没了。
  const attrs = `${before}${after}`.replace(/\shidden(?=[\s/>]|$)/g, ' ').trim();
  const head = attrs ? `<li ${attrs}` : '<li';
  return `${head}${cfg.releaseUrl ? '' : ' hidden'}>`;
});

/**
 * 还没开放的入口（比如在线 Demo 暂时没有正式地址）：给所有 `data-demo` 打上 hidden。
 *
 * 为什么用 hidden 而不是从 HTML 里删掉那一段：
 *   · 源码保持完整——`submission/index.html` 双击就能看到全貌，包括暂时收起的部分
 *   · 卡片编号可以顺着可见的卡片重排（下面那段），删掉就没法这么算了
 * `hidden` 在 HTML 层面就已经让元素不渲染、不可聚焦，CSS 只是兜底。
 */
const hidden = [];
if (cfg.demoHidden) {
  finalHtml = finalHtml.replace(/<([a-z]+)\b([^>]*\bdata-demo\b[^>]*)>/g, (tag, name, attrs) => {
    if (/\shidden(?=[\s/>]|$)/.test(attrs)) return tag;
    hidden.push(name);
    return `<${name}${attrs.replace(/\s*\/?>$/, '')} hidden>`;
  });
}

/**
 * 卡片编号顺着**可见**的卡片重排。
 *
 * 不重排的话，收起 Demo 之后页面上就是 01 → 03，中间空一个号——
 * 访客会以为少了一张卡，而不是「那张暂时没开」。
 */
{
  const ORDER = ['video', 'demo', 'download'];
  const visible = ORDER.filter((id) => !(id === 'demo' && cfg.demoHidden));
  visible.forEach((id, i) => {
    const re = new RegExp(`(<article[^>]*id="${id}"[\\s\\S]*?<span class="num">)[^<]*`);
    if (!re.test(finalHtml)) {
      console.error(`${RED}找不到 id="${id}" 的卡片，无法编号${OFF}`);
      process.exit(1);
    }
    finalHtml = finalHtml.replace(re, `$1${String(i + 1).padStart(2, '0')}`);
  });
}

// 页面里用到、但我们供不上的键（漏配或拼错的信号）。
// 对照的是 `values` 而不是 `cfg`：`videoSize` 是这里量出来的，不在配置里，
// 但页面上必须有它的值。
for (const key of used) {
  if (!(key in values)) {
    console.error(`${RED}页面用了我们供不上的键：${key}${OFF}`);
    process.exit(1);
  }
}

// ---- 打印清单 ---------------------------------------------------------------

/** 空地址在清单里显示成「待填」，并说明它会变成什么样子。 */
const todoMark = (v, note) => (v ? v : `${YELLOW}待填${OFF}${note ? `  ${DIM}${note}${OFF}` : ''}`);

function report() {
  const gameBytes = existsSync(DIST) ? dirSize(DIST) - (existsSync(OUT) ? dirSize(OUT) : 0) : 0;
  const lines = [
    '',
    `=== 官网清单 ===`,
    `  页面        ${DIM}${relative(ROOT, OUT)}/index.html${OFF}`,
    `  演示录屏    ${video ? (video.remote ? `${cfg.videoSrc} ${DIM}(站外直链)${OFF}` : `${cfg.videoSrc}  ${values.videoSize}`) : `${YELLOW}未包含${OFF}`}`,
    `  海报        ${poster ? (poster.remote ? `${cfg.videoPoster} ${DIM}(站外直链)${OFF}` : cfg.videoPoster) : `${YELLOW}未包含${OFF}`}`,
    `  在线 Demo   ${
      cfg.demoHidden
        ? `${YELLOW}已隐藏${OFF}  ${DIM}site.json 的 demoHidden = true；地址定下来后改回 false${OFF}`
        : todoMark(cfg.demoUrl, '页面上是虚线待填块')
    }`,
    `  桌面版下载  ${todoMark(cfg.releaseUrl, '')}`,
    `  源码 zip    ${todoMark(cfg.sourceZipUrl, '页面上是虚线待填块')}`,
    `  代码仓库    ${cfg.repoUrl}`,
    '',
    `  游戏本体（不含本页）  ${gameBytes ? mb(gameBytes) : `${DIM}dist 还没构建${OFF}`}`,
  ];
  if (existsSync(OUT) && !CHECK_ONLY) lines.push(`  产物总计              ${mb(dirSize(DIST))}`);

  // 待填清单单独一栏：这是每次构建后最该被看见的东西。
  // 两个键不进这份清单：
  //   · releaseUrl —— 它空着的时候那一行是**隐藏**的，不是「页面上有个待填」
  //   · demoUrl    —— demoHidden 时整块 Demo 是收起来的，访客看不到任何待填块
  const visibleTodo = todo.filter((k) => k !== 'releaseUrl' && !(k === 'demoUrl' && cfg.demoHidden));
  if (visibleTodo.length) {
    lines.push('', `  ${YELLOW}还欠着的地址（${visibleTodo.length} 处，页面上显示为待填）：${OFF}`);
    for (const k of visibleTodo) {
      lines.push(`    · ${k}  →  填进 submission/site.json 的 "${k}"，再跑一次 npm run build`);
    }
  }
  console.log(lines.join('\n'));
  console.log('');
}

if (!video && !CHECK_ONLY) {
  const why = NO_MEDIA ? '按 --no-media 构建' : `缺 ${missing.join('、') || '录屏文件'}`;
  console.log(
    `${YELLOW}${why}：播放器会被收起、换成一句说明。${OFF}\n` +
      `${YELLOW}完整构建请先把录屏放到 submission/${cfg.videoSrc} 下。${OFF}`,
  );
}

if (CHECK_ONLY) {
  report();
  process.exit(0);
}

// ---- 写盘 -------------------------------------------------------------------

/**
 * 拷 `submission/` 到 `dist/submission/`。
 *
 * 这里**整棵目录照搬**，而不是照着 site.json 里的媒体键去拷。
 * 踩过的坑就是这个：第一版只拷 videoSrc 与 videoPoster，于是
 * `<img src="media/hero.jpg">` 静静地 404 了——抬头主视觉整块不见，
 * 而构建不报错、`verify_submission` 也绿（它判的是**源目录**里的引用，
 * 按设计就不看产物）。「目录里有什么就发什么」是唯一不会漏的做法：
 * 页面上能引用的东西必然在 submission/ 下。
 *
 * 例外有两个：**构建期**文件（site.json 是链接来源、README.md 是给人看的，
 * 不该出现在产物里），以及没被采用的录屏（站外直链或 `--no-media` 时，
 * 本地那份没必要跟着上线）。
 */
const SKIP_NAMES = new Set(['site.json', 'README.md']);

/** 没采用的录屏就别拷（否则部署包白白大二十几 MB）。 */
const videoSkipped = !video || video.remote;

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (SKIP_NAMES.has(e.name)) continue;
    const src = join(from, e.name);
    const dst = join(to, e.name);
    if (e.isDirectory()) {
      copyTree(src, dst);
    } else {
      if (videoSkipped && relative(SRC, src).split(/[\\/]/).join('/') === cfg.videoSrc) continue;
      copyFileSync(src, dst);
    }
  }
}

/** 递归列出目录下的所有文件（相对 base，正斜杠）。 */
function listFiles(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else if (e.isFile()) out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}

mkdirSync(OUT, { recursive: true });
copyTree(SRC, OUT);
// index.html 单独写：它是烘过链接的那一份，不是源文件。
writeFileSync(join(OUT, 'index.html'), finalHtml);

/**
 * 删掉产物里**不该存在**的文件：上一次构建留下的（换过视频名、或从「带视频」
 * 切到 `--no-media`），旧文件会留在部署包里，白白大二十几 MB。
 *
 * 口径是「产物文件集 == 源目录文件集 − 跳过的 + index.html」，
 * 而不是「删掉 top-level 的文件」——后者第一版就是这么写的，
 * 它把刚写进去的 landing.css / landing.js / index.html 一起删了。
 */
const expected = new Set([
  'index.html',
  ...listFiles(SRC).filter((rel) => {
    if (SKIP_NAMES.has(rel.split('/').pop())) return false;
    return !(videoSkipped && rel === cfg.videoSrc);
  }),
]);
let dropped = 0;
for (const rel of listFiles(OUT)) {
  if (expected.has(rel)) continue;
  rmSync(join(OUT, rel), { force: true });
  dropped++;
}

console.log(
  `${GREEN}官网已写入${OFF} ${relative(ROOT, OUT)}/  ${DIM}(index.html + submission/ 其余文件${videoSkipped ? '，未带录屏' : ''}${dropped ? `，清掉 ${dropped} 个残留` : ''})${OFF}`,
);
report();