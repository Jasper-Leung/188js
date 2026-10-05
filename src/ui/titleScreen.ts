/**
 * 标题页 —— 标题、开始、演示 90 秒、语言、画质三档、操作说明入口。
 *
 * ## 为什么标题页要放机器判定理由
 *
 * `detectCapability()` 返回一个 `reason`（「核显：Intel HD Graphics 4000」
 * 「设备内存 2GB」）。原作把这句话留在 `showUnsupported()` 里，只在跑不动
 * 的时候才给玩家看；本作把它**也**放在标题页的画质组里，理由是低配策略
 * 在 Web 上第一次变得**可见且可改**了：低档会把渲染分辨率压到 60%、
 * 关掉阴影与地面细节，并把行道树收进 95m、灌木收进 40m。玩家看着一片
 * 明显更糊的画面，而界面上没有一个字告诉他「这是因为你的卡被判定成了
 * 核显」——他只会以为这个游戏本来就长这样。
 *
 * 所以这里三件事一起给：**判定理由**（为什么落在这档）、
 * **档位摘要**（这一档砍掉了什么，来自 `tierSummary()`）、
 * **三档可选**（随时改，改完宿主立刻调 `onQualityChange` 反映到画面上）。
 * 缺一不可：只有理由没有摘要，玩家不知道怎么改；只有摘要没有理由，
 * 玩家不知道自己为什么被当成低配。
 *
 * ## 档位说明为什么单独给一句 `quality_hint`
 *
 * 摘要说的是"这一档开什么"（分辨率 60% / 阴影 off / 地面细节 off），
 * 而 `quality_hint` 补的是摘要里**放不下**的那一刀：植被半径要**重新进
 * 这一趟**才生效（`veg.invalidate()` 的行为）。不写这一句，玩家调完档
 * 看着画面没变，会以为设置没生效。
 *
 * 它曾经是一句谎话：源文案写"把草皮行道树收到 70m"，而草皮那一层
 * （交叉卡片 + alphaTest + 风摆）早已整层删除换成 `groundDetail`，
 * 70m 也和 `PRESETS` 里的 95m / 40m 都不对。现在由
 * `tools/i18n-supplement.json` 覆盖，改的是真值。
 */
import { t } from '../i18n';
import { TIER_KEYS, tierSummary } from '../core/settings';
import type { Tier } from '../core/capability';
import type { Capability } from '../core/capability';
import { button, clear, el, note, row, rule, setFlag, setShown, setText } from './dom';
import { wireKeyActivate } from './hud';
import type { UIHooks } from './index';

export interface TitleOpts {
  parent: HTMLElement;
  hooks: UIHooks;
  capability: Capability;
  /** 当前档位（宿主从 settings 里读的）。 */
  tier: Tier;
  /**
   * 有没有存档。有才给「继续旅程 / 重新开始」两颗按钮。
   *
   * 存档一直都在（`GameStateManager` 的 `hasSave()`），只是入口从来没摆在
   * 标题页上：想重玩一遍，得先进游戏 → Esc → 重新开始。
   * 玩家不会知道可以这么做——而"再骑一遍"恰好是这种游戏最自然的第二个动作。
   */
  hasSave: boolean;
}

export class TitleScreen {
  readonly root: HTMLDivElement;
  private hooks: UIHooks;
  private cap: Capability;

  /** 面板上选中的档位。宿主可能有自己的存档先例，所以 UI 先存一份。 */
  private picked: Tier;

  private tierBtns: HTMLButtonElement[] = [];
  private summaryBox: HTMLDivElement;
  private reasonEl: HTMLDivElement;
  /** 「继续旅程 / 重新开始」那一排。没有存档时是 null。 */
  private saveRow: HTMLDivElement | null = null;
  // 这两个由 buildHelp() 在构造函数里建。写成 `!` 是准确的——
  // 构造函数第一屏就调了它，TS 只是看不穿跨方法的赋值。
  private helpBox!: HTMLDivElement;
  private helpBody!: HTMLPreElement;

