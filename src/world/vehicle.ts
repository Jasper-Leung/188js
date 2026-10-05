/**
 * 载具与角色 —— 自行车 / 摩托车 / 滑板 / 徒步，以及站在（骑）上面的那个人。
 *
 * ## 四种状态
 *
 * | | 玩家 | 姿态动画 |
 * |---|---|---|
 * `foot` **默认** | 只有角色，三件载具停在路边 | 移动时 `walk` / `run`，**停住不播** |
 * `bike` | 角色跨在坐垫上（站位**从模型量**，不是写死的常数） | `骑自行车`，倍率随速度，车停即定格 |
 * `motorcycle` | **模型自带骑手**（人和车焊死），外加的角色要藏起来 | 无（模型是静态的） |
 * `skate` | 角色站在板上（双脚一前一后） | `run` 里**双脚张得最开的那一帧**·定格 |
 *
 * **默认是 `foot`**：这个游戏讲的是"一个人回到自己的家乡"，
 * 开头让玩家推着车走几步比一上来就骑更贴题，而且这样"没有车"这件事
 * 在界面上是看得见的——按 `E` 才有车，是玩家的选择而不是脚本给的。
 *
 * ## 自行车不是一个模型，是**一组要装配的枢轴**
 *
 * 这一版把 `bicycle.glb` 当成一台**车**来装，而不是当成一堆可以
 * 直接拧 `rotation` 的零件。原因有三件，每一件都对应一个用户报的现象：
 *
 * | 装了什么 | 不装的话 |
 * |---|---|
 * | 前后轮各一个**轮毂枢轴** | 只能直接拧零件节点——轮子恰好成立（几何体以原点为中心），但脚撑不成立 |
 * | **脚撑**铰在后轴，骑行折起 / 静止落地 | 脚撑永远竖在地上，或者永远收着（用户明确要求的行为） |
 * | **曲柄 + 踏板**按传动比转 | 人在上面踩踏板，而踏板一动不动 |
 * | 前端（车把 + 握把 + 挡泥板 + 前轮）一起**转向** | 轮子拐弯而车把直着走，车不像车 |
 *
 * 站位也从「写死的 1.05m」改成**两个实测值相减**：鞍面从模型量，
 * 骨盆高度从**动画**里量。详见 `assembleBike` 与 `update()` 的 bike 分支。
 * 结构图见 `BikeRig`。
 *
 * ## 滑板：姿势是从 `run` 里**量**出来的，不是手摆的
 *
 * 用户要求：站在板上时**保持跑步动画里双脚张得最开的那一帧**。
 * 所以做法是去 `run` 里找那一帧、把它定格成一条片段（`pose.ts`），
 * 而不是另配一段滑板动画——素材里没有。
 *
 * | 量（`survivor.glb` 的 `run`，1.25 s / 31 帧） | 峰值 | 峰值时刻 |
 * |---|---|---|
 * | 横向（X） | 0.0735 | 0.375 s —— **退化**，跑步时两脚各在自己那侧 |
 * | 水平面（XZ） | **0.4319** | **1.1667 s**（键 28）—— 一前一后张开 0.43 |
 * | 三维 | 0.4405 | 1.1675 s —— 与上一行同一帧，多出来的是腾空高度 |
 *
 * 判据取**水平面**（`stancePoseOf` 的注释里为什么横向退化写得更细）：
 * 0.4319 × 角色缩放 1.7534 = **0.757 m** 的前后开度，
 * 而板长约 1.31 m（`SKATE_SCALE` 1.35，模型的长 ≈ 高的 8 倍）——
 * 两脚一前一后落在板的中段，这就是要的站姿。
 *
 * ⚠ 定格的那一帧是**腾空期**：两脚都比站姿高，实测 0.0409 个模型单位
 *   （0.072m）。照原来写死的板面高度 0.12m 摆出去，人就浮在板上面踩空气，
 *   所以站高要减去这个落差（`update()` 的 skate 分支）。
 *
 * ## 摩托车：为什么它没有独立的骑手动画
 *
 * `motorcycle.glb` 是 Tripo 导出的静态模型：84 个 `tripo_part_N`、
 * **0 条动画、0 根骨头**（`tools/extra-models.mjs` 记了这件事）。
 * 骑手和车体焊在同一批零件里，动不了。
 * 所以这个模式下外加的 `char` 必须 `visible = false`——
 * 否则会出现两个骑手叠在一起：一个会摆腿的，一个焊在车上的。
 *
 * ## 缩放：**按各自的实测轮半径反推，一个都不写死**
 *
 * 换过三批模型，每次症状都不同，而**没有一次会报错**：
 *
 * | 批次 | 包围盒 | 曾经的缩放 | 症状 |
 * |---|---|---|---|
 * | `bike.glb` | 16762 × 37892 × **65534** | `WORLD.BIKE_SCALE = 0.012` | 写死成 1 → **车变成 65 公里宽，和角色一起消失** |
 * | `motorcyclemodel.glb` | 轮半径 0.0843 | 按轮半径反推 = 4.15 | 正常 |
 * | **现在**：`bicycle_clean.glb` / `motorcycle_rider.glb` | 轮半径 0.1947 / 0.1712 | 按轮半径反推 = **1.798 / 2.044** | 正常 |
 *
 * 用**轮半径**而不是总高来定尺度，是因为它与模型摆得正不正无关：
 * 总高会随模型自带的俯仰一起变，而偏航不影响竖直方向的尺寸。
 * 摩托车按 2.044 缩放之后是 **2.00 × 1.25 × 2.00 m**，与源项目
 * `shots/06-moto.png` 的 HUD 逐项相同——这是缩放对没对齐的反证。
 *
 * ## 朝向：两台车的偏航都是量出来的
 *
 * Tripo 导出时车头都没有对齐 three 的 **−Z**，而**偏的方向不一样**：
 *
 * | | 车头在 | 要补的偏航 | 怎么量的 |
 * |---|---|---|---|
 * | 自行车 | **−X** | `−90°` | 前轮节点平移 x = −0.3114、后轮 x = +0.2874 |
 * | 摩托车 | **+Z** | `180°` | 前轮节点平移 z = +0.344、后轮 z = −0.299 |
 *
 * ```
 * 绕 Y 转 θ 把 (x,0,z) 映到 (x·cosθ + z·sinθ, 0, −x·sinθ + z·cosθ)
 * three 的 rotation.y = θ 把方位角 α 变成 α − θ，所以车头方位 + 90° = 目标
 * ```
 *
 * ⚠ 量这些数的时候踩过一个坑，值得记下来：**glTF 矩阵是列主序**
 * （平移在 `m[12..14]`）。按行主序写点变换会把**整段平移丢掉**——
 * 包围盒的尺寸全对、只有中心全挤在原点，于是量出"两个前轮同心"，
 * 而真实轴距是 0.643。车轮之间的距离**完全由节点平移决定**，
 * 所以只看单个 mesh 的顶点是不算的。
 *
 * 实测 **200.302°**。这个数写死在下面而不是每次重算：
 * 重算要读 9 个零件的包围盒，而**它对同一个文件永远是同一个答案**，
 * 放运行时只是每次启动都白算一遍。
 *
 * ## 轮子按里程转
 *
 * 按时间转的话松开油门轮子还在空转，一眼假。停下就不转，和真实一致。
 *
 * ### 正负号是**推**出来的，不是试出来的
 *
 * 原来三个载具都写成负号，于是**轮子全是倒着转的**。
 * 不打滑要求接地点速度为零，即 `v_中心 + ω × r = 0`：
 *
 * | | 前进方向 | 自转轴 | 接地点 r | 结论 |
 * |---|---|---|---|---|
 * | 自行车 / 滑板 | −X | 本地 +Z（轮面在 XY 平面里） | (0, −R, 0) | ω = **+**v/R |
 * | 摩托车 | +Z | 本地 +X（轮面在 YZ 平面里） | (0, −R, 0) | ω = **+**v/R |
 *
 * 「倒着转」和「空转」第一眼很像，而**没有任何既有判据量正负号**——
 * 它们量的都是「转了多少」，不是「往哪转」。现在 `verify_bike_rig` 量正负号。
 */
import { Group, Object3D, Vector3, Quaternion, Box3, Matrix4, Mesh, AnimationMixer, AnimationClip, KeyframeTrack, InterpolateDiscrete, LoopRepeat, type AnimationAction } from 'three';
import { RIDE } from '../data/raw';
import { clamp, clamp01, damp } from '../core/math';
import { stancePoseOf, loopSeamOf, trimToSeam, footOrbitOf, type StancePose, type LoopSeam } from './pose';

export type RideMode = 'foot' | 'bike' | 'motorcycle' | 'skate';
export const RIDE_MODES: readonly RideMode[] = ['foot', 'bike', 'motorcycle', 'skate'];

/**
 * 起播位置要**跳过开头那一小段**。
 *
 * 动作片段的作者是从 bind pose 起手、再缓入到正式姿势的，
 * 所以 `idle` 的**第 0 帧就是张开双臂的 T 字**。而 `rebuild()` 之后
 * 到第一次 `mixer.update()` 之间只有一两帧（后台标签里 rAF 还会被节流），
 * 于是玩家看到的第一眼恰好停在这个 T 字上。
 *
 * 所以每条轨起播时都**往前挪一小段**，让第一帧落在已经成形的姿势上。
 * 挪的是**时间轴**而不是权重 —— 权重为 0 的姿势等于 bind pose，
 * 那正是要避开的。
 *
 * 取片段时长的 18%、上限 0.35s：足够越过起手的缓入，又不至于
 * 跳过待机动作的主要部分。片段比这还短时就整段跳过（`Math.min` 兜住）。
 */
function preroll(a: AnimationAction, clip: AnimationClip): void {
  a.time = Math.min(clip.duration * 0.18, 0.35);
}


/**
 * ## 根骨的名字：**不能靠正则猜，必须从骨架里问出来**
 *
 * ★ 这里踩过一个非常贵的坑，值得完整记下来。
 *
 * 原来判根骨的正则是 `/(^|:)hips$/i` —— 它要求名字**整段**是 `hips`
 * 或者以 `:hips` 结尾（Mixam 系的原始命名 `mixamorig:Hips` 正好命中）。
 * 而 **three 的 `GLTFLoader` 在建节点时会把名字清洗一遍**
 * （`PropertyBinding.sanitizeNodeName`），`:` 被**删掉**而不是替换：
 *
 * ```
 * GLB 里的节点名      mixamorig:Hips
 * three 里的 node.name mixamorigHips        ← 少了一个冒号
 * AnimationTrack.name mixamorigHips.position ← 轨道名用的是清洗后的名字
 * ```
 *
 * 于是 `/(^|:)hips$/` **一条都匹配不上**，`stripRootMotion()` 静悄悄地
 * 什么都没做。实测三段动画的根位移（`mixamorigHips.position` 的 z 跨度）：
 *
 * | 片段 | 时长 | 根位移 | 等效凭空多走的速度 |
 * |---|---|---|---|
 * | `run` | 1.25 s | z 0.599 → 3.510 = **2.911 m** | **+2.33 m/s** |
 * | `walk` | 2.333 s | z 0.072 → 1.562 = **1.490 m** | **+0.64 m/s** |
 * | `骑自行车` | 4.958 s | z 0.067 → 5.285 = **5.218 m** | **+1.05 m/s** |
 *
 * 症状与用户报的一字不差：**走路飞快、跑步分不出来、松手之后人往回弹一段**，
 * 骑上车时人也被动画拖在车后面。玩家的输入速度之外还叠着这一份。
 *
 * 所以这里**从骨架结构反查根骨**（`rootBoneName`）而不是猜名字：
 * 根骨 = 父链上没有别的骨的那一根；重名或多个顶骨时取子树最大的那根
 * （真正的根骨一定把整个骨架挂在下面）。
 * ★ 用 `node.name` 去匹配轨道前缀是安全的：清洗发生在建节点那一步，
 *   轨道名和 `node.name` 用的是**同一个**字符串。
 *
 * ## 为什么是「抹平成 0」而不是「减掉一条直线」
 *
 * 来源项目 `bike_ride` 试过直线抵消根斜坡，第九个真 bug 就是它：
 * 片段里 5.2m 的位移**不是匀速的**，直线穿不过那条曲线，
 * 差出来的部分留成骨盆每循环漂 6cm（肩跟着退 13cm，手臂越骑越够不着车把）。
 * 逐帧精确抵消能消掉漂移，但它要求运行时再维护一张与片段同源的关键帧表——
 * 本作用不到那个精度（这里不追求手部握把误差），而**抹平**是零漂移的。
 * 代价是丢掉了骨盆的前后与左右晃动（骑行的上下起伏在 **Y** 上，保留着）。
 */

/** 一根骨的本地坐标（与 `restPoseOf` 同一套结构）。 */
export type BonePose = { p: [number, number, number]; q: [number, number, number, number]; s: [number, number, number] };

function isBone(o: Object3D): boolean {
  return (o as unknown as { isBone?: boolean }).isBone === true;
}

/** 父链上还有没有别的骨。 */
function hasBoneAncestor(o: Object3D): boolean {
  let p = o.parent;
  while (p) {
    if (isBone(p)) return true;
    p = p.parent;
  }
  return false;
}

function subtreeSize(o: Object3D): number {
  let n = 0;
  o.traverse(() => n++);
  return n;
}

/**
 * 骨架的**根骨名**——根位移挂在它身上。
 *
 * 判据按可靠性排序：
 *   1. 顶骨（父链上没有别的骨）里名字像根骨的（`hips` / `pelvis` / `root`）
 *   2. 子树最大的顶骨（根骨一定把整个骨架挂在下面；`neutral_bone` 那种
 *      零子树的末端骨自然被排除）
 *   3. 什么都没有就返回 `''`（调用方据此跳过剥离，而不是抛错）
 *
 * **导出来是为了让回归能问**：这一族故障（根位移没被剥掉）的本质是
 * 「判据和实现认的是同一个错名字」，所以判据必须问**真代码算出来的那个名字**。
 */
export function rootBoneName(root: Object3D): string {
  const tops: Object3D[] = [];
  root.traverse((o) => {
    if (isBone(o) && !hasBoneAncestor(o)) tops.push(o);
  });
  if (!tops.length) return '';
  const named = tops.find((o) => /hips|pelvis|root/i.test(o.name));
  if (named) return named.name;
  let best = tops[0];
  let bestN = -1;
  for (const t of tops) {
    const n = subtreeSize(t);
    if (n > bestN) {
      bestN = n;
      best = t;
    }
  }
  return best.name;
}

/**
 * 片段里根骨的 `position` 轨道。**没有根骨名时退回按名字找**，
 * 宁可多找一条也不要漏——漏掉的后果是动画在拖着人走（见文件头）。
 */
export function rootTrackOf(clip: AnimationClip, rootName: string): KeyframeTrack | null {
  const suffix = '.position';
  let fallback: KeyframeTrack | null = null;
  for (const tr of clip.tracks) {
    if (!tr.name.endsWith(suffix)) continue;
    const node = tr.name.slice(0, -suffix.length);
    if (rootName && node === rootName) return tr;
    if (!fallback && /hips|pelvis/i.test(node)) fallback = tr;
  }
  return fallback;
}

/**
 * 根骨水平位移的**跨度**（米）与它折算出来的地面速度。
 *
 * 片段自带的位移速度就是「这段动画原本配的步速」：拿它去除以当前速度，
 * 就得到让脚不打滑的播放倍率（见 `cadenceScale`）。
 */
export function rootMotionOf(clip: AnimationClip, rootName: string): { span: number; spanX: number; spanZ: number; speed: number } {
  const tr = rootTrackOf(clip, rootName);
  if (!tr) return { span: 0, spanX: 0, spanZ: 0, speed: 0 };
  const v = tr.values;
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    if (v[i] < minx) minx = v[i];
    if (v[i] > maxx) maxx = v[i];
    if (v[i + 2] < minz) minz = v[i + 2];
    if (v[i + 2] > maxz) maxz = v[i + 2];
  }
  const spanX = maxx - minx;
  const spanZ = maxz - minz;
  return {
    spanX,
    spanZ,
    // 水平位移的合长度：跑步片段的骨盆还有真实的左右晃动，
    // 只取 z 会把步速算小。
    span: Math.hypot(spanX, spanZ),
    speed: clip.duration > 1e-6 ? Math.hypot(spanX, spanZ) / clip.duration : 0,
  };
}

/**
 * ## 去掉片段的**根位移**，让它在原地播
 *
 * `walk` / `run` / `骑自行车` 三段都带根位移（实测 1.49 / 2.91 / 5.22 m，
 * 见文件头那张表），直接播的后果是：角色的根节点被动画推着走，
 * 而**车是按物理走的**——于是动画把人往前拖、车把人往后拽。
 * 停下的那一刻两条轨权重归零、根节点弹回原位，
 * 玩家看到的就是**「停止走动的时候人就回来一段距离」**。
 *
 * **只清 X 与 Z，保留 Y**：Y 那一路是走路的上下起伏（bob），
 * 那个留着才有走的感觉；水平位移才是"人在往前走"，而那必须由车来负责。
 *
 * 改的是**轨道里的数值**，不是删轨道 —— 删掉的话 mixer 会把这一根
 * 整个权重让给 bind pose，于是又是 T 字。
 *
 * @param rootName `rootBoneName()` 的结果。**必须传真名字**：
 *   靠正则猜的那一版在这个项目的素材上一条都匹配不上（见文件头）。
 */
export function stripRootMotion(clip: AnimationClip, rootName: string): AnimationClip {
  const tr = rootTrackOf(clip, rootName);
  if (!tr) return clip;
  const v = tr.values.slice();
  for (let i = 0; i < v.length; i += 3) {
    v[i] = 0;
    v[i + 2] = 0;
  }
  const fixed = new KeyframeTrack(tr.name, tr.times.slice(), v, tr.getInterpolation());
  // **新建一条轨道而不是就地改**：就地改会把调用方传进来的那个 clip
  // 也改了，而它是 GLTFLoader 缓存里的同一份对象。
  const tracks = clip.tracks.map((t) => (t === tr ? fixed : t));
  return new AnimationClip(`${clip.name}·inplace`, clip.duration, tracks);
}

/**
 * ## 给 `idle` 补上它缺的骨骼（脚 / 分趾骨）
 *
 * 合片时新片段只覆盖它**自己有的那 65 根骨**（实测 `idle` 只有 195 条通道，
 * 而 `run` / `walk` / `骑自行车` 是 258 条 = 86 根），剩下 21 根——
 * 其中 20 根是分趾骨——**在 idle 里一条轨道都没有**。
 *
 * 没有轨道的那几根会一直停在场景图的静置值上。多数时候那没问题，
 * 但它们是"没人管的"：只要有任何一条别的轨短暂接管同一根骨，它们就会闪。
 *
 * 所以给它们各补一条**常量轨道**，值取自骨架的静置姿态。
 * 这不改任何观感（本来就是那个值），但从此 idle **每一根骨都有归属**，
 * 权重相加不足 1 时漏出来的 bind pose 也就没有脚可漏。
 *
 * `rest` 是静置姿态：`boneName → { p, q, s }`，由 `restPoseOf(char)` 量。
 */
export function bindMissingBones(clip: AnimationClip, rest: Map<string, BonePose>): AnimationClip {
  const have = new Set(clip.tracks.map((t) => t.name.split('.')[0]));
  const extra: KeyframeTrack[] = [];
  for (const [bone, r] of rest) {
    if (have.has(bone)) continue;
    const n = Math.max(2, Math.round(clip.duration * 30));
    const times = new Float32Array(n);
    for (let i = 0; i < n; i++) times[i] = (i / (n - 1)) * clip.duration;
    extra.push(new KeyframeTrack(`${bone}.position`, times, flat(r.p, n), InterpolateDiscrete));
    extra.push(new KeyframeTrack(`${bone}.quaternion`, times, flat(r.q, n), InterpolateDiscrete));
    extra.push(new KeyframeTrack(`${bone}.scale`, times, flat(r.s, n), InterpolateDiscrete));
  }
  if (!extra.length) return clip;
  return new AnimationClip(`${clip.name}·bound`, clip.duration, [...clip.tracks, ...extra]);
}

function flat(v: readonly number[], n: number): Float32Array {
  const out = new Float32Array(n * v.length);
  for (let i = 0; i < n; i++) out.set(v, i * v.length);
  return out;
}

/** 量一份骨架的静置姿态。只认带 `isBone` 的节点，也就是真正的骨。 */
export function restPoseOf(root: Object3D): Map<string, BonePose> {
  const m = new Map<string, BonePose>();
  root.traverse((o) => {
    if (!(o as unknown as { isBone?: boolean }).isBone) return;
    m.set(o.name, {
      p: [o.position.x, o.position.y, o.position.z],
      q: [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w],
      s: [o.scale.x, o.scale.y, o.scale.z],
    });
  });
  return m;
}

/**
 * 徒步时角色相对 ride 位的**横向**偏移（米）。
 *
 * 它是一个导出的常量而不是一个写在 `update()` 里的字面量 `0`，
 * 是为了让 `verify_avatar` 能对它提问：这个数一旦被人改回 2.6，
 * 判据立刻红，而不是等到某个玩家在竖屏上找不到自己。
 *
 * 为什么必须是 0，见 `update()` 里 foot 分支的注释（偏轴 39.1° vs 竖屏半视场 35.8°）。
 */
export const FOOT_LATERAL_OFFSET = 0;

