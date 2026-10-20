/**
 * 钓鱼状态机 —— 纯逻辑，不碰 DOM，不碰 three。
 *
 * ## 它为什么单独成文件
 *
 * 和 `phase.ts` 的 `interactAt()` / `afterCheckInRoute()` / `demoInput()`
 * 同一个理由，一条更硬的：**判定写在宿主里，无头回归就问不到它。**
 *
 * 这不是假设——本项目已经为同类问题栽过。`tryCheckIn()` 曾经只有
 * 「回家」和「打卡」两个分支，铺子分支根本没写，于是三间铺子、10 件商品、
 * 明信片的四样材料、灯笼/香囊/清心茶三条机制**全部不可达**，
 * 而当时 25 条回归全绿，因为它们量的是"预算紧不紧"，
 * 不是"玩家够不够得着"。
 *
 * 钓鱼如果写成 `if (this.fishPhase === 'bite') …`，那么"咬钩窗口到底多宽"
 * "张力曲线会不会单调" "到底可不可赢" 这三件事就只能靠人盯屏幕看。
 *
 * ## 这台机器只有一个输入：按住了确认键没有
 *
 * 刻意的。宿主那边 `onConfirm()` 把 Space/Enter 派发成
 * `press`（点一下）与 `hold`（按住），**不新开任何输入通道**——
 * §6 那条「动作只往下塞键码」因此原样成立，将来 VR 手柄接进来时
 * 走的是同一条路（手柄扳机 → `act()` → 真 `KeyboardEvent` → 同一个监听器）。
 *
 * ## 输赢是怎么设计的
 *
 * **鱼在被收线时挣扎，而进度只在按住时涨。**
 *
 * 第一版把这三件事配错了：按住时张力下降、松手时上升。于是"一直按住"
 * 在数学上是最优解（张力一路降到 0、进度一路涨满），整台机器退化成
 * 一根按住不放的键——而 `verify_fishing` 第 4 条判的就是这个。
 *
 * 正解把"谁让张力涨"翻了过来：
 *   · **按住**：进度涨，但鱼在挣扎 → 张力**涨**。
 *   · **松手**：鱼歇一口气 → 张力**跌**，进度不动。
 *
 * 于是两条死路各自成立、且都不是靠额外的特判凑出来的：
 *   · 一直按住 → 张力一路涨到 1 → 断线。
 *   · 一直松手 → 张力跌到 0、进度永远是 0 → 咬钩窗口耗尽 → 脱钩。
 *
 * 而 `REEL_RATE > 0` 与 `TENSION_RISE > 0` 这两条不变量，就是上面两句的全部依据：
 * 它们保证"按住"永远同时是**唯一**的推进手段**和**唯一危险的动作。
 */
import { clamp } from '../core/math';

/** 一局的六个阶段。`result` 是收场，`result` 里的具体输赢看 `outcome`。 */
export type FishPhase = 'idle' | 'casting' | 'waiting' | 'bite' | 'reeling' | 'result';

export type FishOutcome = 'none' | 'caught' | 'snapped' | 'missed' | 'escaped';

/** 抛投动画时长（秒）。浮漂从手里飞到落点。 */
export const CAST_SEC = 0.75;
/** 咬钩窗口时长（秒）。`verify_fishing` 钉住它不小于 0.8 —— 太窄对手感是致命的。 */
export const BITE_WINDOW_SEC = 1.15;
/**
 * 咬钩的**前兆**时长（秒）。
 *
 * 浮漂先点一下、这之后才是真正的窗口——这 0.35 秒是给玩家的预告，
 * 在它里面按下去**不算**。这个数字原来在三处各写一遍（`stepFish` 的
 * 判定、`holdMeaning` 的提示、湖边那一屏的 `hint()`），
 * 而三处只要有一处漂了，症状就是「浮漂明明点了、按下去却没中」——
 * 界面上没有任何提示说这是设计如此。
 * 所以它只有这一处定义。
 */
