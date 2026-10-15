/**
 * 阶段机 —— 纯逻辑，不碰 DOM，不碰 three。
 *
 * 单独成文件是因为它咬过人一次，而且症状极具欺骗性：
 * 引导页的「开始骑行」直接调了 UI 的 `enterWorld()`，没通知宿主，
 * 于是宿主 `phase` 停在 `'onboarding'`，`canRide` 恒为假，车速被钉在 0。
 * 界面上 HUD 在、小地图在、世界在转、演示还能自己骑——**只有"车不动"**，
 * 而键盘与摇杆走同一条链路，所以两个都失效，看起来像输入系统坏了。
 *
 * 一个"动词失效但画面正常"的 bug 不该只能靠人肉看出来。所以：
 * 判定收在这里（可测），阶段在性能面板上可见（可现场读）。
 *
 * 末尾的 `demoInput()` 是同一件事的另一个实例：**演示模式那辆车自己往前骑**。
 * 它也写成纯函数、由 `verify_demo_drive` 在 Node 里真的闭环跑一遍——
 * 判据写在 `main.ts` 里的话，车往草地里开这件事没人能提前知道。
 *
 * 它要读中心线（`data/route`），所以本文件不再是零依赖：
 * 但那两个模块都是纯计算，不碰 DOM、不碰 three，这个前提没变。
 */
import { clamp, TAU } from '../core/math';
import { STATION_ROAD_MAX_DIST, TOTAL_ARCLENGTH, pointAtArcLength } from '../data/route';

export type Phase =
  | 'boot' | 'title' | 'onboarding' | 'roaming' | 'paused'
  | 'checkin' | 'minigame' | 'synthesis' | 'endcard'
  /**
   * 湖边一屏。**它不在 `isInWorld()` 里** —— 主世界的 HUD 在这一屏不显示，
   * 而那一屏有自己的读数。放进去的话，骑行 HUD 会浮在一片湖岸上。
   */
  | 'lakeside';

/**
 * 允许的相位迁移。**这张表是"声明"，不是"闸门"。**
 *
 * ## 它挡的是什么
 *
 * `main.ts` 原来在**十一处**直接写 `this.phase = …`。于是"现在能处于哪些相位、
 * 谁负责切、哪些切换是没人想过的"这件事没有任何一处能一眼看完——
 * 想回答它只能把十一个赋值点连同它们各自的守卫条件一起读一遍。
 *
 * 现在所有写入都走宿主里的 `goPhase()` 一个入口，而那张入口表在这里。
 * 以后加一条边，是往这张表里添一行；漏了，`verify_phase` 会红。
 *
 * ## 为什么**不**在运行时拒绝表外的迁移
 *
 * 因为宿主（`main.ts`）在无头环境里构造不出来，本项目的回归**跑不到它**。
 * 一张靠"跑一遍才知道全不全"的表去**拒绝**运行时迁移，等于把一个
 * 我从未观察过的行为变成硬失败——而这条重构的承诺是"行为不变"。
 *
 * 所以它只声明、不拦截。真正的强制点是**静态**的那条：宿主里
 * `this.phase =` 只允许出现一次（就在 `goPhase()` 里）。新写的迁移
 * 必须先过 `goPhase()`，于是它必然被这张表收编或被回归抓住。
 */
export const PHASE_EDGES: ReadonlySet<string> = new Set([
  // 开场
  'boot>title',
  'title>onboarding',
  'onboarding>roaming',
  // 骑行 / 暂停。`paused → roaming` 与 `roaming → roaming` 都真的走过：
  // 后者是 `toRoaming()` 的幂等形态（小游戏目标不存在、打卡完直接收尾）。
  'roaming>paused',
  'roaming>roaming',
  'paused>roaming',
  // 站定办事。铺子复用 `checkin`（`verify_phase` 的占用集合里已经有它）。
  'roaming>checkin',
  'checkin>roaming',
  'checkin>synthesis',
  'checkin>minigame',
  'checkin>endcard',
  'minigame>roaming',
  // 收尾
  'synthesis>roaming',
  'synthesis>endcard',
  // `finishRun()` 有三个调用点，演示那一路是从 `roaming` 直接跳结算页。
  'roaming>endcard',
  'endcard>roaming',
  // 湖边一屏。进出都是**玩家主动**的，没有超时兜底——
  // 而这一条恰恰是最容易变成"按了没反应"的地方，所以它必须有边。
  'roaming>lakeside',
  'lakeside>roaming',
]);

