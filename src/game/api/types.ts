/**
 * AI 可游玩接口 —— **契约层**（纯类型 + 纯函数，不碰 DOM、不碰 WebGL）
 *
 * ## 这套接口是给谁用的
 *
 * 给人玩的时候，动词是键盘；给 AI 玩的时候，动词必须变成**可以跨进程下发的东西**。
 * 这个文件把那套动词和它们的**可观测后果**写成一份契约，于是同一份契约
 * 能同时挂在三个地方：
 *
 * · `live.ts` —— 挂在跑着的浏览器游戏上（`window.__gift188`），
 *   AI 通过页面里的 JS 直接驱动**真正的那一局**；
 * · `headless.ts` —— 挂在 Node 里那辆不碰 WebGL 的车上（`tools/ai-play.mjs`），
 *   用来跑策略、回归、批量搜索，一次几千步不占显卡；
 * · `verify/ai.ts` —— 挂在回归上，守住"动作集不许悄悄少一个"和
 *   "接线不许断"这两件事。
 *
 * ## 最重要的一条设计：**告诉 AI 现在能按什么**
 *
 * 这个游戏的动词**几乎全部带相位闸门**：空格只在驿站附近打卡，
 * Esc 只在 `roaming` 暂停，小游戏期间键盘整体被吃掉。
 * 一份只说"你可以按 W/S/A/D/Space"的接口，对 AI 是**有害的**——
 * 它会反复按那些此刻什么都不会发生的键，然后在观察里看不到任何变化，
 * 于是学会"这个接口没用"。
 *
 * 所以 `describeActions()` 是这个文件里最重要的函数：
 * 它从观测快照算出**此刻真的有反应的动作集合**。
 * AI 的策略循环应该是"读 observe() → 看 available → 只从里面挑"。
 */

import { keyToVec } from '../../core/stick';
import { codeOf, DEFAULT_KEYMAP, type GameAction } from '../../core/keymap';
import type { Phase } from '../phase';

/** 可以**按住**的动作。松开和按下同等重要：`keys` 是个集合，忘了松就永久加速。 */
export type AiHeldAction = 'throttle' | 'brake' | 'left' | 'right';

/** 可以**点一下**的动作。点完立刻回到抬起状态。 */
export type AiTapAction =
  | 'checkIn'
  | 'pause'
  | 'camera'
  | 'vehicle'
  | 'relic'
  | 'mute'
  | 'item1'
  | 'item2'
  | 'item3'
  | 'item4'
  /** 对白推进。小游戏与面板各有自己的键，交给适配器去路由。 */
  | 'advance';

export type AiAction = AiHeldAction | AiTapAction;

export const AI_HELD_ACTIONS: readonly AiHeldAction[] = ['throttle', 'brake', 'left', 'right'];

export const AI_TAP_ACTIONS: readonly AiTapAction[] = [
  'checkIn',
  'pause',
  'camera',
  'vehicle',
  'relic',
  'mute',
  'item1',
  'item2',
  'item3',
  'item4',
  'advance',
];

/**
 * 既能点、也**能按住**的动作。
 *
 * ## 它为什么必须存在
 *
 * `act()` 原来只收 `AI_HELD_ACTIONS`（四个骑行键），于是**确认键按不住**——
 * 而"按住确认键"在这三处是**唯一**的表达方式，不是可选项：
 *   · **茶**：按住 3 秒才注满。连点不行——`tea.ts` 的 `setHolding(false)`
 *     会把 `holdTime` **清零**，点一次加一帧、松手归零，永远到不了 3 秒。
 *   · **描云**：按住空格才落笔（`cloud.ts` 的 `kDown`）。
 *   · **钓鱼**：按住收线（`lakeside` 读 `keys.has('Space')`）。
 *
 * 连点能**碰巧**近似出"按住"（宿主逐帧读 `keys`，两帧之间那一下 keyup
 * 落在帧与帧的空隙里），钓鱼就是这么被蒙过去的——但茶绕不过去，
 * 而"靠事件时序的巧合"本来也不该是接口的语义。
 *
 * ## 它为什么不算进 `AI_TAP_ACTIONS`
 *
 * `advance` **仍然在** `AI_TAP_ACTIONS` 里——`tap('advance')` 是合法的
 * （抛竿、咬钩、对白推进都是点一下）。所以
 * `AI_HELD_ACTIONS.length + AI_TAP_ACTIONS.length` 这个计数**不变**，
 * `verify_ai_actions` 那条"动作集不许少一个"的判据一个字都不用改。
 */
