/**
 * 摇杆解算 —— 纯数值，不碰 DOM。
 *
 * 放在 `core/` 而不是 UI 层有两个理由，第二个是主要的：
 *
 * 1. **它就是输入数学**。UI 负责"把事件变成意图"，怎么从偏移算出意图
 *    跟界面无关。放在 UI 里会让无头回归为了验一行算术而拖进整套 DOM。
 * 2. **符号约定只在真机上暴露**。搞反了不会报任何错——摇杆照样能拖、
 *    界面一切正常，只是"往上推车往后走"。桌面上根本没有摇杆，
 *    所以这个 bug 必然漏过所有桌面测试。放在 core 里，`verify_touch`
 *    就能用 Node 直接守住它。
 *
 * 约定（与 `RideInput` 对齐）：**`moveY` 向上为负**，
 * 因为宿主算的是 `throttle += touch.moveY`，而 `throttle` 负为前进。
 */

/** 摇杆行程（px）。超过这个距离按比例饱和，不会无限加速。 */
export const STICK_R = 46;

/** 死区。比它小当作没推——手指按住不动时的微小抖动不该让车慢慢爬。 */
export const DEAD = 0.16;

/**
 * 从"手指相对中心的偏移（单位：行程）"算出 `[moveX, moveY]`。
 *
 * `dx`/`dy` 是**屏幕方向**：右为正、下为正。
 */
export function stickVector(dx: number, dy: number): [number, number] {
  const len = Math.hypot(dx, dy);
  if (len > 1) {
    dx /= len;
    dy /= len;
  }
  const mag = Math.hypot(dx, dy);
  if (mag < DEAD) return [0, 0];
  // 死区之外重新归一化，让「刚过死区」就已经是有效输入——
  // 不然玩家会以为推了没反应，要推到很偏才动。
  const k = (mag - DEAD) / (1 - DEAD) / mag;
  return [dx * k, dy * k];
}

/** 键盘 → `[x, y]`。与指针走同一套方向约定，所以摇杆既能拖也能用方向键推。 */
export function keyToVec(code: string): [number, number] | null {
  switch (code) {
    case 'ArrowLeft':
    case 'KeyA':
      return [-1, 0];
    case 'ArrowRight':
    case 'KeyD':
      return [1, 0];
    case 'ArrowUp':
    case 'KeyW':
      return [0, -1];
    case 'ArrowDown':
    case 'KeyS':
      return [0, 1];
    default:
      return null;
  }
}
