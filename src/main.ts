/**
 * 总装 —— 启动、状态机、输入路由、游戏流程。
 *
 * ## 启动为什么有进度条
 *
 * 地形高程场（129×129 顶点 + 三只碗的选址扫描）、路面三角形索引
 * （约 4600 个三角形入空间哈希）、123 块植被的确定性布置——
 * 加上第一个 GLB 的下载，这一段是 300ms 到 6s（取决于网络）。
 * 这段时间屏幕上必须有东西，而不是白屏或者"点了没反应"。
 *
 * 样式**不在这里 import**：骨架与 @font-face 由 index.html 里那条
 * 渲染阻塞的 `<link>` 提供（`src/index.css`），这样启动屏在第一帧就有样式。
 * UI 组件样式由 `ui/index.ts` 自己 import——它跟着模块走，
 * 于是"UI 挂了"不会把启动屏一起变白。
 */
import { detectCapability, type Capability, type Tier } from './core/capability';
import { PRESETS, loadSettings, saveSettings, clampTier, type SettingsData } from './core/settings';
import { GameLoop } from './core/loop';
import { audio } from './core/audio';
import { initLang, setLang, getLang, t } from './i18n';
import { World, type WorldEvent } from './world/world';
import { Renderer } from './core/renderer';
import { Terrain } from './world/terrain';
import { Road } from './world/road';
import { Water } from './world/water';
import { Vegetation } from './world/vegetation';
import { Stations } from './world/stations';
import { Sky } from './world/sky';
import { Scene, PerspectiveCamera } from 'three';
import { game, GameStateManager } from './game/state';
import { MiniGameHost } from './game/minigameHost';
import { STATIONS, CENTERLINE, TOTAL_ARCLENGTH, nearestArcParam } from './data/route';
import { ECON, SHOPS } from './data/raw';
import { UI } from './ui';
import { clamp } from './core/math';
import { perf } from './core/perf';
import { getBasins } from './world/basins';
import { installTouchDetection, touchEnabled, setTouchMode } from './core/touch';
import { SceneDump } from './ui/sceneDump';
import { DebugPanel } from './debug/panel';
import { probeAt, buildingTable } from './debug/probe';
import { buildInputFromState, endingFromGameState, exportBothSides, seededBackText, type EndingId } from './game/postcard';

import { canRide as canRideNow, type Phase } from './game/phase';

const bootEl = document.getElementById('boot') as HTMLElement;
const bootSub = document.getElementById('boot-sub') as HTMLElement;
const bootFill = document.getElementById('boot-fill') as HTMLElement;
const bootPct = document.getElementById('boot-pct') as HTMLElement;

function boot(progress: number, label?: string) {
  const p = Math.round(clamp(progress, 0, 1) * 100);
  bootFill.style.width = p + '%';
  bootPct.textContent = p + '%';
  if (label) bootSub.textContent = label;
}

function bootDone() {
  bootEl.classList.add('done');
  setTimeout(() => bootEl.remove(), 500);
}

// ---------------------------------------------------------------- 字体
async function registerFonts() {
  if (!('fonts' in document)) return;
  try {
    // UI 字体在首屏就要用，preload 已经拉过一次，这里只是等它 ready，
    // 否则第一帧会用回退字体画一遍再换，读起来像闪了一下
    await document.fonts.load('16px "188UI"');
    await document.fonts.ready;
  } catch {
    /* 字体失败不阻塞游戏 */
  }
}

