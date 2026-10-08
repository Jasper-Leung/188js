/**
 * 游戏状态 —— Godot 版 GameManager 的完整移植。
 *
 * 这是整个游戏唯一的事实来源：打卡次数、旅币、背包、心神、剧情进度。
 * UI、玩法系统、明信片全都从它读，**任何地方都不许自己抄一份**。
 *
 * 移植时保留了几条不太直觉但很重要的判据：
 *
 * · **幂等账本 `earnedTags`**。每一笔旅币都带一个 tag，同一个 tag 只发一次。
 *   读档重玩时 `earn_km` 每帧都在调，没有这个账本，玩家绕一圈回来
 *   旅币就会凭空翻几倍。
 *
 * · **心神只有一条上行口**。原版收满五块碎片正好把心神从 4 打到 1，
 *   而 1 是遮罩最浓那一档——玩家最需要看清世界（集齐二选一）时最暗。
 *   `restoreMood()` + 茶铺的清心茶就是这条上行口，缺了它就是单向下水道。
 *
 * · **"已经收过"和"不用再去"是两件事**。`fragmentStationNeedsVisit()`
 *   顶栏、小地图、脚下提示圈三处都调它。任何一处自己抄一份判据，
 *   玩家就会同时看到三块互相打架的指示牌。
 */
import { ECON, SHOPS, ROAD } from '../data/raw';
import type { GoodDef } from '../data/raw';

export type GameState = 'GIFT_BOX' | 'ROAMING' | 'CHECK_IN' | 'SYNTHESIZING' | 'END_CARD';

export interface SaveBlob {
  version: number;
  collected: Record<string, number>;
  progress_km: number;
  onboarding_shown: number;
  economy: {
    lvbi: number;
    inv: Record<string, number>;
    spent_km: number;
    earned_tags: string[];
    seen_stations: string[];
    mood: number;
    seen_villain: number;
    prologue_done: boolean;
    /** 驿里那个声音是否已经引过路（一次性，落盘） */
    voice_done: boolean;
    ending_id: string;
    /** 1-based 章节号。老存档没有这个字段，读回时按 1 处理 */
    chapter?: number;
    chapter1_done?: boolean;
    /** 骑完的圈数。老存档没有，按 0 处理（那一趟还没开始耗日子） */
    laps?: number;
    /** 累计打卡。老存档没有，按已收碎片数推出来——那是下界，不会少算 */
    check_ins?: number;
  };
}

type Listener<T> = (payload: T) => void;

/**
 * 存档后端。默认 `localStorage`；**无头回归传一个内存实现**。
 *
 * ## 为什么不是一个全局变量
 *
 * 原来 `save()` / `load()` 直接摸 `localStorage`，而两处都包在 `try/catch` 里
 * （无痕模式 / 配额满不该让游戏崩）。在 Node 里 `localStorage` 根本不存在，
 * 于是 `save()` 安静地什么都不做、`load()` 安静地返回 false——
 * **"存档坏了"和"这里没有存档"看起来一模一样。**
 *
 * 后果是日期（`laps` / `check_ins`）这类**只能靠存读往返证明的字段**
 * 在回归里根本测不到：`verify_days` 第一次跑就红了
 * 「存读往返：第 8 天 → 读回第 1 天」，而它报的其实是"后端不存在"，
 * 不是"字段没写进存档"。
 *
 * 抽成可注入的接口之后，那条判据才真的在测它该测的东西。
 * 和 `phase.ts` 把 `canRide` 抽成纯函数是同一个理由。
 */
export interface SaveStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

function memoryStore(): SaveStore {
  const m = new Map<string, string>();
  return {
    read: (k) => m.get(k) ?? null,
    write: (k, v) => void m.set(k, v),
    remove: (k) => void m.delete(k),
  };
}

