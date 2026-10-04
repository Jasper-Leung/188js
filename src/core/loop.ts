/**
 * 主循环 —— 定步长物理 + 可变步长渲染 + 自适应分辨率。
 *
 * 三件事，每件都是低配机器上的生死线：
 *
 * 1. **定步长物理**。Godot 的 `_physics_process` 本身就是定步长的，移植过来
 *    保留。理由不是"手感"，是**可复现**：低配机器 25 帧、30 帧的间隔下，
 *    变步长积分会让自行车在同一个弯里走出不同的轨迹，而没有任何异常。
 *    掉帧时车会"滑"而不是"跳"，看起来仍然是对的。
 *
 * 2. **切到后台就停**。`visibilitychange` 时停掉整个 rAF。
 *    笔记本合盖、切标签页都会走这条路；不处理的话回来时 dt 可能是几秒，
 *    而 dt 稍一不钳制就会把车瞬移过整张地图。这一条同时省电。
 *
 * 3. **自适应分辨率**（默认关）。只动内部渲染分辨率，不动任何画面元素——
 *    没有 LOD 跳变、没有特效消失、文字不会变形。这是唯一一种"降下去
 *    玩家几乎察觉不到、但帧率立刻回来"的手段。
 *    为什么不默认开：Godot 版明确把"自动降档"列为故意不做，理由是
 *    玩家没改任何设置却看到画面在脚下变了。这里把它限制成
 *    **可开关 + 有滞回 + 面板上标着**，并且**只降不升**到超过玩家设的上限。
 */
import { clamp } from './math';

export interface LoopCallbacks {
  /** 定步长逻辑。dt 恒定。 */
  fixed: (dt: number) => void;
  /** 每帧渲染。dt 是真实经过时间。 */
  render: (dt: number, alpha: number) => void;
  /** 改变内部渲染分辨率。scale ∈ (0,1] */
  onScaleChange?: (scale: number) => void;
  /** 帧率统计更新（每 0.5s 一次，给 FPS 面板用） */
  onStats?: (fps: number, frameMs: number) => void;
}

export interface LoopOptions {
  /** 固定步长（秒）。1/60。 */
  fixedDt?: number;
  /** 单帧最多追几步。追太多会在长卡顿后疯狂补帧，反而更卡 */
  maxSubSteps?: number;
  /** 单帧 dt 上限（秒）。超过就当 0.1s，丢掉多出来的。 */
  maxFrameDt?: number;
  /** 自适应目标帧率，0 = 关 */
  adaptiveTargetFps?: number;
  /** 自适应下限倍率 */
  adaptiveMinScale?: number;
  /** 基础倍率（画质档给的） */
  baseScale?: number;
}

export class GameLoop {
  private readonly cb: LoopCallbacks;
  private readonly fixedDt: number;
  private readonly maxSubSteps: number;
  private readonly maxFrameDt: number;

  private rafId = 0;
  private lastTime = 0;
  private accumulator = 0;
  private running = false;

  // 自适应状态
  private targetFps: number;
  private minScale: number;
  private baseScale: number;
  private curScale: number;
  /** 滞回：连续多少个采样窗口超/低于阈值才动。防止在阈值附近来回抖 */
  private overBudgetWindows = 0;
  private underBudgetWindows = 0;
  private windowMs = 0;
  private windowFrames = 0;
  /** 上一次改 scale 是多久之前。改完给一段冷却 */
  private lastScaleChange = -9999;

  /** 慢动作（打卡过场用）。0 = 暂停 */
  timeScale = 1;
  /** 统计 */
  fps = 60;
  frameMs = 16.7;
  private elapsed = 0;