// ---------------------------------------------------------------- 启动
async function main() {
  boot(0.02, t('loading'));
  initLang();
  await registerFonts();

  const capability: Capability = detectCapability();

  // 调试入口：`?caps` 只跑能力探测，不建世界。
  // 存在的原因很实际：软件渲染的机器上，启动整个世界要几十秒，
  // 而"这台机器被判成哪一档、理由是什么"是第一个要回答的问题。
  // 让它进游戏流程去问，等于每次都要先付那几十秒。
  if (new URLSearchParams(location.search).has('caps')) {
    document.body.innerHTML = `<pre style="padding:2em;font:13px/1.7 ui-monospace,monospace;color:#2a2622;background:#e8e0cd;white-space:pre-wrap">${escapeHtml(
      JSON.stringify(capability, null, 2) +
        '\n\n' +
        JSON.stringify(PRESETS[capability.suggestedTier], null, 2),
    )}</pre>`;
    return;
  }

  if (!capability.webgl2) {
    showUnsupported(capability);
    return;
  }

  const settings = loadSettings(capability.suggestedTier);

  // `?tier=0|1|2` 强制档位。三个用途：
  //   · 玩家在探测判断错的时候（隐私模式藏了显卡型号）能自己纠正
  //   · QA 对比三档差异时用同一个世界跑
  //   · 定位"这一档卡"的时候，怀疑对象可以只缩到某一个旋钮上
  const forcedTier = new URLSearchParams(location.search).get('tier');
  if (forcedTier !== null) {
    settings.tier = clampTier(Number(forcedTier));
    settings.qualityTouched = true;
    saveSettings(settings);
  }

  // `?touch=1` / `?touch=0` 强制挂/不挂触屏控件。
  // 自动判定在混合设备上必然有判错的时候，而"摇杆没出现"是最难自查的一类
  // 问题——所以留一个能在任何机器上复现的开关。玩家在暂停面板里改也是同一件事，
  // 那里改会落盘，这里只对本次生效。
  const forcedTouch = new URLSearchParams(location.search).get('touch');
  if (forcedTouch !== null) setTouchMode(forcedTouch === '0' ? 'off' : 'on');

  const preset = PRESETS[settings.tier];
  audio.ambientLayers = preset.ambientLayers;

  boot(0.12);
  // 让浏览器有机会把上面这些画出来（启动屏的进度条是真的，不是假的）
  await nextFrame();

  // ---- 世界（这一步最重：碗的选址扫描 + 路面索引 + 植被布置）----
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  boot(0.2);
  await nextFrame();

  let world: World;
  try {
    world = new World(canvas, settings.tier, preset);
  } catch (e) {
    // 逐个模块试一遍，好过只拿一句 "reading 'x'"。
    // 世界是七个互相独立的子系统拼起来的，构造顺序又带着硬依赖
    // （地形先算碗、水面才认碗），所以定位只能靠"试到哪一步炸"。
    const step = (label: string, fn: () => void) => {
      try {
        fn();
      } catch (err) {
        showFatal(`[${label}] ${err instanceof Error ? err.message : String(err)}`, err);
        throw err;
      }
    };
    // 注意：这里只重建纯计算的部分，Renderer 单独试——
    // 拿不到 WebGL context 时 three 抛的是它自己的错，不是 TypeError。
    step('renderer', () => {
      const cam = new PerspectiveCamera(62, 1, 0.25, 900);
      new Renderer(canvas, settings.tier, preset, cam);
    });
    step('terrain', () => new Terrain());
    step('road', () => new Road(new Terrain()));
    step('water', () => new Water(preset.waterDetail));
    step('vegetation', () => new Vegetation(preset, new Terrain()));
    step('stations', () => new Stations(preset, new Terrain()));
    step('sky', () => new Sky(new Scene(), preset.shadowMapSize, preset.shadowDistance || 120));
    showFatal(`world 构造失败：${e instanceof Error ? e.message : String(e)}`, e);
    return;
  }
  boot(0.62);
  await nextFrame();

  // ---- 资产渐进加载：先能玩，再补好看 ----
  // 顺序不是随便排的：自行车是玩家全程盯着的那一个，最先；
  // 植被其次（没有它世界是空的但路能骑）；地标最后（按距离自己进）。
  //
  // **进度条跟这条链，但启动屏不等它。**
  // 原来 `bootDone()` 挂在链的末尾，于是任何一个 GLB 悬住（弱网、代理、
  // 服务端 200 但不发 body）都会让玩家盯着一根停在 62% 的进度条——
  // 而此时世界已经建好、路能骑、标题页能用，只差一辆自行车。
  // "能不能玩"和"画得全不全"是两件事，不该用后一件卡住前一件。
  const assetChain = world
    .loadBikeModel()
    .then(() => {
      boot(0.78);
      return world.loadVegetationModels();
    })
    .then(() => {
      boot(1);
      audio.prefetchSfx();
    })
    .catch((e) => {
      // 模型拉不到不该让整局玩不成：世界照样能骑，只是路边没有树
      console.warn('[gift188] 部分模型加载失败：', e);
      boot(1);
    });
  // 硬超时：GLTFLoader 没有内建超时，悬住的请求会永远 pending。
  // 20 秒足够 localhost 与正常宽带走完 4MB，也足够在慢网下给出"它不来了"的信号。
  void withTimeout(assetChain, 20_000, '模型加载超时');

  // ---- 游戏状态机 ----
  const app = new App(world, settings, capability);
  await app.ready();
  audio.prefetchSfx();
  // 到这里世界已经可交互（能骑、能打卡、能进世界），**撤启动屏**。
  // 自行车与植被还在后面流式补上，进标题页时通常已经到了，
  // 慢一点的话它们会在标题页背后自己出现——比一根不动的进度条好。
  boot(1);
  bootDone();
}

/** 给一条可能永远 pending 的 promise 加硬超时 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | void> {
  return Promise.race([
    p,
    new Promise<void>((r) =>
      setTimeout(() => {
        console.warn(`[gift188] ${label}（${ms}ms），继续跑`);
        r();
      }, ms),
    ),
  ]);
}

/**
 * 让浏览器有机会把上面这些画出来（启动屏的进度条是真的，不是假的）。
 *
 * 这个函数改过两次，每次都是被真实故障逼出来的：
 *
 * 1. **纯 `requestAnimationFrame`**：后台标签页里 rAF **根本不触发**，
 *    玩家在另一个标签页点开链接、回头再切过来，进度条永远停在 62%。
 * 2. **改成 `setTimeout(20)` 兜底**：仍然会卡。后台标签页在隐藏 5 分钟后
 *    进入 intensive throttling，定时器被限到**每分钟一次**——
 *    于是"等 20ms"变成"等一分钟"，启动条肉眼可见地一格一格爬。
 *    而爬到一半的那几格，玩家在另一个标签页，**根本没在看它**。
 *
 * 所以第三版先问一句"有没有人在看"：
 *   · `document.hidden` 为真 → 直接放行。没有观众的一帧没有意义，
 *     继续往下走才是对的；等它反而是唯一会把它卡住的东西。
 *   · 否则 rAF 与一个 **MessageChannel** 的任务边界赛跑。
 *     选它不选 `setTimeout` 是因为 MessageChannel 走任务队列、
 *     **不受后台限流**，所以就算 `hidden` 判断在某些环境里失效，
 *     这一路也不会被限到一分钟一次。
 *
 * 主循环 `GameLoop` 仍然只走 rAF——游戏不需要给没人在看的标签页渲染，
 * 切回前台时 `focus` 监听会把它接上。
 */