export type AiHoldableAction = AiHeldAction | 'advance';

/** 能按住的全集。`act()` 收的是它，`tap()` 收的是 `AI_TAP_ACTIONS`。 */
export const AI_HOLDABLE_ACTIONS: readonly AiHoldableAction[] = [...AI_HELD_ACTIONS, 'advance'];

/**
 * 动作在 `AI_HELP` 里的分类标签。
 *
 * 单独成一个函数而不是在模板里写三目：`advance` 是唯一一个**两边都在**的动作
 * （能点也能按），而三目嵌套写出来之后，"help 里说它能按住"和
 * "`act()` 真的收它"会各自漂——所以两边读**同一个** `AI_HOLDABLE_ACTIONS`。
 */
export function actionKind(a: AiAction): 'held' | 'tap' | 'both' {
  const canHold = (AI_HOLDABLE_ACTIONS as readonly AiAction[]).includes(a);
  const canTap = (AI_TAP_ACTIONS as readonly AiAction[]).includes(a);
  if (canHold && canTap) return 'both';
  return canHold ? 'held' : 'tap';
}

/**
 * 小游戏期间**此刻真的按得出反应**的动作，按乐事 id 给。
 *
 * ## 它治的是什么
 *
 * 这里原来是一句 `out.push('advance')`——理由是"小游戏期间键盘被整体吃掉"。
 * 那半句只对了一半：**骑行键**确实被吃掉（`bindInput()` 第一行就
 * `if (this.mg.isRunning) return`），但小游戏自己那套键**恰恰是要用的**。
 * 于是驱动 `window.__gift188` 的机器人被锁死在"只能按空格"：
 *   · 古琴与禽语要 `Digit1..4` —— 一个动作都发不出，只能干等 30 秒超时；
 *   · 描云与竹要方向键 —— 光标/刀位一步都挪不动；
 *   · 茶要按住 —— 见 `AiHoldableAction`，按不住。
 * 实测：五件乐事里合规机器人只能赢下**竹**（狂点空格，约一半概率），
 * 另外四件全输，其中三件是超时。
 *
 * ## 为什么是「按 id 查表」而不是「一律给并集」
 *
 * 本项目对 `available` 的要求是**宁可少列一个，也不要列一个按了没反应的**
 * ——列错了的代价是策略学不会区别。并集会让"禽语能按方向键"这种谎
 * 出现在观测里，所以能精确就精确。
 *
 * 表里的每一项都必须**真的被那个小游戏吃掉**，这条由
 * `verify_minigame_ai_actions` 把动作真发进去验，而不是靠读代码。
 */
export const MINI_GAME_AI_ACTIONS: Readonly<Record<string, readonly AiAction[]>> = {
  /** 描云：空格落笔（可按住）+ 方向键挪光标（`cloud.ts` 的 `kDown` / `kx,ky`）。 */
  cloud: ['advance', 'throttle', 'brake', 'left', 'right'],
  /** 倒茶：只有确认键，而且必须**按住**满 3 秒。 */
  tea: ['advance'],
  /** 古琴：`NOTE_KEYS = Digit1..4`（`zither.ts`）。确认键在这屏什么也不做。 */
  zither: ['item1', 'item2', 'item3', 'item4'],
  /** 竹：空格挥刀（点，不是按）+ 左右挪刀位。上下不接。 */
  bamboo: ['advance', 'left', 'right'],
  /** 禽语：`CHOICE_KEYS = Digit1..4` 选答案（`bird.ts`）。 */
  bird: ['item1', 'item2', 'item3', 'item4'],
  /**
   * 琴音林的自由演奏（不轮换、不计分，见 `MINI_GAME_IDS` 的注释）。
   * 三个八度压在 `ZXCVBNM` / `QWERTYU` / `Digit1..7` 上，其中能被 AI 动作
   * 够到的只有：数字行高八度（`item1..4` → `Digit1..4`）、
   * `KeyV` / `KeyE` / `KeyM`（`camera` / `vehicle` / `mute`）。
   */
  qin: ['item1', 'item2', 'item3', 'item4', 'camera', 'vehicle', 'mute'],
};

