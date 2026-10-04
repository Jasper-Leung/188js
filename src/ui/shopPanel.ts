/**
 * 铺子面板 —— 驿铺 / 茶铺 / 灯铺。
 *
 * ## 买不了的时候必须说清是哪一条
 *
 * `GameStateManager.canBuy()` 返回一个布尔值，而那对玩家等于零信息：
 * 旅币不够、要先收碎片、心神已满、已经买满、已经有更好的一档——
 * 五种完全不同的处境，同一个"灰按钮"。原作把这一条列为必修，
 * 因为灰按钮玩家**看得见**，他会绕过去看看别处，然后发现没有别处。
 *
 * 所以这里不复用 `canBuy()` 的返回值来决定显示什么，而是另写一个
 * `blockReason()`，**按玩家的因果顺序**逐条判：
 *
 *   1. 已经有更好的一档 / 心神已满 / 买满了   ← 买了也不会有变化，先说
 *   2. 需要 N 块碎片                        ← 条件，去做别的
 *   3. 旅币不够                              ← 钱，去骑一圈
 *
 * 这个顺序和 `canBuy()` 内部的顺序**故意不同**：`canBuy` 是随便什么顺序
 * 的早返回（那是实现细节），而这里要的是「玩家下一步该干什么」。
 * 两者必须保持一致（买了之后状态要真的变），但不必同序。
 *
 * ## 「无价」那五块
 *
 * `SHOPS.NOT_FOR_SALE` = 云/茶/琴/竹/禽。它们不能买，但**要摆在架子上**：
 * 玩家在驿铺里看见五件"无价"的东西，才会明白碎片不是钱能买的，
 * 而这一趟的目标就是把它们一件一件换回来。
 */
import { t, isEnglish } from '../i18n';
import { ECON, SHOPS } from '../data/raw';
import type { GoodDef } from '../data/raw';
import { button, el, setDisabled, setFlag, setShown, setText } from './dom';
import { wireKeyActivate } from './hud';
import type { UIHooks } from './index';
import type { GameStateManager } from '../game/state';

/**
 * 碎片汉字 → 槽位下标。
 *
 * `NOT_FOR_SALE` 存的是碎片本身的字（'云'），而 `fragment_0..4` 是槽位下标。
 * 架子上要给玩家看的是**槽位**那一份（云/茶/琴/竹/禽，与 HUD 同序），
 * 所以这里把字翻成下标再走 `fragment_n`。翻不出就退回 0（云），
 * 而不是让 `t()` 返回 `⟨fragment_undefined⟩`——货架上出现一个 key 本身，
 * 比显示错一个字更容易让人以为出了 bug。
 */
const NOT_FOR_SALE_SLOT: Record<string, number> = { 云: 0, 茶: 1, 琴: 2, 竹: 3, 禽: 4 };

export interface ShopOpts {
  parent: HTMLElement;
  hooks: UIHooks;
  game: GameStateManager;
}

interface Card {
  good: GoodDef;
  price: HTMLSpanElement;
  btn: HTMLButtonElement;
}

/** 买不了的原因。`null` = 能买。 */
interface Block {
  key: string;
  vars?: Record<string, string | number>;
}

function blockReason(g: GoodDef, game: GameStateManager): Block | null {
  if (g.grant === 'postcard_tier') {
    // 已经有更好的一档：买低档不会把纸面降回去（`buy()` 里是 set 不是取大），
    // 所以这不是"买不了"，是"买了没有意义"——这两句话要分开说。
    if (game.getPostcardTier() >= (g.tier_rank ?? 1)) return { key: 'shop_lower_tier' };
  } else if (g.grant === 'mood_up') {
    // 心神满的时候买清心茶等于白花旅币。`canBuy()` 里真的挡住了这一条
    // （不是只画灰），所以这里也照实说。
    if (game.mood >= ECON.MOOD_CEIL) return { key: 'shop_mood_full' };
  }
  if (game.getItemCount(g.id) >= (g.max_own ?? 1)) return { key: 'shop_maxed' };
  if (g.requires_fragments > game.getCollectedCount()) {
    return { key: 'shop_need_frags', vars: { 0: g.requires_fragments } };
  }
  if (g.price > game.lvbi) return { key: 'shop_need_lvbi' };
  return null;
}

export class ShopPanel {
  readonly root: HTMLDivElement;
  private hooks: UIHooks;
  private game: GameStateManager;

  private shopName = '';
  private titleEl: HTMLDivElement;
  private balEl: HTMLSpanElement;
  private lockEl: HTMLDivElement;
  private grid: HTMLDivElement;
  private cards: Card[] = [];

  constructor(o: ShopOpts) {
    this.hooks = o.hooks;
    this.game = o.game;

    this.root = el('div', 'g-screen g-shop g-hidden');
    const card = el('div', 'g-card g-card-shop');

    const head = el('div', 'g-shop-head');
    this.titleEl = el('div', 'g-group-h');
    head.appendChild(this.titleEl);
    this.balEl = el('span', 'g-shop-bal');
    head.appendChild(this.balEl);
    card.appendChild(head);

    this.lockEl = el('div', 'g-shop-lock');
    card.appendChild(this.lockEl);

    this.grid = el('div', 'g-goods');
    card.appendChild(this.grid);

    const acts = el('div', 'g-acts');
    acts.appendChild(
      button(t('shop_close'), { cls: 'g-btn-major', onClick: () => this.hooks.onShopClose() }),
    );
    card.appendChild(acts);

    this.root.appendChild(card);
    for (const b of this.root.querySelectorAll<HTMLElement>('.g-btn')) {
      wireKeyActivate(b, () => b.click());
    }
    o.parent.appendChild(this.root);
  }

