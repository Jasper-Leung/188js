/**
 * DOM UI 层 —— 对外唯一入口。
 *
 * 原作的整个界面是 Godot `_draw()` 里一笔一笔画出来的：每帧重画，
 * 没有布局、没有焦点、没有可访问性。本模块是它在 Web 上的重新实现，
 * **照抄的是信息结构、判据和语气，不是像素**。
 *
 * ## 为什么用 DOM 而不是 canvas 画 HUD
 *
 * 一条只有像素的论据：这个游戏的目标机器是 2013 年前后的核显笔记本、
 * 4GB 内存、720p。DOM 界面由**浏览器合成器**处理，GPU 开销为 0——
 * 它不进 WebGL 的任何状态，不占一个 draw call，不占显存。
 * 而任何 canvas 绘制的 HUD 都要多一趟全屏 blit 或者一次状态切换，
 * 在填充率受限的核显上和「把渲染分辨率从 100% 降到 60%」是同一个量级
 * （0.6² = 36% 的像素）。再加一条：文字永远清晰。低档的 0.6 倍分辨率
 * 下，canvas 画的字会糊，而 DOM 里的字由浏览器按自己的字体栅格化，
 * **降的只是 3D 那张画布**。
 *
 * 唯一的例外是**小地图**（`minimap.ts`）——它要画的本来就是线，
 * DOM 画不出 961 段路径，用 canvas 2D 是对的。
 * 心神遮罩也**不是** canvas：它是一个纯色 div（见 `moodMask.ts`）。
 *
 * ## 阶段
 *
 * UI 自己不跳阶段，它只**显示**。`main.ts` 决定当前该显示哪一屏，
 * 然后调对应的 `showXxx()`。理由写在 main.ts 的文件头：整台机器只有
 * 那一处能改阶段，否则「一个面板关掉之后玩家落在哪一屏」会出幽灵状态。
 *
 * ## 每帧只改内容，不重建 DOM
 *
 * `update(dt)` 的全部工作就是：几处 `setText`（带缓存，内容没变就不写）、
 * 几处 `setStyle`（同样带缓存）、一次小地图重绘、一次遮罩透明度写入。
 * 没有任何一处创建或销毁节点。`dom.ts` 里连一个「按数据重建列表」的
 * 接口都没有，就是为了让这件事在类型层面做不到反着来。
 */
import './styles.css';

import { onLangChange, t } from '../i18n';
import { onTouchModeChange } from '../core/touch';
import type { Tier } from '../core/capability';
import type { World, WorldEvent } from '../world/world';
import type { GameStateManager } from '../game/state';
import type { Capability } from '../core/capability';
import { el, isShown, setShown, setStyle } from './dom';
import { TitleScreen } from './titleScreen';
import { Onboarding } from './onboarding';
import { Hud } from './hud';
import { Dialogue } from './dialogue';
import { ShopPanel } from './shopPanel';
import { PausePanel } from './pausePanel';
import { SynthesisPanel } from './synthesisPanel';
import { EndCard } from './endCard';
import { TouchControls } from './touchControls';
import { Toast } from './toast';
import { MoodMask } from './moodMask';
import { PerfPanel } from './perfPanel';

// ---------------------------------------------------------------- 接口

export interface UIHooks {
  onStart(): void;
  /**
   * 引导页结束、玩家真正进到世界里了。
   *
   * 这条 hook 存在是因为踩过一次很典型的坑：引导页的「开始骑行」原来直接调
   * `UI.enterWorld()`——UI 自己那个方法，**没有通知宿主**。于是宿主的
   * `phase` 永远停在 `'onboarding'`，而 `canRide = phase === 'roaming'`
   * 恒为假，车速被钉在 0。
   *
   * 症状极具欺骗性：HUD 在、小地图在、世界在转、演示模式能自己骑——
   * 只有"玩家推摇杆、按 W，车不动"。而键盘和摇杆走的是同一条链路，
   * 所以两个都失效，看起来像"输入系统坏了"。
   *
   * 教训落成一条约定：**改变游戏状态机的地方必须经过宿主**，
   * UI 只负责画。少一个 hook 不会报任何错，只会安静地让一个动词失效。
   */
  onWorldEntered(): void;
  onStartDemo(): void;
  onResume(): void;
  onRestart(): void;
  onFinishRun(): void;
  onQualityChange(tier: Tier): void;
  onAdaptiveChange(enabled: boolean, targetFps: number): void;
  onMuteChange(bgm: boolean, sfx: boolean, all: boolean): void;
  onLangToggle(): void;
  onCheckIn(): void;
  onShopBuy(goodId: string): void;
  onShopClose(): void;
  onTakePostcard(): void;
  onKeepRiding(): void;
  onEndingPick(ending: 'leave_door' | 'let_go'): void;
  onExportPostcard(side: 'front' | 'back'): void;
  onWriteBack(text: string): void;
}

