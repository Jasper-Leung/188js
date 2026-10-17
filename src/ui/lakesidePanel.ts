/**
 * 湖边那一屏的读数 —— 张力条、咬钩提示、收场一句话、退出口。
 *
 * ## 它为什么是独立的一个面板，而不是复用 HUD
 *
 * 主世界的 HUD 归 `isInWorld()` 管，而 `lakeside` **不在那个集合里**
 * （见 `game/phase.ts`）。所以这一屏出来的时候整套骑行 HUD 是收掉的——
 * 顶栏、碎片栏、小地图都不在。
 *
 * 而这一屏仍然需要三样读数：张力条要能连续变化、咬钩提示要抢眼、
 * 收场那句要停得住。三样都和 HUD 现有的组件形状不同，
 * 所以另做一屏比把 HUD 改成一个两态的东西更省事，也更不容易碰坏主流程。
 *
 * ## 全部走 `t()`
 *
 * §1 写着「界面里不许写死中文」，而判据扫的正是 `src/ui/**`——
 * **鱼种名也必须进文案表**，不能图省事在 `byLang()` 里硬写。
 * 键补在 `tools/i18n-supplement.json` **和** `src/data/generated/i18n.json` 两侧。
 */
import { el, button, setShown, setText } from './dom';
import { t, isEnglish } from '../i18n';
import { codeOf } from '../core/keymap';
import type { LakesideFrame } from '../world/lakeside';

function kindName(kind: string): string {
  switch (kind) {
    case 'lake_carp': return t('lake_kind_carp');
    case 'lake_bream': return t('lake_kind_bream');
    case 'lake_catfish': return t('lake_kind_catfish');
    case 'lake_crucian': return t('lake_kind_crucian');
    default: return t('lake_kind_default');
  }
}

export class LakesidePanel {
  readonly root: HTMLDivElement;
  private hint: HTMLDivElement;
  private bar: HTMLDivElement;
  private barFill: HTMLDivElement;
  private barText: HTMLDivElement;
  private exitLine: HTMLButtonElement;
  /** VR 入口。**只有这台机器真的支持 `immersive-vr` 时才出现**。 */
  private vrBtn: HTMLButtonElement;
  /** 上一次同步的「提示 + 鱼种 + 语言」，用来判断这一屏该不该重写 DOM。 */
  private lastKey = '';
  private capability: HTMLDivElement;
  private vrAvailable = false;
  /**
   * 出口那颗按钮上一次写的文案。
   *
   * 单独记一份而不在 `lastKey` 里：`lastKey` 只在提示语变化时重写，
   * 而切语言 / 切触屏模式都要改出口那颗——它们和鱼种没关系。
   */
  private lastExitKey = '';

  constructor(parent: HTMLElement, onVr: () => void) {
    this.root = el('div', 'g-lakeside');
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');

    this.hint = el('div', 'g-lakeside-hint');
    this.bar = el('div', 'g-lakeside-bar');
    this.barFill = el('div', 'g-lakeside-bar-fill');
    this.barText = el('div', 'g-lakeside-bar-text');
    // **出口是一颗真的按钮**，而不是一行"按 Esc 回路上"的说明。
    //
    // 原因很具体：触屏玩家看不见键盘，而这一屏**唯一**的出口是 Esc。
    // `readLakesideInput()` 只从 `this.keys` 读，触屏控件又因为
    // `applyTouchVisibility()` 随世界可见性一起被藏掉了——
    // 于是触屏玩家进得来（如果他进得来），**出不去**。
    //
    // 点它 = 合成一次 `Escape`，和 `touchControls.ts` 的 `requestPause()`
    // 走同一条路。不新开一条退出通道，是因为 `main.ts` 里判 `Escape`
    // 的地方已经有一份相位表（湖边 / 暂停 / 面板各不相同），
    // 复制一份早晚会和它漂。
    this.exitLine = button(t('lake_exit'), {
      cls: 'g-lakeside-exit',
      onClick: () => requestExit(),
    });
    // `requestSession()` 要用户激活，所以这一路只能从一次点击进来——
    // 按钮而不是键盘，就是这个原因（见 `core/xr.ts` 的 `enter()`）
    this.vrBtn = button(t('lake_vr_enter'), { cls: 'g-lakeside-vr', onClick: () => onVr() });
    setShown(this.vrBtn, false);

    this.bar.appendChild(this.barFill);
    this.root.appendChild(this.hint);
    this.root.appendChild(this.bar);
    this.root.appendChild(this.barText);
    this.root.appendChild(this.exitLine);
    this.root.appendChild(this.vrBtn);
    this.capability = el('div', 'g-lakeside-capability', t('lake_panorama_fallback'));
    this.root.appendChild(this.capability);
    parent.appendChild(this.root);
    this.root.style.display = 'none';
  }

  hide(): void {
    this.root.style.display = 'none';
    this.lastKey = '';
    this.lastExitKey = '';
  }