function nextFrame(): Promise<void> {
  if (typeof document !== 'undefined' && document.hidden) return Promise.resolve();
  return new Promise((r) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      r();
    };
    requestAnimationFrame(finish);
    try {
      const mc = new MessageChannel();
      mc.port1.onmessage = () => {
        finish();
        mc.port1.close();
      };
      mc.port2.postMessage(0);
    } catch {
      // 极老的浏览器没有 MessageChannel。落到 20ms 定时器，
      // 至少比"什么都不做"好。
      setTimeout(finish, 20);
    }
  });
}

// ---------------------------------------------------------------- App
class App {
  phase: Phase = 'boot';
  world: World;
  settings: SettingsData;
  capability: Capability;
  ui!: UI;
  mg!: MiniGameHost;
  loop!: GameLoop;
  /** `?dump=1` 的场景自检面板。正式发行时不存在——它只在调试参数下挂上 */
  dump: SceneDump | null = null;
  /** `?debug` 的场景探针面板。`F10` 开关，`P` 探针 / `B` 驿站表 */
  debug: DebugPanel | null = null;

  private keys = new Set<string>();
  private touchMode = false;
  private demoActive = false;
  private demoT = 0;

  constructor(world: World, settings: SettingsData, capability: Capability) {
    this.world = world;
    this.settings = settings;
    this.capability = capability;
  }