export interface UIOptions {
  parent: HTMLElement;
  hooks: UIHooks;
  world: World;
  game: GameStateManager;
  capability: Capability;
  /**
   * 当前画质档。**可选**：不给就用 `capability.suggestedTier`。
   *
   * 宿主从 `settings.tier` 拿得到，而 `loadSettings()` 里可能存着玩家
   * 上一趟手动调过的档——那和探测结果不一样。少了这个字段，标题页和
   * 性能面板会把玩家自己的选择显示成"没被选中的那一档"，
   * 于是他刚点过高档、面板还写着低。
   */
  tier?: Tier;
  /** 自适应当前是否开着、目标帧率。宿主从 settings 拿。 */
  adaptiveOn?: boolean;
  adaptiveTarget?: number;
}

/** 宿主给的自适应目标默认值。和 `pausePanel.ts` 里的候选表保持一致。 */
const DEFAULT_ADAPTIVE_TARGET = 30;

/**
 * 正文字体的兜底注册。
 *
 * **正常情况下这段什么也不做**：`src/index.css`（宿主的文件）已经声明了
 * `@font-face { font-family: '188UI'; src: url('/fonts/ui.woff2') }`，
 * 所以下面第一个分支就会命中，走 `document.fonts.load()` 等那份字体到位。
 *
 * 那为什么还要写这一段？两个原因：
 *   1. **本目录不依赖别人的文件有没有写 @font-face。** `postcard/export.ts`
 *      为手写体做了同一件事（先 `check()` 再自己注册 FontFace），
 *      UI 这边跟着同一个约定：宿主把那段 CSS 删掉/改家族名，界面不会
 *      静默退回系统字体，而那在 720p 上是「所有字都难看了」而不是
 *      「报了个错」。
 *   2. **子路径部署。** 自己注册时用 `document.baseURI` 拼地址，
 *      跟着页面基准走；`index.css` 里那条 `/fonts/ui.woff2` 是绝对路径，
 *      在 `base: './'` 的子路径下会 404（index.html 的 preload 用的
 *      却是相对的 `fonts/ui.woff2`）。**这一条建议宿主改成相对路径。**
 *
 * 家族名 `188UI` 三处共用：`chrome.ts` 的 FONT_STACK 首项、
 * `styles.css` 里每一条 font-family、main.ts 的
 * `document.fonts.load('16px "188UI"')`。**不许在这里另写一个名字**。
 *
 * ⚠️ 时序：`main.ts` 的 `registerFonts()` 在 `new UI()` **之前**跑，
 * 那时 UI 的构造还没执行。靠 index.css 的 @font-face 的话它等得住
 * （声明在 CSS 里，样式表一解析就有了）；靠本函数注册的话它等不住，
 * 首屏会闪一次回退字形。所以本函数是兜底，不该被当成主路径。
 */
const UI_FONT_FAMILY = '188UI';
const UI_FONT_PATH = 'fonts/ui.woff2';

let uiFontPromise: Promise<boolean> | null = null;

/** 幂等：第一次真的去加载，之后复用同一个 Promise。 */
function ensureUiFont(): Promise<boolean> {
  if (uiFontPromise) return uiFontPromise;
  uiFontPromise = (async () => {
    if (typeof document === 'undefined' || !document.fonts) return false;
    try {
      if (document.fonts.check(`16px "${UI_FONT_FAMILY}"`)) {
        await document.fonts.load(`16px "${UI_FONT_FAMILY}"`);
        return true;
      }
      if (typeof FontFace === 'undefined') return false;
      const url = new URL(UI_FONT_PATH, document.baseURI).href;
      const face = new FontFace(UI_FONT_FAMILY, `url("${url}")`);
      await face.load();
      document.fonts.add(face);
      await document.fonts.load(`16px "${UI_FONT_FAMILY}"`);
      return true;
    } catch {
      // 字体拿不到就用系统字体：字会难看一点，而游戏照跑。
      // 抛出去的话标题页直接白屏，那比字难看严重得多。
      return false;
    }
  })();
  return uiFontPromise;
}


