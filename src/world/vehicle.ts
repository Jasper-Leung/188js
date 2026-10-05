/**
 * 载具与角色 —— 自行车 / 摩托车 / 滑板 / 徒步，以及站在（骑）上面的那个人。
 *
 * ## 四种状态
 *
 * | | 玩家 | 姿态动画 |
 * |---|---|---|
 * `foot` **默认** | 只有角色，三件载具停在路边 | 移动时 `walk` / `run`，**停住不播** |
 * `bike` | 角色跨在坐垫上 | `骑自行车` |
 * `motorcycle` | **模型自带骑手**（人和车焊死），外加的角色要藏起来 | 无（模型是静态的） |
 * `skate` | 角色站在板上（左脚在前） | `run` |
 *
 * **默认是 `foot`**：这个游戏讲的是"一个人回到自己的家乡"，
 * 开头让玩家推着车走几步比一上来就骑更贴题，而且这样"没有车"这件事
 * 在界面上是看得见的——按 `E` 才有车，是玩家的选择而不是脚本给的。
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
 */
import { Group, Object3D, Vector3, Box3, Matrix4, Mesh, AnimationMixer, AnimationClip, KeyframeTrack, InterpolateDiscrete, LoopRepeat, type AnimationAction } from 'three';
import { RIDE } from '../data/raw';
import { clamp01, damp } from '../core/math';

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

/** 根骨的骨骼名。Mixam 系的约定是 `mixamorig:Hips`。 */
const ROOT_BONE = /(^|:)hips$/i;

/**
 * ## 去掉片段的**根位移**，让它在原地播
 *
 * `walk` / `run` / `骑自行车` 三段都带根位移，而且位移**在骨架的祖先节点上**
 * （来源项目实测约 3.2m）。直接播的后果是： character's 根节点被动画推着走，
 * 而**车是按物理走的**——于是动画把人往前拖、车把人往后拽。
 * 停下的那一刻两条轨权重归零、根节点弹回原位，
 * 玩家看到的就是**「停止走动的时候人就回来一段距离」**。
 *
 * **只清 X 与 Z，保留 Y**：Y 那一路是走路的上下起伏（bob），
 * 那个留着才有走的感觉；水平位移才是"人在往前走"，而那必须由车来负责。
 *
 * 改的是**轨道里的数值**，不是删轨道 —— 删掉的话 mixer 会把这一根
 * 整个权重让给 bind pose，于是又是 T 字。
 */
