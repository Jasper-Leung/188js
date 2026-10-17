import { BUSINESSES, BUSINESS_RULES as R, type BusinessDef } from '../data/business';
export interface BusinessSite { raw: number; goods: number; level: number; completed: number; cooldown: number; order: { remaining: number; reward: number } | null }
export interface BusinessState { version: 1; reputation: number; completed: number; chapter: number; sites: Record<string, BusinessSite> }
export type BusinessAction = 'gather' | 'craft' | 'accept' | 'deliver' | 'cancel' | 'upgrade';
export interface BusinessResult { ok: boolean; coins: number; reason: string; story: number }
const int = (v: unknown, max = 100000) => typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : 0;
export function newBusiness(): BusinessState { return { version: 1, reputation: 0, completed: 0, chapter: 0, sites: Object.fromEntries(BUSINESSES.map(b => [b.id, { raw: 0, goods: 0, level: 1, completed: 0, cooldown: 0, order: null }])) }; }
/** 缺字段的 v3 老档原样保留原经济；经营字段只接受已知建筑和有限数。 */
export function readBusiness(raw: unknown): BusinessState {
  const out = newBusiness();
  if (!raw || typeof raw !== 'object') return out;
  const s = raw as Partial<BusinessState>;
  out.reputation = int(s.reputation); out.completed = int(s.completed); out.chapter = int(s.chapter, R.chapters.length);
  for (const b of BUSINESSES) {
    const site = s.sites?.[b.id]; if (!site || typeof site !== 'object') continue;
    const level = Math.max(1, int(site.level, R.upgradeCosts.length + 1));
    out.sites[b.id] = { raw: int(site.raw, R.storageCap), goods: int(site.goods, R.storageCap), level, completed: int(site.completed), cooldown: int(site.cooldown, R.gatherCooldown), order: site.order && typeof site.order === 'object' ? { remaining: int(site.order.remaining, b.seconds), reward: Math.min(int(site.order.reward), orderReward(b, level)) } : null };
  }
  return out;
}
export function orderReward(b: BusinessDef, level: number): number { return Math.round(b.price * (1 + (level - 1) * R.pricePerLevel)); }
export function advanceBusiness(s: BusinessState, dt: number): void {
  if (!Number.isFinite(dt) || dt <= 0) return;
  for (const site of Object.values(s.sites)) { site.cooldown = Math.max(0, site.cooldown - dt); if (site.order) site.order.remaining = Math.max(0, site.order.remaining - dt); }
}
export function businessBlock(s: BusinessState, b: BusinessDef, action: BusinessAction, coins: number): string {
  const v = s.sites[b.id];
  if (s.reputation < b.unlock) return 'biz_locked';
  if (action === 'gather') return v.cooldown > 0 ? 'biz_cooldown' : v.raw + R.gatherAmount > R.storageCap ? 'biz_full' : '';
  if (action === 'craft') return v.raw < R.craftCost ? 'biz_no_raw' : v.goods + v.level + (v.order ? 1 : 0) > R.storageCap ? 'biz_full' : '';
  if (action === 'accept') return v.order ? 'biz_busy' : v.goods < 1 ? 'biz_no_goods' : '';
  if (action === 'cancel') return !v.order ? 'biz_no_order' : '';
  if (action === 'deliver') return !v.order ? 'biz_no_order' : v.order.remaining > 0 ? 'biz_wait' : '';
  if (v.level > R.upgradeCosts.length) return 'biz_max';
  if (s.reputation < R.upgradeReputation[v.level - 1]) return 'biz_need_rep';
  return coins < R.upgradeCosts[v.level - 1] ? 'biz_need_coins' : '';
}
export function claimBusinessStory(s: BusinessState, chapter1Done: boolean): number {
  const r = R.chapters[s.chapter];
  if (!r || (s.chapter === R.chapters.length - 1 && !chapter1Done)) return 0;
  const sites = Object.values(s.sites);
  if (s.completed < r.orders || s.reputation < r.reputation || sites.filter(v => v.completed > 0).length < r.sites || sites.reduce((n, v) => n + v.level - 1, 0) < r.upgrades) return 0;
  return ++s.chapter;
}
export function actBusiness(s: BusinessState, id: string, action: BusinessAction, coins: number, chapter1Done: boolean): BusinessResult {
  const b = BUSINESSES.find(b => b.id === id);
  if (!b || !['gather','craft','accept','deliver','cancel','upgrade'].includes(action)) return { ok: false, coins, reason: 'biz_unavailable', story: 0 };
  const reason = businessBlock(s, b, action, coins);
  if (reason) return { ok: false, coins, reason, story: 0 };
  const v = s.sites[id];
  if (action === 'gather') { v.raw += R.gatherAmount; v.cooldown = R.gatherCooldown; }
  else if (action === 'craft') { v.raw -= R.craftCost; v.goods += v.level; }
  else if (action === 'accept') { v.goods--; v.order = { remaining: b.seconds, reward: orderReward(b, v.level) }; }
  else if (action === 'cancel') { v.goods = Math.min(R.storageCap, v.goods + 1); v.order = null; }
  else if (action === 'deliver') { coins += v.order!.reward; v.order = null; v.completed++; s.completed++; s.reputation += R.reputationPerOrder; }
  else { coins -= R.upgradeCosts[v.level - 1]; v.level++; }
  return { ok: true, coins, reason: 'biz_done', story: claimBusinessStory(s, chapter1Done) };
}
