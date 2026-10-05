/**
 * 结算页 —— 明信片正反面、切面、背面手写、导出、终局二选一。
 *
 * ## 为什么明信片模块是**动态** import 的
 *
 * `game/postcard/render.ts` 有 58KB，里面是正面/背面两套完整画笔。
 * 首屏要的是标题页和 3D 世界，玩家要看到明信片是**这一趟的最后**。
 * `main.ts` 已经用 `await import('./game/postcard')` 定下了这个约定，
 * 这里沿用：第一次 `show()` 才把模块拉进来；类型走 `import type`，
 * 编译期擦除，零运行时成本。
 *
 * ## 预览画布为什么是 960×540 而不是 1920×1080
 *
 * `CARD_SIZE` = 1920×1080，是**导出**的尺寸（和原作 `EndCard.gd` 一致）。
 * 预览用同一份 `drawPreview()`，它按 `canvas.width` 自己推缩放系数，
 * 所以换小画布相对关系完全一致（render.ts 的注释里明说了「在 1920 的导出
 * 和 450 的预览上」）。1920×1080×4B = 8.3MB，一个只看一眼的预览占 8MB
 * 不合理，而目标是 4GB 内存的机器。960 降到 2MB。
 *
 * ## 手写体为什么走 FontFace API
 *
 * `public/fonts/handwriting.woff2` 有 404KB，**只在打开背面编辑器时**加载。
 * 用 `postcard/export.ts` 的 `ensureHandwritingFont()` 而不是自己写
 * `@font-face`：它先 `document.fonts.check()`、再自己注册 FontFace、
 * 最后 `load()`，而且导出的画布**也**等的是同一个 Promise。
 * 这条不能各走各的——画布 2D 用一个还没 load 完的字体族去 `fillText`
 * 不会报错也不会提示，它直接用当时那套字形画完，症状是
 * 「界面上看得见手写体，导出的 PNG 是系统字体」。走同一个函数，
 * 预览和导出的 PNG 用的就是同一次加载结果。
 */
import { t, isEnglish } from '../i18n';
import { button, clear, el, note, rule, setDisabled, setFlag, setShown, setText } from './dom';
import { wireKeyActivate, stationName } from './hud';
import { FONT_HANDWRITE } from './theme';
import type { PostcardInput } from '../game/postcard';
import { STATIONS } from '../data/route';
import { ROAD } from '../data/raw';
import type { UIHooks } from './index';
import type { GameStateManager } from '../game/state';
import type { Toast } from './toast';

/** 预览画布的边长。理由见文件头。 */
const PREVIEW_W = 960;
const PREVIEW_H = 540;

/** 背面字数的兜底上限。`layout.BACK_MAX_CHARS` 是同一个 200，
 *  这里写死只是为了「明信片模块还没到」的那几十毫秒里也能夹住输入；
 *  模块一到位就走 `clampBackText()`，那是唯一的权威实现。 */
const BACK_FALLBACK_MAX = 200;

/** 明信片模块里本屏用到的部分。 */
interface PostcardMod {
  drawPreview: (ctx: CanvasRenderingContext2D, input: PostcardInput, side: 'front' | 'back') => void;
  clampBackText: (s: string) => string;
  ensureHandwritingFont: () => Promise<boolean>;
  paperTierNameKey: (kitTier: number) => string | null;
}

export interface EndCardOpts {
  parent: HTMLElement;
  hooks: UIHooks;
  game: GameStateManager;
  toast: Toast;
}

export class EndCard {
  readonly root: HTMLDivElement;
  private hooks: UIHooks;
  private game: GameStateManager;
  private toast: Toast;

  private mod: PostcardMod | null = null;
  private side: 'front' | 'back' = 'front';
  private backText = '';
  private editorOpen = false;
  private focused = false;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private captionEl: HTMLDivElement;

  private frontTab: HTMLButtonElement;
  private backTab: HTMLButtonElement;
  private writeBtn: HTMLButtonElement;
  private recapBox: HTMLDivElement;
  private joyBox: HTMLDivElement;
  private paperEl: HTMLSpanElement;

  private editor: HTMLDivElement;
  private ta: HTMLTextAreaElement;
  private countEl: HTMLSpanElement;
  private confirmBtn: HTMLButtonElement;
  private skipBtn: HTMLButtonElement;
  private frontBtn: HTMLButtonElement;

