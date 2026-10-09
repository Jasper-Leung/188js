/**
 * 对白框 —— 说话人 + 逐句推进。
 *
 * ## 按键为什么要在 window 的**捕获**阶段拦
 *
 * `main.ts` 在 window 上挂了一个全局 keydown：Space/Enter → 当前阶段的
 * 确认动作（roaming 下就是打卡），Esc → 暂停。对白播的时候阶段仍然是
 * roaming，于是不加处理的话：
 *
 * · 玩家按空格想推进对白 → main 同时发起了一次打卡，镜头被接管，
 *   对白框还挂在上面，而 `world.narrativeBusy` 已经让 `canCheckIn()`
 *   返回 busy。症状是"对白播到一半画面突然开始转场"。
 * · 玩家按 Esc 想跳过 → main 打开暂停面板，对白框被暂停面板盖住，
 *   而 `showDialogue()` 的 Promise 永远不 resolve，`narrativeBusy`
 *   再也解不开——**这一局就卡死了**。原作在取消按钮上栽过跟头，
 *   这里栽的是同一个坑的另一个入口。
 *
 * 所以对白打开时在 window 上挂一个**捕获**监听，把 Space/Enter/Esc
 * 全部吃掉。捕获阶段在 window 上先于 main 的冒泡监听执行，
 * `stopPropagation()` 之后 main 根本看不到这次按键。
 *
 * 唯一的例外是**对白自己的按钮**（下一句 / 跳过）：它们挂了
 * `wireKeyActivate()`，同样是捕获语义但只处理自己的目标元素。
 * 捕获监听碰到目标是 `.g-btn` 时直接放行，让原生按钮激活正常发生——
 * 否则那两颗按钮会退化成只能鼠标点，而键盘可达性是硬要求。
 */
import { button, el, setShown, setText } from './dom';
import { wireKeyActivate } from './hud';
import { t } from '../i18n';

/**
 * 逐字显示的速度（字/秒）。中文按「字」而不是按「字符」计更稳，
 * 因为标点在视觉上占位和汉字不同，按字符计会让带引号的句子忽快忽慢。
 *
 * 打完一行**不自动往下走**：本作要玩家自己控制节奏，而自动推进意味着
 * 玩家读第二遍的时候第三句已经把它顶掉了。
 */
const CHARS_PER_SEC = 26;

export class Dialogue {
  readonly root: HTMLDivElement;

  private speakerEl: HTMLDivElement;
  private textEl: HTMLDivElement;
  private nextBtn: HTMLButtonElement;
  private skipBtn: HTMLButtonElement;

