#!/usr/bin/env node
/**
 * AI 可游玩接口的**无头命令行**。
 *
 * ## 用法
 *
 *   npm run ai:play                      开一场，默认 30 秒巡航
 *   npm run ai:play -- --seconds 60      跑 60 秒
 *   npm run ai:play -- --follow          自己跟着路骑 30 秒（闭环，出「在路上的帧占比」）
 *   npm run ai:play -- --follow 90       跟路骑 90 秒
 *
 * ⚠ **秒数只写一次 `--follow`。** 重复写（`--follow --follow 90`）
 * 是过去 `AGENTS.md` §6 里的写法，它会**静默跑成 30 秒**——
 * 参数解析见 `tools/argv-flag.mjs`，那里记了这件事的完整经过。
 * 现在 `flag()` 取的是**最后一个** `--follow`，所以三种写法等价，
 * 但文档只教一种。
 *   npm run ai:play -- --jsonl           每帧一行 JSON（给程序读）
 *   npm run ai:play -- --script 巡航     跑内置脚本之一
 *   npm run ai:play -- --list            列出内置脚本
 *   npm run ai:play -- --help            完整帮助（= AI_HELP）
 *
 * ## 它是什么，不是什么
 *
 * **是**：一个不碰 WebGL 的真会话。车会真的加速、真的离路、真的降速，
 * 天数与旅币走的是 `GameStateManager` 里那一套真的代码。
 * 适合跑策略对比、扫参数、回归一批动作序列——几千步只要几秒。
 *
 * **不是**完整的一局：打卡过场、对白、五个小游戏、商店、结算页
 * 都要 DOM 与画布，这里一个都没有。
 * **要玩完整的请用浏览器那个**：`window.__gift188`，见 `src/game/api/live.ts`。
 *
 * ## 为什么它挂在 package.json 上
 *
 * `AGENTS.md` §2 明确禁止往 `tools/` 里塞没人引用的脚本。
 * 这一条同时满足那三个条件：挂在 scripts 上、写清用法、
 * 并且有 `src/verify/ai.ts` 的判据兜着契约不漂。
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flag as flagOf, followSecondsFrom } from './argv-flag.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** 内置脚本：都是"人话里说得清"的一串动作，不是玄学。 */
const SCRIPTS = {
  /** 一路巡航，不打方向。看它能跑多远、有没有掉出路面。 */
  cruise: [{ hold: 'throttle', seconds: 10 }, { wait: 2 }],
  /** 故意打满舵，看离路判定和降速是不是真的发生。 */
  offroad: [
    { hold: 'throttle', seconds: 3 },
    { hold: 'right', seconds: 2 },
    { hold: 'throttle', seconds: 4 },
    { wait: 2 },
  ],
  /** 油门刹车交替：量加速与减速这两个数，顺带验证松手没漏。 */
  accel: [
    { hold: 'throttle', seconds: 2 },
    { hold: 'brake', seconds: 2 },
    { hold: 'throttle', seconds: 2 },
    { hold: 'brake', seconds: 2 },
  ],
  /** 只点不按：一个动作都没做，世界应当完全不动。 */
  idle: [{ wait: 3 }],
};