  private expF: HTMLButtonElement;
  private expB: HTMLButtonElement;
  private endKeep: HTMLButtonElement;
  private endBreak: HTMLButtonElement;

  constructor(o: EndCardOpts) {
    this.hooks = o.hooks;
    this.game = o.game;
    this.toast = o.toast;

    this.root = el('div', 'g-screen g-end g-hidden');

    // ================= 左：卡片 =================
    const left = el('div', 'g-end-l');
    const stage = el('div', 'g-card-stage');
    this.canvas = el('canvas', 'g-card-cv');
    this.canvas.width = PREVIEW_W;
    this.canvas.height = PREVIEW_H;
    this.canvas.setAttribute('role', 'img');
    // 拿不到 2D 上下文只剩一条路：不画。可 2D 上下文在任何一个
    // 支持 WebGL2 的浏览器上都不会拿不到，所以直接抛——静默画不出东西的
    // 结算页比报错更难查。
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('明信片预览拿不到 2D 上下文');
    this.ctx = ctx;
    stage.appendChild(this.canvas);
    left.appendChild(stage);

    const tabs = el('div', 'g-tabs');
    this.frontTab = button(t('card_side_front'), { cls: 'g-tab', onClick: () => this.setSide('front') });
    this.backTab = button(t('card_side_back'), { cls: 'g-tab', onClick: () => this.setSide('back') });
    tabs.appendChild(this.frontTab);
    tabs.appendChild(this.backTab);
    left.appendChild(tabs);

    this.captionEl = el('div', 'g-end-cap');
    left.appendChild(this.captionEl);
    this.root.appendChild(left);

    // ================= 背面编辑器 =================
    this.editor = el('div', 'g-editor');
    this.editor.appendChild(el('div', 'g-group-h', t('back_editor_title')));
    this.ta = el('textarea', 'g-ta');
    this.ta.rows = 5;
    this.ta.placeholder = t('back_placeholder');
    // 手写体只在这一刻需要：编辑器是全工程唯一用到 GiftHand 的地方
    this.ta.style.fontFamily = FONT_HANDWRITE;
    this.editor.appendChild(this.ta);
    this.countEl = el('span');
    this.editor.appendChild(el('div', 'g-editor-count')).appendChild(this.countEl);
    const eActs = el('div', 'g-acts');
    this.confirmBtn = button(t('back_confirm'), { cls: 'g-btn-major', onClick: () => this.commit() });
    this.skipBtn = button(t('back_skip'), {
      cls: 'g-btn-quiet',
      onClick: () => {
        this.ta.value = '';
        this.commit();
        this.exportSide('back');
      },
    });
    this.frontBtn = button(t('back_to_front'), { cls: 'g-btn-quiet', onClick: () => this.closeEditor() });
    eActs.appendChild(this.confirmBtn);
    eActs.appendChild(this.skipBtn);
    eActs.appendChild(this.frontBtn);
    this.editor.appendChild(eActs);
    this.ta.addEventListener('input', () => {
      setText(this.countEl, String(this.clamp(this.ta.value).length));
    });
    left.appendChild(this.editor);
    setShown(this.editor, false);

    // ================= 右：清单与动作 =================
    const right = el('div', 'g-end-r');
    // 纸面档位名（没买套餐时 paperTierNameKey 返回 null，这一格就空着）
    const paperRow = el('div', 'g-end-paper');
    this.paperEl = el('span', 'g-end-paper-n');
    paperRow.appendChild(this.paperEl);
    right.appendChild(paperRow);

    right.appendChild(el('div', 'g-group-h', t('postcard_joys_title')));
    this.joyBox = el('div', 'g-joys');
    right.appendChild(this.joyBox);

    right.appendChild(rule());
    this.writeBtn = button(t('write_back'), { cls: 'g-btn-wide', onClick: () => this.openEditor() });
    right.appendChild(this.writeBtn);

    const exRow = el('div', 'g-acts');
    this.expF = button('', { cls: 'g-btn-major', onClick: () => this.exportSide('front') });
    this.expB = button('', { cls: 'g-btn-major', onClick: () => this.exportSide('back') });
    exRow.appendChild(this.expF);
    exRow.appendChild(this.expB);
    right.appendChild(exRow);

    const shareRow = el('div', 'g-tools');
    shareRow.appendChild(button(t('share'), { cls: 'g-btn-quiet', onClick: () => void this.copyShare() }));
    shareRow.appendChild(
      button(t('restart_end'), { cls: 'g-btn-quiet', onClick: () => this.hooks.onRestart() }),
    );
    right.appendChild(shareRow);

    right.appendChild(rule());
    right.appendChild(el('div', 'g-group-h', t('ending_title')));
    right.appendChild(note(t('ending_hint'), 'g-note-dim'));
    const endRow = el('div', 'g-acts');
    this.endKeep = button(t('ending_keep'), { cls: 'g-btn-major', onClick: () => this.pick('leave_door') });
    this.endBreak = button(t('ending_break'), { cls: 'g-btn-major', onClick: () => this.pick('let_go') });
    endRow.appendChild(this.endKeep);
    endRow.appendChild(this.endBreak);
    right.appendChild(endRow);

    this.recapBox = el('div', 'g-recap');
    right.appendChild(this.recapBox);
    right.appendChild(note(t('disclaimer'), 'g-note-dis'));
    this.root.appendChild(right);

    // 禁用态的按钮不该被空格激活——灰按钮按下去没反应是对的，
    // 但如果它同时还会 emit 一次 onEndingPick 就不对了。
    for (const b of this.root.querySelectorAll<HTMLElement>('.g-btn')) {
      wireKeyActivate(b, () => {
        if (!(b as HTMLButtonElement).disabled) b.click();
      });
    }
    o.parent.appendChild(this.root);
  }

