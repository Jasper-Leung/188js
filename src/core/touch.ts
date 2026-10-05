/**
 * 触屏判定 —— 决定"要不要挂摇杆"。
 *
 * ## 为什么不能只看 `pointer: coarse`
 *
 * 最直观的写法是 `matchMedia('(pointer: coarse)').matches`，原实现就是这么写的，
 * 后果是**相当一部分真机拿不到控件**：
 *
 *   · 开了「桌面版网站」的安卓 Chrome —— coarse 变 false，摇杆消失
 *   · Windows 触屏笔记本 —— 主指针是鼠标，coarse 是 false，但用户可能正拿手指玩
 *   · 平板横屏 / 分屏 —— coarse 随主指针变，旋转一次就翻一次
 *   · 部分安卓 WebView —— 压根不报 pointer media query
 *
 * 症状是"手机上玩不到这个游戏"：控件没挂，而且**界面上没有任何线索说它存在**。
 *
 * ## 现在的判据
 *
 * 四个信号取或，任一为真就当触屏：
 *   1. `pointer: coarse` —— 真的没有精细指针
 *   2. `navigator.maxTouchPoints > 0` —— 有触点就认为用户可能用手指
 *   3. 视口短边小于 900 CSS px **且没有精确指针** —— 见下面「小屏这一条踩过坑」
 *   4. 曾经发生过一次 `touchstart` —— **最强的一条**：手指真的按过屏
 *
 * 第 4 条是关键补充：它在混合设备上最准，而且不会误伤纯桌面
 * （纯桌面前 30 秒没人碰屏，控件不挂，占不掉左下角的点击区）。
 * 一旦触发就永久记住（这次会话内），不因为旋转或分屏又翻回去。
 *
 * ## 小屏这一条踩过坑：窄窗口 ≠ 小设备
 *
 * 第 3 条原本写成 `min(innerWidth, innerHeight) < 900`，想抓的是
 * 「手机 / 小平板横屏」。但**它分不出「窄的窗口」和「小的设备」**：
 * 桌面浏览器窗口贴靠半屏（1440 笔记本对半 = 720×1440）、侧栏分屏、
 * 浏览器缩放到 130%、Windows 贴靠布局——短边统统掉到 900 以下，
 * 于是一个**用鼠标的桌面玩家**被挂上一个他根本用不了的摇杆，
 * 而摇杆占住左下四分之一屏。
 *
 * 症状有欺骗性：界面「多了一套控件」，画面看着像手机版，
 * 但键盘玩家会发现左下角有个永远推不动的东西盖住了小地图。
 *
 * 判据因此加一道 `any-pointer: fine`。这条不误伤它本来要抓的那些：
 *   · 手机竖屏 —— 第 1 条（coarse）本来就为真，摇杆照挂；
 *   · 手机开「桌面版网站」—— coarse 变 false，但第 2 条
 *     （maxTouchPoints > 0）接住；
 *   · 不报 pointer media query 的安卓 WebView —— fine 取不到值按 false，
 *     第 3 条仍然成立，而那本来就是它唯一能生效的理由。
 *
 * 也就是说：**只有「既小、又确实摸不到鼠标」才算小屏设备**。
 *
 * ## 还有一层：手动开关
 *
 * 自动判定总有判错的时候，而"摇杆在哪儿"这种问题**没有提示就是没有答案**。
 * 所以暂停面板里有一个三态开关（自动 / 开 / 关），并且默认存在。
 * 探测只是给一个默认值，**不替玩家做最终决定**——这和画质档的处理是同一条原则。
 */
import { t } from '../i18n';

export type TouchMode = 'auto' | 'on' | 'off';

const KEY = 'gift188.touchmode';

let mode: TouchMode = load();
/** 本次会话里"真的被碰过屏" */
let touched = false;
const listeners = new Set<(on: boolean) => void>();

function load(): TouchMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'auto' || v === 'on' || v === 'off') return v;
  } catch {
    /* 忽略 */
  }
  return 'auto';
}

function save() {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* 忽略 */
  }
}

