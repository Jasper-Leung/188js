/**
 * 性能面板 —— 帧率、绘制调用、三角面、渲染分辨率、档位。
 *
 * ## 帧率为什么自己数，而不是用 main 的 onStats
 *
 * `GameLoop` 每 0.5 秒算好 fps 与 frameMs 并回调 `onStats`，而 main 那一行
 * 写的是 `onStats: (fps, ms) => this.ui.update(0)`——两个值被丢掉了，
 * 只递了一个 0。所以本面板**自己数帧**：只统计 `dt > 0` 的那些调用
 * （也就是 main 从 `render()` 里递进来的那些真帧），
 * `update(0)` 那一次不计入。否则帧率会正好虚高一倍。
 *
 * ## 为什么要量化成整数
 *
 * 这一块是**每帧**更新的，而它挂在屏幕角上、盖着一小块世界。
 * 数字每帧都变的话，每一帧都要重新光栅化那几行字——在核显上这是
 * 实打实的成本。取整到整数帧率、0.5 秒才刷一次，
 * 一秒两次重排 vs 六十次，差 30 倍，而玩家分辨不出 59 和 60。
 *
 * 绘制调用与三角面**不取整**：这两个数是玩家判断「该关阴影还是该降分辨率」
 * 的依据，取整会把 87 变成 90，而 87 配 90 是两个不同的诊断。
 */
import { TIER_KEYS } from '../core/settings';
import { t } from '../i18n';
import { perf } from '../core/perf';
import { el, setShown, setText } from './dom';
import type { Tier } from '../core/capability';
import type { World } from '../world/world';

/** 统计窗口。0.5s 是 `loop.ts` 里那个窗口的同一个数。 */
const WINDOW = 0.5;

export interface PerfOpts {
  parent: HTMLElement;
  world: World;
  tier: Tier;
}

export class PerfPanel {
  readonly root: HTMLDivElement;
  private world: World;

  private fpsEl: HTMLSpanElement;
  private drawEl: HTMLSpanElement;
  private trisEl: HTMLSpanElement;
  private scaleEl: HTMLSpanElement;
  private tierEl: HTMLSpanElement;
  private speedEl: HTMLSpanElement;
  private roadEl: HTMLSpanElement;
  private phaseEl: HTMLSpanElement;

  private winMs = 0;
  private winFrames = 0;
  private visible = false;

  constructor(o: PerfOpts) {
    this.world = o.world;
    this.root = el('div', 'g-perf g-hidden');
    this.root.appendChild(el('div', 'g-perf-h', t('perf_title')));

    const add = (k: string): HTMLSpanElement => {
      const r = el('div', 'g-perf-r');
      r.appendChild(el('span', 'g-perf-k', k));
      const v = el('span', 'g-perf-v');
      r.appendChild(v);
      this.root.appendChild(r);
      return v;
    };

    this.fpsEl = add(t('hud_fps'));
    this.drawEl = add(t('hud_drawcalls'));
    this.trisEl = add(t('hud_tris'));
    this.scaleEl = add(t('hud_scale'));
    this.tierEl = add(t('hud_tier'));
    // 车速与"是否在路上"。这两行看起来多余，其实是排查骑行问题最快的两个数：
    // "车不动"可以是输入没进来（speed=0），也可以是车被推下路了
    // （speed=0 且 onRoad=false），而这两件事的修法完全不同。
    this.speedEl = add(t('hud_speed'));
    this.roadEl = add(t('hud_road'));
    this.phaseEl = add(t('hud_phase'));

    o.parent.appendChild(this.root);
    this.paint();
  }

  /**
   * 每帧调。`dt` 恒为 0 的那一次（main 的 onStats 转发）不计入帧数。
   * 面板收起来时仍然走计数，只是最后一步 `paint()` 早退——
   * 因为**切回来时第一眼要看到一个数**，而不是一个空面板等 0.5 秒。
   */
  update(dt: number): void {
    if (dt <= 0) return;
    this.winMs += dt * 1000;
    this.winFrames++;
    if (this.winMs < WINDOW * 1000) return;
    const fps = Math.round((this.winFrames * 1000) / this.winMs);
    this.winMs = 0;
    this.winFrames = 0;
    if (this.visible) this.paint(fps);
  }

  private paint(fps?: number): void {
    const s = this.world.renderer.stats();
    if (fps !== undefined) setText(this.fpsEl, String(fps));
    setText(this.drawEl, String(s.calls));
    setText(this.trisEl, String(s.triangles));
    setText(this.speedEl, `${this.world.ride.speedValue.toFixed(1)} m/s`);
    setText(this.roadEl, this.world.ride.onRoad() ? t('hud_road_yes') : t('hud_road_no'));
    // 阶段摆在车速旁边。车速 0 而画面全正常时，这一行就是答案。
    setText(this.phaseEl, perf.phase);
    // 显示成百分比而不是 0.6：这一栏下面跟着一个「低 / 中 / 高」，
    // 玩家读的是"我被压到几成"，不是"渲染器的某个浮点字段"。
    setText(this.scaleEl, `${Math.round(s.scale * 100)}%`);
  }

  setTier(tier: Tier): void {
    setText(this.tierEl, t(TIER_KEYS[tier]));
  }

  setVisible(v: boolean): void {
    this.visible = v;
    setShown(this.root, v);
    if (v) this.paint();
  }

  toggle(): void {
    this.setVisible(!this.visible);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** 切语言。 */
  sync(): void {
    const keys = [
      t('hud_fps'), t('hud_drawcalls'), t('hud_tris'), t('hud_scale'),
      t('hud_speed'), t('hud_road'), t('hud_tier'),
    ];
    const rows = this.root.querySelectorAll<HTMLElement>('.g-perf-k');
    for (let i = 0; i < rows.length && i < keys.length; i++) setText(rows[i], keys[i]);
    const head = this.root.querySelector<HTMLElement>('.g-perf-h');
    if (head) setText(head, t('perf_title'));
  }

  dispose(): void {
    this.root.remove();
  }
}
