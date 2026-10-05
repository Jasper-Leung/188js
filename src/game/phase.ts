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
 */

export type Phase = 'boot' | 'title' | 'onboarding' | 'roaming' | 'paused' | 'checkin' | 'minigame' | 'synthesis' | 'endcard';

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
  /** 够得着的距离阈值：驿站半径 + 路半宽 */
  reach: number;
  /** 打卡过场是否进行中（镜头接管中不抢） */
  busy: boolean;
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