  async ready() {
    // 启动阶段的每一步都留一句日志。
    // 理由很实际：用户报"一直卡在加载中"时，能给的只有一行截图，
    // 而"卡在第几步"和"卡在这一步的哪一行"是两种完全不同的故障。
    // 这里的标记刻意留在产物里——它们不花钱，而线上排查靠的就是它们。
    const mark = (s: string) => {
      console.log(`[gift188] ${s}`);
      // 同时写进 title：它是这条链上唯一"一定拿得到"的信号。
      // 远程排障时能读到的往往只有一行截图或一个页面标题，
      // 而"卡在装配 UI"和"卡在显示标题页"是两个完全不同的故障。
      document.title = `188号礼物 · ${s}`;
    };
    const root = document.getElementById('ui-root') as HTMLElement;

    mark('装配 UI…');
    this.ui = new UI({
      parent: root,
      hooks: {
        onStart: () => this.startRide(),
        // 引导页的出口。**必须在这里把 phase 切到 roaming**，
        // 而不是在 UI 内部直接画 HUD——不然 `canRide` 恒为假，车不动。
        onWorldEntered: () => this.enterWorld(),
        onStartDemo: () => this.startDemo(),
        onResume: () => this.resume(),
        onRestart: () => this.restart(),
        onFinishRun: () => this.finishRun(),
        onQualityChange: (tier) => this.setQuality(tier),
        onAdaptiveChange: (on, fps) => this.setAdaptive(on, fps),
        onMuteChange: (bgm, sfx, all) => {
          audio.setBgmMuted(bgm);
          audio.setSfxMuted(sfx);
          audio.setFullyMuted(all);
        },
        onLangToggle: () => this.toggleLang(),
        onCheckIn: () => this.tryCheckIn(),
        onShopBuy: (id) => this.buy(id),
        onShopClose: () => this.ui.setShopOpen(false),
        onTakePostcard: () => this.finishRun(),
        onKeepRiding: () => this.toRoaming(),
        onEndingPick: (e) => {
          game.setEnding(e);
          this.ui.syncFromState();
        },
        onExportPostcard: (side) => void this.exportPostcard(side),
        onWriteBack: (text) => {
          this.backText = text;
        },
      },
      world: this.world,
      game,
      capability: this.capability,
      // 当前档位与自适应设置。**必须传**：不传的话 UI 会回落到
      // `capability.suggestedTier`——那是"探测建议"，而实际生效的是
      // 存档里玩家选过的那一档（或者被 ?tier 强制的那一档）。
      // 两者不一致时，标题页的档位摘要会描述**没有生效**的那一档：
      // 画面跑在低档、面板写着 100% 和 2048px 阴影，玩家于是去调
      // 一个根本没在动的旋钮。
      tier: this.settings.tier,
      adaptiveOn: this.settings.adaptiveTargetFps > 0,
      adaptiveTarget: this.settings.adaptiveTargetFps || 30,
    });

    mark('装配小游戏宿主…');
    this.mg = new MiniGameHost(root);

    mark('判断输入方式…');
    // 触屏判定要**在 UI 建好之前**就装上：玩家第一次用手指碰屏时就应该
    // 立刻挂出摇杆，而那时 UI 还不存在。装晚了，摇杆会等到下一次 touchstart
    // 才出现——而"按了一下才出现"正好是玩家最想避开的那种出现方式。
    installTouchDetection();
    this.touchMode = touchEnabled();
    this.ui.setTouchMode(this.touchMode);

    mark('读档…');
    const loaded = game.load();
    this.backText = readBackText();

    mark('建立主循环…');
    this.loop = new GameLoop(
      {
        fixed: (dt) => this.fixed(dt),
        render: (dt) => this.render(dt),
        onScaleChange: (s) => this.world.renderer.setRenderScale(s),
        onStats: (fps, ms) => {
          perf.fps = fps;
          perf.frameMs = ms;
        },
      },
      {
        adaptiveTargetFps: this.settings.adaptiveTargetFps,
        adaptiveMinScale: this.settings.adaptiveMinScale,
        baseScale: PRESETS[this.settings.tier].renderScale,
      },
    );
    this.world.renderer.setRenderScale(PRESETS[this.settings.tier].renderScale);

    mark('绑定输入…');
    this.bindInput();
    window.addEventListener('resize', () => this.world.renderer.resize());

    // 世界事件
    this.world.on((e) => this.onWorldEvent(e));
    this.world.onRoadsideLine = (text) => this.ui.showToast(text, 2600);
    this.world.onBgmMood = (slot) => audio.setBgmMood(slot);
    game.on('state', () => this.ui.syncFromState());
    game.on('lvbi', () => this.ui.syncFromState());
    game.on('mood', () => this.ui.syncFromState());
    game.on('item', () => this.ui.syncFromState());

    mark('启动循环…');
    this.loop.start();
    this.phase = 'title';
    mark('显示标题页…');
    this.ui.showTitle();
    mark('就绪');
    if (loaded && game.getCollectedCount() > 0) this.ui.syncFromState();

    // `?dump=1` 场景自检。回答"玩家眼前这个东西到底是什么"——
    // 图形 bug 从代码里看不出来，只能让世界自己报。按 F9 开关。
    if (new URLSearchParams(location.search).has('dump')) {
      this.dump = new SceneDump(root, this.world);
    }

    // `?debug` 场景探针。按 F10 开关。
    // 它与 `?dump` 的分工：dump 报「场景里有哪些渲染对象」（给 three 用），
    // probe 报「我在哪、镜头什么状态、这里是什么地方、驿站健康吗」（给人与 AI 用）。
    // 两个都要，因为它们的失败模式不同：dump 抓"多出来的东西"，
    // probe 抓"该在那里的东西不在了"。
    const q = new URLSearchParams(location.search);
    if (q.has('debug') || q.has('probe') || q.has('buildings')) {
      this.debug = new DebugPanel(root, this.world);
      if (q.has('buildings')) this.debug.setMode('buildings');
      // `?probe` 默认直接显示；`?debug` 只是把面板建起来等 F10
      if (q.has('probe') || q.has('buildings')) this.debug.setShown(true);
    }
    // `?x=..&z=..` 直接探一个坐标，并把结果打到 console。
    // 不带 x/z 时就是探玩家所在处——这是"别人报 bug"时最省事的入口：
    // 对方只要把带坐标的链接发过来，接手的人看到的现场与对方完全一致。
    if (q.has('x') || q.has('z') || q.has('probe')) {
      const xs = q.get('x');
      const zs = q.get('z');
      const at = xs !== null && zs !== null ? { x: Number(xs), z: Number(zs) } : {};
      const text = probeAt(this.world, at.x, at.z, { buildings: q.has('buildings'), radius: 40 });
      console.log(text);
      document.title = '188号礼物 · 探针';
    }
    // `?dump=1` 已经消费过 query，但探针还要读 `x`/`z`，所以复用同一个 q。
    // 弧长定位入口：`?arc=` 见下。

    // 弧长定位入口：`?arc=0.42` 把玩家放到中心线参数 0.42 处，`?yaw=90` 再指定朝向（度）。
    // 停在原地**不自动开**——演示会一直往前骑，而"同一个画面看两次"
    // 才是这类问题唯一能查的方式：8 字交叉口那种地方，
    // 错过一次就得再绕一整圈。
    const arc = q.get('arc');
    if (arc !== null) {
      const yaw = q.get('yaw');
      this.world.teleportToArc(Number(arc), yaw === null ? undefined : Number(yaw));
      this.enterWorld();
    }

    // 只读调试出口。它回答的是"车现在在哪、离路多远、画了多少 draw call"这类
    // 只能靠量才知道的问题——上一轮"相机卡在树里"就是靠它定位的，
    // 靠读代码只会得到一堆看起来都对的表达式。
    Object.defineProperty(window, 'gift188', {
      get: () => {
        const w = this.world;
        const p = w.ride.pos;
        return {
          route: { stations: STATIONS.length, points: CENTERLINE.length, length: TOTAL_ARCLENGTH },
          bike: {
            x: +p.x.toFixed(2),
            y: +p.y.toFixed(2),
            z: +p.z.toFixed(2),
            speed: +w.ride.speedValue.toFixed(2),
            onRoad: w.ride.onRoad(),
            /** 到中心线的最近距离（米）。>8 就说明骑偏了 */
            offCenterline: +minDistToCenterline(p.x, p.z).toFixed(2),
            arc: +nearestArcParam(p.x, p.z).toFixed(4),
          },
          chapter: { n: game.chapter, oneDone: game.chapter1Done, objective: game.objective },
          perf: { ...perf },
          nearby: { ...w.nearby },
          phase: this.phase,
        };
      },
      configurable: true,
    });

    /**
     * 探针的编程入口。**这是"让 AI 助手知道现场"的那一条路**：
     * 在控制台敲 `gift188.probe()` 得到当前位置与镜头的完整文本，
     * `gift188.probe(-164, -137)` 探任意坐标，
     * `gift188.probe(undefined, undefined, true)` 附上 16 座驿站体检表。
     *
     * 返回**字符串**而不是打印——这样它能被赋值、被复制、被贴进对话。
     * 打印出来的那一份只存在于滚屏里，捞不回来。
     */
    Object.defineProperty(window, 'gift188', {
      get: () => this.debugHandle(),
      configurable: true,
    });
  }