/**
 * 人物模型正面朝 **+Z**，而本作的车头是 **−Z**（`ride.ts` 的
 * `_fwd = (−sin h, 0, −cos h)`，h=0 时指向 −Z）。差 180°。
 *
 * 依据：来源项目 `vehicle_switch` 里 `Bike.ts:427` 与 `Skate.ts:508`
 * 给角色传的 `yaw` 都是 **0**，而那台自行车的车头被摆成 +Z
 * （它的原始车头在 −X，要 +90° 才对上 +Z）。所以 yaw=0 时人面朝 +Z。
 *
 * **它导出来是为了让 `verify_facing` 能问**：这三个数
 * （人物 yaw、单车 yaw、摩托 yaw）必须合成同一个前进方向，
 * 而"合不合得上"在代码里是三个独立的 `rotation.y`，
 * 读不出来也量不到——只有把三者摆进同一个算式里问一句才行。
 */
export const CHAR_FACING_YAW = Math.PI;

/**
 * 三个模型各自的**车头方向**（模型本地空间）。
 *
 * 导出来是为了让 `verify_facing` 能问：三个 `rotation.y` 是三处各自独立的常数，
 * 代码里没有任何东西把它们联系起来，所以「人正着走、车却横着跑」这种故障
 * 不会让任何一条现有断言变红。
 *
 * | | 车头 | 依据 |
 * |---|---|---|
 * | 人物 | **+Z** | 查骨骼与动画得到：人物没有轮子，模型正面朝 +Z |
 * | 自行车 | **实测** | 逐顶点量「前后轮心连线」，见下面的表 |
 * | 摩托车 | **实测** | 同上 |
 *
 * ## ★ 车的车头是**量出来的连线**，不是「轮面在哪个平面里」推出来的
 *
 * 原来写的是 `bicycle: [-1,0,0]` / `motorcycle: [0,0,1]`，判据是
 * 「轮面在哪个平面里 → 自转轴是哪根轴 → 车头垂直于那根轴 → 只剩两个方向，
 * 再用轮子节点平移挑一个」（`MODEL_AXES` 那条链子）。
 *
 * ★ 那条链子**只用了包围盒**，而包围盒分不出「轮子平面在 XY 里」和
 *   「轮子平面在 XY 里、但整台车绕竖直轴又歪了 11°/27°」——
 *   后者的包围盒**完全一样**，结果却差一整个车头方向。
 *
 * 逐顶点量出来的真值（`GLTFLoader` 走游戏同一条解析路径，见 `measureDriveBasis`）：
 *
 * | | 旧假定 | 实测车头 | 差 |
 * |---|---|---|---|
 * | 自行车 | `-X` | **(-0.98270, 0, 0.18522)** | **10.67°** |
 * | 摩托车 | `+Z` | **(-0.44747, 0, 0.89430)** | **26.58°** |
 *
 * 差的这 26.58° 就是用户报的「摩托车车头没对齐行走方向」——
 * 偏航补 180° 之后车头落在 153.4°，而行进方向是 180°。
 * 自行车的 10.67° 同源：两个模型都是 Tripo 扫描件，导出时没对齐 three 的轴。
 * 换模型时这两个数**必须重量**，而 `verify_drive_basis` 会问运行时量出来的那个。
 */
export const MODEL_HEADS = {
  char: [0, 0, 1] as const,
  bicycle: [-0.982697, 0, 0.185222] as const,
  motorcycle: [-0.447474, 0, 0.894297] as const,
};

/**
 * 模型车头（本地空间）加上它自己的偏航，得到**世界前进方向**。
 *
 * three 的 `rotation.y = theta` 把 `(x, 0, z)` 映到
 * `(x*cos + z*sin, 0, -x*sin + z*cos)`，也就是**方位角 alpha 变成 alpha + theta**
 * （方位角 = `atan2(x, z)`，于是 +Z 是 0 度、+X 是 90 度）。
 *
 * ⚠ 文件头那段旧注释写的是「alpha 减 theta」，**方向写反了**。
 *   下面这个函数与运行时用的是同一套映射，所以判据与实现一起绿、一起红；
 *   但照着那句注释手推会得到相反的符号——而符号反了正是「车横着跑」那一族。
 *
 * 本作的车头约定是 **-Z**（`ride.ts` 的 `_fwd`），所以每个模型都该算成 (0, 0, -1)。
 */
export function facingDir(head: readonly number[], yaw: number): [number, number, number] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [head[0] * c + head[2] * s, 0, -head[0] * s + head[2] * c];
}

/**
 * 把某个车头方向转到 **-Z** 所需的偏航（弧度）。
 *
 * `facingDir(head, yawToTravel(head))` 恒等于 `(0, 0, -1)`，**按定义成立**。
 * 偏航常数由它算出来而不是手抄，正是为了消掉「抄错一位数」这一族静默故障：
 * `verify_facing` 那条 1e-6 的断言只有在两者同源时才可能一直绿。
 *
 * ⚠ 它只处理**纯偏航**。两个模型另外还各有一点点外倾（0.07° / 0.46°），
 *   偏航治不了，治它的是运行时的 `measureDriveBasis` 给出的完整基底四元数。
 */
function yawToTravel(head: readonly [number, number, number]): number {
  // wrap 到 (-π, π]：数学上 259.33° 与 -100.67° 是同一个旋转，
  // 但常数写在代码里、又被日志与判据逐字读出来，归一化一次省掉「哪个是真的」。
  const y = Math.PI - Math.atan2(head[0], head[2]);
  return y > Math.PI ? y - Math.PI * 2 : y <= -Math.PI ? y + Math.PI * 2 : y;
}

/**
 * 每种模式的运动参数。
 *
 * `foot` 的极速刻意比车低（6 m/s）：走路比骑车慢是常识，
 * 而 6 m/s 已经是小跑——徒步时给 15 m/s 会读作"车凭空没了，人在飞"。
 *
 * **自行车那三个数直接取自源项目 `RIDE`，一个字都没改**——
 * 改它等于改原作的手感。`verify_controls` 把这件事钉住了。
 *
 * 摩托车**比自行车快、也比自行车沉**：加速和减速都比自行车小一号
 * （车重大、惯量大），但极速更高。转向给得比自行车大，
 * 因为它的轴距长、转向机构本来就是按机动车设计的。
 * 三个数都刻意与自行车不同——`verify_controls` 会检查这一点，
 * 否则「切换载具」就只是换了个模型。
 */
export const MODE_TUNE: Record<
  RideMode,
  { maxSpeed: number; accel: number; decel: number; turn: number }
> = {
  bike: { maxSpeed: RIDE.MAX_SPEED, accel: RIDE.ACCEL, decel: RIDE.DECEL, turn: RIDE.TURN_SPEED },
  motorcycle: { maxSpeed: 24, accel: 7, decel: 9, turn: 2.3 },
  skate: { maxSpeed: 17, accel: 5.5, decel: 7, turn: 2.6 },
  foot: { maxSpeed: 6, accel: 4, decel: 9, turn: 2.2 },
};

/* ------------------------------------------------------------------ *
 * ## 行车基底：把「模型自己的轴」换算成「行驶的轴」
 * ------------------------------------------------------------------ *
 *
 * ### 这一族故障：整台车相对模型坐标轴歪了，于是两件事同时错
 *
 * 用户报的是「车轮乱滚」+「摩托车车头不对齐」。量下来是**同一个原因**：
 * 两个模型都是 Tripo 扫描件，导出时没对齐 three 的轴。
 *
 * | | 车头偏离模型轴 | 自转轴偏离模型轴 |
 * |---|---|---|
 * | `bicycle.glb` | **10.67°** | **10.67°** |
 * | `motorcycle.glb` | **26.58°** | **26.16°** |
 *
 * 原来那套「轮面在哪个平面里 → 自转轴是哪根轴」**只用了包围盒**，
 * 而包围盒分不出「轮面就在那儿」和「轮面就在那儿、但整台车又歪了 26°」。
 * 于是：
 *   · 车头偏航补了 180°（摩托）/ −90°（单车），**补的是名义值**，实际差 26.58° / 10.67°；
 *   · 轮子绕 `MODEL_AXES` 里那根**名义轴**自转，而真轴偏了 26.16° / 10.67°。
 *
 * ★ 绕歪轴自转的后果不是「转慢一点」，是**接地点在横向蹭**：
 *   轮子每转一圈，接地点画出来是一个**椭圆**而不是一个点，
 *   轮子会一边滚一边摆——这就是「乱滚」��。参考项目
 *   `motocycleriding` 管这叫「轮胎印迹从 7cm 糊到 10cm，转向也发飘」。
 *
 * ### 量法：逐顶点求协方差，**最小特征向量就是自转轴**
 *
 * 轮子是一块**薄板**，薄的那个方向就是车轴。用包围盒量不行（见上），
 * 用「节点位置」也不行（Tripo 把轮心烘进了几何体原点，节点平移只是零件摆放）。
 * 协方差的对称 3x3 用 Jacobi 迭代求特征值，几十次扫描就收敛，没有外部依赖。
 *
 * 轮心取「质心沿轴正交化」——沿轴方向的位置本来就定不出来（薄板沿轴没有特征尺寸）。
 *
 * ### 与两个参考项目同源，不是自创
 *
 * · `motocycleriding/src/model/BikeRig.ts`：同样的协方差 + `W.basis`，并明确写着
 *   「不能只做绕 Y 的偏航校正——那样车头能对正，但模型自带的 X 轴仍不是车身左右轴」。
 * · `bike_ride/src/bike.js`：`modelFwd = modelFront - modelRear`，`yawCorrection`
 *   就是这条连线的方位角。
 */

/**
 * 对称 3x3（行主序 9 个数）的特征值/特征向量，**按特征值升序**返回。
 *
 * ★ 「升序」是这个函数的**契约**，不是实现细节：
 *   调用方取 `eig[0].vec` 当自转轴，而 Jacobi 迭代结束后特征向量落在
 *   **哪一列**是不确定的。不排序的话 `eig[0]` 是个随机的特征向量——
 *   实测在合成夹具上取到的是 X 而不是 Z，于是「量不到行车基底」。
 */
function eigenSym3(m: readonly number[]): { val: number; vec: Vector3 }[] {
  const a = [
    [m[0], m[1], m[2]],
    [m[3], m[4], m[5]],
    [m[6], m[7], m[8]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 64; sweep++) {
    let off = 0;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) off += a[i][j] * a[i][j];
    if (off < 1e-26) break;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-20) continue;
        // 经典 Jacobi 旋转：theta 是对称 2x2 块的相位差
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return [0, 1, 2]
    .map((i) => ({ val: a[i][i], vec: new Vector3(v[0][i], v[1][i], v[2][i]).normalize() }))
    .sort((x, y) => x.val - y.val);
}

/** 一个车轮在**车模本地空间**里的实测轴心、自转轴与半径。 */
export interface WheelFrame {
  /** 轮心（车模本地单位） */
  centre: Vector3;
  /** 自转轴（单位向量，**符号任意**——调用方要自己定约定，见 `measureDriveBasis`） */
  axle: Vector3;
  /**
   * 轮半径（车模本地单位），由两个较大的特征值估：`R = 2√(λ均值)`。
   *
   * 实测误差约 2%（`bicycle.glb` 量到 0.197，真值 0.1946）。
   * 它只用来把「里程」换算成「转角」，2% 的半径误差就是 2% 的转速差，
   * 看不出来；而原来那个写死的 `0.023` 与真值 0.036 差 **57%**，
   * 那是看得出来的偏快。
   */
  radius: number;
}

/**
 * 逐顶点量一个车轮零件组的轴心与自转轴。找不到零件 / 没有顶点时返回 `null`。
 *
 * ⚠ 量的是**真实顶点**，不是 `geometry.boundingBox`：
 *   这份资产是 meshopt 量化的，GLB 里的 accessor min/max 不可信
 *   （实测每个零件的盒子都读成正方体，圆度恒为 1.000）。
 *
 * ## 轮心为什么取**包围盒中心**而不是顶点均值
 *
 * 均值对**对称**形体是对的，对**采样不均**的形体就偏：
 * `CylinderGeometry` 的顶点全落在「端面圆周 + 端面圆心」上，
 * 中间高度一个采样都没有，于是 24 段的圆柱均值落在 y = 0.1947
 * 而不是轴心 0.2——**偏 5mm**。轮心偏 5mm 的话轮子自转时会画出一个
 * 半径 5mm 的圆而不是一个点，看起来就是「轮子有点摆」。
 *
 * 包围盒中心没有这个问题：圆盘在垂直于轴的两个方向上都是对称的，
 * 盒子中心就是轴心。实测前后轮都能回到 0.1998 / 0.1997（互差 0.1mm）。
 *
 * 自转轴则**必须**用协方差（包围盒分不出「歪了多少」，见文件头）。
 */
export function measureWheel(root: Object3D, names: readonly string[]): WheelFrame | null {
  const acc: (WheelFrame | null)[] = [];
  root.traverse((o) => {
    if (names.includes(o.name)) acc.push(measureWheelNode(root, o));
  });
  const good = acc.filter((a): a is WheelFrame => a !== null);
  if (!good.length) return null;
  if (good.length > 1) {
    // ⚠ 多个零件同名时，**按名字遍历会把它们混成一个去量**。
    //   `skateboard.glb` 就是这样：8 个轮子网格只有 6 个名字，每个重复 4 次。
    //   调用方要「逐个量」时必须走 `measureWheelNode`（滑板轮子就是这么做的）。
    //   自行车与摩托车的零件名唯一（`tripo_part_N` 编号不重复），所以不受影响。
    console.warn(
      `[vehicle] measureWheel(${names.join(',')}) 匹配到 ${good.length} 个同名零件，` +
        '它们被当成了一个整体来量 —— 要逐个量请用 measureWheelNode',
    );
  }
  const ctr = new Vector3();
  let rad = 0;
  for (const a of good) {
    ctr.add(a.centre);
    rad = Math.max(rad, a.radius);
  }
  ctr.divideScalar(good.length);
  return { centre: ctr, axle: good[0].axle.clone(), radius: rad };
}

/**
 * 逐顶点量**某一个**车轮节点（不看名字，因此节点重名也安全）。
 *
 * 这是 `measureWheel` 的单节点版本；滑板的 8 个轮子网格只有 6 个名字，
 * 「逐个量」只能走这里。
 */
export function measureWheelNode(root: Object3D, node: Object3D): WheelFrame | null {
  root.updateMatrixWorld(true);
  const inv = new Matrix4().copy(root.matrixWorld).invert();
  const rel = new Matrix4().multiplyMatrices(inv, node.matrixWorld);
  const pos = (node as Mesh).geometry?.attributes?.position;
  if (!pos || pos.count < 12) return null; // 顶点太少，协方差没有意义
  const p = new Vector3();
  const mn = new Vector3(Infinity, Infinity, Infinity);
  const mx = new Vector3(-Infinity, -Infinity, -Infinity);
  const ctr = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(rel);
    if (i === 0) mx.copy(p);
    mn.min(p);
    mx.max(p);
    ctr.add(p);
  }
  ctr.divideScalar(pos.count);
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(rel).sub(ctr);
    cov[0] += p.x * p.x;
    cov[1] += p.x * p.y;
    cov[2] += p.x * p.z;
    cov[3] += p.x * p.y;
    cov[4] += p.y * p.y;
    cov[5] += p.y * p.z;
    cov[6] += p.x * p.z;
    cov[7] += p.y * p.z;
    cov[8] += p.z * p.z;
  }
  for (let i = 0; i < 9; i++) cov[i] /= pos.count;
  const eig = eigenSym3(cov);
  const axle = eig[0].vec;
  // 沿轴向的分量取**顶点均值**（采样不均时它才等于轴心，见文件头），
  // 面内两个分量取包围盒中心（圆盘对这两个方向都对称）。
  // ⚠ 少写 `+ bboxCentre·axle` 就是把轮心整体推歪 `bboxCentre·axle`：
  //   自行车前轮实测 13.6mm，摩托车 15mm —— 轮子自转时画出一个小圆而不是一个点。
  const bboxCentre = mn.clone().add(mx).multiplyScalar(0.5);
  const centre = bboxCentre.clone().addScaledVector(axle, ctr.dot(axle) - bboxCentre.dot(axle));
  return { centre, axle, radius: 2 * Math.sqrt(Math.max(0, (eig[1].val + eig[2].val) / 2)) };
}

/** 一台车的实测行车基底。 */
export interface DriveBasis {
  /** 车头（模型本地空间，水平单位向量）= 前轮心 → 后轮心 反向 */
  head: Vector3;
  /**
   * 自转轴（模型本地空间，单位向量），**统一取成指向车的左侧**。
   *
   * 符号不是随意的：不打滑要求 `v + ω × r = 0`，车头取 `head`、
   * 接地点 `r = (0, −R, 0)` 时解出 `ω = +v / R` **仅当**轴指向左侧。
   * 于是 `spin.rotation.x = +里程/半径` 对所有车型都是对的，代码里不必再判方向。
   */
  axle: Vector3;
  /** 前后轮心（模型本地单位） */
  front: Vector3;
  rear: Vector3;
  /** 轴距（模型本地单位；转向角公式要乘缩放才变成米） */
  wheelbase: number;
  /**
   * **模型空间 → 行驶空间**的旋转：把车头送到 −Z、横向送到 ±X、上送到 +Y。
   *
   * 完整四元数而不是一个偏航，因为两个模型除了偏航还各有一点点外倾
   * （自行车 0.07°、摩托 0.46°）。少了它，摩托的侧撑就会绕着一条偏了 26.58° 的
   * 「前后轴」滚——那不是侧倾，是侧倾加俯仰的混合。
   */
  quat: Quaternion;
}

/**
 * 量出一台车的行车基底。两个轮子任一个量不到就返回 `null`（调用方按「没装」处理）。
 *
 * ★ 输出的 `quat` 已经自检过：`quat * head === (0,0,−1)`、`quat * axle === (−1,0,0)`。
 *   `verify_drive_basis` 会拿一个**已知歪角**的合成模型来问这件事，
 *   所以判据量的是「能不能纠回来」，而不是「这个常数是不是这几个数」。
 */
export function measureDriveBasis(
  root: Object3D,
  frontNames: readonly string[],
  rearNames: readonly string[],
): DriveBasis | null {
  const f = measureWheel(root, frontNames);
  const r = measureWheel(root, rearNames);
  if (!f || !r) return null;
  const head = f.centre.clone().sub(r.centre).setY(0);
  if (head.lengthSq() < 1e-12) return null; // 两个轮子同心，量不出来
  head.normalize();
  const rear = head.clone().negate();
  // 前后两个轮子各自量一次，取平均：真实车辆它们是**一根轴**，平均比单取一个稳。
  //
  // ⚠ **必须先对齐符号再平均**：最小特征向量的**方向是任意的**
  //   （`eigenSym3` 只给出一条轴，不给哪头朝前），两个形状一样的轮子
  //   完全可能一个朝左、一个朝右，直接相加会**互相抵消成零向量**。
  //   实测就是这样：合成夹具上 `f.axle + r.axle` 长度趋近 0，
  //   于是「量不到行车基底」——一个只会在换模型后才发作的静默故障。
  const fa = f.axle.clone();
  const ra = r.axle.clone();
  if (fa.dot(ra) < 0) ra.negate();
  const axle = fa.add(ra);
  if (axle.lengthSq() < 1e-12) return null;
  axle.normalize();
  // 符号约定：指向左侧（`up × head`）
  const left = new Vector3(0, 1, 0).cross(head);
  if (axle.dot(left) < 0) axle.negate();
  // 横向正交化到「车尾」上，再取右；上 = 车尾 × 右（这样 right × up = rear，基底是右手的）
  const right = axle.clone().negate().addScaledVector(rear, axle.dot(rear)).normalize();
  const up = rear.clone().cross(right).normalize();
  // M 的**列**是「行驶三轴在模型空间里的表示」，所以模型→行驶是 M 的转置。
  // 三个数都取反号会得到同一个 R，所以 up 天然朝上，不需要再挑符号。
  const quat = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, up, rear).transpose());
  return {
    head,
    axle,
    front: f.centre,
    rear: r.centre,
    wheelbase: f.centre.distanceTo(r.centre),
    quat,
  };
}

/**
 * 把某个节点的**本地 +X** 转到给定的方向（该方向用 `space` 的局部坐标表示）。
 *
 * 这是参考项目 `motocycleriding` 的 `alignSpinAxis`，抄它的理由是它带**自检**：
 * 对齐之后本地 +X 必须真的落在目标方向上，差一点就 `console.warn`。
 * 少了这个节点，自转就会绕歪轴转——而画面上只是「轮子有点摆」，
 * 没有任何既有断言会红（见文件头那两张表）。
 *
 * ⚠ 只能对**不参与每帧动画**的节点调用：在它上面写 `rotation` 会把这次对齐整个冲掉。
 *   所以每个要自转的机构都是三层——定位 / 对齐（写一次）/ 自转（每帧）。
 */
