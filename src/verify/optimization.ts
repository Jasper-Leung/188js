/**
 * 2026-10 评测之后那一轮优化的回归。
 *
 * ## 这一族守的是什么
 *
 * 那一轮改了九件事，每一件都是**"玩家看得见、而别的判据一条都问不到"**的：
 *
 * | 改动 | 原来的症状 |
 * |---|---|
 * | 打卡圈画出来了 | 「站进光圈再按空格」——那个光圈从来不存在 |
 * | 里程经济改成按圈 | 全清预算里 376 枚（占 47%）**永远拿不到** |
 * | 乐事胜负写进心神 | 五个小游戏**没有任何赌注**，打不打没区别 |
 * | 经营面板未解锁时改口 | 六个灰按钮 + 底下写着「第一单从这里开始」 |
 * | 序章期间空格能推进 | 故事卡是定时卡，**空格按了什么都不发生** |
 * | 碎片栏写 x/3 次 | 只写「2 次」，玩家不知道上限是 3 |
 * | favicon | 每次加载一条 404 |
 * | perf 快照的两个字段 | 恒为 1 / false，**调试出口在说假话** |
 * | README 档数 | 写着四档，实现是五档 |
 *
 * 这些共同的形状是：**全绿**。
 * 旧判据全绿，界面却不对。所以这一族要么量**数值**（经济、赌注、圈的几何），
 * 要么量**结构**（源码里那几处接线在不在）——
 * 无头环境里没有排版引擎，"看得见"证不了，而"当初让它消失的那个结构还在不在"证得了。
 *
 * ## 多出来的那一条：骑行腿烘焙
 *
 * `verify_pedal_bake` 不属于上面九件事，它是补一个**本来就缺的覆盖**。
 *
 * 起因：每次跑 `npm run verify` 都会打一条
 * `[vehicle] 骑行腿烘焙失败（骨名对不上？）—— 骑手会踩在踏板旁边画圈`。
 * 查下去发现那只是**夹具**的骨不全（夹具只有 Hips / Spine / Foot / ToeBase，
 * 没有大腿小腿），真素材 `survivor.glb` 的八根骨齐全——
 * 真实 Chrome 里跑一轮，这条警告**根本不出现**。
 *
 * 但顺着查的过程中发现了一件更要紧的事：**脚踩在踏板上这条路径，
 * 此前没有任何一条判据跑过**。烘焙函数每次都返回 null，
 * 于是「脚离踏板多远」这件事既没有症状，也永远不会被看见。
 *
 * 这条判据自己造一副**和真素材同形**的腿骨（骨链偏移沿本地 +Y、
 * 大腿 0.21520 / 小腿 0.22381 照抄 GLB 里的真值），
 * 然后把烘焙后的片段重新摆一遍，量脚到底在不在踏板圆上。
 *
 * | 断言 | 退回什么写法会红 |
 * |---|---|
 * | 烘焙返回非空 | 把 `bakeRideToPedals` 改成永远返回 null → 红 |
 * | 关键帧上脚精确落在踏板圆上 | 去掉「骨向 → 本地四元数」里的父朝向换算 → 红 |
 * | 帧间偏差 ≤ 0.01 | 把关键帧密度改稀（120 键 → 24 键）→ 红 |
 * | 上下幅度正好一整圈 | 把半径算错 → 红 |
 * | 两只脚差 180° | 左右踏板共用一个圆 → 红 |
 * | 缺骨时干净返回 null | 改成抛异常 → 红 |
 *
 * ★ 骨盆的旋转轨道**故意给一个非单位阵**：父朝向要是单位阵，
 * 上面第二条就退化成恒等，判据守着的是一个恒等式。
 *
 * ## 它凭什么会红
 *
 * | 断言 | 退回什么写法会红 |
 * |---|---|
 * | 圈的半径 = `STATION_REACH` | 把 `addRing()` 里的 `R = STATION_REACH` 改成 `R = 18` → 红 |
 * | 只有五座碎片驿站有圈 | 给十一座路过站也 `addRing()` → 红 |
 * | 圈贴着地形 | 把顶点高度改成平环 → 红 |
 * | 每帧驱动 `updateRings` | 把那一行注释掉 → 红（剥了注释再找） |
 * | 圈钱前五圈各 75 | 把 `LAP_BONUS_CAP` 改成 3 → 红 |
 * | 第六圈不再发钱 | 把上限判断删掉 → 红 |
 * | `earnKm` 不存在 | 把它加回来 → 红 |
 * | 赢 +1 / 输 −1 | 把 `restoreMood` / `costMood` 调换 → 红 |
 * | 未解锁时没有按钮 | 把 `if (!locked)` 删掉 → 红 |
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AnimationClip, Bone, KeyframeTrack, Object3D, Vector3 } from 'three';
import { expect, stripComments, type CheckFn } from './harness';
import { buildSurvivorSkeleton } from './characterFixture';
import { bakeRideToPedals, PoseSampler } from '../world/pose';
import { GameStateManager } from '../game/state';
import { STATION_REACH } from '../game/phase';
import { Stations, RING_NEAR_OPACITY, RING_FAR_OPACITY, RING_SHOW_DIST, RING_WIDTH } from '../world/stations';
import { Terrain } from '../world/terrain';
import { PRESETS } from '../core/settings';
import { STATIONS, FRAGMENT_STATIONS } from '../data/route';
import { ECON, I18N, ROAD, SHOPS } from '../data/raw';
import { BUSINESSES } from '../data/business';
import { businessBlock } from '../game/business';
import { StoryCards, ResultCard } from '../ui/storyCard';
import { isShown } from '../ui/dom';
import { t } from '../i18n';
import { ShopPanel } from '../ui/shopPanel';
import { BusinessPanel } from '../ui/businessPanel';
import type { UIHooks } from '../ui';

// 回归由 `npm run verify` 跑，cwd 就是仓库根。理由同 `verify/ai.ts`。
const ROOT = process.cwd();

/** 读一份源码，**先剥注释**。理由见 `harness.ts` 的 `stripComments`。 */
const srcOf = (rel: string): string => stripComments(readFileSync(join(ROOT, rel), 'utf8'));

/** 内存存档后端。`save()` / `load()` 都包在 try/catch 里，Node 里没有 localStorage。 */
function memStore(): { read(k: string): string | null; write(k: string, v: string): void; remove(k: string): void } {
  const m = new Map<string, string>();
  return {
    read: (k) => m.get(k) ?? null,
    write: (k, v) => void m.set(k, v),
    remove: (k) => void m.delete(k),
  };
}

/** 一个顶点数为 0 的 BufferGeometry 也能量。量的是**位置**，不是渲染。 */
function ringRadii(r: { x: number; z: number; mesh: { geometry: { getAttribute(n: string): { array: ArrayLike<number>; count: number } } } }): number[] {
  const pos = r.mesh.geometry.getAttribute('position');
  const out: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.array[i * 3];
    const z = pos.array[i * 3 + 2];
    out.push(Math.hypot(x - r.x, z - r.z));
  }
  return out;
}

/**
 * 把一棵子树上的字都收集起来。
 *
 * **桩的 `textContent` 只含它自己那一份**，不像真 DOM 那样把后代串起来——
 * 所以量"屏幕上写了什么"必须自己走一遍树。
 */
