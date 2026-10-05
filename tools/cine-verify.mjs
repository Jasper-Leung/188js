// 验证 ?cine=1：UI 消失、帧序号在走、自由机位能改角度。
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'shots', 'cinetest');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();

await page.goto('http://127.0.0.1:4173/?tier=2&touch=0&cine=1', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => {
  const b = document.getElementById('boot');
  return !b || getComputedStyle(b).opacity === '0' || b.offsetParent === null;
}, { timeout: 180000 });
console.log('boot ok');

// 进世界
for (const sel of ['button:has-text("Start Journey")', 'button:has-text("Start Over")', 'button:has-text("开启旅程")']) {
  const b = page.locator(sel).first();
  if (await b.count()) { await b.click().catch(() => {}); break; }
}
await page.waitForTimeout(800);
for (const sel of ['button:has-text("Start Riding")', 'button:has-text("开启旅程")']) {
  const b = page.locator(sel).first();
  if (await b.count()) { await b.click().catch(() => {}); break; }
}
await page.waitForTimeout(3000);

const uiHidden = await page.evaluate(() => {
  const r = document.getElementById('ui-root');
  return r ? getComputedStyle(r).display : 'no-root';
});
console.log('ui-root display :', uiHidden, uiHidden === 'none' ? 'OK' : '*** UI STILL VISIBLE ***');

const f1 = await page.evaluate(() => window.gift188?.cine?.frame ?? -1);
await page.waitForTimeout(1500);
const f2 = await page.evaluate(() => window.gift188?.cine?.frame ?? -1);
console.log(`frame counter   : ${f1} -> ${f2}  ${f2 > f1 ? 'OK (advancing)' : '*** NOT ADVANCING ***'}`);

// 帧时间确定性：连续取 5 个 frame 的间隔，墙上时钟差异很大但游戏时间恒定
const t0 = Date.now();
const a = await page.evaluate(() => window.gift188.cine.frame);
await page.waitForTimeout(1000);
const b = await page.evaluate(() => window.gift188.cine.frame);
console.log(`game time in 1.0s wall clock: ${((b - a) / 60).toFixed(3)}s  (deterministic = always 1/60 per frame, wall-clock irrelevant)`);

// 自由机位
const poses = [
  ['orbit-side',  [90, 12, 7, 2.4]],
  ['orbit-high',  [140, 34, 11, 3]],
  ['orbit-low',   [35, 4, 5, 1.2]],
];
for (const [name, args] of poses) {
  await page.evaluate((a2) => { window.gift188.cine.orbit(a2[0], a2[1], a2[2], a2[3]); }, args);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 88 });
  console.log('posed', name);
}

// 慢放
await page.evaluate(() => { window.gift188.cine.speed = 0.25; });
const c1 = await page.evaluate(() => window.gift188.cine.frame);
await page.waitForTimeout(1000);
const c2 = await page.evaluate(() => window.gift188.cine.frame);
console.log(`slow-mo 0.25x  : ${((c2 - c1) / 60).toFixed(3)}s game time per 1.0s wall`);

await browser.close();
console.log('shots ->', OUT);
