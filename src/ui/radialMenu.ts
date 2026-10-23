/**
 * Tab 转盘 —— 一圈图标按钮，方向键选、Enter 确认、Esc 关闭。
 *
 * ## 它替代了什么
 *
 * 原先这些动作**只在键位上**：V 切视角、E 换载具、M 静音、Esc 暂停、
 * 1~4 选道具。一个新玩家得先在暂停面板的键位表里读到"E 是换载具"，
 * 才敢按 E。
 *
 * 转盘把它们摆成**看得见的一圈**：图标 + 名字 + 键帽。
 * 这也正好落在用户要的"界面尽可能从文字转换成图标按钮"那一条上——
 * 键位说明从"一段文字"变成"一颗图标"。
 *
 * ## 为什么是 Tab，而不是新加一个键
 *
 * Tab 在这个游戏里**本来就没有任何绑定**（`keymap.ts` 的 `ACTIONS` 里没有它，
 * `RESERVED_CODES` 里也没有），所以拿它不撞任何已有快捷键。
 * 而它在浏览器里的默认行为是"移动焦点"——于是这里有一处**必须说清楚的取舍**：
 *
 * · 转盘开着的时候，Tab 被转盘吃掉（在转盘里换选中的那一项）。
 * · 转盘关着的时候，Tab 打开转盘。
 * · **Shift+Tab 永远交给浏览器**，任何时候都不拦。
 *
 * 代价是：从"焦点在 body"的状态按 Tab，得到的是转盘而不是第一个界面按钮。
 * 这条代价是**可以接受**的，理由有两条：
 *
 * 1. 转盘里装着骑行时需要的一切动作——交互、道具、视角、载具、声音、暂停，
 *    也就是原先需要 Tab 去够的那些按钮**全都在里面**。
 * 2. 界面里剩下的按钮仍然在**无障碍树**里（读屏的虚拟光标照常走得到），
 *    而键盘玩家有 `Shift+Tab` 这条永远畅通的退路。
 *
 * 换句话说：Tab 从"移动焦点"变成了"开转盘"，而转盘是骑行时的总闸。
 * 这是"一个轮子装下所有快捷动作"的思路。
 *
 * ## 键从哪来
 *
 * 转盘里那些"真动作"（切视角 / 换载具 / 静音 / 暂停 / 交互）
 * **不在这里实现**——它们由宿主把**既有的键码**合成为一次 `KeyboardEvent`
 * 派发出去，让游戏自己那个键盘监听器去消费。
 *
 * 理由写在 `AGENTS.md` §6：「动作走现有键码与 KeyboardEvent，不开平行输入」。
 * 如果转盘自己直接调 `world.ride.cycleCamera()`，
 * 那么玩家改键位之后，转盘就会和那把新键**各走各的**——
 * 而两处迟早会漂，漂了以后的症状是"我改了键，转盘还是干那件事"。
 */
import { t } from '../i18n';
import { blurWithin, el, setAttr, setFlag, setShown, setText } from './dom';
import { icon, type IconName } from './icons';

export interface RadialItem {
  /** 稳定 id。同一 id 会被当成同一项（更新时不重建按钮）。 */
  id: string;
  icon: IconName;
  /**
   * 名字。**是个函数而不是字符串**——因为切语言时它得跟着变，
   * 而转盘是常驻件：条目只在"内容变了"时才重画，
   * 字符串一旦存进去就冻在那儿，切完语言还是旧语言。
   * 传 `() => t('radial_items')` 这种形式，每次重画都读当前语言。
   */
  label: () => string;
  /** 键帽。缺省就不显示那一格。 */
  key?: string;
  /** 点了之后做什么。**由宿主给**。 */
  run: () => void;
  /** 不可用时显示成灰的，但仍占一个位置（这样圈不会跳）。 */
  disabled?: boolean;
}

interface RadialSlot {
  item: RadialItem;
  btn: HTMLButtonElement;
  icEl: HTMLSpanElement;
  keyEl: HTMLSpanElement;
  labelEl: HTMLSpanElement;
}

export class RadialMenu {
  readonly root: HTMLDivElement;

