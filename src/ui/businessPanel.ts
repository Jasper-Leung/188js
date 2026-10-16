import { BUSINESSES, BUSINESS_RULES as R, businessAt, type BusinessDef } from '../data/business';
import { businessBlock, orderReward, type BusinessAction } from '../game/business';
import type { GameStateManager } from '../game/state';
import { t, stationNameOf } from '../i18n';
import { STATIONS } from '../data/route';
import { button, el, setShown, setText } from './dom';
import { STATION_REACH } from '../game/phase';

export class BusinessPanel {
  readonly root: HTMLDivElement;
  private entry: HTMLButtonElement;
  private content: HTMLDivElement;
  private status: HTMLDivElement;
  private feedback: HTMLDivElement;
  private controls: { button: HTMLButtonElement; action: BusinessAction }[] = [];
  private site: BusinessDef | null = null;
  private nearby = -1;
  private stamp = 0;
  private hour = 8;
  constructor(parent: HTMLElement, private game: GameStateManager, private hooks: { open(): void; close(): void; qin(mode: 'game' | 'free'): void }) {
    this.entry = button(t('biz_open'), { cls: 'g-business-entry g-hidden', onClick: () => this.open(this.nearby) });
    (parent.querySelector<HTMLElement>('.g-frags-h') ?? parent).appendChild(this.entry);
    this.root = el('div', 'g-screen g-business g-hidden');
    this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-modal', 'true'); this.root.setAttribute('aria-label', t('biz_title'));
    this.content = el('div', 'g-card g-business-card');
    this.status = el('div', 'g-business-status'); this.feedback = el('div', 'g-note');
    this.root.appendChild(this.content); parent.appendChild(this.root);
    this.root.addEventListener('keydown', e => {
      if (e.code !== 'Tab') return;
      const items = Array.from(this.root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); items[items.length - 1]?.focus(); }
      else if (!e.shiftKey && i === items.length - 1) { e.preventDefault(); items[0]?.focus(); }
    });
  }
  get isOpen(): boolean { return this.site !== null; }
  hideEntry(): void { setShown(this.entry, false); }
  open(station: number): void {
    const b = businessAt(station); if (!b) return;
    this.root.setAttribute('aria-label', t('biz_title'));
    this.site = b; this.hooks.open(); setShown(this.root, true); setShown(this.entry, false);
    this.content.replaceChildren(); this.controls = [];
    this.content.appendChild(el('h2', '', stationNameOf(STATIONS[station].def)));
    this.content.appendChild(el('p', 'g-note', t('biz_motive')));
    if (b.id === 'music') {
      const choices = el('div', 'g-acts');
      choices.appendChild(button(t('qin_option_game'), { onClick: () => this.startQin('game') }));
      choices.appendChild(button(t('qin_option_free'), { onClick: () => this.startQin('free') }));
      this.content.appendChild(choices);
      this.content.appendChild(el('p', 'g-note', t('qin_options_hint')));
    }
    this.content.appendChild(el('h3', '', t(b.nameKey)));
    this.content.appendChild(this.status);
    const actions = el('div', 'g-business-actions');
    for (const action of ['gather', 'craft', 'accept', 'deliver', 'cancel', 'upgrade'] as const) {
      const btn = button(t(`biz_action_${action}`), { onClick: () => {
        const result = this.game.businessAct(b.id, action);
        this.feedback.textContent = result.story ? t(`biz_story_${result.story}`) : t(result.reason);
        this.refresh();
      } });
      actions.appendChild(btn); this.controls.push({ button: btn, action });
    }
    this.content.appendChild(actions);
    this.feedback.textContent = t(`biz_story_${Math.max(0, this.game.business.chapter)}`);
    this.content.appendChild(this.feedback);
    this.content.appendChild(el('p', 'g-note', t('biz_network', { sites: BUSINESSES.map(d => `${stationNameOf(STATIONS[d.station].def)} (${d.unlock})`).join(' · ') })));
    this.content.appendChild(button(t('biz_close'), { cls: 'g-btn-major', onClick: () => this.close() }));
    const story = this.game.claimBusinessChapter();
    if (story) this.feedback.textContent = t(`biz_story_${story}`);
    this.refresh(); this.root.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }
  close(): void {
    if (!this.site) return;
    this.game.save();
    this.site = null; setShown(this.root, false); this.hooks.close(); this.entry.focus();
  }
  private startQin(mode: 'game' | 'free'): void { this.close(); this.hooks.qin(mode); }
  update(dt: number, canOpen: boolean, nearby: { index: number; distance: number }, hour: number): void {
    this.hour = hour; this.nearby = nearby.index;
    const b = businessAt(nearby.index);
    setShown(this.entry, canOpen && !!b && nearby.distance <= STATION_REACH && !this.isOpen);
    setText(this.entry, t(b?.id === 'music' ? 'qin_options_open' : 'biz_open'));
    this.stamp += dt;
    if (this.isOpen && this.stamp > 0.2) { this.stamp = 0; this.refresh(); }
  }
  private refresh(): void {
    const b = this.site; if (!b) return;
    const v = this.game.business.sites[b.id];
    const next = R.upgradeCosts[v.level - 1];
    const goal = R.chapters[this.game.business.chapter];
    setText(this.status, [
      t('biz_stats', { coins: this.game.lvbi, reputation: this.game.business.reputation, level: v.level }),
      `${t(b.rawKey)}: ${v.raw} · ${t(b.productKey)}: ${v.goods}`,
      t('biz_recipe', { raw: t(b.rawKey), cost: R.craftCost, product: t(b.productKey), amount: v.level }),
      t('biz_order', { customer: t(b.customerKey), shift: t(this.hour < 6 || this.hour >= 18 ? 'biz_night' : 'biz_day'), reward: v.order?.reward ?? orderReward(b, v.level), seconds: Math.ceil(v.order?.remaining ?? b.seconds) }),
      t('biz_progress', { done: this.game.business.completed, need: b.unlock, next: next ?? '—', cooldown: Math.ceil(v.cooldown) }),
      t('biz_goal', { chapter: this.game.business.chapter, total: R.chapters.length }),
      goal ? t('biz_next_goal', { orders: goal.orders, reputation: goal.reputation, sites: goal.sites, upgrades: goal.upgrades }) : '',
      this.game.business.chapter === 3 && !this.game.chapter1Done ? t('biz_main_story') : '',
    ].filter(Boolean).join('\n'));
    for (const c of this.controls) {
      const reason = businessBlock(this.game.business, b, c.action, this.game.lvbi);
      c.button.disabled = !!reason;
      setText(c.button, `${t(`biz_action_${c.action}`)}${reason ? ` · ${t(reason)}` : ''}`);
    }
  }
}
