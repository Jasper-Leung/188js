/**
 * 共享夹具：**与真素材同形的角色骨架**。
 *
 * ## 为什么它必须是「共享」的
 *
 * 这个仓库里至少有两处判据要一副人的骨架，而它们原来各造各的：
 *
 * · `src/verify/vehicle.ts` 的 `verify_bike_rig`——造的是
 *   「髋骨 + 两根踝骨直接挂在角色下面」。
 * · `src/verify/optimization.ts` 的 `verify_pedal_bake`——造的是
 *   「髋骨 → 大腿 → 小腿 → 脚 → 脚趾」，八根腿骨齐全。
 *
 * 两份夹具**不一致**，而这不一致是有后果的：
 * 烘焙（`bakeRideToPedals`）要求**髋 / 膝 / 踝 / 趾**四根骨都在，
 * 所以第一份夹具每次都让烘焙返回 null —— 于是
 * `npm run verify` 每轮都打四条
 * `[vehicle] 骑行腿烘焙失败（骨名对不上？）`，
 * 而真游戏里那条警告**根本不出现**（真素材的八根骨是齐的）。
 *
 * 症状是「判据在测一个不存在的失败」，而更糟的是：
 * **夹具缺骨这件事本身永远不会被看见**——
 * 没有任何一条判据问过「烘焙到底跑没跑」。
 *
 * 所以这里把「与真素材同形的那一副」收成**一份**，
 * 两处判据都用它：夹具与素材不一致的那天，改这一处就够了。
 *
 * ## ★ 这些数字**不是编的**
 *
 * 全部抄自 `survivor.glb` 的骨层级（`mixamorig:*` 命名，
 * three 的 `GLTFLoader` 加载后冒号被**删掉**，所以这里是 `mixamorigXxx`）：
 *
 * | 骨 | 相对父骨的局部平移 | 局部四元数 |
 * |---|---|---|
 * | `mixamorigHips` | （根骨） | 绕 Y 约 90° |
 * | `mixamorigLeftUpLeg` / `RightUpLeg` | (0, ∓0.01952, ∓0.05076) | 绕 X 约 177° |
 * | `mixamorigLeftLeg` / `RightLeg` | **(0, 0.21520, 0)** | 接近单位阵 |
 * | `mixamorigLeftFoot` / `RightFoot` | **(0, 0.22381, 0)** | 大转角 |
 * | `mixamorigLeftToeBase` / `RightToeBase` | **(0, 0.09198, 0)** | — |
 *
 * ★★ **子骨的偏移沿骨本地 +Y**，而烘焙用的 `_up` 正是 (0,1,0)。
 *   烘焙把大腿/小腿的**世界**朝向算出来，再换算成**本地**四元数写回轨道——
 *   那一步成立的前提就是「子骨沿 +Y 挂在父骨上」。
 *   夹具写成别的方向，骨名照样对得上、烘焙照样返回非空，
 *   而脚根本不在踏板上。
 *
 * ## ★ 骨盆的旋转**故意不是单位阵**
 *
 * 烘焙最后一步是「骨向 → 本地四元数」：
 * `q_local = q_父的世界朝向⁻¹ · q_骨的世界朝向`。
 * 父朝向要是单位阵，这一步就退化成恒等——于是把这一步整个删掉，
 * 判据**照样绿**。真素材里骨盆本来就在转，所以夹具也必须转。
 */
import { Bone, Object3D } from 'three';

/** 大腿骨长（模型单位）。真素材 `mixamorigLeftLeg` 相对 `LeftUpLeg` 的平移 y。 */
export const SURVIVOR_THIGH = 0.21519963443279266;
/** 小腿骨长（模型单位）。真素材 `mixamorigLeftFoot` 相对 `LeftLeg` 的平移 y。 */
export const SURVIVOR_SHIN = 0.22381091117858887;
/** 脚掌长（模型单位）。真素材 `mixamorigLeftToeBase` 相对 `LeftFoot` 的平移 y。 */
export const SURVIVOR_TOE = 0.09197956323623657;

/**
 * 真素材里每根腿骨的**绑定变换**（局部平移 + 局部四元数）。左右各一份。
 *
 * 数值逐字来自 `survivor.glb`，不是拟合值。
 */
