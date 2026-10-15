/**
 * AI 可游玩接口 —— **会话层**（编排，不含任何游戏知识）
 *
 * ## 它刻意不知道的事
 *
 * 这一层不知道按键怎么送达、也不知道观测从哪读：
 * 它只做三件事——记住"我现在按着哪些键"、保证"点一下"一定成对落下抬起、
 * 以及把适配器给的东西原样转出去。
 *
 * 这样做的收益是**它可以被无头地完整测一遍**：
 * 用一个假的适配器就能验证"松手会不会漏""连点会不会卡住"这类时序 bug，
 * 而这些恰恰是真实接口最容易写错、且最难靠肉眼看出来的部分。
 *
 * ## 一条硬规则：接口不许让 AI 把自己卡住
 *
 * `act('throttle', true)` 之后如果 AI 崩了、异常了、或者只是忘了，
 * 游戏里的 `keys` 集合会**永久留着这个键**——车会一直自己往前冲，
 * 而且没有任何界面能告诉人"有个键卡住了"。
 *
 * 所以这里做了三件事：
 * 1. 会话自己记一份 `held`，`releaseAll()` 一次全松；
 * 2. `tap()` 内部就是"按下 → 抬起"，不把中间态交给调用方；
 * 3. 任何动作在**不在 `available` 里**时默认拒绝并返回 `false`，
 *    而不是默默发出去——策略需要知道自己这一步被拒了。
 */

import {
  AI_HOLDABLE_ACTIONS,
  describeActions,
  type AiAction,
  type AiEvent,
  type AiHoldableAction,
  type AiObservation,
  type AiTapAction,
} from './types';

/** 适配器要提供的东西。`snapshot` 里**不含** `available`——那个由会话算。 */
export interface AiAdapter {
  /** 下发一次按键。`down=false` 是抬起。实现方负责翻译成 `KeyboardEvent.code`。 */
  send(action: AiAction, down: boolean): void;
  /** 读一帧原始观测。 */
  snapshot(): Omit<AiObservation, 'available'> & { narrativeBusy?: boolean };
  /** 取走"上次 drain 之后"发生的事件。实现方负责取走即清。 */
  drain(): AiEvent[];
  /** 推进一帧。live 里等一次 rAF，headless 里跑一次 fixedUpdate。 */
  frame(): void | Promise<void>;
}

export interface AiActionResult {
  accepted: boolean;
  /** 被拒时的原因。给策略看的，别只靠猜。 */
  reason?: string;
  /** 那一刻的观测快照——"我按了这个键"和"按完之后世界长什么样"必须能对上。 */
  observation: AiObservation;
}

export class AiSession {
  private readonly adapter: AiAdapter;
  /** 本会话按住的键。`observe()` 与 `releaseAll()` 都要用。 */
  private readonly held = new Set<AiAction>();
  private lastObservation: AiObservation | null = null;

  constructor(adapter: AiAdapter) {
    this.adapter = adapter;
  }

  // -------------------------------------------------------------- 读

  /** 读一帧观测。`available` 在这里算，所以永远是"此刻"有效的。 */
  observe(): AiObservation {
    const raw = this.adapter.snapshot();
    const available = describeActions({
      phase: raw.phase,
      canCheckIn: raw.canCheckIn,
      dialogueOpen: raw.dialogueOpen,
      minigame: raw.minigame,
      minigameId: raw.minigameId,
      panelOpen: raw.panelOpen,
      narrativeBusy: raw.narrativeBusy,
    });
    const obs: AiObservation = { ...raw, available };
    this.lastObservation = obs;
    return obs;
  }

  /** 上一次 `observe()` 的结果，没读过就现读一帧。 */
  last(): AiObservation {
    return this.lastObservation ?? this.observe();
  }

  /** 取走这段时间发生的一次性事件。**取走即清**，不会重复发给策略。 */
  drain(): AiEvent[] {
    return this.adapter.drain();
  }

  // -------------------------------------------------------------- 动

