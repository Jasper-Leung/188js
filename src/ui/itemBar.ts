/**
 * 道具栏 —— 底部一排格子，数字键 1~4 选。
 *
 * ## 放哪四个
 *
 *  game's `inv` 里真正属于"玩家随身带着的东西"的只有四件——
 * 信纸 / 墨 / 印 / 封口，也就是明信片那套材料。
 * 它们在结算面板里叫得出名字，但**在这之前从没出现在界面上**：
 * 玩家在铺子里买到"印"，只有一个 `shop_bought` 的「已购」在按钮上闪过，
 * 然后就再也找不到了。
 *
 * 道具栏解决的就是这个：**买到的东西要一直看得见。**
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
 * · **不抢焦点**：`pointer-events:none`，和 toast 同一套理由。
 *   一条道具栏吃掉正在按的空格键，玩家的车会突然停住。
 * · **格子恒在**：没买的道具显示成暗的轮廓而不是消失，
 *   这样玩家知道"还有四格是空的"，而不是以为道具栏就这么点东西。
 * · **不排版动画**：低配机上多一个合成层就是多一份钱（同 toast 的取舍）。
 */
import { t } from '../i18n';
import { el, setFlag, setShown, setText } from './dom';
import { game } from '../game/state';

/** 四格。顺序 = 数字键顺序 = 明信片正面的阅读顺序（纸 → 墨 → 印 → 封）。 */
const SLOTS = [
  { key: 'paper', num: '1' },
  { key: 'ink', num: '2' },
  { key: 'seal', num: '3' },
  { key: 'env', num: '4' },
] as const;

export type ItemId = (typeof SLOTS)[number]['key'];

export class ItemBar {
  readonly root: HTMLDivElement;
  private cells = new Map<ItemId, { box: HTMLDivElement; count: HTMLSpanElement }>();
  /** 当前选中。没买到任何一件时是 `null`。 */
  selected: ItemId | null = null;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'g-itembar');
    for (const s of SLOTS) {
      const box = el('div', 'g-item');
      box.appendChild(el('div', 'g-item-num', s.num));
      box.appendChild(el('div', 'g-item-ic', t(`item_${s.key}`)));
      const count = el('div', 'g-item-c', '');
      box.appendChild(count);
      this.root.appendChild(box);
      this.cells.set(s.key, { box, count });
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

  /** 选中的是哪一件（给 HUD 的道具环读）。 */
  sync() {
    for (const [id, cell] of this.cells) {
      const n = game.inv.get(id) ?? 0;
      setText(cell.count, n > 0 ? `×${n}` : '');
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
