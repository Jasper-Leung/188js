/**
 * 合成面板 —— 五件乐事集齐时的「礼物成形」。
 *
 * ## 集齐是中局，不是终局
 *
 * `state.ts` 的注释里写着这一条：原版收满五块碎片正好把心神从 4 打到 1，
 * 而 1 是遮罩最浓那一档——玩家最需要看清世界（选留门还是放手）时最暗。
 * 于是这一屏给了**两个出口**，而不是直接跳结算：
 *
 * · **收下明信片 · 结束这一趟** → 去结算页
 * · **再骑一圈 · 刷到完满**     → 回世界
 *
 * 第二个出口不是"开发者留的后门"：完满评级要求五座驿站**各去三次**，
 * 收满第一块之后每座还欠两次（`fragmentStationNeedsVisit()` 就是这个判据）。
 * 只给一个出口的话，"这一趟"和"完满"就永远互斥，而
 * `synthesis_choice_hint` 那一行文案把这件事说破了：
 * 「顶栏的圆点还是空的——每座驿站都还能再去两次。」
 *
 * 至于心神：这一屏**不做任何遮罩相关的处理**，它不调 `mood`。
 * 心神的上行口是 `restoreMood()` 与茶铺的清心茶（见 state.ts），
 * 合成屏要是偷偷回一格，那条上行口就没有意义了。
 */
import { t } from '../i18n';
import { button, el, note, setShown, setText } from './dom';
import { wireKeyActivate } from './hud';
import { FRAGMENT_COLORS } from './theme';
import type { UIHooks } from './index';
import type { GameStateManager } from '../game/state';

export interface SynthesisOpts {
  parent: HTMLElement;
  hooks: UIHooks;
  game: GameStateManager;
}

export class SynthesisPanel {
  readonly root: HTMLDivElement;
  private hooks: UIHooks;
  private game: GameStateManager;

  private titleEl: HTMLDivElement;
  private strip: HTMLDivElement;
  private hintEl: HTMLDivElement;
  private takeBtn: HTMLButtonElement;
  private keepBtn: HTMLButtonElement;

  constructor(o: SynthesisOpts) {
    this.hooks = o.hooks;
    this.game = o.game;

    this.root = el('div', 'g-screen g-synth g-hidden');
    const card = el('div', 'g-card g-card-synth');

    this.titleEl = el('div', 'g-synth-title');
    card.appendChild(this.titleEl);

    // 五块碎片。颜色取自 theme.ts（和五个小游戏的景同族），
    // 格子从左到右是云/茶/琴/竹/禽——与 HUD 的碎片栏同序，
    // 玩家从世界里的 HUD 移到这里，认的是位置而不是字。
    this.strip = el('div', 'g-synth-strip');
    for (let s = 0; s < 5; s++) {
      const cell = el('div', 'g-synth-cell');
      const sw = el('span', 'g-synth-sw');
      sw.style.setProperty('--sw', FRAGMENT_COLORS[s]);
      cell.appendChild(sw);
      cell.appendChild(el('span', 'g-synth-w', t(`fragment_${s}`)));
      this.strip.appendChild(cell);
    }
    card.appendChild(this.strip);

    this.hintEl = note(t('synthesis_choice_hint'));
    card.appendChild(this.hintEl);

    const acts = el('div', 'g-acts');
    this.takeBtn = button(t('synthesis_take_postcard'), {
      cls: 'g-btn-major',
      onClick: () => this.hooks.onTakePostcard(),
    });
    this.keepBtn = button(t('synthesis_keep_riding'), {
      cls: 'g-btn-major',
      onClick: () => this.hooks.onKeepRiding(),
    });
    acts.appendChild(this.takeBtn);
    acts.appendChild(this.keepBtn);
    card.appendChild(acts);

    this.root.appendChild(card);
    for (const b of this.root.querySelectorAll<HTMLElement>('.g-btn')) {
      wireKeyActivate(b, () => b.click());
    }
    o.parent.appendChild(this.root);
  }

  show(mode: 'chapter' | 'maxed' | 'plain' = 'plain'): void {
    this.mode = mode;
    setShown(this.root, true);
    this.sync();
    this.takeBtn.focus();
  }

  hide(): void {
    setShown(this.root, false);
  }

  /**
   * 三种打开方式，标题与提示各不相同。
   *
   * · `chapter` —— 第一章在十八驿收尾。**唯一一次**带章节字样的结算，
   *   而 demo 的边界就落在这里，所以它必须自己说明"这一章结束了、
   *   下一章开了"，而不是让玩家自己从"结束这一趟"这几个字里推。
   * · `maxed` —— 五座各去三次，完满评级。可选路线。
   * · `plain` —— 兜底。
   */
  private mode: 'chapter' | 'maxed' | 'plain' = 'plain';

  sync(): void {
    if (this.mode === 'chapter') {
      setText(this.titleEl, t('chapter1_done_title'));
      setText(this.hintEl, t('chapter1_done_line'));
      setText(this.takeBtn, t('synthesis_take_postcard'));
      setText(this.keepBtn, t('synthesis_home_hint'));
      return;
    }
    // 五座都走满（而不是刚集齐）时标题换一句。
    const maxed = this.mode === 'maxed' || this.game.allFragmentsMaxed();
    setText(this.titleEl, maxed ? t('synthesis_done_message') : t('collecting_message'));
    setText(this.hintEl, maxed ? t('revisit_available') : t('synthesis_choice_hint'));
    setText(this.takeBtn, t('synthesis_take_postcard'));
    setText(this.keepBtn, t('synthesis_keep_riding'));
  }

  dispose(): void {
    this.root.remove();
  }
}
