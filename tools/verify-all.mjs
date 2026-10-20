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
import {
  FACTS_REL,
  checkNoDuplicatedFacts,
  compareFacts,
  computeFacts,
  parseFacts,
  writeFacts as writeFactsFile,
} from './release-facts.mjs';

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
// ---- 公开数字：唯一出处 ----
//
// 三道门，各治一件事：
//
//   1. `docs/release-facts.md` 里写的 == 这一轮真实跑出来的（治「漂」）
//   2. 公开文档里**没有**再写一遍那些数（治「抄了三遍所以必然抄不齐」）
//   3. `AGENTS.md` §6 的 follow 示例真的能被工具接受（治「文档里那条命令是死的」）
//
// **为什么放在这里而不是 `src/verify/entry.ts`。**
// 那几个数只有这里同时有：`results.length` 在包内也能拿到，
// 但 `totalAsserts` 要等**全部跑完**才累加得出来，而判据自己是在跑的过程中
// 被调用的——在 `entry.ts` 里问「断言总数是多少」会拿到自己还没打的那部分。
// 所以这一道放在 runner：它是唯一不循环的地方。
//
// **为什么是「唯一出处」而不是「记得更新」。**
// 以前基线写在 `AGENTS.md` 里，而同一对数字还被抄进了 `README.md`、
// `README.zh-CN.md`、`.github/release-body.md` 和提交页——于是
// `README.md` 写着 57 条、`README.zh-CN.md` 写着 88 条、release-body
// 写着 116 条，**三个数都是旧的，而回归全绿**。
// 抄三遍的东西必然抄不齐，所以治法是只留一份、别处指向它。
//
// `--write-facts` 时**跳过门 1**（正在重写它，它当然和现实不一致），
// 但门 2 照跑——门 2 治的正是文档，而这次跑的目的就是把文档改对。

const writeFacts = process.argv.includes('--write-facts');
const factsReal = computeFacts(results.length, totalAsserts);
const docsFail = [];
if (writeFacts) {
  writeFactsFile(factsReal);
  console.log('');
  console.log(`  已写出 ${FACTS_REL}`);
} else {
  docsFail.push(...checkFactsFile(factsReal));
}
docsFail.push(...checkNoDuplicatedFacts());
docsFail.push(...checkFollowExample());
if (docsFail.length) {
  console.log('');
  for (const p of docsFail) console.log(`  ${RED}[DOC] ${p}${OFF}`);
}

// 退出码只作为"CI 能不能红"的信号，**不作为通过与否的判据**
process.exit(fail > 0 || noAssert > 0 || deadFail || docsFail.length > 0 ? 1 : 0);

/**
 * 门 1：唯一出处那份文件，与这一轮真实跑出来的对不对得上。
 *
 * 抓的是**两种**过期：
 *   · 某个键的值落后 → 下一个照着它做决定的人会算错；
 *   · 键不在了 → 这道门会空转，所以要报（"空转的门比没有门更坏"）。
 */
function checkFactsFile(real) {
  const problems = [];
  let text;
  try {
    text = readFileSync(join(ROOT, FACTS_REL), 'utf8');
  } catch {
    return [`读不到 ${FACTS_REL} —— 跑一次 \`npm run facts\` 生成它`];
  }
  const written = parseFacts(text);
  problems.push(...compareFacts(written, real));
  if (!written.version) {
    problems.push(`${FACTS_REL} 里一个键都没解析出来 —— 这道门会空转`);
  }
  return problems;
}

/**
 * 门 3：`AGENTS.md` §6 的 follow 示例必须真的被工具接受。
 *
 * 抓的是**第四种过期**：文档里那条命令本身是死的。
 * 本轮就撞上过——`AGENTS.md` §6 与 `ai-play.mjs` 的用法注释都写着
 * `--follow --follow 90`，而解析取**第一个** `--follow`，
 * 于是 `argv[i+1]` 是 `'--follow'` 自己、`Number()` 出 NaN、
 * **静默跑成默认的 30 秒**；而 30 秒的报告看起来完全合理。
 *
 * 放在这道门里而不是 `src/verify/`：它和上面两条一样是
 * 「文档说的」对「真实跑出来的」，而且用的是**同一个**解析函数
 * （`tools/argv-flag.mjs`），不是抄一份逻辑来验。
 * 加在这里还有一个好处：**它不碰 `results.length`，所以不会动基线。**
 */
function checkFollowExample() {
  const problems = [];
  let text;
  try {
    text = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  } catch {
    return ['读不到 AGENTS.md'];
  }
  const followLines = [...text.matchAll(/npm run ai:play -- --follow[^\n]*/g)];
  if (!followLines.length) {
    problems.push('AGENTS.md §6 里找不到「npm run ai:play -- --follow」的示例——写法变了，这条门会空转');
  } else {
    for (const m of followLines) {
      const line = m[0].trim();
      // **先把行尾注释切掉再取最后一个 token。**
      // 漏掉这一步的话，`--follow 90   # 跟路骑 90 秒` 的最后一个 token 是
      // 「秒」，`Number()` 出 NaN → 整行被跳过 → 这条门从第一天起就是空的。
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