function defaultStore(): SaveStore {
  try {
    // 真的浏览器里有 localStorage；碰不到就退到内存，游戏照跑。
    if (typeof localStorage !== 'undefined') {
      localStorage.getItem(SAVE_KEY);
      return {
        read: (k) => localStorage.getItem(k),
        write: (k, v) => localStorage.setItem(k, v),
        remove: (k) => localStorage.removeItem(k),
      };
    }
  } catch {
    /* 无痕模式：getItem 本身就抛 */
  }
  return memoryStore();
}

const SAVE_KEY = 'gift188.save.v3';

export class GameStateManager {
  // 事件
  private _l: {
    fragment: Listener<number>;
    allCollected: Listener<void>;
    lvbi: Listener<{ delta: number; total: number }>;
    mood: Listener<number>;
    item: Listener<string>;
    state: Listener<GameState>;
    dirty: Listener<void>;
  } = {
    fragment: () => {},
    allCollected: () => {},
    lvbi: () => {},
    mood: () => {},
    item: () => {},
    state: () => {},
    dirty: () => {},
  };

  on<K extends keyof typeof this._l>(k: K, fn: (typeof this._l)[K]) {
    this._l[k] = fn;
    return this;
  }

  // ---- 状态 ----
  collected = new Map<number, number>();
  lvbi = 0;
  inv = new Map<string, number>();
  spentKm = 0;
  earnedTags = new Set<string>();
  seenStations = new Set<number>();
  mood = ECON.MOOD_INITIAL;
  seenVillain = 0;
  prologueDone = false;
  voiceDone = false;
  endingId = '';
  progressKm = 0;
  onboardingShown = false;
  currentState: GameState = 'GIFT_BOX';

  /**
   * 两个"翻转已发过"的闩锁，只活在本次会话里，不落盘。
   * 读档之后必须按存档现状补齐——否则一个已经五站全收的存档，
   * 下一次回访打卡会重发一次 allCollected，把合成动画重放一遍。
   */
  private collectedFired = false;
  // 原来这里还有一个 `maxedFired`，只被 `allMaxed` 那个零订阅事件用。
  // 事件删了它就没有读者了，而 `noUnusedLocals` 会为"只写不读的私有字段"报错——
  // 顺带说，这条编译选项正好是这一族死代码的免费探测器。

  // ================= 章节 =================
  //
  // ## 为什么第一章要在**十八驿**结束，而不是在第五块碎片那里
  //
  // 原来的流程是「集齐五块 → 立刻弹合成面板 → 明信片」。问题有三个：
  //
  // 1. **玩家不知道为什么结束**。集齐是玩家自己做的事，而"这一趟结束了"
  //    是游戏替他做的决定，两件事之间没有任何过渡。
  // 2. **188 号环线是自闭合的**，起点和终点是同一个地方（0 号驿站）。
  //    把它用上，"骑完一圈回到出发的地方"就是最自然的一章结尾——
  //    而这恰好是这个游戏唯一的地标性空间关系（8 字自己穿过自己）。
  // 3. **demo 需要一个干净的边界**。第一章 = 一趟完整的 188，
  //    收在十八驿，玩家清楚地知道"这一章到这儿"，
  //    第二章才是新东西。没有边界的话，demo 结束得含糊其辞。
  //
  // 十八驿就是 0 号驿站（起程驿楼，模型 6 驿楼 = 程序化生成的旅店），
  // 也是 `World` 的出生点。**不新增第 17 座驿站**——
  // 那会动到 `STATIONS` 的长度，而 `verify_stations` 钉的是 16。

  /** 十八驿 = 0 号驿站。环线起点，也是这一章的终点 */
  static readonly HOME_STATION = 0;
  /** 当前章节号（1-based） */
  chapter = 1;
  /** 第一章是否已经完成 */
  chapter1Done = false;

