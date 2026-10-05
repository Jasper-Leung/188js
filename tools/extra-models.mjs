/**
 * 外部补充资产清单 —— 两个工具脚本（贴图压缩 / 几何优化）共用这一份。
 *
 * ## 为什么要单独一张表
 *
 * 这四个模型**不是源项目 `no188` 自带的**，是后来补进来的，
 * 而且它们的定位和源资产完全不同：
 *
 *   · 松树 —— 源项目那株行道树 **35,461 三角面 / 棵**，简化压不动
 *     （ratio 0.02、error 0.15、lockBorder 全试过，32,924 面是硬底）。
 *     这一株是 **6 棵树合在一个网格里、45,201 面，折合 7,534 面/棵**，
 *     便宜 4.7 倍，正好补上"整条环线只有 49 棵树"这个洞。
 *   · 竹 —— 18,444 面，成丛放，给「左上方」换一种植物，免得一路都是松。
 *   · 两栋现代建筑 —— 代表**已经被开发过的地方**，放在「右下方」，
 *     和环线上其余"没人来过的乡野"形成对照。
 *
 * ## 为什么走同一套管道
 *
 * 直接把原文件丢进 `public/models/` 有两个问题：
 * 一是没压过贴图（pine 的 basecolor 有 356KB）；
 * 二是没简化几何（modern house **143,984 面**，一个地标吃掉整个低档预算）。
 * 所以它们和源资产走同一条 `compress-textures` → `optimize-assets` 流程。
 *
 * ## 命名
 *
 * 源文件名带 `+` 和 `3d+model` 这类后缀，是下载站的命名，不是游戏里的命名。
 * 这里统一在 `dst` 里改成短名，代码里只认短名。
 */

/** 补充资产的源目录（和 SRC_MODELS 一样是机器相关的硬编码，见各脚本） */
export const SRC_EXTRA = 'D:/code/20260920';
/** 角色与滑板在另一个目录（`modelbone`），文件名也不同 */
export const SRC_BONE = 'D:/code/20261001/modelbone';
/**
 * `modelbone/vehicle_switch` —— 载具切换系统那个项目的模型目录。
 *
 * 自行车、摩托车、以及**带 9 段动画**的人物都在这里，而不是 `modelbone` 根下：
 * `modelbone` 根下那份是 3 段动画的 `survivor_rigged_v2.glb`（run / walk / 骑自行车），
 * 停在那儿不动的时候只能露出 bind pose —— 也就是**张开双臂的站姿**，
 * 而那是游戏的第一帧。`vehicle_switch` 里的 `survivor_rigged_v2_fullanim.glb`
 * 由 `tools/merge-anim.mjs` 合入了 6 段（clap / surf / dig / jump / **idle** / **wait**），
 * 待机终于有动作可播。
 */
export const SRC_VEHICLE = 'D:/code/20261001/modelbone/vehicle_switch/public/models';
/** 摩托车载具（`motocycleriding` 演示项目导出的那台车） */
export const SRC_MOTO = 'D:/code/20261001/motocycleriding';

/**
 * `[源文件名, 输出短名, 贴图边长, 需要拆簇?, 裁底部比例, 源目录?]`
 * 贴图边长：768 = 量产道具（单株在屏幕上不超过百来像素），
 * 1024 = 地标 / 玩家全程盯着的东西（载具、角色）。
 *
 * 第四项 `split`：这个模型**一棵网格里排了多棵树**
 * （`pine+trees+3d+model.glb` 是 6 棵，X 方向顶点直方图有六个峰）。
 * 不拆的话 6 棵共用一个实例、**共用一个 Y**，而整丛宽 26m，
 * 地形在这段距离里起伏明显——结果就是有的悬空、有的半埋。
 * 拆完之后每棵各自取地形高度，株距与株高也解绑了。
 * 拆法见 `tools/split-glb.mjs`。
 */
