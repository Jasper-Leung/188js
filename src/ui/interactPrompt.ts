/**
 * 交互提示 —— 屏幕下方那颗「◆ F　摸一下」。
 *
 * ## 它要解决的是哪一个洞
 *
 * 这个游戏里有一族**世界里的东西**：旧物、琴音林那张琴、路肩上的木牌。
 * 它们不是界面上的按钮，是"伸手碰一下"——所以它们共用一把 F 键
 * （见 `main.ts` 的 `touchRoadside()`）。
 *
 * 问题是：**F 在这一族上从来没有出现在屏幕上**。
 * 打卡那一族有脚下提示圈（世界坐标投影出来的圆），
 * 碎片驿站有顶栏的「下一处」，而旧物这一族只有"停下来按 F"这句话写在别处。
 * 玩家的体感是"我明明看见那件东西了，可屏幕上没有任何东西说'按 F'"。
 *
 * 这颗提示补的就是这个洞：**够得着才出现**，够不着就完全不占地方。
 *
 * ## 「达到条件才在特定地方出现」
 *
 * 这一族（世界里的东西）的做法是：**走近了才浮出来，走远了就收**，
 * 而且它浮在**固定的屏幕位置**（下方中线），不是浮在屏幕角落。
 *
 * 这里取「条件驱动」这一半；后半条取一个更省事的做法：
 * 旧物那一族**在世界里的位置**与玩家的视角关系很杂（路边、桥下、林子里），
 * 而投影一个世界坐标到屏幕要处理"在相机背后"那一支
 * （HUD 的脚下提示圈已经处理过一次，见 `hud.ts` 的 `syncRing()`）。
 * 两处各做一次投影，就有两处会算错位置。
 *
 * 固定位置还有一条实际的好处：**它不会在画面上乱跑**。
 * 玩家知道"提示在下面那块"，于是低头找，而不是满屏找。
 *
 * ## 与脚下那一圈的关系：**字只留一份**
 *
 * 驿站那一族（铺子 / 回家 / 打卡）**已经有脚下提示圈了**，
 * 而那一圈上写着「空格 · 进入小铺」——和这颗提示说的是同一件事。
 *
 * 两处同时指着同一个动作，而其中一个还多带一个键帽——
 * 那不叫"多一条信息"，那叫"界面吵"。
 *
 * 所以规则是：**圈负责指位置（空间），提示负责说动作（文字 + 键帽）**。
 * 指向同一个动作时，圈上那行**可见文字**让位给提示（无障碍名仍留在圈上，
 * 读屏器照常念得到）；提示说的是别的东西时，圈上的字照旧。
 * 判据是同一族动作的 **kind**，所以两边永远指向同一件事。
 *
 * ## 判据来自哪一边
 *
 * **不复刻任何判定。** 旧物那一族的判据是 `world.relicNearby` /
 * `world.qinInReach` / `world.signInReach`——那是 `main.ts` 的 `touchRoadside()`
 * 用的同一组字段，也是 `world.updateSignAndQin()` 每帧算出来的那一组。
 * 本组件只负责把"有 / 没有"变成"显示 / 不显示"。
 *
 * 打卡那一族（铺子 / 回家 / 打卡）的判据同样复用 `interactAt()`——
 * 和脚下提示圈、宿主那一次「空格」走的是**同一个函数**。
 *
 * ## 与叙事卡的关系：**前景在前，背景让路**
 *
 * 叙事卡那一屏有自己的按钮（「继续 / 提前关闭」「跳到最后一句」），
 * 而这颗提示的药丸摆在屏幕下方中线——手机横屏时两者**重叠**，
 * 并且提示的层级更高，于是那一块既被字压住，点下去还会打到提示上
 * （它会触发一次确认动作）：玩家想推进叙事，结果触发了打卡。
 *
 * 所以叙事段落在场时，这颗提示**整个收掉**，而不是"往后挪一挪"——
 * 挪只会换一种方式继续撞。
 *
 * 这条闸门做在**组件自己身上**（`blocked`），而不是宿主每帧判断：
 * 宿主那一层要同时拿到「有没有叙事段落」与「有没有可交互的东西」
 * 两件事，漏判一次就是屏上两颗药丸叠在一起；而组件自己握着闸门，
 * **谁来 set 都绕不过去**。
 *
 * ## 键帽那一格
 *
 * 显示的是**玩家此刻真正按下去的那把键**，不是写死的 "F"。
 * 键位可以改（`keymap.ts`），而旧物那一族的键是 `interact` 动作，
 * 所以这里走 `codeOf('interact')` —— 玩家把它改到 `KeyG`，
 * 键帽就变成 G。写死 "F" 的话，改键之后屏幕上会指着另一把键。
 */
