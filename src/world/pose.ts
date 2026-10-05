/**
 * 姿势取样 —— 从动作片段里量出「某一刻的姿势」，并把它**定格**成一条片段。
 *
 * 谁在用：**滑板**。站上板之后人不再播跑步循环，而是保持一个定住的姿势。
 * 那个姿势不是摆拍出来的，是从 `run` 里挑出来的一帧，
 * 挑的标准是「双脚张得最开的那一刻」（见 `stancePoseOf`）。
 *
 * ## 为什么采样交给 three 自己，而不是手写前向运动学
 *
 * 把一段动画摆到某个时刻、读某根骨的世界坐标，这事很容易写成手写 FK，
 * 而手写的那一版在本项目的素材上**算出来是错的**：
 * 父链逐级累加的方向一旦写反（`父平移 × 子旋转`，而不是
 * `父平移 × 父旋转 × 子平移`），量出来的脚会跑到骨盆**上方** 1.1 个单位去，
 * 而数值上「看不出哪里不对」——脚比髋还高这件事，只有拿画面比才发现。
 *
 * 所以这里只搭一副**没有网格的 scratch 骨架**（骨的副本，只留名字与静置变换），
 * 把真片段交给 three 自己的 `AnimationMixer` 去摆：
 * 插值、slerp、四元数归一化全走 three 的实现，**和画面上跑的是同一套代码**。
 * 实测两者一致：最宽帧双脚间距 0.4310（见 `stancePoseOf` 的表）。
 *
 * ## ★ `Interpolant.evaluate(t, target)` 在 three 0.169 里**不写 target**
 *
 * 签名上有第二个参数，实现却只返回 `resultBuffer`（而且下一次 `evaluate`
 * 会复用同一块内存）。传一个 `Float32Array` 进去、之后去读那个数组，
 * 读到的**永远是零** —— 于是「定格片段」把每一根骨都写成 0，
 * 人整个塌到原点，症状是「滑板上没人」（和车没装好是同一个画面）。
 *
 * 正确用法只有一种：**用返回值**，并且立刻把分量拷出来。`stillClipAt` 就这么写。
 */
import {
  AnimationClip,
  AnimationMixer,
  Bone,
  Group,
  InterpolateDiscrete,
  KeyframeTrack,
  LoopRepeat,
  Object3D,
  Quaternion,
  Vector3,
  type AnimationAction,
} from 'three';

function isBone(o: Object3D): boolean {
  return (o as unknown as { isBone?: boolean }).isBone === true;
}

/**
 * Mixamo 骨架里代表「脚」的几根骨。
 *
 * ★ 名字是 **three 清洗过**的（`PropertyBinding.sanitizeNodeName` 把 `:`
 *   **删掉**而不是替换），所以是 `mixamorigLeftFoot` 而不是 `mixamorig:LeftFoot`。
 *   写成带冒号的名字，量到的会是「一根都不存在」，于是全部量数恒为 0，
 *   而判据还是绿的。
 */
export const FOOT_BONES: readonly string[] = [
  'mixamorigLeftFoot',
  'mixamorigRightFoot',
  'mixamorigLeftToeBase',
  'mixamorigRightToeBase',
];

/**
 * 搭一副**没有网格**的骨架副本：只留骨（以及骨到根之间的中间节点）与它们的静置变换。
 *
 * ## 为什么要连中间的非骨节点一起留
 *
 * 骨架上面通常还挂着若干普通节点（蒙皮网格的父级、导出工具加的空节点）。
 * 只复制骨、跳过中间那些节点，量到的就是一条**不存在的**骨链——
 * 而结果看上去还挺像个人，不会有人发现。
 * 真模型里 `mixamorigHips` 与 `neutral_bone` 直接挂在场景根上，
 * 所以本项目现在量得出来；但那是**模型的性质**，不是这个函数的保证。
 *
 * ## 静置变换取的是**当时的**值
 *
 * 这与画面上的 mixer 行为一致：`PropertyMixer` 在绑定动作时把「当时的值」
 * 存成 original，缺轨道的骨就回落到它。所以两边的兜底是同一份，
 * 差一个数量级这件事不会发生。
 */
