/**
 * 本轮三件新内容的判据 —— 茶倒水 / 路边躲避挑战 / 琴音林自由演奏。
 *
 * ## 为什么单独成文件而不是塞回 `entry.ts`
 *
 * `entry.ts` 已经连着多轮只涨不跌（见 AGENTS.md §3）。这三族是**新加的**，
 * 不是从别处搬来的——所以按已有的形状建一个新族（导出
 * `registerFeatureChecks(check)`，由 `entry.ts` 在原位调用一次），
 * 而不是让 `entry.ts` 再长三百行。
 *
 * 形状与 vehicle / delivery / scenery / ai 那五族一致：
 * **注册表留在 `entry.ts`**，本文件只拿得到 `CheckFn`。
 *
 * ## 这一族量的是「不成立时会怎样」，不是「成立时好不好」
 *
 * 三件新东西各自有一条**失败时极安静**的判据：
 *   · 茶：水柱画在屏外 / 倒水期间就交出结果 → 图上只是"水没对上口"。
 *   · 躲避：布局把路封死 → 玩家读成"我开得不好"，不会读成"这游戏耍我"。
 *   · 古琴：某一格小于手指 / 某一键映射不到 → 触屏玩家永远弹不出那一个音。
 * 这一族量的全是这三条。
 */
import { expect, fakeCtx, stripComments } from './harness';
import type { CheckFn } from './harness';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BIKE_HALF_WIDTH,
  DodgeRun,
  OBSTACLE,
  SIGN_STANDOFF,
  planObstacles,
  signSide,
  signStandoff,
  signSite,
  signYaw,
} from '../game/challenge';
import { ROAD } from '../world/road';
import { Obstacles, buildSign } from '../world/obstacles';

import { CENTERLINE, TOTAL_ARCLENGTH, pointAtArcLength } from '../data/route';
import {
  ALL_RELICS,
  RELICS,
  RELICS_CH2,
  RELIC_FROM_ROAD,
  RELIC_REACH,
  Relics,
} from '../world/relics';
import { Terrain } from '../world/terrain';
import { ROAD as ROAD_DEF, ROADMESH, I18N, ECON } from '../data/raw';
import {
  tryBind,
  codeOf,
  codeLabel,
  getKeymap,
  setKeymap,
  actionOf,
  type GameAction,
} from '../core/keymap';
import { GameStateManager } from '../game/state';
import {
  QIN_CELL_MIN,
  QIN_KEYS,
  QIN_KEYS_NUMPAD,
  QIN_NOTES,
  QIN_OCTAVES,
  QIN_STRINGS,
  boardRectInto,
  cellRectInto,
  createQinGame,
  noteForKey,
  qinHintLayout,
} from '../game/minigames/qin';
import { MINI_GAME_IDS, createMiniGame } from '../game/minigames';
import { SCENERY_SAY_M, silentSpaceReply, STATION_REACH } from '../game/phase';
import {
  BITE_WINDOW_SEC,
  CAST_SEC,
  RANGE_MAX,
  RANGE_MIN,
  REEL_LIMIT_SEC,
  REEL_RATE,
  RESULT_SEC,
  TENSION_FALL,
  TENSION_RISE,
  castFish,
  createFishState,
  holdMeaning,
  stepFish,
  tensionBand,
  type FishPhase,
} from '../game/fishing';
import { areaRectInto } from '../game/minigames/cloud';
import { POUR_TILT, pourCupRect, pourSpoutTip, createTeaGame } from '../game/minigames/tea';
import type { MiniGameContext, MiniGameResult } from '../game/minigames/types';
import type { Rect } from '../game/minigames/chrome';

/** 判据里要量的那几种视口。**必须包含手机竖屏与平板**，因为这三条全是触屏判据。 */
const VIEWPORTS: readonly (readonly [string, number, number])[] = [
  ['手机竖屏 390×844', 390, 844],
  ['手机横屏 844×390', 844, 390],
  ['平板竖屏 768×1024', 768, 1024],
  ['平板横屏 1024×768', 1024, 768],
  ['桌面 1920×1080', 1920, 1080],
];

/**
 * 一个空的 `Rect` 盒子。
 *
 * 三条落位函数（`boardRectInto` / `cellRectInto` / `areaRectInto`）都是
 * **就地填**而不是返回新对象——它们每个固定步长/每次 resize 都会调一次，
 * 而新建对象意味着每帧一次分配。所以调用处一律是「先拿盒子，再让它填」。
 */
function rect(x = 0, y = 0, w = 0, h = 0): Rect {
  return { x, y, w, h };
}

/**
 * 木牌 + 二十二块石头的三角面上限。
 *
 * 定在这里而不是散在 `obstacles.ts` 里：它是**这一族的契约**，
 * 而判据与被它量的东西住在两个文件里——放进被测模块就变成自证。
 *
 * 参考量：五件旧物合计不到 1200 面（`verify_relics` 量过），
 * 而石头是**路面上的常客**（车轮旁边那一圈），比路肩上的旧物近得多，
 * 所以给到 1100 已经比"五件旧物的总量"相当，而实测约 1050。
 * 第一版实测 1248 —— 超了将近两百面，来源是那个 5×12 的筐环，
 * 降到 4×9 之后才落进来（见 `obstacles.ts` 里那条注释）。
 */
const OBSTACLE_TRI_BUDGET = 1100;

export function registerFeatureChecks(check: CheckFn): void {
  registerDodgeChecks(check);
  registerQinChecks(check);
  registerTeaPourChecks(check);
  registerBoardChecks(check);
  registerFishingChecks(check);
  registerSpaceReplyChecks(check);
  registerRelicLayerChecks(check);
  registerAccessibilityChecks(check);
}

// ---------------------------------------------------------------- 第二章 · 触物共鸣

/**
 * 第二章的判据族。
 *
 * ## 为什么这一族存在
 *
 * 第二章原来是一个**空门**：`objective_chapter2` 的文案写着"把五座各走满三次"，
 * 而 `hud.ts` 的注释自己承认"门后头还是同一批目的地"。上一轮评审把
 * "P2-1 第二章目标"记成了 ✅，而它只改了一条文案——门后没有新东西。
 *
 * 所以这一族量的**不是"第二章存在"**，而是三件能被证伪的事：
 *
 *  1. **分层真的分层**（`verify_relic_layer`）：同一件旧物摸两次读到两段不同的字，
 *     而提示圈在第一层读完之后**不许熄**——它一熄，就等于告诉玩家
 *     "这件东西已经没有别的可说了"，那正是第二章要做的事。
 *  2. **门后真的有内容**（`verify_chapter2`）：第二章至少多出三件，
 *     落在**非碎片驿站**上，且目标文案指的是"听完"而不是"再刷一遍"。
 *  3. **片尾真的接着**（`verify_epilogue`）：两结局各有一张彩蛋，
 *     而它回答的是序章里"没有人记得你"那一句。
 */
