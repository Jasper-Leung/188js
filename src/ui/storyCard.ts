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
import { t, isEnglish } from '../i18n';
import { el, setShown, setText } from './dom';
import { settleMs, settleTextKey, type SettleOutcome } from '../game/phase';

/** 结算三态从 `game/phase` 来——判定不许在这层再抄一份。 */
export type { SettleOutcome };

const MAX_CARDS = 3;
const DEFAULT_MS = 3400;
const MIN_MS = 2400;
/** 显式给了 ms 的长文上限。超过这个值就不再等它读完——见 readingMs 注释。 */
const MAX_MS = 22000;

interface Card {
  root: HTMLDivElement;
  life: number;
}

/**
 * 叙事静音（`?nocine`）。给 AI 截图与自动试玩用。
 *
 * ## 为什么放在这里，而不是在 main.ts 里逐处判断
 *
 * 叙事的入口有五处：序章、驿里的声音、碎片提示、路边碑文、路口那句。
 * 逐处加 `if (!quiet)` 的读法是"新加一段剧情时记得判一次"——
 * 而这份清单上次更新时就已经漏过好几段了。
 *
 * 收在这里，所有卡**共用** `show()` 这一个入口，漏不掉。
 * `showSequence()` 也走 `show()`，所以队列里剩下的那些同样不会被读出来。
 */
let quiet = false;
export function setNarrativeQuiet(on: boolean): void {
  quiet = on;
}
export function narrativeQuiet(): boolean {
  return quiet;
}

/**
 * 按文本长度算这张卡该停留多久。
 *
 * ## 为什么不能写死一个常数
 *
 * 序章从三句变成六句之后，实测两侧长度差 **3.57 倍**
 * （中文 328 字 / 英文 232 词）。写死 9 秒的话，中文勉强够扫读，
 * 英文只够读完前两句半——玩家看到的是"序章被腰斩"，
 * 而界面上没有任何线索说明后面还有内容。
 *
 * 写死一个"英文专用的大常数"也不行：文案是持续生长的，
 * 下次再加一句，总有一边会被腰斩。**时长必须跟着文本走。**
 *
 * ## 两种语言必须分别计量
 *
 * · 中文按**字符**：`5 字/秒`（默读，留理解余量）
 * · 英文按**词**：`2.7 词/秒`（默读速度比中文慢，这是自然规律，
 *   不是我给英语开的特例——同一个信息量的英文就是真的要读更久）
 *
 * 用字符数去算英文会高估约 1.6 倍（一个词平均 5 个字符，
 * 但眼睛是按词跳的），用词数去算中文则无从谈起。
 *
 * ## 为什么封顶 22 秒
 *
 * 时长无上限的读法是"卡片永远在屏幕上"，于是那块 `rgba(18,16,14,0.88)`
 * 的深色底会长时间压住 22% 高度处的路面，而它**不吃点击**——
 * 玩家看不全路又点不动，只会以为游戏卡了。
 * 截断掉的部分仍然读得到（暂停面板里能看到本趟已播的卡），
 * 比让路面消失二十分钟要划算。
 */
export function readingMs(text: string, isEn: boolean): number {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean === '') return MIN_MS;
  const units = isEn ? clean.split(' ').length : clean.length;
  const perSec = isEn ? 2.7 : 5;
  // +1.2s 是首屏认知成本：字要落在视网膜上再开始读，
  // 那一瞬不算在默读速度里。
  const ms = (units / perSec) * 1000 + 1200;
  return Math.round(Math.min(Math.max(ms, MIN_MS), MAX_MS));
}