export function scratchSkeleton(char: Object3D): { root: Group; bones: Map<string, Bone> } {
  const keep = new Set<Object3D>();
  char.traverse((o) => {
    if (!isBone(o)) return;
    for (let p: Object3D | null = o; p && p !== char; p = p.parent) keep.add(p);
  });

  const root = new Group();
  const copy = new Map<Object3D, Object3D>();
  const visit = (o: Object3D): void => {
    // 父节点一定先于子节点被复制（深度优先），所以 `copy.get` 拿得到。
    // ★ 直接挂在 `char` 下的那些（真模型里的 `mixamorigHips`、`neutral_bone`
    //   就是这样）要挂到 scratch 的**根**上，而不是「没有父节点就跳过」——
    //   跳过的后果是 mixer 报一屏 `No target node found`，
    //   于是所有量数恒为 0，而定格出来的姿势是 bind pose。
    const parent = o.parent && o.parent !== char ? copy.get(o.parent) : root;
    if (!parent) return;
    const c: Object3D = isBone(o) ? new Bone() : new Object3D();
    c.name = o.name;
    c.position.copy(o.position);
    c.quaternion.copy(o.quaternion);
    c.scale.copy(o.scale);
    parent.add(c);
    copy.set(o, c);
    for (const k of o.children) if (keep.has(k)) visit(k);
  };
  for (const k of char.children) if (keep.has(k)) visit(k);
  root.updateMatrixWorld(true);

  const bones = new Map<string, Bone>();
  for (const dst of copy.values()) if (isBone(dst)) bones.set(dst.name, dst as Bone);
  return { root, bones };
}

/**
 * 片段里**真正有的那些帧**（全部轨道时间点的并集），去重排序。
 *
 * 为什么不在这里自造一串等距采样点：那样「最宽的那一帧」会**随采样密度漂移**
 * （同一段动画，200 步和 2000 步选出来的时刻不一样），
 * 回归也就钉不住一个具体的数。片段自己的关键帧是稳定的。
 *
 * 量化到 1e-6 再入集合：同一条轨道上的时刻来自同一个 float32，
 * 但不同轨道之间可能有末位差别，不量化就会去重失败、帧数虚高。
 */
export function keyTimesOf(clip: AnimationClip): number[] {
  const set = new Set<number>();
  for (const tr of clip.tracks) {
    for (const t of tr.times) {
      if (!Number.isFinite(t)) continue;
      const q = Math.round(t * 1e6) / 1e6;
      if (q >= -1e-6 && q <= clip.duration + 1e-6) set.add(Math.max(0, q));
    }
  }
  const out = [...set].sort((a, b) => a - b);
  return out.length ? out : [0, clip.duration];
}

/** 采样时每步的假 dt。**不能是 0**：`mixer.update(0)` 在 three 内部提前返回，一帧都不写。 */
const SEEK_DT = 1 / 60;

/**
 * 一副 scratch 骨架 + 一个 mixer：能把 `clip` 摆到任意时刻并量骨。
 *
 * 每个实例**自带一副骨架和自己的 mixer**，所以同时问两段片段时
 * 不会互相污染权重（`AnimationMixer` 是按权重把多条动作混合的，
 * 两条都保持默认权重 1 的话，量到的是它们的混合而不是任何一条）。
 */
export class PoseSampler {
  private readonly root: Group;
  private readonly bones: Map<string, Bone>;
  private readonly mixer: AnimationMixer;
  private readonly action: AnimationAction;
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  /** `relPos` 用的根骨位置暂存。 */
  private readonly c = new Vector3();

