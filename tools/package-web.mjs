/**
 * 打一个可分发的 zip —— 给表单里「下载链接」那一栏用。
 *
 * ## 为什么需要它
 *
 * 提交页的下载栏现在给的是 GitHub 源码 zip（`submission/site.json` 的
 * `sourceZipUrl`），那个链接永远有效，不需要维护。但表单 §3.2 也提到了另一条路：
 * 发一个 GitHub Release，附上构建产物。本脚本就是产线那一环。
 *
 * 产物在 `release/`（已 gitignore），发布时挂到 Release 上，再把地址填回
 * `submission/site.json` 的 `releaseUrl`，重跑一次 `npm run build` 即可。
 *
 * ## 为什么自己写 zip 而不调 Compress-Archive
 *
 * 少一个平台依赖：Windows 上 `Compress-Archive` 在路径超长时有已知的坑，
 * 而这个 zip 里全是深层相对路径。deflateRaw 是 `node:zlib` 自带的。
 *
 * 用法：
 *   node tools/package-web.mjs            # 需要先有 dist/（没有就报错退出）
 *   node tools/package-web.mjs --no-video # 不带 23MB 的录屏，产物小很多
 */
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'release');
const NO_VIDEO = process.argv.includes('--no-video');

/**
 * CRC-32（IEEE）。
 *
 * 自己算而不是用 `node:zlib` 的 `crc32()`：那个是 Node 20.15 / 22.2 才加的，
 * 而 CI 跑的是 `node-version: 20`（拿到的是当期最新 20.x，够用，但那是运气不是保证）。
 * 这张表 256 项，写死比赌版本稳。
 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/ 里没有 index.html —— 先跑 npm run build。');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const NAME = `gift-no188-web-v${pkg.version}.zip`;

/** 收集要打进去的文件（相对路径用 / ，zip 规范如此）。 */
function collect(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const rel = relative(base, p).split(sep).join('/');
    if (e.isDirectory()) out.push(...collect(p, base));
    else out.push({ abs: p, rel });
  }
  return out;
}

const files = collect(DIST).filter((f) => !(NO_VIDEO && f.rel.endsWith('.mp4')));
const raw = files.map((f) => ({ ...f, data: readFileSync(f.abs) }));
const total = raw.reduce((n, f) => n + f.data.length, 0);

// ---------------------------------------------------------------- 写 zip

const locals = [];
const centrals = [];
let offset = 0;

function dosTime(d) {
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xffff,
    date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
  };
}
const { time: dosT, date: dosD } = dosTime(new Date());

for (const f of raw) {
  const deflated = deflateRawSync(f.data, { level: 6 });
  // 压不小就存原件（小文件上 deflate 反而变大）
  const useDeflate = deflated.length < f.data.length;
  const body = useDeflate ? deflated : f.data;
  const method = useDeflate ? 8 : 0;
  const name = Buffer.from(f.rel, 'utf8');
  const crc = crc32(f.data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // 文件名 UTF-8
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(dosT, 10);
  local.writeUInt16LE(dosD, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(f.data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, name, body);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(dosT, 12);
  central.writeUInt16LE(dosD, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(f.data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0o644 << 16, 38); // external attrs
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);

  offset += local.length + name.length + body.length;
}

const centralBuf = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(raw.length, 8);
eocd.writeUInt16LE(raw.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, NAME);
writeFileSync(outPath, Buffer.concat([...locals, centralBuf, eocd]));

const zipSize = statSync(outPath).size;
console.log('');
console.log(`=== 可分发包 ===`);
console.log(`  ${relative(ROOT, outPath)}`);
console.log(`  ${raw.length} 个文件 · 解压后 ${(total / 1024 / 1024).toFixed(2)} MB · zip ${(zipSize / 1024 / 1024).toFixed(2)} MB`);
if (NO_VIDEO) console.log(`  （--no-video：没带录屏文件）`);
console.log('');
console.log('  下一步（可选 —— 页面上「桌面版下载」指的是 Tauri 安装包，与这个网页包不是一回事）：');
console.log(`    gh release upload v${pkg.version} release/${NAME} --clobber`);
console.log('    想把它挂到页面上，就在下载区再加一行；否则留着自己留档也行。');
console.log('');