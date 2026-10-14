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

/**
 * 读源码做接线判据之前，先把注释剥掉。
 *
 * ## 为什么非剥不可
 *
 * 一条「这里必须调用 `foo()`」的断言，最容易的"故意弄坏"的方式是
 * **把那一行注释掉**——而注释里那个字符串**原封不动地留在文件里**，
 * 于是断言照样绿，量到的是"曾经有人写过它"，不是"它现在还在跑"。
 *
 * 口径与 `tools/i18n-dead.mjs` / `tools/i18n-supplement` 那两处同源，
 * **三处共用这一份**：它们问的是同一个问题（这句话现在还会不会被执行到），
 * 答案不该有三套写法。它住在 `harness.ts` 而不是 `entry.ts`，
 * 是为了让拆出去的族也用同一份——否则每搬一族就会多抄一份正则，
 * 而抄出去的那份迟早和原件漂掉。
 */
export const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

/**
 * 假 canvas ctx：只记录调用、不真的画。五个小游戏都不读像素。
 *
 * ## 为什么**只能有一份**
 *
 * 判据里最容易出的错就是**环境不真**：第一版 `verify_minigame_playable`
 * 用的 ctx 在 `measureText` 上返回固定宽度，于是「这一句有多长」永远算错；
 * 而这类假 ctx 只要复制两份，就会有一个测试在假环境里绿、另一个不是——
 * 然后两边各自"对"着跑，症状是一条判据红而另一条绿，且谁都说不出为什么。
 *
 * 所以它住在 `harness.ts`：`entry.ts` 与拆出去的族都从这里取。
 */
export function fakeCtx(w = 960, h = 540): CanvasRenderingContext2D {
  return new Proxy({} as Record<string, unknown>, {
    get(_t, k: string) {
      if (k === 'canvas') return { width: w, height: h };
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') {
        return () => ({ addColorStop() {} });
      }
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return () => undefined; // 所有绘制指令都是 no-op
    },
    set() {
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}
