/**
 * WebXR —— 让湖边那一屏能进头显。
 *
 * ## 手柄怎么变成游戏里的按键
 *
 * **合成 `KeyboardEvent` 派发到 `window`，和 AI 接口走的是同一条路。**
 *
 * 这不是抄 `live.ts` 的写法，是它那条理由的适用范围：
 * 游戏里有七处在监听键盘（`main.ts` / `dialogue.ts` / `endCard.ts` /
 * `postcardPanel.ts` / `minigameHost.ts` / `touchControls.ts` / `hud.ts`），
 * 手柄如果自己造一条"虚拟输入"，就必须把这七处逐个接一遍，
 * 而漏掉任何一处的症状都是最难查的那一类："对白能推进但小游戏里按键没反应"。
 *
 * 所以扳机 → 一个真的 `Space`。于是：
 *   · 湖边钓鱼在头显里**就是同一个键**，没有第二套状态机；
 *   · `verify_fishing` 那十二条断言覆盖的仍然是这一屏的全部玩法；
 *   · 头显和桌面共用一份输入契约，不存在"只在 VR 里坏"的路径。
 *
 * ## 只在这一屏启用
 *
 * 主骑行是低配优先的第三人称，而 WebXR 的开销是**双眼渲染 + 高刷新率**——
 * 和项目的定位正好相反。所以 `enable()` 由宿主在进入湖边时才调，
 * 退出时 `disable()`。这不是"没做完 VR"，是**有意只做一屏**。
 *
 * ## 相机
 *
 * 进 XR 会话时 three 会接管相机（`WebGLRenderer.render` 内部改用 XR 相机），
 * 所以 `Lakeside.update()` 里那套自由视角**必须让位**，否则两套每帧打架。
 * `host.presenting()` 是那道闸。
 */
import { WebGLRenderer, Group } from 'three';
import { codeOf, type GameAction } from './keymap';

export type XrHost = {
  readonly gl: WebGLRenderer;
  /** 把一次按键送进游戏。实现方负责合成 `KeyboardEvent`——和 AI 接口同一套。 */
  dispatchKey(code: string, down: boolean): void;
  /**
   * 会话开始 / 结束。**宿主必须换帧源**——见 `enter()` 的注释：
   * 不换的话头显里是冻住的一帧，而桌面上一切正常。
   */
  onSessionChange(started: boolean): void;
  /** 每帧调一次；会话结束后清理。 */
  onEnd(fn: () => void): void;
};

/**
 * 手柄上各按钮映射到哪个**动作**。
 *
 * ⚠ 存**动作**而不是 `KeyboardEvent.code`：玩家可以在设置里改键，
 * 而 `keymap.ts` 的 `codeOf()` 是唯一的读法。
 * 这里写死 `Escape` / `Space` 的后果是改键之后头显里的
 * 「扳机抛竿」「菜单退出」变成按了没反应——而头显里没有任何
 * 提示告诉玩家键被换掉了。
 */
const BUTTON_ACTIONS = {
  trigger: 'confirm',
  grip: 'interact',
  menu: 'pause',
} as const satisfies Record<string, GameAction>;

/**
 * 手柄的**模拟摇杆**在头显里没有键盘对应物。
 * 用来在湖边走动，轴值超阈值时按一次方向键（连发由手柄自己决定频率）。
 */
const AXIS_KEYS: { axis: number; pos: GameAction; neg: GameAction; dead: number }[] = [
  { axis: 2, pos: 'forward', neg: 'back', dead: 0.6 },
  { axis: 0, pos: 'right', neg: 'left', dead: 0.6 },
];