/**
 * 黄昏变量 `--dusk` 的刷新周期（秒）。
 *
 * 这个 CSS 变量会牵动**所有面板的纸色**（styles.css 里是
 * `rgb(calc(...) calc(...) calc(...))`），所以每帧写它就是每帧一次
 * 全树的样式重算——在弱机上那是一笔真实的开销，而 dusk 一秒钟才变
 * 几个百分点。0.25s 一次，视觉上是一条平滑的斜坡。
 */
const DUSK_PERIOD = 0.25;

// ---------------------------------------------------------------- 类

export class UI {
  readonly root: HTMLDivElement;
  /**
   * 触屏输入意图。**就是** `TouchControls` 持有的那一个对象，
   * 不是副本——所以宿主把 `checkInPressed` 清成 false 时，
   * 清的是摇杆那一次按下留下的那一位。
   */
  readonly touch: { moveX: number; moveY: number; checkInPressed: boolean };

  private opts: UIOptions;
  private hooks: UIHooks;
  private world: World;
  private game: GameStateManager;

  private tier: Tier;
  private adaptiveOn: boolean;
  private adaptiveTarget: number;
  private touchMode: boolean;

  private title: TitleScreen;
  private onboarding: Onboarding;
  private hud: Hud;
  private dialogue: Dialogue;
  /** 当前这段对白的完成信号。见 whenDialogueIdle() */
  private dialogueIdle: Promise<void> = Promise.resolve();
  private shop: ShopPanel;
  private pause: PausePanel;
  private synthesis: SynthesisPanel;
  private endCard: EndCard;
  private touchCtl: TouchControls;
  private toast: Toast;
  private mood: MoodMask;
  private perf: PerfPanel;

  private duskT = 0;
  private lastDusk = -1;
  private worldVisible = false;
  private unbindLang: (() => void) | null = null;
  private unbindTouch: (() => void) | null = null;
  private disposed = false;

  constructor(opts: UIOptions) {
    this.opts = opts;
    this.hooks = opts.hooks;
    this.world = opts.world;
    this.game = opts.game;
    this.tier = opts.tier ?? opts.capability.suggestedTier;
    this.adaptiveOn = opts.adaptiveOn ?? false;
    this.adaptiveTarget = opts.adaptiveTarget ?? DEFAULT_ADAPTIVE_TARGET;
    this.touchMode = false;

    this.root = el('div', 'g-root');
    this.root.setAttribute('aria-live', 'off');
    opts.parent.appendChild(this.root);

    // ---- 顺序就是层序：遮罩在最底，面板在中间，触屏在最上 ----
    // 心神遮罩必须压在 3D 画布之上、UI 之下：世界暗下去，而要读的字不变暗。
    // 同一个 root 内部的绘制顺序靠这个 append 顺序决定，所以它是语义的一部分。
    this.mood = new MoodMask(this.root, this.game);
    this.toast = new Toast(this.root);
    this.dialogue = new Dialogue(this.root);
    this.hud = new Hud(this.root, {
      world: this.world,
      game: this.game,
      onCheckIn: () => this.hooks.onCheckIn(),
    });
    this.shop = new ShopPanel({
      parent: this.root,
      hooks: this.hooks,
      game: this.game,
    });
    this.pause = new PausePanel({
      parent: this.root,
      hooks: this.hooks,
      tier: this.tier,
      adaptiveOn: this.adaptiveOn,
      adaptiveTarget: this.adaptiveTarget,
    });
    this.synthesis = new SynthesisPanel({
      parent: this.root,
      hooks: this.hooks,
      game: this.game,
    });
    this.endCard = new EndCard({
      parent: this.root,
      hooks: this.hooks,
      game: this.game,
      toast: this.toast,
    });
    this.title = new TitleScreen({
      parent: this.root,
      hooks: this.hooks,
      capability: opts.capability,
      tier: this.tier,
    });
    this.onboarding = new Onboarding({
      parent: this.root,
      // 走 hook，不直接调本类的 enterWorld()——见 UIHooks.onWorldEntered 的注释
      onStart: () => this.hooks.onWorldEntered(),
      touch: this.touchMode,
    });
    this.touchCtl = new TouchControls({
      parent: this.root,
      hooks: this.hooks,
      world: this.world,
      game: this.game,
    });
    this.touch = this.touchCtl.state;
    this.perf = new PerfPanel({ parent: this.root, world: this.world, tier: this.tier });

    // 触屏判定是**活的**：玩家第一次用手指碰屏、手机转个屏、
    // 或者在暂停面板里把三态从"自动"拨到"开"，都要立刻反映到控件上。
    // 挂上监听就够——判定本身在 core/touch.ts，这里只负责把它接到 DOM。
    this.unbindTouch = onTouchModeChange((on) => this.setTouchMode(on));

    this.unbindLang = onLangChange(() => this.syncFromState());
    this.syncFromState();
    this.pushDusk(true);
    void ensureUiFont();
  }