  /**
   * 触屏模式：出口那一行的文案换掉。
   *
   * 「Esc 回路上」在触屏上是**一句谎话**——那台设备上没有 Esc 可按。
   * 而控件藏起来之后那一行就是玩家唯一能看到的方向，所以它必须说实话。
   *
   * 与 `applyTouchVisibility()` 同一个判据（`SettingsData.touchMode`
   * 三态 → `Auto` 时看是否粗指针设备），两条读的是同一个值。
   */
  setTouchMode(on: boolean): void {
    this.touchMode = on;
    const key = `${isEnglish() ? 'en' : 'zh'}|${on ? 'touch' : 'keys'}`;
    if (key === this.lastExitKey) return;
    this.lastExitKey = key;
    setText(this.exitLine, t(on ? 'lake_exit_touch' : 'lake_exit'));
  }

  /**
   * VR 入口出不出来。
   *
   * **默认是藏着**，只有宿主确认过 `isSessionSupported('immersive-vr')` 才调
   * 这里的 `true`。反过来（桌面 Chrome 一律有 `navigator.xr` 但不支持 VR）
   * 如果照旧把按钮摆出来，玩家点下去只会得到一句浏览器报错——
   * 而按钮看起来完全正常，没有任何东西能解释为什么它不工作。
   */
  setVrAvailable(on: boolean): void {
    this.vrAvailable = on;
    setText(this.capability, t(on ? 'lake_vr_supported' : 'lake_panorama_fallback'));
    setShown(this.vrBtn, on);
  }

  /**
   * 每帧同步一次。
   *
   * **提示语只在变了才写 DOM。** 张力条每帧都在变，但提示语一个钓局只换两三次；
   * 无条件重写 `textContent` 会把重排打在每一帧上，
   * 而这一屏要伺候的恰恰是扛不住这个的低配机器。
   */
  sync(f: LakesideFrame): void {
    this.root.style.display = 'flex';
    const key = `${isEnglish() ? 'en' : 'zh'}|${this.touchMode}|${f.hint}|${f.fish.phase}|${f.fish.catchKind}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.hint.textContent = this.hintText(f);
      // 状态写进 data 属性而不是 class：配色走 CSS 变量，
      // 换语言 / 换主题时不用重刷一遍类名。
      this.hint.dataset.state = f.hint;
    }

    // 张力条只在收线时出现。没有鱼在拉的时候给一条空的条，
    // 玩家的读法是"这里有个东西"，而一条常驻的空条只会变成墙纸。
    const showBar = f.fish.phase === 'reeling';
    this.bar.style.display = showBar ? 'block' : 'none';
    this.barText.style.display = showBar ? 'block' : 'none';
    if (showBar) {
      this.barFill.style.width = `${Math.round(f.fish.tension * 100)}%`;
      this.barFill.dataset.band = f.tension;
      this.barText.textContent = t('lake_tension');
    }
  }

  private hintText(f: LakesideFrame): string {
    if (f.fish.phase === 'casting' || f.fish.phase === 'waiting') return t('lake_waiting');
    if (f.fish.phase === 'bite') return t(this.touchMode ? 'lake_strike_touch' : 'lake_strike');
    switch (f.hint) {
      case 'strike': return t(this.touchMode ? 'lake_strike_touch' : 'lake_strike');
      case 'tension': return t(this.touchMode ? 'lake_hold_touch' : 'lake_hold');
      case 'caught': return t('lake_caught', { kind: kindName(f.fish.catchKind) });
      case 'snapped': return t('lake_snapped');
      case 'escaped': return t('lake_escaped');
      case 'missed': return t('lake_missed');
      default: return t(this.touchMode ? 'lake_cast_touch' : 'lake_cast_hint');
    }
  }

  /**
   * 换语言。
   *
   * `onLangChange` 触发时 `lastKey` 里已经掺了语言标记（见 `sync`），
   * 所以下一次 `sync` 会自动重写；这里再掺一次是为了覆盖
   * "语言切了但这一屏还停在 result 相位、下一帧不再 sync" 的情况。
   */
  setLang(): void {
    this.lastKey = '';
    this.lastExitKey = '';
    setText(this.exitLine, t(this.touchMode ? 'lake_exit_touch' : 'lake_exit'));
    setText(this.vrBtn, t('lake_vr_enter'));
    setText(this.capability, t(this.vrAvailable ? 'lake_vr_supported' : 'lake_panorama_fallback'));
  }

  /** 记着当前的触屏态，好让 `setLang()` 不用再问一遍宿主。 */
  private touchMode = false;
}

/**
 * 合成一次「暂停」键，交给 `main.ts` 里那一个判据。
 *
 * 与 `touchControls.ts` 的 `requestPause()` **同一个做法、同一段代码形状**：
 * 这一屏不新开退出通道，因为那里已经有一张按相位分流的 `Escape` 表
 * （湖边 / 暂停 / 各面板各不相同），复制一份早晚会和它漂。
 *
 * 键码同样走 `codeOf('pause')`——写死 `Escape` 的话，
 * 改键之后这颗按钮会变成按了没反应的那个。
 */
function requestExit(): void {
  const code = codeOf('pause');
  window.dispatchEvent(
    new KeyboardEvent('keydown', { code, key: code, bubbles: true }),
  );
}
