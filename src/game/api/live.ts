/**
 * AI 可游玩接口 —— **浏览器侧桥**（驱动正在跑的那一局）
 *
 * ## 动作怎么送进去：合成 KeyboardEvent，而不是另开一条平行输入
 *
 * 这个游戏有**七处**在监听键盘：`main.ts`（骑行与面板）、`dialogue.ts`、
 * `endCard.ts`、`postcardPanel.ts`、`minigameHost.ts`、`touchControls.ts`、
 * `hud.ts`。如果 AI 接口自己造一套"虚拟输入"，就必须把这七处逐个接一遍，
 * 而漏掉任何一处的症状都是**最难查的那一类**：
 * "对话能推进但小游戏里按键没反应"——看起来像小游戏坏了。
 *
 * 所以这里**只合成真的 `KeyboardEvent` 并派发到 `window`**：
 * 游戏自己那套监听原封不动地收到，走的是和人手键盘**完全同一条路**。
 * 代价是多一次事件派发（微秒级），换来的是"接口能做的事 = 键盘能做的事"，
 * **一件不多，一件不少**——这条等式比性能重要得多。
 *
 * ## 它刻意不做的事：不认识 `App`
 *
 * `main.ts` 那个类有近两千行，而 `World` 在无头环境里构造不出来
 * （这正是 `goPhase()` 只声明不拦截的原因）。所以这里只认一个
 * `LiveApiHost` 接口，由 `main.ts` 用一小段 getter 把它实现出来。
 * 好处是这个文件能在 Node 里被完整测一遍，而接线那一半由回归去钉。
 */

import { AiSession, type AiAdapter } from './session';
import {
  AI_HELP,
  keysOf,
  summarize,
  type AiAction,
  type AiEvent,
  type AiHeldAction,
  type AiObservation,
} from './types';
import type { Phase } from '../phase';

/**
 * 宿主要提供的东西。**刻意收得很窄**：
 * 一个观测的来源、一个动作的出口、两三个状态布尔。
 * 每多要一个字段，就多一处 `main.ts` 与本文件可能漂移的地方。
 */
export interface LiveApiHost {
  phase(): Phase;
  /** 叙事段落 / 打卡过场正占着屏幕。 */
  narrativeBusy(): boolean;
  dialogueOpen(): boolean;
  dialogueText(): string;
  minigameRunning(): boolean;
  /** 暂停 / 商店 / 明信片 / 结算 任一压着。 */
  panelOpen(): boolean;
  canCheckIn(): boolean;
  /** 观测里除 `tick` / `t` / `available` 之外的全部字段。 */
  observation(): Omit<AiObservation, 'available' | 'tick' | 't'>;
  /** 把一次按键送进游戏。实现方负责合成 `KeyboardEvent`。 */
  dispatchKey(code: string, down: boolean): void;
}

/** 装到 `window` 上的那个对象。名字带 `ai` 是为了和别的调试全局区分开。 */
export interface LiveApi {
  readonly version: string;
  observe(): AiObservation;
  act(action: AiAction, down: boolean): Promise<{ accepted: boolean; reason?: string }>;
  tap(action: AiAction): Promise<{ accepted: boolean; reason?: string }>;
  drain(): AiEvent[];
  frame(n?: number): Promise<void>;
  /** 按住 `seconds` 秒。`wait(2)` 比 `frame(120)` 读得懂。 */
  wait(seconds: number): Promise<void>;
  releaseAll(): AiAction[];
  /**
   * 本会话此刻按着的键。
   *
   * 它和 `releaseAll()` 是**同一份**记账（`AiSession` 内部那个 `held`），
   * 所以策略可以随时问"我是不是正卡着一个键"——
   * 而这件事以前只能靠人去翻游戏源码里的 `keys` 集合。
   */
  heldKeys(): AiHeldAction[];
  help(): string;
  summary(): string;
  /** 原始事件出口：不想用这层抽象的人可以直接收。 */
  on(type: 'event', fn: (e: AiEvent) => void): () => void;
}