/** 这一条迁移在表里吗。 */
export function canGoPhase(from: Phase, to: Phase): boolean {
  return PHASE_EDGES.has(`${from}>${to}`);
}

/** 相位表的边两端都必须是真相位——写错一个字母，这条边会静默地永远匹配不上。 */
export function phaseEdgeErrors(): string[] {
  const all = new Set<Phase>([
    'boot', 'title', 'onboarding', 'roaming', 'paused',
    'checkin', 'minigame', 'synthesis', 'endcard', 'lakeside',
  ]);
  const bad: string[] = [];
  for (const e of PHASE_EDGES) {
    const [from, to] = e.split('>');
    if (!all.has(from as Phase)) bad.push(`「${e}」的起点 ${from} 不是相位`);
    if (!all.has(to as Phase)) bad.push(`「${e}」的终点 ${to} 不是相位`);
  }
  return bad;
}

/**
 * 从 `boot` 出发走不到的**边的起点**。
 *
 * 存在的意义是**让表自己腐烂时响**。一张只增不减的迁移表迟早会攒下
 * 永远走不到的边（某条路改了、某一整段删了），而多出来的边看上去和
 * 其余的一样"对"，没有判据的话它会一直躺着骗人——直到有人照着它去接线。
 *
 * 量的是**起点**而不是终点：BFS 沿着所有边走，所以只要起点可达，
 * 终点就一定进 `seen`。反过来，一条起点本身就没人到不了的边，
 * 它连走都不会被走到，正是要抓的那种。
 */
export function phaseReachErrors(): string[] {
  const adj = new Map<Phase, Phase[]>();
  for (const e of PHASE_EDGES) {
    const [from, to] = e.split('>') as [Phase, Phase];
    const list = adj.get(from);
    if (list) list.push(to);
    else adj.set(from, [to]);
  }
  const seen = new Set<Phase>(['boot']);
  const q: Phase[] = ['boot'];
  while (q.length) {
    const cur = q.shift() as Phase;
    for (const nx of adj.get(cur) ?? []) {
      if (!seen.has(nx)) {
        seen.add(nx);
        q.push(nx);
      }
    }
  }
  const bad: string[] = [];
  for (const from of adj.keys()) {
    if (!seen.has(from)) bad.push(`「${from}>… 」的起点从 boot 走不到——这条边永远不会发生`);
  }
  return bad;
}

export interface CanRideInput {
  phase: Phase;
  /** 打卡按钮这一帧是否刚被按下（按住时不该同时骑行） */
  checkInPressed: boolean;
  /** 剧情对白 / 反派戏播放中 */
  narrativeBusy: boolean;
  /** 打卡过场（镜头接管）进行中 */
  checkInStage: 'none' | 'prompt' | 'moving' | 'holding' | 'outro' | 'busy';
}

/**
 * 玩家这一帧能不能推油门。
 *
 * 六个条件里，**`phase === 'roaming'` 是唯一一个"UI 看不见"的**——
 * 另外五个都能在界面上找到对应的样子（面板开着、对白框亮着、镜头在转）。
 * 所以它也是最容易漏接、而后果最严重的一个。
 */
export function canRide(i: CanRideInput): boolean {
  if (i.phase !== 'roaming') return false;
  if (i.checkInPressed) return false;
  if (i.narrativeBusy) return false;
  if (i.checkInStage !== 'none') return false;
  return true;
}

/** UI 是否应当显示世界 HUD。**必须与 `canRide` 的阶段部分同源**，否则又会脱节。 */
export function isInWorld(phase: Phase): boolean {
  return phase === 'roaming' || phase === 'paused' || phase === 'checkin' || phase === 'synthesis';
}

/**
 * 按空格 / 回车 / 指键的确认键，此刻**到底会发生什么**。
 *
 * 导出来是因为这件事在两个地方各写了一份，而它们已经不一致过一次：
 * `main.ts` 的 `onConfirm()` 认 `title` 与 `roaming`，不认 `onboarding`，
 * 而 AI 契约的相位表给 `onboarding` 标着"出路是 advance"。
 * 实机症状最坏：`available: ['advance']` 一直亮着、
 * `tap('advance')` 一直返回 accepted，而游戏永远停在引导页上——
 * **按 150 次都没动**。契约在亮着，游戏在原地，两者都没报错。
 *
 * 而引导页走不出去还有一半是结构原因：它的出口是那颗
 * 「开始骑行」按钮，`wireKeyActivate()` 挂在**元素**上，
 * 所以只有焦点落在按钮上时空格才有用；
 * AI 派发按键是把事件发到 `window` 的，永远到不了那个元素。
 * 因此 `onboarding` 这一档**必须**由宿主自己接住，
 * 而不能指望"按钮会自己响应"。
 *
 * 返回 `null` = 这一屏没有确认键的出路（该相位归 `Escape` 或别的键管）。
 */
