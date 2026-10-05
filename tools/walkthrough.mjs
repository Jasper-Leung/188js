// Walkthrough 录制：带玩家走进这个世界。
//
// 与空镜 B Roll 的区别：
//   · **UI 保留**（`ui=1`）—— 玩家得看见 HUD、打卡提示、碎片计数
//   · **相机交给游戏**（`cam=game`）—— 第一视角，跟着人走
//
// ## 四个踩过的坑（每一个都让"录一小时"变成废片）
//
// 1. **`--mute-audio` 会让 `audio.unlock()` 永不返回。**
//    `startRide()` 第一句就是 `await audio.unlock()`，于是 phase 卡在
//    'title'，车一动不动，脚本却照样往下走。加
//    `--autoplay-policy=no-user-gesture-required`、**去掉** `--mute-audio`。
//
// 2. **`window.gift188` 在 cine 模式下曾经是启动那一刻的快照。**
//    `installCineMode` 把上一个 getter 的返回值存了下来，于是
//    `bike.x/z/speed/heading/phase` 全是开机值。车真的在动，
//    而录制脚本读到的是"车没动"。已修（存 getter 而不是它的返回值）。
//
// 3. **航向约定搞错 90° 不会报错。**
//    `ride.ts` 的 `_fwd = (-sin h, -cos h)`，所以由前向反解航向是
//    `h = atan2(-dx, -dz)`；而 `heading += -steer * k`，于是
//    **err>0 按 a、err<0 按 d**。这两个符号由 `tools/wt-probe.mjs` 实测钉住，
//    不要靠改代码里的算式去"推"。
//
// 4. **瞄准点必须往前。** `pointAtArc(arc - 13)` 瞄的是身后 13m。
//
// 用法：先 `npm run preview`，再 `node tools/walkthrough.mjs`
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { arcAt, arcDelta, pointAtArc, TOTAL_LENGTH } from './route-geom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, '..', 'shots', 'walkthrough');
const OUT = path.join(HERE, '..', 'promo', 'footage');
fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f), { force: true });