export class XrSession {
  private gl: WebGLRenderer;
  private host: XrHost;
  private buttons = new Map<string, boolean>();
  private axes = new Map<number, GameAction | null>();
  private controllers: Group[] = [];
  private endFns: Array<() => void> = [];
  /** 按钮的**边沿**：`Space` 是点一下，按住和点一下要分开派发。 */
  private pressedThisFrame = new Set<string>();
  /** 两个会话事件挂过了没有。见 `enable()` 那段注释。 */
  private bound = false;
  /** 现在真的在会话里吗。用来让 `onSessionChange(false)` 只发一次。 */
  private wasPresenting = false;

  constructor(host: XrHost) {
    this.host = host;
    this.gl = host.gl;
  }

  /**
   * 浏览器**有** WebXR 这套 API 吗。
   *
   * ⚠ 有 API **不等于**能做沉浸式 VR：桌面版 Chrome / Edge 一律
   * `navigator.xr` 存在而 `immersive-vr` 不支持。要问"能不能真的进 VR"
   * 必须用下面的 `vrAvailable()`。
   */
  static hasApi(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.xr;
  }

  /**
   * 这台机器**真的**能进沉浸式 VR 吗。
   *
   * ## 为什么不能只看 `navigator.xr`
   *
   * 原来那一版就是 `!!navigator.xr`，于是在**任何一台桌面 Chrome 上**
   * 都会把这一层建出来——而它一旦被建出来，湖边那一屏每帧都会问
   * `presenting()`（见那里的注释）。VR 按钮也一样：不先问清楚就摆出来，
   * 玩家点下去只会得到一句浏览器的报错，而按钮看起来完全正常。
   *
   * 想在没有头显的机器上试，装一个 WebXR API Emulator 扩展即可——
   * 它会把 `isSessionSupported('immersive-vr')` 变成 true。
   */
  static async vrAvailable(): Promise<boolean> {
    if (!XrSession.hasApi()) return false;
    try {
      return await navigator.xr!.isSessionSupported('immersive-vr');
    } catch {
      // 隐私模式 / 权限策略下这里会抛，而不是返回 false。
      return false;
    }
  }

  /**
   * 开。**幂等**——重复调用不会把事件挂两遍。
   *
   * 重复挂的症状很轻：一次扳机会派发两下 `Space`，钓鱼还在咬钩窗口里，
   * 而玩家会觉得"有时候按一下就够了，有时候要按两下"。
   *
   * `bound` 而不是 `gl.xr.enabled` 当判据：`disable()` 会把 enabled 按回假，
   * 于是"进出湖边两次"会让这两个会话事件挂上两遍——正是上面那个症状。
   */
  enable(): void {
    if (this.bound) return;
    this.bound = true;
    this.gl.xr.enabled = true;
    this.gl.xr.addEventListener('sessionstart', () => this.onSessionStart());
    this.gl.xr.addEventListener('sessionend', () => this.onSessionEnd());
    // `onEnd` 是宿主给的「会话结束回调注册」，一次性。
    this.host.onEnd(() => {
      this.endFns.forEach((f) => f());
      this.endFns = [];
    });
  }

  /**
   * 退出这一层。
   *
   * ## 这里原来只做了自己的记账
   *
   * 原来 `disable()` 是「把 `enabled` 按回假 + 调自己的 `onSessionEnd()`」，
   * 而**浏览器那边的沉浸式会话仍然开着**——全仓库没有一处 session.end()。
   * 三个后果，每一个都是玩家看得见的：
   *
   * · 头显里冻住。three 只在自己的 `onAnimationFrameCallback` 里绑头显的
   *   framebuffer，而那个回调已经被我们设成了 `null`；`isPresenting` 却还是
   *   true，于是桌面正常、头显黑着或定住。
   * · `presenting()` 永远返回 true，于是下一次进湖边时 `Lakeside.update()`
   *   整段让位（`inXR` 为真 → 不摆相机），玩家在一个**冻住的相机**里站着。
   * · `enter()` 的 `if (isPresenting) return true` 直接短路，
   *   `onSessionChange(true)` 再也不会触发。
   *
   * 所以现在真的去结束会话。`end()` 是异步的，而调用方（`exitLakeside`）
   * 是同步的——**不能 await**：那一路正处在相位切换的中途，
   * 而 `onSessionChange(false)` → 换回 rAF 帧源这件事必须立刻做完。
   * 于是顺序是「先把键松开、通知宿主换帧源，再异步去结束会话」：
   * 桌面侧立刻可玩，头显侧由浏览器自己收尾（它会补发 `sessionend`，
   * 那个事件是幂等的）。
   */
  disable(): void {
    this.gl.xr.enabled = false;
    this.onSessionEnd();
    // 先记账再结束会话：`onSessionEnd()` 已经把 `wasPresenting` 按成 false，
    // 而浏览器补发的 `sessionend` 会再走一遍这里——幂等，两遍都对。
    void this.gl.xr.getSession()?.end().catch(() => {
      // 浏览器拒绝结束（设备被拔、会话已在收尾中）不该把游戏弄坏。
    });
  }

