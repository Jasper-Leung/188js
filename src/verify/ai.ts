/**
 * AI 可游玩接口一族 —— **契约不许悄悄变**。
 *
 * ## 这一族守的是什么
 *
 * 一份给外部（尤其是给 AI）用的接口，最坏的失败方式不是报错，而是
 * **接口还在、语义变了**：动作集少了一个、某个动作按了没反应、
 * 观测里某个字段开始说谎。外部调用者不会看提交记录，
 * 他们只会以为"这个游戏不太听话"。
 *
 * 所以这里守三件事：
 *
 * 1. **动作集不许少一个。** 键位表是这份契约的正面，
 *    少一个动作等于少一个动词，而"少了"永远不会被 `typeof` 抓到。
 * 2. **接线不许断。** `live.ts` 挂在宿主上、`window.__gift188` 真的被装上、
 *    `ai-play.mjs` 真的挂在 `package.json` 上——
 *    **这三样里任何一样断了，接口都是"文档上有、实际上没有"。**
 * 3. **语义不许漂。** 油门符号、HUD 与 AI 算出的方向箭头、
 *    「此刻能按什么」和真实相位闸门是否对得上。
 *
 * ## 关于第 3 条里那个箭头
 *
 * `arrowGlyph()` 从 `hud.ts` 搬到了 `game/api/types.ts`，
 * 就是为了让两边**共用同一份**。搬完之后这里就有条件断言
 * 「HUD 用的那个和接口导出的那个是同一个函数」——
 * 而这不是同义反复：以后谁在 `hud.ts` 里手写一份新的，这一条立刻红。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, stripComments, type CheckFn } from './harness';
import {
  AI_HELD_ACTIONS,
  AI_KEYS,
  AI_TAP_ACTIONS,
  ARROWS,
  arrowGlyph,
  actionOfCode,
  actionVector,
  describeActions,
  summarize,
  AI_HELP,
  type AiAction,
  type AiTapAction,
} from '../game/api/types';
import { keyToVec } from '../core/stick';
import { HeadlessAdapter, headlessSession } from '../game/api/headless';
import { AiSession, runScriptSync } from '../game/api/session';
import { RIDE } from '../data/raw';
import { DEFAULT_LANG, setLang } from '../i18n';
import { PHASE_EDGES } from '../game/phase';

// 回归由 `npm run verify` 跑，cwd 就是仓库根。**不要**用 `__dirname`
// （单文件 ESM 里没有它）或 `import.meta.url` 反推——后者在 esbuild
// 打包之后指向的是临时目录，会把路径算到某个随机位置。
// 理由与 `entry.ts` 的 `verify_payload` 那条完全一样。
const ROOT = process.cwd();

/** 由 `entry.ts` 在原位调用一次，见文件头。 */
export function registerAiApiChecks(check: CheckFn): void {

  // ---------------------------------------------------------------- 动作集

  /**
   * 动作表是这份接口的正面。**少一个动作没有任何东西会报错**——
   * 调用方拿到的是 `undefined`，然后在很远的地方炸掉。
   */
  check('verify_ai_actions', () => {
    const probs: string[] = [];
    let asserts = 0;

    const expected: AiAction[] = [
      'throttle', 'brake', 'left', 'right',
      'checkIn', 'pause', 'camera', 'vehicle', 'relic', 'mute',
      'item1', 'item2', 'item3', 'item4', 'advance',
    ];
    asserts++;
    if (expected.length !== AI_HELD_ACTIONS.length + AI_TAP_ACTIONS.length) {
      probs.push(`held ${AI_HELD_ACTIONS.length} + tap ${AI_TAP_ACTIONS.length} ≠ 期望的 ${expected.length}`);
    }
    for (const a of expected) {
      asserts++;
      if (!AI_KEYS[a] || AI_KEYS[a].length === 0) probs.push(`动作「${a}」没有键位`);
    }
    asserts++;
    const extra = Object.keys(AI_KEYS).filter((k) => !expected.includes(k as AiAction));
    if (extra.length) probs.push(`动作表多出没登记的动作：${extra.join(' ')}`);

    // 反查表必须和正表自洽——它是给「按了某键想知道对应哪个动作」用的。
    // **不能对每个动作都要求往返相等**：`Space` 同时是 `checkIn` 和
    // `advance` 的键（它们在不同的相位生效），反查必然只给出其中一个。
    // 真正该守的是「反查出来的那个动作确实占着这个键」。
    asserts++;
    for (const a of expected) {
      const back = actionOfCode(AI_KEYS[a][0]);
      if (back === null || !AI_KEYS[back].includes(AI_KEYS[a][0])) {
        probs.push(`actionOfCode(${AI_KEYS[a][0]}) = ${back}，而该动作并不占着这个键`);
      }
    }
    asserts++;
    if (actionOfCode('KeyQ') !== null) probs.push('actionOfCode 对一个无关键返回了非 null');

    // 动作向量必须和 `keyToVec()` 一致。这不是同义重复：
    // 动作表是**手写**的，而键位映射是键盘那一族的，两边迟早会漂。
    asserts++;
    for (const a of AI_HELD_ACTIONS) {
      const viaAction = actionVector(a);
      const viaKey = keyToVec(AI_KEYS[a][0]);
      if (!viaKey || viaAction[0] !== viaKey[0] || viaAction[1] !== viaKey[1]) {
        probs.push(`动作「${a}」的方向是 [${viaAction}]，但 ${AI_KEYS[a][0]} 应为 [${viaKey}]`);
      }
    }
    // 油门必须是"上"，刹车必须是"下"——这一条单独钉，
    // 因为符号写反时车会**倒着开**而一切看起来仍然正常。
    asserts++;
    if (actionVector('throttle')[1] >= 0) probs.push('油门的方向不是"上"');
    asserts++;
    if (actionVector('brake')[1] <= 0) probs.push('刹车的方向不是"下"');

    return expect(probs.length === 0, probs.join('；') || `${expected.length} 个动作全有键位且方向自洽`, asserts);
  });

  // ---------------------------------------------------------------- 可用动作

  /**
   * 「此刻按了真的有反应」是这个接口**最有用**的一个字段，
   * 也是最容易悄悄说谎的一个：它由 `describeActions()` 算出来，
   * 而每一道闸门都得对得上宿主里真实存在的那条守卫。
   *
   * ## 这一族最重要的一条：**按真实界面状态逐相位问**
   *
   * 原来这里是 `describeActions({ ...base, phase })`，
   * 而 `base.panelOpen` 恒为 `false`——**那是一个在真实宿主里永远不出现的状态**：
   * 暂停时 `pause.root` 开着、商店开着时 `shop.root` 开着、合成开着时
   * `synthesis.root` 开着。于是三条断言全绿，而实机上
   * **9 个相位里有 3 个 `available` 是空集**（`paused` / `checkin` / `synthesis`），
   * AI 关不掉暂停、走不出商店、推不动结算过场。
   *
   * 教训和第九轮那次一模一样：**守卫必须用它要守的那个真实状态去问**。
   * 所以下面那张表逐条写明每个相位"真实地开着什么"，
   * 它就是 `ui/index.ts:aiScreen()` 的判定结果，不是猜的。
   */
  check('verify_ai_available', () => {
    const probs: string[] = [];
    let asserts = 0;
    const base = { canCheckIn: false, dialogueOpen: false, minigame: false, panelOpen: false };

    const roam = describeActions({ ...base, phase: 'roaming' });
    asserts++;
    if (!roam.includes('throttle')) probs.push('roaming 下没有油门');
    asserts++;
    if (!roam.includes('checkIn')) probs.push('roaming 下没有空格——而第八轮专门做过"没有站时按空格有一句回音"');
    asserts++;
    if (!roam.includes('pause')) probs.push('roaming 下没有暂停');

    // 面板压着的时候不该再给骑行键——按了没反应的动作列出来是有害的。
    const covered = describeActions({ ...base, phase: 'paused', panelOpen: true });
    asserts++;
    if (covered.includes('throttle')) probs.push('面板压着时仍列出了油门');
    asserts++;
    if (covered.length === 0) probs.push('暂停面板开着时一个动作都不给——玩家按 Esc 能继续，AI 不能');

    // 对白只给"推进"。
    const talking = describeActions({ ...base, phase: 'roaming', dialogueOpen: true });
    asserts++;
    if (talking.length !== 1 || talking[0] !== 'advance') {
      probs.push(`对白中可用动作是 [${talking}]，应只有 advance`);
    }

    // 小游戏期间宿主把键盘整体吃掉（`if (this.mg.isRunning) return`）。
    const mg = describeActions({ ...base, phase: 'roaming', minigame: true });
    asserts++;
    if (mg.includes('throttle')) probs.push('小游戏期间仍列出了骑行键');

    /**
     * 每个相位**真实**的界面状态。
     *
     * `panelOpen` 三列分别对应：`aiScreen()` 会不会报 true、
     * 「这一屏的出路是哪根键」，以及它为什么是那根。
     * ——这张表是本判据的地基，改它之前先去读 `main.ts` 的
     * Escape 分支与各面板的 `show()`。
     */
    const REAL: Record<string, { panelOpen: boolean; escape: AiAction }> = {
      // 标题/引导/结算：DOM 流程页，出路是那个被 focus 的按钮（wireKeyActivate + focus()）
      title:      { panelOpen: false, escape: 'advance' },
      onboarding: { panelOpen: false, escape: 'advance' },
      endcard:    { panelOpen: false, escape: 'advance' },
      // 合成开着 synthesis.root，出路同样是它自己那个被 focus 的按钮
      synthesis:  { panelOpen: true,  escape: 'advance' },
      // 商店与暂停：宿主 Escape 分支只认这两处
      paused:     { panelOpen: true,  escape: 'pause' },
      checkin:    { panelOpen: true,  escape: 'pause' },
      roaming:    { panelOpen: false, escape: 'pause' },
      minigame:   { panelOpen: false, escape: 'advance' },
    };

    for (const [phase, want] of Object.entries(REAL)) {
      const acts = describeActions({
        ...base,
        phase: phase as never,
        panelOpen: want.panelOpen,
        minigame: phase === 'minigame',
      });
      asserts++;
      if (acts.length === 0) probs.push(`相位「${phase}」在真实界面状态下没有任何可用动作，AI 会卡死`);
      asserts++;
      if (!acts.includes(want.escape)) {
        probs.push(`相位「${phase}」没有给出它的出路「${want.escape}」，实际是 [${acts}]`);
      }
      asserts++;
      if (phase !== 'roaming' && phase !== 'minigame' && acts.includes('throttle')) {
        probs.push(`相位「${phase}」不该有骑行键`);
      }
    }

    /**
     * 相位表里每一条边都要有一条能用的退出键。
     * **`boot` 排除在外**：那一刻还没有任何监听器挂上，
     * 那个窗口短到 AI 的第一次 `observe()` 不可能落在里面。
     */
    for (const edge of PHASE_EDGES) {
      const [from] = edge.split('>') as [string, string];
      if (from === 'boot') continue;
      const acts = describeActions({ ...base, phase: from as never, panelOpen: REAL[from]?.panelOpen ?? false });
      asserts++;
      if (acts.length === 0) probs.push(`相位边 ${edge} 的起点「${from}」没有任何可用动作`);
    }

    return expect(probs.length === 0, probs.join('；') || `${Object.keys(REAL).length} 个相位按真实界面状态都有出路`, asserts);
  });

  /**
   * `aiScreen()` 的"压着"清单**不许**把流程页算进去。
   *
   * 这是第十轮那个死锁的另一半，修在数据源而不是只修 `describeActions()`。
   *
   * 标题屏开着，意思是「这一屏就是标题屏」，不是「有一个面板压在世界上面」。
   * 早先把 `title.root` / `onboarding.root` / `endCard.root` 也算进 `panelOpen`，
   * 于是 `describeActions()` 那句「面板压着就什么都不给」抢先返回空集，
   * 而代码注释里恰好写着「一个在这里什么都不给的接口，会让 AI 站在标题页永远出不去」。
   *
   * 这里数的是**出现次数**且**先剥注释**：只写 `!/title\.root/.test(...)`
   * 的话，把那一行注释掉就照样绿——字符串还留在文件里。
   */
  check('verify_ai_screen_overlays', () => {
    const probs: string[] = [];
    let asserts = 0;

    const uiSrc = stripComments(readFileSync(join(ROOT, 'src/ui/index.ts'), 'utf8'));
    const start = uiSrc.indexOf('aiScreen():');
    asserts++;
    if (start < 0) {
      probs.push('ui/index.ts 里找不到 aiScreen()');
      return expect(false, probs.join('；'), asserts);
    }
    // 切到下一个方法为止。这段里出现什么，就是那张清单里有什么。
    const body = uiSrc.slice(start, uiSrc.indexOf('setShopOpen', start));

    for (const root of ['this.title.root', 'this.onboarding.root', 'this.endCard.root']) {
      asserts++;
      if (body.includes(root)) {
        probs.push(`aiScreen() 的压着清单里还有 ${root}——它会把流程页当成"有面板压着"而什么都不给`);
      }
    }
    // 反过来，这三块**必须**还在清单之外的那一半里被看见：
    // 商店/暂停/明信片/合成是真正"压在当前这一屏上面"的东西，少一个就会漏。
    for (const root of ['this.shop.root', 'this.pause.root', 'this.postcard.root', 'this.synthesis.root']) {
      asserts++;
      if (!body.includes(root)) probs.push(`aiScreen() 的压着清单里少了 ${root}——压在上面的面板会被漏掉`);
    }

    return expect(probs.length === 0, probs.join('；') || '流程页不算「压着」，四块真面板都算', asserts);
  });

  // ---------------------------------------------------------------- 两端一致

  /**
   * HUD 与 AI 必须算出**同一个方向箭头**。
   *
   * 这不是形式主义：箭头已经从 `hud.ts` 搬到契约层，
   * 而如果以后有人在 HUD 侧手写一份新的，玩家看到的和 AI 收到的
   * 就会不一样——AI 会朝着玩家在屏幕上**看不见**的方向骑，
   * 而症状长得像"AI 不会用导航"，几乎不可能被归因到箭头漂了。
   */
  check('verify_ai_arrow_shared', () => {
    const probs: string[] = [];
    let asserts = 0;

    const hudSrc = readFileSync(join(ROOT, 'src/ui/hud.ts'), 'utf8');
    asserts++;
    if (!/import\s*\{\s*arrowGlyph\s*\}\s*from\s*'\.\.\/game\/api\/types'/.test(hudSrc)) {
      probs.push('hud.ts 不再从契约层引入 arrowGlyph——它自己那份和接口那份已经不是一个函数了');
    }
    asserts++;
    if (/function\s+arrowGlyph/.test(hudSrc)) {
      probs.push('hud.ts 里还留着一个本地 arrowGlyph 定义');
    }

    // 八个方向各取一个点，钉住「相对车头」而不是罗盘北这个约定。
    const cases: [number, number][] = [
      [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
    ];
    for (const [dx, dz] of cases) {
      asserts++;
      const g = arrowGlyph(dx, dz, 0, -1);
      if (!ARROWS.includes(g as never)) probs.push(`(${dx},${dz}) 得到了非法的箭头「${g}」`);
    }
    asserts++;
    if (arrowGlyph(0, -1, 0, -1) !== ARROWS[0]) probs.push('正前方的箭头不是索引 0');
    asserts++;
    if (arrowGlyph(1, 0, 0, -1) !== ARROWS[2]) probs.push('正右方的箭头不是索引 2');

    return expect(probs.length === 0, probs.join('；') || `HUD 与接口共用一份箭头，${ARROWS.length} 向自洽`, asserts);
  });

  // ---------------------------------------------------------------- 接线

  /**
   * **接口必须真的被装上。**
   *
   * 这一条的写法有个坑：第八轮 `verify_after_checkin_route` 的接线断言
   * 第一版写成 `!/homeNextLine\(/`，而函数自己的定义就满足了它——
   * 把调用点删掉照样绿。所以这里**数出现次数**，不数"有没有提到"。
   */
  check('verify_ai_wiring', () => {
    const probs: string[] = [];
    let asserts = 0;

    const mainSrc = readFileSync(join(ROOT, 'src/main.ts'), 'utf8');
    // 数**出现次数**，不数"有没有提到"——第八轮 `verify_after_checkin_route`
    // 的接线断言第一版写成 `!/homeNextLine\(/`，而函数自己的定义就满足了它，
    // 把调用点删掉照样绿。
    //
    // 数的是 `installAiApi(`：定义（`private installAiApi() {`）+
    // 调用（`this.installAiApi();`）= 2。只剩 1 就是调用点被删了。
    // **不是数 `createLiveApi(`** —— 那个函数定义在 `live.ts`，
    // `main.ts` 里只会有一次调用，数它等于在数一个恒为 1 的东西。
    asserts++;
    const installCalls = (mainSrc.match(/installAiApi\(/g) ?? []).length;
    if (installCalls < 2) {
      probs.push(`main.ts 里 installAiApi( 出现 ${installCalls} 次，定义 + 调用至少要 2 次`);
    }
    asserts++;
    if (!/__gift188/.test(mainSrc)) probs.push('main.ts 没有把接口挂到 window.__gift188 上');
    asserts++;
    if (!/dispatchKey/.test(mainSrc)) probs.push('main.ts 没有实现 dispatchKey——动作送不进去');

    // 浏览器侧必须走**真的 KeyboardEvent**。这一条不能退化成"另一种实现也行"：
    // 七处键盘监听（宿主 / 对白 / 结算 / 明信片 / 小游戏 / 触屏 / HUD）
    // 只有走真事件才收得到，而漏掉一处的症状像"小游戏坏了"。
    asserts++;
    if (!/new KeyboardEvent\(/.test(mainSrc)) {
      probs.push('main.ts 不再合成 KeyboardEvent——动作可能绕开了游戏自己的键盘监听');
    }

    // CLI 必须挂在 package.json 上（AGENTS.md §2：tools/ 里不许留没人引用的脚本）。
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    asserts++;
    if (!pkg.scripts?.['ai:play']) probs.push('package.json 里没有 ai:play——tools/ai-play.mjs 会变成没人引用的脚本');
    asserts++;
    if (!readFileSync(join(ROOT, 'tools/ai-play.mjs'), 'utf8').includes('--help')) {
      probs.push('tools/ai-play.mjs 没有写用法（AGENTS.md §2 要求写清用法）');
    }
    asserts++;
    if (!AI_HELP.includes('window.__gift188')) probs.push('AI_HELP 里没有说浏览器那个入口在哪');

    // AI_HELP 必须把 `LiveApi` 上的东西**列全**，而且不许列已经不存在的。
    //
    // 它以前写的是"三个方法"然后列了五个，而 `frame()` / `releaseAll()` /
    // `summary()` / `on()` 一个都没提——其中 `frame()` 正是那段典型循环里
    // 唯一那句 `await`。照着帮助写策略的人会发现循环根本推不动，
    // 而帮助是**唯一**的说明书，源码他看不见。
    //
    // **只比"方法清单"那一段，不比整篇**：正文里随口提一句 `heldKeys()`
    // 不等于列了它——第一版的守卫就栽在这儿（我把清单里那行删掉，
    // 断言照样绿，因为正文里还留着同一个词）。
    asserts++;
    {
      const liveSrc = stripComments(readFileSync(join(ROOT, 'src/game/api/live.ts'), 'utf8'));
      const iface = liveSrc.match(/export interface LiveApi \{([\s\S]*?)\n\}/);
      const block = (AI_HELP.split('方法（全部挂在同一个对象上）：')[1] ?? '').split('\n\n')[0];
      asserts++;
      if (!iface) {
        probs.push('live.ts 里读不出 `export interface LiveApi` —— 这条判据需要改写法了');
      } else if (!block.trim()) {
        probs.push('AI_HELP 里读不出方法清单 —— 这条判据需要改写法了');
      } else {
        const members = [...iface[1].matchAll(/^\s{2}(?:readonly\s+)?([A-Za-z_]\w*)\s*[(:]/gm)].map((m) => m[1]);
        const listed = new Set([...block.matchAll(/^\s{2}([A-Za-z_]\w*)/gm)].map((m) => m[1]));
        for (const m of members) {
          asserts++;
          if (!listed.has(m)) probs.push(`LiveApi 上的「${m}」没有写进 AI_HELP 的方法清单`);
        }
        for (const m of listed) {
          asserts++;
          if (!members.includes(m)) probs.push(`AI_HELP 的方法清单列了「${m}」，而 LiveApi 上没有它`);
        }
      }
    }

    return expect(probs.length === 0, probs.join('；') || '三条路都接上了：浏览器 / 无头 CLI / 回归', asserts);
  });

  // ---------------------------------------------------------------- 无头能开

  /**
   * 无头这一侧必须**真的能开一辆车**——
   * 有了它，策略才能几千步几千步地跑，而不用等渲染。
   *
   * 这一族里只有这一条会构造 `Terrain` / `Road` / `Ride`，
   * 所以它也是唯一会替那三个类"值不值这个体积"投票的地方。
   */
  check('verify_ai_headless_runs', () => {
    const probs: string[] = [];
    let asserts = 0;

    const s = headlessSession();
    const first = s.observe();
    asserts++;
    if (first.phase !== 'roaming') probs.push(`无头会话的相位是 ${first.phase}`);
    asserts++;
    if (!first.available.includes('throttle')) probs.push('无头会话开出来没有油门');
    asserts++;
    if (!Number.isFinite(first.arc)) probs.push('弧长不是有限数');
    asserts++;
    if (typeof first.objective !== 'string' || first.objective.length === 0) {
      probs.push('目标句是空的');
    }

    // 油门必须真的让车动起来——**方向也要对**。
    // 只断言"速度变了"会让车倒着开也通过，而那看起来完全正常。
    asserts++;
    s.actSync('throttle', true);
    s.frameSync(60);
    asserts++;
    if (Math.abs(s.last().speed) < 0.5) probs.push('按住油门一秒，车没动');
    asserts++;
    if (s.last().speed < 0) {
      probs.push(`按住油门后速度是 ${s.last().speed.toFixed(2)}（负数 = 倒着开），应为正`);
    }
    asserts++;
    if (s.last().km <= first.km) probs.push('按住油门后公里数没涨');
    // 一秒满油必须正好是 `RIDE.ACCEL`——和 `verify_ride` 用同一个常量，
    // 而不是"看起来差不多"。差一点点说明有人改了一边没改另一边。
    asserts++;
    if (Math.abs(s.last().speed - RIDE.ACCEL) > 0.5) {
      probs.push(`一秒满油门是 ${s.last().speed.toFixed(2)} m/s，应为 ACCEL=${RIDE.ACCEL}`);
    }

    // 松手必须真的把车停下来——`releaseAll()` 漏了的话车会永远冲下去，
    // 而下一个使用者拿到的是一台"刹不住"的车。
    s.releaseAll();
    s.frameSync(240);
    asserts++;
    if (s.last().speed > 0.5) {
      probs.push(`松手四秒后还有 ${s.last().speed.toFixed(2)} m/s（刹不住）`);
    }

    // 极速不能超过常量。
    asserts++;
    if (s.last().maxSpeed !== RIDE.MAX_SPEED) {
      probs.push(`上报的极速 ${s.last().maxSpeed}，应为 RIDE.MAX_SPEED=${RIDE.MAX_SPEED}`);
    }

    // `summarize()` 是给人和 CLI 看的摘要，它必须**真的能拼出字符串**。
    asserts++;
    const line = summarize(s.last());
    if (!line.includes('km') || line.length < 10) probs.push(`摘要拼不出来：${line}`);

    // 上报的语言必须**跟着真的语言走**。
    //
    // 这一条守的是一个已经发生过的谎：观测里的显示用字符串一直有
    // （目标句、下一站名、对白），但"这是哪种语言"挂在一个没人调用的
    // `lang()` 上，而无头侧把它写死成 `'zh'`。中文环境下全绿，
    // 换成英文就全错——而因为没人读它，错了也没有任何症状。
    //
    // 所以断言只能写成"**翻一下就变**"：写死常量过不了这一条。
    const s2 = headlessSession();
    for (const want of ['en', 'zh'] as const) {
      setLang(want);
      s2.frameSync(1);
      asserts++;
      if (s2.last().lang !== want) {
        probs.push(`语言切到 ${want} 之后观测报的是 ${s2.last().lang}`);
      }
    }
    // 切回默认，别把回归后面的判据留在一个临时语言上。
    setLang(DEFAULT_LANG);
    s2.frameSync(1);

    // `onRoad` 和 `offRoad` 必须**永远一致**。
    //
    // 这两个数回答的是同一件事（"偏出去了没有 / 偏出去多远"），
    // 而它们以前是各自算的：`onRoad` 来自路面的高度查询，
    // `offRoad` 来自横向距离，于是同一帧里能同时出现
    // `onRoad: true` 和 `offRoad: 2.81`（实测 546/3000 帧）。
    // 症状对 AI 来说非常坏：它按 `onRoad` 决定不用减速，
    // 又按 `offRoad` 觉得已经偏得很远，于是来回摇摆。
    //
    // **必须真的开出去看**。原地站着两个数恒为 0，任何实现都能过；
    // 而只跑直路也不够——那样两个数永远是同一侧的 0/true。
    // 所以这里先直着开（沥青上，`onRoad=true` 那一侧），
    // 再打方向把车逼出路肩（`onRoad=false` 那一侧），两头都得验。
    asserts++;
    {
      const s3 = headlessSession();
      let contradiction = '';
      let wentOffRoad = false;
      s3.actSync('throttle', true);
      for (let i = 0; i < 2400 && !contradiction; i++) {
        if (i === 150) s3.actSync('right', true);
        if (i === 900) {
          s3.actSync('right', false);
          s3.actSync('left', true);
        }
        s3.frameSync(1);
        const o = s3.last();
        if (!o.onRoad) wentOffRoad = true;
        if (o.onRoad === o.offRoad > 0) {
          contradiction = `第 ${i} 帧 onRoad=${o.onRoad} 但 offRoad=${o.offRoad.toFixed(2)}m`;
        }
      }
      s3.releaseAll();
      if (contradiction) probs.push(`离路两个数自相矛盾：${contradiction}`);
      asserts++;
      // 车要真的偏出去过，否则这一整段只验了「一直在路上」那一种情况。
      if (!wentOffRoad) probs.push('开了 40 秒都没偏出路肩，这一段没验到 `onRoad=false` 那一侧');
    }

    return expect(
      probs.length === 0,
      probs.join('；') || '无头会话开得动、刹得住、方向对、离路只有一个真相',
      asserts,
    );
  });

  /**
   * 九个相位逐个问一遍：**AI 在每一屏都真的走得出去吗**。
   *
   * 这条族里上一张 `REAL` 表问的是 `describeActions()` 这个**函数**，
   * 而这里问的是**真会话**——把同一辆车推进那一屏，
   * 然后照着 `available` 里的出路真按一下，看它接不接。
   *
   * 区别是实质的：契约说"这一屏能按 pause 出去"，
   * 和会话真的接受这一次 `tap('pause')`，是两件事。
   * 第十轮那个死锁在前者上是绿的、在实机上是死的；
   * 而当时无头这一侧**根本问不出来**——
   * `snapshot()` 把 `phase` / `panelOpen` / `minigame` 全写死成
   * "什么都没有"，于是无头回归一辈子只看得见 `roaming` 那一种相位。
   * 现在这些状态可以注入了（`setScreen()`），这一族才真的闭上了。
   */
  check('verify_ai_phase_gates', () => {
    const probs: string[] = [];
    let asserts = 0;

    /** 与 `verify_ai_available` 里那张 REAL 表同源：真实界面状态 + 该屏的出路。 */
    const REAL: Record<string, { screen: Parameters<HeadlessAdapter['setScreen']>[0]; escape: AiTapAction }> = {
      title:      { screen: { phase: 'title' },                                          escape: 'advance' },
      onboarding: { screen: { phase: 'onboarding' },                                     escape: 'advance' },
      endcard:    { screen: { phase: 'endcard' },                                        escape: 'advance' },
      synthesis:  { screen: { phase: 'synthesis', panelOpen: true },                     escape: 'advance' },
      paused:     { screen: { phase: 'paused', panelOpen: true },                        escape: 'pause' },
      checkin:    { screen: { phase: 'checkin', panelOpen: true },                       escape: 'pause' },
      roaming:    { screen: { phase: 'roaming' },                                        escape: 'pause' },
      minigame:   { screen: { phase: 'minigame', minigame: true },                       escape: 'advance' },
      // 对白压着骑行：出路只剩推进，而推进必须真的被接受。
      dialogue:   { screen: { phase: 'roaming', dialogueOpen: true, dialogueText: '……' }, escape: 'advance' },
    };

    for (const [name, want] of Object.entries(REAL)) {
      const a = new HeadlessAdapter();
      a.setScreen(want.screen);
      const s = new AiSession(a);
      const o = s.observe();

      asserts++;
      if (o.phase !== want.screen.phase) {
        probs.push(`注入 ${name} 之后观测报的相位是 ${o.phase}`);
      }
      asserts++;
      if (o.available.length === 0) {
        probs.push(`相位「${name}」的 available 是空集——AI 在这一屏一步也走不了`);
        continue;
      }
      asserts++;
      if (!o.available.includes(want.escape)) {
        probs.push(`相位「${name}」没有给出出路「${want.escape}」，实际是 [${o.available}]`);
      }
      // **真按一下**。契约列了而会话拒绝，是同一类谎的另一种长相。
      const r = s.tapSync(want.escape);
      asserts++;
      if (!r.accepted) {
        probs.push(`相位「${name}」列出了「${want.escape}」，真按下去却被拒：${r.reason}`);
      }
      s.releaseAll();
    }

    // 复位必须真的复位：上一个用例留下的临时相位会毒化后面所有判据。
    asserts++;
    {
      const a = new HeadlessAdapter();
      a.setScreen({ phase: 'paused', panelOpen: true });
      a.resetScreen();
      const o = new AiSession(a).observe();
      if (o.phase !== 'roaming' || o.panelOpen || o.available.includes('pause') === false) {
        probs.push(`resetScreen() 之后仍在 ${o.phase} / panelOpen=${o.panelOpen}`);
      }
    }

    return expect(probs.length === 0, probs.join('；') || `${Object.keys(REAL).length} 屏真会话都走得出去`, asserts);
  });

  /**
   * 脚本跑完**必须把车停下**。
   *
   * `runScript()` 的 `finally` 里那一句 `releaseAll()` 就是这件事的全部。
   * 漏掉它的症状非常具体：CLI 跑完退出没事，
   * 但**下一个**在同一进程里开会话的人拿到一台全速冲刺的车。
   */
  check('verify_ai_script_releases', () => {
    const probs: string[] = [];
    let asserts = 0;

    const s = headlessSession();
    const r = runScriptSync(s, [
      { hold: 'throttle', seconds: 1 },
      { hold: 'right', seconds: 0.5 },
      { hold: 'throttle', seconds: 1 },
    ]);
    asserts++;
    if (r.observations.length < 3) probs.push('脚本只留下了不到 3 个采样点');
    asserts++;
    if (s.heldKeys().length !== 0) {
      probs.push(`脚本跑完还按着 ${s.heldKeys().join(' ')}`);
    }
    // 事件必须是"发生过"的一次性记录，而不是重复快照。
    asserts++;
    if (!Array.isArray(r.events)) probs.push('runScript 没有返回事件数组');
    asserts++;
    const again = s.drain();
    asserts++;
    if (again.length !== 0) probs.push(`事件被 drain 了两次，第二次还有 ${again.length} 条（取走即清失效了）`);

    return expect(probs.length === 0, probs.join('；') || '脚本跑完松手，事件取走即清', asserts);
  });
}
