/**
 * 极小的 DOM 构造 helper。
 *
 * 整个 UI 层的全部 DOM 操作都从这里过，目的是把**「每帧不重建 DOM」**这条
 * 要求变成一件由类型系统兜底的事：这里没有任何一个「把子节点全删了再按数据
 * 重新生成一遍」的接口，只有 `el()`（建一次）和 `setText()` / `setStyle()`
 * （改内容，带缓存）。想在 `update(dt)` 里重建列表的人会发现无路可走。
 *
 * ## 为什么 setText 要带缓存
 *
 * 「已过 n 驿」这一行每帧都会被碰到，而 `n` 只在路过新驿的那一帧变。
 * 无脑写 `textContent` 看着无害，代价是**每帧一次样式重算 + 一次布局失效**：
 * 顶栏下面就是碎片栏和脚下提示圈，每次失效都要把它们一起重排。
 * 60 帧乘以一行文字，在 4GB 内存的核显笔记本上就是持续 2~3% 的主线程。
 * 而「只在一行字的**内容**真的变了时才写」这个缓存，是零成本的。
 *
 * 缓存放在 WeakMap 而不是挂在元素上：元素一被丢弃，缓存条目也跟着回收，
 * 不会有泄漏；而在元素上挂 `_lastText` 会和 HTMLElement 的类型打架。
 */

/** 建一个元素。`cls` 会拼上 `g-` 前缀（见 `cn`）。传 null 与不传等价。 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string | null,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 拼类名。`cn('hud-bar', on && 'is-on')` —— 条件项传 false/null 直接略过。 */
export function cn(...parts: (string | false | null | undefined)[]): string {
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    out = out ? out + ' ' + p : p;
  }
  return out;
}

const lastText = new WeakMap<Node, string>();
const lastStyle = new WeakMap<HTMLElement, Map<string, string>>();
const lastCls = new WeakMap<HTMLElement, Map<string, boolean>>();

/** 写文本，**内容没变就不写**。见文件头。 */
export function setText(node: Node, s: string): void {
  if (lastText.get(node) === s) return;
  lastText.set(node, s);
  node.textContent = s;
}

/** 写行内样式，值没变就不写。 */
export function setStyle(node: HTMLElement, prop: string, value: string): void {
  let m = lastStyle.get(node);
  if (!m) {
    m = new Map();
    lastStyle.set(node, m);
  }
  if (m.get(prop) === value) return;
  m.set(prop, value);
  node.style.setProperty(prop, value);
}

/** 加/去一个类，带缓存。 */
export function setFlag(node: HTMLElement, cls: string, on: boolean): void {
  let m = lastCls.get(node);
  if (!m) {
    m = new Map();
    lastCls.set(node, m);
  }
  if (m.get(cls) === on) return;
  m.set(cls, on);
  node.classList.toggle(cls, on);
}

const lastAttr = new WeakMap<HTMLElement, Map<string, string>>();

/** 写属性，值没变就不写。无障碍名（`aria-label`）每帧跟着界面走时靠它。 */
export function setAttr(node: HTMLElement, name: string, value: string): void {
  let m = lastAttr.get(node);
  if (!m) {
    m = new Map();
    lastAttr.set(node, m);
  }
  if (m.get(name) === value) return;
  m.set(name, value);
  node.setAttribute(name, value);
}

/** 显示/隐藏一整块。用 class 而不是 `display:none` 的内联样式，好让 CSS 管过渡。 */
export function setShown(node: HTMLElement, shown: boolean): void {
  setFlag(node, 'g-hidden', !shown);
}

/** 当前是不是显示着。`syncFromState()` 用它当门：看不见的面板不去重建。 */
export function isShown(node: HTMLElement): boolean {
  return !node.classList.contains('g-hidden');
}

export function setDisabled(node: HTMLButtonElement, disabled: boolean): void {
  if (node.disabled === disabled) return;
  node.disabled = disabled;
}

export function on<K extends keyof HTMLElementEventMap>(
  node: HTMLElement,
  type: K,
  fn: (ev: HTMLElementEventMap[K]) => void,
  opts?: AddEventListenerOptions,
): () => void {
  node.addEventListener(type, fn as EventListener, opts);
  return () => node.removeEventListener(type, fn as EventListener, opts);
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export interface ButtonOpts {
  cls?: string;
  /** 无障碍名。按钮里只有图形没有字时必给。 */
  aria?: string;
  title?: string;
  /** 设为 false 时这个按钮只是不能按（灰），而不是不出现 */
  onClick?: (ev: MouseEvent) => void;
}

/**
 * 建一个按钮。
 *
 * 永远是 `<button type="button">`：`type` 不写的话它落在 `<form>` 里
 * 就是一个 submit，而本工程的外壳将来挂个表单就会让"点开始"变成刷新页面。
 *
 * 这里**不做** `tabindex` / 焦点管理——原生 `<button>` 已经可 Tab、可用
 * Enter/Space 激活，额外设置只会破坏浏览器的顺序焦点逻辑。
 */
export function button(text: string, o: ButtonOpts = {}): HTMLButtonElement {
  const b = el('button', cn('g-btn', o.cls, 'g-fade'), text);
  b.type = 'button';
  if (o.aria) b.setAttribute('aria-label', o.aria);
  if (o.title) b.title = o.title;
  if (o.onClick) b.addEventListener('click', o.onClick);
  return b;
}

/**
 * 一行「标签 / 值」，设置面板与暂停面板里到处都是。
 * 值节点单独返回，因为它是 `setText` 每帧要碰的那个。
 */
export function row(label: string, cls?: string): { row: HTMLDivElement; value: HTMLSpanElement } {
  const r = el('div', cn('g-row', cls));
  r.appendChild(el('span', 'g-row-k', label));
  const v = el('span', 'g-row-v');
  r.appendChild(v);
  return { row: r, value: v };
}

/** 一行「标签 / 一串小标签」。返回写小标签的函数。 */
export function chipRow(label: string): { row: HTMLDivElement; put: (s: string) => HTMLSpanElement } {
  const r = el('div', 'g-row');
  r.appendChild(el('span', 'g-row-k', label));
  const box = el('span', 'g-chips');
  r.appendChild(box);
  return {
    row: r,
    put: (s: string) => {
      const c = el('span', 'g-chip', s);
      box.appendChild(c);
      return c;
    },
  };
}

/** 一条水平分隔线。分隔用线不用阴影，见 theme.ts 原则 3。 */
export function rule(): HTMLDivElement {
  return el('div', 'g-rule');
}

/** 一段小字说明。 */
export function note(s: string, cls?: string): HTMLDivElement {
  return el('div', cn('g-note', cls), s);
}

/**
 * 焦点圈兜底。
 *
 * `:focus-visible` 已经能只给键盘焦点画圈（styles.css 里写了），
 * 这里的 `on()` 包装是给**被程序 focus 的元素**用的：Tab 切过去的按钮
 * 浏览器会画，JS 主动 focus 的（比如打开面板时把焦点放回第一个按钮）
 * 也会画——真正画不出来的是老浏览器，所以留一个 `g-force-focus` 手动加。
 * 不用 `outline:none` 了事：焦点圈看不见是这个项目明确禁止的。
 */
export function focusFirst(container: HTMLElement): void {
  const first = container.querySelector<HTMLElement>(
    'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  if (first) first.focus();
}

/** 把焦点从容器里挪走（面板关闭时），否则焦点会掉回 body 而 Tab 顺序乱掉。 */
export function blurWithin(container: HTMLElement): void {
  const a = container.ownerDocument.activeElement;
  if (a && container.contains(a) && a instanceof HTMLElement) a.blur();
}
