/**
 * 植被与景物一族 —— **树要站在地上，而且要站在该站的地方**。
 *
 * ## 为什么这一族单独成文件
 *
 * 它原来住在 `entry.ts` 里，四条判据（落地偏移、密度、分块剔除、景物摆放）
 * 共 526 行，而那个文件已经九千多行了。放在一起的后果不是"文件大"，
 * 是**没人愿意再往里加东西**：改一处要在一个巨大的文件里定位上下文，
 * 于是能不改就不改，能不写就不写。
 *
 * ## 这一族守的是同一条主线：模型摆得**像**长在那儿
 *
 * · `verify_veg_ground` —— 原型是 `pos.y = 地形高度`，而实例矩阵的 y 是
 *   模型原点的高度。源项目的 GLB 里树与灌木的原点都不在底面，
 *   于是底下半个身子插进土里——画面上它读作"草丛矮了一截"，
 *   没人会想到是落地规则错了。
 * · `verify_veg_density` / `verify_veg_cull` —— 密到看不见路、
 *   或者分块剔除把站在眼前的那片也剔了，都是"世界没成形"的观感。
 * · `verify_scenery` —— 景物必须贴路、必须避开站名标签的位置。
 *
 * 四条判据各自会红的做法都写在各自的注释里。
 */
import { BufferAttribute, BufferGeometry, InterleavedBuffer, InterleavedBufferAttribute } from 'three';
import { expect, type CheckFn } from './harness';
import { CENTERLINE, STATIONS } from '../data/route';
import { PRESETS } from '../core/settings';
import { ROAD } from '../data/raw';
import { WATER_LEVEL } from '../world/basins';
import type { Tier } from '../core/capability';
import { bottomOf, chunkVisibility, groundOffsetFor, STATION_TREE_CLEAR_R, Vegetation } from '../world/vegetation';
import { distToRoad, Scenery, sceneryPlacements, scenerySpec, type SceneryKind } from '../world/scenery';
import { Terrain } from '../world/terrain';

/** 碎片「琴」对应的驿站序号（琴音林）。回归要用它量那片林子的密度。 */
const ZITHER_STATION_IDX = STATIONS.findIndex((s) => s.def.fragment === '琴');

