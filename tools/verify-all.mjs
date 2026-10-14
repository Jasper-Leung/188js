/**
 * 无头回归 —— 把 src/verify/entry.ts 打包成 ESM 在 Node 里跑。
 *
 * 判据**不信退出码**。这是从源项目搬来的一条：
 * 一条回归自己抛异常时，`--quit-after` 收掉进程的退出码是 0，
 * 于是"一行断言都没打过的回归"看着像跑通了。所以这里判三件事：
 *   1. 有没有真的打出断言（asserts > 0）
 *   2. 有没有 [FAIL]
 *   3. 抛没抛异常
 * 三者任一不满足就是没跑成，不许算通过。
 *
 * 用法： node tools/verify-all.mjs
 */
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { followSecondsFrom } from './argv-flag.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ENTRY = join(ROOT, 'src/verify/entry.ts');

const outDir = mkdtempSync(join(tmpdir(), 'gift188-verify-'));
const outFile = join(outDir, 'verify.mjs');

await build({
  entryPoints: [ENTRY],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  // **不要把 three 标成 external**。产物写在项目外的临时目录里，
  // 而 three 并没有走 WebGL——它只用向量/矩阵/Object3D 树，在 Node 里能跑。
  // external 的结果是运行时 `Cannot find package 'three'`，而报这个错
  // 的原因和"three 需要浏览器"完全无关，很容易被误判成"这套东西没法无头跑"。
  // 顺带这也是 verify_ride 的前提：它要在 Node 里真的把车开起来。
  logLevel: 'warning',
  // JSON import 是 esbuild 内置能力，不用配 loader 之外的开关
  // （`resolveJsonModule` 是 tsc 的选项，esbuild 不认，传了会直接抛）
  loader: { '.json': 'json' },
});

const mod = await import(pathToFileURL(outFile).href);
const results = mod.runAll();

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

console.log('');
console.log('=== 无头回归 ===');
let pass = 0;
let fail = 0;
let noAssert = 0;
let totalAsserts = 0;

for (const r of results) {
  let status;
  if (r.asserts === 0) {
    status = `${YELLOW}NO-ASSERT${OFF}`;
    noAssert++;
  } else if (r.ok) {
    status = `${GREEN}PASS${OFF}          `;
    pass++;
  } else {
    status = `${RED}FAIL${OFF}          `;
    fail++;
  }
  totalAsserts += r.asserts;
  console.log(`  ${r.name.padEnd(20)} ${status}  ${r.asserts} 条   ${DIM}${r.detail}${OFF}`);
}

console.log('');
console.log(`  跑过 ${results.length} 条：PASS ${pass} / FAIL ${fail} / 没跑成 ${noAssert}`);
console.log(`  断言 ${totalAsserts} 条，其中 ${fail} 条红`);
if (noAssert > 0) {
  console.log(`  ${YELLOW}没跑成的条目不算通过：它们一条断言都没打出来${OFF}`);
}
console.log('');

// ---- 文案死字 ----
//
// 单拎出来而不是塞进 entry.ts：它要读源码文件，而 entry 是给 esbuild 打进
// 单文件的，那边没有 fs（`scanDead()` 在这里是当库 import 的）。
//
// 它也是唯一一条**以「没发生过的问题」为判据**的检查：白名单之外的死字必须为零。
const deadRes = spawnSync(process.execPath, [join(__dirname, 'i18n-dead.mjs')], {
  encoding: 'utf8',
});
if (deadRes.stdout) process.stdout.write(deadRes.stdout);
if (deadRes.stderr) process.stderr.write(deadRes.stderr);
const deadFail = deadRes.status !== 0;

// ---- 文档基线：`AGENTS.md` §1 写的「当前基线」不许过期 ----
//
// **为什么放在这里而不是 `src/verify/entry.ts`。**
// 那两个数只有这里同时有：`results.length` 在包内也能拿到，
// 但 `totalAsserts` 要等**全部跑完**才累加得出来，而判据自己是在跑的过程中
// 被调用的——在 `entry.ts` 里问「断言总数是多少」会拿到自己还没打的那部分。
// 所以这一道放在 runner：它是唯一不循环的地方。
//
// **它已经是过期两次的东西了。** `AGENTS.md` §1 那张表的全部意义就是
// 「当前基线」，而它连续两轮落后于代码（67→71→79→实际）。
// 上一轮评审把它记成 P1「更新基线」，那只是治标——不装门，
// 下一轮还会再漂一次。
//
// 三条一起失守的写法：`npm run verify` 只看退出码，于是文档过期
// 没有任何人会知道。
const docsFail = checkDocBaseline(results.length, totalAsserts);
if (docsFail.length) {
  console.log('');
  for (const p of docsFail) console.log(`  ${RED}[DOC] ${p}${OFF}`);
}

// 退出码只作为"CI 能不能红"的信号，**不作为通过与否的判据**
process.exit(fail > 0 || noAssert > 0 || deadFail || docsFail.length > 0 ? 1 : 0);

/**
 * `AGENTS.md` 里写着的基线，与这一轮真实跑出来的对不对得上。
 *
 * 抓的是**三种**过期，各有各的症状：
 *   · §1 的条数 / 断言数落后 → 下一个人照着文档判断「要不要跑」会算错；
 *   · §3 的 `entry.ts` 行数落后 → 拆分进度表说谎，而那张表是用来做决定的；
 *   · 一处都找不到 → 文档被改了形状，这条判据会空转，所以要报。
 */