  constructor(char: Object3D, clip: AnimationClip) {
    const sk = scratchSkeleton(char);
    this.root = sk.root;
    this.bones = sk.bones;
    this.mixer = new AnimationMixer(this.root);
    this.action = this.mixer.clipAction(clip);
    this.action.setLoop(LoopRepeat, Infinity);
    this.action.play();
    // 冻结时间：**每帧写的都是同一个时刻**，所以量出来的姿势是定住的。
    // `paused` 只把有效倍率压到 0，`_update` 照样把插值结果写进骨头。
    this.action.paused = true;
    this.seek(0);
  }

  /** 摆到 `t` 秒。超出片段范围时 three 自己夹到端点。 */
  seek(t: number): void {
    this.action.time = t;
    this.mixer.update(SEEK_DT);
    this.root.updateMatrixWorld(true);
  }

  /** 两根骨在**水平面**上的距离（模型单位，y 被丢掉）。少任何一根返回 0。 */
  span(a: string, b: string): number {
    const ba = this.bones.get(a);
    const bb = this.bones.get(b);
    if (!ba || !bb) return 0;
    ba.getWorldPosition(this.a);
    bb.getWorldPosition(this.b);
    return Math.hypot(this.a.x - this.b.x, this.a.z - this.b.z);
  }

  /** 这些骨里**最低**的那一个的 Y（角色本地空间，模型单位）。一根都没有返回 `Infinity`。 */
  lowY(names: readonly string[]): number {
    let low = Infinity;
    for (const n of names) {
      const b = this.bones.get(n);
      if (!b) continue;
      b.getWorldPosition(this.a);
      if (this.a.y < low) low = this.a.y;
    }
    return low;
  }

  /** scratch 骨架里有没有这根骨。 */
  has(name: string): boolean {
    return this.bones.has(name);
  }

  /** 全部骨名。 */
  boneNames(): string[] {
    return [...this.bones.keys()];
  }

  /**
   * 某根骨**相对根骨**的世界位置。
   *
   * ★ 为什么必须减掉根骨，而不是直接用世界位置：骑行片段自带 5.2m 的根位移
   *   （`stripRootMotion` 之前），而脚的绝对轨迹是「踩踏 + 整个人往前平移」。
   *   不减掉根骨的话，量到的「脚在不在原处」99% 是那 5.2m 平移，
   *   于是循环接缝会被量成「离末帧最近」——**恰好是最差的那个点**。
   *   实测：不减根骨时末帧差距 5.2，减掉之后 0.244。
   *
   * 减掉根骨之后**骨盆自己的上下起伏也被减掉了**，而那是要看的
   *   （`poseSnapshot` 另外单列一根出来比它的本地 y）。
   */
  relPos(root: string, name: string, out: Vector3): boolean {
    const b = this.bones.get(name);
    const r = this.bones.get(root);
    if (!b || !r) return false;
    r.getWorldPosition(this.c);
    b.getWorldPosition(out);
    out.sub(this.c);
    return true;
  }

  /** 某根骨的**世界**姿态（四元数，可能带双覆盖的符号——比较时务必看 `rotAngle`）。 */
  worldQuat(name: string, out: Quaternion): boolean {
    const b = this.bones.get(name);
    if (!b) return false;
    b.getWorldQuaternion(out);
    return true;
  }

  /** 某根骨的**本地** y。骑行的上下起伏（bob）就挂在根骨的这一路上。 */
  localY(name: string): number {
    return this.bones.get(name)?.position.y ?? 0;
  }

  /** `root` 那一根及其全部后代骨名。用来把「根骨的兄弟」挡在度量之外。 */
  subtreeOf(root: string): string[] {
    const out: string[] = [];
    const stack = [root];
    while (stack.length) {
      const n = stack.pop()!;
      if (out.includes(n)) continue;
      out.push(n);
      for (const b of this.bones.values()) {
        if (this.bones.get(n) === b.parent) stack.push(b.name);
      }
    }
    return out;
  }
}

