/**
 * `ai:play` 的命令行解析。
 *
 * ## 为什么它单独一个文件
 *
 * **因为有人要验它。** 原来的 `flag()` 写在 `ai-play.mjs` 里面，
 * 而那个文件顶层就调 `main()`，所以判据没法 import 它——
 * 于是「文档里教的那条命令到底跑不跑得起来」这件事，
 * **只能靠人照着敲一遍**。
 *
 * 本轮就栽在这上面：`AGENTS.md` §6 与工具自己的用法注释都写着
 *
 *     npm run ai:play -- --follow --follow 90
 *
 * 而 `flag()` 用 `indexOf` 取**第一个** `--follow`，
 * 于是 `argv[0 + 1]` 是 `'--follow'` 这个字符串本身而不是 `'90'`，
 * `Number('--follow')` 出 NaN，**静默回落成默认的 30 秒**——
 * 而且 30 秒的报告看起来完全合理（100% 在路面、均 10.6 m/s），
 * 唯一的征兆是「我明明要 90 秒」。
 *
 * 那个文件里已经有一段专门讲这类 bug 的注释（"看起来还挺合理，
 * 所以这个 bug 能安静地活很久"），**而它自己的用法注释就是那个 bug 的教材。**
 * 把它抽出来之后，`tools/verify-all.mjs` 的 `[DOC]` 门就能拿**真函数**
 * 去跑文档里的每一行示例——不是抄一份逻辑来验，是验同一份。
 *
 * （按 `AGENTS.md` §2 的规矩它没有挂 package.json scripts：
 * 那条规矩针对的是"没人引用的脚本"，而这是被两个已存在的文件 import 的模块。）
 */

/**
 * 取 `--name` 的值。
 *
 * ## 为什么是 `lastIndexOf` 而不是 `indexOf`
 *
 * `indexOf` 让「同一个 flag 出现两次」这件事变成一个陷阱：
 * `--follow --follow 45` 取到的是第一个位置，它的下一个 token
 * 是**第二个 `--follow` 自己**，于是值变成 `NaN`。
 * `lastIndexOf` 让「重复写一遍再带值」和「只写一遍带值」完全等价，
 * 三种常见写法（`--follow 45` / `--follow --follow 45` / `--follow --seconds 45`）
 * 从此得到同一个结果，而文档只需要保证其中一种是对的。
 *
 * 这不是"顺手改的"：它是上一条那个 bug 的另一半。
 * 作者当时防住了「值是 `true`」（`Number(true) === 1`，
 * 会把 30 秒变成 1 秒），没防住「值是另一个 flag」。
 * **两种都是同一个错误形状：值没落在你以为它落的地方。**
 */
export function flag(argv, name, dflt = null) {
  const i = argv.lastIndexOf(`--${name}`);
  return i < 0 ? dflt : (argv[i + 1] ?? true);
}

/**
 * `--follow` 要跑多少秒。
 *
 * 两种来源，优先级 `--follow <秒>` 高于 `--seconds <秒>`。
 * **两者都拿不到数就回落 `--seconds` 的默认值 30**，而不是 1——
 * `Number(true) === 1` 那条坑在这里再挡一次。
 */
export function followSecondsFrom(argv) {
  const seconds = Number(flag(argv, 'seconds', 30));
  if (!argv.includes('--follow')) return seconds;
  const raw = flag(argv, 'follow');
  return typeof raw === 'string' && Number.isFinite(Number(raw)) ? Number(raw) : seconds;
}