  // ---------------------------------------------------------------- 生命周期

  show(): void {
    setShown(this.root, true);
    this.sync();
    if (!this.mod) {
      // 模块还在路上：先铺一张纸色的空卡，玩家看到的是「一张正在生成的卡」
      this.paintBlank();
      void this.loadMod();
    } else {
      this.paint();
    }
    if (!this.focused) {
      this.focused = true;
      const first = this.root.querySelector<HTMLElement>('.g-btn-major');
      if (first) first.focus();
    }
  }

  hide(): void {
    setShown(this.root, false);
  }

  private async loadMod(): Promise<void> {
    try {
      this.mod = (await import('../game/postcard')) as unknown as PostcardMod;
      if (this.root.classList.contains('g-hidden')) return;
      this.paint();
      this.paintPaper();
    } catch {
      // 画不出来：面板还在，只是卡是空白的。不要把整个结算页弄没——
      // 玩家这一趟的驿数、心神、五件乐事都还写在右栏里。
      this.paintBlank();
    }
  }

  // ---------------------------------------------------------------- 画卡

  /**
   * 拼导出输入。
   *
   * `main.ts` 里有一份几乎一样的 `buildPostcardInput()`。这一份是**预览**用的，
   * 少不了一件东西：它必须带上 `seenStations` / `seenCount`，
   * 否则抬头那张路线图上全是空心点、配着一行「已过 0 驿」——
   * 那是一张玩家永远拿不到的卡（`postcard/types.ts` 的注释里点名了这个兜底）。
   * main 那份没传这两项（不在本任务的文件范围里），导出的 PNG 抬头会走
   * `seenCountOf()` 的兜底分支。**这一处需要 main 侧补上。**
   */
  private buildInput(): PostcardInput {
    const seen: boolean[] = [];
    for (let i = 0; i < STATIONS.length; i++) seen.push(this.game.seenStations.has(i));
    return {
      slotVisits: ROAD.FRAGMENT_SLOT_STATION_IDX.map((i) => this.game.getStationCount(i)),
      kitTier: this.game.getPostcardTier(),
      hasPaper: this.game.hasItem('paper'),
      hasInk: this.game.hasItem('ink'),
      hasSeal: this.game.hasItem('seal'),
      hasEnvelope: this.game.hasItem('env'),
      ending: this.game.endingId === 'let_go' ? 'let_go' : 'leave_door',
      backText: this.backText,
      lang: isEnglish() ? 'en' : 'zh',
      seenStations: seen,
      seenCount: this.game.getSeenStationCount(),
    };
  }

  private paint(): void {
    if (!this.mod) return;
    try {
      this.ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
      this.mod.drawPreview(this.ctx, this.buildInput(), this.side);
    } catch {
      this.paintBlank();
    }
  }