function alignLocalX(node: Object3D, dirInSpace: Vector3, space: Object3D): void {
  // 三步，每一步都换到**同一个空间**里去，顺序不能反：
  //   ① `dirInSpace` 是**模型空间**（`measureDriveBasis` 量的就是那个），
  //      经 `space` 变成**世界**方向；
  //   ② 世界方向经**父节点的世界朝向**换算成**父空间**方向；
  //   ③ 取「本地 +X → 父空间方向」的最小旋转。
  //
  // ★ ② 少一步就是「轮子绕歪轴滚」，而它**不报错**：
  //   本作把行车基底挂在模型节点**自己**身上（不像参考项目那样单独一层
  //   `normalized`），所以从模型空间到父空间要经过 `space` 的世界朝向。
  //   参考项目的写法是 `父世界⁻¹ · 归一化层 · qModel`——
  //   那个 `归一化层` 在这里**就是 `space` 本身**，写成 `space` 的逆会差一整个基底。
  space.updateWorldMatrix(true, false);
  node.parent?.updateWorldMatrix(true, false);
  const want = dirInSpace.clone().normalize().transformDirection(space.matrixWorld);
  const qParent = new Quaternion();
  (node.parent ?? space).getWorldQuaternion(qParent);
  const target = want.clone().applyQuaternion(qParent.invert()).normalize();
  const from = new Vector3(1, 0, 0);
  const d = clamp(from.dot(target), -1, 1);
  const q = new Quaternion();
  if (d > 0.999999) q.identity();
  else if (d < -0.999999) q.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
  else q.setFromAxisAngle(new Vector3().crossVectors(from, target).normalize(), Math.acos(d));
  node.quaternion.copy(q);
  // 自检：本地 +X 转过去之后，在世界空间里必须真的落在目标方向上
  node.updateWorldMatrix(true, false);
  const got = new Vector3(1, 0, 0).transformDirection(node.matrixWorld);
  if (got.distanceTo(want) > 1e-3) {
    console.warn(
      `[vehicle] ${node.name || '(匿名)'} 自转轴对齐偏差 ` +
        `${((Math.acos(clamp(Math.abs(got.dot(want)), -1, 1)) * 180) / Math.PI).toFixed(2)}°` +
        ' —— 轮子会绕着歪轴滚',
    );
  }
}



/**
 * 按目标高度（米）反推缩放。
 *
 * 不能写死：模型是「归一化到 1 单位」的（滑板高 0.121、角色高 1.0），
 * 换一批模型高度就变了，写死的数字会在下次换模型时悄悄失配。
 *
 * 扫的是**真实顶点**，不是 `geometry.boundingBox`——
 * GLB 里的 accessor min/max 不可信（见 vegetation.ts 的 bottomOf 注释）。
 *
 * ## ★ 必须与「已经缩放过」无关 —— 否则第二次量到的是自己的产物
 *
 * `Box3.setFromObject()` 给的是**世界**盒子，而 `rebuild()` 会把量出来的
 * 缩放**写回同一个节点**。于是：
 *
 * ```
 * 第一次 rebuild：身高 0.998 → scale 1.753
 * 第二次 rebuild：盒子已经是 1.75m 高 → scale = 1.75 / 1.75 = 1.000
 * ```
 *
 * 实测 `survivor.glb` 就是这样：第一次 1.7534，第二次 **1.0000**——
 * **人矮了 43%**。而触发第二次只需要按一下 `E`（切载具），
 * 或者摩托车模型晚到（`world.ts` 里它是 `Promise.all` 之外单独 `attach` 的）。
 *
 * 症状安静到没有工具会报错：车还在、人还在，只是**小了一号**，
 * 于是又被读成「人不在自行车上」——和站位算错是同一个画面。
 *
 * 做法：量之前**先把 root 自己的 scale 摘掉**，量完再放回去。
 * 摘自己的（而不是除以一个系数）是因为祖先上也可能有缩放，
 * 除法只对「父链全是 1」成立，而那不是这个函数该假设的事。
 */
export function autoScaleToHeight(root: Object3D, targetH: number): number {
  const keep = root.scale.clone();
  root.scale.setScalar(1);
  let box: Box3;
  try {
    box = new Box3().setFromObject(root);
  } finally {
    root.scale.copy(keep);
  }
  const h = box.max.y - box.min.y;
  if (!Number.isFinite(h) || h < 1e-6) return 1;
  return targetH / h;
}

/** 角色的目标身高（米）。成年男性约 1.75。 */
const CHAR_HEIGHT = 1.75;
/**
 * 坐垫高度（米）。**只剩兜底用**：模型没量到鞍面时才用。
 *
 * 它原来是站位的**唯一**来源，而那个 1.05 是个**谁也没量过的数**：
 * 既不是这台车的鞍面高度（实测鞍面在 0.974m），也不是动画里骨盆的高度
 * （0.882m）——两个真实值都不等于 1.05，于是人跨在车上方/方，
 * 症状就是用户报的「人不在自行车上」。
 * 现在站位由 `saddleTopOf` + `pelvisHeightOf` 两个**实测值**算出来。
 */
const SADDLE_H = 1.05;

/**
 * 上一代摩托（`motorcyclemodel.glb`，84 个零件）的量测记录，保留在这里做对照：
 *
 * ```
 * 总包围盒   x 0.5702  y 0.9746  z 0.9816
 * 前轮盒     x 0.1687  y 0.3291  z 0.2906   → 半径 0.0843
 * 后轮盒     x 0.1569  y 0.3183  z 0.2844   → 半径 0.0785
 * ```
 *
 * 注意前轮半径 0.0843 —— 那一代的轮子只有现在这台的一半大，
 * 所以同一句「前轮半径 0.35m」在两台车上给出的缩放差一倍
 * （4.15 vs 2.04）。**这就是为什么缩放必须跟着模型量，不能写死。**
 *
 * 现在的三个模型见下面那张对照表。
 */

/**
 * ## 三台车的标定 —— 全部是**量出来的**，量的是**真实顶点**
 *
 * 模型换成了 `modelbone/vehicle_switch` 那一套（自行车 / 人车合一摩托 /
 * 带 9 段动画的人物）。量法：走一遍 GLB 的 node transform 树取世界包围盒。
 *
 * ### ⚠ 量的时候踩过的两个坑，都属于"静默出错"那一族
 *
 * 1. **glTF 矩阵是列主序**（平移在 `m[12..14]`）。按行主序写点变换
 *    （`m[0]*x + m[1]*y + m[2]*z + m[3]`）会**把整段平移丢掉**——
 *    包围盒的**尺寸全对**，只有**中心全挤在原点**，于是量出"两个前轮同心"。
 * 2. 只看**单个 mesh** 的顶点不算，要乘上它那个节点的平移。车轮之间的距离
 *    完全由节点平移决定。
 *
 * 两条合起来的后果是：量出来的摩托车只有 0.98 高、0.67 长，
 * 而源项目同一台车的 HUD 明明写着「整车 2.00×1.25×2.00 m」。
 * **是那份 HUD 把它校回来的**——下面每一个数都能和它对上。
 *
 * ### 三个模型的对照
 *
 * | | 原始包围盒 | 轮半径 | 缩放 | 缩放后 | 车头 |
 * |---|---|---|---|---|---|
 * | 自行车 | 0.980 × 0.659 × 0.375 | 0.1947 | 1.798 | 长 1.76m / 高 1.18m | **−X** |
 * | 摩托车 | 0.611 × 0.980 × 0.978 | 0.1712 | 2.044 | **2.00 × 1.25 × 2.00 m** | **+Z** |
 * | 人物 | 0.922 × 1.000 × 0.353 | — | 1.751 | 高 1.75m | +Z（面朝前） |
 *
 * 摩托那一行和源项目 `shots/06-moto.png` 的 HUD 逐项相同
 * （整车 2.00×1.25×2.00 m、轴距 1.411 m、缩放 2.0440、整高 2.00 m）。
 */

/** 自行车的真实前轮半径（米）。26~28 寸轮连胎约 0.35m。 */
export const BIKE_WHEEL_R = 0.35;
/** 摩托车的真实前轮半径（米）。探险车型前轮连胎约 0.35m。 */
export const MOTO_WHEEL_R = 0.35;

/**
 * 自行车：前轮 / 后轮零件名。
 *
 * 用**节点名**而不是下标——GLB 里的节点顺序一变就全错。
 * 判据（圆度 = 两轴差 / 较大者）：
 *   · `tripo_part_0`  s = 0.095 × 0.389 × 0.369 → 圆度 **5%**  r = 0.1947  ← 前轮
 *   · `tripo_part_2`  s = 0.089 × 0.389 × 0.364 → 圆度 **6%**  r = 0.1944  ← 后轮
 *   · `tripo_part_1`  圆度 27% —— 车架那个大三角，**不是轮子**
 *
 * 27% 与 5% 之间的差距足够大，所以卡 12% 就刚好把车架挡在外面
 * （阈值放到 35% 会把车架和挡泥板一起放进来，而它们的"半径"还比真轮子大，
 * 取 max 就把车架当成了后轮）。
 *
 * 节点平移：前 x = −0.3114，后 x = +0.2874 → **轴距 0.6102**，
 * 按 1.798 缩放后是 **1.097m**（真实自行车轴距 1.05~1.10m）。
 */
const BIKE_FRONT_WHEEL = ['tripo_part_0'];
const BIKE_REAR_WHEELS = ['tripo_part_2'];

/**
 * 鞍面零件名（`tripo_part_7`）。
 *
 * 骑手要坐的不是一个写死的 `SADDLE_H`，而是**从模型上量出来的鞍面**：
 * 实测它的盒子是 x [0.0619, 0.2344] / y [0.4654, 0.5441] / z [−0.0923, 0.0343]
 * ——一块 7.9cm 厚的楔形，坐在**顶面**（`box.max.y = 0.544`）而不是中心。
 * 取中心的话人矮 4cm，看起来像陷进坐垫里。
 *
 * 依据：来源项目 `bike_ride/src/bike.js` 的 `SADDLE_TOP` 也是
 * 「`tripo_part_7` 最高那批顶点的重心」，把它的 x/z 换算回车模空间
 * 是 (0.138, 0.543, 0.008)，与这里量到的 y = 0.544 对得上。
 */
const BIKE_SADDLE = ['tripo_part_7'];

/**
 * 后轮支架（脚撑）零件名：`tripo_part_11`。
 *
 * 依据同源：来源项目 `bike_ride/src/bike.js` 的 `PART.rearStand`。
 * 它也是**全车唯一碰到地面的零件**（实测 y 从 0 到 0.1966，
 * 而后轴在 y = 0.1997 —— 顶端正好铰在后轴上），所以身份没有第二种解释。
 *
 * 逐层截面（8 层，每层的世界包围盒）说明它是一块**板**而不是一根杆：
 * 每一层 x 只有 3~6cm 厚，z 却有 11~17cm 宽，底端比顶端更宽。
 * 折起来之后它正好躺在后轮平面里、往后伸出轮子——和真车的脚撑
 * 收起时贴着后下叉的样子一致。
 */
const BIKE_REAR_STAND = ['tripo_part_11'];

/**
 * 脚撑**折起**的角度（弧度），绕**横向轴**（车模本地 Z）。
 *
 * ★ 100° 不是审美数字，是来源项目在**同一份扫描件**上实测/沿用的值
 *   （`bike_ride/src/bike.js` 的 `STAND_FOLD_ANGLE`，枢轴同样落在后轴上）。
 *
 * ## 符号是怎么定的（两边换算过，不是照抄）
 *
 * 参考项目的车模空间被 `yawCorrection` 预先转成「+Z 为前、+X 为左」，
 * 它的 `standMount.quaternion` 把挂载点的**本地 X** 对齐到
 * `Y × forward`（也就是车的左侧），折角加在 `standFold.rotation.x` 上。
 * 本作不做那次预旋转（车头在 −X、左右也没翻过），于是：
 *
 * ```
 * 参考车模空间 → 本作车模空间：model.x = −frame.z，model.z = frame.x
 *   参考的「左」= frame +X = model +Z      ← 折轴就是本地的 +Z
 *   同一根轴、同一角度 ⇒ 参考的 rotation.x = 本作的 rotation.z
 * ```
 *
 * 所以正的 `rotation.z` 就是折起方向：绕 +Z 转 +100° 把脚撑的**脚**
 * 从正下方 (−Y) 甩到正后方 (+X) 略偏上（+10°），也就是收起贴住后下叉。
 */
export const STAND_FOLD_ANGLE = (100 * Math.PI) / 180;

/** 低于这个速度（米/秒）就算「停着」，脚撑放下来垂直于地面。固步长 1/60。 */
const STAND_DEPLOY_SPEED = 0.25;

/**
 * 脚撑当前该有的角度（弧度）。**停着 = 放下来（0），动起来 = 折起（100°）**。
 *
 * 提成纯函数是为了让回归能问「骑起来时脚撑确实是收起的」——
 * 这一族故障（脚撑永远竖着、或者永远收起）在画面上很好认，
 * 却没有**任何**现有断言会红。
 */
export function standFoldAt(speed: number): number {
  return Math.abs(speed) > STAND_DEPLOY_SPEED ? STAND_FOLD_ANGLE : 0;
}

/** 曲柄轴零件名。轴心位置直接取它的节点位置，不写死。 */
const BIKE_CRANK_AXLE = 'crankAxle';
/** 曲柄 + 踏板：随传动比转的那一组。 */
const BIKE_CRANK_PARTS = ['crankArmL', 'crankArmR', 'pedalL', 'pedalR', 'crankAxle', 'crankShell'];
/**
 * 跟车把一起转向的前端零件。
 *
 * 取自来源项目 `bike_ride/src/bike.js` 的 `PART`：车把 + 两只握把 + 前挡泥板。
 * 三者必须和前轮在**同一个刚体**里——真车上它们就是前叉那一坨，
 * 只转前轮的话画面上会看到轮子拐弯而车把直着走。
 */
const BIKE_STEER_PARTS = ['tripo_part_8', 'tripo_part_23', 'tripo_part_25', 'tripo_part_5'];

/**
 * 车把最大偏转（弧度）。
 *
 * **不是审美数字**：来源项目在同一份扫描件上扫过转向角与「拳→车把」的接触误差，
 * 11.5°（0.20 rad）是手臂还握得住的上限，17.2° 就脱手了（README「转向角是实测上限」）。
 * 超过它，手会离开车把。
 */
export const BIKE_STEER_MAX = 0.2;

/**
 * 链传动比（飞轮圈数 / 链盘圈数）。
 *
 * 曲柄转一圈，后轮转 `BIKE_GEAR` 圈——**轮子必须比曲柄转得快**，
 * 链盘永远比飞轮大。取 50T/18T ≈ 2.78 的常见值，取整到 2.6。
 *
 * ⚠ 这条系数治的是「轮子比踏板慢」：来源项目 `bike_ride` 缺了它时，
 *   每踩一圈车只前进 0.53m 而轮子只转 0.435 圈——**链子在用一个 2.3:1 的
 *   减速把轮子往回驱**，这个机构在物理上不存在。
 */
export const BIKE_GEAR_RATIO = 2.6;

/**
 * 骨盆落在鞍面**上方**多少（占身高比例）与**后方**多少（米）。
 *
 * 骨盆高度不是「坐垫高度 + 一点」：它由**动画自己的骨盆高度**决定
 * （`pelvisHeightOf`，实测骑手骨盆在角色本地 0.504 处 = 身高的 50.4%），
 * 坐垫只提供 x/z 与一个参考面。这两个数只管**微调**：
 *
 * · 上方 +0.6% 身高：来源项目实测胯心比鞍面高 **5.7mm**（他们的角色 1.007 高，
 *   换算到本作 1.75m 就是 1.05cm）。取 0 表示胯心正好压进坐垫，看着像陷进去。
 * · 后方 4.5cm：同上，实测 2.6cm（他们单位）→ 4.5cm（本作米制）。
 *   骑手重心必须在坐垫**后面一点**，正压在上面会像站在车顶上。
 */
const PELVIS_ABOVE_SADDLE = 0.006;
const PELVIS_BEHIND_SADDLE = 0.045;

/** 装配节点的名字前缀。切载具时按它清掉上一轮留下的空节点。 */
const RIG = 'rig:';

/**
 * ## ★ 行车基底**必须按模型缓存**，理由和 `BIKE_RIGS` 是同一条、但更致命
 *
 * 轮子、曲柄、脚撑在第一次装配时就被 `attach` 进了 rig，
 * 于是它们的**节点变换里从此带着自转角、曲柄角、转向角**。
 * 而 `measureDriveBasis` 读的就是「零件相对 root 的局部变换」。
 * 所以**第二次调用它量到的不是模型的原始姿态，而是上一次骑过之后的姿态**。
 *
 * 实测（连按 5 次 E，每骑 2 秒）：
 *
 * | 第几次 | 量到的车头方位 | 量到的车轴 y 分量 |
 * |---|---|---|
 * | 1（真值） | −79.33° | 0.0016 |
 * | 2 | **−107.65°** | **0.509** |
 * | 3 | −85.72° | **0.871** |
 * | 4 | −79.02° | **0.981** |
 * | 5 | −71.22° | 0.809 |
 *
 * 车头每按一次 E 就漂一次（用户报「每次按 E 位置都会变化一次」），
 * 而车轴一路歪到**接近竖直**——轮子绕一条竖直的轴转，
 * 画面上就是「滚得像球，不始终沿着一个方向」。
 *
 * ★ 偏航和车轴**同时**漂，所以「车头歪」与「轮子横滚」是**同一个原因**。
 *   我第一轮只把 rig 做了缓存、没把基底做缓存，于是第一次正常、
 *   之后越来越歪——而所有判据都只在**刚 attach、还没骑**的状态下问过一次。
 *
 * 键用模型对象（`WeakMap`）：模型换了自然重算、模型被丢弃时记录跟着回收。
 */
const BIKE_BASIS = new WeakMap<Object3D, DriveBasis | null>();
const MOTO_BASIS = new WeakMap<Object3D, DriveBasis | null>();

/**
 * 摩托车的转向 / 自转枢轴，**按模型缓存**（与 `BIKE_RIGS` 同一套理由）。
 *
 * 判据必须落在这里而不是 `this.motoSteer`：`rebuild()` 会把实例字段清成 `null`，
 * 判据跟着一起被清掉，于是「已建过」永远不成立，每次按 E 都重建一轮枢轴。
 */
const MOTO_RIGS = new WeakMap<Object3D, { steer: Group; spins: { axis: Group; spin: Group }[] }>();

/** 取自行车的行车基底；**只在第一次真正测量**，之后一直返回同一份。 */
function bikeBasisOf(bike: Object3D): DriveBasis | null {
  if (!BIKE_BASIS.has(bike)) BIKE_BASIS.set(bike, measureDriveBasis(bike, BIKE_FRONT_WHEEL, BIKE_REAR_WHEELS));
  return BIKE_BASIS.get(bike) ?? null;
}

/** 取摩托车的行车基底；同上。 */
function motoBasisOf(moto: Object3D): DriveBasis | null {
  if (!MOTO_BASIS.has(moto)) {
    MOTO_BASIS.set(moto, measureDriveBasis(moto, MOTORCYCLE_FRONT_WHEELS, MOTORCYCLE_REAR_WHEELS));
  }
  return MOTO_BASIS.get(moto) ?? null;
}

/**
 * 每台自行车的装配**只建一次**。
 *
 * 键是车模本身（`WeakMap`），所以模型换了 key 就自然重建、不用手动失效，
 * 而模型被丢弃时这条记录也跟着回收。
 * 为什么必须缓存而不是每次重建，见 `assembleBike` 的注释：
 * 枢轴一旦被移除，**挂在里面的零件会跟着脱离整车**。
 */
const BIKE_RIGS = new WeakMap<Object3D, BikeRig>();

/**
 * 骨盆在角色**本地**空间的高度（模型单位）。
 *
 * 取根骨 `position` 轨道 y 的均值——**不是最大值、不是第一帧**：
 * 骨盆本来就要随踩踏起伏，用最大值会让人整体偏高半个起伏。
 *
 * 导出是为了让回归能问「骑手到底坐多高」：站位算错时，
 * 画面上是「人浮在车上面 / 陷进车架里」，而没有任何其它断言会红。
 */
export function pelvisHeightOf(clip: AnimationClip, rootName: string): number {
  const tr = rootTrackOf(clip, rootName);
  if (!tr) return 0;
  const v = tr.values;
  let sum = 0;
  const n = Math.floor(v.length / 3);
  for (let i = 0; i < n; i++) sum += v[i * 3 + 1];
  return n ? sum / n : 0;
}

export interface PreparedRideClip {
  /** 真正拿去播的片段：已剥水平根位移、已按循环接缝裁短。 */
  clip: AnimationClip;
  /**
   * 接缝的量数。`null` = 量不到双脚/根骨，或**一圈都没踩满**——
   * 这时 `clip` 原样返回（只是剥了根位移），**不裁**：
   * 裁一个量不出接缝的片段，等于把循环剪成一段残缺的踩踏。
   */
  seam: LoopSeam | null;
  /** 片段自带的步速（m/s），在**原始**片段上量。 */
  cadence: number;
  /** 骑手骨盆高度（模型单位），在**原始**片段上量。 */
  pelvisY: number;
  /**
   * **动画自己**的曲柄角速度（弧度 / 片段秒）：`2π × turns / time`。
   *
   * 它是「脚在这条片段里踩得多快」，**与地面速度无关**——
   * 而物理曲柄的转速是 `速度 / (轮半径 × 传动比)`。两者本来毫无关系，
   * 差着 3.15 倍，于是脚绕着踏板以三倍速空转（`pedalCadence` 处理这件事）。
   *
   * 量不到接缝时是 0，调用方据此退回按步速推的旧行为。
   */
  pedalRate: number;
  /**
   * 骑行片段的「脚圈中心」，**角色本地、模型单位**（见 `footOrbitOf`）。
   *
   * 自行车摆位靠它：脚该踩在**踏板**上，而踏板绕曲柄轴心转，
   * 所以「脚圈中心 = 曲柄轴心」就是骑手该对上的那个点。
   *
   * `null` = 量不到（骨架里没有左右踝）⇒ 摆位退回旧的「骨盆钉鞍面」。
   */
  footOrbit: Vector3 | null;
}