  // ================= 三十日 =================
  //
  // ## 为什么日期要**由行为算出来**，而不是一个手动推进的计数器
  //
  // 律师函说"三十日内不开业，依法征收"，反派第三场说"五天内不签字"。
  // 这两句话写好了、也念出来了，而**三十天从来不会走**——
  // 于是这个期限不是压力，只是一句背景。
  //
  // 做法是让日期是**已发生的事**的函数，而不是一个可以被推进的数：
  // 打卡要花时间、骑完一圈要花时间，两者一加就是日期。
  // 这样玩家没法"顺便"推进它（没有地方能点），
  // 而**迷路真的会花掉日期**——这一趟里唯一不推进任何事的行为。
  //
  // ## 这三个常数定的到底是什么期限（**别再按"刚好用完"读它**）
  //
  // 一天的口径是 `DAYS_PER_LAP = 3` / `DAYS_PER_CHECKIN = 1`，而
  // `day = 1 + 3×圈数 + 打卡次数`——注意开头的那个 `1 +`。
  // 刷满五座要 15 次打卡，于是认真玩一圈的实际账是：
  //
  // | 圈数 | day | 状态 |
  // |-----:|-----:|:-----|
  // | 3 | 25 | 宽裕 |
  // | 4 | 28 | 余 2 天 |
  // | **5** | **31** | **过期**（`DAYS_LIMIT = 30`） |
  //
  // 也就是说**门槛不是"磨蹭"，是第五圈**——而刷满评级（五座各三次）要的
  // 恰恰是第五圈。**认真玩到底的人一定过期**：这不是失误，是路线本身的长度。
  //
  // 那条路径上"过期"与"完满"必然同时成立，所以 `afterCheckInRoute()`
  // 必须让完满先判（`phase.ts` 里写着理由，`verify_after_checkin_route` 守着）。
  // 两件事的处理是分开且都不吃亏的：完满面板照弹，目标换成 `back_break` 那个留白结局。
  //
  // 要不要把 `DAYS_LIMIT` 调成 31 让认真玩刚好不超时，是**产品取舍**，
  // 不是这里该顺手改的常数——改它会同时动到 `verify_days` 的基线。

  /** 骑完一圈花几天。 */
  static readonly DAYS_PER_LAP = 3;
  /** 一次打卡花几天。 */
  static readonly DAYS_PER_CHECKIN = 1;
  /** 总共多少天。 */
  static readonly DAYS_LIMIT = 30;

  /** 骑完的圈数（≥0）。落盘。 */
  laps = 0;
  /** 累计打卡次数（落盘，由 `checkIn` 自己加）。 */
  checkIns = 0;

  /** 骑完一圈记一天账。**只由世界层在圈数真的 +1 时调。** */
  noteLap() {
    this.laps++;
    this.save();
  }

  /** 今天是第几天。1 起。 */
  get day(): number {
    return (
      1 +
      this.laps * GameStateManager.DAYS_PER_LAP +
      this.checkIns * GameStateManager.DAYS_PER_CHECKIN
    );
  }

  /** 还剩几天。**可以是 0，也可以是负数**——过期是一个状态，不是一个失败。 */
  get daysLeft(): number {
    return Math.max(0, GameStateManager.DAYS_LIMIT - this.day);
  }

  /** 过期了吗。 */
  get overdue(): boolean {
    return this.day > GameStateManager.DAYS_LIMIT;
  }

  /**
   * 这一趟现在该做什么。
   *
   * 过期之后目标**从"收齐五件乐事"变成"回去把话说完"**——
   * 走的还是同一条路、同一辆车，但目标换了一个，而 `back_break` 那个结局
   * 就是为它准备的。
   *
   * 过期**不是失败画面**：README 写着"没有会结束这一趟的失败画面"，
   * 而这句话和"有时间限制"是可以同时成立的——
   * 过期了不会死，只是事情变成了另一种样子。
   */
  get objective(): 'collect' | 'return' {
    if (this.allCollected() && !this.chapter1Done) return 'return';
    return 'collect';
  }

  /** 过期之后的目标文案键。 */
  get objectiveKey(): 'objective_collect' | 'objective_return' | 'objective_overdue' {
    if (this.overdue) return 'objective_overdue';
    return this.objective === 'return' ? 'objective_return' : 'objective_collect';
  }

