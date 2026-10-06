/**
 * 明信片预览 —— 还没到终点，也能看这一趟走到哪了。
 *
 * ## 它为什么不是结算页的复制品
 *
 * 原来只有一条路能看见这张卡：走完全程、`finishRun()` 弹出结算页。
 * 于是玩家在整个三十天里**完全不知道自己在攒什么**——只知道"收碎片、
 * 攒旅币、数驿站"，直到最后一天那张卡才第一次出现。
 * 而这张卡才是这一趟的产出物：他骑的每一天都在往它上面落格，
 * 却不知道每一格是怎么来的。
 *
 * 中途能看，才第一次让"碎片"这个词有了形状：
 * 不是一串计数，是卡上那一格从灰色问号变成真的画。
 *
 * ## 「点碎片」为什么圈地图上的点，而不是五格画区
 *
 * 画区随评级增减（`VARIANT_LAYOUTS` 里初旅只有 4 格）——
 * **还没到过的那一件在卡上根本没有格子可圈**。
 * 而 16 座驿站在地图方框里一直都在：到过没有，只是实心还是空心。
 * 所以圈的落点取地图上的驿站点（`fragmentMapDot()`），
 * 五种状态（没到 / 一到 / 两到 / 三到 / 五件齐）都圈得住。
 * 坐标也从 `render.ts` 里取，和 `drawRouteMap()` 画那颗点的是同一套投影——
 * 在两边各算一遍，圈会慢慢钉到框外去，而那颗点还在框里。
 *
 * ## 来历为什么只有一段、放在卡的上方
 *
 * 序章已经把来龙去脉讲过了（十八驿、五件乐事、"它们不是你的东西"），
 * 这里再讲一遍等于让玩家重听一遍序章。所以只补**那张卡是什么**：
 * 五格是什么、怎么落成真、背面那句话归谁。
 * 具体的"这一件在讲什么"由每格的 `fragment_tip_N` 承担，
 * 点了才展开——一段常显加五行按需读，比六段常显轻。
 */
import { buildInputFromState, drawPreview, fragmentMapDot } from '../game/postcard';
import type { PostcardInput } from '../game/postcard';
import { getLang } from '../i18n';
import { t } from '../i18n';
import { ECON, ROAD } from '../data/raw';
import { button, el, note, setAttr, setFlag, setShown, setText } from './dom';
import { stationName, wireKeyActivate } from './hud';
import { FRAGMENT_COLORS } from './theme';

/** 预览画布像素。和结算页那块是同尺寸，两处的圈与点才用同一套坐标。 */
const PREVIEW_W = 960;
const PREVIEW_H = 540;

export interface PostcardPanelOpts {
  parent: HTMLElement;
  /** 关掉这页、回到暂停面板。Esc 也走它。 */
  onClose(): void;
}

export class PostcardPanel {
  readonly root: HTMLDivElement;

  private readonly opts: PostcardPanelOpts;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly titleEl: HTMLHeadingElement;
  private readonly countEl: HTMLSpanElement;
  private readonly originEl: HTMLDivElement;
  private readonly hintEl: HTMLDivElement;
  private readonly tipEl: HTMLDivElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly cells: { btn: HTMLButtonElement; sw: HTMLSpanElement; name: HTMLSpanElement; stat: HTMLSpanElement }[] = [];

  /** 正在看的这一格；`-1` = 没选。 */
  private focus = -1;
  private unbindEsc: (() => void) | null = null;