/**
 * id 未知时退回的并集。
 *
 * 只在"宿主没报 id"时用得上（真实宿主一定报）。它存在的理由是
 * **空集比并集坏得多**：这一屏从"能玩"退化成"一步都走不了"，
 * 正是修这条 bug 之前的样子。宁可多给，也不要把一屏变成死屏。
 */
export const MINI_GAME_AI_ACTIONS_ANY: readonly AiAction[] = [
  ...new Set(Object.values(MINI_GAME_AI_ACTIONS).flat()),
];

/** 动作 → `KeyboardEvent.code`。**这是键盘与接口之间唯一的翻译表。**
 *
 * 用 `code` 而不是 `key`，和 `bindInput()` 保持一致：
 * 游戏读的是 `e.code`，所以接口下发的也必须是 `code`，
 * 这样"接口按的键"和"人手按的键"在游戏里**完全同路**，
 * 不会出现"人能做的事 AI 做不了"的第二套语义。
 *
 * 方向键与 WASD 同时列出来：`keyToVec()` 两个都收，
 * 策略用哪套都行，而 `verify` 会断言这两套算出来的向量一致。
 */
export const AI_KEYS: Readonly<Record<AiAction, readonly string[]>> = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  checkIn: ['Space'],
  pause: ['Escape'],
  camera: ['KeyV'],
  vehicle: ['KeyE'],
  relic: ['KeyF'],
  mute: ['KeyM'],
  item1: ['Digit1'],
  item2: ['Digit2'],
  item3: ['Digit3'],
  item4: ['Digit4'],
  // 对白与小游戏按的是"确认"，键盘上落在空格/回车/指键几族上；
  // 适配器负责把它们路由到当前真正监听的那一个。
  advance: ['Space', 'Enter', 'NumpadEnter'],
};

/** 反查：某个 `KeyboardEvent.code` 属于哪个动作（拿第一个匹配的）。 */
export function actionOfCode(code: string): AiAction | null {
  for (const a of Object.keys(AI_KEYS) as AiAction[]) {
    if (AI_KEYS[a].includes(code)) return a;
  }
  return null;
}

/**
 * 动作 → 它**此刻**真正该派发的那些键码。
 *
 * ## 为什么 `AI_KEYS` 不能直接派发
 *
 * `AI_KEYS` 是**契约表**：写死物理键，是为了让 `verify_ai_actions`
 * 能钉住"每个动作都有一个键位、方向和 `keyToVec()` 一致"——
 * 那是判据要量的东西，不能因为玩家改了键就变成另一个形状。
 *
 * 但真正派发的那一侧必须**跟玩家的键位走**：改键之后 AI 还在派 `KeyW`，
 * 症状是"手动玩正常，AI 玩车不动"，而没有任何地方提示为什么。
 *
 * 所以拆成两份：**表是契约，读法是运行时**。这一条是唯一的读法。
 */
export function keysOf(action: AiAction): string[] {
  const g = AI_TO_GAME_ACTION[action];
  if (!g) return [...AI_KEYS[action]];
  const fallback = DEFAULT_KEYMAP[g];
  const current = codeOf(g);
  if (current === fallback) return [...AI_KEYS[action]];
  // 只替换**默认那个键位**。动作表里那把备用键（`ArrowUp` 等）
  // 不受重映射影响——它们是系统级的方向，玩家没要求改它们。
  return AI_KEYS[action].map((c) => (c === fallback ? current : c));
}

/** 能被重映射的那部分 AI 动作 → 游戏动作。其余（`item1~4` / `advance`）不走键位表。 */
const AI_TO_GAME_ACTION: Partial<Record<AiAction, GameAction>> = {
  throttle: 'forward',
  brake: 'back',
  left: 'left',
  right: 'right',
  checkIn: 'confirm',
  pause: 'pause',
  camera: 'camera',
  vehicle: 'vehicle',
  relic: 'interact',
  mute: 'mute',
};

/** `[moveX, moveY]`，和 `stickVector()` / `keyToVec()` 同一个约定。 */
export function actionVector(action: AiHeldAction): [number, number] {
  return keyToVec(AI_KEYS[action][0]) ?? [0, 0];
}