function hasCoarsePointer(): boolean {
  try {
    return matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

function maxTouchPoints(): number {
  return typeof navigator !== 'undefined' ? (navigator.maxTouchPoints ?? 0) : 0;
}

function smallViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return Math.min(window.innerWidth, window.innerHeight) < 900;
}

/**
 * 有没有精确指针（鼠标 / 触控板）。
 *
 * 取不到值一律按 false —— 即「当作没有鼠标」，于是小屏信号照常生效。
 * 这个默认值是故意的：它在**没有精确指针的设备**上才是对的，而取不到值的
 * 设备（老 WebView）本来就没有鼠标可按。
 */
function hasFinePointer(): boolean {
  try {
    return matchMedia('(any-pointer: fine)').matches;
  } catch {
    return false;
  }
}

/**
 * 触屏判定的**纯逻辑部分**。
 *
 * 单独抽出来是因为上面那条「窄窗口会误判」的坑是**在这台机器上真的踩到过的**
 * ——而原来 `touchEnabled()` 直接读 `matchMedia` 与 `navigator`，
 * 无头回归里根本没有 `window`，钉不住它。
 *
 * 抽成纯函数后 `verify_touch` 才能对它下断言（见 `entry.ts` 里的
 * 「窄桌面窗口不该挂摇杆」）。
 */
export function decideTouch(s: {
  /** `pointer: coarse` */
  coarse: boolean;
  /** `navigator.maxTouchPoints` */
  points: number;
  /** `any-pointer: fine` */
  fine: boolean;
  /** `min(innerWidth, innerHeight)` */
  shortEdge: number;
  /** 本次会话是否真的发生过一次 `touchstart` */
  touched: boolean;
}): boolean {
  if (s.touched) return true;
  if (s.coarse) return true;
  if (s.points > 0) return true;
  // 小屏**且没有鼠标**：窄窗口不是小设备，见文件头「小屏这一条踩过坑」
  return s.shortEdge < 900 && !s.fine;
}

/** 当前是否应当挂触屏控件。 */
export function touchEnabled(): boolean {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return decideTouch({
    coarse: hasCoarsePointer(),
    points: maxTouchPoints(),
    fine: hasFinePointer(),
    shortEdge: typeof window === 'undefined' ? 0 : Math.min(window.innerWidth, window.innerHeight),
    touched,
  });
}

/** 判定用的四个信号各是什么。设置面板拿它把理由写给玩家看。 */
export function touchSignals(): { coarse: boolean; points: number; fine: boolean; small: boolean; touched: boolean } {
  const fine = hasFinePointer();
  return { coarse: hasCoarsePointer(), points: maxTouchPoints(), fine, small: smallViewport() && !fine, touched };
}

export function touchMode(): TouchMode {
  return mode;
}

export function setTouchMode(next: TouchMode): void {
  if (next === mode) return;
  mode = next;
  save();
  notify();
}

export function onTouchModeChange(fn: (on: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  const on = touchEnabled();
  listeners.forEach((fn) => fn(on));
}

/**
 * 装上监听。**必须在游戏开始前调**，因为 `touchstart` 一旦发生就想立刻挂上控件，
 * 等用户按下"开始"再装就晚了一拍。
 */
export function installTouchDetection(): void {
  if (typeof window === 'undefined') return;

  const onTouch = () => {
    if (touched) return;
    touched = true;
    // 只在自动模式下才需要通知——手动关掉的人不该被一次触摸顶回来
    if (mode === 'auto') notify();
  };
  // 用 capture：万一某个 UI 面板调了 stopPropagation，外层也要听得见
  window.addEventListener('touchstart', onTouch, { capture: true, passive: true });

  // 视口尺寸变了（旋转、分屏、地址栏收起）要重算
  let t = 0;
  const onResize = () => {
    clearTimeout(t);
    t = window.setTimeout(() => {
      if (mode === 'auto') notify();
    }, 180);
  };
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('orientationchange', onResize, { passive: true });

  // 鼠标与触摸的主次会切换（外接/拔掉鼠标），pointer media query 随之改变
  if (typeof matchMedia === 'function') {
    try {
      const coarse = matchMedia('(pointer: coarse)');
      coarse.addEventListener?.('change', () => {
        if (mode === 'auto') notify();
      });
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 供设置面板显示的一句人话。
 *
 * 原来在这里内联写了两套语言（`getLang() === 'zh' ? '已检测到触摸' : 'Touch detected'`）。
 * 内联双语能显示对，但它是一份**不在文案表里**的翻译：
 * 拼错、漏翻、两种语言文案不同步，都没有任何工具会发现——
 * 而这一句恰好是"手机上玩不到这个游戏"这类问题的自查入口。
 * 走 `t()` 之后它和其他文案受同一套守卫管。
 */
export function touchModeLabel(): string {
  const s = touchSignals();
  if (s.touched) return t('touch_reason_touched');
  if (s.coarse) return t('touch_reason_coarse');
  if (s.points > 0) return t('touch_reason_points', [s.points]);
  if (s.small) return t('touch_reason_small');
  return t('touch_reason_none');
}
