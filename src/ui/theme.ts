/**
 * 设计 token —— 「宣纸与墨」。
 *
 * 原作是 Godot 里的 `_draw()`：每一条线、每一块底色都写死在绘制代码里，
 * 换档不换色。本文件是它 Web 版的唯一色表，**所有颜色只在这里出现一次**。
 * 面板、HUD、小地图（canvas 2D）、触屏控件都从这里取，任何一处自己抄一个
 * `#e8e0cd` 上去，那一处就会在黄昏时和别处对不上。
 *
 * ## 三条原则（都是原作版式抄来的，不是审美偏好）
 *
 * 1. **纸是暖白，不是纯白**。纯白 `#fff` 在 3D 场景上会读成一块发光的板子，
 *    而 `#ece3ce` 这种带黄的纸色在冷调的天光下才坐得住。原作的
 *    `LAND_COL = F4F2EA` 是同一个判断，只是明信片那张纸更白一点。
 * 2. **强调色只给印泥红**。整块界面里只有一处红（当前目标 / 强调按钮 /
 *    碎片图标），其余靠墨色的浓淡分层。红一多，"这一处是重点"就失效了。
 * 3. **分隔用细线不用阴影**。阴影在弱核显上要重新光栅化边缘，而这张界面的
 *    分隔信息量很低（面板本身已经是一个纸色的块），1px 实线足够。
 *
 * ## 字体栈为什么不自己写
 *
 * `FONT_STACK`（正文）与 `FONT_HAND`（背面手写体）都从别的模块 import，
 * 不在本文件另抄一份：chrome.ts 那份是五个小游戏共用的，postcard/layout.ts
 * 那份是明信片画布用的，两边的"第一项家族名"都被别处 `document.fonts.load()`
 * 当成契约等着。抄一份的代价是：改了一处，另一处的 `load()` 恒为 false，
 * 然后**静默退回系统字体**——界面上完全看不出异常，只有导出的 PNG 字形变了。
 */
import { FONT_STACK } from '../game/minigames/chrome';
import { FONT_HAND } from '../game/postcard/layout';

/** 界面正文字体栈。首项 `188UI` = public/fonts/ui.woff2（181KB 子集）。 */
export const FONT_BODY = FONT_STACK;

/** 明信片背面手写体栈。首项 `GiftHand` = handwriting.woff2（404KB，懒加载）。 */
export const FONT_HANDWRITE = FONT_HAND;

// ---------------------------------------------------------------- 纸与墨

/**
 * 纸色不是一个色值，是**一对**：日间与黄昏。
 *
 * 面板纸色写成 `rgb(calc(236 - var(--dusk) * 76) ...)`（见 styles.css），
 * `--dusk` 由 index.ts 从 `world.sky.state.dusk` 每 0.25s 写一次。
 * 不这么做的后果很具体：黄昏时世界整个压暗，一块 `#ece3ce` 的面板浮在
 * 上面会亮得刺眼，而**面板的对比度反而比日间更高**——那是把"重要"信号
 * 反着发。压暗之后面板和背景一起沉下去，字才重新读得出来。
 */
export const PAPER_DAY: readonly [number, number, number] = [236, 227, 206];
export const PAPER_DUSK: readonly [number, number, number] = [158, 146, 124];

/** 墨色。正文。 */
export const INK = '#2b241b';
/** 次级文字：说明、注脚、单位。 */
export const INK_SOFT = '#6b5f4c';
/** 三级文字：图例、禁用态的说明。 */
export const INK_FAINT = '#9a8d76';
/** 印泥红。全界面只有这一处强调色。 */
export const ACCENT = '#9d3a2f';
/** 印泥红的浅一档：进度环的底、hover 底色。 */
export const ACCENT_SOFT = '#c4705c';
/** 金：与明信片的 `ACCENT_COL = C9A26B` 同源，用于"已集齐"这类正面的事。 */
export const GOLD = '#c9a26b';

/**
 * 五件乐事的颜色。
 *
 * 取自 chrome.ts 里五个小游戏的景（云影台的天光、茶烟小筑的桌面、琴音林的
 * 远景、竹雨庭的湿地面、花房的湖面），所以碎片栏的五个色块和进游戏后看到的
 * 那一屏是同一族颜色——玩家在 HUD 上认的是"颜色 + 汉字"，而颜色先到。
 * 竹那一格最深（#2E3A38），它在小地图上要用白描边才看得见，见 minimap.ts。
 */
export const FRAGMENT_COLORS: readonly string[] = [
  '#9fc3dc', // 云
  '#8a6540', // 茶
  '#546b52', // 琴
  '#2e3a38', // 竹
  '#d9c9ae', // 禽
];

// ---------------------------------------------------------------- 节奏

/**
 * 唯一的动效时长：150ms 淡入。
 *
 * 原作几乎没有动效，而那不是省事——界面每多一处动效，弱核显上就多一处
 * 合成层。这里只保留"面板出现"一种，并且只动 opacity（合成器就能做，
 * 不触发重绘）。转场、缩放、位移一律不做。
 */
export const FADE_MS = 150;

/** 面板圆角。原作的控件几乎都是方的，圆角大一点就"游戏化"了。 */
export const RADIUS = '0.2rem';

// ---------------------------------------------------------------- 缺口

/**
 * 本目录用到、而 `src/data/generated/i18n.json` 里**没有**的 key。
 *
 * 按约定不往 raw.ts 里加（那是数据层，不是本任务的范围），
 * 照单列在这里给宿主补表时抓。判据是：界面上有一句话/一个标签，
 * 现有 234 个 key 里**没有任何一个能把这句话说全**——
 * 拿 `key_pause`（「暂停 / 继续」）去顶一个触屏按钮，或者拿
 * `postcard_back_title`（「第188号路线 · 礼物」，那是**卡面印刷的抬头**）
 * 去顶正反面切换页签，都是拿一句更长的不相干的话凑数。
 *
 * 这些 key **必须中英双语**（i18n 的集合一致性由 `npm run verify` 的
 * `verify_i18n` 守着，缺一侧会直接挂）。
 */
export const UI_MISSING_KEYS: readonly string[] = [
  'hud_tris', // 性能面板的「三角面」一行。`hud_fps`/`hud_drawcalls`/`hud_scale`/`hud_tier` 都有，唯独面数没有
  'tier_shadows', // 画质档摘要的「阴影」标签。tierSummary() 返回 shadows 的值，标签没处放
  'tier_grass', // 画质档摘要的「草皮」标签，同上
  'touch_pause_button', // 触屏右上角「暂停」按钮。`key_pause` 是给键盘说明用的整句
  'touch_mute_button', // 触屏右上角「静音」按钮。`key_mute` 同上
  'card_side_front', // 结算页正反面切换的「正面」页签
  'card_side_back', // 结算页正反面切换的「背面」页签
];