  /**
   * 第一章完成。**一次性闩锁**：返回 true 表示"这一次调用真的完成了它"，
   * 于是触发结算的那一侧可以安全地重入。
   *
   * 第二章在这里解锁，但**不自动开始**——让它只落到存档里，
   * 由标题页显示。自动跳章会让玩家来不及看明信片。
   */
  claimChapter1Complete(): boolean {
    if (this.chapter1Done) return false;
    if (!this.allCollected()) return false;
    this.chapter1Done = true;
    this.chapter = 2;
    this.save();
    return true;
  }

  /** 十八驿到了没有（玩家在范围内且这一章正在等他回去） */
  atHome(stationIdx: number, dist: number, reach: number): boolean {
    return this.objective === 'return' && stationIdx === GameStateManager.HOME_STATION && dist <= reach;
  }

  /** 存档后端。默认 `localStorage`，无头回归注入内存实现。 */
  store: SaveStore = defaultStore();

  constructor(store?: SaveStore) {
    if (store) this.store = store;
    this.resetState();
  }

  private resetState() {
    this.collected = new Map();
    for (const idx of ROAD.FRAGMENT_SLOT_STATION_IDX) this.collected.set(idx, 0);
    this.collectedFired = false;
    this.lvbi = 0;
    this.inv = new Map();
    this.spentKm = 0;
    this.earnedTags = new Set();
    this.seenStations = new Set();
    this.mood = ECON.MOOD_INITIAL;
    this.seenVillain = 0;
    this.prologueDone = false;
    this.voiceDone = false;
    this.endingId = '';
    this.progressKm = 0;
    this.onboardingShown = false;
    this.currentState = 'GIFT_BOX';
    this.chapter = 1;
    this.chapter1Done = false;
    this.laps = 0;
    this.checkIns = 0;
  }

  reset() {
    this.resetState();
    this.clearSave();
  }

  // ================= 打卡 =================

  checkIn(stationIndex: number): boolean {
    if (stationIndex < 0) return false;
    if (!ROAD.FRAGMENT_SLOT_STATION_IDX.includes(stationIndex)) return false;
    const prev = this.collected.get(stationIndex) ?? 0;
    const next = Math.min(prev + 1, ECON.MAX_VISITS_PER_STATION);
    if (next <= prev) return false;

    this.collected.set(stationIndex, next);
    this.checkIns++;
    if (prev === 0) {
      this.earn(ECON.LVBI_FIRST_CHECKIN, `checkin_${stationIndex}_1`);
      this.earn(ECON.LVBI_PER_FRAGMENT, `frag_${stationIndex}`);
      this.costMood(1); // 深度余响的代价
      this._l.fragment(stationIndex);
    } else {
      this.earn(ECON.LVBI_REPEAT_CHECKIN, `checkin_${stationIndex}_${next}`);
    }
    this.save();

    if (this.allCollected() && !this.collectedFired) {
      this.collectedFired = true;
      this._l.allCollected();
    }
    // 原来这里还有一个 `allMaxed` 事件（`allFragmentsMaxed()` 时发一次），
    // **零订阅**。而"五座各去三次"这一刻真正发生的地方是
    // `main.afterMiniGame()`：它在结算屏落幕后直接判 `allFragmentsMaxed()`
    // 然后弹合成面板。事件和那个判断是同一件事的两个来源，
    // 留着一个没人听的，等于给"完满评级"准备了第二条会漂移的路径。
    // 所以事件删掉，判断留在 afterMiniGame —— 那是玩家真的能看见的那一处。
    return true;
  }

  getStationCount(stationIdx: number): number {
    return this.collected.get(stationIdx) ?? 0;
  }

  isCollected(stationIdx: number): boolean {
    return this.getStationCount(stationIdx) > 0;
  }

  isStationExhausted(stationIdx: number): boolean {
    return this.getStationCount(stationIdx) >= ECON.MAX_VISITS_PER_STATION;
  }

