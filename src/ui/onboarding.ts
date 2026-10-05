/**
 * 引导页 —— 四个词 + 操作说明，然后开骑。
 *
 * ## 四个词为什么是这四个
 *
 * 旅币、心神、驿、碎片——它们是玩家在这一趟里会遇到的**全部**抽象名词。
 * 其余的东西（乐事、明信片、旅店、封口）要么在第一次遇到时自己会解释，
 * 要么本来就该带着惊喜出现；而这四个如果不先说，玩家会在前三十秒里
 * 同时看到「已过 3 驿 / 旅币 27 / 心神 4/5 / 碎片 2/5」四个互不相干的数，
 * 一个都解释不了。
 *
 * 顺序也是判据：**先说会自己涨的（旅币），再说会自己掉的（心神），
 * 再说计数单位（驿），最后说目标（碎片）**。玩家读到最后一句时，
 * 前面三个数已经各自有名字了。
 *
 * ## 键盘可达是硬要求
 *
 * 这一页是**纯键盘必须走得完**的：Tab 能到每一项说明与那颗「开始骑行」，
 * Enter/Space 能激活。而「开始骑行」按下去之后进的是世界——
 * 那之后玩家要一直按着方向键，所以这一页不能是"只有鼠标能出去"的地方。
 * 原作把键盘玩家困死过一次（取消按钮点不到），这里不重蹈。
 */
import { t } from '../i18n';
import { button, el, rule, setShown, setText } from './dom';
import { wireKeyActivate } from './hud';

export interface OnboardingOpts {
  parent: HTMLElement;
  /** 进世界。宿主（index.ts）把它接到 `UI.enterWorld()`。 */
  onStart: () => void;
  /** 触屏设备显示触屏操作说明，桌面显示键盘说明。两套都写进 DOM，切的时候换显隐。 */
  touch: boolean;
}

interface Term {
  key: string;
  descKey: string;
  node: HTMLElement;
}

export class Onboarding {
  readonly root: HTMLDivElement;

  private terms: Term[] = [];
  private deskBox: HTMLDivElement;
  private touchBox: HTMLDivElement;
  private hintEl: HTMLDivElement;
  private startBtn: HTMLButtonElement;
  private isTouch: boolean;

  constructor(o: OnboardingOpts) {
    this.isTouch = o.touch;
    this.root = el('div', 'g-screen g-onb g-hidden');
    const card = el('div', 'g-card g-card-onb');

    card.appendChild(el('h2', 'g-h2', t('onboarding_title')));
    card.appendChild(el('div', 'g-onb-sub', t('onboarding_subtitle')));
    card.appendChild(rule());

    // ---- 四个词 ----
    card.appendChild(el('div', 'g-group-h', t('glossary_title')));
    const grid = el('div', 'g-gloss');
    const words: [string, string][] = [
      ['glossary_lvbi', 'glossary_lvbi_desc'],
      ['glossary_mood', 'glossary_mood_desc'],
      ['glossary_station', 'glossary_station_desc'],
      ['glossary_fragment', 'glossary_fragment_desc'],
    ];
    for (const [k, dk] of words) {
      const item = el('div', 'g-gloss-item');
      item.appendChild(el('div', 'g-gloss-w', t(k)));
      item.appendChild(el('div', 'g-gloss-d', t(dk)));
      grid.appendChild(item);
      this.terms.push({ key: k, descKey: dk, node: item });
    }
    card.appendChild(grid);
    card.appendChild(rule());

    // ---- 操作说明（两套都建，切的时候换显隐）----
    this.deskBox = this.buildDesk();
    this.touchBox = this.buildTouch();
    card.appendChild(el('div', 'g-group-h', t('controls_title')));
    card.appendChild(this.deskBox);
    card.appendChild(this.touchBox);

    this.hintEl = el('div', 'g-onb-hint', t('desktop_hint'));
    card.appendChild(this.hintEl);

    this.startBtn = button(t('start_ride'), { cls: 'g-btn-major', onClick: () => o.onStart() });
    const acts = el('div', 'g-acts');
    acts.appendChild(this.startBtn);
    card.appendChild(acts);

    this.root.appendChild(card);
    for (const b of this.root.querySelectorAll<HTMLElement>('.g-btn')) {
      wireKeyActivate(b, () => b.click());
    }
    o.parent.appendChild(this.root);
    this.setTouch(o.touch);
  }

