/**
 * 键位重映射。
 *
 * ## 为什么它必须是一张"动作 → 物理键"的表，而不是全局替换字符串
 *
 * 硬编码的 `KeyboardEvent.code` 一共出现在两类地方：
 * `main.ts` 的 `switch (e.code)`（一次性动词）与 9 处 `this.keys.has('KeyW')`
 * （持续按住）。而**合成按键的还有三方**：
 *
 * · `touchControls.ts` —— 触屏那颗「暂停」按钮合成 `Escape`
 * · `lakesidePanel.ts` —— 湖边出口合成 `Escape`
 * · `xr.ts` —— 手柄 menu 键合成 `Escape`
 *
 * 四方各写一份 `Escape` 的话，玩家把暂停改到 `KeyP` 之后，
 * 触屏按钮和头显菜单**会静默失效**（它们还在派发 `Escape`，
 * 而 `Escape` 已经不对应任何动作了）。所以合成侧也必须走这张表——
 * 这也是它为什么是**模块级单例**而不是 `App` 的一个字段：
 * `touchControls` 与 `xr` 拿不到 `App`。
 *
 * ## 为什么不做「同一把键绑到两个动作」
 *
 * 允许的话，玩家会得到一个自己都没意识到的坑：两个动作共用一把键，
 * 触发顺序由 `switch` 的 case 顺序决定，而那个顺序不是设计出来的。
 * 所以 `setKeymap()` **拒绝**制造冲突，并报出是哪两个动作。
 *
 * ## 冲突怎么判
 *
 * 按**物理 code** 比。`ShiftLeft` 与 `ShiftRight` 视为两个不同的键——
 * 它们在浏览器里本来就是两个 `code`，而把左右 Shift 判成冲突
 * 会让"我想用左 Shift 加速"这种完全正常的配置被拒。
 */

export type GameAction =
  | 'forward' | 'back' | 'left' | 'right'
  | 'confirm' | 'interact'
  | 'camera' | 'vehicle' | 'mute' | 'pause';

/** 每一项都要有 `key_<action>` 与 `key_<action>_desc` 两条文案。 */
export const ACTIONS: readonly GameAction[] = [
  'forward', 'back', 'left', 'right',
  'confirm', 'interact',
  'camera', 'vehicle', 'mute', 'pause',
];

export const DEFAULT_KEYMAP: Record<GameAction, string> = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  confirm: 'Space',
  interact: 'KeyF',
  camera: 'KeyV',
  vehicle: 'KeyE',
  mute: 'KeyM',
  pause: 'Escape',
};

/**
 * 模块级当前键位表。
 *
 * 只在两处被写：启动时从设置灌一次，设置面板改键时。读的地方遍布
 * `main.ts` / `touchControls.ts` / `xr.ts` / `lakesidePanel.ts`。
 */
let current: Record<GameAction, string> = { ...DEFAULT_KEYMAP };

/**
 * 把设置里的键位灌进来。
 *
 * ## 为什么不能直接 `{...DEFAULT_KEYMAP, ...raw}`
 *
 * `settings.keymap` 来自 `localStorage`，那是个**玩家可以手改的文件**。
 * 一份手改过的设置可以写出 `{"pause": "KeyW"}`，而那样「前进」和「暂停」
 * 就共用了同一把键——`actionOf()` 返回**第一个**匹配的，于是「前进」
 * 从此按不动，而界面上没有任何一句话说为什么。
 *
 * 所以这里**逐项校验**，而不只是浅合并：
 * · 不是字符串的丢掉；
 * · 是保留码（`F8` / `Digit1` / …）的丢掉；
 * · 和前面某个动作撞了的丢掉（保留默认，不报——
 *   反正玩家下一步会去设置里看到它）。
 *
 * 每次碰撞都**记进 `console.warn`**：不拦玩家自己玩的自由，
 * 但要让排障的人一眼能看出是哪一份设置出了问题。
 */