  /**
   * 这座碎片驿站还欠一次到访吗？
   *
   * 完满评级要求五座各去三次，所以"还没收"从来不是目标的全集。
   * 顶栏 / 小地图 / 脚下提示圈三处都调这一个函数。
   */
  fragmentStationNeedsVisit(stationIdx: number): boolean {
    if (!ROAD.FRAGMENT_SLOT_STATION_IDX.includes(stationIdx)) return false;
    return this.getStationCount(stationIdx) < ECON.MAX_VISITS_PER_STATION;
  }

  /**
   * 刷满五座各三次**还欠多少次到访**。
   *
   * 与 `fragmentStationNeedsVisit` 同源：同一个 `MAX_VISITS_PER_STATION`，
   * 所以「哪一座还欠」和「一共欠几次」不可能对不上。
   *
   * 它存在的原因是**可达性**：集齐五件之后 `objective` 变成 `'return'`，
   * 顶栏「下一处」那一格改为指向十八驿（`hud.ts` 那一支的 `return`），
   * 于是「再访 · 还差 N 次」这一档**在整章剩下的时间里都不会再出现**——
   * 而完满评级要的正是那 10 次到访。玩家看不到还欠多少，就只会一路骑回家
   * 把这一趟收掉。把这个数算出来放进那一格，缺的那句话才有着落。
   */
  fragmentVisitsRemaining(): number {
    return ROAD.FRAGMENT_SLOT_STATION_IDX.reduce(
      (sum, i) => sum + Math.max(0, ECON.MAX_VISITS_PER_STATION - this.getStationCount(i)),
      0,
    );
  }

  allCollected(): boolean {
    return ROAD.FRAGMENT_SLOT_STATION_IDX.every((i) => (this.collected.get(i) ?? 0) > 0);
  }

  allFragmentsMaxed(): boolean {
    return ROAD.FRAGMENT_SLOT_STATION_IDX.every(
      (i) => (this.collected.get(i) ?? 0) >= ECON.MAX_VISITS_PER_STATION,
    );
  }

  getCollectedCount(): number {
    return ROAD.FRAGMENT_SLOT_STATION_IDX.filter((i) => (this.collected.get(i) ?? 0) > 0).length;
  }

  /** 已经过的驿站数。全 16 站一起数，这是唯一留在玩家面前的进度单位。 */
  getSeenStationCount(): number {
    return this.seenStations.size;
  }

  isFragmentCollected(slot: number): boolean {
    if (slot < 0 || slot >= ROAD.FRAGMENT_SLOT_STATION_IDX.length) return false;
    return (this.collected.get(ROAD.FRAGMENT_SLOT_STATION_IDX[slot]) ?? 0) > 0;
  }

  fragmentSlotVisitsLeft(slot: number): number {
    if (slot < 0 || slot >= ROAD.FRAGMENT_SLOT_STATION_IDX.length) return 0;
    const cnt = this.collected.get(ROAD.FRAGMENT_SLOT_STATION_IDX[slot]) ?? 0;
    return Math.max(ECON.MAX_VISITS_PER_STATION - cnt, 0);
  }

  // ================= 旅币 =================

  /**
   * 每骑过 1 整公里 +2。只在跨过整数公里时发钱。
   * 帧间只记进度，所以每帧调也不会每帧写盘。
   */
  earnKm(newKm: number): number {
    const clamped = Math.min(Math.max(newKm, 0), ECON.TOTAL_ROUTE_KM);
    const whole = Math.floor(clamped);
    if (whole > Math.floor(this.spentKm)) {
      const gained = (whole - Math.floor(this.spentKm)) * ECON.LVBI_PER_KM;
      this.spentKm = whole;
      this.lvbi += gained;
      this._l.lvbi({ delta: gained, total: this.lvbi });
      this.save();
      return gained;
    }
    if (clamped > this.spentKm) this.spentKm = clamped;
    return 0;
  }

