/**
 * 世界内的常驻 HUD —— 顶栏、碎片栏、脚下提示圈，外加小地图。
 *
 * ## 三块指示牌必须用同一个函数
 *
 * 原作踩过这个坑，而且踩得很贵：`GameManager.fragment_station_needs_visit()`
 * 的注释里写着「顶栏、小地图、脚下提示圈三处都调它。任何一处自己抄一份判据，
 * 玩家就会同时看到三块互相打架的指示牌」。
 *
 * 事故的形状是：顶栏按「这一站收过没有」判断，于是收过第一块碎片之后
 * 顶栏就认为云影台不用再去；小地图按「到访次数 < 3」判断，于是它还在闪；
 * 脚下提示圈按第三套判断，于是它既不出现也不消失。玩家收到的信号是
 * 「这里到底还要不要来」——而完满评级要求五座各去**三次**，所以
 * 「已经收过」从来不是目标的全集。
 *
 * 因此本文件里找目标的代码**只有一处**：`nextFragmentTarget()`。
 * 顶栏读它写那行字，小地图由它传进去，脚下提示圈则和它同源于
 * `world.nearby.needsVisit`（`World.updateProximity()` 调的是同一个判据）。
 * 任何一处想改成自己的口径，先去 state.ts 改那个函数。
 *
 * ## 脚下提示圈为什么是一个跟着屏幕走的 DOM 圆
 *
 * 原作用 3D 在地面画一个半径 15m 的圈。Web 侧用 DOM 复现，选的是
 * 「把驿站的世界坐标投影到屏幕，在那儿放一个圆」——理由有两条：
 *
 * · **它得能用鼠标点。** 原作那个圈是 3D 网格，鼠标点不到；本作要求
 *   圈可点，而一个 3D 环要变成可点热区就得再叠一块不可见的碰撞体，
 *   纯属把 DOM 已经做好的事搬回 3D。
 * · **键盘必须有等价物。** 圆做成真正的 `<button>`，Tab 能到、Enter/Space
 *   能激活，激活的就是打卡那一个 hook。原作正是「取消按钮键盘点不到」
 *   把键盘玩家困住的——所以这里把可点性和可聚焦性绑在同一个元素上，
 *   不会出现「鼠标能点、键盘到不了」的按钮。
 *
 * 圆的大小按距离缩放，但**缩放走 transform 而不是 width/height**：
 * 改 width 会让浏览器每帧重排这个元素的子树，而 transform 由合成器
 * 直接处理，代价为零。位置同理，用 translate3d。
 *
 * ## 圈上的字与屏幕下方那颗提示：**字只留一份**
 *
 * 圈上那行「空格 · 进入小铺」与下方那颗交互提示说的是同一件事。
 * 两处同时指着同一个动作，而其中一个还多带一个键帽——
 * 那不叫"多一条信息"，那叫"界面吵"。
 *
 * 规则是：**圈负责指位置（空间），提示负责说动作（文字 + 键帽）**。
 * 指向同一个动作时（同一个 `kind`），圈上那行**可见文字**让位给提示；
 * 提示说的是别的东西时，圈上的字照旧。
 * 无障碍名**留在圈上**——读屏器照常念得到，而它不占视觉位置。
 */
import { Vector3 } from 'three';
import { STATIONS } from '../data/route';
import { ECON, ROAD } from '../data/raw';
import { t, stationNameOf } from '../i18n';
import { Minimap } from './minimap';
import { button, el, setAttr, setFlag, setShown, setStyle, setText } from './dom';
import { fragmentColors } from './theme';
import { QuestTracker } from './questTracker';
import { icon } from './icons';
import type { World } from '../world/world';
import { GameStateManager } from '../game/state';
import { interactAt, STATION_REACH, type InteractKind } from '../game/phase';

/** 碎片槽位 → 驿站下标。碎片栏按槽位排，而 `getStationCount()` 收驿站下标，
 *  这两个下标空间不是一回事（云影台是驿站 7、槽位 0）。 */
const SLOT_TO_STATION = ROAD.FRAGMENT_SLOT_STATION_IDX;

/**
 * 站名（按下标）。判定本身在 `i18n/stationNameOf()`——
 * `world.ts` 也要用它（对白框的说话人、故事卡的抬头），两处必须是同一份口径。
 *
 * 它是**数据**不是文案：16 个站名是关卡内容，和 `ROAD.STATIONS` 同源。
 * 顶栏、对白框、脚下提示圈三处都调它——同一个站名在三处显示成三个写法，
 * 是玩家最先发现的 bug。
 */
export function stationName(i: number): string {
  const s = STATIONS[i];
  return s ? stationNameOf(s.def) : '';
}

export interface NextTarget {
  idx: number;
  dist: number;
}

/**
 * 圈上那行**可见文字**要不要让位给屏幕下方那颗提示。
 *
 * ## 规则
 *
 * **圈负责指位置（空间），提示负责说动作（文字 + 键帽）。**
 * 两处指向**同一个动作**时，圈上的字让位——否则同一个动作在屏上被念两遍。
 *
 * ## 为什么比的是 `kind` 而不是文字
 *
 * 文字是拼出来的（`空格 · 进入小铺`、`Space · 进入小铺`、触屏那套又是另一句），
 * 而提示那侧的文案也随语言与触屏模式变。
 * 比字符串的话，**两边文案一改就可能不再相等**，于是「字只留一份」这条悄悄失效，
 * 而屏上还是两处都在说话。
 * `kind` 是**动作本身**（shop / home / checkin / relic / qin / sign），
 * 两边都从同一族判据出来（`interactAt()` 与 `world.roadsideCandidates()`），
 * 所以它不随语言变，也不会各自漂。
 *
 * @param label 圈上原本要写的那行字
 * @param ringKind 这一圈说的是哪一族动作（`interactAt()` 的结果）
 * @param promptKind 提示正在说的是哪一族动作；null = 提示没亮
 */
