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
/**
 * 同一句话连发的最短间隔（秒）。
 *
 * 竹丛挨着竹丛的时候，每一片都各自合法地 cue 一次（`BambooBeats` 里是按丛去重的），
 * 于是玩家会在十几秒里看到三条一模一样的「前面有竹」。第一条之后的那两条没有新信息——
 * 真正的信号是 HUD 上那个收缩的圈，它不重复。
 *
 * 关掉这一层跑一遍演示就知道它挡的是什么：骑快了**三条会同时躺在屏上**，
 * 三行一模一样的字摞在屏幕底部，把真正要读的那一条埋掉。这不是"多读了两遍"，
 * 是"该读的没读到"。
 *
 * 3s 这个数两头都有约束：
 *  · **下界 `> DEFAULT_MS/1000`**：重复的那条绝不能落在第一条还在屏上的时候，
 *    否则两条一模一样的字会并排躺着。
 *  · **上界「读完也忘掉了」**：演示里相邻两丛最近的一次相距约 2.7s。
 *    2s 拦不住它——那两条只是擦着错开，本来就没叠。而 3s 之后仍然是每丛一次，
 *    因为真正的新一丛是玩家主动骑过去的，间隔远大于 3s，误伤不了。
 *
 * 去重放在这一层而不是 `beatOn` 里：toast 是唯一知道「屏上现在有什么」的地方，
 * 在这里拦，以后任何一条新加的提示都不会再犯同一个错。
 */
const REPEAT_GAP_SEC = 3.0;

interface Item {
  node: HTMLDivElement;
  life: number;
}

export class Toast {
  readonly root: HTMLDivElement;
  private items: Item[] = [];
  /**
   * `update(dt)` 攒出来的累计秒数。
   *
   * 不用 `Date.now()`：这一层刻意不碰 `setTimeout`（见文件头），
   * 墙钟会让"玩家在暂停面板里待了多久"漏进提示的去重里。
   */
  private clock = 0;
  private repeatText = '';
  private repeatAt = 0;

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
    // 被压掉的那一条**不**刷新时间戳：锚点永远是最近一次真的上屏的那条。
    if (text === this.repeatText && this.clock - this.repeatAt < REPEAT_GAP_SEC) return;
    this.repeatText = text;
    this.repeatAt = this.clock;
    const node = el('div', 'g-toast g-fade', text);
    this.root.appendChild(node);
    this.items.push({ node, life: ms / 1000 });

    while (this.items.length > MAX_TOASTS) {
      const old = this.items.shift();
      if (old) old.node.remove();
    }
  }

  update(dt: number): void {
    // 时钟要在早退**之前**推进。反过来的话，提示全消掉之后时钟就冻住了，
    // 下一次真的隔了很久才来的同一句话会被当成"刚刚说过"而压掉。
    if (dt > 0) this.clock += dt;
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