/**
 * 把 `clip` 在 `t` 时刻的姿势**定格**成一条新片段。
 *
 * 每条轨道采一个值、写成两个相同的帧 + 离散插值，于是这条轨在
 * 任意时刻都是同一个数——包括 mixer 自己去夹取的时候。
 * 时长给 1 秒：它只是个「能被 mixer 播的容器」，不再被推进。
 *
 * ★ 值只能用 `evaluate()` 的**返回值**（见文件头）。
 */
export function stillClipAt(clip: AnimationClip, t: number, name: string): AnimationClip {
  const tracks = clip.tracks.map((tr) => {
    const size = tr.getValueSize();
    // ★ 只用 `evaluate()` 的返回值，而且**立刻**把分量拷出来：
    //   它就是 interpolant 自己的 resultBuffer，下一次 evaluate 会原地改写。
    const raw = tr.createInterpolant().evaluate(t);
    const v = new Float32Array(size);
    for (let i = 0; i < size; i++) v[i] = raw[i];
    const values = new Float32Array(size * 2);
    values.set(v, 0);
    values.set(v, size);
    return new KeyframeTrack(tr.name, new Float32Array([0, 1]), values, InterpolateDiscrete);
  });
  return new AnimationClip(name, 1, tracks);
}

export interface StancePose {
  /** 定格后的片段：`run` 的 `time` 那一帧被冻结成常量 */
  clip: AnimationClip;
  /** 取自 `run` 的哪一刻（秒） */
  time: number;
  /** 那一帧双脚在水平面的间距（模型单位） */
  span: number;
  /**
   * 那一帧的**最低脚点**比「站平」高出多少（模型单位）。
   * 正数 = 人要往下压这么多才踩得到板面。
   *
   * 它必须**相对**另一段片段量，不能写死一个常数：
   * 骨原点在踝关节而不是脚底，模型原点也不在板面上，
   * 所以「这个高度算不算踩到板」只有一个自校准的答法——
   * 拿同一把尺子（同一批骨、同一套变换）去量一段**站姿**，
   * 两者之差才是「这一帧比站着高了多少」。
   */
  rise: number;
}

/**
 * ★ 从 `run` 里挑出「双脚张得最开的那一帧」，并定格成滑板姿势。
 *
 * ## 「张得最开」为什么量**水平面**、为什么只量**两个踝骨**
 *
 * `survivor.glb` 的 `run`（1.25 s，31 帧）实测三个量各自的峰值：
 *
 * | 量 | 峰值 | 峰值时刻 | 读作 |
 * |---|---|---|---|
 * | 横向（X） | **0.0735** | 0.375 s | **退化**：跑步时两脚各在自己那一侧，横向间距几乎恒定，取最大等于随便取一帧 |
 * | 水平面（XZ） | **0.4319** | **1.1667 s**（键 28，93.3%） | 前脚在后脚**正前方** 0.43，正是滑板该有的前后站姿 |
 * | 三维 | 0.4405 | 1.1675 s | 与上一行**同一帧**；多出来的那点是腾空期的高度差，不是站姿宽 |
 *
 * 判据取水平面：横向那一列说明「按横向取最大」这件事本身没有意义，
 * 而三维会把「腾空多高」混进「站得有多开」。
 *
 * 换算到世界尺度：0.4319 × 1.7534 = **0.757 m** 的前后开度。
 * 板长约 1.31 m，所以两脚一前一后落在板的中段——这就是要的站姿。
 *
 * @param stand 「站平」的参考片段（通常是 `idle`）。给 `null` 时 `rise` 记 0。
 * @returns 量不到双脚（模型没有这两根骨）时返回 `null`。
 */