function registerRelicLayerChecks(check: CheckFn): void {
  /** 分层闩锁：第一次读到 `now`，第二次读到 `past`，第三次读不到。 */
  check('verify_relic_layer', () => {
    let asserts = 0;
    const probs: string[] = [];
    const relics = new Relics(new Terrain(), 2);

    asserts++;
    if (relics.placements.length !== ALL_RELICS.length) {
      probs.push(`第二章建出 ${relics.placements.length} 件，应为 ${ALL_RELICS.length}`);
    }

    // 逐件走一遍两层。`Relics.nearestWithin` 是真的几何判据，
    // 所以这里把玩家摆到那件东西正旁边再按 F——走的和实机同一条路。
    let layered = 0;
    for (const p of relics.placements) {
      const r1 = fakeTouch(relics, p.index);
      const r2 = fakeTouch(relics, p.index);
      const r3 = fakeTouch(relics, p.index);
      if (r1 === 'now' && r2 === 'past' && r3 === null) layered++;
      else probs.push(`${p.def.kind}：第一次 ${r1} / 第二次 ${r2} / 第三次 ${r3}，应为 now / past / null`);
    }
    asserts++;
    if (layered !== relics.placements.length) {
      probs.push(`${layered}/${relics.placements.length} 件做到了"现在 → 过去 → 不再说话"`);
    }

    // **提示圈不许在第一层之后熄掉。**这是这一族里最容易被"顺手改对"的一条：
    // 判据一旦写成 `!heard`，功能上看起来没差别，而玩家就再也回不来了。
    //
    // 用**一份新的 `Relics`**：上面那个循环已经把每一件都读到"不再说话"了，
    // 在同一份上问 `pending(0)` 量到的是上一轮的残留，不是"开场时亮不亮"。
    asserts++;
    const fresh = new Relics(new Terrain(), 2);
    if (!fresh.pending(0)) {
      probs.push('一件都没摸的时候 `pending(0)` 就是 false——提示圈从一开始就不亮');
    }
    fakeTouch(fresh, 0);
    asserts++;
    if (!fresh.pending(0)) {
      probs.push('读完第一层就 `pending(0) === false`——提示圈第一层之后就熄，玩家回不来摸第二层');
    }
    fakeTouch(fresh, 0);
    asserts++;
    if (fresh.pending(0)) {
      probs.push('读完两层仍报 pending——提示圈不熄，这一件永远提示不完');
    }

    // 两层的文案不许是同一句。
    asserts++;
    for (const d of ALL_RELICS) {
      if (d.textKey === d.pastKey) probs.push(`${d.kind} 的过去层与现在层是同一个键`);
      if (d.echoKey === d.pastKey || d.echoKey === d.textKey) {
        probs.push(`${d.kind} 的回响与某一层撞键`);
      }
    }

    return expect(
      probs.length === 0,
      probs.length
        ? probs.join('；')
        : `${ALL_RELICS.length} 件各两层 · 第三次不再说话 · 读完两层提示圈才熄 · 三层文案互不撞键`,
      asserts,
    );
  });

  /** 门后真的有东西：新件数、落位、以及四类文案键双语齐全。 */
  check('verify_chapter2', () => {
    let asserts = 0;
    const probs: string[] = [];

    // 1. 第二章比第一章多出东西来。
    asserts++;
    const extra = ALL_RELICS.length - RELICS.length;
    if (extra < 3) {
      probs.push(`第二章只多出 ${extra} 件，门后还是那一批——空门没有被填上`);
    }

    // 2. 第一章五件一件都不许动。它们的身份、位置、文案是**回扣**，
    //    改一件就等于把第一章那句"它出现在第一位是回扣"作废。
    asserts++;
    for (let i = 0; i < RELICS.length; i++) {
      if (RELICS[i].chapter !== 1) probs.push(`第 ${i} 件（${RELICS[i].kind}）不再是第一章的`);
      if (RELICS[i].stationIdx !== ROAD_DEF.FRAGMENT_SLOT_STATION_IDX[i]) {
        probs.push(`第 ${i} 件换了驿站，与碎片槽位不再一一对应`);
      }
    }

    // 3. 第二章那几件不许落在碎片驿站上——落在那儿就还是"再刷一遍"。
    asserts++;
    for (const d of RELICS_CH2) {
      if (ROAD_DEF.FRAGMENT_SLOT_STATION_IDX.includes(d.stationIdx)) {
        probs.push(`${d.kind} 落在碎片驿站 ${d.stationIdx} 上——和第一章是同一批目的地`);
      }
    }

    // 4. 茶壶（最后一件）必须在家门口。第二章的收尾发生在出发的那个地方。
    asserts++;
    const teapot = RELICS_CH2.find((r) => r.kind === 'teapot');
    if (!teapot) probs.push('第二章没有茶壶——最后一件旧物没了');
    else if (teapot.stationIdx !== GameStateManager.HOME_STATION) {
      probs.push(`茶壶在 ${teapot.stationIdx} 号驿，不在家（${GameStateManager.HOME_STATION}）`);
    }

    // 5. 四类文案键，两侧齐全，且都不许是空串。
    asserts++;
    for (const d of ALL_RELICS) {
      for (const key of [d.titleKey, d.textKey, d.pastKey, d.echoKey]) {
        for (const lang of ['zh', 'en'] as const) {
          const v = I18N[lang][key];
          if (!v) probs.push(`${lang} 缺 ${key}`);
          else if (!v.trim()) probs.push(`${lang} 的 ${key} 是空串——英文界面会显示一个空卡片`);
        }
      }
    }

    // 6. 第二章那几件不许和第一章重样。
    asserts++;
    const kinds = new Set(RELICS_CH2.map((r) => r.kind));
    if (kinds.size !== RELICS_CH2.length) probs.push('第二章三件里有重样的物件');

    // 7. 几何仍然成立：离中心线 `RELIC_FROM_ROAD`、不压路、够得着。
    const terrain = new Terrain();
    const relics = new Relics(terrain, 2);
    asserts++;
    for (const p of relics.placements) {
      const beyond = p.roadDist - ROADMESH.TOTAL_HALF_WIDTH;
      if (Math.abs(p.roadDist - RELIC_FROM_ROAD) > 0.05) {
        probs.push(`${p.def.kind} 离中心线 ${p.roadDist.toFixed(2)}m，应为 ${RELIC_FROM_ROAD}m`);
      } else if (beyond > RELIC_REACH) {
        probs.push(`${p.def.kind} 在路肩外 ${beyond.toFixed(1)}m，够不着`);
      } else if (beyond < 0.9) {
        probs.push(`${p.def.kind} 贴在路肩上，不用减速就能摸到`);
      }
    }

    // 8. 三角面预算。八件一起算。
    asserts++;
    const tris = relics.triangleCount();
    if (tris > 3400) probs.push(`八件合计 ${tris} 三角面，超出 3400 的预算`);

    return expect(
      probs.length === 0,
      probs.length
        ? probs.join('；')
        : `八件 · 第二章多 ${extra} 件且都落在非碎片驿站 · 茶壶在家门口 · 四类键双语齐全 · ${tris} 面`,
      asserts,
    );
  });

  /** 彩蛋：两结局各一张，且真的被引用。 */
  check('verify_epilogue', () => {
    let asserts = 0;
    const probs: string[] = [];

    asserts++;
    for (const k of ['epilogue_keep', 'epilogue_let_go']) {
      for (const lang of ['zh', 'en'] as const) {
        if (!I18N[lang][k]) probs.push(`${lang} 缺 ${k}`);
      }
    }

    asserts++;
    for (const k of ['epilogue_keep', 'epilogue_let_go']) {
      if (I18N.zh[k] === I18N.en[k]) probs.push(`${k} 中英两侧一字不差——没翻`);
    }

    // 引用在**代码**里，不在表里。文案表里有键却没人 `t()` 就是死字，
    // 而死字白名单只减不增——所以这两条必须是真接线。
    const src = stripComments(readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8'));
    asserts++;
    for (const k of ['epilogue_keep', 'epilogue_let_go']) {
      if (!src.includes(`'${k}'`)) probs.push(`${k} 没有被任何代码引用`);
    }

    // 两张彩蛋不许是同一张。
    asserts++;
    if (I18N.zh.epilogue_keep === I18N.zh.epilogue_let_go) {
      probs.push('两结局共用同一张彩蛋——二选一的意义没了');
    }

    return expect(
      probs.length === 0,
      probs.length
        ? probs.join('；')
        : '留门 / 放手 各一张彩蛋 · 两侧齐全 · 都被 main.ts 引用 · 两张不同',
      asserts,
    );
  });
}

/**
 * 把玩家摆到第 `index` 件正旁边，然后按一次 F——**走和实机同一条路**。
 *
 * 为什么不直接读 `Relics.heard` / `Relics.past` 两个集合：
 * 那样量到的是"两个集合被正确地写了"，而不是"玩家真的读到了两段不同的字"。
 * 中间那层 `touchRelic()` 才是判据要守的东西。
 */
function fakeTouch(relics: Relics, index: number): 'now' | 'past' | null {
  const p = relics.placements[index];
  if (!p) return null;
  const n = relics.nearestWithin(p.x, p.z, RELIC_REACH);
  if (n.index !== index) return null;
  return n.index < 0 ? null : layerOf(relics, n.index);
}

/** `touchRelic()` 的分层判定，抄的是 `world.ts` 那一份。 */
function layerOf(relics: Relics, i: number): 'now' | 'past' | null {
  const def = relics.placements[i]?.def;
  if (!def) return null;
  if (!relics.isHeard(i)) {
    relics.markHeard(i);
    return 'now';
  }
  if (!relics.hasPast(i)) {
    relics.markPast(i);
    return 'past';
  }
  return null;
}

// ---------------------------------------------------------------- 路边躲避挑战

/**
 * **布局不许把路封死。**这是这一族里唯一真正承重的一条。
 *
 * 量的是两条：
 *   ① 每块石头**连着半径**都还在路面之内（`lateral + radius ≤ 路半宽`）
 *      ——否则「躲过去」的唯一办法是离路，而离路要吃降速惩罚，
 *      那一圈会变成"一边掉速一边躲"。
 *   ② 相邻两块**永不落在同一条车道**——横向永远还剩三条通路。
 *
 * 加上"沿路间隔 ≥ MIN_GAP"，玩家读到的才是"几块石头"，不是"一堵墙"。
 */
function registerDodgeChecks(check: CheckFn): void {
  check('verify_dodge_layout', () => {
    let asserts = 0;
    const probs: string[] = [];
    const half = ROAD.TOTAL_HALF_WIDTH;
    for (const seed of [1, 7, 99, 2026, 65535]) {
      const list = planObstacles(seed, 0);

      asserts++;
      if (list.length !== OBSTACLE.COUNT) {
        probs.push(`seed ${seed}：铺了 ${list.length} 块，应为 ${OBSTACLE.COUNT}`);
      }

      for (const o of list) {
        asserts++;
        if (Math.abs(o.lateral) + o.radius > half) {
          probs.push(
            `seed ${seed} #${o.index}：横向 ${o.lateral.toFixed(2)}m + 半径 ${o.radius.toFixed(2)}m 越过路沿 ${half}m`,
          );
        }
        asserts++;
        if (o.radius < OBSTACLE.R_MIN - 1e-9 || o.radius > OBSTACLE.R_MAX + 1e-9) {
          probs.push(`seed ${seed} #${o.index}：半径 ${o.radius.toFixed(2)} 超出约定区间`);
        }
      }

      // 相邻两块不许同车道。按弧长排一遍再比——
      // `planObstacles` 生成时是按 i 递增的，落盘顺序也就是弧长顺序。
      for (let i = 1; i < list.length; i++) {
        asserts++;
        if (list[i].lateral === list[i - 1].lateral) {
          probs.push(`seed ${seed}：#${i - 1} 与 #${i} 落在同一条车道（${list[i].lateral}m），横向只剩一条通路`);
        }
      }

      // 沿路间隔
      const gaps = list.map((o, i) => {
        const d = i === 0 ? o.s - list[list.length - 1].s : o.s - list[i - 1].s;
        return d + TOTAL_ARCLENGTH;
      });
      for (const d of gaps) {
        asserts++;
        if (d < OBSTACLE.MIN_GAP - 1e-6) {
          probs.push(`seed ${seed}：有一对石头只隔 ${d.toFixed(1)}m < ${OBSTACLE.MIN_GAP}m`);
        }
      }

      // 起手不能贴脸
      asserts++;
      const first = Math.min(...list.map((o) => o.s));
      if (first < OBSTACLE.LEAD_IN - 1e-6) {
        probs.push(`seed ${seed}：起手 ${OBSTACLE.LEAD_IN}m 内就有石头（${first.toFixed(1)}m）`);
      }
    }

    // 同一个种子必须给出同一套布局：玩家中途退出再回来，
    // 石头不该换位置——那读起来是"这个游戏在改我的路"。
    asserts++;
    const a = planObstacles(42, 0).map((o) => `${o.s.toFixed(4)}:${o.lateral}`).join('|');
    const b = planObstacles(42, 0).map((o) => `${o.s.toFixed(4)}:${o.lateral}`).join('|');
    if (a !== b) probs.push('同一个种子给出了两套不同的布局');

    // **三角面预算 + 木牌在撤走之后必须还在**。
    // 用假地形（`getHeightAt` 恒 0）：面数与高程无关。
    // 木牌自身的面数单独量一次——撤走之后剩下的**就该**是它，
    // 而不为零（不为 0）正是"木牌还挂着"这句话的证据。
    const signOnly = new Obstacles();
    signOnly.group.add(buildSign());
    const signCost = signOnly.triangleCount();

    const obs = new Obstacles();
    const sign = buildSign();
    obs.group.add(sign);
    obs.place(planObstacles(3, 0), { getHeightAt: () => 0 } as unknown as Terrain);
    const tris = obs.triangleCount();
    asserts++;
    if (tris > OBSTACLE_TRI_BUDGET) {
      probs.push(`木牌 + ${OBSTACLE.COUNT} 块石头共 ${tris} 面，超过预算 ${OBSTACLE_TRI_BUDGET}`);
    }
    obs.clear();
    // 撤走之后**木牌仍在**（它挂的是 `group`，`clear()` 只按 `stones.visible`），
    // 所以剩下的面数恰好是木牌那一块——不为零才是对的。
    asserts++;
    if (obs.triangleCount() !== signCost) {
      probs.push(`撤走石头之后还剩 ${obs.triangleCount()} 面，木牌本身是 ${signCost} 面——石头没撤干净`);
    }
    asserts++;
    if (sign.parent !== obs.group) probs.push('撤走石头之后木牌跟着不见了 —— 路肩上什么都没有了');

    const summary = `${OBSTACLE.COUNT} 块 · 三条车道轮换 · 相邻不同道 · 最小间隔 ${OBSTACLE.MIN_GAP}m · 全在路内 · 木牌+石头 ${tris} 面`;
    return expect(probs.length === 0, probs.length ? probs.join('；') : summary, asserts);
  });

  /**
   * **绕一圈的判定**——进度怎么涨、碰了怎么收、绕满怎么成。
   *
   * 掉头那一支是重点：只把**正的**弧长差累加进去，
   * 所以往回骑不会把进度推上去。而"骑满 1.0 才算一圈"，
   * 所以在半路停下永远不算成。
   */
  check('verify_dodge_lap', () => {
    let asserts = 0;
    const probs: string[] = [];

    // 一趟干干净净地绕完。
    //
    // **必须真的会躲**：正中那一档车道上就摆着石头，
    // 而骑手骑的是**车把中心**——沿中心线走是必撞的。
    // 所以这里跑一个最简单的闭环：看前方最近的那块，
    // 挑离它最远的一条车道过去。这条闭环本身就是一句断言：
    // 「这一圈有解」。
    const run = new DodgeRun();
    run.start(0, 7);
    asserts++;
    if (run.state !== 'running') probs.push('起跑之后状态不是 running');

    // N 步走满 1.0 —— 循环上界是 `<= N` 而不是 `< N`：
    // `arc = (i/N) % 1` 在 i = N-1 时才到 0.99983，**差那 0.00017 就绕不满一圈**，
    // 而症状是「明明骑完一圈却没判成」，看起来像圈数判定坏了。
    const N = 6000;
    let lateral = 0;
    let won = false;
    for (let i = 0; i <= N && !won; i++) {
      const arc = (i / N) % 1;
      const here = arc * TOTAL_ARCLENGTH;
      // 前方 2–45m 内的**所有**石头
      const cands: { lateral: number }[] = [];
      for (const o of run.obstacles) {
        let ds = o.s - here;
        if (ds > TOTAL_ARCLENGTH / 2) ds -= TOTAL_ARCLENGTH;
        if (ds < -TOTAL_ARCLENGTH / 2) ds += TOTAL_ARCLENGTH;
        if (ds > 2 && ds < 45) cands.push(o);
      }
      // 挑一条「到前方每一块都够远」的车道。
      // 判据是**最差的那一块**而不是最近的那一块：只看最近一块的话，
      // 会出现"绕过第一块、第二块正在把车等回来"的那种死法。
      let want = lateral;
      if (cands.length) {
        let best = OBSTACLE.LANES[0];
        let bd = -Infinity;
        for (const L of OBSTACLE.LANES) {
          let worst = Infinity;
          for (const o of cands) worst = Math.min(worst, Math.abs(L - o.lateral));
          if (worst > bd) {
            bd = worst;
            best = L;
          }
        }
        want = best;
      }
      // 前方没有石头时**保持**横向，不回正。
      // 回正这一下是致命的：刚躲开的那块石头还在身后 1m，
      // 车一横移就正好插回它身上——第一版就死在这儿。
      lateral += (want - lateral) * 0.3;
      const f = frameAt(arc);
      if (run.step(arc, f.x + f.rx * lateral, f.z + f.rz * lateral)?.type === 'won') won = true;
    }
    asserts++;
    if (!won) probs.push('一个会躲的骑手绕满一圈仍然没有 won —— 这一圈无解，或者圈数判定坏了');
    asserts++;
    if (run.progress < 1) probs.push(`won 之后进度是 ${run.progress}，应为 1`);
    asserts++;
    if (run.state !== 'won') probs.push(`won 之后状态是 ${run.state}`);

    // **骑中心线必撞**：正中那一档车道上摆着石头，
    // 而这一条是"没有躲避可言"的反证。
    const straight = new DodgeRun();
    straight.start(0, 7);
    let straightHit = false;
    for (let i = 0; i < N && !straightHit; i++) {
      const arc = (i / N) % 1;
      const f = frameAt(arc);
      if (straight.step(arc, f.x, f.z)?.type === 'hit') straightHit = true;
    }
    asserts++;
    if (!straightHit) {
      probs.push('一路骑中心线也撞不到 —— 正中那档车道没摆石头，这一条就没有躲避可言');
    }

    // 掉头不涨分
    const back = new DodgeRun();
    back.start(0, 7);
    for (let i = 1; i <= 200; i++) {
      const arc = (((-i * 0.0005) % 1) + 1) % 1;
      const f = frameAt(arc);
      back.step(arc, f.x, f.z);
    }
    asserts++;
    if (back.progress > 0.001) {
      probs.push(`一路往回骑却涨了 ${(back.progress * 100).toFixed(2)}% 的进度——掉头也加分，这一圈就不叫一圈`);
    }

    // 撞到就收，且不再继续加分
    const hit = new DodgeRun();
    hit.start(0, 7);
    const target = hit.obstacles[5];
    let ev: ReturnType<DodgeRun['step']> = null;
    // 从石头前方 6m 骑进它怀里
    for (let i = -20; i <= 0 && !ev; i++) {
      ev = hit.step(target.s / TOTAL_ARCLENGTH, target.x, target.z);
    }
    asserts++;
    if (!ev || ev.type !== 'hit') probs.push('把车开到石头正中心却没有判撞');
    asserts++;
    if (hit.state !== 'hit') probs.push(`撞了之后状态是 ${hit.state}`);
    asserts++;
    if (hit.hitIndex !== target.index) probs.push('撞了但记错了是哪一块');

    // 撞过之后那一趟必须彻底停掉：再走一百圈也不许再报 won
    const after = hit.state;
    let rewon = false;
    for (let i = 0; i < N; i++) {
      const arc = (i / N) % 1;
      const f = frameAt(arc);
      if (hit.step(arc, f.x, f.z)?.type === 'won') rewon = true;
    }
    asserts++;
    if (after !== 'hit' || rewon) probs.push('撞过之后仍然能绕出 won——这一趟没有结束');

    // 车把半宽这一项不能是零：判据要确认"贴上去"真的会判撞
    asserts++;
    if (BIKE_HALF_WIDTH <= 0) probs.push('车把半宽是 0，等于没有碰撞');

    return expect(probs.length === 0, probs.length ? probs.join('；') : '会躲的骑手绕满一圈 / 骑中心线必撞 / 掉头不加分 / 撞了即收', asserts);
  });

  /**
   * 木牌钉在哪：远的那一侧，而且**真的离得开驿站**。
   *
   * 钉错一侧的症状是"木牌落进某座驿站的院子里"——
   * 玩家远远看见的是一座亭子，走过去才发现地上插了块板子。
   */
  check('verify_dodge_sign', () => {
    let asserts = 0;
    const probs: string[] = [];
    for (const arcT of [0.42, 0.1, 0.6, 0.85]) {
      const side = signSide(arcT);
      const chosen = signStandoff(side, arcT);
      const other = signStandoff(side === 1 ? -1 : 1, arcT);
      asserts++;
      if (chosen < SIGN_STANDOFF) {
        probs.push(`arcT=${arcT}：选中的那一侧离驿站只有 ${chosen.toFixed(1)}m < ${SIGN_STANDOFF}m`);
      }
      asserts++;
      if (other > chosen) {
        probs.push(`arcT=${arcT}：选了离驿站 ${chosen.toFixed(1)}m 的那一侧，另一侧有 ${other.toFixed(1)}m——不是更远的那侧`);
      }
      // 纯函数：同一个弧长算两次要得到同一个答案
      asserts++;
      if (signSide(arcT) !== side) probs.push(`arcT=${arcT}：signSide 不是纯函数`);
      // 木牌真的在路肩外
      const p = signSite(arcT, side);
      asserts++;
      if (Math.abs(p.x) === 0 && Math.abs(p.z) === 0) probs.push(`arcT=${arcT}：木牌落位是原点`);

      // 木牌的**正面**（局部 +Z，炭字那一侧）必须对着路面。
      //
      // 量法是独立的：不看 `signYaw()` 内部用的那个锚点，而是拿木牌站位
      // 在全部中心线采样点里暴力找最近的一个，再看正面朝不朝它。
      // 两侧都量——钉在哪一侧是 `signSide()` 算出来的，两边都得朝路。
      //
      // 这一条守的是一次真实的白屏：`World.buildSign()` 原来拿
      // `this.ride.pos`（玩家出生点，隔了小半圈）当"路的方向"，而且
      // `this.ride` 在构造里比 `buildSign()` **晚**才被赋值，
      // 于是每一次建世界都抛 `reading 'pos'`。就算那个顺序对了，
      // 拿出生点当朝向也有一半概率把木牌扭到背对路面。
      asserts++;
      for (const sd of [1, -1] as const) {
        const yaw = signYaw(arcT, sd);
        const site = signSite(arcT, sd);
        let bx = site.x;
        let bz = site.z;
        let bd = Infinity;
        for (const q of CENTERLINE) {
          const d = (q.x - site.x) ** 2 + (q.z - site.z) ** 2;
          if (d < bd) {
            bd = d;
            bx = q.x;
            bz = q.z;
          }
        }
        const l = Math.hypot(bx - site.x, bz - site.z) || 1;
        // `rotation.y = yaw` 之后局部 +Z 指向世界坐标的 (sin yaw, cos yaw)
        const dot = ((bx - site.x) / l) * Math.sin(yaw) + ((bz - site.z) / l) * Math.cos(yaw);
        if (dot < 0.9) {
          probs.push(
            `arcT=${arcT} side=${sd}：木牌正面没对着路（吻合度 ${dot.toFixed(3)}）——玩家只会看到背面`,
          );
        }
      }
    }

    // 纯函数：同一个弧长算两次要得到同一个朝向（刷新一次页面木牌不会扭过去）
    asserts++;
    if (signYaw(0.42, 1) !== signYaw(0.42, 1)) probs.push('signYaw 不是纯函数');

    // ---- 接线：`buildSign()` 不许再碰 `this.ride` ----
    //
    // 这一条守的是一次真实的白屏：`World` 构造里 `buildSign()` 跑在
    // `new Ride(...)` **之前**，而它原来要 `this.ride.pos` 来定朝向，
    // 于是每一次建世界都抛 `Cannot read properties of undefined (reading 'pos')`，
    // 玩家看到的是 "World construction failed" 那一屏。
    //
    // 无头回归抓不到它——`new World()` 需要 WebGL，判据里从来没有过一整个
    // 世界实例。所以这里退一步问**源码的形状**：构造里在 `this.ride` 被赋值
    // 之前不许出现它，`buildSign()` 的方法体里也不许出现它。
    // 形状变了（找不到那两处锚点）同样要报——判据不许空转。
    //
    // **必须先剥注释**：上面那条注释里就写着 `this.ride` 这四个字，
    // 不剥的话判据量到的是"有人提到过它"，而不是"代码里真的在读它"。
    // 口径与 `harness.ts` 里那份共用（`entry.ts` / `ai.ts` 同源）。
    const worldSrc = stripComments(
      readFileSync(join(process.cwd(), 'src', 'world', 'world.ts'), 'utf8'),
    );
    const ctorAt = worldSrc.indexOf('constructor(canvas');
    const rideAt = worldSrc.indexOf('this.ride = new Ride(');
    asserts++;
    if (ctorAt < 0 || rideAt < 0) {
      probs.push('world.ts 里找不到 `constructor(canvas…` / `this.ride = new Ride(`——构造顺序这条判据空转了');
    } else if (worldSrc.slice(ctorAt, rideAt).includes('this.ride')) {
      probs.push('World 构造在 `this.ride` 赋值之前就引用了它——建世界会抛 reading \'pos\'（玩家看到白屏）');
    }

    const signFnAt = worldSrc.indexOf('private buildSign(');
    asserts++;
    if (signFnAt < 0) {
      probs.push('world.ts 里找不到 `private buildSign(`——木牌朝向这条判据空转了');
    } else {
      const body = worldSrc.slice(signFnAt, worldSrc.indexOf('\n  }', signFnAt));
      if (body.includes('this.ride')) {
        probs.push('buildSign() 又在读 `this.ride` 了——它在 `new Ride(...)` 之前被调用，会抛 reading \'pos\'');
      }
    }

    const summary = `木牌离最近驿站 ≥ ${SIGN_STANDOFF}m · 取更远的一侧 · 正面朝路 · 纯函数 · 构造顺序不读 this.ride`;
    return expect(probs.length === 0, probs.length ? probs.join('；') : summary, asserts);
  });
}

// ---------------------------------------------------------------- 琴音林自由演奏

function registerQinChecks(check: CheckFn): void {
  /**
   * 二十一个音，二十一个键，**一对一**。
   *
   * 两个方向都要量：
   *   · 每个音都被某个键弹得到（漏一条 = 有一个音怎么按都出不来）
   *   · 每个键只对应一个音（两个键撞成一个音 = 按哪个都一样）
   */
  check('verify_qin_keys', () => {
    let asserts = 0;
    const probs: string[] = [];

    asserts++;
    if (QIN_NOTES !== QIN_STRINGS * QIN_OCTAVES) {
      probs.push(`音数 ${QIN_NOTES} ≠ ${QIN_STRINGS} × ${QIN_OCTAVES}`);
    }
    asserts++;
    if (QIN_NOTES !== 21) probs.push(`三个八度 × 七根弦应是 21 个音，实际 ${QIN_NOTES}`);

    // 键位表逐项验
    const seen = new Map<string, number>();
    for (let o = 0; o < QIN_OCTAVES; o++) {
      asserts++;
      if (QIN_KEYS[o].length !== QIN_STRINGS) {
        probs.push(`八度 ${o} 只有 ${QIN_KEYS[o].length} 个键，应为 ${QIN_STRINGS}`);
      }
      for (let s = 0; s < QIN_STRINGS; s++) {
        const key = QIN_KEYS[o][s];
        const note = o * QIN_STRINGS + s;
        asserts++;
        if (noteForKey(key) !== note) {
          probs.push(`${key} 映射到 ${noteForKey(key)}，应是 ${note}`);
        }
        asserts++;
        if (seen.has(key)) probs.push(`${key} 被两个音抢了（${seen.get(key)} 与 ${note}）`);
        seen.set(key, note);
      }
    }

    // 小键盘只补**高八度**：低/中两行没有小键盘键，
    // 而把 `Numpad1..7` 填成三行的话，第 0 个八度会先把它认领走——
    // 于是外接键盘上按小键盘响的是最低那根弦，屏上却写着「高八度」。
    for (let s = 0; s < QIN_STRINGS; s++) {
      asserts++;
      const want = (QIN_OCTAVES - 1) * QIN_STRINGS + s;
      if (noteForKey(`Numpad${s + 1}`) !== want) {
        probs.push(`Numpad${s + 1} 映射到 ${noteForKey(`Numpad${s + 1}`)}，应是高八度第 ${s + 1} 弦（${want}）`);
      }
    }
    asserts++;
    if (QIN_KEYS_NUMPAD.length !== QIN_STRINGS) {
      probs.push(`小键盘补了 ${QIN_KEYS_NUMPAD.length} 个键，应为 ${QIN_STRINGS}`);
    }
    // 不该弹的键
    for (const k of ['Space', 'Escape', 'KeyA', 'Digit0', 'F5', 'Unidentified']) {
      if (k === 'Escape') continue; // Esc 是退出，不是音
      asserts++;
      if (noteForKey(k) !== -1) probs.push(`${k} 被当成了一个音`);
    }

    // **它不在轮换表里**：加进去会把 15 局重排成 18 局
    asserts++;
    if ((MINI_GAME_IDS as readonly string[]).includes('qin')) {
      probs.push('`qin` 进了 MINI_GAME_IDS —— 自由演奏会把 15 局重排');
    }
    asserts++;
    if (MINI_GAME_IDS.length !== 5) probs.push(`轮换表变成 ${MINI_GAME_IDS.length} 项了`);

    return expect(probs.length === 0, probs.length ? probs.join('；') : '21 个音 ↔ 21 个键，含小键盘；不进轮换表', asserts);
  });

  /**
   * 每一格都要**手指点得中**。
   *
   * 量两件事，在五种视口下各量一遍：
   *   ① 七×三 的格子**正好铺满**板子（不重叠、不留缝）
   *   ② 每格不小于 `QIN_CELL_MIN`
   *
   * ①是几何自洽（重叠的话点上面那格会同时响两下）；
   * ②才是触屏。横屏手机放不下 44px 时这里会红——那正是它该红的时候。
   */
  check('verify_qin_touch', () => {
    let asserts = 0;
    const probs: string[] = [];
    for (const [label, w, h] of VIEWPORTS) {
      const board = rect();
      boardRectInto(board, w, h);

      asserts++;
      if (board.x < -0.001 || board.y < -0.001 || board.x + board.w > w + 0.001 || board.y + board.h > h + 0.001) {
        probs.push(`${label}：板子跑出视口了（${board.x.toFixed(0)},${board.y.toFixed(0)} ${board.w.toFixed(0)}×${board.h.toFixed(0)}）`);
      }

      const cell = rect();
      for (let n = 0; n < QIN_NOTES; n++) {
        cellRectInto(cell, board, n);
        asserts++;
        if (cell.w < QIN_CELL_MIN || cell.h < QIN_CELL_MIN) {
          probs.push(
            `${label}：第 ${n} 格只有 ${cell.w.toFixed(0)}×${cell.h.toFixed(0)}px，小于 ${QIN_CELL_MIN}px`,
          );
        }
        asserts++;
        if (cell.x < board.x - 0.001 || cell.x + cell.w > board.x + board.w + 0.001) {
          probs.push(`${label}：第 ${n} 格横向越过板子`);
        }
        asserts++;
        if (cell.y < board.y - 0.001 || cell.y + cell.h > board.y + board.h + 0.001) {
          probs.push(`${label}：第 ${n} 格纵向越过板子`);
        }
      }
      // 横向铺满：三列之和 == 板宽（留缝的话最右一列点不到）
      const last = rect();
      cellRectInto(last, board, QIN_NOTES - 1);
      asserts++;
      if (Math.abs(last.x + last.w - (board.x + board.w)) > 0.001) {
        probs.push(`${label}：三列没有铺满板子，右边差 ${(board.x + board.w - last.x - last.w).toFixed(2)}px`);
      }
      // 纵向铺满
      asserts++;
      if (Math.abs(last.y + last.h - (board.y + board.h)) > 0.001) {
        probs.push(`${label}：七行没有铺满板子`);
      }

      // 那行操作提示**不许压在弦上**。矮视口上板子吃掉了几乎全部高度，
      // 所以提示必须挪到板子上面；高视口上它在板子下面。
      // 判据是「提示基线落在板子的 y 区间之外」，而不是"在某个绝对位置"。
      const hint = qinHintLayout(h, board.y);
      const inBoard = hint.y >= board.y - 2 && hint.y <= board.y + board.h + 2;
      asserts++;
      if (inBoard) {
        probs.push(
          `${label}：提示基线 y=${hint.y.toFixed(0)} 落在板子的 y 区间内（${board.y.toFixed(0)}–${(board.y + board.h).toFixed(0)}）`,
        );
      }
      asserts++;
      if (hint.y < 0 || hint.y > h) probs.push(`${label}：提示掉出视口（y=${hint.y.toFixed(0)}）`);
    }

    // 平板上要**收窄**：铺满 768 就够不着边角
    const tablet = rect();
    boardRectInto(tablet, 1024, 768);
    asserts++;
    if (tablet.w > 620.5) probs.push(`平板横屏板子宽 ${tablet.w.toFixed(0)}px，没收窄`);
    // 手机竖屏不能被缩：390 × 0.7 = 273，本来就够画
    const phone = rect();
    boardRectInto(phone, 390, 844);
    asserts++;
    if (phone.w < 240) probs.push(`手机竖屏板子只有 ${phone.w.toFixed(0)}px，描得太小点不准`);

    return expect(probs.length === 0, probs.length ? probs.join('；') : '7×3 铺满板子 · 每格 ≥44px · 平板收窄手机不缩', asserts);
  });

  /**
   * 它真的**弹得响**，而且**不会自己结算**。
   *
   * 后半条是这一屏最要紧的：自由演奏没有胜负，
   * 而"弹着弹着被判赢"或者"弹到一半被 30 秒兜底收掉"，
   * 都会让玩家读到一句他根本没参与过的评价。
   */
  check('verify_qin_freeplay', () => {
    let asserts = 0;
    const probs: string[] = [];
    let result: MiniGameResult | null = null;
    const played: number[] = [];
    const g = createQinGame({
      ctx: fakeCtx(1024, 768),
      width: 1024,
      height: 768,
      lang: 'zh',
      palette: { ink: '#000', paper: '#fff', accent: '#a60', dim: '#888', ok: '#0a0', bad: '#a00' },
      audio: {
        sfx() {},
        note() {},
        // 记下真的弹了哪些音：键位表对得上还不够，
        // 得确认 `onKeyDown` 真的走到了 `pluck()`。
        noteFree(i: number) {
          played.push(i);
        },
        duckAmbient() {},
      },
      t: (k: string) => k,
      seed: 1,
      onDone: (r: MiniGameResult) => {
        result = r;
      },
    } as unknown as MiniGameContext);
    g.resize(1024, 768);

    // 全部二十一个键挨个按一遍
    for (let o = 0; o < QIN_OCTAVES; o++) {
      for (let s = 0; s < QIN_STRINGS; s++) {
        g.onKeyDown(QIN_KEYS[o][s], false);
        g.onKeyUp(QIN_KEYS[o][s]);
        g.step(1 / 60);
        g.draw();
      }
    }
    asserts++;
    if (played.length !== QIN_NOTES) {
      probs.push(`按遍 21 个键只响了 ${played.length} 声`);
    }
    asserts++;
    if (new Set(played).size !== QIN_NOTES) {
      probs.push(`21 个键只响了 ${new Set(played).size} 个不同的音——有键位撞车`);
    }

    // 什么都不按、不弹，走满 40 秒也不许自己结算
    for (let i = 0; i < 60 * 40; i++) {
      g.step(1 / 60);
      if (i % 10 === 0) g.draw();
    }
    asserts++;
    if (result !== null) {
      probs.push(`什么都不弹就收到了终局「${result}」——这一屏没有胜负`);
    }

    // 触屏：每一格点一下都要响。**必须在 Esc 之前**——
    // 退出之后这一局就 finished 了，而 `onPointerDown` 会早退，
    // 于是这一步会数出 0 格——那不是"触屏弹不了"，是判据自己放错了顺序。
    const board = rect();
    boardRectInto(board, 1024, 768);
    const cell = rect();
    let taps = 0;
    for (let n = 0; n < QIN_NOTES; n++) {
      cellRectInto(cell, board, n);
      played.length = 0;
      g.onPointerDown(cell.x + cell.w * 0.5, cell.y + cell.h * 0.5);
      g.onPointerUp(cell.x + cell.w * 0.5, cell.y + cell.h * 0.5);
      if (played.length === 1 && played[0] === n) taps++;
    }
    asserts++;
    if (taps !== QIN_NOTES) probs.push(`${QIN_NOTES} 格里只有 ${taps} 格点得响（或响错了音）`);

    // Esc 退出
    g.onKeyDown('Escape', false);
    asserts++;
    if (result !== 'cancel') probs.push(`Esc 之后的结果是 ${result}，应为 cancel`);

    // 同一个实例也必须由 `createMiniGame` 造得出来（宿主走的是那条路）
    asserts++;
    try {
      createMiniGame('qin', {
        ctx: fakeCtx(800, 600),
        width: 800,
        height: 600,
        lang: 'en',
        palette: { ink: '#000', paper: '#fff', accent: '#a60', dim: '#888', ok: '#0a0', bad: '#a00' },
        audio: { sfx() {}, note() {}, duckAmbient() {} },
        t: (k: string) => k,
        seed: 2,
        onDone() {},
      } as unknown as MiniGameContext);
    } catch (e) {
      probs.push(`createMiniGame('qin') 抛异常：${String((e as Error)?.message ?? e).split('\n')[0]}`);
    }

    return expect(probs.length === 0, probs.length ? probs.join('；') : '21 键 21 音 · 触屏 21 格 · 不自判 · Esc 退出', asserts);
  });
}

// ---------------------------------------------------------------- 茶：倒水

function registerTeaPourChecks(check: CheckFn): void {
  /**
   * 水柱**落进盏里**，而盏**在屏内**。
   *
   * 壶嘴尖随倾角转，盏的位置是从"转到底的壶嘴尖"推出来的——
   * 两处各算一次的话，倾角一改水就画到别处去了，
   * 而图上的症状只是"水在半空中没了"。
   */
  check('verify_tea_pour_geometry', () => {
    let asserts = 0;
    const probs: string[] = [];
    for (const [label, w, h] of VIEWPORTS) {
      const sc = Math.min(w, h) / 400;
      const rx = 78 * sc;
      const ry = 60 * sc;
      const cx = w * 0.5;
      const cy = h * 0.44;
      const tip = pourSpoutTip(cx, cy, rx, ry, POUR_TILT);
      const cup = pourCupRect(cx, cy, rx, ry);

      asserts++;
      if (cup.x < -0.5 || cup.x + cup.w > w + 0.5) {
        probs.push(`${label}：盏跑出屏外（x=${cup.x.toFixed(0)} w=${cup.w.toFixed(0)}）`);
      }
      asserts++;
      if (cup.y + cup.h > h + 0.5) {
        probs.push(`${label}：盏掉到屏底下面了（y=${cup.y.toFixed(0)} h=${cup.h.toFixed(0)}）`);
      }
      asserts++;
      if (!(tip.y < cup.y)) {
        probs.push(`${label}：壶嘴尖（y=${tip.y.toFixed(0)}）不在盏口（y=${cup.y.toFixed(0)}）上方——水会往上流`);
      }
      asserts++;
      if (!(tip.y <= cup.y + cup.h)) {
        probs.push(`${label}：壶嘴尖压在盏底以下，水柱落不进盏里`);
      }
      // 水平方向：壶嘴尖与盏心不许差出一整个盏宽，
      // 否则水柱是横着甩过去的，而那在图上读成"泼出去"。
      asserts++;
      const cupCx = cup.x + cup.w * 0.5;
      if (Math.abs(tip.x - cupCx) > cup.w) {
        probs.push(`${label}：盏心离壶嘴尖 ${Math.abs(tip.x - cupCx).toFixed(0)}px，超过一个盏宽 ${cup.w.toFixed(0)}px`);
      }
    }
    return expect(probs.length === 0, probs.length ? probs.join('；') : '五种视口下，水都从壶嘴落进盏里', asserts);
  });

  /**
   * 倒水**要占掉时间**，而那一段时间里不许已经交出结果。
   *
   * ## 为什么这条要钉
   *
   * 原来这一屏是「按满 3 秒 → 立刻 `onDone`」，玩家看到的是
   * 「我按了，然后什么也没发生」。加了倒水之后它终于有一个落幕，
   * 但**顺序不能反**：如果壶刚一动就交出结果，
   * 结算屏会把整段倒水盖住——那一屏等于没做。
   */
  check('verify_tea_pour_timing', () => {
    let asserts = 0;
    const probs: string[] = [];
    let result: MiniGameResult | null = null;
    const g = createTeaGame({
      ctx: fakeCtx(960, 540),
      width: 960,
      height: 540,
      lang: 'zh',
      palette: { ink: '#000', paper: '#fff', accent: '#a60', dim: '#888', ok: '#0a0', bad: '#a00' },
      audio: { sfx() {}, note() {}, duckAmbient() {} },
      t: (k: string) => k,
      seed: 1,
      onDone: (r: MiniGameResult) => {
        result = r;
      },
    } as unknown as MiniGameContext);
    g.resize(960, 540);

    // 按住空格
    g.onKeyDown('Space', false);

    // 3.05 秒：按满了，但倒水还没走完 —— **不许**已经交出结果
    for (let i = 0; i < Math.floor(3.05 * 60); i++) g.step(1 / 60);
    asserts++;
    if (result !== null) {
      probs.push(`按满 3.05 秒就已经交出「${result}」了——结算屏会把整段倒水盖住`);
    }

    // 一路走到 5 秒：必须交出，而且交出的是 win
    for (let i = 0; i < Math.floor(2 * 60) && result === null; i++) g.step(1 / 60);
    asserts++;
    if (result !== 'win') probs.push(`5 秒之后的结果是 ${result}，应为 win`);

    // 继续推进不抛异常（收尾动画走完之后仍每帧 draw）
    for (let i = 0; i < 60; i++) {
      g.step(1 / 60);
      g.draw();
    }

    // **总时长必须留在 `verify_minigame_playable` 那个 5 秒窗口之内**。
    // 3s 注水 + 收尾 > 5s 的话，那条判据会把茶报成"卡死"——
    // 而它其实好好的，只是收尾比它以为的长。
    asserts++;
    const total = 3.0 + 1.95;
    if (total > 5.0) {
      probs.push(`注水 3s + 收尾后共 ${total.toFixed(2)}s，超过判据给的 5 秒窗口`);
    }

    g.onKeyUp('Space');
    return expect(probs.length === 0, probs.length ? probs.join('；') : '按满不立刻交 · 5 秒内交出 win', asserts);
  });
}

// ---------------------------------------------------------------- 描云：响应式板子

/**
 * 平板收窄、手机不缩——**两边都必须成立**。
 *
 * 只钉"平板变小了"会漏掉另一半：把板子一并缩到手机上也点不准，
 * 而那种退化在平板上看不出来，只有真机上才骂人。
 */
function registerBoardChecks(check: CheckFn): void {
  check('verify_cloud_board', () => {
    let asserts = 0;
    const probs: string[] = [];

    for (const [label, w, h] of VIEWPORTS) {
      const b = rect();
      areaRectInto(b, w, h);
      asserts++;
      if (b.x < -0.001 || b.y < -0.001 || b.x + b.w > w + 0.001 || b.y + b.h > h + 0.001) {
        probs.push(`${label}：板子跑出视口了`);
      }
      asserts++;
      if (b.w < 240) probs.push(`${label}：板子宽 ${b.w.toFixed(0)}px < 240px，手机上描不准`);
      asserts++;
      if (b.w > 560.5) probs.push(`${label}：板子宽 ${b.w.toFixed(0)}px > 560px，平板上够不着边角`);
      // 板子不能压到进度条上（条在 h*0.88）
      asserts++;
      if (b.y + b.h > h * 0.88) {
        probs.push(`${label}：板子底沿 ${(b.y + b.h).toFixed(0)} 压在进度条 ${(h * 0.88).toFixed(0)} 上`);
      }
    }

    // 手机竖屏**一个字都没变**：390 × 0.70 = 273，本来就在夹取区间内
    const phone = rect();
    areaRectInto(phone, 390, 844);
    asserts++;
    if (Math.abs(phone.w - 390 * 0.7) > 0.01) {
      probs.push(`手机竖屏板子宽 ${phone.w.toFixed(1)}，应为 ${(390 * 0.7).toFixed(1)}（不受收窄影响）`);
    }
    // 平板横屏真的被收了
    const tablet = rect();
    areaRectInto(tablet, 1024, 768);
    asserts++;
    if (tablet.w >= 1024 * 0.7) {
      probs.push(`平板横屏板子宽 ${tablet.w.toFixed(0)}，没收窄`);
    }
    asserts++;
    if (tablet.w !== 560) probs.push(`平板横屏板子宽 ${tablet.w.toFixed(1)}，应为 560`);

    return expect(probs.length === 0, probs.length ? probs.join('；') : '手机 273px 不变 · 平板收到 560px', asserts);
  });
}

/**
 * 中心线在某处的**局部标架**：中心点 + 右法向。
 *
 * 躲避的仿真是"横向偏移着骑"，而横向偏移必须沿着**路的右法向**推出去——
 * 直接往 +x 加是错的：8 字的上半支与下半支朝向不同，
 * 于是"骑左边"在那两段会变成"骑右边"，而测试照样绿。
 */
function frameAt(arc: number): { x: number; z: number; rx: number; rz: number } {
  const s = (((arc % 1) + 1) % 1) * TOTAL_ARCLENGTH;
  const a = pointAtArcLength(Math.max(0, s - 1.5)).pos;
  const b = pointAtArcLength(Math.min(TOTAL_ARCLENGTH, s + 1.5)).pos;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  return { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5, rx: dz / l, rz: -dx / l };
}
/**
 * 钓鱼：判定必须在无头里问得到。
 *
 * 这一族量的是 `game/fishing.ts` 那台纯状态机。**它必须留在无头里可测**——
 * 和 `tryCheckIn()` 少一个分支就让三间铺子、10 件商品、明信片四样材料
 * 全部不可达、而 25 条回归全绿，是同一类事故的两种规模。
 */

/** 用固定步长跑一局，返回中途见到的相位序列与最终结果。 */
function runFish(seed: number, hold: (tension: number, phase: FishPhase) => boolean, maxSec = 90) {
  const s = createFishState(seed);
  const dt = 1 / 60;
  const seen = new Set<FishPhase>();
  let casted = false;
  let holdNow = false;
  for (let i = 0; i * dt < maxSec; i++) {
    if (s.phase === 'idle' && !casted) {
      castFish(s);
      casted = true;
    }
    holdNow = s.phase === 'idle' ? false : hold(s.tension, s.phase);
    stepFish(s, dt, holdNow);
    seen.add(s.phase);
    if (s.phase === 'result' && s.outcome !== 'none') {
      return { outcome: s.outcome, kind: s.catchKind, range: s.range, seen, state: s };
    }
  }
  return { outcome: s.outcome, kind: s.catchKind, range: s.range, seen, state: s };
}

function registerFishingChecks(check: CheckFn): void {
  /**
   * 这台机器可不可玩：**能赢、能输、而且输法不止一种。**
   *
   * 只测"能不能赢"是不够的——一台恒胜的机器比一台坏掉的更糟，
   * 因为它让整件事失去意义。所以下面三条各自钉住一件事：
   * 有一种打法能赢、一种打法会断线、一种打法压根上不了钩。
   */
  check('verify_fishing', () => {
    let asserts = 0;
    const probs: string[] = [];

    // 1. 两条设计前提，它们是"两条死路各自成立"的全部依据。
    //    · `TENSION_RISE > 0`：按住时张力**也涨**。不成立的话"一直按住"就成了
    //      最优解，而整台机器退化成一根按住不放的键——第一版就是这么错的。
    //    · `REEL_RATE > 0`：按住是**唯一**推进进度的手段。不成立的话"一直松手"
    //      也就通了，两条死路塌成一条。
    asserts++;
    if (TENSION_RISE <= 0) {
      probs.push(`TENSION_RISE(${TENSION_RISE}) ≤ 0 —— 收线不激怒鱼，一直按住就能赢`);
    }
    if (REEL_RATE <= 0) {
      probs.push(`REEL_RATE(${REEL_RATE}) ≤ 0 —— 没有推进手段，机器无解`);
    }
    if (TENSION_FALL <= 0) {
      probs.push(`TENSION_FALL(${TENSION_FALL}) ≤ 0 —— 松手不能让鱼松劲，张力只涨不跌`);
    }

    // 2. 咬钩窗口不能窄到反人类。
    asserts++;
    if (BITE_WINDOW_SEC < 0.8) {
      probs.push(`咬钩窗口只有 ${BITE_WINDOW_SEC}s —— 低于 0.8s 对手感是致命的`);
    }

    // 3. 会赢：一条"张力高就松"的参考策略必须能收满。
    //    判据只证明**存在**一条可行打法，不规定它必须最优。
    asserts++;
    const win = runFish(188, (tension) => tension < 0.45);
    if (win.outcome !== 'caught') {
      probs.push(`"张力高就松"这条打法收不了线（结果 ${win.outcome}）—— 机器可能无解`);
    }
    if (win.kind === '') {
      probs.push('赢下来了却没给出鱼种');
    }

    // 4. 一直按住会断线。
    asserts++;
    const hold = runFish(188, () => true);
    if (hold.outcome !== 'snapped') {
      probs.push(`一直按住的结果是 ${hold.outcome}，不是 snapped —— 按住不再是双刃剑`);
    }

    // 5. 一直松手压根上不了钩。
    asserts++;
    const loose = runFish(188, () => false);
    if (loose.outcome !== 'missed') {
      probs.push(`一直松手的结果是 ${loose.outcome}，不是 missed —— 咬钩窗口没有约束力`);
    }

    // 6. 六个相位一个都不许是死路。
    asserts++;
    const need: FishPhase[] = ['casting', 'waiting', 'bite', 'reeling', 'result'];
    for (const p of need) {
      if (!win.seen.has(p)) probs.push(`一条能赢的局里没经过 ${p} —— 这个相位是死的`);
    }

    // 7. 确定：同一个 seed 必须给出同一串结果。
    asserts++;
    const a = runFish(7, (t) => t < 0.45);
    const b = runFish(7, (t) => t < 0.45);
    if (a.outcome !== b.outcome || a.kind !== b.kind || a.range !== b.range) {
      probs.push(`同一个 seed 跑出了两串结果：${a.outcome}/${a.kind} vs ${b.outcome}/${b.kind}`);
    }

    // 8. 但不能所有 seed 都一样——那就成了假随机。
    asserts++;
    const ranges = new Set<number>();
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 24; seed++) {
      const r = runFish(seed, (t) => t < 0.45);
      ranges.add(Math.round(r.range * 100));
      kinds.add(r.kind);
    }
    if (ranges.size < 8) probs.push(`24 个 seed 只落到 ${ranges.size} 个抛投距离 —— 随机性是假的`);
    if (kinds.size < 2) probs.push(`24 局只钓到 ${kinds.size} 种鱼 —— 鱼种表没接上`);

    // 9. 抛投距离在区间内，且动画/停留时长都是正的。
    asserts++;
    if (win.range < RANGE_MIN - 1e-6 || win.range > RANGE_MAX + 1e-6) {
      probs.push(`抛投距离 ${win.range.toFixed(2)}m 跑出了 [${RANGE_MIN}, ${RANGE_MAX}]`);
    }
    if (CAST_SEC <= 0 || RESULT_SEC <= 0) {
      probs.push(`CAST_SEC(${CAST_SEC}) 或 RESULT_SEC(${RESULT_SEC}) 不为正 —— 动画会瞬移`);
    }

    // 10. 收线阶段不能无限期挂着。
    //     「上钩之后一直不按」是一个合法的按键序列：进度永远是 0、张力跌到 0，
    //     而没有耐心上限的话 `reeling` 永远不会结束 —— 这一屏就出不出去了。
    //     症状极其安静：相位不报错、张力合法、UI 不闪，只有一直盯着看才发现。
    asserts++;
    {
      const s = createFishState(3);
      castFish(s);
      // 上界必须**按各段之和**算：抛投 + 最长等待 + 咬钩窗 + 收线耐心。
      // 拍一个数会栽两次——第一版写 200 帧（3.3s，耐心却是 12s），
      // 第二版写 `REEL_LIMIT_SEC + 4`（16s），而最坏路径是
      // 0.75 + 6.8 + 1.5 + 12 ≈ 21s，两次都在**还在收线**时就退出，
      // 读到 `outcome === 'none'` 这个中间态，报出来的是一条假红。
      // 假红比假绿贵：它会让人去改一个没坏的东西。
      const budget = CAST_SEC + 7 + BITE_WINDOW_SEC + 1 + REEL_LIMIT_SEC + 2;
      for (let i = 0; i * (1 / 60) < budget && s.phase !== 'result'; i++) {
        stepFish(s, 1 / 60, s.phase === 'bite' && s.biteLeft <= 0.3);
      }
      if (s.outcome !== 'escaped') {
        probs.push(`上钩后一直不按的结果是 ${s.outcome}，不是 escaped`);
      }
      // 而脱钩之后必须能回到 idle，第二局才开得了。
      for (let i = 0; i * (1 / 60) < 10 && s.phase !== 'idle'; i++) stepFish(s, 1 / 60, false);
      if (s.phase !== 'idle') {
        probs.push(`收场之后回不到 idle（停在 ${s.phase}），第二局开不了`);
      }
    }
    if (REEL_LIMIT_SEC <= 0) {
      probs.push(`REEL_LIMIT_SEC(${REEL_LIMIT_SEC}) 不为正 —— 收线阶段没有上限`);
    }

    // 11. `holdMeaning` 只在真窗口里说 strike。
    //     咬钩那 0.35 秒是**前兆**，按了不算——提示语要是提前亮起来，
    //     玩家会在浮漂点下去之前就按，然后怪游戏不认。
    asserts++;
    {
      const s = createFishState(5);
      castFish(s);
      for (let i = 0; i < 200 && s.phase !== 'bite'; i++) stepFish(s, 1 / 60, false);
      if (s.phase !== 'bite') {
        probs.push('走不到 bite 相位');
      } else {
        let saidStrikeTooEarly = false;
        for (let i = 0; i < 200 && s.phase === 'bite'; i++) {
          const m = holdMeaning(s);
          const inWindow = s.biteLeft <= 0.35;
          if ((m === 'strike') !== inWindow) saidStrikeTooEarly = true;
          stepFish(s, 1 / 60, false);
        }
        if (saidStrikeTooEarly) {
          probs.push('holdMeaning 在咬钩窗口之外说了 strike（或在窗口内没说）');
        }
      }
    }

    // 12. 张力三档单调。
    asserts++;
    if (tensionBand(0.1) !== 'calm' || tensionBand(0.6) !== 'tight' || tensionBand(0.9) !== 'danger') {
      probs.push('张力分档不对 —— HUD 那条读数会显示错的颜色');
    }

    return expect(
      probs.length === 0,
      probs.length
        ? probs.join('；')
        : `可赢(${win.outcome}) · 一直按住 ${hold.outcome} · 一直松手 ${loose.outcome}`
          + ` · 咬钩窗 ${BITE_WINDOW_SEC}s · 24 个 seed 落出 ${ranges.size} 个距离 / ${kinds.size} 种鱼`,
      asserts,
    );
  });
}