  /** tag 幂等：同一个 tag 只发一次。空 tag 每次都发。 */
  earn(amount: number, tag = ''): number {
    if (amount <= 0) return 0;
    if (tag !== '') {
      if (this.earnedTags.has(tag)) return 0;
      this.earnedTags.add(tag);
    }
    this.lvbi += amount;
    this._l.lvbi({ delta: amount, total: this.lvbi });
    return amount;
  }

  /** 首次路过任意驿站 +3。16 站里 11 座没有碎片，这条让它们都有存在理由。 */
  onStationPass(stationIdx: number): number {
    if (this.seenStations.has(stationIdx)) return 0;
    this.seenStations.add(stationIdx);
    const gained = this.earn(ECON.LVBI_PER_PASS, `pass_${stationIdx}`);
    this.save();
    return gained;
  }

  onMiniGame(stationIdx: number, win: boolean): number {
    const amount = win ? ECON.LVBI_MINI_WIN : ECON.LVBI_MINI_LOSE;
    const tag = win ? `mini_${stationIdx}_win` : `mini_${stationIdx}_lose`;
    const gained = this.earn(amount, tag);
    this.save();
    return gained;
  }

  // ================= 心神 =================

  /** 只扣不锁：下限 1，永不归零。不做成失败条件。 */
  costMood(amount = 1): number {
    const before = this.mood;
    this.mood = Math.max(ECON.MOOD_FLOOR, this.mood - amount);
    const delta = this.mood - before;
    if (delta !== 0) this._l.mood(this.mood);
    return delta;
  }

  /** 心神的上行口。满的时候返回 0（买东西不能白花旅币）。 */
  restoreMood(amount = 1): number {
    const before = this.mood;
    this.mood = Math.min(ECON.MOOD_CEIL, this.mood + amount);
    const delta = this.mood - before;
    if (delta !== 0) {
      this._l.mood(this.mood);
      this.save();
    }
    return delta;
  }

  /**
   * 心神 → 视野遮罩不透明度。0 = 看得清，0.34 = 雾最浓。
   * 只有心神进这条：灯笼/香囊走 getVisibilityFactor()，不把雾买散。
   */
  getMoodMaskAlpha(): number {
    const t = (ECON.MOOD_CEIL - this.mood) / (ECON.MOOD_CEIL - ECON.MOOD_FLOOR);
    return Math.min(Math.max(ECON.MOOD_MASK_MAX * t, 0), ECON.MOOD_MASK_MAX);
  }

  /** 心神 → 草皮与树的可见半径系数。灯笼撑回来，香囊把惩罚砍一半。 */
  getVisibilityFactor(): number {
    const t = (ECON.MOOD_CEIL - this.mood) / (ECON.MOOD_CEIL - ECON.MOOD_FLOOR);
    let penalty = 1 - (ECON.MOOD_VIS_MAX + (ECON.MOOD_VIS_MIN - ECON.MOOD_VIS_MAX) * t);
    if (this.hasItem('sachet')) penalty *= ECON.SACHET_PENALTY_SCALE;
    let base = 1 - penalty;
    const lamps = Math.min(this.getItemCount('lamp'), ECON.LAMP_VIS_MAX_OWN);
    base *= Math.min(1 + ECON.LAMP_VIS_STEP * lamps, ECON.LAMP_VIS_CAP);
    return Math.min(Math.max(base, ECON.VIS_FLOOR), ECON.VIS_CEIL);
  }

  // ================= 背包 =================

  getItemCount(id: string): number {
    return this.inv.get(id) ?? 0;
  }

  hasItem(id: string): boolean {
    return this.getItemCount(id) > 0;
  }

  getPostcardTier(): number {
    return this.inv.get('postcard_tier') ?? 0;
  }

  canBuy(g: GoodDef): boolean {
    if (g.price > this.lvbi) return false;
    if (g.requires_fragments > this.getCollectedCount()) return false;
    if (g.grant === 'postcard_tier') return this.getPostcardTier() < (g.tier_rank ?? 1);
    if (g.grant === 'mood_up') {
      // 满心神时买它等于白花旅币，所以这条要真的挡在 canBuy 里，
      // 不能只把按钮画灰——灰按钮玩家看得见，绕过去照样把钱花掉。
      if (this.mood >= ECON.MOOD_CEIL) return false;
    }
    return this.getItemCount(g.id) < (g.max_own ?? 1);
  }