function collectText(node: { textContent?: string; children?: ArrayLike<unknown> }): string {
  const out: string[] = [];
  const walk = (n: { textContent?: string; children?: ArrayLike<unknown> }): void => {
    if (typeof n.textContent === 'string' && n.textContent) out.push(n.textContent);
    const kids = n.children;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      walk(kids[i] as { textContent?: string; children?: ArrayLike<unknown> });
    }
  };
  walk(node);
  return out.join('\n');
}

export function registerOptimizationChecks(check: CheckFn, parent: () => HTMLElement): void {
  // ================================================================ 打卡圈
  /**
   * 圈是**判定**的可见化：半径必须与 `STATION_REACH` 一致，
   * 不一致的话「站进光圈再按空格」这句话就在骗人。
   */
  check('verify_checkin_ring', () => {
    let asserts = 0;
    const probs: string[] = [];
    const terrain = new Terrain();
    const stations = new Stations(PRESETS[1], terrain);

    // ---- 1. 只有碎片驿站有圈 ----
    //
    // 十一座路过站不收打卡。给它们也画圈，玩家会在不该按空格的地方
    // 看见一个圈——而按了没反应，那比没有圈更糟。
    asserts++;
    if (FRAGMENT_STATIONS.length !== 5) {
      probs.push(`碎片驿站是 ${FRAGMENT_STATIONS.length} 座，判据的前提不成立`);
    }
    asserts++;
    if (stations.rings.length !== FRAGMENT_STATIONS.length) {
      probs.push(`画了 ${stations.rings.length} 个圈，碎片驿站有 ${FRAGMENT_STATIONS.length} 座`);
    }

    // ---- 2. 半径必须正好是 `STATION_REACH` ----
    //
    // 量的是**几何**（顶点到圈心的水平距离），不是常量：
    // 把 `addRing()` 里的 `R = STATION_REACH` 改成别的数，这条立刻红。
    //
    // 容差 1mm：顶点存在 `Float32BufferAttribute` 里，float32 在 21m 那个量级
    // 上只有七位有效数字，往返一圈的误差就是 1e-6 量级。
    // 1mm 远小于「18m 与 21.5m」那种改动，放得过去。
    asserts++;
    {
      let worst = 0;
      for (const r of stations.rings) {
        const radii = ringRadii(r);
        const max = Math.max(...radii);
        worst = Math.max(worst, Math.abs(max - STATION_REACH));
      }
      if (worst > 1e-3) {
        probs.push(`圈的半径与 STATION_REACH（${STATION_REACH.toFixed(2)}m）差了 ${(worst * 100).toFixed(2)}cm——判定与提示对不上`);
      }
    }

    // ---- 3. 环宽（内外两圈）也要在 ----
    //
    // 只有一条线的话它就不是"圈"而是"射线"——玩家分不清自己在圈里还是圈外。
    asserts++;
    {
      let minD = Infinity;
      for (const r of stations.rings) {
        for (const d of ringRadii(r)) minD = Math.min(minD, d);
      }
      const expectInner = STATION_REACH - RING_WIDTH;
      if (Math.abs(minD - expectInner) > 1e-3) {
        probs.push(`环的内沿在 ${minD.toFixed(2)}m，应为 ${expectInner.toFixed(2)}m（环宽 ${RING_WIDTH}m）`);
      }
    }

    // ---- 4. 圈心就是驿站 ----
    asserts++;
    {
      let bad = '';
      for (const r of stations.rings) {
        const st = STATIONS.find((s) => Math.hypot(s.x - r.x, s.z - r.z) < 0.01);
        if (!st) bad = `有个圈心不在任何一座驿站上（${r.x.toFixed(1)}, ${r.z.toFixed(1)}）`;
        else if (!st.hasFragment) bad = `${st.def.name} 不是碎片驿站，却画了打卡圈`;
      }
      if (bad) probs.push(bad);
    }

    // ---- 5. 圈要贴着地形 ----
    //
    // 21.5m 的半径跨过去地形能差出好几米：
    // 平环的一半会埋进坡里、另一半浮在空中。
    // 所以顶点高度必须逐点取地形——这里量它离地多远。
    asserts++;
    {
      let worstLift = 0;
      let buried = 0;
      for (const r of stations.rings) {
        const pos = r.mesh.geometry.getAttribute('position');
        for (let i = 0; i < pos.count; i++) {
          const x = pos.array[i * 3];
          const y = pos.array[i * 3 + 1];
          const z = pos.array[i * 3 + 2];
          const lift = y - terrain.getHeightAt(x, z);
          worstLift = Math.max(worstLift, lift);
          if (lift < -0.01) buried++;
        }
      }
      if (buried > 0) probs.push(`圈有 ${buried} 个顶点埋进地里（低于地面 1cm 以上）`);
      if (worstLift > 0.5) probs.push(`圈最高处离地 ${worstLift.toFixed(2)}m——它浮在空中，不是画在地上`);
    }

    // ---- 6. 进圈变色，出圈变淡，远了不画 ----
    asserts++;
    {
      const r = stations.rings[0];
      if (!r) {
        probs.push('一个圈都没有，这条判据的前提不成立');
      } else {
        stations.updateRings(r.x, r.z);
        if (!r.mesh.visible) probs.push('站在圈心，圈却不可见');
        if (Math.abs(r.mat.opacity - RING_NEAR_OPACITY) > 1e-6) {
          probs.push(`圈内不透明度 ${r.mat.opacity}，应为 ${RING_NEAR_OPACITY}`);
        }
        asserts++;
        stations.updateRings(r.x + STATION_REACH + 6, r.z);
        if (Math.abs(r.mat.opacity - RING_FAR_OPACITY) > 1e-6) {
          probs.push(`圈外不透明度 ${r.mat.opacity}，应为 ${RING_FAR_OPACITY}`);
        }
        asserts++;
        stations.updateRings(r.x + RING_SHOW_DIST + 50, r.z);
        if (r.mesh.visible) probs.push(`离 ${RING_SHOW_DIST + 50}m 还在画圈——远处挂着一个 21.5m 的圈只是色斑`);
      }
    }

    // ---- 7. 接线：每帧驱动 ----
    //
    // **必须每帧**。放进 `world.ts` 那个 0.4 秒的模型加载节流里的话，
    // 进圈那一刻会迟 0.4 秒才变色——读起来就是"我明明进来了"。
    asserts++;
    {
      const src = srcOf('src/world/world.ts');
      if (!src.includes('this.stations.updateRings(')) {
        probs.push('world.ts 没有每帧驱动打卡圈');
      }
    }

    // ---- 8. 判定半径只有一个来源 ----
    asserts++;
    {
      const src = srcOf('src/world/stations.ts');
      if (!src.includes('const R = STATION_REACH')) {
        probs.push('addRing() 不再以 STATION_REACH 为半径——圈画歪了就和判定对不上');
      }
    }

    return expect(
      probs.length === 0,
      probs.length ? probs.join('；') : `五道圈，半径 ${STATION_REACH.toFixed(1)}m = 判定圈`,
      asserts,
    );
  });

  // ================================================================ 经济
  /**
   * 里程经济改成**按圈**。
   *
   * 源项目那条环线真长 188 公里，所以 `LVBI_PER_KM = 2` 走完全程是 376 枚；
   * 这一版的环线只有 1228.8 米，按公里发钱一圈才 2 枚——
   * 于是「全清 799 / 缺口 211」那个预算**从来没成立过**。
   */
  check('verify_lap_bonus', () => {
    let asserts = 0;
    const probs: string[] = [];

    // ---- 1. 每圈发一次，数额就是那个数 ----
    asserts++;
    {
      const g = new GameStateManager();
      const before = g.lvbi;
      g.noteLap();
      const got = g.lvbi - before;
      if (got !== GameStateManager.LVBI_PER_LAP) {
        probs.push(`第一圈发 ${got} 枚，应为 ${GameStateManager.LVBI_PER_LAP}`);
      }
    }

    // ---- 2. 前 N 圈各发一次，第 N+1 圈不再发 ----
    //
    // 上限的意义：**第五圈刚好是刷满评级的那一圈**。
    // 领满之后再多骑不给钱——那一趟该干的事已经干完了，
    // 再骑只是烧日期。
    asserts++;
    {
      const g = new GameStateManager();
      for (let i = 0; i < GameStateManager.LAP_BONUS_CAP; i++) g.noteLap();
      const atCap = g.lvbi;
      const want = GameStateManager.LAP_BONUS_CAP * GameStateManager.LVBI_PER_LAP;
      if (atCap !== want) probs.push(`骑满 ${GameStateManager.LAP_BONUS_CAP} 圈只有 ${atCap} 枚，应为 ${want}`);
      asserts++;
      g.noteLap();
      g.noteLap();
      if (g.lvbi !== atCap) {
        probs.push(`第 ${GameStateManager.LAP_BONUS_CAP + 1} 圈之后还在发钱（${g.lvbi - atCap} 枚）——圈成了水龙头`);
      }
      asserts++;
      if (g.laps !== GameStateManager.LAP_BONUS_CAP + 2) {
        probs.push(`圈数没有照记（${g.laps}）——日期与圈数必须分开记`);
      }
    }

    // ---- 3. 幂等：读档回来不能重发 ----
    //
    // `laps` 与 `earnedTags` 一起落盘。少了后者，读档之后
    // 再骑一圈就会把已经领过的圈钱再发一次。
    asserts++;
    {
      const store = memStore();
      const g = new GameStateManager(store);
      g.noteLap();
      g.noteLap();
      const lvbi = g.lvbi;
      const laps = g.laps;
      const g2 = new GameStateManager(store);
      if (!g2.load()) probs.push('有存档却读不回来');
      asserts++;
      if (g2.lvbi !== lvbi) probs.push(`读档后旅币 ${g2.lvbi}，应为 ${lvbi}`);
      asserts++;
      if (g2.laps !== laps) probs.push(`读档后圈数 ${g2.laps}，应为 ${laps}`);
      asserts++;
      g2.noteLap();
      if (g2.lvbi !== lvbi + GameStateManager.LVBI_PER_LAP) {
        probs.push(`读档后骑第三圈发 ${g2.lvbi - lvbi} 枚，应为 ${GameStateManager.LVBI_PER_LAP}`);
      }
    }

    // ---- 4. 「按公里发钱」那条老路必须已经拆掉 ----
    //
    // 它在源项目里是对的，在这一版是错的。
    // 方法留着（哪怕是个空壳）就等于**两套口径同时存在**——
    // 而哪一套在生效，取决于谁先被调用。所以这里要求它**不存在**。
    asserts++;
    {
      const src = srcOf('src/game/state.ts');
      if (/earnKm\s*\(/.test(src)) probs.push('state.ts 里还有 earnKm()——按公里发钱那条老路没拆干净');
    }
    asserts++;
    {
      const src = srcOf('src/world/world.ts');
      if (/earnKm\s*\(/.test(src)) probs.push('world.ts 还在调 earnKm()——两套经济口径同时在跑');
    }

    // ---- 5. 无头那一侧必须跟得上 ----
    //
    // 浏览器里骑完一圈发 75 枚，无头里不发 → 两套经济分叉，
    // 而 `npm run ai:play` 的判据读的就是无头那份数字。
    asserts++;
    {
      const src = srcOf('src/game/api/headless.ts');
      if (!src.includes('this.game.noteLap()')) {
        probs.push('headless.ts 不调 noteLap()——无头那一侧不记圈，两套经济会分叉');
      }
    }

    // ---- 6. 存档里不该再写那个记账位 ----
    asserts++;
    {
      const src = srcOf('src/game/state.ts');
      if (/spent_km:\s*this\./.test(src)) {
        probs.push('存档还在写 spent_km——按公里发钱那条老路的记账位');
      }
    }

    return expect(
      probs.length === 0,
      probs.length ? probs.join('；') : `每圈 ${GameStateManager.LVBI_PER_LAP} 枚 · 领满 ${GameStateManager.LAP_BONUS_CAP} 圈`,
      asserts,
    );
  });

  // ================================================================ 乐事赌注
  /**
   * 五个小游戏原来**没有任何赌注**：
   * 碎片在第一次到访就必得（`checkIn()` 不看胜负），而输赢只差 15 枚旅币。
   * 于是「把五件乐事打赢」在进度上没有任何区别。
   *
   * 现在胜负写进**心神**：赢了回一格，输了掉一格——
   * 而心神同时决定雾的浓度与视野，所以输掉的代价是**看得见的那一层**。
   */
  check('verify_minigame_stakes', () => {
    let asserts = 0;
    const probs: string[] = [];

    // ---- 1. 赢 +1 / 输 −1 ----
    asserts++;
    {
      const g = new GameStateManager();
      const m0 = g.mood;
      g.onMiniGame(0, true);
      if (g.mood !== m0 + 1) probs.push(`赢了一局心神 ${g.mood}，应为 ${m0 + 1}`);
    }
    asserts++;
    {
      const g = new GameStateManager();
      const m0 = g.mood;
      g.onMiniGame(0, false);
      if (g.mood !== m0 - 1) probs.push(`输了一局心神 ${g.mood}，应为 ${m0 - 1}`);
    }

    // ---- 2. 上下限 ----
    //
    // 上限 5 是"满"；下限 1 是**不做成失败条件**：
    // 输了下一局照样能赢回来，而心神掉到 0 就等于判死了。
    asserts++;
    {
      const g = new GameStateManager();
      for (let i = 0; i < 10; i++) g.onMiniGame(0, true);
      if (g.mood !== ECON.MOOD_CEIL) probs.push(`连赢十局心神 ${g.mood}，上限是 ${ECON.MOOD_CEIL}`);
    }
    asserts++;
    {
      const g = new GameStateManager();
      for (let i = 0; i < 10; i++) g.onMiniGame(0, false);
      if (g.mood !== ECON.MOOD_FLOOR) probs.push(`连输十局心神 ${g.mood}，下限是 ${ECON.MOOD_FLOOR}`);
    }

    // ---- 3. 收碎片的那一次代价仍然在 ----
    //
    // 赢一局是**抵掉**那一次代价，输一局是**再付一次**。
    // 要是这一条被删了，赢就变成纯赚，赌注就没有了。
    asserts++;
    {
      const g = new GameStateManager();
      const m0 = g.mood;
      g.checkIn(ROAD.FRAGMENT_SLOT_STATION_IDX[0]);
      if (g.mood !== Math.max(ECON.MOOD_FLOOR, m0 - 1)) {
        probs.push(`收第一块碎片心神 ${g.mood}，应为 ${Math.max(ECON.MOOD_FLOOR, m0 - 1)}`);
      }
    }

    // ---- 4. 心神真的影响画面 ----
    //
    // 这是这一条存在的理由：赌注必须落在**看得见的东西**上。
    // 雾的浓度（`getMoodMaskAlpha`）与视野（`getVisibilityFactor`）
    // 各量一头——只看一头的话，堵住另一头照样绿。
    asserts++;
    {
      const g = new GameStateManager();
      const top = g.getMoodMaskAlpha();
      const topVis = g.getVisibilityFactor();
      for (let i = 0; i < 10; i++) g.onMiniGame(0, false);
      const bottom = g.getMoodMaskAlpha();
      const bottomVis = g.getVisibilityFactor();
      if (!(bottom > top)) probs.push(`心神到底时雾反而更淡（${top} → ${bottom}）——输掉的代价看不见`);
      if (!(bottomVis < topVis)) probs.push(`心神到底时视野反而更清（${topVis} → ${bottomVis}）——输掉的代价看不见`);
    }

    // ---- 5. 接线：结算屏要把这一局的得失说出来 ----
    asserts++;
    {
      const src = srcOf('src/main.ts');
      if (!/mood:\s*moodDelta/.test(src)) {
        probs.push('main.ts 没有把这一局的心神得失传给结算屏——玩家看不见自己赢了什么');
      }
      asserts++;
      if (!/const moodBefore = game\.mood/.test(src)) {
        probs.push('main.ts 没有在开打前量心神——量到的会是「连打卡那一次」的总数');
      }
    }
    asserts++;
    {
      const src = srcOf('src/ui/storyCard.ts');
      if (!/mood\?:\s*number/.test(src)) {
        probs.push('ResultCard 不接受 mood 选项——结算屏渲染不出这一行');
      }
    }

    // ---- 6. 结算屏那一行真的写着「旅币 +N · 心神 ±1」 ----
    //
    // 量的是**DOM 上的字**，不是代码里有没有那个分支：
    // 少了这一条，「赢了有 +1」就只是代码里的一行注释。
    asserts++;
    {
      const card = new ResultCard(parent());
      card.show('win', 0, 1000, undefined, { gain: 20, mood: 1 });
      const row = card.root.querySelector('.g-result-gain') as HTMLElement | null;
      const txt = row?.textContent ?? '';
      if (!txt.includes('20')) probs.push(`结算屏的账那一行是「${txt}」，没写旅币 20`);
      asserts++;
      if (!txt.includes('+1')) probs.push(`结算屏的账那一行是「${txt}」，没写「心神 +1」`);
    }
    asserts++;
    {
      const card = new ResultCard(parent());
      card.show('lose', 0, 1000, undefined, { gain: 5, mood: -1 });
      const row = card.root.querySelector('.g-result-gain') as HTMLElement | null;
      const txt = row?.textContent ?? '';
      if (!txt.includes('-1')) probs.push(`输了的账那一行是「${txt}」，没写「心神 −1」`);
    }
    asserts++;
    {
      // 取消那一局：既没有旅币也没有心神，这一行必须收起来。
      const card = new ResultCard(parent());
      card.show('cancel', 0, 1000, undefined, {});
      const row = card.root.querySelector('.g-result-gain') as HTMLElement | null;
      if (row && isShown(row)) probs.push('取消那一局仍然摆着账那一行');
    }

    return expect(
      probs.length === 0,
      probs.length ? probs.join('；') : '赢 +1 / 输 −1，代价落在雾与视野上',
      asserts,
    );
  });

  // ================================================================ 经营面板
  /**
   * 没点亮的驿站原来也在讲"第一单从这里开始"，
   * 而它上面六个按钮全在写「口碑未达标」。
   */
  check('verify_business_locked_copy', () => {
    let asserts = 0;
    const probs: string[] = [];

    // ---- 1. 判定：没口碑就是锁着的 ----
    asserts++;
    {
      const g = new GameStateManager();
      const locked = BUSINESSES.find((b) => b.unlock > 0);
      if (!locked) {
        probs.push('没有任何一座驿站需要口碑——这条判据的前提不成立');
      } else {
        const reason = businessBlock(g.business, locked, 'gather', g.lvbi);
        if (reason !== 'biz_locked') {
          probs.push(`未解锁的驿站返回 ${reason}，应为 biz_locked`);
        }
      }
    }

    // ---- 2. 锁着的时候不摆那六个按钮 ----
    asserts++;
    {
      const src = srcOf('src/ui/businessPanel.ts');
      if (!/if \(!locked\)\s*\{/.test(src)) {
        probs.push('businessPanel 在锁着的时候照样摆按钮——六个灰按钮全是同一句「口碑未达标」');
      }
      asserts++;
      if (!src.includes('biz_locked_note')) {
        probs.push('businessPanel 没有用 biz_locked_note——玩家看不到还差多少口碑');
      }
      asserts++;
      if (!src.includes('biz_locked_hint')) {
        probs.push('businessPanel 没有用 biz_locked_hint——玩家不知道下一步该去哪儿');
      }
    }

    // ---- 3. 锁着的时候不该讲流程链 ----
    //
    // 「备料 → 制作 → 接单 → 等待服务 → 交付。第一单从这里开始」
    // 这句在锁着的时候是**假话**——一件都做不了，哪来的第一单。
    asserts++;
    {
      const src = srcOf('src/ui/businessPanel.ts');
      if (!/locked\s*\?\s*t\('biz_locked_hint'\)/.test(src)) {
        probs.push('锁着的时候仍在讲「第一单从这里开始」——流程链与按钮互相打架');
      }
    }

    // ---- 4. 文案两侧都有，且带占位符 ----
    asserts++;
    {
      for (const lang of ['zh', 'en'] as const) {
        const tbl = I18N[lang];
        for (const key of ['biz_locked_note', 'biz_locked_hint']) {
          if (!tbl[key]) probs.push(`${lang} 侧没有 ${key}`);
        }
      }
    }
    asserts++;
    {
      const note = I18N.zh.biz_locked_note ?? '';
      if (!note.includes('{need}')) {
        probs.push('biz_locked_note 没有 {need} 占位符——玩家看不到还差多少口碑');
      }
    }

    // ---- 5. 屏上真的没有那六个按钮 ----
    //
    // 这一族量的是**屏上的字**，不是代码里有没有那个分支。
    // 少了它，「锁着就不摆按钮」就只是注释里的一句话。
    asserts++;
    {
      const g = new GameStateManager();
      const panel = new BusinessPanel(parent(), g, {
        open: () => {},
        close: () => {},
        qin: () => {},
      });
      const locked = BUSINESSES.find((b) => b.unlock > 0);
      if (!locked) {
        probs.push('没有任何一座驿站需要口碑——这条判据的前提不成立');
      } else {
        panel.open(locked.station);
        const text = collectText(panel.root);
        asserts++;
        if (!text.includes(t('biz_locked_note', { need: locked.unlock }))) {
          probs.push('锁着的驿站屏幕上没有「还没点着 · 口碑 N 才开张」那一行');
        }
        asserts++;
        // **量按钮本身，不量整块屏上的字。**
        //
        // 「备料」这两个字在状态栏里也有（`biz_progress` 的「备料冷却 N 秒」），
        // 所以按字面找它，找到的是状态栏而不是那颗按钮——
        // 这条断言会绿，而按钮明明还摆在那儿。
        if (panel.root.querySelector('.g-business-actions')) {
          probs.push('锁着的驿站仍然摆着「备料」那颗按钮');
        }
        asserts++;
        if (text.includes(t('biz_story_0'))) {
          probs.push('锁着的驿站仍在讲「第一单从这里开始」——它一件都做不了');
        }
        asserts++;
        if (!text.includes(t('biz_locked_hint'))) {
          probs.push('锁着的驿站没有告诉玩家下一步该去哪儿');
        }
      }
    }

    // ---- 6. 解锁之后那些东西必须回来 ----
    //
    // 上一条只证"锁着的时候没有"。这一条证"解锁之后有"——
    // 不然把按钮整个删掉也能让上一条绿。
    asserts++;
    {
      const g = new GameStateManager();
      const open = BUSINESSES.find((b) => b.unlock === 0);
      if (!open) {
        probs.push('没有任何一座驿站一开始就开着——这条判据的前提不成立');
      } else {
        const panel = new BusinessPanel(parent(), g, {
          open: () => {},
          close: () => {},
          qin: () => {},
        });
        panel.open(open.station);
        const acts = panel.root.querySelector('.g-business-actions');
        const buttons = acts ? acts.querySelectorAll('button') : [];
        if (buttons.length !== 6) {
          probs.push(`开着的驿站只有 ${buttons.length} 颗动作按钮，应为 6——按钮被误删了`);
        }
        asserts++;
        const text = collectText(panel.root);
        if (!text.includes(t('biz_motive'))) {
          probs.push('开着的驿站不讲「先备料，再制作，接一单试试」');
        }
      }
    }

    return expect(
      probs.length === 0,
      probs.length ? probs.join('；') : '锁着的驿站说另一套话',
      asserts,
    );
  });

  // ================================================================ 商店
  /**
   * 五件「无价」碎片卡撤下来了。
   *
   * 理由：碎片是**买不到**的，而它们占的是货架位置。
   * 开局旅币 0，架上十件商品有九件买不了，再加五件永远买不了的，
   * 玩家看到的是一张**没有一件能按的架子**。
   *
   * 「碎片不是钱能买的」这句话由另外两处说（顶栏碎片栏、明信片正面五格），
   * 那两处都更有针对性。
   */
  check('verify_shop_no_priceless', () => {
    let asserts = 0;
    const probs: string[] = [];
    const g = new GameStateManager();
    const hooks = { onShopBuy: () => {}, onShopClose: () => {} } as unknown as UIHooks;
    const panel = new ShopPanel({ parent: parent(), hooks, game: g });

    // ---- 1. 驿铺的架子上摆的全是商品表里的那几件 ----
    asserts++;
    {
      const shopName = '驿铺';
      panel.open(shopName);
      const grid = panel.root.querySelector('.g-goods');
      const cards = grid ? grid.querySelectorAll('.g-good') : [];
      const want = g.goodsForShop(shopName).length;
      if (cards.length !== want) {
        probs.push(`驿铺架子上有 ${cards.length} 件，商品表里有 ${want} 件`);
      }
      asserts++;
      const names = new Set(g.goodsForShop(shopName).map((x) => x.name));
      for (const c of cards) {
        const n = (c.querySelector('.g-good-n') as HTMLElement | null)?.textContent ?? '';
        if (!names.has(n)) probs.push(`架子上摆着一件不在商品表里的东西：「${n}」`);
      }
    }

    // ---- 2. 五件「无价」一个都不许在架上 ----
    asserts++;
    {
      const grid = panel.root.querySelector('.g-goods');
      const cards = grid ? grid.querySelectorAll('.g-good') : [];
      for (const c of cards) {
        const n = (c.querySelector('.g-good-n') as HTMLElement | null)?.textContent ?? '';
        if ((SHOPS.NOT_FOR_SALE as string[]).includes(n)) {
          probs.push(`架子上还摆着「${n}」——它永远买不了`);
        }
        const en = SHOPS.NOT_FOR_SALE_EN[n];
        if (en && n === en) probs.push(`架子上还摆着「${n}」——它永远买不了`);
      }
    }

    // ---- 3. 三间铺子都过一遍 ----
    asserts++;
    {
      for (const name of Object.keys(SHOPS.TABLE)) {
        const goods = g.goodsForShop(name);
        for (const gd of goods) {
          if ((SHOPS.NOT_FOR_SALE as string[]).includes(gd.name)) {
            probs.push(`${name} 的商品表里混进了「${gd.name}」`);
          }
        }
      }
    }

    // ---- 4. 源码里不该再引用那五件 ----
    asserts++;
    {
      const src = srcOf('src/ui/shopPanel.ts');
      if (src.includes('NOT_FOR_SALE')) {
        probs.push('shopPanel 还在引用 NOT_FOR_SALE——那五件「无价」又回来了');
      }
    }

    return expect(
      probs.length === 0,
      probs.length ? probs.join('；') : '架子上只剩买得了的东西',
      asserts,
    );
  });

  // ================================================================ 序章空格
  /**
   * 故事卡是**定时卡**：它自己读满就退场，**不吃按键**
   * （吃按键的是对白框，它在捕获阶段拦 Space/Enter）。
   * 而序章那七张摆在屏上的时候，打卡被 `prologueBusy` 让开——
   * 于是玩家按空格**什么都不会发生**。
   */
  check('verify_prologue_space', () => {
    let asserts = 0;
    const probs: string[] = [];

    // ---- 1. `advanceTop()` 真的退掉一张、接上下一张 ----
    asserts++;
    {
      const cards = new StoryCards(parent());
      cards.showSequence(['第一句', '第二句', '第三句'], { dismissible: true });
      // 每次都重新取一遍快照：`count` / `pending` 是 getter，
      // TypeScript 会把上一次读到的值**窄化**成字面量，
      // 于是第二次比较会被判成"两个类型没有交集"。
      const before = { count: cards.count, pending: cards.pending };
      if (before.count !== 1 || before.pending !== 2) {
        probs.push(`队列形状变了：在屏 ${before.count} / 排队 ${before.pending}`);
      } else {
        const ok = cards.advanceTop();
        asserts++;
        if (!ok) probs.push('advanceTop() 没有退掉任何一张');
        asserts++;
        const after = { count: cards.count, pending: cards.pending };
        if (after.count !== 1 || after.pending !== 1) {
          probs.push(`退掉一张之后形状是 ${after.count}/${after.pending}，应为 1/1`);
        }
      }
    }

    // ---- 2. 没有卡时它必须说"没有"，而不是硬退一张别的 ----
    asserts++;
    {
      const cards = new StoryCards(parent());
      if (cards.advanceTop()) probs.push('屏上没有卡时 advanceTop() 却说退掉了');
    }

    // ---- 3. 退到最后一个：队列排空，闸门必须落下 ----
    //
    // 闸门（`storyBusy`）落下之后打卡才恢复。
    // 要是这里卡住，玩家永远打不了卡——而那种事从画面上看不出来。
    asserts++;
    {
      const cards = new StoryCards(parent());
      cards.showSequence(['第一句', '第二句'], { dismissible: true });
      for (let i = 0; i < 10; i++) cards.advanceTop();
      if (cards.busy) probs.push(`两张都退完了 busy 仍为真（在屏 ${cards.count} / 排队 ${cards.pending}）——闸门会永久关死`);
    }

    // ---- 4. 接线：空格这一下要真的落到故事卡上 ----
    asserts++;
    {
      const src = srcOf('src/main.ts');
      if (!src.includes('this.ui.advanceStoryCard()')) {
        probs.push('main.ts 的 tryCheckIn() 没有把空格交给故事卡——序章期间按空格仍然什么都不会发生');
      }
    }
    asserts++;
    {
      const src = srcOf('src/ui/index.ts');
      if (!src.includes('advanceStoryCard()')) {
        probs.push('UI 层没有暴露 advanceStoryCard()');
      }
    }
    asserts++;
    {
      const src = srcOf('src/ui/storyCard.ts');
      if (!/advanceTop\(\)\s*:\s*boolean/.test(src)) {
        probs.push('StoryCards 没有 advanceTop()');
      }
    }

    // ---- 5. 关不掉的那张不吃空格 ----
    //
    // 路边那块碑文是「骑过去顺便读」的：它不吃点击，
    // 也不该因为玩家按了空格就被抽走——那句话是给停下来的人读的。
    asserts++;
    {
      const cards = new StoryCards(parent());
      cards.show('路边那块碑', { title: '碑' });
      if (cards.advanceTop()) probs.push('空格把「骑过去顺便读」的那张卡抽走了——它不该吃按键');
      asserts++;
      if (cards.count !== 1) probs.push('那张关不掉的卡被空格退掉了');
    }
    asserts++;
    {
      const cards = new StoryCards(parent());
      cards.show('停下来读', { dismissible: true });
      if (!cards.advanceTop()) probs.push('「停下来读」的那张卡不吃空格');
    }

    // ---- 6. 路边那块碑文压着的时候，序章也要能接着念 ----
    //
    // 「屏上真的空了才接下一张」这条规矩本来是为了不让两张卡糊在一起，
    // 可它会让序章停在一块关不掉的碑文后面好几秒——
    // 而玩家按的是空格，他要的是"接着念"。
    asserts++;
    {
      const cards = new StoryCards(parent());
      cards.showSequence(['第一句', '第二句'], { dismissible: true });
      cards.show('路边那块碑', { title: '碑' });
      const before = collectText(cards.root);
      if (!before.includes('第一句') || before.includes('第二句')) {
        probs.push(`序章第一句没有在屏上（屏上是「${before.slice(0, 40)}」）`);
      }
      cards.advanceTop();
      const after = collectText(cards.root);
      if (!after.includes('第二句')) {
        probs.push('退掉序章第一句之后，第二句没有接上来——空格推进被路边那块碑文卡住了');
      }
      asserts++;
      if (!after.includes('路边那块碑')) {
        probs.push('推进序章的时候把路边那块碑文一起带走了——它关不掉');
      }
    }

    return expect(
      probs.length === 0,
      probs.length ? probs.join('；') : '序章期间空格能推进故事卡',
      asserts,
    );
  });

  // ================================================================ 碎片 x/3
  check('verify_frag_visit_count', () => {
    let asserts = 0;
    const probs: string[] = [];

    // ---- 1. 文案两侧都有，两个 %d ----
    asserts++;
    {
      for (const lang of ['zh', 'en'] as const) {
        const s = I18N[lang].frag_visit_count;
        if (!s) {
          probs.push(`${lang} 侧没有 frag_visit_count`);
          continue;
        }
        const n = (s.match(/%d/g) ?? []).length;
        if (n !== 2) probs.push(`${lang} 侧 frag_visit_count 有 ${n} 个 %d，应为 2（现在几次 / 共几次）`);
      }
    }

    // ---- 2. HUD 用的是新键 ----
    asserts++;
    {
      const src = srcOf('src/ui/hud.ts');
      if (!src.includes('frag_visit_count')) {
        probs.push('HUD 还在用 postcard_visit_n——玩家看不到上限是 3');
      }
      asserts++;
      if (/setText\(c\.cnt, t\('postcard_visit_n'/.test(src)) {
        probs.push('HUD 的碎片计数还在写「%d 次」');
      }
    }

    // ---- 3. 上限那个数来自数据，不是写死的 3 ----
    asserts++;
    {
      const src = srcOf('src/ui/hud.ts');
      if (!/MAX_VISITS_PER_STATION/.test(src)) {
        probs.push('HUD 的分母不是 ECON.MAX_VISITS_PER_STATION——上限改了它不会跟着变');
      }
    }

    return expect(
      probs.length === 0,
      probs.length ? probs.join('；') : '碎片栏写「几次 / 共几次」',
      asserts,
    );
  });

  // ================================================================ favicon
  check('verify_favicon', () => {
    let asserts = 0;
    const probs: string[] = [];

    // ---- 1. 文件在 ----
    asserts++;
    {
      if (!existsSync(join(ROOT, 'public', 'favicon.svg'))) {
        probs.push('public/favicon.svg 不存在——浏览器还是会去要一次 /favicon.ico 并拿回 404');
      }
    }

    // ---- 2. HTML 引用了它 ----
    asserts++;
    {
      const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
      if (!/<link[^>]+rel="icon"/.test(html)) {
        probs.push('index.html 没有 <link rel="icon">');
      }
    }

    // ---- 3. 引用的那个文件真的在 public 里 ----
    //
    // 改文件名而忘了拷文件，症状是**又一条 404**——
    // 和没加 favicon 一模一样，所以这条必须钉住。
    asserts++;
    {
      const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
      const m = html.match(/<link[^>]+rel="icon"[^>]*href="([^"]+)"/);
      if (!m) {
        probs.push('读不出 icon 的 href');
      } else {
        const href = m[1];
        if (href.startsWith('http') || href.startsWith('data:')) {
          probs.push(`icon 指向外部地址（${href}）——本项目不该依赖外部资源`);
        } else {
          const rel = href.replace(/^\.?\//, '');
          if (!existsSync(join(ROOT, 'public', rel))) {
            probs.push(`index.html 指向 ${href}，而 public 里没有这个文件`);
          }
        }
      }
    }

    return expect(
      probs.length === 0,
      probs.length ? probs.join('；') : 'favicon 在位，不再有那条 404',
      asserts,
    );
  });

  // ================================================================ perf 死字段
  check('verify_perf_snapshot_fields', () => {
    let asserts = 0;
    const probs: string[] = [];

    // ---- 1. 档位与「玩家动过画质」必须真的被写 ----
    //
    // 它们以前在 `perf.ts` 里声明、给了默认值，然后**再也没有人写过**——
    // 于是 `window.gift188.perf` 报出来的档位与真实档位无关。
    asserts++;
    {
      const src = srcOf('src/main.ts');
      if (!/perf\.tier\s*=/.test(src)) {
        probs.push('没有人写 perf.tier——调试出口里的档位是死的');
      }
      asserts++;
      if (!/perf\.qualityTouched\s*=/.test(src)) {
        probs.push('没有人写 perf.qualityTouched——调试出口里的「动过画质」是死的');
      }
    }

    // ---- 2. 写的是 settings 里的真值，不是常量 ----
    asserts++;
    {
      const src = srcOf('src/main.ts');
      if (!/perf\.tier\s*=\s*this\.settings\.tier/.test(src)) {
        probs.push('perf.tier 不是从 settings 读的');
      }
      asserts++;
      if (!/perf\.qualityTouched\s*=\s*this\.settings\.qualityTouched/.test(src)) {
        probs.push('perf.qualityTouched 不是从 settings 读的');
      }
    }

    return expect(
      probs.length === 0,
      probs.length ? probs.join('；') : 'perf 快照的档位与 touched 都在动',
      asserts,
    );
  });

  // ================================================================ README 档数
  check('verify_readme_ranks', () => {
    let asserts = 0;
    const probs: string[] = [];

    // ---- 1. 五档都要写出来 ----
    //
    // 实现是四个有名档 + 第五个「完满」（五座各走满三次）。
    // README 写着四档——于是读者按四档规划，而结算屏写「共 5 档」。
    asserts++;
    {
      const zh = readFileSync(join(ROOT, 'README.zh-CN.md'), 'utf8');
      for (const name of ['初旅', '探索者', '朝圣者', '大师', '完满']) {
        if (!zh.includes(name)) probs.push(`README.zh-CN.md 里没有「${name}」这一档`);
      }
    }
    asserts++;
    {
      const en = readFileSync(join(ROOT, 'README.md'), 'utf8');
      for (const name of ['First Ride', 'Explorer', 'Pilgrim', 'Master', 'Full']) {
        if (!en.includes(name)) probs.push(`README.md 里没有 "${name}" 这一档`);
      }
    }

    // ---- 2. 不许再写「四档」 ----
    asserts++;
    {
      const zh = readFileSync(join(ROOT, 'README.zh-CN.md'), 'utf8');
      if (/明信片四档/.test(zh)) probs.push('README.zh-CN.md 还写着「明信片四档」');
    }
    asserts++;
    {
      const en = readFileSync(join(ROOT, 'README.md'), 'utf8');
      if (/four postcard ranks/.test(en)) probs.push('README.md 还写着 "four postcard ranks"');
    }

    return expect(
      probs.length === 0,
      probs.length ? probs.join('；') : '五档：初旅 / 探索者 / 朝圣者 / 大师 / 完满',
      asserts,
    );
  });

  // ================================================================ 骑行腿烘焙
  check('verify_pedal_bake', () => {
    let asserts = 0;
    const probs: string[] = [];

    // ---- 夹具：一副**和真素材同形**的腿骨 ----
    //
    // ★ 这副骨架是**共享的**（`./characterFixture.ts`）：
    //   `src/verify/vehicle.ts` 的 `verify_bike_rig` 用的是同一副。
    //
    //   原来两处各造各的，而 `verify_bike_rig` 那副**缺了大腿小腿**——
    //   烘焙（`bakeRideToPedals`）要的八根腿骨它只有两根，
    //   于是它每次都返回 null，每轮 verify 都打四条
    //   「骑行腿烘焙失败（骨名对不上？）」，而真游戏里那条根本不出现。
    //   **夹具与素材不一致的那天，改共享那一份就够了。**
    //
    // ★ 那几个数不是编的，是从 `survivor.glb` 的骨层级里读出来的真值；
    //   而「子骨的偏移沿骨本地 +Y」是烘焙成立的前提——
    //   全部细节见 `characterFixture.ts` 的文件头。

    // ---- 一条骑行片段：骨盆有起伏，没有水平位移 ----
    //
    // ★ 水平位移必须是 0：`stripRootMotion()` 会把根轨道的 x / z 抹成 0
    //   （人在原地播，走的距离由车负责）。夹具里留一点水平位移，
    //   骨盆就会离踏板越来越远，最后**够不着**——
    //   而 `solveTwoBone` 会把超界的距离**静悄悄地夹到 [a+b]**，
    //   于是脚够不着踏板却没有一条断言会红。
    //
    //   键数与时长对齐真素材（`骑自行车` 那段：4.958s / 120 个键 ≈ 24fps）。
    const N = 119;
    const DURATION = 4.958333492279053;
    const buildClip = (): AnimationClip => {
      const times = new Float32Array(N + 1);
      for (let i = 0; i <= N; i++) times[i] = (i / N) * DURATION;
      const hipsPos = new Float32Array((N + 1) * 3);
      for (let i = 0; i <= N; i++) {
        const u = i / N;
        hipsPos.set(
          [
            0.0019521618960425258,
            0.5251340866088867 + 0.02 * Math.sin(u * 2 * Math.PI),
            0.07223034650087357,
          ],
          i * 3,
        );
      }
      const ident = (n: number): Float32Array => {
        const q = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) q.set([0, 0, 0, 1], i * 4);
        return q;
      };
      // ★ 骨盆的旋转轨道给一个**非单位**的常量（绕 Y 轴 90°）。
      //
      //   烘焙最后一步是「骨向 → 本地四元数」：`q_local = q_父的世界朝向⁻¹ · q_骨的世界朝向`。
      //   父朝向要是单位阵，这一步就退化成恒等——于是把这一步整个删掉，判据**照样绿**。
      //   真素材里骨盆本来就在转（骑姿），所以夹具也必须转。
      const pelvisRot = new Float32Array((N + 1) * 4);
      for (let i = 0; i <= N; i++) pelvisRot.set([0, Math.SQRT1_2, 0, Math.SQRT1_2], i * 4);
      const tracks: KeyframeTrack[] = [
        new KeyframeTrack('mixamorigHips.position', times, hipsPos),
        new KeyframeTrack('mixamorigHips.quaternion', times, pelvisRot),
      ];
      for (const side of ['Left', 'Right'] as const) {
        for (const part of ['UpLeg', 'Leg', 'Foot', 'ToeBase']) {
          tracks.push(new KeyframeTrack(`mixamorig${side}${part}.quaternion`, times, ident(N + 1)));
        }
      }
      return new AnimationClip('骑自行车', DURATION, tracks);
    };

    const char = buildSurvivorSkeleton();
    const clip = buildClip();

    // ---- 踏板的位置**从骨架量出来**，不写死 ----
    //
    // 曲柄轴心放在两髋中点下方 0.20（模型单位）——真实车就是那样：
    // 曲柄在坐垫下面、两条腿够得着。写死一个常数的话，
    // 换一个身高或换一套偏移，够不够得着就变成运气了。
    const probe = new PoseSampler(char, clip);
    const hipL = new Vector3();
    const hipR = new Vector3();
    probe.seek(0);
    probe.originPos('mixamorigLeftUpLeg', hipL);
    probe.originPos('mixamorigRightUpLeg', hipR);
    const centre = new Vector3(
      (hipL.x + hipR.x) / 2,
      (hipL.y + hipR.y) / 2 - 0.2,
      (hipL.z + hipR.z) / 2,
    );
    const RADIUS = 0.15;
    const lateral: [number, number] = [hipL.x + 0.09, hipR.x - 0.09];

    // ---- 1. 烘焙必须成功 ----
    //
    // ★ 这是**第一次**有判据跑到这条路径上。
    // 以前它每次都返回 null（真素材的骨名对得上，可夹具的骨对不上），
    // 于是「骑手踩在踏板旁边画圈」这件事**没有任何一条断言会红**。
    asserts++;
    const baked = bakeRideToPedals(char, clip, {
      centre: centre.clone(),
      lateralX: lateral,
      radius: RADIUS,
      phase: 0,
      turns: 1,
      sense: 1,
    });
    if (!baked) {
      probs.push('bakeRideToPedals 返回 null —— 骑手的脚没有落到踏板上');
      return expect(false, probs.join('；'), asserts);
    }

    // ---- 2. 时长不变，轨道齐 ----
    asserts++;
    if (Math.abs(baked.duration - clip.duration) > 1e-6) {
      probs.push(`烘焙后时长变成 ${baked.duration}，原片段是 ${clip.duration}`);
    }
    asserts++;
    {
      const names = new Set(baked.tracks.map((tr) => tr.name));
      for (const side of ['Left', 'Right'] as const) {
        for (const part of ['UpLeg', 'Leg', 'Foot']) {
          const want = `mixamorig${side}${part}.quaternion`;
          if (!names.has(want)) probs.push(`烘焙结果里没有 ${want}`);
        }
      }
    }

    // ---- 3. ★ 脚必须真的落在踏板圆上 ----
    //
    // 这一条才是这个函数存在的理由：把脚从「原动画画的那圈」挪到
    // 「踏板画的那圈」。量法是**把烘焙后的片段重新摆一遍**。
    //
    // ★★ 踏板圆在 **x = lateralX[li] 那个平面**上（左右两个踏板各在自己
    //   的平面里转，共用一个圆是错的——那样两只脚会挤到中线上）。
    //   所以「离圆心的距离」要量 **YZ 平面里的半径**，再单独量 x；
    //   拿三维距离去减半径，恒定差出 lateralX 与圆心的横向距离，
    //   看着像错、其实是对的。
    asserts++;
    {
      const after = new PoseSampler(char, baked);
      /** 某只脚在踏板平面里的半径与横向位置。 */
      const measure = (side: 'Left' | 'Right', out: { r: number; x: number }): void => {
        const p = new Vector3();
        after.originPos(`mixamorig${side}Foot`, p);
        out.r = Math.hypot(p.y - centre.y, p.z - centre.z);
        out.x = p.x;
      };

      // 3a. 关键帧上必须**精确**落在圆上。
      //
      // 这是烘焙给的承诺：解出来的脚就在目标点上。
      // 一旦够不着（`solveTwoBone` 把距离夹到 [a+b]），这里立刻红。
      let maxKeyErr = 0;
      let maxKeyX = 0;
      const m = { r: 0, x: 0 };
      for (let i = 0; i <= N; i++) {
        after.seek((i / N) * baked.duration);
        measure('Left', m);
        maxKeyErr = Math.max(maxKeyErr, Math.abs(m.r - RADIUS));
        maxKeyX = Math.max(maxKeyX, Math.abs(m.x - lateral[0]));
      }
      if (maxKeyErr > 1e-4) {
        probs.push(`左脚在关键帧上离踏板圆差了 ${maxKeyErr.toFixed(6)}（模型单位）`);
      }
      if (maxKeyX > 1e-4) {
        probs.push(`左脚的横向位置差 ${maxKeyX.toFixed(6)} —— 它没落在自己的踏板平面上`);
      }

      // 3b. 帧间也不能跑偏。
      //
      // 烘焙只在**关键帧**上求解，帧间是插值出来的。
      // 关键帧一多，帧间的偏差就趋近于 0——真素材是 120 个键 / 4.96s（24fps），
      // 实测帧间偏差 0.00012 模型单位。这条钉的是「别把关键帧密度改稀」。
      let maxMidErr = 0;
      let minY = Infinity;
      let maxY = -Infinity;
      const STEPS = 481;
      for (let i = 0; i < STEPS; i++) {
        after.seek((i / (STEPS - 1)) * baked.duration);
        measure('Left', m);
        maxMidErr = Math.max(maxMidErr, Math.abs(m.r - RADIUS));
        const p = new Vector3();
        after.originPos('mixamorigLeftFoot', p);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
      if (maxMidErr > 0.01) {
        probs.push(`左脚在帧间离踏板圆最远 ${maxMidErr.toFixed(5)} —— 关键帧太稀，脚会甩出踏板`);
      }

      // 3c. 上下幅度必须正好是一整圈（2R）。
      asserts++;
      if (Math.abs(maxY - minY - RADIUS * 2) > 1e-3) {
        probs.push(`左脚上下只画了 ${(maxY - minY).toFixed(4)}，一整圈该是 ${(RADIUS * 2).toFixed(4)}`);
      }
    }

    // ---- 4. 两只脚差半个圈（踏板本来就是 180° 对置） ----
    asserts++;
    {
      const after = new PoseSampler(char, baked);
      after.seek(baked.duration * 0.25);
      const l = new Vector3();
      const r = new Vector3();
      after.originPos('mixamorigLeftFoot', l);
      after.originPos('mixamorigRightFoot', r);
      const ang = (p: Vector3): number => Math.atan2(p.y - centre.y, p.z - centre.z);
      let diff = Math.abs(ang(l) - ang(r));
      while (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (Math.abs(diff - Math.PI) > 0.05) {
        probs.push(`两只脚在踏板圆上差了 ${((diff - Math.PI) * 180 / Math.PI).toFixed(2)}°，该是 180°`);
      }
    }

    // ---- 5. 骨对不上时必须**干净地失败**，不能崩 ----
    //
    // `vehicle.ts` 靠这个 null 才敢写「烘焙失败就退回原动画」；
    // 改成抛异常，那条退路就变成了崩溃。
    asserts++;
    {
      const bare = new Object3D();
      const hips = new Bone();
      hips.name = 'mixamorigHips';
      bare.add(hips);
      for (const side of ['Left', 'Right'] as const) {
        const foot = new Bone();
        foot.name = `mixamorig${side}Foot`;
        foot.position.set(0.09, 0.1, 0);
        hips.add(foot);
      }
      let threw = false;
      let out: AnimationClip | null = null;
      try {
        out = bakeRideToPedals(bare, clip, {
          centre: centre.clone(),
          lateralX: lateral,
          radius: RADIUS,
          phase: 0,
          turns: 1,
          sense: 1,
        });
      } catch {
        threw = true;
      }
      if (threw) probs.push('骨对不上时 bakeRideToPedals 抛了异常——vehicle.ts 的退路会变成崩溃');
      if (out !== null) probs.push('骨对不上时 bakeRideToPedals 却返回了片段');
    }

    return expect(
      probs.length === 0,
      probs.length ? probs.join('；') : '脚落在踏板上：烘焙成功 · 半径对得上 · 两只脚差半个圈 · 缺骨时干净失败',
      asserts,
    );
  });
}
