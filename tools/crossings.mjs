/**
 * 算出 8 字环线上**所有**的自交点，并报出每一处的夹角。
 *
 * 用途：交叉口是这次要改的那块（去掉圆盘盘、改成真正的交叉口），
 * 而"8 字有几个交叉、在哪、夹角多少"必须是量出来的——
 * 源项目只在其中一个交叉上放了广场盘，那个数（PLAZA_CENTER）
 * 不能代表另外三处，而三处才是真正需要处理的。
 */
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const outDir = mkdtempSync(join(tmpdir(), 'gift188-cross-'));
const outFile = join(outDir, 'x.mjs');

const ENTRY = join(outDir, 'entry.ts');
writeFileSync(
  ENTRY,
  `
import { CENTERLINE, TOTAL_ARCLENGTH, shapeReport } from '${ROOT.replace(/\\/g, '/')}/src/data/route';
export function run() {
  const n = CENTERLINE.length;
  const out = [];
  // 两个相邻的环向参数差至少 0.08（≈98m）才算"真的交叉"，
  // 否则同一条线上的近邻点会刷出一堆假交点
  const MIN_SEP = 0.08;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = i / (n - 1);
      const b = j / (n - 1);
      const sep = Math.min(Math.abs(a - b), 1 - Math.abs(a - b));
      if (sep < MIN_SEP) continue;
      const p = CENTERLINE[i];
      const q = CENTERLINE[j];
      const d = Math.hypot(p.x - q.x, p.z - q.z);
      if (d < 14) {
        // 夹角：两条切线方向
        const ti = tangent(i), tj = tangent(j);
        const dot = ti.x * tj.x + ti.z * tj.z;
        const ang = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
        out.push({ i, j, a: +a.toFixed(4), b: +b.toFixed(4), d: +d.toFixed(2), ang: +ang.toFixed(1), x: +p.x.toFixed(1), z: +p.z.toFixed(1) });
      }
    }
  }
  // 合并成簇：同一个交点会被记两次以上
  const clusters = [];
  for (const c of out) {
    const hit = clusters.find((k) => Math.hypot(k.x - c.x, k.z - c.z) < 30);
    if (hit) { hit.n++; if (c.ang < hit.ang) { hit.ang = c.ang; } }
    else clusters.push({ x: c.x, z: c.z, ang: c.ang, n: 1, at: [c.a, c.b] });
  }
  return { shape: shapeReport(), clusters: clusters.sort((p,q)=>p.x-q.x) };
}
function tangent(i: number) {
  const n = CENTERLINE.length;
  const a = CENTERLINE[Math.max(0, i - 1)];
  const b = CENTERLINE[Math.min(n - 1, i + 1)];
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
}
`,
  'utf8',
);

await build({ entryPoints: [ENTRY], outfile: outFile, bundle: true, format: 'esm', platform: 'node', target: 'node18', logLevel: 'warning', loader: { '.json': 'json' } });
const mod = await import(pathToFileURL(outFile).href);
const r = mod.run();
console.log('shape:', JSON.stringify(r.shape));
console.log('交叉口簇:');
for (const c of r.clusters) {
  console.log(`  (${c.x}, ${c.z})  最小夹角 ${c.ang}°  命中 ${c.n} 对  参数 ${c.at.map((v) => v.toFixed(3)).join(' / ')}`);
}