export function setKeymap(next: Partial<Record<GameAction, string>>): void {
  const out: Record<GameAction, string> = { ...DEFAULT_KEYMAP };
  for (const a of ACTIONS) {
    const v = next[a];
    if (typeof v !== 'string' || v.length === 0) continue;
    if (RESERVED_CODES.has(v)) {
      console.warn(`[gift188] 键位「${a}」不能绑到保留键 ${v}，已跳过`);
      continue;
    }
    const clash = ACTIONS.find((other) => other !== a && out[other] === v);
    if (clash) {
      console.warn(`[gift188] 键位「${a}」与「${clash}」撞在同一把键 ${v} 上，已退回默认 ${DEFAULT_KEYMAP[a]}`);
      continue;
    }
    out[a] = v;
  }
  current = out;
}

export function getKeymap(): Record<GameAction, string> {
  return current;
}

/** 动作 → 物理键。**合成按键的那几方一律走这里。** */
export function codeOf(action: GameAction): string {
  const v = current[action];
  return typeof v === 'string' && v.length > 0 ? v : DEFAULT_KEYMAP[action];
}

/**
 * 物理键 → 动作。返回 `null` 表示这一下没有绑到任何动作。
 *
 * 注意 `Digit1~4` 与 `F8~F10` **不在表里**——它们是固定功能键
 * （道具栏 / 调试），不给重映射，否则玩家改键改到一半发现
 * 「数字键选道具」也一起没了，而那与本次改动无关。
 */
export function actionOf(code: string): GameAction | null {
  for (const a of ACTIONS) {
    if (current[a] === code) return a;
  }
  return null;
}

/**
 * **不给重映射的固定功能键。**
 *
 * 它们原来靠「不在表里」来躲过重映射，可那条路挡不住**反向**的坑：
 * 玩家把「暂停」绑到 `F8`，而 `main.ts` 的 switch 是先问动作表再问物理码
 * （`this.actionOf(e.code) ?? e.code`），于是 `F8` 被认成「暂停」，
 * 而性能面板那颗键**从此按不动**——没有任何提示，按键那一栏写的是「成功」。
 *
 * 所以这些码不能作为**目标**出现。它们在主机的 switch 里按物理码直接匹配，
 * 而那里的顺序是「动作表优先」——一个动作占了它，物理码那一支就永远够不着了。
 */
const RESERVED_CODES: ReadonlySet<string> = new Set([
  // 道具栏 1~4
  'Digit1', 'Digit2', 'Digit3', 'Digit4',
  // 调试面板
  'F8', 'F9', 'F10', 'KeyP', 'KeyB',
  // 硬编码的「确认」并联键
  'Enter', 'NumpadEnter',
]);

/**
 * 写入一个新键位。返回 `null` 表示成功，否则返回**冲突说明**。
 *
 * 调用方（设置面板）负责把那句话摆到界面上——它要说得比这里详细，
 * 因为它知道玩家刚按了哪一颗键。
 */
export function tryBind(action: GameAction, code: string): string | null {
  if (RESERVED_CODES.has(code)) return 'reserved';
  const clash = ACTIONS.find((a) => a !== action && current[a] === code);
  if (clash) return clash;
  current = { ...current, [action]: code };
  return null;
}

/**
 * 一个键显示成什么样：`W` / `空格` / `Esc`。
 *
 * ## 为什么显示名和 `code` 要分开
 *
 * `code` 是布局相关的（`KeyW` 在 AZERTY 上是 `KeyZ` 的位置），
 * 而面板上写 `KeyW` 没人看得懂。`KeyboardEvent.key` 才是当前布局上的那个键。
 * 但 `key` 在非拉丁布局上可能是「Z」，而中文玩家看到的是「Z」——
 * 两种都出现过，所以显示名以 `code` 为主（稳定、可预期），
 * 少数几个高频键用 `code` 直接翻成人话。
 */
const CODE_LABEL: Record<string, string> = {
  Space: 'Space',
  Escape: 'Esc',
  Enter: 'Enter',
  ShiftLeft: 'L Shift',
  ShiftRight: 'R Shift',
  ControlLeft: 'L Ctrl',
  ControlRight: 'R Ctrl',
  AltLeft: 'L Alt',
  AltRight: 'R Alt',
};

/** `KeyW` → `W`，`Digit1` → `1`，`Space` → `Space`。 */
export function codeLabel(code: string): string {
  // 手改过的 `settings.keymap` 可以把非字符串灌进来，
  // 而这里在 `new UI()` 里跑——一处 `TypeError` 就让整个游戏起不来。
  if (typeof code !== 'string') return '?';
  const mapped = CODE_LABEL[code];
  if (mapped) return mapped;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}