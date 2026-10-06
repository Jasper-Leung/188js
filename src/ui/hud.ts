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
 */
import { Vector3 } from 'three';
import { STATIONS } from '../data/route';
import { ECON, ROAD, ROADMESH, WORLD } from '../data/raw';
import { t, stationNameOf } from '../i18n';
import { Minimap } from './minimap';
import { button, el, setAttr, setFlag, setShown, setStyle, setText } from './dom';
import { FRAGMENT_COLORS } from './theme';
import type { World } from '../world/world';
import { GameStateManager } from '../game/state';
import { interactAt, type InteractKind } from '../game/phase';

/**
 * 8 向箭头，索引 0 = 正前方，顺时针递增。
 * 抄自 `HUD3D.gd` 的 `ARROWS`——那边的注释写着「字体 LXGW 覆盖这几个码位」，
 * 也就是这 8 个字形是字体子集里**特意留的**。换成 emoji 箭头（⬆️ 之类）
 * 会让它们掉出子集，首屏多下一份字体去补 4 个字形。
 */
const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'] as const;

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
 * 必须相对车头而不是罗盘北：8 字自闭合，两个方向都能到全部五座，
 * 骑反了「下一处 · 84m」会一直是 84m，而玩家在交叉点上完全看不出自己
 * 骑反了。这是原作 `_arrow_glyph()` 注释的原话，判据一字不改。
 */
function arrowGlyph(dx: number, dz: number, fx: number, fz: number): string {
  // 约定方位角 a(v) = atan2(x, -z)：正前方（-Z）是 0、正右方（+X）是 +π/2。
  // 相减即「目标相对车头偏了几度」，向右为正。
  const rel = Math.atan2(dx, -dz) - Math.atan2(fx, -fz);
  const wrapped = Math.atan2(Math.sin(rel), Math.cos(rel)); // wrap 到 [-π, π]
  const i = Math.round(wrapped / (Math.PI / 4));
  return ARROWS[((i % 8) + 8) % 8];
}

// ---------------------------------------------------------------- 碎片栏

interface FragCell {
  box: HTMLDivElement;
  name: HTMLSpanElement;
  cnt: HTMLSpanElement;
  pips: HTMLSpanElement[];
}

export interface HudOpts {
  world: World;
  game: GameStateManager;
  onCheckIn: () => void;
}

export class Hud {
  readonly root: HTMLDivElement;
  readonly minimap: Minimap;

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

  // 碎片栏
  private fragCountEl: HTMLSpanElement;
  private cells: FragCell[] = [];

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
  private ringX = NaN;
  private ringY = NaN;
  private ringScale = NaN;

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
    top.appendChild(this.nextEl);
    this.root.appendChild(top);

    // ---------------- 碎片栏 ----------------
    const fb = el('div', 'g-frags');
    const fh = el('div', 'g-frags-h');
    fh.appendChild(el('span', 'g-frags-title', t('glossary_fragment')));
    this.fragCountEl = el('span', 'g-frags-n');
    fh.appendChild(this.fragCountEl);
    fb.appendChild(fh);

    const strip = el('div', 'g-frags-row');
    for (let s = 0; s < 5; s++) strip.appendChild(this.buildCell(s));
    fb.appendChild(strip);
    this.root.appendChild(fb);

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

    // ---------------- 小地图 ----------------
    this.minimap = new Minimap(this.root, this.world, this.game);

    parent.appendChild(this.root);
    this.sync();
  }

  private buildCell(slot: number): HTMLDivElement {
    const box = el('div', 'g-frag');
    const swatch = el('span', 'g-frag-sw');
    // 颜色只做底，汉字单独用墨色画在上面（见 styles.css 的 .g-frag-sw）：
    // 竹那一格在小地图上是深色，压在纸色上会变成一个小黑洞。
    swatch.style.setProperty('--sw', FRAGMENT_COLORS[slot]);
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

    this.cells.push({ box, name, cnt, pips });
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
  private syncTop(target: NextTarget | null): void {
    setText(this.seenEl, t('stations_seen', { 0: this.game.getSeenStationCount() }));
    setText(this.lvbiEl, t('lvbi_label', { 0: this.game.lvbi }));
    setText(this.moodEl, t('mood_label', { 0: this.game.mood, 1: ECON.MOOD_CEIL }));
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

    // 集齐五件之后，导航指向**十八驿**而不是任何一座碎片驿站。
    // 这是第一章唯一的收尾动作，所以它必须占住「下一处」这一格——
    // 那一格是玩家屏幕上唯一会持续指示"我该去哪"的地方。
    if (this.game.objective === 'return') {
      const home = STATIONS[GameStateManager.HOME_STATION];
      const p = this.world.ride.pos;
      const f = this.world.ride.forward;
      const arrow = arrowGlyph(home.x - p.x, home.z - p.z, f.x, f.z);
      const dist = Math.floor(Math.hypot(home.x - p.x, home.z - p.z));
      setText(this.nextEl, t('hud_home_target', { 0: arrow, 1: dist }));
      setFlag(this.nextEl, 'is-home', true);
      return;
    }
    setFlag(this.nextEl, 'is-home', false);

    if (!target) {
      setText(this.nextEl, t('hud_all_done'));
      setFlag(this.nextEl, 'is-done', true);
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
      setText(
        this.nextEl,
        t('hud_revisit_target', { 0: name, 1: arrow, 2: t('visits_left_n', { 0: left }) }),
      );
    } else {
      // 原作是 int(dist)，**向下取整**。取整而不是四舍五入是有意义的：
      // 数字往上跳会让人以为"刚刚近了很多"，而这一栏每帧都在跳。
      setText(this.nextEl, t('hud_next_target', { 0: name, 1: arrow, 2: Math.floor(target.dist) }));
    }
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
      reach: WORLD.STATION_PASS_RADIUS + ROADMESH.TOTAL_HALF_WIDTH,
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
    const label = this.ringLabelFor(kind);
    setText(this.ringLabel, label);
    // 圈内那个圆是纯装饰（它是 div 不是文字），所以按钮的可访问名走 aria
    setAttr(this.ringBtn, 'aria-label', label);
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
    this.beatEl.style.setProperty('--beat', String(Math.max(0, Math.min(1, s.remain))));
    for (let i = 0; i < this.beatDots.length; i++) {
      setFlag(this.beatDots[i], 'is-on', i < s.hits);
    }
  }

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
    this.syncTop(nextFragmentTarget(this.world, this.game));
    setText(this.fragCountEl, t('fragments', { 0: this.game.getCollectedCount() }));
    for (let s = 0; s < this.cells.length; s++) {
      const c = this.cells[s];
      const cnt = this.game.getStationCount(SLOT_TO_STATION[s]);
      setText(c.name, t(`fragment_${s}`));
      setText(c.cnt, t('postcard_visit_n', { 0: cnt }));
      c.box.title = t(`fragment_tip_${s}`);
      setFlag(c.box, 'is-got', this.game.isFragmentCollected(s));
      setFlag(c.box, 'is-full', cnt >= ECON.MAX_VISITS_PER_STATION);
      for (let k = 0; k < c.pips.length; k++) {
        setFlag(c.pips[k], 'is-on', k < cnt);
      }
    }
    // 这里**不**去 `minimap.sync()`：小地图自己按状态签名比对
    // （见 minimap.ts 的 signature()），而 `syncFromState()` 是每公里
    // 调一次的——在这儿强制重画，等于每 40 秒白画一次 961 段路径。
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
