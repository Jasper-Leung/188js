/**
 * 小游戏宿主 —— 画布、DPR、输入路由、超时兜底、结算面板。
 *
 * ## 超时是宿主补的，不是小游戏自己判的
 *
 * 云与茶没有内建超时（原作也没有，它们靠 World3D 的 30 秒兜底）。
 * 少了这道兜底，玩家的车就永远锁在打卡过场里——而这个游戏**没有死亡画面**，
 * 于是就成了一个死局。这里补上 30 秒，到点按"没完成"结算，和原作一致。
 *
 * ## 输入路由
 *
 * 浏览器没有 Godot 那种"按键已被处理"的传播机制，所以这里显式问小游戏：
 * `onKeyDown` 返回 true 表示它吃掉了这次按键，宿主就不让它再冒到
 * 「打卡」上。反过来宿主**不能**过滤 `event.repeat`——
 * 云和茶是按住生效的，滤掉 repeat 它们就永远按不满。
 * 需要"只认新的一下"的地方（竹）由小游戏自己记按着状态。
 *
 * ## DPR 与低配
 *
 * 画布按 CSS 像素 × `min(devicePixelRatio, 2)` 出图。2 是上限：
 * 小游戏是 2D 的，在一块 4K 屏上按 3 倍出图只是白烧填充率，
 * 而这些画面全是色块与线，2 倍已经完全够看。
 * 高配之外还额外受画面的**总像素**限制，见 `pickDpr`。
 */
import { createMiniGame, gameFor, type MiniGame, type MiniGameContext, type MiniGameId, type MiniGameResult } from './minigames';
import { t, getLang } from '../i18n';
import { audio } from '../core/audio';

const TIMEOUT_SEC = 30;
const RESULT_HOLD_SEC = 1.6;

export interface MiniGameHandle {
  /** 结算面板的文案，宿主拿去显示 */
  result: MiniGameResult;
  /** 这一件乐事的 id */
  id: MiniGameId;
  /**
   * 这一局是不是**宿主 30 秒兜底**收的，而不是玩法自己判负。
   *
   * 为什么要单独记一个布尔而不是给 `MiniGameResult` 加第四个值：
   * 结算三态（成了 / 没完成 / 先放一放）是 `verify_settle` 钉死的语义，
   * 加第四个值会让那一整套判据与 `settleTextKey` 一起重写。
   * 而"超时"和"玩砸了"本来就**不该换大字**——玩家看到的大字仍然是
   * 「这次没有完成」，区别只在小字：一个是「不要紧，骑一会儿再来」，
   * 一个是「这一件超时了」。所以它是一个**修饰**，不是一个状态。
   */
  timedOut: boolean;
}