export class StoryCards {
  readonly root: HTMLDivElement;
  private cards: Card[] = [];
  /**
   * 待播的队列。**一次只演一张**，演完自动接下一张。
   *
   * 队列存在的原因不是"想一次说很多"，而是**一张卡装不下**：
   * 序章六句在中文侧要 66 秒、在英文侧要 86 秒才能读完，
   * 而单卡上限 22 秒（`MAX_MS`）。硬塞进一张就是必然腰斩。
   * 拆成六张按序播，每张都读到完整。
   *
   * 顺带的观感好处：一次只亮一张，那块 `rgba(18,16,14,0.88)`
   * 的深色底不会把六段话叠成一片黑压条。
   */
  private queue: {
    text: string;
    opts: { title?: string; interrupt?: boolean; ms?: number; dismissible?: boolean };
  }[] = [];
  /** 自动推进的秒数。0 = 不自动推进（只有强制打断才用得到）。 */
  autoSec = DEFAULT_MS / 1000;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'g-cards');
    parent.appendChild(this.root);
  }

  /**
   * 顺序播一组卡：一张演完再上下一张。
   *
   * 路边那些"顺路读到"的东西仍然直接 `show()`——它们本来就不该排队，
   * 玩家正骑着车读到的东西不能因为前面还有三句话就压在后面。
   * 所以这个方法**只给叙事段落用**（序章、驿里的声音）。
   */
  showSequence(
    parts: string[],
    opts: { title?: string; interrupt?: boolean; ms?: number; dismissible?: boolean } = {},
  ): void {
    // 静音时**整组不入队**。只让 `show()` 挡是不够的：
    // 文字会先全压进 `queue`，而 `pump()` 每取一条都被 `show()` 挡回去，
    // 于是 `queue` 永远非空 —— `afterCardGone()` 认定「还有东西」，
    // 容器就再也不会 `setShown(false)`。症状是取消静音后
    // 突然冒出一整趟攒下来的旧卡。**队列要么全进要么全不进。**
    if (quiet) return;
    for (const p of parts) {
      if (p) this.queue.push({ text: p, opts });
    }
    if (!this.cards.length) this.pump();
  }

  /** 队列里还有就上下一张。 */
  private pump() {
    const next = this.queue.shift();
    if (!next) return;
    this.show(next.text, next.opts);
  }

  /**
   * 浮出一条。
   * @param text 正文
   * @param opts.title 顶部的小标题（通常是碑名或说话人）
   * @param opts.interrupt **强制打断**：压暗画面并且锁操作。
   *        只有反派那几场用——它们的性质是"有人在你耳边说话"，
   *        玩家需要停一下才接得住。路边的东西一律传 false。
   * @param opts.ms 显式时长。**不传就按文本长度算**（`readingMs`），
   *        这才是长文案（中英长度差 3.5 倍）不被腰斩的唯一办法。
   * @param opts.dismissible **可点掉**。默认 false。
   *
   *        为什么默认仍然是 false：`.g-cards` 的 `pointer-events: none`
   *        是**文件头里写死的硬要求**——路边读到的东西必须不吃点击，
   *        压在它下面的路照样能点、照样能转。给所有卡开点击，
   *        等于把这条硬要求反过来：**过弯时点一下会吞掉一次转向输入**。
   *
   *        所以只有"停下来读"性质的段落才开：驿里的声音三句每句
   *        10~13 秒，等它自己走完是一种惩罚；而碑文、路口那三个字
   *        属于骑过去顺便读到，开点击只会让人乱点。
   */
  show(
    text: string,
    opts: { title?: string; interrupt?: boolean; ms?: number; dismissible?: boolean } = {},
  ): void {
    if (!text) return;
    // 静音时**不排进队列**。排进去的话队列会一直非空，
    // 而每次 `pump()` 都会被这条判断挡回去——于是 `afterCardGone()`
    // 认定"队列还有东西"，`setShown(root,false)` 永远不会执行。
    if (quiet) return;
    const card = el('div', 'g-card-line');
    if (opts.interrupt) card.classList.add('is-interrupt');
    if (opts.dismissible) card.classList.add('is-dismissible');
    if (opts.title) card.appendChild(el('div', 'g-card-t', opts.title));
    card.appendChild(el('div', 'g-card-b', text));
    if (opts.dismissible) {
      // 点一下 = 立刻退场（并接上队列里的下一张）。
      // 绑在这一张上而不是 `.g-cards` 容器上：容器要保持
      // `pointer-events: none`，否则路边那些字也会开始吃点击。
      card.addEventListener('click', () => this.dismiss(card));
    }
    this.root.appendChild(card);
    const ms = opts.ms ?? readingMs(text, isEnglish());
    this.cards.push({ root: card, life: Math.max(MIN_MS, ms) / 1000 });

    // 超出上限就把最早那条挤掉，而不是往下堆到屏幕外
    while (this.cards.length > MAX_CARDS) {
      const old = this.cards.shift();
      old?.root.remove();
    }
    setShown(this.root, true);
  }

  /**
   * 点掉某一张。
   *
   * 走的是和 `update()` 里自动退场**同一条**路径，所以队列推进只有一处实现——
   * "点掉"和"等它走完"的行为不可能各说各话。
   */
  private dismiss(card: HTMLElement): void {
    const i = this.cards.findIndex((c) => c.root === card);
    if (i < 0) return;
    card.remove();
    this.cards.splice(i, 1);
    this.afterCardGone();
  }

  /** 一张退场之后：队列里还有就接上，否则把容器收起来。 */
  private afterCardGone(): void {
    if (this.cards.length) return;
    if (this.queue.length) this.pump();
    else setShown(this.root, false);
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
    // 队列里还有就接上。**必须等屏幕上真的空了再接**，
    // 否则两张黑底卡重叠的 220ms 里文字会糊在一起。
    if (!this.cards.length) this.afterCardGone();
  }

  /**
   * 一次清空。进世界 / 重开时用，免得上一趟的字留到下一趟。
   *
   * **队列也一起清**。只清屏幕不清队列的症状很特别：
   * 重开一趟之后，序章的第一句会在玩家已经骑出去几十米的时候
   * 才浮上来——因为上一趟排队的后半截还留在里面。
   */
  clear(): void {
    for (const c of this.cards) c.root.remove();
    this.cards = [];
    this.queue = [];
    setShown(this.root, false);
  }

  get count(): number {
    return this.cards.length;
  }

  /** 队列里还没演的条数。回归用。 */
  get pending(): number {
    return this.queue.length;
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
  /** 旅币到账。`+N coins`。0 = 这一局没发钱（取消），不画这一行 */
  private gain: HTMLDivElement;
  /** 输了之后的那句安慰 / 超时说明。只有 lose 才有 */
  private note: HTMLDivElement;
  private onDone: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'g-result g-hidden');
    const box = el('div', 'g-result-box');
    this.big = el('div', 'g-result-big', '');
    this.sub = el('div', 'g-result-sub', '');
    this.gain = el('div', 'g-result-gain g-hidden', '');
    this.note = el('div', 'g-result-note g-hidden', '');
    box.appendChild(this.big);
    box.appendChild(this.sub);
    box.appendChild(this.gain);
    box.appendChild(this.note);
    this.root.appendChild(box);
    parent.appendChild(this.root);
  }

  /**
   * @param outcome 这一局怎么收的。**取消不是失败**——玩家按 Esc 退出时弹
   *        「这次没有完成」，读起来就是"我失败了"，而他明明什么都没做错。
   *        哪个 key 由 `game/phase.ts` 的 `settleTextKey` 判。
   * @param slot 乐事槽位（0..4），用来取 `fragment_<i>` 那两个字
   * @param ms 停留毫秒。不给就按 `settleMs(outcome)`——
   *        **成的时候给得比败的时候长**：赢是这一刻唯一的高光，输只是路过的过程。
   * @param o.gain 这一局实际到账的旅币。**0 就不画这一行**。
   *        钱是这一趟唯一"越玩越多"的东西，而它原来只体现在顶栏那个
   *        跳了一下的数字上——玩家要自己把两件事对上号。
   *        放在这里而不是再弹一条 toast：这一屏就是玩家唯一在看的屏幕，
   *        而 toast 和它同时出现会把"你赢了"和"你得了 20 旅币"拆成
   *        两条互不相干的提示（`storyCard.ts` 文件头记着这个教训）。
   * @param o.timedOut 是不是**超时**收的，而不是玩砸了。
   *        宿主 30 秒兜底与"弹错音"是两件事，而它们原来共用一句
   *        「这次没有完成」——玩家以为自己手慢，其实他根本没机会做完。
   */
  show(
    outcome: SettleOutcome,
    slot: number,
    ms = settleMs(outcome),
    onDone?: () => void,
    o: { gain?: number; timedOut?: boolean } = {},
  ): void {
    setText(this.big, t(settleTextKey(outcome)));
    // 副标题：赢了给乐事名，输了给「这一件：X」——
    // 输的时候玩家同样需要知道自己刚才是哪一件没做成，
    // 而 `mg_played` 那个键一直空着（它带一个尾随空格，本来就是给拼接用的）。
    // 取消不给：他什么都没做，告诉他"这一件是茶"只会让人以为自己漏了什么。
    const name = t(`fragment_${slot}`);
    setText(this.sub, outcome === 'win' ? name : outcome === 'lose' ? `${t('mg_played')}${name}` : '');

    const gain = o.gain ?? 0;
    setText(this.gain, gain > 0 ? t('collecting_lvbi', { 0: gain }) : '');
    setShown(this.gain, gain > 0);

    // 超时与玩砸分开说。取消没有这一行：他没输。
    const note = outcome === 'lose' ? t(o.timedOut ? 'mg_timeout' : 'mg_failed_hint') : '';
    setText(this.note, note);
    setShown(this.note, note !== '');

    this.root.classList.toggle('is-win', outcome === 'win');
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