/** 由 `entry.ts` 在原位调用一次，见文件头。 */
export function registerSceneryChecks(check: CheckFn): void {
  /**
   * 树和灌木必须**底面**站在地面上，而不是**原点**站在地面上。
   *
   * 原型是 `pos.y = 地形高度`，而实例矩阵的 y 是模型原点的高度。
   * 源项目的 GLB 里树与灌木的原点都不在底面，于是底下半个身子插进土里——
   * 而画面上它读作"草丛矮了一截"，没人会想到是落地规则错了。
   *
   * 三条断言各自会红的做法都写在下面。
   */
  check('verify_veg_ground', () => {
    let asserts = 0;
    const probs: string[] = [];

    // 1. 方向：模型原点低于底面（minY < 0）时，偏移必须为正——往上抬。
    //    写反成 `+bboxMinY` 会把树整个沉进地里，比原 bug 更糟。
    asserts++;
    const sunk = groundOffsetFor(-1.2, 1, 8);
    if (sunk <= 0) probs.push(`模型原点低于底面时偏移为 ${sunk}，应当为正（往上抬）`);

    // 2. 随缩放变化：树是逐株 6~9 倍，灌木是 4 倍乘 0.5~1。
    //    固定偏移只对其中一种正确——那正是原型（yOffset 恒为 0）的问题。
    asserts++;
    if (Math.abs(groundOffsetFor(-1, 1, 6) - 6) > 1e-9 || Math.abs(groundOffsetFor(-1, 1, 9) - 9) > 1e-9) {
      probs.push('偏移没有随实例缩放变化');
    }
    asserts++;
    if (Math.abs(groundOffsetFor(-0.5, 4, 1) - 2) > 1e-9) probs.push('偏移没有乘上模型缩放');

    // 3. 原点就在底面时不该动；退化输入不许把整片植被抬上天
    asserts++;
    if (Math.abs(groundOffsetFor(0, 1, 8)) > 1e-9) probs.push('模型原点就在底面时偏移不为 0');
    asserts++;
    for (const bad of [NaN, Infinity, -Infinity]) {
      if (groundOffsetFor(bad, 1, 8) !== 0) probs.push(`退化输入 ${bad} 得到了非零偏移 ${groundOffsetFor(bad, 1, 8)}`);
    }

    // 4. **交错属性**——这一条是「路边从来没有树」的守护。
    //
    //    原实现遍历 `pos.array` 并按 `itemSize` 跨步，那只对**独立数组**成立。
    //    而这些模型（NORMAL + POSITION + TEXCOORD_0 共用一个 buffer）的
    //    属性是交错的，跨步会把法线和 UV 当成 Y 读进来：
    //    实测树的实例 Y 落到 **+949,141 米**，被视锥剔除，一次都不画。
    //
    //    下面造一个真的交错 BufferAttribute 来复现——**用非交错的那种测不出来**。
    asserts++;
    {
      // 每个顶点 8 个 float：normal(3) + position(3) + uv(2)
      const n = 4;
      const stride = 8;
      const data = new Float32Array(n * stride);
      for (let i = 0; i < n; i++) {
        const o = i * stride;
        data[o + 0] = 0; // normal.x
        data[o + 1] = 9e9; // normal.y
        data[o + 2] = 0; // normal.z
        data[o + 3] = i * 0.25; // position.x
        data[o + 4] = 100 + i * 2; // position.y ← 真正的底面是 100，不是 0
        data[o + 5] = 0; // position.z
        data[o + 6] = 5e8; // uv.x
        data[o + 7] = 5e8; // uv.y
      }
      // 真实形态是 `InterleavedBuffer`：三种属性共用一块数组、stride 8。
      // **不能拿 `new BufferAttribute(data, 3, 8)` 冒充**——那个第三个参数
      // 是 normalized（布尔），写 8 会在运行时报错，测的就不是同一件事了。
      const buf = new InterleavedBuffer(data, stride);
      const inter = new InterleavedBufferAttribute(buf, 3, 3); // offset 3 = POSITION
      const g = new BufferGeometry();
      g.setAttribute('position', inter);
      const b = bottomOf(g);
      // 旧的跨步循环在这份数据上读到的是 index 3i+1：
      // 9e9 / position.y / uv.y / vertex1.normal.z(=0) …… 最小值落在 **0**，
      // 于是它把模型当成"底面在原点"——而真实底面是 100。
      // 差 100m，×缩放 27 就是 2.7km，正是"树飘到天上"的量级。
      if (Math.abs(b - 100) > 1e-6) probs.push(`交错属性读出底面 ${b}，应为 100（跨步把法线/UV 当成了 Y）`);
    }

    // 5. 非交错的老路径不能被改坏。
    asserts++;
    {
      const g = new BufferGeometry();
      g.setAttribute(
        'position',
        new BufferAttribute(new Float32Array([-1, 3, 0, 1, 0, 0, 0, 1, 0]), 3),
      );
      if (Math.abs(bottomOf(g)) > 1e-6) probs.push(`非交错属性的底面读成 ${bottomOf(g)}，应为 0`);
    }

    // 6. 一个远离本体的游离顶点不该毁掉"最低点"。
    asserts++;
    {
      const g = new BufferGeometry();
      const pts: number[] = [];
      for (let i = 0; i < 200; i++) pts.push(0, i * 0.02, 0); // 0..3.98
      pts.push(5, -35000, 5); // 唯一的游离顶点
      g.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
      const b = bottomOf(g);
      if (b < -0.01) probs.push(`游离顶点污染了底面：${b}（应为 0 附近）`);
    }

    // 7. 空几何退化成 0，而不是抛。
    asserts++;
    {
      const g = new BufferGeometry();
      if (bottomOf(g) !== 0) probs.push('空几何的底面不为 0');
    }

    return expect(
      probs.length === 0,
      probs.length ? probs.join('；') : '底面落地，偏移随缩放，方向为正',
      asserts,
    );
  });

  // ---------------------------------------------------------------- 植被密度
  /**
   * 路**两边必须有树**。
   *
   * ## 这条为什么存在
   *
   * 实机截屏里出现过的样子：一条光秃秃的柏油路，两侧是纯绿色山坡，
   * 一棵树都没有——而那是**高档**。数出来才发现：
   *
   *   | 档位 | 全环线树 | 灌木 | 起点 60m 内 |
   *   |---|---|---|---|
   *   | 低 | 13 | 37 | 2 / 2 |
   *   | 中 | 49 | 111 | 6 / 11 |
   *   | 高 | 49 | 111 | 6 / 11 |
   *
   * 1228.8m 的环线一共 49 棵树（25m 株距、左右错开 = 每侧 50m 一株）。
   * 真实的乡村公路行道树是**每侧 15~25m 一株**，
   * 也就是说这里的密度只有真实值的三分之一，而截图上读起来就是"高速公路"。
   *
   * 根因是一株树 **35,461 个三角面**，简化压不动（详见 vegetation.ts 的注释）。
   *
   * ## 换完低模松树之后
   *
   * `pine.glb` 一丛 6 棵、31,219 面（5,203 面/棵），株距从 25m 收到 17m，
   * 于是全环线 **72 丛 = 434 株**，起点 60m 内从 6 株变成 30 株。
   * 断言记的是**株数**（丛数 × `TREES_PER_COPE`），因为那才是玩家看见的东西。
   */
  check('verify_veg_density', () => {
    let asserts = 0;
    const probs: string[] = [];

    const terrain = new Terrain();
    // `Placement` 没有导出（它是 vegetation.ts 的模块内类型），
    // 这里只用到 x/z 两个字段，所以就地写结构类型而不是把它导出——
    // 为了让一条断言能跑就把模块的内部形状变成公共 API，不划算。
    type P = { x: number; z: number };
    const counts: {
      tier: number;
      tree: number;
      nearTree: number;
      bush: number;
      variants: number;
      minRoad: number;
      minBury: number;
    }[] = [];
    for (let tier = 0 as Tier; tier <= 2; tier = (tier + 1) as Tier) {
      const veg = new Vegetation(PRESETS[tier], terrain);
      const chunks = (veg as unknown as { chunks: { tree: (P & { variant: number; bury: number })[]; bush: P[] }[] }).chunks;
      let tree = 0;
      let bush = 0;
      let nearTree = 0;
      const variants = new Set<number>();
      const s0 = STATIONS[0];
      for (const c of chunks) {
        tree += c.tree.length;
        bush += c.bush.length;
        for (const p of c.tree) {
          variants.add(p.variant);
          if (Math.hypot(p.x - s0.mapX, p.z - s0.mapZ) < 60) nearTree++;
        }
      }
      // 最近的一棵树离中心线多远 ——「树不许压在路面上」这条硬约束的实测值
      let minRoad = Infinity;
      // 最小的埋地深度 ——「松树不悬空」那条
      let minBury = Infinity;
      for (const c of chunks) {
        for (const p of c.tree) {
          minRoad = Math.min(minRoad, distToRoad(p.x, p.z));
          minBury = Math.min(minBury, p.bury);
        }
      }
      counts.push({ tier, tree, nearTree, bush, variants: variants.size, minRoad, minBury });
    }

    // 1. 每档全环线至少 120 株。低于这个数，1228m 的路就是"两旁没东西"，
    //    而玩家一进世界看到的就是前 60m。
    asserts++;
    for (const c of counts) {
      if (c.tree < 120) probs.push(`第 ${c.tier} 档全环线只有 ${c.tree} 株树`);
    }

    // 2. 起点 60m 内至少 24 株 —— 开局第一眼。
    asserts++;
    for (const c of counts) {
      if (c.nearTree < 12) probs.push(`第 ${c.tier} 档起点 60m 内只有 ${c.nearTree} 株树`);
    }

    // 3. **变体要真的被用到**：拆分出的 6 棵如果只用到 1 棵，
    //    画面上仍是同一个模型复制 N 遍 —— 那是"看起来有树"而不是"有树林"。
    asserts++;
    for (const c of counts) {
      if (c.variants < 4) probs.push(`第 ${c.tier} 档只用到 ${c.variants} 个树变体（拆了 6 棵）`);
    }

    // 4. **树不许压在路面上**：路面总半宽 6.5m，树冠半径最坏 8.1m，
    //    所以树干中心离中心线必须 ≥ 14.6m。
    //    这一条是硬约束：画面上一眼能看出"树枝搭在沥青上"，
    //    而回归不钉住它，下一次调株距就会被改回去。
    asserts++;
    for (const c of counts) {
      if (c.minRoad < 14.6) {
        probs.push(`第 ${c.tier} 档最近的一棵树离中心线只有 ${c.minRoad.toFixed(1)}m（应 ≥14.6）`);
      }
    }

    // 5. **每棵都要往地里埋一点** ——「松树不悬空」这条用户要求。
    //
    //    `terrain.getHeightAt()` 是**点采样**：它给的是树干中心那一柱的高度，
    //    而地形在树根那 0.5m 直径内是有坡度的。树根正好坐在坡的上沿时，
    //    下坡那一侧会露出缝 —— 读作"树浮在地面上"。
    //    埋一点就把这个缝吃掉；代价是树看起来矮一点点，**而没有人会数树有多高**。
    asserts++;
    for (const c of counts) {
      if (c.minBury <= 0) probs.push(`第 ${c.tier} 档有树完全没往地里埋（bury=${c.minBury}），根下会露缝`);
    }

    // 6. 灌木同理，但门槛低一档：它是补空地的，不是主景。
    asserts++;
    for (const c of counts) {
      if (c.bush < 80) probs.push(`第 ${c.tier} 档全环线只有 ${c.bush} 丛灌木`);
    }

    // 7. 密度不得再随档位断崖式下跌：低档砍的是**半径**，不是株数。
    //    半径已经能把看不见的那些块剔掉，再砍株数就是两次砍同一刀。
    asserts++;
    const low = counts[0];
    const high = counts[2];
    if (low.tree * 2 < high.tree) {
      probs.push(`低档 ${low.tree} 株不足高档 ${high.tree} 株的一半：密度与半径被重复扣了一次`);
    }

    // 8. **树不许种在驿站身上** ——「琴音林让位圈」那条。
    //
    //    这条不是审美数字。驿站在中心线外 18m，行道树横向偏移下限 16m，
    //    **两者在同一条带上**：让位圈加进来之前，琴音林最近的一株树
    //    离站中心只有 5.7m——树是从林冠地块里穿出来的，
    //    读作"林子里戳了一根杆子"，而不是一棵树。
    //
    //    会红的做法：把 `STATION_TREE_CLEAR` 调到 0 / 去掉 `insideStationClear`
    //    那一行 → 琴音林立刻回到 5.7m，红。
    asserts++;
    for (const tier of [0, 1, 2] as Tier[]) {
      const veg = new Vegetation(PRESETS[tier], terrain);
      const chunks = (veg as unknown as { chunks: { tree: P[] }[] }).chunks;
      for (const s of STATIONS) {
        let worst = Infinity;
        for (const c of chunks) {
          for (const p of c.tree) worst = Math.min(worst, Math.hypot(p.x - s.x, p.z - s.z));
        }
        if (worst < 14) {
          probs.push(`第 ${tier} 档 ${s.def.name} 最近的树离站只有 ${worst.toFixed(1)}m，树种在站上了`);
        }
      }
    }

    // 9. **让位圈半径不许被改小** + 琴音林那圈确实空出来了。
    //
    //    为什么不写"40m 内 ≤N 株"：那个 N 得拍，而株数还受株距、
    //    档位、hash 落点影响，改一次别处它就漂——一条会漂的断言
    //    要么被人放宽到没意义，要么半夜自己红了。这里直接守**半径**
    //    （被改小 → 红），再守一个**实测得到**的最近距离。
    //
    //    实测：让位圈加进来之前琴音林最近的一株树离站 5.7m（种在模型里），
    //    之后是 24.5m。判据卡在 14m —— 站脚半宽 8 + 树冠半径最坏 8.1 ≈ 16，
    //    取 14 留一点余量，同时仍高于"零让位"时的 5.7m 足够多。
    asserts++;
    if (STATION_TREE_CLEAR_R < 16) {
      probs.push(`驿站让位半径只有 ${STATION_TREE_CLEAR_R}m，应 ≥16m（站脚半宽 8 + 树冠半径最坏 8.1）`);
    }
    {
      const zither = STATIONS[ZITHER_STATION_IDX];
      const veg = new Vegetation(PRESETS[2], terrain);
      const chunks = (veg as unknown as { chunks: { tree: P[] }[] }).chunks;
      let nearest = Infinity;
      let near40 = 0;
      for (const c of chunks) {
        for (const p of c.tree) {
          const d = Math.hypot(p.x - zither.x, p.z - zither.z);
          if (d < 40) near40++;
          nearest = Math.min(nearest, d);
        }
      }
      if (nearest < 14) {
        probs.push(`琴音林最近的行道树离站只有 ${nearest.toFixed(1)}m（让位前是 5.7m），让位圈没生效`);
      }
    }

    const summary = counts
      .map((c) => `档${c.tier} ${c.tree}株/起点${c.nearTree}/变体${c.variants}/最近${c.minRoad.toFixed(1)}m`)
      .join(' · ');
    return expect(probs.length === 0, probs.length ? probs.join('；') : summary, asserts);
  });

  // ---------------------------------------------------------------- 植被剔除
  /**
   * 剔除必须按**几何距离**判，不能拿弧长差当距离。
   *
   * ## 原来错在哪
   *
   * `Vegetation.update` 原来是 `|块号 − 玩家块号| × CHUNK_LEN <= 半径`。
   * 这只在"路是一条不自交的曲线"时成立，而这个世界是 **8 字**：
   * 中心线被自己穿过 4 次，两条支路在交叉口**物理重合**
   * （实测中心线 #0 与 #480 相距 0.0m），弧长上却隔着整整半个环。
   *
   * 玩家实机看到的症状是：**在十字路口原地转圈，树木（以及路边的建筑）
   * 不断隐藏又显示。** 两条原因都在下面各占一条断言：
   *
   *   1. 站在路口时，`cur` 落在其中一条支路上，于是**另一条支路上贴脸的树
   *      被判成 612m 外**而剔掉 —— 半径内出现一个"树洞"。
   *   2. 原地转圈时车身会漂，`nearestChunkT` 在两条支路之间反复跳，
   *      `cur` 在 #0 与 #51 之间来回翻，**整片树线一帧一变**。
   *
   * 两条都是"同一条判据在自交环线上失效"的症状，所以守它要守**两遍**：
   * 只守洞，守不住闪；只守闪，守不住停在那儿就不动的洞。
   *
   * `chunkVisibility` 是从 `update()` 里抽出来的纯函数（判定本身不依赖
   * GLB，无头环境直接能调），回归守的就是它。
   */
  check('verify_veg_cull', () => {
    let asserts = 0;
    const probs: string[] = [];

    const terrain = new Terrain();
    type P = { x: number; z: number };
    type C = { index: number; cx: number; cz: number; treeOuter: number; bushOuter: number; tree: P[]; bush: P[] };
    const veg = new Vegetation(PRESETS[2], terrain);
    const chunks = (veg as unknown as { chunks: C[] }).chunks;

    // 找路口：中心线上每个点，看它离"线上其它点"最近有多近——
    // 两条支路互相靠近的地方，那个最近距离就小（自交处为 0）。
    const crossings: { i: number; d: number; x: number; z: number }[] = [];
    for (let i = 0; i < CENTERLINE.length; i += 4) {
      const p = CENTERLINE[i];
      let best = Infinity;
      for (let j = 0; j < CENTERLINE.length; j += 4) {
        if (Math.abs(i - j) < 60) continue;
        best = Math.min(best, Math.hypot(p.x - CENTERLINE[j].x, p.z - CENTERLINE[j].z));
      }
      if (best < 30) crossings.push({ i, d: best, x: p.x, z: p.z });
    }

    // 0. 8 字必须真的自交，否则下面两条断言守的是一个不存在的场景。
    asserts++;
    if (!crossings.length) probs.push('中心线上找不到自交点，判据的前提不成立');

    const R = PRESETS[2].treeRadius;
    const B = PRESETS[2].bushRadius;

    // 1. **路口不许出现"树洞"**：半径内的每一株都必须可见。
    //
    //    原实现在路口会把另一条支路上 6~49m 的块整片剔掉，
    //    所以这条在改动前必然红（实测最坏一处 8 块在 60m 内被剔）。
    asserts++;
    {
      let worstTree = 0;
      let worstBush = 0;
      let at = '';
      for (const c of crossings) {
        const vis = chunkVisibility(chunks, c.x, c.z, R, B);
        for (let k = 0; k < chunks.length; k++) {
          if (vis.tree[k]) continue;
          for (const p of chunks[k].tree) {
            const d = Math.hypot(p.x - c.x, p.z - c.z);
            if (d <= R && d > worstTree) { worstTree = d; at = `树@${d.toFixed(0)}m`; }
          }
          if (vis.bush[k]) continue;
          for (const p of chunks[k].bush) {
            const d = Math.hypot(p.x - c.x, p.z - c.z);
            if (d <= B && d > worstBush) worstBush = d;
          }
        }
      }
      if (worstTree > 0) probs.push(`路口有 ${at} 的树被剔掉（树半径 ${R}m）`);
      if (worstBush > 0) probs.push(`路口有 ${worstBush.toFixed(0)}m 的灌木被剔掉（灌木半径 ${B}m）`);
    }

    // 1b. **全线**同一判据：不许在任何地方剔掉半径内的树。
    //     路口只是最容易犯的地方，但整条线上每一处都得过。
    asserts++;
    {
      let worst = 0;
      let worstAt = '';
      for (let f = 0; f < 400; f++) {
        const p = CENTERLINE[Math.round((f / 400) * (CENTERLINE.length - 1))];
        const vis = chunkVisibility(chunks, p.x, p.z, R, B);
        for (let k = 0; k < chunks.length; k++) {
          if (vis.tree[k]) continue;
          for (const q of chunks[k].tree) {
            const d = Math.hypot(q.x - p.x, q.z - p.z);
            if (d <= R && d > worst) { worst = d; worstAt = `#${f}`; }
          }
        }
      }
      if (worst > 0) probs.push(`全线采样 400 点，${worstAt} 处有 ${worst.toFixed(0)}m 的树被剔掉`);
    }

    // 2. **原地转圈不得让可见集跳动**。
    //
    //    这是用户报的那条：路口站定后小幅漂移（转向时的横向位移量级），
    //    可见块集合必须完全不变。原来会在两条支路之间翻，整片树线一帧一变。
    asserts++;
    {
      let flips = 0;
      let lost = 0;
      for (const c of crossings) {
        const ref = chunkVisibility(chunks, c.x, c.z, R, B);
        // 1.5m 圈上取 24 个采样点 = 转向时车身的横向漂移量级
        for (let k = 0; k < 24; k++) {
          const a = (k / 24) * Math.PI * 2;
          const v = chunkVisibility(chunks, c.x + Math.cos(a) * 1.5, c.z + Math.sin(a) * 1.5, R, B);
          for (let j = 0; j < chunks.length; j++) {
            if (ref.tree[j] && !v.tree[j]) lost++;
            if (ref.tree[j] !== v.tree[j]) flips++;
          }
        }
      }
      if (flips > 0) probs.push(`路口 ±1.5m 漂移让可见集翻转了 ${flips} 次（转圈时树线会闪）`);
      if (lost > 0) probs.push(`路口 ±1.5m 漂移让 ${lost} 块原本可见的树消失`);
    }

    // 3. **判定必须随位置连续**：沿中心线每米走一步，
    //     新点亮的树数不许超过一小步能解释的量（一步只可能多出相邻块）。
    //     这条守的是"半径判定本身没写反"，与路口无关。
    asserts++;
    {
      let worstStep = 0;
      let worstAt = '';
      for (let f = 0; f < 400; f++) {
        const p = CENTERLINE[Math.round((f / 400) * (CENTERLINE.length - 1))];
        const q = CENTERLINE[Math.round((f / 400) * (CENTERLINE.length - 1)) + 1] ?? p;
        const a = chunkVisibility(chunks, p.x, p.z, R, B);
        const b = chunkVisibility(chunks, q.x, q.z, R, B);
        let added = 0;
        for (let j = 0; j < chunks.length; j++) if (!a.tree[j] && b.tree[j]) added++;
        // 中心线相邻两点约 1.28m（1228.8m / 961 点），
        // 一步能跨进的块数上界 = 步长/CHUNK_LEN + 1
        const cap = Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / 12) + 1;
        if (added > worstStep) { worstStep = added; worstAt = `#${f}`; }
        if (added > cap) probs.push(`${worstAt} 一步点亮了 ${added} 块，超过上限 ${cap}`);
      }
      void worstStep;
    }

    const summary = `路口 ${crossings.length} 处，半径内无死树，±1.5m 漂移可见集不变`;
    return expect(probs.length === 0, probs.length ? probs.join('；') : summary, asserts);
  });

  check('verify_scenery', () => {
    let asserts = 0;
    const probs: string[] = [];

    const terrain = new Terrain();
    const sc = new Scenery(terrain);
    const all = sceneryPlacements(sc);

    const kinds: SceneryKind[] = ['bamboo', 'mod_tower', 'mod_house'];
    for (const kind of kinds) {
      const sp = scenerySpec(kind);
      const [sx, sz] = sp.quad;
      const pts = all[kind];

      // 1. 摆满了没有。摆不满说明判定条件太苛刻——玩家那一角就空了。
      asserts++;
      if (pts.length < sp.max) probs.push(`${kind} 只摆了 ${pts.length}/${sp.max} 个`);

      // 2. **象限**。这是这一族的全部意义，放错象限等于没做。
      asserts++;
      const wrong = pts.filter((p) => sx * p.x < 8 || sz * p.z < 8);
      if (wrong.length) probs.push(`${kind} 有 ${wrong.length} 个落在象限外（首例 ${wrong[0].x.toFixed(0)},${wrong[0].z.toFixed(0)}）`);

      // 3. 不在水下。
      asserts++;
      const wet = pts.filter((p) => p.y < WATER_LEVEL + 0.6);
      if (wet.length) probs.push(`${kind} 有 ${wet.length} 个在水里`);

      // 4. 离路**落在区间内**。下限是别压路；上限是"玩家看得见"——
      //    这条是踩过坑才有的：最初没有上限，候选从象限角落开始贪心填，
      //    结果竹子全落在离路 460m 处，而雾距上限才 400m，一辈子看不见。
      asserts++;
      const offRoad = pts.filter((p) => {
        const d = distToRoad(p.x, p.z);
        return d < sp.road[0] || d > sp.road[1];
      });
      if (offRoad.length) probs.push(`${kind} 有 ${offRoad.length} 个离路不在 ${sp.road[0]}~${sp.road[1]}m 内`);

      // 5. 不骑在驿站上。
      asserts++;
      const onStation = pts.filter((p) => STATIONS.some((s) => Math.hypot(p.x - s.mapX, p.z - s.mapZ) < ROAD.STATION_OFFSET));
      if (onStation.length) probs.push(`${kind} 有 ${onStation.length} 个压在驿站 keepout 里`);

      // 6. 不在陡坡上（建筑一半悬空）。
      asserts++;
      const steep = pts.filter((p) => {
        const h = terrain.getHeightAt(p.x, p.z);
        return Math.max(Math.abs(terrain.getHeightAt(p.x + 6, p.z) - h), Math.abs(terrain.getHeightAt(p.x, p.z + 6) - h)) / 6 > 0.35;
      });
      if (steep.length) probs.push(`${kind} 有 ${steep.length} 个在陡坡上`);
    }

    // 7. 两样东西**不能同象限**：竹在西北、建筑在东南，
    //    放到一起就分不出"哪边是开发区"了。这条只需验一次。
    asserts++;
    const modInNW = all.mod_tower.filter((p) => p.x < 0 && p.z < 0).length + all.mod_house.filter((p) => p.x < 0 && p.z < 0).length;
    const bamInSE = all.bamboo.filter((p) => p.x > 0 && p.z > 0).length;
    if (modInNW > 0) probs.push(`${modInNW} 栋现代建筑落到了西北`);
    asserts++;
    if (bamInSE > 0) probs.push(`${bamInSE} 丛竹落到了东南`);

    const sum = kinds.map((k) => `${k}×${all[k].length}`).join(' ');
    return expect(probs.length === 0, probs.length ? probs.join('；') : sum, asserts);
  });

  // ---------------------------------------------------------------- 视角 / 载具
}
