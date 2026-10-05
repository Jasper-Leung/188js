/**
 * 文案 —— 中英双语，两侧集合严格一致。
 *
 * key 集合一致性由 `npm run verify` 里的 `verify_i18n` 守着。
 * 这条断言是从源项目搬来的，而且它挡过真东西：曾经有一个
 * `"progress": "已行 %dkm / 188km"` 只存在于中文表里，被一条"看起来齐全"
 * 的扫描放过了——而它是全表里唯一真带着里程的一句，玩家一眼就能算出
 * 7200km/h 然后整个数字连同它承载的解锁门一起失去可信度。
 *
 * 格式化用 `printf` 风格（%d / %s），和源项目一致，替换规则也一致：
 * 命名参数优先，位置参数兜底。
 *
 * ## 默认语言是英语（`DEFAULT_LANG`）
 *
 * 原来是"按 `navigator.language` 猜一次"。看着更贴心，实际有害：
 * 中文机器上默认中文，于是**任何一处漏翻的中文都不会被发现**——
 * 开发的人看自己那一份，永远是对的；玩家拿到英文版才发现。
 * 而漏翻恰恰是这类项目最容易出的错（界面上的一句硬编码、
 * 数据里的一个 `def.name`、启动屏骨架里的一行静态字）。
 *
 * 改成固定英语之后，本地化成了**默认会被看见的那一种**：
 * 每一句没翻的地方都会当场露出来，而不是等到发版。
 * 中文玩家点一次标题页上的语言按钮就好，代价是一次点击。
 */
import { I18N, type Lang, type StationDef } from '../data/raw';

export type { Lang };

/**
 * 首次访问用的语言。
 *
 * 刻意**不**读 `navigator.language`——理由见文件头。
 * 想要"按系统语言"的玩家，存一次选择即可（`setLang()` 会落盘）。
 */
export const DEFAULT_LANG: Lang = 'en';

let current: Lang = DEFAULT_LANG;
const listeners = new Set<(lang: Lang) => void>();

const STORAGE_KEY = 'gift188.lang';

export function initLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') {
      current = saved;
      return current;
    }
  } catch {
    /* 忽略 */
  }
  current = DEFAULT_LANG;
  return current;
}

export function getLang(): Lang {
  return current;
}

export function isEnglish(): boolean {
  return current === 'en';
}

/**
 * 按当前语言在两份**数据**之间选一份。
 *
 * 存在的理由是 `isEnglish() ? a_en : a_zh` 这个写法在十几处里迟早写反一次，
 * 而写反的症状是"英文界面里出现一个中文词"——和漏翻长得很像，
 * 排查时不会先怀疑它。参数顺序固定成 `(中文, 英文)`，
 * 调用处一眼能看出哪边是哪边。
 *
 * 它只处理**数据自带双语**的字段（站名、商品名……）。
 * 面向玩家的字面文案一律走 `t()`：那张表才是能加断言守的地方。
 */
export function byLang<T>(zh: T, en: T): T {
  return current === 'en' ? en : zh;
}

/**
 * 站名。英文侧缺失时回退到中文名，与 Godot 的
 * `RoadData.station_display_name()` 同一套口径。
 *
 * 之前这个函数住在 `ui/hud.ts`，于是 `world.ts`（对白框的说话人、
 * 故事卡的抬头）拿不到，只能直接写 `def.name` —— 英文界面里
 * 对白框上方永远挂着中文站名，而 HUD 顶栏是英文，同一个站名两种写法。
 */
export function stationNameOf(def: StationDef): string {
  return byLang(def.name, def.name_en || def.name);
}

export function setLang(lang: Lang) {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* 忽略 */
  }
  listeners.forEach((fn) => fn(lang));
}

export function onLangChange(fn: (lang: Lang) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 取文案并做 printf 替换。
 * 缺失的 key 返回 `⟨key⟩` 而不是空串——空串会让一个漏翻的文案
 * 在界面上变成一块空白，而 `⟨hero_start⟩` 一眼就能看出是哪个 key 掉了。
 *
 * `vars` 收两种形态：命名对象 `{name}`，或者**按出现顺序**的数组。
 * 数组这一支是给"参数在别处攒出来"的地方用的——比如档位判定理由
 * `cap_reason_memory: '设备内存 %dGB'`，参数在 `decideTier()` 里本来就该是一个
 * 数组，硬包成 `{0: x}` 只会让人以为那是命名参数。
 */
export function t(key: string, vars?: Record<string, string | number> | (string | number)[]): string {
  const table = I18N[current] ?? I18N.zh;
  let s = table[key];
  if (s === undefined) {
    const fb = I18N.zh[key];
    s = fb === undefined ? `⟨${key}⟩` : fb;
  }
  if (!vars) return s;

  const named = Array.isArray(vars) ? null : vars;
  // 命名参数 {name}
  if (named) s = s.replace(/\{(\w+)\}/g, (m, name: string) => (name in named ? String(named[name]) : m));
  // 位置参数 %s %d %f（含 %.1f / %.0f 精度）与 %% 转义 —— 按出现顺序消费。
  // `%%` 必须写在分支最前面：`%d%%` 这类串里，先吃到 `%d` 剩下的 `%%`
  // 才能被认成转义符，而不是被当成"一个 % 加一个残缺占位符"原样留在界面上。
  // 少了精度分支，茶的 `%.1f` 和琴的 `%.0f` 会一字不差地显示成 "%.1f"。
  let i = 0;
  const ordered = Array.isArray(vars) ? vars : Object.values(vars);
  s = s.replace(/%%|%(\.\d+)?[sdf]/g, (m, prec: string | undefined) => {
    if (m === '%%') return '%';
    const v = i < ordered.length ? ordered[i++] : undefined;
    if (v === undefined) return '';
    if (!prec) return String(v);
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return String(v);
    return n.toFixed(Number(prec.slice(1)));
  });
  return s;
}

/** 当前语言表里不存在的 key（回归用） */
export function missingKeys(): { zh: string[]; en: string[] } {
  const zhKeys = Object.keys(I18N.zh);
  const enKeys = Object.keys(I18N.en);
  return {
    zh: enKeys.filter((k) => !(k in I18N.zh)),
    en: zhKeys.filter((k) => !(k in I18N.en)),
  };
}

export const LANGS: Lang[] = ['zh', 'en'];
