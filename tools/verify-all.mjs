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
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

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

// 退出码只作为"CI 能不能红"的信号，**不作为通过与否的判据**
process.exit(fail > 0 || noAssert > 0 ? 1 : 0);