export function stancePoseOf(
  char: Object3D,
  run: AnimationClip,
  stand: AnimationClip | null,
  feet: readonly string[] = FOOT_BONES,
): StancePose | null {
  const left = feet.find((n) => /leftfoot$/i.test(n));
  const right = feet.find((n) => /rightfoot$/i.test(n));
  if (!left || !right) return null;

  const probe = new PoseSampler(char, run);

  // 只在片段**真正有的那些帧**上取最大，而且**到此为止**。
  //
  // ★ 这里**不做**段内细化，而这是有理由的：glTF 的位置轨道是
  //   **分段线性**的（`run` 的骨盆 31 个关键帧之间就是 31 段直线），
  //   而**分段线性函数的极大值必在折点上**——也就是必在关键帧上。
  //   段内再怎么搜也搜不出比折点更高的值。
  //
  //   唯一可能段内出峰的是四元数：slerp 出来的旋转是非线性的，
  //   挂在它下面的骨的世界坐标在段内是条弯的曲线。实测真素材
  //   （`survivor.glb` 的 `run`）：段内细搜到 1.16666 s / 0.43194，
  //   只扫关键帧是 1.16667 s / 0.43194——**差 1e-5**，而多花 40 次采样。
  //
  //   顺带一提：段内搜索还有一个更坏的性质——曲线在一段里近乎平坦时
  //   （两端的值几乎相等），搜索会收敛到平台上任意一点，
  //   得到的时刻既不是关键帧、也不可复现地「最优」。
  const times = keyTimesOf(run);
  let time = times[0] ?? 0;
  let span = -1;
  for (const t of times) {
    probe.seek(t);
    const s = probe.span(left, right);
    if (s > span) {
      span = s;
      time = t;
    }
  }

  // 落板高度：与一段站姿比，取「最低脚点」之差（自校准，见 `StancePose.rise`）。
  //
  // ★ 必须**重新摆回 `time`**：上面那个循环结束时 probe 停在**最后一个关键帧**上，
  //   而 `time` 通常不是它。不摆回去的话，落差量的是别人的姿势——
  //   而这一帧恰好是「双脚最低」的那一帧，差值会算成一个小数，
  //   症状是「人几乎浮在板上面」，没有任何别的断言会红。
  probe.seek(time);
  let rise = 0;
  if (stand) {
    const flat = new PoseSampler(char, stand);
    let standLow = Infinity;
    for (const t of keyTimesOf(stand)) {
      flat.seek(t);
      const y = flat.lowY(feet);
      if (y < standLow) standLow = y;
    }
    if (Number.isFinite(standLow)) rise = probe.lowY(feet) - standLow;
  }

  return { clip: stillClipAt(run, time, `${run.name}·stance`), time, span, rise };
}