export function stripRootMotion(clip: AnimationClip): AnimationClip {
  const tracks = clip.tracks.map((tr) => {
    if (!tr.name.endsWith('.position') || !ROOT_BONE.test(tr.name.slice(0, -'.position'.length))) {
      return tr;
    }
    // 逐关键帧把 x / z 抹平，y 原样保留。
    // **新建一条轨道而不是就地改**：就地改会把调用方传进来的那个 clip
    // 也改了，而它是 GLTFLoader 缓存里的同一份对象。
    const v = tr.values.slice();
    for (let i = 0; i < v.length; i += 3) {
      v[i] = 0;
      v[i + 2] = 0;
    }
    return new KeyframeTrack(tr.name, tr.times.slice(), v, tr.getInterpolation());
  });
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
export function bindMissingBones(
  clip: AnimationClip,
  rest: Map<string, { p: [number, number, number]; q: [number, number, number, number]; s: [number, number, number] }>,
): AnimationClip {
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
export function restPoseOf(root: Object3D): Map<string, { p: [number, number, number]; q: [number, number, number, number]; s: [number, number, number] }> {
  const m = new Map<string, { p: [number, number, number]; q: [number, number, number, number]; s: [number, number, number] }>();
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
 * 三个模型各自的**车头方向**（模型本地空间），实测自轮子 / 骑手的节点平移。
 *
 * ⚠ 这一段里的自行车行**已作废**，被下面紧跟着的那段取代。留着是为了
 * 提醒：它就是被实机推翻的那一版。
 *
 * 它们**导出来是为了让 `verify_facing` 能问**：三个 `rotation.y` 是三处
 * 各自独立的常数，代码里没有任何东西把它们联系起来，所以
 * 「人正着走、车却横着跑」这种故障不会让任何一条现有断言变红。
 *
 * | | 车头 | 依据 |
 * |---|---|---|
 * | 人物 | **+Z** | 来源项目给角色传的 `yaw` 是 0，而那台自行车车头是 +Z |
 * | 自行车 | ~~**−X**~~ → 实为 **−Z** | 前轮节点平移 x = −0.3114（**与渲染不符**） |
 * | 摩托车 | **+Z** | 前轮节点平移 z = +0.344，后轮 z = −0.299 |
 */
/**
 * 三个模型各自的**车头方向**（模型本地空间）。
 *
 * ⚠ 自行车的这条**是被实机推翻过一次**的。
 *
 * 我原先按节点平移量出「前轮在 x = −0.311、后轮在 x = +0.287」，
 * 推出车头在 −X、于是补 −90°。渲染出来是**横着的**——车头指向画面右侧，
 * 垂直于路（`chase` 侧视图下一眼可判）。也就是说车头本来就在 **−Z**，
 * 而 −Z 正是本作的前进方向，**一个偏航都不该补**。
 *
 * 摩托车那台的节点平移（z = +0.344 / −0.299）与渲染**是自洽的**，
 * 所以被推翻的只有自行车这一条。教训：几何量测在**没验证过那一维**之前
 * 不该直接写进代码——`verify_facing` 验的是"三个数自洽"，
 * 而三个数一起错的时候它是绿的。
 */
export const MODEL_HEADS = {
  char: [0, 0, 1] as const,
  bicycle: [0, 0, -1] as const,
  motorcycle: [0, 0, 1] as const,
};

/**
 * 模型车头（本地空间）加上它自己的偏航，得到**世界前进方向**。
 *
 * three 的 `rotation.y = θ` 把 `(x, 0, z)` 映到
 * `(x·cosθ + z·sinθ, 0, −x·sinθ + z·cosθ)`（方位角 α 变成 α − θ）。
 * 本作的车头约定是 **−Z**（`ride.ts` 的 `_fwd`），所以每个模型都该算成 (0, 0, −1)。
 */
export function facingDir(head: readonly number[], yaw: number): [number, number, number] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [head[0] * c + head[2] * s, 0, -head[0] * s + head[2] * c];
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



/**
 * 按目标高度（米）反推缩放。
 *
 * 不能写死：模型是「归一化到 1 单位」的（滑板高 0.121、角色高 1.0），
 * 换一批模型高度就变了，写死的数字会在下次换模型时悄悄失配。
 *
 * 扫的是**真实顶点**，不是 `geometry.boundingBox`——
 * GLB 里的 accessor min/max 不可信（见 vegetation.ts 的 bottomOf 注释）。
 */
export function autoScaleToHeight(root: Object3D, targetH: number): number {
  const box = new Box3().setFromObject(root);
  const h = box.max.y - box.min.y;
  if (!Number.isFinite(h) || h < 1e-6) return 1;
  return targetH / h;
}

/** 角色的目标身高（米）。成年男性约 1.75。 */
const CHAR_HEIGHT = 1.75;
/** 坐垫高度（米）。角色跨在车上时脚要落在这个高度附近。 */
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
 * 车头对齐 −Z 所需的绕 Y 偏航（弧度）。本作的车头是 −Z
 * （`ride.ts` 的 `_fwd = (−sin h, 0, −cos h)`，h=0 时指向 −Z）。
 *
 * three 的 `rotation.y = θ` 把方位角 α 变成 `α − θ`：
 *   · 自行车车头在 **−Z**（方位 270°，实机 chase 侧视图判定）→ 就是 −Z → **θ = 0**
 *   · 摩托车车头在 **+Z**（方位 0°）→ 要变成 −Z（方位 180°）→ **θ = ±180°**
 *
 * ⚠ 自行车这一条是**实机推翻**过几何量测之后改的，详见 `MODEL_HEADS` 上面
 * 那段：按节点平移量出来的是 −X（要 θ = −90°），渲染出来车是横着的。
 * 节点平移与渲染在这一维上不一致，所以以渲染为准。
 */
export const BICYCLE_YAW = 0;
export const MOTORCYCLE_YAW = Math.PI;

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
 * `rotation.order = 'YXZ'` 就是为它准备的：Z 放在最内层，
 * 所以这个滚转发生在**模型自己的坐标系**里（它的前后轴 = 本地 Z），
 * 偏航在外面再转 180°，两者不会互相污染。
 *
 * **只在静止时出现**：骑起来必须是立直的，而且**轮子的自转轴必须保持水平**——
 * 轮子只在移动时转，那时倾角恰好是 0，所以"轴平行于水平面"是**结构性成立**的，
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
  return Math.abs(speed) < MOTO_PARK_SPEED ? -MOTO_PARK_LEAN : 0;
}

/** 两个模型**轮子自转轴**的方向（模型本地空间）。 */
export const MODEL_AXLES = {
  /** 自行车：轮面在 XY 平面里（Z 最薄，0.095），所以轴是本地 Z */
  bicycle: [0, 0, 1] as const,
  /** 摩托车：轮面在 YZ 平面里（X 最薄，0.192），所以轴是本地 X */
  motorcycle: [1, 0, 0] as const,
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
  private motoWheels: Object3D[] = [];
  /** 摩托车前轮组的转向枢轴 */
  private motoSteer: Object3D | null = null;
  /** 摩托车轮子半径（米），按里程换算转角用 */
  private motoWheelR = 0.35;
  /**
   * 停放姿态（模型自带的纵向倾角，弧度）。**只在静止时挂上去**。
   * 装配时量一次存下来，之后每帧按速度在它和 0 之间插值。
   */
  private motoParkPitch = 0;
  private models: VehicleModels = { bike: null, motorcycle: null, skate: null, char: null, clips: {} };
  private mode: RideMode = 'foot';
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
  private blend: { walk: number; run: number } = { walk: 0, run: 0 };

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
   * 两件事，顺序不能换：
   *   1. `stripRootMotion` —— 去掉水平根位移，让动画在原地播。
   *   2. `bindMissingBones` —— 给 `idle` 补上它缺的骨（含脚 / 分趾骨）。
   *
   * ⚠ 别把它放进 `rebuild()`：那是每次切载具都会调的，
   *   而它每次都 new 一批轨道，反复处理会一直涨。
   */
  private prepareClips(): void {
    const c = this.models.clips;
    const char = this.models.char;
    if (!char || !c) return;
    if (this.clipsReady) return;
    const rest = restPoseOf(char);
    const fix = (k: 'run' | 'walk' | 'ride' | 'idle') => {
      const clip = c[k];
      if (!clip) return;
      let out = stripRootMotion(clip);
      // 只有待机需要补骨：移动的三段本来就覆盖全部 86 根
            if (k === 'idle') out = bindMissingBones(out, rest);
      c[k] = out;
    };
    fix('run');
    fix('walk');
    fix('ride');
    fix('idle');
    this.clipsReady = true;
  }

  /** clips 是否已经处理过（`prepareClips` 的幂等标记）。 */
  private clipsReady = false;

  private rebuild(): void {
    this.group.clear();
    this.wheels = [];
    this.motoWheels = [];
    this.motoSteer = null;
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.walkAction = null;
    this.runAction = null;
    this.idleAction = null;
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
      // 车头已经在本地 −Z（实机判定），正好是本作前进方向 → 不补偏航。
      // 这里曾经补 −90°，结果是车横着走、垂直于路。
      bike.rotation.y = BICYCLE_YAW;
      bike.visible = this.mode === 'bike';
      this.group.add(bike);
      if (this.mode === 'bike') this.collectBikeWheels(bike);
    }
    if (moto) {
      // 缩放按**前轮实测半径**反推，不写死——见 motorcycleScale 的注释。
      const s = motorcycleScale(moto);
      moto.scale.setScalar(s);
      // ★ 旋转顺序必须是 **YXZ**，不是默认的 XYZ。
      //   本模型同时要偏航（车头 +Z → −Z，补 180°）和侧倾（绕前后轴）。
      //   默认 XYZ 下两者共用一个欧拉角，绕 X 的那一个会在偏航**之后**再转，
      //   于是"侧倾"变成"车头往下扎"——而侧倾本该绕着车头那条轴滚。
      //   YXZ 把 Z 放在最内层：侧倾先在模型自己的坐标系里滚完，再整体偏航。
      moto.rotation.order = 'YXZ';
      moto.rotation.y = MOTORCYCLE_YAW;
      // 停放姿态 = **向一侧侧过去**（绕前后轴的滚转）。
      // 侧撑在车的**左边**，而模型车头在 +Z ⇒ 左边是 +X，
      // 绕 +Z 转一个**负**角才是往左倒。符号错了就是往右倒，
      // 而它在正视图里和"没倒"几乎一样，只有走起来才看得出来。
      this.motoParkPitch = MOTO_PARK_LEAN;
      moto.rotation.x = 0;
      moto.rotation.z = -this.motoParkPitch;
      moto.visible = this.mode === 'motorcycle';
      this.group.add(moto);
      if (this.mode === 'motorcycle') {
        this.collectMotorcycle(moto, s);
      }
    }
    if (skate) {
      // 滑板归一化到 1 单位、实测高 0.121 → 0.11m 的板，取 0.9 得 0.11m×8
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

  private collectWheels(board: Object3D): void {
    // 按**节点名**找，不靠下标：GLB 里的节点顺序一变就全错
    for (const n of ['wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR']) {
      const o = board.getObjectByName(n);
      if (o) this.wheels.push(o);
    }
  }

  /**
   * 自行车的两个轮子。
   *
   * 自行车**整个车身就是这两个轮子**（`tripo_part_0` / `tripo_part_2`），
   * 所以这里和滑板共用 `wheels` 这一组——它们都是"绕各自的轴自转"。
   * 摩托车的轮子另走 `motoWheels`，因为它还要绕前轮轴心**转向**。
   *
   * 轴向：`bicycle_clean.glb` 的轮面在 **XY 平面**里（s 的 Z 最薄，0.095），
   * 所以自转轴是**本地 Z**——和滑板一样，和摩托车（本地 X）相反。
   */
  private collectBikeWheels(bike: Object3D): void {
    for (const n of [...BIKE_FRONT_WHEEL, ...BIKE_REAR_WHEELS]) {
      const o = bike.getObjectByName(n);
      if (o) this.wheels.push(o);
    }
  }

  /**
   * 收集摩托车的轮子与转向件。
   *
   * ## 自转轴为什么是 X
   *
   * 滑板轮子绕**本地 Z** 转（`skate_glide` 的板身沿本地 −X 走），
   * 摩托车的轮子却是绕**模型本地 X** 转：实测前轮包围盒是
   * x 0.169 / y 0.329 / z 0.291 —— **Y 最大**，说明轮面在 YZ 平面里，
   * 车轴指向 X。这和滑板正好反过来，写死成同一个轴的话轮子会横着滚。
   *
   * ## 只转主胎零件
   *
   * Tripo 把卡钳、油管焊进了前轮那一组，整组自转会把它们甩出去。
   * 所以只让纯胎+辋的那一个零件转，其余留在车体上（见常量区注释）。
   */
  private collectMotorcycle(moto: Object3D, scale: number): void {
    const frontBox = localUnion(moto, MOTORCYCLE_FRONT_WHEELS);
    if (!frontBox.isEmpty()) {
      // 竖直跨度 = 轮直径。存米制半径给按里程换算用。
      // 本地盒子里**不含** root.scale，所以这里要乘米制缩放才是世界半径。
      this.motoWheelR = ((frontBox.max.y - frontBox.min.y) / 2) * scale;
    }
    const wheels: Object3D[] = [];
    for (const n of [...MOTORCYCLE_FRONT_WHEELS, ...MOTORCYCLE_REAR_WHEELS]) {
      const o = moto.getObjectByName(n);
      if (o) wheels.push(o);
    }
    this.motoWheels = wheels;

    // ---- 转向枢轴 ----
    //
    // 枢轴摆在**前轮轴心**上，绕 Y 偏转模拟车把。
    // 摆在别处的话，转一下车把整个前轮组会绕着别的点甩出去。
    if (frontBox.isEmpty()) return;
    const pivot = new Group();
    pivot.name = 'motoSteer';
    pivot.position.set(
      (frontBox.min.x + frontBox.max.x) / 2,
      (frontBox.min.y + frontBox.max.y) / 2,
      (frontBox.min.z + frontBox.max.z) / 2,
    );
    moto.add(pivot);

    // `attach` 会**保持世界变换**重挂父子关系，而这里正要的就是这个：
    // 直接 `pivot.add(part)` 会把零件当成枢轴的子节点重新解释它的
    // position，整组零件会瞬间跳到前轮轴心上去。
    // ⚠ 必须先刷新世界矩阵：pivot 刚加进来，它的 matrixWorld 还是旧的。
    moto.updateMatrixWorld(true);
    for (const n of MOTORCYCLE_STEER) {
      const o = moto.getObjectByName(n);
      if (o) pivot.attach(o);
    }
    // **前轮也要跟着转向**：真车上前轮和车把是一个刚体。
    // 挂进枢轴不影响自转——枢轴初始无旋转，轮子的本地 X 轴仍是模型 X 轴。
    for (const w of wheels) {
      const isFront = MOTORCYCLE_FRONT_WHEELS.includes(w.name);
      if (isFront) pivot.attach(w);
    }
    if (pivot.children.length) this.motoSteer = pivot;
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
      // ★ 骑上车的第一帧也不能是 bind pose（见 preroll 的说明）。
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

  /** 每帧：动画、轮子、站位。`speed` 米/秒。 */
  update(dt: number, speed: number, heading: number): void {
    this.speed = speed;
    this.heading = heading;

    // 动画权重要在 mixer 之前算：mixer 本帧写骨骼用的是**上一帧**的权重。
    // 反过来的话权重淡入会比预期晚一帧，低速起步时看着像"先滑一步再走"。
    if (this.mode !== 'bike') this.updateFootAnim(dt, speed);
    this.mixer?.update(dt);

    const bike = this.models.bike;
    const moto = this.models.motorcycle;
    const skate = this.models.skate;
    const char = this.models.char;

    bike && (bike.visible = this.mode === 'bike');
    moto && (moto.visible = this.mode === 'motorcycle');
    skate && (skate.visible = this.mode === 'skate');
    // 摩托车自带骑手，外加的角色必须让位（见文件头）。
    char && (char.visible = this.mode !== 'motorcycle');

    // 轮子按**里程**转：停下就不转
    this.wheelSpin += speed * dt;
    if (this.wheels.length) {
      // 半径**按模式取**：滑板轮 0.023 个单位、自行车轮 0.35m，
      // 两者共用一个半径的话自行车会转快 15 倍（0.35/0.023）——
      // 症状是车轮像在空转，而轮子转多快没有任何判据会红。
      // 两者的自转轴都是本地 Z（轮面都在 XY 平面里），所以数组可以共用。
      const rad = this.mode === 'bike' ? BIKE_WHEEL_R : 0.023 * SKATE_SCALE;
      for (const w of this.wheels) w.rotation.z = -this.wheelSpin / rad;
    }
    // 摩托车轮子绕**本地 X**（轮面在 YZ 平面里，见 collectMotorcycle）。
    // 转角同样按里程算，所以停车后轮子不会继续空转。
    if (this.motoWheels.length) {
      const ang = -this.wheelSpin / Math.max(this.motoWheelR, 1e-4);
      for (const w of this.motoWheels) w.rotation.x = ang;
    }
    // 车把随速度偏转，**跟着实际转向输入**：直行时 heading 不变但玩家
    // 可能一直压着舵，用 heading 的变化率会让原地打方向时车把纹丝不动。
    if (this.motoSteer) {
      this.motoSteer.rotation.y = damp(this.motoSteer.rotation.y, steerAngleFor(speed), STEER_RATE, dt);
    }
    // 车身倾角：**只在静止时出现**，而且是**左右侧倾**（绕前后轴）。
    //
    // 骑起来必须是 0，两个理由：
    //   · 车头要时刻指向前方（侧倾不动航向，俯仰才会）
    //   · 轮子的自转轴要平行于水平面（轮子只在移动时转，那时倾角恰好是 0）
    if (moto && this.mode === 'motorcycle') {
      moto.rotation.z = damp(moto.rotation.z, motoLeanAt(speed), STEER_RATE, dt);
    }

    if (!char || !char.visible) return;

    if (this.mode === 'bike') {
      // 跨在坐垫上：位置由车的变换决定，**不自己算**，免得两处各算一套而漂移。
      //
      // 除的是**这台车自己的缩放**（1.798），不是旧的 `WORLD.BIKE_SCALE = 0.012`
      // ——那一代车模的包围盒是 65534，靠 0.012 压回米制；现在这批模型单位正常，
      // 继续除 0.012 会把人放到 87m 高空去。
      const s = bike ? bike.scale.x || 1 : 1;
      const p = new Vector3(0, SADDLE_H / s, 0);
      bike?.localToWorld(p);
      char.position.copy(bike ? p : new Vector3(0, SADDLE_H, 0));
    } else if (this.mode === 'skate') {
      const p = new Vector3(0, 0.12 / SKATE_SCALE, 0);
      skate?.localToWorld(p);
      char.position.copy(skate ? p : new Vector3(0, 0.12, 0));
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
    // 角色朝向 = 前进方向。
    //
    // 徒步原来是 `heading`（侧对），用户要求「方向与行走方向一致」：
    // 人朝自己走的方向走，而不是横着走。
    //
    // ★ 而人物模型**正面朝 +Z**，本作的车头是 **−Z**，所以这里要补 180°。
    //   依据是来源项目：`Bike.ts` / `Skate.ts` 给角色的 `yaw` 都是 **0**，
    //   而那台自行车的车头是 +Z（它要 +90° 才是 +Z）——所以 yaw=0 时人面朝 +Z。
    //   不补这一下，人就是**倒着走**：玩家从背后看到的是他的脸。
    char.rotation.y = heading + CHAR_FACING_YAW;
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
  /** 摩托车轮子半径（米）。给回归量：按里程换算转角时要用。 */
  get motorcycleWheelRadius(): number {
    return this.motoWheelR;
  }
}

/** 滑板缩放。归一化模型高 0.121，乘 0.9 → 0.109m ≈ 一块真实滑板的高度。 */
const SKATE_SCALE = 0.9;

/** 低于这个速度（米/秒）就算站定，不播动画。见 updateFootAnim 的注释。 */
const FOOT_IDLE_SPEED = 0.35;
/** 权重淡入淡出的指数衰减率。7.7 与相机跟随同一档手感。 */
const FOOT_BLEND_RATE = 7.7;
/** 低于这个速度纯走 `walk`，高于 `RUN_FULL` 纯跑 `run`，中间线性混合。 */
const WALK_FULL = 0.8;
const RUN_FULL = 3.2;
/** 车把偏转的指数衰减率。比动画慢一点，转向看起来才"有重量"。 */
const STEER_RATE = 9;
/** 车把最大偏转（弧度）。约 26°，真实摩托的最大转向角。 */
const STEER_MAX = (26 * Math.PI) / 180;

/**
 * 由**速度**推出车把偏转量（弧度）。
 *
 * 真实的把随速度回正（高速时前轮只走很小的角度），而速度趋零时把可以打到头。
 * 这里取 `STEER_MAX × v / (v + 6)`：v=0 → 0，v=6 → 一半，v→∞ → 满。
 */
function steerAngleFor(speed: number): number {
  const v = Math.abs(speed);
  return STEER_MAX * (v / (v + 6));
}

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