function checkDocBaseline(checkCount, assertCount) {
  const problems = [];
  let text;
  try {
    text = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  } catch {
    return ['读不到 AGENTS.md'];
  }

  // §1：`npm run verify     # 无头回归：79 条 / 1274 条断言 …`
  const headline = /无头回归：\s*(\d+)\s*条\s*\/\s*(\d+)\s*条断言/.exec(text);
  if (!headline) {
    problems.push('AGENTS.md §1 里找不到「无头回归：N 条 / N 条断言」那一行——基线的写法变了，这条门会空转');
  } else {
    if (Number(headline[1]) !== checkCount) {
      problems.push(
        `AGENTS.md §1 写的是 ${headline[1]} 条，实际 ${checkCount} 条（新增/删除判据后要改这里）`,
      );
    }
    if (Number(headline[2]) !== assertCount) {
      problems.push(
        `AGENTS.md §1 写的是 ${headline[2]} 条断言，实际 ${assertCount} 条`,
      );
    }
  }

  // §1 第二处：`断言 1274 条、0 条红`
  const tail = /断言\s*(\d+)\s*条、\s*0\s*条红/.exec(text);
  if (!tail) {
    problems.push('AGENTS.md §1 里找不到「断言 N 条、0 条红」那一句');
  } else if (Number(tail[1]) !== assertCount) {
    problems.push(`AGENTS.md §1 第二处写的是 ${tail[1]} 条断言，实际 ${assertCount} 条`);
  }

  // §4 的命令块：`npm run verify      # 87 条 / 1417 断言`
  //
  // 为什么要扫**不止 §1**：同一对数字在文里出现了三次（§1 两处 + §4 一处），
  // 而前两次都过期过一次。只钉住 §1 的话，另两处会安静地烂在那儿。
  // 代价是得躲开正文里那些**历史**叙述（"67→71→79 那两次"）——
  // 所以模式要求 `# N 条 / N 断言` 的紧邻写法，正文里那种不带这个形状。
  const assertsIn = /#\s*(\d+)\s*条\s*\/\s*(\d+)\s*断言/.exec(text);
  if (!assertsIn) {
    problems.push('AGENTS.md §4 里找不到「# N 条 / N 断言」那一行');
  } else {
    if (Number(assertsIn[1]) !== checkCount) {
      problems.push(`AGENTS.md §4 写的是 ${assertsIn[1]} 条，实际 ${checkCount} 条`);
    }
    if (Number(assertsIn[2]) !== assertCount) {
      problems.push(`AGENTS.md §4 写的是 ${assertsIn[2]} 条断言，实际 ${assertCount} 条`);
    }
  }

  // §3：`entry.ts` 仍有 **9,214 行**
  // 正则容得下 markdown 粗体——原文写的是 `仍有 **9,214 行**`，
  // 而 `**` 卡在数字前面会让这条门误报成「写法变了」。
  const entry = /`entry\.ts`\s*仍有\s*\**\s*([\d,]+)\s*\**\s*行/.exec(text);
  if (!entry) {
    problems.push('AGENTS.md §3 里找不到「`entry.ts` 仍有 N 行」——拆分进度表的写法变了');
  } else {
    const actual = readFileSync(join(ROOT, 'src', 'verify', 'entry.ts'), 'utf8').split('\n').length;
    const said = Number(entry[1].replace(/,/g, ''));
    if (Math.abs(said - actual) > 2) {
      problems.push(`AGENTS.md §3 写 entry.ts ${said} 行，实际 ${actual} 行`);
    }
  }

  // §6：`npm run ai:play -- --follow …` 的示例必须真的被工具接受
  //
  // 抓的是**第四种过期**：文档里那条命令本身是死的。
  // 本轮就撞上过——`AGENTS.md` §6 与 `ai-play.mjs` 的用法注释都写着
  // `--follow --follow 90`，而解析取**第一个** `--follow`，
  // 于是 `argv[i+1]` 是 `'--follow'` 自己、`Number()` 出 NaN、
  // **静默跑成默认的 30 秒**；而 30 秒的报告看起来完全合理。
  //
  // 放在这道门里而不是 `src/verify/`：它和上面三条一样是
  // 「文档说的」对「真实跑出来的」，而且用的是**同一个**解析函数
  // （`tools/argv-flag.mjs`），不是抄一份逻辑来验。
  // 加在这里还有一个好处：**它不碰 `results.length`，所以不会动 §1 的基线。**
  const followLines = [...text.matchAll(/npm run ai:play -- --follow[^\n]*/g)];
  if (!followLines.length) {
    problems.push('AGENTS.md §6 里找不到「npm run ai:play -- --follow」的示例——写法变了，这条门会空转');
  } else {
    for (const m of followLines) {
      const line = m[0].trim();
      // **先把行尾注释切掉再取最后一个 token。**
      // 漏掉这一步的话，`--follow 90   # 跟路骑 90 秒` 的最后一个 token 是
      // 「秒」，`Number()` 出 NaN → 整行被跳过 → 这条门从第一天起就是空的。
      // （写完这条判据后的第一轮自测就撞上了这个形状，见 REVIEW-round11 的返工记录。）
      const body = line.replace(/^.*?ai:play\s+--\s*/, '').split('#')[0].trim();
      const args = body ? body.split(/\s+/) : [];
      const want = Number(args[args.length - 1]);
      // `--follow` 不带值的示例没有秒数可查，跳过
      if (!Number.isFinite(want)) continue;
      const got = followSecondsFrom(args);
      if (got !== want) {
        problems.push(
          `AGENTS.md §6 的「${line}」写的是 ${want} 秒，工具实际会跑 ${got} 秒` +
            '（秒数只写一次 `--follow`，重复写会静默回落到默认值）',
        );
      }
    }
  }

  return problems;
}
