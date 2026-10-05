// 排版段逐帧截图。
// 不用 CDP screencast：它只跑到 ~12fps，文字动画会一顿一顿。
// 这里是纯 DOM（无 WebGL），page.screenshot 足够快。
//
// 关键：帧序号由**截图循环**直接写进 window.__lock.i，
// 再等两帧 rAF 让 render() 跑完。
// 早先让页面自己按 rAF 递增，结果它 60fps 跑得比截图快，
// 截到第 570 张时时钟已经走到 1470（= 49000ms，超出时间轴），
// 于是 render 找不到场景，满屏羊皮纸。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TYPO = path.join(HERE, '..', 'promo', 'typo');
const OUT = path.join(HERE, '..', 'shots', 'typo');
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { force: true });

const SCENES = (await import(pathToFileURL(path.join(TYPO, 'scenes.js')).href)).default;
const DURATION = Number(process.argv[2] || 43000);
const FPS = 30;
const TOTAL = Math.ceil((DURATION / 1000) * FPS);

// 占位符在注释里也出现过，必须 replaceAll，否则真的那处没被替换
const tpl = fs.readFileSync(path.join(TYPO, 'typo.template.html'), 'utf8');
const html = tpl
  .replaceAll('__DURATION__', String(DURATION))
  .replaceAll('__SCENES__', () => JSON.stringify(SCENES));
const page0 = path.join(TYPO, 'typo.render.html');
fs.writeFileSync(page0, html, 'utf8');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--hide-scrollbars', '--mute-audio', '--force-device-scale-factor=1'],
});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'en-US' });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

await page.goto(pathToFileURL(page0).href, { waitUntil: 'load', timeout: 30000 });
await page.evaluate(() => { window.__lock = { i: 0 }; });
await page.waitForTimeout(400);

const stamps = [];
for (let i = 0; i < TOTAL; i++) {
  // 写入帧号 -> 等两帧 rAF，确保 render 用的是新值
  await page.evaluate((k) => new Promise((res) => {
    window.__lock.i = k;
    requestAnimationFrame(() => requestAnimationFrame(() => res()));
  }), i);
  const name = `t${String(i).padStart(5, '0')}.jpg`;
  await page.screenshot({ path: path.join(OUT, name), type: 'jpeg', quality: 92 });
  stamps.push({ name, t: (i / FPS) * 1000 });
}
await browser.close();

fs.writeFileSync(path.join(OUT, 'stamps.json'), JSON.stringify(stamps), 'utf8');
console.log(`captured ${stamps.length} frames @ ${FPS}fps over ${DURATION / 1000}s`);

// 关键帧抽查
for (const ms of [3000, 14000, 16000, 17000, 19000, 25000, 30500, 37000, 41000]) {
  const idx = Math.min(Math.floor((ms / 1000) * FPS), stamps.length - 1);
  const p = path.join(OUT, stamps[idx].name);
  if (fs.existsSync(p)) fs.copyFileSync(p, path.join(OUT, `check-${ms}.jpg`));
}
console.log('checks written');
