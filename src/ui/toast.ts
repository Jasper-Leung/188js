/**
 * toast —— 屏幕下方的一叠短提示。
 *
 * 用在：黄昏提示、旅币到账、打卡被拒的原因、小游戏结果、导出成功与否。
 * 这些事的共同点是**都要说出来，但都不值得开一个面板**：开面板会停操作、
 * 会吃掉一次按键，而"刚刚才结束 · 稍等一下"这种话如果不说，玩家只会以为
 * 空格键坏了。
 *
 * ## 三条约束
 *
 * · **不抢焦点**。整条容器 `pointer-events:none`，里面的 toast 也是。
 *   一条飘过去的提示把正在按的空格键吃掉，玩家的车会突然停住——那一下
 *   "莫名其妙"比没有提示更糟。
 * · **堆叠上限 3**。原作的 `LVBI_GAIN_SHOW_SEC` 只有一个位置；
 *   超过 3 条就把最早那条挤掉，而不是往下堆到屏幕外。
 * · **不排版动画**。新的一条直接出现在最上面（append 到最后，用
 *   `column-reverse` 排成"新的在上"），只有 opacity 淡入 150ms。
 *   上移/滑入会让人盯着看它去哪，而低配机上多一个合成层就是多一份钱。
 *
 * 计时走 `update(dt)`，不用 `setTimeout`：暂停时游戏循环会停，
 * `setTimeout` 不会——玩家在提示还在的时候按了 Esc，暂停面板里那条
 * "已保存"会自己消失，而恢复之后世界已经变了。
 */
import { el } from './dom';

/** 同时最多几条。 */
const MAX_TOASTS = 3;
/** 默认停留秒数。 */
const DEFAULT_MS = 1800;

interface Item {
  node: HTMLDivElement;
  life: number;
}

export class Toast {
  readonly root: HTMLDivElement;
  private items: Item[] = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', 'g-toasts');
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    // 提示是对屏幕阅读器的补充说明，不该抢走正在操作的控件
    parent.appendChild(this.root);
  }

  /**
   * 弹一条。`ms` 传 0 表示不自动消失（配合调用方自己 sync 掉）——
   * 实际上没有调用方需要，保留是为了「已保存」这类要给玩家时间读完的场景。
   */
  show(text: string, ms = DEFAULT_MS): void {
    if (!text) return;
    const node = el('div', 'g-toast g-fade', text);
    this.root.appendChild(node);
    this.items.push({ node, life: ms / 1000 });

    while (this.items.length > MAX_TOASTS) {
      const old = this.items.shift();
      if (old) old.node.remove();
    }
  }

  update(dt: number): void {
    if (this.items.length === 0 || dt <= 0) return;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.life -= dt;
      if (it.life > 0) continue;
      it.node.remove();
      this.items.splice(i, 1);
    }
  }

  /** 立刻收掉全部（切语言、重开、读档之后）。 */
  clear(): void {
    for (const it of this.items) it.node.remove();
    this.items.length = 0;
  }

  dispose(): void {
    this.clear();
    this.root.remove();
  }
}
