// 快速对照：同一段路，分别在 first 机位下拍「徒步」与「自行车」，
// 看看角色模型会不会挡住画面。短拍即可，用来选 v2 用哪种。
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { arcAt, pointAtArc } from './route-geom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'shots', 'fptest');
fs.mkdirSync(OUT, { recursive: true });

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--hide-scrollbars', '--mute-audio'],
});
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'en-US' })).newPage();

await page.goto('http://127.0.0.1:4173/?tier=2&touch=0', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => {
  const b = document.getElementById('boot');
  return !b || getComputedStyle(b).opacity === '0' || b.offsetParent === null;
}, { timeout: 180000 });

for (const sel of ['button:has-text("Start Journey")', 'button:has-text("Start Over")', 'button:has-text("开启旅程")']) {
  const b = page.locator(sel).first();
  if (await b.count()) { await b.click().catch(() => {}); break; }
}
await page.waitForTimeout(1000);
for (const sel of ['button:has-text("Start Riding")', 'button:has-text("开启旅程")']) {
  const b = page.locator(sel).first();
  if (await b.count()) { await b.click().catch(() => {}); break; }
}
await page.waitForTimeout(9000);

// first 机位
await page.keyboard.press('v'); await page.waitForTimeout(400);
await page.keyboard.press('v'); await page.waitForTimeout(600);

async function ride(sec, tag) {
  await page.keyboard.down('w');
  let prev = null, heading = 0, held = null;
  const t0 = Date.now();
  const setKey = async (k) => {
    if (held === k) return;
    if (held) await page.keyboard.up(held).catch(() => {});
    held = k; if (k) await page.keyboard.down(k).catch(() => {});
  };
  let shot = 0;
  while ((Date.now() - t0) / 1000 < sec) {
    const b = await page.evaluate(() => {
      const g = window.gift188; return g ? { x: g.bike.x, z: g.bike.z } : null;
    }).catch(() => null);
    if (!b) { await page.waitForTimeout(45); continue; }
    if (prev) {
      const dx = b.x - prev.x, dz = b.z - prev.z;
      if (Math.hypot(dx, dz) > 1e-4) heading = heading + wrap(Math.atan2(dz, dx) - heading) * 0.25;
    }
    prev = { x: b.x, z: b.z };
    const here = arcAt(b.x, b.z);
    const t = pointAtArc(here.arc - 13);
    const err = wrap(Math.atan2(t.z - b.z, t.x - b.x) - heading);
    let cmd = null;
    if (err > 0.05 || here.dist > 2.5) cmd = 'd';
    else if (err < -0.05 || here.dist > 2.5) cmd = 'a';
    await setKey(cmd);
    if (shot < 3) { await page.screenshot({ path: path.join(OUT, `${tag}-${shot}.jpg`), type: 'jpeg', quality: 90 }); shot++; }
    await page.waitForTimeout(300);
  }
  await setKey(null);
  await page.keyboard.up('w').catch(() => {});
  await page.waitForTimeout(500);
}

console.log('--- on foot, first cam ---');
await ride(14, 'foot');

console.log('--- switch to bicycle (E) ---');
await page.keyboard.press('e');
await page.waitForTimeout(1200);
const mode = await page.evaluate(() => document.body.innerText.match(/Walking|Bicycle|Motorcycle|Skate|徒步|自行车/g)?.slice(0, 3) || 'n/a');
console.log('mode hint:', JSON.stringify(mode));
await ride(14, 'bike');

await browser.close();
console.log('frames:', fs.readdirSync(OUT).join(' '));
