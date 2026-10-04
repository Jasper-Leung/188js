/**
 * 触屏控件 —— 左下摇杆、右侧打卡、右上暂停/静音。
 *
 * ## 只在 pointer: coarse 时挂
 *
 * 挂不挂由宿主决定（`UI.setTouchMode()`，main 按 `matchMedia('(pointer: coarse)')`
 * 给），本文件只负责显示与隐藏。理由不是省那点内存：桌面机上多出四块
 * 半透明的 DOM，其中摇杆会一直**吃掉左下角一大片点击区**——
 * 玩家用鼠标点场景时如果点在那儿，事件被摇杆吞掉，而界面上看不出
 * 那里有东西。
 *
 * ## 摇杆的输出方向（一个容易搞反的约定）
 *
 * `UI.touch` 暴露的是 `{moveX, moveY, checkInPressed}`，main 把它
 * **加进** `RideInput`：`throttle += touch.moveY`。而 `RideInput.throttle`
 * 的约定是**负为前进**（`ride.ts` 里 `if (vert < -0.1) 加速`）。
 * 所以摇杆往上推必须是 **moveY = -1**。搞反了不会报任何错，
 * 症状是"往上推车往后走、往下推往前走"——一个玩家会立刻发现的 bug，
 * 但它只在真机上出现，桌面测不出来。
 *
 * ## 暂停按钮为什么要合成一次 Esc
 *
 * `UIHooks` 里只有 `onResume()`，没有 `onPause()`。而"暂停"在 main 里
 * 只由一个地方发起：window 的 keydown 里 `Escape` → `pause()`。
 * 触屏的暂停按钮**就是**那个 Esc——同一个意思、同一条判据——
 * 所以这里合成一次 keydown 交给它，而不是在 UI 里自己把暂停面板弹出来：
 * 那样做的话 main 的 phase 仍然是 'roaming'、主循环不会停，
 * 世界会在暂停面板后面继续跑。
 *
 * 这是一个需要宿主补 `onPause` 的地方，见交付报告里的歧义清单。
 */
import { t } from '../i18n';
import { audio } from '../core/audio';
import { button, el, setFlag, setShown, setText } from './dom';
import { wireKeyActivate } from './hud';
import { WORLD, ROADMESH } from '../data/raw';
import type { UIHooks } from './index';
import type { World } from '../world/world';
import type { GameStateManager } from '../game/state';

/** 摇杆的行程（px）。超过这个距离就按比例饱和，不会无限加速。 */

export interface TouchOpts {
  parent: HTMLElement;
  hooks: UIHooks;
  world: World;
  game: GameStateManager;
}

/**
 * 摇杆解算与方向键映射都在 `core/stick.ts`——它们是纯数值，
 * 放在这里会让无头回归为了验一行算术而拖进整套 DOM。
 * 本文件只负责"把事件变成意图"和显示。
 */
import { STICK_R, stickVector, keyToVec } from '../core/stick';

export class TouchControls {
  readonly root: HTMLDivElement;

  /**
   * 写进 world 的输入意图。**对象本身**被 UI 直接透给宿主
   * （`UI.touch` 就是它），所以宿主每帧读完把 `checkInPressed` 清成 false
   * 时，清的就是这里那一个字段——不是副本。
   */
  readonly state = { moveX: 0, moveY: 0, checkInPressed: false };

  private hooks: UIHooks;
  private world: World;
  private game: GameStateManager;

  private stick: HTMLDivElement;
  private knob: HTMLDivElement;
  private checkBtn: HTMLButtonElement;
  private pointerId = -1;