  constructor(cb: LoopCallbacks, opts: LoopOptions = {}) {
    this.cb = cb;
    this.fixedDt = opts.fixedDt ?? 1 / 60;
    this.maxSubSteps = opts.maxSubSteps ?? 5;
    this.maxFrameDt = opts.maxFrameDt ?? 0.1;
    this.targetFps = opts.adaptiveTargetFps ?? 0;
    this.minScale = opts.adaptiveMinScale ?? 0.5;
    this.baseScale = opts.baseScale ?? 1;
    this.curScale = this.baseScale;

    // 切后台：停掉 rAF。这不只是省电——合盖再打开时 dt 可能是十几秒，
    // 而 dt 稍不钳制，车会一帧之内瞬移过整张地图，然后卡在路外面。
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stop();
      else this.start();
    });
    // 有些机器上页面卸载前也不给 hidden 事件，补一道
    window.addEventListener('blur', () => this.suspend());
    window.addEventListener('focus', () => this.resume());
  }

  /** 临时停摆（打开暂停面板时用；不重置时间基准） */
  suspend() {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  resume() {
    if (this.running) return;
    this.start();
  }

  start() {
    if (this.running || document.hidden) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  setAdaptive(targetFps: number, minScale: number) {
    this.targetFps = targetFps;
    this.minScale = clamp(minScale, 0.3, 1);
  }

  setBaseScale(scale: number) {
    this.baseScale = clamp(scale, 0.25, 1);
    this.curScale = this.baseScale;
    this.cb.onScaleChange?.(this.curScale);
  }

  get scale() {
    return this.curScale;
  }

  private tick = (now: number) => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    let frameDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    // 钳制：长卡顿（切窗、GC、断点）之后 dt 可能是几秒，
    // 不钳制的话 fixed 循环会追 maxSubSteps 步然后车瞬移。
    if (!(frameDt > 0)) frameDt = 0;
    if (frameDt > this.maxFrameDt) frameDt = this.maxFrameDt;

    this.elapsed += frameDt;

    // ---- 统计窗口 ----
    this.windowMs += frameDt * 1000;
    this.windowFrames++;
    if (this.windowMs >= 500) {
      this.fps = (this.windowFrames * 1000) / this.windowMs;
      this.frameMs = this.windowMs / this.windowFrames;
      this.cb.onStats?.(this.fps, this.frameMs);
      this.adapt();
      this.windowMs = 0;
      this.windowFrames = 0;
    }

    // ---- 定步长 ----
    this.accumulator += frameDt * this.timeScale;
    const step = this.fixedDt;
    let steps = 0;
    while (this.accumulator >= step && steps < this.maxSubSteps) {
      this.cb.fixed(step);
      this.accumulator -= step;
      steps++;
    }
    // 追不上就丢掉：宁可让游戏慢放，也不让车瞬移
    if (this.accumulator > step * this.maxSubSteps) this.accumulator = 0;

    this.cb.render(frameDt, this.accumulator / step);
  };

  /**
   * 自适应分辨率。只在**超标**时降，且有滞回与冷却。
   *
   * 只降不升是刻意的：升上去之后如果又立刻降下来，画面会"呼吸"，
   * 那种抖动比一直低一档难受得多。玩家想要更高，自己去面板里调。
   */
  private adapt() {
    if (this.targetFps <= 0) return;
    const budget = 1000 / this.targetFps;
    const cooldown = this.elapsed - this.lastScaleChange;
    if (cooldown < 1.5) {
      this.overBudgetWindows = 0;
      this.underBudgetWindows = 0;
      return;
    }

    if (this.frameMs > budget * 1.12) {
      this.overBudgetWindows++;
      this.underBudgetWindows = 0;
    } else if (this.frameMs < budget * 0.72) {
      this.underBudgetWindows++;
      this.overBudgetWindows = 0;
    } else {
      // 在带子里：什么都不做，也不要重置计数（免得在边界反复累计）
      return;
    }

    // 连续 3 个窗口（约 1.5s）超预算才动
    if (this.overBudgetWindows >= 3) {
      const next = clamp(this.curScale * 0.85, this.minScale, this.baseScale);
      if (next < this.curScale - 0.01) {
        this.curScale = next;
        this.lastScaleChange = this.elapsed;
        this.cb.onScaleChange?.(this.curScale);
      }
      this.overBudgetWindows = 0;
    }
  }
}
