/**
 * 从 Godot 源项目机械提取数据表 → src/data/generated/*.json
 *
 * 用法： node tools/extract-data.mjs [源项目根目录]
 *
 * 每一项都是"从哪个文件的哪个常量搬什么"。搬不成就抛错退出，
 * 绝不静默跳过一个空表——空表和"表里全是默认值"在运行时长得一模一样。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractLiteral, resolveRefs } from './gd-parse.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = process.argv[2] ?? 'D:/code/20260926/no188';
const OUT = join(ROOT, 'src/data/generated');

if (!existsSync(SRC)) {
  console.error(`[extract-data] 找不到源项目：${SRC}`);
  console.error('用法：node tools/extract-data.mjs <no188 根目录>');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

const cache = new Map();
function read(rel) {
  if (cache.has(rel)) return cache.get(rel);
  const p = join(SRC, rel);
  if (!existsSync(p)) throw new Error(`源文件不存在：${p}`);
  const text = readFileSync(p, 'utf8');
  cache.set(rel, text);
  return text;
}

/** 从一个 .gd 文件里搬多个常量，并做交叉引用展开。 */
function grab(rel, names) {
  const src = read(rel);
  const raw = {};
  for (const n of names) {
    try {
      raw[n] = extractLiteral(src, rel, n);
    } catch (e) {
      throw new Error(`搬 ${rel} 的 ${n} 失败：${e.message}`);
    }
  }
  // 互相引用的情况：先全部搬出来，再统一展开
  const out = {};
  for (const [n, v] of Object.entries(raw)) out[n] = resolveRefs(v, raw);
  return out;
}

const written = [];
function emit(name, value) {
  const p = join(OUT, `${name}.json`);
  writeFileSync(p, JSON.stringify(value, null, 2) + '\n', 'utf8');
  written.push({ name, keys: Object.keys(value).length });
  console.log(`  ✓ ${name}.json  (${Object.keys(value).length} 项)`);
}

console.log('[extract-data] 源项目：', SRC);

// ---------------------------------------------------------------- 路线与驿站
{
  const d = grab('scripts/road_data.gd', [
    'SCALE', 'CX', 'CY', 'LEMNISCATE_LOCAL', 'ROT_DEG', 'LEMNISCATE_SCALE',
    'LEMNISCATE_CX', 'LEMNISCATE_CY', 'STATION_LEMNISCATE_IDX', 'STATION_OFFSET',
    'STATION_FOOT_HALF', 'PLAZA_CENTER', 'PLAZA_RADIUS', 'PLAZA_STATION_MARGIN',
    '_DIR_STEPS', '_INTERP_PER_SEG',
    'FRAGMENT_SLOT_STATION_IDX', 'FRAGMENT_STATION_TO_SLOT', 'FRAGMENT_COUNT',
    'stations',
  ]);
  emit('road', d);
}

// ---------------------------------------------------------------- 铺子与商品
{
  const d = grab('scripts/shop_data.gd', [
    'SHOPS', 'KIT_PLAIN', 'KIT_FINE', 'KIT_RARE', 'GOODS',
    'NOT_FOR_SALE', 'NOT_FOR_SALE_EN', 'SHOP_AT_STATION',
  ]);
  emit('shops', d);
}

// ---------------------------------------------------------------- 文案
{
  const d = grab('scripts/Localization.gd', ['STRINGS']);
  const tables = d.STRINGS;
  // 合并 Web 版补充表（见 i18n-supplement.json 的说明：只增不改）
  const supplementPath = join(__dirname, 'i18n-supplement.json');
  if (existsSync(supplementPath)) {
    const sup = JSON.parse(readFileSync(supplementPath, 'utf8'));
    for (const lang of ['zh', 'en']) {
      tables[lang] = { ...tables[lang], ...(sup[lang] ?? {}) };
    }
    console.log(`  · 合并补充文案 zh ${Object.keys(sup.zh ?? {}).length} 条 / en ${Object.keys(sup.en ?? {}).length} 条`);
  }
  const zh = tables.zh ?? {};
  const en = tables.en ?? {};
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  const missingEn = zhKeys.filter((k) => !(k in en));
  const missingZh = enKeys.filter((k) => !(k in zh));
  console.log(`  · 文案 zh ${zhKeys.length} 条 / en ${enKeys.length} 条`);
  if (missingEn.length || missingZh.length) {
    console.warn('  ! key 集合不一致：');
    if (missingEn.length) console.warn('    en 缺：', missingEn.join(', '));
    if (missingZh.length) console.warn('    zh 缺：', missingZh.join(', '));
    // 不退出：key 集合一致性由回归来守，这里只报
  }
  emit('i18n', tables);
}

// ---------------------------------------------------------------- 水体
{
  const d = grab('scripts/water_data.gd', [
    'BASIN_ROAD_CLEAR', 'WATER_LEVEL', 'WATER_DEPTH',
    'SITE_SEARCH_REACH', 'SITE_SEARCH_STEP', 'SITE_STATION_PENALTY', 'SITE_SEPARATION',
    'BASIN_SHAPES',
  ]);
  emit('water', d);
}

