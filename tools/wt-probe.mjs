// Walkthrough 转向控制器的**离线标定 + 高速试跑**。
//
// 为什么要它：原来 `walkthrough.mjs` 每帧都要截图（~1.1s/帧），
// 控制器把约定搞反了也只能等录完一小时才发现车在往回骑。
// 这里**不截图**，一次 CDP 往返只推进一帧，3000 帧一分钟内跑完——
// 于是「控制器对不对」变成一个可以在动手录之前就回答的问题。
//
// 它回答两件事：
//   1. **符号**：按住 A / D 各半秒，heading 各自怎么变。
//      约定是 `fwd = (-sin h, -cos h)`、`heading += -steer * k`，
//      推出来的结论必须被实测否证/证实，不能靠读代码定。
//   2. **能不能到**：从站前 45m 起步，修正后的控制器能不能把弧长
//      从 112m 推到站点附近，而不是越骑越远。
//
// 用法（需要 `npm run preview` 在 4173 上跑着）：
//   node tools/wt-probe.mjs          走标题页按钮（录标题/引导页时用这个）
//   node tools/wt-probe.mjs arc      走 ?arc= 自动化入口（跳过标题页）
//
// 为什么要 `arc` 这一条：`startRide()` 第一件事是 `await audio.unlock()`，
// 无头 + 静音下实测挂住不返回，phase 永远停在 'title' ——
// 点按钮是**有效的**，卡在它后面那句 await 上。
// `?arc=` 直接调 `enterWorld()`，绕开整条链路。
//
// ⚠️ `?arc=` 收的是**归一化参数 0..1**，不是米。
//    route-geom 的 `pointAtArc()` 收的是米。两个混用会传到环线另一头去。
import { chromium } from 'playwright-core';
import { arcAt, pointAtArc } from './route-geom.mjs';

const FPS = 60;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// 注意：模块顶层写 `const NOW = Date.now()` 只会求值**一次**，
// 于是后面所有 `NOW - t0` 恒为 0 —— 计时全部变成 0ms。
const now = () => Date.now();