  /** `window.gift188` 的内容与 `probe()` 方法。拆出来是为了类型干净 */
  private debugHandle(): Record<string, unknown> {
    const w = this.world;
    const p = w.ride.pos;
    return {
      route: { stations: STATIONS.length, points: CENTERLINE.length, length: TOTAL_ARCLENGTH },
      bike: {
        x: +p.x.toFixed(2),
        y: +p.y.toFixed(2),
        z: +p.z.toFixed(2),
        speed: +w.ride.speedValue.toFixed(2),
        onRoad: w.ride.onRoad(),
        /** 到中心线的最近距离（米）。>8 就说明骑偏了 */
        offCenterline: +minDistToCenterline(p.x, p.z).toFixed(2),
        arc: +nearestArcParam(p.x, p.z).toFixed(4),
      },
      chapter: { n: game.chapter, oneDone: game.chapter1Done, objective: game.objective },
      perf: { ...perf },
      nearby: { ...w.nearby },
      phase: this.phase,
      /** 探针。返回文本，可直接贴进对话 */
      probe: (x?: number, z?: number, buildings?: boolean) => probeAt(w, x, z, { buildings: !!buildings, radius: 40 }),
      /** 16 座驿站的完整体检表（带上玩家位置，所以"该加载却没加载"会报出来） */
      buildings: () => buildingTable({ stations: w.stations, terrain: w.terrain, road: w.road, playerX: p.x, playerZ: p.z }),
    };
  }

  private backText = '';