  private hub: HTMLDivElement;
  private hubTitle: HTMLDivElement;
  private hubHint: HTMLDivElement;
  private ring: HTMLDivElement;
  private slots: RadialSlot[] = [];
  private sel = 0;
  private open_ = false;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'g-radial g-hidden');
    this.root.setAttribute('role', 'menu');
    setAttr(this.root, 'aria-label', t('radial_title'));

    this.hub = el('div', 'g-radial-hub');
    this.hubTitle = el('div', 'g-radial-hub-t', t('radial_title'));
    this.hubHint = el('div', 'g-radial-hub-h', t('radial_hint'));
    this.hub.appendChild(this.hubTitle);
    this.hub.appendChild(this.hubHint);

    this.ring = el('div', 'g-radial-ring');
    this.root.appendChild(this.hub);
    this.root.appendChild(this.ring);
    parent.appendChild(this.root);
  }

  /**
   * 换一整圈条目。
   *
   * **按 id 复用按钮**：同一个 id 的那一项只改内容，不重建节点。
   * 重建按钮会把焦点弄丢——而焦点正是转盘在键盘上"选中项"的可视锚点。
   * 圈的大小变了（条目增减）时，只在末尾追加或移除，多余的槽位藏起来。
   */
  setItems(items: RadialItem[]): void {
    // 记下旧槽位，好把已经不在这一圈里的那些摘掉。
    const byId = new Map(this.slots.map((s) => [s.item.id, s]));
    const next: RadialSlot[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let slot = byId.get(it.id);
      if (!slot) {
        slot = this.makeSlot(it);
        this.ring.appendChild(slot.btn);
      }
      slot.item = it;
      this.paintSlot(slot);
      // 角度：从正上方开始，顺时针铺开。
      // 一项时是 0°（正上方），两项时是 -90°/+90°（左右），
      // 六项时正好每 60° 一颗。
      const step = 360 / Math.max(items.length, 1);
      slot.btn.style.setProperty('--a', `${-90 + i * step}deg`);
      next.push(slot);
    }
    // 这一圈里没有了的：摘掉。
    for (const s of this.slots) {
      if (!next.includes(s)) s.btn.remove();
    }
    this.slots = next;
    if (this.sel >= this.slots.length) this.sel = 0;
    this.paint();
  }

  private makeSlot(item: RadialItem): RadialSlot {
    const btn = el('button', 'g-radial-item');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    const icEl = el('span', 'g-radial-ic');
    const keyEl = el('span', 'g-radial-key');
    const labelEl = el('span', 'g-radial-t');
    btn.appendChild(icEl);
    btn.appendChild(keyEl);
    btn.appendChild(labelEl);
    const slot: RadialSlot = { item, btn, icEl, keyEl, labelEl };
    // 点击走**按 id 找**而不是按位置：圈里的顺序会变（条目会增减），
    // 而按位置找的话，删掉一项之后点到的就是隔壁那颗。
    btn.addEventListener('click', () => {
      const idx = this.slots.findIndex((s) => s.btn === btn);
      if (idx >= 0) this.activate(idx);
    });
    return slot;
  }

  private paintSlot(slot: RadialSlot): void {
    const it = slot.item;
    const name = it.label();
    setText(slot.labelEl, name);
    setText(slot.keyEl, it.key ?? '');
    setShown(slot.keyEl, !!it.key);
    setAttr(slot.btn, 'aria-label', it.key ? `${name} (${it.key})` : name);
    slot.btn.disabled = !!it.disabled;
    setFlag(slot.btn, 'is-off', !!it.disabled);
    const want = it.icon;
    if (slot.icEl.dataset.icon !== want) {
      slot.icEl.dataset.icon = want;
      slot.icEl.replaceChildren(icon(want));
    }
  }

  private paint(): void {
    for (let i = 0; i < this.slots.length; i++) {
      setFlag(this.slots[i].btn, 'is-sel', i === this.sel);
      setAttr(this.slots[i].btn, 'aria-selected', i === this.sel ? 'true' : 'false');
    }
  }

  // ---------------------------------------------------------------- 开合

  get isOpen(): boolean {
    return this.open_;
  }

  open(): void {
    if (this.open_) return;
    this.open_ = true;
    setShown(this.root, true);
    setText(this.hubTitle, t('radial_title'));
    setText(this.hubHint, t('radial_hint'));
    // 打开时重画一遍：条目上的名字是**函数**（跟着语言走），
    // 而转盘可能关了很久——期间切过一次语言。
    this.repaint();
    // 焦点落在当前选中的那一颗上：读屏器会念出它的名字，
    // 而键盘玩家能立刻看见"现在选中的是哪一个"。
    this.focusSel();
  }

  /** 把每一项的内容重画一遍。名字是函数，所以切语言后必须重画。 */
  repaint(): void {
    for (const s of this.slots) this.paintSlot(s);
    this.paint();
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    setShown(this.root, false);
    // 焦点不能留在一个 `display:none` 的按钮上：下一站 Tab 会从 body
    // 开始乱跳，而玩家刚关掉转盘正打算继续骑车。
    blurWithin(this.root);
  }

  toggle(): void {
    if (this.open_) this.close();
    else this.open();
  }

  private focusSel(): void {
    const s = this.slots[this.sel];
    if (s && !s.btn.disabled) s.btn.focus();
  }

  // ---------------------------------------------------------------- 键盘

  /**
   * 方向键 / Enter / Esc / Tab。**返回 true 表示"这一下被转盘吃掉了"**。
   *
   * 宿主必须在**自己的按键处理之前**问这一句：被吃掉的键不能再往下走
   * （方向键在骑行相位是转向，Esc 是暂停）。
   *
   * @param shift Shift 键按着没有。Tab + Shift 是"往回换"，其余一样。
   */
  handleKey(code: string, shift = false): boolean {
    if (!this.open_) return false;
    if (code === 'Escape') {
      this.close();
      return true;
    }
    if (code === 'ArrowRight' || code === 'ArrowDown') {
      this.move(1);
      return true;
    }
    if (code === 'ArrowLeft' || code === 'ArrowUp') {
      this.move(-1);
      return true;
    }
    if (code === 'Tab') {
      // 转盘开着的时候 Tab 在**圈里**换项，而不是把焦点带出转盘。
      // 见文件头「为什么是 Tab」那一节。
      this.move(shift ? -1 : 1);
      return true;
    }
    if (code === 'Enter' || code === 'Space') {
      this.activate(this.sel);
      return true;
    }
    return false;
  }

  private move(step: number): void {
    const n = this.slots.length;
    if (!n) return;
    // 跳过禁用项：停在它上面的话，Enter 什么也不会发生——
    // 那看起来就是"这颗按钮坏了"。
    for (let i = 1; i <= n; i++) {
      const idx = (this.sel + step * i + n * 2) % n;
      if (!this.slots[idx].btn.disabled) {
        this.sel = idx;
        break;
      }
    }
    this.paint();
    this.focusSel();
  }

  private activate(index: number): void {
    const s = this.slots[index];
    if (!s || s.btn.disabled) return;
    this.close();
    s.item.run();
  }
}
