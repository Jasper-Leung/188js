/**
 * 心神遮罩 —— 画面压暗。
 *
 * ## 为什么是一个 DOM 覆盖层而不是后处理 pass
 *
 * 原作（`renderer.ts` 文件头记着这条）把压暗做成一个全屏后处理 pass：
 * 场景渲到一张 RT，再用一个 quad 把雾色乘上去。在 Web 上这不值：
 *
 * · 后处理是**一整趟全屏 blit**。核显的瓶颈几乎永远是填充率，
 *   1920×1080 的一次全屏采样就是 200 万个像素的读+写——和低档
 *   `renderScale: 0.6` 省下来的 36% 像素是同一个量级。
 * · 遮罩的**唯一输入是 `game.getMoodMaskAlpha()`，一个 0..0.34 的数**，
 *   且只随打卡次数变（一天里变 3 次）。用不着 GPU：浏览器合成一个
 *   半透明 div 的开销是 0，它甚至不碰 WebGL 的任何状态。
 * · 它天然跟着 UI 走——面板、对白、toast 都在它**上面**，
 *   正是原作要的效果：世界暗下去，而你要读的字不变暗。
 *
 * 代价是它盖不住 canvas 之外的东西（比如浏览器自己的滚动条），
 * 而本作没有滚动区域，这条不成立。
 *
 * ## 为什么要量化成 1/64
 *
 * 原始 alpha 每次打卡变 1/5 = 0.068，是连续的。但 `opacity` 每帧被写一次
 * 就是一次样式重算（这一层只有一个元素，所以代价很小，但它挡着整个画面，
 * 浏览器会因为它不可命中而每帧重做一次合成判断）。取整到 1/64 之后，
 * 一个心神等级只会触发**一次**写入，而视觉上 1/64 的差（最大 0.005）
 * 在 0.34 的量程上根本看不出来。
 */
import { el, setShown, setStyle } from './dom';
import type { GameStateManager } from '../game/state';

/** alpha 量化的档数。1/64 ≈ 0.0156，在 0..0.34 上看不出台阶。 */
const STEPS = 64;

export class MoodMask {
  readonly root: HTMLDivElement;
  private game: GameStateManager;
  private lastQ = -1;
  private lastAlpha = -1;

  constructor(parent: HTMLElement, game: GameStateManager) {
    this.game = game;
    this.root = el('div', 'g-mood');
    // 这一层既不接收指针也不进 Tab 序：它不是控件，是一层滤镜。
    // 写成 aria-hidden 是因为屏幕阅读器读它只会得到一个空的 div。
    this.root.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.root);
    this.apply(true);
  }

  /**
   * 每帧调。`alpha` 变了才写样式。
   * 注意这里读的是 `getMoodMaskAlpha()` 而不是 `mood`：那条换算
   * （心神 → 遮罩浓度）住在 state.ts 里，UI 只负责把它画出来。
   * 自己再换算一遍就是把那条换算抄成两份，改了一处忘了另一处，
   * 症状是"茶铺买了清心茶，雾没有散"。
   */
  update(_dt: number): void {
    this.apply(false);
  }

  private apply(force: boolean): void {
    const a = this.game.getMoodMaskAlpha();
    if (!force && Math.abs(a - this.lastAlpha) < 1 / (STEPS * 2)) return;
    this.lastAlpha = a;
    const q = Math.round(a * STEPS);
    if (!force && q === this.lastQ) return;
    this.lastQ = q;
    setShown(this.root, q > 0);
    setStyle(this.root, 'opacity', (q / STEPS).toFixed(4));
  }

  /** 读档 / 重开之后强制对齐一次。 */
  sync(): void {
    this.apply(true);
  }

  dispose(): void {
    this.root.remove();
  }
}
