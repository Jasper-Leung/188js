// 新版实录：载具（徒步/自行车/摩托车/滑板）× 视角（向前/追车/骑手）
// 沿中心线自动驾驶 + CDP screencast 逐帧落盘。
// 前车方向让 arc 递减，所以前视取 arc - LOOKAHEAD。
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { arcAt, pointAtArc } from './route-geom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'shots', 'screencast2');
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { force: true });

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:4173';
const RIDE_SECONDS = Number(process.argv[2] || 240);
const LOOKAHEAD = 14;

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'en-US' });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 140)));

await page.goto(`${BASE}/?tier=2&touch=0`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => {
  const b = document.getElementById('boot');
  return !b || getComputedStyle(b).opacity === '0' || b.offsetParent === null;
}, { timeout: 180000 });
console.log('boot ok');

for (const sel of ['button:has-text("Start Journey")', 'button:has-text("Start Over")',
                   'button:has-text("开启旅程")', 'button:has-text("继续旅程")', 'button:has-text("重新开始")']) {
  const b = page.locator(sel).first();
  if (await b.count()) { await b.click().catch(() => {}); console.log('clicked start'); break; }
}
await page.waitForTimeout(1000);
for (const sel of ['button:has-text("Start Riding")', 'button:has-text("开启旅程")']) {
  const b = page.locator(sel).first();
  if (await b.count()) { await b.click().catch(() => {}); break; }
}
await page.waitForTimeout(9000);
console.log('riding');

// ---- screencast ----
const cdp = await ctx.newCDPSession(page);
const stamps = [];
let n = 0;
cdp.on('Page.screencastFrame', async (f) => {
  try { cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch {}
  const name = `f${String(n++).padStart(5, '0')}.jpg`;
  fs.writeFileSync(path.join(OUT, name), Buffer.from(f.data, 'base64'));
  stamps.push({ name, t: Date.now(), v: lastVehicle, c: lastCam });
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });

await page.keyboard.down('w');

let prev = null, heading = 0, held = null, laps = 0, lastNorm = null;
let lastVehicle = 0, lastCam = 0;
let vehicleFlip = Date.now(), camFlip = Date.now();
const t0 = Date.now();

const setKey = async (k) => {
  if (held === k) return;
  if (held) await page.keyboard.up(held).catch(() => {});
  held = k;
  if (k) await page.keyboard.down(k).catch(() => {});
};

while ((Date.now() - t0) / 1000 < RIDE_SECONDS) {
  const b = await page.evaluate(() => {
    const g = window.gift188;
    return g ? { x: g.bike.x, z: g.bike.z } : null;
  }).catch(() => null);
  if (!b) { await page.waitForTimeout(45); continue; }

  if (prev) {
    const dx = b.x - prev.x, dz = b.z - prev.z;
    if (Math.hypot(dx, dz) > 1e-4) {
      const h = Math.atan2(dz, dx);
      heading = heading + wrap(h - heading) * 0.25;
    }
  }
  prev = { x: b.x, z: b.z };

  const here = arcAt(b.x, b.z);
  const target = pointAtArc(here.arc - LOOKAHEAD);
  const want = Math.atan2(target.z - b.z, target.x - b.x);
  const err = wrap(want - heading);
  const off = here.dist;
  let cmd = null;
  if (err > 0.06 || off > 3.0) cmd = 'd';
  else if (err < -0.06 || off > 3.0) cmd = 'a';
  await setKey(cmd);

  const norm = here.arc / 1228.82;
  if (lastNorm !== null && lastNorm > 0.75 && norm < 0.25) { laps++; console.log(`  lap ${laps} @ ${Math.round((Date.now() - t0) / 1000)}s`); }
  lastNorm = norm;

  // 轮换载具与视角，让片子里有内容变化
  if (Date.now() - vehicleFlip > 30000) {
    vehicleFlip = Date.now();
    lastVehicle = (lastVehicle + 1) % 4;
    await page.keyboard.press('e').catch(() => {});
    console.log(`  vehicle -> ${lastVehicle}`);
  }
  if (Date.now() - camFlip > 15000) {
    camFlip = Date.now();
    lastCam = (lastCam + 1) % 3;
    await page.keyboard.press('v').catch(() => {});
  }

  await page.waitForTimeout(45);
}

await setKey(null);
await page.keyboard.up('w').catch(() => {});
await cdp.send('Page.stopScreencast').catch(() => {});
await browser.close();

fs.writeFileSync(path.join(OUT, 'stamps.json'), JSON.stringify(stamps), 'utf8');
const span = stamps.length > 1 ? (stamps[stamps.length - 1].t - stamps[0].t) / 1000 : 0;
console.log(`frames: ${stamps.length}  span: ${span.toFixed(1)}s  avg fps: ${(stamps.length / span).toFixed(1)}`);