  /** 铺名的中英文口径，与 `SHOPS.TABLE` 一致（英文回退到中文名）。 */
  private displayName(name: string): string {
    const def = SHOPS.TABLE[name];
    if (!def) return name;
    return isEnglish() ? def.name_en || name : name;
  }

  /** 铺子还没亮（`seen_unlock` 没到）时的状态。灯铺要过 6 站。 */
  private get locked(): boolean {
    const need = this.game.shopUnlockSeen(this.shopName);
    return need > 0 && this.game.getSeenStationCount() < need;
  }

  /** 开。`shopName` 来自 `world.nearby.shopName`。 */
  open(shopName: string): void {
    this.shopName = shopName;
    setShown(this.root, true);
    this.build();
    this.refresh();
    const first = this.grid.querySelector<HTMLElement>('.g-btn:not([disabled])');
    if (first) first.focus();
  }

  close(): void {
    setShown(this.root, false);
    this.shopName = '';
    this.cards = [];
  }

  get isOpen(): boolean {
    return this.shopName !== '';
  }

  /**
   * 铺子没亮的时候也把面板开出来，但只给一句话。
   * 直接不开更省事，可那样玩家按了空格没反应，
   * 而他并不知道那座铺子此刻还没开张。
   */
  private build(): void {
    this.grid.textContent = '';
    this.cards = [];
    setText(this.titleEl, this.displayName(this.shopName));

    if (this.locked) {
      setText(this.lockEl, t('shop_locked', { 0: this.game.shopUnlockSeen(this.shopName) }));
      setShown(this.lockEl, true);
      return;
    }
    setShown(this.lockEl, false);

    for (const g of this.game.goodsForShop(this.shopName)) {
      this.grid.appendChild(this.buildCard(g));
    }
    for (const f of SHOPS.NOT_FOR_SALE) {
      this.grid.appendChild(this.buildPriceless(f));
    }
  }

  private buildCard(g: GoodDef): HTMLElement {
    const box = el('div', 'g-good');
    const head = el('div', 'g-good-h');
    head.appendChild(el('span', 'g-good-n', isEnglish() ? g.name_en || g.name : g.name));
    const price = el('span', 'g-good-p', t('shop_buy', { 0: g.price }));
    head.appendChild(price);
    box.appendChild(head);
    box.appendChild(el('div', 'g-good-d', isEnglish() ? g.desc_en || g.desc : g.desc));

    const btn = button(t('shop_buy_one'), {
      cls: 'g-good-b',
      onClick: () => this.hooks.onShopBuy(g.id),
    });
    box.appendChild(btn);

    this.cards.push({ good: g, price, btn });
    return box;
  }

  private buildPriceless(frag: string): HTMLElement {
    const box = el('div', 'g-good is-nfs');
    const head = el('div', 'g-good-h');
    head.appendChild(el('span', 'g-good-n', t(`fragment_${NOT_FOR_SALE_SLOT[frag] ?? 0}`)));
    head.appendChild(el('span', 'g-good-p', t('shop_nfs_title')));
    box.appendChild(head);
    box.appendChild(el('div', 'g-good-d', t('shop_nfs_hint')));
    // 不可买就不放按钮：放一颗灰按钮在那里，玩家会去按它，
    // 然后得到一句「买不了」。不存在的按钮不产生这种期待。
    return box;
  }

  /** 从 game 重新读价格与可否购买。买完东西、读档、切语言之后调。 */
  refresh(): void {
    if (!this.isOpen) return;
    setText(this.balEl, t('shop_balance', { 0: this.game.lvbi }));
    if (this.locked) {
      setText(this.lockEl, t('shop_locked', { 0: this.game.shopUnlockSeen(this.shopName) }));
      setShown(this.lockEl, true);
      return;
    }
    for (const c of this.cards) {
      const block = blockReason(c.good, this.game);
      // 价格**始终**显示：买不了的时候藏掉价格，玩家会以为这东西没有价，
      // 而「无价」在这个游戏里是一个有特定含义的词（`shop_nfs_title`）。
      setText(c.price, t('shop_buy', { 0: c.good.price }));
      if (block) {
        setDisabled(c.btn, true);
        setFlag(c.btn, 'is-blocked', true);
        setText(c.btn, t(block.key, block.vars));
      } else {
        setDisabled(c.btn, false);
        setFlag(c.btn, 'is-blocked', false);
        setText(c.btn, t('shop_buy_one'));
      }
    }
  }

  /** 切语言。整块重建：这一屏玩家只待十几秒，不在 update 路径上。 */
  sync(): void {
    if (!this.isOpen) return;
    this.build();
    this.refresh();
  }

  dispose(): void {
    this.root.remove();
  }
}
