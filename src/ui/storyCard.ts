/**
 * 黑底文字卡 —— 路边读到的那些字。
 *
 * ## 为什么不复用对白框
 *
 * 对白框是**说话**用的：有人物名、有说话人、会锁操作（`narrativeBusy`），
 * 而且默认要玩家按一下才走。对路边碑文和靠近驿站时浮出来的那几句来说，
 * 这三条全是错的：
 *
 *   · 碑文没有人说话——「编号 188。这条路认得每一个走过的人。」是一块石头上的刻字；
 *   · 锁操作意味着玩家在过弯时被锁住不能转向，那是最容易招骂的一种打断；
 *   · **要按一次鼠标才能跳过**是最大的问题：玩家正在骑，
 *     他不知道屏幕中间这行字是不是需要他做什么，于是**停下来看**——
 *     一次本来应该"骑过去顺便读到"的东西，被做成了"必须停下"的东西。
 *
 * 所以这一层是：黑底、白字、自动推进、不吃输入、可叠多条。
 *
 * ## 为什么是黑底
 *
 * 参照 188 号路的碑：石头是深的，刻字是浅的。黑底 + 米白字读作"刻在石头上"，
 * 而一张半透明的白卡读作"游戏弹了个提示"。这是玩家对"这是世界里的东西"
 * 和"这是界面在说事"最快的分辨方式。
 *
 * ## 三条硬约束
 *
 * · **`pointer-events: none`**：不吃点击。它是背景上浮出来的一层字，
 *   压在它下面的路必须照样能点、照样能转。
 * · **不碰 `narrativeBusy`**：只有"郑铎那类打断"才允许锁操作（见 `interrupt`），
 *   路边的东西一律不锁。
 * · **自动推进有下限**：短于 2.4 秒的话玩家来不及读完，
 *   而"来不及读完"读作"字太多了"，于是玩家开始主动跳过。
 */
import { t } from '../i18n';
import { el, setShown, setText } from './dom';

const MAX_CARDS = 3;
const DEFAULT_MS = 3400;
const MIN_MS = 2400;

interface Card {
  root: HTMLDivElement;
  life: number;
}

export class StoryCards {
  readonly root: HTMLDivElement;
  private cards: Card[] = [];
  /** 自动推进的秒数。0 = 不自动推进（只有强制打断才用得到）。 */
  autoSec = DEFAULT_MS / 1000;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'g-cards');
    parent.appendChild(this.root);
  }

  /**
   * 浮出一条。
   * @param text 正文
   * @param opts.title 顶部的小标题（通常是碑名或说话人）
   * @param opts.interrupt **强制打断**：压暗画面并且锁操作。
   *        只有反派那几场用——它们的性质是"有人在你耳边说话"，
   *        玩家需要停一下才接得住。路边的东西一律传 false。
   */
  show(text: string, opts: { title?: string; interrupt?: boolean; ms?: number } = {}): void {
    if (!text) return;
    const card = el('div', 'g-card-line');
    if (opts.interrupt) card.classList.add('is-interrupt');
    if (opts.title) card.appendChild(el('div', 'g-card-t', opts.title));
    card.appendChild(el('div', 'g-card-b', text));
    this.root.appendChild(card);
    this.cards.push({ root: card, life: Math.max(MIN_MS, opts.ms ?? DEFAULT_MS) / 1000 });

    // 超出上限就把最早那条挤掉，而不是往下堆到屏幕外
    while (this.cards.length > MAX_CARDS) {
      const old = this.cards.shift();
      old?.root.remove();
    }
    setShown(this.root, true);
  }

  /** 走 `update(dt)`，不用 `setTimeout`：暂停时游戏循环会停而定时器不会。 */
  update(dt: number): void {
    if (!this.cards.length) return;
    for (let i = this.cards.length - 1; i >= 0; i--) {
      const c = this.cards[i];
      c.life -= dt;
      if (c.life > 0) continue;
      c.root.remove();
      this.cards.splice(i, 1);
    }
    if (!this.cards.length) setShown(this.root, false);
  }

  /** 一次清空。进世界 / 重开时用，免得上一趟的字留到下一趟。 */
  clear(): void {
    for (const c of this.cards) c.root.remove();
    this.cards = [];
    setShown(this.root, false);
  }

  get count(): number {
    return this.cards.length;
  }
}

/**
 * 结算屏 —— 一局小游戏打完之后的那一下。
 *
 * ## 为什么必须有一个屏
 *
 * 之前"打成了"只有一条 toast飘过去。**这是玩家唯一确认自己做到什么的地方**，
 * 而 toast 的问题是：它飘走了就没了，而且它长得很像"又一条提示"，
 * 玩家分不清这一条是"你赢了"还是"你得到了三个旅币"。
 *
 * 一句大字 + 这件乐事的名字，是这件事应有的分量。
 */
export class ResultCard {
  readonly root: HTMLDivElement;
  private life = 0;
  private big: HTMLDivElement;
  private sub: HTMLDivElement;
  private onDone: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'g-result g-hidden');
    const box = el('div', 'g-result-box');
    this.big = el('div', 'g-result-big', '');
    this.sub = el('div', 'g-result-sub', '');
    box.appendChild(this.big);
    box.appendChild(this.sub);
    this.root.appendChild(box);
    parent.appendChild(this.root);
  }

  /**
   * @param win 这一局成没成
   * @param slot 乐事槽位（0..4），用来取 `fragment_<i>` 那两个字
   * @param ms 停留毫秒。**成的时候给得比败的时候长**——
   *        赢是这一刻唯一的高光，输只是路过的过程。
   */
  show(win: boolean, slot: number, ms = win ? 2100 : 1300, onDone?: () => void): void {
    setText(this.big, win ? t('mg_success') : t('mg_failed'));
    setText(this.sub, win ? t(`fragment_${slot}`) : '');
    this.root.classList.toggle('is-win', win);
    setShown(this.root, true);
    this.life = ms / 1000;
    this.onDone = onDone ?? null;
  }

  update(dt: number): void {
    if (this.life <= 0) return;
    this.life -= dt;
    if (this.life > 0) return;
    this.life = 0;
    setShown(this.root, false);
    const f = this.onDone;
    this.onDone = null;
    f?.();
  }

  get showing(): boolean {
    return this.life > 0;
  }
}