export type ConfirmAction = 'startRide' | 'enterWorld' | 'checkIn' | 'fish';

export function confirmAction(phase: Phase): ConfirmAction | null {
  if (phase === 'title') return 'startRide';
  if (phase === 'onboarding') return 'enterWorld';
  if (phase === 'roaming') return 'checkIn';
  /**
   * 湖边这一屏的确认键是**钓鱼**，不是"进入"。
   *
   * 而它的两种用法——"咬钩瞬间点一下"和"收线时按住"——用的是同一个键。
   * `holdMeaning()` 负责把当前这一刻该当哪一种，宿主只管把键按下去。
   * 之所以不拆成两个动作：拆了就必须在 UI 上放两个提示，而两个提示会打架。
   */
  if (phase === 'lakeside') return 'fish';
  return null;
}

/**
 * HUD / 道具栏 / 触屏控件的可见性状态。`isInWorld()` 判的是"该不该显示"，
 * 这个类记的是"DOM 上现在是不是那样"——**两件事，少一件就会漏。**
 *
 * ## 为什么它是一个类，而不是 UI 上的一个 boolean
 *
 * 原来 `ui/index.ts` 上是 `private worldVisible = false` 加一句
 * `if (this.worldVisible === v) return;`。而 DOM 里的 HUD 是**构造出来就可见**的，
 * 于是冷启动时 `showTitle()` 里的 `setWorldVisible(false)` 撞上同值直接返回——
 * **它从来没有真正隐藏过任何东西**：整套顶栏、碎片栏和小地图就那么透在
 * 标题卡后面，一直透到玩家点下「开启旅程」。
 *
 * 症状安静到不需要任何报错：功能全对，只是第一眼像"这游戏已经开始了"。
 * 它能活下来是因为"当前可见性"这个状态**从来没有被谁读过**——
 * 判据量的是别的东西，于是这条路径上没有任何断言。
 *
 * 所以这里把两件事分开记：「当前值」与「是否已经落到 DOM 上」。
 * **第一次请求必须执行**，之后才允许同值早退。
 */
export class WorldVisibility {
  /** DOM 构造出来就是可见的，所以初值必须是 `true`——
   *  取 `false` 的话，第一次 `set(false)` 又会被同值早退吃掉，
   *  也就是原来那个 bug 本身。 */
  private visible = true;
  private applied = false;

  /**
   * 请求切到 `v`。返回 true 表示**这一次真的需要改 DOM**，
   * 调用方据此决定要不要往下走——`setShown` / 道具栏 / 触屏控件都不是免费的。
   */
  set(v: boolean): boolean {
    if (this.applied && this.visible === v) return false;
    this.visible = v;
    this.applied = true;
    return true;
  }

  /** 当前世界 HUD 是否可见。 */
  get value(): boolean {
    return this.visible;
  }

  /** 已经落到 DOM 上了吗。给回归问——原来的 bug 就是它一直 false。 */
  get hasApplied(): boolean {
    return this.applied;
  }
}

// ---------------------------------------------------------------- 结算（不碰 DOM 的那一半）

/** 一局乐事的三种收场。**取消不是失败**，见 `settleTextKey`。 */
export type SettleOutcome = 'win' | 'lose' | 'cancel';

/**
 * 结算屏那一行大字读哪个 key。
 *
 * ## 为什么要有这个函数，而不是让宿主 `result === 'win' ? A : B`
 *
 * `MiniGameResult` 刻意把 `lose`（玩法失败）和 `cancel`（玩家按 Esc）拆成两个值，
 * 而宿主只认 `win`——于是**玩家按 Esc 退出的那一局，屏幕上弹的是「这次没有完成」**。
 * 玩家读到的不是"我取消了"，而是"我失败了"；而他明明什么都没做错。
 * 演示模式跳过小游戏走同一条路：注释写着"中性的一句：它在被跳过，不是在被判负"，
 * 传的却是 `false`——**注释描述的意图和代码做的事不一致**，而且这样活了好几轮。
 *
 * 两个分支各自要一句不同的文案，所以"三态塌成两态"这件事必须有一个显式的落点。
 * 这里就是那个落点，`verify_settle` 守着 `cancel` 不许落回 `mg_failed`。
 */
