/**
 * 视野 —— 由画幅比例推出竖直 FOV。
 *
 * ## 这里原来写的是什么
 *
 * ```ts
 * camera.fov = camera.aspect < 0.8 ? 74 : 62;
 * ```
 *
 * 两个问题，都很安静：
 *
 * 1. **竖屏手机上横向几乎看不见路。** three 的 `PerspectiveCamera.fov`
 *    是**竖直**视野。竖屏 9:19.5 的比例是 0.46，74° 竖直换算成水平只有
 *    `2·atan(tan(37°)·0.46) ≈ 38°`——而横屏 16:9 下 62° 竖直对应 94° 水平。
 *    同一段路，在横屏看得见整条来路，在竖屏只看得见正前方一小块。
 * 2. **0.8 是一个硬台阶。** 转一下手机，FOV 在 62 与 74 之间**跳变**，
 *    画面会"咯哒"一下缩放。玩家说不出哪里不对，但会觉得晕。
 *
 * ## 现在的规则
 *
 * 保持横屏观感**一字不变**（16:9 仍是 62°），只在水平视野真的不够时才补，
 * 而且补的过程是连续的：
 *
 * ```
 * h(62°, aspect) ≥ 76°  →  62°（原样，不动）
 * 否则                →  把水平撑到 76°，竖直最多到 V_MAX
 * ```
 *
 * `76°` 这个下限是量出来的：4:3 平板在 62° 竖直下水平已有 77°，
 * 所以平板与笔记本**完全不受影响**；1:1 方画幅只有 62°，会被补到 76°；
 * 9:19.5 竖屏从 31° 补到 45°。
 *
 * ## 为什么竖直要设上限
 *
 * 纯粹锁水平的话，9:19.5 要把竖直开到 119°——那不是广角，是鱼眼，
 * 直线在画面边缘会折得很厉害，路面读成一条弧。`V_MAX = 84°` 是
 * "还能看、但不至于变成鱼眼"的边界。宁可竖屏窄一点，也不要畸变。
 */

/** 横屏基准竖直 FOV。改这个数等于改横屏观感，16:9 下必须仍是这个值 */
export const FOV_BASE = 62;

/** 参考画幅。与 16:9 一起定出"横屏的原始观感" */
export const FOV_REF_ASPECT = 16 / 9;

/** 水平视野下限。低于它的画幅会被补宽，见文件头 */
export const FOV_MIN_HORIZONTAL = 76;

/** 竖直 FOV 上限。再宽就成鱼眼了 */
export const FOV_MAX = 84;

const DEG = Math.PI / 180;

/** 水平 FOV（度）→ 竖直 FOV（度） */
function verticalFromHorizontal(hDeg: number, aspect: number): number {
  return (2 * Math.atan(Math.tan((hDeg * DEG) / 2) / aspect)) / DEG;
}

/** 竖直 FOV（度）→ 水平 FOV（度） */
export function horizontalFromVertical(vDeg: number, aspect: number): number {
  return (2 * Math.atan(Math.tan((vDeg * DEG) / 2) * aspect)) / DEG;
}

/**
 * 给定画幅比例，返回该用的竖直 FOV（度）。
 *
 * 纯函数、无副作用、**处处连续**——`aspect` 扫一遍不出现跳变。
 * 这一点本身就是它存在的理由：原来的三元表达式在 0.8 处不连续，
 * 而"转屏时画面跳一下"这种问题只看代码是看不出来的。
 */
export function verticalFovForAspect(aspect: number): number {
  const a = Number.isFinite(aspect) && aspect > 0.01 ? aspect : FOV_REF_ASPECT;
  const hNow = horizontalFromVertical(FOV_BASE, a);
  if (hNow >= FOV_MIN_HORIZONTAL) return FOV_BASE;
  return Math.min(Math.max(verticalFromHorizontal(FOV_MIN_HORIZONTAL, a), FOV_BASE), FOV_MAX);
}
