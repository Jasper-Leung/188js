// 空镜 B Roll 录制器（定稿）。
//
// 三个要点：
//   1. `cine.noCharacter = true` —— 画面里没有人。自由机位下角色本来是入镜的
//      （第一视角才自动藏），录风景必须单独开这个。
//   2. 机位**沿路推轨**（dolly），不是定点。世界是静止的，固定机位配静止画面
//      只会得到一段"在动但什么都没有"的视频；沿路推才有树影扫过的视差。
//   3. 确定性步进 —— 每帧正好推进 1/60 秒，编码出来绝对平滑。
//
// 机位高度锁在 2.6~3.2m：**行道树离路 >=16m、高 8~12m**，只要机位在路面上
// 就一定干净。之前试过 32m 的空中机位，反而插进树冠/竹丛里（竹子能到 22m）。
//
// 时长随便：node tools/scenery.mjs 30  -> 每条 30 秒，没有时长上限。
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pointAtArc, TOTAL_LENGTH } from './route-geom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRAMES_DIR = path.join(HERE, '..', 'shots', 'scenery');
const OUT_DIR = path.join(HERE, '..', 'promo', 'footage');
fs.mkdirSync(FRAMES_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const FPS = 60;
const seconds = Number(process.argv[2] || 12);
const only = process.argv[3] || null;

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// 每条：沿环线的一段推轨。[起始弧长, 结束弧长, 机位高, 看向点前伸(米), 名字]
// 这些弧长是从 scout 接触印相里逐张挑出来的：站在这些位置画面是干净的，
// 而且正前方有东西可看（树、茶寮、湖、竹丛）。
const SHOTS = [
  { name: '01-pine-road',    from: 430, to: 500, y: 2.9, look: 80 },
  { name: '02-tea-shed',     from: 575, to: 645, y: 3.1, look: 70 },
  { name: '03-lakeside',     from: 700, to: 760, y: 2.7, look: 60 },
  { name: '04-bamboo',       from: 985, to: 1055, y: 2.8, look: 65 },
  { name: '05-open-road',    from: 130, to: 200, y: 3.0, look: 85 },
  { name: '06-pines-deep',   from: 735, to: 800, y: 2.6, look: 55 },
];

const shots = only ? SHOTS.filter((s) => s.name.includes(only)) : SHOTS;

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--hide-scrollbars', '--mute-audio', '--force-device-scale-factor=1',
         '--disable-frame-rate-limit', '--disable-gpu-vsync'],
});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 140)));

await page.goto('http://127.0.0.1:4173/?tier=2&touch=0&cine=1', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => {
  const b = document.getElementById('boot');
  return !b || getComputedStyle(b).opacity === '0' || b.offsetParent === null;
}, { timeout: 180000 });
for (const sel of ['button:has-text("Start Journey")', 'button:has-text("Start Over")', 'button:has-text("开启旅程")']) {
  const b = page.locator(sel).first();
  if (await b.count()) { await b.click().catch(() => {}); break; }
}
await page.waitForTimeout(800);
for (const sel of ['button:has-text("Start Riding")', 'button:has-text("开启旅程")']) {
  const b = page.locator(sel).first();
  if (await b.count()) { await b.click().catch(() => {}); break; }
}
await page.waitForTimeout(2500);
await page.evaluate(() => { window.gift188.cine.noCharacter = true; });

const FRAMES = Math.round(seconds * FPS);
const made = [];

for (const s of shots) {
  const dir = path.join(FRAMES_DIR, s.name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });

  const start = pointAtArc(s.from);
  await page.evaluate((p) => { window.gift188.cine.goto(p.x, p.z); }, start);
  await page.waitForTimeout(2500);          // 让这一带的植被/建筑流式补上

  const f0 = await page.evaluate(() => window.gift188.cine.frame);

  for (let i = 0; i < FRAMES; i++) {
    const t = ease(i / (FRAMES - 1));
    const camA = s.from + (s.to - s.from) * t;   // 机位当前弧长
    const cam = pointAtArc(camA);
    const aim = pointAtArc(camA + s.look);       // 看向点永远在前方固定距离
    await page.evaluate((a) => {
      window.gift188.cine.pose(a[0], a[1], a[2], a[3], a[4], a[5]);
    }, [cam.x, s.y, cam.z, aim.x, 2.0, aim.z]);
    await page.waitForFunction((tg) => (window.gift188.cine?.frame ?? -1) >= tg, f0 + i + 1, { timeout: 15000 });
    await page.screenshot({ path: path.join(dir, `${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 94 });
  }

  const list = path.join(dir, 'list.txt');
  fs.writeFileSync(list, Array.from({ length: FRAMES },
    (_, i) => `file '${String(i).padStart(5, '0')}.jpg'`).join('\n'), 'utf8');

  const mp4 = path.join(OUT_DIR, `${s.name}.mp4`);
  const { execFileSync } = await import('node:child_process');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-r', String(FPS), '-i', list,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p',
    '-r', String(FPS), '-movflags', '+faststart', mp4,
  ], { cwd: dir, stdio: 'inherit' });

  made.push(mp4);
  console.log(`  ${s.name.padEnd(18)} ${seconds}s  ${Math.round(fs.statSync(mp4).size / 1024)} KB`);
}

await browser.close();
console.log('\n' + made.join('\n'));