  constructor(o: TitleOpts) {
    this.hooks = o.hooks;
    this.cap = o.capability;
    this.picked = o.tier;

    this.root = el('div', 'g-screen g-title g-hidden');
    const card = el('div', 'g-card g-card-title');

    // ---- 抬头 ----
    const head = el('div', 'g-title-head');
    head.appendChild(el('div', 'g-title-mark', '188'));
    head.appendChild(el('h1', 'g-title-h1', t('game_title')));
    head.appendChild(el('div', 'g-title-sub', t('subtitle')));
    head.appendChild(el('div', 'g-title-guide', t('guide')));
    card.appendChild(head);

    // ---- 主按钮 ----
    // 顺序是刻意的：先「开启旅程」，再「演示」。演示是给评审看的，
    // 放在第二颗——它不该和主行动同一个视觉权重。
    const acts = el('div', 'g-acts');
    acts.appendChild(button(t('start'), { cls: 'g-btn-major', onClick: () => this.hooks.onStart() }));
    acts.appendChild(button(t('demo_start'), { cls: 'g-btn-major', onClick: () => this.hooks.onStartDemo() }));
    card.appendChild(acts);
    card.appendChild(note(t('demo_hint'), 'g-note-dim'));

    // ---- 有存档才出现的两颗 ----
    // 放在主按钮**下面**而不是并列：并列会让人以为「开启旅程」和「继续旅程」
    // 是两个并列的入口，而它们其实是"从头"和"接着"的关系。
    // 「重新开始」是破坏性的，所以用 quiet 样式，不给主行动那颗的视觉权重。
    if (o.hasSave) {
      this.saveRow = el('div', 'g-acts g-acts-sub');
      this.saveRow.appendChild(
        button(t('title_continue'), { cls: 'g-btn', onClick: () => this.hooks.onContinue() }),
      );
      this.saveRow.appendChild(
        button(t('title_restart'), { cls: 'g-btn-quiet', onClick: () => this.hooks.onRestart() }),
      );
      card.appendChild(this.saveRow);
    }

    // ---- 工具行 ----
    const tools = el('div', 'g-tools');
    tools.appendChild(button(t('language'), { cls: 'g-btn-quiet', onClick: () => this.hooks.onLangToggle() }));
    tools.appendChild(
      button(t('controls_title'), { cls: 'g-btn-quiet', onClick: () => this.setHelpOpen(true) }),
    );
    card.appendChild(tools);

    card.appendChild(rule());

    // ---- 画质三档 ----
    const qBox = el('div', 'g-group');
    qBox.appendChild(el('div', 'g-group-h', t('quality')));
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
    qBox.appendChild(seg);
    this.summaryBox = el('div', 'g-rows');
    qBox.appendChild(this.summaryBox);
    this.reasonEl = note(this.cap.reason, 'g-note-why');
    qBox.appendChild(this.reasonEl);
    qBox.appendChild(note(t('quality_hint'), 'g-note-dim'));
    card.appendChild(qBox);

    this.root.appendChild(card);
    this.root.appendChild(this.buildHelp());

    // 标题页的每一颗按钮都要能用空格/回车激活。
    // main 在 window 上对 Space/Enter 调了 preventDefault，会顺带吃掉原生
    // 按钮激活（见 hud.ts 里 wireKeyActivate 的注释），所以这里统一补一层：
    // 按键 → 自己 click() 一次 → 走按钮自己的 onClick，语义完全一致。
    for (const b of this.root.querySelectorAll<HTMLElement>('.g-btn')) {
      wireKeyActivate(b, () => b.click());
    }

    o.parent.appendChild(this.root);
    this.sync();
  }

  // ---------------------------------------------------------------- 画质

  private pickTier(tier: Tier): void {
    if (this.picked === tier) return;
    this.picked = tier;
    this.sync();
    this.hooks.onQualityChange(tier);
  }

  /**
   * 档位摘要。
   *
   * `tierSummary()` 给的是**这一档开什么**（渲染分辨率 60%、阴影 off、
   * 草皮 off），而玩家要判断的是「切到低档我会失去什么」——两者是同一件事
   * 的正反面，所以值直接取 `tierSummary()` 的返回值，不自己按 preset 重算
   * 一遍：重算的话 preset 表一改，这里就会和画面上真实生效的那一档对不上，
   * 而对不上的后果是玩家去调一个根本没生效的旋钮。
   */
  private paintSummary(): void {
    clear(this.summaryBox);
    const s = tierSummary(this.picked);
    const add = (k: string, v: string) => {
      const r = row(k);
      setText(r.value, v);
      this.summaryBox.appendChild(r.row);
    };
    add(t('hud_scale'), s.renderScale);
    add(t('tier_shadows'), s.shadows);
    add(t('tier_ground'), s.ground);
  }

  /** 宿主把档位改回来时（读档、它在 onQualityChange 里夹了一次之后）。 */
  setTier(tier: Tier): void {
    this.picked = tier;
    this.sync();
  }

  // ---------------------------------------------------------------- 帮助

  private buildHelp(): HTMLDivElement {
    const box = el('div', 'g-help g-hidden');
    const card = el('div', 'g-card g-card-help');
    card.appendChild(el('div', 'g-group-h', t('controls_title')));
    // help_overlay 是一整段带 \n 的速查表。保留换行，不拆成列表——
    // 拆成列表要多写一份 key，而这一条文案本来就按速查表的形状排过版。
    this.helpBody = el('pre', 'g-help-body', t('help_overlay'));
    card.appendChild(this.helpBody);
    card.appendChild(note(t('help_close'), 'g-note-dim'));
    box.appendChild(card);
    box.addEventListener('click', () => this.setHelpOpen(false));
    this.helpBox = box;
    return box;
  }

  private setHelpOpen(open: boolean): void {
    setShown(this.helpBox, open);
    if (open) {
      // 焦点放进去，键盘玩家才 Tab 得出去——焦点在面板外面时 Tab 会跳到
      // 背后的标题按钮，那和「面板挡住了」读起来是同一件事。
      const close = this.helpBox.querySelector<HTMLElement>('.g-btn');
      if (close) close.focus();
    }
  }

  // ---------------------------------------------------------------- 生命周期

  show(): void {
    setShown(this.root, true);
    this.sync();
    // 焦点落在「开启旅程」上：进来就能直接按空格开跑，而 Tab 的第一站
    // 不应该是背后某个看不见的元素。
    const first = this.root.querySelector<HTMLElement>('.g-btn-major');
    if (first) first.focus();
  }

  hide(): void {
    setShown(this.root, false);
    setShown(this.helpBox, false);
  }

  /** 切语言 / 宿主改档之后。 */
  sync(): void {
    for (let i = 0; i < this.tierBtns.length; i++) {
      setText(this.tierBtns[i], t(TIER_KEYS[i]));
      setFlag(this.tierBtns[i], 'is-on', (i as Tier) === this.picked);
    }
    this.paintSummary();
    setText(this.reasonEl, this.cap.reason);
    setText(this.helpBody, t('help_overlay'));
    if (this.saveRow) {
      const btns = this.saveRow.querySelectorAll<HTMLElement>('.g-btn, .g-btn-quiet');
      // 顺序与构造时一致：继续、重开
      setText(btns[0], t('title_continue'));
      setText(btns[1], t('title_restart'));
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
