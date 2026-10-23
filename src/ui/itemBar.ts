/**
 * 道具栏 —— 一个展开按钮，面板内保留四格；点击或数字键 1~4 选。
 *
 * ## 放哪四个
 *
 * game's `inv` 里真正属于"玩家随身带着的东西"的只有四件——
 * 信纸 / 墨 / 印 / 封口，也就是明信片那套材料。
 * 它们在结算面板里叫得出名字，但**在这之前从没出现在界面上**：
 * 玩家在铺子里买到"印"，只有一个 `shop_bought` 的「已购」在按钮上闪过，
 * 然后就再也找不到了。
 *
 * 道具面板让玩家随时查看已购材料，收起时给骑行画面留出空间。
 *
 * ## 为什么是"选中"而不是"使用"
 *
 * 这四件在原作里的作用是**拼出明信片**，没有"拿出来用一下"的时机。
 * 所以数字键选中的是**当前要用的那一件**，选中态会被 HUD 的道具环读走，
 * 也会在切换时给一条提示——它不改变任何玩法数值，
 * 这一点写在下面，免得被当成"道具系统"去期待它能做什么。
 *
 * ## 三条约束
 *
 * · **只在按钮内接收点击**：外壳不截获骑行触控，按钮保留键盘焦点。
 * · **面板内格子恒在**：没买的道具显示成不可选的轮廓而不是消失，
 *   这样玩家知道"还有四格是空的"，而不是以为道具栏就这么点东西。
 * · **不排版动画**：低配机上多一个合成层就是多一份钱（同 toast 的取舍）。
 *
 * ## 图标化
 *
 * 展开按钮与四格都改成了**图标**（`icons.ts` 的内联 SVG，零请求）。
 * 名字没有丢：它挪到了 `title` 与 `aria-label` 上——
 * 一颗只有图形的按钮若没有无障碍名，读屏器只会念「按钮」，
 * 那是把「图标化」做成了「不可用」。
 *
 * 为什么四格也换：那一格原来写着 `Envelope`，而 `first` 机位下车把横过
 * 整条底部，标签压在车篮上——图标没有字宽，**结构上**就不会被切掉。
 */
import { t } from '../i18n';
import { button, el, setAttr, setFlag, setShown, setText } from './dom';
import { icon, iconButton, type IconName } from './icons';
import { game } from '../game/state';

/** 四格。顺序 = 数字键顺序 = 明信片正面的阅读顺序（纸 → 墨 → 印 → 封）。 */
const SLOTS = [
  { key: 'paper', num: '1', icon: 'paper' },
  { key: 'ink', num: '2', icon: 'ink' },
  { key: 'seal', num: '3', icon: 'seal' },
  { key: 'env', num: '4', icon: 'envelope' },
] as const;

export type ItemId = (typeof SLOTS)[number]['key'];

export class ItemBar {
  readonly root: HTMLDivElement;
  private cells = new Map<ItemId, { box: HTMLButtonElement; count: HTMLSpanElement; label: HTMLElement }>();
  /** 当前选中。没买到任何一件时是 `null`。 */
  selected: ItemId | null = null;

  private toggle: HTMLButtonElement;
  private panel = el('div', 'g-item-panel g-hidden');
  private expanded = false;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'g-itembar');
    // 展开/收起：图标不变，**无障碍名变**（显示 / 隐藏）。
    // 所以这里不能 `setText` 那个按钮——那会把里面的 SVG 洗掉。
    this.toggle = iconButton('bag', t('items_show'), t('items_show'), 'g-fade g-item-toggle');
    this.toggle.addEventListener('click', () => { this.expanded = !this.expanded; this.sync(); });
    this.root.appendChild(this.toggle);
    this.root.appendChild(this.panel);
    for (const s of SLOTS) {
      const box = button('', { cls: 'g-item', onClick: () => { this.select(s.num); } });
      box.appendChild(el('div', 'g-item-num', s.num));
      // `.g-item-ic` 现在装的是图标。**名字在 title / aria-label 上**，
      // 而它必须在那儿——见文件头「图标化」那一节。
      const label = el('div', 'g-item-ic');
      label.appendChild(icon(s.icon as IconName));
      box.appendChild(label);
      const count = el('div', 'g-item-c', '');
      box.appendChild(count);
      this.panel.appendChild(box);
      this.cells.set(s.key, { box, count, label });
    }
    parent.appendChild(this.root);
    this.sync();
  }

  /** 数字键 1~4 → 选中某格。没买到就返回 false，调用方给一句提示。 */
  select(key: string): boolean {
    const s = SLOTS.find((x) => x.num === key);
    if (!s) return false;
    if ((game.inv.get(s.key) ?? 0) <= 0) return false;
    this.selected = s.key;
    this.sync();
    return true;
  }

  /**
   * 展开 / 收起面板。给 Tab 转盘用。
   *
   * 展开态是**唯一的**：所以它住在道具栏自己身上，
   * 而不是让转盘替它记一份——两份状态迟早会对不上，
   * 而症状是"转盘显示'收起'，而面板是开着的"。
   */
  togglePanel(): void {
    this.expanded = !this.expanded;
    this.sync();
  }

  /** 选中的是哪一件（给 HUD 的道具环读）。 */
  sync() {
    const toggleLabel = t(this.expanded ? 'items_hide' : 'items_show');
    setAttr(this.toggle, 'aria-label', toggleLabel);
    setAttr(this.toggle, 'title', toggleLabel);
    setAttr(this.toggle, 'aria-expanded', String(this.expanded));
    setShown(this.panel, this.expanded);
    setFlag(this.root, 'is-expanded', this.expanded);
    for (const [id, cell] of this.cells) {
      const n = game.inv.get(id) ?? 0;
      setText(cell.count, n > 0 ? `×${n}` : '');
      // 名字走无障碍名与悬停提示。图标本身是 `aria-hidden` 的
      // （见 icons.ts），所以**无障碍名由按钮承担**。
      const name = t(`item_${id}`);
      setAttr(cell.box, 'aria-label', name);
      setAttr(cell.box, 'title', name);
      cell.box.disabled = n <= 0;
      cell.box.setAttribute('aria-pressed', String(this.selected === id));
      setFlag(cell.box, 'is-own', n > 0);
      setFlag(cell.box, 'is-sel', this.selected === id);
    }
    setShown(this.root, this.visible);
  }

  /** 在世界里才显示。标题页与引导页不占这一块位置。 */
  visible = false;

  setVisible(v: boolean) {
    this.visible = v;
    setShown(this.root, v);
  }
}
