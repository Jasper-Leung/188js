import type { Lang } from '../../data/raw';

export type MiniGameId = 'cloud' | 'tea' | 'zither' | 'bamboo' | 'bird';
export type MiniGameResult = 'win' | 'lose' | 'cancel';

/** 音效钩子。宿主实现，模块只管调。 */
export interface MiniGameAudio {
  /** 一次性音效，如 'collect' / 'zither_1' / 'bamboo_cut' / 'tea_pour' / 'bird_call' / 'cloud_brush' */
  sfx(name: string): void;
  /** 琴音：0..3 对应四个音高 */
  note(index: number): void;
  /** 环境音在小游戏期间要不要压低 */
  duckAmbient(on: boolean): void;
}

export interface MiniGamePalette {
  ink: string;        // 墨色文字
  paper: string;      // 纸底
  accent: string;     // 强调色（云/茶/琴/竹/禽各有主色）
  dim: string;        // 次要文字
  ok: string;
  bad: string;
}

export interface MiniGameContext {
  /** 已经调好 DPR 的 2D context，坐标系是 CSS 像素（左上原点） */
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  lang: Lang;
  palette: MiniGamePalette;
  audio: MiniGameAudio;
  /** 取文案。宿主传入，文案表在 ../../data/raw 的 I18N.zh / I18N.en */
  t(key: string, vars?: Record<string, string | number>): string;
  /** 本局的确定性种子（同一个驿站第几次到访 → 固定 seed），保证玩法可复现 */
  seed: number;
  /** 结束回调。cancel 只能是玩家按 Esc 触发的 */
  onDone(result: MiniGameResult): void;
  // ⚠️ 这里原来还有一个 `tick(dt)`，由宿主注入 `tick: (dt) => this.game?.step(dt)`。
  // 它和 `MiniGame.step(dt)` 是同一件事的两扇门，而**五个游戏一个都没读过 ctx.tick**——
  // 宿主自己的 `fixedUpdate()` 直接调 `step(dt)`。留着的害处不是"多一个字段"，
  // 而是下一个人会以为"游戏也可以走 tick 那扇门"，于是把状态机接到一个没人调的闭包上，
  // 而症状是游戏停在开场那一帧（和 `step` 漏掉时一模一样）。
  // 所以它删了，推进只有 `step` 一条路。
}

export interface MiniGame {
  readonly id: MiniGameId;
  /** 宿主在 update 里调它，内部决定是 update 还是 render */
  step(dt: number): void;
  /** 绘制。宿主在 render 里调它。 */
  draw(): void;
  /** 键盘。key 是 'ArrowLeft' 这种 code。返回 true 表示"我吃掉了这次按键" */
  onKeyDown(key: string, shift: boolean): boolean;
  onKeyUp(key: string): boolean;
  /** 指针。坐标是 CSS 像素。 */
  onPointerDown(x: number, y: number): void;
  onPointerMove(x: number, y: number): void;
  onPointerUp(x: number, y: number): void;
  /** 宿主在窗口尺寸变化时调，小游戏要自己重新布局 */
  resize(w: number, h: number): void;
  /** 玩家按 Esc。返回 true 表示已处理。 */
  cancel(): boolean;
  /** 资源清理 */
  dispose(): void;
}
