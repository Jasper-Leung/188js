/**
 * 证明 `verify_buildings` 会红。
 *
 * 源项目搬来的一条方法论：
 * > 每加一条新断言，都要先证明它会红 —— 故意弄坏、看它红、撤掉。
 *
 * 一条永远绿的断言守不住任何东西。所以这里**故意**制造四种真实故障，
 * 逐个确认体检能指出来，然后恢复。
 *
 * 用法：node tools/verify-buildings-red.mjs
 */
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRCPATH = ROOT.replace(/\\/g, '/');
const outDir = mkdtempSync(join(tmpdir(), 'gift188-red-'));
const outFile = join(outDir, 'red.mjs');
const ENTRY = join(outDir, 'entry.ts');
const R = SRCPATH;

writeFileSync(
  ENTRY,
  `
import { auditBuildings, type AuditContext } from '${R}/src/debug/probe';
import { Terrain } from '${R}/src/world/terrain';
import { Road } from '${R}/src/world/road';
import { Stations } from '${R}/src/world/stations';
import { PRESETS } from '${R}/src/core/settings';
import { CENTERLINE } from '${R}/src/data/route';

/** 中心线上离 (x,z) 最近的点。只在造故障时用 */
function nearestOnCenterline(x, z) {
  let best = Infinity, bx = 0, bz = 0;
  for (const p of CENTERLINE) {
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < best) { best = d; bx = p.x; bz = p.z; }
  }
  return [bx, bz];
}

export function run() {
  const results = [];
  const fresh = () => {
    const terrain = new Terrain();
    const road = new Road(terrain);
    const stations = new Stations(PRESETS[1], terrain);
    const ctx = { stations, terrain, road };
    return { ctx, st: stations.list };
  };

  // ---- 基线：什么都��弄坏时，应该是干净的 ----
  {
    const { ctx } = fresh();
    const issues = auditBuildings(ctx);
    results.push({ name: '基线（未破坏）', want: 'clean', got: issues.length === 0 ? 'clean' : 'dirty', issues });
  }

  // ---- 故障 1：把一座站抬到 3m 高（悬空）。
  //      **要挪 group，不能只挪 worldPos**——worldPos 只是构造时用来摆位的副本，
  //      之后改它并不会移动物体。只改 worldPos 而不挪物体，
  //      检查应该报"位置记录与实际位置差 3m"，而不是报"悬空"。
  //      两种都试，验证两条判据各管一半。
  {
    const { ctx, st } = fresh();
    const s = st[2];
    s.worldPos.y += 3;
    s.object.position.y += 3;
    s.object.updateMatrixWorld(true);
    const issues = auditBuildings(ctx);
    results.push({ name: '把 #2 整体抬高 3m（悬空）', want: 'dirty', got: issues.length > 0 ? 'dirty' : 'clean', issues });
  }

  // ---- 故障 1b：只改 worldPos 的**水平**位置，不挪物体 ----
  //    注意不能用 y：worldPos.y 是**地面**高度，而包围盒中心 y 是楼的腰高，
  //    两者本来就不该相等，拿 y 去比会天天误报。
  {
    const { ctx, st } = fresh();
    st[2].worldPos.x += 3;
    const issues = auditBuildings(ctx);
    const hit = issues.some((i) => /位置记录与实际位置/.test(i.msg));
    results.push({ name: '只改 #2 的水平位置记录', want: 'dirty', got: hit ? 'dirty' : 'clean', issues });
  }

  // ---- 故障 2：把一座站推进沥青里 ----
  //    方向必须**指向最近的中心线点**，不能瞎写 +x：
  //    站本来就被偏置到路的一侧，+14 有可能正好把它推得更远。
  {
    const { ctx, st } = fresh();
    const s = st[5];
    const [nearX, nearZ] = nearestOnCenterline(s.worldPos.x, s.worldPos.z);
    let dx = nearX - s.worldPos.x;
    let dz = nearZ - s.worldPos.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    // 挪到中心线边上：18m -> 2m
    const step = l - 2;
    s.worldPos.x += dx * step; s.worldPos.z += dz * step;
    s.object.position.x += dx * step; s.object.position.z += dz * step;
    s.object.updateMatrixWorld(true);
    const issues = auditBuildings(ctx);
    results.push({ name: '把 #5 推进离中心线 2m', want: 'dirty', got: issues.length > 0 ? 'dirty' : 'clean', issues });
  }

  // ---- 故障 3：把一座站埋进地里 2m ----
  {
    const { ctx, st } = fresh();
    st[0].object.position.y -= 2;
    st[0].object.updateMatrixWorld(true);
    const issues = auditBuildings(ctx);
    results.push({ name: '把 #0 埋进地下 2m', want: 'dirty', got: issues.length > 0 ? 'dirty' : 'clean', issues });
  }

  // ---- 故障 4：地基不平（把地形抬起来做出一个 4m 的台子）----
  {
    const { ctx, st } = fresh();
    const s = st[6];
    const orig = ctx.terrain.getHeightAt.bind(ctx.terrain);
    ctx.terrain.getHeightAt = (x, z) => {
      const d = Math.hypot(x - s.worldPos.x, z - s.worldPos.z);
      return orig(x, z) + (d < 5 ? 5 : 0);
    };
    const issues = auditBuildings(ctx);
    results.push({ name: '在 #6 底下堆一个 5m 的台子', want: 'dirty', got: issues.length > 0 ? 'dirty' : 'clean', issues });
  }

  // ---- 故障 5：玩家已进加载半径，而某座真模型仍未加载 ----
  {
    const { ctx, st } = fresh();
    ctx.playerX = st[4].worldPos.x;
    ctx.playerZ = st[4].worldPos.z;
    const issues = auditBuildings(ctx);
    const hit = issues.some((i) => i.station === 4 && /未加载/.test(i.msg));
    results.push({ name: '玩家站到未加载的站旁', want: 'dirty', got: hit ? 'dirty' : 'clean', issues });
  }

  return results;
}
`,
  'utf8',
);

await build({ entryPoints: [ENTRY], outfile: outFile, bundle: true, format: 'esm', platform: 'node', target: 'node18', logLevel: 'warning', loader: { '.json': 'json' } });
const mod = await import(pathToFileURL(outFile).href);
const results = mod.run();

const COL_GREEN = '\x1b[32m';
const COL_RED = '\x1b[31m';
const COL_DIM = '\x1b[2m';
const COL_OFF = '\x1b[0m';

console.log('\n=== 证明 verify_buildings 会红 ===\n');
let bad = 0;
for (const r of results) {
  const ok = r.got === r.want;
  if (!ok) bad++;
  const mark = ok ? `${COL_GREEN}符合预期${COL_OFF}` : `${COL_RED}不符合！${COL_OFF}`;
  console.log(`  ${ok ? `${COL_GREEN}PASS${COL_OFF}` : `${COL_RED}FAIL${COL_OFF}`}  ${r.name.padEnd(30)} 期望=${r.want.padEnd(6)} 实际=${r.got.padEnd(6)} ${mark}`);
  for (const i of r.issues.slice(0, 3)) console.log(`        ${COL_DIM}#${i.station} ${i.name} [${i.level}] ${i.msg}${COL_OFF}`);
}
console.log(`\n  ${results.length - bad}/${results.length} 条符合预期${bad ? ` —— 有 ${bad} 条判据抓不住对应故障` : ' —— 判据确实能指出真实故障'}\n`);
if (bad) process.exitCode = 1;