/**
 * 8 向箭头，索引 0 = 正前方，顺时针递增。
 *
 * 抄自 `HUD3D.gd` 的 `ARROWS`——那边的注释写着「字体 LXGW 覆盖这几个码位」，
 * 也就是这 8 个字形是字体子集里**特意留的**。换成 emoji 箭头（⬆️ 之类）
 * 会让它们掉出子集，首屏多下一份字体去补 4 个字形。
 *
 * **它现在住在契约层而不是 `hud.ts`**，因为它已经是两份东西的公共依赖：
 * HUD 顶栏要它，AI 观测的 `nextArrow` 也要它。
 * 两边各写一份的结果一定是某一版偷偷漂了——
 * 而漂了之后玩家看到的箭头和 AI 算的方向会不一致，
 * 那正好是这类接口最难被察觉的一类 bug。
 * `verify/ai.ts` 里有一条断言专门钉住"两边算出同一个字形"。
 */
export const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'] as const;

/**
 * 目标相对**车头**的方向箭头。8 向，向右为正。
 *
 * 必须相对车头而不是罗盘北：8 字自闭合，两个方向都能到全部五座，
 * 骑反了「下一处 · 84m」会一直是 84m，而玩家在交叉点上完全看不出自己
 * 骑反了。这是原作 `_arrow_glyph()` 注释的原话，判据一字不改。
 */
export function arrowGlyph(dx: number, dz: number, fx: number, fz: number): string {
  // 以车头位姿 a(v) = atan2(x, -z)：车头正对 -Z 是 0°，正前方 +X 是 +90°。
  // 把两个方向都减掉车头位姿，差值就是目标偏在车头哪一侧。
  const rel = Math.atan2(dx, -dz) - Math.atan2(fx, -fz);
  const wrapped = Math.atan2(Math.sin(rel), Math.cos(rel)); // wrap 到 [-π, π]
  const i = Math.round(wrapped / (Math.PI / 4));
  return ARROWS[((i % 8) + 8) % 8];
}

// ---------------------------------------------------------------- 观测

/**
 * 一帧的完整观测。**只有玩家真的能感觉到的东西**，不掺内部量。
 *
 * 有意**不放**的东西：`Object3D` 树、GLB 句柄、渲染器统计、
 * 以及任何"读源码才知道"的状态。理由是这份快照要能当成**观测空间**用——
 * 一个 AI 只能对它看见的东西做策略，
 * 往里塞内部量等于让评估作弊。
 */
export interface AiObservation {
  /** 单调递增的帧号（不是毫秒）。跨进程比较请用这个。 */
  tick: number;
  /** 已经推进的游戏时间（秒）。 */
  t: number;

  phase: Phase;
  /** 章节，1 或 2。 */
  chapter: number;

  // ---- 旅程 ----
  day: number;
  daysLeft: number;
  coins: number;
  lvbi: number;
  /** 心神，1..MOOD_CEIL。**顶栏那格显示为 "Composure 4/5"，取的就是这一个数。**
   *
   * 契约里只留 `mood` 一个字段：界面上它有两套叫法（导语页叫「心神」，
   * 顶栏叫 Composure），而两处读的是**同一个** `game.mood`。
   * 观测里写两个字段，下游一定会以为有两件事可以分别调，
   * 然后花很久去找一个根本不存在的心神/定力分离逻辑。 */
  mood: number;
  /** 已经刷到的碎片件数。 */
  fragmentsGot: number;
  /** 每件乐事各去了几次，长度恒为 5。 */
  slotVisits: number[];

  // ---- 车 ----
  speed: number;
  maxSpeed: number;
  /** 在路面上为 true。离路时为 false——这是玩家最该盯着的一个布尔。 */
  onRoad: boolean;
  /** 离路多少米（0 = 在路上）。 */
  offRoad: number;
  /** 沿路线的弧长（米）。 */
  arc: number;
  /** 已骑公里数。 */
  km: number;
  /** 当前载具。 */
  vehicle: string;
  /** 当前镜头。 */
  camera: string;

