// 从空镜 mp4 里挑静帧：每条取 4 个候选，contact sheet 看着选。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FOOT = path.join(HERE, '..', 'promo', 'footage');
const CAND = path.join(HERE, '..', 'shots', 'stills-cand');
fs.mkdirSync(CAND, { recursive: true });
for (const f of fs.readdirSync(CAND)) fs.rmSync(path.join(CAND, f), { force: true });

const shots = fs.readdirSync(FOOT).filter((f) => f.endsWith('.mp4')).sort();
const picks = [];   // [tag, jpgPath]
const at = [0.22, 0.45, 0.68, 0.88];

for (const s of shots) {
  const base = path.basename(s, '.mp4');
  for (let i = 0; i < at.length; i++) {
    const ss = at[i] * 14;                     // 每条 14s
    const out = path.join(CAND, `${base}__${Math.round(at[i] * 100)}.jpg`);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(ss), '-i', path.join(FOOT, s), '-frames:v', '1', '-q:v', '2', out]);
    picks.push([`${base} @${ss.toFixed(1)}s`, out]);
  }
}

// 拼 contact sheet
const W = 480, H = 270, FONT = 'C\\:/Windows/Fonts/arial.ttf';
const ins = [], flt = [], layout = [];
picks.forEach(([tag, p], i) => {
  ins.push('-i', p);
  flt.push(`[${i}:v]scale=${W}:${H},drawtext=fontfile='${FONT}':text='${tag}':fontsize=17:fontcolor=yellow:box=1:boxcolor=black@0.65:boxborderw=4:x=6:y=6[v${i}]`);
  layout.push(`${(i % 4) * W}_${Math.floor(i / 4) * H}`);
});
const fc = flt.join(';') + ';' + picks.map((_, i) => `[v${i}]`).join('')
  + `xstack=inputs=${picks.length}:layout=${layout.join('|')}[out]`;
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...ins,
  '-filter_complex', fc, '-map', '[out]', '-frames:v', '1', '-q:v', '4',
  path.join(CAND, '_sheet.jpg')]);

console.log(`${picks.length} candidates from ${shots.length} shots`);
