/**
 * 几何探针 —— 把回归抓到的两处偏差摊开看清楚。
 * 用法： node tools/probe.mjs
 */
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const outFile = join(mkdtempSync(join(tmpdir(), 'gift188-probe-')), 'probe.mjs');

await build({
  entryPoints: [join(ROOT, 'src/verify/probe.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  logLevel: 'warning',
  loader: { '.json': 'json' },
});

const mod = await import(pathToFileURL(outFile).href);
mod.probeAll();