  // ---------------------------------------------------------------- 阶段

  private setWorldVisible(v: boolean): void {
    if (this.worldVisible === v) return;
    this.worldVisible = v;
    setShown(this.hud.root, v);
    // 触屏控件跟着 HUD 一起进出世界。
    // 标题页/引导页上摆一个活的摇杆是有害的：那里点它什么也不会发生，
    // 而摇杆长得又很像"可以拖"，于是玩家会在标题页上推两下、发现没反应、
    // 得出"这游戏在手机上玩不了"的结论。**控件不出现，就不会被误试。**
    this.applyTouchVisibility();
  }

  showTitle(): void {
    this.title.show();
    this.onboarding.hide();
    this.setWorldVisible(false);
    this.hidePanels();
  }

  /**
   * 引导页。
   *
   * ⚠️ 这一页的出口**必须走 hook**（`UIHooks.onWorldEntered`），不能直接调
   * 本类的 `enterWorld()`。原因写在那个 hook 的注释里：漏掉的话宿主的
   * `phase` 会停在 'onboarding'，车不响应输入，而界面上没有任何异常。
   *
   * 这里是当初没接上的地方，留着这段说明是因为它很容易被"顺手改回去"——
   * 看起来 `this.enterWorld()` 更直接，而且对 UI 自己来说完全等价。
   */
  showOnboarding(): void {
    this.title.hide();
    this.onboarding.show();
    this.setWorldVisible(false);
    this.hidePanels();
  }

  /**
   * 标题/引导结束，进入世界 HUD。**由宿主调用**（`App.enterWorld()`），
   * 不要从 UI 内部直接调——那样会绕过宿主的阶段机。
   */
  enterWorld(): void {
    this.title.hide();
    this.onboarding.hide();
    this.setWorldVisible(true);
    this.hidePanels();
    this.hud.sync();
  }

  private hidePanels(): void {
    this.pause.hide();
    this.synthesis.hide();
    this.endCard.hide();
    this.shop.close();
  }

  showPause(): void {
    this.pause.show();
  }

  hidePause(): void {
    this.pause.hide();
  }

  showSynthesis(mode: 'chapter' | 'maxed' | 'plain' = 'plain'): void {
    this.synthesis.show(mode);
  }

  showEndCard(): void {
    this.setWorldVisible(false);
    this.hidePanels();
    this.endCard.show();
  }

  // ---------------------------------------------------------------- 每帧

  /**
   * 每帧调。**dt 可能恒为 0**：main 在 `GameLoop` 的 `onStats` 里写的是
   * `onStats: (fps, ms) => this.ui.update(0)`，每 0.5 秒会多来一次 dt=0
   * 的调用（顺带把 fps/ms 丢了，见 perfPanel.ts 的注释）。
   * 所以这里所有用到 dt 的地方都要能接受 0，而帧率统计必须自己数真帧。
   */
  update(dt: number): void {
    if (this.disposed) return;
    this.duskT += dt;
    if (this.duskT >= DUSK_PERIOD) {
      this.duskT = 0;
      this.pushDusk(false);
    }
    this.hud.update(dt);
    this.dialogue.update(dt);
    this.toast.update(dt);
    this.mood.update(dt);
    this.perf.update(dt);
    // 触屏控件的可用态跟着脚下那一圈走，宿主有没有开触屏模式都一样算——
    // 开着的时候它是一次 setText/setFlag（都带缓存），不开的时候
    // 整个层是 display:none，这一次调用的代价可以忽略。
    this.touchCtl.sync();
  }