export function ringLabelText(
  label: string,
  ringKind: InteractKind,
  promptKind: string | null,
): string {
  return promptKind === ringKind ? '' : label;
}

/**
 * 把渲染好的「下一处」一句切成 `[站名, 距离·余次]`。
 *
 * 切点取**最后一个** ` · `，而分隔符本身留在后半段（`" · 18m"`），
 * 所以界面上仍然是原来那句的样子——`setText` 两侧拼回去逐字相同。
 * 这一点有回归守着（`verify_hud_next_split`），不是靠人记得。
 *
 * 为什么按分隔符切而不拆成两个文案 key：中英语序不同
 * （`下一处 %s %s · %dm` / `Next %s %s · %dm`），拆 key 等于把语序搬进代码，
 * 而语序本来就该住在文案表里。四个模板各含一个 ` · `，所以切点是确定的。
 *
 * 没有分隔符时（将来有人改了模板）返回 `[整句, '']`：站名格里是整句，
 * 距离格空着——**可辨认的降级**，不是距离静默消失。
 */
export function splitNextTarget(rendered: string): [string, string] {
  const i = rendered.lastIndexOf(' · ');
  if (i < 0) return [rendered, ''];
  return [rendered.slice(0, i), rendered.slice(i)];
}

/**
 * 「下一处」在**该回十八驿**时的那一行。`left` 是刷满还欠多少次到访。
 *
 * ## 为什么它必须是两句而不是一句
 *
 * 回十八驿与刷到完满是两条**可以并行**的路：第一章的收尾动作是前者，
 * 而完满评级要的是后者。原来的写法是这一支直接 `return`，
 * 于是顶栏从集齐那一刻起整章都不再提还欠几次——玩家于是看不到"还有事没做"，
 * 只会一路骑回家把这一趟收掉，而那面评级墙是给这类人准备的。
 *
 * ## 为什么导出成纯函数
 *
 * `World` 在无头环境里构造不出来，所以整个 HUD 在 `npm run verify` 里
 * 建不起来。与其让这条判据退化成注释，不如把这一格**怎么决定**拆出来单独验——
 * 和上面那个 `splitNextTarget` 是同一个手法。
 */
export function homeNextLine(arrow: string, dist: number, left: number): string {
  return left > 0
    ? t('hud_home_target_visits', { 0: arrow, 1: left, 2: dist })
    : t('hud_home_target', { 0: arrow, 1: dist });
}

/**
 * 「下一处」：最近的、**还欠一次到访**的碎片驿站。没有就返回 null。
 *
 * 距离用**世界坐标的直线距离**，不是沿中心线的弧长。原作也是直线距离，
 * 这不是随手选的：弧长在 8 字交叉点附近会突然出现两个几乎相等的解
 * （两条环都「很近」），指哪一条就变得随机，而直线距离没有这个歧义。
 * 代价是玩家离目标还有 30m 时数字会偏小——那个数字只用来给个量级，
 * 不当尺子用。
 */