export function settleTextKey(o: SettleOutcome): 'mg_success' | 'mg_failed' | 'result_cancel' {
  if (o === 'win') return 'mg_success';
  if (o === 'cancel') return 'result_cancel';
  return 'mg_failed';
}

/** 结算屏停留毫秒。赢了给足，输了与取消都快走——站在那儿看"失败"没人愿意。 */
export function settleMs(o: SettleOutcome): number {
  return o === 'win' ? 2100 : 1300;
}

// ---------------------------------------------------------------- 交互

/**
 * 玩家在驿站门口按确认键（空格 / 回车 / 脚下的圈）会发生什么。
 *
 * ## 为什么要有这个函数，而不是让宿主自己 if
 *
 * 因为**同一个判断被两个地方各写一遍时，它们会漂**：
 * 宿主要拿它决定"这一下是开铺子还是打卡"，HUD 要拿它决定"脚下那个圈
 * 写「进入小铺」还是「打卡」，圈要不要出现"。两处任何一处落后于另一处，
 * 症状都是玩家看见一句话、按下空格、什么都没发生。
 *
 * 这个项目已经为同一类问题栽过一次（`state.ts` 文件头：「下一处」在顶栏、
 * 脚下提示圈、小地图三处各找一次，玩家会同时看到三块互相打架的指示牌）。
 * 所以这里让它**只有一个出处**。
 *
 * ## 纯函数是为了可测
 *
 * 判定如果写在 `main.ts` 里，无头回归就问不到它——而这正是它出问题的原因：
 * `tryCheckIn()` 曾经只有「回家」和「打卡」两个分支，**铺子分支根本没写**，
 * 于是三间铺子、10 件商品、明信片的四样材料、灯笼/香囊/清心茶三条机制
 * 全部不可达，而 25 条回归全绿，因为它们量的是"预算紧不紧"，
 * 不是"玩家够不够得着"。
 *
 * 放出来之后 `verify_reach` 能枚举 16 座驿站 × 两种目标，
 * 证明**每一间铺子都真的会被返回**。
 */
export type InteractKind = 'shop' | 'home' | 'checkin' | 'none';

/**
 * 「打卡完必须骑开」这道门。
 *
 * ## 它挡的是什么
 *
 * 打卡是**用同一个键**（空格）触发的，而触发之后玩家往往还站在圈里。
 * 没有这道门，站在圈里连按就能把一座驿站的十次到访在两秒内刷完——
 * 于是「三次到访」这件事和「旅币 / 碎片 / 日期」全部一起失去意义。
 *
 * 所以：**打卡完必须离上一次打卡的位置 ≥ `minDist` 米，才能再打一次。**
 *
 * ## 为什么它是一个纯函数（这一条是修出来的）
 *
 * 原来这道门住在 `World.canCheckIn()` 里，配一个叫 `recheckArmed` 的布尔。
 * 而那个布尔**在全项目里只被写成 `false`、从来没有被写回 `true`**——
 * 它不是"骑开了就重新武装"的闩锁，而是一个一次性熔断：
 *
 * ```
 * 打卡 → recheckArmed = false（且此后再无赋值）
 *      → 之后每一次打卡都退化成「必须离上一次的**打卡位置** 8m」
 * ```
 *
 * 症状：**第二、第三次到访按空格毫无反应。**
 * 而这两次不是可选内容——`MAX_VISITS_PER_STATION = 3` 是完满评级的条件，
 * 顶栏和脚下圈还会主动写「再访 · 还差 2 次」叫玩家回来。
 *
 * 为什么玩家一定会撞上：每一圈都在同一条路上经过同一座驿站，
 * 而圈外能停车的位置就那么几个——**他第二次停的地方和第一次几乎重合**，
 * 于是那个"上一次的打卡位置"离他只有一两米，门一直关着，
 * 弹出来的只有一句 1.4 秒的 `blocked_recheck` toast。
 *
 * 修法不是加一句 `recheckArmed = true`（那要靠"谁负责重新武装"这个
 * 不存在的人来维持），而是让这个函数**自己幂等**：
 * 距离够了就是 `true`，而宿主每帧拿它的返回值回写那个布尔。
 * 于是「重新武装」从一个需要有人记得做的事情，变成这条规则的推论。
 *
 * `armed` 是**已重新武装**的状态，`dist` 是到上一次打卡位置的距离。
 * 两个入参缺一不可：站着不动（`dist` 小）要挡住，骑开了（`armed` 已真）要放行。
 */
export function recheckGate(armed: boolean, dist: number, minDist: number): boolean {
  return armed || dist >= minDist;
}

