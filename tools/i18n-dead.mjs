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

/**
 * 动态拼出来的 key：`` t(`cam_${mode}`) `` / `` `stele_${n}_line` ``。
 * 字面量扫描看不见它们，于是每个都被误判成"死字"。
 *
 * ## 为什么不手工登记
 *
 * 原来这里有一张手写的 `DYNAMIC_PREFIXES`（只有 `cam_` / `veh_`），
 * 于是它自己变成了"每加一处动态拼键就要记得改这里"的清单——
 * 而这份清单上次更新时，仓库里已经有 5 处动态拼键没登记：
 * 反派引子、石碑铭文、碎片名与碎片短句、章节标签。
 * 症状一模一样：**文案在表里、中英都有、代码里真的会被 `t()` 到，
 * 而回归报它们是死字。**
 *
 * 上一轮评审据这份报告得出"反派三场 13 条没接、全局压力为零"——
 * 那是**错的**：`updateVillain()` 每个字都念了。
 *
 * 所以改成**从源码自动推导**：扫出所有含 `${` 的模板字面量，
 * 取静态前缀与后缀；表里的 key 同时满足就认作"动态引用"。
 * 加一处动态拼键不需要改任何地方，误报从根上消失。
 *
 * 判据仍然保守：**只放宽"死字"这一侧**。前缀匹配到的 key 一定在表里，
 * 不会把没写过的 key 放过（那是下面 `findMissingRefs` 的活）。
 */
function templateShapes(blob) {
  const shapes = [];
  for (const m of blob.matchAll(/`([^`\\]*)\$\{[^}]*\}([^`\\]*)`/g)) {
    shapes.push({ head: m[1], tail: m[2] });
  }
  return shapes;
}

const isDynamicKey = (k, shapes) =>
  shapes.some(({ head, tail }) => head !== '' && k.startsWith(head) && k.endsWith(tail));

/**
 * 去掉注释再扫。
 *
 * 不去掉的话，**注释里提一句 `t('dusk_toast')` 就等于把这个键接上了**——
 * 而它恰恰是这一轮刚修掉的那种缺字。反过来也一样：注释里写
 * "这里本来要念 prologue_1" 会把一条死字伪装成活字。
 *
 * 只处理两种形态，都是安全的：
 *   · `/* … *\/` 整块
 *   · **整行**都是 `//` 注释的行（前面只允许空白）
 * 行尾注释保留——它和代码同一行，剥掉有可能伤到字符串字面量，
 * 而误留一个假引用是保守方向（死字那边偏保守，反向那边会多报一条，
 * 多报只会让人来看一眼，不会让人去改本来正确的代码）。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

/**
 * 数据里引用的 key：`world.json` 的 `VILLAIN_SCENES[].parts[].lines` 装的是
 * **键名本身**，由 `deliverVillain()` 循环 `t(key)` 取值。
 *
 * 所以只扫 `.ts` 的字面量会漏掉它们——而漏掉的方式最坏：
 * 报告说"反派三场 10 条没接、全局压力为零"，而实际上 `updateVillain()`
 * 每个字都在念。上一轮评审就是被这一条带偏的。
 *
 * 口径：把 `src/data/generated/*.json` 里所有字符串值收下来，
 * **凡与表里的键同名就算引用**。它只放宽死字这一侧，不影响反向检查。
 */
function dataKeys() {
  const dir = join(ROOT, 'src/data/generated');
  if (!existsSync(dir)) return new Set();
  const out = new Set();
  const walk = (v) => {
    if (typeof v === 'string') out.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      walk(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    } catch {
      /* 读不动就当它没有引用，不让这条检查自己变成阻塞项 */
    }
  }
  return out;
}