  get enabled(): boolean {
    return this.gl.xr.enabled;
  }

  /**
   * 现在是不是在 XR 会话里。
   *
   * ## 这里曾经无限递归
   *
   * 它原来写的是 `return this.host.presenting()`，而宿主那一侧的回调是
   * `presenting: () => xr.presenting()`——**同一句话转了一圈**。
   * 于是湖边那一屏的第一帧就是 `RangeError: Maximum call stack size exceeded`，
   * 而且它只在 `navigator.xr` 存在时发生（也就是每一台桌面 Chrome）。
   *
   * 真相只有一个来源：渲染器的 `WebXRManager.isPresenting`。
   */
  presenting(): boolean {
    return this.gl.xr.isPresenting;
  }

  /**
   * 开一次沉浸式会话。
   *
   * ## 为什么必须由一次点击触发
   *
   * `requestSession()` 要**用户激活**（user activation）。不在点击回调里调，
   * Chrome 直接抛 `SecurityError`——而界面上看到的是"按钮按了没反应"。
   * 所以这条路只从 VR 那个按钮进来，不要顺手挪到别处。
   *
   * ## 会话开起来之后，帧源必须换
   *
   * three 的 `WebXRManager` 只在**它自己的帧回调**里绑定头显的 framebuffer
   * 并刷新双眼位姿（`WebXRManager.js` 的 `onAnimationFrame`），而那个回调是
   * `renderer.setAnimationLoop()` 装上去的——`window.requestAnimationFrame`
   * 不在里面。所以宿主收到 `onSessionChange(true)` 之后要把主循环的 rAF 停掉、
   * 改由渲染器推帧。不换的话头显里是一帧冻住的画面，而桌面上一切正常。
   */
  async enter(): Promise<boolean> {
    if (this.gl.xr.isPresenting) return true;
    if (!XrSession.hasApi()) return false;
    this.enable();
    try {
      const session = await navigator.xr!.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor'],
      });
      await this.gl.xr.setSession(session);
      return true;
    } catch {
      // 玩家拒绝授权、头显被拔掉、或者这一台机器其实不支持。
      // 三种都不该把游戏弄坏——按钮按了没成，说一声就够了。
      return false;
    }
  }

  private onSessionStart(): void {
    // **先告诉宿主换帧源。** 这是头显里能不能看见东西的那一步，
    // 而它必须发生在第一帧之前——晚一帧就是"进 VR 之后黑一下"。
    this.wasPresenting = true;
    this.host.onSessionChange(true);
    const session = this.gl.xr.getSession();
    if (!session) return;
    // 'local-floor' 带出**地面原点**，而湖边的水面高度不是 0——
    // 所以这一屏仍然用 'local'，眼高由 `Lakeside` 自己管。
    void session
      .requestReferenceSpace('local')
      .then(() => {
        // **只手，不用 grip。** three r169 只有 `getController(i)` 这个单数形式，
        // 而 `getControllerGrips()` 是后来才有的；两只手各取一个就够了——
        // 这一屏不需要手柄的位姿（玩家自己走动），只需要按键与摇杆。
        for (const src of [this.gl.xr.getController(0), this.gl.xr.getController(1)]) this.bind(src);
      })
      .catch(() => {
        // 拿不到参考空间就只是没有手——**不阻断会话**。
        // 整屏失败和少一半功能，后者对玩家友好得多。
      });
  }

  /**
   * three 的 `Object3DEventMap` **不包含** XR 的那五个事件
   * （`selectstart` / `selectend` / `squeezestart` / `squeezeend` / `axismove`），
   * 可运行时它们确实由 `WebXRManager` 派发。所以这里显式取一次 `any` 挂上去，
   * 而不是去改 three 的类型——改类型要么动 `node_modules`，要么全项目加一串
   * `declare module`，两者都比这一行贵。
   */
  private bind(src: Group): void {
    const s = src as unknown as {
      addEventListener(t: string, fn: (ev: unknown) => void): void;
      userData: Record<string, unknown>;
    };
    s.addEventListener('selectstart', () => this.down(codeOf(BUTTON_ACTIONS.trigger)));
    s.addEventListener('selectend', () => this.up(codeOf(BUTTON_ACTIONS.trigger)));
    s.addEventListener('squeezestart', () => this.down(codeOf(BUTTON_ACTIONS.grip)));
    s.addEventListener('squeezeend', () => this.up(codeOf(BUTTON_ACTIONS.grip)));
    // 模拟摇杆：把轴值当成方向键，跨过死区时**按下**、回到死区内时**松开**。
    s.addEventListener('axismove', (ev) => {
      const e = ev as { axis?: number; value?: number };
      const idx = e.axis;
      if (idx == null) return;
      const rule = AXIS_KEYS.find((r) => r.axis === idx);
      if (!rule) return;
      const v = e.value ?? 0;
      // 轴值存的是**动作**，派发时才翻成物理键。这样"改键之后摇杆跟着改"
      // 不需要动这里——而如果这里存了物理键，它就会是最后一个漏掉的地方。
      const act: GameAction | null = v > rule.dead ? rule.pos : v < -rule.dead ? rule.neg : null;
      const cur = this.axes.get(idx);
      if (cur === act) return;
      if (cur) this.up(codeOf(cur));
      if (act) this.down(codeOf(act));
      this.axes.set(idx, act);
    });
    this.controllers.push(src);
  }

  private down(code: string | undefined): void {
    if (!code) return;
    if (this.buttons.get(code)) return;
    this.buttons.set(code, true);
    this.pressedThisFrame.add(code);
    this.host.dispatchKey(code, true);
  }

  private up(code: string | undefined): void {
    if (!code) return;
    if (!this.buttons.get(code)) return;
    this.buttons.set(code, false);
    this.host.dispatchKey(code, false);
  }

  private onSessionEnd(): void {
    // 只有**真的在会话里**才通知宿主换回帧源。`disable()` 每次退出湖边都会
    // 走到这里，而那时本来就没在 VR 里——无条件通知的话，每次退出湖边都会
    // 把主循环重启一遍（多一次 rAF 交接，还可能和 `setManual` 抢）。
    if (this.wasPresenting) {
      this.wasPresenting = false;
      this.host.onSessionChange(false);
    }
    // **会话结束时必须把所有按下的键松开**。
    // 不松的话 `main.ts` 的 `this.keys` 里会永久留着 `Space`，
    // 而回到桌面之后玩家第一次按方向键就会发现"车自己在动"。
    for (const [code, held] of this.buttons) if (held) this.host.dispatchKey(code, false);
    this.buttons.clear();
    this.axes.clear();
    this.pressedThisFrame.clear();
    for (const c of this.controllers) c.parent?.remove(c);
    this.controllers = [];
  }

  dispose(): void {
    this.onSessionEnd();
    this.endFns = [];
  }
}