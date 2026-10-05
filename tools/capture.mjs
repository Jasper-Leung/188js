// 确定性录制器：用 ?cine=1，按**帧序号**截图，不按墙上时钟。
//
// 为什么这样录才不卡：
//   每张截图都对应恰好 1/60 秒的游戏时间，帧与帧之间的运动量完全相等。
//   机器慢只会让整个录制变慢放，**不会**出现重复帧/丢帧造成的顿挫。
//   录 1800 帧 = 正好 30 秒成片，编码 60fps 出来是绝对平滑的。
//
// 用法：
//   node tools/capture.mjs <名字> <帧数> [--shot=脚本JSON]
// 例：
//   node tools/capture.mjs road 1200
//   node tools/capture.mjs turn 900 --shot='[[0,{"follow":1}],[120,{"orbit":[120,18,8,2.5]}]]'
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'shots', 'cine');
fs.mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const name = args[0] || 'shot';
const FRAMES = Number(args[1] || 900);
// 机位表从**文件**读，不走命令行：PowerShell 会把内联 JSON 的引号吃掉
// （--shot='[[0,{"follow":1}]]' 传进来会变成 [[0,{\follow\:1}]]）。
const shotArg = args.find((a) => a.startsWith('--shots='));
const SHOTS = shotArg
  ? JSON.parse(fs.readFileSync(path.resolve(shotArg.slice('--shots='.length)), 'utf8'))
  : [];

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--hide-scrollbars', '--mute-audio', '--force-device-scale-factor=1',
    // 录制时不要让浏览器自己"省"，掉帧会直接变成画面里的一次停顿
    '--disable-frame-rate-limit', '--disable-gpu-vsync',
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 160)));

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

const runShot = async (o) => {
  await page.evaluate((o2) => {
    const c = window.gift188.cine;
    if (o2.follow) c.follow();
    if (o2.orbit) c.orbit(o2.orbit[0], o2.orbit[1], o2.orbit[2], o2.orbit[3]);
    if (o2.pose) c.pose(...o2.pose);
    if (o2.speed !== undefined) c.speed = o2.speed;
    if (o2.freeze) c.freeze();
    if (o2.play) c.play();
  }, o);
};

let si = 0;
for (let f = 0; f < FRAMES; f++) {
  // 到点就切机位/速度
  while (si < SHOTS.length && SHOTS[si][0] <= f) { await runShot(SHOTS[si][1]); si++; }
  // 等到**第 f 帧**被真正渲染出来，再截
  await page.waitForFunction((target) => (window.gift188.cine?.frame ?? -1) > target, f, { timeout: 10000 });
  await page.screenshot({
    path: path.join(OUT, `${name}-${String(f).padStart(5, '0')}.jpg`),
    type: 'jpeg', quality: 94,
  });
}
await browser.close();

// 交给 ffmpeg：按 60fps 顺序拼
const list = path.join(OUT, `${name}.txt`);
const lines = [];
for (let f = 0; f < FRAMES; f++) lines.push(`file '${name}-${String(f).padStart(5, '0')}.jpg'`);
fs.writeFileSync(list, lines.join('\n'), 'utf8');
console.log(`captured ${FRAMES} frames = ${(FRAMES / 60).toFixed(1)}s of game time -> ${list}`);
