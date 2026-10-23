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
import { audio } from '../core/audio';
import type { Tier } from '../core/capability';
import type { World, WorldEvent } from '../world/world';
import type { GameStateManager } from '../game/state';
import type { Capability } from '../core/capability';
import { bindTouchButtons, el, isShown, setShown, setStyle } from './dom';
import { TitleScreen } from './titleScreen';
import { Onboarding } from './onboarding';
import { Hud } from './hud';
import { Dialogue, type DialogueLines } from './dialogue';
import { ShopPanel } from './shopPanel';
import { PausePanel } from './pausePanel';
import { PostcardPanel } from './postcardPanel';
import { SynthesisPanel } from './synthesisPanel';
import { EndCard } from './endCard';
import { TouchControls } from './touchControls';
import { Toast, type ToastKind } from './toast';
import { LakesidePanel } from './lakesidePanel';
import type { LakesideFrame } from '../world/lakeside';
import { HudVisibility } from './visibility';
import { ItemBar } from './itemBar';
import { InteractPrompt, type PromptState } from './interactPrompt';
import { RadialMenu, type RadialItem } from './radialMenu';
import { StoryCards, ResultCard, setNarrativeQuiet, type SettleOutcome } from './storyCard';
import { WorldVisibility } from '../game/phase';
import { MoodMask } from './moodMask';
import { PerfPanel } from './perfPanel';

// ---------------------------------------------------------------- 接口

export interface UIHooks {
  onStart(): void;
  /**
   * 标题页的「继续旅程」：跳过引导页，直接回到世界。
   *
   * 它和 `onStart` 的区别只有"要不要再看一遍那四个词"——存档在 `ready()`
   * 阶段就读进来了，序章也因为 `prologueDone` 不会重播。
   * 单独一个 hook 而不是复用 `onStart`，是因为"从头"和"接着"对玩家是
   * 两件不同的事，**共用一个动词会让标题页没法把它们分开摆**。
   */
  onContinue(): void;
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
  /**
   * 无障碍那一组。**一个 hook 传全部，而不是四个**。
   *
   * 四个 hook 会让宿主那边出现四个各自落盘、各自 `syncFromState()` 的回调，
   * 而这四项是**同一个 `SettingsData`**——分开传迟早出现"改了配色没落盘、
   * 重开又变回去"。一个动作对象配一次 `saveSettings()`，是唯一的口径。
   *
   * `keymap` 只在**改键**时传；音量滑块每拖一下都调一次，
   * 所以音量走 `onVolumeChange` 而不塞进这里（它不需要落盘那么频繁）。
   */
  onAccessibilityChange(patch: {
    volBgm?: number;
    volSfx?: number;
    colorblind?: boolean;
    reduceMotion?: boolean;
    holdToToggle?: boolean;
  }): void;
  /**
   * 音量**提交**。与上面那个的区别只有一条：**要不要落盘**。
   *
   * 滑块的 `input` 事件在拖动过程中每帧都发（实测 60Hz），
   * 在那上面写 `localStorage` 会在弱机上造成可测量的卡顿——
   * 而一次 `saveSettings()` 是整份 `SettingsData` 的序列化。
   * `change` 事件在松手时发一次，所以音量走它。
   *
   * ⚠ **这条钩子曾经只存在于一条注释里**：注释写着"音量由 `onVolumeCommit`
   * 在松手时落一次"，而 `onVolumeCommit` 全仓库没有实现，于是
   * `settings.volBgm` 从不被赋值，`saveSettings()` 每次写回旧值——
   * **玩家调完音量，关掉标签页就丢**。
   * 注释比代码完整比没有注释更糟：它让读代码的人以为这一段已经做完了。
   */
  onVolumeCommit(volBgm: number, volSfx: number): void;
  onKeymapChange(keymap: Record<string, string>): void;
  onLangToggle(): void;
  onCheckIn(): void;
  onShopBuy(goodId: string): void;
  onShopClose(): void;
  onTakePostcard(): void;
  onKeepRiding(): void;
  onEndingPick(ending: 'leave_door' | 'let_go'): void;
  onExportPostcard(side: 'front' | 'back'): void;
  onWriteBack(text: string): void;
  /**
   * 关掉结算页，**回到世界**，这一趟的进度原样留着。
   *
   * 它和 `onRestart` 是两件事，别混：后者走 `resetRun()` 把这一趟清干净，
   * 而这一页原来**只有那一个出口**——玩家按了暂停里的「结束这一趟 · 收下明信片」
   * 之后，剩下的是"丢掉全部进度重来"或者"刷新页面"。
   *
   * 和相位的关系写在 `main.ts` 的 `closeEndCard()` 里：结算页的相位是
   * `endcard`，而暂停面板那两个动词各自要求 `paused` / `roaming`，
   * 所以这一条不能靠复用它们实现。
   */
  onCloseEndCard(): void;
  /**
   * 玩家点了湖边那一屏的「戴上头显」。
   *
   * ## 为什么它必须是宿主来做
   *
   * `navigator.xr.requestSession()` 要**用户激活**，而用户激活只在点击回调
   * 那一小段时间里有效——所以这一路是"点击 → 宿主 → `XrSession.enter()`"，
   * 中间不能 `await` 任何别的东西。UI 自己开不了会话：它拿不到渲染器，
   * 而 `gl.xr.setSession()` 是会话真正生效的那一步。
   *
   * 按钮**只在 `isSessionSupported('immersive-vr')` 为真时出现**
   * （宿主调 `setLakesideVr()`），所以这个 hook 被调用时机器一定是支持的。
   */
  onVrRequest(): void;
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
  /**
 * 触屏输入意图。**不是副本**：`TouchControls.state` 本体，
 * 所以宿主清掉 `checkInPressed` 清的就是控制器那一个字段。
 *
 * `holdPressed` 是给"按住"用的动词（钓鱼收线、云、茶）——
 * 没有它，触屏上根本没有"按住"这个动作。
 */
readonly touch: {
  moveX: number;
  moveY: number;
  checkInPressed: boolean;
  holdPressed: boolean;
};

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
  private postcard: PostcardPanel;
  private synthesis: SynthesisPanel;
  private endCard: EndCard;
  private touchCtl: TouchControls;
  private toast: Toast;
  private lakeside!: LakesidePanel;
  private itemBar!: ItemBar;
  /** 交互提示。**够得着才在**（见 interactPrompt.ts 的文件头）。 */
  private prompt!: InteractPrompt;
  /** Tab 转盘。宿主给条目，UI 只负责画与收键。 */
  private radial!: RadialMenu;
  /** 转盘当前那一圈条目。切语言时用它重画（名字是函数，跟着语言走）。 */
  private radialItems: RadialItem[] = [];
  private visibility!: HudVisibility;
  private storyCards!: StoryCards;
  private resultCard!: ResultCard;
  private mood: MoodMask;
  private perf: PerfPanel;