/** 结算屏落幕之后继续流程时走的那一条。 */
export type AfterCheckIn = 'return-home' | 'maxed' | 'overdue' | 'roaming';

export interface AfterCheckInState {
  /** 五件碎片集齐了没有 */
  allCollected: boolean;
  /** 第一章结算过了没有（集齐之后要回十八驿把它领掉） */
  chapter1Done: boolean;
  /** 五座碎片驿站是否各到访三次 */
  allFragmentsMaxed: boolean;
  /** 日期过没过期 */
  overdue: boolean;
}

/**
 * 小游戏结算屏落幕之后，下一步是哪一条。
 *
 * ## 顺序是这里的活契约
 *
 * `maxed` **必须排在 `overdue` 前面**，而这条以前只活在一段注释里——
 * 论证本身没错，但没有任何东西守着它。把它写成一个能返回答案的纯函数，
 * "那面完满评级墙到底到不到得了"就从一句推理变成一条断言
 * （`verify_after_checkin_route`）。
 *
 * ## 为什么它承重
 *
 * `day = 1 + 3×圈数 + 打卡次数`，刷满五座要 15 次打卡，于是认真玩到第五圈
 * 就已经 `day 31 > 30`：**过期是刷满的必然结果，不是玩家失误**。
 * 所以反过来只要刷满了就一定已经过期——两者不是互斥的两个 if，
 * `maxed` 放在后面的话，那面墙对最该拿到它的人永远关着门。
 *
 * `return-home` 在最前面是另一回事：集齐之后第一章还没结算完，
 * 那时玩家手上什么都还没领，弹什么评级都是空的。
 */
export function afterCheckInRoute(s: AfterCheckInState): AfterCheckIn {
  if (s.allCollected && !s.chapter1Done) return 'return-home';
  if (s.allFragmentsMaxed) return 'maxed';
  if (s.overdue) return 'overdue';
  return 'roaming';
}

export interface InteractInput {
  /** `world.nearby.shopName`：空串 = 面前这座驿站没有铺子 */
  shopName: string;
  /** 面前是不是十八驿 */
  isHome: boolean;
  /** 当前目标是不是「回十八驿」（集齐五件之后） */
  objectiveReturn: boolean;
  /** 这座驿站有没有碎片 */
  hasFragment: boolean;
  /** 这座碎片驿站还欠到访吗 */
  needsVisit: boolean;
  /** 到驿站中心的距离（米） */
  distance: number;
  /** 够得着的距离阈值。**传 `STATION_REACH`**，不要自己再写一份算式。 */
  reach: number;
  /** 打卡过场是否进行中（镜头接管中不抢） */
  busy: boolean;
}

/**
 * 站在路面最远的那条边上，还要留多长一段纵向窗口（米）。
 *
 * 半径恰好等于"驿站到路面最远那条边"时，站在那条边上只有**一个点**
 * 够得着——等于要玩家停在精确的一米上。`STATION_REACH` 取
 * `√(横向² + 纵向²)`，于是那条边上仍有 ±8m 可以按。
 */
export const STATION_REACH_WINDOW = 8;

/**
 * 在路面上够得着驿站的距离（米）。**全项目只有这一个出处。**
 *
 * ## 为什么不再是 `STATION_PASS_RADIUS + TOTAL_HALF_WIDTH`
 *
 * 那个算式（15 + 4 = 19）假设驿站站在路面**边上**，于是"再加一个路半宽"
 * 就盖住了整条路——`hud.ts` 的注释当年就是这么写的（"少一寸玩家会站在圈外
 * 按空格"）。但驿站其实在路面外 20m 量级，所以 19 只盖住了靠驿站那一半，
 * **路面外侧那一截上按空格什么都不会发生**。
 *
 * ⚠ **这里不要写死 `18`。** `18` 是 `ROAD.STATION_OFFSET`（站点基准偏移），
 * 而 `STATION_ROAD_MAX_DIST` 是**算出来的最大值**——广场盘上那座为了不压在
 * 另一条路的沥青上被额外推出去了，于是它比基准偏移远得多（实测 ≈ 22m）。
 * 两者不是同一个数，`verify_space_reply` 量到的生效圈也因此是 **23.4m**
 * 而不是按 18 估的 19.7m。真值只有一个出处：下面那个常量本身。
 *
 * 玩家对这件事的描述只会是"有时候按不动"——因为它取决于你压在这条 8m 宽
 * 路面的哪一侧，而路面上没有任何标记告诉你这条线在哪。
 *
 * 更糟的是它有**六份副本**（`main.ts` / `hud.ts` / `touchControls.ts` /
 * `world.ts` 两处 / 回归两处），所以改一处不会让另外五处跟着对。
 * 现在它们全部读这一个常量，而 `verify_reach` 守它够得着整条路。
 */
