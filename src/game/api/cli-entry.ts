/**
 * AI 接口的**打包入口**——只给 `tools/ai-play.mjs` 用。
 *
 * 为什么要有这个文件：`tools/*.mjs` 是纯 Node，而这一侧的实现是 TS。
 * `verify-all.mjs` 用的是「esbuild 打 `src/verify/entry.ts`」那一招，
 * 这里照抄同一套（three **不标 external**：它不走 WebGL，只用向量与 Object3D）。
 *
 * 它只**再导出**，`ai-play.mjs` 的每一行 import 都对着真正的模块，
 * 所以这个文件永远不会有自己的逻辑，也就不需要判据守着它。
 */
export { headlessSession, followRoad, type FollowReport } from './headless';
export { runScript } from './session';
export { AI_HELP } from './types';