export function nextFragmentTarget(world: World, game: GameStateManager): NextTarget | null {
  const p = world.ride.pos;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < STATIONS.length; i++) {
    if (!game.fragmentStationNeedsVisit(i)) continue;
    const s = STATIONS[i];
    const d = Math.hypot(s.x - p.x, s.z - p.z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best < 0 ? null : { idx: best, dist: bestD };
}

/**
 * 目标相对**车头**的方向箭头。8 向，向右为正。
 *
 * 这一段实现已经搬到 `game/api/types.ts` —— 箭头字形现在是 HUD 与
 * AI 观测的公共依赖，两边各留一份必然会有一边偷偷漂掉。
 * 这里只做重导出，调用点一行都不用改。
 */

import { arrowGlyph } from '../game/api/types';

// ---------------------------------------------------------------- 碎片栏

interface FragCell {
  box: HTMLDivElement;
  name: HTMLSpanElement;
  cnt: HTMLSpanElement;
  pips: HTMLSpanElement[];
  /** 色块本体。色觉切换时要重写它的 `--sw`，所以得留着。 */
  swatch: HTMLSpanElement;
}

export interface HudOpts {
  world: World;
  game: GameStateManager;
  onCheckIn: () => void;
}

export class Hud {
  readonly root: HTMLDivElement;
  readonly minimap: Minimap;
  /**
   * 主线追踪器。它**挂在碎片卡里面**（构造时传进去的是那张卡），
   * 所以它不需要自己算位置——理由见 `questTracker.ts` 的文件头。
   */
  readonly quest: QuestTracker;

  private world: World;
  private game: GameStateManager;

  // 顶栏
  private seenEl: HTMLSpanElement;
  private lvbiEl: HTMLSpanElement;
  private moodEl: HTMLSpanElement;
  private chapterEl: HTMLSpanElement;
  /** 期限：余 N 天 / 已过期 N 天 */
  private daysEl: HTMLSpanElement;
  private offRoadEl: HTMLSpanElement;
  private nextEl: HTMLDivElement;
  /** 「下一处」的两格：站名（可省略号）/ 距离·余次（永不省略） */
  private nextNameEl: HTMLSpanElement;
  private nextMetaEl: HTMLSpanElement;
  /** 「这一趟要做什么」：一句目标陈述。`objectiveKey` 渲染出来的。 */
  private objectiveEl: HTMLDivElement;

  // ---- 给 AI 接口读的镜像（见 `aiNext`） ----
  /**
   * 顶栏算出来的「下一处」，**原样留一份**。
   *
   * AI 观测里也有 `nextStation` / `nextDistance` / `nextArrow`，
   * 而那三个数**必须**是玩家在这一帧看到的那三个——
   * 如果 AI 侧自己再算一遍，两处判据迟早会漂；
   * 漂了以后 AI 会朝着一个玩家在屏幕上**看不见**的方向骑，
   * 而症状长得像"AI 好像不太会用导航"，极难归因。
   * 所以这里存的是**已经算好的结果**，不是第二份计算。
   */
  private aiNextIdx = -1;
  private aiNextName = '';
  private aiNextDist = -1;
  private aiNextArrow = '';
  private aiObjective = '';

  /** 上一帧 `update()` 算出来的导航与目标。`main.ts` 装 AI 接口时读它。 */
  get aiNext(): {
    idx: number;
    name: string;
    dist: number;
    arrow: string;
    objective: string;
  } {
    return {
      idx: this.aiNextIdx,
      name: this.aiNextName,
      dist: this.aiNextDist,
      arrow: this.aiNextArrow,
      objective: this.aiObjective,
    };
  }

  // 碎片栏
  private cells: FragCell[] = [];
  /** 色觉友好配色。写进行内 `--sw`，所以切换时要重画而不只是挂 class。 */
  private colorblind = false;
  /** 减弱动效。节拍圈在 canvas/CSS 之外，这一项由它自己读。 */
  private reduceMotion = false;

  // 脚下提示圈
  private ringHold: HTMLDivElement;
  private ring: HTMLDivElement;
  private ringBtn: HTMLButtonElement;
  private ringLabel: HTMLDivElement;
  private ringShown = false;
  /** 骑行节拍：容器 / 收缩的圈 / 键帽 / 五个进度点 */
  private beatEl: HTMLDivElement;
  private beatRing: HTMLDivElement;
  private beatKey: HTMLDivElement;
  private beatDots: HTMLSpanElement[] = [];
  /**
   * 碎片栏的组头（「碎片」两个字）。
   *
   * 它和 `offRoadEl` / `beatKey` 一样是构造时写死的静态文案——
   * 不留在字段里的话，`sync()` 翻不到它，切完语言顶栏下面是旧语言。
   */
  private fragsTitleEl: HTMLSpanElement;
  /** 组头前面那枚碎片图标。留着一个引用好让切语言时不必重建。 */
  private fragsIconEl!: HTMLSpanElement;
  /** 路边躲避挑战的进度条。`setDodge()` 逐帧只改一个自定义属性。 */
  private dodgeEl: HTMLDivElement;
  private dodgeFill: HTMLSpanElement;
  private dodgeText: HTMLDivElement;
  private ringX = NaN;
  private ringY = NaN;
  private ringScale = NaN;
  /**
   * 屏幕下方那颗提示正在说的是哪一族动作。null = 提示没亮。
   *
   * ★ 它决定**圈上那行可见文字要不要让位**（规则见 `ringLabelText()`）。
   *   由 UI 层每帧推过来（提示与圈是同一个 UI 里的两件东西，
   *   它们之间只靠这一个值说话）。
   */
  private promptKind: string | null = null;

  private touchMode = false;
  private tmp = new Vector3();

  constructor(parent: HTMLElement, o: HudOpts) {
    this.world = o.world;
    this.game = o.game;

    this.root = el('div', 'g-hud');

    // ---------------- 顶栏 ----------------
    // 三段：状态（左）… 导航（右）。中间的空档由 CSS 的 margin-left:auto
    // 顶开，所以「下一处」不管多长都贴着右端，不在后面留一条死区。
    const top = el('div', 'g-top');
    const left = el('div', 'g-top-l');
    this.seenEl = el('span', 'g-stat');
    this.lvbiEl = el('span', 'g-stat');
    this.moodEl = el('span', 'g-stat');
    left.appendChild(this.seenEl);
    left.appendChild(this.lvbiEl);
    left.appendChild(this.moodEl);
    // 章节。放在状态组里而不是标题页，因为它要在**游戏进行中**回答
    // "我现在在第几章"——而集齐五件之后这一章的走法会整个变掉。
    this.chapterEl = el('span', 'g-stat g-stat-chapter');
    left.appendChild(this.chapterEl);
    /**
     * 期限。放在状态组最前面，排在「已过 N 驿」**之前**——
     * 因为它是唯一一个"会因为什么都不做而变少"的数，
     * 而其余几个都只会往上加。玩家扫一眼顶栏时，它该是最先被扫到的那一格。
     */
    this.daysEl = el('span', 'g-stat g-stat-days');
    left.insertBefore(this.daysEl, this.seenEl);
    /**
     * 离路提示。**只在真的偏出去时出现。**
     *
     * 降速本身是 `ride.ts` 的 `applyOffRoad()`，但光降速玩家未必察觉：
     * 6m/s 掉到 2.7m/s 在一片绿色草坡上很难自己看出来，而这时候
     * 相机往往已经钻进树冠（最近的植被块可以距玩家 0.5m）。
     * 所以给它一格字，让"我偏了"这件事和"车变慢了"同时发生。
     *
     * 复用 `hud_road_no`（性能面板里那句「已偏离」），不新增文案。
     */
    this.offRoadEl = el('span', 'g-stat g-stat-offroad g-hidden', t('hud_road_no'));
    left.appendChild(this.offRoadEl);
    top.appendChild(left);
    this.nextEl = el('div', 'g-next');
    /**
     * 「下一处」拆成两格：**站名**与**距离 / 余次**。
     *
     * 原来是 `setText(this.nextEl, t('hud_next_target', ...))` 一整句，
     * 靠 CSS 的 `text-overflow: ellipsis` 收尾。而距离在模板里排在**最后**
     * （`下一处 %s %s · %dm`），于是站名一长，最先被省略号吃掉的就是距离——
     * 也就是唯一告诉玩家"我在靠近"的那个数。实机在 726px 宽下读到的是
     * `Next Birdsong Cove Flower House ↗ · 1…`。
     *
     * 拆开之后收缩压力只落在站名那一格：距离 `flex: 0 0 auto`，
     * 任何宽度下都不会被截断，而站名省略号是一个**体面的**降级
     * （名字认不出来，但还差多远一定读得到）。
     */
    this.nextNameEl = el('span', 'g-next-name');
    this.nextMetaEl = el('span', 'g-next-meta');
    this.nextEl.appendChild(this.nextNameEl);
    this.nextEl.appendChild(this.nextMetaEl);
    top.appendChild(this.nextEl);
    /**
     * 「这一趟要做什么」——顶栏的**第二行**，独占一行。
     *
     * ## 为什么不放进上面那一行
     *
     * 那一行的每一格都是一个**数或词**（天数 / 驿数 / 旅币 / 章节），
     * 而 `.g-top-l > *` 是 `white-space: nowrap`、整组 `flex-shrink: 0`——
     * 塞一句完整的话进去，「29 days left」就会被折成两行、顶栏整个变高。
     * 更要紧的是**它问的不是同一个问题**：上面那行答「我这趟怎么样」，
     * 这一行答「我这趟在干什么」。玩家开场两分钟里最想问的是后者，
     * 而游戏里此前**从来没有一处字回答过它**（`objectiveKey` 写好了、
     * 有回归守着，却从没被渲染过一次）。
     *
     * ## 为什么不是 toast
     *
     * 换目标那一下（集齐、过期）本来就有 toast 喊一遍。
     * toast 说完就飘走，而"我现在该干嘛"是玩家整个第一章都在反复确认的事——
     * 所以是**喊一次 + 一直挂着**，不是二选一。
     *
     * `flex-basis: 100%` 让它折到第二行，于是那条渐隐背景（它本来就是按
     * `calc(100% - 0.9em)` 画的，与顶栏是一行还是两行无关）自动罩住两行。
     */
    this.objectiveEl = el('div', 'g-objective');
    top.appendChild(this.objectiveEl);
    this.root.appendChild(top);

    // ---------------- 碎片栏 ----------------
    const fb = el('div', 'g-frags');
    /**
     * 主线追踪器是这张卡的**头一行**。
     *
     * 它排在「碎片」那个组头**上面**：组头是下面那五个格子的标题，
     * 而追踪器答的是更上位的那个问题——「这一章还差多少」。
     *
     * 计数（「2/5」）原来在组头右边，现在归追踪器：
     * 它本来就是**主线**的进度（收齐五枚），放在主线那一行里才对得上；
     * 而「碎片」这个词留给下面那五格，它说的是那五件乐事。
     */
    this.quest = new QuestTracker(fb, this.game);
    const fh = el('div', 'g-frags-h');
    // 组头前面挂一枚碎片图标：这一组是「五件乐事」，
    // 而图标比「碎片」两个字更快认出来（颜色先到，字后到）。
    this.fragsIconEl = el('span', 'g-frags-ic');
    this.fragsIconEl.appendChild(icon('shard'));
    fh.appendChild(this.fragsIconEl);
    this.fragsTitleEl = el('span', 'g-frags-title', t('glossary_fragment'));
    fh.appendChild(this.fragsTitleEl);
    fb.appendChild(fh);

    const strip = el('div', 'g-frags-row');
    for (let s = 0; s < 5; s++) strip.appendChild(this.buildCell(s));
    fb.appendChild(strip);
    // **挂进 `top` 里，不挂 `root`。** 碎片栏是 `position: absolute; top: 100%`
    // （见 styles.css），它的定位基准必须是顶栏本身——
    // 挂在 `root` 下时基准是 `.g-root`，`top: 100%` 就变成"铺满整屏"。
    // 挂进 `top` 之后顶栏几行它就跟着几行，目标陈述那一行不会再被它盖住。
    top.appendChild(fb);

    // ---------------- 脚下提示圈 ----------------
    // 圈与文字是两个元素：圈跟着距离缩放，文字不能跟着缩放
    // （缩放会把提示字放大或缩到看不清）。
    this.ringHold = el('div', 'g-ring-hold');
    this.ringBtn = button('', { cls: 'g-ring-btn' });
    this.ring = el('div', 'g-ring');
    this.ringBtn.appendChild(this.ring);
    this.ringLabel = el('div', 'g-ring-label');
    this.ringHold.appendChild(this.ringBtn);
    this.ringHold.appendChild(this.ringLabel);
    wireKeyActivate(this.ringBtn, o.onCheckIn);
    this.root.appendChild(this.ringHold);
    setShown(this.ringHold, false);

    // ---------------- 骑行节拍 ----------------
    // 放在圈的正上方一点：两者都在"脚下"，但节拍是**骑行中**的，
    // 圈是**停下来**的，上下分开才不会看错。
    this.beatEl = el('div', 'g-beat g-hidden');
    this.beatRing = el('div', 'g-beat-ring');
    this.beatKey = el('div', 'g-beat-key', t('key_relic'));
    this.beatEl.appendChild(this.beatRing);
    this.beatEl.appendChild(this.beatKey);
    const bd = el('div', 'g-beat-dots');
    this.beatDots = [];
    for (let i = 0; i < 5; i++) {
      const d = el('span', 'g-beat-dot');
      this.beatDots.push(d);
      bd.appendChild(d);
    }
    this.beatEl.appendChild(bd);
    this.root.appendChild(this.beatEl);

    // ---------------- 路边躲避挑战 ----------------
    // 放在节拍**下面**一点：两者都是"骑行中的提示"，
    // 而挑战要骑整整一圈，它不该和 1.15 秒的节拍圈抢同一块地方。
    this.dodgeEl = el('div', 'g-dodge g-hidden');
    const dodgeBar = el('div', 'g-dodge-bar');
    this.dodgeFill = el('span', 'g-dodge-fill');
    dodgeBar.appendChild(this.dodgeFill);
    this.dodgeText = el('div', 'g-dodge-text');
    this.dodgeEl.appendChild(dodgeBar);
    this.dodgeEl.appendChild(this.dodgeText);
    this.root.appendChild(this.dodgeEl);

    // ---------------- 小地图 ----------------
this.minimap = new Minimap(this.root, this.world, this.game);

parent.appendChild(this.root);
    this.sync();
  }

  /**
   * 换掉碎片栏那五个色块。
   *
   * **必须重画，不能只挂一个 class。** 颜色是写在行内 `--sw` 上的——
   * 它来自 `theme.ts` 的两份常量，而 CSS 变量在这里是被**逐格**写死的。
   * 挂 class 而不重写，症状是"设置里开了，格子没变"，
   * 而玩家没有任何办法判断自己到底有没有开成功。
   */
  setColorblind(on: boolean): void {
    this.colorblind = on;
    const colors = fragmentColors(on);
    for (let slot = 0; slot < this.cells.length; slot++) {
      this.cells[slot]?.swatch.style.setProperty('--sw', colors[slot] ?? colors[0]);
    }
  }

  /** 减弱动效：收缩的节拍圈是游戏内运动，CSS 媒体查询管不到它。 */
  setReduceMotion(on: boolean): void {
    this.reduceMotion = on;
    this.root.dataset.reduceMotion = on ? 'on' : 'off';
  }

  private buildCell(slot: number): HTMLDivElement {
    const box = el('div', 'g-frag');
    const swatch = el('span', 'g-frag-sw');
    // 颜色只做底，汉字单独用墨色画在上面（见 styles.css 的 .g-frag-sw）：
    // 竹那一格在小地图上是深色，压在纸色上会变成一个小黑洞。
    swatch.style.setProperty('--sw', fragmentColors(this.colorblind)[slot]);
    box.appendChild(swatch);

    const name = el('span', 'g-frag-n', t(`fragment_${slot}`));
    box.appendChild(name);
    const cnt = el('span', 'g-frag-c');
    box.appendChild(cnt);

    const pips: HTMLSpanElement[] = [];
    const pipRow = el('span', 'g-pips');
    for (let k = 0; k < ECON.MAX_VISITS_PER_STATION; k++) {
      const p = el('span', 'g-pip');
      pipRow.appendChild(p);
      pips.push(p);
    }
    box.appendChild(pipRow);
    box.title = t(`fragment_tip_${slot}`);

    this.cells.push({ box, name, cnt, pips, swatch });
    return box;
  }

  // ---------------------------------------------------------------- 每帧

  update(_dt: number): void {
    // 目标只算一次，三块指示牌共用（见文件头）
    const target = nextFragmentTarget(this.world, this.game);
    this.syncTop(target);
    this.minimap.update(0, target ? target.idx : -1);
    this.syncRing();
  }

  /**
   * 顶栏的「下一处」。三档，与 Godot `HUD3D._update_next_label()` 一一对应：
   * · 没有目标       → `hud_all_done`（「五座都走满了 · 正在收尾」）
   * · 还没收过这一站 → `hud_next_target`（站名 + 箭头 + 距离）
   * · 收过了还欠到访 → `hud_revisit_target`（站名 + 箭头 + 还差 N 次）
   * 第三档是原作补的：集齐之后「下一处」指的是**回访**而不是新碎片，
   * 还写「下一处 · 站名 · 距离」的话，玩家会以为这一站里还压着一块碎片。
   * 第一档也不是空串——`verify_minimap.gd` 第 10 节末尾钉的就是这一条：
   * 五座都刷满到跳结算页之间有 2.5 秒，那 2.5 秒里导航栏不能哑掉。
   */
  /**
   * 写「下一处」：一句模板先渲染，再按**最后一个** ` · ` 切成两格。
   *
   * 为什么不新增两个 key（一个给名字一个给距离）而要切字符串：
   * 中英文的语序不同（`下一处 %s %s · %dm` / `Next %s %s · %dm`），
   * 拆成两个 key 就等于把语序写死进代码，而那份语序本来就该住在文案表里。
   * 四个模板里都已经有一个 ` · `，所以「按最后一个分隔符切」是确定的；
   * 万一哪天有人把分隔符删了，`verify_hud_next_split` 会红，而界面上
   * 退化成「整句进站名格、距离格为空」——不是静默地读不到距离。
   */
  private setNext(rendered: string): void {
    const [name, meta] = splitNextTarget(rendered);
    setText(this.nextNameEl, name);
    setText(this.nextMetaEl, meta);
  }

  private syncTop(target: NextTarget | null): void {
    setText(this.seenEl, t('stations_seen', { 0: this.game.getSeenStationCount() }));
    setText(this.lvbiEl, t('lvbi_label', { 0: this.game.lvbi }));
    setText(this.moodEl, t('mood_label', { 0: this.game.mood, 1: ECON.MOOD_CEIL }));
    // `chapter_label_2` 写的是「第二章 · 在路上」而不是光一个「第二章」：
    // 第二章的存档闩锁是真的，可它背后没有内容——门后头还是同一批目的地。
    // 顶栏是玩家每一眼都会读的一格，它说出口的每一个字都得兑现得了。
    setText(this.chapterEl, t(`chapter_label_${this.game.chapter}`, { 0: this.game.chapter }));
    // 期限。**它是顶栏第一件被读到的数**，不是角落里的一个提醒：
    // 律师函说三十日，玩家就得随时能看见"我还剩多少"。
    // 过期之后这一格换字（`hud_days_over`）——不是变红、不是闪烁，
    // 这个世界里没有警报音，只有一句话变了。
    setText(
      this.daysEl,
      this.game.overdue
        ? t('hud_days_over', { 0: this.game.day - GameStateManager.DAYS_LIMIT })
        : t('hud_days_left', { 0: this.game.daysLeft }),
    );
    setFlag(this.daysEl, 'is-over', this.game.overdue);    // 离路提示：与降速同源（`ride.ts` 的 `applyOffRoad`），
    // 用它自己的布尔而不是重新判路面，免得两处判据漂移。
    setShown(this.offRoadEl, this.world.ride.offRoad);

    // 目标陈述。**必须在下面那两个 `return` 之前**——「该回十八驿」那一支
    // 会直接 `return`，而那一支恰恰是最需要把目标写出来的时候
    // （顶栏改成指十八驿了，但"这一趟在收尾"这句话只有这里有）。
    //
    // `t()` **只调一次**、结果给两处用（写进 DOM、留给 AI 接口读）。
    // `verify_days` 数过「覆盖 objectiveKey 的地方有且只有一处」，
    // 所以这里不是"调两次也对"，而是**调两次就会红**。
    //
    // 第二章那一支要带一个数：门后不再是"把五座各走满三次"（那还是第一章），
    // 而是"路上还有几件没听完"。**目标必须报数**——不报的话玩家没有
    // 下一次停车的理由，而停车是这个游戏里唯一为了一句话而做的事。
    const objectiveKey = this.game.objectiveKey;
    const objectiveText = objectiveKey === 'objective_chapter2'
      ? t(objectiveKey, { 0: this.game.chapter2Remaining })
      : t(objectiveKey);
    setText(this.objectiveEl, objectiveText);
    this.aiObjective = objectiveText;

    // 集齐五件之后，导航指向**十八驿**而不是任何一座碎片驿站。
    // 这是第一章唯一的收尾动作，所以它必须占住「下一处」这一格——
    // 那一格是玩家屏幕上唯一会持续指示"我该去哪"的地方。
    //
    // ★ 但它**不能连"还欠多少次"一起吞掉**。
    // 这一支原来直接 `return`，于是 `hud_revisit_target`（「再访 · 还差 N 次」）
    // 从集齐那一刻起整章都不会再出现——而完满评级要的正是剩下那 10 次到访。
    // 玩家于是看不到"还有事没做"，只会一路骑回家把这一趟收掉。
    // 回十八驿与刷到完满是两条可以并行的路，这一格要把后者说清楚，
    // 而不是把后者当成不存在。
    if (this.game.objective === 'return') {
      const home = STATIONS[GameStateManager.HOME_STATION];
      const p = this.world.ride.pos;
      const f = this.world.ride.forward;
      const arrow = arrowGlyph(home.x - p.x, home.z - p.z, f.x, f.z);
      const dist = Math.floor(Math.hypot(home.x - p.x, home.z - p.z));
      const left = this.game.fragmentVisitsRemaining();
      this.setNext(homeNextLine(arrow, dist, left));
      setFlag(this.nextEl, 'is-home', true);
      this.aiNextIdx = GameStateManager.HOME_STATION;
      this.aiNextName = stationName(GameStateManager.HOME_STATION);
      this.aiNextDist = dist;
      this.aiNextArrow = arrow;
      return;
    }
    setFlag(this.nextEl, 'is-home', false);

    if (!target) {
      this.setNext(t('hud_all_done'));
      setFlag(this.nextEl, 'is-done', true);
      this.aiNextIdx = -1;
      this.aiNextName = '';
      this.aiNextDist = -1;
      this.aiNextArrow = '';
      return;
    }
    setFlag(this.nextEl, 'is-done', false);

    const st = STATIONS[target.idx];
    const p = this.world.ride.pos;
    const f = this.world.ride.forward;
    const arrow = arrowGlyph(st.x - p.x, st.z - p.z, f.x, f.z);
    const name = stationName(target.idx);

    if (this.game.isCollected(target.idx)) {
      const left = Math.max(ECON.MAX_VISITS_PER_STATION - this.game.getStationCount(target.idx), 0);
      this.setNext(t('hud_revisit_target', { 0: name, 1: arrow, 2: t('visits_left_n', { 0: left }) }));
    } else {
      // 原作是 int(dist)，**向下取整**。取整而不是四舍五入是有意义的：
      // 数字往上跳会让人以为"刚刚近了很多"，而这一栏每帧都在跳。
      this.setNext(t('hud_next_target', { 0: name, 1: arrow, 2: Math.floor(target.dist) }));
    }
    this.aiNextIdx = target.idx;
    this.aiNextName = name;
    this.aiNextDist = Math.floor(target.dist);
    this.aiNextArrow = arrow;
  }

  /**
   * 脚下提示圈。
   *
   * 出现的条件与圈上写什么，**都取自 `phase.ts` 的 `interactAt()`**——
   * 和宿主 `tryCheckIn()` 是同一个函数。所以「圈上写进入小铺、按下去却
   * 跑去打卡」这种脱节在结构上就不可能发生（同一个项目已经为"三块指示牌
   * 各找一次目标"栽过一次，见 `state.ts` 文件头）。
   *
   * 距离阈值抄 `World.canCheckIn()` 里那一条：够得着的定义是
   * 「驿站半径 + 路半宽」，少一寸玩家会站在圈外按空格。
   *
   * 铺子站（0 / 2 / 8）过去**从来不出圈**——`needsVisit` 对没有碎片的驿站
   * 恒假，而那三座恰好都没有碎片。于是玩家在茶铺和灯铺门口看不到任何提示，
   * 按空格也没有反应（宿主那条路也没写）。现在两半都补上了。
   */
  private syncRing(): void {
    const nb = this.world.nearby;
    if (nb.index < 0) {
      this.hideRing();
      return;
    }
    const kind = interactAt({
      shopName: nb.shopName,
      isHome: nb.isHome,
      objectiveReturn: this.game.objective === 'return',
      hasFragment: nb.hasFragment,
      needsVisit: nb.needsVisit,
      distance: nb.distance,
      reach: STATION_REACH,
      busy: this.world.checkInStage !== 'none',
    });
    if (kind === 'none') {
      this.hideRing();
      return;
    }

    const st = STATIONS[nb.index];
    const w = this.root.clientWidth || window.innerWidth;
    const h = this.root.clientHeight || window.innerHeight;

    // 投影到屏幕。y 取驿站的模型脚底高度，而不是地形高度 0：
    // 驿站站在山坡上时，用 0 会让圈落在模型下面半层。
    const baseY = this.world.stations.list[nb.index]?.worldPos.y ?? 0;
    this.tmp.set(st.x, baseY + 0.6, st.z).project(this.world.ride.camera);
    // this.tmp.z > 1 = 在相机背后。这时 x/y 会翻到对侧，画出来是个骗人的位置，
    // 所以宁可整个藏起来。
    if (this.tmp.z > 1) {
      this.hideRing();
      return;
    }
    const px = (this.tmp.x * 0.5 + 0.5) * w;
    const py = (-this.tmp.y * 0.5 + 0.5) * h;

    if (!this.ringShown) {
      this.ringShown = true;
      setShown(this.ringHold, true);
    }
    if (px !== this.ringX || py !== this.ringY) {
      this.ringX = px;
      this.ringY = py;
      const tr = `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0)`;
      setStyle(this.ringBtn, 'transform', tr);
      setStyle(this.ringLabel, 'transform', tr);
    }

    // 缩放 1.0 → 0.55，量化到 1/40。距离每帧都在变，不量化就是每帧一次
    // style 写入；1/40 的台阶在 9rem 的圆上是 3.6px，看不出来。
    const k = Math.round((1 - Math.min(nb.distance / 40, 1) * 0.45) * 40) / 40;
    if (k !== this.ringScale) {
      this.ringScale = k;
      setStyle(this.ring, 'transform', `scale(${k.toFixed(3)})`);
    }

    // 键位提示。铺子与回家各一套，**不复用打卡那套**——
    // 「打卡」和「进入小铺」是不同的事，标签含糊就等于没提示。
    //
    // ★ 可见文字**可能让位给屏幕下方那颗提示**：两者指向同一个动作时，
    //   同一件事在屏上只留一份字（圈指位置，提示说动作）。
    //   无障碍名照旧写全——读屏器念得到，而它不占视觉位置。
    const label = this.ringLabelFor(kind);
    const visible = ringLabelText(label, kind, this.promptKind);
    setText(this.ringLabel, visible);
    setShown(this.ringLabel, !!visible);
    // 圈内那个圆是纯装饰（它是 div 不是文字），所以按钮的可访问名走 aria
    setAttr(this.ringBtn, 'aria-label', label);
  }

  /**
   * 屏幕下方那颗提示正在说的是哪一族动作。
   *
   * 由 UI 层推过来（提示与圈都在 UI 里，UI 是唯一同时看得见两者的那一层）。
   * null = 提示没亮 → 圈上的字照旧。
   */
  setPromptKind(k: string | null): void {
    this.promptKind = k;
  }

  private hideRing(): void {
    if (!this.ringShown) return;
    this.ringShown = false;
    setShown(this.ringHold, false);
  }

  /**
   * 骑行节拍。
   *
   * **一个收缩的圈 + 五个点**，没有别的。
   *
   * 为什么不给文字：窗口只有 1.15s，而一行 4 个汉字的 toast 要读 1.5s——
   * 玩家会先读完再按，窗口早就过了。**一个会缩的圈比一行字快**，
   * 而且它能被余光读到，而这件事需要的恰恰是余光而不是注意力。
   *
   * 五个点是进度。节拍给旅币但**不给碎片**（见 `game/beat.ts` 的文件头），
   * 于是这个计数是这一件乐事唯一的可见痕迹——它得一直待在那儿。
   *
   * 圈用 CSS 变量 `--beat` 表示剩余比例，逐帧只改一个自定义属性，
   * 不重建 DOM：它在骑行中每帧都要动。
   */
  setBeat(s: { open: boolean; remain: number; hits: number; goal: number; done: boolean }): void {
    setShown(this.beatEl, !s.done);
    if (s.done) return;
    setFlag(this.beatEl, 'is-open', s.open);
    // **减弱动效时 `--beat` 停在一个固定值**，圈不再每帧收缩。
    //
    // 那是这个 HUD 里**唯一**一处持续运动，而它是收缩动画——
    // 前庭功能敏感者在 1.15 秒的窗口里盯着一个不断变小的环，
    // 是这一屏最容易引发不适的地方。而它降级之后**信息量不减**：
    // 圈亮着 = 窗口开着，那才是玩家要读的那一句；
    // "还剩多久"本来就不该靠盯着环来数（`beats` 的注释里也是这么写的）。
    this.beatEl.style.setProperty(
      '--beat',
      String(this.reduceMotion ? 0.5 : Math.max(0, Math.min(1, s.remain))),
    );
    for (let i = 0; i < this.beatDots.length; i++) {
      setFlag(this.beatDots[i], 'is-on', i < s.hits);
    }
  }

  /**
   * 路边躲避挑战的进度。
   *
   * `left` 是**还剩多少米**，不是比例。比例只在条上（`--dodge`），
   * 而字里那个数必须是米——玩家心里量的是"还有多远到木牌"，
   * 给一个 0.37 他没法知道自己什么时候能松一口气。
   *
   * 距离每帧都在变，字是 DOM 写入而不是 CSS 变量。所以**量化到 5 米一档**：
   * 每帧重写一次 textContent 会在弱机上变成一条真实的开销，
   * 而同一个字符串写了 60 次没人看得出来。
   */
  setDodge(v: { active: boolean; progress: number; left: number }): void {
    setShown(this.dodgeEl, v.active);
    if (!v.active) return;
    const p = Math.max(0, Math.min(v.progress, 1));
    this.dodgeEl.style.setProperty('--dodge', p.toFixed(3));
    const step = Math.max(0, Math.round(v.left / 5) * 5);
    const text = t('challenge_hud_left', { left: step });
    if (text !== this.dodgeLast) {
      this.dodgeLast = text;
      setText(this.dodgeText, text);
    }
  }
  private dodgeLast = '';

  /**
   * 圈上那行字。分派规则只在这一处，而 kind 来自 `interactAt()`——
   * 和宿主 `tryCheckIn()` 同一个函数，所以标签与动作不可能对不上。
   */
  private ringLabelFor(kind: InteractKind): string {
    if (kind === 'shop') return t(this.touchMode ? 'touch_shop_prompt' : 'desktop_shop_prompt');
    if (kind === 'home') return t('desktop_home_prompt');
    const nb = this.world.nearby;
    const revisited = this.game.getStationCount(nb.index) > 0;
    return this.touchMode
      ? revisited
        ? t('touch_revisit_button')
        : t('touch_checkin_prompt')
      : revisited
        ? t('desktop_revisit_prompt', { 0: nb.visitsLeft })
        : t('desktop_checkin_prompt');
  }

  // ---------------------------------------------------------------- 同步

  /** 从 game 重新读一遍所有显示。读档、买东西、打完卡、切语言之后调。 */
  sync(): void {
    // 构造时写死的三处静态文案：离路提示、碎片栏组头、节拍键帽。
    // 不在这里重贴的话，切完语言它们是旧语言——而「碎片」两个字
    // 在顶栏下面挂一整趟，是最容易被看出"只翻了一半"的一处。
    setText(this.offRoadEl, t('hud_road_no'));
    setText(this.fragsTitleEl, t('glossary_fragment'));
    setText(this.beatKey, t('key_relic'));
    this.syncTop(nextFragmentTarget(this.world, this.game));
    // 主线追踪器自己读 `game`（进度 / 完成 / 接没接），
    // 所以它只需要被告知"状态可能变了"。
    this.quest.sync();
    for (let s = 0; s < this.cells.length; s++) {
      const c = this.cells[s];
      const cnt = this.game.getStationCount(SLOT_TO_STATION[s]);
      setText(c.name, t(`fragment_${s}`));
      setText(c.cnt, t('frag_visit_count', [cnt, ECON.MAX_VISITS_PER_STATION]));
      c.box.title = t(`fragment_tip_${s}`);
      setFlag(c.box, 'is-got', this.game.isFragmentCollected(s));
      setFlag(c.box, 'is-full', cnt >= ECON.MAX_VISITS_PER_STATION);
      for (let k = 0; k < c.pips.length; k++) {
        setFlag(c.pips[k], 'is-on', k < cnt);
      }
    }
    // 小地图只重贴**无障碍名**（`aria-label`），不重画静态层：
    // `minimap.sync()` 只写一个属性，而 `syncFromState()` 是每公里
    // 调一次的——在这儿强制重画那 961 段路径才是浪费（见 minimap.ts
    // 的 signature()：它自己按状态签名决定什么时候重画）。
    this.minimap.sync();
  }

  setTouchMode(on: boolean): void {
    this.touchMode = on;
    this.syncRing();
  }

  dispose(): void {
    this.minimap.dispose();
    this.root.remove();
  }
}

/**
 * 让一个按钮用 Enter/Space 激活，并且**吃掉这次按键**。
 *
 * 为什么需要这一层：`main.ts` 在 window 上挂了一个全局 keydown，
 * 对 Space/Enter 调了 `e.preventDefault()` 然后自己去触发
 * 「当前阶段的确认动作」。而 `preventDefault()` 在 keydown 上会
 * **顺带吃掉原生按钮的激活**——于是 Tab 到「演示 · 90 秒」按空格，
 * 跑起来的不是演示，是 main 那个「标题页空格 = 开始旅程」。
 * 这个 bug 在键盘玩家手里表现为「有些按钮按空格没反应」，
 * 正好是本项目明令禁止的那一类。
 *
 * 这里在 keydown 阶段 `stopPropagation()`：事件不再冒泡到 window，
 * main 的监听器根本看不到这次按键，原生按钮激活照常发生。
 * 空格/Enter 之外一律不拦（Esc 归暂停、M 归静音、F8 归性能面板）。
 *
 * 第二件事顺带解决：焦点在这个按钮上时 main 的 onConfirm 不会被触发，
 * 所以不会出现「点一次按钮触发两次」。
 */
export function wireKeyActivate(btnEl: HTMLElement, fn: () => void): void {
  btnEl.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' && e.code !== 'Enter') return;
    // ⚠️ **不能**在这里无条件 `stopPropagation()`。
    //
    // 它当初解决的是 main 那个 window 冒泡监听器抢空格（见上面那段），
    // 而"目标阶段拦住、不再往上冒"正是这么写的。但目标阶段同时也是
    // **小游戏收键的那条路**：小游戏宿主也在 window 上挂监听，而它要的是
    // 空格（云落笔 / 茶注水 / 竹下刀）。
    //
    // 症状：玩家用空格打卡 → 圈按钮拿到焦点 → 打卡过场走完、小游戏开始，
    // 圈按钮仍然持有焦点 → 此后每一次空格都在这里被 `stopPropagation()` 截住，
    // **永远到不了小游戏**。而琴和禽用数字键，数字键不在这个名单里，
    // 于是它们照常能玩——正好是"**部分**游戏玩不了"。
    //
    // 所以这里改成**显式地问宿主**：宿主知道现在是暂停/结算页还是小游戏，
    // 只有前两者才需要独占空格。
    //
    // ⚠️ 但 `preventDefault()` **必须留着**，无条件留。
    // 它挡的是浏览器对 `<button>` 的原生激活（那会让空格在按钮上
    // 既触发这里、又冒到 main）。而 `stopPropagation()` 一旦放行，
    // 小游戏自己会对吃掉的键调 `preventDefault`（见 minigameHost），
    // 原生激活一样不会发生——两件事各管一段，合起来才对。
    if (spaceKeyOwnedHere()) e.stopPropagation();
    e.preventDefault();
    if (!e.repeat) fn();
  });
}

/**
 * `wireKeyActivate` 的**同一个** `stopPropagation` 判定，从宿主侧问过来。
 *
 * 拆成两个函数是因为上面那条在 UI 模块里，而相位在 `main.ts`：
 * 不传相位进来，UI 就没有判断依据，只能像原来那样无条件拦截。
 */
let spaceKeyOwner: () => boolean = () => true;

/** 由宿主在相位变化时装进来。见 `verify_ui_keys` 的判据。 */
export function setSpaceKeyOwner(fn: () => boolean): void {
  spaceKeyOwner = fn;
}

/** 这一屏现在要不要独占 Space/Enter。宿主答。 */
export function spaceKeyOwnedHere(): boolean {
  return spaceKeyOwner();
}