/**
 * 骑行片段的预处理。**导出来是为了让回归能问**：它跑的是运行时真正在播的那条路，
 * 而「接缝到底裁在哪」这件事在代码里看不出来也量不到——只有把这一步单独提出来，
 * 判据才能对着**真代码算出来的那个时刻**提问，而不是对着某个写死的常数。
 *
 * 四步，顺序不能换：
 *
 * 1. **量步速与骨盆高**（都在**原始**片段上）。
 *    剥完根位移水平分量就归零了，再量步速恒为 0，
 *    于是 `cadenceScale` 除以 0 → 播放倍率失效，动画变成「原地播」。
 * 2. `stripRootMotion` —— 让人在原地播，走的距离由车负责。
 * 3. `loopSeamOf` —— 在**剥过**的片段上量接缝。
 *    与在原始片段上量等价（接缝度量本来就是根骨相对的，父节点平移不改变子骨的相对位置），
 *    但「量的是真正在播的那份」这件事可查。滑板姿势也是这个理由放在 `fix('run')` 之后的。
 * 4. `trimToSeam` —— 裁到接缝上，让循环首尾接得上。
 *
 * ⚠ 裁剪**不改变步速**：实测 4.958s 段量到 1.061 m/s，裁到 1.688s 仍是
 *   1.055 m/s（差 0.6%），因为根位移在时间上本来就是均匀的。
 *   所以第 1 步在原始片段上量的那个数可以放心用。
 */
export function prepareRideClip(
  char: Object3D,
  clip: AnimationClip,
  rootName: string,
): PreparedRideClip {
  const cadence = rootMotionOf(clip, rootName).speed;
  const pelvisY = pelvisHeightOf(clip, rootName);
  const inplace = stripRootMotion(clip, rootName);
  const seam = loopSeamOf(char, inplace, rootName);
  const cut = seam ? trimToSeam(inplace, seam) : inplace;
  return {
    clip: cut,
    seam,
    cadence,
    pelvisY,
    // 接缝就在「踩满一圈」那一帧上，所以 turns/time 就是片段每秒钟的曲柄转速。
    pedalRate: seam && seam.time > 1e-6 ? (2 * Math.PI * seam.turns) / seam.time : 0,
    // ★ 量的是**裁完之后**真正在播的那条：脚圈中心会随裁剪点移动
    //   （接缝落在 1 圈处，而整条片段是 3.417 圈，两者的中点轨迹不同）。
    footOrbit: footOrbitOf(char, cut),
  };
}

/**
 * 鞍面在**车模本地**空间的位置：坐垫零件**最高那 5% 顶点**的质心。
 *
 * 为什么不是包围盒中心：实测 `tripo_part_7` 是 x [0.062, 0.234] /
 * y [0.465, 0.544] / z [−0.092, 0.034] 的一块 7.9cm 厚的**楔形**，
 * 中心比顶面低 4cm。坐垫要坐在**顶面**上。
 *
 * 为什么是「最高 5% 的顶点」而不是 `box.max.y`：`max.y` 是一个点的极值，
 * 座垫的坐骨尖会把它顶高几毫米，而骑手胯心是一块**面**。
 * 来源项目 `bike_ride/src/bike.js` 的 `SADDLE_TOP` 就是这么量的。
 *
 * 顶点用 `applyMatrix4` 逐点变换（不是只搬中心），因为零件节点自带缩放
 * （实测每个零件节点 `scale = 0.1946`）。
 */
export function saddleTopOf(root: Object3D, names: readonly string[]): Vector3 | null {
  const box = localUnion(root, names);
  if (box.isEmpty()) return null;
  const thr = box.min.y + (box.max.y - box.min.y) * 0.95;
  root.updateMatrixWorld(true);
  const inv = new Matrix4().copy(root.matrixWorld).invert();
  const rel = new Matrix4();
  const acc = new Vector3();
  const p = new Vector3();
  let n = 0;
  root.traverse((o) => {
    if (!names.includes(o.name)) return;
    const g = (o as Mesh).geometry;
    if (!g) return;
    const pos = g.attributes.position;
    if (!pos) return;
    rel.multiplyMatrices(inv, o.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(rel);
      if (p.y < thr) continue;
      acc.add(p);
      n++;
    }
  });
  return n ? acc.divideScalar(n) : null;
}

export interface BikeRig {
  frontSteer: Group;
  /** 前轮轴心（同时是 `frontAxis` 的父节点） */
  frontHub: Group;
  rearHub: Group;
  /** 脚撑铰点（后轴处） */
  standFold: Group;
  crank: Group;
  /**
   * 三层自转枢轴，每层只干一件事。
   *
   * `spin` 是每帧写 `rotation.x` 的那一层；`axis` 是一次性的轴对齐
   * （本地 +X → 实测车轴），**绝不能在上面写 `rotation`**，否则对齐被整个冲掉。
   * 拆成三层是为了让「轴对齐」与「自转角度」互不覆盖——
   * 这正是参考项目 `bike_ride/src/bike.js` 注释里点名的那个坑：
   * 「在已经带固定朝向的节点上赋 `rotation.y`，会把那个朝向整个替换掉」。
   */
  spins: { axis: Group; spin: Group }[];
  /** 脚撑的自转层（绕实测车轴折起） */
  standSpin: Group;
  /** 曲柄的自转层（绕实测车轴转） */
  crankSpin: Group;
  /** 两条曲柄臂（挂在 `crankSpin` 下，随它转） */
  arms: Object3D[];
  /** 踏板：挂在 `crank` 下但**不挂 `crankSpin`**，靠手动重算轨道绕圈（平台保持水平） */
  pedals: { node: Object3D; orbit: Vector3 }[];
  /** 鞍面（车模本地单位） */
  seat: Vector3 | null;
  /** 轴距（**米**）。转向角公式 `δ = atan(ω·L / v)` 里 L 要用米。 */
  wheelbaseM: number;
  /** 脚撑当前角度（弧度），静止时 damping 到 0 */
  standAngle: number;
}

/**
 * 动画的**播放倍率**：让脚不打滑、让走和跑真的分开。
 *
 * ## 为什么需要它
 *
 * 根位移被剥离之后，动画在原地播，而**地面位移由玩家决定**。
 * 于是出现一个老问题：地面 6 m/s 而腿按 1× 播（`walk` 片段自带的步速
 * 只有 **0.64 m/s**），脚就在地上**滑行**——反过来慢速时腿又倒腾得飞快。
 * 这也正是用户说的「行走和跑步不能区分」：
 * 两条片段的权重是按速度混的，但**腿的快慢和速度无关**，所以看起来一样。
 *
 * 做法是 `倍率 = 当前速度 ÷ 该片段自带的步速`：
 *
 * | 片段 | 实测自带步速 |
 * |---|---|
 * | `walk` | 0.64 m/s |
 * | `run` | 2.33 m/s |
 * | `骑自行车` | 1.05 m/s |
 *
 * 上限 `CADENCE_MAX` 2.4：再快腿就是一片糊，而 6 m/s 本来已经是冲刺。
 * 下限 0：车停住时骑行动画**完全停住**（踏板不空转，脚撑同时放下来）。
 */
const CADENCE_MAX = 2.4;

/**
 * 由**速度**推出播放倍率。**给回归量**：踩不踩得准只能从倍率上看。
 *
 * `natural <= 0`（量不到根位移、比如手工造的 clip）时返回 1，
 * 也就是「保持原速」——而不是除以 0 得到 Infinity。
 */
export function cadenceScale(speed: number, natural: number): number {
  // 停住 ⇒ 一律 0。**先判速度、再判步速**，顺序不能换：
  // 骑行轨的权重恒为 1（不像 walk/run 会随速度淡出），所以车停着时
  // 它是唯一还在动的东西——倍率 1 就读作「人站在原地空踩踏板」。
  if (Math.abs(speed) < 1e-3) return 0;
  // 量不到步速（手工造的 clip、根骨轨道不在）⇒ 保持原速，而不是除以 0。
  if (!(natural > 1e-3)) return 1;
  return Math.min(Math.abs(speed) / natural, CADENCE_MAX);
}

/**
 * 骑行动画的播放倍率上限。
 *
 * 3.0 不是随手取的：它让脚的转速落在 **105 RPM**（实测 `骑自行车`
 * 一秒 0.585 圈 × 3.0），也就是**原来** `CADENCE_MAX = 2.4` 换算出来的
 * 99 RPM 附近。原来那个上限管的是同一件事（别让腿糊成一片），
 * 换个推导方式之后不该顺手把它放宽。
 */
export const PEDAL_CADENCE_MAX = 3;

/**
 * 骑行动画的播放倍率：**由物理曲柄的转速反推**，而不是由步速。
 *
 * ## 为什么骑行不能走 `cadenceScale`
 *
 * `cadenceScale` 是给**腿在地面上的动画**用的：倍率 = 速度 ÷ 片段自带步速，
 * 目标是脚不打滑。骑行没有「地面」——**脚踩在踏板上**，而踏板是**车的一部分**，
 * 它的转速已经被 `updateBikeRig` 钉死了：
 *
 * ```
 * 曲柄角 = 里程 / 轮半径 / 传动比   ⇒   角速度 = 速度 / (0.35 × 2.6) = 2.925 × 速度
 * ```
 *
 * 也就是说曲柄每转一圈车要走 **5.72m**。而动画里的脚自带一个
 * 与地面无关的转速（实测 3.723 rad/片段秒）。原来两条各走各的，
 * 播放倍率是 `cadenceScale`，**先撞上 2.4 的上限**——于是倍率与速度基本脱钩：
 *
 * | 速度 | 老倍率 | 物理曲柄 | 老：脚/曲柄 | 新：脚/曲柄 |
 * |---|---|---|---|---|
 * | 2 m/s | 1.885 | 0.350 圈/s | **3.19×**（脚在抡） | 0.97 |
 * | 5 m/s | 2.400 | 0.875 圈/s | **1.63×** | 0.99 |
 * | 8 m/s | 2.400 | 1.399 圈/s | 1.02× | 0.98 |
 * | 12 m/s | 2.400 | 2.099 圈/s | 0.68×（脚跟不上） | 0.83 ★ |
 * | 15 m/s | 2.400 | 2.623 圈/s | **0.54×**（脚跟不上） | 0.68 ★ |
 *
 * 「老」那一列是实测世界空间里脚绕自己那个圈转了几圈、再除以曲柄转了几圈。
 * ★ 标记的是**故意**落后的：见下面的上限。
 *
 * 症状是**脚和踏板各踩各的**：低速时脚以三倍速绕着踏板空转，高速时脚又跟不上踏板，
 * 而中间只有 8 m/s 附近一个速度是碰巧对的。而 `verify_ride` / `verify_bike_rig`
 * 全部绿：车在走、轮子不打滑、曲柄 = 轮角 / 2.6 全对——
 * 这一族故障的根在**两条独立的时钟**上，现有判据一条都量不到它。
 *
 * ## 做法：让动画的转速**追**曲柄
 *
 * ```
 * 倍率 = 曲柄角速度 ÷ 动画自带的曲柄角速度
 * ```
 *
 * 改完两边同速，**相位差恒定**——脚不再乱抡，而是稳定地跟着踏板一起转。
 * 踩踏节奏交给了传动比，而这本来就是**物理上唯一正确**的那个：
 * 8 m/s 时 2.36 倍（82 RPM），15 m/s 时被上限压到 3.0（105 RPM）。
 *
 * ⚠ 上限以上（≈8.5 m/s 以上）腿会比曲柄慢，这是**故意的**：
 *   30fps 的低配机上 105 RPM 已经是每帧 14°，再快腿就是一片糊。
 *   本作的目标机型就是低配（见 `core/capability`）。
 *
 * @param pedalRate `prepareRideClip` 量出来的动画自带曲柄角速度。
 *   给 0（量不到接缝）时返回 0 —— 调用方据此退回 `cadenceScale`。
 */
export function pedalCadence(speed: number, pedalRate: number): number {
  // 停住 ⇒ 0。与 cadenceScale 同一个理由：车停着时脚该定住，而不是原地空踩。
  if (Math.abs(speed) < 1e-3) return 0;
  if (!(pedalRate > 1e-6)) return 0;
  const crank = Math.abs(speed) / (BIKE_WHEEL_R * BIKE_GEAR_RATIO);
  return Math.min(PEDAL_CADENCE_MAX, crank / pedalRate);
}

/**
 * 车把偏转（弧度）——**真实自行车运动学，不是拍脑袋的角速度**
 *
 * ```
 * δ = atan( ω · L / v )
 * ```
 *
 * ω 是航向变化率（rad/s）、L 是轴距（米）、v 是地面速度。
 * 于是**转弯半径只由转向角决定、与速度无关**：快了就是同一条弧扫得更快，
 * 真车就是这样。
 *
 * 用**航向变化率**而不是「转向输入」：航向的变化**就是**转向输入乘速度
 * （`ride.ts` 的 `heading += −horiz · turn · dt · turnFactor`），
 * 所以这个量已经把「打方向」和「按多快」两件事都算进去了。
 * 静止时给 0：车没动，把打到底没有意义，而真车停着也不会把车把拧到底。
 */
export function bikeSteerTarget(yawRate: number, speed: number, wheelbaseM: number): number {
  return steerFromYawRate(yawRate, speed, wheelbaseM, BIKE_STEER_MAX);
}

/**
 * ## ★ 前端偏转只由**航向变化率**决定 —— 直行必须是 0
 *
 * ```
 * δ = atan( ω · L / v )
 * ```
 *
 * ω 是航向变化率（rad/s）、L 是轴距（米）、v 是地面速度。
 * 于是**转弯半径只由偏转角决定、与速度无关**：快了就是同一条弧扫得更快，
 * 真车就是这样。
 *
 * 用**航向变化率**而不是「转向输入」：航向的变化**就是**转向输入乘速度
 * （`ride.ts` 的 `heading += −horiz · turn · dt · turnFactor`），
 * 所以这个量已经把「打方向」和「按多快」两件事都算进去了。
 * 速度趋零时给 0：车没动，把打到底没有意义，而真车停着也不会把车把拧到底。
 *
 * ### 摩托车为什么原来是「看速度」——那是个纯 bug
 *
 * 原来的 `steerAngleFor(speed) = STEER_MAX · v / (v + 6)`，理由写的是
 * 「真实的把随速度回正（高速时前轮只走很小的角度）」。
 * 那个说法本身没错（高速时**允许**的转角确实更大），但它**只有速度**一个输入，
 * 于是**玩家完全不按方向时它也非零**：
 *
 * | 速度 | 直行时的车把角 |
 * |---|---|
 * | 3 m/s | 8.67° |
 * | 8 m/s | 14.86° |
 * | 15 m/s | 18.57° |
 * | 24 m/s | **20.80°** |
 *
 * ★ 这个 20.8° 之所以现在才被看见，是因为它一直被**另一个错误盖着**：
 *   摩托车车头本身就偏 26.58°（偏航补的是名义 180°），方向与这 20.8° 相反，
 *   两者部分抵消。把车头纠准之后，20.8° 全部暴露 ——
 *   **车头对齐了，车却恒定往右偏**，而前轮被拖着横蹭，
 *   画面上就是「轮子滚得像球，不始终沿着一个方向」。
 *
 * 这也是这一族 bug 为什么难抓：改好一处，另一处就显形，
 * 而两边各自的断言都还绿着（速度、朝向、离地全都正常）。
 *
 * @param maxAngle 该车型的机械极限（自行车 11.5°，摩托车 26°）
 */
export function steerFromYawRate(
  yawRate: number,
  speed: number,
  wheelbaseM: number,
  maxAngle: number,
): number {
  const v = Math.abs(speed);
  if (v < 0.3 || !(wheelbaseM > 1e-3) || !Number.isFinite(yawRate)) return 0;
  return clamp(Math.atan((yawRate * wheelbaseM) / v), -maxAngle, maxAngle);
}

/**
 * 车头对齐 −Z 所需的绕 Y 偏航（弧度）。本作的车头是 −Z
 * （`ride.ts` 的 `_fwd = (−sin h, 0, −cos h)`，h=0 时指向 −Z）。
 *
 * ## ★ 它们由 `MODEL_HEADS` **算出来**，不是手抄的
 *
 * 原来这两个数是 `−90°` / `180°`，也就是「自行车车头在 −X、摩托车在 +Z」推出来的。
 * 而那两条车头本身是用**包围盒**判的（轮面在哪个平面里 → 轴是哪根 → 车头只剩两个方向）。
 * 逐顶点量出来，两个模型都**相对模型轴歪着**：
 *
 * | | 旧偏航 | 实测车头方位 | 新偏航 | 原来差 |
 * |---|---|---|---|---|
 * | 自行车 | −100.67° | −79.33° | **−100.67°** | **10.67°** |
 * | 摩托车 | 206.58° | −26.58° | **−153.42°** | **26.58°** |
 *
 * 摩托车那 26.58° 就是用户报的「车头没对齐行走方向」。
 *
 * ⚠ 这两个数**只用于「面向」判据与日志**。运行时真正摆车的是
 *   `measureDriveBasis()` 给出的**完整四元数**，它比纯偏航多治了外倾
 *   （自行车 0.07°、摩托 0.46°）。所以别指望改这两个数能修好画面——
 *   要改就去重量那个模型。
 */
export const BICYCLE_YAW = yawToTravel(MODEL_HEADS.bicycle);
export const MOTORCYCLE_YAW = yawToTravel(MODEL_HEADS.motorcycle);

/** 把模型缩放到米制：按**前轮**实测半径反推。 */
function scaleByFrontWheel(root: Object3D, names: readonly string[], targetR: number): number {
  const box = localUnion(root, names);
  if (!box.isEmpty()) {
    const h = box.max.y - box.min.y;
    if (Number.isFinite(h) && h > 1e-6) return targetR / (h / 2);
  }
  return 1;
}

/** 自行车缩放。找不到轮子时退回按总高（0.66 单位 → 约 1.09m），不会静默出错。 */
export function bicycleScale(root: Object3D): number {
  const s = scaleByFrontWheel(root, BIKE_FRONT_WHEEL, BIKE_WHEEL_R);
  if (s !== 1) return s;
  const all = localUnion(root, null);
  const h = all.max.y - all.min.y;
  return Number.isFinite(h) && h > 1e-6 ? 1.09 / h : 1;
}

/** 摩托车缩放。实测 0.35 / (0.342/2) = **2.044**，与源项目标定一致。 */
export function motorcycleScale(root: Object3D): number {
  const s = scaleByFrontWheel(root, MOTORCYCLE_FRONT_WHEELS, MOTO_WHEEL_R);
  if (s !== 1) return s;
  const all = localUnion(root, null);
  const h = all.max.y - all.min.y;
  return Number.isFinite(h) && h > 1e-6 ? 2.0 / h : 1;
}

/**
 * 摩托车的前后轮零件名。
 *
 * ⚠ 这一组**换过模型就必须重量**：`vehicle_switch/src/vehicles/motoParts.ts`
 * 那张分组表是从**另一个项目**（`motocycleriding`）继承的，
 * 而这台 `motorcycle_rider.glb` 的零件编号**对不上它**
 * ——实测 `tripo_part_0` 与 `tripo_part_1` 的中心只差 0.024，
 * 而轮距应是 0.643。于是 `unionParts` 找不到零件 → 返回空盒 →
 * 缩放走"按总高"兜底 → **摩托车要么缩成一个点要么大得离谱**。
 * 这就是「缩放比例不一样导致摩托车看不见」的确切机制。
 *
 * 现在的判据是量出来的：
 *   · 前轮 `tripo_part_0`  s = 0.192 × **0.342** × 0.290 → 半径 0.1712
 *     节点平移 z = **+0.344**（最靠前）
 *   · 后轮 `tripo_part_1`  s = 0.171 × 0.324 × 0.283 → 半径 0.1619
 *     节点平移 z = **−0.299** → 轴距 0.643 × 2.044 = **1.31m**
 */
const MOTORCYCLE_FRONT_WHEELS = ['tripo_part_0'];
/** 后轮 + 轮毂附件（沿用源项目分组表里 1 / 35 / 43 / 65 的语义） */
const MOTORCYCLE_REAR_WHEELS = ['tripo_part_1'];
/** 留在车体上、跟着前轮转向一起偏的零件（挡泥板 / 前叉 / 车头罩） */
const MOTORCYCLE_STEER = [
  'tripo_part_10', 'tripo_part_54', 'tripo_part_57',
  'tripo_part_59', 'tripo_part_62', 'tripo_part_63', 'tripo_part_68',
];

/**
 * 停放姿态：模型自带的纵向倾角（绕前后轴，单位弧度），由前后轮中心的高度差量出来。
 *
 * 「摩托车自带一个倾角」就是它。实测前轮中心 y=0.179、后轮 y=0.162、
 * 轴距 0.643 → **1.5°**（车头略高于车尾）。
 *
 * 用轮子量而不是量包围盒：包围盒的高度会随骑手姿势变化
 * （压车时人是往内侧倒的），而两个轮子的相对高度只跟车身纵向姿态有关。
 *
 * **这个数只在静止时生效**：停着的摩托车是斜着停的，骑起来要立直。
 * 见 `update()` 里按速度切的那一段。
 */
export function motorcycleBuiltInPitch(root: Object3D): number {
  const front = localUnion(root, MOTORCYCLE_FRONT_WHEELS);
  const rear = localUnion(root, MOTORCYCLE_REAR_WHEELS);
  if (front.isEmpty() || rear.isEmpty()) return 0;
  const fy = (front.min.y + front.max.y) / 2;
  const ry = (rear.min.y + rear.max.y) / 2;
  const fz = (front.min.z + front.max.z) / 2;
  const rz = (rear.min.z + rear.max.z) / 2;
  const dz = fz - rz;
  if (!Number.isFinite(dz) || Math.abs(dz) < 1e-6) return 0;
  return Math.atan2(fy - ry, dz);
}

