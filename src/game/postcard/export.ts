/**
 * 明信片导出 PNG —— 正反两面各一张 `CARD_SIZE` 的位图。
 *
 * ## 为什么导出是异步的
 *
 * 玩家在背面写的字要用手写体 `public/fonts/handwriting.woff2`（家族名 `GiftHand`，
 * 约 404KB）。**画布 2D 用一个还没 load 完的字体族去 `fillText`，不会报错、
 * 不会回退提示、也不会等——它直接用当时能拿到的最后一套字形画完。**
 * 于是会出现：界面里打字看得见（DOM 有回流，字体到位了），导出的 PNG 却是一套
 * 系统字体的字形。所以导出必须先 `await document.fonts.load('32px "GiftHand"')`。
 *
 * `ensureHandwritingFont()` 干两件事：
 *   1. 先问 `document.fonts.check()`——如果外层（index.html / UI 那边的
 *      `@font-face`）已经声明了 `GiftHand`，直接 `load()` 即可；
 *   2. 没声明就自己注册一个 `FontFace`。这样本模块**不依赖别的文件有没有写
 *      @font-face**，导出这条路自己走得通（而 `@font-face` 归 UI 那边的文件管，
 *      不在本任务的边界内）。
 *
 * 失败不抛：字体拿不到就退回 `FONT_HAND` 里声明的系统兜底字体导出，
 * 总比整条导出按钮报错、把玩家这一趟的产物弄丢要好。
 */
import { CARD_SIZE } from './types';
import type { PostcardInput } from './types';
import { BACK_MAX_CHARS, FONT_HAND, FONT_UI } from './layout';
import { drawBack, drawFront } from './render';

/** `document.fonts.load()` 用的探测字号。**任何固定字号都行**，只要和
 *  `FONT_HAND` 的家族名一致——但必须传一个尺寸，字号本身不参与判断。 */
const PROBE_SIZE = 32;

/** 手写体在 `public/` 下的路径。用 `document.baseURI` 拼，
 *  这样 Vite 的 `base` 配成子路径时也不会 404。 */
const HANDWRITING_PATH = 'fonts/handwriting.woff2';