  // ---- 导航（玩家在顶栏和小地图上真能读到的） ----
  /** 下一处驿站的序号；-1 = 没有下一处。 */
  nextStation: number;
  /** 站点名（已按当前语言取好的**显示用**字符串，不是 i18n 键）。 */
  nextName: string;
  /** 还有多远（米）。-1 = 没有下一处。 */
  nextDistance: number;
  /** 方向箭头字符，例如 `↗`。空串 = 不指方向。 */
  nextArrow: string;
  /** 脚下能不能打卡。 */
  canCheckIn: boolean;
  /** 「这一趟要做什么」的**显示用**句子。 */
  objective: string;
  /**
   * 上面这些显示用字符串是哪种语言（`'zh'` / `'en'`）。
   *
   * AI 要读 `objective` / `nextName` / `dialogueText` 才能判断
   * "我在哪、要干什么"，所以它至少得知道这是哪种语言——
   * 否则中文和英文会被当成同一种东西去比较。
   *
   * 它以前**不在**观测里，而是挂在适配器上一个没人调用的 `lang()` 上，
   * 而那个函数在无头侧写死了 `'zh'`：中文环境下一切照旧，
   * 换成英文就全错，而没有任何一处会读到它。
   */
  lang: string;

  // ---- 正在说的话 ----
  /** 屏幕上有对白/故事卡时为 true。 */
  dialogueOpen: boolean;
  /** 那段字（显示用）。 */
  dialogueText: string;
  /** 小游戏正在跑。 */
  minigame: boolean;
  /**
   * 正在跑的是哪一件乐事（`'cloud' | 'tea' | 'zither' | 'bamboo' | 'bird' | 'qin'`），
   * 没在跑就是 `null`。
   *
   * **它是 `minigame` 那个布尔之外的附加字段，不是它的替代。**
   * 布尔回答"有没有"，这个回答"是哪一件"——而 `describeActions()`
   * 要靠后者才给得出那一屏**真正的**键位（见 `MINI_GAME_AI_ACTIONS`）。
   * 两件事分开而不是把布尔换成联合类型，是因为前者有六个调用方
   * （`live.ts` 的事件影子比对、`session.ts` 的闸门、两处回归），
   * 而它们全都只关心"有没有"。
   */
  minigameId: string | null;
  /** 面板类 UI 是否压着（暂停 / 商店 / 明信片 / 结算）。 */
  panelOpen: boolean;

  /** 此刻**真的有反应**的动作集合。AI 的策略只该从这里面挑。 */
  available: AiAction[];
}

/** 一次性的事。轮询式：AI 每次 `drain()` 取走上次之后发生的，取走即清。 */
export interface AiEvent {
  tick: number;
  t: number;
  kind:
    | 'phase'
    | 'day'
    | 'checkIn'
    | 'fragment'
    | 'chapter'
    | 'coins'
    | 'mood'
    | 'stationPassed'
    | 'offRoadEnter'
    | 'offRoadExit'
    | 'camera'
    | 'vehicle'
    | 'minigame'
    | 'dialogue'
    | 'saveFailed'
    | 'saveMigrated';
  /** 这一条自己的载荷。语义随 `kind` 而定，注释在各自的产出点。 */
  detail?: string | number | boolean;
}

// ---------------------------------------------------------------- 纯函数

/**
 * 从观测算出「此刻真的有反应的动作」。
 *
 * 每一道闸门都对应宿主里真实存在的一条守卫，而不是"看起来合理"：
 * · 骑行键只在 `phase === 'roaming'` 且没有叙事段在跑时有效
 *   （`bindInput()` 里 `if (this.mg.isRunning) return`，`canRide` 又要求 `roaming`）；
 * · `checkIn` 只在脚下有驿站时有效（`STATION_PASS_RADIUS` 之内）；
 * · `pause` 只在 `roaming` 有效——`pause()` 第一行就是 `if (phase !== 'roaming') return`；
 * · 小游戏期间键盘被整体吃掉，所以只给 `advance`。
 *
 * 给错的代价不是"多点一次没反应"，而是策略学不会区别——
 * 所以宁可保守：**宁可少列一个，也不要列一个按了没反应的。**
 *
 * ## 但「保守」有一条不能越的界
 *
 * 下面那一条曾经写的是 `if (o.panelOpen) return out;`——面板压着就什么都不给。
 * 看上去最保守，实际后果是**把调用方锁死**：实机在标题屏上量到
 * `available: []`、`tap('advance')` 被拒，AI 连游戏都启动不了；
 * 而按真实界面状态逐个相位跑一遍，`paused` / `checkin` / `synthesis`
 * **全都是空集**——也就是暂停关不掉、商店走不出、结算过场推不动。
 *
 * 一屏都不给，和给一个错的键，坏在同一个地方：调用方学不会区别，
 * 而这一次它连"卡住了"这件事都观测不到（`available` 恒空，
 * 策略没有任何信号可以据此反应）。
 *
 * 所以正确的分法是**问「这一屏怎么出去」**，而不是问「有没有面板」：
 * · DOM 流程页（标题 / 引导 / 合成 / 结算）——出路是**确认键**。
 *   它们各自 `wireKeyActivate()` 了按钮并在 `show()` 里 `focus()`，
 *   于是 Space/Enter 打在那个被聚焦的按钮上（见 `hud.ts:719`）。
 * · 商店 / 暂停——出路是 **Esc**。宿主里 Escape 只认这两处
 *   （`main.ts` 的 Escape 分支：`shopOpen` 先判，然后 `paused`，然后 `roaming`）。
 *   别的相位 Esc 真的什么也不做，所以别的相位不给它。
 */