  /**
   * 把黄昏推进度写进 CSS 变量。
   *
   * `--dusk` 是 0..1，styles.css 里所有面板纸色都由它算出来
   * （见 theme.ts 的 PAPER_DAY / PAPER_DUSK）。不这么做的后果很具体：
   * 黄昏时世界整个压暗，一块没压的纸色面板浮在上面会亮得刺眼，
   * 而**面板与背景的对比度反而比日间更高**——那是把「这里最重要」
   * 这个信号反着发。
   */
  private pushDusk(force: boolean): void {
    const d = this.world.sky.state.dusk;
    // 量化到 1/32：太阳一秒钟压下去几度，1/32 的台阶看不出来，
    // 而它让「值没变就不写」这条缓存真的能生效。
    const q = Math.round(Math.min(Math.max(d, 0), 1) * 32) / 32;
    if (!force && q === this.lastDusk) return;
    this.lastDusk = q;
    setStyle(this.root, '--dusk', q.toFixed(3));
  }

  // ---------------------------------------------------------------- 事件

  /**
   * 世界事件。
   *
   * ⚠️ `main.ts` 目前**自己**处理全部世界事件（对白、黄昏提示、开铺子），
   * 没有把它们转发到这里。所以本方法是备着的——它必须和 main 现有的
   * 行为**不重复**，否则哪天被转发过来的那一刻，玩家会看到两条一样的提示：
   *
   * · `dialogue` —— 播对白（main 也直接调 `showDialogue`，效果一致，不冲突）
   * · `stationPassed` —— 让小地图重画静态层。
   *   这一条**不是可有可无的冗余**：小地图另有一层自检（`signature()`，
   *   见 minimap.ts），所以即使永远不被转发，图也不会停在开局。
   *   留着这条是让它在被转发时少一次一帧的延迟。
   * · `duskBegan` —— **不弹提示**，那条由 main 弹（弹两条会重复）
   * · `villain` / `loaded` —— 不需要 UI 动作
   */
  onWorldEvent(e: WorldEvent): void {
    switch (e.type) {
      case 'dialogue':
        void this.showDialogue(e.speaker, e.lines);
        break;
      case 'stationPassed':
        // 「到过 = 实心」是那张图唯一的编码，错过一次刷新就是一个整局
        this.hud.minimap.markDirty();
        break;
      case 'duskBegan':
      case 'villain':
      case 'loaded':
        break;
    }
  }

  /** 播对白，返回 Promise，播完 resolve。空格/点击推进，Esc 一次跳完。 */
  showDialogue(speaker: string, lines: string[]): Promise<void> {
    const p = this.dialogue.show(speaker, lines);
    this.dialogueIdle = p;
    return p;
  }

  /**
   * 等当前这段对白念完。已经在念就等它，没在念立刻返回。
   *
   * 存在的理由：过场镜头（1.0s 移动 + 1.5s 停留 + 0.4s 收尾）与对白
   * 是**两条独立的时序**。镜头走完时对白往往还没念完（正常速度下要玩家点），
   * 而此时如果直接弹合成面板，主循环一停玩家就没法再点了——
   * 于是那三句"你回来了"会卡在半截，然后被面板盖住。
   */
  whenDialogueIdle(): Promise<void> {
    return this.dialogueIdle;
  }

  showToast(text: string, ms?: number): void {
    this.toast.show(text, ms);
  }

  // ---------------------------------------------------------------- 同步