/** 取字体栈里**第一项**的家族名——那一项才是 `document.fonts.load` 要等的那个。 */
function firstFamilyOf(stack: string): string {
  const first = stack.split(',')[0].trim();
  return first.replace(/^["']|["']$/g, '');
}

/**
 * 宿主注册 `@font-face` 要用的**手写体家族名**。
 *
 * ```css
 * @font-face {
 *   font-family: 'GiftHand';
 *   src: url('/fonts/handwriting.woff2') format('woff2');
 *   font-display: swap;
 * }
 * ```
 *
 * 它是**从 `layout.FONT_HAND` 的第一项解析出来的**，本模块不再另抄一份字符串。
 * 这一条是硬性的：`check()` / `load()` 用的是解析出来的名字，而 `FontFace`
 * 曾经用的是写死的 `'GiftHand'`——两处一旦不一致，`check` 恒为 false、
 * `load` 静默失败，**导出的 PNG 就悄悄退回系统字体**，界面上却看不出任何异常
 * （DOM 有回流、字体到位，只有 canvas 那条路没有）。
 * 那正是 `layout.ts` 顶部"布局表与颜色表各抄一份、整体错位一格"同一类事故。
 */
export const FONT_FAMILY = firstFamilyOf(FONT_HAND);

/** 印刷体家族名（`public/fonts/ui.woff2`，首屏就加载的那份子集）。 */
export const UI_FONT_FAMILY = firstFamilyOf(FONT_UI);

let handFontPromise: Promise<boolean> | null = null;
let registeredFace = false;

/** 字体是否已经能用了。 */
export function isHandwritingReady(): boolean {
  if (typeof document === 'undefined' || !document.fonts) return false;
  return document.fonts.check(`${PROBE_SIZE}px "${FONT_FAMILY}"`);
}

/**
 * 确保手写体可用。幂等：第一次真的去加载，之后复用同一个 Promise。
 *
 * 返回值是"最终能不能拿到手写体"——`false` 表示已经退回系统兜底字体，
 * 调用方可以据此提示，但**不必因此放弃导出**。
 */
export function ensureHandwritingFont(): Promise<boolean> {
  if (handFontPromise) return handFontPromise;

  handFontPromise = (async () => {
    if (typeof document === 'undefined' || !document.fonts) return false;
    const spec = `${PROBE_SIZE}px "${FONT_FAMILY}"`;
    try {
      // 1) 外层（index.html 的 @font-face 或别的模块）已经声明过这个家族。
      //    先直接问它要一次：已加载的立刻返回；**声明了但还在下载的会在这里等到**。
      //    这一步必须在下面"自己注册"之前，否则宿主刚声明、还没下载完的窗口期里
      //    `check()` 恒为 false，我们会再注册一份同家族的 FontFace ——
      //    白白多拉一次 404KB，且 FontFaceSet 里多一个同名候选。
      if (document.fonts.check(spec)) return true;
      await document.fonts.load(spec);
      if (document.fonts.check(spec)) return true;
    } catch {
      // 落到 2)
    }
    try {
      // 2) 自己注册一个。家族名取 FONT_FAMILY（从 FONT_HAND 解析），
      //    与上面 check/load 用的是同一个值——不许在这里写死字符串。
      if (!registeredFace && typeof FontFace !== 'undefined') {
        const url = new URL(HANDWRITING_PATH, document.baseURI).href;
        const face = new FontFace(FONT_FAMILY, `url("${url}")`);
        await face.load();
        document.fonts.add(face);
        registeredFace = true;
        await document.fonts.load(spec);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  })();

  return handFontPromise;
}

/** 产出一块空白画布。不透明、不缩放、默认色彩空间（sRGB）。 */
function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = CARD_SIZE.w;
  c.height = CARD_SIZE.h;
  return c;
}

/**
 * 导出 PNG。返回 Blob。
 *
 * · 尺寸就是 `CARD_SIZE`（1920×1080），和原作 `EndCard.gd` 里
 *   `_postcard_export.size` / `_back_viewport.size` 一致。正反两面同尺寸，
 *   导出时两张 PNG 能直接拼成一张 1920×2160 的对折卡。
 * · **每一面都重新建画布重画一遍**，不复用预览那块 canvas——预览是
 *   降采样的、且可能还带着上一次的内容。
 * · 背面一定先 `await ensureHandwritingFont()`；正面不写手写体字，
 *   但顺手一起等掉（同一次 Promise，之后导出背面就是零成本）。
 */
export async function exportPostcardPng(
  input: PostcardInput,
  side: 'front' | 'back',
): Promise<Blob> {
  await ensureHandwritingFont();

  const canvas = makeCanvas();
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('拿不到 2D 上下文');

  // 不设任何 transform：画笔按 `canvas.width` 自己推 `k`，见 render.ts 文件头。
  if (side === 'front') drawFront(ctx, input);
  else drawBack(ctx, input);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('canvas.toBlob 返回了 null'));
    }, 'image/png');
  });
}

/**
 * 导出文件名。原作桌面版写的是 `gift_188_front.png` / `gift_188_back.png`，
 * Web 端沿用同一对名字，免得玩家在两个平台之间对不上。
 */
export function exportFileName(side: 'front' | 'back'): string {
  return side === 'front' ? 'gift_188_front.png' : 'gift_188_back.png';
}

/** 顺手把玩家写的字截到上限。UI 的输入框应当也调它，
 *  而导出路径内部还有一道 `slice` 兜底——两头都留着是有意的：
 *  原作在 `TextEdit.text_changed` 里用 `substr` 兜住，
 *  而那张 200 字的卡是玩家写满时的那一张。 */
export function clampBackText(s: string): string {
  return s.slice(0, BACK_MAX_CHARS);
}