export function describeActions(o: {
  phase: Phase;
  canCheckIn: boolean;
  dialogueOpen: boolean;
  minigame: boolean;
  panelOpen: boolean;
  /** 有叙事段落/打卡过场正在占着屏幕。 */
  narrativeBusy?: boolean;
  /**
   * 正在跑哪一件乐事。**给了就按它的真实键位给动作**，不给就退回并集。
   *
   * 它是可选参数而不是必填，是为了让"只想问某个相位能按什么"的调用方
   * （回归里那张 `REAL` 表）不用为小游戏单独编一个 id。
   */
  minigameId?: string | null;
}): AiAction[] {
  const out: AiAction[] = [];
  // 小游戏自己吃键盘——但**只吃掉骑行那一套**。
  // `bindInput()` 第一行 `if (this.mg.isRunning) return` 拦的是宿主自己那层；
  // 小游戏模块自己的 `onKeyDown` 恰恰在等这些键。原来这里一律只给 `advance`，
  // 后果见 `MINI_GAME_AI_ACTIONS` 的注释（五件里四件打不动）。
  // 判据上要认**两个**信号：宿主自己报的 `minigame` 布尔，
  // 以及相位已经是 `minigame` —— 后者是 `runMiniGame()` 切过去的，
  // 而两者之间有一小段谁先谁后。漏掉相位那个，
  // 症状是「AI 在小游戏刚开始的那两帧里按 W，车动了」。
  if (o.minigame || o.phase === 'minigame') {
    const known = o.minigameId ? MINI_GAME_AI_ACTIONS[o.minigameId] : undefined;
    out.push(...(known ?? MINI_GAME_AI_ACTIONS_ANY));
    return out;
  }
  if (o.dialogueOpen) {
    out.push('advance');
    return out;
  }

  /**
   * 湖边一屏。
   *
   * **不新加动作。** 钓鱼用的确认键就是 Space，而 Space 已经是 `checkIn` /
   * `advance` 的键位——适配器是**按相位**路由的（`live.ts`），不是按动作名，
   * 所以 `act('advance', …)` 在这一屏派发出去的就是钓鱼要的那一下。
   * 新加一个 `reel` 只会和 `verify_ai_actions` 的键位唯一性打架，
   * 而拿不到任何新能力。
   *
   * `advance` 的两种用法——"抛投 / 咬钩时点下去"与"收线时按住"——
   * 由 `act(action, down)` 的 `down` 区分，本来就是同一个键的两种用法。
   *
   * `pause` 必须排在前面：这一屏没有对白也没有 DOM 页，
   * 但它**有**一个必须出去的出口。给 `advance` 的话，
   * AI 在这一屏里没有任何合法的退出方式——
   * 那正是 `verify_ai_available` 会报「该相位没有任何可用动作」的那一档。
   */
  if (o.phase === 'lakeside') {
    out.push('pause', 'advance');
    return out;
  }

  // **DOM 流程页**。放在 `panelOpen` 之前，因为合成屏开着合成面板、
  // 结算屏还能被明信片面板盖住——它们都是"这一屏本身就是 DOM 页"，
  // 出路都是那个被 `focus()` 的按钮，不是 Esc。
  if (
    o.phase === 'title' ||
    o.phase === 'onboarding' ||
    o.phase === 'synthesis' ||
    o.phase === 'endcard'
  ) {
    out.push('advance');
    return out;
  }

  // 剩下的"有东西压着"只可能是商店（`checkin`）与暂停（`paused`），
  // 而这两处 Escape 在宿主里是真的会退出一层的。
  if (o.panelOpen) {
    if (o.phase === 'checkin' || o.phase === 'paused') out.push('pause');
    return out;
  }

  if (o.phase === 'roaming' && !o.narrativeBusy) {
    out.push('throttle', 'brake', 'left', 'right');
    out.push('camera', 'vehicle', 'relic', 'mute');
    out.push('item1', 'item2', 'item3', 'item4');
  }
  // 空格：脚下有站就打卡，没有站也要给——
  // 「没有站时按空格有一句回音」是第八轮专门修过的东西，
  // 而那一句正是玩家（和 AI）判断"我是不是该往那边骑"的信号。
  if (o.phase === 'roaming') out.push('checkIn');
  // Esc：`roaming` 上是暂停，上面两处（`paused` / `checkin`）是"退出当前面板"。
  if (o.phase === 'roaming') out.push('pause');
  return out;
}

