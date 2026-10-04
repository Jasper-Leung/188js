/**
 * 小游戏工厂 + ID 顺序表。
 *
 * 五件乐事怎么轮着上（对应 Godot 的 MiniGamePicker.gd）：
 *
 *   原来 `_run_mini_game()` 里是一张「驿站 → 固定小游戏」的表，而且只在
 *   **首次到访**时才进它。于是完满评级要求的三次到访里，后两次**一件乐事都没有**：
 *   玩家第三次骑到云影台，脚下的圈写着「再访 · 还差 1 次」，走进去只有一句
 *   「这件已经收过了」。全游戏最强的重玩钩子，十次到访里十次是空的。
 *
 *   现在每一趟打卡都有一件乐事，按 `(碎片槽位 + 第几次到访) % 5` 轮换：
 *     · 第一次到访拿到的**还是**这座驿站自己的那件（云影台仍是描云），
 *       所以第一趟的手感和配对关系一个字没变；
 *     · 之后两趟依次往后挪，五座驿站串起来正好把五件乐事走一遍；
 *     · 5 站 × 3 次 = 15 局，每件乐事正好各出现 3 次，不多不少。
 *
 *   ```
 *           第1次 第2次 第3次
 *   云影台(0):  0    1    2
 *   茶烟小筑(1): 1    2    3
 *   琴音林(2):   2    3    4
 *   竹雨庭(3):   3    4    0
 *   花房(4):     4    0    1
 *   ```
 *
 * `visit` 从 0 起算而不是 1，是为了让「第一次到访 = 自己那件」这件事在公式里
 * 看得见——`slot + 0` 就是 slot，不用在调用处再补一次特判。
 * 宿主自己算好 id 传进来，这里的 `gameFor` 只是把同一张表原样搬过来备查。
 */
import { createBambooGame } from './bamboo';
import { createBirdGame } from './bird';
import { createCloudGame } from './cloud';
import { createTeaGame } from './tea';
import { createZitherGame } from './zither';
import type { MiniGame, MiniGameContext, MiniGameId } from './types';

/** 顺序与碎片槽位 0..4 一致：云 / 茶 / 琴 / 竹 / 禽。
 *  这是一条**独立副本**，和 `RoadData.FRAGMENT_SLOT_STATION_IDX` 的顺序必须对得上
 *  ——它决定"第一趟拿到的还是自己那件"。 */
export const MINI_GAME_IDS: readonly MiniGameId[] = ['cloud', 'tea', 'zither', 'bamboo', 'bird'];

/** 第 `visit` 次到访（**从 0 起**）`slot` 号碎片驿站，该玩第几件。纯函数。 */
export function gameFor(slot: number, visit: number): number {
  return (slot + Math.max(visit, 0)) % MINI_GAME_IDS.length;
}

/** 15 局的完整排布：一行一个 slot，三次到访从左到右。 */
export function schedule(): number[][] {
  return MINI_GAME_IDS.map((_, slot) => [0, 1, 2].map((visit) => gameFor(slot, visit)));
}

/**
 * 造一个**未启动**的实例。
 *
 * 宿主会先 `draw()` 若干帧做入场动画，所以任何一个构造路径都**不许**立刻
 * `onDone()`：五个游戏里只有竹和琴有"开场自己会往下走"的计时器，而它们的
 * 第一拍分别是 0.8s 引导期和 0.5s 首次显示延迟，构造完当帧不会结算；
 * 云/茶/禽更是要玩家先有输入才可能走到结算分支。
 *
 * 唯一在构造里就发生的事是 `audio.duckAmbient(true)`（压低环境音）——那不是结算，
 * `dispose()` / 结算时都会翻回去。
 *
 * **按键重复**：浏览器的长按会连着发 `keydown`（`event.repeat === true`），而
 * `onKeyDown(key, shift)` 的签名里没有 repeat 位。宿主**不要**自己过滤 repeat，
 * 也不要自己合成 —— 需要"只认新的一下"的地方（竹）自己在模块里记了按着状态。
 * 反过来，宿主也不该把 `keydown` 合并成"只按一次"：云和茶是**按住**生效的。
 */
export function createMiniGame(id: MiniGameId, ctx: MiniGameContext): MiniGame {
  switch (id) {
    case 'cloud': return createCloudGame(ctx);
    case 'tea': return createTeaGame(ctx);
    case 'zither': return createZitherGame(ctx);
    case 'bamboo': return createBambooGame(ctx);
    case 'bird': return createBirdGame(ctx);
  }
}

export { MISSING_KEYS } from './chrome';
export type { MiniGame, MiniGameContext, MiniGameId, MiniGameResult } from './types';