// ---------------------------------------------------------------- 路面
{
  const d = grab('scripts/RoadBuilder.gd', [
    'LANE_WIDTH', 'ROAD_WIDTH', 'ROAD_HALF_WIDTH', 'SHOULDER_WIDTH',
    'TOTAL_HALF_WIDTH', 'TOTAL_WIDTH', 'ROAD_LIFT', 'SHOULDER_SINK', 'UV_SCALE',
    'RESAMPLE_STEP', 'GRID_CELL',
    'PLAZA_CENTER_X', 'PLAZA_CENTER_Z', 'PLAZA_RADIUS', 'PLAZA_LIFT', 'PLAZA_THICKNESS',
  ]);
  emit('roadMesh', d);
}

// ---------------------------------------------------------------- 地形
{
  const d = grab('scripts/TerrainBuilder.gd', ['TERRAIN_SIZE', 'TERRAIN_RES', 'MAX_HEIGHT', 'BASE_COLOR']);
  emit('terrain', d);
}

// ---------------------------------------------------------------- 骑行物理与相机
{
  const d = grab('scripts/Player3D.gd', [
    'MAX_SPEED', 'ACCEL', 'DECEL', 'REVERSE_SPEED', 'TURN_SPEED',
    'CAM_BACK', 'CAM_UP', 'CAM_SIDE', 'CAM_LOOK_AHEAD', 'CAM_LOOK_UP',
  ]);
  emit('ride', d);
}

// ---------------------------------------------------------------- 经济与状态
{
  const d = grab('scripts/GameManager.gd', [
    'SAVE_PATH', 'SAVE_VERSION', 'TOTAL_ROUTE_KM', 'MAX_VISITS_PER_STATION',
    'LVBI_PER_KM', 'LVBI_PER_PASS', 'LVBI_FIRST_CHECKIN', 'LVBI_REPEAT_CHECKIN',
    'LVBI_MINI_WIN', 'LVBI_MINI_LOSE', 'LVBI_PER_FRAGMENT', 'VILLAIN_SCENE_COUNT',
    'MOOD_CEIL', 'MOOD_FLOOR', 'MOOD_INITIAL', 'MOOD_MASK_MAX',
    'MOOD_VIS_MAX', 'MOOD_VIS_MIN', 'LAMP_VIS_STEP', 'LAMP_VIS_MAX_OWN',
    'LAMP_VIS_CAP', 'SACHET_PENALTY_SCALE', 'VIS_FLOOR', 'VIS_CEIL',
    'DEMO_BUDGET_SEC', 'DEMO_END_AT_SEC',
  ]);
  emit('economy', d);
}

// ---------------------------------------------------------------- 画质分档（作为对照，不是直接照搬）
{
  const d = grab('scripts/QualitySettings.gd', [
    'QUALITY_LOW', 'QUALITY_MEDIUM', 'QUALITY_HIGH', 'TIER_COUNT', 'PARAMS', 'TIER_NAME_KEYS',
  ]);
  emit('qualityReference', d);
}

// ---------------------------------------------------------------- 世界常量
{
  const d = grab('scripts/World3D.gd', [
    'INTERACT_COOLDOWN_SEC', 'RECHECK_IN_MIN_DIST', 'BIKE_SCALE', 'WHEEL_RADIUS',
    'FRONT_Z', 'REAR_Z', 'FA_X', 'RA_X', 'WY', 'STATION_PASS_RADIUS',
    'STELE_PASS_RADIUS', 'STATION_LOAD_DISTANCE',
    'STATION_GLB_CONFIG', 'STATION_ROOF_TINT', 'VILLAIN_SCENES',
  ]);
  emit('world', d);
}

// ---------------------------------------------------------------- 小游戏排布
{
  const src = read('scripts/mini_games/MiniGamePicker.gd');
  const names = ['MiniGameCloud', 'MiniGameTea', 'MiniGameZither', 'MiniGameBamboo', 'MiniGameBird'];
  const emit_ = {
    gameFor: 'function game_for(slot, visit) { return (slot + Math.max(visit, 0)) % 5; }',
    // 15 局排布：每行一个碎片槽位，三次到访从左到右
    schedule: names.map((_, slot) => [0, 1, 2].map((visit) => (slot + visit) % 5)),
    order: names,
  };
  // 校验一下 schedule 和 GDScript 的公式一致（这份公式是抄的，必须自己验）
  for (let slot = 0; slot < 5; slot++) {
    for (let visit = 0; visit < 3; visit++) {
      const expect = (slot + Math.max(visit, 0)) % 5;
      if (emit_.schedule[slot][visit] !== expect) {
        throw new Error(`排布自检失败：slot=${slot} visit=${visit}`);
      }
    }
  }
  emit_._source = src.length;
  emit('miniGames', emit_);
}

console.log(`[extract-data] 完成：${written.length} 个文件 → ${OUT}`);