  private lines: string[] = [];
  private lineIdx = 0;
  /** 当前行已经露出几个字。 */
  private shownChars = 0;
  private typing = false;
  private resolveCurrent: (() => void) | null = null;
  private onKeyBound = false;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'g-dlg g-hidden');
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'false');

    const box = el('div', 'g-dlg-box');
    this.speakerEl = el('div', 'g-dlg-who');
    box.appendChild(this.speakerEl);
    this.textEl = el('div', 'g-dlg-text');
    box.appendChild(this.textEl);

    const bar = el('div', 'g-dlg-bar');
    this.nextBtn = button(t('dialogue_next'), { cls: 'g-dlg-next' });
    this.skipBtn = button(t('dialogue_skip'), { cls: 'g-dlg-skip' });
    bar.appendChild(this.nextBtn);
    bar.appendChild(this.skipBtn);
    box.appendChild(bar);
    this.root.appendChild(box);
    parent.appendChild(this.root);

    // 点击框外的空白处也推进：原作是点哪都行，而对话框只占屏幕下方一条
    this.root.addEventListener('click', () => this.advance());

    wireKeyActivate(this.nextBtn, () => this.advance());
    wireKeyActivate(this.skipBtn, () => this.finish());
  }

  get active(): boolean {
    return this.resolveCurrent !== null;
  }

  /**
   * 播一段对白，播完（或跳过）resolve。
   *
   * 重复调用是安全的：上一次没播完就再调一次，会把上一次的 Promise 结掉，
   * 否则那个 `.then()` 永远挂着，`narrativeBusy` 就再也解不开——
   * 和上面 Esc 那个问题是同一类，只是入口不同。
   */
  private autoAdvanceSec = 0;
  private autoT = 0;

  show(speaker: string, lines: string[]): Promise<void> {
    this.finish();
    this.lines = lines.length ? lines : [''];
    this.lineIdx = 0;
    this.shownChars = 0;
    this.typing = this.lines[0].length > 0;
    setText(this.speakerEl, speaker);
    setShown(this.speakerEl, speaker.length > 0);
    this.renderLine();
    setShown(this.root, true);
    this.bindKeys();
    this.syncButtons();
    return new Promise<void>((resolve) => {
      this.resolveCurrent = resolve;
    });
  }

  /**
   * 自动推进的间隔（秒）。0 = 关，靠玩家按键。
   * 只给演示模式用——正常游玩里对白就是要等人读完。
   */
  setAutoAdvance(sec: number): void {
    this.autoAdvanceSec = sec;
    this.autoT = 0;
  }

  /**
   * 立刻收场，不等玩家按键。
   *
   * 存在的理由是 `Ui.hidePanels()`：那个方法负责"推新面板之前把旧面板收干净"，
   * 而它原来收了 pause / postcard / synthesis / endCard / shop 五样，
   * **唯独没收对白**。症状是 90 秒演示结束、结算屏推上来之后，
   * 序章那一句还浮在明信片卡片正上方——而且它会跟着玩家继续走：
   * `showTitle()` 与 `closeEndCard()` 都走同一个 `hidePanels()`。
   *
   * ⚠ **必须走 `finish()`，不能只 `setShown(root, false)`。**
   * `finish()` 除了藏，还会解 `resolveCurrent` 并摘掉按键监听。
   * 只藏不解 Promise 的话，所有 `whenDialogueIdle()` 的调用方会永久挂着——
   * 那正是这个项目反复栽过的"界面全对、只有某个 Promise 永远不落地"。
   *
   * `finish()` 本身幂等，没有对白在播时调用是安全的空操作。
   */
  hide(): void {
    this.finish();
  }

  /** 每帧推进一步逐字显示。暂停时 main 不调它，逐字就停在那儿——这是对的。 */
  update(dt: number): void {
    // 自动推进（演示模式）。没有它的话，演示会在第一句对白上永远停住：
    // 对白靠玩家按键推进，而演示里没有人按键——车也就跟着不动了，
    // 表现为"演示跑到第一个驿站就卡住"，而每一处代码都跑得好好的。
    if (this.autoAdvanceSec > 0 && this.active) {
      this.autoT += dt;
      if (this.autoT >= this.autoAdvanceSec) {
        this.autoT = 0;
        this.advance();
      }
    }
    if (!this.typing || dt <= 0) return;
    this.shownChars += CHARS_PER_SEC * dt;
    const full = this.lines[this.lineIdx]?.length ?? 0;
    if (this.shownChars >= full) {
      this.shownChars = full;
      this.typing = false;
      this.syncButtons();
    }
    this.renderLine();
  }

  /** 空格 / 点击：先把这一行吐完，吐完了再下一行。 */
  private advance(): void {
    if (!this.active) return;
    if (this.typing) {
      this.shownChars = this.lines[this.lineIdx]?.length ?? 0;
      this.typing = false;
      this.renderLine();
      this.syncButtons();
      return;
    }
    this.lineIdx++;
    if (this.lineIdx >= this.lines.length) {
      this.finish();
      return;
    }
    this.shownChars = 0;
    this.typing = this.lines[this.lineIdx].length > 0;
    this.renderLine();
    this.syncButtons();
  }

  /** 收尾：解 Promise、摘按键、隐藏。幂等。 */
  private finish(): void {
    const r = this.resolveCurrent;
    this.resolveCurrent = null;
    this.typing = false;
    setShown(this.root, false);
    this.unbindKeys();
    // 先解 Promise 再返回：调用方的 .then() 里可能立刻开下一段对白，
    // 而那需要这时的按键监听已经摘干净了，否则会多挂一个。
    if (r) r();
  }

  private renderLine(): void {
    const s = this.lines[this.lineIdx] ?? '';
    setText(this.textEl, s.slice(0, Math.floor(this.shownChars)));
  }

  /**
   * 按钮上的进度提示。
   * `visits_left_n` 在这里是借用的：它是一个纯 `%d` 的键，用来显示
   * 「第几句 / 共几句」。这比新增一个 key 好——`dialogue_next` 那一条
   * 已经说明了按钮的作用，不该再长出一个「3/7」的数字把它挤变形。
   */
  private syncButtons(): void {
    const n = this.lines.length;
    setText(
      this.nextBtn,
      this.typing || this.lineIdx >= n - 1
        ? t('dialogue_next')
        : `${this.lineIdx + 1} / ${n}`,
    );
    setShown(this.skipBtn, n > 1 || this.typing);
  }

  // ---------------------------------------------------------------- 按键

  private bindKeys(): void {
    if (this.onKeyBound) return;
    this.onKeyBound = true;
    window.addEventListener('keydown', this.onKey, true);
  }

  private unbindKeys(): void {
    if (!this.onKeyBound) return;
    this.onKeyBound = false;
    window.removeEventListener('keydown', this.onKey, true);
  }

  private onKey = (e: KeyboardEvent) => {
    if (!this.active) return;
    if (e.code === 'Space' || e.code === 'Enter') {
      // 焦点在对白自己的按钮上时放行，让原生激活走 wireKeyActivate
      const tgt = e.target as HTMLElement | null;
      if (tgt && typeof tgt.closest === 'function' && tgt.closest('.g-btn')) return;
      e.stopPropagation();
      e.preventDefault();
      if (!e.repeat) this.advance();
    } else if (e.code === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      if (!e.repeat) this.finish();
    }
  };

  /** 切语言之后。两颗按钮的文案都在这里重新取一遍。 */
  sync(): void {
    setText(this.skipBtn, t('dialogue_skip'));
    this.syncButtons();
  }

  dispose(): void {
    this.finish();
    this.root.remove();
  }
}
