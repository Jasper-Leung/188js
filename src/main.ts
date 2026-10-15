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
import { initLang, setLang, getLang, t, onLangChange } from './i18n';
import { World, type WorldEvent } from './world/world';
import { Lakeside, type LakesideFrame } from './world/lakeside';
import { XrSession } from './core/xr';
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
import { ECON, SHOPS, RIDE, ROAD as ROAD_RAW } from './data/raw';
import { UI } from './ui';
import { setSpaceKeyOwner, stationName } from './ui/hud';
import { clamp } from './core/math';
import { perf } from './core/perf';
import { getBasins } from './world/basins';
import { installTouchDetection, touchEnabled, setTouchMode } from './core/touch';
import { SceneDump } from './ui/sceneDump';
import { DebugPanel } from './debug/panel';
import { probeAt, buildingTable } from './debug/probe';
import { buildInputFromState, endingFromGameState, exportFileName, exportPostcardPng, seededBackText, type EndingId } from './game/postcard';

import { afterCheckInRoute, canRide as canRideNow, confirmAction, interactAt, demoAim, demoInput, unwrapArc, silentSpaceReply, SCENERY_SAY_M, STATION_REACH, type Phase, type SettleOutcome } from './game/phase';
import { createLiveApi, type LiveApiHost } from './game/api';
import type { AiObservation } from './game/api';
import type { BeatEvent } from './game/beat';
import { roadSpawnPose, type RideInput } from './world/ride';
import { actionOf, codeOf, setKeymap, type GameAction } from './core/keymap';
import { MODE_TUNE } from './world/vehicle';

const bootEl = document.getElementById('boot') as HTMLElement;
const bootSub = document.getElementById('boot-sub') as HTMLElement;
const bootFill = document.getElementById('boot-fill') as HTMLElement;
const bootPct = document.getElementById('boot-pct') as HTMLElement;

/**
 * 把 `data-i18n="键名"` 的静态骨架按当前语言填上。
 *
 * 启动屏是**唯一一块在 UI 建好之前就在屏幕上的界面**，
 * 所以它不能只靠 `t()` 在别处渲染：那些调用点还不存在。
 * 做法是骨架里写英语占位、这里按语言覆写——占位必须等于默认语言，
 * 否则玩家会看到"先中文、后英文"的一跳。
 *
 * 语言切换时也要重跑一次：启动屏通常在切换之前就被摘掉了，
 * 但那只是通常，而这一行是它唯一的兜底。
 */
function applyStaticI18n(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n ?? '');
  }
  document.title = t('game_title');
  // `<html lang>` 跟着语言走：它决定读屏软件的语音、浏览器的翻译提示，
  // 以及一部分系统字体回退。中文玩家拿到 `lang="en"` 会在无障碍工具上读错。
  document.documentElement.lang = getLang() === 'zh' ? 'zh-CN' : 'en';
}