import { t } from '../i18n';
import { codeLabel } from '../core/keymap';
import { button, el, setAttr, setShown, setText } from './dom';
import { icon, type IconName } from './icons';
import { wireKeyActivate } from './hud';

/**
 * 提示指向的是哪一族动作。
 *
 * ★ 它不只是给图标的：`kind` 还用来判「提示与脚下那一圈是不是在说同一件事」，
 *   那是「字只留一份」那条规则的判据（见 `hud.ts` 的 `ringLabelText()`）。
 */
export type PromptKind = 'relic' | 'qin' | 'sign' | 'shop' | 'home' | 'checkin';

export interface PromptState {
  /** 图标。语义由它承担（手 = 伸手摸一下，等等）。 */
  icon: IconName;
  /** 动作名（走 `t()`）。它同时是按钮的无障碍名。 */
  label: string;
  /** 物理键码（`KeyboardEvent.code`）。键帽显示它。 */
  key: string;
  /** **哪一族动作**。用于「圈与提示指向同一个动作时字只留一份」。 */
  kind: PromptKind;
  /** 按下去之后要发生什么。**由宿主给**——UI 不自己改变游戏状态。 */
  onPick: () => void;
}

/**
 * 提示组件的外部依赖。
 *
 * 只有一项，但它是**闸门**：有它在，叙事段落在场时提示就让路。
 */
export interface PromptOptions {
  /**
   * 现在是不是被别的界面挡住了。
   *
   * 返回 true = **让路**：这颗提示整个收掉，不亮、不占地方、不接点击。
   *
   * UI 层传的是 `() => this.storyBusy`——屏上有叙事卡（或叙事队列还没空）
   * 就让路。规则见文件头「前景在前，背景让路」。
   */
  blocked?: () => boolean;
}

export class InteractPrompt {
  readonly root: HTMLDivElement;

  private btn: HTMLButtonElement;
  private icEl: HTMLSpanElement;
  private keyEl: HTMLSpanElement;
  private labelEl: HTMLDivElement;
  /** 闸门。**有它才让路**，没有就是"没人挡"（默认不挡）。 */
  private blocked: (() => boolean) | undefined;

  /** 当前这一下是什么。null = 没有可交互的东西。 */
  private cur: PromptState | null = null;
  /** 按钮的点击回调要跟着状态走，所以它读 `this.cur` 而不是闭包捕获。 */
  private curIcon: IconName = 'hand';

  constructor(parent: HTMLElement, opts: PromptOptions = {}) {
    this.blocked = opts.blocked;
    this.root = el('div', 'g-prompt g-hidden');
    this.btn = button('', { cls: 'g-prompt-btn' });
    this.icEl = el('span', 'g-prompt-ic');
    this.icEl.appendChild(icon('hand'));
    this.keyEl = el('span', 'g-prompt-key');
    this.btn.appendChild(this.icEl);
    this.btn.appendChild(this.keyEl);
    this.labelEl = el('div', 'g-prompt-t');
    this.root.appendChild(this.btn);
    this.root.appendChild(this.labelEl);
    // 点击走宿主给的意图。UI **不自己**触发交互：
    // 交互的判据（节拍窗口 / 旧物 / 湖边）在宿主那一侧，
    // 而这里只有"玩家点了这一颗"这一个事实。
    this.btn.addEventListener('click', () => this.cur?.onPick());
    // 键盘也要能用：焦点在这颗按钮上时，Enter / 空格走的是它自己的动作。
    // `wireKeyActivate` 会 `preventDefault()` 掉浏览器的原生激活，
    // 所以**不会**双发（原生 click 与这里的回调）。
    wireKeyActivate(this.btn, () => this.cur?.onPick());
    parent.appendChild(this.root);
  }

