/**
 * 性能快照 —— 循环写、性能面板读。
 *
 * 为什么要单独一个模块：帧率是 `GameLoop` 算出来的，而要显示它的是 UI。
 * 两者之间如果直接传，就要在 `UIOptions` 上多开一个回调，或者让 UI 反向
 * import 循环——两种都把"谁依赖谁"搅在一起。这个模块是它们的公共黑板：
 * 循环往里写，面板从里面读，谁也不认识谁。
 *
 * 刻意只有一个可变对象而不是事件：面板每 0.5 秒读一次，走事件只会多出
 * 一堆没人订阅的分配。
 */
import type { Tier } from './capability';

export interface PerfSnapshot {
  fps: number;
  frameMs: number;
  /** draw call 数 */
  calls: number;
  triangles: number;
  textures: number;
  /** 内部渲染分辨率倍率（自适应会改它） */
  renderScale: number;
  /** 窗口 CSS 尺寸 */
  cssW: number;
  cssH: number;
  /** 实际 drawingBuffer 尺寸——低配上这两个数的比值就是"糊了多少" */
  bufferW: number;
  bufferH: number;
  /** 可见的植被块 / 实例数 */
  vegChunks: number;
  vegTrees: number;
  vegBushes: number;
  vegGrass: number;
  tier: Tier;
  /** 玩家手动动过画质——动过之后"建议档"就不再自动覆盖 */
  qualityTouched: boolean;
  /**
   * 当前阶段机状态。
   *
   * 放进性能面板是因为它救过一次命：症状是"车速 0.0 而画面全正常"，
   * 而 phase 是**唯一一个在界面上看不见的**否决理由——面板开着、对白亮着、
   * 镜头在转，玩家都会以为"那肯定是能骑的"。把 phase 摆在车速旁边，
   * 下一��看到"车速 0.0 / 阶段 onboarding"就不用再猜了。
   */
  phase: string;
}

export const perf: PerfSnapshot = {
  fps: 0,
  frameMs: 0,
  calls: 0,
  triangles: 0,
  textures: 0,
  renderScale: 1,
  cssW: 0,
  cssH: 0,
  bufferW: 0,
  bufferH: 0,
  vegChunks: 0,
  vegTrees: 0,
  vegBushes: 0,
  vegGrass: 0,
  tier: 1,
  qualityTouched: false,
  phase: 'boot',
};

export function resetPerf() {
  perf.fps = 0;
  perf.frameMs = 0;
}
