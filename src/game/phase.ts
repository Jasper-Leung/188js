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
