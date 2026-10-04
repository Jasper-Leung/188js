/**
 * 调试面板 —— 把探针的纯文本放上屏，并能一键复制。
 *
 * ## 为什么要「复制」这个按钮
 *
 * 这个面板的真正用途是**把现场交给别人**：贴进对话、贴进 issue、贴给 AI 助手。
 * 截图能表达"看起来不对"，但表达不了"离中心线 3.2m、底离地 +1.4m、
 * 视场横 93.8°"——而后者才是能定位的。
 *
 * 所以按钮不是装饰：**它把一份可核对的数字拷进剪贴板**，
 * 而这份数字在 `src/verify/` 里跑的是**同一套判据**
 * （见 `verify_buildings`），所以面板显示的"正常/不正常"和回归的结果永远一致。
 *
 * 面板默认不挂：它只在 `?debug` 存在时创建，正式发行路径上不存在这个节点。
 */
import { el } from '../ui/dom';
import { probeAt, buildingTable } from './probe';
import type { World } from '../world/world';

/** 刷新间隔。与 `sceneDump` 同一个 0.5s——两者的数据来源相同，一起刷新才对得上 */
const REFRESH_MS = 500;

export class DebugPanel {
  readonly root: HTMLDivElement;
  private world: World;
  private text: HTMLPreElement;
  private timer = 0;
  private shown = false;
  private mode: 'probe' | 'buildings' = 'probe';
  private pinned = false;

  constructor(parent: HTMLElement, world: World) {
    this.world = world;
    this.root = el('div', 'g-debug g-hidden');

    const bar = el('div', 'g-debug-bar');
    const mk = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.className = 'g-debug-btn';
      b.textContent = label;
      b.addEventListener('click', fn);
      bar.appendChild(b);
      return b;
    };
    mk('探针 P', () => this.setMode('probe'));
    mk('驿站表 B', () => this.setMode('buildings'));
    mk('复制', () => void this.copy());
    mk('钉住', () => {
      this.pinned = !this.pinned;
      this.root.classList.toggle('is-pinned', this.pinned);
    });
    mk('关 Esc', () => this.setShown(false));
    this.root.appendChild(bar);

    this.text = document.createElement('pre');
    this.text.className = 'g-debug-text';
    this.root.appendChild(this.text);

    parent.appendChild(this.root);
    this.paint();
  }

  /** 探针默认跟着玩家跑；钉住之后停在当前坐标，方便对着看 */
  setPinned(v: boolean): void {
    this.pinned = v;
    this.root.classList.toggle('is-pinned', v);
  }

  setMode(m: 'probe' | 'buildings'): void {
    this.mode = m;
    this.paint();
  }

  setShown(v: boolean): void {
    this.shown = v;
    this.root.classList.toggle('g-hidden', !v);
    if (v) this.paint();
  }

  toggle(): void {
    this.setShown(!this.shown);
  }

  get isShown(): boolean {
    return this.shown;
  }

  get currentText(): string {
    return this.text.textContent ?? '';
  }

  /**
   * 每帧调，内部按 0.5s 节流。
   *
   * **钉住时不算。** 探针默认输出会跟着车跑，钉住是为了"停在某一点上
   * 边看边调"，而刷新的正是它要停住的那个数。
   */
  update(dt: number): void {
    if (!this.shown) return;
    if (this.pinned && this.mode === 'probe') return;
    this.timer += dt * 1000;
    if (this.timer < REFRESH_MS) return;
    this.timer = 0;
    this.paint();
  }

  private paint(): void {
    // 带上玩家位置，于是"在加载半径内却仍未加载"会被报出来，
    // 而离得远的那些（还没进半径，本来就该没加载）不报。
    // 不带的话这一列在浏览器里也会全是"否"，等于没有这一列。
    const ctx = { stations: this.world.stations, terrain: this.world.terrain, road: this.world.road, playerX: this.world.ride.pos.x, playerZ: this.world.ride.pos.z };
    this.text.textContent = this.mode === 'buildings' ? buildingTable(ctx) : probeAt(this.world, undefined, undefined, { radius: 40 });
  }

  /**
   * 复制。`navigator.clipboard` 需要安全上下文与用户手势——
   * 按钮点击正好满足后者；不满足时退回 `execCommand`，
   * 两条路都没有就选中文本让用户自己 Ctrl+C。
   */
  private async copy(): Promise<void> {
    const value = this.currentText;
    const hint = this.root.querySelector('.g-debug-hint');
    const say = (s: string) => {
      if (hint) hint.textContent = s;
    };
    try {
      await navigator.clipboard.writeText(value);
      say('已复制');
      return;
    } catch {
      /* 落到下面的兜底 */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      say(ok ? '已复制' : '复制失败，请手动选中');
    } catch {
      say('复制失败，请手动选中');
    }
    setTimeout(() => say(''), 2200);
  }
}