  /**
   * 按住或松开一个**可按住**的动作。
   *
   * 可按住的全集是 `AI_HOLDABLE_ACTIONS` —— 四个骑行键**加上确认键**。
   * 确认键为什么必须能按住，见 `types.ts` 里 `AiHoldableAction` 的注释：
   * 茶、描云、钓鱼三处只有"按住"这一种表达方式。
   *
   * 重复按同一个状态会被**吞掉**：游戏那边是 `Set.add/delete`，
   * 重复发不会出错，但会让适配器的调用计数虚高，
   * 而调用计数正是策略判断"我这一帧到底干了什么"的依据。
   */
  async act(action: AiAction, down: boolean): Promise<AiActionResult> {
    if (!(AI_HOLDABLE_ACTIONS as readonly AiAction[]).includes(action)) {
      return this.reject(`「${action}」不是可按住的动作`);
    }
    if (this.held.has(action) === down) {
      return { accepted: true, observation: this.last() };
    }
    const before = this.last().available;
    if (down && !before.includes(action)) {
      return this.reject(`此刻按「${action}」不会有反应（phase=${this.last().phase}）`);
    }
    this.held.add(action);
    this.adapter.send(action, down);
    return { accepted: true, observation: this.last() };
  }

  /**
   * 点一下。**按下和抬起一定成对**——中间那一帧留给适配器去派发，
   * 不管中间抛不抛异常，`finally` 都会把键松开。
   *
   * 这一点是接口能用性的关键：`tap` 漏掉抬起，症状是"车停不下来"，
   * 而这个症状在策略日志里长得像"AI 决策有问题"。
   */
  async tap(action: AiTapAction): Promise<AiActionResult> {
    const before = this.last().available;
    if (!before.includes(action)) {
      return this.reject(`此刻按「${action}」不会有反应（phase=${this.last().phase}）`);
    }
    try {
      this.adapter.send(action, true);
      await this.adapter.frame();
    } finally {
      this.adapter.send(action, false);
    }
    return { accepted: true, observation: this.last() };
  }

  /**
   * 一把松开本会话按住的全部键。
   *
   * `run()` 正常结束、抛异常、以及 CLI 的 `finally` 都会调它。
   * 它**不知道**有没有别人（人手键盘、触屏）在按着别的键，
   * 所以只清自己那份——这是保守的那一侧，而保守在这一层是对的。
   */
  releaseAll(): AiAction[] {
    const released = [...this.held];
    for (const a of released) {
      this.held.delete(a);
      this.adapter.send(a, false);
    }
    return released;
  }

  /** 本会话此刻按着的键。给策略日志用。 */
  heldKeys(): AiAction[] {
    return [...this.held];
  }

  // -------------------------------------------------------------- 走

  /** 推进一帧。live 里是真的等一帧渲染，headless 里是跑一次物理。 */
  async frame(n = 1): Promise<void> {
    for (let i = 0; i < n; i++) await this.adapter.frame();
  }

  /** 推进 `seconds` 秒。`headless` 那边一帧是定步长，所以这个换算是准的。 */
  async wait(seconds: number): Promise<void> {
    await this.frame(Math.max(1, Math.round(seconds * 60)));
  }

  /**
   * 推进一步并返回新观测——策略循环里最常用的一行。
   */
  async step(): Promise<AiObservation> {
    await this.adapter.frame();
    return this.observe();
  }

  // ---- 同步那一半 ----------------------------------------------------
  //
  // `act` / `tap` / `frame` 都是 `async`，而 **`await` 即使对一个非 Promise
  // 也会挂起当前函数**——于是同步地连着调它们，只有第一次真的执行了。
  //
  // 这个坑很安静：无头会话里的 `adapter.frame()` 是同步的，
  // 于是「按住油门跑 60 帧」在判据里只跑了 **1 帧**，
  // 断言报出来的是「车没动」，而修法看起来像是物理坏了。
  // 真正的错是**调用方以为自己在跑一个循环**。
  //
  // 所以下面这一组是**给适配器本身同步的场合**用的：
  // 无头批量、回归、以及任何不想在循环里 await 的人。
  // 浏览器那一侧**必须**用 async 版本——它要真的等下一次渲染。

  /** 同步按住/松开。和 `act()` 同一份判断，只是不等任何东西。 */
  actSync(action: AiAction, down: boolean): AiActionResult {
    if (!(AI_HOLDABLE_ACTIONS as readonly AiAction[]).includes(action)) {
      return this.reject(`「${action}」不是可按住的动作`);
    }
    if (this.held.has(action) === down) {
      return { accepted: true, observation: this.last() };
    }
    if (down && !this.last().available.includes(action)) {
      return this.reject(`此刻按「${action}」不会有反应（phase=${this.last().phase}）`);
    }
    this.held.add(action);
    this.adapter.send(action, down);
    return { accepted: true, observation: this.last() };
  }