  /**
   * 从 game 状态重新同步所有显示。
   *
   * 读档、买东西、打完卡、换语言、宿主改完画质之后调。
   * 它是**唯一**的刷新入口——所以每一块都必须提供 `sync()`，
   * 而不是各自去读 game。
   *
   * ⚠️ 调用频率比看上去高得多：`main.ts` 在 `game.on('lvbi')` 上挂了它，
   * 而 `earnKm()` **每跨一整公里**触发一次——不是每次发钱，是每公里。
   * 所以
   *   · 常驻的（HUD / 触屏 / 遮罩 / 性能面板）无条件同步，全是带缓存的
   *     文本写入，代价约等于零；
   *   · 面板类的一律**先看它是不是开着**。引导页的 `sync()` 会
   *     `replaceWith()` 重建整份操作说明，小地图的静态层要重画 961 段
   *     路径——为一块 `display:none` 的东西做这些，纯粹是浪费。
   */
  /**
   * 对白自动推进（演示模式用）。0 = 靠玩家按键。
   *
   * 存在的唯一理由：演示里没有人按键，而对白是靠按键推进的。
   * 不开这个，演示会在第一句对白上永远停住——车跟着不动，
   * 而每一处代码都跑得好好的，看起来像"演示坏了"。
   */
  setDialogueAutoAdvance(sec: number): void {
    this.dialogue.setAutoAdvance(sec);
  }

  syncFromState(): void {
    if (this.disposed) return;    // 常驻部分
    this.hud.sync();
    this.touchCtl.sync();
    this.mood.sync();
    this.perf.setTier(this.tier);
    this.pushDusk(true);
    // 面板部分：只看开着的那一块
    if (isShown(this.shop.root)) this.shop.refresh();
    if (isShown(this.pause.root)) this.pause.sync();
    if (isShown(this.synthesis.root)) this.synthesis.sync();
    if (isShown(this.endCard.root)) this.endCard.sync();
    if (isShown(this.title.root)) this.title.sync();
    if (isShown(this.onboarding.root)) this.onboarding.sync();
    this.dialogue.sync();
  }

  /** 宿主把画质/自适应改回去了（读档、onQualityChange 之后）。 */
  setQuality(tier: Tier, adaptiveOn?: boolean, adaptiveTarget?: number): void {
    this.tier = tier;
    if (adaptiveOn !== undefined) this.adaptiveOn = adaptiveOn;
    if (adaptiveTarget !== undefined) this.adaptiveTarget = adaptiveTarget;
    this.title.setTier(tier);
    this.pause.setQuality(tier, this.adaptiveOn, this.adaptiveTarget);
    this.perf.setTier(tier);
  }

  // ---------------------------------------------------------------- 性能面板

  setPerfVisible(v: boolean): void {
    this.perf.setVisible(v);
  }

  togglePerf(): void {
    this.perf.toggle();
  }

  // ---------------------------------------------------------------- 铺子

  /** 打开/关闭铺子面板。铺名取 `world.nearby.shopName`。 */
  setShopOpen(open: boolean): void {
    if (!open) {
      this.shop.close();
      return;
    }
    const name = this.world.nearby.shopName;
    if (!name) return;
    this.shop.open(name);
  }

  // ---------------------------------------------------------------- 触屏

  /** 触屏控件开关（由 main 根据 `pointer: coarse` 决定）。 */
  setTouchMode(on: boolean): void {
    this.touchMode = on;
    this.onboarding.setTouch(on);
    this.hud.setTouchMode(on);
    this.applyTouchVisibility();
  }

  /** 触屏控件 = 判定为触屏 **且** 已经进到世界里。两个条件都要。 */
  private applyTouchVisibility(): void {
    this.touchCtl.setMode(this.touchMode && this.worldVisible);
  }
  get isTouchMode(): boolean {
    return this.touchMode;
  }

  // ---------------------------------------------------------------- 收尾

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unbindLang?.();
    this.unbindLang = null;
    this.unbindTouch?.();
    this.unbindTouch = null;
    this.dialogue.dispose();
    this.hud.dispose();
    this.shop.dispose();
    this.pause.dispose();
    this.synthesis.dispose();
    this.endCard.dispose();
    this.touchCtl.dispose();
    this.toast.dispose();
    this.mood.dispose();
    this.perf.dispose();
    this.title.dispose();
    this.onboarding.dispose();
    this.root.remove();
  }

  /** 存档/难度相关的只读出口，给调试窗口用。 */
  get info() {
    return {
      tier: this.tier,
      worldVisible: this.worldVisible,
      dusk: this.lastDusk,
      lang: t('language_current'),
      game: this.game,
      opts: this.opts,
    };
  }
}