async function main() {
  const argv = process.argv.slice(2);
  // 解析规则住在 `tools/argv-flag.mjs`（取**最后一个** `--name`），
  // 这里只是把 argv 绑上去，调用点一个都不用改。
  const flag = (name, dflt = null) => flagOf(argv, name, dflt);
  if (argv.includes('--list')) {
    console.log('内置脚本：' + Object.keys(SCRIPTS).join('  '));
    return;
  }

  // ---- 把 TS 打成单文件 ESM，在 Node 里跑 ----
  // 和 `tools/verify-all.mjs` 同一套做法：three **不能**标成 external
  // （它不走 WebGL，只用向量/矩阵/Object3D，在 Node 里能跑）。
  const out = mkdtempSync(join(tmpdir(), 'gift188-ai-'));
  try {
    const entry = join(out, 'entry.mjs');
    await build({
      entryPoints: [resolve(root, 'src/game/api/cli-entry.ts')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      outfile: entry,
      loader: { '.json': 'json' },
      logLevel: 'silent',
    });
    const mod = await import(`file://${entry}?t=${Date.now()}`);

    const jsonl = argv.includes('--jsonl');
    // **只在显式传了 `--script` 时才走脚本分支。**
    // 原来这里给的是 `flag('script', 'cruise')`——默认值非空，于是
    // 下面那个 `if` 恒真，`--seconds` 那条分支成了死代码：
    // `npm run ai:play -- --seconds 8` 跑出来的其实是内置的 cruise 脚本，
    // 而且它**看起来还挺合理**，所以这个 bug 能安静地活很久。
    const scriptName = argv.includes('--script') ? flag('script') : null;
    const seconds = Number(flag('seconds', 30));

    // --follow：自己跟着路走。它不是第五个「脚本」——脚本是动作序列，
    // 这一条是**闭环**：每帧读观测、算方向、再落回键码。
    // 跑它的理由和 `verify_ride` 一样：**「好不好骑」要是个数，不是手感。**
    if (argv.includes('--follow')) {
      // 秒数怎么来的（`--follow 90` 高于 `--seconds 90`，都拿不到就回落 30）
      // 住在 `tools/argv-flag.mjs`，因为 `[DOC]` 那道门要拿**真函数**
      // 去跑 `AGENTS.md` §6 里的示例行。
      const r = mod.followRoad(followSecondsFrom(argv));
      reportFollow(r, jsonl);
      return;
    }

    if (scriptName && SCRIPTS[scriptName]) {
      const s = mod.headlessSession();
      const r = await mod.runScript(s, SCRIPTS[scriptName]);
      report(r.observations, r.events, jsonl);
      return;
    }

    // 默认：开一辆车，按住油门 seconds 秒，沿途每 0.5 秒打一次点。
    const s = mod.headlessSession();
    const obs = [];
    const all = [];
    obs.push(s.observe());
    await s.act('throttle', true);
    try {
      const steps = Math.round(seconds * 60);
      for (let i = 0; i < steps; i++) {
        await s.frame();
        if (i % 30 === 0) obs.push(s.observe());
      }
      all.push(...s.drain());
    } finally {
      s.releaseAll();
    }
    obs.push(s.observe());
    report(obs, all, jsonl);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function report(observations, events, jsonl) {
  if (jsonl) {
    for (const o of observations) {
      process.stdout.write(JSON.stringify(o) + '\n');
    }
    for (const e of events) {
      process.stdout.write(JSON.stringify({ event: e }) + '\n');
    }
    return;
  }
  const first = observations[0];
  const last = observations[observations.length - 1];
  console.log('=== 无头会话 ===');
  console.log(`起始  ${first ? describe(first) : '（无）'}`);
  console.log(`结束  ${last ? describe(last) : '（无）'}`);
  console.log(`帧数  ${observations.length} 个采样点`);
  if (events.length) {
    console.log('事件：');
    for (const e of events.slice(0, 20)) {
      console.log(`  t=${e.t.toFixed(2)}s  ${e.kind}${e.detail !== undefined ? `  ${e.detail}` : ''}`);
    }
    if (events.length > 20) console.log(`  …还有 ${events.length - 20} 条`);
  } else {
    console.log('事件：（无）');
  }
  console.log('');
  console.log('⚠ 这一侧没有 DOM：打卡 / 对白 / 小游戏 / 商店 / 结算页都跑不了。');
  console.log('  要玩完整的请在浏览器里用 window.__gift188（见 src/game/api/live.ts）。');
}

function describe(o) {
  const nav = o.nextDistance >= 0 ? ` → ${o.nextName} ${o.nextArrow} ${o.nextDistance}m` : '';
  const road = o.onRoad ? '' : ` 离路 ${o.offRoad.toFixed(1)}m`;
  return (
    `第${o.day}天(剩${o.daysLeft})  ${o.km.toFixed(3)}km  ` +
    `${(o.speed * 3.6).toFixed(1)}km/h${road}  旅币${o.coins} 心神${o.mood} ` +
    `碎片${o.fragmentsGot}/5${nav}\n        目标：${o.objective}\n` +
    `        可用动作：${o.available.join(' ') || '（无）'}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * `--follow` 的报告。**`onRoadRatio` 是这一屏要看的那一个数**，
 * 其余是解释它用的。
 *
 * 它量的仍然只是**路面与转向**这一层：控制器是 `demoAim`/`demoInput`，
 * 逐帧 60Hz、有预瞄。真人两样都没有，所以这个数是**上限**，
 * 别拿它当「这游戏好上手」的证据（见 `headless.ts` 里 `followRoad` 的注释）。
 */
function reportFollow(r, jsonl) {
  if (jsonl) {
    process.stdout.write(JSON.stringify({ follow: r }) + '\n');
    return;
  }
  console.log('=== 跟路骑行 ===');
  console.log(
    `  ${r.seconds}s / ${r.frames} 帧   里程 ${r.km.toFixed(3)}km   ` +
      `速度 ${r.minSpeed.toFixed(1)}–${r.maxSpeed.toFixed(1)} m/s（均 ${r.avgSpeed.toFixed(1)}）`,
  );
  console.log(
    `  在路面上的帧 ${((r.onRoadRatio) * 100).toFixed(1)}%   ` +
      `离路 ${r.offRoadFrames} 帧   最远偏出中心线 ${r.worstLateral.toFixed(2)}m`,
  );
  console.log('');
  console.log('  注：控制器逐帧 60Hz 且有预瞄，这是「路面与转向」的**上限**，不是手感。');
}
