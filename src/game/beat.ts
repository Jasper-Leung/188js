/**
 * 骑行中的节拍 —— **第一件真正发生在"骑"这个动作上的乐事。**
 *
 * ## 为什么是它
 *
 * 五个小游戏（描云 / 注茶 / 琴记忆 / 竹 QTE / 观禽）**全部是单屏 2D 覆盖层**，
 * 没有一件和"骑"有关。它们填的是时间，不是玩法。
 *
 * 而这个游戏唯一的持续动作就是骑。所以哪怕只有一件乐事搬回路上，
 * 整个结构也会不一样：**玩家第一次有了一件"必须一边骑一边做"的事。**
 *
 * ## 为什么是"骑过竹丛时按一下"，而不是"停下来打一套"
 *
 * 骑行的乐趣来自**速度**，而停下来打 QTE 是把速度换成了点击。
 * 所以这里不要求停车：竹丛在**路边**，玩家经过时窗口打开，
 * 按对了就成。它和 `verify_offslow` 的路肩惩罚是同一套东西的两面——
 * 想拿全，得贴着竹丛骑；想稳，就得慢下来。**这个取舍本身就是玩法。**
 *
 * ## 不碰碎片经济
 *
 * 命中的奖励是旅币 + 一次结算提示，**不写进 `collected`**。
 * 原因很实际：碎片次数被 `verify_mini_game`（15 局每件 3 次）与
 * `verify_checkin`（"已收过"≠"不用再去"）钉着，
 * 往里加一路来源会让那两条判据同时红，而它们的红是**真的**——
 * 玩家会问"我明明只打了一次，为什么显示三次"。
 * 所以这一件乐事是**独立的一条**：它给旅币、给提示、给故事，不动收集。
 */
import { sceneryPlacements, type Scenery } from '../world/scenery';
import { CENTERLINE } from '../data/route';

/**
 * 进入这个距离内窗口打开。
 *
 * **24m。** 玩家在路面上离中心线最远 4m（`ROADMESH.TOTAL_HALF_WIDTH`），
 * 而节拍点落在 18m 处，所以这个半径覆盖了
 * "人贴着路肩、圈亮在路侧那片竹丛边上"这一种姿态。
 */
export const BEAT_ARM_RADIUS = 24;

/**
 * 更早的一档：**"前面有竹"**。
 *
 * ## 为什么节拍原本是"零提示"
 *
 * 旧物有两级（`relics.ts:388`）：18m 说"那边有东西"，2.8m 说"这件叫什么，按 F"。
 * 节拍一条都没有——于是玩家看到圈亮起时，既不知道那是什么，也不知道该按哪个键，
 * 而窗口只有 1.15s。**这一件乐事的第一分钟是白扔的。**
 *
 * ## 为什么是 48m
 *
 * 提前量 = `(48 - 24) / 车速`：巡航 11 m/s 时 2.2s，踩满 15 m/s 时 1.6s。
 * 不到 3 秒，但那句只有四个字（"前面有竹"），它是**状态播报**而不是操作说明——
 * 真正的操作说明在引导页 Controls 里（F = 摸旧物 / 竹丛里按节拍）。
 *
 * 再远就反了：48m 之外还有一段直路，提示会先于弯道亮起，
 * 玩家在看不见竹丛的时候被告知"前面有竹"，读到的是噪声。
 *
 * 窗口那一档（24m）**不许**给提示：1.15s 的窗口再叠一条 1.8s 的 toast，
 * 玩家会先读完字再按键，窗口早就过了。窗口由 HUD 上那个收缩的圈表示
 * （`ui.setBeat`），它比任何一行字都快。
 */
export const BEAT_CUE_RADIUS = 48;

/**
 * 节拍点离中心线多少米 —— **落在竹丛的临路边，不是丛心**。
 *
 * ## 为什么不是丛心
 *
 * 竹丛的落位规则是"离路 26~110m"（`scenery.ts` 的 `road: [26, 110]`）。
 * 直接拿丛心当节拍点，`verify_beat` 量出来是：**100 片里只有 1 片够得着**。
 * 玩家绕一圈只遇得到一次机会，而目标是 5 下——
 * 于是这个机制在判据上是绿的（"至少有一处可达"），在实际里是死的。
 *
 * ## 为什么落在 18m 这个数
 *
 * 18m = 路面半宽 4 + 临路缓冲 14。玩家贴着路肩骑时离它 14m，
 * 正常骑在路中心时离它 18m——**两种姿态都在 24m 窗口内**，
 * 而不需要玩家专门压草。压草是 `verify_offslow` 的事，不该由这一件来罚。
 *
 * 它同时是**看得见的**：18m 外是一片真实的竹丛，
 * 不像"空草地上凭空亮一个圈"那样读不出"为什么是现在"。
 */
export const BEAT_FROM_ROAD = 18;
/** 窗口时长（秒）。够在正常速度下反应一次，又短到不能提前乱按。 */
export const BEAT_WINDOW = 1.15;
/** 窗口外按 = 失手。**不惩罚**，只是这一下不算。 */
export const BEAT_KEY = 'KeyF';
/** 多少下算完成这一件乐事。 */
export const BEAT_GOAL = 5;

/**
 * `cue` = 进了 48m 那档（还没开窗口），`armed` = 窗口真的开了。
 * 两者必须分开：**提示在窗口之前，圈在窗口之中**。
 */
export type BeatEvent = 'cue' | 'armed' | 'hit' | 'miss' | 'done';

