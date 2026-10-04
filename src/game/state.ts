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
    ending_id: string;
    /** 1-based 章节号。老存档没有这个字段，读回时按 1 处理 */
    chapter?: number;
    chapter1_done?: boolean;
  };
}

type Listener<T> = (payload: T) => void;

const SAVE_KEY = 'gift188.save.v3';

export class GameStateManager {
  // 事件
  private _l: {
    fragment: Listener<number>;
    allCollected: Listener<void>;
    allMaxed: Listener<void>;
    lvbi: Listener<{ delta: number; total: number }>;
    mood: Listener<number>;
    item: Listener<string>;
    state: Listener<GameState>;
    dirty: Listener<void>;
  } = {
    fragment: () => {},
    allCollected: () => {},
    allMaxed: () => {},
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
  private maxedFired = false;

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

  /** 当前目标。'return' 只在集齐且第一章未完成时出现 */
  get objective(): 'collect' | 'return' {
    return this.allCollected() && !this.chapter1Done ? 'return' : 'collect';
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

  constructor() {
    this.resetState();
  }

  private resetState() {
    this.collected = new Map();
    for (const idx of ROAD.FRAGMENT_SLOT_STATION_IDX) this.collected.set(idx, 0);
    this.collectedFired = false;
    this.maxedFired = false;
    this.lvbi = 0;
    this.inv = new Map();
    this.spentKm = 0;
    this.earnedTags = new Set();
    this.seenStations = new Set();
    this.mood = ECON.MOOD_INITIAL;
    this.seenVillain = 0;
    this.prologueDone = false;
    this.endingId = '';
    this.progressKm = 0;
    this.onboardingShown = false;
    this.currentState = 'GIFT_BOX';
    this.chapter = 1;
    this.chapter1Done = false;
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
    if (this.allFragmentsMaxed() && !this.maxedFired) {
      this.maxedFired = true;
      this._l.allMaxed();
    }
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
          ending_id: this.endingId,
          chapter: this.chapter,
          chapter1_done: this.chapter1Done,
        },
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(blob));
      this._l.dirty();
    } catch {
      /* 无痕模式 / 配额满：不落盘，游戏照跑 */
    }
  }

  load(): boolean {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
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
        this.endingId = String(ec.ending_id ?? '');
        // 老存档没有这两个字段。`?? 1` / `?? false` 让它们退回"第一章、未完成"，
        // 于是老存档读回来会**重新**要求玩家回一次十八驿——这是对的：
        // 那些存档本来就没走完新的章节流程，补一次比"直接当成已完成"诚实。
        this.chapter = Math.max(1, Number(ec.chapter) || 1);
        this.chapter1Done = ec.chapter1_done === true;
      }
      // 必须在 collected 载入**之后**再对齐：这两个事件在存档写下的那一刻
      // 就已经发过了，读档回来不该再发一遍。
      this.collectedFired = this.allCollected();
      this.maxedFired = this.allFragmentsMaxed();
      return true;
    } catch {
      this.clearSave();
      return false;
    }
  }

  clearSave() {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* 忽略 */
    }
  }

  hasSave(): boolean {
    try {
      return localStorage.getItem(SAVE_KEY) !== null;
    } catch {
      return false;
    }
  }
}

export const game = new GameStateManager();