  private duskT = 0;
  private lastDusk = -1;
  /**
   * 世界 HUD 的可见性状态。**初值"可见"是对的**——DOM 里的 HUD 构造出来就在，
   * 而第一次 `setWorldVisible(false)` 必须真的执行（`showTitle()` 就靠它），
   * 所以这个类把「第一次必生效」写进了规则，而不是靠初始值碰巧对上。
   * 原因见 `game/phase.ts` 的 `WorldVisibility`。
   */
  private readonly worldVis = new WorldVisibility();
  private unbindLang: (() => void) | null = null;
  private unbindTouch: (() => void) | null = null;
  private disposed = false;
  private colorblind = false;
  private reduceMotion = false;
  private holdToToggle = false;
  private lakesideOn = false;
  private hudControlsEnabled = true;
  private unbindTouchButtons: () => void;

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
    this.unbindTouchButtons = bindTouchButtons(this.root);
    opts.parent.appendChild(this.root);

    // ---- 顺序就是层序：遮罩在最底，面板在中间，触屏在最上 ----
    // 心神遮罩必须压在 3D 画布之上、UI 之下：世界暗下去，而要读的字不变暗。
    // 同一个 root 内部的绘制顺序靠这个 append 顺序决定，所以它是语义的一部分。
    this.mood = new MoodMask(this.root, this.game);
    this.toast = new Toast(this.root);
    // 湖边读数。**它不属于 `isInWorld()`**，所以收放由宿主显式调
    // `setLakeside()` / `hideLakeside()`，而不是跟着世界可见性走。
    this.lakeside = new LakesidePanel(this.root, () => this.hooks.onVrRequest());
    this.itemBar = new ItemBar(this.root);
    this.storyCards = new StoryCards(this.root);
    this.resultCard = new ResultCard(this.root);
    this.dialogue = new Dialogue(this.root);
    this.hud = new Hud(this.root, {
      world: this.world,
      game: this.game,
      onCheckIn: () => this.hooks.onCheckIn(),
    });
    // 交互提示与转盘**在 HUD 之后构造**：它们是浮在骑行画面上的那一层，
    // 必须压在 HUD 上面；而面板（`.g-screen`，z-index 50）仍然在它们上面
    // （转盘 40 / 提示 12），所以「暂停面板开着时底下不该有提示」
    // 是结构上成立的，而不是靠谁记得先关掉它。
    this.prompt = new InteractPrompt(this.root, {
      // ★ 叙事段落在场时，这颗提示让路（前景在前，背景让路）。
      //
      // 闸门做在提示组件自己身上，而不是宿主每帧判断：
      // 宿主那一层要同时拿到「有没有叙事段落」与「有没有可交互的东西」，
      // 漏判一次就是屏上两颗药丸叠在一起（手机横屏时它们真的重叠，
      // 而提示的层级更高，点下去会打到提示而不是叙事卡的按钮）。
      //
      // 这里传的是 `this.storyBusy`——**屏上有叙事卡，或叙事队列还没空**。
      // `storyCards` 在本类里比 `prompt` 先构造（见上面），所以这个闭包
      // 被调用时它一定已经就位。
      blocked: () => this.storyBusy,
    });
    this.radial = new RadialMenu(this.root);
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
      onLookPostcard: () => this.lookPostcard(),
    });
    // 无障碍那一组灌一次初值。它读的是 `SettingsData` 的同一份数字，
    // 而宿主在构造 `App` 时就把它们推进 `audio` 了——
    // 于是面板上看到的滑块位置与真正发出来的音量**必然一致**。
    this.pause.setAccessibilityState({
      volBgm: audio.volume.bgm,
      volSfx: audio.volume.sfx,
      colorblind: this.colorblind,
      reduceMotion: this.reduceMotion,
      holdToToggle: this.holdToToggle,
    });
    // 必须在暂停面板之后构造：两者都是铺满全屏的 `.g-screen`，
    // 同层叠放的先后由 `.g-root` 里的 append 顺序决定，构造早了就被压在下面。
    this.postcard = new PostcardPanel({
      parent: this.root,
      onClose: () => {
        // 先把这一页自己关掉：`pause.show()` 只管把暂停亮起来，
        // 不负责收别人的屏。留着这一页的话两张卡片叠在一起——
        // 而它本来就是「点卡外暗处」和「Esc」都要收掉的。
        this.postcard.hide();
        this.pause.show();
      },
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
      hasSave: this.game.hasSave(),
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
    this.visibility = new HudVisibility(this.root, () => this.touchCtl.releaseActions());
    this.perf = new PerfPanel({ parent: this.root, world: this.world, tier: this.tier });

    // 触屏判定是**活的**：玩家第一次用手指碰屏、手机转个屏、
    // 或者在暂停面板里把三态从"自动"拨到"开"，都要立刻反映到控件上。
    // 挂上监听就够——判定本身在 core/touch.ts，这里只负责把它接到 DOM。
    this.unbindTouch = onTouchModeChange((on) => this.setTouchMode(on));

    this.unbindLang = onLangChange(() => {
      // 湖边读数也要跟着换语言：它不在 `syncFromState()` 的管辖范围内
      // （`lakeside` 不在 `isInWorld()` 里），所以这里单独点一次。
      this.lakeside.setLang();
      // 转盘上的名字是**函数**，所以重画一遍就换完了。
      // 不重画的话，切完语言转盘上还是旧语言——而它常驻在骑行画面上，
      // 是玩家最容易盯着看的一块字。
      this.radial.setItems(this.radialItems);
      // toast 的清空也**只该在这里**：`clear()` 的注释写着"切语言、重开、
      // 读档之后"，而 `syncFromState()` 是每公里跑一次的——把 clear() 放进
      // 去的话，每过一公里玩家就没提示看了。toast 的寿命只有 1.8 秒，
      // 切语言时清掉它们是可接受的代价（总比留着一句旧语言的强）。
      this.toast.clear();
      this.syncFromState();
    });
    this.syncFromState();
    this.pushDusk(true);
    void ensureUiFont();
  }

  // ---------------------------------------------------------------- 阶段

  /**
   * 干净模式：把**全部** DOM 界面藏起来，只留 3D 世界。
   *
   * 给 AI 截图与自动试玩用（`?clean=1`）。一条截图里混着顶栏、小地图、
   * 心神数字、道具栏和飘过去的字，AI 判断"这个世界长什么样"就会被
   * 这些稳定不动的像素干扰；玩家看到的是一个游戏，AI 需要看到的是**山**。
   *
   * ## 为什么用 CSS 类，而不是逐个 `setShown(false)`
   *
   * 因为 `setWorldVisible()` 会在进世界时把 HUD 和道具栏**重新打开**
   * （`enterWorld()` → `setWorldVisible(true)`）。逐个隐藏的话，
   * 隐藏动作会在下一次阶段切换时被原样撤销——症状是"标题页干净，
   * 一进世界 HUD 全回来了"，而这正好是这个功能最需要工作的那个时刻。
   *
   * 一条 `visibility: hidden` 挂在 `g-root` 上就压住了所有子元素，
   * 而 `setShown` 改的 `display` 依然照常进行，阶段机完全不受影响。
   * **用 `visibility` 而不是 `display: none`**：后者会让
   * `getBoundingClientRect` 返回 0，某些面板的布局测量会跟着错位。
   */
  setHudControlsAvailable(on: boolean): void {
    this.hudControlsEnabled = on;
    this.visibility.setAvailable(on && this.worldVisible && !this.dialogue.active);
  }

  setCleanMode(on: boolean): void {
    this.visibility.setClean(on);
  }

  /**
   * 叙事静音。收在 `StoryCards` 的**唯一入口**上，所以序章、驿里的声音、
   * 碎片提示、碑文、路口那句——五处一起安静，不会漏。
   */
  setNarrativeQuiet(on: boolean): void {
    setNarrativeQuiet(on);
    // 已经浮在屏幕上的立刻收掉。只切开关不管屏上的那些，
    // 症状是"参数写了但这一趟还是挡着字"——而那正是要截图的人最恨的。
    if (on) this.storyCards.clear();
  }

  /** 世界 HUD 现在是否可见。给每帧路径（触屏控件、性能面板）读。 */
  private get worldVisible(): boolean {
    return this.worldVis.value;
  }

  private setWorldVisible(v: boolean): void {
    // `set()` 返回 false = 这次不需要动 DOM（同值且已经落过一次）。
    // 原来这里是 `if (this.worldVisible === v) return;`，而初值就等于
    // 第一次请求的值，于是**冷启动那一次隐藏从来没有执行过**。
    if (!this.worldVis.set(v)) return;
    setShown(this.hud.root, v);
    // 道具栏跟着 HUD 一起进出世界：它和 HUD 一样是"在世界里的信息"，
    // 标题页上摆一排空格子只会让人以为少了什么。
    this.itemBar.setVisible(v);
    // 交互提示与转盘是**世界里的**浮层：离开世界时必须一起收掉。
    // 漏掉的话，标题页上会浮着一颗「按 F 摸一下」——
    // 而标题页上没有旧物，那颗按钮按下去什么也不会发生。
    if (!v) {
      this.prompt.set(null);
      this.radial.close();
    }
    this.visibility.setAvailable(v && this.hudControlsEnabled);
    // 触屏控件跟着 HUD 一起进出世界。
    // 标题页/引导页上摆一个活的摇杆是有害的：那里点它什么也不会发生，
    // 而摇杆长得又很像"可以拖"，于是玩家会在标题页上推两下、发现没反应、
    // 得出"这游戏在手机上玩不了"的结论。**控件不出现，就不会被误试。**
    this.applyTouchVisibility();
  }

  /**
   * 收放"在世界里才有意义"的界面外壳：顶栏、小地图、道具栏、触屏控件。
   *
   * 湖边那一屏进出时用。**对外暴露它的理由**：原来只有 `showTitle()` /
   * `enterWorld()` / `closeEndCard()` 几个内部点会调那个私有的
   * `setWorldVisible()`，于是湖边那条路想收 HUD 时只能去调 `syncFromState()`
   * ——而那个函数从头到尾**没有一行碰可见性**，症状是整套骑行 HUD
   * （含一个停在上一次位置的小地图）浮在一片湖岸上。
   *
   * `lakeside` 面板自己**不归它管**，走 `setLakeside()` / `hideLakeside()`。
   */
  setWorldChromeVisible(v: boolean): void {
    this.setWorldVisible(v);
  }

  /**
   * 色觉友好配色。
   *
   * ## 为什么落在 CSS 自定义属性 + HUD 重绘两处
   *
   * 碎片色**不只在 DOM 里**：格子、小地图上的点、HUD 那一排都在用同一份
   * `FRAGMENT_COLORS`（`hud.ts`）。所以这一项不是一个 class 就完事的——
   * DOM 侧靠 CSS 变量换掉所有 `var(--frag-n)`，而 **canvas 侧的那几个色块**
   * 必须显式重绘，否则玩家会看到"格子里变了、图上没变"。
   */
  setHoldToToggle(on: boolean): void {
    this.holdToToggle = on;
    this.pause.setSwitches({ holdToToggle: on });
  }

  setColorblind(on: boolean): void {
    this.colorblind = on;
    this.root.dataset.cb = on ? 'on' : 'off';
    this.pause.setSwitches({ colorblind: on });
    this.hud.setColorblind(on);
  }

  /**
   * 减弱动效。
   *
   * `data-reduce-motion` 是一道**总闸**，CSS 与 3D 两侧都读它：
   * CSS 那一半关掉过渡与动画（见 `styles.css` 里同一名的选择器），
   * 3D 那一半是路口那一下"停一拍"与 HUD 的收缩圈——
   * 后两者是**游戏内的运动**，媒体查询管不到，而它们恰恰是
   * 前庭功能敏感者最难承受的那两处。
   */
  setReduceMotion(on: boolean): void {
    this.reduceMotion = on;
    this.root.dataset.reduceMotion = on ? 'on' : 'off';
    this.pause.setSwitches({ reduceMotion: on });
    this.hud.setReduceMotion(on);
  }

  get isColorblind(): boolean {
    return this.colorblind;
  }

  get isReduceMotion(): boolean {
    return this.reduceMotion;
  }

  /** 数字键 1~4 选道具。返回 false 表示那一格还没买到。 */
  selectItemSlot(num: string): boolean {
    return this.itemBar.select(num);
  }

  /**
   * 浮一条黑底文字卡（路边碑文 / 靠近时的那几句）。
   *
   * **不吃点击、不锁操作、自动推进** —— 三条都是硬要求，
   * 理由见 `storyCard.ts` 的文件头。要锁操作的只有反派那几场，
   * 走 `showInterruptCard()`。
   *
   * @param ms 停留毫秒。**长度不同必须显式给**：默认 3.4s 是给
   *        一两句话的，卡片不会按字数缩放——序章六句用默认时长
   *        会在第三句还没读完就被抽走，而"读不完"读作"字太多了"。
   *        下限由 StoryCards 兜（2.4s）。
   */
  showStoryCard(text: string, title?: string, ms?: number, dismissible = false): void {
    this.storyCards.show(text, { title, ms, dismissible });
  }

  /**
   * 顺序播一组叙事段落：一张演完再上下一张，每张按**自己**的长度定时。
   *
   * 存在的理由是容量：序章六句中文要 66 秒、英文要 86 秒才读得完，
   * 而单卡上限 22 秒。一张卡装不下就是会被腰斩——而腰斩没有任何提示，
   * 玩家只会以为"这个游戏就这么多内容"。
   *
   * 时长由 `storyCard.ts:readingMs` 按语言分流量：中文按字符、英文按词。
   * 路边那些"顺路读到"的字**不要**走这里，它们仍然用 `showStoryCard`。
   */
  showStorySequence(
    parts: string[],
    title?: string,
    opts: { dismissible?: boolean } = {},
  ): void {
    this.storyCards.showSequence(parts, { title, ...opts });
  }

  /**
   * 叙事段落正在屏上吗（序章那七张、或驿里那几句）。
   *
   * 给 `main.tryCheckIn()` 当闸门用。**不能拿 `world.narrativeBusy` 代替**：
   * 故事卡是"骑过去顺便读"，它刻意不锁操作，所以序章期间
   * `narrativeBusy` 恒为假、`canRide` 也放行——那些判断都是对的，
   * 错的是**打卡**没有跟着一起让路。
   */
  get storyBusy(): boolean {
    return this.storyCards.busy;
  }

  /**
   * 退掉当前这张叙事卡片，让下一张接上来。
   *
   * 序章期间玩家按空格时走这条路：故事卡是定时卡，自己不吃按键，
   * 而打卡又让开——不接这一下，那一下空格就是**纯粹没发生**。
   * 屏上没有卡时返回 false。
   */
  advanceStoryCard(): boolean {
    return this.storyCards.advanceTop();
  }

  /** 强制打断：压暗 + 锁操作。只给"有人在你耳边说话"那几场用。 */
  showInterruptCard(text: string, title?: string, ms?: number): void {
    this.storyCards.show(text, { title, interrupt: true, ms });
  }

  /**
   * 小游戏结算屏。三态——**取消不是失败**。
   *
   * `o.gain` 是这一局实际到账的旅币，`o.timedOut` 区分"超时"与"玩砸了"，
   * `o.mood` 是这一局在**心神**上的得失（赢 +1 / 输 −1）。
   * 三者都只改小字，大字仍由 `settleTextKey` 判，所以结算三态的语义没被动过。
   */
  showResult(
    outcome: SettleOutcome,
    slot: number,
    onDone?: () => void,
    o: { gain?: number; timedOut?: boolean; mood?: number } = {},
  ): void {
    this.resultCard.show(outcome, slot, undefined, onDone, o);
  }

  /** 结算屏还在的时候宿主要让出控制权（否则玩家在过场里按了空格）。 */
  get resultShowing(): boolean {
    return this.resultCard.showing;
  }

  /** 道具栏，用来在打卡/购买之后刷新已拥有状态 */
  get items(): ItemBar {
    return this.itemBar;
  }

  // ---------------------------------------------------------------- 转盘 / 交互提示

  /**
   * 换转盘上那一圈条目。
   *
   * **条目由宿主给**：UI 只负责画与收键，而"按下去要发生什么"
   * 是游戏规则上的事，不该由界面层决定。
   *
   * 条目的名字是**函数**（`() => t(...)`），所以切语言不需要重设整圈——
   * UI 在 `onLangChange` 里重画一次就够了。
   */
  setRadialItems(items: RadialItem[]): void {
    this.radialItems = items;
    this.radial.setItems(items);
  }

  /** 转盘开着吗。宿主在处理按键之前要问这一句。 */
  get radialOpen(): boolean {
    return this.radial.isOpen;
  }

  /** 开 / 关转盘。 */
  toggleRadial(): void {
    this.radial.toggle();
  }

  /**
   * 把这一下按键交给转盘。
   *
   * 返回 true 表示「转盘吃掉了这一下」——宿主必须**就此打住**：
   * 方向键在骑行相位是转向，Esc 是暂停，而这两件事在转盘开着时
   * 分别是"换选中的那一项"和"关掉转盘"。
   */
  handleRadialKey(code: string, shift = false): boolean {
    return this.radial.handleKey(code, shift);
  }

  /**
   * 交互提示。传 `null` = 现在没有可交互的东西，于是提示整个收掉。
   *
   * **判据由宿主给**（它手里有 `world.relicNearby` / `world.qinInReach` /
   * `world.signInReach`），UI 只负责把它画出来或收掉。
   *
   * ★ 顺带把「它是哪一族动作」推给脚下那一圈：
   *   两者指向同一个动作时，圈上那行字让位（规则见 `hud.ts` 的 `ringLabelText()`）。
   *   提示与圈都在这个 UI 层里，**这一层是唯一同时看得见两者的地方**，
   *   所以「谁在说话」这件事只在这里判一次。
   *
   * ★ 叙事段落在场时**提示让路**——但那条闸门不在这里，
   *   而在提示组件自己身上（`InteractPrompt` 的 `blocked`）。
   *   所以 `setPrompt()` 传进来的状态**可能不显示**：
   *   屏上有叙事卡时，这一格让给叙事卡。
   */
  setPrompt(s: PromptState | null): void {
    this.prompt.set(s);
    this.hud.setPromptKind(this.prompt.kind);
  }

  /** 交互提示现在亮着吗。给宿主与回归读。 */
  get promptShown(): boolean {
    return this.prompt.shown;
  }

  showTitle(): void {
    this.title.show();
    this.onboarding.hide();
    this.setWorldVisible(false);
    this.hidePanels();
  }

  /**
   * 自行车的 GLB 到货了没有 → 标题页那颗「演示」按钮能不能按。
   *
   * 宿主（`main.ts` 的 `onAssetLoaded()`）从世界的 `loaded` 事件问出来再喂进来。
   * **UI 不自己轮询**：模型的生死只有世界知道，而让面板去猜"大概加载完了吧"
   * 就会在 20 秒硬超时之后点亮一颗永远按不动的按钮。
   *
   * 幂等，重复调用安全。
   */
  setDemoReady(ready: boolean): void {
    this.title.setDemoReady(ready);
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
    this.postcard.hide();
    this.synthesis.hide();
    this.endCard.hide();
    this.shop.close();
    // 对白也在这张单子里。**它原来不在**——于是 `finishRun()` 推结算屏时，
    // 序章那一句还浮在明信片正上方，而且会跟着玩家一路走到标题页。
    // `hide()` 内部走 `finish()`，所以 `dialogueIdle` 会被解开（见 `Dialogue.hide`）。
    this.dialogue.hide();
  }

  showPause(): void {
    this.visibility.setAvailable(false);
    this.pause.show();
  }

  hidePause(): void {
    this.pause.hide();
    // 一起关：明信片是暂停的子页，留着它等于"暂停已经结束了但还挡着路"。
    // 正常路径上不会走到这儿（Esc 在捕获阶段就被明信片自己拦住、退回暂停），
    // 这一行是给"宿主绕过暂停面板直接把暂停收掉"那条路兜住的。
    this.postcard.hide();
  }

  /**
   * 暂停里的「看看明信片」。
   *
   * 先把暂停收起来：两张居中卡片叠在一起读作"有两个菜单"，
   * 而这一屏要说的事只有一件——这趟攒到哪儿了。
   * 相位不动，仍然是 `paused`，所以退出时回到的是暂停面板而不是路上。
   *
   * **对外公开**是因为 Tab 转盘上也有这一项：转盘是骑行时的快捷入口，
   * 而"看看这一趟攒到哪儿了"正是它该给的一个动作。
   */
  lookPostcard(): void {
    this.pause.hide();
    this.postcard.show();
  }

  showSynthesis(mode: 'chapter' | 'maxed' | 'plain' = 'plain'): void {
    this.visibility.setAvailable(false);
    this.synthesis.show(mode);
  }

  showEndCard(): void {
    this.setWorldVisible(false);
    this.hidePanels();
    this.endCard.show();
  }

  /**
   * 关掉结算页，**回到世界**。
   *
   * `showEndCard()` 做了两件事，这里逐件撤销：`setWorldVisible(false)` 把 HUD
   * 收了起来（不撤的话玩家回到路上是"没有顶栏、没有小地图"的世界），
   * `hidePanels()` 之后 `endCard.show()` 把结算页推了上来。
   *
   * **不动 `game` 的任何进度**——关掉一页说明"我想回去继续骑"，
   * 不是"我要重新开始"。真正清档的是 `restart()`，那件事仍然只在
   * 「重新开始」那一个动词后面发生。
   *
   * 和 `enterWorld()` 的区别：那一条是**从标题/引导页走进世界**，
   * 会顺带重放序章；这一条是**从结算页走回世界**，序章早播过了。
   */
  closeEndCard(): void {
    this.endCard.hide();
    this.setWorldVisible(true);
    this.hud.sync();
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
    this.storyCards.update(dt);
    this.resultCard.update(dt);
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

  /** 播对白，返回 Promise；空格/点击推进，跳转停在末句或进入指定终点。 */
  showDialogue(speaker: string, lines: DialogueLines, onSkipToNext?: () => void): Promise<void> {
    this.visibility.setAvailable(false);
    const p = this.dialogue.show(speaker, lines, onSkipToNext);
    void p.then(() => { if (!this.dialogue.active) this.visibility.setAvailable(this.worldVisible && this.hudControlsEnabled); });
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

  showToast(text: string, ms?: number, kind?: ToastKind): void {
    this.toast.show(text, ms, kind);
  }

  /** 湖边这一屏的读数。宿主每帧调一次，面板自己决定要不要真的改 DOM。 */
  setLakeside(f: LakesideFrame): void {
    this.lakeside.sync(f);
  }

  /**
   * 收起湖边读数。
   *
   * **退出这一屏时必须显式收。** 它不在 `setWorldVisible()` 的管辖范围内——
   * 那一套管的是「骑行 HUD 有没有」，而这一屏和骑行 HUD 是互斥的两套东西。
   * 漏掉的话，退出湖边之后张力条会浮在正常骑行画面上。
   */
  hideLakeside(): void {
    this.lakeside.hide();
  }

  /**
   * 湖边那一屏的 VR 入口出不出来。
   *
   * 宿主在启动时问一次 `isSessionSupported('immersive-vr')`，答案是异步的
   * （而且可能比玩家进湖边晚），所以它是一条独立的 setter 而不是构造参数。
   */
  setLakesideVr(available: boolean): void {
    this.lakeside.setVrAvailable(available);
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
   * 而旅币**每一次变动**都会触发一次——打卡、买东西、过关、每骑完一圈。
   * 所以
   *   · 常驻的（HUD / 触屏 / 遮罩 / 性能面板）无条件同步，全是带缓存的
   *     文本写入，代价约等于零；
   *   · 面板类的一律**先看它是不是开着**。引导页的 `sync()` 会
   *     `replaceWith()` 重建整份操作说明，小地图的静态层要重画 961 段
   *     路径——为一块 `display:none` 的东西做这些，纯粹是浪费；
   *   · 自己管显隐的浮动层（故事卡 / 结算卡）看**自己的状态**：
   *     屏上有几张卡、结算卡还有没有寿命。它们的 `sync()` 内部也带缓存，
   *     但门还是要有的——没卡的时候那是几十次白跑的 `querySelector`。
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
    if (isShown(this.postcard.root)) this.postcard.sync();
    if (isShown(this.synthesis.root)) this.synthesis.sync();
    if (isShown(this.endCard.root)) this.endCard.sync();
    if (isShown(this.title.root)) this.title.sync();
    if (isShown(this.onboarding.root)) this.onboarding.sync();
    // 故事卡与结算卡不是"开着才同步"的那一族：它们是**自己管显隐**的
    // 浮动层（自动推进、到点自己收）。所以门用的是它们自己的状态——
    // 屏上有卡才重贴外壳，见各自 `sync()` 的注释。
    if (this.storyCards.count > 0) this.storyCards.sync();
    if (isShown(this.resultCard.root)) this.resultCard.sync();
    this.dialogue.sync();
    this.itemBar.sync();
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

  // ---------------------------------------------------------------- 焦点

  /**
   * 把键盘焦点从界面上摘下来。
   *
   * **为什么需要它**：打卡是用空格触发的，而空格落在 HUD 的"脚下提示圈"
   * 那个 `<button>` 上时，浏览器会把它变成 `document.activeElement`。
   * 那个按钮挂了 `wireKeyActivate`，而它在 keydown 的**目标阶段**
   * `stopPropagation()` ——于是往 window 冒泡的那条路被截断，
   * 小游戏（也在 window 上收键）永远收不到空格。
   *
   * 调用时机只有一个：小游戏开始之前。那一屏上没有任何需要键盘焦点的控件
   * （五个小游戏都是 canvas 自己收键），所以把焦点交出去是零代价的。
   *
   * 不用 `blur()` 的原因：焦点可能落在**别的**面板上（结算页、暂停页），
   * 而这一层只知道自己这几个子面板。这里直接对 `document.activeElement`
   * 判一次，落在 `.g-root` 里才摘——落在画布上就说明本来就是对的。
   */
  releaseFocus(): void {
    const a = document.activeElement;
    if (a instanceof HTMLElement && this.root.contains(a)) a.blur();
  }

  // ---------------------------------------------------------------- 性能面板

  setPerfVisible(v: boolean): void {
    this.perf.setVisible(v);
  }

  togglePerf(): void {
    this.perf.toggle();
  }

  // ---------------------------------------------------------------- 铺子

  /**
   * 铺子面板开着没有。
   *
   * 宿主要靠它决定 `Escape` 该做什么（见 `main.ts` 的 `Escape` 分支）：
   * 商店**复用**了 `checkin` 相位，而 `Escape` 那条分支只认 `paused` /
   * `roaming`——于是开店期间按 `Esc` 什么都没发生，玩家会以为游戏卡住了。
   * `Esc` 是"我卡住了"的第一反应键，它必须有出口。
   */
  get shopOpen(): boolean {
    return this.shop.isOpen;
  }

  /**
   * HUD 上一帧算出来的「下一处」与目标陈述。
   *
   * 只给 `main.ts` 的 AI 接口用（`aiObservation()`）。
   * **不是**让 UI 再算一遍——`Hud.syncNext()` 每帧已经算过一次了，
   * 两份算法早晚会漂，而漂了以后 AI 会朝着玩家在屏幕上**看不见**的方向骑。
   */
  get navNext(): {
    idx: number;
    name: string;
    dist: number;
    arrow: string;
    objective: string;
  } {
    return this.hud.aiNext;
  }

  /**
   * 「屏幕上现在压着什么」——**只读，不改任何状态**。
   *
   * 只为 `main.ts` 装 AI 接口而存在（`game/api/live.ts`）。它问的是
   * **「此刻哪些键按了真的有反应」**，而这件事的回答分散在七个面板上：
   * 每加一个面板就多一处要同步的地方，而漏掉一处的症状是
   * 「AI 在暂停的时候按 W，游戏动了」——看起来像 AI 策略有问题。
   *
   * 所以它一次性把面板的可见性收成三个布尔，
   * `describeActions()` 再拿这三个布尔算出可用动作集合。
   *
   * 这里刻意用各面板**自己的** `root` 与 `isShown()`，
   * 而不是拿 `phase` 去猜：相位描述的是流程状态，
   * 而「有没有东西压在画面上」是呈现问题——序章对白压在 `roaming` 上就是反例。
   *
   * ## 标题 / 引导 / 结算三块**不在**这个列表里
   *
   * 它们问的是另一个问题。标题屏开着，意思是「**这一屏就是标题屏**」，
   * 不是「有一个面板压在世界上面」——玩家正站在这一屏里，而不是被它挡住。
   * 而 `describeActions()` 恰恰为这三个相位准备了 `advance`，
   * 并在注释里写着「一个在这里什么都不给的接口，会让 AI 站在标题页永远出不去」。
   *
   * 早先把它们也算进 `panelOpen`，于是 `describeActions()` 里
   * `if (o.panelOpen) return []` 抢先一步返回空集，那三个分支**成了死代码**：
   * 实机在标题屏上量到 `available: []`、`tap('advance')` 被拒，
   * AI 连游戏都启动不了，走完一趟也永远停在结算屏上。
   *
   * 排除掉它们之后，结算屏上再开明信片面板仍然会被正确地判成"有东西压着"
   * （`postcard.root` 还在列表里），而裸的结算屏给 `advance`——
   * 这正是"压在上面的东西"和"当前这一屏"该有的区别。
   */
  aiScreen(): { panelOpen: boolean; dialogueOpen: boolean; dialogueText: string } {
    /** 「压在当前这一屏**上面**」的面板。标题/引导/结算是这一屏本身，故不在内。 */
    const overlays = [
      this.shop.root,
      this.pause.root,
      this.postcard.root,
      this.synthesis.root,
    ];
    const dialogueOpen = this.dialogue.active;
    return {
      panelOpen: overlays.some((r) => isShown(r)),
      dialogueOpen,
      // 取**屏幕上真正在显示的那段字**，而不是另存一份——
      // 对白是一个字一个字打出来的，中间态也是玩家看得见的状态。
      dialogueText: dialogueOpen ? (this.dialogue.root.textContent ?? '').trim() : '',
    };
  }

  /** 打开/关闭铺子面板。铺名取 `world.nearby.shopName`。 */
  setShopOpen(open: boolean): void {
    if (!open) {
      this.shop.close();
      this.applyTouchVisibility();
      this.visibility.setAvailable(this.worldVisible && this.hudControlsEnabled);
      return;
    }
    const name = this.world.nearby.shopName;
    if (!name) return;
    this.visibility.setAvailable(false);
    this.shop.open(name);
    this.applyTouchVisibility();
  }

  // ---------------------------------------------------------------- 触屏

  /** 触屏控件开关（由 main 根据 `pointer: coarse` 决定）。 */
  setTouchMode(on: boolean): void {
    this.touchMode = on;
    this.root.dataset.touch = on ? 'on' : 'off';
    this.onboarding.setTouch(on);
    this.hud.setTouchMode(on);
    this.applyTouchVisibility();
  }

  /**
   * 骑行节拍。**只转调 HUD 那一个方法**——
   * 界面上除了"一个会缩的圈 + 五个点"之外不该有任何节拍相关的东西，
   * 所以这里不新增面板、不新增状态，只把状态递过去。
   */
  setBeat(s: { open: boolean; remain: number; hits: number; goal: number; done: boolean }): void {
    this.hud.setBeat(s);
  }

  /**
   * 路边躲避挑战的进度。**只转调 HUD 那一个方法**——同节拍那一条：
   * 这一件在界面上只有一根条和一句"还剩多少米"，
   * 不新增面板、不新增状态。
   */
  setDodge(v: { active: boolean; progress: number; left: number }): void {
    this.hud.setDodge(v);
  }

  /** 触屏控件 = 判定为触屏 **且** 已经进到世界里。两个条件都要。 */
private applyTouchVisibility(): void {
    // **湖边那一屏是例外**：世界看不见了，可那一屏是**走路 + 抛竿**，
    // 而摇杆与那颗大按钮是它仅有的两个动词。跟着世界一起藏起来的话，
    // 触屏玩家进得来出不去、连站着都做不到——那一屏对他们等于不存在。
    if (this.lakesideOn) {
      this.touchCtl.setMode(this.touchMode);
      // 出口那一行的文案也要跟着触屏态走：那一刻它写的是
      // 「按 Esc 回路上」，而这台设备上**没有 Esc 可按**。
      this.lakeside.setTouchMode(this.touchMode);
      return;
    }
    this.touchCtl.setMode(this.touchMode && this.worldVisible && !this.shop.isOpen);
    // 湖边出口那一行跟着同一个值换文案。
    // 控件藏起来的那一次，恰恰是**最需要那句「点这里」**的那一次。
    this.lakeside.setTouchMode(this.touchMode);
  }

  /**
   * 进入 / 退出湖边。
   *
   * 必须在 `setWorldVisible` **之前**调：`applyTouchVisibility()` 要读到它
   * 才不会把控件藏掉，而它自己是在 `setWorldVisible()` 里被调用的。
   */
  setLakesideActive(on: boolean): void {
    if (this.lakesideOn === on) return;
    this.visibility.setClean(false);
    this.lakesideOn = on;
    this.touchCtl.setLakesideMode(on);
    this.applyTouchVisibility();
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
    this.unbindTouchButtons();
    this.visibility.dispose();
    this.dialogue.dispose();
    this.hud.dispose();
    this.shop.dispose();
    this.pause.dispose();
    this.postcard.dispose();
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
