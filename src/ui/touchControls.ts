import { touchHand, requestLandscape } from '../core/touchLayout';
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
import { codeOf } from '../core/keymap';
import { button, el, setAttr, setFlag, setShown, setText } from './dom';
import { wireKeyActivate } from './hud';
import { STATION_REACH } from '../game/phase';
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
 *
 * `holdPressed` 是给**按住**用的动词（钓鱼收线、云、茶）。
 * 原来没有它，于是触屏上根本没有"按住"这个动作——
 * 而"按住"恰好是这三个小游戏与整局钓鱼**唯一**的输入方式。
 * 症状不是"按了没反应"，而是"这一屏在触屏上根本没法玩"。
 */
readonly state = { moveX: 0, moveY: 0, checkInPressed: false, holdPressed: false };

  private hooks: UIHooks;
  private world: World;
  private game: GameStateManager;

  private stick: HTMLDivElement;
  private knob: HTMLDivElement;
  private checkBtn: HTMLButtonElement;
  private vehicleBtn: HTMLButtonElement;
  private pauseBtn: HTMLButtonElement;
  private muteBtn: HTMLButtonElement;
  private rotate: HTMLDivElement;
  private rotateMessage: HTMLParagraphElement;
  private rotateBtn: HTMLButtonElement;
  private portraitBtn: HTMLButtonElement;
  private cleanup: Array<() => void> = [];
  /** 「摸一下」那颗。对应 `GameAction` 里的 `interact`（键盘默认 F）。 */
  private actBtn!: HTMLButtonElement;
  private pointerId = -1;
  /** 湖边那一屏：摇杆 = 走、大按钮 = 抛竿。默认 false。 */
  private lakesideMode = false;

  constructor(o: TouchOpts) {
    this.hooks = o.hooks;
    this.world = o.world;
    this.game = o.game;

    this.root = el('div', 'g-touch g-hidden');
    const hand = () => { o.parent.dataset.touchHand = touchHand(); };
    hand(); window.addEventListener('gift188-touch-hand', hand);
    this.cleanup.push(() => window.removeEventListener('gift188-touch-hand', hand));
    this.rotate = el('div', 'g-rotate');
    this.rotateMessage = el('p', '', t('touch_rotate_hint'));
    this.rotateBtn = button(t('touch_landscape'), { onClick: () => { void requestLandscape().then(ok => { if (!ok) setText(this.rotateMessage, t('touch_rotate_manual')); }); } });
    this.portraitBtn = button(t('touch_portrait_continue'), { onClick: () => { o.parent.dataset.portraitAllowed = 'yes'; } });
    this.rotate.appendChild(this.rotateMessage);
    this.rotate.appendChild(this.rotateBtn);
    this.rotate.appendChild(this.portraitBtn);
    o.parent.appendChild(this.rotate);

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

    // ---- 右侧打卡 / 抛竿 ----
    const right = el('div', 'g-touch-r');
    // **指针路径与键盘路径分开。** `pointerdown` 发边沿（抛竿）并开始按住；
    // `click` 只在没有指针参与时才发——否则一次点按会派发两次，
    // 而钓鱼那 1.15 秒的咬钩窗里按两下和按一下不是一回事。
    let pointerCast = false;
    this.checkBtn = button(t('touch_checkin_button'), {
      cls: 'g-touch-check',
      onClick: () => {
        if (pointerCast) {
          pointerCast = false;
          return;
        }
        this.pressAction();
      },
    });
    const press = (e: PointerEvent) => {
      try { this.checkBtn.setPointerCapture(e.pointerId); } catch { /* 某些浏览器拒绝 */ }
      pointerCast = true;
      this.state.holdPressed = true;
      this.pressAction();
      e.preventDefault();
    };
    const releaseAction = (e: PointerEvent) => {
      try { this.checkBtn.releasePointerCapture(e.pointerId); } catch { /* 同上 */ }
      this.state.holdPressed = false;
    };
    this.checkBtn.addEventListener('pointerdown', press);
    this.checkBtn.addEventListener('pointerup', releaseAction);
    this.checkBtn.addEventListener('pointercancel', releaseAction);
    this.checkBtn.addEventListener('lostpointercapture', releaseAction);
    right.appendChild(this.checkBtn);
    this.root.appendChild(right);

    // ---- 右上：暂停 / 静音 ----
    const top = el('div', 'g-touch-t');
    this.pauseBtn = button(t('touch_pause_button'), {
      cls: 'g-touch-sq',
      aria: t('key_pause'),
      onClick: () => requestPause(),
    });
    this.muteBtn = button(t('touch_mute_button'), {
      cls: 'g-touch-sq',
      aria: t('key_mute'),
      onClick: () => this.toggleMute(),
    });
    this.vehicleBtn = button(t('touch_vehicle'), { cls: 'g-touch-vehicle', aria: t('touch_vehicle'), onClick: () => {
      const code = codeOf('vehicle');
      window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));
    } });
    this.root.appendChild(this.vehicleBtn);
    top.appendChild(this.pauseBtn);
    top.appendChild(this.muteBtn);
    // ---- 「摸一下」那颗（F）----
    //
    // **它原来根本不存在**，而这是触屏上最大的一个洞：F 挂着节拍窗口、
    // 旧物、琴、木牌**和**湖边那一屏。没有它，触屏玩家摸不到任何一件旧物、
    // 进不去湖边、也读不了路边的字——而这些是这个游戏的全部内容。
    //
    // 它放在摇杆与右屏之间，而不是挤进右上那一排：那一排是"高频小按钮"，
    // 而「摸一下」是**这一屏最主要的动词**，值得一颗独立的、常亮的按钮。
    // 点击/点一下的边沿。**和湖边那颗按钮分开**，因为两个动作在相位上互斥
    // （`touchRoadside()` 取最近的那一个），而它们各自有自己的键。
    //
    // ⚠ **要带上 `checkBtn` 同款的双发守卫**：`preventDefault()` 抑制的是
    // 兼容鼠标事件，不抑制 `click`——一次点按会同时触发 `pointerdown` 和
    // `click` 两条路，而那一个键会派发两次。在木牌旁，一次点按会
    // 既读出木牌文字又直接起跑躲避挑战。
    let actPointer = false;
    this.actBtn = button(t('touch_act_button'), {
      cls: 'g-touch-act',
      aria: t('key_interact'),
      onClick: () => {
        if (actPointer) {
          actPointer = false;
          return;
        }
        this.sendInteract();
      },
    });
    this.actBtn.addEventListener('pointerdown', (e) => {
      actPointer = true;
      e.preventDefault();
      this.sendInteract();
    });
    this.root.appendChild(this.actBtn);
    this.root.appendChild(top);

    for (const b of this.root.querySelectorAll<HTMLElement>('.g-btn')) {
      wireKeyActivate(b, () => b.click());
    }
    o.parent.appendChild(this.root);

    /**
     * **窗口失焦时必须松手。**
     *
     * 键盘那条路有 `main.ts` 的 `window.addEventListener('blur', () => this.keys.clear())`
     * 兜着；而这一侧原来**没有**，于是：按住抛竿键切出去再切回来，
     * 那条鱼就在没人按着的时候自己收线；按着摇杆切出去再切回来，
     * 车就在没人推的时候自己开。
     *
     * `pointerdown` 里 `setPointerCapture` 会让 `pointerup` 跨过窗口边界送达，
     * 而**取消**（`pointercancel`）在切走的那一帧不一定到——
     * 所以只靠那四个监听器不够，这里再兜一层。
     */
    const dropAll = () => {
      this.state.moveX = 0;
      this.state.moveY = 0;
      this.state.checkInPressed = false;
      this.state.holdPressed = false;
      this.pointerId = -1;
      this.paintKnob();
    };
    window.addEventListener('blur', dropAll);
    window.addEventListener('orientationchange', dropAll);
    window.addEventListener('resize', dropAll);
    const visibility = () => { if (document.hidden) dropAll(); };
    document.addEventListener('visibilitychange', visibility);
    this.cleanup.push(() => {
      for (const event of ['blur', 'orientationchange', 'resize']) window.removeEventListener(event, dropAll);
      document.removeEventListener('visibilitychange', visibility);
    });
  }

  /**
   * 那颗大按钮的边沿。
   *
   * **湖边那一屏不走 `hooks.onCheckIn()`。** 那里站着没有驿站，
   * 而那一侧要的是"抛竿"——两条完全不同的动词。
   * 于是这里只把**意图**记进 `state`，由宿主按当前相位决定它是什么：
   * 骑行相位是打卡，湖边相位是抛竿。
   * （原来只有 `hooks.onCheckIn()` 一条路，于是湖边在触屏上没有任何动词。）
   */
  private pressAction(): void {
    this.state.checkInPressed = true;
    if (!this.lakesideMode) this.hooks.onCheckIn();
  }

  /**
   * 「摸一下」：节拍窗口 / 旧物 / 琴 / 木牌 / 进湖边，共用那把 F。
   *
   * ## 为什么是**合成键码**而不是一个 hook
   *
   * F 的判定在宿主的 `keydown` 监听器里（`case 'interact'`），
   * 而宿主那一侧还接着节拍窗口与短路。走 hook 的话就得把这一整套
   * 复制到 UI 层——而症状会是"触屏能摸到旧物、摸不到节拍、也进不去湖边"。
   *
   * 所以和 `requestPause()` 同一个做法：**合成一次真的按键**，
   * 让游戏自己的键盘监听器去消费。这一屏与 `main.ts` 里
   * 「动作只往下塞键码」那条硬约束是同一条。
   */
  private sendInteract(): void {
    const code = codeOf('interact');
    window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));
  }

  /**
   * 湖边模式：摇杆 = 走，那颗大按钮 = 抛竿 / 收线。
   *
   * 进去时**必须清掉按住状态**：从骑行切进来时手指多半还按着摇杆，
   * 而残留的 `holdPressed` 会让玩家一进湖边就"已经在收线"——
   * 而那条鱼还没抛出去。
   */
  setLakesideMode(on: boolean): void {
    if (this.lakesideMode === on) return;
    this.lakesideMode = on;
    setShown(this.vehicleBtn, !on);
    setShown(this.actBtn, !on);
    this.state.holdPressed = false;
    this.state.checkInPressed = false;
    this.state.moveX = 0;
    this.state.moveY = 0;
    this.paintKnob();
    if (on) setText(this.checkBtn, t('touch_cast_button'));
    else setText(this.checkBtn, t('touch_checkin_button'));
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
    setText(this.vehicleBtn, t('touch_vehicle'));
    setAttr(this.vehicleBtn, 'aria-label', t('touch_vehicle'));
    setText(this.pauseBtn, t('touch_pause_button'));
    setText(this.muteBtn, t('touch_mute_button'));
    setText(this.actBtn, t('touch_act_button'));
    setAttr(this.pauseBtn, 'aria-label', t('key_pause'));
    setAttr(this.muteBtn, 'aria-label', t('key_mute'));
    setAttr(this.actBtn, 'aria-label', t('key_interact'));
    setAttr(this.stick, 'aria-label', t('touch_joystick_key'));
    setText(this.rotateMessage, t('touch_rotate_hint'));
    setText(this.rotateBtn, t('touch_landscape'));
    setText(this.portraitBtn, t('touch_portrait_continue'));
    // 湖边那一屏不跑这一段：那一侧没有驿站，也就没有"还欠一次到访吗"。
    if (this.lakesideMode) {
      setFlag(this.checkBtn, 'is-live', true);
      return;
    }
    const nb = this.world.nearby;
    const inRange =
      nb.index >= 0 &&
      nb.hasFragment &&
      nb.needsVisit &&
      nb.distance <= STATION_REACH;
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
      this.state.holdPressed = false;
      this.state.checkInPressed = false;
      this.pointerId = -1;
      this.paintKnob();
    }
  }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    this.rotate.remove();
    this.root.remove();
  }
}

/** 方向键 → [x, y]。注意 y 向上为负（见文件头的约定）。 */

/**
 * 请求暂停。合成一次「暂停」键，交给 main 里那一个判据。
 * 理由见文件头——UIHooks 里没有 onPause。
 *
 * ⚠ **键码走 `codeOf('pause')`，不是写死的 `Escape`。**
 * 玩家把暂停改到 `KeyP` 之后，这颗按钮还在派发 `Escape` 的话，
 * 它会变成一颗按了没反应的按钮——而它在暂停面板上，
 * 于是"键盘改键之后暂停面板自己坏了"。
 */
function requestPause(): void {
  const code = codeOf('pause');
  window.dispatchEvent(
    new KeyboardEvent('keydown', { code, key: code, bubbles: true }),
  );
}
