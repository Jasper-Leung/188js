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

/**
 * `[源文件名, 输出短名, 贴图边长, 需要拆簇?]`
 * 贴图边长：768 = 量产道具（单株在屏幕上不超过百来像素），
 * 1024 = 地标（玩家会绕着它骑）。
 *
 * 第四项 `split`：这个模型**一棵网格里排了多棵树**
 * （`pine+trees+3d+model.glb` 是 6 棵，X 方向顶点直方图有六个峰）。
 * 不拆的话 6 棵共用一个实例、**共用一个 Y**，而整丛宽 26m，
 * 地形在这段距离里起伏明显——结果就是有的悬空、有的半埋。
 * 拆完之后每棵各自取地形高度，株距与株高也解绑了。
 * 拆法见 `tools/split-glb.mjs`。
 */
export const EXTRA_MODELS = [
  ['pine+trees+3d+model.glb', 'pine.glb', 768, true],
  ['bamboo+stalks+3d+model.glb', 'bamboo.glb', 768, false],
  ['modern+building+3d+model.glb', 'mod_tower.glb', 1024, false],
  ['modern+circular+house+3d+model.glb', 'mod_house.glb', 1024, false],
];

/** 需要拆簇的模型 → 拆分后输出的短名。 */
export function splitTargetName(dst) {
  return dst.replace(/\.glb$/, '_split.glb');
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