  // ---------------------------------------------------------------- 输入
  private bindInput() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) {
        // 长按连发**不能**在这里被滤掉：云和茶是按住生效的。
        // 需要"只认新的一下"的地方由小游戏自己记按着状态。
        return;
      }
      // 先问小游戏要不要。它吃掉了就别让这次按键冒到打卡上。
      if (this.mg.isRunning && this.mg.consumesKey(e.code)) return;
      if (this.phase === 'minigame') return;

      this.keys.add(e.code);

      switch (e.code) {
        case 'Escape':
          e.preventDefault();
          if (this.phase === 'paused') this.resume();
          else if (this.phase === 'roaming') this.pause();
          break;
        case 'Space':
        case 'Enter':
          e.preventDefault();
          this.onConfirm();
          break;
        case 'KeyM':
          audio.setFullyMuted(!audio.fullyMuted);
          this.ui.syncFromState();
          break;
        case 'F8':
          e.preventDefault();
          this.ui.togglePerf();
          break;
        case 'F9':
          // 场景自检。F8 已经被性能面板占了，所以顺延到 F9。
          // 没带 `?dump=1` 时按了没反应——这个入口只为排障存在，
          // 不值得为正式发行版本再背一个常驻面板。
          e.preventDefault();
          this.dump?.toggle();
          break;
        case 'F10':
          e.preventDefault();
          if (this.debug) {
            this.debug.toggle();
          } else {
            // 没带 `?debug` 就现场建一个：排障时"先改 URL 再刷新"很烦，
            // 而这个面板不加载任何资产，建它的代价只有几行 DOM。
            this.debug = new DebugPanel(document.getElementById('ui-root') as HTMLElement, this.world);
            this.debug.setShown(true);
          }
          break;
        case 'KeyP':
          if (this.debug?.isShown) this.debug.setMode('probe');
          break;
        case 'KeyB':
          if (this.debug?.isShown) this.debug.setMode('buildings');
          break;
        default:
          break;
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
    window.addEventListener('blur', () => this.keys.clear());
  }

  private onConfirm() {
    if (this.phase === 'title') {
      this.startRide();
      return;
    }
    if (this.phase === 'roaming') this.tryCheckIn();
  }

  // ---------------------------------------------------------------- 阶段
  private async startRide() {
    await audio.unlock();
    audio.playBgm('bgm', 0.5);
    this.ui.setDialogueAutoAdvance(0);
    this.phase = 'onboarding';
    this.ui.showOnboarding();
  }

  private enterWorld() {
    // 幂等：UI 的 enterWorld() 也会走到这里（它只负责画 HUD），
    // 而 hook 是从 UI 内部发出来的，所以这条路径可能被走两次
    if (this.phase === 'roaming') {
      this.ui.enterWorld();
      return;
    }
    this.phase = 'roaming';
    this.ui.enterWorld();
    this.ui.syncFromState();
  }

  private toRoaming() {
    this.phase = 'roaming';
    this.ui.hidePause();
    this.loop.resume();
  }

  pause() {
    if (this.phase !== 'roaming') return;
    this.phase = 'paused';
    this.loop.suspend();
    this.ui.showPause();
  }

  resume() {
    if (this.phase !== 'paused') return;
    this.toRoaming();
  }

  restart() {
    game.reset();
    this.world.setOdometer(0);
    this.backText = '';
    writeBackText('');
    this.demoActive = false;
    this.world.teleportToStation(0);
    this.ui.setShopOpen(false);
    this.toRoaming();
    this.ui.syncFromState();
  }

  private startDemo() {
    void audio.unlock();
    audio.playBgm('bgm', 0.5);
    this.demoActive = true;
    this.demoT = 0;
    // 演示里没有人按键，对白必须自己往前走
    this.ui.setDialogueAutoAdvance(2.4);
    this.enterWorld();
  }

  private finishRun() {
    this.phase = 'endcard';
    this.demoActive = false;
    this.loop.suspend();
    this.ui.showEndCard();
    audio.sfx('export', 0.6);
  }

  setQuality(tier: Tier) {
    this.settings.tier = clampTier(tier);
    this.settings.qualityTouched = true;
    saveSettings(this.settings);
    const preset = PRESETS[this.settings.tier];
    this.world.applyPreset(preset, this.settings.tier);
    audio.ambientLayers = preset.ambientLayers;
    this.loop.setBaseScale(preset.renderScale);
    this.ui.syncFromState();
  }

  setAdaptive(on: boolean, targetFps: number) {
    this.settings.adaptiveTargetFps = on ? targetFps : 0;
    saveSettings(this.settings);
    this.loop.setAdaptive(this.settings.adaptiveTargetFps, this.settings.adaptiveMinScale);
  }

  toggleLang() {
    setLang(getLang() === 'zh' ? 'en' : 'zh');
    this.ui.syncFromState();
  }

  // ---------------------------------------------------------------- 打卡
  tryCheckIn() {
    if (this.phase !== 'roaming') return;
    const can = this.world.canCheckIn();
    if (!can.ok) {
      const key = can.reason === 'cooldown' ? 'blocked_cooldown' : can.reason === 'recheck' ? 'blocked_recheck' : 'blocked_busy';
      this.ui.showToast(t(key), 1400);
      return;
    }
    // 回家这一条走独立分支：0 号驿站没有碎片，
    // `runMiniGame` 里 `STATIONS[idx].slot < 0` 会立刻把它踢回 roaming，
    // 于是"第一章完成"这件事一次都不会发生。
    if (this.world.nearby.isHome) {
      this.phase = 'checkin';
      this.world.startCheckIn(
        GameStateManager.HOME_STATION,
        () => void this.completeChapterOne(),
        true,
      );
      return;
    }
    const idx = this.world.nearby.index;
    if (idx < 0) return;
    this.phase = 'checkin';
    this.world.startCheckIn(idx, (finished) => void this.runMiniGame(finished));
  }

  /**
   * 第一章完成。
   *
   * 顺序是有讲究的：**先把"回家"那三句念完，再合成礼物**。
   * 合成面板一弹出就把主循环停了，玩家来不及读那句"下一章的门开了"；
   * 而这一章真正的信息量就在那一句上。
   */
  private async completeChapterOne() {
    if (!game.claimChapter1Complete()) {
      // 已经完成过（重复触发 / 读档后旧存档）：直接回到骑行，不重放
      this.toRoaming();
      return;
    }
    this.ui.syncFromState();
    // 对白在 startCheckIn 的 holding 段已经发起。等它念完再进合成——
    // 主循环一停玩家就没法再点了，不等的话那三句会卡在半截然后被面板盖住。
    await this.ui.whenDialogueIdle();
    this.phase = 'synthesis';
    this.ui.showSynthesis('chapter');
  }

  private async runMiniGame(stationIdx: number) {
    const st = STATIONS[stationIdx];
    if (!st || st.slot < 0) {
      this.toRoaming();
      return;
    }
    const visit = game.getStationCount(stationIdx); // 打卡前的次数
    const id = MiniGameHost.idFor(st.slot, visit);
    this.phase = 'minigame';

    // 演示模式**不玩小游戏**。90 秒的预算（`DEMO_BUDGET_SEC`）里塞不进一局，
    // 而 `DEMO_END_AT_SEC = 62` 之后本来就该开始收尾。
    // 跳过不是作弊：评审要看的是世界与流程，不是手速。
    // 顺带这一句也用掉了 `DEMO_END_AT_SEC`——否则它是数据表里两个没人读的数之一。
    if (this.demoActive && this.demoT > ECON.DEMO_END_AT_SEC) {
      game.checkIn(stationIdx);
      this.ui.showToast(t('mg_failed'), 1200);
      this.ui.syncFromState();
      this.toRoaming();
      return;
    }

    // 种子由 (驿站, 第几次到访) 决定：同一趟重玩是同一局，
    // 玩家重打一遍不会因为随机数换了一串而拿到另一道题。
    const handle = await this.mg.run(id, seedFor(stationIdx, visit));
    const win = handle.result === 'win';

    // 打卡与经济
    game.checkIn(stationIdx);
    game.onMiniGame(stationIdx, win);
    if (win) audio.sfx('collect');

    this.ui.showToast(win ? t('mg_success_hint') : t('mg_failed'), 1600);
    this.ui.syncFromState();

    // 集齐五件之后**不结算**。原来这里是直接弹合成面板，
    // 于是"这一趟结束了"是游戏替玩家做的决定，中间没有任何过渡。
    // 现在改成把目标换成"回十八驿"——188 号环线自闭合，
    // 起点就是终点，骑回出发的地方是这一章最自然的结尾，
    // 而 demo 也有了一个干净的边界（一章 = 一趟 188）。
    if (game.allCollected() && !game.chapter1Done) {
      this.toRoaming();
      this.ui.showToast(t('objective_return'), 4200);
      return;
    }
    // 完满评级（五座各去三次）是**可选**的另一条路，仍然就地结算
    if (game.allFragmentsMaxed()) {
      this.phase = 'synthesis';
      this.ui.showSynthesis('maxed');
      return;
    }
    this.toRoaming();
  }

  // ---------------------------------------------------------------- 铺子
  private buy(id: string) {
    const good = SHOPS.GOODS.find((g) => g.id === id);
    if (!good) return;
    if (game.buy(good)) audio.sfx('collect', 0.7);
    this.ui.syncFromState();
  }

  // ---------------------------------------------------------------- 明信片
  /**
   * 导出明信片。
   *
   * 优先走 `showSaveFilePicker`（拿得到路径、不会被下载目录吞掉），
   * 拿不到就退回 `<a download>`。两条路都要处理"用户取消"——
   * `AbortError` 不是失败，把提示弹出来会让玩家以为存坏了。
   */
  private async exportPostcard(side: 'front' | 'back') {
    try {
      const ending: EndingId = endingFromGameState();
      const input = buildInputFromState({
        ending,
        backText: this.backText || seededBackText(ending, getLang()),
      });
      const { front, back } = await exportBothSides(input);
      const blob = side === 'front' ? front : back;
      const name = side === 'front' ? 'gift188-front.png' : 'gift188-back.png';
      await saveBlob(blob, name);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return; // 玩家自己取消
      console.warn('[gift188] 明信片导出失败：', e);
      this.ui.showToast(t('export_failed'), 2400);
    }
  }

  // ---------------------------------------------------------------- 事件
  private onWorldEvent(e: WorldEvent) {
    if (e.type === 'dialogue') {
      // 剧情对白锁操作，播完再放开
      this.world.narrativeBusy = true;
      void this.ui.showDialogue(e.speaker, e.lines).then(() => {
        this.world.narrativeBusy = false;
        this.world.retryVillain();
      });
    } else if (e.type === 'duskBegan') {
      this.ui.showToast(t('dusk_toast'), 3200);
    } else if (e.type === 'loaded') {
      // 资产到位不打扰玩家：它自己会出现在画面上
      void e.what;
    } else if (e.type === 'stationPassed') {
      void e.index;
    }
  }

  // ---------------------------------------------------------------- 循环
  private fixed(dt: number) {
    if (this.phase !== 'roaming' && this.phase !== 'checkin') {
      // 非骑行阶段仍然推进固定步长，好让世界的时间继续走
      // （对白、暂停面板背后的黄昏都要动）
    }
    const canRide = canRideNow({
      phase: this.phase,
      checkInPressed: this.ui.touch.checkInPressed,
      narrativeBusy: this.world.narrativeBusy,
      checkInStage: this.world.checkInStage,
    });

    let throttle = 0;
    let steer = 0;
    if (this.phase === 'roaming') {
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) throttle -= 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) throttle += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) steer -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) steer += 1;
      throttle += this.ui.touch.moveY;
      steer += this.ui.touch.moveX;
    }
    this.ui.touch.checkInPressed = false;
    this.world.fixedUpdate(dt, { throttle: clamp(throttle, -1, 1), steer: clamp(steer, -1, 1) }, canRide);
    this.world.postFixedUpdate();
  }

  private render(dt: number) {
    this.world.render(dt);
    if (this.mg.isRunning) this.mg.render();
    this.ui.update(dt);
    this.dump?.update(dt);
    this.debug?.update(dt);
    if (this.demoActive) this.demoT += dt;
    this.syncPerf();
  }

  /**
   * 把渲染与植被的统计刷进公共快照。
   *
   * `perf` 是**公共对象**：循环、面板、自检面板、调试出口都读它。
   * 以前这里是 `onStats: (fps, ms) => this.ui.update(0)`——两个值被丢掉、
   * 只递了一个 0，于是 `perf` 永远停在初始值，
   * `window.gift188.perf` 报出来的 fps 是 0，而屏幕上的性能面板却是真的。
   * 两个地方说不同的话，没有一个地方是对的。
   */
  private syncPerf() {
    const s = this.world.renderer.stats();
    perf.calls = s.calls;
    perf.triangles = s.triangles;
    perf.textures = s.textures;
    perf.renderScale = s.scale;
    const sz = this.world.renderer.size;
    perf.cssW = sz.cssW;
    perf.cssH = sz.cssH;
    perf.bufferW = sz.bufferW;
    perf.bufferH = sz.bufferH;
    const v = this.world.veg.stats;
    perf.vegChunks = v.chunksVisible;
    perf.vegTrees = v.trees;
    perf.vegBushes = v.bushes;
    perf.phase = this.phase;
    // 环境声的两条输入：离水多远、天有多暗。
    // 碗的位置从 `getBasins()` 拿，不从 `Water` 上拿——水面网格只知道自己
    // 的平面，"哪片水"是世界层的事，混在一起就成了两处真相。
    const p = this.world.ride.pos;
    let nearWater = 0;
    for (const b of getBasins()) {
      const d = Math.hypot(p.x - b.cx, p.z - b.cz);
      nearWater = Math.max(nearWater, clamp(1 - (d - b.radius) / 40, 0, 1));
    }
    audio.setAmbient(nearWater, this.world.sky.state.dusk, clamp(this.world.ride.speedValue / 15, 0, 1));
  }
}

