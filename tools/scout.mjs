// 取景勘察：每个候选机位只拍**一张**，拼成接触印相。
// 先看再录 —— 录满 6 条再发现机位被树挡着，浪费的是几分钟不是几秒。
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pointAtArc, TOTAL_LENGTH } from './route-geom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'shots', 'scout');
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { force: true });

// 沿路的切向（决定"顺着路看"的方向）
const tangentAt = (a) => {
  const p = pointAtArc(a), q = pointAtArc(a + 16);
  const dx = q.x - p.x, dz = q.z - p.z, L = Math.hypot(dx, dz) || 1;
  return [dx / L, dz / L];
};

const CANDIDATES = [];

// A) 路面机位：站在路上，顺着路往前看（树离路 >=16m，所以路面上是干净的）
for (const a of [150, 300, 450, 600, 750, 900, 1050]) {
  const p = pointAtArc(a), [tx, tz] = tangentAt(a);
  CANDIDATES.push({
    tag: `road-${a}`,
    at: [p.x, p.z],
    cam: [p.x - tx * 10, 2.9, p.z - tz * 10],
    look: [p.x + tx * 70, 2.0, p.z + tz * 70],
  });
}

// B) 空中机位：树高 8~12m，相机抬到 26m 以上就不会插进树冠
for (const a of [0, 430, 900]) {
  const p = pointAtArc(a);
  CANDIDATES.push({
    tag: `air-${a}`,
    at: [p.x, p.z],
    cam: [p.x + 40, 32, p.z + 40],
    look: [p.x, 0, p.z],
  });
}

// C) 水边：basin 在 station 2 / 4 / 6（锚点下标 6/9/15，每锚点约 25.6m）
for (const [name, lm] of [['water-s2', 6], ['water-s4', 9], ['water-s6', 15]]) {
  const a = lm * 25.6;
  const p = pointAtArc(a), [tx, tz] = tangentAt(a);
  CANDIDATES.push({
    tag: name,
    at: [p.x, p.z],
    cam: [p.x - tx * 6, 2.4, p.z - tz * 6],
    look: [p.x + tx * 50, -1.5, p.z + tz * 50],
  });
}

// D) 老建筑正面：驿站离路 18m，机位放在路肩上、稍微离地，看建筑
const STA = [
  ['pavilion-a', 1], ['tea-b', 10], ['shrine', 6], ['lantern', 8],
];
for (const [name, stIdx] of STA) {
  const lm = [1, 4, 6, 9, 11, 12, 15, 18, 24, 27, 36, 39, 30, 42, 45, 47][stIdx];
  const a = lm * 25.6;
  const p = pointAtArc(a), [tx, tz] = tangentAt(a);
  CANDIDATES.push({
    tag: name,
    at: [p.x, p.z],
    cam: [p.x - tx * 8, 4.0, p.z - tz * 8],
    look: [p.x - tx * 18 + tz * 16, 2.0, p.z - tz * 18 - tx * 16],
  });
}

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--hide-scrollbars', '--mute-audio', '--force-device-scale-factor=1'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
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
await page.waitForTimeout(2000);
await page.evaluate(() => { window.gift188.cine.noCharacter = true; });

for (const c of CANDIDATES) {
  await page.evaluate((cc) => {
    window.gift188.cine.goto(cc.at[0], cc.at[1]);
    window.gift188.cine.pose(cc.cam[0], cc.cam[1], cc.cam[2], cc.look[0], cc.look[1], cc.look[2]);
  }, c);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(OUT, `${c.tag}.jpg`), type: 'jpeg', quality: 85 });
  console.log('  ', c.tag);
}
await browser.close();
console.log('->', OUT, `(${CANDIDATES.length} candidates)`);