export const SURVIVOR_LEG_RIG = {
  Left: {
    hipT: [-9.473459350317626e-9, -0.01952172815799713, -0.05075642094016075] as const,
    hipR: [-0.9993082880973816, 0.017668623477220535, 0.01766352541744709, 0.0275451447814703] as const,
    legR: [-0.01603129133582115, -0.03300134092569351, 0.03545479476451874, 0.9986975789070129] as const,
    footR: [0.28991496562957764, 0.3870552182197571, -0.4265589118003845, 0.7643200159072876] as const,
    toeR: [0.2806793451309204, 0.2163766324520111, -0.06510218973584508, 0.9328247308731079] as const,
  },
  Right: {
    hipT: [1.916638936449999e-8, -0.019521543756127357, 0.050756409764289856] as const,
    hipR: [0.9992901086807251, -0.018657958135008812, -0.01866307482123375, 0.026884835213422775] as const,
    legR: [0.020862214267253876, -0.03546271100640297, 0.032845232635736465, 0.9986132383346558] as const,
    footR: [0.13703280687332153, 0.4885921776294708, -0.49721696972846985, 0.7037578225135803] as const,
    toeR: [0.2684095501899719, 0.3481787145137787, -0.10476520657539368, 0.8920494318008423] as const,
  },
} as const;

/**
 * 真素材的**根骨**（骨盆）绑定变换。
 *
 * 位置 (0.00195, 0.52513, 0.07223)、旋转绕 Y 约 90°。
 */
export const SURVIVOR_HIPS = {
  position: [0.0019521618960425258, 0.5251340866088867, 0.07223034650087357] as const,
  quaternion: [-6.108267314175464e-8, -0.70710688829422, 8.001851625749623e-8, 0.7071066498756409] as const,
} as const;

/**
 * 真素材里那**八根腿骨**的名字。
 *
 * 烘焙要的正是这八个（`hip` / `knee` / `ankle` / `toe` × 左右），
 * 少一根就整条烘焙返回 null。
 */
export const SURVIVOR_LEG_BONE_NAMES = [
  'mixamorigLeftUpLeg',
  'mixamorigLeftLeg',
  'mixamorigLeftFoot',
  'mixamorigLeftToeBase',
  'mixamorigRightUpLeg',
  'mixamorigRightLeg',
  'mixamorigRightFoot',
  'mixamorigRightToeBase',
] as const;

/**
 * 造一副**与真素材同形**的骨架：
 * `char → hips → UpLeg → Leg → Foot → ToeBase`，左右各一条。
 *
 * 返回的 `char` 上**只有骨**——要网格的话自己加
 * （网格只影响 `autoScaleToHeight()` 量到的身高，不影响骨）。
 */
export function buildSurvivorSkeleton(): Object3D {
  const char = new Object3D();
  const hips = new Bone();
  hips.name = 'mixamorigHips';
  hips.position.set(...SURVIVOR_HIPS.position);
  hips.quaternion.set(...SURVIVOR_HIPS.quaternion);
  char.add(hips);

  for (const side of ['Left', 'Right'] as const) {
    const r = SURVIVOR_LEG_RIG[side];
    const up = new Bone();
    up.name = `mixamorig${side}UpLeg`;
    up.position.set(r.hipT[0], r.hipT[1], r.hipT[2]);
    up.quaternion.set(r.hipR[0], r.hipR[1], r.hipR[2], r.hipR[3]);
    hips.add(up);

    const leg = new Bone();
    leg.name = `mixamorig${side}Leg`;
    leg.position.set(0, SURVIVOR_THIGH, 0);
    leg.quaternion.set(r.legR[0], r.legR[1], r.legR[2], r.legR[3]);
    up.add(leg);

    const foot = new Bone();
    foot.name = `mixamorig${side}Foot`;
    foot.position.set(0, SURVIVOR_SHIN, 0);
    foot.quaternion.set(r.footR[0], r.footR[1], r.footR[2], r.footR[3]);
    leg.add(foot);

    const toe = new Bone();
    toe.name = `mixamorig${side}ToeBase`;
    toe.position.set(0, SURVIVOR_TOE, 0);
    toe.quaternion.set(r.toeR[0], r.toeR[1], r.toeR[2], r.toeR[3]);
    foot.add(toe);
  }
  return char;
}