/* ------------------------------------------------------------------ *
 * ## 循环接缝：一条循环片段**该在哪里断开**
 * ------------------------------------------------------------------ *
 *
 * `setLoop(LoopRepeat, Infinity)` 把末帧硬接回首帧。于是只要素材的
 * 首帧与末帧**不是同一个姿势**，每转一圈就「啪」一下把整个人瞬移回去。
 *
 * `骑自行车` 实测就是这样：4.958s / 120 帧，脚只踩了 **3.417 圈**——
 * 不是整数圈，所以末帧的脚停在**半圈之后**的姿势上：
 *
 * | | 时刻 | 已踩圈数 | 双脚与首帧的差距（模型单位） |
 * |---|---|---|---|
 * | 现状接缝（末帧） | 4.958s | 3.417 | **0.2442** |
 * | ★ 裁到 1 圈后 | **1.708s** | **1.012** | **0.0314**（好 7.8 倍） |
 *
 * 换算成看得见的量：只量两个踝骨的位置差，末帧是 **0.1979**（34.7cm），
 * 裁完是 **0.0114**（2.0cm）——**17 倍**。0.2 个单位是角色小半个小腿，
 * 每转一圈脚就「啪」地瞬移一次，一眼就看得见。
 *
 * 裁掉的 3.25s 不是白丢的：`cadenceScale` 用的是片段自带的步速倍率，
 * 而裁剪不改变步速（实测 4.958s 段 1.061 m/s → 1.708s 段 1.041 m/s，差 1.9%），
 * 所以**踩踏速率不变**，变的只是「多久循环一次」。
 *
 * ### 找法：**脚踩满一圈之后**，取离首帧最近的那一帧
 *
 * 判据分两半，缺一不可：
 *
 * 1. **圈数 ≥ 1**：只比「像不像首帧」会挑中 t≈0 附近——那里当然最像，
 *    但那等于什么都没裁。所以先量「脚相对曲柄中心转过几圈」，
 *    再只在 ≥1 圈的帧里找。
 * 2. **差距最小**：在上面的候选里取双脚离首帧最近的那一帧。
 *    **不在段内细化**——理由与 `stancePoseOf` 那段是同一条：
 *    差距函数对每条分段线性轨道也是分段线性的，极小值必在折点上。
 *    实测这一条素材上段内细搜比取折点只好 0.005 个单位，而换来的是一个
 *    不可复现的时刻（回归钉不住）。
 *
 * 实测最优解 t=1.708s（帧 41，1.012 圈），**脚最优与全身最优落在同一帧**
 * （脚差 0.0314 / 身体差 0.0273），所以两个判据不打架——
 * 不存在「脚回去了但上身还在拧」的第二选择。
 *
 * ### ★ 四元数必须**符号无关**地比，否则量出来的是假差距
 *
 * three 的四元数有双覆盖：`q` 与 `−q` 是**同一个旋转**。
 * 而 `PropertyMixer` 写进骨头的是归一化后的结果，符号会随姿态翻面。
 * 实测：接缝处 `LeftToeMiddle2` 的世界四元数与首帧只差 **14.8°**，
 * 可逐分量相减得到 0.5562——**符号反了**。而
 * `neutral_bone` 更狠：它是根骨的**兄弟**（都挂在 `Armature` 下），
 * 带着 5.26 的根位移，逐分量比得到 0.84，**比脚踝本身还「跳」**。
 *
 * 所以：① 旋转一律走 `2·acos(|q₀·q₁|)`；② 位置一律减掉根骨；
 * ③ 全身只取**根骨的子树**，把 `neutral_bone` 这类兄弟节点挡在外面。
 */

/**
 * 把 1 弧度折算成多少模型单位。
 *
 * 理由是**物理**的而不是拍脑袋的：一根单位长的肢体转 θ 弧度，
 * 末端正好走 θ。模型身高 ≈ 1.0，所以肢长取 1，
 * 「转 1 弧度」与「偏移 0.1 个单位」在画面上是同一件事。
 *
 * 取 0.1 而不是 1：转角是**无量纲**的，不折成位置就没法和位移相加；
 * 折大了会让一个原地转手腕的骨盖过一条腿的位移。
 */
const SEAM_ROT_WEIGHT = 0.1;

/** 某根骨在某一刻的快照（根骨相对）。 */
interface BoneFrame {
  /** 相对根骨的世界位置 */
  p: Vector3;
  /** 世界姿态（**可能带双覆盖的符号**，比较必须走 `rotAngle`） */
  q: Quaternion;
  /** 这根骨的**本地** y（只有根骨那一路有意义：骑行的上下起伏） */
  y: number;
}

/** 符号无关的旋转角（弧度）。`q` 与 `−q` 是同一个旋转，所以 dot 取绝对值。 */
function rotAngle(a: Quaternion, b: Quaternion): number {
  return 2 * Math.acos(Math.min(1, Math.abs(a.dot(b))));
}

export interface LoopSeam {
  /** 循环该在这里断开（秒）。播 `[0, time]`。 */
  time: number;
  /** 原片段时长 */
  duration: number;
  /** 到断点为止脚已经踩了几圈（绝对值，**≥ 1**） */
  turns: number;
  /** 断点处**双脚**与首帧的差距（模型单位） */
  footGap: number;
  /** 断点处**全身**与首帧的差距（模型单位） */
  bodyGap: number;
  /** 不裁剪的话，末帧与首帧的双脚差距——用来证明裁剪有意义 */
  footGapAtEnd: number;
}

