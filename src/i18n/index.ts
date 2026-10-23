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
 * ## 首次访问按系统语言，之后记住玩家的选择
 *
 * 历史上这里改过三次，每次的理由都值得留着：
 *
 * 1. **按 `navigator.language` 猜一次**（最初）。贴心，但有害：
 *    中文机器上默认中文，于是**任何一处漏翻的中文都不会被发现**——
 *    开发的人看自己那一份，永远是对的；玩家拿到英文版才发现。
 * 2. **固定英语**（第二代）。本地化成了默认会被看见的那一种，
 *    每一句没翻的地方都当场露出来。代价是中文玩家要点一次按钮。
 * 3. **按系统语言 + 存档优先**（现在）。第二代挡漏翻的职责并没有丢，
 *    它被上面两条判据接手了：`npm run verify` 的 `verify_i18n` 查
 *    **中英键集严格一致** + **英文表里一个汉字都不许有**。漏翻在两种
 *    默认语言下都会红，于是"按系统语言"不再有代价——而中文玩家
 *    第一次进来自动就是中文，不用先点一次按钮。
 *
 * 优先级只有一条：**localStorage 里存过的选择 > 系统语言 > 'en'**。
 * 存过的永远赢——玩家在标题页或暂停面板切过一次，那份选择就要一直算数，
 * 哪怕他随后把系统语言改成了别的。
 */
import { I18N, type Lang, type StationDef } from '../data/raw';

export type { Lang };

/**
 * 最后兜底的语言：系统语言也读不到时（无头回归、隐私模式空串）用它。
 *
 * 它是**回退**而不是默认——正常路径上首次访问走 `systemLang()`。
 * 选 'en' 的两个理由：英文是源文案的基准侧（`I18N.zh` 缺键时回退的
 * 也是它），而一个汉字都不认识的玩家比看不懂英文的玩家更少见。
 */
export const DEFAULT_LANG: Lang = 'en';

let current: Lang = DEFAULT_LANG;
const listeners = new Set<(lang: Lang) => void>();

/**
 * 存档的键。导出是为了回归能直接读写它——
 * 测试里用 `setLang()` 造假存档是靠不住的：`setLang` 在语言没变时
 * 会早退，**根本不落盘**（无头回归里上一个检查可能正好留着同一个语言）。
 */
export const STORAGE_KEY = 'gift188.lang';

/**
 * 把一条 BCP-47 语言标签映射到支持的语言。
 *
 * 纯函数，不碰任何全局——回归里直接拿各种标签喂它（见 `verify_i18n`）。
 * 规则只有一条：`zh` 开头（`zh` / `zh-CN` / `zh-Hans` / `zh-Hant`）→ 中文，
 * 其余一律英文。**不做更细的映射**：全部文案只有两份，
 * 而 `zh-Hant` 与 `zh-Hans` 共用一份中文表（要繁简转换是另一个项目）。
 *
 * 大小写不敏感（`ZH-cn` 也是中文），前后空白要容忍——某些安卓 WebView
 * 报上来的 `navigator.language` 是带空格的。
 */
export function langOf(tag: string): Lang {
  return /^zh/i.test(tag.trim()) ? 'zh' : 'en';
}

/**
 * 系统语言。读 `navigator.languages[0] || navigator.language`。
 *
 * 两条防御：`navigator.language` 读不到时（某些隐私模式下是空串），
 * 以及**根本没有 `navigator`** 时，都回退到 `DEFAULT_LANG`。
 *
 * ## ★ 无头回归跑在哪个语言上，取决于 **Node 版本**
 *
 * `navigator` 是 **Node 21+ 才有的全局**（Node 20 上没有）。
 * 于是同一份回归：
 *
 *   · 本机 Node 22 + 中文系统 → `navigator.language = 'zh-SG'` → **'zh'**
 *   · CI 的 Node 20 → 没有 `navigator` → 兜底 `DEFAULT_LANG` = **'en'**
 *
 * 也就是说：**判据跑在哪个语言上，是环境决定的，不是代码决定的。**
 * 2026-10-23 那次 CI 红的就是这么来的——`verify_shop_no_priceless`
 * 拿**渲染出来的货架文字**（跟着语言走）去比对**商品表里的中文名**，
 * 于是在英文侧每一件商品都被报成「不在商品表里」。
 *
 * 所以规矩是：**判据不许依赖当前语言**。
 * 要比渲染结果，就用 `t()` 取同一份文案（两边一致），
 * 或者把**数据自带的两边写法**都收进白名单。
 * 反过来，把语言钉死在某一个值上并不能解决问题——那只是把
 * 「这台机器上绿、那台机器上红」换成「所有人都在同一个假设下绿」，
 * 而那个假设本身没人验过。
 *
 * 探测走 `globalThis` 间接取，**不能写裸 `navigator`**：esbuild 打包时
 * 看见 bundle 里没有这个全局标识符，会把 `typeof navigator !== 'undefined'`
 * 折叠成常量，而折叠方向猜不得（`verify/entry.ts` 的 `document` 桩
 * 同一个理由，那边记着一次"桩被跳过然后抛 document is not defined"）。
 */
export function systemLang(): Lang {
  try {
    const nav = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } }).navigator;
    const tag = (nav && nav.languages && nav.languages[0]) || (nav && nav.language) || '';
    if (!tag) return DEFAULT_LANG;
    return langOf(tag);
  } catch {
    return DEFAULT_LANG;
  }
}

export function initLang(): Lang {
  // 1. 玩家自己选过——最高优先。`setLang()` 会落盘，所以这里读得到。
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') {
      current = saved;
      return current;
    }
  } catch {
    /* 忽略：无头环境或隐私模式下没有 localStorage，走下面两条 */
  }
  // 2. 系统语言：中文机器进来自动中文，不用先点一次按钮。
  //    读不到时 `systemLang()` 自己回退到 `DEFAULT_LANG`。
  current = systemLang();
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
