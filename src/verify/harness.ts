/**
 * 判据骨架 —— `entry.ts` 与各个拆出去的族共用的那几行。
 *
 * ## 为什么先抽它，而不是先搬判据
 *
 * `entry.ts` 连着四轮只涨不跌。拆它之前得先回答一个问题：
 * **搬出去的那些判据，靠什么把自己注册回来？**
 *
 * 靠 import。但 **ESM 的 import 会被提升**：一个只写
 * `import './vehicle'` 的模块，会在 `entry.ts` 的任何一行之前执行完，
 * 于是那一族全部排到最前面，**注册顺序变了**。
 *
 * 而注册顺序在这个项目里是有语义的 —— `entry.ts` 的 `verify_toast_reply`
 * 明确写着：「判据按注册顺序跑，谁先装上 DOM 桩后面那条就会拿到残桩」。
 *
 * 所以拆分的形状定成这样：
 *
 *   · **注册表留在 `entry.ts`**（`results` / `check` / `runAll` / `checkNames`），
 *     它是唯一的收集点，搬出去的族碰不到它。
 *   · **拆出去的族导出 `registerXxxChecks(check)`**，
 *     由 `entry.ts` 在**原来的位置**调用一次。
 *
 * 于是顺序逐字不变，搬移对判据不可见；而往后再拆任何一块，
 * 都只是复制这个形状。
 *
 * `expect` 住在这里是因为它两边都要用，而它是个纯粹的构造器：
 * 条件、给人看的那句话、断言条数，三样进一件出。
 */

/** 一条判据跑完的结果。`asserts` 是**它真的打出的断言数**——判据一条没打也是失败。 */
export interface CheckResult {
  ok: boolean;
  detail: string;
  asserts: number;
}

/** `check` 的形状。`entry.ts` 的注册表实现它，拆出去的族只调用它。 */
export type CheckFn = (name: string, fn: () => CheckResult) => void;

/**
 * 收一条判据的结果。
 *
 * 注意它**不判断**任何东西——判断在调用方写的那串 `if (...) probs.push(...)` 里，
 * 而 `tools/verify-all.mjs` 有意不信退出码（一条回归自己抛异常时退出码仍然是 0）。
 * 这里只负责把三样东西原样装进一个对象。
 */
export function expect(cond: boolean, detail: string, asserts: number): CheckResult {
  return { ok: cond, detail, asserts };
}