/** 页面标题：`<游戏名> · <当前步骤>`。切语言后要跟着换游戏名那一半。 */
function setDocTitle(step: string): void {
  document.title = `${t('game_title')} · ${step}`;
}

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
  // **语言必须先于任何一句 `t()`**。原来这里是反的：
  // `boot(0.02, t('loading'))` 在前、`initLang()` 在后，于是启动屏第一句
  // 用的还是模块顶上的默认值——一个已经选了英语的玩家，
  // 每次启动看到的头一句都是「正在加载中...」。
  initLang();
  applyStaticI18n();
  onLangChange(() => applyStaticI18n());
  boot(0.02, t('loading'));
  await registerFonts();

  const capability: Capability = detectCapability();

  // 调试入口：`?caps` 只跑能力探测，不建世界。
  // 存在的原因很实际：软件渲染的机器上，启动整个世界要几十秒，
  // 而"这台机器被判成哪一档、理由是什么"是第一个要回答的问题。
  // 让它进游戏流程去问，等于每次都要先付那几十秒。
  if (new URLSearchParams(location.search).has('caps')) {
    // 判定理由是**键 + 参数**，所以把翻译后的那句也打出来：
    // 只看 `reasonKey` 谁都得自己回表里查，而这一屏存在的意义
    // 恰恰是"这台机器被判成了什么、为什么"。
    document.body.innerHTML = `<pre style="padding:2em;font:13px/1.7 ui-monospace,monospace;color:#2a2622;background:#e8e0cd;white-space:pre-wrap">${escapeHtml(
      JSON.stringify(capability, null, 2) +
        '\n\n' +
        `reason: ${t(capability.reasonKey, capability.reasonVars)}\n\n` +
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
    showFatal(t('fatal_world', [e instanceof Error ? e.message : String(e)]), e);
    return;
  }
  boot(0.62);
  await nextFrame();

  // ---- 资产渐进加载：先能玩，再补好看 ----
  //
  // **进度条跟这条链，但启动屏不等它。**
  // 原来 `bootDone()` 挂在链的末尾，于是任何一个 GLB 悬住（弱网、代理、
  // 服务端 200 但不发 body）都会让玩家盯着一根停在 62% 的进度条——
  // 而此时世界已经建好、路能骑、标题页能用，只差一辆自行车。
  // "能不能玩"和"画得全不全"是两件事，不该用后一件卡住前一件。
  /**
   * 三组资产**并行**跑，不再排队。
   *
   * ## 原来那条链为什么慢
   *
   * 它是 `bike → vegetation → (scenery + extras)` 的**串行**链，
   * 而这三组的体量分别是 **2.79MB / ~2.1MB / ~7.2MB**。
   * 串行意味着总时间 = 三者之和 ≈ 12MB 的传输时间，
   * 而它们彼此之间**没有任何依赖**（植被不关心车模长什么样，反之亦然）。
   *
   * 实测症状：每次开页都命中 20 秒硬超时
   * （`[gift188] model loading timed out (20000ms), continuing`），
   * 于是路边一直没有树、角色一直没到、演示按钮一直点不亮。
   *
   * 改成并行之后总时间 = **max(三组)**，不是 sum。
   * 20 秒的阈值没动——它本来就不是"够不够用"的旋钮，
   * 它是"请求是不是真的挂住了"的信号（GLTFLoader 没有内建超时）。
   */
  const bikeChain = world.loadBikeModel().then(() => boot(0.78));
  const restChain = Promise.all([
    // 植被其次（没有它世界是空的但路能骑）
    world.loadVegetationModels().then(() => boot(0.9)),
    // 载具配件（滑板 + 角色）与区域散布都是**可选**的：
    // 拉不到只是不能换滑板 / 少一片竹，不该拖住整条链。
    world.loadSceneryModels(),
    world.loadVehicleExtras(),
  ]).then(() => boot(1));
  const assetChain = Promise.all([bikeChain, restChain])
    .then(() => {
      audio.prefetchSfx();
    })
    .catch((e) => {
      // 模型拉不到不该让整局玩不成：世界照样能骑，只是路边没有树
      console.warn('[gift188]', t('warn_models_partial'), e);
      boot(1);
    });
  // 硬超时：GLTFLoader 没有内建超时，悬住的请求会永远 pending。
  // 20 秒足够 localhost 与正常宽带走完这几组，也足够在慢网下给出"它不来了"的信号。
  //
  // ## 这一条**什么都不丢**，评审记了两次是因为它读起来像在丢
  //
  // 第九轮与第十轮都提过它，两次的猜测是「慢网玩家会少看到几座地标，
  // 而他们不会知道」。**那是错的，`withTimeout` 的实现决定了这不可能**：
  //
  //   · 它是 `Promise.race([p, 只打警告的定时器])` —— 定时器那一支
  //     `console.warn` 之后 `r()`，**不 reject、不 abort、不清任何缓存**；
  //   · 调用点是 `void`，返回值整个丢掉，所以它连"替 p 兜底"都不是；
  //   · `assetChain` 自己那侧仍然在跑，它落定的时候照样调 `boot(1)`。
  //
  // 所以慢网玩家看到的是**更晚看到树**，不是**永远看不到树**。
  // 那条 `warn_model_timeout` 文案自己写着 "continuing"，
  // **它是准确的**——只是它长得像一条失败。
  //
  // ⚠ **这里唯一不能改的是「不要把它改成真的会取消的那一种」**：
  // 一旦有人为了"更干脆"给它加上 abort，那一改才是真的丢资产，
  // 而且症状是"某些玩家路边永远没有树"——极难归因。
  void withTimeout(assetChain, 20_000, t('warn_model_timeout'));

  // **摩托车单独一条链**，不进上面的 `assetChain`。
  //
  // 理由是它 3.4MB，而 `assetChain` 外面套着 20 秒硬超时：
  // 塞进那个 `Promise.all` 就等于让**最慢的那一个**决定整条链的成败——
  // 弱网下滑板和角色早就到了，进度条却卡在 0.9 直到超时，
  // 玩家看着一个明明已经能玩的游戏迟迟不开始。
  //
  // 它是纯附加的可选载具：晚几秒出现，`E` 就在 `canEnter` 上跳过它，
  // 玩家什么都不必等。**不进链也就不会被那次超时波及。**
  void world.loadMotorcycleModel().catch((e) => console.warn('[gift188]', t('warn_motorcycle'), e));

  // ---- 游戏状态机 ----
  const app = new App(world, settings, capability);
  await app.ready();
  audio.prefetchSfx();
  // 到这里世界已经可交互（能骑、能打卡、能进世界），**撤启动屏**。
  // 自行车与植被还在后面流式补上，进标题页时通常已经到了，
  // 慢一点的话它们会在标题页背后自己出现——比一根不动的进度条好。
  boot(1);
  bootDone();

  if (new URLSearchParams(location.search).has('cine')) installCineMode(app);
}

/**
 * `?cine=1` —— 录制模式。给外部录制脚本用。
 *
 * 基础行为（拍空镜 B Roll 用的）：
 *   · 循环切到确定性模式：每帧固定推进 1/60 秒，帧序号 `frame` 可查
 *   · 隐藏整个 UI（它是**一个** `#ui-root` 节点，`display:none` 一次全没）
 *   · 接管相机，位姿完全由 `window.gift188.cine` 给
 *
 * 两个开关，用来把上面三条拆开单独关掉：
 *
 * | 追加参数 | 效果 | 什么时候用 |
 * |:---|:---|:---|
 * | `ui=1` | **保留 UI** | 录 walkthrough：玩家得看见 HUD、打卡提示、碎片计数 |
 * | `cam=game` | **不接管相机** | 录真实操作：让游戏自己的机位跟着人走 |
 *
 * 例：
 *   拍空镜    `?tier=2&cine=1`
 *   录操作    `?tier=2&cine=1&ui=1&cam=game`
 */
function installCineMode(app: App): void {
  const q = new URLSearchParams(location.search);
  const keepUi = q.get('ui') === '1';
  const gameCam = q.get('cam') === 'game';

  if (!keepUi) {
    const uiRoot = document.getElementById('ui-root');
    if (uiRoot) uiRoot.style.display = 'none';
  }

  // 世界与循环都在 App 私有字段上，这里用一次性的桥接取出来。
  // （TS 的 `private` 只是编译期约束；录制出口本来就该走同一条路。）
  const anyApp = app as unknown as {
    world: {
      ride: {
        pos: { x: number; y: number; z: number };
        setCameraLocked(v: boolean): void;
        setHideCharacter(v: boolean): void;
        spawn(x: number, z: number, heading?: number): void;
        placeCamera(x: number, y: number, z: number, lx: number, ly: number, lz: number): void;
      };
    };
    loop: {
      deterministic: boolean;
      frame: number;
      timeScale: number;
      stepOnce(): void;
      setManual(v: boolean): void;
      stop(): void;
      start(): void;
    };
  };
  const ride = anyApp.world.ride;

  // 自由机位：接管之后 Ride.render() 里的跟随逻辑会整段跳过，
  // 所以位姿完全由外部给，不会被 damp 拉回去。
  // `cam=game` 时不接管 —— 走操作流程时要用游戏自己的机位。
  anyApp.loop.deterministic = true;
  if (!gameCam) ride.setCameraLocked(true);

  const D = Math.PI / 180;
  const base = { x: ride.pos.x, y: ride.pos.y + 2, z: ride.pos.z };

  const cine = {
    /** 已渲染的帧数。录制脚本等它跳到目标值再截图。 */
    get frame() {
      return anyApp.loop.frame;
    },
    /** 慢放：0.25 就是四分之一速。0 = 停。 */
    set speed(v: number) {
      anyApp.loop.timeScale = v;
    },
    /**
     * 手动步进：`true` 之后 rAF 停掉，画面只在 `cine.step()` 被调用时才前进。
     *
     * 为什么需要它：`--disable-frame-rate-limit` 会让 rAF 跑到几百 Hz，
     * 于是"等第 N 帧"在两次 CDP 往返之间就已经冲过去一百多帧，
     * 录出来变成每 143 帧抽 1 帧——**人几乎没动，而代码不报错**。
     * 逐帧要就没有这个竞态。
     */
    set manual(v: boolean) {
      const l = anyApp.loop as { stop?: () => void };
      if (v) { anyApp.loop.stop?.(); anyApp.loop.setManual?.(true); }
      else { anyApp.loop.setManual?.(false); anyApp.loop.start?.(); }
      void l;
    },
    /** 精确推进一帧，返回新的帧号。 */
    step() {
      anyApp.loop.stepOnce();
      return anyApp.loop.frame;
    },
    /**
     * 空镜：`true` 之后**任何机位都看不到人**。
     * 第一视角下角色本来就挡镜头（机位在头后 15cm），但绕拍、定机位时
     * 画面里还是会站着一个人——录风景素材要的是"没有人"，所以单独给一个开关。
     */
    set noCharacter(v: boolean) {
      ride.setHideCharacter(v);
    },
    /** 从角色背后绕过去拍。yaw/pitch 是角度，dist 是米。 */
    orbit(yawDeg: number, pitchDeg: number, dist = 6, height = 2) {
      const yaw = yawDeg * D;
      const pitch = pitchDeg * D;
      const x = base.x - Math.sin(yaw) * Math.cos(pitch) * dist;
      const z = base.z - Math.cos(yaw) * Math.cos(pitch) * dist;
      const y = base.y + height + Math.sin(pitch) * dist;
      ride.placeCamera(x, y, z, base.x, base.y, base.z);
    },
    /** 直接给机位。最自由，也最需要调用方自己算好朝向。 */
    pose(x: number, y: number, z: number, lx: number, ly: number, lz: number) {
      ride.placeCamera(x, y, z, lx, ly, lz);
    },
    /** 直接把角色瞬移到某个世界坐标。录 B Roll 时省得一路骑过去。 */
    goto(x: number, z: number, heading = 0) {
      ride.spawn(x, z, heading);
      base.x = ride.pos.x;
      base.y = ride.pos.y + 2;
      base.z = ride.pos.z;
    },
    /** 放回角色第一/第三人称。 */
    follow() {
      ride.setCameraLocked(false);
    },
    /** 停在当前帧不动了。定格用。 */
    freeze() {
      anyApp.loop.timeScale = 0;
    },
    /** 恢复推进。 */
    play() {
      anyApp.loop.timeScale = 1;
    },
  };

  /**
   * 把 `cine` 并进 `window.gift188`，其余字段保持是**活的**。
   *
   * ⚠️ 这里原来写的是 `const prev = window.gift188` —— 那是在**安装这一刻**
   * 把上一个 getter 的返回值（一个普通对象）取出来存成了快照，
   * 于是之后每次读到的 `bike.x / bike.z / speed / heading / phase / input`
   * 全是**启动那一刻**的值。
   *
   * 症状极坏：录制脚本读到的车永远停在出生点——"车不动"，
   * 于是所有结论都建立在一份冻结数据上：控制器对不对、A/D 符号、
   * 能不能到站，读的全是同一份开机快照，而且**不报任何错**。
   * （`canRide` 恒为 true、弧长恒为 112m、按键计数恒为 0，
   *  每一项单独看都"合理"，合起来才是 bug。）
   *
   * 所以这里存的是**上一个 getter 本身**，每次读都重新调用它。
   */
  const prevDesc = Object.getOwnPropertyDescriptor(window, 'gift188');
  Object.defineProperty(window, 'gift188', {
    configurable: true,
    get: () => {
      const live = prevDesc?.get ? prevDesc.get() : prevDesc?.value;
      const base188 = typeof live === 'object' && live !== null ? (live as Record<string, unknown>) : {};
      // 每读一次都重新取：bike/phase/input 必须是当前值，cine 才是录制控制
      return { ...base188, cine };
    },
  });
}

/** 给一条可能永远 pending 的 promise 加硬超时 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | void> {
  return Promise.race([
    p,
    new Promise<void>((r) =>
      setTimeout(() => {
        console.warn(`[gift188] ${t('boot_slow_step', [label, ms])}`);
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
  /**
   * 相位。**整个宿主里唯一被写的地方是 `goPhase()`。**
   *
   * 原来它在**十一处**被直接赋值，想回答"现在能处于哪些相位、谁负责切"，
   * 只能把十一个赋值点和它们各自的守卫条件连着读一遍。
   * 现在那十一处都走 `goPhase()`，而允许的迁移列在 `game/phase.ts`
   * 的 `PHASE_EDGES` 里。
   *
   * 读这一格的地方有一大堆（`canRide` / `isInWorld` / 键位分支 / …），
   * 所以它**是**公开的；只是不再被随便写。
   */
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

  /**
   * 某个**动作**此刻按住了没有。
   *
   * 原来这一类是九处 `this.keys.has('KeyW')`，而键位一可重映射，
   * 那九处就必须跟着改——漏一处就得到"方向能重映射、刹车不能"这种
   * 半生不熟的状态，而玩家没有办法从界面上看出是哪一半坏了。
   *
   * 所以**物理键一律不在这条路径上出现**，全部走 `codeOf(action)`。
   */
  private held(action: GameAction): boolean {
    return this.keys.has(codeOf(action));
  }

  /** 物理键 → 动作（`null` = 没绑到任何可重映射动作）。 */
  private actionOf(code: string): GameAction | null {
    return actionOf(code);
  }

  /**
   * 湖边一屏。
   *
   * **它不是一颗"场景"，是一个挂在同一棵场景树上的 group**——
   * 见 `world/lakeside.ts` 文件头：`Renderer` 只持有一个 Scene 和一台相机，
   * 所以进出靠切可见性，而不是换场景。
   */
  private lakeside!: Lakeside;
  /** 指针拖动的累计位移。**每帧读完就清零**，所以它是"这一帧转了多少"。 */
  private lookDx = 0;
  private lookDy = 0;
  /** 湖边这一屏当前这一帧该怎么显示。宿主只把它交给 UI，不自己解释。 */
  private lakeFrame: LakesideFrame | null = null;
  /** XR。**浏览器不支持时它是 null**，而这一层在那种情况下不产生任何东西。 */
  private xr: XrSession | null = null;
  private xrEndHooks: Array<() => void> = [];

  /** 已经弹过"那边有东西"的旧物。**只活在本次会话**，不落盘。 */
  private relicHinted = new Set<string>();
  /** 片尾彩蛋只放一次。反复结算（反复点「结束这一趟」）不该被彩蛋刷屏。 */
  private epilogueShown = false;
  /** 已经报出过名字的旧物。和上面那个分开，理由见 `updateRelicHint`。 */
  private relicNamed = new Set<string>();
  private touchMode = false;
  private demoActive = false;
  /** 演示模式不碰玩家的存档位置（演示只是放一段给人看）。 */
  private demoSuppressPose = false;
  /** `?arc=` / `?yaw=` 传送优先于存档位置。 */
  private arcOverride = false;
  private demoT = 0;
  /**
   * 序章那七张叙事段落正在排队或正在演。
   *
   * **它管的是打卡，不是骑行**：车该动照动（序章本来就不锁操作）。
   * 只用它让开 `tryCheckIn()` 里的商店，理由见那里。
   *
   * 生命周期交给 `tryCheckIn()` 自查（叙事段落一空就自己落下），
   * 所以 `resetRun()` 不必管它——重开时序章会重新起播并把它重新置真。
   */
  private prologueBusy = false;
  /**
   * 玩家自己按过 `E` 没有。
   *
   * 它是「车到货时自动换成自行车」的唯一安全阀（`onAssetLoaded()`）：
   * 玩家表达过偏好的话，游戏就不再替他换。
   */
  private vehicleTouched = false;
  /**
   * 演示那辆车记住的弧长。-1 = 还没起步，第一帧直接采信 `nearestArcParam()`。
   *
   * 它必须自己记一份而不能每帧现取：8 字在中央穿过自己，
   * 现取的那一下会在两条支路之间跳（弧长差半圈），见 `demoDrive()`。
   */
  private demoArc = -1;

  constructor(world: World, settings: SettingsData, capability: Capability) {
    this.world = world;
    this.settings = settings;
    this.capability = capability;
    // **设置在构造时就生效**，不等玩家打开暂停面板。
    // 键位必须赶在第一次 `keydown` 之前灌进去——
    // 而 `this.keys` 在建世界那一刻就已经开始收键了。
    this.applyAccessibilitySettings();
  }

  /**
   * 把设置里那些"不是画质"的部分推到运行时。
   *
   * ## 为什么要单独一个方法而不是散在面板回调里
   *
   * 四样东西各有各的"生效时机"：
   *
   * · **音量 / 静音** —— 必须在 `AudioContext` 建起来**之前**摆好，
   *   否则首次解锁那一瞬间会先按默认音量放一段再被拉低。
   * · **键位** —— 必须在第一次 `keydown` 之前灌进去。
   * · **色觉** —— 一次 DOM 属性 + 一次 HUD 重绘。
   * · **减弱动效** —— 一次 DOM 属性，CSS 与 3D 两侧都读它。
   *
   * 而它们的**共同点**是：都能从设置面板之外的路径被触发
   * （启动、读档、切语言）。散在面板回调里的话，
   * "切语言之后静音没了"这种 bug 就会在两年后出现而没人想得起来为什么。
   */
  private applyAccessibilitySettings(): void {
    setKeymap(this.settings.keymap as Partial<Record<GameAction, string>>);
    audio.volBgm = this.settings.volBgm;
    audio.volSfx = this.settings.volSfx;
    audio.setFullyMuted(this.settings.mutedAll);
    if (audio.bgmMuted !== this.settings.mutedBgm) audio.setBgmMuted(this.settings.mutedBgm);
    if (audio.sfxMuted !== this.settings.mutedSfx) audio.setSfxMuted(this.settings.mutedSfx);
    // 构造函数里先调一次，那时 `ready()` 还没建 UI；UI 那半在建好之后补上
    if (!this.ui) return;
    this.ui.setColorblind(this.settings.colorblind);
    this.ui.setReduceMotion(this.settings.reduceMotion);
    // **第三颗不能漏。** 上面两颗有人修过（dff7a27），
    // 而它就是同类被漏掉的那颗——开关显示与运行时状态不一致，
    // 玩家开了「按住改切换」、重开之后开关写「关」。
    this.ui.setHoldToToggle(this.settings.holdToToggle);
  }

  /**
   * 切相位。**整个宿主里唯一写 `this.phase` 的地方。**
   *
   * ## 为什么只是"一个入口"而不是"一个闸门"
   *
   * 允许的迁移列在 `game/phase.ts` 的 `PHASE_EDGES` 里，而这里
   * **不拒绝**表外的迁移。原因很实在：本项目的回归**跑不到这个类**
   * （`World` 在无头环境里构造不出来），所以一张靠"跑一遍才知道全不全"
   * 的表去拒绝运行时迁移，等于把一个我从未观察到的行为变成硬失败，
   * 而这次重构的承诺是"行为不变"。
   *
   * 真正的强制点是**静态**的那一条：`verify_phase` 数 `this.phase =`
   * 在 `main.ts` 里出现几次，只能是 1（就是下面这行）。
   * 于是新增迁移**必须**先过这里，也就必然被表收编或者被回归抓住。
   */
  private goPhase(next: Phase): void {
    this.phase = next;
  }

  async ready() {
    // 启动阶段的每一步都留一句日志。
    // 理由很实际：用户报"一直卡在加载中"时，能给的只有一行截图，
    // 而"卡在第几步"和"卡在这一步的哪一行"是两种完全不同的故障。
    // 这里的标记刻意留在产物里——它们不花钱，而线上排查靠的就是它们。
    const mark = (key: string) => {
      const s = t(key);
      console.log(`[gift188] ${s}`);
      // 同时写进 title：它是这条链上唯一"一定拿得到"的信号。
      // 远程排障时能读到的往往只有一行截图或一个页面标题，
      // 而"卡在装配 UI"和"卡在显示标题页"是两个完全不同的故障。
      setDocTitle(s);
    };
    const root = document.getElementById('ui-root') as HTMLElement;

    mark('boot_step_ui');
    this.ui = new UI({
      parent: root,
      hooks: {
        onStart: () => this.startRide(),
        onContinue: () => this.continueRun(),
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
          // **静音现在落盘。** 原来三个布尔只是 `audio` 上的普通字段，
          // 于是**每一次开游戏都从"有声"开始**——
          // 聋人 / 听力不佳的玩家每次都要重新静音一次。
          // 这是「把静音当开关」和「把静音当设置」的区别。
          this.settings.mutedBgm = bgm;
          this.settings.mutedSfx = sfx;
          this.settings.mutedAll = all;
          saveSettings(this.settings);
        },
        onAccessibilityChange: (patch) => {
          // 音量：这里**只推给 audio，不落盘**——滑块的 `input` 每帧都发，
          // 在那上面写 `localStorage` 会在弱机上造成可测量的卡顿。
          // 落盘走下面的 `onVolumeCommit`（滑块的 `change`，松手时一次）。
          if (patch.volBgm !== undefined) audio.setVolume('bgm', patch.volBgm);
          if (patch.volSfx !== undefined) audio.setVolume('sfx', patch.volSfx);
          if (patch.colorblind !== undefined) {
            this.settings.colorblind = patch.colorblind;
            this.ui.setColorblind(patch.colorblind);
          }
          if (patch.reduceMotion !== undefined) {
            this.settings.reduceMotion = patch.reduceMotion;
            this.ui.setReduceMotion(patch.reduceMotion);
          }
          if (patch.holdToToggle !== undefined) {
            this.settings.holdToToggle = patch.holdToToggle;
            // 开关必须立刻推给 UI，否则面板上写着「开」而运行时读的是「关」。
            this.ui.setHoldToToggle(patch.holdToToggle);
          }
          saveSettings(this.settings);
        },
        onVolumeCommit: (volBgm, volSfx) => {
          // **这一次才落盘。** 少了它，音量每次重开都回到 100%——
          // 而界面上看不出任何异常，因为拖动当场是生效的。
          this.settings.volBgm = volBgm;
          this.settings.volSfx = volSfx;
          audio.setVolume('bgm', volBgm);
          audio.setVolume('sfx', volSfx);
          saveSettings(this.settings);
        },
        onKeymapChange: (keymap) => {
          this.settings.keymap = keymap;
          saveSettings(this.settings);
        },
        onLangToggle: () => this.toggleLang(),
        onCheckIn: () => this.tryCheckIn(),
        onShopBuy: (id) => this.buy(id),
        onShopClose: () => this.closeShop(),
        onTakePostcard: () => this.finishRun(),
        onKeepRiding: () => this.toRoaming(),
        onEndingPick: (e) => {
          game.setEnding(e);
          this.ui.syncFromState();
        },
        onCloseEndCard: () => this.closeEndCard(),
        onVrRequest: () => void this.onVrRequest(),
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

    mark('boot_step_minigame');
    this.mg = new MiniGameHost(root);

    mark('boot_step_input_mode');
    // 触屏判定要**在 UI 建好之前**就装上：玩家第一次用手指碰屏时就应该
    // 立刻挂出摇杆，而那时 UI 还不存在。装晚了，摇杆会等到下一次 touchstart
    // 才出现——而"按了一下才出现"正好是玩家最想避开的那种出现方式。
    installTouchDetection();
    this.touchMode = touchEnabled();
    this.ui.setTouchMode(this.touchMode);
    this.ui.setColorblind(this.settings.colorblind);
    this.ui.setReduceMotion(this.settings.reduceMotion);

    mark('boot_step_load');
    const loaded = game.load();
    this.backText = readBackText();

    mark('boot_step_loop');
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

    mark('boot_step_bind');
    this.bindInput();
    // 空格归谁：`wireKeyActivate` 靠它决定要不要独占空格。
    //
    // 只有**面板页**需要独占——那些按钮就是这一屏唯一的出口，按空格必须
    // 触发它们而不是漏到别处。小游戏页相反：它在 window 上收键，
    // 而云落笔 / 茶注水 / 竹下刀全靠空格，一路上任何一处 `stopPropagation()`
    // 都会让那一局变成"按了没反应"。
    //
    // 这里只答"是不是小游戏"，不答别的相位：`main.ts` 自己的 window 监听器
    // 对非小游戏相位已经各走各的分支（Space→onConfirm、Esc→暂停/继续），
    // 多答一份只会制造第二个判定点。
    setSpaceKeyOwner(() => !this.mg.isRunning);
    window.addEventListener('resize', () => this.world.renderer.resize());

    // 世界事件
    this.world.on((e) => this.onWorldEvent(e));
    // **补一次已经发生的事。**
    //
    // 资产链在 `new App()` 之前就起跑了（`main.ts` 启动那段），
    // 而这一行才是第一次订阅——本地磁盘命中时自行车早加载完了，
    // 那次 `loaded` 事件发生在**没有订阅者**的时候，直接丢了。
    // 症状是标题页的「演示」按钮永远停在"正在装车"，而车明明就在那儿。
    //
    // 问的是 `canEnter('bike')` 而不是某个标志位：它读的是 `Vehicle.models`
    // 里的实际模型引用，所以"到没到"只有一个来源。
    if (this.world.ride.vehicle.canEnter('bike')) this.onAssetLoaded('bike');
    // 路边碑文：黑底文字卡，不是 toast。
    // 差别不是好不好看，是**toast 要求玩家注意到它，而字应该"顺路读到"**——
    // 玩家在过弯，不该为了一块石头停下来。
    this.world.onRoadsideLine = (text) => this.ui.showStoryCard(text, t('stele_title'));
    this.world.onBeat = this.beatOn;
    this.world.onBgmMood = (slot) => audio.setBgmMood(slot);
    game.on('lvbi', () => this.ui.syncFromState());
    game.on('mood', () => this.ui.syncFromState());
    game.on('item', () => this.ui.syncFromState());
    /**
     * 拿到碎片：**说清楚那是什么。**
     *
     * 这一条是这一轮实机评审里最刺眼的"内容没送达"：
     * 玩家打一局小游戏、收下一块碎片，屏幕上只有 `碎片 2/5` 涨了一格。
     * 五块碎片的名字（云/茶/琴/竹/禽）在 HUD 的格子里，`fragment_tip_*`
     * 挂在那一格的 `title` 上——而 `title` 只有鼠标悬停才看得见，
     * 触屏上根本悬停不了。所以整局下来玩家**始终不知道自己在收集什么**。
     *
     * 用已有的黑底文字卡：不锁操作、不吃点击、自动推进，
     * 和序章、石碑、路过的驿站台词走同一条路。
     */
    game.on('fragment', (stationIdx) => {
      const slot = STATIONS[stationIdx]?.slot ?? -1;
      if (slot < 0) return;
      this.ui.showStoryCard(
        `${t(`fragment_${slot}`)}\n${t(`fragment_tip_${slot}`)}`,
        t('fragment_obtained'),
      );
    });

    // 湖边那一屏：先把实例建好，**但不加载模型**。
    // 加载是玩家第一次想进去时才发生的（见 `enterLakeside`）——
    // 0.73MB 不该在首屏关键路径上抢带宽。
    this.lakeside = new Lakeside(this.world.camera);
    this.world.scene.add(this.lakeside.group);
    this.bindLakesideLook();
    // WebXR **只在湖边这一屏开**。主骑行是低配优先的第三人称，
    // 而 XR 的开销是双眼渲染 + 高刷新率，和项目的定位正好相反。
    //
    // **建不建这一层要问异步的 `isSessionSupported('immersive-vr')`，
    // 不能只看 `navigator.xr` 在不在**：桌面版 Chrome / Edge 一律有
    // `navigator.xr` 而一律不支持沉浸式 VR。原来那一版只看 API 在不在，
    // 于是在任何一台桌面 Chrome 上都建了这一层，而湖边那一屏每帧都会问它
    // `presenting()`——那一句当时是个无限递归（见 `core/xr.ts`），
    // 于是那一屏的第一帧就是 `RangeError`。现在两头都堵上了：
    // 探针问得准，`presenting()` 也只读渲染器。
    void XrSession.vrAvailable().then((ok) => {
      // 探针的答案直接交给 UI（按钮由它决定出不出现），宿主不另存一份——
      this.ui.setLakesideVr(ok);
      if (!ok) return;
      this.xr = new XrSession({
        gl: this.world.renderer.gl,
        dispatchKey: (code, down) => this.dispatchKey(code, down),
        onSessionChange: (started) => this.onXrSession(started),
        onEnd: (fn) => this.xrEndHooks.push(fn),
      });
    });

    mark('boot_step_run');
    this.loop.start();
    this.goPhase('title');
    mark('boot_step_title');
    this.ui.showTitle();
    mark('boot_step_ready');
    if (loaded && game.getCollectedCount() > 0) this.ui.syncFromState();

    this.applyAutomation();

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
      setDocTitle(t('debug_title_probe'));
    }
    // `?dump=1` 已经消费过 query，但探针还要读 `x`/`z`，所以复用同一个 q。
    // 弧长定位入口：`?arc=` 见下。

    // 弧长定位入口：`?arc=0.42` 把玩家放到中心线参数 0.42 处，`?yaw=90` 再指定朝向（度）。
    // 停在原地**不自动开**——演示会一直往前骑，而"同一个画面看两次"
    // 才是这类问题唯一能查的方式：8 字交叉口那种地方，
    // 错过一次就得再绕一整圈。
    const arc = q.get('arc');
    if (arc !== null) {
      this.arcOverride = true;
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
     *
     * ## 它是一个 **getter**：每读一次都是一份新的快照
     *
     * `gift188` 是 `Object.defineProperty` 装上的 getter，
     * 所以 `const D = gift188` 拿到的是**那一刻**的快照，
     * 之后车再往前走，`D.bike` 永远停在原地。
     *
     * 这个坑很贵：我用它做过一次"把车开六千帧"的探针，
     * 结果车在 (−14.1, 77.5) 上一动不动地"冻"了六千帧——
     * **车其实一直在动**，只是探针读的是开局那一份。
     * 症状像物理坏了，而根因是探针自己把时间冻住了。
     *
     * 所以：**每一帧都重新读** `gift188`，不要存进变量。
     * 存下来的那份是冻结的，只会更早地过期。
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
      /**
       * 16 座驿站的落位（含碎片站标记）。
       *
       * 录制脚本需要它来「把车骑到驿站跟前」：驿站横向偏出路面约 18m，
       * 而 `interactAt` 的判定是 `distance <= reach`（驿站半径 + 路半宽）。
       * 沿中心线骑过去，最近也只到 ~18m，**永远够不着**——
       * 真玩家会往路肩上偏一点，脚本就得会。
       */
      stations: STATIONS.map((s, i) => ({
        i, x: +s.x.toFixed(2), z: +s.z.toFixed(2), hasFragment: s.hasFragment, slot: s.slot,
      })),
      bike: {
        x: +p.x.toFixed(2),
        y: +p.y.toFixed(2),
        z: +p.z.toFixed(2),
        speed: +w.ride.speedValue.toFixed(2),
        /**
         * 真实航向（rad）。约定是 `fwd = (-sin h, -cos h)`，
         * 即 **-Z 为车头**（`ride.ts` 的 `_fwd`）。
         *
         * 录制脚本要它，是因为从位置增量反推航向既慢又脆：多转 90° 的
         * 约定错误在画面上只表现为"车往回骑"，代码里**不会报任何错**。
         * 直接读比猜便宜得多。
         */
        heading: +w.ride.headingValue.toFixed(4),
        onRoad: w.ride.onRoad(),
        /** 到中心线的最近距离（米）。>8 就说明骑偏了 */
        offCenterline: +minDistToCenterline(p.x, p.z).toFixed(2),
        arc: +nearestArcParam(p.x, p.z).toFixed(4),
      },
      chapter: { n: game.chapter, oneDone: game.chapter1Done, objective: game.objective },
      perf: { ...perf },
      nearby: { ...w.nearby },
      phase: this.phase,
      /**
       * 「按了没反应」的完整现场。
       *
       * `canRide` 只覆盖**运动**的门卫，而按键还有一道独立的门：
       * `bindInput()` 的 keydown 处理器开头就 `if (this.mg.isRunning) return`，
       * 它**不经过 canRide**。于是可能出现 `canRide === true` 但 W 就是不响
       * ——截图上看不出来，日志上也没有任何异常。
       * `keysDown` 是「按键到底有没有进到宿主」的唯一直接证据。
       */
      input: {
        narrativeBusy: w.narrativeBusy,
        checkInStage: w.checkInStage,
        mgRunning: this.mg.isRunning,
        keysDown: Array.from(this.keys),
        canRide: canRideNow({
          phase: this.phase,
          checkInPressed: false,
          narrativeBusy: w.narrativeBusy,
          checkInStage: w.checkInStage,
        }),
      },
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
      // 小游戏自己有一支 `window` keydown 监听器在派发（云/茶要长按，不能滤 repeat）。
      // 这里再问一次 `consumesKey` 会把同一次按键**派发两遍**——琴会一次吃两声、
      // 云的光标一次挪两格。宿主在跑就整段让位。
      if (this.mg.isRunning) return;
      if (this.phase === 'minigame') return;

      this.keys.add(e.code);

      // switch 的判据是**动作**而不是物理键——可重映射的十个动作走这张表，
      // 而 F8/F9/F10/KeyP/KeyB/Digit1~4 这些固定功能键在 switch 的下半段
      // 按物理 code 直接匹配（它们不给重映射，理由见 keymap.ts）。
      switch (this.actionOf(e.code) ?? e.code) {
        case 'pause':
          e.preventDefault();
          // **先问面板，再问相位。**
          //
          // 商店复用 `checkin` 相位，而下面两条只认 `paused` / `roaming`，
          // 于是开店期间按 `Esc` 过去什么都不会发生：玩家把商店关不掉，
          // 也没有任何提示——`Esc` 明明是"我卡住了"的第一反应键。
          //
          // 顺序要紧：铺子开着的时候 `Esc` 应该是**退出一层**，
          // 而不是顺手把整个游戏暂停掉、把铺子留在暂停面板底下。
          if (this.ui.shopOpen) {
            this.closeShop();
          } else if (this.phase === 'lakeside') this.exitLakeside();
          else if (this.phase === 'paused') this.resume();
          else if (this.phase === 'roaming') this.pause();
          break;
        case 'confirm':
          e.preventDefault();
          this.onConfirm();
          break;
        case 'mute':
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
        case 'camera':
          // 切视角。`world.ride.cycleCamera()` **只改机位**，
          // 不碰任何运动状态 —— 见 ride.ts 的 CamMode 注释。
          this.ui.showToast(t('cam_switched', { mode: t(`cam_${this.world.ride.cycleCamera()}`) }), 1200);
          break;
        case 'vehicle':
          // 切载具。滑板模型没加载成功时不切，并说清为什么——
          // 按了键没反应而不解释，玩家会以为 E 坏了。
          //
          // `vehicleTouched` 在这里落下：玩家一旦自己选过，自行车到货时
          // 就不再自动换给他了（见 `onAssetLoaded()`）。
          {
            this.vehicleTouched = true;
            const v = this.world.ride.cycleVehicle();
            this.ui.showToast(
              v ? t('veh_switched', { mode: t(`veh_${v}`) }) : t('veh_locked'),
              1200,
            );
          }
          break;
        case 'interact': {
          // **F 同时服务四件事**，而顺序是有讲究的：先节拍，后路边。
          //
          // 节拍窗口只有 1.15s，而路边那些要停下来才够得着——
          // 窗口开着的时候玩家正在骑，不是在路边站着。
          // 所以先把窗口吃掉：它有截止时间，其余三样没有。
          const beat = this.world.pressBeat();
          if (beat !== 'miss' || this.world.beats.state.open) {
            this.ui.setBeat(this.world.beats.state);
            break;
          }
          // **短路**：路边这一排接住了就不再往下问。湖边一屏挂在这一串的
          // **最后**，而它的门槛（碗心 + 半径 + 60m）宽到碎片驿站旁就够得着——
          // 碎片驿站本来就临水，于是不短路的话「摸一下旧物」和「走进湖边」
          // 会在同一次按键里一起发生，而玩家只以为按了一下。
          if (this.touchRoadside()) break;
          this.tryEnterLakeside();
          break;
        }
        case 'Digit1':
        case 'Digit2':
        case 'Digit3':
        case 'Digit4': {
          // 道具栏。选中失败 = 那一格还没买到
          const n = e.code.slice(-1);
          const ok = this.ui.selectItemSlot(n);
          this.ui.items.sync();
          if (!ok) this.ui.showToast(t('item_none'), 1200);
          break;
        }
        default:
          break;
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
    window.addEventListener('blur', () => this.keys.clear());
  }

/**
   * 「摸一下眼前这个」。F 键唯一的落点。
   *
   * 旧物、琴音林那张琴、路肩上的木牌——三样都不是 UI 上的按钮，
   * 都是"世界里的东西，伸手碰一下"。主角的设定是
   * 「东西坏了我修，修之前我要先摸一遍」，
 * 所以它们共用一把键、共用一种手感，比各配一个键更像**这个人**。
 *
 * ## 顺序：按距离，近的优先
 *
 * 三样东西的落位互不相邻（路肩外 2m / 驿站院里 / 路肩外 2m），
 * 所以实际不会打架；可判据仍然按距离取最近的那一个，
 * 因为"优先序写死"在有人把木牌挪到驿站门口的那天就会变成 bug，
 * 而那种 bug 的症状是"我站在木牌前面，按 F 弹出来的却是旧物"——
 * 界面上没有任何东西能解释它。
 *
* 一样都够不着时**什么都不做，也不解释**：玩家正对着它，按了没反应
   * 本身就是"我得再靠近一点"的反馈，一句提示反而是在教他读界面。
   *
   * ## 返回 `true` = 这一排接住了，链子到此为止
   *
   * 原来它返回 `void`，而调用处无条件接着问湖边。于是按一次 F 可以
   * **同时**吃掉遗物故事卡并把玩家传送进湖边：在碎片驿站旁两边都够得着
   * （驿站本来就临水，而湖边的门槛是「碗心 + 半径 + 60m」）。
   * 症状是"我摸了一下那件东西，然后画面突然变成湖"——两件事都发生了，
   * 而玩家只以为按了一下。
   *
   * 这一排内部本来**就是**互斥的（`cands.sort` 取最近的那一个），
   * 所以"要么接住、要么没接住"一直是它真实的形状，缺的只是说出来。
   *
   * @returns 这一排里有东西被触发了。
   */
private touchRoadside(): boolean {
  const w = this.world;
  const cands: { kind: 'relic' | 'qin' | 'sign'; d: number }[] = [];
  if (w.relicNearby >= 0 && w.relics.pending(w.relicNearby)) {
    cands.push({ kind: 'relic', d: w.relicDistance });
  }
  if (w.qinInReach) cands.push({ kind: 'qin', d: w.qinDistance });
  if (w.signInReach) cands.push({ kind: 'sign', d: w.signDistance });
  if (cands.length === 0) return false;
  cands.sort((a, b) => a.d - b.d);

  switch (cands[0].kind) {
    case 'relic': {
      // 摸旧物。**主角唯一属于自己的那件事**——序章里他明说
      // "我这双手只会做一件事"，而那三张卡之后游戏再也没给过他一次机会。
      //
      // 分层：第一次读到 `textKey`（现在），第二次读到 `pastKey`（过去）。
      // 两层之间隔着一次"骑走、掉头、再停回来"，所以这里**一次只出一张卡**。
      const r = w.touchRelic();
      if (!r) return false;
      this.ui.showStoryCard(t(r.textKey), t(r.titleKey));
      this.onRelicListened(r.layer, r.echoKey);
      return true;
    }
    case 'qin':
      void this.runGuqin();
      return true;
    case 'sign':
      this.touchSign();
      return true;
  }
}

/**
 * 听见一件旧物之后。
 *
 * ## 过去层要"多一句"，因为倾听原本没有后果
 *
 * 计划书 §2 的缺口之三是"倾听不回响任何东西"：听完一件旧物，世界一处不变，
 * 于是摸它这件事**没有后果**，也就没有理由回来摸第二遍。
 * 回响给两样东西，都不新造系统：
 *
 * · **一句 `echoKey`**——这是一件东西在"世界这边"留下的痕迹。
 * · **一圈常亮的青灰**——骑回去时看得见自己听过了几件（`Relics.update`）。
 *
 * ## 这里**故意不再引 `voice_*`**
 *
 * `voice_1` / `voice_2` / `voice_3` 已经在第一次靠近十八驿时整段播过了
 * （`world.ts` 的 `claimVoiceGuide()` 一次性闩锁）。再引一遍的结果是
 * 同一段话玩家听两次——而它们本来就不是"每件旧物附赠的一句"，
 * 那是守驿人的独白，重复只会把那句话稀释掉。
 *
 * 收束交给 `relic_teapot_echo`（"茶还温着"）与结算后的彩蛋，
 * 后者正面回答序章那句"代价是没有人记得你"。
 */
private onRelicListened(layer: 'now' | 'past', echoKey: string): void {
  const relics = this.world.relics;
  // 顶栏那一行「还剩 %d 件」每听完一件就要掉一格。
  // 不刷的话它会一直停在打开这一章时的数——而玩家刚在路上数过。
  game.setChapter2Remaining(relics.remainingCount);
  const index = this.world.relicNearby;
  const def = index >= 0 ? relics.placements[index]?.def : undefined;

  if (layer === 'past') {
    this.ui.showStoryCard(t(echoKey), t('relic_echo_title'), 5200);
    // 爷爷的茶壶是全剧最新的一件，也是最后一件——第二章到此闭合。
    if (def && def.kind === 'teapot') game.claimChapter2Complete();
  }
}

/** 读木牌。第一次读出那段字；之后按下去直接起跑。 */
private touchSign() {
  const w = this.world;
  if (!this.signRead) {
    this.signRead = true;
    this.ui.showStoryCard(t('challenge_sign_text'), t('challenge_sign_title'), 9000, true);
    return;
  }
  if (!w.startDodge()) {
    this.ui.showToast(t('challenge_busy'), 1600, 'reply');
  }
}

/**
 * 琴音林那张琴。**自由演奏**：不进打卡、不扣旅币、不给碎片。
 *
 * ## 为什么复用 `checkin` 相位而不是新增一个
 *
 * 语义完全一样——站定了、车不能动、镜头之外正在办事——
 * 而铺子已经复用过它一次（见 `tryCheckIn()` 那段注释）。
 * 新增一个相位会在 `PHASE_EDGES` 与 `verify_phase` 的占用集合里
 * 各添一条，而它带来不了任何新的能力。
 */
private async runGuqin() {
  if (this.mg.isRunning || this.phase !== 'roaming') return;
  if (this.prologueBusy && this.ui.storyBusy) return;
  // 坐在琴前面时不该还在躲石头。实际不会发生（木牌在路肩上、琴在驿站院里），
  // 但这一句是零成本的那一半：万一两样挪近了，它挡住的是"面板关着、石头还在场上"。
  this.world.endDodge();
  this.goPhase('checkin');
  // 把焦点从"脚下那个圈"上摘下来（理由同 `runMiniGame`）。
  this.ui.releaseFocus();
  // **先讲清楚这是什么**，再让面板上来。自由演奏这一屏没有任何
  // 进度条也没有倒计时，所以玩家第一眼必须知道"我不会被打断"。
  if (!this.qinSeen) {
    this.qinSeen = true;
    this.ui.showStoryCard(t('qin_intro_text'), t('qin_intro_title'));
    await nextFrame();
    await this.ui.whenDialogueIdle();
  }
  await this.mg.runFreePlay('qin', seedFor(this.QIN_STATION, 0));
  this.toRoaming();
  this.ui.showToast(t('qin_left'), 2000);
}

/** 琴音林的碎片槽位。与 `World` 里那一处同源，判据 `verify_qin_station` 钉着它。 */
private readonly QIN_STATION = 2;
/** 木牌那一段字读过了没有（本次会话）。和 `Relics.heard` 一样不落盘：
 *  它不是剧情进度，是"这一趟我有没有停下来读过"。 */
private signRead = false;
/** 琴音林的引子只讲一次。之后再进去就直接是那张琴。 */
private qinSeen = false;
/** 茶倒完水那一句旁白讲过了没有（本次会话）。理由见 `runMiniGame` 里那段。 */
private teaPourSeen = false;

private onConfirm() {
    // 按哪一下去哪里由 `confirmAction()` 一处说了算（见那里的注释）：
    // 这一屏原本漏了 `onboarding`，而 AI 契约给引导页标着"出路是 advance"，
    // 于是契约一直亮着、游戏一直停在原地，两边都不报错。
    switch (confirmAction(this.phase)) {
      case 'startRide':
        this.startRide();
        break;
      case 'enterWorld':
        this.enterWorld();
        break;
      case 'checkIn':
        this.tryCheckIn();
        break;
      case 'fish':
        // 这一屏的确认键是钓鱼，而"点一下"与"按住"是同一个键的两种用法，
        // 分派在 `readLakesideInput()` 里按当前相位决定给哪一种。
        this.confirmPressed = true;
        break;
    }
  }

  /** 湖边这一屏的确认键，这一帧刚按下过。**每帧读完清零。** */
  private confirmPressed = false;

  // ---------------------------------------------------------------- 湖边一屏
  /**
   * 「这里没有可互动的东西」这一句，这次靠近已经说过没有。
   *
   * **它是"走近再说一次"，不是"每次按都说一次"。**
   * 走开之后由 `updateSpaceReplyArm()` 复位——和 `relicHinted` 同一个套路：
   * 说过的标志由"距离"维护，而不是由"按了多少下"维护。
   * 后者会在玩家站着反复试的时候变成刷屏，而刷屏正是当初把远处改沉默的原因。
   */
  private spaceReplySaid = false;

  /**
   * 走开了就把那句话重新武装上。
   *
   * 用 `SCENERY_SAY_M × 2` 而不是同一个数：玩家要真的离开那栋房子，
   * 而不是在它边上挪两步又回来又听一遍。
   */
  private updateSpaceReplyArm(): void {
    if (!this.spaceReplySaid) return;
    const p = this.world.ride.pos;
    if (this.world.scenery.nearestBuilding(p.x, p.z) > SCENERY_SAY_M * 2) {
      this.spaceReplySaid = false;
    }
  }

  /**
   *
   * ## 门槛为什么是「离水面 60m 以内」而不是「离驿站多远」
   *
 * 这一屏不该在地图任何地方都能进——那它就不是「湖边」，是第二个世界。
   * 而门槛一旦用「离驿站多远」，就和打卡那条链搅在一起（驿站本来就临水）；
   * 用**离碗心多远**则完全独立：玩家看见水、走到底、按下 F。
   *
   * 60m 是为了让「站在路上往湖那边看」进得去——那多半已经在碗沿之外了；
   * 门槛收到 40m 就得先把车骑进草地，而这一屏明明是给走路的人准备的。
   */
  private async tryEnterLakeside(): Promise<void> {
    if (this.phase !== 'roaming') return;
    const p = this.world.ride.pos;
    const near = getBasins().some((b) => Math.hypot(p.x - b.cx, p.z - b.cz) < b.radius + 60);
    if (!near) return;
    // **调用点是 keydown 处理器，它不会 await，也不会 catch。**
    //
    // `load()` 内部那条 Promise 可以在 `ensureMeshopt()` 上 reject，
    // 而那个 reject 会被 `Lakeside.loading` 与 `assets.ts` 的 `cache`
    // **两边都记住**——于是 `failed` 永远是假、每一次按 F 都再抛一次，
    // 而界面上是"在加载…"飘了一次又一次。
    //
    // 兜在这里而不是把 `load()` 改成永不 reject：加载失败是要让玩家
    // 知道的（`lake_missing`），问题只在于那个 reject 顺着调用栈跑掉了。
    try {
      await this.enterLakeside();
    } catch (e) {
      console.warn('[gift188]', t('lake_missing'), e);
      this.ui.showToast(t('lake_missing'), 2600);
    }
  }

  /**
   * 「这里可以走进湖边」的一次性提示。
   *
   * **为什么必须有它**：入口挂在 F 键上，而 F 已经是"摸一下眼前这个"的落点。
   * 玩家在湖边站着，看到的世界和站在路中间没有任何区别——
   * 没有这句提示，这一屏等于不存在，而且没有任何东西提示它不存在。
   *
   * 只弹一次（本次会话）。每帧都问"够不够近"然后弹一遍的话，
   * 玩家沿岸走一路会看到同一句话连续飘十几次。
   */
  private lakeHinted = false;
  private updateLakesideHint(): void {
    if (this.lakeHinted || this.phase !== 'roaming') return;
    const p = this.world.ride.pos;
    const near = getBasins().some((b) => Math.hypot(p.x - b.cx, p.z - b.cz) < b.radius + 60);
    if (!near) return;
    this.lakeHinted = true;
    this.ui.showToast(t('lakeside_enter'), 3000);
  }

  /**
   * 进湖边。
   *
   * 模型**按需加载**，不在启动时抢带宽——0.73MB 在 3G 上就是一次能看见的停顿，
   * 而它在首屏关键路径上根本用不到。所以第一次按是「在加载」，第二次才进得去。
   *
   * 那个「在加载」的提示是必须的：没有它，玩家按了没反应，
   * 而这一屏在他看来明明有一个入口。
   */
  private async enterLakeside(): Promise<void> {
    if (!this.lakeside.ready) {
      if (this.lakeside.failed) {
        this.ui.showToast(t('lake_missing'), 2600);
        return;
      }
      this.ui.showToast(t('lake_loading'), 1800);
      await this.lakeside.load();
      if (this.lakeside.failed) {
        this.ui.showToast(t('lake_missing'), 2600);
        return;
      }
      // ↓↓ 模型到位时世界可能已经不在骑行相位了。
      //
      // `tryEnterLakeside()` 只在 `await` **之前**问过一次 `phase === 'roaming'`。
      // 这几秒里玩家完全可以按 Esc（→ `paused`）、在驿站门口按空格
      // （→ `checkin`）、甚至重新开始。于是 `goPhase('lakeside')` 会从
      // 那两个相位发起——**两条边都不在 `PHASE_EDGES` 里**，而症状都很难归因：
      //
      // · 暂停面板盖在湖面上，而 `fixed()` 只认 `lakeside`：
      //   主循环推进了、湖边在跑，可玩家看见的是一层遮罩；
      // · 打卡过场冻在半截：`world.advanceCheckIn` 不再被调用，
      //   那个 Promise 永远不 resolve。
      //
      // 所以这里**再问一次**，不在就安静地退回骑行——
      // 玩家刚按过一次 F，什么都没发生，那本来就该是什么都没发生。
      if (this.phase !== 'roaming') return;
    }
    this.goPhase('lakeside');
    // 主世界的 HUD、小地图、道具栏全收掉。
    //
    // ⚠ **必须显式调 `setWorldChromeVisible()`**：`syncFromState()` 只同步**内容**，
    // 一行可见性都不碰。原来这里写的是"`isInWorld(phase)` 说了算"——那句话是错的，
    // `isInWorld` 在整个 `ui/` 里没有任何调用点，只有判据在用。
    this.ui.setWorldChromeVisible(false);
    // **必须在 setWorldVisible 之前**：applyTouchVisibility() 读它决定
    // 控件藏不藏，而它自己是在 setWorldVisible() 里被调用的。
    this.ui.setLakesideActive(true);
    this.ui.syncFromState();
    // `foreign` 那一组不属于主世界：这一次遍历不能把它按 `v` 摆弄。
    this.world.setWorldVisible(false, this.lakeside.group);
    this.lakeside.enter();
    this.lakeside.seedFor(this.world.ride.pos.x, this.world.ride.pos.z);
    // 进这一屏才开 XR。理由见字段上那条注释。
    this.xr?.enable();
    this.lookDx = 0;
    this.lookDy = 0;
    this.ui.releaseFocus();
  }

  /**
   * 退出湖边。
   *
   * 四件事一件都不能少——和 `closeEndCard()` 同一类问题：
   * 只改相位的话，相机还留在湖边，玩家回到路上会觉得"世界怎么歪了"。
   */
  private exitLakeside(): void {
    this.goPhase('roaming');
    this.lakeside.exit();
    this.ui.hideLakeside();
    this.xr?.disable();
    // 顺序有讲究：**先收湖岸，再开主世界**。反过来的话 `setWorldVisible(true)`
    // 那一次遍历会把湖岸这一组也按 `true` 摆上，5.8 万面的地形就永久留在路上了。
    this.ui.setLakesideActive(false);
    this.world.setWorldVisible(true, this.lakeside.group);
    this.ui.setWorldChromeVisible(true);
    this.ui.syncFromState();
    this.lookDx = 0;
    this.lookDy = 0;
  }

  /**
   * 湖边这一屏的转向：在画布上拖动。
   *
   * ## 为什么用 pointer 而不是 mouse
   *
   * `pointerdown/move/up` 同时覆盖鼠标、触摸和笔，而触屏玩家恰恰是这一屏的
   * 主要人群之一（骑行那边已经有完整的触屏控件）。用 `mouse*` 的话
   * 触屏玩家只能看不能转——而"只能看"在这一屏几乎等于"这屏坏了"。
   *
   * `setPointerCapture` 是必须的：拖到画布外松手的话 `pointerup` 收不到，
   * 视角会一直卡在转动的方向上，而界面上没有任何东西提示它卡住了。
   */
  private bindLakesideLook() {
    const el = this.world.renderer.gl.domElement;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    el.addEventListener('pointerdown', (e) => {
      if (this.phase !== 'lakeside') return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      try { el.setPointerCapture(e.pointerId); } catch { /* 合成事件可能没有 pointerId */ }
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging || this.phase !== 'lakeside') return;
      this.lookDx += e.clientX - lastX;
      this.lookDy += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    const stop = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try { el.releasePointerCapture(e.pointerId); } catch { /* 同上 */ }
    };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
    // 窗口失焦时松开：否则切走标签页再回来，这一屏还在"按住转向"的状态里。
    window.addEventListener('blur', () => { dragging = false; });
  }

  /**
   * 湖边这一屏的输入。**只从 `this.keys` 读，不新开监听器。**
   *
   * 这一条是 §6 那条硬约束的落点：动作只往下塞键码，
   * 浏览器侧合成真 `KeyboardEvent` 派发到 window。
   * 所以将来 VR 手柄接进来时，扳机走的也是这条路，
   * 而**不是**在这一屏另开一条手柄通道——两条通道早晚会漂。
   */
  private readLakesideInput(dt: number): void {
    const touch = this.ui.touch;
    // 触屏的边沿与键盘的边沿**并联**，读完都要清。
    // 漏清触屏那一份的症状是"进湖边自动抛一次竿"——
    // 而那一竿落下去之后玩家还没站稳。
    const f = this.confirmPressed || touch.checkInPressed;
    this.confirmPressed = false;
    touch.checkInPressed = false;
    // 摇杆是**模拟量**，这里过一道死区再当方向用。
    // 0.35 不是随手取的：`stickVector()` 的死区是 0.16，
    // 而 0.35 是"拇指自然摆过去的最小位移"——低于它玩家觉得自己没推。
    const sx = touch.moveX;
    const sy = touch.moveY;
    const axis = (v: number) => (v > 0.35 ? 1 : v < -0.35 ? -1 : 0);
    // 方向与确认键都走 `codeOf()`：改了键位之后，这一屏要跟着一起改，
    // 而不是变成「只有骑行是新的、湖边还是旧的」。
    // 方向键（Arrow*）**永远并联**——它们是系统级的方向，
    // 不在重映射表里（见 `keymap.ts`），而让它们继续有效是纯收益。
    this.lakeFrame = this.lakeside.update(dt, {
      forward: this.held('forward') || this.keys.has('ArrowUp') || sy < -0.35,
      back: this.held('back') || this.keys.has('ArrowDown') || sy > 0.35,
      left: this.held('left') || this.keys.has('ArrowLeft') || axis(sx) < 0,
      right: this.held('right') || this.keys.has('ArrowRight') || axis(sx) > 0,
      yawDelta: this.lookDx,
      pitchDelta: this.lookDy,
      hold: this.held('confirm') || this.keys.has('Enter') || touch.holdPressed,
      press: f,
    }, this.xr?.presenting() ?? false);
    this.lookDx = 0;
    this.lookDy = 0;
    if (this.lakeFrame) this.ui.setLakeside(this.lakeFrame);
  }

  /**
   * 玩家点了「戴上头显」。
   *
   * `requestSession()` 要用户激活，所以这一路从点击直接走到 `enter()`，
   * **中间不许 await 任何别的东西**（一次 `await` 就把激活用掉了，
   * Chrome 会抛 `SecurityError`，而界面上只是"按了没反应"）。
   */
  private async onVrRequest(): Promise<void> {
    if (!this.xr) return;
    const ok = await this.xr.enter();
    if (!ok) this.ui.showToast(t('lake_vr_failed'), 2600);
  }

  /**
   * XR 会话进出时换帧源。
   *
   * ## 为什么非换不可
   *
   * three 的 `WebXRManager` 只在**它自己的帧回调**里绑定头显的 framebuffer
   * 并刷新双眼位姿（`node_modules/three/src/renderers/webxr/WebXRManager.js`
   * 的 `onAnimationFrame`），而那个回调是 `renderer.setAnimationLoop()` 装上去的
   * ——`window.requestAnimationFrame` **不在它里面**。
   *
   * 所以进 VR 之后继续让主循环用 rAF 渲染，头显里是一帧冻住的画面
   * （或者干脆全黑），而桌面上一切正常、控制台一个字都不报。
   *
   * ## 换法沿用录制那一路
   *
   * `setManual(true)` 让主循环的 rAF 停摆（`tick()` 开头就返回，不再排下一帧），
   * 帧改由渲染器推——`stepOnce()` 一次跑完定步长与渲染，正是录制模式
   * （`?cine=1`）用的那个组合。会话结束时原样换回来。
   */
  private onXrSession(started: boolean): void {
    const gl = this.world.renderer.gl;
    if (started) {
      this.loop.setManual(true);
      gl.setAnimationLoop(() => this.loop.stepOnce());
    } else {
      gl.setAnimationLoop(null);
      this.loop.setManual(false);
      this.loop.start();
    }
  }

  // ---------------------------------------------------------------- 阶段
  /**
   * 标题页的「开启旅程」：**从头**来一趟。
   *
   * 它原来不清档。症状是：玩到一半刷新页面，标题页上那颗最大的
   * 「开启旅程」按下去，进游戏发现钱还在、天数还在、序章也不播——
   * 玩家以为开了新的一趟，实际接上了旧的那趟，而且**没有任何提示**。
   *
   * 存档在 `ready()` 的「读档…」那一步就已经读进来了（见文件头），
   * 所以不清它就是"带着别人的进度启程"。有存档时清掉，
   * 这一趟才是真的从头。
   *
   * 清完之后 `prologueDone` 是 false，`enterWorld()` 自然会把序章播回来——
   * 这正是"新的一趟"该有的样子，不需要在这里另外安排。
   */
  private async startRide() {
    if (game.hasSave()) this.resetRun();
    await audio.unlock();
    audio.playBgm('bgm', 0.5);
    this.ui.setDialogueAutoAdvance(0);
    this.goPhase('onboarding');
    this.ui.showOnboarding();
  }

  /**
   * 标题页的「继续旅程」：不看引导页，直接回到世界。
   *
   * 存档在 `ready()` 的「读档…」那一步就已经读进来了，所以这里不需要
   * 再 load 一次；序章也不会重播——`enterWorld()` 里那句
   * `if (!game.prologueDone)` 在有存档时为假。
   */
  private continueRun() {
    void audio.unlock();
    audio.playBgm('bgm', 0.5);
    this.ui.setDialogueAutoAdvance(0);
    this.enterWorld();
  }

  /**
   * 清掉这一趟的全部进度，回到十八驿旁。
   *
   * 标题页的「重新开始」与暂停面板的「重新开始」共用这一段——
   * 两条路径要做的事完全一样，只有**之后去哪**不同。
   */
  private resetRun() {
    game.reset();
    this.world.setOdometer(0);
    this.backText = '';
    writeBackText('');
    this.demoActive = false;
    this.demoSuppressPose = false;
    this.demoArc = -1;
    this.world.teleportToStation(0);
    this.ui.setShopOpen(false);
  }

  private enterWorld() {
    // 幂等：UI 的 enterWorld() 也会走到这里（它只负责画 HUD），
    // 而 hook 是从 UI 内部发出来的，所以这条路径可能被走两次
    if (this.phase === 'roaming') {
      this.ui.enterWorld();
      this.refreshRelicsForChapter();
      return;
    }
    this.goPhase('roaming');
    this.ui.enterWorld();
    this.ui.syncFromState();
    // 续档进世界时 `chapter` 可能是 2（玩家打完第一章存了档、退出、重进）。
    // 旧档没有这个字段时它读作 1，于是建三件那一步被跳过——正确的降级。
    this.refreshRelicsForChapter();
    // **把人放回他上次停的地方。** 这一步必须在序章之后——
    // `playPrologue()` 走的是打卡过场，它自己会摆车。
    // 只在"续档"这一条路上生效：标题页的「开始旅程」已经把
    // `resetState()` 跑过一遍，`pose` 是 null，于是这一次是空操作。
    this.restorePose();
    this.playPrologue();
  }

  /**
   * 把车放回存档里那个位置。
   *
   * ## 为什么放在 `enterWorld()` 的最后而不是建世界时
   *
   * `World` 构造时就 `spawn()` 在起点驿站，那是**新的一趟**该有的样子。
   * 读档是这一趟的**中途**，两件事的时序必须分开：先让世界按新一趟建好
   * （地形、植被、驿站模型都在它该在的地方），再把车挪过去。
   *
   * ## 为什么要落到**路面上**
   *
   * 存档记的是玩家停的地方，而那个地方可能压在路肩上、甚至在草里。
   * 直接照搬的话，玩家会从一个歪着的姿态开始，而第一个症状是
   * "按 W 之后车斜着离开沥青"——和 `roadSpawnPose()` 那段注释里
   * 记的是同一种病。所以把 x/z 投回最近的**中心线点**再重建朝向，
   * 等于「他停在了这儿，他面朝路」。
   */
  private restorePose(): void {
    // **`?arc=` / `?yaw=` 优先。** 那一路是排障用的："把玩家放到弧长 0.42 那儿"。
    // 有存档时 `restorePose()` 会把它盖掉，于是那行命令完全失灵——
    // 而那个工具存在的意义恰恰是"一眼看出这地方长什么样"。
    if (this.arcOverride) return;
    const p = game.pose;
    if (!p) return;
    const here = roadSpawnPose(p.x, p.z);
    this.world.respawn(here.x, here.z, here.heading);
  }

  /**
   * 骑行中定期把位置写进存档。
   *
   * ## 为什么是 4 秒而不是"退出时才存"
   *
   * 关标签页、崩浏览器、设备没电——这三种都拿不到退出钩子，
   * 而它们的症状都是同一个："我骑了半小时，回来还在出发点"。
   * 4 秒的代价是一次几百字节的 `localStorage` 写入（`progress_km`
   * 之类本来就每帧在写），换来的是最坏情况下只丢 4 秒。
   */
  private poseSaveClock = 0;
  private static readonly POSE_SAVE_S = 4;

  /**
   * **序章**：只在 `prologueDone` 为假时播，播完立刻落盘。
   *
   * 它原来是 `enterWorld()` 的一整个代码块，抽出来是因为**进世界的路径不止一条**：
   * 标题页的「开始旅程」、标题页的「继续旅程」、以及**世界里的「重新开始」**。
   * 前两条都经过 `enterWorld()`，第三条原来直接走 `toRoaming()` 绕开了它——
   * 而 `resetRun()` 已经把 `prologueDone` 清成了 false 并落盘（这一点
   * `verify_story` 有专门的断言：重开就该再看一遍序章）。
   * 于是玩家在世界里按「重新开始」，拿到的是一个进度全清、**而一个字故事都没有**的存档：
   * 他不知道自己是谁、替谁跑、代价是什么，而这三句在这个游戏里只在这里出现过。
   * 想补回来只能退回标题页再点一次「继续旅程」——没有人会知道要这么做。
   *
   * 幂等靠 `prologueDone` 自己，不靠调用点，所以三条路径随便怎么改都不会重播第二次。
   *
   * 下面这段设计说明与实现一起搬过来了（顺序即因果、六句分卡不合并、
   * `dismissible` 的理由），它们是这一段的约束，不是历史包袱。
   */
  private playPrologue() {
    // 这是整个游戏里最该被送达而一直没送达的三句——
    // 律师函、母亲、还有"代价是没有人记得你"。它决定玩家知不知道
    // 自己这一趟在替谁跑。不锁操作、自动推进、**点一下就能退场**，
    // 所以正在过弯的玩家什么都不用做，骑过去也会读完。
    //
    // ⚠️ 这段注释原来写的是「按 `E` 跳过」。`E` 早就改成换载具了，
    // 而且它从来就没跳过过任何字——`storyCard.ts` 的卡不吃键盘。
    // 一句与代码不符的注释比没有注释更贵：下一个人会照着它去找那个键。
    //
    // `prologue_0_1..3` 是**动机**：他为什么从公司辞了手回来。
    // 排在原有三句**之前**，因为顺序就是因果——
    // 先有"我的手会听东西说话"和"八百年前有人在这儿高兴地活着"，
    // 律师函才不是一封凭空来的信，十八驿才不是一个待回收的任务，
    // 而是他本来就该回来的地方。
    //
    // 两条一起发**而不是**分两张卡：它们的因果是一条链，
    // 拆成两张会让中间那次 3.4 秒的空档把"辞职"和"家业"这两件事
    // 在玩家脑子里断成两段各自忘掉。
    //
    // 六句**顺序播**，不是一张卡：中文侧读完要 66 秒、英文侧 86 秒，
    // 而单卡上限 22 秒。塞进一张就是必然腰斩，而腰斩没有任何提示。
    // 拆开之后每张都读到完整，算法见 `storyCard.ts:readingMs`。
    //
    // `dismissible` 和驿里那三句同一条理由（`world.ts:408`）：**这是"停下来读"
    // 而不是"骑过去顺便读"**。六句加起来一分半钟，站在起点看完是一种惩罚；
    // 而路边碑文、路口那三个字仍然不开——它们要的是"别打断我过弯"。
    // 判据：谁长谁开，不是谁想开谁开。
    if (!game.prologueDone) {
      game.markPrologueDone();
      // 置位在**起播**这一刻而不是播完：闸门要挡住的是"叙事还在屏上时按下的那一下空格"，
      // 而序章一进世界就起了播，中间没有玩家能插手的时间窗。
      // 它自己落下的地方在 `tryCheckIn()` —— 叙事段落一空就落，不靠轮询。
      this.prologueBusy = true;
      this.ui.showStorySequence(
        [
          t('prologue_0_1'),
          t('prologue_0_2a'),
          t('prologue_0_2b'),
          t('prologue_0_3'),
          t('prologue_1'),
          t('prologue_2'),
          t('prologue_3'),
        ],
        t('prologue_speaker'),
        { dismissible: true },
      );
      return true;
    }
    return false;
  }

  private toRoaming() {
    this.goPhase('roaming');
    this.ui.hidePause();
    this.loop.resume();
  }

  pause() {
    if (this.phase !== 'roaming') return;
    this.goPhase('paused');
    this.loop.suspend();
    this.ui.showPause();
  }

  resume() {
    if (this.phase !== 'paused') return;
    this.toRoaming();
  }

  restart() {
    this.resetRun();
    // 同一个动词，两条路径：暂停面板里是"回到刚才那一趟的起点"，
    // 标题页里是"清档之后从头进世界"——后者还得把标题页收起来。
    if (this.phase === 'title') {
      this.continueRun();
    } else {
      this.toRoaming();
      // 世界里「重新开始」也是**新的一趟**。`resetRun()` 刚把
      // `prologueDone` 清成 false，所以序章必须在这里重播：
      // 进度清零而前提不补，玩家就得到一个"不知道自己是谁"的存档。
      // 标题页那条路经 `enterWorld()` 已经播过了，所以不重复调。
      this.playPrologue();
    }
    this.ui.syncFromState();
  }

  /**
   * 关铺子。**必须把相位还回去**——`tryCheckIn()` 打开铺子时把 phase 设成了
   * `checkin`（为了不在 `canRide` 的白名单之外），而 `canRide` 只认 `roaming`。
   * 忘了这一句的症状和当初引导页那个 bug 一模一样：**画面全对，只有车不动**。
   */
  private closeShop() {
    this.ui.setShopOpen(false);
    if (this.phase === 'checkin') this.goPhase('roaming');
  }

  /**
   * 标题页的「演示」。
   *
   * 原来这一段只做三件事：解锁音频、放 BGM、对白自动推进——**车不动**。
   * 现在车自己往前骑（`readInput()` → `demoDrive()`），而"车往草地里开"
   * 这件事由 `verify_demo_drive` 在 Node 里闭环跑一遍，不靠人眼看。
   */
  private startDemo() {
    void audio.unlock();
    audio.playBgm('bgm', 0.5);
    this.demoActive = true;
    this.demoT = 0;
    this.demoArc = -1;
    // **演示不碰玩家的存档位置。** 它只是"放一段给评委看"——
    // 而 `tickPoseSave` 会照常把坐标写进存档。放完演示之后「继续旅程」
    // 会把玩家放在演示结束的地方，而不是他上次停的地方。
    this.demoSuppressPose = true;
    // 演示里没有人按键，对白必须自己往前走
    this.ui.setDialogueAutoAdvance(2.4);
    this.enterWorld();
    this.mountDemoVehicle();
  }

  /**
   * 演示一开始就把车换成自行车。
   *
   * ## 这里曾经有一段"徒步会开坏演示"的警告，现在它过期了
   *
   * 原文说：演示驾驶控制器是**按自行车标定的**（`DEMO_CRUISE = 11`，
   * 徒步极速只有 6），前视 12m 在徒步下变成整整 2 秒预判，纯追踪于是
   * 大幅摆头、里程零增长。**那两条都已经不是问题了**：
   *
   * · `phase.ts` 的 `demoLookahead(speed)` 把前视按**预判时间**恒定缩放，
   *   6 m/s 时自动收到约 6.5m，仍然是 1.1 秒；
   * · `demoInput()` 的巡航取 `min(DEMO_CRUISE, maxSpeed * 0.8)`，
   *   徒步时是 4.8 m/s，不会一直去要一个够不到的速度。
   *
   * 也就是说**兜底路径本身是好的**，车到没到都能把这一趟骑完。
   *
   * ## 剩下的那一条仍然要堵
   *
   * 兜底是好的，但它**静默**。对一个 3D 骑行游戏来说，90 秒里出现一个
   * 背包在跑的人、而界面上没有一个字说明为什么，比开坏更伤。
   * 所以真正的修复不在这个方法里，而在两处：
   * 标题页在模型到货前**禁用**演示按钮（`titleScreen.ts` 的 `demoReady`），
   * 以及车一到位就自动切上去（`onAssetLoaded()`）。
   *
   * 保留这一行是因为它是兜底的兜底：万一玩家在模型到货前用别的方式
   * （`?autostart`、控制台）进了演示，这里至少还能把车换上。
   *
   * 为什么是自行车而不是摩托车：摩托极速 24，比 `DEMO_CRUISE` 高一倍的档，
   * 收油曲线会长期贴在负油门上；而自行车极速 15，11 落在中间偏下，
   * 正是那张前视表量出来时的速度。
   */
  private mountDemoVehicle(): void {
    this.world.ride.vehicle.set('bike');
  }

  /**
   * 演示的时间推进 —— 不只是加一个秒表，**90 秒到了就要真的收场**。
   *
   * ## 原来这句是一个空承诺
   *
   * 标题页上写着「演示 · 90 秒」，而 `DEMO_BUDGET_SEC` 在整个代码库里
   * **从来没被读过一次**（只在 `ECON` 的类型声明和一条注释里出现）。
   * 实测无头跑 309 秒，演示仍在继续：天数、驿站、铜钱从 +238s 起到 +309s
   * 一个都没变过。评审等来的不是收尾，是一片不会停的天空。
   *
   * 一个兑现不了的按钮比没有按钮更糟——它把"我不知道自己要等多久"
   * 写在了界面上。所以现在预算用掉，`demo_card_notice` 也终于有个落点。
   *
   * 为什么调 `finishRun()` 而不是自己拼一个收尾：结算页要展示明信片，
   * 而明信片正是演示想让人看到的东西。演示的价值是**让人看到走完全程
   * 是什么样**，直接跳到结算页比在路边停下来更符合那个目的。
   */
  private demoTick(dt: number): void {
    this.demoT += dt;
    if (this.demoT >= ECON.DEMO_BUDGET_SEC) {
      this.demoT = ECON.DEMO_BUDGET_SEC;
      this.ui.showToast(t('demo_card_notice'), 3200);
      this.finishRun();
    }
  }

  private finishRun() {
    // 保险：这一趟结束了，而某一局还开着的话先把它收掉，
    // 否则 runMiniGame 里 await 的那个句柄永远不 resolve，
    // 那条 `afterMiniGame` 链就断在半截——症状是结算页关掉之后
    // 再也回不到骑行。今天这条路径按不到（小游戏期间 Esc 被游戏吃掉），
    // 理由见 `MiniGameHost.abort()` 的注释。
    this.mg.abort();
    this.goPhase('endcard');
    this.demoActive = false;
    this.loop.suspend();
    this.ui.showEndCard();
    audio.sfx('export', 0.6);
    this.queueEpilogue();
  }

  /**
   * 片尾彩蛋：结算屏之后**再补一张故事卡**，两结局各一版。
   *
   * ## 为什么它回答的是序章那一句
   *
   * `prologue_1` 说"守驿人记路，不记己……代价是没有人记得你"。
   * 全作到结算为止**没有一处正面回答它**——而这一张是正面回答：
   * 留门那一支里，一个孩子在很多年以后摸到了那把茶壶。
   *
   * ## 为什么是「一张卡」而不是新面板
   *
   * 计划书 §8 写死了：新输入不造、面板不造、双场景叠化不做。
   * 彩蛋用现成的 `showStoryCard` 队列，零新系统。
   *
   * 排队而不是直接弹：此刻结算屏正压在最上面，直接弹会被它盖住，
   * 而故事卡队列会在面板收起之后才放出来（`StoryCards` 的既有行为）。
   */
  private queueEpilogue(): void {
    const ending: EndingId = endingFromGameState();
    const key = ending === 'let_go' ? 'epilogue_let_go' : 'epilogue_keep';
    if (this.epilogueShown) return;
    this.epilogueShown = true;
    this.ui.showStoryCard(t(key), t('ending_title'), 9000);
  }

  /**
   * 关掉结算页，回到世界。
   *
   * ## 为什么要单独一个方法，而不是复用 `resume()`
   *
   * `resume()` 的第一行是 `if (this.phase !== 'paused') return;`，而这一页的
   * 相位是 `endcard`——直接调它**什么都不会发生**，症状是"按了关闭但页面还在"。
   * 同理也不能调 `toRoaming()` 就完事：它只改相位和主循环，不把结算页收起来。
   *
   * 三件事一件都不能少：
   *   1. 相位回到 `roaming` —— `canRide` 只认它，否则车不动；
   *   2. `loop.resume()` —— `finishRun()` 停过主循环，漏了就是"能看不能动"；
   *   3. `ui.closeEndCard()` —— `showEndCard()` 藏了 HUD、推了结算页。
   *
   * **不清档**。玩家点的是"关掉这一页"，不是"重新开始"；
   * 这一趟的驿数、乐事、背面写的字全部留着，`restart()` 仍然只在
   * 「重新开始」那一个动词后面发生。
   */
  private closeEndCard() {
    this.goPhase('roaming');
    this.loop.resume();
    this.ui.closeEndCard();
    this.ui.syncFromState();
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
  /**
   * 空格按了没反应、而玩家正挨着一座驿站时，最多离多远还值得搭一句话（米）。
   *
   * `STATION_REACH`（≈ 19.7m）圈的是"空格生效区"，而驿站站在路面外 18m，
   * 玩家贴着路对面骑过去时离驿站 20~26m——正好落在圈外，而这正是
   * "光圈差一点点"最容易发生的地带。所以搭话半径比生效圈再宽 12m：
   * 宽到盖住路对面，窄到不等玩家骑出半条街还听得到。
   */
  private static readonly RING_HINT_EXTRA_M = 12;

  tryCheckIn() {
    if (this.phase !== 'roaming') return;
    // 序章那七张叙事段落还在屏上时，**打卡让路**。
    //
    // 实机撞到的：序章跑在 `roaming` 相位上，而故事卡是**故意不锁操作**的
    // （`narrativeBusy` 全程为假、`canRide` 也放行——那些判断都是对的），
    // 错的是打卡没跟着一起让路。于是玩家出生就在十八驿门口、而那是个商店，
    // 按下 Space 推进叙事的那一下**同时**把商店顶了上来：
    // 律师函那段压在前面，背后一屏 0 铜钱、全部"Not enough coins"的商品。
    //
    // 为什么不用 `world.narrativeBusy`：那正是这里**不能用**的信号——
    // "骑过去顺便读"的字本来就不该锁操作，把它改成锁会砸掉别的设计。
    //
    // 为什么不清标志而是每次重新判：标志只保证"序章刚起播"这一次让路，
    // 而叙事段落随时可能被点掉或自动走完。挂在 tryCheckIn 里自查，
    // 就不会出现"序章早结束了、闸门还关着"这种僵尸状态，也不需要每帧去轮询。
    if (this.prologueBusy) {
      if (this.ui.storyBusy) return;
      this.prologueBusy = false;
    }
    const kind = this.interactKind();
    if (kind === 'shop') {
      // 相位复用 `checkin`：它已经在 `verify_phase` 的"占用"集合里
      // （`{paused, checkin, synthesis}`），所以不用新增相位、那条不变式也不用改。
      // 语义也对得上——"站定了、车不能动、镜头之外正在办事"。
      // `world.checkInStage` 保持 `'none'`，打卡过场不会被触发。
      this.goPhase('checkin');
      this.ui.setShopOpen(true);
      return;
    }
    const can = this.world.canCheckIn();
    if (!can.ok) {
      // 'reply'：这一条是**回答玩家刚才那一下**的，不是环境提示。
      // 按成 'ambient' 的话 3 秒去重会把它吃掉——而站着不动连按，
      // 说的都是同一句，于是第二下开始屏幕上什么都不出。
      //
      // 'busy' 这一桶里混着三种完全不同的处境，原来一律回一句
      // `blocked_busy`（"这里现在进不去"）——而它三种都答不上：
      //   ① 站在驿站边上、但还没进圈（`distance > STATION_REACH`）。
      //      玩家要听的是规则本身：「圈 = 空格的生效区」。这句是
      //      `hint_ring_needed`，只在他确实挨着一座站时说——
      //      离所有驿站都远的时候按的那一下不该有回音（见下）。
      //   ② 够得着，但这座站现在无事可做（到访刷满 / 既无铺子也无碎片）。
      //      `blocked_busy` 的原文对它就是有效的。
      //   ③ 四下无驿站。**原来也弹**，于是骑在路中间随手按空格都会
      //      一遍遍飘"这里现在进不去"——它和眼前任何东西都对不上号，
      //      玩家只会以为游戏坏了。现在离得远就干脆不说话。
      if (can.reason === 'recheck') {
        // 反刷门（打卡后骑开 `RECHECK_IN_MIN_DIST` 米）。这句要说满 2.6s：
        // 三种里唯一规则（那段距离）完全不可见、而玩家会反复撞上的一条。
        this.ui.showToast(t('blocked_recheck'), 2600, 'reply');
      } else if (can.reason === 'cooldown') {
        this.ui.showToast(t('blocked_cooldown'), 1400, 'reply');
      } else {
        const nb = this.world.nearby;
        if (nb.index >= 0 && nb.distance <= STATION_REACH + App.RING_HINT_EXTRA_M) {
          this.ui.showToast(t(nb.distance > STATION_REACH ? 'hint_ring_needed' : 'blocked_busy'), 2200, 'reply');
          this.spaceReplySaid = false;
        } else {
          /**
           * 最后这一段：出了提示外圈，而玩家**很可能就站在一栋景物旁边**。
           *
           * 原来这里是直接往下走，也就是彻底沉默——而路边散布的
           * `mod_house` / `mod_tower` 看得见、摸得着，却不是 16 座驿站里的任何一座，
           * 于是玩家骑到它们旁边按空格，界面上一个字都不出。
           * 玩家能给出的描述只有「靠近建筑的时候有时候交互不了」。
           *
           * 而"远处不吭声"是**故意的**（上面那段注释：否则在路中间随手按空格
           * 会一遍遍飘同一句）。所以这里加的不是"把静默区扩回去"，
           * 而是**一次性的那句**：说一句、走开才复位。判定在 `silentSpaceReply()`。
           */
          const p = this.world.ride.pos;
          const buildingDist = this.world.scenery.nearestBuilding(p.x, p.z);
          if (
            silentSpaceReply({
              stationDist: nb.distance,
              reach: STATION_REACH,
              hintExtra: App.RING_HINT_EXTRA_M,
              buildingDist,
              said: this.spaceReplySaid,
            }) === 'nothing_here'
          ) {
            this.ui.showToast(t('nothing_here'), 2600, 'reply');
            this.spaceReplySaid = true;
          }
        }
      }
      return;
    }
    // 回家这一条走独立分支：0 号驿站没有碎片，
    // `runMiniGame` 里 `STATIONS[idx].slot < 0` 会立刻把它踢回 roaming，
    // 于是"第一章完成"这件事一次都不会发生。
    if (kind === 'home' || this.world.nearby.isHome) {
      this.goPhase('checkin');
      this.world.startCheckIn(
        GameStateManager.HOME_STATION,
        () => void this.completeChapterOne(),
        true,
      );
      return;
    }
    const idx = this.world.nearby.index;
    if (idx < 0) return;
    this.goPhase('checkin');
    this.world.startCheckIn(idx, (finished) => void this.runMiniGame(finished));
  }

  /**
   * 「对面前的站按确认会发生什么」。判定在 `phase.ts` 的 `interactAt()` 里，
   * HUD 的脚下提示圈读的是同一个函数——所以圈上写什么和按下去发生什么
   * 不可能各说各话。
   */
  private interactKind() {
    const nb = this.world.nearby;
    return interactAt({
      shopName: nb.shopName,
      isHome: nb.isHome,
      objectiveReturn: game.objective === 'return',
      hasFragment: nb.hasFragment,
      needsVisit: nb.needsVisit,
      distance: nb.distance,
      reach: STATION_REACH,
      busy: this.world.checkInStage !== 'none',
    });
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
      this.refreshRelicsForChapter();
      return;
    }
    this.ui.syncFromState();
    // 对白在 startCheckIn 的 holding 段已经发起。等它念完再进合成——
    // 主循环一停玩家就没法再点了，不等的话那三句会卡在半截然后被面板盖住。
    await this.ui.whenDialogueIdle();
    this.goPhase('synthesis');
    this.ui.showSynthesis('chapter');
    // 门开得有仪式。合成屏收起之后补这一张——它是"你本可以把它卖掉"
    // 这句**唯一一次**出现在玩家眼前的机会，而下一屏就是重新骑出去。
    this.ui.showStoryCard(t('chapter2_door_text'), t('chapter2_door_title'), 7600);
    this.refreshRelicsForChapter();
  }

  /**
   * 把旧物系统推到当前章该有的样子。
   *
   * **为什么不在 `claimChapter1Complete()` 里直接建**：那三件是第二章的东西，
   * 而玩家此刻正看着第一章的合成屏。它们要在他**重新骑出去**的路上出现，
   * 而不是在这一屏上抢一句「下一章」。
   *
   * 读档进来时也走这一条：旧档里 `chapter` 可能是 2 而世界里一件都没建。
   */
  private refreshRelicsForChapter(): void {
    this.world.relics.setChapter(game.chapter);
    game.setChapter2Remaining(this.world.relics.remainingCount);
  }

  private async runMiniGame(stationIdx: number) {
    const st = STATIONS[stationIdx];
    if (!st || st.slot < 0) {
      this.toRoaming();
      return;
    }
    const visit = game.getStationCount(stationIdx); // 打卡前的次数
    const id = MiniGameHost.idFor(st.slot, visit);
    this.goPhase('minigame');
    // 把焦点从"脚下那个圈"上摘下来。
    //
    // 打卡是**用空格**触发的，而空格落在 HUD 的圈按钮上时，那个按钮会成为
    // `document.activeElement`（原生按钮的键盘激活路径）。此后圈按钮一直持有
    // 焦点直到它被隐藏——而 `hud.syncRing()` 要等下一次 `sync()` 才收它，
    // 于是**整个小游戏期间焦点都在它上面**。
    //
    // 后果见 `wireKeyActivate` 那段注释：一路上的 `stopPropagation()` 把空格
    // 截在目标阶段，小游戏永远收不到。交出去是对的动作：这一屏上没有
    // 任何需要键盘焦点的控件（五个小游戏都在 canvas 上自己收键）。
    this.ui.releaseFocus();
    // 告诉世界「现在在小游戏里」：反派的对白要等，
    // 但引子（手机响了）照样会压暗一下——它不结束任何东西。
    this.world.setBusyForMinigame(true);

    // 演示模式**不玩小游戏**。90 秒的预算（`DEMO_BUDGET_SEC`）里塞不进一局，
    // 而 `DEMO_END_AT_SEC = 62` 之后本来就该开始收尾。
    // 跳过不是作弊：评审要看的是世界与流程，不是手速。
    // 顺带这一句也用掉了 `DEMO_END_AT_SEC`——否则它是数据表里两个没人读的数之一。
    if (this.demoActive && this.demoT > ECON.DEMO_END_AT_SEC) {
      game.checkIn(stationIdx);
      // **不给「失败」**。演示里没有人按键，这一局必然是跳过去的，
      // 而屏幕上弹出「失败」是在告诉评审"这个游戏做不出来"。
      // 中性的一句：它在被跳过，不是在被判负。
      //
      // ⚠️ 这一行原来传的是 `false`——注释写着"中性"，代码做的是"判负"，
      // 两件事不一致却谁也没发现，因为没有一条判据问过"取消长什么样"。
      // 现在三态是真的三态（`settleTextKey`），`verify_settle` 守着。
      this.ui.showResult('cancel', st.slot);
      this.ui.syncFromState();
      this.toRoaming();
      return;
    }

    // 种子由 (驿站, 第几次到访) 决定：同一趟重玩是同一局，
    // 玩家重打一遍不会因为随机数换了一串而拿到另一道题。
    //
    // ⚠️ **必须等对白念完再开**。
    //
    // 打卡过场在 `moving` 结束那一刻就发出了这座驿站的对白，而小游戏要等到
    // `holding`(1.5s) + `outro`(0.4s) 之后才开——中间只隔 1.9 秒。五座碎片驿站
    // 的对白都是三句、约 4 秒（`verify_minigame_dialogue` 量着这个数），
    // 所以**小游戏每次都盖在还没念完的对白上**。
    //
    // 症状安静得离谱：`Dialogue` 在 window 的**捕获**阶段吃掉 Space/Enter/Esc，
    // 而小游戏是在**冒泡**阶段收键的。于是玩家看见的是一屏乐事、按空格毫无反应，
    // Esc 也退不出去——而五个小游戏里有三个（云/茶/竹）只认空格。
    // 琴和禽用数字键，数字键不在被吃掉的名单里，所以它们"能玩"——
    // 正好是"**部分**游戏玩不了"这个症状的来源。
    await this.ui.whenDialogueIdle();
    // 「为什么要玩」这一条，就落在**对白读完、小游戏开打之前**那一步。
    //
    // 原来这个衔接是空的：镜头一收、对白一走，屏幕上直接换成乐事，
    // 于是玩家看到的是"我按了空格 → 它开始考我"。而这一局的**目的**
    // （点亮驿站上的圆点、收齐碎片）从来没有被任何一句话说出来过——
    // 顶栏那个数字会动，但它不解释自己。
    //
    // 放在这里而不是开局：开局说一句是背景，玩家已经忘了；
    // 放在**每一局**之前是提醒，而第一局之前那一次就够了——
    // 它是可点掉的，2.6 秒后角标也撤了，不占着不让走。
    this.ui.showStoryCard(t('minigame_why'), t('minigame_why_title'), 2600, true);
    const handle = await this.mg.run(id, seedFor(stationIdx, visit));

    // **三态，不是两态**。`MiniGameResult` 早就把「玩法失败」与「玩家按 Esc」
    // 拆成两个值，而这里原来只认 `win`——于是玩家主动取消的一局，
    // 弹出来的是「这次没有完成」。他没做错任何事，却读到了"我失败了"。
    const outcome: SettleOutcome = handle.result;
    const win = outcome === 'win';

    // **茶倒完水那一下的一句旁白**，只讲一次。
    //
    // 它落在小游戏交回来之后：玩家刚看完壶倾下去、水进盏、
    // 「成了」浮出来，这时候补一句"原来忙完了是有声音的"，
    // 才接得住——放在小游戏之前讲，那是提前剧透。
    //
    // 一次性闩锁**不落盘**：它不是剧情进度，
    // 是"这一趟我有没有留心看过那一下"。
    if (win && id === 'tea' && !this.teaPourSeen) {
      this.teaPourSeen = true;
      this.ui.showStoryCard(t('tea_pour_text'), t('tea_pour_title'));
    }

    // 乐事结束了，被压着的反派对白现在可以交付
    this.world.setBusyForMinigame(false);

    // 打卡与经济
    //
    // `checkIn()` 与 `onMiniGame()` **都返回这一笔实际到账多少**，
    // 而它们原来一个返回值都没人接：钱进了账，顶栏的数字跳了一下，
    // 而玩家没有拿到任何一句"你拿到了什么"。这一趟里唯一"越玩越多"的东西
    // 就靠那个跳动的数字自己说话——它和"你刚赢了"是两件事，
    // 玩家要自己把两件事对上号。
    //
    // 这里用**前后差值**而不是把两个返回值加起来：
    // `earn()` 有 tag 幂等（同一笔不重发），差值天然把"这一局没发钱"表示成 0，
    // 于是取消那一局就不会显示 "+0 coins"。
    const lvbiBefore = game.lvbi;
    game.checkIn(stationIdx);
    // ⚠️ 取消与失败在这里仍然同价（`LVBI_MINI_LOSE`）。这是**刻意**的：
    // 经济常数是 1:1 移植契约的一部分，改它会动到 `verify_economy`。
    // 本轮只修"玩家被告知了什么"，不改他拿到了多少。
    game.onMiniGame(stationIdx, win);
    const gained = game.lvbi - lvbiBefore;
    if (win) audio.sfx('collect');

    // **结算屏**。之前只有一条 toast 飘过去——这是玩家唯一确认
    // 自己做到什么的地方，而 toast 长得很像"又一条提示"。
    // 一句大字 + 这件乐事的名字，是这件事应有的分量。
    // 旅币到账、超时与玩砸的分别，都写在这一屏上而不是再叠一条 toast：
    // 同一时刻两条提示会把"你赢了"和"你得了 20 旅币"拆成两件无关的事。
    this.ui.showResult(outcome, st.slot, () => this.afterMiniGame(stationIdx, visit), {
      gain: gained,
      timedOut: handle.timedOut,
    });
    this.ui.syncFromState();
  }

  /**
   * 结算屏落幕之后才继续流程——否则面板和下一步会同时在屏幕上。
   *
   * 走哪一条由 `afterCheckInRoute()` 判，顺序的理由写在那里。
   *
   * @param stationIdx 刚打完的那座驿站
   * @param visit **打卡前**已经来过几次（0 = 第一次来）。用它挑"第几圈"那一句。
   *        原来第二个参数是 `_win` 且被显式 void 掉了——胜负在这一步已经
   *        由结算屏说完了，而这一屏之后真正还缺的信息是"我还能再来几次"，
   *        那个数只有这里拿得到。
   */
  private afterMiniGame(stationIdx: number, visit: number) {
    switch (
      afterCheckInRoute({
        allCollected: game.allCollected(),
        chapter1Done: game.chapter1Done,
        allFragmentsMaxed: game.allFragmentsMaxed(),
        overdue: game.overdue,
      })
    ) {
      // 集齐五件之后**不结算**。原来这里是直接弹合成面板，
      // 于是"这一趟结束了"是游戏替玩家做的决定，中间没有任何过渡。
      // 现在改成把目标换成"回十八驿"——188 号环线自闭合，
      // 起点就是终点，骑回出发的地方是这一章最自然的结尾，
      // 而 demo 也有了一个干净的边界（一章 = 一趟 188）。
      case 'return-home':
        this.toRoaming();
        this.ui.showToast(t('objective_return'), 4200);
        return;
      // 完满评级（五座各去三次）就地结算。
      // 顺序是 `afterCheckInRoute` 里的活契约，理由写在那里。
      case 'maxed':
        this.goPhase('synthesis');
        this.ui.showSynthesis('maxed');
        return;
      // 过期。这一趟**不结束**，但目标换了。
      // `back_break` 那个结局是为它写好的，而在这之前它没有任何入口——
      // 一个写好了却到不了的结局，和没写是一样的。
      case 'overdue':
        this.toRoaming();
        this.ui.showToast(t('objective_overdue'), 5200);
        return;
      default:
        this.toRoaming();
        this.showRevisitLine(stationIdx, visit);
    }
  }

  /**
   * 「第几圈」那一句。
   *
   * `MAX_VISITS_PER_STATION = 3` 这个结构一直是对的（`verify_checkin` 守着），
   * 而它在界面上**完全看不出来**：顶栏那一格圆点很小，而"同一座驿站还要去
   * 两次"这件事从来没有被说出来过。于是第二圈和第三圈在玩家眼里和第一圈
   * 一模一样——他不知道自己刚才那趟是白跑还是算数。
   *
   * 这两句本来就写在文案表里（`revisit_2nd_round` / `revisit_3rd_round`），
   * 一直没人念。放在**结算屏落幕、回到骑行之后**这个位置是有理由的：
   * 它是"这件做完了"和"继续骑"之间的那半句，
   * 而放在小游戏之前会把玩家按在原地先等一句话。
   *
   * 第一次来（`visit === 0`）不给——那时候还没有"又来了一趟"这回事。
   * 集齐 / 过期 / 完满那三条出口不给——它们各有各的收尾，
   * 在那里插一句"山还是那些山"是抢戏。
   */
  private showRevisitLine(stationIdx: number, visit: number) {
    const key = visit === 1 ? 'revisit_2nd_round' : visit === 2 ? 'revisit_3rd_round' : '';
    if (!key) return;
    this.ui.showStoryCard(t(key), stationName(stationIdx));
  }

  // ---------------------------------------------------------------- 铺子
  /**
   * 买一件。
   *
   * 原来这里只 `syncFromState()` 一下就结束了：商品变成"已拥有"、旅币少了，
   * 而**玩家没有得到任何一句确认**。`shop_bought`（"已购"）一直躺在文案表里
   * 没人念——于是在一个要盯着余额做减法的经济里，"我到底买没买上"这件事
   * 只能靠读商品条目自己的状态去反推，而那一栏在成交瞬间是不动的。
   *
   * `buy()` 返回成交与否，所以买不成（钱不够 / 已拥有 / 满心神）时**不弹**：
   * 那几种情况铺子面板上本来就有各自的说明（`shop_need_lvbi` 等），
   * 再叠一条"没买成"只会和它们打架。
   */
  private buy(id: string) {
    const good = SHOPS.GOODS.find((g) => g.id === id);
    if (!good) return;
    const ok = game.buy(good);
    if (!ok) {
      this.ui.syncFromState();
      return;
    }
    audio.sfx('collect', 0.7);
    this.ui.showToast(t('shop_bought'), 1400);
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
      // 只画被请求的那一面：原来一律 `exportBothSides()` 把两面都画掉，
      // 而玩家点的是「导出正面」或「导出背面」一个按钮。
      const blob = await exportPostcardPng(input, side);
      await saveBlob(blob, exportFileName(side));
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return; // 玩家自己取消
      console.warn('[gift188]', t('warn_postcard_export'), e);
      this.ui.showToast(t('export_failed'), 2400);
    }
  }

  /**
   * 自动化 / AI 入口。三个查询参数，都只对本次会话生效、**不落盘**。
   *
   * | 参数 | 作用 |
   * |---|---|
   * | `?clean=1` | 藏起全部 DOM 界面，只留 3D 世界，并直接进世界 |
   * | `?nocine=1` | 不播任何叙事文字（序章、驿里的声音、碎片提示、碑文、路口） |
   * | `?autostart=1` | 跳过标题页与引导页直接进世界，界面照常显示 |
   *
   * ## 为什么截图需要这个
   *
   * 一张混着顶栏、小地图、心神数字、道具栏和飘过去的字的截图，
   * AI 判断"这个世界长什么样"就会被这些稳定不动的像素干扰。
   * 玩家看到的是一个游戏，AI 需要看到的是**山**。
   *
   * 叙事文字尤其糟：它是**会动的**。截图打在字上，AI 会把字里的内容
   * 当成画面的一部分描述出来（"一张写着律师函的黑色卡片"），
   * 而画面的主体是山。所以 `?nocine` 不是锦上添花，是必需的。
   *
   * ## 为什么都做成"只对本次生效"
   *
   * 落盘的话，玩家的真实存档会被一条调试参数污染——下一次正常开游戏
   * 界面是空的、序章不播，而**没有任何界面能把它改回来**。
   * 玩家唯一能做的事是清 localStorage，于是进度全丢。
   */
  private applyAutomation() {
    const q = new URLSearchParams(location.search);
    const clean = q.has('clean');    // `?clean` 蕴含 `?nocine`：既然界面整个藏起来了，
    // 再让文字在背后继续排队只是浪费——而且若 `show()` 仍会读出文字，
    // 它读的是 0 宽容器，将来取消干净模式时会突然冒出一堆旧卡。
    const nocine = q.has('nocine') || clean;

    if (nocine) this.ui.setNarrativeQuiet(true);
    if (clean) {
      this.ui.setCleanMode(true);
      setDocTitle(t('debug_title_clean'));
    }

    // 直接进世界，省掉标题页与引导页——那两个都是 DOM，
    // 干净模式下它们本来就是一块不可见的板子，但它们会**占住阶段机**：
    // 不点「开始骑行」就永远是 `phase === 'title'`，车不动、画面停在标题。
    if (clean || q.has('autostart')) {
      this.continueRun();
    }

    this.installAiApi();
  }

  // ---------------------------------------------------------------- AI 接口

  /**
   * 把 AI 可游玩接口装到 `window.__gift188`。
   *
   * ## 它为什么常驻，而不是藏在 `?ai=1` 后面
   *
   * 藏起来等于要求每个想用它的人**先知道那个参数**，
   * 而"AI 能不能玩这个游戏"这件事本身就该是打开控制台敲一行就能试的。
   * 它也**不能**做任何键盘做不到的事：每个动作都是一次真的
   * `KeyboardEvent` 派发，走的是和人手键盘完全同一条路
   * （理由与七处键盘监听的账，见 `game/api/live.ts` 的文件头）。
   *
   * ## 观测为什么几乎全是"现读现报"
   *
   * 导航那几项**不重新计算**，直接读 HUD 上一帧算好的
   * （`hud.aiNext`）。两份算法早晚会漂，而漂了以后 AI 会朝着
   * 玩家在屏幕上**看不见**的方向骑——症状像"AI 不会用导航"，极难归因。
   */
  private installAiApi() {
    const host: LiveApiHost = {
      phase: () => this.phase,
      narrativeBusy: () => this.world.narrativeBusy,
      dialogueOpen: () => this.ui.aiScreen().dialogueOpen,
      dialogueText: () => this.ui.aiScreen().dialogueText,
      minigameRunning: () => this.mg.isRunning,
      panelOpen: () => this.ui.aiScreen().panelOpen,
      canCheckIn: () => this.world.canCheckIn().ok,
      observation: () => this.aiObservation(),
      // **合成真的 KeyboardEvent**，而不是另开一条平行输入：
      // 七个监听键盘的地方（宿主 / 对白 / 结算 / 明信片 / 小游戏 / 触屏 / HUD）
      // 原封不动地收到，走和人手键盘完全同一条路。
      dispatchKey: (code, down) => this.dispatchKey(code, down),
    };
    (window as unknown as { __gift188?: unknown }).__gift188 = createLiveApi(host);
  }

  /**
   * 合成一次按键，送给**焦点所在的那个元素**。
   *
   * ## 谁在用它
   *
   * 三个调用方，同一条路：AI 接口（`live.ts`）、VR 手柄（`core/xr.ts`）、
   * 以及宿主自己。它们**共用这一个实现**是有意的——
   * §6 那条「动作只往下塞键码、不许另开平行输入」在它们身上是同一句话：
   * 七个监听键盘的地方原封不动地收到，走的和人手键盘完全一样的路。
   * 抄一份给手柄，就等于给这一屏造出第二条输入，而两条早晚会漂。
   *
   * ## 为什么派给焦点而不是一律派给 window
   *
   * 真实按键的事件目标是当前焦点，而事件只会往上冒、不会往下走——
   * 所以一发到 window，它就永远到不了按钮上。
   * 而引导页、结算屏、合成面板的出路**全都**挂在按钮元素上
   * （`wireKeyActivate`），于是 AI 按确认键时：
   * `available` 里亮着 `advance`、`tap('advance')` 返回 accepted，
   * 而游戏纹丝不动。实测引导页连按 150 次没动过。
   *
   * 派给焦点之后事件照样会冒到 window（`bubbles: true`），
   * 所以骑行与面板那套 window 监听一个字都不用改——
   * 这一句只是让"目标"和真人按键一致，不是另开一条平行输入。
   */
  private dispatchKey(code: string, down: boolean): void {
    const ev = new KeyboardEvent(down ? 'keydown' : 'keyup', {
      code,
      key: code,
      bubbles: true,
      cancelable: true,
      repeat: false,
    });
    const target = document.activeElement;
    (target instanceof HTMLElement ? target : window).dispatchEvent(ev);
  }

  /**
   * 一帧观测。**只报玩家真能感觉到的东西**——
   * 往里塞渲染器统计或 Object3D 树会让这份快照失去"观测"的意义，
   * 那等于让任何基于它做的评估作弊。
   */
  private aiObservation(): Omit<AiObservation, 'available' | 'tick' | 't'> {
    const r = this.world.ride;
    const nav = this.ui.navNext;
    const screen = this.ui.aiScreen();
    return {
      phase: this.phase,
      chapter: game.chapter,
      day: game.day,
      daysLeft: game.daysLeft,
      coins: game.lvbi,
      lvbi: game.lvbi,
      mood: game.mood,
      fragmentsGot: game.getCollectedCount(),
      slotVisits: ROAD_RAW.FRAGMENT_SLOT_STATION_IDX.map((i) => game.getStationCount(i)),
      speed: r.speedValue,
      maxSpeed: RIDE.MAX_SPEED,
      onRoad: !r.offRoad,
      // 「偏了多远」和上面那个布尔**必须**是同一份计算（见 `Ride.offRoadMeters`）：
      // 在这一行自己拿 `r.lateral` 重算，就会出现 `onRoad: true` 配 `offRoad: 2.81`
      // 这种自相矛盾的观测——一个说在路上，一个说偏出去两米八。
      offRoad: r.offRoadMeters,
      // 归一化弧长，和 `nearestArcParam()` 的定义一致（0..1）。
      arc: nearestArcParam(r.pos.x, r.pos.z),
      km: game.progressKm,
      vehicle: r.vehicleKind,
      camera: r.cameraMode,
      nextStation: nav.idx,
      nextName: nav.name,
      nextDistance: nav.dist,
      nextArrow: nav.arrow,
      canCheckIn: this.world.canCheckIn().ok,
      objective: nav.objective,
      lang: getLang(),
      dialogueOpen: screen.dialogueOpen,
      dialogueText: screen.dialogueText,
      minigame: this.mg.isRunning,
      panelOpen: screen.panelOpen,
    };
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
    } else if (e.type === 'storyLine') {
      // 顺路读到的字：黑底、不锁、不吃点击。
      // 玩家在过弯也照样读完，不需要停下、也不需要按任何键。
      //
      // 有 `parts` 走顺序播：一段叙事在英文侧读不完（单卡上限 22 秒），
      // 合并成一张会被腰斩，而腰斩没有任何提示。详见 storyCard.ts:readingMs。
      if (e.parts && e.parts.length > 1) {
        this.ui.showStorySequence(e.parts, e.title, { dismissible: e.dismissible });
      } else {
        this.ui.showStoryCard(e.text, e.title);
      }
    } else if (e.type === 'villainCue') {
      // **引子不吃点击、不锁操作**，只压暗一下。
      // 它唯一的作用是让玩家在郑铎开口之前先觉得有什么不对——
      // 而"手机响了"这句话本身不该把人按在路上，更不该顶掉一局茶。
      this.ui.showInterruptCard(e.text, t('villain_cue_title'), 1200);
    } else if (e.type === 'duskBegan') {
      // 这里原来写的是 `t('dusk_toast')`，而那条键**从来不存在**——
      // 于是第二圈天色转暗时，玩家看到的是字面量 `⟨dusk_toast⟩`。
      // 表里真正写着的是 `dusk_began`：「天要暗了。灯亮起来，路还是那条路。」
      this.ui.showToast(t('dusk_began'), 3200);
    } else if (e.type === 'loaded') {
      // 资产到位不打扰玩家：它自己会出现在画面上。
      // **除了自行车**——它是这一档唯一的例外，理由见 `onAssetLoaded()`。
      this.onAssetLoaded(e.what);
    } else if (e.type === 'stationPassed') {
      void e.index;
    } else if (e.type === 'dodgeStart') {
      // 起跑。这一句是**唯一**告诉玩家"接下来一整圈都在躲什么"的台词，
      // 所以它带 `dismissible`：它是给自己看的，不是拦路的那一句。
      this.ui.showStoryCard(t('challenge_start_text'), t('challenge_start_title'), 7000, true);
    } else if (e.type === 'dodgeHit') {
      this.ui.showStoryCard(e.text, t('challenge_hit_title'), 6500, true);
      this.ui.syncFromState();
    } else if (e.type === 'dodgeWon') {
      // **奖励在这里发，不在世界层。**
      //
      // `checkIn()` 会走旅币账本、心神、存档与 `allCollected` 事件；
      // 那些都是 `GameStateManager` 的活。世界层要是也顺手改一笔，
      // 两边就会各自记一次到访，而顶栏那一格圆点只有一处——
      // 于是玩家看见"碎片到了，可到访次数没涨"。
      const lvbiBefore = game.lvbi;
      // 它会返回 false：五座驿站都去满三次之后，绕完一圈**仍然有解**
      //（一圈确实一件没碰），但已经没有碎片可以再给了。
      // 那种时候弹「碎片落进你手里」是在骗人——所以分成两句话说。
      const awarded = game.checkIn(e.station);
      const gained = Math.max(game.lvbi - lvbiBefore, 0);
      this.ui.showStoryCard(
        awarded ? e.text : t('challenge_all_full_text'),
        t(awarded ? 'challenge_win_title' : 'challenge_all_full_title'),
      );
      if (gained > 0) this.ui.showToast(t('challenge_gain', { coins: gained }), 2200);
      this.ui.syncFromState();
      if (audio.ready) audio.sfx('collect');
    }
  }

  /**
   * 自行车到位。
   *
   * ## 它做两件事，都是「不让玩家看见一次降级」
   *
   * **① 点亮标题页的演示按钮。**
   * 演示是给评审看的 90 秒，而它第一辆车必须是自行车（`mountDemoVehicle()`）。
   * 模型没到时 `set('bike')` 被 `canEnter()` 挡掉，于是那 90 秒里出现的是
   * 一个背包在跑的人——对一个 3D 骑行游戏来说，那就是它的第一句话。
   * 所以按钮在到货前是禁用的（文案 `demo_loading`），而不是按下去再看运气。
   *
   * **② 玩家还没自己选过载具的话，直接把人放上自行车。**
   * 这是 P1-6 那条「开局不要走路」的落点。做成**到货才切**而不是「一进世界就切」，
   * 是因为进世界那一刻车多半还没到，那时候 `set('bike')` 同样会被挡掉，
   * 于是又回到徒步——这正是原来的问题。
   *
   * `vehicleTouched` 是这里唯一的安全阀：玩家自己按过 `E` 之后再自动换车，
   * 读起来就是"游戏不听我的"。**只在玩家没表达过偏好时才替他决定。**
   *
   * ## 为什么模型没到也不重试
   *
   * `assetChain` 外面套着 20 秒硬超时（`main.ts` 启动那段），超时后那条链
   * 就不再推进了。与其在这里轮询一个可能永远不会来的事件，不如让标题页
   * 一直显示"正在装车"——那是一个**诚实**的状态，而一个 20 秒后突然能按的
   * 按钮读起来像坏了。
   */
  private onAssetLoaded(what: string): void {
    if (what !== 'bike') return;
    this.ui.setDemoReady(true);
    if (!this.vehicleTouched && this.world.ride.vehicle.id === 'foot') {
      this.world.ride.vehicle.set('bike');
    }
  }

  // ---------------------------------------------------------------- 循环
  /**
   * 固定步长。**所有阶段都跑**——非骑行阶段也要推进，
   * 好让世界的时间继续走（对白、暂停面板背后的黄昏都要动）。
   */
  private fixed(dt: number) {
    // 湖边这一屏**自己接管这一帧**：主世界不更新，相机不由 `Ride` 驱动。
    //
    // 放在最前面是有意的——`world.fixedUpdate` 会把相机拉回跟车位，
    // 而这一屏的相机归 `Lakeside` 管。两者同时跑的话，每帧都会被抢一次，
    // 症状是"视角往回弹"，而且只在移动时出现，很难归因。
    if (this.phase === 'lakeside') {
      this.readLakesideInput(dt);
      return;
    }
    const canRide = canRideNow({
      phase: this.phase,
      checkInPressed: this.ui.touch.checkInPressed,
      narrativeBusy: this.world.narrativeBusy,
      checkInStage: this.world.checkInStage,
    });
    this.world.fixedUpdate(dt, this.readInput(), canRide);
    this.ui.touch.checkInPressed = false;
    // 小游戏的状态机也按固定步长走。漏掉这一句，`step()` 永远不被调用：
    // 茶的注水不走、竹的引子不放、琴的示范不响、禽的倒计时不动，
    // 而且 `resultT` 不倒完所以 `run()` 的 Promise 永远不 resolve，
    // 五件乐事全部卡死。
    this.mg.fixedUpdate(dt);
    this.world.postFixedUpdate();
    this.updateRelicHint();
    this.updateRoadsideHint();
    // 走开了就把「这里没有可互动的东西」重新武装上。
    this.updateSpaceReplyArm();
    this.updateLakesideHint();
    // 挑战进度条。**只在进行中才读世界**：没在挑战的时候那一行是
    // "active: false"，而 `dodgeProgress` 每帧算一次弧长累加并不便宜。
    const dodge = this.world.dodgeRunning;
    this.ui.setDodge({
      active: dodge,
      progress: this.world.dodgeProgress,
      left: TOTAL_ARCLENGTH - this.world.dodgeTravelledMeters,
    });
    this.updateDayToast();
    this.tickPoseSave(dt);
    this.announceSaveState();
  }

  /**
   * 每 4 秒把位置写进存档一次。**只在骑行相位写**——
   * 对白、打卡、小游戏、湖边都不写：那几处车是不动的，
   * 而在它们期间存位置只会把玩家冻结在打卡圈里。
   */
  private tickPoseSave(dt: number): void {
    if (this.phase !== 'roaming') return;
    // 演示不碰玩家的存档位置——它只是放一段给人看，
    // 放完之后「继续旅程」不该把玩家放在演示结束的地方。
    if (this.demoSuppressPose) return;
    this.poseSaveClock += dt;
    if (this.poseSaveClock < App.POSE_SAVE_S) return;
    this.poseSaveClock = 0;
    const p = this.world.ride.pos;
    game.setPose(p.x, p.z, this.world.ride.headingValue);
    game.save();
  }

  /**
   * 路边的两样东西：木牌与琴音林，各给一次提示。
   *
   * 和旧物同一条规矩（`updateRelicHint`）：**够得着才提示**，
   * 而提示只说"可以按 F"，不解释玩法——玩法由木牌上那段字负责。
   *
   * 挑战进行中不提示：那 0.9 秒里玩家要盯的是石头。
   */
  private updateRoadsideHint() {
    const w = this.world;
    if (w.dodgeRunning) return;
    if (w.signInReach && !this.signRead && !this.signHinted) {
      this.signHinted = true;
      this.ui.showToast(t('challenge_hint'), 2200);
    }
    if (w.qinInReach && !this.qinSeen && !this.qinHinted) {
      this.qinHinted = true;
      this.ui.showToast(t('qin_hint_near'), 2600);
    }
  }
  private signHinted = false;
  private qinHinted = false;

  /**
   * 存档那边的两条坏消息，各说一次。
   *
   * ## 为什么放在这里，而不是 `load()` / `save()` 旁边直接弹
   *
   * `load()` 发生在 `boot()` 里、UI 还没建好（`showTitle()` 在它后面）；
   * 而 `save()` 是被 `checkIn()` / `noteLap()` / `buy()` 内部调的，
   * 一趟几十次。把提示写在发生处，就得给"UI 还没准备好"和"同一句话说四十遍"
   * 各写一层例外。
   *
   * 所以两边都只**置一个标志**，说话统一放在这一帧。
   * `take…()` 读走就清，于是这两个调用每帧各问一次、总共只会各响一次。
   *
   * ## 为什么是 `fixed()` 而不是 `render()`
   *
   * 暂停时 `fixed()` 不跑，于是玩家在暂停面板里不会被这两条提示打断；
   * 而"存档没存上"这句话本来也不该抢着对一个正在读暂停菜单的人说话。
   */
  private announceSaveState() {
    if (game.takeSaveMigrated()) {
      // 说的是「格式变了，进度没带过来」而不是「进度没了」。
      // 前者是**发生了什么**，后者会被读成判罚——而玩家什么都没做错，
      // 他只是在我们改存档格式的那个版本里多骑了两天。
      this.ui.showToast(`${t('save_migrated_title')}\n${t('save_migrated_line')}`, 5200);
    }
    if (game.takeWriteFailed()) {
      // 必须说清「这一趟不会留下存档」：**只说"存不上"而不说后果，
      // 玩家会以为待会儿重试一下就好，于是照常玩两小时再关掉。
      this.ui.showToast(`${t('save_unsaved_title')}\n${t('save_unsaved_line')}`, 5200);
    }
  }

  /**
   * 这一帧的车把。**只读输入，不改任何状态。**
   *
   * 拆出来是因为它有两个来源：玩家的键／摇杆，和演示模式那辆自己骑的车。
   * 挤在 `fixed()` 里的时候，第二个来源要覆盖第一个只能靠一层 if 套一层 if，
   * 而"演示到底有没有在开车"这件事就没有任何一处能一眼看见了。
   *
   * ⚠️ 顺序不能动：`canRide` 必须在 `touch.checkInPressed` 被清零**之前**问，
   * 那是"按住空格确认时不该同时骑行"这条规则的唯一落点。
   */
  private readInput(): RideInput {
    let throttle = 0;
    let steer = 0;
    if (this.phase === 'roaming') {
      if (this.held('forward') || this.keys.has('ArrowUp')) throttle -= 1;
      if (this.held('back') || this.keys.has('ArrowDown')) throttle += 1;
      if (this.held('left') || this.keys.has('ArrowLeft')) steer -= 1;
      if (this.held('right') || this.keys.has('ArrowRight')) steer += 1;
      throttle += this.ui.touch.moveY;
      steer += this.ui.touch.moveX;
    }
    // 演示模式下没有人按键，这一行是**唯一的**来源。
    // 它覆盖而不是叠加：叠加的话，评审在演示里碰一下摇杆车就会一顿。
    if (this.demoActive) {
      const d = this.demoDrive();
      throttle = d.throttle;
      steer = d.steer;
    }
    return { throttle: clamp(throttle, -1, 1), steer: clamp(steer, -1, 1) };
  }

  /**
   * 演示模式那辆车怎么打方向。
   *
   * **只有两行是这里自己的**：记住弧长（`demoArc`），以及每帧去问一次
   * "车头该往哪边摆"（`demoAim`）。换算成车把是 `demoInput` 的事。
   *
   * 为什么要自己记弧长：8 字在中央穿过自己，而那个路口正好落在弧长 0
   * （也就是演示的起点）——两条支路在那儿同一个坐标、弧长差半圈。
   * `unwrapArc()` 挡的是"车偏到两支一样近"时量到的那一下换支；
   * 正常骑它一次都不触发（实测 45 秒零次），它是兜底，理由见 `phase.ts:unwrapArc`。
   */
  private demoDrive(): { throttle: number; steer: number } {
    const ride = this.world.ride;
    const p = ride.pos;
    const raw = nearestArcParam(p.x, p.z);
    this.demoArc = unwrapArc(this.demoArc < 0 ? raw : this.demoArc, raw);
    const v = ride.speedValue;
    // 极速与车速都取当前载具的：演示若切不到自行车（模型没加载好），
    // 这两个数会让控制器自动退回到徒步也能骑的档，而不是一路要 11 m/s。
    return demoInput(
      demoAim(p.x, p.z, ride.headingValue, this.demoArc, undefined, v),
      v,
      MODE_TUNE[ride.vehicleKind].maxSpeed,
    );
  }

  /**
   * 旧物的两级提示。
   *
   * **18m（`relicSpotted`）说"那边有东西"，2.8m（`relicNearby`）说"这件叫什么，按 F"。**
   * 分两级是因为一句提示只能干一件事：
   * 只在够得着时弹，玩家已经停稳了，提示毫无用处；
   * 只在 18m 弹，玩家走过去之后不知道该按哪个键。
   *
   * 每件各给一次，记在 `relicHinted` 里。它和 `Relics.heard` 分开：
   * 提示过了但还没摸是常态（他可能直接骑过去了），
   * 把两件事记成一个，玩家就得停下来摸才有资格再被提醒一次。
   */
  private updateRelicHint() {
    if (this.phase !== 'roaming') return;
    const relics = this.world.relics;
    // **提示也分两层**：一件旧物要提醒两次（"路边有东西" + "按 F"），
    // 而每件现在有**两次**可读。记号因此带上层号——
    // 只按 index 记的话，第二层永远拿不到提示，
    // 症状是"那圈青灰一直亮着，可我站在旁边什么提示都没有"。
    const layer = (i: number) => (relics.isHeard(i) ? 'past' : 'now');
    const spotted = this.world.relicSpotted;
    if (spotted >= 0 && relics.pending(spotted)) {
      const k = `${spotted}:${layer(spotted)}`;
      if (!this.relicHinted.has(k)) {
        this.relicHinted.add(k);
        this.ui.showToast(t('relic_near'), 1800);
      }
    }
    const i = this.world.relicNearby;
    if (i < 0 || !relics.pending(i)) return;
    const nk = `${i}:${layer(i)}`;
    if (this.relicNamed.has(nk)) return;
    this.relicNamed.add(nk);
    const title = t(relics.placements[i].def.titleKey);
    this.ui.showToast(t('relic_hint', { name: title }), 2200);
  }

  /**
   * 节拍的三档反馈。
   *
   * · `cue`（48m）：**「前面有竹」**。这是这一件乐事原本完全缺的那一档——
   *   没有它，玩家看到圈亮起时既不知道那是什么，也不知道该按哪个键。
   * · `armed`（24m，窗口开了）：**不弹提示**。窗口只有 1.15s，再叠一条
   *   1.8s 的 toast，玩家会先读完字再按键，窗口早就过了。
   *   窗口本身由 HUD 上那个收缩的圈表示（`ui.setBeat`），它比任何一行字都快。
   * · `hit` / `miss` / `done`：打中了、打偏了、凑满五下。
   */
  private beatOn = (e: BeatEvent, hits: number) => {
    this.ui.setBeat(this.world.beats.state);
    if (e === 'cue') this.ui.showToast(t('beat_cue'), 1800);
    else if (e === 'hit') this.ui.showToast(t('beat_hit', { 0: hits, 1: this.world.beats.state.goal }), 1200);
    else if (e === 'miss') this.ui.showToast(t('beat_miss'), 1200);
    else if (e === 'done') {
      // 完成一件乐事：给一笔旅币，**不改碎片计数**（见 beat.ts 的文件头）。
      game.earn(12, 'beat_done');
      this.ui.syncFromState();
      this.ui.showToast(t('beat_done'), 4200);
    }
  };

  /** 上一次看到的日期。用来在翻页时给一句话。 */
  private lastDay = 1;

  /**
   * 日期翻页时报一句。
   *
   * **不是"还剩几天"的倒计时播报，而是一句"第 N 天"。**
   * 理由：顶栏那一格每时每刻都在写着余数，播报是重复的；
   * 而"第 N 天"是**一件新发生的事**，和顶栏那个持续变化的数不是同一句话。
   * 一天只在打卡或骑完一圈时翻，所以这句话一天最多出现一次——
   * 一天一次的东西才值得占用注意力。
   */
  private updateDayToast() {
    if (this.phase !== 'roaming') return;
    if (game.day === this.lastDay) return;
    this.lastDay = game.day;
    this.ui.showToast(t('day_passed', { 0: game.day }), 2400);
  }

  private render(dt: number) {
    // 湖边那一屏的相机归 `Lakeside` 管，而它跑在定步长里——所以这里必须把
    // 相机的归属权**交出去**。不交的话 `Ride.render()` 会用跟随机位把它覆盖回去，
    // 而 `renderer` 画的是最后一次写入：症状是"这一屏能进、能走、就是看不见自己动"。
    this.world.render(dt, this.phase !== 'lakeside');
    if (this.mg.isRunning) this.mg.render();
    this.ui.update(dt);
    this.dump?.update(dt);
    this.debug?.update(dt);
    if (this.demoActive) this.demoTick(dt);
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
  if (bootEl.isConnected) showFatal(t('fatal_uncaught', [e.message]), e.error);
});

void main();