/** 递归收集 src 下的 .ts（跳过 verify 自己，免得它引用 key 把死字变成活字）。 */
function collect(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * 反向判据：**被 `t()` 引用、但表里根本没有的 key**。
 *
 * ## 为什么必须和死字判据成对存在
 *
 * 死字扫描查"写了没人用"，对另一族完全失明——而那一族**正在游戏里**：
 *
 * | 键 | 玩家在屏幕上看到的 |
 * |---|---|
 * | `t('key_item_bar')` | `⟨key_item_bar⟩`（引导页第一屏） |
 * | `t('dusk_toast')`   | `⟨dusk_toast⟩`（第二圈天色转暗时） |
 *
 * `t()` 的兜底把缺失渲染成 `⟨key⟩` 而不是 key 本身，
 * **在屏幕上看起来像一个设计**，所以没有任何工具会报错。
 * 而引导页那三行里两行自指（`V → V` / `E → E`）、一行是内部符号名，
 * 正好是玩家点「开启旅程」之后看到的**第一屏**。
 *
 * 两个判据成对：死字管"写了没送出去"，这一条管"引用了没写"。
 * 少了任何一半，另一半的漏洞都留着。
 */
function findMissingRefs(blob, table) {
  const missing = new Map();
  // t('key') / t("key") / t(lang, 'key')
  const re = /\bt\(\s*(?:[A-Za-z_$][\w$.]*\s*,\s*)?['"]([A-Za-z0-9_]+)['"]/g;
  for (const m of blob.matchAll(re)) {
    const k = m[1];
    if (k in table) continue;
    missing.set(k, (missing.get(k) ?? 0) + 1);
  }
  return missing;
}

export function scanDead() {
  const i18n = JSON.parse(readFileSync(join(ROOT, 'src/data/generated/i18n.json'), 'utf8'));
  const zh = i18n.zh || i18n;
  const en = i18n.en || {};
  const files = collect(join(ROOT, 'src')).filter((f) => !f.includes(`${'verify'}\\`) && !f.includes('/verify/'));
  const blob = stripComments(files.map((f) => readFileSync(f, 'utf8')).join('\n'));
  const shapes = templateShapes(blob);
  const fromData = dataKeys();

  const used = (k) =>
    isDynamicKey(k, shapes) ||
    fromData.has(k) ||
    blob.includes(`'${k}'`) ||
    blob.includes(`"${k}"`) ||
    blob.includes('`' + k + '`');
  const dead = Object.keys(zh).filter((k) => !used(k));

  const allowPath = join(ROOT, 'tools/i18n-dead-allow.json');
  const allow = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, 'utf8')) : [];
  const allowed = new Map(allow.map((a) => [a.key, a.why]));
  const unexpected = dead.filter((k) => !allowed.has(k));
  const stale = [...allowed.keys()].filter((k) => !dead.includes(k));

  // 反向：引用了但没写。两侧都要查——只查 zh 的话，一份只补了中文的
  // key 会在英文界面里变成 `⟨key⟩`，而中文玩家永远不会发现。
  const missingZh = findMissingRefs(blob, zh);
  const missingEn = findMissingRefs(blob, en);
  const missing = [...new Set([...missingZh.keys(), ...missingEn.keys()])].sort();

  return { total: Object.keys(zh).length, dead, allowed, unexpected, stale, missing, shapes };
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

  // ---- 反向：引用了但没写 ----
  console.log('');
  console.log('=== 缺字（引用了但表里没有 → 界面上显示 ⟨key⟩）===');
  if (r.missing.length) {
    for (const k of r.missing) console.log(`  ${RED}✗ t('${k}') 引用了它，两侧表里都没有${OFF}`);
    console.log(`  ${DIM}要么把这条文案补进 tools/i18n-supplement.json + src/data/generated/i18n.json（两侧都要），`);
    console.log(`  要么改用它本来该用的那条键${OFF}`);
  } else {
    console.log(`  ${GREEN}没有引用不存在的键${OFF}`);
  }

  process.exit(r.unexpected.length > 0 || r.missing.length > 0 ? 1 : 0);
}