export const STRIKE_PRELUDE_SEC = 0.35;
/** 收场停留（秒）。给玩家看清结果，不至于一闪而过。 */
export const RESULT_SEC = 2.2;
/**
 * 收线阶段的耐心上限（秒）。超了鱼脱钩。
 *
 * **这条是被判据逼出来的。** 第一版没有它，于是「收线时一直不按」是一个
 * 完全合法的状态：张力一路跌到 0、进度永远是 0，而 `reeling` 永远不会结束——
 * 玩家可以无限期挂在这一屏，第二局开不了。
 *
 * 症状极其安静：相位没报错、张力显示合法、UI 上什么都不闪，
 * 而"这一屏永远出不去"这件事只有盯着看才发现。
 * 它和 `tryCheckIn()` 少一个分支是同一类事故，只是更小。
 */
export const REEL_LIMIT_SEC = 12;
/** 按住收线时，鱼在挣扎 → 张力的上升速度（每秒）。**必须为正**，见文件头。 */
export const TENSION_RISE = 0.55;
/** 松手歇一口气 → 张力的下降速度（每秒）。 */
export const TENSION_FALL = 0.30;
/** 按住时收线进度（每秒）。全按住约 3.3 秒收满，但撑不到那么久。 */
export const REEL_RATE = 0.30;
/** 抛投距离的随机范围（米）。 */
export const RANGE_MIN = 9;
export const RANGE_MAX = 17;

export interface FishState {
  phase: FishPhase;
  outcome: FishOutcome;
  /** 本局种子。同一个驿站、同一次到访 → 同一串结果。 */
  seed: number;
  /** 已过秒数（状态机自己的时钟，和宿主帧率无关） */
  t: number;
  /** `casting` 进度 0..1 */
  castT: number;
  /** `waiting` 还要等多久 */
  waitLeft: number;
  /** `bite` 窗口还剩多久 */
  biteLeft: number;
  /** `reeling` 还剩多少耐心（秒） */
  reelLeft: number;
  /** `result` 还要停多久 */
  resultLeft: number;
  /** 张力 0..1，≥1 即断线 */
  tension: number;
  /** 收线进度 0..1 */
  progress: number;
  /** 抛投落点到岸边的水平距离（米） */
  range: number;
  /** 这一局钓上来的是什么（纯装饰，交给文案层） */
  catchKind: string;
}

