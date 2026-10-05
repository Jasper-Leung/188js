/**
 * 明信片系统的对外入口。
 *
 * UI 层只需要认这一个文件：`import { buildInputFromState, drawPreview,
 * exportPostcardPng } from '@/game/postcard'`。
 *
 * 明信片是这个游戏的**最终产出物**——玩家骑一圈收集五块碎片，
 * 15 次打卡，最后合成一张可以写字、可以导出 PNG 的明信片。整条情绪线收在这里，
 * 所以它对外的接口刻意很小：**一个输入结构 + 三个动作**（画、预览、导出），
 * 中间所有判据（评级、纸面、蜡封、文案）都在这一层里算完，
 * 外面不许也不需要再判一次。
 *
 * 分层：
 *   · `layout.ts` —— 常量：尺寸、留白、印章位置、碎片色表、评级→画区布局表、文案取字
 *   · `types.ts`  —— 类型 + 纯函数：评级 `computeTier`、主题 `computeTheme`
 *   · `render.ts` —— 画笔：正反两面
 *   · `export.ts` —— PNG 导出 + 手写体加载
 */
import { ROAD } from '../../data/raw';
import { game } from '../state';
import { exportPostcardPng } from './export';
import { t } from './layout';
import {
  computeTier,
  endingOf,
  isStationSeen,
  kitTierClamp,
  prefilledBackKey,
  seenCountOf,
  type EndingId,
  type Lang,
  type PostcardInput,
} from './types';

// ---- 类型 ----
export type { EndingId, Lang, PostcardInput, PostcardTheme, CardTier, Rgb, ThemeRgb } from './types';
export { CARD_SIZE } from './types';

// ---- 评级 / 主题 ----
export {
  computeTier,
  computeVariant,
  computeTheme,
  endingOf,
  prefilledBackKey,
  backCaptionKey,
  themeRgb,
  kitTierClamp,
  paperTierName,
  paperTierNameKey,
  paperTextureFlags,
  seenCountOf,
  isStationSeen,
  hex,
  css,
  darkened,
  lightened,
  lerpC,
} from './types';

// ---- 版面常量 ----
export {
  MISSING_KEYS,
  FRAGMENT_COLS,
  VARIANT_LAYOUTS,
  FONT_UI,
  FONT_HAND,
  MAX_VISITS_PER_STATION,
  t,
  tInt,
} from './layout';

// ---- 绘制 ----
export {
  drawFront,
  drawBack,
  drawPreview,
  panelFill,
  layoutMap,
  backMessageBox,
  joysColumnRect,
  sealBroken,
} from './render';
export type { MapLayout, Rect } from './render';

// ---- 导出 ----
export {
  exportPostcardPng,
  exportFileName,
  ensureHandwritingFont,
  isHandwritingReady,
  clampBackText,
} from './export';

// ---- 字体家族名（宿主注册 @font-face 用） ----
//
// `FONT_FAMILY` = 手写体（`public/fonts/handwriting.woff2`，玩家在背面写的字），
// `UI_FONT_FAMILY` = 印刷体（`public/fonts/ui.woff2`，抬头/标签/落款/金印）。
// 两者都**从 `layout.FONT_HAND` / `layout.FONT_UI` 的第一项解析出来**，
// 不是另抄的字符串：家族名在代码里只能有一个出处，否则 canvas 会静默退回
// 系统字体、导出的 PNG 字形与界面不一致（见 export.ts 的说明）。
export { FONT_FAMILY, UI_FONT_FAMILY } from './export';

export interface BuildInputOverrides {
  /** 玩家在背面写的字。 */
  backText?: string;
  lang?: Lang;
  /** 结局。没给就按存档的 `endingId` 读。 */
  ending?: EndingId;
  /** 评级覆盖（演示 / 定妆照用）。 */
  tierOverride?: PostcardInput['tierOverride'];
}

/**
 * 从存档单例拼一份 `PostcardInput`。
 *
 * **一个字段都不许在调用方自己算** —— 顶栏、小地图、脚下提示圈三处都调
 * `game.fragmentStationNeedsVisit()`，明信片这一处再自己抄一遍判据，
 * 玩家就会同时看到几块互相打架的指示牌。
 *
 * `endingId` 的映射：原作存的是 `'keep'` / `'break'`（空串 = 未竟）。
 * 本工程用 `'leave_door'` / `'let_go'`。**未竟落到 `leave_door`**：
 * 留门那一支画出来是"蜡封完好"，而未竟的正面本来也不该出现掰开的口——
 * 那道裂口只属于【放手】。
 */
export function buildInputFromState(overrides: BuildInputOverrides = {}): PostcardInput {
  const slotVisits: number[] = [];
  for (const stationIdx of ROAD.FRAGMENT_SLOT_STATION_IDX) {
    slotVisits.push(game.getStationCount(stationIdx));
  }

  const seenStations: boolean[] = [];
  for (let i = 0; i < ROAD.STATIONS.length; i++) seenStations.push(game.seenStations.has(i));

  const input: PostcardInput = {
    slotVisits,
    kitTier: kitTierClamp(game.getPostcardTier()),
    hasPaper: game.hasItem('paper'),
    hasInk: game.hasItem('ink'),
    hasSeal: game.hasItem('seal'),
    hasEnvelope: game.hasItem('env'),
    ending: overrides.ending ?? endingFromGameState(),
    backText: overrides.backText ?? '',
    lang: overrides.lang ?? 'zh',
    seenStations,
    seenCount: game.getSeenStationCount(),
  };
  if (overrides.tierOverride !== undefined) input.tierOverride = overrides.tierOverride;
  return input;
}

/** 存档里的 `endingId` → 明信片用的两值结局。转换只在 `types.ts` 的 `endingOf` 里。 */
export function endingFromGameState(): EndingId {
  return endingOf(game.endingId);
}

/**
 * 【留门】预填的那一句。
 *
 * 原作的 `EndCard._seed_back_text()`：**只有 keep 才预填**，放手 / 未竟一律留白。
 * 留白不是省事——"留白 + 掰开的蜡封"是这个抉择真正落在产物上的东西；
 * 只改一句预填文案的话，玩家的收获和手抄一遍没区别，那不叫选择。
 */
export function seededBackText(ending: EndingId, lang: Lang): string {
  const key = prefilledBackKey(ending);
  return key ? t(lang, key) : '';
}

/**
 * 一次把两张都导出来。原作是**两次 Blob 下载**（先正面，再背面），
 * 因为浏览器会把连续两次下载当弹窗拦掉。
 * 这里保持"分开拿"，由调用方决定怎么下载；不要图省事合成一张 1920×2160——
 * 玩家要的是能分别发出去的两张。
 */
export async function exportBothSides(
  input: PostcardInput,
): Promise<{ front: Blob; back: Blob }> {
  const front = await exportPostcardPng(input, 'front');
  const back = await exportPostcardPng(input, 'back');
  return { front, back };
}

/** 便捷：这张卡现在的四档评级（给 UI 角标 / 定妆照用）。 */
export function tierOf(input: PostcardInput) {
  return computeTier(input);
}

export { computeTier as tier, seenCountOf as seenCount, isStationSeen as stationSeen };
