/**
 * 一族新判据：**字与底必须读得出来**。
 *
 * ## 它治的是哪一个病
 *
 * 第十三轮实机评审撞到的：**游戏唯一的临时反馈通道读不出来**。
 *
 * 抓到的那条 toast 是「序章还在播 · 按空格接着念」——
 * 字 `rgb(28,46,60)`、底 `rgba(24,20,15,0.88)`，**对比度 1.31:1**。
 * 我按空格，系统答了一句话，而那句话**印在一块近黑的板上**。
 * 玩家的第一反应只有一个：游戏坏了。
 *
 * 根因不是写错了一个颜色，是**语义翻了**：
 * UI 重做把 `.g-root` 的色板从「宣纸与墨」换成「深青蓝玻璃」，
 * 于是 `--paper` 从**浅色**（`calc(236 - dusk*78)`）变成**深色底板**
 * （`calc(28 - dusk*13)`），而仍按旧约定写下的 `color: var(--paper)`
 * 一夜之间全变成了「深字压深底」。
 *
 * 一共 **9 处**（`.g-toast` / `.g-ring-label` / `.g-touch-check` / `.g-touch-act` /
 * `.g-touch-sq` / `.g-touch-vehicle` / `.g-lakeside-hint` /
 * `.g-lakeside-capability` / `.g-lakeside-exit`+`.g-lakeside-vr`）。
 * 手工 grep 只找出 5 处——**紧凑写法 `color:var(--paper)` 漏在眼里**，
 * 而这正是"靠自觉"守不住的道理：所以这一族是**自动的**。
 *
 * ## 为什么不是"算一遍就完"
 *
 * 算一遍只能证明**今天**这一版是对的。下一版换个颜色、复制一条规则，
 * 就又漏了。所以这里守的是**结构**：
 *
 * 1. `.g-root` 作用域里**不许出现 `color: var(--paper…)`**——
 *    底板令牌不能当字色用。这条是通用的，新增规则也归它管。
 * 2. 受保护的每一块：字必须**亮**，底必须**托得住它**，
 *    而"托得住"是按 WCAG 相对亮度**算出来**的，不是看出来的。
 * 3. 压在 3D 场景上（底是透明的）那些：必须有**暗影**，
 *    否则浅字落在浅色路面上照样读不出。
 *
 * ## 这条证不了什么
 *
 * 证不了「玩家看得见」。无头没有排版引擎，算得出对比度，
 * 算不出字落在哪里、压在什么上面。所以它量的是**能算的那一半**，
 * 另一半（位置与遮挡）只能靠实机——但**颜色这一半从此不再靠人眼**。
 *
 * ## 为什么阈值是 4.5
 *
 * WCAG AA 对普通正文的门槛。`--ink`（#ece6d6）压 `--paper`（rgb(28,46,60)）
 * 是 14.7:1，而半透底板叠在**最亮的白**上要还能过 4.5 ——
 * 这就是为什么触屏那三颗按钮的底色必须从 0.45 提到 0.72。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, stripComments, type CheckFn } from './harness';

// 回归由 `npm run verify` 跑，cwd 就是仓库根。**不要**用 `__dirname`
// （单文件 ESM 里没有它）或 `import.meta.url` 反推——理由与
// `ui_regressions.ts` 顶上那段完全一样。
const ROOT = process.cwd();

/** 两份样式表。`ui/styles.css` 是 `.g-root` 那一层，`index.css` 是宿主那一层。 */
const UI_CSS = stripComments(readFileSync(join(ROOT, 'src/ui/styles.css'), 'utf8'));
const HOST_CSS = stripComments(readFileSync(join(ROOT, 'src/index.css'), 'utf8'));

/** sRGB 三通道。 */
type Rgb = [number, number, number];

/** WCAG 相对亮度。 */
function luminance(c: Rgb): number {
  const f = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

/** 对比度（1..21）。 */
function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 把一个半透明色叠到不透明底上。 */
function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [
    fg[0] * alpha + bg[0] * (1 - alpha),
    fg[1] * alpha + bg[1] * (1 - alpha),
    fg[2] * alpha + bg[2] * (1 - alpha),
  ];
}

/**
 * 一条规则的选择器正文（`{` 到配对的 `}`，CSS 里没有嵌套花括号）。
 *
 * ⚠ **选择器后面必须紧跟 `{`**：只找名字的话，
 * `.g-root .g-toast` 会先命中 `.g-root .g-toasts`（那个容器）——
 * 它当然没有字色，于是判据报「这条规则没有字色」，
 * 而真正要量的那条规则根本没被读到。**判据自己找错，比没判据更费时间。**
 */