export const EXTRA_MODELS = [
  ['pine+trees+3d+model.glb', 'pine.glb', 768, true, 0],
  // 竹子要**裁掉底部 35%**：整株插进地里当竹丛，地下那一截永远看不见，
  // 而它是实打实每帧都在算的面。裁掉之后 18,444 → 4,265 面（剩 23%），
  // 省下的预算直接换成数量——密度是玩家看得见的，地下那一截不是。
  ['bamboo+stalks+3d+model.glb', 'bamboo.glb', 768, false, 0.35],
  ['modern+building+3d+model.glb', 'mod_tower.glb', 1024, false, 0],
  ['modern+circular+house+3d+model.glb', 'mod_house.glb', 1024, false, 0],
  // 滑板：42,600 面 / 归一化 0.973×0.121×0.711。
  // `skate_glide/README.md` 写明板身的 31.7° 偏航**已经烘进 GLB**，
  // 所以运行时**不要**再补一次 modelYawFix——补了就会歪 31.7°。
  // 轮子节点名是 wheel_FL / wheel_FR / wheel_RL / wheel_RR，绕**本地 Z**自转。
  ['skate_glide/skateboard+3d+model.glb', 'skateboard.glb', 1024, false, 0, SRC_BONE],
  // 角色：**9 段动画**（`survivor_rigged_v2_fullanim.glb`），
  // 86 骨 / 59,956 顶点 / 51,423 面，归一化高 1.0。
  // 片段：run · walk · 骑自行车 · clap · surf · dig · jump · **idle** · **wait**。
  //
  // 换这一版是为了**待机**：上一版只有 3 段（run / walk / 骑自行车），
  // 而 `Vehicle.updateFootAnim()` 在速度归零时把两条轨的权重都清零，
  // 于是停下来露出的是 bind pose —— 游戏第一帧就是**张开双臂的站姿**。
  // 有 `idle` 之后那一句"待机权重 0"才有地方可去。
  // 贴图 1024：玩家全程盯着这个人。
  ['survivor_rigged_v2_fullanim.glb', 'survivor.glb', 1024, false, 0, SRC_VEHICLE],
  //
  // 自行车：25 个零件 / 175,178 顶点 / **184,433 面**，21 张贴图共 15.1MB。
  // 原始包围盒（未缩放）长 0.9796 × 高 0.6588 × 宽 0.3746。
  // ⚠ 车头方向**不要照抄节点平移**：前轮 x=−0.3114、后轮 x=+0.2874 看着像车头在 −X，
  //   但实机 `chase` 侧视图里车是**横着的**，证明车头本来就在 **−Z**，
  //   而 −Z 正是本作前进方向 ⇒ `BICYCLE_YAW = 0`。以渲染为准（见 vehicle.ts 的 MODEL_HEADS）。
  // 轮半径实测 0.1947（`tripo_part_0` 圆度 5%，`tripo_part_2` 圆度 6%，
  // 而车架大三角圆度 27% 被正确挡在外面）。
  // 贴图 1024：玩家骑的是它，离镜头最近。
  ['bicycle_clean.glb', 'bicycle.glb', 1024, false, 0, SRC_VEHICLE],
  // 摩托车：**Tripo 导出**，69 个 `tripo_part_N` 静态网格，**无骨骼无动画**，
  // 骑手与车体焊死在同一批零件里（所以这个模式下共享角色必须藏起来）。
  // 原始 24.4MB / 381,656 顶点 / **376,765 面** / **207 张贴图**。
  // 原始包围盒 0.6111 × 0.9803 × 0.9783，**车头在 +Z**
  // （前轮 `tripo_part_0` z=+0.344，后轮 `tripo_part_1` z=−0.299，轴距 0.643）。
  //
  // 贴图压到 **512**：207 张各带一张 baseColor，1024 的话光贴图就 20MB 上下，
  // 比原图还大。几何那边另给一档更狠的简化（见 optimize-assets.mjs 的 JOBS）。
  ['motorcycle_rider.glb', 'motorcycle.glb', 512, false, 0, SRC_VEHICLE],
];

/** 需要拆簇的模型 → 拆分后输出的短名。 */
export function splitTargetName(dst) {
  return dst.replace(/\.glb$/, '_split.glb');
}

/** 需要裁底部的模型 → 裁完输出的短名。 */
export function trimTargetName(dst) {
  return dst.replace(/\.glb$/, '_trim.glb');
}

/**
 * 量产道具：同一个网格重复几十次，单个在屏幕上不超过百来个像素。
 *
 * 简化误差是**相对包围盒**的，对着一栋 15m 的驿楼是"肉眼无差别"，
 * 对着一株 10m 的树同样"无差别"——但性价比差得远。
 *
 * **这里曾经有一个不生效的 bug**：`MASS_MODELS` 在 `optimize-assets.mjs`
 * 里声明了却从没被 `JOBS` 读过，树和灌木一直按地标阈值简化。
 *
 * 用**前缀**匹配而不是精确名，是为了 `_split` 变体自动继承同一档——
 * 否则拆出来的松树会因为名字对不上而偷偷回到地标的阈值。
 */
const MASS_BASES = ['tree', 'bush', 'pine', 'bamboo'];
export function isMassModel(name) {
  const base = name.replace(/\.glb$/, '').replace(/_split$/, '');
  return MASS_BASES.includes(base);
}
export const MASS_MODEL_NAMES = new Set(['tree.glb', 'bush.glb', 'pine.glb', 'bamboo.glb']);