/** 观测里"玩家看得见的字符串"字段。给 CLI 与 AI 做摘要用。 */
export function summarize(o: AiObservation): string {
  const nav = o.nextDistance >= 0 ? ` → ${o.nextName} ${o.nextArrow} ${Math.round(o.nextDistance)}m` : '';
  const road = o.onRoad ? '' : ` [离路 ${o.offRoad.toFixed(1)}m]`;
  return (
    `d${o.day}(剩${o.daysLeft}) ${o.km.toFixed(2)}km ${(o.speed * 3.6).toFixed(0)}km/h${road}` +
    ` 币${o.coins} 心${o.mood} 碎片${o.fragmentsGot}/5${nav} · ${o.objective}`  );
}

/** 一份人类/AI 都能直接读的接口说明。`help()` 与 `tools/ai-play.mjs --help` 共用。 */
export const AI_HELP = `
Gift No.188 · AI 可游玩接口

三个入口，一份契约：
  1. 浏览器里   window.__gift188   —— 驱动正在跑的那一局
  2. 无头 Node  npm run ai:play    —— 不占显卡，跑策略与批量搜索
  3. 回归      src/verify/ai.ts   —— 守住动作集与接线

动作（held = 按住不放，tap = 点一下，both = 两种都行）：
${(Object.keys(AI_KEYS) as AiAction[])
  .map((a) => `  ${a.padEnd(9)} ${actionKind(a).padEnd(5)}${AI_KEYS[a].join(' / ')}`)
  .join('\n')}

方法（全部挂在同一个对象上）：
  observe()             读一帧观测（含 available：此刻按了真的有反应的动作）
  act(action, down)     按住/松开一个 held 动作
  tap(action)           点一下一个 tap 动作（按下与抬起一定成对）
  drain()               取走上次之后发生的一次性事件，**取走即清**
  frame(n)              推进 n 帧（浏览器里等的是真实渲染）
  wait(seconds)         按秒推进，等价于 frame(seconds * 60)
  releaseAll()          松开本会话按住的全部键，返回松了哪些
  heldKeys()            本会话此刻按着哪些键
  on('event', fn)       订阅原始事件，返回退订函数
  summary()             把当前观测拼成一行人读得懂的摘要
  help()                这段文字
  version               接口版本号

动作此刻无效时 act / tap **返回 { accepted: false, reason }**，
不会默默发出去——策略需要知道自己这一步被拒了。
只有能按住的动（四个骑行键 + advance）进 heldKeys()；纯 tap 的不进，
也不用 releaseAll() 兜底。

小游戏期间 available 会变成**那一件乐事真正的键位**（见 MINI_GAME_AI_ACTIONS）：
描云/竹要方向键、古琴/禽语要 item1..4、茶要按住 advance。
观测里的 minigameId 告诉你正在跑哪一件。

典型循环：
  while (true) {
    const o = observe();
    if (o.canCheckIn) await tap('checkIn');
    else if (o.available.includes('throttle')) await act('throttle', true);
    for (const e of drain()) log(e);
    await frame();
    // 一局结束前记得 await releaseAll()，否则车会一直自己往前冲。
  }
`;
