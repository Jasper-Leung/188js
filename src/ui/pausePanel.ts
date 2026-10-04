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
 * `loop.setBaseScale()`。这里不写"下次生效"之类的软话——`quality_hint`
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
import { TIER_KEYS, tierSummary } from '../core/settings';
import { t } from '../i18n';
import { button, el, note, row, rule, setFlag, setShown, setText } from './dom';
import { wireKeyActivate } from './hud';
import type { Tier } from '../core/capability';
import { touchMode, setTouchMode, touchModeLabel, type TouchMode } from '../core/touch';
import type { UIHooks } from './index';

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

  private tierBtns: HTMLButtonElement[] = [];
  private summaryBox: HTMLDivElement;
  private adaptBtn: HTMLButtonElement;
  private adaptTargets: HTMLDivElement;
  private bgmBtn: HTMLButtonElement;
  private sfxBtn: HTMLButtonElement;
  private allBtn: HTMLButtonElement;
  private langBtn: HTMLButtonElement;
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
    card.appendChild(el('h2', 'g-h2', t('pause_title')));

    // ---- 三个大动作 ----
    const acts = el('div', 'g-acts');
    acts.appendChild(button(t('continue'), { cls: 'g-btn-major', onClick: () => this.hooks.onResume() }));
    acts.appendChild(button(t('restart'), { cls: 'g-btn-major', onClick: () => this.hooks.onRestart() }));
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
    card.appendChild(el('div', 'g-group-h', t('quality')));
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
    card.appendChild(note(t('quality_hint'), 'g-note-dim'));

    // ---- 自适应分辨率 ----
    const ad = el('div', 'g-group');
    this.adaptBtn = button(t('adaptive_on'), { cls: 'g-btn-toggle', onClick: () => this.toggleAdaptive() });
    const adHead = el('div', 'g-group-h');
    adHead.appendChild(el('span', null, t('hud_scale')));
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
    ad.appendChild(note(t('adaptive_hint'), 'g-note-dim'));
    card.appendChild(ad);

    // ---- 触屏操作 ----
    // 放在自适应分辨率下面，因为两者是同一类东西：都是"这台机器跑得动吗"的答案，
    // 而自适应只能改画面，**改不了"你手上没有按键"**。
    // 自动判定总有判错的时候（见 core/touch.ts 的四条信号），
    // 所以这里给三态：自动 / 开 / 关。三态而不是开关，是因为
    // "自动"要能找回——一个被误判成触屏的桌面用户需要一条退路。
    const tc = el('div', 'g-group');
    const tcHead = el('div', 'g-group-h');
    tcHead.appendChild(el('span', null, t('touch_mode')));
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
    card.appendChild(tc);

    card.appendChild(rule());

    // ---- 静音 ----
    const mu = el('div', 'g-group');
    mu.appendChild(el('div', 'g-group-h', t('mute')));
    const muSeg = el('div', 'g-seg');
    this.allBtn = button(t('mute'), { cls: 'g-seg-b', onClick: () => this.toggleAll() });
    this.bgmBtn = button(t('bgm_short'), { cls: 'g-seg-b', aria: t('bgm_mute'), onClick: () => this.toggleBgm() });
    this.sfxBtn = button(t('sfx_short'), { cls: 'g-seg-b', aria: t('sfx_mute'), onClick: () => this.toggleSfx() });
    muSeg.appendChild(this.allBtn);
    muSeg.appendChild(this.bgmBtn);
    muSeg.appendChild(this.sfxBtn);
    mu.appendChild(muSeg);
    card.appendChild(mu);

    // ---- 语言 / 操作说明 ----
    const tools = el('div', 'g-tools');
    this.langBtn = button(t('language'), { cls: 'g-btn-quiet', onClick: () => this.hooks.onLangToggle() });
    tools.appendChild(this.langBtn);
    tools.appendChild(
      button(t('controls_title'), { cls: 'g-btn-quiet', onClick: () => this.setHelpOpen(true) }),
    );
    card.appendChild(tools);

    this.root.appendChild(card);
    this.helpBox = this.buildHelp();
    this.root.appendChild(this.helpBox);

    for (const b of this.root.querySelectorAll<HTMLElement>('.g-btn')) {
      wireKeyActivate(b, () => b.click());
    }
    o.parent.appendChild(this.root);
    this.sync();
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
    for (let i = 0; i < this.tierBtns.length; i++) {
      setText(this.tierBtns[i], t(TIER_KEYS[i]));
      setFlag(this.tierBtns[i], 'is-on', (i as Tier) === this.tier);
    }
    this.paintSummary();
    this.paintTouch();

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

    setText(this.langBtn, t('language'));
    setText(this.finishBtn, t('finish_run'));
    setText(this.finishHint, t('finish_run_hint'));
    setText(this.helpBody, t('help_overlay'));
  }

  dispose(): void {
    this.root.remove();
  }
}