/**
 * ## 摩托车的停放倾角：**左右侧倾**，绕自己的前后轴
 *
 * 停着的摩托车是靠侧撑斜着的（向一边侧过去），**不是前后栽下去**。
 * 所以它是**绕前后轴的滚转（roll）**，不是绕左右轴的俯仰（pitch）——
 * 这两者的区别不是角度大小，是**转轴**：
 *
 *   · 俯仰绕左右轴 ⇒ **车头会往下扎**，而"车头要时刻指向前方"
 *   · 滚转绕前后轴 ⇒ 车头方向**一点不变**，只是人往一边斜
 *
 * ## ★ 倾角现在挂在**基底之外**的槽节点上，符号跟着换了
 *
 * 原来写在 `moto.rotation.z` 上，并靠 `rotation.order = 'YXZ'` 让它绕
 * 「模型自己的前后轴」滚。**那个前提已经不成立了**：实测这台车的
 * 前后轴在方位 −26.58° 上，而模型本地 Z 与它只差 **26.58°**——
 * 绕它滚得到的是「侧倾 + 俯仰」的混合，不是侧倾。
 *
 * 现在倾角挂在 `motoSlot`（`moto` 的**父节点**，见 `rebuild`）：
 * 它的本地 +Z 就是真正的、水平的**前后轴**。
 *
 * | | 绕哪根轴 | 正角倒向 |
 * |---|---|---|
 * | 旧（`moto.rotation.z`，模型 Z） | 偏 26.58° 的假前后轴 | 模型 +X = 车的**左**（负角） |
 * | 新（`motoSlot.rotation.z`，行驶 +Z） | 真正的前后轴 | **左**（正角） |
 *
 * 绕 +Z 转 θ 把上向量 (0,1,0) 映到 (−sinθ, cosθ, 0)，正角往 −X 倒，
 * 而行驶基底里 +X 是**右**（`ride.ts` 的 `_right`），所以正角 = 往左倒。
 * 侧撑在**左边**，于是正的 `MOTO_PARK_LEAN` 才是对的。
 *
 * **只在静止时出现**：骑起来必须是立直的，而且**轮子的自转轴必须保持水平**——
 * 轮子只在移动时转，那时倾角恰好是 0，所以「轴平行于水平面」是**结构性成立**的，
 * 不需要额外补偿。真要补偿就得让轮子反向转 −倾角，
 * 而那会让停着的车轮子歪着（视觉上比不补偿更糟）。
 */
const MOTO_PARK_LEAN = 0.2; // 弧度 ≈ 11.5°，一辆探险车靠侧撑的常见角度
/** 低于这个速度就算「停着」（米/秒）。固步长 1/60，0.15 ≈ 9 帧的余量。 */
const MOTO_PARK_SPEED = 0.15;

/**
 * 摩托车当前的**左右倾角**（弧度，绕前后轴）。停着 = 侧撑角度，骑起来 = 0。
 *
 * 提成纯函数是为了让 `verify_facing` 能问「骑起来时倾角确实是 0」——
 * 因为**轮子只在移动时转，而倾角也只在静止时非零**，
 * 这两件事叠起来「自转轴平行于水平面」才是结构性成立的。
 * 一旦有人让倾角在移动时也非零，轮子就会转成一个椭圆。
 */
export function motoLeanAt(speed: number): number {
  return Math.abs(speed) < MOTO_PARK_SPEED ? MOTO_PARK_LEAN : 0;
}

/**
 * 两个模型**轮子自转轴**的方向（模型本地空间，实测）。
 *
 * ## ★ 这一段原来是整个「车轮乱滚」的根
 *
 * 原来写的是「自行车 = 本地 Z、摩托车 = 本地 X」，判据是
 * 「轮面在哪个平面里 → 薄的那根轴就是自转轴」。**判据没错，输入错了**：
 * 包围盒只告诉你「哪根轴最薄」，没告诉你「整台车相对模型轴歪了多少」。
 *
 * 逐顶点实测（`measureWheel` 求协方差的最小特征向量）：
 *
 * | | 旧假定 | 实测自转轴 | 与名义轴夹角 |
 * |---|---|---|---|
 * | 自行车 | (0,0,1) | **(0.18512, 0.00157, 0.98272)** | **10.67°** |
 * | 摩托车 | (1,0,0) | **(0.89755, -0.00558, 0.44087)** | **26.16°** |
 *
 * 绕着偏 26° 的轴自转，接地点画出来是**椭圆**：轮子一边滚一边横向蹭，
 * 胎印从 7cm 糊到 10cm。`motocycleriding/src/model/BikeRig.ts` 把它写成
 * 「否则轮子绕着歪轴转：接地点会左右蹭，轮胎印迹从 7 cm 糊到 10 cm，转向也发飘」
 * ——**同一个机制**。
 *
 * 这两个数**只给判据与日志读**；运行时用的是 `measureDriveBasis().axle`，
 * 它的符号统一成「指向左侧」，于是自转恒为 `+里程/半径`。
 */
export const MODEL_AXES = {
  /** 自行车：轮面在 XY 平面里，名义轴是本地 Z，实测偏 10.67° */
  bicycle: [0.18511715, 0.00157277, 0.9827152] as const,
  /** 摩托车：轮面在 YZ 平面里，名义轴是本地 X，实测偏 26.16° */
  motorcycle: [0.8975512, -0.00557638, 0.44087497] as const,
};

export interface VehicleModels {
  bike: Object3D | null;
  motorcycle: Object3D | null;
  skate: Object3D | null;
  /** 角色根节点 */
  char: Object3D | null;
  clips: {
    run?: AnimationClip;
    walk?: AnimationClip;
    ride?: AnimationClip;
    /** 站定时播的待机。**缺了它停下来就是 bind pose**（张开双臂） */
    idle?: AnimationClip;
  };
}

/**
 * 若干零件在 **`root` 本地空间**的并集包围盒。`names === null` = 整模型。
 * 找不到任何一个就返回空盒。
 *
 * ## 为什么不能用 `Box3.setFromObject()`
 *
 * 那是**世界空间**的盒子，而它的两个用法都把它当本地坐标用：
 *
 *   · `pivot.position = frontBox 的中心` —— pivot 是 `root` 的子节点，
 *     本地空间。喂世界坐标进去，枢轴就落在别处，
 *     **车把一转就把前轮甩出去**（"按住 W 前轮分离"就是它）。
 *   · `scale = 目标轮半径 / (盒子高度 / 2)` —— 世界盒子里**已经含了
 *     `root.scale`**，而 `rebuild()` 里 `group.clear()` 之后那个 scale 还在，
 *     于是**第二次切换**量到的是缩放过一遍的盒子、返回 1，车缩成 56%。
 *     第一条尤其阴：它只在第二次及以后发作，而第一次切换是对的。
 *
 * 做法：取零件几何体的局部包围盒，施加「零件相对 root」的矩阵。
 * 用 `applyMatrix4` 逐角点变换，所以零件自带旋转也是对的
 * （只把中心 `worldToLocal` 一下会在带旋转的件上算错尺寸）。
 */
export function localUnion(root: Object3D, names: readonly string[] | null): Box3 {
  const box = new Box3();
  root.updateMatrixWorld(true);
  const inv = new Matrix4().copy(root.matrixWorld).invert();
  const rel = new Matrix4();
  let n = 0;
  // `names === null` = 整模型（兜底用：找不到轮子时量总高）
  root.traverse((o) => {
    if (names) {
      if (!names.includes(o.name)) return;
    } else if (o === root) {
      return;
    }
    const g = (o as Mesh).geometry;
    if (!g) return;
    if (!g.boundingBox) g.computeBoundingBox();
    if (!g.boundingBox) return;
    rel.multiplyMatrices(inv, o.matrixWorld);
    box.union(g.boundingBox.clone().applyMatrix4(rel));
    n++;
  });
  return n ? box : new Box3();
}




/**
 * 曾经在这里有一个 `PARKED_OFFSET = 2.6`（"载具停下时停在路边的偏移"）。
 * 它被去掉了，理由记在 `update()` 里 foot 分支的注释上——一句话版本：
 * **它挂错了模式**。挂在 `foot` 上，而 foot 是默认且全程在用的模式，
 * 于是默认机位下人被推到偏轴 39.1°，竖屏（横半视场 35.8°）直接出画。
 *
 * 留着这段说明是因为这个数还会被人想起来：它本身不是错的，
 * 错的是它回答的问题（"停放时车停哪儿"）和它挂的地方（"走路时人在哪儿"）。
 */

export class Vehicle {
  readonly group = new Group();
  private mixer: AnimationMixer | null = null;
  private wheels: Object3D[] = [];
  /** 摩托车轮子绕**模型自身 X 轴**转（与滑板的本地 Z 不同，见 `collectWheels`） */
  /** 摩托车前轮组的转向枢轴 */
  private motoSteer: Object3D | null = null;
  /**
   * 摩托车前后轮的自转层（`axis` 层带一次性写死的轴对齐，**不写 rotation**）。
   * 与自行车 `BikeRig.spins` 同一套骨架，见 `alignLocalX`。
   */
  private motoSpins: { axis: Group; spin: Group }[] = [];
  /**
   * 摩托车侧撑倾角的载体，**必须在行车基底之外**。
   *
   * 它是 `moto` 的父节点，所以它的本地 +Z 就是真正的（水平的）前后轴。
   * 倾角写在 `moto` 上不行：three 的 `rotation` 与 `quaternion` 互为镜像，
   * 往 `moto` 写 `rotation` 会把行车基底整个冲掉；而倾角留在 `moto` 里面的话，
   * 它绕的又是模型自己的 Z——偏了 26.58°，那不是侧倾是侧倾加俯仰。
   */
  private motoSlot: Group | null = null;
  /** 摩托车轮子半径（米），按里程换算转角用 */
  private motoWheelR = 0.35;
  /** 摩托车轴距（**米**）。转向角公式 `d = atan(w * L / v)` 里 L 要用米。 */
  private motoWheelbaseM = 1.45;
  /** 滑板轮半径（米），由 `collectWheels` 逐节点实测。0 = 还没量到。 */
  private skateWheelR = 0;
  /**
   * 两台车**实测出来的**行车基底。`null` = 量不到（退回名义偏航）。
   *
   * 存下来是为了给回归问：代码里没有任何东西把「量到的车头」和
   * 「实际摆出来的朝向」联系起来，而这一族故障（车头歪、轮子绕歪轴滚）
   * 全部属于「实现与判据各认各的数」。`verify_drive_basis` 直接读这两个字段。
   */
  private bikeBasis: DriveBasis | null = null;
  private motoBasis: DriveBasis | null = null;
  private models: VehicleModels = { bike: null, motorcycle: null, skate: null, char: null, clips: {} };
  private mode: RideMode = 'foot';
  /** 第一视角时为 true，角色整个不渲染（由 `Ride.render()` 每帧推进来）。 */
  private selfHidden = false;
  private wheelSpin = 0;
  /** 当前速度，用来在 run / walk 之间混合 */
  private speed = 0;
  private heading = 0;
  /** 角色的动画轨：徒步时用它按速度混合 walk / run */
  private walkAction: AnimationAction | null = null;
  private runAction: AnimationAction | null = null;
  /**
   * 站定时播的待机轨。两条移动轨权重归零时它接上去，
   * 而没有它的话角色会露出 bind pose（张开双臂）。
   * 模型里没有 `idle` 片段时它是 null，退回 bind pose——老的 3 段模型走的就是这条。
   */
  private idleAction: AnimationAction | null = null;
  /**
   * 骑自行车的循环轨。它与 `walkAction` / `runAction` 是**互斥**的一路：
   * 上车就一直播（车停着时人还跨在车上，本来就该保持那个姿势），
   * 而**播放倍率由速度决定**——车停住时倍率 0，人就定在踩踏的姿势上，
   * 配上放下来的脚撑，读作「支着车站着」，而不是「停在原地空踩」。
   */
  private rideAction: AnimationAction | null = null;
  /**
   * 滑板姿势轨。定格的、权重 1、`paused`——与另外三条都互斥。
   * 它存在的意义是「滑板模式下人不该再动」这件事有一个**可量的对象**：
   * 姿势一旦被别的轨稀释，画面上是「人有点抖」，而没有任何别的断言会红。
   */
  private stanceAction: AnimationAction | null = null;
  private blend: { walk: number; run: number } = { walk: 0, run: 0 };
  /** 骨架根骨名。根位移挂在它身上，剥不干净就是「人自己在往前漂」。 */
  private rootBone = '';
  /**
   * 每段移动片段**原本配的步速**（m/s），由 `rootMotionOf` 在原始片段上量出。
   * 播放倍率 = 当前速度 ÷ 它（见 `cadenceScale`）。
   */
  private clipCadence: { run: number; walk: number; ride: number } = { run: 0, walk: 0, ride: 0 };
  /** 骑手骨盆在角色本地空间的高度（模型单位），骑行站位用。 */
  private pelvisH = 0;
  /**
   * 滑板姿势：`run` 里双脚张得最开的那一帧，已定格（见 `stancePoseOf`）。
   * `null` = 量不到（骨架里没有那两根踝骨），滑板模式退回播 `idle`。
   */
  private stance: StancePose | null = null;
  /**
   * 骑行片段的**循环接缝**：脚踩满一圈之后离首帧最近的那一帧。
   * `null` = 量不到，循环照旧在片段末尾接回（脚会每圈跳一下）。
   *
   * 存下来是为了让回归能问「循环到底裁在哪」：裁剪这件事在画面上
   * 只有「脚抖不抖」，而抖不抖是**接缝的差距**，不是一个能看出来的数。
   */
  rideSeam: LoopSeam | null = null;
  /**
   * 动画**自己**的曲柄角速度（弧度 / 片段秒），由 `prepareRideClip` 量出。
   * 0 = 量不到，播放倍率退回按步速推（`applyCadence`）。
   */
  private ridePedalRate = 0;
  /**
   * 骑行片段的「脚圈中心」，**角色本地、模型单位**（`footOrbitOf` 量出）。
   * 自行车摆位靠它把脚圈中心对准曲柄轴心；`null` 时退回鞍面摆法。
   */
  private rideFootOrbit: Vector3 | null = null;
  /** 自行车的装配节点。`null` = 没装（不是 bike 模式，或模型没到）。 */
  private rig: BikeRig | null = null;
  /** 车把当前偏转（弧度），由航向变化率推出来（见 `bikeSteerTarget`）。 */
  private steerAngle = 0;
  private lastHeading = 0;

  constructor() {
    this.group.name = 'vehicle';
  }

  get id(): RideMode {
    return this.mode;
  }

  /** 能不能进这个模式。没模型就不给进——而不是切过去发现是空的。 */
  canEnter(m: RideMode): boolean {
    if (m === 'foot') return true;
    if (m === 'bike') return this.models.bike !== null;
    if (m === 'motorcycle') return this.models.motorcycle !== null;
    return this.models.skate !== null;
  }

  attach(m: Partial<VehicleModels>): void {
    this.models = { ...this.models, ...m };
    this.prepareClips();
    this.rebuild();
  }

  /**
   * 片段预处理，**只在挂上新的 clips 时跑一次**。
   *
   * 三件事，顺序不能换：
   *   1. **先量后改**：`rootMotionOf` 必须在**原始**片段上量——
   *      剥离之后水平位移已经没了，再量就是 0，而步速正是靠它算出来的
   *      （`cadenceScale`）。反过来写的后果是播放倍率恒等于 1，
   *      也就是「动画在原地播」这条修好了，而「走和跑分不出来」那条没有。
   *   2. `stripRootMotion` —— 去掉水平根位移，让动画在原地播。
   *   3. `bindMissingBones` —— 给 `idle` 补上它缺的骨（含脚 / 分趾骨）。
   *
   * 骑行片段多一步：`prepareRideClip` 会把**循环接缝**也一并裁掉
   * （见它的注释）。它走的是自己的分支而不是塞进 `fix`，
   * 原因是它要多问一句「脚踩满一圈没有」——`walk` / `run` 没有踏板，
   * 同一个判据套上去量的是骨盆的左右晃，不是步频。
   *
   * ⚠ 别把它放进 `rebuild()`：那是每次切载具都会调的，
   *   而它每次都 new 一批轨道，反复处理会一直涨。
   */
  private prepareClips(): void {
    const c = this.models.clips;
    const char = this.models.char;
    if (!char || !c) return;
    if (this.clipsReady) return;
    this.rootBone = rootBoneName(char);
    const rest = restPoseOf(char);
    const fix = (k: 'run' | 'walk' | 'ride' | 'idle') => {
      const clip = c[k];
      if (!clip) return;
      // ★ 顺序：先量（原始片段），再改。
      const rm = rootMotionOf(clip, this.rootBone);
      if (k !== 'idle' && rm.speed > 1e-3) this.clipCadence[k] = rm.speed;
      // ★ 骨盆高度也必须在**原始**片段上量（Y 一路本来就没被动过，
      //   但读处理后的那份会让「量的是谁」这件事变得不可查）。
      if (k === 'ride') this.pelvisH = pelvisHeightOf(clip, this.rootBone);
      let out = stripRootMotion(clip, this.rootBone);
      // 只有待机需要补骨：移动的三段本来就覆盖全部 86 根
      if (k === 'idle') out = bindMissingBones(out, rest);
      c[k] = out;
    };
    fix('run');
    fix('walk');
    fix('idle');
    // ---- 骑行：走自己的分支，因为要按「脚踩满一圈」裁循环接缝 ----
    if (c.ride) {
      const r = prepareRideClip(char, c.ride, this.rootBone);
      this.pelvisH = r.pelvisY;
      this.rideSeam = r.seam;
      this.ridePedalRate = r.pedalRate;
      this.rideFootOrbit = r.footOrbit;
      if (r.cadence > 1e-3) this.clipCadence.ride = r.cadence;
      if (!r.seam) {
        // 量不到 = 素材不循环（或骨架认不出脚）。**照旧播整条**，
        // 只是 warn 一句——裁一个量不出接缝的片段会把踩踏剪成半截。
        console.warn(
          '[vehicle] 量不到「骑自行车」的循环接缝（骨架里没有左右踝/根骨，或一圈没踩满），' +
            '循环照旧在片段末尾接回——脚会在每圈末尾跳一下',
        );
      }
      c.ride = r.clip;
    }
    // ★ 滑板姿势：从**处理之后**的 `run` 里挑「双脚张得最开的那一帧」，定格。
    //
    //   顺序必须在 `fix('run')` 之后 —— 要的是**游戏真正在播的那份**片段，
    //   而剥离过的 `run` 根骨水平位移已经归零，定格出来的姿势才不会带残余漂移。
    //   （张角是两个脚之差，根位移对两者一视同仁，所以「量」这件事不受影响。）
    if (c.run) {
      const pose = stancePoseOf(char, c.run, c.idle ?? null);
      if (pose) {
        // 每一根骨都得有归属（与 `idle` 同款规矩）：姿势片段漏掉的那几根骨
        // 会一直停在场景图的静置值上，而只要有任何一条别的轨短暂接管同一根骨，
        // 它们就会闪。`run` 实测覆盖全部 86 根，这里是给换模型兜底。
        this.stance = { ...pose, clip: bindMissingBones(pose.clip, rest) };
      } else {
        // 量不到双脚 = 这个模型的骨架不认得。滑板模式退回原来的样子
        // （站上板后播 `idle`），并在切过去时由 `startClips` 报一句。
        console.warn('[vehicle] 量不到滑板姿势（骨架里没有左右踝骨），滑板模式退回待机姿势');
      }
    }
    this.clipsReady = true;
  }

  /** clips 是否已经处理过（`prepareClips` 的幂等标记）。 */
  private clipsReady = false;

  /**
   * 把**实测行车基底**挂到自行车模型节点上。
   *
   * 量不到就退回名义偏航（`BICYCLE_YAW`），**不抛错**——
   * 那时车还是歪着，但能骑；而且 `console.warn` 会说清楚是量没量到。
   */
  private applyBikeBasis(bike: Object3D): void {
    const basis = bikeBasisOf(bike);
    if (!basis) {
      console.warn('[vehicle] 自行车行车基底量不到，退回名义偏航 —— 车头与轮轴都会歪');
      bike.rotation.y = BICYCLE_YAW;
      return;
    }
    bike.quaternion.copy(basis.quat);
    this.bikeBasis = basis;
  }

  /** 摩托车的行车基底，见 `applyBikeBasis`。 */
  private applyMotoBasis(moto: Object3D): void {
    const basis = motoBasisOf(moto);
    if (!basis) {
      console.warn('[vehicle] 摩托车行车基底量不到，退回名义偏航 —— 车头与轮轴都会歪');
      moto.rotation.y = MOTORCYCLE_YAW;
      return;
    }
    moto.quaternion.copy(basis.quat);
    this.motoBasis = basis;
  }