  buy(g: GoodDef): boolean {
    if (!this.canBuy(g)) return false;
    this.lvbi -= g.price;
    if (g.grant === 'postcard_tier') {
      this.inv.set('postcard_tier', g.tier_rank ?? 1);
    } else {
      this.inv.set(g.id, this.getItemCount(g.id) + 1);
      if (g.grant === 'mood_up') this.restoreMood(g.mood_up ?? 1);
    }
    this._l.lvbi({ delta: -g.price, total: this.lvbi });
    this._l.item(g.id);
    this.save();
    return true;
  }

  goodsForShop(shopName: string): GoodDef[] {
    return SHOPS.GOODS.filter((g) => g.sell_at === shopName);
  }

  shopAtStation(idx: number): string {
    return SHOPS.SHOP_AT_STATION[String(idx)] ?? '';
  }

  shopUnlockSeen(shopName: string): number {
    return SHOPS.TABLE[shopName]?.seen_unlock ?? 0;
  }

  // ================= 剧情 =================

  markPrologueDone() {
    this.prologueDone = true;
    this.save();
  }

  /**
   * 驿里那个声音是否已经引过路。**一次性**，落盘。
   *
   * ## 为什么它要落盘，而 `junctionLap` 那种"每圈一次"的不落盘
   *
   * 交叉口那句「路自此复」每圈都成立——它提醒的正是"你又走回来了"，
   * 而 `junctionLap` 只活在本次会话里，于是重开一趟它从第一圈重新数，
   * 这正是要的。
   *
   * 这一句不一样：它是一次**引路**——把"五件乐事散在一条路上"这件事
   * 交给玩家，交给完就没有下文了。读第二遍的收益是零，
   * 而一个在老驿站门口反复报菜名的声音会让那个地方从"有人在这儿"
   * 掉成"有个 UI 在循环"。所以它跟 `prologueDone` 一样落盘。
   */
  claimVoiceGuide(): boolean {
    if (this.voiceDone) return false;
    this.voiceDone = true;
    this.save();
    return true;
  }

  /**
   * 反派场次（1-based）。返回 true 表示这一场该播。
   * 严格顺序：必须 i === seenVillain + 1。跳场会把漏掉的对白永久吞掉。
   */
  claimVillainScene(i: number): boolean {
    if (i < 1 || i > ECON.VILLAIN_SCENE_COUNT || this.seenVillain !== i - 1) return false;
    this.seenVillain = i;
    this.save();
    return true;
  }

  setEnding(ending: string) {
    this.endingId = ending;
    this.save();
  }

  setState(s: GameState) {
    this.currentState = s;
    this._l.state(s);
  }

  /** 展示用：让这一趟补齐成完满评级。演示与"跳过"用。 */
  fillFinishedRun() {
    for (let i = 0; i < 16; i++) this.seenStations.add(i);
    for (const si of ROAD.FRAGMENT_SLOT_STATION_IDX) {
      this.collected.set(si, ECON.MAX_VISITS_PER_STATION);
    }
    this.inv.set('postcard_tier', 3);
    for (const id of ['paper', 'ink', 'seal', 'env']) this.inv.set(id, 1);
    this.seenVillain = ECON.VILLAIN_SCENE_COUNT;
    this.mood = ECON.MOOD_INITIAL;
  }

  // ================= 存档 =================

