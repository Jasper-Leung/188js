import { touchHand, setTouchHand } from '../core/touchLayout';
import { worldSettings } from './worldSettings';
import { worldClock } from '../core/dayClock';
/**
 * 暂停面板 —— 继续 / 重开 / 收工，外加画质、自适应、静音、语言、操作说明。
 *
 * ## 为什么这些开关全在这一块
 *
 * 原作的暂停菜单只有"继续 / 重开"。本作把画质三档、自适应分辨率、
 * 三组静音、语言全搬进来，判据是**它们是玩家在玩的过程中唯一会去改的
 * 东西**，而改它们的那一秒钟玩家正好是停着的——按 ESC 的那一秒。
 * 放进标题页等于让玩家为了调一档画质退出游戏重来一次。
 *
 * ## 画质切换要立刻反映到画面上
 *
 * 点一档就调 `onQualityChange(tier)`，宿主立刻 `world.applyPreset()` +
 * `loop.setBaseScale()`。这里不写"下次生效"之类的软话——`qualityHint()`
 * 那一行讲的是**植被半径**要重新进这一趟才生效（`veg.invalidate()` 的
 * 行为），阴影和分辨率是当场就变的。两件事都写出来，玩家才知道
 * 「画面已经变了，但草还没回来」不是 bug。
 *
 * ## 静音状态从 audio 读，不自己存一份
 *
 * 面板上的三颗灯读 `audio.bgmMuted / sfxMuted / fullyMuted`，而不是在 UI
 * 里另存三个布尔值。原因是 **M 键**（main 的 keydown 里的 `KeyM`）会直接
 * 改 audio 而不经过任何 hook——UI 存的那份会在按了 M 之后开始说谎，
 * 而一个说谎的静音开关比没有开关更糟。UI 只负责"点一下 → 调 hook"，
 * 状态永远回读。
 */
import { audio } from '../core/audio';
import { TIER_KEYS, qualityHint, tierSummary } from '../core/settings';
import { t } from '../i18n';
import { button, el, note, row, rule, setFlag, setShown, setText } from './dom';
import { icon, type IconName } from './icons';
import { wireKeyActivate } from './hud';
import type { Tier } from '../core/capability';
import { touchMode, setTouchMode, touchModeLabel, type TouchMode } from '../core/touch';
import type { UIHooks } from './index';
import { ACTIONS, codeLabel, codeOf, getKeymap, tryBind, type GameAction } from '../core/keymap';

/** 自适应目标帧率的候选。纯数字，语言中立，不需要文案。 */
const ADAPTIVE_TARGETS = [24, 30, 45, 60] as const;

/** 触屏操作三态。顺序即显示顺序：自动 / 开 / 关。 */
const TOUCH_MODES: { value: TouchMode; key: string }[] = [
  { value: 'auto', key: 'touch_auto' },
  { value: 'on', key: 'touch_on' },
  { value: 'off', key: 'touch_off' },
];

export interface PauseOpts {
  parent: HTMLElement;
  hooks: UIHooks;
  tier: Tier;
  /** 自适应当前是否开着、目标多少。由宿主持有（settings 里落盘的那份）。 */
  adaptiveOn: boolean;
  adaptiveTarget: number;
  /**
   * 打开明信片预览。**不走 hooks**：它只开一屏 UI，不改存档也不改相位
   * （相位在整段时间里都还是 `paused`），而 hooks 是给宿主那些
   * 「游戏状态机要动」的动词留的——见 UIHooks.onWorldEntered 的注释。
   */
  onLookPostcard?: () => void;
}

export class PausePanel {
  readonly root: HTMLDivElement;
  private hooks: UIHooks;
  private tier: Tier;
  private adaptiveOn: boolean;
  private adaptiveTarget: number;

  private touchSeg: HTMLDivElement;
  private touchBtns: HTMLButtonElement[] = [];
  private touchWhy: HTMLElement;
  private handBtn: HTMLButtonElement;
  private worldTime: ReturnType<typeof worldSettings>;
  private captions: { node: HTMLElement; key: string }[] = [];
  private caption<T extends HTMLElement>(node: T, key: string): T {
    this.captions.push({ node, key });
    return node;
  }

