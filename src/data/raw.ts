/**
 * 原始数据（从 GDScript 机械提取，见 tools/extract-data.mjs）
 *
 * 这一层只做一件事：把 JSON 里那些提取器留下的标记（__v2 / __color）
 * 拆成正经的 TS 类型。**不加工、不补默认值、不"顺手改好"**——
 * 上游是 Godot 源项目，改这里的值等于改了原作。
 */
import roadJson from './generated/road.json';
import roadMeshJson from './generated/roadMesh.json';
import terrainJson from './generated/terrain.json';
import shopsJson from './generated/shops.json';
import waterJson from './generated/water.json';
import rideJson from './generated/ride.json';
import economyJson from './generated/economy.json';
import worldJson from './generated/world.json';
import miniGamesJson from './generated/miniGames.json';
import i18nJson from './generated/i18n.json';
import qualityRefJson from './generated/qualityReference.json';

export interface V2 {
  x: number;
  y: number;
}

export type RGBA = [number, number, number, number];

export interface StationDef {
  name: string;
  name_en: string;
  event: string;
  event_en: string;
  fragment: string;
  fragment_en: string;
  color: RGBA;
  /** 画布空间位置（未经横向偏移），小地图与语义位置用它 */
  canvas: V2;
  /** 沿路面法线推到路肩外的偏移（世界单位，米） */
  off: V2;
  /** 只有三间铺子所属的驿站有 */
  shop?: string;
  text: string;
  text_en: string;
  /** 只有五座碎片驿站有；首访对白 */
  dialogue?: string[];
  dialogue_en?: string[];
  model_idx: number;
}

export interface GoodDef {
  id: string;
  name: string;
  name_en: string;
  price: number;
  sell_at: string;
  requires_fragments: number;
  grant: string;
  desc: string;
  desc_en: string;
  /** 套餐档位 1..3 */
  tier_rank?: number;
  /** 可叠数量 */
  max_own?: number;
  /** 视野加成的封顶比例 */
  cap?: number;
  /** mood_up 商品每次回几格 */
  mood_up?: number;
}

export interface ShopDef {
  name_en: string;
  station_idx: number;
  seen_unlock: number;
}

export interface BasinShape {
  station: number;
  radius: number;
  squash: number;
  depth: number;
}

export interface StationGlbConfig {
  path: string;
  scale: number;
  label_y: number;
  glow_y: number;
  glow_range: number;
  rot_y?: number;
}

export interface VillainScene {
  seen: number;
  parts: { speaker: string; lines: string[] }[];
}

export type Lang = 'zh' | 'en';

// ---------------------------------------------------------------- 路线 / 驿站
const v2 = (a: { __v2: number[] } | { __color: number[] }): V2 => {
  if ('__v2' in a) return { x: a.__v2[0], y: a.__v2[1] };
  throw new Error('期望 __v2');
};
const col = (a: { __v2: number[] } | { __color: number[] }): RGBA => {
  if ('__color' in a) return [a.__color[0], a.__color[1], a.__color[2], a.__color[3]];
  throw new Error('期望 __color');
};

export const ROAD = {
  SCALE: roadJson.SCALE,
  CX: roadJson.CX,
  CY: roadJson.CY,
  ROT_DEG: roadJson.ROT_DEG,
  LEMNISCATE_SCALE: roadJson.LEMNISCATE_SCALE,
  LEMNISCATE_CX: roadJson.LEMNISCATE_CX,
  LEMNISCATE_CY: roadJson.LEMNISCATE_CY,
  LEMNISCATE_LOCAL: (roadJson.LEMNISCATE_LOCAL as { __v2: number[] }[]).map(v2),
  STATION_LEMNISCATE_IDX: roadJson.STATION_LEMNISCATE_IDX as number[],
  STATION_OFFSET: roadJson.STATION_OFFSET,
  STATION_FOOT_HALF: roadJson.STATION_FOOT_HALF,
  PLAZA_CENTER: v2(roadJson.PLAZA_CENTER),
  PLAZA_RADIUS: roadJson.PLAZA_RADIUS,
  PLAZA_STATION_MARGIN: roadJson.PLAZA_STATION_MARGIN,
  DIR_STEPS: roadJson._DIR_STEPS,
  INTERP_PER_SEG: roadJson._INTERP_PER_SEG,
  FRAGMENT_SLOT_STATION_IDX: roadJson.FRAGMENT_SLOT_STATION_IDX as number[],
  FRAGMENT_STATION_TO_SLOT: roadJson.FRAGMENT_STATION_TO_SLOT as Record<string, number>,
  FRAGMENT_COUNT: roadJson.FRAGMENT_COUNT,
  STATIONS: (roadJson.stations as (Omit<StationDef, 'canvas' | 'off' | 'color'> & {
    canvas: { __v2: number[] };
    off: { __v2: number[] };
    color: { __color: number[] };
  })[]).map((s) => ({
    ...s,
    canvas: v2(s.canvas),
    off: v2(s.off),
    color: col(s.color),
  })) as StationDef[],
};