  save() {
    try {
      const blob: SaveBlob = {
        version: ECON.SAVE_VERSION,
        collected: Object.fromEntries(this.collected),
        progress_km: this.progressKm,
        onboarding_shown: this.onboardingShown ? 1 : 0,
        economy: {
          lvbi: this.lvbi,
          inv: Object.fromEntries(this.inv),
          spent_km: this.spentKm,
          earned_tags: [...this.earnedTags],
          seen_stations: [...this.seenStations].map(String),
          mood: this.mood,
          seen_villain: this.seenVillain,
          prologue_done: this.prologueDone,
          voice_done: this.voiceDone,
          ending_id: this.endingId,
          chapter: this.chapter,
          chapter1_done: this.chapter1Done,
          laps: this.laps,
          check_ins: this.checkIns,
        },
      };
      this.store.write(SAVE_KEY, JSON.stringify(blob));
      this._l.dirty();
    } catch {
      /* 无痕模式 / 配额满：不落盘，游戏照跑 */
    }
  }

  load(): boolean {
    try {
      const raw = this.store.read(SAVE_KEY);
      if (!raw) return false;
      const blob = JSON.parse(raw) as SaveBlob;
      if (blob.version !== ECON.SAVE_VERSION) {
        this.clearSave();
        return false;
      }
      for (const [k, v] of Object.entries(blob.collected ?? {})) {
        this.collected.set(Number(k), Number(v));
      }
      this.progressKm = Math.min(Math.max(Number(blob.progress_km) || 0, 0), ECON.TOTAL_ROUTE_KM);
      this.onboardingShown = blob.onboarding_shown === 1;

      const ec = blob.economy;
      if (ec) {
        this.lvbi = Math.max(0, Number(ec.lvbi) || 0);
        this.inv = new Map(Object.entries(ec.inv ?? {}).map(([k, v]) => [k, Number(v)]));
        this.spentKm = Math.min(Math.max(Number(ec.spent_km) || 0, 0), ECON.TOTAL_ROUTE_KM);
        this.earnedTags = new Set(ec.earned_tags ?? []);
        this.seenStations = new Set((ec.seen_stations ?? []).map(Number));
        this.mood = Math.min(Math.max(Number(ec.mood) || ECON.MOOD_INITIAL, ECON.MOOD_FLOOR), ECON.MOOD_CEIL);
        this.seenVillain = Math.max(0, Number(ec.seen_villain) || 0);
        this.prologueDone = ec.prologue_done === true;
        // 老存档没有这个字段。`?? false` 让它退回"还没引过路"，
        // 于是老存档读回来会在十八驿门口听见一次——那一趟本来就没听过，
        // 补一次是对的；反过来默认 true 就等于永久吞掉它。
        this.voiceDone = ec.voice_done === true;
        this.endingId = String(ec.ending_id ?? '');
        // 老存档没有这两个字段。`?? 1` / `?? false` 让它们退回"第一章、未完成"，
        // 于是老存档读回来会**重新**要求玩家回一次十八驿——这是对的：
        // 那些存档本来就没走完新的章节流程，补一次比"直接当成已完成"诚实。
        this.chapter = Math.max(1, Number(ec.chapter) || 1);
        this.chapter1Done = ec.chapter1_done === true;
        this.laps = Math.max(0, Number(ec.laps) || 0);
        // 老存档没有 `check_ins`。按**已经收掉的碎片数**推出来——
        // 那是下界（只算了首访），不会把日子算少，
        // 于是老存档读回来会**看起来更紧迫一点**，而不会更宽松。
        // 反过来默认 0 等于凭空还他十几天。
        this.checkIns = Math.max(
          0,
          Number(ec.check_ins) || ROAD.FRAGMENT_SLOT_STATION_IDX.filter((i) => this.isCollected(i)).length,
        );
      }
      // 必须在 collected 载入**之后**再对齐：这两个事件在存档写下的那一刻
      // 就已经发过了，读档回来不该再发一遍。
      this.collectedFired = this.allCollected();
      return true;
    } catch {
      this.clearSave();
      return false;
    }
  }

  clearSave() {
    try {
      this.store.remove(SAVE_KEY);
    } catch {
      /* 忽略 */
    }
  }

  hasSave(): boolean {
    try {
      return this.store.read(SAVE_KEY) !== null;
    } catch {
      return false;
    }
  }
}

export const game = new GameStateManager();