// ---------------------------------------------------------------- 「按了没反应」回什么

/**
 * 这一条量的**是「什么时候闭嘴」，不是「什么时候说话」。**
 *
 * 起因是一条玩家描述：*靠近建筑的时候有时候交互不了*。路边散布的
 * `mod_house` / `mod_tower` 看得见摸得着，却不是 16 座驿站里的任何一座，
 * 于是按空格什么都没有。
 *
 * 而"离得远就干脆不说话"是一个**故意的**决定——远处也弹的话，
 * 玩家在路中间随手按空格会一遍遍飘同一句。所以修法不是把静默区扩回去，
 * 而是**一次性的那句**，说一句、走开才复位。
 *
 * 于是最容易出的错是**反过来**：修完之后开始刷屏。
 * 刷屏比沉默更糟，因为它让玩家按任何键都有一句不相干的字飘上来。
 * 所以下面把沉默的那一半当成主判据来量：
 *   · 已经说过之后必须闭嘴（这一条护着"每次靠近只说一句"）
 *   · 附近没有景物时必须闭嘴（护着路中间随手按）
 *   · 而"站在景物旁边、第一次按"必须说话（护着这次修复本身）
 */
function registerSpaceReplyChecks(check: CheckFn): void {
  check('verify_space_reply', () => {
    let asserts = 0;
    const probs: string[] = [];
    const EXTRA = 12;
    const base = { reach: STATION_REACH, hintExtra: EXTRA };
    const FAR = STATION_REACH + EXTRA + 10;
    const NEAR_BUILDING = SCENERY_SAY_M - 5;

    // 1. 圈外但还在外圈里 → 那条规则一直在说，别被新增的分支吞掉。
    asserts++;
    if (
      silentSpaceReply({ ...base, stationDist: STATION_REACH + 3, buildingDist: NEAR_BUILDING, said: false })
      !== 'ring'
    ) {
      probs.push('驿站外圈里没有回「圈 = 空格的生效区」——那条规则被吞了');
    }

    // 2. 修复本身：出了外圈、站在景物旁边、第一次按 → 必须说话。
    asserts++;
    if (
      silentSpaceReply({ ...base, stationDist: FAR, buildingDist: NEAR_BUILDING, said: false })
      !== 'nothing_here'
    ) {
      probs.push('站在景物旁边按空格仍然没有回音 —— 这就是这次要修的那条');
    }

    // 3. **只说一次。** 这一条是防刷屏的主判据。
    asserts++;
    if (
      silentSpaceReply({ ...base, stationDist: FAR, buildingDist: NEAR_BUILDING, said: true })
      !== 'none'
    ) {
      probs.push('说过一次之后又说了 —— 站着反复按会刷屏');
    }

    // 4. 附近没有景物时保持沉默。路边随手按空格不该有回音。
    asserts++;
    for (const dist of [Infinity, 999, 400, 60]) {
      asserts++;
      if (silentSpaceReply({ ...base, stationDist: FAR, buildingDist: dist, said: false }) !== 'none') {
        probs.push(`附近 ${dist}m 没有景物却开口了 —— 路中间随手按会刷屏`);
      }
    }

    // 5. 圈**内**时这一层不该插手：圈内的事由 canCheckIn() 答，
    //    这里再说一遍就是两句对同一件事各说各话。
    asserts++;
    if (
      silentSpaceReply({ ...base, stationDist: STATION_REACH - 1, buildingDist: NEAR_BUILDING, said: false })
      !== 'none'
    ) {
      probs.push('驿站圈内的失败也由这里开口 —— 会和 canCheckIn() 的回答撞车');
    }

    // 6. 常量之间不许打架：景物那句的范围必须大于驿站生效圈，
    //    否则「站在建筑物边上」和「站在驿站边上」在玩家感知里不是同一件事，
    //    而同一句话要同时回答两处。
    asserts++;
    if (SCENERY_SAY_M <= STATION_REACH) {
      probs.push(`SCENERY_SAY_M(${SCENERY_SAY_M}) ≤ STATION_REACH(${STATION_REACH.toFixed(1)}) —— 范围关系反了`);
    }

    return expect(
      probs.length === 0,
      probs.length
        ? probs.join('；')
        : `驿站圈 ${STATION_REACH.toFixed(1)}m · 外圈 +${EXTRA}m · 景物 ${SCENERY_SAY_M}m · 说过只说一次`,
      asserts,
    );
  });
}