export class MiniGameHost {
  readonly root: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private game: MiniGame | null = null;
  private running = false;
  private elapsed = 0;
  private resultT = -1;
  private currentResult: MiniGameResult = 'cancel';
  /** 本局是不是被 30 秒兜底收的。`settle()` 读完就清，所以不会串到下一局 */
  private timedOut = false;
  private resolveFn: ((h: MiniGameHandle) => void) | null = null;
  private dpr = 1;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'minigame-layer';
    this.root.hidden = true;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'minigame-canvas';
    const c = this.canvas.getContext('2d', { alpha: false });
    if (!c) throw new Error('拿不到 2D context');
    this.ctx = c;
    this.root.appendChild(this.canvas);
    parent.appendChild(this.root);
    this.bindInput();
  }

  /** 第 `visit` 次到访（0 起）、碎片槽位 `slot` 对应的那件乐事 */
  static idFor(slot: number, visit: number): MiniGameId {
    const idx = gameFor(slot, visit);
    return (['cloud', 'tea', 'zither', 'bamboo', 'bird'] as const)[idx];
  }

  /**
   * 跑一件乐事。返回一个 Promise，结算后 resolve。
   * 种子由 (驿站, 第几次到访) 决定，所以同一趟重玩是同一局——
   * 这对"再访"很重要：它必须是可练习的，而不是随机的。
   */
  run(id: MiniGameId, seed: number): Promise<MiniGameHandle> {
    this.dispose(true);
    this.root.hidden = false;
    this.elapsed = 0;
    this.resultT = -1;
    this.running = true;
    this.resize();

    const ctxObj: MiniGameContext = {
      ctx: this.ctx,
      width: this.cssW,
      height: this.cssH,
      lang: getLang(),
      palette: {
        ink: '#2a2622',
        paper: '#e8e0cd',
        accent: '#b4552f',
        dim: '#7a6f5e',
        ok: '#4a7a44',
        bad: '#a8442f',
      },
      audio: {
        sfx: (n) => audio.sfx(n),
        note: (i) => audio.note(i),
        duckAmbient: (on) => audio.duckAmbient(on),
      },
      t,
      seed,
      onDone: (r) => this.finish(r),
    };

    this.game = createMiniGame(id, ctxObj);
    // 尺寸给真值：小游戏在构造里可能就要布局
    (this.game as MiniGame).resize(this.cssW, this.cssH);
    this.dpr = pickDpr(this.cssW, this.cssH);
    this.applyCanvasSize();

    return new Promise<MiniGameHandle>((resolve) => {
      this.resolveFn = resolve;
    });
  }

  /** 定步长。宿主在暂停时不要调。 */
  fixedUpdate(dt: number) {
    if (!this.running || !this.game) return;
    // 游戏自己的状态机在这里往前走。`step()` 没有第二个调用方——
    // 漏掉这一句，茶的注水不走、竹的引子不放、琴的示范不响、禽的倒计时不动，
    // 五件乐事全停在开场那一帧。
    this.game.step(dt);
    this.elapsed += dt;
    // 超时兜底：云与茶没有内建计时，靠这道
    if (this.resultT < 0 && this.elapsed > TIMEOUT_SEC) {
      this.timedOut = true;
      this.finish('lose');
    }
    if (this.resultT >= 0) {
      this.resultT += dt;
      if (this.resultT > RESULT_HOLD_SEC) this.settle();
    }
  }

  render() {
    if (!this.game || this.root.hidden) return;
    this.ctx.save();
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.game.draw();
    this.ctx.restore();
  }

  private cssW = 800;
  private cssH = 600;

  private resize() {
    const r = this.root.getBoundingClientRect();
    this.cssW = Math.max(320, Math.floor(r.width || window.innerWidth));
    this.cssH = Math.max(240, Math.floor(r.height || window.innerHeight));
    this.dpr = pickDpr(this.cssW, this.cssH);
    this.applyCanvasSize();
    this.game?.resize(this.cssW, this.cssH);
  }

  private applyCanvasSize() {
    this.canvas.width = Math.floor(this.cssW * this.dpr);
    this.canvas.height = Math.floor(this.cssH * this.dpr);
    this.canvas.style.width = this.cssW + 'px';
    this.canvas.style.height = this.cssH + 'px';
  }

  onResize = () => this.resize();

  // ---------------------------------------------------------------- 输入
  private bindInput() {
    window.addEventListener('resize', this.onResize);

    window.addEventListener('keydown', (e) => {
      if (!this.running || !this.game) return;
      if (e.code === 'Escape') {
        // Esc 永远能退出。这一条是硬要求：原作的取消按钮是 _draw() 画出来的
        // 假按钮，键盘点不到，少了这道口子键盘玩家会被困在那一屏。
        e.preventDefault();
        this.finish('cancel');
        return;
      }
      if (e.code === 'F5' || e.code === 'F12') return;
      if (this.game.onKeyDown(e.code, e.shiftKey)) e.preventDefault();
    });

    window.addEventListener('keyup', (e) => {
      if (!this.running || !this.game) return;
      if (this.game.onKeyUp(e.code)) e.preventDefault();
    });

    const toLocal = (e: PointerEvent) => {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.running || !this.game) return;
      this.canvas.setPointerCapture(e.pointerId);
      const p = toLocal(e);
      this.game.onPointerDown(p.x, p.y);
      e.preventDefault();
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.running || !this.game) return;
      const p = toLocal(e);
      this.game.onPointerMove(p.x, p.y);
    });
    const up = (e: PointerEvent) => {
      if (!this.running || !this.game) return;
      const p = toLocal(e);
      this.game.onPointerUp(p.x, p.y);
    };
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
  }

  get isRunning() {
    return this.running;
  }

  // ---------------------------------------------------------------- 结算
  private finish(result: MiniGameResult) {
    if (!this.running || this.resultT >= 0) return;
    this.currentResult = result;
    this.resultT = 0;
    if (result === 'win') audio.sfx('collect');
    else if (result === 'lose') audio.sfx('open', 0.5);
  }

  private settle() {
    const id = this.game?.id ?? 'cloud';
    const h: MiniGameHandle = { result: this.currentResult, id, timedOut: this.timedOut };
    this.running = false;
    this.timedOut = false;
    this.root.hidden = true;
    this.game?.dispose();
    this.game = null;
    const cb = this.resolveFn;
    this.resolveFn = null;
    cb?.(h);
  }

  /**
   * 强制退出（宿主决定这一趟结束了，而某一局还开着）。
   *
   * 原来这里是 `this.finish('cancel')`——**绕过游戏自己的 `cancel()`**。
   * 五个游戏都实现了 `cancel()`（各自的注释写着"玩家按 Esc"），而它们是
   * 通往同一个 `finish('cancel')` 的**第二扇门**，从来没有被推开过。
   * 现在这里走 `game.cancel()`，那五个实现才真的接上了：
   * 玩家按 Esc 走游戏自己的 `onKeyDown`，宿主强制收尾走这里，两条路
   * 进的是同一段逻辑，而不是两条各自维护的平行实现。
   *
   * 调用方是 `main.finishRun()`（暂停面板的「结束这一趟」）。
   * 今天这条路径在小游戏期间**按不到**——小游戏期间 Esc 被游戏吃掉，
   * 暂停面板开不出来——所以它是一道按不到的保险。
   * 留着并接上，而不是删掉：这一趟结束与某一局还开着同时发生，
   * 是那种"改一次相位机就会撞上"的组合，而它的正确处置只有一行。
   */
  abort() {
    if (!this.running) return;
    const g = this.game;
    if (g && g.cancel()) return;
    this.finish('cancel');
  }

  dispose(force = false) {
    if (force) {
      this.running = false;
      this.timedOut = false;
      this.root.hidden = true;
      // ⚠️ 原来这里 resolve 的是 `{ result: 'cancel', id: 'cloud' }`——
      // **id 写死成云**。被强制收掉的是琴，句柄却说这是云，
      // 而 `main.runMiniGame` 后面拿 `handle.id` 做过判断。
      // 现在读真实的 id。
      const id = this.game?.id ?? 'cloud';
      this.game?.dispose();
      this.game = null;
      this.resolveFn?.({ result: 'cancel', id, timedOut: false });
      this.resolveFn = null;
    }
  }
}

/**
 * 小游戏画布的 DPR。
 *
 * 除了常规的 `min(devicePixelRatio, 2)`，还加一道**总像素**上限：
 * 一块 4K 屏上 2 倍 DPR 意味着每帧要填 3300 万像素，而这五个小游戏
 * 全是色块与线——多出来的分辨率一像素都看不出来，却实实在在地吃掉
 * 一块 4K 屏的填充率。超过 260 万像素就往下压。
 */
function pickDpr(w: number, h: number): number {
  const cap = Math.min(window.devicePixelRatio || 1, 2);
  const MAX_PIXELS = 2_600_000;
  const area = w * h;
  if (area * cap * cap <= MAX_PIXELS) return cap;
  return Math.max(1, Math.sqrt(MAX_PIXELS / area));
}

export { gameFor };
export type { MiniGameId, MiniGameResult };
