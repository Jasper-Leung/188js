/**
 * 两条玩家看得见、而判据看不见的回归 —— 第九轮评审实机撞出来的那两条。
 *
 * ## 为什么要专门开一族
 *
 * 这两条有一个共同的形状：**它们全绿地活了下来**。
 * 目标句在 DOM 里、CSS 也在包里、71 条判据一条不红，
 * 而屏幕上**一个字都没有**。正反面按钮的 `is-on` 一直在正确地加和去，
 * 而选中的那颗因为底色和面板几乎同色，读起来像一块空的。
 *
 * 无头环境里没有排版引擎，所以这一族**证明不了"看得见"**——
 * 那是它的能力边界，不装。全绿证明不了，就换一组**能证的**命题：
 * 不去证"字出现了"，而去证**当初让它消失的那个结构已经不存在了**。
 * 结构对了，字就会在；结构哪天又被改回去，这一族立刻红。
 *
 * 哪条能证、哪条不能证，写在每一条的注释里，不含糊。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, stripComments, type CheckFn } from './harness';

// 回归由 `npm run verify` 跑，cwd 就是仓库根。**不要**用 `__dirname`
// （单文件 ESM 里没有它）或 `import.meta.url` 反推——后者在 esbuild 打包后
// 指向临时目录。理由与 `entry.ts` 的 `verify_payload` 那条完全一样。
const ROOT = process.cwd();
const styles = readFileSync(join(ROOT, 'src/ui/styles.css'), 'utf8');
const hudSrc = readFileSync(join(ROOT, 'src/ui/hud.ts'), 'utf8');
const itemCss = stripComments(readFileSync(join(ROOT, 'src/index.css'), 'utf8'));

/** 取一条规则的选择器正文（`{` 到配对的 `}`，CSS 里没有嵌套花括号）。 */
function ruleBody(selector: string): string {
  const i = styles.indexOf(selector);
  if (i < 0) return '';
  const open = styles.indexOf('{', i);
  if (open < 0) return '';
  const close = styles.indexOf('}', open);
  return styles.slice(open + 1, close);
}

/**
 * `.g-item*` 的规则正文。道具栏在 **`src/index.css`**，不在 `ui/styles.css`，
 * 而且那几条规则自带一大段解释 bug 来历的注释——注释里写着
 * `opacity: 0.42` 和 `width: 52px`，所以**必须先剥注释**再取规则，
 * 否则这条判据会被自己的说明文字喂绿（见文件头：只在注释里提到的不算数）。
 */
function itemRule(selector: string): string {
  const i = itemCss.indexOf(selector);
  if (i < 0) return '';
  const open = itemCss.indexOf('{', i);
  if (open < 0) return '';
  const close = itemCss.indexOf('}', open);
  return itemCss.slice(open + 1, close);
}

/** sRGB 相对亮度（WCAG 定义）。 */
function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 对比度（1..21）。两个底色之间"分不分得出来"就用它。 */
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 由一个纸色 token 还原出**白天**（`--dusk = 0`）的 RGB。
 *
 * 只有两种写法，判据只需要认这两种：
 * · `--paper:  rgb(var(--pw) var(--pg) var(--pb))`        → 原值
 * · `--paper-6: rgb(calc(var(--pw) - 40) calc(...) …)`   → 每通道减一个数
 */
function paperTokenRgb(token: string): [number, number, number] | null {
  // `--pw: calc(236 - var(--dusk) * 78);` —— 第一个数就是 dusk=0 的值。
  const base: number[] = [];
  for (const n of ['pw', 'pg', 'pb']) {
    const m = new RegExp(`--${n}:\\s*calc\\(\\s*(\\d+(?:\\.\\d+)?)`).exec(styles);
    if (!m) return null;
    base.push(Number(m[1]));
  }
  // **按分号取整条声明，不能用 `rgb\\(([^)]*)\\)`。**
  // 声明里是 `rgb(calc(var(--pw) - 40) …)` —— 括号是**嵌套**的，
  // `[^)]*` 会在 `calc(` 那个右括号处停下，拿到半截 `calc(var(--pw`。
  const decl = new RegExp(`${token}:[^;]*;`).exec(styles);
  if (!decl) return null;
  // 三通道各自减掉的那个数；`--paper` 没有减法，就是原值。
  const subs = [...decl[0].matchAll(/-\s*(\d+(?:\.\d+)?)\s*\)/g)].map((m) => Number(m[1]));
  if (subs.length === 0) return base as [number, number, number];
  if (subs.length !== 3) return null;
  return subs.map((v, i) => base[i] - v) as [number, number, number];
}