const FPS = 60;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const LOOK = 13;          // 前视距离（米）
// 一整圈 1228.8m。按实测 ~9 m/s 算要 136s，加标题/序章/打卡，
// 预算给到 21000 帧（350s）——卡住了宁可提前收尾，也不要录到空转。
const MAX_FRAMES = 21000;
const LAP_TARGET = TOTAL_LENGTH - 20;   // 回到起点前 20m 收尾

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  args: [
    '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    // 见坑 1：不要 --mute-audio，它让 audio.unlock() 不返回
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

await page.goto('http://127.0.0.1:4173/?tier=2&touch=0&cine=1&ui=1&cam=game',
  { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => {
  const b = document.getElementById('boot');
  return !b || getComputedStyle(b).opacity === '0' || b.offsetParent === null;
}, { timeout: 180000 });

let idx = 0;
const log = (...a) => console.log('  ', ...a);
const state = () => page.evaluate(() => {
  const g = window.gift188;
  if (!g || !g.bike) return null;
  return { x: g.bike.x, z: g.bike.z, heading: g.bike.heading, speed: g.bike.speed,
           off: g.bike.offCenterline, near: g.nearby, phase: g.phase, input: g.input };
});
/** 16 座驿站的落位。用来「把车骑到驿站跟前」——见 debugHandle 里的说明。 */
const stations = () => page.evaluate(() => window.gift188.stations);
const step = () => page.evaluate(() => window.gift188.cine.step());
const manual = (v) => page.evaluate((on) => { window.gift188.cine.manual = on; }, v);

/**
 * 推进一帧并截图。**每张截图严格对应一次 stepOnce**。
 *
 * `WT_FAST=1` 时只推进不截图：整圈 21000 帧存成 jpg 要十几分钟，
 * 而「能不能跑满一圈」这个问题在 1 秒一帧的纯逻辑下几十秒就能回答。
 * 验证用，正式录才截。
 */
const FAST = process.env.WT_FAST === '1';
const stepShot = async () => {
  await step();
  if (FAST) { idx++; return null; }
  const name = `w${String(idx++).padStart(5, '0')}.jpg`;
  await page.screenshot({ path: path.join(DIR, name), type: 'jpeg', quality: 92 });
  if (idx % 600 === 0) log(`  ...${idx} frames (${(idx / FPS).toFixed(0)}s)`);
  return name;
};
const hold = async (sec) => { for (let i = 0; i < Math.round(sec * FPS); i++) await stepShot(); };

/** 等到世界真的允许推油门（序章结束、打卡过场没在跑）。 */
const waitRidable = async (label, maxSec = 60) => {
  for (let i = 0; i < maxSec * 2; i++) {
    const s = await state();
    if (s?.input?.canRide) return true;
    await manual(false); await page.waitForTimeout(500); await manual(true);
  }
  log(`  [${label}] TIMEOUT waiting for canRide: ${JSON.stringify((await state())?.input)}`);
  return false;
};

/**
 * 连按 ESC 直到回到能骑的状态。
 *
 * 打卡是**两段**：`checkin`（镜头过场）→ `minigame`（小游戏）。
 * 一次 ESC 只从过场进到小游戏，看起来像"ESC 没用"。
 */
const exitToRoaming = async (maxTries = 8) => {
  for (let i = 0; i < maxTries; i++) {
    const s = await state();
    if (s?.phase === 'roaming' && s?.input?.canRide) return true;
    await manual(false);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1200);
  }
  return false;
};

const clickVisible = async (label, sels) => {
  for (const sel of sels) {
    const b = page.locator(sel).first();
    if (!(await b.count())) continue;
    if (!(await b.isVisible().catch(() => false))) continue;
    try {
      await b.click({ timeout: 8000 });
      const seen = [];
      for (let i = 0; i < 40; i++) {
        const p = (await state())?.phase;
        if (seen[seen.length - 1] !== p) seen.push(p);
        if (p && p !== 'title') break;
        await page.waitForTimeout(500);
      }
      log(`  [${label}] ${sel} -> phase ${JSON.stringify(seen)}`);
      return true;
    } catch (e) {
      log(`  [${label}] click failed ${sel}: ${String(e).split('\n')[0]}`);
    }
  }
  return false;
};

// ---------- 1. 标题页 ----------
log('title');
await page.waitForTimeout(4000);
await manual(true);
await hold(3);

// ---------- 2. 进世界 ----------
if (!(await clickVisible('title', ['button:has-text("Start Journey")', 'button:has-text("开启旅程")']))) {
  console.error('!! 没能从标题页进游戏，中止。');
  await browser.close();
  process.exit(1);
}
await manual(true);
await hold(2.5);
if (!(await clickVisible('onboarding', ['button:has-text("Start Riding")', 'button:has-text("开始骑行")']))) {
  console.error('!! 没能从引导页进世界，中止。');
  await browser.close();
  process.exit(1);
}

// ---------- 3. 序章（rAF 自己在走，文字卡要时间） ----------
log('prologue');
await manual(false);
await page.waitForTimeout(2000);
await manual(true);
await hold(2);
await waitRidable('prologue');
await hold(2);

// ---------- 4. 第一视角 ----------
await manual(false);
await page.keyboard.press('v'); await page.waitForTimeout(300);
await page.keyboard.press('v'); await page.waitForTimeout(600);
await manual(true);
log('first person');
await hold(1.5);

// ---------- 5. 骑完整整一圈 ----------
//
// 三个和「只骑到第一个站」版本不同的地方：
//
// · **弧长靠航位推算**（见 `ride()` 的注释）——
//   `arcAt` 只看最近距离，在自交点上会给出相差 610m 的另一个弧长；
//   而「限制在上一帧弧长附近找」又太黏，车开出去几米就粘回起点、里程不走。
//   沿切线一小步一小步推才是稳的。
//
// · **用累计里程判断跑完没**，而不是看当前弧长 ——
//   跑满一圈后弧长会绕回 0，光看 `here.arc` 永远到不了终点。
//
// · **中途打卡不打断里程**：打卡过场那段（几十秒）车是停着的，
//   但它是"走这一圈"的一部分，里程要接着算。
const STATIONS = await stations();
const fragments = STATIONS.filter((s) => s.hasFragment);
log(`fragment posts: ${fragments.map((s) => `#${s.i}`).join(' ')}`);

let held = null;
const setKey = async (k) => {
  if (held === k) return;
  if (held) await page.keyboard.up(held).catch(() => {});
  held = k;
  if (k) await page.keyboard.down(k).catch(() => {});
};

/**
 * 沿中心线骑。`done(state, here)` 返回 true 就停。里程累加在 `travelled` 上。
 *
 * ## 弧长怎么跟：航位推算，不是「最近点」
 *
 * `arcAt(x,z)` 只看最近距离，在自交点上会给出相差 610m 的另一个弧长。
 * 但「限制在 prevArc 附近找」更糟：**它是粘的**——车开出去几米后，
 * 起点那批采样点仍然在 20m 内、且弧长比别处更接近 prevArc，于是永远赢，
 * 弧长钉在 0 不动，车只会绕着起点打转（实测 `travelled 0m`）。
 *
 * 正解是**沿切线做航位推算**：每帧只挪 `位移 · 切向`（一步 ~0.1m），
 * 单调、不可能跳支。再每隔一段用全局最近点**缓慢**校正漂移，
 * 但只在两者足够接近时才校正（接近 = 不在自交点上）。
 */
const ride = async (label, done, { seekPost = null } = {}) => {
  await manual(false);
  await page.keyboard.down('w');
  await manual(true);
  let iter = 0;
  let hit = false;
  const sinceReport = { frames: 0 };
  while (iter < MAX_FRAMES && idx < MAX_FRAMES) {
    iter++;
    const b = await state();
    if (!b) return 'null-handle';

    // ---- 弧长：沿切线推一小步 ----
    const pa = pointAtArc(arc);
    const pb = pointAtArc(arc + 1);
    let tx = pb.x - pa.x, tz = pb.z - pa.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    const step = (b.x - lastPos.x) * tx + (b.z - lastPos.z) * tz;
    arc += Math.max(-3, Math.min(3, step));
    lastPos = { x: b.x, z: b.z };

    // 缓慢校正航位推算的漂移。**只在两者接近时校正**——
    // 差得远说明车跑到自交口另一支上去了，那正是不能信的场合。
    if (iter % 60 === 0) {
      const g = arcAt(b.x, b.z).arc;
      const d = arcDelta(g, arc);
      if (Math.abs(d) < 15) arc += d * 0.25;
    }
    travelled += Math.abs(step) < 3 ? step : 0;   // 只累计合理的前进量

    const here = { arc, dist: arcAt(b.x, b.z).dist };

    // 瞄准点：默认前视 LOOK 米；seekPost 且进了 40m 就改瞄**驿站本身**
    //（驿站横向偏出路面 ~18m，只沿中心线骑永远够不着 `reach`）
    let t = pointAtArc(arc + LOOK);
    let dToPost = Infinity;
    if (seekPost) {
      dToPost = Math.hypot(seekPost.x - b.x, seekPost.z - b.z);
      if (dToPost < 40) t = { x: seekPost.x, z: seekPost.z };
    }
    // 约定 fwd = (-sin h, -cos h)  =>  h = atan2(-dx, -dz)
    const err = wrap(Math.atan2(-(t.x - b.x), -(t.z - b.z)) - b.heading);
    // 航向要**变大**才抵消正的 err；实测按 a 让 heading 变大
    const cmd = err > 0.05 ? 'a' : err < -0.05 ? 'd' : null;
    await setKey(cmd);

    const n = b.near;
    if (n && n.hasFragment) minNear = Math.min(minNear, n.distance);

    if (done(b, here)) { hit = true; break; }
    await stepShot();

    sinceReport.frames++;
    if (sinceReport.frames >= (iter < 24 ? 15 : 300)) {
      sinceReport.frames = 0;
      log(`  ...${(idx / FPS).toFixed(0)}s | travelled ${travelled.toFixed(0)}/${LAP_TARGET.toFixed(0)}m` +
        ` arc ${here.arc.toFixed(1)}m off ${here.dist.toFixed(1)}m v ${b.speed.toFixed(1)}m/s` +
        ` hdg ${b.heading.toFixed(2)} err ${err.toFixed(2)} key=${cmd ?? '-'}` +
        (seekPost ? ` post ${dToPost.toFixed(0)}m` : ''));
    }
  }
  await setKey(null);
  await page.keyboard.up('w').catch(() => {});
  why = hit ? label : 'budget';
  return why;
};

let arc = 0, travelled = 0, minNear = Infinity;
let lastPos = { x: 0, z: 0 };
let why = 'budget', checkedIn = false;

// 把车放到起点弧长，并且**按道路走向**给航向。
//
// 为什么必须这么做：`world` 是在驿站 0 旁 `ride.spawn(near.x, near.z, 0)` 起的步，
// heading=0 意味着「车头朝 -Z」——而这条路的走向在这里是 **+Z**。
// 也就是**车是倒着停的**，要转 159° 才顺路。
//
// 不处理的话控制器为了掉头会一直满舵，而满舵半径 ~19m 大于前视距离 13m，
// 于是它根本转不过来：**原地画圆，弧长永远停在 37m，一圈都骑不完**（实测）。
// 这个 bug 从头到尾不报错，只表现为「车在绕圈」。
const START_ARC = 0;
{
  const p = pointAtArc(START_ARC);
  const q = pointAtArc(START_ARC + 5);
  const roadHeading = Math.atan2(-(q.x - p.x), -(q.z - p.z));
  await manual(false);
  await page.evaluate(([x, z, h]) => window.gift188.cine.goto(x, z, h), [p.x, p.z, roadHeading]);
  await page.waitForTimeout(800);
  await manual(true);
  const chk = await state();
  log(`placed at arc ${START_ARC}m (${p.x.toFixed(1)}, ${p.z.toFixed(1)}), heading ${roadHeading.toFixed(2)} rad` +
    `  [game reported arc ${arcAt(chk.x, chk.z).arc.toFixed(1)}m]`);
  arc = START_ARC;
  lastPos = { x: chk.x, z: chk.z };
  travelled = 0;
}

// 5a. 先骑到第一座碎片站
const first = fragments
  .map((s) => ({ s, arc: arcAt(s.x, s.z).arc }))
  .map((o) => ({ ...o, ahead: ((o.arc - START_ARC) % TOTAL_LENGTH + TOTAL_LENGTH) % TOTAL_LENGTH }))
  .sort((a, b2) => a.ahead - b2.ahead)[0];
log(`first post on the way: #${first.s.i} at arc ${first.arc.toFixed(0)}m (${first.ahead.toFixed(0)}m from start)`);

const atPost = (b) => {
  const n = b.near;
  if (n && n.hasFragment && n.distance <= (n.reach ?? 15)) {
    log(`  arrived at post #${n.index}: ${n.distance.toFixed(1)}m <= reach ${n.reach ?? 15}m`);
    return true;
  }
  return false;
};
// 只在真的还没打卡时才把「到站」当终点，免得路过别站就停
const r1 = await ride('arrived', (b) => atPost(b), { seekPost: first.s });
if (r1 !== 'arrived') {
  log(`  no check-in this run (${r1}), closest approach ${minNear.toFixed(1)}m`);
}

// ---------- 6. 打卡 + 小游戏 ----------
if (r1 === 'arrived') {
  checkedIn = true;
  await manual(true);
  await hold(2.5);
  await manual(false);
  await page.keyboard.press('Space');
  await page.waitForTimeout(1200);
  log(`  after Space -> phase ${(await state())?.phase}`);
  await manual(true);
  await hold(6);
  // 五件乐事的提示里都写了 "ESC 放弃"，但 **一次 ESC 不够**：
  // 打卡过场（phase=checkin）和小游戏（phase=minigame）是两段，
  // 第一下 ESC 只是从过场进到小游戏。所以循环按到真的能骑为止。
  const ok = await exitToRoaming();
  log(`  exit to roaming -> ${ok ? 'ok' : 'FAILED'} phase=${(await state())?.phase}`);
  await manual(true);
  await hold(3);
}

// ---------- 7. 骑完剩下的圈 ----------
// 先确认车真的动得了：上一版在这里盲骑 12 秒，而那时 phase 还卡在
// 小游戏里、canRide 为假 —— 结尾是 12 秒静止画面，录像机却照样报"骑完了"。
const pre = await state();
if (pre?.input?.canRide) {
  // 打卡过场里车停着，但里程不能算丢：`arc` 与 `lastPos` 原样保留，
  // 恢复骑行后第一步的切线推算会自动接上（车没动，投影为 0，里程不受影响）。
  const r2 = await ride('lap-done', () => travelled >= LAP_TARGET);
  const end = await state();
  log(`lap: ${(idx / FPS).toFixed(0)}s, travelled ${travelled.toFixed(0)}m / ${LAP_TARGET.toFixed(0)}m (${r2})`);
  if (end) log(`  ended at (${end.x}, ${end.z})`);
} else {
  log(`  rest of lap SKIPPED (phase=${pre.phase}, canRide=${pre.input?.canRide})`);
}
log(`travelled total ${travelled.toFixed(0)}m / ${LAP_TARGET.toFixed(0)}m, minNear ${minNear.toFixed(1)}m, exit=${why}`);

await hold(3);
await browser.close();

const N = idx;
const list = path.join(DIR, 'list.txt');
const mp4 = path.join(OUT, '07-walkthrough.mp4');
if (FAST) {
  console.log(`\nFAST run (no screenshots): ${N} frames = ${(N / FPS).toFixed(1)}s of game time`);
  console.log(`lap: ${travelled.toFixed(0)}m / ${LAP_TARGET.toFixed(0)}m (${why})`);
  console.log(`checked in: ${checkedIn} (closest ${minNear.toFixed(1)}m)`);
  await browser.close();
  process.exit(0);
}
fs.writeFileSync(list, Array.from({ length: N }, (_, i) => `file 'w${String(i).padStart(5, '0')}.jpg'`).join('\n'), 'utf8');
const { execFileSync } = await import('node:child_process');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'concat', '-safe', '0', '-r', String(FPS), '-i', list,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
  '-r', String(FPS), '-movflags', '+faststart', mp4], { cwd: DIR, stdio: 'inherit' });

console.log(`\nwalkthrough: ${N} frames = ${(N / FPS).toFixed(1)}s  ->  ${mp4}`);
console.log(`lap: ${travelled.toFixed(0)}m / ${LAP_TARGET.toFixed(0)}m (${why === 'lap-done' ? 'FULL LAP' : 'incomplete: ' + why})`);
console.log(`checked in: ${checkedIn} (closest ${minNear.toFixed(1)}m)`);