  private rebuild(): void {
    this.group.clear();
    // 航向基准**无条件**重置：它现在同时喂给自行车与摩托车的前端偏转，
    // 而摩托车模式下 `updateBikeRig` 不会跑（`rig` 为 null），
    // 忘了在这里重置的话，切到摩托后第一帧的 yawRate 会是
    // 「上一次切载具到现在累积的角度 ÷ 一帧」——一次猛打方向。
    this.lastHeading = this.heading;
    this.wheels = [];
    this.motoSpins = [];
    this.motoSteer = null;
    this.motoSlot = null;
    this.bikeBasis = null;
    this.motoBasis = null;
    this.rig = null;
    this.steerAngle = 0;
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.walkAction = null;
    this.runAction = null;
    this.idleAction = null;
    this.rideAction = null;
    this.stanceAction = null;
    this.blend = { walk: 0, run: 0 };

    const bike = this.models.bike;
    const moto = this.models.motorcycle;
    const skate = this.models.skate;
    const char = this.models.char;

    // **车模的缩放来自各自的数据，不能统一写 1**。
    // 换过两次模型，每次症状都不同：
    //   · 最早那个 bike.glb 单位是乱的（包围盒 65534），靠 WORLD.BIKE_SCALE 压回米制；
    //     曾经这里写成 1，结果车和角色一起消失。
    //   · 现在是 `bicycle_clean.glb`，单位正常（轮半径 0.1947），
    //     所以改成**按前轮实测半径**反推，和摩托车走同一条路。
    //     写死一个数的话，换模型那天它就悄悄失配——而画面上只是"车有点大"。
    if (bike) {
      bike.scale.setScalar(bicycleScale(bike));
      // ★ 摆**实测行车基底**，而不是一个写死的偏航。
      //
      //   原来写的是 `bike.rotation.y = BICYCLE_YAW`（-90°），依据是
      //   「车头在本地 -X」。而逐顶点量出来车头在 (-0.98270, 0, 0.18522)，
      //   偏航要 **-100.67°** —— 差 10.67°。同时轮子该绕的车轴也偏了 10.67°。
      //
      //   两者一起治，所以这里挂的是**完整四元数**而不是偏航：
      //   它把车头送到 -Z、把实测车轴送到横向、把上送到 +Y。
      //   之后 `assembleBike` 在这个坐标系里建「轴对齐 → 自转」两层。
      this.applyBikeBasis(bike);
      bike.visible = this.mode === 'bike';
      this.group.add(bike);
      // ⚠ `alignLocalX` 与 `measureWheel` 都要读**世界**矩阵，而
      //   `Object3D.updateMatrixWorld()` **不会**往上更新祖先。
      //   所以这里显式从 `group` 刷一遍，别指望调用方已经刷过。
      this.group.updateMatrixWorld(true);
      if (this.mode === 'bike') {
        this.rig = this.assembleBike(bike);
      }
    }
    if (moto) {
      // 缩放按**前轮实测半径**反推，不写死——见 motorcycleScale 的注释。
      const s = motorcycleScale(moto);
      moto.scale.setScalar(s);
      // ★ 同样挂实测行车基底：这台车实测歪了 **26.58°**（车头）与 **26.16°**（车轴）。
      //   原来补的 180° 是按「车头在 +Z」算的，而 +Z 只是**名义**方向——
      //   补完之后车头落在 153.4°，而行进方向是 180°，这就是用户报的
      //   「摩托车车头没对齐行走方向」。
      this.applyMotoBasis(moto);
      // 侧撑的倾角**不能**写在 `moto` 上：`moto` 的四元数是行车基底，
      // 往它上面写 `rotation` 会把基底整个冲掉（three 的 rotation 与
      // quaternion 互为镜像，任何一个被写另一个就被重算）。
      // 所以倾角挂在这个**基底之外**的槽节点上——它的本地 +Z 就是真正的
      // 前后轴（水平），侧倾于是绕着车头那条轴滚，而不是绕一条偏 26.58° 的假轴。
      this.motoSlot = new Group();
      this.motoSlot.name = `${RIG}motoSlot`;
      this.motoSlot.rotation.z = motoLeanAt(0);
      this.motoSlot.add(moto);
      moto.visible = this.mode === 'motorcycle';
      this.group.add(this.motoSlot);
      this.group.updateMatrixWorld(true); // 同上：轴对齐要读世界矩阵
      if (this.mode === 'motorcycle') {
        this.collectMotorcycle(moto, s);
      }
    }
    if (skate) {
      // 缩放与板面高度都只有一个来源（文件尾的 `SKATE_SCALE` / `SKATE_DECK_Y`），
      // 改大板只要改那一个数，站高会自己跟着算。
      skate.scale.setScalar(SKATE_SCALE);
      // 板身的偏航已经烘进 GLB，这里只补"本地 −X 对上前进方向"那 90°。
      skate.rotation.y = Math.PI / 2;
      skate.visible = this.mode === 'skate';
      this.group.add(skate);
      if (this.mode === 'skate') this.collectWheels(skate);
    }
    if (char) {
      char.scale.setScalar(autoScaleToHeight(char, CHAR_HEIGHT));
      // **摩托车自带骑手**（Tripo 导出，人车焊死），这个模式下要把角色藏起来，
      // 否则两个骑手叠在一起：一个摆腿的，一个焊在车上的。
      char.visible = this.mode !== 'motorcycle';
      this.group.add(char);
      if (this.mode !== 'motorcycle') this.startClips(char);
    }
  }

  /**
   * 收集滑板的轮子。
   *
   * ## ★ 这里原来写的是 `getObjectByName('wheel_FL')` —— 而这种节点**一个都不存在**
   *
   * `skateboard.glb` 里的轮子节点名是 `wheel_FL_1` / `wheel_FL_2`（还有 `wheel_RL_*`），
   * 而且**每个名字在模型里重复 4 次**（8 个轮子网格只有 6 个不同的名字，
   * 四个轮子各有一对外侧/内侧轮）。所以：
   *
   * · 按名字取 → 找不到，`this.wheels` 恒为空 ⇒ **滑板的轮子从来没转过**；
   * · 就算把名字补成 `wheel_FL_1`，`getObjectByName` 也只会返回**其中一个**
   *   ——8 个轮子只转 2 个。
   *
   * 症状安静到没有任何断言会红：轮子不转在画面上只是「看不出在滚」，
   * 而速度、离地、站位、面数全都正常。
   *
   * 所以这里**遍历并保留节点对象**（不是名字）：名字只用来筛，节点本身才是身份。
   * 这一条对 `measureWheel` / `localUnion` 同样成立——它们按名字遍历，
   * 在这个模型上会把**四个轮子混成一个**去量。自行车与摩托车的零件名
   * 唯一（`tripo_part_N` 编号不重复），所以那两台车没踩到这颗雷。
   */
  private collectWheels(board: Object3D): void {
    const nodes: Object3D[] = [];
    board.traverse((o) => {
      if (/^wheel_/.test(o.name)) nodes.push(o);
    });
    this.wheels = nodes;
    // 轮半径：逐**节点**量（同名会被混量，见 `collectWheels` 的注释）。
    let r = 0;
    for (const o of nodes) {
      const f = measureWheelNode(board, o);
      if (f && f.radius > r) r = f.radius;
    }
    if (r > 1e-4) this.skateWheelR = r * SKATE_SCALE;
  }

  /**
   * ## 装配自行车：一组**枢轴**，而不是直接拧零件
   *
   * 拧零件（`mesh.rotation.x = ...`）只在一种情况下成立：
   * 那个零件的**节点原点正好在转轴上**。而**脚撑**不成立——
   * 它的节点在零件中段，而铰点必须落在**后轴**上。
   * 绕着零件中段转 100°，脚撑会甩出一道弧线而不是折起来。
   *
   * 所以按来源项目 `bike_ride/src/bike.js` 的结构建枢轴，
   * 并且给每个要自转的机构**拆成三层**：
   *
   * ```
   * bike                              ← 挂实测行车基底（quat，见 rebuild）
   *  ├ frontSteer  (前轴处, rotation.y = 车把角)   ├ 车把/握把/挡泥板
   *  │   └ frontHub                             └ frontAxis  (quat: 本地 +X = 实测车轴)
   *  │       └ frontSpin  (rotation.x = 里程/半径)   └ 前轮
   *  ├ rearHub    (后轴处)                       └ rearAxis → rearSpin  → 后轮
   *  ├ standFold  (后轴处, quat = 车轴)          └ standSpin (rotation.x = 折角) → 脚撑
   *  └ crank      (曲柄轴心)                     └ crankAxis (quat = 车轴)
   *      ├ crankSpin (rotation.x = 传动角)         └ 两只曲柄臂
   *      └ 两只踏板（不转，轨道手动重算 → 平台保持水平）
   * ```
   *
   * ★ 为什么是三层而不是两层：`axis` 上带的是**一次性写死的朝向**，
   *   而 `spin` 每帧要写 `rotation.x`。在同一个节点上写 `rotation` 会把
   *   那个朝向**整个替换掉**——参考项目 `bike_ride/src/bike.js` 的注释
   *   点名过这个坑（「在已经带固定朝向的节点上赋 `rotation.y`，
   *   会把那个朝向 wholesale 替换掉，而不是叠加」）。
   *   两层的后果是轮子又开始绕歪轴滚，而画面上只是「轮子有点摆」。
   *
   * 曲柄**组本身不转**（只转两条臂），踏板用「手动重算轨道」跟着绕：
   * 踏板挂在不转的 `crankAxis` 上（不是臂上），它是一个**轴承**，
   * 平台必须始终保持水平——真车上的踏板被曲柄臂带着绕圈，
   * 而平台相对车架一直是平的。
   *
   * 轴心与自转轴**逐顶点实测**（`measureDriveBasis`），不用包围盒中心。
   * 任何一步量不到（模型还没到位 / 换了名字）就返回 `null`，
   * 那时车照旧能骑，只是没有转向、没有脚撑——**不抛错**。
   */
  private assembleBike(bike: Object3D): BikeRig | null {
    // ★ **按模型缓存，装配只做一次**。
    //
    // 原来每次进入 bike 模式都重建枢轴，而重建的第一步是「清掉上一轮的
    // `rig:` 节点」——那会把**挂在里面的零件一起带走**：
    // 前轮、车把、挡泥板、脚撑、曲柄都已经被 `attach` 进了枢轴，
    // 枢轴一被移除它们就跟着脱离整车，于是下一次
    // `bike.getObjectByName('tripo_part_0')` 找不到东西、
    // `assembleBike` 返回 `null` ⇒ **转向 / 脚撑 / 曲柄全部静默失效**。
    //
    // 症状极其安静：车还能骑，只是「怎么骑都不对」，而没有任何断言会红。
    // 重新挂回零件也不可行——`attach` 保留世界变换，
    // 轮子会带着**自转过的角度**被当成静置姿态挂回去。
    //
    // 所以枢轴常驻：建一次、之后只复位它的动态角度。
    const cached = BIKE_RIGS.get(bike);
    if (cached) {
      this.resetRig(cached);
      return cached;
    }
    bike.updateMatrixWorld(true);

    const part = (n: string) => bike.getObjectByName(n) ?? null;

    // ★ 轴心与自转轴都**逐顶点实测**（`measureDriveBasis`），不用包围盒中心。
    //   包围盒量不出「整台车相对模型轴歪了 10.67°」——那正是原来的病根。
    //   取的是**缓存那份**（`bikeBasisOf`）：`rebuild()` 里 `applyBikeBasis`
    //   已经先量过一次了；这里若再量一次，量到的就是轮子已经被 attach 进
    //   rig 之后（带着自转角）的姿态 —— 见 `BIKE_BASIS` 上那张漂移表。
    const basis = bikeBasisOf(bike);
    if (!basis) return null;
    const frontAxle = basis.front;
    const rearAxle = basis.rear;
    // 脚撑与曲柄的折/转轴用**两个轮轴的平均**：真车上链线与轮轴是平行的，
    // 而曲柄零件自己的包围盒是个小方块，量不出它的轴。
    const lateral = basis.axle;
    const frontWheel = part(BIKE_FRONT_WHEEL[0]);
    const rearWheel = part(BIKE_REAR_WHEELS[0]);
    if (!frontWheel || !rearWheel) return null;

    // ---- 前端：转向枢轴（前轴处）→ 定位 → 轴对齐 → 自转 → 前轮 ----
    const frontSteer = new Group();
    frontSteer.name = `${RIG}frontSteer`;
    frontSteer.position.copy(frontAxle);
    bike.add(frontSteer);
    bike.updateMatrixWorld(true);
    for (const n of BIKE_STEER_PARTS) {
      const o = part(n);
      if (o) frontSteer.attach(o);
    }
    const frontHub = new Group();
    frontHub.name = `${RIG}frontHub`;
    frontSteer.add(frontHub);
    // ---- 后轮 ----
    const rearHub = new Group();
    rearHub.name = `${RIG}rearHub`;
    rearHub.position.copy(rearAxle);
    bike.add(rearHub);

    // 前后轮共用同一个「轴对齐 → 自转」两层骨架
    //
    // ★ **零件必须等对齐做完再挂上去**。`alignLocalX` 写的是对齐层自己的
    //   `quaternion`，而对齐层是零件的**祖先** —— 先挂后对齐等于连轮子带姿态
    //   一起转过去（对齐量本身就是个几十度的旋转），轮面法线当场就不在轴向上了：
    //   自转层绕真轴拧，拧的却是一只已经被拧歪的轮子，于是轮子整个翻跟头。
    //   先对齐、后 `attach`（它保持世界变换）轮子原地不动，而自转层的本地 +X
    //   已经落在真正的轴上。
    const spins: { axis: Group; spin: Group; mesh: Object3D }[] = [];
    const addSpin = (host: Object3D, mesh: Object3D, tag: string) => {
      const axis = new Group();
      axis.name = `${RIG}${tag}Axis`;
      host.add(axis);
      const spin = new Group();
      spin.name = `${RIG}${tag}Spin`;
      axis.add(spin);
      spins.push({ axis, spin, mesh });
    };
    frontSteer.updateMatrixWorld(true);
    bike.updateMatrixWorld(true);
    addSpin(frontHub, frontWheel, 'front');
    addSpin(rearHub, rearWheel, 'rear');
    bike.updateMatrixWorld(true);

    // ---- 脚撑：铰在**后轴**，所以它折起来时是绕车轴摆出去的 ----
    const stand = part(BIKE_REAR_STAND[0]);
    const standFold = new Group();
    standFold.name = `${RIG}standFold`;
    standFold.position.copy(rearAxle);
    bike.add(standFold);
    const standSpin = new Group();
    standSpin.name = `${RIG}standSpin`;
    standFold.add(standSpin);

    // ---- 曲柄：轴心取 `crankAxle` 节点自己的位置，不写死 ----
    const crank = new Group();
    crank.name = `${RIG}crank`;
    const axleNode = part(BIKE_CRANK_AXLE);
    if (axleNode) {
      crank.position.copy(axleNode.position);
    } else {
      // 找不到轴零件就退回「曲柄与地面之间的中点」，仍然不抛错
      crank.position.set(0, BIKE_WHEEL_R * 0.9, 0);
    }
    bike.add(crank);
    bike.updateMatrixWorld(true);
    // 曲柄同样拆成「对齐层 / 自转层」：踏板挂在对齐层上（不转），
    // 曲柄臂挂在自转层上。合成一个节点的话，给踏板重算轨道就得连对齐一起冲掉。
    const crankAxis = new Group();
    crankAxis.name = `${RIG}crankAxis`;
    crank.add(crankAxis);
    const crankSpin = new Group();
    crankSpin.name = `${RIG}crankSpin`;
    crankAxis.add(crankSpin);
    bike.updateMatrixWorld(true);
    const arms: Object3D[] = [];
    const pedals: { node: Object3D; orbit: Vector3 }[] = [];

    // ---- 先统一做轴对齐（父节点必须全部就位，`alignLocalX` 要读父的世界朝向）----
    bike.updateMatrixWorld(true);
    for (const s of spins) alignLocalX(s.axis, lateral, bike);
    alignLocalX(standFold, lateral, bike);
    alignLocalX(crankAxis, lateral, bike);

    // ---- 再把零件挂上去：对齐层已经摆正，`attach` 保持世界变换，零件原地不动 ----
    bike.updateMatrixWorld(true);
    for (const s of spins) s.spin.attach(s.mesh);
    if (stand) standSpin.attach(stand);
    for (const n of BIKE_CRANK_PARTS) {
      const o = part(n);
      if (!o) continue;
      if (n === 'pedalL' || n === 'pedalR') {
        crankAxis.attach(o);
        // 轨道位置必须在 attach **之后**取：attach 保留世界变换，
        // 之后的 `position` 才是相对曲柄轴心的局部量。
        pedals.push({ node: o, orbit: o.position.clone() });
      } else {
        crankSpin.attach(o);
        if (n === 'crankArmL' || n === 'crankArmR') arms.push(o);
      }
    }

    const scale = bike.scale.x || 1;
    const rig: BikeRig = {
      frontSteer,
      frontHub,
      rearHub,
      standFold,
      crank,
      spins,
      standSpin,
      crankSpin,
      arms,
      pedals,
      seat: saddleTopOf(bike, BIKE_SADDLE),
      wheelbaseM: basis.wheelbase * scale,
      standAngle: 0,
    };
    BIKE_RIGS.set(bike, rig);
    return rig;
  }


  private resetRig(rig: BikeRig): void {
    rig.frontSteer.rotation.set(0, 0, 0);
    // 只复位**自转层**。轴对齐层带的是一次性写死的朝向（`axis` / `standFold` /
    // `crankAxis`），复位它就等于把对齐冲掉，轮子又开始绕歪轴滚。
    for (const s of rig.spins) s.spin.rotation.set(0, 0, 0);
    rig.standSpin.rotation.set(0, 0, 0);
    rig.crankSpin.rotation.set(0, 0, 0);
    rig.standAngle = 0;
    for (const a of rig.arms) a.rotation.set(0, 0, 0);
    for (const p of rig.pedals) p.node.position.copy(p.orbit);
  }

  /**
   * 收集摩托车的轮子与转向件。
   *
   * ## 自转轴为什么**不能**写死成模型 X
   *
   * 原来写的是「摩托车绕**模型本地 X** 转」，判据是
   * 「前轮包围盒 x 0.169 / y 0.329 / z 0.291 —— Y 最大，轮面在 YZ 平面里，轴指向 X」。
   * 判据没错，**输入错了**：包围盒只说明「哪根轴最薄」，
   * 不说明「整台车相对模型轴歪了多少」。逐顶点实测这台车**歪了 26.16°**
   * （见 `MODEL_AXES`）。绕那根歪轴自转，轮子会一边滚一边横向蹭。
   *
   * 所以这里和自行车走同一套：逐顶点量出**实测车轴**，
   * 给每个轮子建「定位 → 轴对齐 → 自转」三层，自转恒为 `rotation.x`。
   *
   * ## ★ 枢轴按**模型**缓存，不是按实例字段
   *
   * 原来这里用 `this.motoSteer.parent === moto` 当「已建过」的判据，
   * 而 `rebuild()` 开头有一句 `this.motoSteer = null` —— **守卫因此永远不生效**。
   * 每次按 E 都重建 `steer` + `rearHub` + 2×`axis` + 2×`spin` = **6 个 Group**，
   * 实测摩托车节点数 677 → 1877 → 2177 → 2477 → 3083（连按 200 次 + 若干轮）。
   *
   * 画面上看不出来（`attach` 保留世界变换，所以轮子的角度**看起来**是对的），
   * 于是它一路泄漏到退出游戏为止。自行车没这个问题：`assembleBike` 走的是
   * `BIKE_RIGS` 这个 `WeakMap`，`rebuild()` 不会把它清掉。
   * 所以这里也改成 `WeakMap`——**同一类修复要两台车都做**。
   */
  private collectMotorcycle(moto: Object3D, scale: number): void {
    // ---- 已建过就复用（判据在 WeakMap 上，不在会被 rebuild 清掉的实例字段上）----
    const cached = MOTO_RIGS.get(moto);
    if (cached) {
      cached.steer.rotation.y = 0;
      for (const s of cached.spins) s.spin.rotation.x = 0;
      this.motoSteer = cached.steer;
      this.motoSpins = cached.spins;
      return;
    }

    // 取**缓存那份**基底：轮子一旦被 attach 进 rig，它量到的就不是原始姿态了
    // （见 `BIKE_BASIS` 上那张「每次按 E 都漂一次」的表）。
    const basis = motoBasisOf(moto);
    const frontBox = localUnion(moto, MOTORCYCLE_FRONT_WHEELS);
    if (!frontBox.isEmpty()) {
      // 竖直跨度 = 轮直径。存米制半径给按里程换算用。
      // 本地盒子里**不含** root.scale，所以这里要乘米制缩放才是世界半径。
      this.motoWheelR = ((frontBox.max.y - frontBox.min.y) / 2) * scale;
    }
    const frontWheel = moto.getObjectByName(MOTORCYCLE_FRONT_WHEELS[0]);
    const rearWheel = moto.getObjectByName(MOTORCYCLE_REAR_WHEELS[0]);
    if (!basis || !frontWheel || !rearWheel) return;

    // 轴距存**米**：`δ = atan(ω·L / v)` 里 L 必须是米。
    // 少了这一步，摩托车的前端偏转会差一整个缩放系数（实测 2.044）。
    this.motoWheelbaseM = basis.wheelbase * scale;

    const lateral = basis.axle;

    // ---- 转向枢轴：摆在**前轮实测轴心**上，绕 Y 偏转模拟车把 ----
    //
    // 摆在别处的话，转一下车把整个前轮组会绕着别的点甩出去。
    const steer = new Group();
    steer.name = `${RIG}motoSteer`;
    steer.position.copy(basis.front);
    moto.add(steer);

    // 后轮只需要「定位 + 对齐 + 自转」；前轮多一层转向。
    const rearHub = new Group();
    rearHub.name = `${RIG}motoRearHub`;
    rearHub.position.copy(basis.rear);
    moto.add(rearHub);

    // `attach` 会**保持世界变换**重挂父子关系，而这里正要的就是这个：
    // 直接 `pivot.add(part)` 会把零件当成枢轴的子节点重新解释它的
    // position，整组零件会瞬间跳到前轮轴心上去。
    // ⚠ 必须先刷新世界矩阵：pivot 刚加进来，它的 matrixWorld 还是旧的。
    moto.updateMatrixWorld(true);
    for (const n of MOTORCYCLE_STEER) {
      const o = moto.getObjectByName(n);
      if (o) steer.attach(o);
    }
    const spins: { axis: Group; spin: Group; mesh: Object3D }[] = [];
    const addSpin = (host: Object3D, mesh: Object3D, tag: string) => {
      const axis = new Group();
      axis.name = `${RIG}moto${tag}Axis`;
      host.add(axis);
      const spin = new Group();
      spin.name = `${RIG}moto${tag}Spin`;
      axis.add(spin);
      spins.push({ axis, spin, mesh });
    };
    // **前轮也要跟着转向**：真车上前轮和车把是一个刚体。
    addSpin(steer, frontWheel, 'Front');
    addSpin(rearHub, rearWheel, 'Rear');

    // ---- 轴对齐：父节点全部就位之后才做；**做完再挂轮子**，理由见 `assembleBike` ----
    moto.updateMatrixWorld(true);
    for (const s of spins) alignLocalX(s.axis, lateral, moto);
    moto.updateMatrixWorld(true);
    for (const s of spins) s.spin.attach(s.mesh);

    if (steer.children.length) {
      // ★ 记进 `WeakMap`（而不是只存在实例字段上），否则 `rebuild()` 一清空
      //   「已建过」这个事实就丢了，下一次上车又重建一轮枢轴 —— 每按一次 E 漏 6 个节点。
      MOTO_RIGS.set(moto, { steer, spins });
      this.motoSteer = steer;
      this.motoSpins = spins;
    }
  }