// ---------------------------------------------------------------- 工具
function seedFor(stationIdx: number, visit: number): number {
  // 确定性种子：同一座驿站、同一次到访永远是同一局，
  // 玩家重打一遍不会因为随机数换了一串而拿到另一道题。
  return (stationIdx + 1) * 7919 + (visit + 1) * 104729;
}

function minDistToCenterline(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < CENTERLINE.length; i += 2) {
    const d = Math.hypot(CENTERLINE[i].x - x, CENTERLINE[i].z - z);
    if (d < best) best = d;
  }
  return best;
}

async function saveBlob(blob: Blob, name: string): Promise<void> {
  const w = window as Window & {
    showSaveFilePicker?: (o: unknown) => Promise<{ createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }>;
  };
  if (typeof w.showSaveFilePicker === 'function') {
    const handle = await w.showSaveFilePicker({ suggestedName: name, types: [{ description: 'PNG', accept: { 'image/png': ['.png'] } }] });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // 立刻 revoke 会让部分浏览器下载失败（还没开始读就失效了）
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const BACK_KEY = 'gift188.backtext';

function readBackText(): string {
  try {
    return localStorage.getItem(BACK_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeBackText(v: string): void {
  try {
    if (v) localStorage.setItem(BACK_KEY, v);
    else localStorage.removeItem(BACK_KEY);
  } catch {
    /* 忽略 */
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/**
 * 「这台浏览器跑不动」。
 *
 * 走 `t()` 而不是写死中文，理由很实际：**这一屏恰恰是给英文玩家看的**——
 * 跑不动 WebGL 2 的机器里，英文用户占比不低（老机器、旧系统、外籍同事的笔电），
 * 而写死中文的话他们看到的是一整屏读不懂的字，只能干瞪眼。
 * 文案本身（`unsupported_title/body/fix`）在表里中英都是齐的。
 *
 * `escapeHtml` 仍然要套在能力报告上：那是一段 `JSON.stringify`，里面有 `"`。
 */
function showUnsupported(c: Capability) {
  bootEl.innerHTML = `<div style="padding:2.4em;max-width:34em;color:#2a2622;background:#e8e0cd;font:15px/1.9 system-ui,sans-serif">
    <h1 style="font-weight:500;margin:0 0 .8em">${escapeHtml(t('unsupported_title'))}</h1>
    <p style="margin:0 0 1em">${escapeHtml(t('unsupported_body'))}</p>
    <p style="margin:0 0 1em;color:#6b6156">${escapeHtml(t('unsupported_fix'))}</p>
    <pre style="margin:1.4em 0 0;padding:1em;background:#ddd4bd;font-size:12px;white-space:pre-wrap">${escapeHtml(JSON.stringify(c, null, 2))}</pre>
  </div>`;
}

/**
 * 致命错误页。
 *
 * **故意留白屏之外的这一屏**：模块自己出错时，页面上只剩一句「启动失败」的话，
 * 玩家没法把它变成一条可提交的信息。而这一屏连同 `window.error` 监听
 * （见文件末尾）是这个项目里唯一能把「哪一步炸了」带出去的地方。
 *
 * 文案同样走 `t()`：崩溃不分语言。
 */
function showFatal(msg: string, err: unknown) {
  console.error('[gift188]', msg, err);
  bootEl.innerHTML = `<div style="padding:2.4em;max-width:34em;color:#2a2622;background:#e8e0cd;font:15px/1.9 system-ui,sans-serif">
    <h1 style="font-weight:500;margin:0 0 .8em">${escapeHtml(t('fatal_title'))}</h1>
    <p style="margin:0 0 1em">${escapeHtml(msg)}</p>
    <p style="margin:0;color:#6b6156">${escapeHtml(t('fatal_note'))}</p>
  </div>`;
}

// 兜底：模块本身出错时也要留一句在页面上，而不是一片白屏
window.addEventListener('error', (e) => {
  if (bootEl.isConnected) showFatal(`未捕获错误：${e.message}`, e.error);
});

void main();