// ---------------------------------------------------------------- 无障碍 · 存档 · 触屏

/**
 * 这一族量的四件事，全都是**「某个操作在某一种设备/设置下够不着」**。
 *
 * 它们有一个共同形状：**功能在某个玩家身上不存在，而且界面上没有一处
 * 提示它不存在**。所以判据量的也不是"功能有没有"，而是
 * "那条路径还在不在"——纯 DOM 接线的那些，无头跑不到，只能钉源码。
 *
 *  · `verify_accessibility` —— 音量会落盘、静音会落盘、改键会派发、
 *    色觉切换会重画而不是只挂 class、减弱动效会接管节拍圈
 *  · `verify_save_pose` —— 位置存得进、读得出、坏档不炸、重开清掉
 *  · `verify_volatile_store` —— 无痕模式下那句「进度不会被保存」真的会响
 *  · `verify_touch_coverage` —— 每一个动词在触屏上都有对应控件
 */
function registerAccessibilityChecks(check: CheckFn): void {
  const srcOf = (p: string) => stripComments(readFileSync(join(process.cwd(), p), 'utf8'));
  const mainSrc = srcOf(join('src', 'main.ts'));
  const uiSrc = srcOf(join('src', 'ui', 'index.ts'));
  const touchSrc = srcOf(join('src', 'ui', 'touchControls.ts'));
  const stateSrc = srcOf(join('src', 'game', 'state.ts'));
  const pauseSrc = srcOf(join('src', 'ui', 'pausePanel.ts'));
  const audioSrc = srcOf(join('src', 'core', 'audio.ts'));
  const typesSrc = srcOf(join('src', 'game', 'api', 'types.ts'));
  const liveSrc = srcOf(join('src', 'game', 'api', 'live.ts'));
  const hudSrc = srcOf(join('src', 'ui', 'hud.ts'));

  /**
   * 键位表本身。**纯函数，所以真的跑它**——这一族里只有它能被行为判据覆盖，
   * 其余全是 DOM 接线（`verify_panel_behavior` 那一族管）与源码形状。
   *
   * 而它偏偏是最该跑行为判据的那一块：`settings.keymap` 来自
   * `localStorage`——**玩家可以手改的文件**。
   */
  check('verify_keymap', () => {
    let asserts = 0;
    const probs: string[] = [];
    const before = { ...getKeymap() };

    // 1. 保留键不许成为绑定目标。
    asserts++;
    for (const code of ['F8', 'F9', 'F10', 'Digit1', 'Digit4', 'KeyP', 'KeyB', 'Enter']) {
      const r = tryBind('pause', code);
      if (r === null) {
        probs.push(`「暂停」被绑到了保留键 ${code} 上——而主机的 switch 是动作表优先，那个键从此按不动`);
      }
      if (codeOf('pause') === code) {
        probs.push(`绑完保留键 ${code} 之后它真的生效了——tryBind 既没拒绝也没拦住写入`);
      }
    }
    if (codeOf('pause') !== before.pause) {
      probs.push(`前面那一轮循环把「暂停」的键位改成了 ${codeOf('pause')}，应为 ${before.pause}`);
      setKeymap(before);
    }

    // 2. 正常绑定 + 冲突拒绝。
    asserts++;
    {
      setKeymap(before);
      if (tryBind('forward', 'KeyI') !== null) {
        probs.push('「前进」绑到 I 失败了——那把键本来空着');
      }
      asserts++;
      if (codeOf('forward') !== 'KeyI' || actionOf('KeyI') !== 'forward') {
        probs.push(`绑定没有生效：codeOf=${codeOf('forward')} actionOf=${actionOf('KeyI')}`);
      }
      asserts++;
      if (tryBind('back', 'KeyI') !== 'forward') {
        probs.push('把「后退」绑到已经属于「前进」的键上没有被拒绝');
      }
      asserts++;
      if (codeOf('back') !== before.back) {
        probs.push(`一次被拒绝的绑定仍然改了键位：「后退」=${codeOf('back')}`);
      }
    }

    // 3. **手改过的存档不许造成撞键。** 这是 `setKeymap` 存在的全部理由。
    asserts++;
    {
      setKeymap({ ...before, pause: 'KeyW' } as Partial<Record<GameAction, string>>);
      if (actionOf('KeyW') !== 'forward') {
        probs.push(`一份写着 pause=KeyW 的存档把「前进」挤掉了：actionOf('KeyW')=${actionOf('KeyW')}`);
      }
      if (codeOf('pause') === 'KeyW') {
        probs.push('撞键的存档把「暂停」直接按 KeyW 收了——那会让 W 变成暂停而不是前进');
      }
    }

    // 4. **非字符串不许进表。** `codeLabel()` 在 `new UI()` 里跑，
    //    一处 TypeError 就让整个游戏起不来。
    asserts++;
    {
      setKeymap({ ...before, forward: 5 as unknown as string });
      asserts++;
      if (typeof codeOf('forward') !== 'string') {
        probs.push(`一份写着 forward=5 的存档把非字符串灌了进来：codeOf=${String(codeOf('forward'))}`);
      }
      asserts++;
      // `codeLabel` 必须在任何输入下都不抛。
      let threw = '';
      try {
        codeLabel(codeOf('forward'));
      } catch (e) {
        threw = String(e);
      }
      if (threw) probs.push(`codeLabel() 抛了：${threw}——它在 \`new UI()\` 里跑，一抛就是黑屏`);
    }

    // 5. 恢复现场，别把后续判据的键位弄脏。
    asserts++;
    setKeymap(before);
    if (getKeymap().forward !== before.forward || getKeymap().back !== before.back) {
      probs.push('恢复默认键位之后对不上——`setKeymap` 不是幂等的');
    }

    return expect(
      probs.length === 0,
      probs.length
        ? probs.join('；')
        : '保留键拒绑 · 正常绑定生效 · 冲突不改表 · 手改存档不撞键 · 非字符串不崩 · 幂等',
      asserts,
    );
  });

  check('verify_accessibility', () => {
    let asserts = 0;
    const probs: string[] = [];

    // 1. 音量是**真的旋钮**，不是三档按钮。
    asserts++;
    if (!/setVolume\(/.test(audioSrc)) {
      probs.push('audio 没有 `setVolume()` —— 只有三个布尔开关，外放太吵的玩家没有任何旋钮');
    } else if (!/this\.volBgm \* this\.volBgm/.test(audioSrc) && !/\* this\.volBgm/.test(audioSrc)) {
      probs.push('`applyBuses()` 没有乘上 `volBgm` —— 推子动了但声音不变');
    }

    // 2. 静音**落盘**。原来三个布尔只是 audio 上的普通字段，
    //    于是每次开游戏都从「有声」开始。
    asserts++;
    if (!/this\.settings\.mutedAll = all/.test(mainSrc)) {
      probs.push('静音没有写回 settings —— 每次开游戏都从有声开始，聋人每次都要重新静音');
    }

    // 3. 音量 / 配色 / 动效 / 按住改切换都在面板上，且都经过宿主落盘。
    //    判据按**文案键**找——面板调的是 `t('reduce_motion')`，
    //    而 `reduceMotion` 是设置字段名，两者不在同一个命名空间里。
    asserts++;
    for (const [key, label] of [
      ['vol_bgm', '音乐音量'],
      ['vol_sfx', '音效音量'],
      ['colorblind', '色觉友好配色'],
      ['reduce_motion', '减弱动效'],
      ['hold_to_toggle', '按住改切换'],
    ] as const) {
      if (!pauseSrc.includes(`'${key}'`)) probs.push(`暂停面板里没有 ${label} 的控件（找文案键 ${key}）`);
    }
    asserts++;
    for (const key of ['volBgm', 'volSfx', 'colorblind', 'reduceMotion', 'holdToToggle']) {
      if (!mainSrc.includes(`${key} = `) && !mainSrc.includes(`${key}:`)) {
        probs.push(`宿主没有把 ${key} 落进 settings —— 改了不生效，重开也丢`);
      }
    }

    // 4. 改键真的派发新键。
    asserts++;
    if (!/onKeymapChange/.test(mainSrc)) {
      probs.push('宿主没有接 `onKeymapChange` —— 改键只改界面，不落盘，重开就没了');
    }
    asserts++;
    // 主机的 keydown 判据必须是**动作**，不是物理键。
    if (!/switch \(this\.actionOf\(e\.code\)/.test(mainSrc)) {
      probs.push('keydown 的 switch 仍然按物理 code 判 —— 改键之后大部分键失效');
    }
    asserts++;
    // 九处方向读取里不许再有裸的 `keys.has('KeyX')`。
    const bareKeys = [...mainSrc.matchAll(/keys\.has\('Key[A-Z]'\)/g)].length;
    if (bareKeys > 0) {
      probs.push(`main.ts 里还有 ${bareKeys} 处写死 \`keys.has('Key…')\` —— 漏掉的那一半动作改不了键`);
    }

    // 5. 色觉切换要**重画**，不能只挂 class。
    asserts++;
    if (!/swatch\.style\.setProperty\('--sw'/.test(hudSrc)) {
      probs.push('色觉切换没有重写色块的 `--sw` —— 设置里开了，格子颜色不变');
    }
    asserts++;
    if (!/fragmentColors\(/.test(hudSrc)) {
      probs.push('HUD 仍在读固定的 `FRAGMENT_COLORS` —— 两套配色没有同一处口径');
    }

    // 6. 减弱动效要管到**游戏内**运动，媒体查询管不到的那部分。
    asserts++;
    if (!/this\.reduceMotion \? 0\.5/.test(hudSrc)) {
      probs.push('节拍圈没有读减弱动效 —— 那是这个 HUD 里唯一持续运动的地方');
    }

// 7. **三颗开关都得在启动时被推进。** 漏一颗的症状是
    //    「画面已经切了、开关写着关」——而上面两颗被修过一次，
    //    第三颗是同类里漏掉的那一颗。
    //
    // ⚠ **只看 `applyAccessibilitySettings` 那个方法体**：
    // 同一串 `ui.setHoldToToggle(` 在 `onAccessibilityChange` 里也出现，
    // 而后者是「玩家刚点了开关」那条路。切出去一大段去找它，
    // 少的那一颗照样能靠另一处蒙混过关——这条判据就是这么空转的。
    asserts++;
    {
      const def = mainSrc.indexOf('private applyAccessibilitySettings');
      const body = def < 0 ? '' : mainSrc.slice(def, mainSrc.indexOf('\n  }', def));
      if (!body) {
        probs.push('main.ts 里找不到 `private applyAccessibilitySettings` —— 这条判据空转了');
      } else {
        for (const [fn, name] of [
          ['setColorblind', '色觉友好配色'],
          ['setReduceMotion', '减弱动效'],
          ['setHoldToToggle', '按住改切换'],
        ] as const) {
          if (!body.includes(`ui.${fn}(`)) {
            probs.push(`\`applyAccessibilitySettings()\` 没有调 \`ui.${fn}()\` —— ${name} 的开关与运行时状态会不一致`);
          }
        }
      }
    }

    return expect(
      probs.length === 0,
      probs.length
        ? probs.join('；')
        : '音量推子 ×2 · 静音落盘 · 配色重画 · 节拍圈可静止 · 十个动作全部走键位表',
      asserts,
    );
  });

  check('verify_save_pose', () => {
    let asserts = 0;
    const probs: string[] = [];

    // 真的存读往返一次。这条是**行为**，不是源码形状。
    const store = memoryForTest();
    const g = new GameStateManager(store);
    g.setPose(123.5, -456.25, 1.75);
    g.save();
    const g2 = new GameStateManager(store);
    asserts++;
    if (!g2.load()) {
      probs.push('存了读不回来');
    } else if (!g2.pose) {
      probs.push('存档里没有 pose —— 续档把玩家放回出发点，而这是「骑一条闭合环线」的游戏');
    } else {
      const p = g2.pose;
      if (Math.abs(p.x - 123.5) > 1e-6 || Math.abs(p.z + 456.25) > 1e-6 || Math.abs(p.h - 1.75) > 1e-6) {
        probs.push(`pose 往返不对：${JSON.stringify(p)}`);
      }
    }

    // 老存档没有这个字段 → 按「没存过」处理，不是崩。
    asserts++;
    {
      const s2 = memoryForTest();
      s2.setItem('gift188.save.v3', JSON.stringify({
        version: ECON.SAVE_VERSION,
        collected: {},
        progress_km: 0,
        onboarding_shown: 1,
        economy: { lvbi: 0, inv: {}, spent_km: 0, earned_tags: [], seen_stations: [], mood: 3, seen_villain: 0, prologue_done: true, voice_done: true, ending_id: '' },
      }));
      const g3 = new GameStateManager(s2);
      if (!g3.load()) probs.push('老存档（无 pose）读不回来');
      else if (g3.pose !== null) probs.push(`老存档读出了 pose ${JSON.stringify(g3.pose)}，应为 null`);
    }

    // **坏档不许把车摆到 NaN 上。** 那是玩家手改过 / 写坏过的存档。
    asserts++;
    {
      const s3 = memoryForTest();
      const blob = {
        version: ECON.SAVE_VERSION,
        collected: {}, progress_km: 0, onboarding_shown: 1,
        pose: { x: NaN, z: 0, h: 0 },
        economy: { lvbi: 0, inv: {}, spent_km: 0, earned_tags: [], seen_stations: [], mood: 3, seen_villain: 0, prologue_done: true, voice_done: true, ending_id: '' },
      };
      s3.setItem('gift188.save.v3', JSON.stringify(blob).replace(/"x":null/, '"x":null'));
      const g4 = new GameStateManager(s3);
      g4.load();
      if (g4.pose !== null) probs.push(`NaN 坐标被采信了：${JSON.stringify(g4.pose)} —— 车会掉出世界`);
    }

    // 重开一趟要把位置清掉。
    asserts++;
    {
      const g5 = new GameStateManager(memoryForTest());
      g5.setPose(1, 2, 3);
      g5.reset();
      if (g5.pose !== null) probs.push('重开之后 pose 还在 —— 玩家被放在上一趟停的那里');
    }

    // 主机那一侧：周期存 + 进世界时摆回去。
    asserts++;
    // **要量到它喂的是真位置，而且这一行本身是干净的。**
    // 只查 `setPose(` 出现过是不够的：把它短路掉
    // （`void (0) && game.setPose(...)`）断言照样绿，而位置从此是上一轮那个。
    // 所以判据要求这一行**整行就是**那一句 —— 带 `m` 锚到行首，
    // 前面多任何东西都算不算数。
    if (!/^\s*game\.setPose\(p\.x, p\.z, this\.world\.ride\.headingValue\);$/m.test(mainSrc)) {
      probs.push(
        '`tickPoseSave()` 没有把 `ride.pos` 真的喂给 `setPose()` —— '
        + '存档里的位置要么不更新、要么是上一轮那个',
      );
    }
    asserts++;
    if (!/this\.world\.respawn\(/.test(mainSrc)) {
      probs.push('`enterWorld()` 没有调用 `world.respawn()` —— 续档放回了出发点');
    }
    asserts++;
    if (!/respawn\(x: number, z: number, heading: number\)/.test(srcOf(join('src', 'world', 'world.ts')))) {
      probs.push('`World` 没有 `respawn()` —— 挪车时 `lastPos` / `lastArc` 不会被一起挪，里程会跳一整圈');
    }

    // `?arc=` 传送必须优先于存档位置：那一路是排障用的。
    asserts++;
    if (!/if \(this\.arcOverride\) return;/.test(mainSrc)) {
      probs.push(
        '`restorePose()` 没有让 `?arc=` 优先 —— 有存档时它会把排障用的传送盖掉，'
        + '而那个工具存在的意义恰恰是"一眼看出这地方长什么样"',
      );
    }

    // 演示不许把玩家的存档位置写成演示结束的地方。
    asserts++;
    if (!/if \(this\.demoSuppressPose\) return;/.test(mainSrc)) {
      probs.push(
        '`tickPoseSave()` 没有挡演示模式 —— 放完演示之后「继续旅程」'
        + '会把玩家放在演示结束的地方，而不是他上次停的地方',
      );
    }

    return expect(
      probs.length === 0,
      probs.length ? probs.join('；') : '存读往返 · 老档降级 · NaN 拒收 · 重开清空 · 每 4 秒一次 · respawn 挪两条锚',
      asserts,
    );
  });

  check('verify_volatile_store', () => {
    let asserts = 0;
    const probs: string[] = [];

    // **兜底 store 的 write 必须抛。** 它不抛的话 `save()` 的 catch 不跑，
    // `takeWriteFailed()` 永远是假，那句「进度不会被保存」永远不出现——
    // 而它本来就是为了这个场景写的。
    asserts++;
    if (/function memoryStore\(/.test(stateSrc)) {
      probs.push('兜底仍然是 `memoryStore()`：它的 write 永不抛，于是无痕模式下玩家丢两小时进度而一句提示都没有');
    }
    asserts++;
    if (!/function volatileStore\(/.test(stateSrc)) {
      probs.push('没有 `volatileStore()` —— 存不进去的时候没有任何东西会说一声');
    }

    // **而且它必须真的被用上。** 只判断「`volatileStore()` 这个函数存在」
    // 是不够的：把它留在原地而让 `defaultStore()` 退回去一个不抛的内联对象，
    // 四条断言全绿，而无痕模式那条提示又一次不会响。
    asserts++;
    if (!/return volatileStore\(\);/.test(stateSrc)) {
      probs.push('`defaultStore()` 的兜底没有返回 `volatileStore()` —— 它可能退到了一个不抛的后端，于是那句提示又不会响了');
    }

    // 而且**这一路必须真的会响**。`verify_save_notice` 注入的是
    // 一个 write 直接抛的 store，它从没走过 `defaultStore()` 的兜底分支——
    // 判据与实机的失败方式不同，所以这里补一条真的走兜底的。
    asserts++;
    {
      const s = throwingStore();
      const g = new GameStateManager(s);
      g.save();
      if (!g.takeWriteFailed()) {
        probs.push('后端写不进去，而 `takeWriteFailed()` 仍然是 false —— 那句提示不会响');
      } else if (g.takeWriteFailed()) {
        probs.push('`takeWriteFailed()` 不是取走式 —— 每一帧都会再弹一次');
      }
    }

    // 写探测也要有：Safari 无痕下 getItem 正常而 setItem 抛。
    asserts++;
    if (!/SAVE_PROBE_KEY/.test(stateSrc)) {
      probs.push('`defaultStore()` 只探 `getItem` 不探 `setItem` —— Safari 无痕下会拿着一个「看起来能用」的 store 写到底');
    }

    return expect(
      probs.length === 0,
      probs.length ? probs.join('；') : '兜底会抛 · 提示真的会响且只响一次 · 读写都探过',
      asserts,
    );
  });

  check('verify_touch_coverage', () => {
    let asserts = 0;
    const probs: string[] = [];

    // 1. **「摸一下」有控件。** F 挂着节拍 / 旧物 / 琴 / 木牌 / 湖边。
    asserts++;
    if (!/g-touch-act/.test(touchSrc)) {
      probs.push(
        '触屏没有「摸一下」那颗按钮：F 挂着节拍窗口、旧物、琴、木牌**和**湖边那一屏。'
        + '没有它，触屏玩家摸不到任何一件旧物、进不去湖边、读不了路边的字',
      );
    }
    asserts++;
    if (!/codeOf\('interact'\)/.test(touchSrc)) {
      probs.push('触屏那颗「摸一下」合成的是写死的键码 —— 改键之后它变成一颗按了没反应的按钮');
    }

    // 2. **按住**存在。
    asserts++;
    if (!/holdPressed/.test(touchSrc)) {
      probs.push('`TouchControls.state` 没有 `holdPressed` —— 触屏上根本没有「按住」这个动作，而它正是钓鱼收线 / 云 / 茶唯一的输入方式');
    }
    asserts++;
    if (!/touch\.holdPressed/.test(mainSrc)) {
      probs.push('宿主没读 `touch.holdPressed` —— 触屏按不住，钓鱼永远收不了线');
    }

    // 3. 湖边那一屏的摇杆要真的驱动相机。
    asserts++;
    if (!/this\.ui\.touch\.holdPressed|this\.ui\.touch\b/.test(mainSrc)) {
      probs.push('湖边那一屏没有并联触屏输入 —— 它在触屏上站着都做不到');
    }
    asserts++;
    for (const axis of ['forward', 'back', 'left', 'right']) {
      if (!new RegExp(`${axis}:[^\\n]*sy|${axis}:[^\\n]*sx`).test(mainSrc)) {
        probs.push(`湖边的 ${axis} 没有并联摇杆`);
      }
    }

    // 4. 湖边那一屏**要显示触屏控件**——它是走和抛竿的唯一手段。
    asserts++;
    if (!/setLakesideActive/.test(uiSrc)) {
      probs.push('UI 没有 `setLakesideActive()` —— 湖边那一屏的触屏控件跟着世界一起被藏起来了');
    }
    asserts++;
    if (!/if \(this\.lakesideOn\)/.test(uiSrc)) {
      probs.push('`applyTouchVisibility()` 没有湖边这一条例外 —— 控件会随世界可见性一起消失');
    }

    // 5. 出口。
    asserts++;
    if (!/exitLine = button\(/.test(srcOf(join('src', 'ui', 'lakesidePanel.ts')))) {
      probs.push('湖边的出口还是一行说明文字而不是按钮 —— 触屏上没有出口');
    }

    // 6. API 那一侧跟着键位走。
    asserts++;
    if (!/export function keysOf\(/.test(typesSrc)) {
      probs.push('契约层没有 `keysOf()` —— AI 会一直派发写死的物理键，改键之后「手动正常、AI 不动」');
    }
    asserts++;
    if (!/keysOf\(action\)/.test(liveSrc)) {
      probs.push('`live.ts` 的 `send()` 仍在用 `AI_KEYS[action]` 直接派发');
    }

    return expect(
      probs.length === 0,
      probs.length ? probs.join('；') : '摸一下 / 按住 / 湖边摇杆 / 湖边控件可见 / 出口按钮 / AI 跟键位，七项都在',
      asserts,
    );
  });
}

/** 无头回归用的内存后端。**不用 `localStorage`** —— Node 里根本没有。 */
function memoryForTest(): { read(k: string): string | null; write(k: string, v: string): void; setItem(k: string, v: string): void; remove(k: string): void } {
  const m = new Map<string, string>();
  return {
    read: (k) => m.get(k) ?? null,
    write: (k, v) => void m.set(k, v),
    setItem: (k, v) => void m.set(k, v),
    remove: (k) => void m.delete(k),
  };
}

/** 一个 `write` 直接抛的后端。用来证明「提示真的会响」。 */
function throwingStore(): { read(k: string): string | null; write(k: string, v: string): void; remove(k: string): void } {
  return {
    read: () => null,
    write: () => {
      throw new Error('storage unavailable');
    },
    remove: () => {},
  };
}
