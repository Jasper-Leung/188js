/** 经营数值的唯一配置；站号与 data/route 的实际建筑对应。 */
export interface BusinessDef { id: string; station: number; nameKey: string; rawKey: string; productKey: string; customerKey: string; unlock: number; price: number; seconds: number }
export const BUSINESSES: readonly BusinessDef[] = [
  { id: 'provisions', station: 0, nameKey: 'biz_provisions', rawKey: 'biz_supply', productKey: 'biz_meal', customerKey: 'biz_rider', unlock: 0, price: 12, seconds: 12 },
  { id: 'tea', station: 2, nameKey: 'biz_tea', rawKey: 'biz_leaf', productKey: 'biz_cup', customerKey: 'biz_walker', unlock: 0, price: 14, seconds: 14 },
  { id: 'lantern', station: 8, nameKey: 'biz_lantern', rawKey: 'biz_wick', productKey: 'biz_light', customerKey: 'biz_keeper', unlock: 6, price: 20, seconds: 18 },
  { id: 'pastry', station: 10, nameKey: 'biz_pastry', rawKey: 'biz_leaf', productKey: 'biz_cake', customerKey: 'biz_farmer', unlock: 4, price: 16, seconds: 14 },
  { id: 'music', station: 13, nameKey: 'biz_music', rawKey: 'biz_score', productKey: 'biz_seat', customerKey: 'biz_listener', unlock: 8, price: 22, seconds: 20 },
  { id: 'bamboo', station: 14, nameKey: 'biz_bamboo', rawKey: 'biz_cane', productKey: 'biz_basket', customerKey: 'biz_neighbor', unlock: 4, price: 18, seconds: 16 },
  { id: 'lake', station: 4, nameKey: 'biz_lake', rawKey: 'biz_herb', productKey: 'biz_packet', customerKey: 'biz_boater', unlock: 6, price: 18, seconds: 16 },
];
export const BUSINESS_RULES = {
  gatherAmount: 3, gatherCooldown: 8, craftCost: 2, storageCap: 24, reputationPerOrder: 2,
  upgradeCosts: [24, 48], upgradeReputation: [2, 8], pricePerLevel: 0.25,
  chapters: [{ orders: 1, reputation: 2, sites: 1, upgrades: 0 }, { orders: 3, reputation: 6, sites: 1, upgrades: 0 }, { orders: 6, reputation: 12, sites: 3, upgrades: 1 }, { orders: 10, reputation: 20, sites: 3, upgrades: 2 }],
} as const;
export const businessAt = (station: number) => BUSINESSES.find(b => b.station === station);