export const STATION_REACH = Math.hypot(STATION_ROAD_MAX_DIST, STATION_REACH_WINDOW);

/**
 * 离这么近就当「玩家以为这里站着一栋能进的地方」（米）。
 *
 * 取 25m 是照着 `STATION_REACH ≈ 19.7m` 与那条 12m 外圈定的：
 * 比驿站生效圈大一点、小于外圈，于是「站在建筑物边上」和
 * 「站在驿站边上」在玩家感知里是同一件事——同一句话能回答两处。
 */
export const SCENERY_SAY_M = 25;

/** 按下确认键、什么也没发生时**要不要回一句**，以及回哪一句。 */
export type SilentSpaceReply = 'none' | 'ring' | 'busy' | 'nothing_here';

/**
 * 「按了空格没有任何反应」这一刻该说什么。
 *
 * ## 它治的是哪一个病
 *
 * 玩家骑到路边一栋景物房子旁边（`mod_house` / `mod_tower`——它们**不是**
 * 16 座驿站里的任何一座），按下空格，什么都不发生，界面上一个字也没有。
 * 于是玩家的描述只能是「靠近建筑的时候有时候交互不了」。
 *
 * 而「离得远就干脆不说话」是一个**故意的**决定（见 `main.ts` 那段注释）：
 * 远处也弹的话，玩家在路中间随手按空格会一遍遍飘「这里现在进不去」。
 * 所以修法不能是「把静默区扩回去」，而必须是**边沿触发 + 每次靠近只说一句**
 * ——和 `relicHinted` 是同一个套路：说过的标志在走开之后才复位。
 *
 * ## 为什么判定要在这里
 *
 * 因为这是**一条会被反复撞上的规则**，而规则写在宿主里就没人能问它。
 * 四种结果各自对应一句文案，而「该说哪一句」必须在无头里能验：
 * `verify_space_reply` 量的是「什么时候闭嘴」，那比量「什么时候说话」难得多，
 * 也是防住刷屏的那一半。
 */
export function silentSpaceReply(o: {
  /** 离最近驿站多远（米） */
  stationDist: number;
  /** 驿站生效半径 */
  reach: number;
  /** 有反馈的外圈（米） */
  hintExtra: number;
  /** 离最近的景物建筑多远（米）。**无穷大表示附近没有。** */
  buildingDist: number;
  /** 本次靠近已经说过没有 */
  said: boolean;
}): SilentSpaceReply {
  if (o.stationDist > o.reach) {
    // 圈外但还在外圈里：这是「圈 = 空格的生效区」那条规则，
    // 它一直在说，别因为新增的分支把它吞了。
    if (o.stationDist <= o.reach + o.hintExtra) return 'ring';
    // 出了外圈，又确实站在一栋景物旁边，而这一轮还没说过。
    if (o.buildingDist <= SCENERY_SAY_M && !o.said) return 'nothing_here';
  }
  // 说过了，或者压根没有景物在近旁：**继续闭嘴**。
  return 'none';
}

export function interactAt(i: InteractInput): InteractKind {
  if (i.busy) return 'none';
  if (i.distance > i.reach) return 'none';
  // 收尾那一趟，这一键归回家。0 号驿站同时是十八驿与驿铺，
  // 而明信片的四样材料全在驿铺——但反过来（铺子吃掉回家）
  // 会让第一章永远完不成，所以章节收尾优先。
  if (i.isHome && i.objectiveReturn) return 'home';
  if (i.shopName) return 'shop';
  if (i.hasFragment && i.needsVisit) return 'checkin';
  return 'none';
}

// ---------------------------------------------------------------- 演示驾驶