// ---------------------------------------------------------------- 路面
export const ROADMESH = roadMeshJson as {
  LANE_WIDTH: number;
  ROAD_WIDTH: number;
  ROAD_HALF_WIDTH: number;
  SHOULDER_WIDTH: number;
  TOTAL_HALF_WIDTH: number;
  TOTAL_WIDTH: number;
  ROAD_LIFT: number;
  SHOULDER_SINK: number;
  UV_SCALE: number;
  RESAMPLE_STEP: number;
  GRID_CELL: number;
  PLAZA_CENTER_X: number;
  PLAZA_CENTER_Z: number;
  PLAZA_RADIUS: number;
  PLAZA_LIFT: number;
  PLAZA_THICKNESS: number;
};

// ---------------------------------------------------------------- 地形
export const TERRAIN = {
  SIZE: terrainJson.TERRAIN_SIZE,
  RES: terrainJson.TERRAIN_RES,
  MAX_HEIGHT: terrainJson.MAX_HEIGHT,
  BASE_COLOR: col(terrainJson.BASE_COLOR),
};

// ---------------------------------------------------------------- 骑行
export const RIDE = rideJson as {
  MAX_SPEED: number;
  ACCEL: number;
  DECEL: number;
  REVERSE_SPEED: number;
  TURN_SPEED: number;
  CAM_BACK: number;
  CAM_UP: number;
  CAM_SIDE: number;
  CAM_LOOK_AHEAD: number;
  CAM_LOOK_UP: number;
};

// ---------------------------------------------------------------- 经济
export const ECON = economyJson as {
  SAVE_VERSION: number;
  TOTAL_ROUTE_KM: number;
  MAX_VISITS_PER_STATION: number;
  LVBI_PER_KM: number;
  LVBI_PER_PASS: number;
  LVBI_FIRST_CHECKIN: number;
  LVBI_REPEAT_CHECKIN: number;
  LVBI_MINI_WIN: number;
  LVBI_MINI_LOSE: number;
  LVBI_PER_FRAGMENT: number;
  VILLAIN_SCENE_COUNT: number;
  MOOD_CEIL: number;
  MOOD_FLOOR: number;
  MOOD_INITIAL: number;
  MOOD_MASK_MAX: number;
  MOOD_VIS_MAX: number;
  MOOD_VIS_MIN: number;
  LAMP_VIS_STEP: number;
  LAMP_VIS_MAX_OWN: number;
  LAMP_VIS_CAP: number;
  SACHET_PENALTY_SCALE: number;
  VIS_FLOOR: number;
  VIS_CEIL: number;
  DEMO_BUDGET_SEC: number;
  DEMO_END_AT_SEC: number;
};

// ---------------------------------------------------------------- 铺子
export const SHOPS = {
  TABLE: shopsJson.SHOPS as Record<string, ShopDef>,
  GOODS: shopsJson.GOODS as GoodDef[],
  KIT_PLAIN: shopsJson.KIT_PLAIN,
  KIT_FINE: shopsJson.KIT_FINE,
  KIT_RARE: shopsJson.KIT_RARE,
  NOT_FOR_SALE: shopsJson.NOT_FOR_SALE as string[],
  NOT_FOR_SALE_EN: shopsJson.NOT_FOR_SALE_EN as Record<string, string>,
  SHOP_AT_STATION: shopsJson.SHOP_AT_STATION as Record<string, string>,
};

// ---------------------------------------------------------------- 水体
export const WATER = waterJson as {
  BASIN_ROAD_CLEAR: number;
  WATER_LEVEL: number;
  WATER_DEPTH: number;
  SITE_SEARCH_REACH: number;
  SITE_SEARCH_STEP: number;
  SITE_STATION_PENALTY: number;
  SITE_SEPARATION: number;
  BASIN_SHAPES: BasinShape[];
};

// ---------------------------------------------------------------- 世界常量
export const WORLD = {
  INTERACT_COOLDOWN_SEC: worldJson.INTERACT_COOLDOWN_SEC,
  RECHECK_IN_MIN_DIST: worldJson.RECHECK_IN_MIN_DIST,
  BIKE_SCALE: worldJson.BIKE_SCALE,
  WHEEL_RADIUS: worldJson.WHEEL_RADIUS,
  FRONT_Z: worldJson.FRONT_Z,
  REAR_Z: worldJson.REAR_Z,
  FA_X: worldJson.FA_X,
  RA_X: worldJson.RA_X,
  WY: worldJson.WY,
  STATION_PASS_RADIUS: worldJson.STATION_PASS_RADIUS,
  STELE_PASS_RADIUS: worldJson.STELE_PASS_RADIUS,
  STATION_LOAD_DISTANCE: worldJson.STATION_LOAD_DISTANCE,
  STATION_GLB_CONFIG: worldJson.STATION_GLB_CONFIG as StationGlbConfig[],
  STATION_ROOF_TINT: worldJson.STATION_ROOF_TINT as Record<string, { __color: number[] }>,
  VILLAIN_SCENES: worldJson.VILLAIN_SCENES as VillainScene[],
};

// ---------------------------------------------------------------- 小游戏
export const MINIGAMES = miniGamesJson as {
  gameFor: string;
  schedule: number[][];
  order: string[];
};

// ---------------------------------------------------------------- 文案
export const I18N = i18nJson as Record<Lang, Record<string, string>>;

// ---------------------------------------------------------------- 画质（原作对照）
export const QUALITY_REF = qualityRefJson as {
  QUALITY_LOW: number;
  QUALITY_MEDIUM: number;
  QUALITY_HIGH: number;
  TIER_COUNT: number;
  PARAMS: Record<string, unknown>[];
  TIER_NAME_KEYS: string[];
};