  /** 同步点一下。抬起走 `finally`，漏不掉。 */
  tapSync(action: AiTapAction): AiActionResult {
    if (!this.last().available.includes(action)) {
      return this.reject(`此刻按「${action}」不会有反应（phase=${this.last().phase}）`);
    }
    try {
      this.adapter.send(action, true);
      this.adapter.frame();
    } finally {
      this.adapter.send(action, false);
    }
    return { accepted: true, observation: this.last() };
  }

  /**
   * 同步推进 n 帧，**并把最后一帧的观测刷新进 `lastObservation`**。
   * **适配器必须是真的同步的**（无头侧就是），浏览器侧请用 `frame()`。
   *
   * 为什么顺带刷新：推进了世界却不更新快照，`last()` 就会返回
   * **上一帧**的观测——于是「按住油门跑 60 帧之后车有多少速」读出来是 0，
   * 而报错看着像物理坏了。调用方几乎总是在步进之后读一次，
   * 所以把刷新藏在这里比在每个调用点提醒要可靠得多。
   */
  frameSync(n = 1): void {
    for (let i = 0; i < n; i++) this.adapter.frame();
    this.observe();
  }

  /** 同步推进一步并返回新观测。 */
  stepSync(): AiObservation {
    this.adapter.frame();
    return this.observe();
  }

  private reject(reason: string): AiActionResult {
    return { accepted: false, reason, observation: this.last() };
  }
}

// ---------------------------------------------------------------- 脚本

/** `tools/ai-play.mjs` 和 `verify` 共用的一步。 */
export type AiStep =
  | { hold: AiHoldableAction; seconds?: number }
  | { tap: AiTapAction }
  | { wait: number }
  | { observe: true };

/**
 * 跑一小段脚本。**返回沿途的每一帧观测**——
 * 「跑完看一眼结果」和「看着它一步步走过去」能查出的问题完全不同，
 * 而后者才是玩这个游戏时真正会遇到的问题。
 */
export async function runScript(
  s: AiSession,
  steps: readonly AiStep[],
): Promise<{ observations: AiObservation[]; events: AiEvent[] }> {
  const observations: AiObservation[] = [s.observe()];
  const events: AiEvent[] = [];
  try {
    for (const step of steps) {
      if ('wait' in step) {
        await s.wait(step.wait);
        observations.push(s.observe());
      } else if ('observe' in step) {
        observations.push(s.observe());
      } else if ('tap' in step) {
        await s.tap(step.tap);
        observations.push(s.observe());
      } else {
        await s.act(step.hold, true);
        await s.wait(step.seconds ?? 1);
        await s.act(step.hold, false);
        observations.push(s.observe());
      }
      events.push(...s.drain());
    }
  } finally {
    // 脚本写错不该把车留在"全速冲刺"的状态上留给下一个使用者。
    s.releaseAll();
  }
  return { observations, events };
}

/**
 * `runScript()` 的同步版本，脚本形状完全一样。
 *
 * **为什么要两个**：判据是同步的（`check(name, () => CheckResult)`），
 * 而 `runScript()` 是 `async` 的——在同步判据里调它会拿到一个 Promise，
 * 于是 `r.observations.length` 读的是 `undefined`。
 * 上一次就踩过：判据安静地打成 `NO-ASSERT`，而 `verify-all.mjs`
 * 有意不信退出码，所以"一条断言都没打"在汇总里被算成**没跑成**而不是失败。
 *
 * 浏览器那一侧仍然用 async 版本（它要等下一次渲染）。
 */
export function runScriptSync(
  s: AiSession,
  steps: readonly AiStep[],
): { observations: AiObservation[]; events: AiEvent[] } {
  const observations: AiObservation[] = [s.observe()];
  const events: AiEvent[] = [];
  try {
    for (const step of steps) {
      if ('wait' in step) {
        s.frameSync(Math.max(1, Math.round(step.wait * 60)));
        observations.push(s.observe());
      } else if ('observe' in step) {
        observations.push(s.observe());
      } else if ('tap' in step) {
        s.tapSync(step.tap);
        observations.push(s.observe());
      } else {
        s.actSync(step.hold, true);
        s.frameSync(Math.max(1, Math.round((step.seconds ?? 1) * 60)));
        s.actSync(step.hold, false);
        observations.push(s.observe());
      }
      events.push(...s.drain());
    }
  } finally {
    s.releaseAll();
  }
  return { observations, events };
}