/**
 * 演示模式的车自己往前骑。
 *
 * ## 原来这里是个假按钮
 *
 * `startDemo()` 原来只做了三件事：解锁音频、放 BGM、把对白设成自动推进。
 * **车不动。** 评审点「演示」之后看到的是一片会呼吸的天空。
 * 一个不能兑现的按钮比没有按钮更糟——它把"这个做不出来"写在了界面上。
 *
 * ## 为什么是纯函数
 *
 * 和 `interactAt()` 同一个理由：判定写在 `main.ts` 里，无头回归就问不到它。
 * 演示车把方向打反这件事，肉眼在 90 秒里未必看得出来（它只是慢慢歪出去），
 * 而它一旦歪出去，`verify_demo_drive` 的闭环回归立刻红。
 *
 * ## 为什么判据是"车头该往哪边摆"，而不是两个弧长
 *
 * 最初想的是 `demoInput(arc, targetArc)`：车在环上的参数、目标点在环上的参数。
 * **那样什么也测不出来。** 弧长是车在中心线上的**投影**，而投影对横向偏移不敏感：
 * 车压在中心线右侧 3m、车头也正，前方 16m 那个点落回中心线时仍然是"前方 16m"——
 * 弧长差纹丝不动，控制器于是永远认为自己在路上，开出去再也回不来。
 *
 * 换成"横向偏移"也不够：偏航测不到（把点积投到路的方向上，
 * 纯转头不产生任何横向分量，车头歪 20° 那一项恒等于 0）。
 *
 * 最后落在**纯追踪**上：`demoAim()` 算"车头该往右摆多少弧度"，
 * 横向偏了与车头歪了都进这一个数——偏出去 3m 换算成 3/16 rad，
 * 歪了 20° 就是 0.35 rad，控制器不需要知道自己错在哪一项上。
 */

/** 巡航速度（米/秒）。比极速 15 慢一档：评审要看的是路，不是车有多快。 */
export const DEMO_CRUISE = 11;
/**
 * 前视距离（米）。12m ≈ 1.1 秒的预判。
 *
 * **这个数是量出来的，不是拍的**（`verify_demo_drive` 的那套闭环，同一条 188 环线）：
 *
 * | 前视 | 最大横向偏移 | 离路帧数 |
 * |---|---|---|
 * | 8m  | 0.95m | 0 |
 * | 10m | 1.39m | 0 |
 * | **12m** | **1.90m** | **0** |
 * | 16m | 3.07m | 0 |
 * | 20m | 4.37m | 19~50 |
 *
 * 路半宽 4m。20m 那一档已经骑到路肩外了——纯追踪的稳态偏差约 `L²/(2R)`，
 * 前视越长切弯切得越狠，而 188 环线上最紧的那个弯半径只有 40m 出头。
 */
export const DEMO_LOOKAHEAD = 12;
/**
 * 按当前车速换算前视距离，让**预判时间**恒定，而不是让距离恒定。
 *
 * ## 为什么不能写死 12m
 *
 * `DEMO_LOOKAHEAD = 12` 那张标定表是在 **11 m/s** 下量出来的（12m ≈ 1.1 秒）。
 * 前视的物理意义是**时间**：同样 12m，11 m/s 时是 1.1 秒的预判，
 * 6 m/s（徒步极速）时变成整整 2 秒——纯追踪开始大幅摆头，实测演示车
 * 在 +238s ~ +309s 之间里程零增长，是卡住而不是慢。
 *
 * 所以这里按速度缩放，把那张表锚在它被量出来的那一档上：
 * 11 m/s 时返回 12m（与标定表逐字相符），别的速度按比例缩放。
 * 上限 20m 是标定表里"开始骑出路肩"的那一档，不许越过。
 *
 * 有了它，`mountDemoVehicle()` 万一切不到自行车也不会把演示开坏——
 * 那时前视自动缩到 6.5m，仍然是约 1.1 秒。
 */
export function demoLookahead(speed: number): number {
  const v = Math.max(0, speed);
  return Math.min(DEMO_LOOKAHEAD * (v / DEMO_CRUISE), DEMO_LOOKAHEAD_MAX);
}
/** 标定表里 20m 那一档会骑到路肩外，所以这是硬上限。 */
const DEMO_LOOKAHEAD_MAX = 20;

/** 每弧度瞄偏给多少转向。1.0（满舵）对应 0.4 rad ≈ 23°。 */
const DEMO_STEER_GAIN = 2.5;
/** 弯道收油：转向打出去多少，就从油门里扣多少。 */
const DEMO_TURN_BRAKE = 0.55;
/** 车速误差 → 油门。0.32 意味着差 3m/s 就给满一档。 */
const DEMO_SPEED_GAIN = 0.32;

/**
 * 车头该往哪边摆（纯追踪）。
 *
 * @param px,pz 车在哪儿
 * @param heading 车头角。车头方向是 `(-sin h, -cos h)`（`ride.ts` 的约定，-Z 为前）
 * @param arc 车在环上的参数 [0,1)。**用 `unwrapArc()` 过滤过的那个**——
 *        8 字自交口上现取的弧长会在两条支路之间跳，详见 `unwrapArc`。
 * @returns 弧度，**正 = 该往右打**。已经在 [-π, π] 里。
 */