  constructor(o: PostcardPanelOpts) {
    this.opts = o;
    this.root = el('div', 'g-screen g-pc g-hidden');
    const card = el('div', 'g-card g-card-pc');

    const head = el('div', 'g-pc-head');
    this.titleEl = el('h2', 'g-h2', t('postcard_look_title')) as HTMLHeadingElement;
    this.countEl = el('span', 'g-pc-count');
    head.appendChild(this.titleEl);
    head.appendChild(this.countEl);
    this.closeBtn = button(t('settings_close'), {
      cls: 'g-btn-quiet g-pc-x',
      aria: t('settings_close'),
      onClick: () => this.opts.onClose(),
    });
    head.appendChild(this.closeBtn);
    card.appendChild(head);

    const body = el('div', 'g-pc-body');

    const stage = el('div', 'g-card-stage g-pc-stage');
    this.canvas = el('canvas', 'g-card-cv') as HTMLCanvasElement;
    this.canvas.width = PREVIEW_W;
    this.canvas.height = PREVIEW_H;
    this.canvas.setAttribute('role', 'img');
    this.ctx = this.canvas.getContext('2d');
    stage.appendChild(this.canvas);
    body.appendChild(stage);

    const side = el('div', 'g-pc-side');
    this.originEl = el('div', 'g-pc-origin');
    side.appendChild(this.originEl);

    const fr = el('div', 'g-pc-frags');
    for (let s = 0; s < 5; s++) fr.appendChild(this.buildCell(s));
    side.appendChild(fr);

    this.tipEl = el('div', 'g-pc-tip g-hidden');
    side.appendChild(this.tipEl);
    body.appendChild(side);

    card.appendChild(body);
    this.hintEl = note(t('postcard_look_hint'), 'g-note-dim');
    card.appendChild(this.hintEl);

    this.root.appendChild(card);

    // 点卡外的暗处就关，和暂停面板里那份操作说明同一个手势。
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.opts.onClose();
    });

    // Esc 收掉这页、退回暂停，而不是直接回路上。
    // 走捕获阶段：main 的 keydown 挂在 window 的冒泡阶段，
    // 而它的 Esc 分支是"暂停就 resume"——不先拦住，
    // 玩家只是想翻完这张卡就骑回路上去了。
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Escape' || !isShownPc(this.root)) return;
      e.preventDefault();
      e.stopPropagation();
      this.opts.onClose();
    };
    document.addEventListener('keydown', onKey, true);
    this.unbindEsc = () => document.removeEventListener('keydown', onKey, true);

    for (const c of this.cells) wireKeyActivate(c.btn, () => c.btn.click());

    o.parent.appendChild(this.root);
    this.sync();
  }

  private buildCell(slot: number): HTMLButtonElement {
    const b = button('', {
      cls: 'g-pc-frag',
      onClick: () => this.focusCell(slot),
    });
    const sw = el('span', 'g-pc-frag-sw');
    sw.style.setProperty('--sw', FRAGMENT_COLORS[slot] ?? '#8a7f6b');
    const name = el('span', 'g-pc-frag-n', t(`fragment_${slot}`));
    const stat = el('span', 'g-pc-frag-s');
    b.appendChild(sw);
    b.appendChild(name);
    b.appendChild(stat);
    this.cells.push({ btn: b, sw, name, stat });
    return b;
  }

  /** 点这一格：圈到卡上、把它的来历那一句翻出来。 */
  private focusCell(slot: number): void {
    this.focus = this.focus === slot ? -1 : slot;
    this.paintTip();
    const input = buildInputFromState({ lang: getLang() });
    this.paintFrags(input);
    this.paint(input);
  }

  /** 那一格下面那句话。选中才显示——不选的时候这一屏不该多出一段要读的字。 */
  private paintTip(): void {
    const tip = this.focus >= 0 ? `${t(`fragment_${this.focus}`)} · ${t(`fragment_tip_${this.focus}`)}` : '';
    setText(this.tipEl, tip);
    setShown(this.tipEl, this.focus >= 0);
  }

  private statusOf(input: PostcardInput, slot: number): string {
    const stIdx = ROAD.FRAGMENT_SLOT_STATION_IDX[slot];
    const name = stationName(stIdx);
    const visits = Math.floor(input.slotVisits[slot] ?? 0);
    const max = ECON.MAX_VISITS_PER_STATION;
    if (visits <= 0) return t('postcard_status_missing', { 0: name });
    if (visits >= max) return t('postcard_status_full', { 0: name });
    return t('postcard_status_left', { 0: name, 1: max - visits });
  }

  private paintFrags(input: PostcardInput): void {
    for (let s = 0; s < this.cells.length; s++) {
      const c = this.cells[s];
      const visits = Math.floor(input.slotVisits[s] ?? 0);
      const max = ECON.MAX_VISITS_PER_STATION;
      setFlag(c.btn, 'is-got', visits > 0);
      setFlag(c.btn, 'is-full', visits >= max);
      setText(c.stat, this.statusOf(input, s));
      setText(c.name, t(`fragment_${s}`));
      setAttr(c.btn, 'aria-label', `${t(`fragment_${s}`)} · ${this.statusOf(input, s)}`);
      setFlag(c.btn, 'is-focus', this.focus === s);
    }
  }

  private paint(input: PostcardInput): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
    drawPreview(ctx, input, 'front');
    if (this.focus >= 0) {
      const p = fragmentMapDot(input, this.focus, PREVIEW_W, PREVIEW_H);
      if (p) {
        const k = PREVIEW_W / 900;
        // 两道：一道淡的晕把那一块从地图里托出来，一道实的圈钉住点。
        ctx.save();
        ctx.lineWidth = 9 * k;
        ctx.strokeStyle = 'rgba(20, 17, 12, 0.16)';
        ctx.beginPath();
        ctx.arc(p[0], p[1], 14 * k, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 2.2 * k;
        ctx.strokeStyle = 'rgba(20, 17, 12, 0.78)';
        ctx.beginPath();
        ctx.arc(p[0], p[1], 10 * k, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  show(): void {
    setShown(this.root, true);
    // 第一次进来就替玩家选好"还差的那一件"：
    // 不选的话这一屏只有五格空的卡，而"点一点"这件事得有人先示范一次。
    if (this.focus < 0) {
      this.focus = firstMissing();
    }
    this.sync();
    const first = this.root.querySelector<HTMLElement>('button:not([disabled])');
    if (first) first.focus();
  }

  hide(): void {
    setShown(this.root, false);
  }

  /** 语言切换、或玩家路上收了一件碎片之后回写。 */
  sync(): void {
    setText(this.titleEl, t('postcard_look_title'));
    setText(this.closeBtn, t('settings_close'));
    setText(this.hintEl, t('postcard_look_hint'));
    setText(this.originEl, t('postcard_origin'));

    const input = buildInputFromState({ lang: getLang() });
    const got = input.slotVisits.filter((v) => Math.floor(v ?? 0) > 0).length;
    setText(this.countEl, t('fragments', { 0: got }));
    this.paintFrags(input);

    this.paintTip();

    if (isShownPc(this.root)) this.paint(input);
  }

  dispose(): void {
    this.unbindEsc?.();
    this.root.remove();
  }
}

/** 界面是不是开着。单独一个函数，因为 Esc 的捕获监听拿不到实例。 */
function isShownPc(root: HTMLElement): boolean {
  return !root.classList.contains('g-hidden');
}

/** 还没到过的那一件；全到了就返回 -1（五件齐了，没得引导）。 */
function firstMissing(): number {
  const input = buildInputFromState({ lang: getLang() });
  for (let s = 0; s < input.slotVisits.length; s++) {
    if (Math.floor(input.slotVisits[s] ?? 0) <= 0) return s;
  }
  return -1;
}