  private tierBtns: HTMLButtonElement[] = [];
  private summaryBox: HTMLDivElement;
  private hintEl: HTMLDivElement;
  private adaptBtn: HTMLButtonElement;
  private adaptTargets: HTMLDivElement;
  private bgmBtn: HTMLButtonElement;
  private sfxBtn: HTMLButtonElement;
  private allBtn: HTMLButtonElement;
  private langBtn: HTMLButtonElement;
  private pcBtn: HTMLButtonElement;
  private helpBtn: HTMLButtonElement;
  private helpBox: HTMLDivElement;
  /** 由 buildHelp() 在构造函数里建；`!` 是准确的，TS 只是看不穿跨方法赋值。 */
  private helpBody!: HTMLPreElement;
  private finishBtn: HTMLButtonElement;
  private finishHint: HTMLDivElement;

  constructor(o: PauseOpts) {
    this.hooks = o.hooks;
    this.tier = o.tier;
    this.adaptiveOn = o.adaptiveOn;
    this.adaptiveTarget = o.adaptiveTarget;
    this.touchSeg = el('div', 'g-seg');
    this.touchWhy = note(t('touch_why'), 'g-note-dim');

    this.root = el('div', 'g-screen g-pause g-hidden');
    const card = el('div', 'g-card g-card-pause');
    card.appendChild(this.caption(el('h2', 'g-h2', t('pause_title')), 'pause_title'));

    // ---- 三个大动作 ----
    const acts = el('div', 'g-acts');
    acts.appendChild(this.caption(button(t('continue'), { cls: 'g-btn-major', onClick: () => this.hooks.onResume() }), 'continue'));
    acts.appendChild(this.caption(button(t('restart'), { cls: 'g-btn-major', onClick: () => this.hooks.onRestart() }), 'restart'));
    card.appendChild(acts);

    this.finishBtn = button(t('finish_run'), {
      cls: 'g-btn-major g-btn-wide',
      onClick: () => this.hooks.onFinishRun(),
    });
    card.appendChild(this.finishBtn);
    this.finishHint = note(t('finish_run_hint'), 'g-note-dim');
    card.appendChild(this.finishHint);

    card.appendChild(rule());

    // ---- 画质 ----
    card.appendChild(this.caption(el('div', 'g-group-h', t('quality')), 'quality'));
    const seg = el('div', 'g-seg');
    for (let i = 0; i < TIER_KEYS.length; i++) {
      const b = button(t(TIER_KEYS[i]), {
        cls: 'g-seg-b',
        aria: `${t(TIER_KEYS[i])} · ${t('quality')}`,
        onClick: () => this.pickTier(i as Tier),
      });
      this.tierBtns.push(b);
      seg.appendChild(b);
    }
    card.appendChild(seg);
    this.summaryBox = el('div', 'g-rows');
    card.appendChild(this.summaryBox);
    card.appendChild((this.hintEl = note(qualityHint(this.tier), 'g-note-dim')));

    // ---- 自适应分辨率 ----
    const ad = el('div', 'g-group');
    this.adaptBtn = button(t('adaptive_on'), { cls: 'g-btn-toggle', onClick: () => this.toggleAdaptive() });
    const adHead = el('div', 'g-group-h');
    adHead.appendChild(this.caption(el('span', null, t('hud_scale')), 'hud_scale'));
    adHead.appendChild(this.adaptBtn);
    ad.appendChild(adHead);
    this.adaptTargets = el('div', 'g-seg g-seg-sm');
    for (const fps of ADAPTIVE_TARGETS) {
      this.adaptTargets.appendChild(
        button(String(fps), {
          cls: 'g-seg-b',
          aria: `${fps} FPS`,
          onClick: () => this.pickAdaptiveTarget(fps),
        }),
      );
    }
    ad.appendChild(this.adaptTargets);
    ad.appendChild(this.caption(note(t('adaptive_hint'), 'g-note-dim'), 'adaptive_hint'));
    card.appendChild(ad);

    // ---- 触屏操作 ----
    // 放在自适应分辨率下面，因为两者是同一类东西：都是"这台机器跑得动吗"的答案，
    // 而自适应只能改画面，**改不了"你手上没有按键"**。
    // 自动判定总有判错的时候（见 core/touch.ts 的四条信号），
    // 所以这里给三态：自动 / 开 / 关。三态而不是开关，是因为
    // "自动"要能找回——一个被误判成触屏的桌面用户需要一条退路。
    const tc = el('div', 'g-group');
    const tcHead = el('div', 'g-group-h');
    tcHead.appendChild(this.caption(el('span', null, t('touch_mode')), 'touch_mode'));
    tc.appendChild(tcHead);
    this.touchSeg = el('div', 'g-seg');
    for (const m of TOUCH_MODES) {
      this.touchBtns.push(
        button(t(m.key), {
          cls: 'g-seg-b',
          onClick: () => this.pickTouchMode(m.value),
        }),
      );
    }
    this.touchBtns.forEach((b) => this.touchSeg.appendChild(b));
    tc.appendChild(this.touchSeg);
    this.touchWhy = note(t('touch_why'), 'g-note-dim');
    tc.appendChild(this.touchWhy);
    this.handBtn = button(t(touchHand() === 'right' ? 'touch_hand_right' : 'touch_hand_left'), { onClick: () => {
      setTouchHand(touchHand() === 'right' ? 'left' : 'right');
      setText(this.handBtn, t(touchHand() === 'right' ? 'touch_hand_right' : 'touch_hand_left'));
    } });
    tc.appendChild(this.handBtn);
    card.appendChild(tc);
    this.worldTime = worldSettings(worldClock);
    card.appendChild(this.worldTime);

    card.appendChild(rule());

    // ---- 静音 ----
    const mu = el('div', 'g-group');
    mu.appendChild(this.caption(el('div', 'g-group-h', t('mute')), 'mute'));
    const muSeg = el('div', 'g-seg');
    this.allBtn = button(t('mute'), { cls: 'g-seg-b', onClick: () => this.toggleAll() });
    this.bgmBtn = button(t('bgm_short'), { cls: 'g-seg-b', aria: t('bgm_mute'), onClick: () => this.toggleBgm() });
    this.sfxBtn = button(t('sfx_short'), { cls: 'g-seg-b', aria: t('sfx_mute'), onClick: () => this.toggleSfx() });
    muSeg.appendChild(this.allBtn);
    muSeg.appendChild(this.bgmBtn);
    muSeg.appendChild(this.sfxBtn);
    mu.appendChild(muSeg);
    card.appendChild(mu);

    // ---- 无障碍：音量 / 配色 / 动效 / 按住改切换 / 改键 ----
//
// **放在静音的下面、语言上面。** 顺序是按「多久会用一次」排的：
// 静音与音量是所有玩家都会看的，语言其次，而改键与色觉是
// 「知道自己需要」的人才会找的——把它们摆在下面，
// 不会让每次进来调音量的人都先滚过十行键位。
card.appendChild(this.buildAccessibility());
card.appendChild(rule());

    // ---- 明信片 / 语言 / 操作说明 ----
    // 明信片放最左：暂停的那一秒是玩家唯一会停下来想"我到底在攒什么"的时刻，
    // 而这一屏是三十天里唯一能回答那个问题的地方。
    //
    // 三颗都带**图标**：它们是整个暂停面板里唯一三个「动词」，
    // 而暂停面板的其余部分全是数值与开关——一排图标能把那一组从
    // 一片参数里拎出来，玩家不用逐字读就知道"这三颗是可以点的"。
    const tools = el('div', 'g-tools');
    this.pcBtn = this.toolButton('postcard', t('postcard_look'), () => o.onLookPostcard?.());
    tools.appendChild(this.pcBtn);
    this.langBtn = this.toolButton('globe', t('language'), () => this.hooks.onLangToggle());
    tools.appendChild(this.langBtn);
    // ⚠ **这颗不能走 `caption()`**：caption 那一族靠 `setText(node, t(key))`
    // 重贴，而 `setText` 会把按钮里的**图标一起洗掉**。
    // 所以它改走 `relabelTool()`——只换名字那一格。
    this.helpBtn = this.toolButton('keys', t('controls_title'), () => this.setHelpOpen(true));
    tools.appendChild(this.helpBtn);
    card.appendChild(tools);

    this.root.appendChild(card);
    this.helpBox = this.buildHelp();
    this.root.appendChild(this.helpBox);

    for (const b of this.root.querySelectorAll<HTMLElement>('.g-btn')) {
      wireKeyActivate(b, () => b.click());
    }
    // 改键要**吃掉的键不能同时激活别的按钮**：收键的那一下如果还会
    // click 到「继续」，玩家想改键结果把游戏关了。捕获阶段拦下并 `stopPropagation`。
    this.root.addEventListener('keydown', (e) => {
      if (this.capturing) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
    o.parent.appendChild(this.root);
    this.sync();
  }

  /**
   * 一颗「图标 + 名字」的按钮。暂停面板工具条上的三颗都用它。
   *
   * 图标是 `aria-hidden` 的（见 `icons.ts`），所以**无障碍名由按钮承担**——
   * 这里给 `aria-label` 同一个名字。
   *
   * 为什么图标的**旁边还留着字**：这三颗是面板里仅有的三个动词，
   * 而「操作说明」那一个光看图标猜不出来（问号可以是很多东西）。
   * 图标负责让人一眼认出这是哪一类动作，字负责说清是哪一件。
   */
  private toolButton(ic: IconName, label: string, onClick: () => void): HTMLButtonElement {
    const b = button('', { cls: 'g-btn-quiet g-tool-btn', onClick });
    b.setAttribute('aria-label', label);
    b.title = label;
    b.appendChild(icon(ic));
    b.appendChild(el('span', 'g-tool-t', label));
    return b;
  }

  /**
   * 换一颗工具按钮的名字。**只换名字那一格**，图标原样留着。
   *
   * 为什么不用 `setText(btn, ...)`：那会把整颗按钮的内容换成一行字，
   * 图标就没了——而这一轮的目标正是"文字变图标"。
   */
  private relabelTool(btn: HTMLButtonElement, label: string): void {
    btn.setAttribute('aria-label', label);
    btn.title = label;
    const span = btn.querySelector('.g-tool-t');
    if (span) setText(span, label);
  }

  // ---------------------------------------------------------------- 无障碍

  private volBgm!: HTMLInputElement;
  private volSfx!: HTMLInputElement;
  private volBgmOut!: HTMLSpanElement;
  private volSfxOut!: HTMLSpanElement;
  private cbBtn!: HTMLButtonElement;
  private motionBtn!: HTMLButtonElement;
  private holdBtn!: HTMLButtonElement;
  private keyRowBtns = new Map<GameAction, HTMLButtonElement>();
  /**
   * 无障碍块里**每一行要贴的字**，留住元素好让切语言时重贴。
   *
   * ## 为什么必须留
   *
   * 这一整块原来全部是 `el(..., t('...'))` 写一次就不管了，而 `sync()`
   * 只重贴上半部分。症状是**在暂停面板内部按「语言」**——
   * 那颗按钮就在这个面板里，而面板变成了一半新一半旧：
   * 顶栏那半已经切了、无障碍这整块还是旧语言。
   *
   * 之所以能发生：这一块是在本轮新加的，而**上一轮加过的东西没人顺手
   * 接进 `sync()`**。新增一个要贴字的控件，就必须同时登记到这里。
   */
private a11yTitle!: HTMLElement;
  private a11yWhy!: HTMLElement;
  private keymapTitle!: HTMLElement;
  private volLabels: { el: HTMLElement; key: string }[] = [];
  private swLabels: { el: HTMLElement; key: string }[] = [];
  private keyRowLabels = new Map<GameAction, HTMLElement>();
  private capturing: GameAction | null = null;
  /** 改键冲突那句话。**留在原地**而不是飘走。 */
  private keyConflictEl!: HTMLElement;
  private colorblind = false;
  private reduceMotion = false;
  private holdToToggle = false;

  /**
   * 音量 / 配色 / 动效 / 按住改切换 / 改键。
   *
   * ## 为什么音量是 `input[type=range]` 而不是三档按钮
   *
   * 三档（静音 / 30% / 100%）听上去够用，而实际上最需要调音量的人是
   * 戴耳机的那个——他们要的是**连续**的推子，因为"能听见"和"听不见"
   * 之间那一大段对耳机用户全是"太吵"。三档把那一段整段跳过了。
   *
   * ## 改键为什么是「点一下然后按下一颗」
   *
   * 弹一个捕获输入的模态框是另一条路，而它要新造一个焦点陷阱——
   * 这个面板里已经有别的东西在管焦点了。此处更简单也更可靠：
   * 点那颗按钮之后**面板就地变成捕获态**，下一颗按下的键就是绑定。
   * 再按一次「取消」或按 Esc 退出捕获。
   */
  private buildAccessibility(): HTMLDivElement {
    const box = el('div', 'g-group g-a11y');
    this.a11yTitle = el('div', 'g-group-h', t('accessibility'));
    box.appendChild(this.a11yTitle);

    // ---- 音量 ----
    const volRow = (labelKey: string, which: 'bgm' | 'sfx') => {
      const wrap = el('div', 'g-vol');
      const lab = el('label', 'g-vol-l', t(labelKey));
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = '100';
      input.step = '5';
      input.className = 'g-vol-r';
      // 滑块必须有关联标签，否则读屏只会念出「滑块」。
      input.setAttribute('aria-label', t(labelKey));
      const out = el('span', 'g-vol-v', '100%');
      // `input` = 拖动过程中（每帧）。只推 audio，不落盘。
      input.addEventListener('input', () => {
        const v = Number(input.value) / 100;
        setText(out, `${Math.round(v * 100)}%`);
        this.hooks.onAccessibilityChange({ [which === 'bgm' ? 'volBgm' : 'volSfx']: v });
      });
      // `change` = 松手时一次。**落盘只走这一条**——
      // 而它原来根本不存在，于是音量每次重开都回到 100%。
      input.addEventListener('change', () => {
        this.hooks.onVolumeCommit(
          Number(this.volBgm.value) / 100,
          Number(this.volSfx.value) / 100,
        );
      });
      wrap.appendChild(lab);
      wrap.appendChild(input);
      wrap.appendChild(out);
      this.volLabels.push({ el: lab, key: labelKey });
      return { wrap, input, out };
    };
    const bgm = volRow('vol_bgm', 'bgm');
    const sfx = volRow('vol_sfx', 'sfx');
    this.volBgm = bgm.input;
    this.volBgmOut = bgm.out;
    this.volSfx = sfx.input;
    this.volSfxOut = sfx.out;
    box.appendChild(bgm.wrap);
    box.appendChild(sfx.wrap);

    // ---- 三个开关 ----
    const sw = (labelKey: string, on: boolean, fn: (v: boolean) => void) => {
      const b = button(on ? t('on') : t('off'), {
        cls: 'g-btn-toggle',
        // 读的是 `setFlag` 写的那个类：`dataset.isOn` 从来没人写过，开了就关不掉
        onClick: () => fn(!b.classList.contains('is-on')),
      });
      setFlag(b, 'is-on', on);
      return { b, label: labelKey };
    };
    const cb = sw('colorblind', false, (v) => {
      this.colorblind = v;
      this.syncAccessibility();
      this.hooks.onAccessibilityChange({ colorblind: v });
    });
    const mo = sw('reduce_motion', false, (v) => {
      this.reduceMotion = v;
      this.syncAccessibility();
      this.hooks.onAccessibilityChange({ reduceMotion: v });
    });
    const ho = sw('hold_to_toggle', false, (v) => {
      this.holdToToggle = v;
      this.syncAccessibility();
      this.hooks.onAccessibilityChange({ holdToToggle: v });
    });
    this.cbBtn = cb.b;
    this.motionBtn = mo.b;
    this.holdBtn = ho.b;

for (const [key, b] of [['colorblind', this.cbBtn], ['reduce_motion', this.motionBtn], ['hold_to_toggle', this.holdBtn]] as const) {
      const head = el('div', 'g-group-h g-group-h-sm');
      // **留住这个 span。** 切语言要重贴它，而重贴需要元素引用——
      // 原来写成 `head.firstChild` 去捞，而 `firstChild` 在无头桩里是
      // undefined，于是构造期就往 WeakMap 里塞了一个 undefined 当键。
      const lab = el('span', null, t(key));
      head.appendChild(lab);
      // 切语言时整块重贴——见 `retranslateAccessibility()`。
      this.swLabels.push({ el: lab, key });
      head.appendChild(b);
      box.appendChild(head);
    }
    this.a11yWhy = note(t('accessibility_why'), 'g-note-dim');
    box.appendChild(this.a11yWhy);

    // ---- 改键 ----
    const kr = el('div', 'g-keys');
    for (const a of ACTIONS) {
      const r = el('div', 'g-keyrow');
      const lab = el('span', 'g-keyrow-l', t(`key_${a}`));
      this.keyRowLabels.set(a, lab);
      r.appendChild(lab);
      const b = button(codeLabel(codeOf(a)), {
        cls: 'g-btn-toggle g-keycap',
        onClick: () => this.beginCapture(a),
      });
      this.keyRowBtns.set(a, b);
      r.appendChild(b);
      kr.appendChild(r);
    }
    this.keymapTitle = el('div', 'g-group-h g-group-h-sm', t('keymap_title'));
    box.appendChild(this.keymapTitle);
    box.appendChild(kr);
    // 冲突那句话留在原地而不是飘走——见 `captureKeys` 里那一句。
    this.keyConflictEl = note('', 'g-note-why');
    setShown(this.keyConflictEl, false);
    box.appendChild(this.keyConflictEl);

    // 捕获态的全局监听挂在**窗口**上而不是这一行：
    // 焦点在面板里，但按键目标是 `window`，而这一屏本来就在监听键盘。
    this.captureKeys = (e: KeyboardEvent) => {
      if (!this.capturing) return;
      // Shift / Control / Alt 单独按下不算绑定——那是组合键的修饰键，
      // 而这个游戏没有组合键。
      if (['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(e.code)) return;
      const act = this.capturing;
      e.preventDefault();
      e.stopPropagation();
      this.capturing = null;
      if (e.code === 'Escape') {
        this.syncKeyRow();
        return;
      }
      const clash = tryBind(act, e.code);
      if (clash === 'reserved') {
        // 数字键 / F8~F10 / Enter 这些不做重映射——它们是固定功能键。
        // 而玩家此刻盯着那颗键帽，所以这句话必须**留在原地**说清楚，
        // 而不是弹一个会飘走的 toast。
        setText(this.keyConflictEl, t('key_reserved', { action: t(`key_${act}`) }));
        setShown(this.keyConflictEl, true);
      } else if (clash) {
        // 冲突要说出来。这里**不用 toast**：toast 会飘走，而这一刻玩家
        // 的注意力全在那颗键帽上——那句话得**留在原地**，
        // 旁边就是刚按下的那一颗。
        setText(
          this.keyConflictEl,
          t('key_conflict', { action: t(`key_${act}`), other: t(`key_${clash}`) }),
        );
        setShown(this.keyConflictEl, true);
      } else {
        setShown(this.keyConflictEl, false);
      }
      this.syncKeyRow();
      this.hooks.onKeymapChange(getKeymap() as unknown as Record<string, string>);
    };
    window.addEventListener('keydown', this.captureKeys, true);

    return box;
  }

  private captureKeys!: (e: KeyboardEvent) => void;

  private beginCapture(action: GameAction): void {
    this.capturing = action;
    this.syncKeyRow();
  }

  private syncKeyRow(): void {
    for (const [a, b] of this.keyRowBtns) {
      if (this.capturing === a) {
        setText(b, t('key_press_now'));
        setFlag(b, 'is-capturing', true);
      } else {
        setText(b, codeLabel(codeOf(a)));
        setFlag(b, 'is-capturing', false);
      }
    }
  }

  /** 从宿主灌一次（构造时与 `sync()` 都调）。设置面板是**读这份**的唯一地方。 */
  setAccessibilityState(v: {
    volBgm: number;
    volSfx: number;
    colorblind: boolean;
    reduceMotion: boolean;
    holdToToggle: boolean;
  }): void {
    this.volBgm.value = String(Math.round(v.volBgm * 100));
    this.volSfx.value = String(Math.round(v.volSfx * 100));
    setText(this.volBgmOut, `${Math.round(v.volBgm * 100)}%`);
    setText(this.volSfxOut, `${Math.round(v.volSfx * 100)}%`);
    this.colorblind = v.colorblind;
    this.reduceMotion = v.reduceMotion;
    this.holdToToggle = v.holdToToggle;
    this.syncAccessibility();
  }

  /** 宿主在构造之后才把存档里的开关推进来（`App.ready()`），面板要跟着改显示 */
  setSwitches(v: { colorblind?: boolean; reduceMotion?: boolean; holdToToggle?: boolean }): void {
    if (v.colorblind !== undefined) this.colorblind = v.colorblind;
    if (v.reduceMotion !== undefined) this.reduceMotion = v.reduceMotion;
    if (v.holdToToggle !== undefined) this.holdToToggle = v.holdToToggle;
    this.syncAccessibility();
  }

  private syncAccessibility(): void {
    setFlag(this.cbBtn, 'is-on', this.colorblind);
    setText(this.cbBtn, this.colorblind ? t('on') : t('off'));
    setFlag(this.motionBtn, 'is-on', this.reduceMotion);
    setText(this.motionBtn, this.reduceMotion ? t('on') : t('off'));
    setFlag(this.holdBtn, 'is-on', this.holdToToggle);
    setText(this.holdBtn, this.holdToToggle ? t('on') : t('off'));
    this.syncKeyRow();
  }

  // ---------------------------------------------------------------- 画质

  private pickTier(tier: Tier): void {
    if (this.tier === tier) return;
    this.tier = tier;
    this.sync();
    this.hooks.onQualityChange(tier);
  }

  private paintSummary(): void {
    this.summaryBox.textContent = '';
    const s = tierSummary(this.tier);
    const add = (k: string, v: string) => {
      const r = row(k);
      setText(r.value, v);
      this.summaryBox.appendChild(r.row);
    };
    add(t('hud_scale'), s.renderScale);
    add(t('tier_shadows'), s.shadows);
    add(t('tier_ground'), s.ground);
    setText(this.hintEl, qualityHint(this.tier));
  }

  // ---------------------------------------------------------------- 触屏

  /**
   * 切三态。改完立刻同步——**不经过 hooks**：触屏判定是纯客户端的，
   * 不影响世界、存档或画质，绕一圈 hook 只会多一个"忘了实现"的地方。
   * UI 自己监听 `onTouchModeChange` 把控件挂上/摘下。
   */
  private pickTouchMode(m: TouchMode): void {
    setTouchMode(m);
    this.sync();
  }

  private paintTouch(): void {
    const cur = touchMode();
    this.touchBtns.forEach((b, i) => {
      setText(b, t(TOUCH_MODES[i].key));
      setFlag(b, 'is-on', TOUCH_MODES[i].value === cur);
    });
    // 把判定理由写在下面：触屏控件"不出现"是最难排查的一类问题，
    // 而玩家能自己看见"它因为什么出现/没出现"，就不需要猜了。
    setText(this.touchWhy, `${t('touch_why')} · ${touchModeLabel()}`);
  }

  // ---------------------------------------------------------------- 自适应

  private toggleAdaptive(): void {
    this.adaptiveOn = !this.adaptiveOn;
    this.sync();
    this.hooks.onAdaptiveChange(this.adaptiveOn, this.adaptiveTarget);
  }

  private pickAdaptiveTarget(fps: number): void {
    this.adaptiveTarget = fps;
    this.sync();
    // 选目标值本身就意味着"我要用这个"，所以顺带把它打开——
    // 否则玩家点了 45 结果什么也没发生，只能理解成"这个按钮坏了"。
    if (!this.adaptiveOn) {
      this.adaptiveOn = true;
      this.hooks.onAdaptiveChange(true, fps);
    }
  }

  // ---------------------------------------------------------------- 静音

  /**
   * 三个开关都是「读当前 → 取反 → 报新值」。
   * 报的是**三个一起**，因为 `onMuteChange(bgm, sfx, all)` 是全量签名，
   * 而宿主那边三个都是幂等的 setter。局部上报会让"点 BGM 把全局也关了"
   * 这类交互在宿主那边变成状态竞争。
   */
  private toggleBgm(): void {
    this.hooks.onMuteChange(!audio.bgmMuted, audio.sfxMuted, audio.fullyMuted);
  }

  private toggleSfx(): void {
    this.hooks.onMuteChange(audio.bgmMuted, !audio.sfxMuted, audio.fullyMuted);
  }

  private toggleAll(): void {
    this.hooks.onMuteChange(audio.bgmMuted, audio.sfxMuted, !audio.fullyMuted);
  }

  // ---------------------------------------------------------------- 帮助

  private buildHelp(): HTMLDivElement {
    const box = el('div', 'g-help g-hidden');
    const card = el('div', 'g-card g-card-help');
    card.appendChild(el('div', 'g-group-h', t('controls_title')));
    this.helpBody = el('pre', 'g-help-body', t('help_overlay'));
    card.appendChild(this.helpBody);
    card.appendChild(note(t('help_close'), 'g-note-dim'));
    box.appendChild(card);
    box.addEventListener('click', () => this.setHelpOpen(false));
    return box;
  }

  private setHelpOpen(open: boolean): void {
    setShown(this.helpBox, open);
  }

  // ---------------------------------------------------------------- 生命周期

  show(): void {
    setShown(this.root, true);
    this.sync();
    const first = this.root.querySelector<HTMLElement>('.g-btn-major');
    if (first) first.focus();
  }

  hide(): void {
    setShown(this.root, false);
    setShown(this.helpBox, false);
    // **关掉面板必须卸掉捕获态。** 捕获监听器在 `window` 上、`capture` 阶段
    // 并且 `stopPropagation()`——不清的话，面板关掉之后玩家按的**下一颗键**
    // 会被吞掉并直接写进键位表。症状是"点了继续之后按 W 车不动，
    // 而静音那一栏的字变成了 W"。
    this.capturing = null;
    this.syncKeyRow();
  }

  /** 宿主改了画质 / 自适应之后回写。 */
  setQuality(tier: Tier, adaptiveOn: boolean, adaptiveTarget: number): void {
    this.tier = tier;
    this.adaptiveOn = adaptiveOn;
    this.adaptiveTarget = adaptiveTarget;
    this.sync();
  }

  /**
   * 从 audio 与 game 回读所有开关。
   * 静音那三颗每次都重读（因为 M 键会绕过 UI 改 audio），
   * 画面的档位则跟着 `tier` 成员走。
   */
  sync(): void {
    for (const { node, key } of this.captions) setText(node, t(key));
    for (let i = 0; i < this.tierBtns.length; i++) {
      setText(this.tierBtns[i], t(TIER_KEYS[i]));
      this.tierBtns[i].setAttribute('aria-label', `${t(TIER_KEYS[i])} · ${t('quality')}`);
      setFlag(this.tierBtns[i], 'is-on', (i as Tier) === this.tier);    }
    this.paintSummary();
    this.paintTouch();
    setText(this.handBtn, t(touchHand() === 'right' ? 'touch_hand_right' : 'touch_hand_left'));
    this.worldTime.refresh();

    setText(this.adaptBtn, this.adaptiveOn ? t('adaptive_on') : t('adaptive_off'));
    setFlag(this.adaptBtn, 'is-on', this.adaptiveOn);
    setShown(this.adaptTargets, this.adaptiveOn);
    const btns = this.adaptTargets.querySelectorAll<HTMLElement>('.g-seg-b');
    for (let i = 0; i < btns.length; i++) {
      setFlag(btns[i], 'is-on', Number(btns[i].textContent) === this.adaptiveTarget);
    }

    // 三颗静音灯：读 audio，不读自己
    setFlag(this.allBtn, 'is-on', audio.fullyMuted);
    setText(this.allBtn, t('mute'));
    setFlag(this.bgmBtn, 'is-on', !audio.bgmMuted);
    setText(this.bgmBtn, audio.bgmMuted ? t('off') : t('bgm_short'));
    setFlag(this.sfxBtn, 'is-on', !audio.sfxMuted);
    setText(this.sfxBtn, audio.sfxMuted ? t('off') : t('sfx_short'));

    // 三颗工具按钮：换名字，不动图标（见 `relabelTool`）。
    this.relabelTool(this.pcBtn, t('postcard_look'));
    this.relabelTool(this.langBtn, t('language'));
    this.relabelTool(this.helpBtn, t('controls_title'));
    setText(this.finishBtn, t('finish_run'));    setText(this.finishHint, t('finish_run_hint'));
    setText(this.helpBody, t('help_overlay'));
    this.retranslateAccessibility();
  }

  /**
   * 切语言时把无障碍这一整块重新贴一遍。
   *
   * **原来只翻上面那一半**：这块是新加的，而每个新控件都"写了一次 `t()`
   * 就不管"——于是同一个面板在切语言之后变成一半新一半旧，
   * 而「语言」那颗按钮就在这个面板里。
   *
   * 只有两处需要登记：要贴字的元素（`volLabels` / `swLabels` / `keyRowLabels` /
   * 标题与说明），以及**捕获态的那颗键帽**（它此刻写着"按下新键…"，
   * 而那句话也要跟着切）。
   */
  private retranslateAccessibility(): void {
    // `setText` 内部用 `WeakMap<Node, string>` 做「没变就不写」的缓存，
    // 而 WeakMap 的键**不能是 undefined**。所以这里统一走一个守卫：
    // 万一某个字段还没建好（构造顺序被改过），跳过它而不是把整块炸掉。
    const put = (node: HTMLElement | undefined, key: string) => {
      if (node) setText(node, t(key));
    };
    put(this.a11yTitle, 'accessibility');
    put(this.a11yWhy, 'accessibility_why');
    put(this.keymapTitle, 'keymap_title');
    for (const { el: e, key } of this.volLabels) {
      setText(e, t(key));
      // 滑块的 aria-label 也要跟着切——读屏只念它。
      // 不用 `instanceof HTMLInputElement`：在无头桩里那个类不存在，
      // 用 `tagName` 判稳一些（`el()` 创出来的是 `<label>`，而下一格是 `<input>`）。
      const input = e.nextElementSibling as HTMLElement | null;
      if (input && input.tagName === 'INPUT') input.setAttribute('aria-label', t(key));
    }
    for (const { el: e, key } of this.swLabels) setText(e, t(key));
    for (const [a, lab] of this.keyRowLabels) setText(lab, t(`key_${a}`));
    // 开关上的「开 / 关」是状态而不是语言——由 `syncAccessibility()` 负责。
    this.syncAccessibility();
    this.syncKeyRow();
  }

  dispose(): void {
    // 捕获监听器挂在 `window` 上而不是这个 root，所以 `root.remove()` 不会带走它。
    // 留着的后果是：下一次再有按键时它会读 `this.capturing`——面板已经没了，
    // 但那个引用还在，而它被 `stopPropagation()` 吞掉的那颗键会被白白吞掉。
    window.removeEventListener('keydown', this.captureKeys, true);
    this.capturing = null;
    this.root.remove();
  }
}
