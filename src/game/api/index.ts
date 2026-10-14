/**
 * AI 可游玩接口 —— 对外入口。
 *
 * 三条路，一份契约：
 * · `live.ts`     浏览器里驱动**正在跑的那一局**（`window.__gift188`）
 * · `headless.ts` Node 里那辆不碰 WebGL 的车（策略、批量搜索、回归）
 * · `types.ts`    动作集 / 观测快照 / 事件流 / "此刻能按什么"
 *
 * 只想引契约（写策略的人）：`import { AI_KEYS, describeActions } from './game/api'`
 * 想真的玩（接宿主的人）：`import { createLiveApi } from './game/api'`
 */

export * from './types';
export {
  AiSession,
  runScript,
  runScriptSync,
  type AiAdapter,
  type AiActionResult,
  type AiStep,
} from './session';
export { createLiveApi, type LiveApi, type LiveApiHost } from './live';
export { HeadlessAdapter, headlessSession, HEADLESS_DT } from './headless';
