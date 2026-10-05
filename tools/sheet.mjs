// 把 scout 目录里的候选帧拼成接触印相，带名字。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] || path.join(HERE, '..', 'shots', 'scout');
const out = process.argv[3] || path.join(HERE, '..', 'shots', 'scout', '_sheet.jpg');
const COLS = 4, W = 384, H = 216;
// 这个 ffmpeg 是 ImageMagick 自带的，没有 fontconfig，drawtext 必须给绝对路径，
// 否则报 "Cannot load default config file" 然后整条滤镜链失败。
const FONT = 'C\\:/Windows/Fonts/arial.ttf';

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg') && !f.startsWith('_')).sort();
if (!files.length) { console.log('no frames in', dir); process.exit(0); }

const ins = [], flt = [], layout = [];
files.forEach((f, i) => {
  ins.push('-i', path.join(dir, f));
  const label = path.basename(f, '.jpg');
  flt.push(`[${i}:v]scale=${W}:${H},drawtext=fontfile='${FONT}':text='${label}':fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.6:boxborderw=4:x=6:y=6[v${i}]`);
  const c = i % COLS, r = Math.floor(i / COLS);
  layout.push(`${c * W}_${r * H}`);
});
const n = files.length;
const fc = flt.join(';') + ';' + files.map((_, i) => `[v${i}]`).join('') + `xstack=inputs=${n}:layout=${layout.join('|')}[out]`;

execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...ins,
  '-filter_complex', fc, '-map', '[out]', '-frames:v', '1', '-q:v', '4', out]);
console.log(`sheet: ${n} frames, ${COLS} cols -> ${out}`);