/** 由 `entry.ts` 在原位调用一次，见文件头。 */
export function registerUiRegressionChecks(check: CheckFn): void {

  // ---------------------------------------------------------------- 目标句

  /**
   * ## 这条证不了什么
   *
   * 证不了「那句字在屏幕上」。无头没有排版引擎，`expect()` 也看不见像素。
   *
   * ## 这条证什么
   *
   * 证**当初让它消失的那个结构已经不存在了**：
   * 碎片栏曾经写死 `top: 3.3em`——那是按**顶栏只有一行**量出来的，
   * 而目标句（`flex-basis: 100%`）把顶栏撑成两行之后，
   * 碎片栏正好压在那行字上；它又是 `position: absolute` 且在 DOM 里更靠后，
   * **后绘制**，于是把字盖了。而 `styles.css` 里当时还挂着一句自我提醒：
   * 「凡是动 `.g-top` 的高度，这里必须一起动」。提醒没有生效。
   *
   * 所以现在守的是那个**根因**而不是那次事故：
   * · `.g-frags` 的定位基准必须是顶栏自己（`top: 100%`），不能再是某个 em 数；
   * · 而要让 `top: 100%` 有意义，碎片栏必须**是顶栏的子元素**——
   *   挂在 `.g-root` 下时 `top: 100%` 会变成"铺满整屏"。
   * 这两条同时成立，结构上就不可能再撞。
   */
  check('verify_hud_objective_visible', () => {
    const probs: string[] = [];
    let asserts = 0;

    const frags = ruleBody('.g-root .g-frags {');
    asserts++;
    if (!frags) probs.push('找不到 .g-frags 的规则');
    asserts++;
    if (!/top:\s*100%/.test(frags)) {
      const hard = /top:\s*([\d.]+)em/.exec(frags);
      probs.push(
        hard
          ? `.g-frags 又是写死的 top: ${hard[1]}em —— 这正是盖住目标句的那个结构`
          : '.g-frags 的 top 不是 100%，它不再跟着顶栏的高度走',
      );
    }
    // 目标句必须能折到第二行，否则它和第一行挤在一起，碎片栏仍然会压上去。
    const obj = ruleBody('.g-root .g-objective {');
    asserts++;
    if (!obj) probs.push('找不到 .g-objective 的规则');
    asserts++;
    if (!/flex:\s*0\s+0\s+100%/.test(obj)) {
      probs.push('.g-objective 不再独占一行（缺 flex: 0 0 100%）');
    }
    asserts++;
    if (!/color:\s*var\(--ink-soft\)/.test(obj)) {
      probs.push('.g-objective 的颜色不是 --ink-soft');
    }

    // 结构：碎片栏要挂进 `top` 里。
    // 数**出现次数**：定义一次 + 挂载一次。只挂到 `root` 上就是漏了那一半。
    asserts++;
    if (!/top\.appendChild\(fb\)/.test(hudSrc)) {
      probs.push('hud.ts 没有把碎片栏挂进 top（它必须挂在顶栏里面，top: 100% 才有意义）');
    }
    asserts++;
    if (/this\.root\.appendChild\(fb\)/.test(hudSrc)) {
      probs.push('碎片栏仍然挂在 root 上——那样 top: 100% 会变成铺满整屏');
    }
    // 目标句元素本身也必须在 top 里。
    asserts++;
    if (!/top\.appendChild\(this\.objectiveEl\)/.test(hudSrc)) {
      probs.push('目标句没有被挂进顶栏');
    }

    return expect(probs.length === 0, probs.join('；') || '碎片栏跟着顶栏高度走，目标句不再被压住', asserts);
  });

  // ---------------------------------------------------------------- 正反面

  /**
   * ## 这条证不了什么
   *
   * 证不了「那颗按钮看起来是选中的」。颜色好不好看得看屏幕。
   *
   * ## 这条证什么
   *
   * 证**激活态与面板底色之间的对比度够高**——这一条是可以算的，
   * 而原来的 bug 正是一个**可算却没算**的东西：
   * `--paper-3` 比 `--paper` 只深 16/18/20，而卡片底色就是 `--paper`，
   * 所以「选中」这个状态全靠一个约 7% 的底色差扛着。
   * 按 WCAG 相对亮度算下来，对比度只有 **1.19**；
   * 换成 `--paper-6`（深 40/44/48）之后是 **1.59**。
   *
   * 阈值取 **1.30**：它落在 1.19 与 1.59 中间。
   * 这条**对改动前的实现是红的**——实测过（把 `.g-tab.is-on` 改回
   * `--paper-3`，这一条立刻 FAIL），不是事后补的一段注释。
   */
  check('verify_postcard_tabs', () => {
    const probs: string[] = [];
    let asserts = 0;

    const on = ruleBody('.g-root .g-tab.is-on {');
    asserts++;
    if (!on) {
      probs.push('找不到 .g-tab.is-on 的规则');
    } else {
      // 1) 底色差够大
      const tok = /background:\s*var\((--paper-\d+)\)/.exec(on);
      asserts++;
      if (!tok) {
        probs.push('.g-tab.is-on 没有一个纸色底（这是「选中」唯一的底色信号）');
      } else {
        const card = ruleBody('.g-root .g-card {');
        asserts++;
        const cardTok = /background:\s*var\((--paper[\w-]*)\)/.exec(card);
        asserts++;
        if (!cardTok) {
          probs.push('找不到 .g-card 的底色，算不出对比度');
        } else {
          const sel = paperTokenRgb(tok[1]);
          const base = paperTokenRgb(cardTok[1]);
          asserts++;
          if (!sel || !base) {
            probs.push(`还原 ${tok[1]} / ${cardTok[1]} 的 RGB 失败，算不出对比度`);
          } else {
            const ratio = contrast(sel, base);
            asserts++;
            if (ratio < 1.3) {
              probs.push(
                `选中底色 ${tok[1]} 与卡片底色 ${cardTok[1]} 的对比度只有 ${ratio.toFixed(2)}` +
                  `（应 ≥ 1.30；改动前是 1.19，那正是「读起来像透明」的原因）`,
              );
            }
          }
        }
      }
      // 2) 不能只有底色：字重要变
      asserts++;
      if (!/font-weight:\s*(600|bold)/.test(on)) {
        probs.push('.g-tab.is-on 没有加字重——底色在灰度屏上会一起失效');
      }
      // 3) 再加一道强调色的下沿线
      asserts++;
      if (!/box-shadow:[\s\S]*inset[\s\S]*var\(--accent\)/.test(on)) {
        probs.push('.g-tab.is-on 没有那道朱砂下沿线');
      }
    }

    // 读屏也要能知道现在看的是哪一面：两颗按钮的文字永远一样。
    // 匹配的是 `setAttribute('role', 'tablist')` 这种写法——
    // 早先写成找 `role="tablist"` 这个字符串形式，判据红了一次，
    // 而红的原因是**判据找错了写法**，不是实现没做。
    const endSrc = readFileSync(join(ROOT, 'src/ui/endCard.ts'), 'utf8');
    asserts++;
    if (!/aria-selected/.test(endSrc)) {
      probs.push('endCard.ts 没有 aria-selected——键盘/读屏用户听不出自己切没切过面');
    }
    asserts++;
    if (!/setAttribute\(\s*'role',\s*'tablist'\s*\)/.test(endSrc)) {
      probs.push('正反面那一组没有 role="tablist"');
    }
    asserts++;
    if (!/setAttribute\(\s*'role',\s*'tab'\s*\)/.test(endSrc)) {
      probs.push('两颗按钮没有 role="tab"');
    }

    return expect(probs.length === 0, probs.join('；') || '正反面的选中态有底色 + 字重 + 下沿线三道信号', asserts);
  });

  // ------------------------------------------------------------ 道具栏压车身

  /**
   * ## 这条证不了什么
   *
   * 证不了「道具栏在 `first` 机位下好看」。那是像素，无头没有排版引擎。
   *
   * ## 这条证什么
   *
   * 证当初让它"文字直接印在车篮上"的那个结构已经不存在了。两个根因：
   *
   * 1. `.g-item` 整格挂 `opacity: 0.42` —— 那是把**底板**也变半透明，
   *    于是车把/车篮从格子里透出来。而"没买到显示成暗的一格"要暗的是**字**。
   * 2. 格子写死 `width: 52px`，而 `first` 机位下车把横过整条底部，
   *    `Envelope` 需要 57px → 被切成 `Envelop`，缺的那个字母掉在深色车篮上，
   *    读起来像本来就没有第四件道具。
   *
   * 守的是结构（底板不许有 opacity / 宽度不许写死 / 标签不许折行），
   * 结构对了字就在；哪天改回去立刻红。
   */
  check('verify_itembar_over_body', () => {
    const probs: string[] = [];
    let asserts = 0;

    const cell = itemRule('.g-item {');
    asserts++;
    if (!cell) {
      probs.push('index.css 里找不到 .g-item 的规则');
    } else {
      asserts++;
      if (/(^|[\s;])opacity\s*:/.test(cell)) {
        probs.push('.g-item 又挂了 opacity —— 底板跟着变半透明，车篮会从格子里透出来');
      }
      asserts++;
      if (/(^|[\s;])width\s*:\s*[\d.]+px/.test(cell)) {
        probs.push('.g-item 的宽度又写死成 px —— 最长的标签（Envelope）会被切掉');
      }
      asserts++;
      if (!/min-width\s*:\s*[\d.]+px/.test(cell)) {
        probs.push('.g-item 没有 min-width，格子无法跟着最长的标签长');
      }
      // 底板必须够不透明：0.82 的 alpha 挡不住紧贴着后面的车身几何。
      const bg = /background:\s*rgba?\([^)]*?([\d.]+)\s*\)/.exec(cell);
      asserts++;
      if (!bg) {
        probs.push('找不到 .g-item 的底色，算不出它挡不挡得住后面的车');
      } else if (Number(bg[1]) < 0.9) {
        probs.push(`.g-item 底色透明度只有 ${bg[1]}，要 ≥ 0.9 才挡得住紧贴着的车篮`);
      }
    }

    const ic = itemRule('.g-item-ic {');
    asserts++;
    if (!ic) {
      probs.push('找不到 .g-item-ic 的规则');
    } else {
      asserts++;
      if (!/white-space\s*:\s*nowrap/.test(ic)) {
        probs.push('.g-item-ic 没有 nowrap —— 标签会折行而不是把格子撑宽');
      }
    }

    // "没买到显示成暗的一格"这条意图必须落在**字**上，不能落回整格 opacity。
    asserts++;
    if (!/g-item:not\(\.is-own\)\s+\.g-item-ic/.test(itemCss)) {
      probs.push('没有针对 .g-item:not(.is-own) 的字色规则 —— 未买到的格子无法只暗字');
    }

    // 道具栏必须压在车身几何之上：它 z-index 6，而卡片是 8、提示更高。
    // 少了这条，格子的底板再实也可能被后画的层盖掉。
    asserts++;
    if (!/z-index\s*:\s*[1-9]/.test(itemRule('.g-itembar {'))) {
      probs.push('.g-itembar 没有 z-index —— 它和车身几何谁在上就说不清了');
    }

    return expect(probs.length === 0, probs.join('；') || '道具栏底板不透明、宽度跟着标签走，压在车身上也读得出', asserts);
  });
}