  /**
   * 起角色的动画轨。
   *
   * ## 徒步是**三条轨按速度混合**，不是"跑动画一直播"
   *
   * 用户要求：切到徒步时**不要自动播跑步动画**，而是移动时才播。
   * 所以这里把 `walk` 与 `run` 都装上、**权重都设 0**，
   * 由 `update` 按速度淡入淡出。停住 → 两条轨权重都归零 → **落到 `idle`**。
   *
   * ## `idle` 是这一版才有的，它治的是一个第一帧的毛病
   *
   * 上一版人物模型只有 3 段（run / walk / 骑自行车）。停下来时两条轨都归零，
   * 露出来的是 **bind pose** —— 也就是**张开双臂的站姿**，而那是游戏的第一帧。
   * 现在这份模型有 9 段，多出来的 `idle` / `wait` 正好补上这个洞。
   *
   * 所以「待机权重 0」这句话现在有个落点：两条移动轨归零时把 `idle` 抬到 1。
   * 模型里没有 `idle` 的话退回 bind pose（老的模型就是这条退路）。
   *
   * 骑行（`bike`）不在这个分支里：它是单独一条 `骑自行车` 循环，
   * 从上马起就一直播——车停着的时候人还跨在车上，本来就该保持那个姿势。
   *
   * ★ 但它的**播放倍率由速度决定**（`cadenceScale`）：车停住时倍率 0，
   *   人就定在踩到一半的姿势上，而不是**站在原地空踩踏板**。
   *   停着的时候脚撑同时放下来，两件事合起来才读作「支着车站着」。
   */
  private startClips(char: Object3D): void {
    const { walk, run, ride, idle } = this.models.clips;
    if (this.mode === 'bike') {
      const clip = ride;
      if (!clip) return; // 找不到就保持 bind pose
      this.mixer = new AnimationMixer(char);
      const a = this.mixer.clipAction(clip);
      a.setLoop(LoopRepeat, Infinity);
      a.play();
      preroll(a, clip);
      this.rideAction = a;
      // ★ 骑上车的第一帧也不能是 bind pose（见 preroll 的说明）。
      this.mixer.update(1 / 60);
      return;
    }
    // ★ 滑板：**一条定格的姿势轨**，不参与按速度的混合。
    //
    //   原来这个模式走的是徒步那条分支（`updateFootAnim`），于是人站在板上
    //   一路播跑步循环——两件事一起错：脚在板上打滑，人看着像原地跑。
    //   现在它有自己的一条轨：权重恒为 1、动作 `paused`，
    //   所以速度、转向都不再影响姿势，板滑出去时人就保持那个站姿。
    //
    //   `paused` 只把有效播放倍率压到 0，mixer 照样每帧把插值结果写进骨头，
    //   所以这个姿势是**钉在**骨上的（别的轨短暂接管同一根骨也会被它按回来）。
    if (this.mode === 'skate' && this.stance) {
      this.mixer = new AnimationMixer(char);
      const a = this.mixer.clipAction(this.stance.clip);
      a.setLoop(LoopRepeat, Infinity);
      a.play();
      a.paused = true;
      a.weight = 1;
      this.stanceAction = a;
      // 同样推一帧：不上这一步，第一帧露出来的是 bind pose（张开双臂）。
      this.mixer.update(1 / 60);
      return;
    }
    this.idleAction = null;
    if (!walk && !run) return;
    this.mixer = new AnimationMixer(char);
    const mk = (clip: AnimationClip | undefined) => {
      if (!clip || !this.mixer) return null;
      const a = this.mixer.clipAction(clip);
      a.setLoop(LoopRepeat, Infinity);
      // **先 play 再把权重压到 0**：不 play 的话 mixer 不会去写这条轨，
      // 权重淡入时会从 bind pose 硬跳一帧（可见的"起步抽搐"）。
      a.play();
      preroll(a, clip);
      a.weight = 0;
      return a;
    };
    this.walkAction = mk(walk);
    this.runAction = mk(run ?? walk);
    // 待机轨**权重直接给 1**（不是淡入）：它从第一帧就该在，
    // 而走路/跑步起来时再由 update 把它压回去。
    if (idle && this.mixer) {
      const a = this.mixer.clipAction(idle);
      a.setLoop(LoopRepeat, Infinity);
      a.play();
      preroll(a, idle);
      a.weight = 1;
      this.idleAction = a;
    }
    // ★ 立刻推一帧，让**第一帧**就已经是待机姿势。
    //
    // 不推的话：mixer 只在 `update(dt)` 里写骨骼，而 `update` 是在
    // `rebuild()` **之后**的下一个渲染帧才被调用——于是从 rebuild
    // 到第一次 mixer.update 之间，角色的骨骼还停在 **bind pose**：
    // **张开双臂的 T 字**，出现在游戏的第一帧上。
    //
    // 用一个真实的小步长（不是 0）：`mixer.update(0)` 在 three 内部
    // 会提前返回，一帧都不写，那样等于什么都没做。
    this.mixer.update(1 / 60);
  }

  /** 循环切换所有模式。返回切到的那个，或 null（模型没加载成功）。 */
  cycle(): RideMode | null {
    for (let i = 1; i <= RIDE_MODES.length; i++) {
      const next = RIDE_MODES[(RIDE_MODES.indexOf(this.mode) + i) % RIDE_MODES.length];
      if (next !== this.mode && this.canEnter(next)) {
        this.mode = next;
        this.rebuild();
        return next;
      }
    }
    return null;
  }

  set(m: RideMode): boolean {
    if (m === this.mode || !this.canEnter(m)) return false;
    this.mode = m;
    this.rebuild();
    return true;
  }

  /**
   * 徒步动画：**按速度淡入淡出，停住就完全不播**。
   *
   * ## 为什么要有这段
   *
   * 原来 `startClip` 一上来就 `play()` 跑步循环，于是**切到徒步的瞬间
   * 人就在原地跑**，站着不动也在原地跑。用户明确要求：移动才播。
   *
   * ## 阈值为什么是 0.35 m/s 而不是 0
   *
   * 速度是通过 `damp` 逼近 0 的，数学上永远到不了 0：
   * 松手之后速度会一路衰减到 1e-4 才停。阈值取 0 就是"到死也不停"，
   * 人会在减速的最后半秒里以极慢的速度原地踏步——
   * 那比跑步更像"滑步机"。0.35 m/s 大约是正常步速的 1/10，
   * 低于它就视为站定，回到 bind pose。
   *
   * ## 混合而不是切
   *
   * `walk` 与 `run` 按速度线性混合，交叉点在**小跑速度的一半**（1.6 m/s）：
   * 走 → 小跑 → 跑，慢动作与快动作之间没有"啪"的一下跳变。
   * 淡入淡出用 `damp`（与相机同一套指数逼近），所以在 30fps 与 120fps 上
   * 手感一致——照抄每帧 lerp(0.2) 的话低配机上会明显更迟钝。
   */
  private updateFootAnim(dt: number, speed: number): void {
    const v = Math.abs(speed);
    const moving = v > FOOT_IDLE_SPEED;
    const walk = moving ? clamp01((RUN_FULL - v) / (RUN_FULL - WALK_FULL)) : 0;
    const run = moving ? 1 - walk : 0;

    this.blend.walk = damp(this.blend.walk, walk, FOOT_BLEND_RATE, dt);
    this.blend.run = damp(this.blend.run, run, FOOT_BLEND_RATE, dt);
    if (this.walkAction) this.walkAction.weight = this.blend.walk;
    if (this.runAction) this.runAction.weight = this.blend.run;

    /**
     * 待机轨**接住差额**，让三条轨的权重**恒等于 1**。
     *
     * 这一条治的是「松开方向键时出现 T 字」：
     * mixer 是**按权重混合**的，而权重和不足 1 时，**剩下的那一份就是 bind pose**。
     * 原来待机是"渐入"的、移动两条轨是"渐出"的，两者错开的那几帧里
     * 权重和 < 1 —— 漏出来的那一份正好是**张开双臂的站姿**，
     * 于是每一次松手都闪一下 T 字。停着不动看不出来，一松手就看得见。
     *
     * 所以待机权重**不是阻尼出来的，是算出来的**：`1 − walk − run`。
     * 移动时 walk 与 run 互补（和恒为 1）⇒ 待机 0；停下时两条都趋 0 ⇒ 待机趋 1；
     * 中途任意时刻三者之和**恰好是 1**，没有一个时刻漏出 bind pose。
     */
    const idleW = Math.max(0, 1 - this.blend.walk - this.blend.run);
    if (this.idleAction) this.idleAction.weight = idleW;

    // 两条轨都归零之后**把权重硬清零**：damp 是指数逼近，数学上到不了 0，
    // 会永远停在 1e-9 上。留着这个残值的后果是 mix 每帧仍在按它采样并
    // 写回骨骼——而 1e-9 的权重乘上去虽然看不见，却让"权重和 = 1"这条
    // 不再精确成立（差了 2e-9，够不上任何阈值，但原则上是漏的）。
    if (this.blend.walk < 0.002 && this.blend.run < 0.002) {
      this.blend.walk = 0;
      this.blend.run = 0;
      if (this.walkAction) this.walkAction.weight = 0;
      if (this.runAction) this.runAction.weight = 0;
      if (this.idleAction) this.idleAction.weight = 1;
    }
  }

  /**
   * 第一视角时把角色整个藏起来。
   *
   * `FOOT_LATERAL_OFFSET` 归零之后，角色就坐在 ride 原点上，而 `first`
   * 机位是 `back: 0.15 / up: 1.62`——**在角色头后面 15cm**。
   * 于是骑手视角的画面被后脑勺和背包占掉大半，比第三人称还糟。
   *
   * 之所以做成开关而不是在 `update()` 里直接判模式：`update()` 不知道
   * 相机在哪，只有 `Ride` 知道。所以可见性由外面推进来。
   */
  setSelfHidden(hidden: boolean): void {
    this.selfHidden = hidden;
  }

  /** 每帧：动画、轮子、站位。`speed` 米/秒。 */
  update(dt: number, speed: number, heading: number): void {    this.speed = speed;
    this.heading = heading;

    // 动画权重要在 mixer 之前算：mixer 本帧写骨骼用的是**上一帧**的权重。
    // 反过来的话权重淡入会比预期晚一帧，低速起步时看着像"先滑一步再走"。
    //
    // ★ 只在**徒步**模式下算。滑板有自己的定格姿势轨（`stanceAction`），
    //   摩托车模式下角色整个不可见；这两种模式都不该被按速度的混合动过。
    if (this.mode === 'foot') this.updateFootAnim(dt, speed);
    // 播放倍率**在 mixer 之前**写：mixer 本帧用的就是这个值。
    this.applyCadence(speed);
    this.mixer?.update(dt);

    const bike = this.models.bike;
    const moto = this.models.motorcycle;
    const skate = this.models.skate;
    const char = this.models.char;

    bike && (bike.visible = this.mode === 'bike');
    moto && (moto.visible = this.mode === 'motorcycle');
    skate && (skate.visible = this.mode === 'skate');
    // 摩托车自带骑手，外加的角色必须让位（见文件头）；
    // 第一视角下角色挡在相机正前方，也要让位（见 `setSelfHidden`）。
    char && (char.visible = !this.selfHidden && this.mode !== 'motorcycle');

    // 轮子按**里程**转：停下就不转
    this.wheelSpin += speed * dt;
    // ★ **正号，而且三个载具统一**。符号是这样定的，不是试出来的：
    //   不打滑要求「接地点速度 = 0」，即 `v_中心 + ω × r = 0`。
    //   `measureDriveBasis` 把实测车轴的符号**统一成「指向车的左侧」**
    //   （`axle · (up × head) > 0`），在这个约定下解出来恒是 **ω = +v / R**。
    //   写负号的话**三个载具的轮子全是倒着转的**，
    //   而画面上「轮子空转」和「轮子倒转」第一眼很像，
    //   没有任何现有判据量得到正负号。
    // ---- 航向变化率：两台车的前端都靠它算偏转，**每帧只算一次** ----
    //
    // 航向变化率是**这一帧**的量，所以要 wrap 到 (-pi, pi]：
    // 玩家转过一整圈（|dh| > pi）时，不 wrap 会把一次小转弯读成一次反向猛打。
    const dy = this.heading - this.lastHeading;
    const hStep = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.lastHeading = this.heading;
    const yawRate = dt > 1e-6 ? hStep / dt : 0;

    if (this.wheels.length) {
      // 滑板轮半径**逐节点实测**（`skateboard.glb` 实测 0.036 模型单位 × 缩放）。
      // 原来写死 0.023，与真值差 57% —— 轮子转快一半多，看着像「轮子在空转」。
      // 自转轴实测就是**本地 Z**（偏差 0.37°），所以 `rotation.z` 是对的。
      const rad = Math.max(this.skateWheelR, 1e-4);
      for (const w of this.wheels) w.rotation.z = this.wheelSpin / rad;
    }
    // 自行车：前后轮各绕**实测车轴**转（`spin` 层的本地 +X 已经对齐到它），
    // 转角**同一个**（同轴、通过链条联动）。
    if (this.rig) {
      const ang = this.wheelSpin / BIKE_WHEEL_R;
      for (const s of this.rig.spins) s.spin.rotation.x = ang;
      this.updateBikeRig(dt, speed, yawRate);
    }
    // 摩托车：同一套骨架，转角同样按里程算，所以停车后轮子不会继续空转。
    if (this.motoSpins.length) {
      const ang = this.wheelSpin / Math.max(this.motoWheelR, 1e-4);
      for (const s of this.motoSpins) s.spin.rotation.x = ang;
    }
    // 车把随速度偏转，**跟着实际转向输入**：直行时 heading 不变但玩家
    // 可能一直压着舵，用 heading 的变化率会让原地打方向时车把纹丝不动。
    if (this.motoSteer) {
      this.motoSteer.rotation.y = damp(
        this.motoSteer.rotation.y,
        steerFromYawRate(yawRate, speed, this.motoWheelbaseM, MOTO_STEER_MAX),
        STEER_RATE,
        dt,
      );
    }
    // 车身倾角：**只在静止时出现**，而且是**左右侧倾**（绕前后轴）。
    //
    // 骑起来必须是 0，两个理由：
    //   · 车头要时刻指向前方（侧倾不动航向，俯仰才会）
    //   · 轮子的自转轴要平行于水平面（轮子只在移动时转，那时倾角恰好是 0）
    if (this.motoSlot && this.mode === 'motorcycle') {
      this.motoSlot.rotation.z = damp(this.motoSlot.rotation.z, motoLeanAt(speed), STEER_RATE, dt);
    }

    if (!char || !char.visible) return;

    if (this.mode === 'bike') {
      // ★ 摆位：**脚圈中心对准曲柄轴心**——不是「骨盆钉在鞍面上」。
      //
      // 骑手真正该对上的点是**踏板**，而脚踩在踏板上这件事在动画里
      // 就是「两踝中点绕某个点转圈」。那个点就是曲柄轴心，于是整件事
      // 塌成一行式子，而且**不含任何写死的常数**：
      //
      // ```
      // char.position = 曲柄轴心(车模本地) → group
      //                − R_y(π) · (脚圈中心 × 角色缩放)
      // ```
      //
      // 两个量都是实测的（`rig.crank` 由 `assembleBike` 装出来，
      // `footOrbit` 由 `prepareRideClip` 从动画里量），所以换车、换人、
      // 换动画都不用改这里。
      //
      // ## ★ 为什么不再用「骨盆钉鞍面」——代价写在下面，别急着改回去
      //
      // 旧做法把骨盆放在鞍面上方 1.1cm，于是**脚离踏板 11–17cm**：
      // 脚在旁边画圈，够不着踏板。改成对准曲柄轴心之后脚到踏板只剩 **5.1cm**
      // （那是这套素材的精度上限：脚圈半径 0.149 对踏板轨道 0.098，
      //  差值非零就对不齐）。
      //
      // 代价是**骑手悬在鞍面上方 15.9cm**——因为这套骑行动画的
      // 「腿长 ÷ 曲柄半径」之比是 3.93，而这台车是 7.23：
      // 动画的腿**相对**这台车太短，而缩放保持比值，调角色的身高调和不了。
      // 可解析地证明：脚够得着轴心要 s≥1.173、脚圈半径等于踏板半径要
      // s=0.658，两者之积 0.772≠1，没有哪个 s 同时成立。
      //
      // 所以这是**有意选的取舍**：让脚够得着踏板，接受骑手偏高。
      // 视觉上读作「车对 rider 偏小」，比「两只脚在旁边空踩」自然。
      // `verify_bike_rig` 的判据已随之改成量「脚圈中心落在曲柄轴心上」。
      //
      // 脚圈中心量不到（骨架里没有左右踝）时退回旧的鞍面摆法，
      // 那时至少人还坐在车上。
      //
      // ★ 全程**不用 `localToWorld()`**：它给的是**世界**坐标，而
      //   `char.position` 是在父节点 `this.group` 的空间里解读的——
      //   而 `group` 自己已经平移到玩家位置（沿路几百米）。两者一混，
      //   角色被放到「距原点两倍」的地方，实机症状是
      //   **载具在、骑手不见了**（滑板模式就是「滑板上没人」）。
      const cs = char.scale.x || 1;
      const orbit = this.rideFootOrbit;
      if (bike && orbit && this.rig) {
        bike.updateMatrix();
        // 曲柄轴心：车模本地 → group 空间
        const axis = this.rig.crank.position.clone().applyMatrix4(bike.matrix);
        // 脚圈中心：模型单位 → 米（角色缩放）→ 角色自己的朝向（`char.rotation.y = π`）
        const g = orbit.clone().multiplyScalar(cs).applyAxisAngle(AXIS_Y, CHAR_FACING_YAW);
        char.position.copy(axis).sub(g);
      } else {
        const s = bike ? bike.scale.x || 1 : 1;
        const seat = this.rig?.seat ?? new Vector3(0, SADDLE_H / s, 0);
        if (bike) {
          // 全程在**车模本地单位**里算，最后一次 `bike.matrix` 换到 group 空间。
          //   鞍面在车模空间；骨盆高度在角色空间，要除以角色缩放换到同一单位。
          const pelvisY = seat.y * s + CHAR_HEIGHT * PELVIS_ABOVE_SADDLE;
          const p = new Vector3(
            // 后方 = 车模 +X（车头在 −X）。骑手重心要在坐垫后面一点。
            seat.x + PELVIS_BEHIND_SADDLE / s,
            (pelvisY - this.pelvisH * cs) / s,
            seat.z,
          );
          bike.updateMatrix();
          char.position.copy(p).applyMatrix4(bike.matrix);
        } else {
          char.position.set(0, SADDLE_H, 0);
        }
      }
    } else if (this.mode === 'skate') {
      // 同上：车与人是兄弟节点，用局部矩阵，别用 localToWorld。
      //
      // ★ 站高**按实测落差压下去**（`stance.rise` × 角色缩放）。
      //
      //   原来这里写死 0.12m，那是「板面多高」；而人踩不踩到板面，
      //   取决于这一帧的脚在**哪个高度**——跑步动画里双脚张得最开的那一刻
      //   正好是腾空期，两只脚都离地（实测比站姿高 0.0409 个模型单位
      //   = 0.072m），照写死的 0.12 摆出去，人就是**浮在板上面踩空气**。
      //
      //   这个数不能写死成另一个常数：骨原点在踝关节而不是脚底，
      //   模型原点也不在板面上。`stance.rise` 是拿同一把尺子量一段站姿
      //   作参照的自校准之差（见 `StancePose.rise`）。
      const dropM = (this.stance?.rise ?? 0) * (char.scale.x || 1);
      const deck = SKATE_DECK_Y - dropM;
      const p = new Vector3(0, deck / SKATE_SCALE, 0);
      if (skate) {
        skate.updateMatrix();
        char.position.copy(p).applyMatrix4(skate.matrix);
      } else {
        char.position.set(0, deck, 0);
      }
    } else {
      // 徒步：**站在 ride 位上，不 sideways 挪。**
      //
      // 这里原来把角色推到侧向 `PARKED_OFFSET = 2.6m`，理由是"载具停下时
      // 停在路边"。但那一段挂在 `mode === 'foot'` 上——而 foot 是**默认、
      // 且全程在用**的模式，不是"停放"。三件事叠起来出了一个静默故障：
      //
      //   1. 默认机位 `forward` 的横向偏移是 0（`CAM.forward.side`），
      //      相机锁在 ride 位正后方 3.2m；
      //   2. 相机与角色偏轴角 = `atan(2.6 / 3.2)` = **39.1°**；
      //   3. 竖屏（画幅 < 1）时横向半视场只有 ~35.8°（`fov.ts`，实测
      //      竖 84.0° / 横 71.6°）。
      //
      // 39.1° > 35.8°，于是**人整个在画面外**，横屏也只是贴在右边缘 2/3 处。
      // 更糟的是 foot 模式下自行车是隐藏的（`bike.visible = mode === 'bike'`），
      // 所以"人站在停着的车旁边"这个画面连车都没有——只剩一个推不出视野的人。
      //
      // 症状安静到没有任何工具会报错：`verify_veg_ground` 量的是植被落地、
      // `verify_ride` 量的是速度与离地，都跟"角色在不在画面里"无关。
      // 现在由 `verify_avatar` 守：foot 模式的横向偏移必须为 0，
      // 且偏轴角必须小于竖屏半视场。
      char.position.set(FOOT_LATERAL_OFFSET, 0, 0);
    }
    // 角色朝向。
    //
    // ★ **这里只补 180°，不再补 `heading`** —— 原来写的是
    //   `heading + CHAR_FACING_YAW`，那把航向**算了两遍**：
    //   `this.group` 挂在 `ride.bikePivot` 下面，而 `bikePivot.rotation.y`
    //   已经是 `heading`（`ride.ts` 的 `render()`），所以角色的**世界**朝向
    //   曾经是 `2·heading + π`。
    //   h = 0 时看不出来，一转弯就露馅：车往左拐，人往右转，
    //   转得还是车的两倍。症状只在**转向时**出现，直行时完全正常，
    //   而所有既有断言量的都是 `char.rotation.y` 这个**局部**量——
    //   它确实等于 `heading + π`，所以判据和实现一起错、一起绿。
    //
    //   现在判据改成量**世界朝向**（`verify_foot_anim` 第 5/6 条），
    //   它把 `Vehicle.group` 挂进一个带航向的父节点里复现真实场景图。
    //
    // 人物模型**正面朝 +Z**，而本组空间的前进方向是 **−Z**（车头约定），
    // 所以这里要补 180°。不补的话人是**倒着走**：玩家从背后看到的是他的脸。
    //   依据是来源项目：`Bike.ts` / `Skate.ts` 给角色的 `yaw` 都是 **0**，
    //   而那台自行车的车头是 +Z（它要 +90° 才是 +Z）——所以 yaw=0 时人面朝 +Z。
    char.rotation.y = CHAR_FACING_YAW;
  }