/** 每 16.7ms 广播一次「有新事件了」，省得策略自己轮询。 */
const EVENT_TICK_MS = 120;

/**
 * 挂上桥。返回那个要装到 `window` 上的对象。
 *
 * `window.__gift188` 这个全局是**常驻**的，不藏在 URL 参数后面：
 * 藏起来等于要求每个来玩它的人先知道那个参数，
 * 而"AI 能不能玩这个游戏"这件事本身就该是一行代码就能试的。
 * 它不能做任何键盘做不到的事——每个动作都是一次真的按键派发。
 */
export function createLiveApi(host: LiveApiHost): LiveApi {
  let tick = 0;
  let t = 0;
  const listeners = new Set<(e: AiEvent) => void>();
  let drained: AiEvent[] = [];

  const adapter: AiAdapter = {
    send(action, down) {
      for (const code of keysOf(action)) host.dispatchKey(code, down);
    },
    snapshot() {
      return { tick, t, ...host.observation() };
    },
    drain() {
      return drained;
    },
    async frame() {
      await nextFrame();
      // 游戏时间跟着真实时钟走：这一侧是**真游戏**，不是定步长模拟。
      t += 1 / 60;
      tick++;
      drained = collectEvents();
      if (drained.length) for (const e of drained) for (const fn of listeners) fn(e);
    },
  };

  const session = new AiSession(adapter);

  /**
   * 事件从哪来：**对比前后两帧的观测**。
   *
   * 宿主没有事件总线（`GameStateManager` 的监听器是给 UI 用的，
   * 在 `checkIn()` 之类的地方触发，语义是"刷新界面"而不是"通报一件事"），
   * 而接一条新总线要动 `state.ts` 的每一个触发点——那是这次改动最不该碰的地方。
   * 所以这里用影子比对：只看玩家能看见的那些数，变了就发一条。
   * 它漏报内部事件，但**不会虚报**，而对 AI 来说"少一条"远好过"多一条假的"。
   */
  let shadow: Record<string, unknown> | null = null;
  function collectEvents(): AiEvent[] {
    const o = session.last();
    const now: Record<string, unknown> = {
      phase: o.phase,
      day: o.day,
      coins: o.coins,
      mood: o.mood,
      fragmentsGot: o.fragmentsGot,
      camera: o.camera,
      vehicle: o.vehicle,
      onRoad: o.onRoad,
      minigame: o.minigame,
      dialogueOpen: o.dialogueOpen,
    };
    const out: AiEvent[] = [];
    if (shadow) {
      for (const [k, v] of Object.entries(now)) {
        if (shadow[k] !== v) {
          const kind = k as AiEvent['kind'];
          out.push({ tick, t, kind, detail: v as string | number | boolean });
        }
      }
    }
    shadow = now;
    return out;
  }

  return {
    version: '1.0.0',
    observe: () => session.observe(),
    async act(action, down) {
      const r = await session.act(action as never, down);
      return { accepted: r.accepted, reason: r.reason };
    },
    async tap(action) {
      const r = await session.tap(action as never);
      return { accepted: r.accepted, reason: r.reason };
    },
    drain: () => {
      const out = drained;
      drained = [];
      return out;
    },
    frame: (n = 1) => session.frame(n),
    wait: (seconds) => session.wait(seconds),
    releaseAll: () => session.releaseAll(),
    heldKeys: () => session.heldKeys(),
    help: () => AI_HELP,
    summary: () => summarize(session.observe()),
    on(_type, fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** 等下一帧渲染。挂起而不是轮询，是因为这一侧要和屏幕上的画面同一拍。 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 1000 / 60);
  });
}

/** 事件广播的心跳。留成常量是为了让测试能引用同一个数字。 */
export const LIVE_EVENT_INTERVAL_MS = EVENT_TICK_MS;