export interface BeatState {
  /** 窗口开着吗 */
  open: boolean;
  /** 窗口剩余比例 0~1（给 HUD 画收缩的圈） */
  remain: number;
  /** 已经按中的次数 */
  hits: number;
  goal: number;
  done: boolean;
}

export class BambooBeats {
  private points: { x: number; z: number }[] = [];
  private used = new Set<number>();
  private armedIdx = -1;
  private t = 0;
  private hits = 0;
  private done = false;
  /** 已经播过"前面有竹"的那些点。和 `used` 分开：提示过了不等于这一片用掉了。 */
  private cued = new Set<number>();
  /** 上一次按 F 的时刻，用来挡"连按刷" */
  private lastPress = -99;

  constructor(sc: Scenery) {
    const b = sceneryPlacements(sc).bamboo;
    // 每一片竹丛算一个节拍点，**位置推到它的临路边**（见 `BEAT_FROM_ROAD`）。
    // 方向取"最近中心线点 → 竹丛"，所以节拍落在丛与路之间的那一侧，
    // 也就是玩家骑过去时它在自己手边的那一侧。
    for (const p of b) {
      let nx = p.x;
      let nz = p.z;
      let bd = Infinity;
      for (const q of CENTERLINE) {
        const d = (q.x - p.x) * (q.x - p.x) + (q.z - p.z) * (q.z - p.z);
        if (d < bd) {
          bd = d;
          nx = q.x;
          nz = q.z;
        }
      }
      const dist = Math.sqrt(bd);
      if (dist < 1e-3) {
        this.points.push({ x: p.x, z: p.z });
        continue;
      }
      // 从中心线朝竹丛走 BEAT_FROM_ROAD 米
      const ux = (p.x - nx) / dist;
      const uz = (p.z - nz) / dist;
      this.points.push({ x: nx + ux * BEAT_FROM_ROAD, z: nz + uz * BEAT_FROM_ROAD });
    }
  }

  get pointCount(): number {
    return this.points.length;
  }

  /**
   * 真实落位。**给 `verify_beat` 量**——
   * 判据必须量**节拍点本身**，不能量竹丛圆心。
   *
   * 第一版量错了对象：拿 26~110m 外的丛心去比 24m 的窗口，
   * 于是报「1/100 够得着」，而实际上 100 个节拍点**全部**在路边 18m。
   * 一条量错了对象的判据会把正确的实现说成错的——
   * 这比没有判据更费时间，因为人会去改本来没错的那一半。
   */
  get allPoints(): readonly { x: number; z: number }[] {
    return this.points;
  }

  get state(): BeatState {
    return {
      open: this.armedIdx >= 0 && this.t < BEAT_WINDOW,
      remain: this.armedIdx >= 0 ? Math.max(0, 1 - this.t / BEAT_WINDOW) : 0,
      hits: this.hits,
      goal: BEAT_GOAL,
      done: this.done,
    };
  }

  /** 玩家按了节拍键。返回发生了什么。 */
  press(): BeatEvent {
    if (this.done) return 'miss';
    if (this.armedIdx < 0) return 'miss';
    if (this.t < BEAT_WINDOW) {
      this.hits++;
      this.used.add(this.armedIdx);
      this.armedIdx = -1;
      this.t = 0;
      if (this.hits >= BEAT_GOAL) {
        this.done = true;
        return 'done';
      }
      return 'hit';
    }
    // 窗口开着但已经超时的第一次按：算失手，并且**把这一片用掉**，
    // 免得玩家停在那儿一直按。
    this.used.add(this.armedIdx);
    this.armedIdx = -1;
    this.t = 0;
    return 'miss';
  }

  /** 挡连按：两次按之间至少 0.25s。 */
  allowPress(now: number): boolean {
    if (now - this.lastPress < 0.25) return false;
    this.lastPress = now;
    return true;
  }

  /** 每帧调用。`now` 是累计秒数，只用于挡连按。 */
  update(dt: number, px: number, pz: number, now: number): BeatEvent | null {
    this.t += dt;
    if (this.armedIdx >= 0) {
      if (this.t >= BEAT_WINDOW) {
        // 超时不算失手——**自动放弃**。
        // 惩罚一次"玩家正在拐弯没看见"是没有意义的，
        // 而 `verify_offslow` 已经惩罚了压草这件事，不该罚两次。
        this.used.add(this.armedIdx);
        this.armedIdx = -1;
        this.t = 0;
      }
      return null;
    }
    if (this.done) return null;
    // 一趟循环干两件事：先找开窗口的，再顺手记下够得着提示档的那一个。
    //
    // **开窗口优先于提示**：同一片竹同时满足两档时，只发 `armed`。
    // 反过来的话，玩家会先读到"前面有竹"、再看到圈亮起，
    // 而那一行字在圈亮起的时候已经读完了——提示退化成重复。
    let cueIdx = -1;
    for (let i = 0; i < this.points.length; i++) {
      if (this.used.has(i)) continue;
      const p = this.points[i];
      const d = Math.hypot(px - p.x, pz - p.z);
      if (d <= BEAT_ARM_RADIUS) {
        this.armedIdx = i;
        this.t = 0;
        return 'armed';
      }
      if (cueIdx < 0 && d <= BEAT_CUE_RADIUS && !this.cued.has(i)) cueIdx = i;
    }
    if (cueIdx >= 0) {
      this.cued.add(cueIdx);
      return 'cue';
    }
    void now;
    return null;
  }
}
