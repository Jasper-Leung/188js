/**
 * 文案 —— 中英双语，214 个 key，两侧集合严格一致。
 *
 * key 集合一致性由 `npm run verify` 里的 `verify_i18n` 守着。
 * 这条断言是从源项目搬来的，而且它挡过真东西：曾经有一个
 * `"progress": "已行 %dkm / 188km"` 只存在于中文表里，被一条"看起来齐全"
 * 的扫描放过了——而它是全表里唯一真带着里程的一句，玩家一眼就能算出
 * 7200km/h 然后整个数字连同它承载的解锁门一起失去可信度。
 *
 * 格式化用 `printf` 风格（%d / %s），和源项目一致，替换规则也一致：
 * 命名参数优先，位置参数兜底。
 */
import { I18N, type Lang } from '../data/raw';

export type { Lang };

let current: Lang = 'zh';
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
  // 首次访问按浏览器语言猜一次。猜错玩家能自己切，猜对省一次点击。
  current = (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  return current;
}

export function getLang(): Lang {
  return current;
}

export function isEnglish(): boolean {
  return current === 'en';
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
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const table = I18N[current] ?? I18N.zh;
  let s = table[key];
  if (s === undefined) {
    const fb = I18N.zh[key];
    s = fb === undefined ? `⟨${key}⟩` : fb;
  }
  if (!vars) return s;

  // 命名参数 {name}
  s = s.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
  // 位置参数 %s %d %f —— 按出现顺序消费
  let i = 0;
  const ordered = Object.values(vars);
  s = s.replace(/%[sdf]/g, () => (i < ordered.length ? String(ordered[i++]) : ''));
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