export function demoAim(
  px: number,
  pz: number,
  heading: number,
  arc: number,
  lookahead?: number,
  speed = DEMO_CRUISE,
): number {
  // 不传就按当前车速算前视，见 `demoLookahead()`。
  const ahead = lookahead ?? demoLookahead(speed);
  // 目标：脚下这段中心线往前 ahead 米的那个点。
  const q = pointAtArcLength(arc * TOTAL_ARCLENGTH + ahead);
  const want = Math.atan2(-(q.pos.x - px), -(q.pos.z - pz));
  let aim = heading - want;
  // 车头角与目标角都只差一个模 2π，不归一化的话
  // 会在 ±π 附近突然反向打一满舵。
  while (aim > Math.PI) aim -= TAU;
  while (aim < -Math.PI) aim += TAU;
  return aim;
}

/**
 * 这一帧的车把。
 *
 * @param aim `demoAim()` 的输出（弧度，正 = 往右打）
 * @param speed 当前车速（米/秒）。收油要它，缺了它就是一脚到底的直线。
 * @param maxSpeed 当前载具的极速。巡航目标必须**不超过它**——否则控制器
 *        会一直要一个够不到的速度，油门永久贴在 -1 上，
 *        而那个 -1 里没有任何信息，演示车读作"一直在拼命但不动"。
 *        徒步极速 6 而 `DEMO_CRUISE` 是 11，就是这么卡住的。
 * @returns `throttle` 与 `steer`，都在 [-1, 1]。**注意油门符号与键盘相反**：
 *        负数才是往前推（`ride.ts` 里 `vert < 0` 才是加速）。
 */
export function demoInput(aim: number, speed: number, maxSpeed = DEMO_CRUISE): { throttle: number; steer: number } {
  const steer = clamp(aim * DEMO_STEER_GAIN, -1, 1);
  // 巡航再慢也要给载具极速的八成：太低的话车在起点几乎不动，
  // 评审看到的是"一辆停着的车"。
  const cruise = Math.min(DEMO_CRUISE, maxSpeed * 0.8);
  // 目标速度以下就推，以上就收；再按转向补一脚刹车，好让车在弯里慢下来。
  const throttle = clamp((speed - cruise) * DEMO_SPEED_GAIN + Math.abs(steer) * DEMO_TURN_BRAKE, -1, 1);
  return { throttle, steer };
}

/**
 * 把这一帧量到的弧长接上一帧的，**并且挡掉 8 字自交口那一下跳变**。
 *
 * ## 它挡的是什么
 *
 * `nearestArcParam()` 扫全路径取最近段。188 号环线在中央穿过自己一次
 * （`JUNCTION.center` 落在弧长 0），两条支路在那儿**同一个坐标、差了半圈弧长**。
 * 只要车偏到两支一样近（几厘米之内），量出来的那一下就会换支，
 * 于是前视点瞬间落到 600m 外——`demoAim()` 返回一个大角度，车被甩一舵。
 *
 * ## 实测口径，别把它说得更神
 *
 * 正常闭环跑 45 秒**一次都不触发**（去掉它，45 秒的横向偏移与车速逐帧相同）：
 * 因为车贴着中心线骑的时候，最近的那一支永远是它自己那一支。
 * 留着它是给"车偏到路口中心那几米"兜底——那一档能不能真的发生，
 * 取决于车偏得多离谱，而**演示车没有玩家会去把它骑偏**。
 * 真正守住它的是 `verify_phase` 里那三条契约断言，不是"车会抖"这种描述。
 *
 * ## 判据
 *
 * 一帧之内弧长只可能前进 `车速 × dt / 环长`（11 m/s、1/60s 固步长 ≈ 0.00015）。
 * 超过 `maxStep` 的跳变只可能来自换支路，**丢掉它、沿用上一帧的值**。
 *
 * @param prev 上一帧接受的弧长。首帧传 `raw` 本身。
 * @param raw 这一帧 `nearestArcParam()` 的结果。
 * @param maxStep 一帧允许的最大弧长变化（归一化，环长 1.0）。
 */
export function unwrapArc(prev: number, raw: number, maxStep = 0.01): number {
  let d = raw - prev;
  // 环是首尾相接的：0.998 → 0.002 是"前进 0.004"，不是"退了 0.996"。
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  if (Math.abs(d) > maxStep) return prev;
  const next = prev + d;
  return next < 0 ? next + 1 : next >= 1 ? next - 1 : next;
}

