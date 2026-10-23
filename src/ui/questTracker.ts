/**
 * 主线追踪器 —— 那一行「◆ 主线 · 收集五枚乐事 　2/5」。
 *
 * ## 它回答哪一个问题
 *
 * 顶栏的「下一处」答的是**下一站去哪**；碎片栏答的是**五件分别到访了几次**。
 * 两者都不答「主线本身」——这一趟的主线是"把五枚乐事收齐"，
 * 而玩家要的那个数（已收几枚）此前只被拆开着摆在五个格子里。
 *
 * 碎片栏是**按碎片分**的，追踪器是**按主线分**的：
 * 前者回答"哪几件还差"，后者回答"这一章还差多少"。两句话问的不是同一件事，
 * 所以它们摆在一起不冲突——它们是同一枚硬币的两面。
 *
 * ## 为什么挂在碎片栏**里面**，而不是旁边再放一块卡
 *
 * 位置是这一层最难的事。两个候选：
 *
 * · **右上角另起一块卡**：那里在触屏布局里已经被小地图占了
 *   （`.g-minimap` 在 `data-touch='on'` 时挪到 `top: … + 5.4rem`），
 *   而桌面布局下那块地方空着——于是同一块卡在两种布局里位置完全不同，
 *   得写两套偏移规则，而偏移规则是"靠人记"的那一类耦合。
 * · **挂在碎片栏里面**：碎片栏的定位基准是顶栏自己（`top: 100%`，
 *   见 `styles.css` 里那段注释与 `verify_hud_objective_visible`），
 *   它跟着顶栏折几行走；而追踪器作为它的一个子节点，天然排在它下面。
 *   **一条位置规则都不用新写**，也不可能与别处撞上。
 *
 * 代价是它与碎片栏共用一张卡——而这正好是对的：主线要收的就是那五枚碎片，
 * 它们本来就是一件事。
 *
 * ## 主线达成之后为什么不收起来
 *
 * 主线达成**不等于**这一趟结束。第一章的收尾动作仍然是回十八驿，
 * 而"可以继续探索"是要明确告诉玩家的一件事——世界还在，
 * 五座驿站还各能去三次，评级墙也还在前面。
 *
 * 所以达成态换的是**那一行字**（`quest_done` + `quest_keep_exploring`），
 * 不是整块消失。整块消失的话，玩家的第一反应是"我做完了？游戏没了？"——
 * 而实际上他只是把第一章的主线做完了，后面还有一整片世界。
 *
 * ## 判据一律走 `game`
 *
 * 进度、完成与否、接没接下，全在 `state.ts` 里算好了（`mainQuestProgress` /
 * `mainQuestDone` / `mainQuestAccepted`）。本文件**不自己数**：
 * 碎片栏数的是到访次数（`getStationCount`），追踪器数的是收到几枚
 * （`getCollectedCount`）——两件事，一个在 state 里一个在 HUD 里，
 * 而它们各自的那个判据都只有一个出处。
 */
import { t } from '../i18n';
import { el, setFlag, setShown, setText } from './dom';
import { icon } from './icons';
import type { GameStateManager } from '../game/state';

export class QuestTracker {
  readonly root: HTMLDivElement;

  private iconEl: HTMLSpanElement;
  private titleEl: HTMLSpanElement;
  private countEl: HTMLSpanElement;
  /** 达成之后多出来的那一行：「继续探索这个世界」。 */
  private hintEl: HTMLDivElement;

  constructor(parent: HTMLElement, private game: GameStateManager) {
    this.root = el('div', 'g-quest');

    this.iconEl = el('span', 'g-quest-ic');
    // 图标随状态换：接任务时是卷轴，达成之后是对勾。
    // 它是 `aria-hidden` 的（见 icons.ts），所以换图标不涉及无障碍名。
    this.iconEl.appendChild(icon('quest'));

    this.titleEl = el('span', 'g-quest-t');
    this.countEl = el('span', 'g-quest-n');

    this.root.appendChild(this.iconEl);
    this.root.appendChild(this.titleEl);
    this.root.appendChild(this.countEl);

    this.hintEl = el('div', 'g-quest-hint g-hidden');
    this.root.appendChild(this.hintEl);

    parent.appendChild(this.root);
    this.sync();
  }

  /**
   * 重新读一遍状态。
   *
   * 调用的地方与 HUD 的其它常驻件一样：`Hud.sync()`（读档、买东西、
   * 打完卡、切语言之后）与每帧路径。**每帧只改内容不重建 DOM**——
   * 图标那一处换图标是唯一一处会动 DOM 结构的操作，
   * 所以它被 `setFlag` 之外的一次显式比较挡着，只在状态翻转的那一帧发生。
   */
  sync(): void {
    const accepted = this.game.mainQuestAccepted;
    // 没接下主线时不显示这一行：老存档（没有 `quest_main` 字段）读回来是
    // "没接"，而给一个没接的任务显示进度条是**说了一件不存在的事**。
    setShown(this.root, accepted);
    if (!accepted) return;

    const done = this.game.mainQuestDone;
    setFlag(this.root, 'is-done', done);
    setText(this.titleEl, done ? t('quest_done') : t('quest_main_title'));
    // 计数用 `fragments` 那一条（"%d/5"），它与碎片栏组头用的是同一个 key，
    // 于是两处显示的永远是同一种写法——而「主线 2/5」与「碎片 2/5」
    // 必须是同一个数。
    setText(this.countEl, t('fragments', { 0: this.game.mainQuestProgress }));

    // 达成态：换图标 + 补一行「继续探索这个世界」。
    if (done !== this.wasDone) {
      this.wasDone = done;
      this.iconEl.replaceChildren(icon(done ? 'check' : 'quest'));
    }

    setShown(this.hintEl, done);
    if (done) setText(this.hintEl, t('quest_keep_exploring'));
  }

  /** 上一次同步时主线是不是已经达成。用来避免每帧换图标。 */
  private wasDone = false;
}