/**
 * 在 `clip` 里找出循环接缝：脚踩满一圈之后，离首帧最近的那一帧。
 *
 * 圈数用**曲柄角**量：骑行的两只脚对称地踩在两个踏板上，
 * 所以**两踝的中点就是曲柄轴心**，左踝相对它的方位角单调转过一周就是踩了一圈。
 * 取 `atan2(dy, dz)`（矢状面）而不是 `atan2(dx, dz)`——
 * 踩踏发生在前后方向上，用错平面会量到骨盆的左右晃。
 *
 * @param rootName 根骨名。位置一律相对它来量（见文件头「为什么必须减掉根骨」）。
 * @returns 量不到双脚、量不到根骨，或**一圈都没踩满**时返回 `null`
 *   （后者意味着这段动画本来就不循环，不用裁）。
 */
export function loopSeamOf(
  char: Object3D,
  clip: AnimationClip,
  rootName: string,
  feet: readonly string[] = FOOT_BONES,
): LoopSeam | null {
  const left = feet.find((n) => /leftfoot$/i.test(n));
  const right = feet.find((n) => /rightfoot$/i.test(n));
  if (!left || !right) return null;

  const probe = new PoseSampler(char, clip);
  if (!probe.has(left) || !probe.has(right) || !probe.has(rootName)) return null;

  const bodyBones = probe.subtreeOf(rootName);
  const footBones = feet.filter((n) => probe.has(n));
  const times = keyTimesOf(clip);

  const snap = (t: number, set: readonly string[]): Map<string, BoneFrame> => {
    probe.seek(t);
    const out = new Map<string, BoneFrame>();
    for (const n of set) {
      const p = new Vector3();
      if (!probe.relPos(rootName, n, p)) continue;
      const q = new Quaternion();
      if (!probe.worldQuat(n, q)) continue;
      out.set(n, { p, q, y: probe.localY(n) });
    }
    return out;
  };

  /** 一份快照与首帧的差距。根骨只比自己的**本地 y**：x/z 是根位移，与循环无关。 */
  const gap = (a: Map<string, BoneFrame>, b: Map<string, BoneFrame>): number => {
    let s = 0;
    a.forEach((x, n) => {
      const y = b.get(n);
      if (!y) return;
      const dp = n === rootName ? Math.abs(x.y - y.y) : x.p.distanceTo(y.p);
      s += dp + rotAngle(x.q, y.q) * SEAM_ROT_WEIGHT;
    });
    return a.size ? s / a.size : 0;
  };

  // ---- ① 逐关键帧量曲柄圈数 ----
  const la = new Vector3();
  const ra = new Vector3();
  const turns = new Float64Array(times.length);
  let prev = 0;
  let acc = 0;
  for (let i = 0; i < times.length; i++) {
    probe.seek(times[i]);
    probe.relPos(rootName, left, la);
    probe.relPos(rootName, right, ra);
    const ang = Math.atan2(la.y - (la.y + ra.y) / 2, la.z - (la.z + ra.z) / 2);
    if (i > 0) {
      // 解缠：每一帧的角度都折到 (−π, π]，否则转过 180° 那一格会突然反向。
      let d = ang - prev;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      acc += d;
    }
    prev = ang;
    turns[i] = acc / (2 * Math.PI);
  }
  const totalTurns = Math.abs(turns[times.length - 1]);
  // 一圈都没踩满就没有「踩了一圈之后」可选——不裁，别把循环裁成一个残段。
  if (totalTurns < 1) return null;

  // ---- ② 只在「已踩 ≥1 圈」的关键帧里找差距最小的那一帧 ----
  const p0Foot = snap(times[0], footBones);
  const p0Body = snap(times[0], bodyBones);
  let at = -1;
  let best = Infinity;
  for (let i = 0; i < times.length; i++) {
    if (Math.abs(turns[i]) < 1 - 1e-9) continue;
    const g = gap(p0Foot, snap(times[i], footBones));
    if (g < best) {
      best = g;
      at = i;
    }
  }
  if (at < 0) return null;

  // ★ **不做段内细化**，理由与 `stancePoseOf` 那段完全一样：差距函数对每条
  //   分段线性轨道也是分段线性的，极小值必在折点上；而四元数 slerp 带进来的
  //   非线性，实测只差 1e-5 量级。所以断点就取**关键帧本身**——
  //   一个可复现、能被回归钉住的具体时刻。
  const time = times[at];

  return {
    time,
    duration: clip.duration,
    turns: Math.abs(turns[at]),
    footGap: gap(p0Foot, snap(time, footBones)),
    bodyGap: gap(p0Body, snap(time, bodyBones)),
    footGapAtEnd: gap(p0Foot, snap(clip.duration, footBones)),
  };
}