  /**
   * 设成"现在有 / 没有可交互的东西"。
   *
   * 传 `null` 就收起来。**不要传一个空的壳**——
   * 那一族东西最忌讳的就是"有一个按钮一直亮着但按了没反应"，
   * 而"亮着"本身就是玩家的期望。
   *
   * ★ **闸门在这里生效**：叙事段落在场时（`blocked()` 为真），
   *   这一片直接当成"什么都没有"——不亮、不占地方、不接点击。
   *   闸门做在组件自己身上，所以**谁来 set 都绕不过它**。
   */
  set(s: PromptState | null): void {
    // ⚠ 先过闸门再比：被挡住时这一下等于"没有"，
    //   而 `this.cur` 记的也必须是"没有"——
    //   否则提示看着收起来了，`shown` / `kind` 却还在说它亮着，
    //   脚下那一圈就会以为「已经有人在说这件事」而继续让位。
    const eff = s && this.blocked?.() ? null : s;
    if (eff === this.cur) return;
    this.cur = eff;
    setShown(this.root, !!eff);
    if (!eff) return;
    setText(this.labelEl, eff.label);
    // 键帽：显示玩家此刻真正要按的那把键。`codeLabel` 把
    // `KeyF` 变成 `F`、`Space` 变成 `Space`。
    setText(this.keyEl, codeLabel(eff.key));
    // 无障碍名是**动作名**，不是键帽：读屏器念「摸一下，按钮」，
    // 而念「F，按钮」对读屏用户没有任何意义（他们按的是键，不是看）。
    setAttr(this.btn, 'aria-label', eff.label);
    if (eff.icon !== this.curIcon) {
      this.curIcon = eff.icon;
      this.icEl.replaceChildren(icon(eff.icon));
    }
  }

  /** 现在有没有提示。给宿主与回归读。 */
  get shown(): boolean {
    return this.cur !== null;
  }

  /** 当前的动作名。给回归与 AI 观测读。 */
  get label(): string {
    return this.cur?.label ?? '';
  }

  /**
   * 当前指向哪一族动作。null = 没有提示。
   *
   * 给 UI 层读：它要拿这个去问脚下那一圈「你们说的是不是同一件事」，
   * 而那一圈在 `hud.ts` 里——两层之间只靠这一个值说话。
   */
  get kind(): PromptKind | null {
    return this.cur?.kind ?? null;
  }
}

/**
 * 交互提示的动作名。**走 `t()`**——界面上的字不许写死。
 *
 * 两族：
 * · 旧物 / 琴 / 木牌 —— 按 **F**（`interact` 动作）。
 * · 铺子 / 回家 / 打卡 —— 按 **空格**（`confirm` 动作）。
 *
 * 它们分成两族是因为它们是**两把键**：提示上写"按 F"却要玩家按空格，
 * 那比没有提示更糟。
 */
export function promptLabelOf(kind: 'relic' | 'qin' | 'sign' | 'shop' | 'home' | 'checkin'): string {
  if (kind === 'relic') return t('interact_relic');
  if (kind === 'qin') return t('interact_qin');
  if (kind === 'sign') return t('interact_sign');
  if (kind === 'shop') return t('interact_shop');
  if (kind === 'home') return t('interact_home');
  return t('interact_checkin');
}