  /**
   * 桌面：WASD / 空格 / ESC / M / V / E / 1~4，与 main 的 keydown 分支一一对应。
   *
   * 左边一列是**描述键**，右边才是键帽。原来这里写的是 `key_camera` /
   * `key_vehicle`——那两条的**值就是键帽本身**（"V" / "E"），于是界面上
   * 渲染出「V → V」「E → E」这种自指的行。`key_item_bar` 更糟：那条键
   * 根本不存在，`t()` 的兜底渲染成 `⟨key_item_bar⟩`。
   *
   * 三行里两行自指、一行是内部符号名，而这是玩家点「开启旅程」之后
   * 看到的**第一屏**。真正该用的 `key_item_bar_desc` 一直都在表里，
   * 只是被死字白名单当成"冗余条目"记了一笔。
   *
   * 现在由 `i18n-dead.mjs` 的反向判据（"引用了但没写"）守着这一类。
   */
  private buildDesk(): HTMLDivElement {
    const box = el('div', 'g-keys');
    const items: [string, string][] = [
      ['key_forward', 'W / ↑'],
      ['key_back', 'S / ↓'],
      ['key_left', 'A / ←'],
      ['key_right', 'D / →'],
      ['key_check_in', 'Space / Enter'],
      ['key_pause', 'Esc'],
      ['key_mute', 'M'],
      ['key_camera_desc', 'V'],
      ['key_vehicle_desc', 'E'],
      ['key_item_bar_desc', '1 ~ 4'],
    ];
    for (const [k, glyph] of items) {
      const r = el('div', 'g-key');
      r.appendChild(el('span', 'g-key-g', glyph));
      r.appendChild(el('span', 'g-key-d', t(k)));
      box.appendChild(r);
    }
    return box;
  }

  /** 触屏：左下摇杆 / 右侧打卡 / 右上三颗。 */
  private buildTouch(): HTMLDivElement {
    const box = el('div', 'g-keys');
    // 方位词也是文案：原来直接写死 '左下' / '右侧' / '右上'，
    // 于是触屏玩家的英文引导页上，两列说明都是英文、只有左边那把"键帽"是中文。
    const items: [string, string, string][] = [
      ['touch_joystick_key', 'touch_joystick_desc', 'touch_pos_left'],
      ['touch_checkin_key', 'touch_checkin_desc', 'touch_pos_right'],
      ['touch_buttons_key', 'touch_buttons_desc', 'touch_pos_topright'],
    ];
    for (const [k, dk, posKey] of items) {
      const r = el('div', 'g-key');
      r.appendChild(el('span', 'g-key-g', t(posKey)));
      const d = el('span', 'g-key-d');
      d.appendChild(el('b', null, t(k)));
      d.appendChild(el('i', null, t(dk)));
      r.appendChild(d);
      box.appendChild(r);
    }
    return box;
  }

  setTouch(on: boolean): void {
    this.isTouch = on;
    setShown(this.deskBox, !on);
    setShown(this.touchBox, on);
    setText(this.hintEl, on ? t('touch_hint') : t('desktop_hint'));
  }

  show(): void {
    setShown(this.root, true);
    this.startBtn.focus();
  }

  hide(): void {
    setShown(this.root, false);
  }

  /** 切语言。 */
  sync(): void {
    const head = this.root.querySelector('.g-h2');
    if (head) setText(head, t('onboarding_title'));
    const sub = this.root.querySelector('.g-onb-sub');
    if (sub) setText(sub, t('onboarding_subtitle'));
    for (const tm of this.terms) {
      const w = tm.node.querySelector('.g-gloss-w');
      const d = tm.node.querySelector('.g-gloss-d');
      if (w) setText(w, t(tm.key));
      if (d) setText(d, t(tm.descKey));
    }
    // 两套说明整体重建：它们是纯文本节点，替换比逐个 setText 省事，
    // 而这一页一辈子只显示一次，不在 update 路径上。
    const fresh = this.isTouch ? this.buildTouch() : this.buildDesk();
    const old = this.isTouch ? this.touchBox : this.deskBox;
    old.replaceWith(fresh);
    if (this.isTouch) this.touchBox = fresh;
    else this.deskBox = fresh;
    setText(this.hintEl, this.isTouch ? t('touch_hint') : t('desktop_hint'));
    setText(this.startBtn, t('start_ride'));
    const gh = this.root.querySelector('.g-group-h');
    if (gh) setText(gh, t('glossary_title'));
  }

  dispose(): void {
    this.root.remove();
  }
}