/**
 * 把片段裁到 `[0, seam.time]`，让它在**量出来的那个时刻**接回首帧。
 *
 * 做两件事：
 *
 * 1. **丢掉断点之后的全部关键帧**，时长给 `seam.time`。
 * 2. **保证每条轨在断点上都有值**。
 *
 * ⚠ 第 2 步不是可有可无的。`骑自行车` 里有 5 根骨的轨道**只有 2 帧**
 *   （分趾骨的 `LeftToeMiddle1/2`、`LeftToeRing1/2`，以及根骨的兄弟
 *   `neutral_bone`），两帧分别在 0 和片段末尾 4.958s。裁到 1.708s 之后
 *   它们的第二帧被丢掉，只剩一个关键帧——而**一帧的轨道是不能插值的**。
 *   在断点上补一个同值关键帧，它们就变回 [0, seam] 的常量轨（本来就是常量），
 *   所以不需要额外的特判。对那些 120 帧的轨，补上去的值与最后一帧相同（本来就是常量段），
 *   等于白补一次——**一次** `evaluate`，不花钱。
 *
 * ⚠ 值只能用 `evaluate()` 的**返回值**且**立刻**拷出来（见文件头）。
 *   逐条取的是**原轨道**在 `seam.time` 处的值。
 */
export function trimToSeam(clip: AnimationClip, seam: LoopSeam): AnimationClip {
  const end = seam.time;
  const tracks: KeyframeTrack[] = [];
  for (const tr of clip.tracks) {
    const size = tr.getValueSize();
    const n = tr.times.length;

    // ① 落在 [0, end] 里的关键帧
    let keep = 0;
    while (keep < n && tr.times[keep] <= end + 1e-6) keep++;

    if (keep === 0) {
      // 断点早于这条轨的第一帧：整条轨在 [0, end] 上是常量。
      tracks.push(
        new KeyframeTrack(
          tr.name,
          new Float32Array([0, end]),
          new Float32Array([...tr.values.subarray(0, size), ...tr.values.subarray(0, size)]),
          tr.getInterpolation(),
        ),
      );
      continue;
    }

    // ② 末帧已经落在断点上（`seam.time` 就是一个关键帧）时原样保留，
    //    否则在断点上补一帧。
    const needPad = end - tr.times[keep - 1] > 1e-6;
    const times = new Float32Array(needPad ? keep + 1 : keep);
    const values = new Float32Array(needPad ? (keep + 1) * size : keep * size);
    times.set(tr.times.subarray(0, keep));
    values.set(tr.values.subarray(0, keep * size));
    if (needPad) {
      const raw = tr.createInterpolant().evaluate(end);
      times[keep] = end;
      for (let i = 0; i < size; i++) values[keep * size + i] = raw[i];
    }

    tracks.push(new KeyframeTrack(tr.name, times, values, tr.getInterpolation()));
  }
  return new AnimationClip(`${clip.name}·loop`, end, tracks);
}