  /**
   * 播放倍率：让**脚不打滑**，也让走和跑真的分开。
   *
   * 放在 `mixer.update` **之前**调用：mixer 本帧用的就是这个值。
   * 待机轨不动（它没有位移，速度对它没有意义）。
   */
  private applyCadence(speed: number): void {
    if (this.walkAction) this.walkAction.timeScale = cadenceScale(speed, this.clipCadence.walk);
    if (this.runAction) this.runAction.timeScale = cadenceScale(speed, this.clipCadence.run);
    // 骑行：★ 走**曲柄**而不是步速（见 pedalCadence）——
    //   脚踩在踏板上，而踏板的转速已经被里程钉死了，两条时钟必须合成一条。
    //   量不到动画自带转速时（`ridePedalRate` = 0）退回按步速推，
    //   也就是改动之前的行为——宁可慢，也不能让脚在半空里疯转。
    if (this.rideAction) {
      this.rideAction.timeScale =
        this.ridePedalRate > 1e-6
          ? pedalCadence(speed, this.ridePedalRate)
          : cadenceScale(speed, this.clipCadence.ride);
    }
  }

  /**
   * 每帧的自行车部件姿态：**转向 / 脚撑 / 曲柄**。
   *
   * 三件事都是「从同一个里程与航向推出来的」，所以它们**不可能互相矛盾**：
   * 轮子转多少（`wheelSpin`）、曲柄转多少、弯打多大，
   * 全部来自 `update()` 的同一组输入。
   *
   * @param yawRate 航向变化率，由 `update()` 算一次传进来（两台车共用同一个值）
   */
  private updateBikeRig(dt: number, speed: number, yawRate: number): void {
    const rig = this.rig;
    if (!rig) return;

    // ---- 转向：δ = atan(ω · L / v)，与速度无关地定出转弯半径 ----
    this.steerAngle = damp(
      this.steerAngle,
      bikeSteerTarget(yawRate, speed, rig.wheelbaseM),
      STEER_RATE,
      dt,
    );
    rig.frontSteer.rotation.y = this.steerAngle;

    // ---- 脚撑：停着放下来（垂直于地面），动起来折起 ----
    //
    // 用 `damp` 而不是直接赋值：放下/收起都该有那一下"哐"的到位感，
    // 而且速度是 damp 出来的，直接赋值会在阈值附近每帧跳变。
    rig.standAngle = damp(rig.standAngle, standFoldAt(speed), STAND_RATE, dt);
    // 写在**自转层**（`standSpin`）而不是 `standFold` 上：
    // 后者带的是一次性的轴对齐（本地 +X = 实测车轴），
    // 往它上面写 `rotation` 会把对齐冲掉，脚撑就开始绕歪轴甩。
    rig.standSpin.rotation.x = rig.standAngle;

    // ---- 曲柄与踏板 ----
    //
    // 曲柄角 = **轮角 ÷ 传动比** ⇒ 轮子转一圈，曲柄只转 1/2.6 圈。
    // 链盘永远比飞轮大，所以轮子必须比曲柄转得快，这个机构反过来不存在。
    //
    // ⚠ 这里是「先求轮角再除传动比」，**不是**「里程直接除传动比」：
    //   后者少除了一个轮半径（0.35m），曲柄会慢 2.86 倍 ——
    //   而「慢了多少」是个带量纲的数，判据里很难一眼看出它是错的。
    // 少了整个系数的后果见 `BIKE_GEAR_RATIO`：链条在用减速把轮子往回驱。
    const crankAng = this.wheelSpin / BIKE_WHEEL_R / BIKE_GEAR_RATIO;
    // 曲柄臂挂在**自转层**下，跟着它转就够了——臂自己的 rotation 保持 bind pose。
    rig.crankSpin.rotation.x = crankAng;
    // 踏板挂在**对齐层**（`crankAxis`，不转）上而不是曲柄臂上：它是一个轴承，
    // 平台必须始终相对车架保持水平。真车上的踏板就是被曲柄臂带着绕圈、
    // 而平台始终朝上的。所以轨道**手动重算**——父级不转的话，
    // 挂一个反向旋转会把轨道一起抵消掉。
    // 绕的是 `crankAxis` 的本地 +X，也就是 `alignLocalX` 对齐好的**实测车轴**。
    for (const p of rig.pedals) {
      p.node.position.copy(p.orbit).applyAxisAngle(AXIS_X, crankAng);
    }
  }

  /** 步行速度，用来决定 run 还是 walk（给 HUD 或调试读）。 */  get currentSpeed(): number {
    return this.speed;
  }
  get currentHeading(): number {
    return this.heading;
  }
  /**
   * 徒步时 walk / run 两条轨的当前权重。**给回归量**：
   * "停住不播" 这条判据只能从权重上量，看画面是量不出来的。
   */
  get footBlend(): { walk: number; run: number } {
    return { walk: this.blend.walk, run: this.blend.run };
  }
  /**
   * **处理之后**的片段表。**给回归量**：`verify_foot_anim` 要问三件事——
   * 根骨还有没有水平位移（动画是不是在原地播）、`idle` 有没有绑定脚部骨骼、
   * 权重和是不是恒为 1。这三件都是 `prepareClips()` 之后才成立的性质，
   * 读原始 clip 会读到一份没处理过的。
   */
  get rideClips(): VehicleModels['clips'] {
    return this.models.clips;
  }
  /**
   * 待机轨的当前权重。**给回归量**：站定时它必须是 1。
   *
   * 少了它，停下就露出 bind pose——张开双臂的站姿，出现在游戏的第一帧。
   * 这一条和 `footBlend` 是配对的：前者说"移动轨要让开"，这一条说
   * "让开之后得有人接住"，而后者才是真正治那个毛病的那半句。
   * 模型里没有 `idle` 片段时这里是 0（退回 bind pose，行为与旧模型一致）。
   */
  get footIdleWeight(): number {
    return this.idleAction?.weight ?? 0;
  }
  /**
   * 各移动片段**自带**的步速（m/s）。**给回归量**。
   *
   * 为什么必须是这三个数而不是「读处理后的片段重算一遍」：
   * 剥离之后水平位移已经是 0，重算必然得 0 ——
   * 于是「步速是在剥离之前量的」这条**就永远绿**，而它恰恰是
   * 「播放倍率恒等于 1 → 脚在地上滑行 → 走和跑分不出来」那条的根。
   * 真值只能问 Vehicle 自己存下来的那一份。
   */
  get clipCadenceSpeeds(): { run: number; walk: number; ride: number } {
    return { ...this.clipCadence };
  }
  /**
   * 骑手骨盆在角色本地空间的高度（模型单位）。**给回归量**。
   *
   * 站位 = 鞍面 − 骨盆高度，两者必须**分别**从模型和动画量出来；
   * 少任何一个都会让人浮在车上面或陷进车架里。
   */
  get pelvisHeight(): number {
    return this.pelvisH;
  }
  /**
   * 滑板姿势的**实测数据**（`null` = 没量到）。**给回归量**：
   * 「双脚张得最开的那一帧」这件事在画面上只读作「站得挺开」，
   * 判据必须能问：取自哪一帧、张角多大、要往下压多少。
   */
  get stancePose(): StancePose | null {
    return this.stance;
  }
  /**
   * 滑板姿势轨的当前权重。**给回归量：它必须是 1**。
   *
   * 权重不足 1 时 mixer 漏出来的那一份是 bind pose（张开双臂的 T 字），
   * 也就是「滑板上站着一个张开手的人」——而姿态看起来仍然「像那么回事」，
   * 速度、站位、轮子转角全部正常。
   */
  get stanceWeight(): number {
    return this.stanceAction?.weight ?? 0;
  }
  /** 滑板姿势轨是否被冻结（`paused`）。给回归量：不冻结就还是动画。 */
  get stancePaused(): boolean {
    return this.stanceAction?.paused ?? false;
  }
  /**
   * 自行车的装配是否成功（`null` = 没装）。**给回归量**：
   * 脚撑、转向、曲柄都在 `rig` 上，没有它就等于「那些功能静默失效」。
   */
  get hasBikeRig(): boolean {
    return this.rig !== null;
  }
  /** 脚撑当前角度（弧度）。给回归量：骑起来必须是折起角、停下必须 0。 */
  get standAngle(): number {
    return this.rig?.standAngle ?? 0;
  }
  /** 车把当前偏转（弧度）。给回归量。 */
  get barAngle(): number {
    return this.steerAngle;
  }
  /**
   * 摩托车前轮当前偏转（弧度）。**给回归量：零转向输入时它必须是 0。**
   *
   * 原来这里用 `steerAngleFor(speed)`——一个**只看速度**的公式，
   * 于是玩家完全不按方向时它也非零（实测 24 m/s 恒为 **20.80°**）。
   * 那个值一直被「车头本身偏 26.59°」部分抵消着，所以看不出来。
   */
  get motoSteerAngle(): number {
    return this.motoSteer?.rotation.y ?? 0;
  }
  /** 摩托车轴距（米）。给回归量：转向角公式里 L 要用米。 */
  get motorcycleWheelbase(): number {
    return this.motoWheelbaseM;
  }
  /** 骑行轨当前的播放倍率。给回归量：车停住时必须是 0。 */
  get rideTimeScale(): number {
    return this.rideAction?.timeScale ?? 0;
  }
  /** 自行车后轮当前的转角（弧度）。给回归量：量**正负号**与「绕的是不是真轴」用。 */
  get bikeWheelAngle(): number {
    return this.rig?.spins[1]?.spin.rotation.x ?? 0;
  }
  /** 曲柄的当前转角（弧度）。给回归量。 */
  get bikeCrankAngle(): number {
    return this.rig?.crankSpin.rotation.x ?? 0;
  }
  /** 曲柄轴心的**世界**坐标（米）。自行车摆位把脚圈中心对准的就是它。 */
  get bikeCrankCentre(): Vector3 | null {
    if (!this.rig) return null;
    this.rig.crank.updateWorldMatrix(true, false);
    return this.rig.crank.getWorldPosition(new Vector3());
  }
  /**
   * 骑行片段的「脚圈中心」，**角色本地、模型单位**（`footOrbitOf` 量出）。
   * 摆位就是拿它对准 `bikeCrankCentre`；判据要问的也是这一对。
   */
  get rideFootOrbitLocal(): Vector3 | null {
    return this.rideFootOrbit ? this.rideFootOrbit.clone() : null;
  }
  /**
   * 自行车**自转层的本地 +X 在世界空间**的方向（单位向量）。
   *
   * ★ 这是「轮子到底绕哪根轴滚」**唯一**能问的地方。
   *   `bikeWheelAngle` 只说转了多少、正负号对不对；
   *   而「车轮乱滚」的根因是**轴歪了**——转角完全正常，方向也正常，
   *   只是转轴不是车轴，接地点画出来是个椭圆。
   *   判据拿它和 `measureDriveBasis().axle`（经父链变换到世界）比夹角。
   */
  get bikeSpinAxisWorld(): Vector3 | null {
    const spin = this.rig?.spins[1]?.spin;
    if (!spin) return null;
    spin.updateWorldMatrix(true, false);
    return new Vector3(1, 0, 0).transformDirection(spin.matrixWorld);
  }
  /** 摩托车后轮当前的转角（弧度）。给回归量。 */
  get motoWheelAngle(): number {
    return this.motoSpins[1]?.spin.rotation.x ?? 0;
  }
  /** 摩托车自转层的本地 +X 在世界空间的方向。给回归量（同一族）。 */
  get motoSpinAxisWorld(): Vector3 | null {
    const spin = this.motoSpins[1]?.spin;
    if (!spin) return null;
    spin.updateWorldMatrix(true, false);
    return new Vector3(1, 0, 0).transformDirection(spin.matrixWorld);
  }
  /**
   * 两台车**实测出来的**行车基底（`null` = 量不到，退回了名义偏航）。
   *
   * 导出来是为了让 `verify_drive_basis` 能问「量到的东西对不对」——
   * 而这件事在代码里没有任何别的地方能看出来：`rebuild` 量完就摆上去，
   * 量错的话画面上只是「车有点歪」。
   */
  get driveBasis(): { bike: DriveBasis | null; moto: DriveBasis | null } {
    return { bike: this.bikeBasis, moto: this.motoBasis };
  }
  /** 鞍面在**车模本地**空间的位置。给回归量：站位就是拿它和骨盆高度相减。 */
  get bikeSeat(): Vector3 | null {
    return this.rig?.seat ? this.rig.seat.clone() : null;
  }
  /** 摩托车轮子半径（米）。给回归量：按里程换算转角时要用。 */
  get motorcycleWheelRadius(): number {
    return this.motoWheelR;
  }
  /**
   * 滑板每个轮子当前的转角（弧度）。**给回归量：轮子有没有被找到、有没有在转。**
   *
   * `skateboard.glb` 的轮子节点名是 `wheel_FL_1` / `wheel_FL_2` 这类，
   * 而原来的 `getObjectByName('wheel_FL')` 一个都找不到 ——
   * 于是**滑板的轮子从来没转过**，而画面上只是「看不出在滚」，
   * 速度、离地、站位、面数全部正常，没有任何断言会红。
   */
  get skateWheelAngles(): number[] {
    return this.wheels.map((w) => w.rotation.z);
  }
}

/**
 * 滑板缩放。归一化模型高 0.121，乘 1.35 → 板身高 **0.163m**、
 * 板长约 **1.31m**（模型的长 ≈ 高的 8 倍）。
 *
 * 原来是 **0.9**（板高 0.109m、板长 0.87m，一块真实滑板的尺寸），
 * 用户要求**视觉上放大到 1.5 倍**。写实尺寸在这个世界里偏小：
 * 1.75m 的角色站在 0.87m 的板上，而双脚前后本来就张开 0.757m（见文件头），
 * 于是两脚几乎踩在板的两端（0.379 vs 半长 0.435），板看着像块小脚垫。
 * 放大之后脚落在板的中段，反倒更像「人站在一块板上」。
 *
 * ★ 改这个数**不要**顺手去改板面高度：那个是从它算出来的（见 `SKATE_DECK_Y`）。
 */
const SKATE_SCALE = 1.35;
/** `skateboard.glb` 归一化后的板身高（模型单位，实测）。 */
const SKATE_MODEL_H = 0.121;
/**
 * 板面高度相对板身高度的**倍数**。1.10 而不是 1.00：板面贴图自己有厚度，
 * 角色原点正好摆在板身最高点上会陷进去一点。
 *
 * 写成**倍数**而不是「板身高 + 若干米」，是为了改 `SKATE_SCALE` 时它自动跟着走。
 * 「缩放」与「站高」两个各自写死的数迟早会对不上，
 * 而症状是「人陷进板里」或「人浮在板上面」——画面上很明显，判据却一条都不红。
 */
const SKATE_DECK_FACTOR = 1.1;
/**
 * 板面高度（米）——**角色原点该摆到的那个高度**，不含站姿落差。
 *
 * 0.9 缩放时它是 0.1198m，和原来写死的 0.12 差 0.2mm（同一个数），
 * 所以这一处改动对 0.9 时代的画面是零影响，只是把那个数变成了**算出来的**。
 */
export const SKATE_DECK_Y = SKATE_MODEL_H * SKATE_SCALE * SKATE_DECK_FACTOR;

/** 低于这个速度（米/秒）就算站定，不播动画。见 updateFootAnim 的注释。 */
const FOOT_IDLE_SPEED = 0.35;
/** 权重淡入淡出的指数衰减率。7.7 与相机跟随同一档手感。 */
const FOOT_BLEND_RATE = 7.7;
/** 低于这个速度纯走 `walk`，高于 `RUN_FULL` 纯跑 `run`，中间线性混合。 */
const WALK_FULL = 0.8;
const RUN_FULL = 3.2;
/** 车把偏转的指数衰减率。比动画慢一点，转向看起来才"有重量"。 */
const STEER_RATE = 9;
/**
 * 脚撑放下/收起的指数衰减率。
 *
 * 比 `STEER_RATE` 慢一档：真实的车撑是"哐"地一下到位，
 * 而太快会看成一段动画而不是一次机械动作。
 */
const STAND_RATE = 7;
/**
 * 对齐层 / 自转层共用的**本地 +X**（`alignLocalX` 把本地 +X 对到实测车轴）。
 * 踏板轨道绕它转，脚撑与曲柄的自转角也写在绕它对齐好的那���节点上。
 */
const AXIS_X = new Vector3(1, 0, 0);
/** 竖直轴。角色朝向（`CHAR_FACING_YAW`）与「两脚在矢状面里转圈」都绕它。 */
const AXIS_Y = new Vector3(0, 1, 0);
/**
 * 摩托车前轮的最大转向角（弧度）。约 26°，真实摩托的最大转向角。
 *
 * 它现在只作为**上限**用（`steerFromYawRate`），不再是「速度越快打越少」那条
 * 没有转向输入也会非零的公式的目标值——见 `steerFromYawRate` 的注释。
 */
const MOTO_STEER_MAX = (26 * Math.PI) / 180;




/**
 * 从加载好的 GLB 里取出动画剪辑。找不到返回空表，不抛。
 *
 * ## 片段名是**中文的**
 *
 * `survivor_rigged_v2_fullanim.glb` 里的 9 段：
 * `run` · `walk` · `骑自行车` · `clap` · `surf` · `dig` · `jump` · `idle` · `wait`。
 * 三段是英文、三段是中文，剩下三段两种命名都可能——所以这里**两套都认**，
 * 而不是写死一张表。
 *
 * 认不出来的片段一律丢掉：`clap` / `surf` / `dig` / `jump` 这四段在
 * 这个游戏里没有触发条件，硬挂上去只会让角色在没人操作的时候自己鼓掌。
 */
export function collectClips(clips: readonly AnimationClip[]): {
  run?: AnimationClip;
  walk?: AnimationClip;
  ride?: AnimationClip;
  idle?: AnimationClip;
} {
  const out: { run?: AnimationClip; walk?: AnimationClip; ride?: AnimationClip; idle?: AnimationClip } = {};
  for (const c of clips ?? []) {
    if (c.name === 'run') out.run = c;
    else if (c.name === 'walk') out.walk = c;
    else if (c.name === '骑自行车' || /cycl|bike|ride/i.test(c.name)) out.ride = c;
    // `idle` / `待机` 都认。**它治的是第一帧**：没有它，停下来就露出 bind pose
    else if (c.name === 'idle' || c.name === '待机' || /idle/i.test(c.name)) out.idle = c;
  }
  return out;
}