  private paintBlank(): void {
    this.ctx.fillStyle = '#f4f2ea';
    this.ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H);
  }

  private setSide(side: 'front' | 'back'): void {
    if (this.side === side) return;
    this.side = side;
    this.closeEditor();
    this.sync();
    this.paint();
  }

  // ---------------------------------------------------------------- 背面手写

  private clamp(s: string): string {
    return this.mod ? this.mod.clampBackText(s) : s.slice(0, BACK_FALLBACK_MAX);
  }

  private openEditor(): void {
    this.editorOpen = true;
    setShown(this.editor, true);
    this.ta.value = this.backText;
    setText(this.countEl, String(this.backText.length));
    this.ta.focus();
    if (!this.mod) return;
    // 字体拿不到就静默退回系统兜底字体——`postcard/export.ts` 的注释
    // 里明确选了这一条：总比整条导出按钮报错、把玩家这一趟的产物弄丢要好。
    // 所以这里不弹任何提示，`onWriteBack()` 报出去的还是同一段字。
    void this.mod.ensureHandwritingFont();
  }

  private closeEditor(): void {
    if (!this.editorOpen) return;
    this.editorOpen = false;
    setShown(this.editor, false);
  }

  private commit(): void {
    this.backText = this.clamp(this.ta.value);
    this.ta.value = this.backText;
    setText(this.countEl, String(this.backText.length));
    this.closeEditor();
    // 把这份字报给宿主：导出时它要用同一段 `backText` 拼 `PostcardInput`，
    // 而宿主自己并不持有这个编辑器。宿主存下之后 `syncFromState()`
    // 会回来调本屏的 sync()，所以这里不用再主动重画。
    this.hooks.onWriteBack(this.backText);
    this.sync();
    this.paint();
  }

  // ---------------------------------------------------------------- 动作

  /**
   * 导出。**真正下载 PNG 的是宿主**（`onExportPostcard` → `exportPostcardPng`
   * → `<a download>`），这里只发指令。
   *
   * 为什么不自己导：那会是**两次下载**——UI 导一次、宿主再导一次，
   * 玩家在下载目录里拿到两个同名文件。所以这条 hook 的语义是
   * 「请求导出这一面」，成功与否由宿主弹 `exported` / `export_failed`。
   */
  private exportSide(side: 'front' | 'back'): void {
    this.hooks.onExportPostcard(side);
  }

  private pick(ending: 'leave_door' | 'let_go'): void {
    this.hooks.onEndingPick(ending);
    // 宿主的 onEndingPick 会 `game.setEnding()` 再 `ui.syncFromState()`，
    // 所以状态此刻已经是对的了；这里只需要把改了终局的正面重画一遍
    // （放手会把封口的蜡掰开，那是**画在正面**上的差别）。
    this.paint();
  }

  private async copyShare(): Promise<void> {
    try {
      await navigator.clipboard.writeText(t('share_text'));
      this.toast.show(t('copied'), 1400);
    } catch {
      // 剪贴板在没有用户手势 / 非安全上下文里会被拒。
      // 不给提示比给一句「复制失败」好——那句话会让人以为剪贴板坏了，
      // 而实际上他可以直接选中那几行字。
    }
  }

  // ---------------------------------------------------------------- 同步

  /** 全部显示从 game 回读。切语言、买东西、选了终局之后调。 */
  sync(): void {
    // 注意这里**不改显隐**：sync 只负责内容。让它顺手 show 一下的话，
    // `UI.syncFromState()` 那道「面板开着才同步」的门就形同虚设了。
    setText(this.frontTab, t('card_side_front'));
    setText(this.backTab, t('card_side_back'));
    setFlag(this.frontTab, 'is-on', this.side === 'front');
    setFlag(this.backTab, 'is-on', this.side === 'back');
    // 背面那一句按结局分支：选了「放手」就把"留白是故意的"说出来。
    // `back_break_blank` 之前是死字——文案写着"背面留白，封口的蜡已经掰开。
    // 这句话不再替你写"，而玩家点进背面只看到一片空白，
    // 读起来像**功能没做完**，不像一个抉择。说出这句话，它才是抉择。
    const backCaption =
      this.game.endingId === 'break' ? t('back_break_blank') : t('back_preview_caption');
    setText(this.captionEl, this.side === 'front' ? t('postcard_variant_hint') : backCaption);

    setText(this.writeBtn, t('write_back'));
    // 导出两颗按钮要能分辨：同一个「导出明信片」摆在两处，玩家不知道
    // 哪颗出正面。这里拼的是「动词 · 名词」，不是新文案。
    setText(this.expF, `${t('export')} · ${t('card_side_front')}`);
    setText(this.expB, `${t('export')} · ${t('card_side_back')}`);
    setText(this.endKeep, t('ending_keep'));
    setText(this.endBreak, t('ending_break'));
    setText(this.confirmBtn, t('back_confirm'));
    setText(this.skipBtn, t('back_skip'));
    setText(this.frontBtn, t('back_to_front'));

    // 选了哪一边，那一颗就不再可选。
    // 不这么做的话玩家能反复横跳，而「选一边，另一边就没了」是这一屏的赌注。
    const chosen = this.game.endingId;
    setDisabled(this.endKeep, chosen === 'leave_door');
    setDisabled(this.endBreak, chosen === 'let_go');

    this.paintJoys();
    this.paintPaper();
    this.paintRecap();
  }

  private paintJoys(): void {
    clear(this.joyBox);
    for (let s = 0; s < 5; s++) {
      const n = this.game.getStationCount(ROAD.FRAGMENT_SLOT_STATION_IDX[s]);
      const r = el('div', 'g-joy');
      r.appendChild(el('span', 'g-joy-w', t(`fragment_${s}`)));
      r.appendChild(el('span', 'g-joy-n', t('postcard_visit_n', { 0: n })));
      r.title = t(`fragment_tip_${s}`);
      setFlag(r, 'is-empty', n === 0);
      this.joyBox.appendChild(r);
    }
  }

  /** 纸面档位名。没买套餐时 `paperTierNameKey` 返回 null，就什么都不显示。 */
  private paintPaper(): void {
    if (!this.mod) {
      setText(this.paperEl, '');
      return;
    }
    const key = this.mod.paperTierNameKey(this.game.getPostcardTier());
    setText(this.paperEl, key ? t(key) : '');
  }

  /**
   * 这一趟还剩下的东西。
   *
   * 只写**能从 game 读出来**的那几行。小游戏的胜负（`recap_mini` /
   * `recap_mini_lost`）不写——`GameStateManager` 里没有这个计数器，
   * `onMiniGame()` 只把胜负换成了旅币。要加得在 state.ts 里加一个计数器，
   * 那是数据层的改动，不在 UI 这一层的范围里。
   */
  private paintRecap(): void {
    clear(this.recapBox);
    this.recapBox.appendChild(el('div', 'g-group-h', t('recap_title')));
    const add = (k: string, vars?: Record<string, string | number>) => {
      this.recapBox.appendChild(el('div', 'g-recap-l', t(k, vars)));
    };

    add('recap_seen', { 0: this.game.getSeenStationCount() });

    const missing: string[] = [];
    for (let s = 0; s < 5; s++) {
      if (this.game.fragmentSlotVisitsLeft(s) > 0) missing.push(t(`fragment_${s}`));
    }
    if (missing.length === 1) add('recap_frag_one', { 0: missing[0] });
    else if (missing.length > 1) add('recap_frag_missing', { 0: missing.join('、') });

    // 没读到的驿站：路过但没打过卡、而它自己是有话可说的那几座
    const unread: string[] = [];
    for (let i = 0; i < STATIONS.length; i++) {
      if (!this.game.seenStations.has(i)) continue;
      if (this.game.getStationCount(i) > 0) continue;
      if (STATIONS[i].def.text) unread.push(stationName(i));
    }
    if (unread.length) add('recap_unread', { 0: unread.join('、') });

    if (this.game.endingId) {
      add('recap_ending', {
        0: t(this.game.endingId === 'let_go' ? 'ending_break' : 'ending_keep'),
      });
    }
    if (this.game.lvbi > 0) add('recap_lvbi', { 0: this.game.lvbi });
    const extras =
      (this.game.hasItem('paper') ? 1 : 0) +
      (this.game.hasItem('ink') ? 1 : 0) +
      (this.game.hasItem('seal') ? 1 : 0) +
      (this.game.hasItem('env') ? 1 : 0);
    if (extras > 0) add('recap_tier', { 0: extras });
  }

  dispose(): void {
    this.root.remove();
  }
}
