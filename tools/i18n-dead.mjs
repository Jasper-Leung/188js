/**
 * 文案死字检查 —— 有没有「翻译了、写进表了、代码里一次都没引用」的 key。
 *
 * ## 为什么要单独一个环节
 *
 * 这一族 bug 不会让任何一条现有断言变红，因为它不产生任何**错误**：
 * `prologue_1`（律师函 / 三十日期限 / 母亲）躺在 i18n 表里，中英双语，
 * 谁也不会注意到它从没被 `t()` 过一次。玩家看到的只是"这游戏跟我没关系"。
 *
 * 实测：`266 条 key 里有 70 条` 引用数为 0——**26% 的文案玩家永远看不到**，
 * 其中包含整个序章、整个反派、碎片文本、石碑铭文。
 *
 * 它也不是 `verify_i18n` 能管的事：那条守的是"中英两侧 key 集合一致"，
 * 而死字是**两侧一致地没人用**。
 *
 * ## 判据
 *
 * 以 `src` 目录下所有 `.ts` 里出现的字符串字面量为"引用"。这是个**保守**口径：
 * `t('foo')` / `'foo'` / `` `foo` `` 都算引用。所以它只会**少报**
 * （动态拼出来的 key 会被误判成死字），不会多报——
 * 对一条守卫来说，少报比多报安全，因为多报会让人去改本来正确的代码。
 *
 * ## 白名单
 *
 * 死字里有一大块是**故意还没接的剧情**（序章、反派、石碑……）。
 * 它们不是忘了，是还没排到。所以不直接判 FAIL，而是：
 *   · 白名单里的 key 不算错；
 *   · **白名单之外出现任何新的死字 → FAIL**。
 *
 * 于是"死字数量"只能减不能增，而每接上一段剧情，就从白名单里划掉一行。
 * 白名单在 `tools/i18n-dead-allow.json`，每条都带 `why` 说明为什么还没接。
 *
 * 用法：node tools/i18n-dead.mjs        （由 verify-all.mjs 自动调用）
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 递归收集 src 下的 .ts（跳过 verify 自己，免得它引用 key 把死字变成活字）。 */
function collect(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

export function scanDead() {
  const i18n = JSON.parse(readFileSync(join(ROOT, 'src/data/generated/i18n.json'), 'utf8'));
  const zh = i18n.zh || i18n;
  const files = collect(join(ROOT, 'src')).filter((f) => !f.includes(`${'verify'}\\`) && !f.includes('/verify/'));
  const blob = files.map((f) => readFileSync(f, 'utf8')).join('\n');

  const used = (k) => blob.includes(`'${k}'`) || blob.includes(`"${k}"`) || blob.includes('`' + k + '`');
  const dead = Object.keys(zh).filter((k) => !used(k));

  const allowPath = join(ROOT, 'tools/i18n-dead-allow.json');
  const allow = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, 'utf8')) : [];
  const allowed = new Map(allow.map((a) => [a.key, a.why]));
  const unexpected = dead.filter((k) => !allowed.has(k));
  const stale = [...allowed.keys()].filter((k) => !dead.includes(k));

  return { total: Object.keys(zh).length, dead, allowed, unexpected, stale };
}

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

// 直接被 node 跑时才打表；被 verify-all.mjs `import` 时只当库用。
// 判据用 pathToFileURL 而不是字符串拼 `file://` —— Windows 上后者少一个斜杠，
// 症状是"跑起来什么都不打"，看上去像检查通过了。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = scanDead();
  const pct = ((r.dead.length / r.total) * 100).toFixed(0);

  console.log('');
  console.log('=== 文案死字（写了但没人引用）===');
  console.log(`  全表 ${r.total} 条 · 死字 ${r.dead.length} 条（${pct}%）· 白名单 ${r.allowed.size} 条`);

  if (r.stale.length) {
    console.log(`  ${YELLOW}白名单里有 ${r.stale.length} 条已经不再是死字（剧情接上了？）：${r.stale.join('、')}${OFF}`);
  }
  if (r.unexpected.length) {
    console.log(`  ${RED}新增死字 ${r.unexpected.length} 条：${r.unexpected.join('、')}${OFF}`);
    console.log(`  ${DIM}接上它，或者确认它确实还没排到、然后加进 tools/i18n-dead-allow.json（要写 why）${OFF}`);
  } else {
    console.log(`  ${GREEN}白名单之外没有新的死字${OFF}`);
  }
  // 白名单按理由分组打印：让人一眼看出「欠的是哪一段剧情」
  const byWhy = new Map();
  for (const [k, why] of r.allowed) {
    if (!r.dead.includes(k)) continue;
    if (!byWhy.has(why)) byWhy.set(why, []);
    byWhy.get(why).push(k);
  }
  for (const [why, ks] of byWhy) console.log(`  ${DIM}${String(ks.length).padStart(3)} 条  ${why}${OFF}`);

  process.exit(r.unexpected.length > 0 ? 1 : 0);
}
