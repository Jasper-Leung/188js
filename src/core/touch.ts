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
 *   3. 视口短边小于 900 CSS px —— 手机/小平板横屏
 *   4. 曾经发生过一次 `touchstart` —— **最强的一条**：手指真的按过屏
 *
 * 第 4 条是关键补充：它在混合设备上最准，而且不会误伤纯桌面
 * （纯桌面前 30 秒没人碰屏，控件不挂，占不掉左下角的点击区）。
 * 一旦触发就永久记住（这次会话内），不因为旋转或分屏又翻回去。
 *
 * ## 还有一层：手动开关
 *
 * 自动判定总有判错的时候，而"摇杆在哪儿"这种问题**没有提示就是没有答案**。
 * 所以暂停面板里有一个三态开关（自动 / 开 / 关），并且默认存在。
 * 探测只是给一个默认值，**不替玩家做最终决定**——这和画质档的处理是同一条原则。
 */
import { getLang } from '../i18n';

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

/** 当前是否应当挂触屏控件。 */
export function touchEnabled(): boolean {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return touched || hasCoarsePointer() || maxTouchPoints() > 0 || smallViewport();
}

/** 判定用的四个信号各是什么。设置面板拿它把理由写给玩家看。 */
export function touchSignals(): { coarse: boolean; points: number; small: boolean; touched: boolean } {
  return { coarse: hasCoarsePointer(), points: maxTouchPoints(), small: smallViewport(), touched };
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

/** 供设置面板显示的一句人话 */
export function touchModeLabel(): string {
  const s = touchSignals();
  if (s.touched) return getLang() === 'zh' ? '已检测到触摸' : 'Touch detected';
  if (s.coarse) return getLang() === 'zh' ? '粗指针设备' : 'Coarse pointer';
  if (s.points > 0) return getLang() === 'zh' ? `支持触摸（${s.points} 点）` : `Touch capable (${s.points} points)`;
  if (s.small) return getLang() === 'zh' ? '小屏' : 'Small screen';
  return getLang() === 'zh' ? '未检测到触摸' : 'No touch detected';
}
