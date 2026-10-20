/**
 * 参赛提交页的判据 —— 三件交付物（录屏 / Demo / 下载）都得真的在那儿。
 *
 * ## 为什么需要它
 *
 * 提交页是**唯一一个直接给评委看的东西**，而它的失效方式全是静默的：
 * 链接写错一个字、媒体文件没跟仓库走、页面里混进一句游戏里其实没有的卖点——
 * 构建不报错、CI 不报错、页面照常渲染，只是评委点下去发现是空的。
 *
 * `promo/SUBMISSION-FORM.zh.md` §0.1 / §0.3 记的就是这类事故：文案里出现过
 * 还没实现的机制、还有一句被说成「零贴图」但实际有 258 张贴图的描述。
 * 那些是**表单里的**错误。这一页现在也上线了，所以同样的口径要有同样的门。
 *
 * ## 口径
 *
 * 主要判**提交页自己的东西**（`submission/**`）。
 * 产物（`dist/`）那部分**顺带**判一下：CI 的顺序已经是
 * typecheck → build → verify（`AGENTS.md` §4），所以 verify 跑的时候
 * 产物**已经在了**，而页面上那几个体积正是构建时填进去的——
 * 不看产物，就等于只判了"源码里的占位符没写错"，而那不是真正要紧的事。
 *
 * ## 为什么不复用构建脚本里的解析
 *
 * `tools/build-submission.mjs` 里有一套 `data-cfg` 的正则，这里**刻意重写一遍**。
 * 共用同一套解析的后果是：解析器写错了，两边一起绿——而这条判据的全部意义
 * 就是抓构建脚本抓不到的东西。判据要能独立地红。
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export function assertSubmission(): { ok: boolean; detail: string; asserts: number } {
  let asserts = 0;
  const probs: string[] = [];

  // verify 由 `npm run verify` 跑，cwd 就是仓库根。用 cwd 而不是 `import.meta.url`
  // 反推——后者在 esbuild 打成单文件 ESM 之后指向的是临时目录。
  const ROOT = process.cwd();
  const SRC = join(ROOT, 'submission');
  const htmlPath = join(SRC, 'index.html');
  const cfgPath = join(SRC, 'site.json');

  const unescape = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const mib = (n: number) => `${(n / 1048576).toFixed(2)} MB`;

  // ---------------------------------------------------------------- 文件在不在
  asserts++;
  if (!existsSync(htmlPath)) {
    return { ok: false, detail: 'submission/index.html 不存在', asserts };
  }
  asserts++;
  if (!existsSync(cfgPath)) {
    return { ok: false, detail: 'submission/site.json 不存在（链接的唯一来源没了）', asserts };
  }

  const html = readFileSync(htmlPath, 'utf8');

  // ---------------------------------------------------------------- site.json
  let cfg: Record<string, string> = {};
  asserts++;
  try {
    const parsed: unknown = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => [k, String(v ?? '')]),
    );
  } catch (e) {
    probs.push(`site.json 解析失败：${(e as Error).message}`);
  }

  // 链接类键允许为空：空 = 正式地址还没定，页面上会显示成「待填」。
  // 其余每个键都必须有值，否则页面上会出现一个说不清为什么是空的元素。
  const MAY_BE_EMPTY = new Set(['demoUrl', 'sourceZipUrl', 'releaseUrl']);
  asserts++;
  for (const [k, v] of Object.entries(cfg)) {
    if (MAY_BE_EMPTY.has(k)) continue;
    if (!v) probs.push(`site.json 的 "${k}" 是空的，而它不允许为空`);
  }

  // 链接类必须是 https。踩过的坑是 `188-gift-web` 这种和仓库名对不上的地址，
  // 以及缺协议头变成相对路径——两者都在评审点下去那一刻才暴露。
  asserts++;
  for (const k of ['demoUrl', 'repoUrl', 'sourceZipUrl', 'devlogUrl', 'commitsUrl', 'releaseUrl']) {
    const v = cfg[k];
    if (v && !/^https:\/\/[^\s]+$/.test(v)) probs.push(`${k} 不是 https 链接：${v || '(空)'}`);
  }

  // ---------------------------------------------------------------- 三件都在
  // 下面每一条都是"删掉就红"：这三样是赛事表单要的三个字段，缺一个这页就废了。
  asserts++;
  if (!/<video\b[\s\S]*?<source\b[^>]*data-cfg="videoSrc"/.test(html)) {
    probs.push('页面里没有带 data-cfg="videoSrc" 的 <video><source> —— 演示录屏不见了');
  }
  asserts++;
  if (!/<a\b[^>]*data-cfg="demoUrl"/.test(html)) {
    probs.push('页面里没有 data-cfg="demoUrl" 的链接 —— 在线 Demo 不见了');
  }
  asserts++;
  {
    const rows = html.match(/class="dl-row"/g) ?? [];
    if (rows.length < 3) {
      probs.push(`下载清单只有 ${rows.length} 行，至少要有 3 行（发行包 / 源码 / 本地运行）`);
    }
  }

  // ---------------------------------------------------------------- 单一数据源
  // HTML 里每个 data-cfg 都要在 site.json 里有对应键。**例外是构建时量出来的那几个**：
  // 它们不进配置，因为它们是**事实**而不是**设定**——
  // 录屏多大、产物多大、回归多少条，都是量出来的，写进配置就等于允许它过期。
  //
  // 这一组以前是手抄进 HTML 的，而手抄的那一版已经过期过：
  // 页面写着 21.41 MB / 17.47 MB / 279 KB，实际是 22.94 MB / 18.21 MB / 339 KB。
  // 现在这些位置在源码里是占位，由 `tools/build-submission.mjs` 在构建时填。
  const computed = new Set([
    'videoSize',
    'payloadSize',
    'modelsSize',
    'modelsShare',
    'firstScreenSize',
    'jsGzipSize',
    'fileCount',
    'checksCount',
    'assertsCount',
    'i18nKeys',
  ]);

  const attrOf = (tag: string, name: string): string | undefined => {
    const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
    return m ? m[1] : undefined;
  };

  /** 一处 data-cfg 的用法：键 + 它当前带的属性 + 元素里的正文。 */
  interface Use {
    key: string;
    tag: string;
    inner?: string;
  }
  const uses: Use[] = [];

  for (const tag of html.match(/<a\b[^>]*>/g) ?? []) {
    const key = attrOf(tag, 'data-cfg');
    if (key) uses.push({ key, tag });
  }
  for (const tag of html.match(/<source\b[^>]*>/g) ?? []) {
    const key = attrOf(tag, 'data-cfg');
    if (key) uses.push({ key, tag });
  }
  for (const tag of html.match(/<video\b[^>]*>/g) ?? []) {
    if (attrOf(tag, 'data-cfg') === 'videoPoster') uses.push({ key: 'videoPoster', tag });
  }
  for (const m of html.matchAll(/<(?:code|span)\b([^>]*)>([\s\S]*?)<\/(?:code|span)>/g)) {
    const key = attrOf(`<x ${m[1]}>`, 'data-cfg');
    if (key) uses.push({ key, tag: `<x ${m[1]}>`, inner: m[2] });
  }

  asserts++;
  for (const u of uses) {
    if (!(u.key in cfg) && !computed.has(u.key)) {
      probs.push(`页面用了 site.json 里没有的键：${u.key}`);
    }
  }

  // **默认值也必须一致**：构建脚本会用 site.json 覆写产物，但仓库里这份 HTML
  // 是可以直接双击打开的（本地预览、别人 clone 下来看）。两边不一致时，
  // 预览到的和上线的是两份东西——这正是「唯一数据源」要防的。
  //
  // 分两种状态：
  //   · site.json 有值 → HTML 必须带着同一个 href，且不能还挂着 data-todo
  //   · site.json 空值 → HTML **必须没有 href**，且必须挂 data-todo
  // 后者是「占位」的约定。没有 href 的 `<a>` 在 HTML 里不是链接：
  // 不可聚焦、不可点、读屏也不会念成链接——所以占位不会变成死链。
  asserts++;
  for (const u of uses) {
    const want = cfg[u.key];
    if (want === undefined) continue;
    const name = u.tag.startsWith('<source') ? 'src' : u.tag.startsWith('<video') ? 'poster' : 'href';
    // `attrVal` 是**属性**上的值，`got` 对文本节点来说是正文。
    // 占位那条判据查的是属性（正文本来就该是「待填 / TBD」那句话），
    // 两者混用会报出「href="待填 / TBD"」这种不存在的属性。
    const attrVal = attrOf(u.tag, name);
    const got = u.inner !== undefined ? unescape(u.inner) : attrVal;
    const marked = /data-todo="/.test(u.tag);
    if (!want) {
      if (attrVal !== undefined) {
        probs.push(`data-cfg="${u.key}" 是占位（site.json 为空），HTML 里却还留着 ${name}="${attrVal}"`);
      }
      if (!marked) probs.push(`data-cfg="${u.key}" 是占位，但没标 data-todo —— 页面上会看不出它还没定`);
      continue;
    }
    if (got !== want) {
      probs.push(`data-cfg="${u.key}" 在 HTML 里是 "${got ?? '(缺失)'}"，site.json 是 "${want}"`);
    }
    if (marked) {
      probs.push(`data-cfg="${u.key}" 已经有地址了，HTML 里却还挂着 data-todo —— 页面上会显示成待填`);
    }
  }

  // 不许有「既没有 href、也没标待填」的链接：那就是一个点了没反应的按钮，
  // 症状和死链一模一样，却连一个显式的理由都没有。
  asserts++;
  for (const tag of html.match(/<a\b[^>]*>/g) ?? []) {
    if (/\bhref="/.test(tag) || /data-todo="/.test(tag)) continue;
    probs.push(`页面有个没有 href 也没有 data-todo 的链接：${tag.slice(0, 80)}`);
  }

  // 「暂时没开放的入口」这一档：demoHidden 为 true 时构建会把 data-demo 那些元素收起来。
  // 这里判的是**源码**，判两件事：
  //   · 标记还在 —— 否则有人是把整段删了而不是打了开关，改回 false 也回不来
  //   · demoHidden 为 false 时源码里不该残留 hidden —— 残留的话，重新开放了却还是看不见
  asserts++;
  {
    const demoEls = (html.match(/<[a-z]+\b[^>]*\bdata-demo\b[^>]*>/g) ?? []).length;
    if (cfg.demoHidden === 'true' && demoEls === 0) {
      probs.push('demoHidden 为 true，但页面里一个 data-demo 标记都没有 —— 那一块是被删了吗？');
    }
    if (cfg.demoHidden === 'false') {
      for (const tag of html.match(/<[a-z]+\b[^>]*\bdata-demo\b[^>]*>/g) ?? []) {
        if (/\shidden(?=[\s/>]|$)/.test(tag)) {
          probs.push(`demoHidden 为 false，但源码里这个元素还带着 hidden：${tag.slice(0, 70)}`);
        }
      }
    }
  }

  // ---------------------------------------------------------------- 相对链接都落地
  // 页面引用 ../fonts/ui.woff2 这种从 dist/submission/ 往上跳的路径：
  // 源文件里它对应 public/fonts/。两条都查，因为症状（浏览器控制台一个 404）
  // 比原因难找得多。
  asserts++;
  {
    const refs = new Set<string>();
    for (const m of html.matchAll(/\b(?:href|src|poster)="([^"]+)"/g)) refs.add(m[1]);
    for (const ref of refs) {
      if (/^(https?:|data:|#|mailto:)/.test(ref)) continue;
      if (ref.includes('{{')) continue;
      const inSubmission = existsSync(join(SRC, ref));
      const inPublic = ref.startsWith('../') && existsSync(join(ROOT, 'public', ref.slice(3)));
      if (!inSubmission && !inPublic) {
        probs.push(`页面引用了不存在的相对路径：${ref}`);
      }
    }
  }

  // ---------------------------------------------------------------- 媒体不是占位
  const localMedia = (v: string) => (v && !/^https?:\/\//.test(v) ? join(SRC, v) : '');
  const videoPath = localMedia(cfg.videoSrc ?? '');
  const posterPath = localMedia(cfg.videoPoster ?? '');

  asserts++;
  if (!videoPath || !existsSync(videoPath)) {
    probs.push(`录屏文件不在仓库里：${cfg.videoSrc || '(未配置)'}`);
  } else if (statSync(videoPath).size < 1024 * 1024) {
    // 低于 1MB 几乎一定是占位文件或者压坏的产物，页面却会照播
    probs.push(`录屏只有 ${mib(statSync(videoPath).size)}，多半不是完整片子`);
  }

  asserts++;
  if (posterPath && !existsSync(posterPath)) {
    probs.push(`海报不在仓库里：${cfg.videoPoster}`);
  } else if (posterPath && statSync(posterPath).size < 20 * 1024) {
    probs.push(`海报只有 ${mib(statSync(posterPath).size)}，播放器在加载前会是一块黑`);
  }

  // 页面写出来的体积必须等于文件真实体积：换了片子没重跑构建，
  // 评委看到的数字就会和实际下载量对不上。
  asserts++;
  if (videoPath && existsSync(videoPath)) {
    const real = mib(statSync(videoPath).size);
    const shown = [...html.matchAll(/data-cfg="videoSize"[^>]*>([^<]*)</g)].map((m) => unescape(m[1]));
    for (const s of shown) {
      if (s !== real) probs.push(`页面写着录屏 ${s}，实际是 ${real}`);
    }
  }

  // **产物**里那几个体积必须等于这一轮量出来的值。
  //
  // 源码里那些位置写的是占位（`—`），构建时才填——所以要看的是**产物**。
  // 而 CI 的顺序是 typecheck → build → verify（`AGENTS.md` §4），
  // 于是 verify 跑的时候产物**已经在了**：这条判据因此能真正抓到
  // 「构建填错了」或「产物是旧的」。
  //
  // 口径与 `tools/build-submission.mjs` 的 `measureBuild()` 一致，
  // 但**这里重算一遍**：共用同一段逻辑的话，逻辑写错了两边一起绿，
  // 而这条判据的全部意义就是抓构建脚本抓不到的东西。
  asserts++;
  {
    const built = join(ROOT, 'dist', 'submission', 'index.html');
    if (existsSync(built)) {
      const builtHtml = readFileSync(built, 'utf8');
      const dist = join(ROOT, 'dist');
      // **走一遍、顶层跳过 `submission`**，而不是「总大小减去 submission」。
      // 相减看着等价，实际上不是：它依赖 `dist/submission` 此刻的体积，
      // 而那个目录可能是上一次 build 留下的——于是数字随重建顺序漂移。
      const dirBytes = (dir: string, top: boolean): number => {
        if (!existsSync(dir)) return 0;
        let total = 0;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (top && e.name === 'submission') continue;
          const p = join(dir, e.name);
          total += e.isDirectory() ? dirBytes(p, false) : statSync(p).size;
        }
        return total;
      };
      const assets = join(dist, 'assets');
      const names = existsSync(assets) ? readdirSync(assets) : [];
      const jsName = names.find((f) => f.endsWith('.js'));
      const cssName = names.find((f) => f.endsWith('.css'));
      const payload = dirBytes(dist, true);
      const models = dirBytes(join(dist, 'models'), true);
      const firstScreen = ['index.html', 'fonts/ui.woff2'].reduce((sum, rel) => {
        const p = join(dist, rel);
        return sum + (existsSync(p) ? statSync(p).size : 0);
      }, 0)
        + (jsName ? statSync(join(assets, jsName)).size : 0)
        + (cssName ? statSync(join(assets, cssName)).size : 0);
      const want: [string, string][] = [
        ['payloadSize', mib(payload)],
        ['modelsSize', mib(models)],
        ['firstScreenSize', mib(firstScreen)],
      ];
      if (jsName) {
        want.push(['jsGzipSize', `${Math.round(gzipSync(readFileSync(join(assets, jsName))).length / 1024)} KB`]);
      }
      for (const [key, real] of want) {
        const shown = [...builtHtml.matchAll(new RegExp(`data-cfg="${key}"[^>]*>([^<]*)<`, 'g'))]
          .map((m) => unescape(m[1]));
        if (!shown.length) {
          probs.push(`产物里没有 data-cfg="${key}" —— 页面上的那一格是空的`);
          continue;
        }
        for (const s of shown) {
          if (s !== real) probs.push(`产物页面写着 ${key} = ${s}，实际是 ${real}`);
        }
      }

      // 回归条数那两个数：页面上的必须和**唯一那一份**一样。
      //
      // 它们是构建时从 `docs/release-facts.md` 读的，所以这条判据量的是
      // 「页面有没有抄错唯一那一份」——而 [DOC] 门管的是
      // 「那一份本身对不对」。两件事，少一件就留了个后门。
      const factsPath = join(ROOT, 'docs', 'release-facts.md');
      if (existsSync(factsPath)) {
        const factsText = readFileSync(factsPath, 'utf8');
        for (const key of ['checks', 'asserts']) {
          const m = new RegExp(`^\\|\\s*\`${key}\`\\s*\\|[^|]*\\|\\s*\`([^\`]*)\`` , 'm').exec(factsText);
          if (!m) {
            probs.push(`docs/release-facts.md 里没有 ${key} 那一行`);
            continue;
          }
          const shown = [...builtHtml.matchAll(new RegExp(`data-cfg="${key}Count"[^>]*>([^<]*)<`, 'g'))]
            .map((x) => unescape(x[1]));
          for (const s of shown) {
            if (s !== m[1]) probs.push(`产物页面写着 ${key} = ${s}，唯一那一份是 ${m[1]}`);
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- 死链不许出现
  // releaseUrl 为空时，发行包那一行必须是 hidden —— 一个点不开的按钮
  // 比没有这个按钮糟得多。
  asserts++;
  if (!cfg.releaseUrl && !/data-cfg-row="releaseUrl"[^>]*hidden/.test(html)) {
    probs.push('releaseUrl 是空的，但发行包那一行没有 hidden —— 页面上会出现死链');
  }

  // ---------------------------------------------------------------- 口径
  // 这三条是 §0.1 与 §0.3 写在表单上的约束，现在同样适用于这一页：
  // 别承诺游戏里没有的机制，也别把「模型自带贴图」说成「零贴图」。
  const FORBIDDEN: [string, string][] = [
    ['Echo', '回响机制尚未实现'],
    ['八百年诗人', '尚未实现'],
    ['零贴图', '只能精确说「路面地形草皮水面零贴图文件 + 7 座驿站零图片字节」'],
    ['no textures', '同上'],
    ['zero texture', '同上'],
  ];
  asserts++;
  for (const [needle, why] of FORBIDDEN) {
    if (html.includes(needle)) probs.push(`页面里出现了「${needle}」：${why}`);
  }

  const notes = [
    `三件交付物齐：录屏 / Demo / 下载 ${html.match(/class="dl-row"/g)?.length ?? 0} 行`,
    `demo ${cfg.demoUrl}`,
    `录屏 ${cfg.videoSrc || '(未配置)'}${videoPath && existsSync(videoPath) ? ` ${mib(statSync(videoPath).size)}` : ''}`,
  ];

  return {
    ok: probs.length === 0,
    detail: probs.length ? probs.join('  ') : notes.join('  '),
    asserts,
  };
}