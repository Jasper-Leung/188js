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

export function setKeymap(next: Partial<Record<GameAction, string>>): void {
  current = { ...DEFAULT_KEYMAP, ...next };
}

export function getKeymap(): Record<GameAction, string> {
  return current;
}

/** 动作 → 物理键。**合成按键的那几方一律走这里。** */
export function codeOf(action: GameAction): string {
  return current[action] ?? DEFAULT_KEYMAP[action];
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
 * 写入一个新键位。返回 `null` 表示成功，否则返回**冲突说明**。
 *
 * 调用方（设置面板）负责把那句话摆到界面上——它要说得比这里详细，
 * 因为它知道玩家刚按了哪一颗键。
 */
export function tryBind(action: GameAction, code: string): string | null {
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
  const mapped = CODE_LABEL[code];
  if (mapped) return mapped;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}