/**
 * 量 7 类程序化地标的**屋顶**：有没有、位置对不对、多高、多宽。
 *
 * 存在的理由：用户报"一部分建筑没屋顶，或者屋顶位置不对"，
 * 而"看起来对不对"在无头环境里答不了。能答的是**结构事实**：
 * 最高的那批顶点是不是屋顶、屋顶底面是不是坐在墙体顶面上、挑檐出檐多少。
 *
 * 用法：node tools/arch-roofs.mjs
 */
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = ROOT.replace(/\\/g, '/');
const outDir = mkdtempSync(join(tmpdir(), 'gift188-roof-'));
const outFile = join(outDir, 'roof.mjs');
const ENTRY = join(outDir, 'entry.ts');

writeFileSync(
  ENTRY,
  `
import { buildStationArch, ARCH_BY_MODEL_IDX } from '${SRC}/src/world/architecture';

export function run() {
  const out = [];
  for (const kind of Object.values(ARCH_BY_MODEL_IDX)) {
    const mb = buildStationArch(kind, 10);
    const p = mb.build().positions;
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
      minY = Math.min(minY, p[i+1]); maxY = Math.max(maxY, p[i+1]);
      minZ = Math.min(minZ, p[i+2]); maxZ = Math.max(maxZ, p[i+2]);
    }
    // 屋顶 = 最高那一层。取「高于总高 70%」的顶点当屋顶带，
    // 再取其中最低的 y 当檐底（起翘屋顶的檐口比脊低，所以是 min 不是 max）。
    const roofLo = minY + (maxY - minY) * 0.70;
    let rMinY = Infinity, rMaxY = -Infinity, rMinX = Infinity, rMaxX = -Infinity, rMinZ = Infinity, rMaxZ = -Infinity, n = 0;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i+1] < roofLo) continue;
      n++;
      rMinY = Math.min(rMinY, p[i+1]); rMaxY = Math.max(rMaxY, p[i+1]);
      rMinX = Math.min(rMinX, p[i]); rMaxX = Math.max(rMaxX, p[i]);
      rMinZ = Math.min(rMinZ, p[i+2]); rMaxZ = Math.max(rMaxZ, p[i+2]);
    }
    out.push({
      kind,
      tris: mb.triangleCount,
      body: { w: +(maxX-minX).toFixed(2), h: +(maxY-minY).toFixed(2), d: +(maxZ-minZ).toFixed(2) },
      roofVerts: n,
      roof: n ? {
        eaveY: +rMinY.toFixed(2), ridgeY: +rMaxY.toFixed(2),
        w: +(rMaxX-rMinX).toFixed(2), d: +(rMaxZ-rMinZ).toFixed(2),
      } : null,
      overhang: n ? +Math.max(rMaxX-rMinX-(maxX-minX), rMaxZ-rMinZ-(maxZ-minZ)).toFixed(2) : null,
    });
  }
  return out;
}
`,
  'utf8',
);

await build({ entryPoints: [ENTRY], outfile: outFile, bundle: true, format: 'esm', platform: 'node', target: 'node18', logLevel: 'warning', loader: { '.json': 'json' } });
const mod = await import(pathToFileURL(outFile).href);

console.log('\n=== 7 类地标的屋顶 ===\n');
console.log('类型        三角面  整体(宽×高×深)      屋顶顶点数  檐底/脊   屋顶(宽×深)   出檐');
for (const r of mod.run()) {
  const roof = r.roof
    ? `${r.roof.eaveY.toFixed(2).padStart(5)}/${r.roof.ridgeY.toFixed(2).padStart(5)}  ${(r.roof.w + '×' + r.roof.d).padEnd(12)}  ${String(r.overhang).padStart(5)}`
    : '  —— 无屋顶 ——  ';
  console.log(
    r.kind.padEnd(10),
    String(r.tris).padStart(6),
    `  ${(r.body.w + '×' + r.body.h + '×' + r.body.d).padEnd(16)}`,
    String(r.roofVerts).padStart(10),
    '  ' + roof,
  );
}
console.log();