/** 极小的确定性随机：同一个 seed 永远给同一串数。 */
function rand(seed: number, salt: number): number {
  let h = (seed * 2654435761) ^ ((salt + 1) * 40503);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export function createFishState(seed: number): FishState {
  return {
    phase: 'idle',
    outcome: 'none',
    seed,
    t: 0,
    castT: 0,
    waitLeft: 0,
    biteLeft: 0,
    reelLeft: 0,
    resultLeft: 0,
    tension: 0,
    progress: 0,
    range: RANGE_MIN,
    catchKind: '',
  };
}

/** 抛投。只能在 `idle` 上调。 */
export function castFish(s: FishState): void {
  if (s.phase !== 'idle') return;
  s.phase = 'casting';
  s.outcome = 'none';
  s.castT = 0;
  s.tension = 0;
  s.progress = 0;
  // 距离与等待时间各抽一次：一次"抛得远"不必然"等得久"，
  // 两者独立才有每一局都不一样的手感。
  s.range = RANGE_MIN + rand(s.seed, 1) * (RANGE_MAX - RANGE_MIN);
  s.waitLeft = 2.2 + rand(s.seed, 2) * 4.6;
}

/** 收场（钓上 / 断线 / 错过）。 */
function settle(s: FishState, outcome: FishOutcome, kind = ''): void {
  s.phase = 'result';
  s.outcome = outcome;
  s.catchKind = kind;
  s.resultLeft = RESULT_SEC;
}

/** 鱼种。索引由 seed 定，所以同一局永远是同一条鱼。 */
const KINDS = ['lake_carp', 'lake_bream', 'lake_catfish', 'lake_crucian'] as const;

function kindOf(seed: number): string {
  return KINDS[Math.floor(rand(seed, 3) * KINDS.length) % KINDS.length];
}

/**
 * 推进一帧。
 *
 * @param s   状态（原地改）
 * @param dt  秒
 * @param hold 确认键**按住中**。点一下和按住走的是同一条路，所以
 *             「咬钩窗口里点一下」和「收线时按住」只是同一个布尔量的两种用法。
 */
export function stepFish(s: FishState, dt: number, hold: boolean): void {
  if (dt <= 0) return;
  s.t += dt;

  switch (s.phase) {
    case 'idle':
      break;

    case 'casting':
      s.castT += dt / CAST_SEC;
      if (s.castT >= 1) {
        s.castT = 1;
        s.phase = 'waiting';
      }
      break;

    case 'waiting':
      s.waitLeft -= dt;
      if (s.waitLeft <= 0) {
        s.phase = 'bite';
        // 浮漂这一下是"前兆"：它先点一下，真正的窗口才开始。
        // 少这一下的话，咬钩和等待的切换是瞬时的，玩家学不会。
        s.biteLeft = BITE_WINDOW_SEC + STRIKE_PRELUDE_SEC;
      }
      break;

    case 'bite':
      s.biteLeft -= dt;
      // 前兆那 0.35 秒里按了不算 —— 它是给玩家的预告，不是窗口。
      if (hold && s.biteLeft <= STRIKE_PRELUDE_SEC) {
        s.phase = 'reeling';
        s.tension = 0.25;
        s.progress = 0;
        s.reelLeft = REEL_LIMIT_SEC;
      } else if (s.biteLeft <= 0) {
        settle(s, 'missed');
      }
      break;

    case 'reeling':
      // 按住 = 收线（进度涨）+ 鱼挣扎（张力也涨）；松手 = 鱼歇（张力跌）、进度不动。
      // 于是"一直按住"会在约 3 秒后撞破 1 而断线，"一直松手"则进度永远为 0——
      // 而后者由 `REEL_LIMIT_SEC` 兜底收掉，否则这一屏能无限期挂着（见那条常量的注释）。
      s.reelLeft -= dt;
      if (hold) {
        s.progress += REEL_RATE * dt;
        s.tension += TENSION_RISE * dt;
      } else {
        s.tension -= TENSION_FALL * dt;
      }
      s.tension = clamp(s.tension, 0, 1.2);
      s.progress = clamp(s.progress, 0, 1);
      if (s.tension >= 1) {
        settle(s, 'snapped');
      } else if (s.progress >= 1) {
        settle(s, 'caught', kindOf(s.seed));
      } else if (s.reelLeft <= 0) {
        settle(s, 'escaped');
      }
      break;

    case 'result':
      s.resultLeft -= dt;
      if (s.resultLeft <= 0) {
        s.phase = 'idle';
        s.outcome = 'none';
        s.catchKind = '';
        s.tension = 0;
        s.progress = 0;
      }
      break;
  }
}

/**
 * 「按住确认键」在当前相位到底代表什么。
 *
 * 之所以要这样一个函数：咬钩窗口和收线阶段**用的是同一个键**，
 * 而它们要的时序完全相反（一个是"在这一瞬间点下去"，一个是"这一段一直按着"）。
 * 两处各自 if 的话，早晚会漂——而漂了之后的症状是"鱼咬了钩但按什么都没用"，
 * 界面上没有任何提示。
 */
export type HoldMeaning = 'nothing' | 'strike' | 'reel' | 'reeling';

export function holdMeaning(s: FishState): HoldMeaning {
  if (s.phase === 'bite') return s.biteLeft <= STRIKE_PRELUDE_SEC ? 'strike' : 'nothing';
  if (s.phase === 'reeling') return 'reel';
  if (s.phase === 'idle') return 'reel';
  return 'nothing';
}

/**
 * 头显里那套**世界空间**读数该显示什么。
 *
 * ## 它为什么必须存在
 *
 * 桌面与手机上，咬钩提示、张力条、收场结果都在 `ui/lakesidePanel.ts` 的
 * **DOM** 里。DOM 是页面上的东西——**沉浸式 VR 会话里它不会进头显**。
 * 于是那一屏在头显里的原样是：
 *
 *   · 输入是通的（`core/xr.ts` 把扳机派发成真的 `Space`，走的是同一套键位表）；
 *   · 但**读数是瞎的**——玩家看不见什么时候该点、看不见张力、看不见收场。
 *
 * 而钓鱼的全部玩法就是「在那一瞬间点下去」和「张力高了就松手」，
 * 两条都要**看见**才玩得成。所以头显里那套读数必须是**场景里的几何**，
 * 不能是 DOM。
 *
 * ## 它是纯函数
 *
 * 与 `holdMeaning` / `tensionBand` 同一个理由：**判定写在宿主里，无头回归就问不到它。**
 * 所以"环该显示成什么样""张力条该多长"这些决定放在这里，
 * `world/lakeside.ts` 只负责把结果画成几何。
 *
 * ## 为什么要用几何而不是文字
 *
 * 贴一张写着「拉！」的图要新素材、要切语言、还要在头显里对得上透视。
 * 而这一屏需要的信号只有三个：**现在能不能抛**、**现在该点吗**、**张力到哪了**——
 * 一个环的明暗、一个环的脉动、一条条的长度就够表达了，
 * 而且**没有语言**。英文默认、还有中文，文字方案要多一倍的活儿。
 */
export type XrHudState = {
  /**
   * 状态环。
   *
   * · `ready`  —— 空闲，可以抛竿（慢慢呼吸的一圈）
   * · `strike` —— 咬钩窗口，快闪的一圈
   * · 其余     —— 收场结果（颜色即结果）
   * · `none`   —— 这一刻没有什么要提示的（抛投中 / 等待中）
   */
  ring: 'none' | 'ready' | 'strike' | 'caught' | 'snapped' | 'escaped' | 'missed';
  /** 环的脉动 0..1。`ready` 慢、`strike` 快。 */
  ringPulse: number;
  /** 环的淡出 0..1。收场时随剩余时间淡掉。 */
  ringFade: number;
  /** 张力条是否可见（只在收线时）。 */
  tensionVisible: boolean;
  /** 张力条填充比例 0..1。 */
  tension: number;
  /** 张力档位，决定配色。 */
  band: 'calm' | 'tight' | 'danger';
};

export function xrHudState(s: FishState): XrHudState {
  const base: XrHudState = {
    ring: 'none',
    ringPulse: 0,
    ringFade: 1,
    tensionVisible: false,
    tension: 0,
    band: tensionBand(s.tension),
  };
  switch (s.phase) {
    case 'idle':
      // 空闲：慢慢呼吸的一圈，告诉玩家"可以抛了"。
      return { ...base, ring: 'ready', ringPulse: 0.5 + 0.5 * Math.sin(s.t * 2.2) };
    case 'bite':
      // 前兆那 0.35 秒**不算**提示——它还是 `none`，
      // 和 `holdMeaning` 用的是同一个窗口（见 `STRIKE_PRELUDE_SEC`）。
      return s.biteLeft <= STRIKE_PRELUDE_SEC
        ? { ...base, ring: 'strike', ringPulse: 0.5 + 0.5 * Math.sin(s.biteLeft * 18) }
        : base;
    case 'reeling':
      return { ...base, tensionVisible: true, tension: clamp(s.tension, 0, 1) };
    case 'result':
      return {
        ...base,
        ring: s.outcome === 'none' ? 'none' : s.outcome,
        ringFade: clamp(s.resultLeft / RESULT_SEC, 0, 1),
      };
    default:
      return base;
  }
}

/** 张力档位，给 HUD 上那条读数用。`tension` 是连续量，这里只分三档好做颜色。 */
export function tensionBand(t: number): 'calm' | 'tight' | 'danger' {
  if (t >= 0.78) return 'danger';
  if (t >= 0.4) return 'tight';
  return 'calm';
}