function ruleBody(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${esc}\\s*\\{`).exec(css);
  if (!m) return '';
  const open = m.index + m[0].length - 1;
  const close = css.indexOf('}', open);
  if (close < 0) return '';
  return css.slice(open + 1, close);
}

/** 规则正文里某条声明的值（`color` / `background` / `background-color`）。 */
function decl(body: string, prop: string): string {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body);
  return m ? m[1].trim() : '';
}

// ---------------------------------------------------------------- 色板

/**
 * `.g-root` 色板：名字 → RGB。
 *
 * 只认**一种**写法——`--ink: #ece6d6;` 与纸色三通道那一族。
 * 认不出来就返回 null，让判据报"算不出"而不是**算错**：
 * 判据自己算错还报绿，比没有判据更费时间。
 */
function buildPalette(css: string): Map<string, Rgb> {
  const pal = new Map<string, Rgb>();

  // 直接给十六进制的：--ink / --ink-soft / --ink-faint / --accent / --cyan …
  for (const m of css.matchAll(/--([\w-]+)\s*:\s*#([0-9a-fA-F]{3,8})\s*;/g)) {
    const h = m[2];
    const full =
      h.length === 3
        ? h
            .split('')
            .map((c) => c + c)
            .join('')
        : h.slice(0, 6);
    pal.set(m[1], [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ]);
  }

  // 纸色三通道：`--pw: calc(28 - var(--dusk) * 13);` —— 第一个数就是 dusk=0 的值。
  const base: number[] = [];
  for (const n of ['pw', 'pg', 'pb']) {
    const m = new RegExp(`--${n}:\\s*calc\\(\\s*(\\d+(?:\\.\\d+)?)`).exec(css);
    if (!m) return pal;
    base.push(Number(m[1]));
  }
  if (base.length !== 3) return pal;

  // `--paper` / `--paper-2` / `--paper-3` / `--paper-6`：
  // 声明里是 `rgb(calc(var(--pw) - 9) …)` —— 括号是**嵌套**的，
  // 所以按分号取整条声明，不能用 `rgb\(([^)]*)\)`。
  for (const name of ['paper', 'paper-2', 'paper-3', 'paper-6']) {
    const d = new RegExp(`--${name}:[^;]*;`).exec(css);
    if (!d) continue;
    const subs = [...d[0].matchAll(/([+-])\s*(\d+(?:\.\d+)?)\s*\)/g)].map((m) =>
      m[1] === '-' ? -Number(m[2]) : Number(m[2]),
    );
    if (subs.length === 0) {
      pal.set(name, base as Rgb);
    } else if (subs.length === 3) {
      pal.set(name, subs.map((v, i) => base[i] + v) as Rgb);
    }
  }
  return pal;
}

const PALETTE = buildPalette(UI_CSS);

/**
 * 解析一个颜色值。
 *
 * `var(--token)` 的语义要写对：**变量有值时兜底不生效**。
 * `var(--paper, #f2ede2)` 那个兜底是浅色的——作者写它的时候 `--paper` 还是浅纸；
 * 色板换了之后 `--paper` 有了值，兜底就再也轮不上了，
 * 而那一行就变成了深青字压深青底。认错这一条，判据会把最坏的一处放过去。
 */
function resolveColor(v: string): { rgb: Rgb; alpha: number } | null {
  const s = v.trim();
  const vm = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)$/.exec(s);
  if (vm) {
    const c = PALETTE.get(vm[1].slice(2));
    if (c) return { rgb: c, alpha: 1 };
    if (vm[2]) return resolveColor(vm[2]);
    return null;
  }
  const hm = /^#([0-9a-fA-F]{3,8})$/.exec(s);
  if (hm) {
    const h = hm[1];
    const full =
      h.length === 3
        ? h
            .split('')
            .map((c) => c + c)
            .join('')
        : h.slice(0, 6);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return {
      rgb: [
        parseInt(full.slice(0, 2), 16),
        parseInt(full.slice(2, 4), 16),
        parseInt(full.slice(4, 6), 16),
      ],
      alpha: a,
    };
  }
  const rm = /^rgba?\(([^)]*)\)$/.exec(s);
  if (rm) {
    const parts = rm[1]
      .split(/[,\s/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    return {
      rgb: [parts[0], parts[1], parts[2]],
      alpha: parts.length > 3 ? parts[3] : 1,
    };
  }
  return null;
}

/**
 * 一块「字压底」的读得出来吗？
 *
 * @param body 规则正文
 * @param colorText 这条规则自己的字色。**空 = 从基规则继承**
 *        （`:active` / `.is-live` 那一族只改底色，字色是继承来的）。
 * @param backdrop 这块的底**压在什么上面**：
 *   不给 = 压在 3D 场景上（最坏情况是纯白），
 *   给了 = 压在某个不透明底上（比如药丸里的键帽压在药丸上）。
 */
function legibility(
  body: string,
  colorText: string,
  backdrop?: string,
): { ok: boolean; why: string } {
  if (!colorText) return { ok: false, why: '这条规则没有字色（继承的也算）——判据算不出它压得住压不住' };
  const fg = resolveColor(colorText);
  if (!fg) return { ok: false, why: `算不出字色「${colorText}」` };

  // 字必须**亮**：深字压深底是这一族的病根。
  if (luminance(fg.rgb) < 0.15) {
    return { ok: false, why: `字色「${colorText}」是深色（亮度 ${luminance(fg.rgb).toFixed(3)}）——深字压深底读不出来` };
  }

  const bgText = decl(body, 'background-color') || decl(body, 'background');
  if (!bgText || /^transparent$/i.test(bgText)) {
    // 底是透明的：这块压在 3D 场景上，只能靠暗影托住。
    if (!/text-shadow\s*:/.test(body)) {
      return { ok: false, why: '底是透明的（压在 3D 场景上）却没有 text-shadow——浅字落在浅色路面上照样读不出' };
    }
    return { ok: true, why: '浅字 + 暗影' };
  }
  const bg = resolveColor(bgText);
  if (!bg) return { ok: false, why: `算不出底色「${bgText}」` };

  if (bg.alpha >= 0.999) {
    const r = contrast(fg.rgb, bg.rgb);
    return r >= 4.5
      ? { ok: true, why: `对比度 ${r.toFixed(2)}:1` }
      : { ok: false, why: `字与底的对比度只有 ${r.toFixed(2)}:1（要 ≥ 4.5）` };
  }

  // 半透底：最坏情况是它叠在**最亮的白**上。
  const back = backdrop ? resolveColor(backdrop) : { rgb: [255, 255, 255] as Rgb, alpha: 1 };
  if (!back) return { ok: false, why: `算不出底下的东西「${backdrop}」` };
  const worst = Math.min(
    contrast(fg.rgb, composite(bg.rgb, bg.alpha, back.rgb)),
    contrast(fg.rgb, composite(bg.rgb, bg.alpha, [0, 0, 0])),
  );
  return worst >= 4.5
    ? { ok: true, why: `最坏情况对比度 ${worst.toFixed(2)}:1` }
    : { ok: false, why: `叠在最亮背景上时对比度只有 ${worst.toFixed(2)}:1（要 ≥ 4.5）` };
}

/** 由 `entry.ts` 在原位调用一次，见文件头。 */
export function registerUiContrastChecks(check: CheckFn): void {

  /**
   * 一族玩家看得见、而判据看不见的回归 —— 第十三轮实机撞出来的那一条。
   *
   * ## 这条证不了什么
   *
   * 证不了「玩家看得见」。无头没有排版引擎。
   *
   * ## 这条证什么
   *
   * 证**颜色这一半不会再翻回去**：
   * · 底板令牌（`--paper`）不许再被当字色用（通用，新增规则也归它管）；
   * · 受保护的每一块，字要亮、底要托得住它，而"托得住"是**算出来**的；
   * · 压在场景上（底透明）的那几块，必须有暗影。
   *
   * 这条**对改动前的实现是红的**——实机量到的 toast 是 1.31:1、
   * 三颗触屏按钮是 1.31~1.33:1。改回 `color: var(--paper)` 就立刻 FAIL。
   */
  check('verify_ui_text_contrast', () => {
    const probs: string[] = [];
    let asserts = 0;

    // ---- 1. 通用防线：底板令牌不许当字色 ----
    //
    // 两条写法都算输：`color: var(--paper)` 与紧凑的 `color:var(--paper)`。
    // 手工 grep 只找出 5 处，漏掉的 4 处全是紧凑写法——
    // 这就是"靠自觉守不住"的实证。
    for (const [name, css] of [
      ['ui/styles.css', UI_CSS],
      ['index.css', HOST_CSS],
    ] as const) {
      const hits = [...css.matchAll(/color\s*:\s*var\(\s*--paper[-\w]*\s*(?:,[^)]*)?\)/g)];
      asserts++;
      if (hits.length) {
        probs.push(
          `${name} 里有 ${hits.length} 处把底板令牌当字色用（${hits
            .map((h) => `「${h[0]}」`)
            .join('、')}）——` +
            '`--paper` 是**深色底板**，浅色的字一律用 `--ink`',
        );
      }
    }

    // ---- 2. 逐块算对比度 ----
    //
    // `backdrop` 给的是「这块压在什么上面」：
    // 不给 = 压在 3D 场景上（最坏情况是纯白）；
    // 给了 = 压在某个不透明底上（键帽压在药丸上）。
    const guarded: { sel: string; why: string; backdrop?: string; base?: string }[] = [
      { sel: '.g-root .g-toast', why: '提示条（游戏唯一的临时反馈通道）' },
      { sel: '.g-root .g-ring-label', why: '脚下提示圈上的那行字' },
      { sel: '.g-root .g-touch-check', why: '触屏打卡按钮' },
      {
        sel: '.g-root .g-touch-check.is-live',
        why: '触屏打卡按钮（够得着的那一态）',
        base: '.g-root .g-touch-check',
      },
      { sel: '.g-root .g-touch-act', why: '触屏「摸一下」按钮' },
      {
        sel: '.g-root .g-touch-act:active',
        why: '触屏「摸一下」按钮（按下的那一瞬）',
        base: '.g-root .g-touch-act',
      },
      { sel: '.g-root .g-touch-sq', why: '触屏暂停/音量小方块（手机上唯一的退出手段）' },
      { sel: '.g-root .g-touch-vehicle', why: '触屏载具按钮' },
      { sel: '.g-root .g-prompt-btn', why: '交互提示药丸' },
      { sel: '.g-root .g-prompt-t', why: '交互提示里的动作名' },
      { sel: '.g-root .g-prompt-key', why: '交互提示里的键帽', backdrop: 'var(--paper)' },
      { sel: '.g-lakeside-hint', why: '湖边提示语' },
      { sel: '.g-lakeside-capability', why: '湖边全景降级说明' },
    ];
    for (const g of guarded) {
      asserts++;
      const body = ruleBody(UI_CSS, g.sel);
      if (!body) {
        probs.push(`styles.css 里找不到「${g.sel}」的规则（${g.why}）——判据自己失效了`);
        continue;
      }
      // 字色：这一条自己的没有就从基规则继承（`:active` / `.is-live` 那一族
      // 只改底色，字色是继承来的——不继承的话判据会误报"没有字色"）。
      const colorText = decl(body, 'color') || (g.base ? decl(ruleBody(UI_CSS, g.base), 'color') : '');
      const r = legibility(body, colorText, g.backdrop);
      asserts++;
      if (!r.ok) {
        probs.push(`${g.why}（${g.sel}）${r.why}`);
      }
    }

    // ---- 3. 动作名必须有自己的底 ----
    //
    // 它原来只有一道 text-shadow，底下是 3D 场景：
    // 实机截图里「进入小铺」一半泡在浅色路面上，
    // 而键帽 `Space` 有自己的框所以清楚——**最该看清的词最看不清**。
    asserts++;
    {
      const body = ruleBody(UI_CSS, '.g-root .g-prompt-t');
      const bg = decl(body, 'background-color') || decl(body, 'background');
      if (!bg || /^transparent$/i.test(bg)) {
        probs.push('.g-prompt-t 没有自己的底板——动作名浮在 3D 场景上，落在浅色路面就糊');
      }
    }

    // ---- 4. 圈上的字必须有暗影 ----
    //
    // 它压在 3D 场景上（底是透明的），底是不定的：
    // 浅字 + 一道够厚的暗影，才能在浅色路面上也读得出。
    asserts++;
    {
      const body = ruleBody(UI_CSS, '.g-root .g-ring-label');
      const sh = decl(body, 'text-shadow');
      if (!sh) {
        probs.push('.g-ring-label 没有 text-shadow——它压在场景上，浅字落在浅色路面上就散');
      }
    }

    // ---- 5. 两套色板不许同名不同义 ----
    //
    // `:root` 那一套是「宣纸与墨」（浅纸），`.g-root` 那一套是「深青蓝玻璃」（深底）。
    // 同一个 `--paper` 两个意思，就是这一族回归的根因。
    asserts++;
    {
      const hostRoot = /:root\s*\{([\s\S]*?)\}/.exec(HOST_CSS)?.[1] ?? '';
      if (/--paper\s*:/.test(hostRoot)) {
        probs.push(
          'index.css 的 `:root` 里还有 `--paper`——它和 `.g-root` 的 `--paper` 含义相反' +
            '（一个浅纸一个深底），同名不同义是这一族回归的根因。它应该叫 `--paper-legacy`。',
        );
      }
    }

    return expect(
      probs.length === 0,
      probs.join('；') ||
        '字与底都读得出来：底板令牌不当字色用，受保护的每一块对比度 ≥ 4.5:1，压在场景上的那些有暗影',
      asserts,
    );
  });
}