const MODE = process.argv[2] === 'arc' ? 'arc' : 'ui';
const ARC_M = Number(process.argv[3] ?? 112);
// `?arc=` 收的是**归一化参数 0..1**，不是米。
const ARC_PARAM = ARC_M / 1228.8200;
const URL = MODE === 'arc'
  ? `http://127.0.0.1:4173/?tier=2&touch=0&cine=1&ui=1&cam=game&arc=${ARC_PARAM.toFixed(6)}`
  : 'http://127.0.0.1:4173/?tier=2&touch=0&cine=1&ui=1&cam=game';

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  args: [
    '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    // **不要 --mute-audio**：加上它 `audio.unlock()` 在无头下不返回，
    // `startRide()` 卡在第一句 await，phase 永远停在 'title'。
    // 录制不出声没关系，autoplay 这条才是解锁 AudioContext 的关键。
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
// **必须在应用代码跑之前**挂钩，否则 bindInput() 注册时就看不见了。
// 「按了没反应」有两种：事件没到 / 到了但被守卫挡掉。
// 记下每次 addEventListener 的 target 与调用栈，才能分清是哪一种。
await ctx.addInitScript(() => {
  window.__binds = [];
  const orig = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (type === 'keydown' || type === 'keyup' || type === 'blur') {
      let who = 'unknown';
      if (this === window) who = 'window';
      else if (this === document) who = 'document';
      else if (this && this.tagName) who = `${this.tagName}#${this.id || ''}`;
      window.__binds.push({
        who, type,
        capture: !!(opts === true || (opts && opts.capture)),
        stack: (new Error()).stack.split('\n').slice(1, 5).map((s) => s.trim()).join(' <- '),
      });
    }
    return orig.call(this, type, fn, opts);
  };
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}]`, m.text().slice(0, 200)); });

await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => {
  const b = document.getElementById('boot');
  return !b || getComputedStyle(b).opacity === '0' || b.offsetParent === null;
}, { timeout: 180000 });

const state = () => page.evaluate(() => {
  const g = window.gift188;
  if (!g || !g.bike) return null;
  return { x: g.bike.x, z: g.bike.z, heading: g.bike.heading, speed: g.bike.speed,
           off: g.bike.offCenterline, near: g.nearby, phase: g.phase, input: g.input };
});
const step = () => page.evaluate(() => window.gift188.cine.step());
const manual = (v) => page.evaluate((on) => { window.gift188.cine.manual = on; }, v);

// 标题 → 进世界。
//
// 原来这里是 `b.click().catch(() => {})`——**点击失败被静默吞掉**，
// 于是 phase 停在 'title'、车一直没动，而日志照样往下印
// "in world, prologue done"。一次失败要烧掉一小时录制才发现。
// 现在点击必须成功，否则直接把现场（按钮清单 + phase）打出来再退出。
const buttons = () => page.evaluate(() => Array.from(
  document.querySelectorAll('#ui-root button, .g-btn'),
  (b) => ({ text: (b.textContent || '').trim().slice(0, 40), vis: !!b.offsetParent }),
).filter((b) => b.text));

const clickStart = async (label) => {
  const inv = await buttons();
  const vis = inv.filter((b) => b.vis).map((b) => b.text);
  console.log(`  [${label}] visible buttons: ${JSON.stringify(vis)}`);
  // 按**文案**点，不按位置。文案走 i18n，两种语言都试。
  for (const sel of ['button:has-text("Start Journey")', 'button:has-text("开启旅程")',
                     'button:has-text("Start Riding")', 'button:has-text("开始骑行")']) {
    const b = page.locator(sel).first();
    if (!(await b.count())) continue;
    // 隐藏的按钮也在 DOM 里，count() 照样 >0。先按可见性筛掉，
    // 否则会对一个永远点不到的按钮白等 8 秒。
    if (!(await b.isVisible().catch(() => false))) {
      console.log(`  [${label}] skip (hidden): ${sel}`);
      continue;
    }
    try {
      await b.click({ timeout: 8000 });
      // 点击之后 phase 是**异步**才变的：`startRide()` 第一件事是
      // `await audio.unlock()`，无头 + 静音下这一步实测要好几秒。
      // 只读一次会读到旧值，看起来就像"点了没用"；等 1.5s 也不够。
      // 所以轮询到「离开 title」为止，给足 20 秒。
      const seen = [];
      for (let i = 0; i < 40; i++) {
        const p = (await state())?.phase;
        if (seen[seen.length - 1] !== p) seen.push(p);
        if (p && p !== 'title') break;
        await page.waitForTimeout(500);
      }
      console.log(`  [${label}] clicked ${sel} -> phase 变化: ${JSON.stringify(seen)}`);
      return seen[seen.length - 1] !== 'title';
    } catch (e) {
      // **不吞**：这正是上一版把一小时录制烧掉的原因
      console.log(`  [${label}] click FAILED on "${sel}": ${String(e).split('\n')[0]}`);
    }
  }
  return false;
};

if (MODE === 'ui') {
  await page.waitForTimeout(3000);
  if (!(await clickStart('title'))) {
    console.log('  !! 标题页没能点进去，放弃。phase=', (await state())?.phase);
    await browser.close();
    process.exit(1);
  }
  await page.waitForTimeout(1500);
  await clickStart('onboarding');
  await page.waitForTimeout(1200);
  const ph = (await state())?.phase;
  console.log(`  phase after start = ${ph}`);
  if (ph === 'title') {
    console.log('  !! 仍在标题页。phase 必须是 onboarding/roaming 才谈得上骑行。');
    await browser.close();
    process.exit(1);
  }
  // 序章文字卡自己按 2.4s 往前走，rAF 停着它不会动 —— 临时交还控制权
  await manual(false);
  await page.waitForTimeout(14000);
  await manual(true);
  console.log(`  phase after prologue = ${(await state())?.phase}`);
} else {
  // `?arc=` 已经在 boot 时调过 enterWorld()，序章同样要自己走完
  await page.waitForTimeout(2000);
  await manual(false);
  await page.waitForTimeout(14000);
  await manual(true);
  const s = await state();
  console.log(`  arc mode: phase=${s?.phase} arc=${arcAt(s.x, s.z).arc.toFixed(1)}m off=${s?.off}`);
}

await manual(false);
await page.keyboard.press('v'); await page.waitForTimeout(300);
await page.keyboard.press('v'); await page.waitForTimeout(500);
await manual(true);

const goArc = async (a, label) => {
  const p = pointAtArc(a);
  await manual(false);
  await page.evaluate((q) => window.gift188.cine.goto(q.x, q.z), p);
  await page.waitForTimeout(2000);
  await manual(true);
  const s = await state();
  console.log(`  placed at arc ${a}m${label ? ' — ' + label : ''} -> actual arc ${arcAt(s.x, s.z).arc.toFixed(1)}m, phase=${s.phase}`);
};

/**
 * 等到世界真的允许推油门。
 *
 * `canRide()` 有五个条件，`phase` 之外最会卡人的是 `narrativeBusy`
 * （序章对白还在播）和 `checkInStage`（打卡过场）。
 * 卡在这两个上面的症状**完全安静**：按 W 没反应、速度 0、没有任何报错。
 * 所以这里轮询到 `canRide` 为真，而不是 `waitForTimeout` 一个拍脑袋的数——
 * 原来固定等 14 秒，序章一改长就又变成"车不动的一小时录制"。
 */
const waitRidable = async (label, maxSec = 60) => {
  for (let i = 0; i < maxSec * 2; i++) {
    const s = await state();
    if (s?.input?.canRide) {
      console.log(`  [${label}] canRide OK (phase=${s.phase}, narrativeBusy=${s.input.narrativeBusy}, checkInStage=${s.input.checkInStage})`);
      return true;
    }
    if (i % 10 === 0) console.log(`  [${label}] waiting... phase=${s?.phase} busy=${s?.input?.narrativeBusy} stage=${s?.input?.checkInStage}`);
    await manual(false);
    await page.waitForTimeout(500);
    await manual(true);
  }
  const s = await state();
  console.log(`  [${label}] TIMEOUT waiting for canRide: ${JSON.stringify(s?.input)}`);
  return false;
};

console.log('\n=== 0. 世界允许骑行了吗 ===');
if (!(await waitRidable('boot'))) {
  await browser.close();
  process.exit(1);
}

console.log('\n=== 0b. 按键到底有没有进页面 ===');
await page.evaluate(() => {
  window.__keys = [];
  window.addEventListener('keydown', (e) => window.__keys.push(['down', e.code, e.repeat]), true);
  window.addEventListener('keyup', (e) => window.__keys.push(['up', e.code]), true);
});
await page.keyboard.down('w');
await page.waitForTimeout(400);
await page.keyboard.up('w');
await page.waitForTimeout(200);
console.log(`  activeElement = ${await page.evaluate(() => {
  const a = document.activeElement;
  return a ? `${a.tagName}#${a.id || ''}.${a.className || ''}` : 'null';
})}`);
console.log(`  页面收到的键盘事件: ${JSON.stringify(await page.evaluate(() => window.__keys))}`);

console.log('\n=== 0c. 实时(rAF)油门对照 ===');
await page.evaluate(() => {
  window.__blur = 0;
  window.addEventListener('blur', () => { window.__blur++; });
});
await manual(false);
await page.keyboard.down('w');
await page.waitForTimeout(1500);
const rt = await state();
console.log(`  实时按 w 1.5s -> speed=${rt.speed} pos=(${rt.x},${rt.z}) heading=${rt.heading}`);
console.log(`  input=${JSON.stringify(rt.input)}`);
console.log(`  blur 次数=${await page.evaluate(() => window.__blur)}`);
await page.keyboard.up('w');
await page.waitForTimeout(300);

console.log('\n=== 0d. window 上到底绑了哪些监听器 ===');
{
  const client = await ctx.newCDPSession(page);
  const { result } = await client.send('Runtime.evaluate', { expression: 'window' });
  const { listeners } = await client.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
  const kd = listeners.filter((l) => l.type === 'keydown' || l.type === 'keyup');
  console.log(`  window 上 keydown/keyup 监听器: ${kd.length} 个`);
  for (const l of kd) console.log(`    - ${l.type} capture=${l.useCapture} line=${l.lineNumber}:${l.columnNumber}`);
  const other = listeners.filter((l) => l.type === 'blur');
  console.log(`  window 上 blur 监听器: ${other.length} 个`);
  console.log(`  iframe 数: ${await page.evaluate(() => document.querySelectorAll('iframe').length)}`);
  const binds = await page.evaluate(() => window.__binds || []);
  const win = binds.filter((b) => b.who === 'window');
  const nonWin = binds.filter((b) => b.who !== 'window');
  console.log(`  启动期键盘/blur 监听: 共 ${binds.length} 个，其中 window 上 ${win.length} 个`);
  for (const b of win) console.log(`    - [window] ${b.type} capture=${b.capture}  ${b.stack.slice(0, 130)}`);
  console.log(`  非 window 上的 ${nonWin.length} 个（按 target 归类）: ${JSON.stringify(nonWin.reduce((a, b) => { a[`${b.who}/${b.type}`] = (a[`${b.who}/${b.type}`] || 0) + 1; return a; }, {}))}`);
}

console.log('\n=== 0e. 派发位置矩阵 ===');
{
  // 先装一支**自己的**冒泡监听器，和 App 的挂在同一个 window 上。
  // 它能收到而 App 收不到 => App 的监听器不在这个 window 上。
  await page.evaluate(() => {
    window.__bub = [];
    window.addEventListener('keydown', (e) => window.__bub.push(`bubble:${e.code}`));
    window.addEventListener('keydown', (e) => window.__bub.push(`capture:${e.code}`), true);
  });
  const before = (await state()).input.keyDownCount;
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true })));
  await page.waitForTimeout(250);
  const after = (await state()).input.keyDownCount;
  console.log(`  SYNTH window.dispatch -> own listeners saw: ${JSON.stringify(await page.evaluate(() => window.__bub))}`);
  console.log(`  SYNTH window.dispatch -> App keyDownCount ${before} -> ${after}`);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true })));
  await page.waitForTimeout(400);
  console.log(`  SYNTH window.dispatch Escape -> phase=${(await state()).phase} keyDownCount=${(await state()).input.keyDownCount}`);
  const s2 = await state();
  console.log(`  debugHandle appId=${s2.input.appId}`);
  console.log(`  handlers that fired, by instance: ${JSON.stringify(await page.evaluate(() => window.__keyAppIds || []))}`);
}

console.log('\n=== 1. 符号标定 ===');
// Escape 在 roaming 下会走 bindInput 的同一条路径并 pause()，
// phase 会变成 'paused' —— 这是「监听器到底绑上没有」零歧义的判据。
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true })));
await page.waitForTimeout(500);
const esc = await state();
console.log(`  合成 keydown(Escape) 后 phase=${esc.phase}  (roaming -> paused 才说明监听器在跑)`);
if (esc.phase === 'paused') {
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true })));
  await page.waitForTimeout(500);
  console.log(`  再合成一次 Escape -> phase=${(await state()).phase}`);
}

// 合成事件：绕开 CDP，单独验「W 能不能进 keys」
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true })));
const syn = await state();
console.log(`  合成 keydown(KeyW) 后 keysDown=${JSON.stringify(syn.input.keysDown)}`);
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true })));
console.log(`  合成 keyup(KeyW)   后 keysDown=${JSON.stringify((await state()).input.keysDown)}`);
await goArc(112, 'before the first fragment post');

// 油门 + 半秒满舵，量 heading 变化
const calibrate = async (key) => {
  await manual(false);
  await page.keyboard.down('w');
  for (let i = 0; i < 40; i++) { await manual(true); await step(); }
  const a = await state();
  console.log(`    按住 w 0.67s 后: speed=${a.speed} heading=${a.heading} pos=(${a.x},${a.z})`);
  const h0 = a.heading;
  await manual(false);
  await page.keyboard.down(key);
  for (let i = 0; i < 30; i++) { await manual(true); await step(); }
  const h1 = (await state()).heading;
  await manual(false);
  await page.keyboard.up(key).catch(() => {});
  for (let i = 0; i < 30; i++) { await manual(true); await step(); }
  return wrap(h1 - h0);
};
const dA = await calibrate('a');
const dD = await calibrate('d');
console.log(`  按住 a 半秒 -> heading ${(dA * 180 / Math.PI).toFixed(1)}°`);
console.log(`  按住 d 半秒 -> heading ${(dD * 180 / Math.PI).toFixed(1)}°`);

// heading 要**变大**才能抵消正的 err。实测哪个键让它变大，就用哪个。
const upKey = dA > dD ? 'a' : 'd';
const dnKey = dA > dD ? 'd' : 'a';
console.log(`  => err>0 用 '${upKey}', err<0 用 '${dnKey}'  (不是靠读代码定的，是量出来的)`);

console.log('\n=== 2. 计时 ===');
const t0 = now();
for (let i = 0; i < 200; i++) await step();
const tStep = now() - t0;
console.log(`  step(): ${(tStep / 200).toFixed(1)} ms/帧  ->  3000 帧约 ${(tStep / 200 * 3000 / 1000).toFixed(0)}s`);

const t1 = now();
await page.screenshot({ type: 'jpeg', quality: 92 });
const tShot = now() - t1;
console.log(`  screenshot(): ${tShot} ms/张  ->  3000 帧约 ${(tShot * 3000 / 1000).toFixed(0)}s`);
console.log(`  step+screenshot: ${((tStep / 200 + tShot) * 3000 / 1000 / 60).toFixed(1)} 分钟`);

console.log('\n=== 3. 修正后的控制器试跑 ===');
await goArc(112, 'restart before the first fragment post');
await manual(false);
await page.keyboard.down('w');

const LOOK = 13;
let held = null, iter = 0, checkedIn = false;
const setKey = async (k) => {
  if (held === k) return;
  if (held) await page.keyboard.up(held).catch(() => {});
  held = k;
  if (k) await page.keyboard.down(k).catch(() => {});
};

const MAX = 2600;
const samples = [];
while (iter < MAX) {
  iter++;
  const b = await state();
  if (!b) { console.log('  null handle'); break; }

  const here = arcAt(b.x, b.z);
  // **往前** 13m 取瞄准点（原来写的是 -13，瞄的是身后）
  const t = pointAtArc(here.arc + LOOK);
  // 航向约定 fwd = (-sin h, -cos h)  =>  h = atan2(-dx, -dz)
  const hTarget = Math.atan2(-(t.x - b.x), -(t.z - b.z));
  const err = wrap(hTarget - b.heading);

  // 离中心线太远时先纠偏，优先于朝向（这是它原来混在一起的那部分）
  let cmd = null;
  if (here.dist > 3) {
    // 目标直接指向前方最近中心线点，角度自然更大，纠偏更快
    const t2 = pointAtArc(here.arc + LOOK);
    cmd = Math.atan2(-(t2.x - b.x), -(t2.z - b.z)) - b.heading > 0 ? upKey : dnKey;
  }
  if (err > 0.05) cmd = upKey;
  else if (err < -0.05) cmd = dnKey;
  await setKey(cmd);

  if (iter % 100 === 0) samples.push(`iter ${iter}: arc ${here.arc.toFixed(0)}m off ${here.dist.toFixed(1)}m near ${b.near?.distance?.toFixed?.(0) ?? '?'}m`);
  if (samples.length && iter % 400 === 0) { console.log('  ' + samples.pop()); }

  const n = b.near;
  if (!checkedIn && n && n.hasFragment && n.distance < 11) {
    await setKey(null);
    await manual(false);
    await page.keyboard.up('w').catch(() => {});
    console.log(`  >> reached post #${n.index} at ${n.distance.toFixed(1)}m after ${iter} iters (arc ${here.arc.toFixed(0)}m)`);
    checkedIn = true;
    break;
  }
  await step();
}
for (const s of samples) console.log('  ' + s);
await setKey(null);
await page.keyboard.up('w').catch(() => {});
console.log(`\n  result: ${checkedIn ? 'OK' : 'DID NOT ARRVE'}, iters ${iter}`);

await browser.close();