  constructor(o: TouchOpts) {
    this.hooks = o.hooks;
    this.world = o.world;
    this.game = o.game;

    this.root = el('div', 'g-touch g-hidden');

    // ---- 左下摇杆 ----
    const stickWrap = el('div', 'g-stick');
    this.stick = el('div', 'g-stick-base');
    // 摇杆也要能被键盘驱动：Tab 得到它之后方向键就能推。
    // 触屏设备上一般用不到，但外接键盘 / 平板键盘 / 辅助技术都要这一条。
    this.stick.tabIndex = 0;
    this.stick.setAttribute('role', 'application');
    this.stick.setAttribute('aria-label', t('touch_joystick_key'));
    this.knob = el('div', 'g-stick-knob');
    this.stick.appendChild(this.knob);
    stickWrap.appendChild(this.stick);
    this.root.appendChild(stickWrap);

    this.stick.addEventListener('pointerdown', (e) => {
      this.pointerId = e.pointerId;
      this.stick.setPointerCapture(e.pointerId);
      this.moveTo(e);
      e.preventDefault();
    });
    this.stick.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.pointerId) return;
      this.moveTo(e);
    });
    const release = (e: PointerEvent) => {
      if (e.pointerId !== this.pointerId) return;
      this.pointerId = -1;
      this.state.moveX = 0;
      this.state.moveY = 0;
      this.paintKnob();
    };
    this.stick.addEventListener('pointerup', release);
    this.stick.addEventListener('pointercancel', release);
    this.stick.addEventListener('lostpointercapture', release);

    // 键盘驱动摇杆
    this.stick.addEventListener('keydown', (e) => {
      const v = keyToVec(e.code);
      if (!v) return;
      e.preventDefault();
      e.stopPropagation();
      this.state.moveX = v[0];
      this.state.moveY = v[1];
      this.paintKnob();
    });
    this.stick.addEventListener('keyup', (e) => {
      if (!keyToVec(e.code)) return;
      e.stopPropagation();
      this.state.moveX = 0;
      this.state.moveY = 0;
      this.paintKnob();
    });
    this.stick.addEventListener('blur', () => {
      this.state.moveX = 0;
      this.state.moveY = 0;
      this.paintKnob();
    });

    // ---- 右侧打卡 ----
    const right = el('div', 'g-touch-r');
    this.checkBtn = button(t('touch_checkin_button'), {
      cls: 'g-touch-check',
      onClick: () => {
        this.state.checkInPressed = true;
        this.hooks.onCheckIn();
      },
    });
    right.appendChild(this.checkBtn);
    this.root.appendChild(right);

    // ---- 右上：暂停 / 静音 ----
    const top = el('div', 'g-touch-t');
    const pauseBtn = button(t('touch_pause_button'), {
      cls: 'g-touch-sq',
      aria: t('key_pause'),
      onClick: () => requestPause(),
    });
    const muteBtn = button(t('touch_mute_button'), {
      cls: 'g-touch-sq',
      aria: t('key_mute'),
      onClick: () => this.toggleMute(),
    });
    top.appendChild(pauseBtn);
    top.appendChild(muteBtn);
    this.root.appendChild(top);

    for (const b of this.root.querySelectorAll<HTMLElement>('.g-btn')) {
      wireKeyActivate(b, () => b.click());
    }
    o.parent.appendChild(this.root);
  }

  private moveTo(e: PointerEvent): void {
    const r = this.stick.getBoundingClientRect();
    const cx = r.left + r.width * 0.5;
    const cy = r.top + r.height * 0.5;
    const [mx, my] = stickVector((e.clientX - cx) / STICK_R, (e.clientY - cy) / STICK_R);
    this.state.moveX = mx;
    this.state.moveY = my;
    this.paintKnob();
  }

  private paintKnob(): void {
    const x = (this.state.moveX * STICK_R).toFixed(1);
    const y = (this.state.moveY * STICK_R).toFixed(1);
    this.knob.style.setProperty('transform', `translate(${x}px, ${y}px)`);
  }

  /**
   * 打卡按钮的可用态与文案。
   *
   * 判据用 `world.nearby` 而不是自己重算——理由和 HUD 的脚下提示圈一样：
   * 「这里还欠一次到访吗」只有 `fragmentStationNeedsVisit()` 一个判据。
   */
  sync(): void {
    const nb = this.world.nearby;
    const inRange =
      nb.index >= 0 &&
      nb.hasFragment &&
      nb.needsVisit &&
      nb.distance <= WORLD.STATION_PASS_RADIUS + ROADMESH.TOTAL_HALF_WIDTH;
    const revisited = inRange && this.game.getStationCount(nb.index) > 0;
    setText(this.checkBtn, revisited ? t('touch_revisit_button') : t('touch_checkin_button'));
    setFlag(this.checkBtn, 'is-live', inRange);
  }

  /**
   * 全局静音。状态从 `audio` 读而不是自己存一份——M 键（在桌面端）
   * 会直接改 audio 而不经过任何 hook，UI 存的那份会开始说谎。
   * 报的是三个值一起，因为 `onMuteChange` 是全量签名，而宿主那边
   * 三个都是幂等 setter。
   */
  private toggleMute(): void {
    this.hooks.onMuteChange(audio.bgmMuted, audio.sfxMuted, !audio.fullyMuted);
  }

  setMode(on: boolean): void {
    setShown(this.root, on);
    if (!on) {
      this.state.moveX = 0;
      this.state.moveY = 0;
      this.pointerId = -1;
      this.paintKnob();
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

/** 方向键 → [x, y]。注意 y 向上为负（见文件头的约定）。 */

/**
 * 请求暂停。合成一次 Esc 键，交给 main 里那一个判据。
 * 理由见文件头——UIHooks 里没有 onPause。
 */
function requestPause(): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }),
  );
}
