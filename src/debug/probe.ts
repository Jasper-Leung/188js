/**
 * 场景探针 —— 把"我现在在哪、镜头是什么状态、周围有什么"变成**可读文本**。
 *
 * ## 为什么是文本，不是又一个画面面板
 *
 * 这个东西的主要消费者不是玩家，是**要看着这段描述干活的人**——
 * 包括 AI 助手。人能看图，但 AI 读不到图；人能"看见树长歪了"，
 * 但看不见树底面离地 1.3m 那个数。
 *
 * 所以这里刻意输出**带数字的纯文本**，三个理由：
 *   · 能被 `query(kind:'text')` 读到，不依赖截图；
 *   · 能被复制粘贴进对话，AI 立刻拿到同一份事实；
 *   · 数字可核对——"离中心线 3.2m"能被另一段代码验，"看着有点歪"不能。
 *
 * ## 关于"光圈"
 *
 * 游戏相机**没有物理光圈**：three 的 `PerspectiveCamera` 是针孔模型，
 * 没有焦距、没有光圈叶片、没有景深。能对应上的只有
 * **视场角（FOV）、近/远裁剪面、画幅比例**——这三个决定了"镜头看得见什么"。
 * 所以本探针报这三项，而不是编一个 `f/2.8` 出来。
 *
 * ## 坐标为什么给两套
 *
 * 世界坐标 `(x, z)` 对**算法**友好（`getHeightAt` 要的就是它），
 * 对**人**不友好——8 字形上 `(0, 43)` 是自交点，`(-164, -137)` 在哪没人说得清。
 * 所以每个位置都同时给**弧长百分比 + 米数 + 最近的驿站**，
 * 人看后者，机器用前者。
 */
import { Box3, Vector3, Matrix4 } from 'three';
import { CENTERLINE, TOTAL_ARCLENGTH, STATIONS, nearestArcParam, nearestStation } from '../data/route';
import { ROADMESH, WORLD } from '../data/raw';
import { getBasins } from '../world/basins';
import { JUNCTION } from '../world/road';
import { horizontalFromVertical } from '../core/fov';
import { game } from '../game/state';
import type { World } from '../world/world';
import type { StationRuntime } from '../world/stations';

// ---------------------------------------------------------------- 小工具
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '—');
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '—');
const deg = (rad: number) => ((rad * 180) / Math.PI).toFixed(1);

/** 点到轴对齐包围盒在 XZ 上的最短距离。点在盒内返回 0 */
function boxDistXZ(box: Box3, x: number, z: number): number {
  const dx = Math.max(box.min.x - x, 0, x - box.max.x);
  const dz = Math.max(box.min.z - z, 0, z - box.max.z);
  return Math.hypot(dx, dz);
}

/** 点到中心线的最近距离。**这是**到中心线、不是到路沿** */
function offCenterline(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < CENTERLINE.length; i += 2) {
    const d = Math.hypot(CENTERLINE[i].x - x, CENTERLINE[i].z - z);
    if (d < best) best = d;
  }
  return best;
}

/** 位置描述：弧长百分比 + 米数 + 最近的驿站（人类可读的那一半） */
function whereLine(x: number, z: number): string {
  const t = nearestArcParam(x, z);
  const near = nearestStation(x, z);
  const st = STATIONS[near.index];
  return (
    `弧长 ${(t * 100).toFixed(1)}%（${(t * TOTAL_ARCLENGTH).toFixed(0)}/${TOTAL_ARCLENGTH.toFixed(0)}m）` +
    `  最近 ${st.def.name} #${near.index} ${near.distance.toFixed(0)}m`
  );
}

// ---------------------------------------------------------------- 镜头
/**
 * 镜头状态。
 *
 * `fovV` 是 three 里的竖直视场角，`fovH` 是**换算出来的**水平视场角——
 * 玩家真正感受到"能看多远"的是后者，而它完全由画幅比例决定。
 * 竖屏 9:19.5 与横屏 16:9 用同一个 `fovV` 时水平视野差 3 倍，
 * 所以两个都必须报，只报一个会误导判断。
 */
export function cameraLine(world: World): string {
  const cam = world.ride.camera;
  const sz = world.renderer.size;
  const aspect = sz.cssW / Math.max(1, sz.cssH);
  const fovV = cam.fov;
  const fovH = horizontalFromVertical(fovV, aspect);
  const st = world.renderer.stats();
  const p = cam.position;
  const d = new Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  return [
    `相机 pos=(${f1(p.x)}, ${f1(p.y)}, ${f1(p.z)})`,
    `朝向 yaw=${deg(cam.rotation.y)}° pitch=${deg(cam.rotation.x)}° 视向=(${f2(d.x)}, ${f2(d.y)}, ${f2(d.z)})`,
    `视场 竖${f1(fovV)}° / 横${f1(fovH)}°（画幅 ${sz.cssW}×${sz.cssH} = ${aspect.toFixed(2)}，绘制 ${sz.bufferW}×${sz.bufferH}，倍率 ${st.scale.toFixed(2)}）`,
    `裁剪 near=${cam.near} far=${cam.far}`,
    `渲染 draw=${st.calls} 三角面=${st.triangles} 程序=${st.programs} 贴图=${st.textures}`,
  ].join('\n    ');
}

// ---------------------------------------------------------------- 位置探针
export interface ProbeOpts {
  /** 半径：把多少米内的东西列出来 */
  radius?: number;
  /** 要不要带上 16 座驿站的完整体检表 */
  buildings?: boolean;
}

/**
 * 探针主体。`x`/`z` 省略时用玩家位置。
 *
 * 输出刻意分节且每行都以标签开头——AI 读这种文本比读散文准得多，
 * 而人扫一眼也能找到要看的那一行。
 */
export function probeAt(world: World, x?: number, z?: number, opts: ProbeOpts = {}): string {
  const radius = opts.radius ?? 40;
  const px = x ?? world.ride.pos.x;
  const pz = z ?? world.ride.pos.z;
  const L: string[] = [];

  L.push('=== 场景探针 ===');

  // ---- 位置 ----
  const groundY = world.terrain.getHeightAt(px, pz);
  const roadY = world.road.getHeightAt(px, pz);
  const off = offCenterline(px, pz);
  L.push(
    `位置 世界=(${f1(px)}, ${f1(pz)})  地形高=${f2(groundY)}  路面高=${Number.isFinite(roadY) ? f2(roadY) : '—'}`,
  );
  L.push(`      ${whereLine(px, pz)}  离中心线=${f1(off)}m  在路面上=${world.road.isOnRoad(px, pz) ? '是' : '否'}`);

  // ---- 交叉口 ----
  const dCross = Math.hypot(px - JUNCTION.center.x, pz - JUNCTION.center.z);
  if (dCross < JUNCTION.flatRadius * 1.5) {
    L.push(
      `      距 8 字交叉口 ${f1(dCross)}m（压平半径 ${JUNCTION.flatRadius}m，标线让开 ${f2(JUNCTION.paved)}m）`,
    );
  }

  // ---- 水与地形特征 ----
  const basins = getBasins();
  let nearestBasin = { name: '—', d: Infinity };
  basins.forEach((b, i) => {
    const d = Math.hypot(px - b.cx, pz - b.cz);
    if (d < nearestBasin.d) nearestBasin = { name: basinName(i), d };
  });
  L.push(`      最近水面 ${nearestBasin.name} ${nearestBasin.d.toFixed(0)}m  水位高=${f2(basins[0]?.level ?? NaN)}`);
  L.push(`      天色 dusk=${f2(world.sky.state.dusk)}  太阳=(${f2(world.sky.state.sunDir.x)}, ${f2(world.sky.state.sunDir.y)}, ${f2(world.sky.state.sunDir.z)})`);

  // ---- 玩家自己的状态 ----
  L.push(
    `玩家 速度=${f1(world.ride.speedValue)}m/s 朝向=${deg(world.ride.headingValue)}° ` +
      `骑过驿=${game.getSeenStationCount()}/${STATIONS.length} 碎片=${game.getCollectedCount()}/5 ` +
      `当前目标=${game.objective === 'return' ? '回十八驿' : '收齐五件乐事'}`,
  );

  // ---- 镜头 ----
  L.push('镜头');
  L.push('    ' + cameraLine(world));

  // ---- 附近 ----
  L.push(`附近（${radius}m 内）`);
  L.push(...nearbyBuildings(world, px, pz, radius));
  L.push(...nearbyVeg(world, px, pz, radius));

  if (opts.buildings) {
    L.push('');
    L.push(buildingTable(world));
  }
  return L.join('\n');
}

function basinName(i: number): string {
  return `水${i + 1}`;
}

/** 半径内的驿站 / 建筑 */
function nearbyBuildings(world: World, x: number, z: number, radius: number): string[] {
  const out: string[] = [];
  const rows: string[] = [];
  for (const st of world.stations.list) {
    const d = Math.hypot(st.worldPos.x - x, st.worldPos.z - z);
    if (d > radius) continue;
    rows.push(`    驿站 #${String(st.index).padStart(2)} ${pad(st.placement.def.name, 8)} 距 ${f1(d).padStart(5)}m  ${describeStation(st)}`);
  }
  if (rows.length) {
    out.push('  驿站/建筑');
    out.push(...rows);
  }
  return out;
}

/** 一座驿站的一句话状态——「建筑是否正常」最直接的答案 */
function describeStation(st: StationRuntime): string {
  const src = st.loaded ? 'GLB 已加载' : 'GLB 未加载';
  const frag = st.placement.hasFragment ? `碎片「${st.placement.def.fragment}」` : '无碎片';
  return `${frag}  模型=#${st.modelIdx} ${src}  半径=${f1(st.radius)}m  锚点高=${f1(st.glowY)}m`;
}

const pad = (s: string, n: number) => {
  // 中文按 2 个字宽算，否则表格对不齐
  let w = 0;
  let out = '';
  for (const ch of s) {
    out += ch;
    w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
    if (w >= n) break;
  }
  while (w < n) {
    out += ' ';
    w++;
  }
  return out;
};

/** 半径内的植被 */
function nearbyVeg(world: World, x: number, z: number, radius: number): string[] {
  const out: string[] = [];
  const stats = world.veg.stats;
  out.push(
    `  植被 本帧可见：块=${stats.chunksVisible} 树=${stats.trees} 灌木=${stats.bushes} draw=${stats.drawCalls}`,
  );
  // 区域散布：竹 / 现代建筑。数量少但每一件都值钱，所以逐件报最近的那个，
  // 让"西北到底有没有竹"这种问题不必靠截图回答。
  {
    const s = world.scenery.stats;
    out.push(
      `  散布 全图：竹=${s.bamboo} 塔楼=${s.mod_tower} 圆屋=${s.mod_house} · 本帧可见格=${s.visibleCells} draw=${s.drawCalls}`,
    );
    for (const child of world.scenery.group.children) {
      const m = child as { name?: string; visible: boolean; matrixWorld?: Matrix4 };
      if (!m.visible || !m.name) continue;
      const p = new Vector3().setFromMatrixPosition((m.matrixWorld ?? new Matrix4()) as Matrix4);
      const dist = Math.hypot(p.x - x, p.z - z);
      if (dist > radius) continue;
      out.push(`    ${m.name}  距 ${dist.toFixed(0)}m  中心 (${p.x.toFixed(0)}, ${p.z.toFixed(0)})`);
    }
  }
  // 逐个量最近的一株树/灌木（植被是按块实例化的，没有可枚举的实例表，
  // 所以这里量**块**而不是实例——块才是剔除的单位）
  const box = new Box3();
  const v = new Vector3();
  const near: string[] = [];
  for (const group of [world.veg.groupTrees, world.veg.groupBushes]) {
    for (const child of group.children) {
      const mesh = child as { geometry?: unknown; matrixWorld?: unknown; visible: boolean };
      if (!mesh.visible) continue;
      box.setFromObject(child as never);
      if (box.isEmpty()) continue;
      const d = boxDistXZ(box, x, z);
      if (d > radius) continue;
      box.getCenter(v);
      const s = box.getSize(new Vector3());
      const name = (child as { name?: string }).name ?? '(无名)';
      near.push(`    ${pad(name.split('@')[0], 16)} 距 ${f1(d).padStart(5)}m  尺寸 ${f1(s.x)}×${f1(s.y)}×${f1(s.z)}  中心 (${f1(v.x)}, ${f1(v.y)}, ${f1(v.z)})`);
    }
  }
  if (near.length) {
    out.push('  最近的植被块（尺寸是**世界包围盒**，被地面切掉的部分也在里面）');
    out.push(...near.slice(0, 8));
  }

  // ---- 资产加载失败 ----
  //
  // `loadModel()` 失败时是 `resolve(null)`，**不抛异常**，
  // 所以"模型没拉到"过去一次都不会在界面上留下痕迹——
  // 症状只是"路边没有树"，而布置表和剔除统计都说树在那儿。
  // 这一段把失败原因摆出来，它为空才代表什么都没失败。
  if (world.assetErrors.length) {
    out.push(`  资产加载失败 ${world.assetErrors.length} 条：`);
    for (const e of world.assetErrors) out.push(`    ✗ ${e}`);
  }

  // ---- 植被为什么没画出来 ----
  //
  // 这段是被一件**很旧的事**逼出来的：整条环线的行道树从来没有渲染过，
  // 而当时 19 条回归没有一条能发现——它们量的是"布了多少株"，
  // 不是"画了几次"。`attachMeshes()` 建出来的块**在场景里、visible=true、
  // 包围盒也正常**，但渲染器一次都不画它。
  //
  // 所以这里不报"有几株"，报的是**逐项排查表**：
  // 网格在不在 → 可见吗 → 材质是什么 → 材质有没有贴图 → 包围球有效吗。
  out.push('  植被渲染排查');
  for (const [label, group] of [['树', world.veg.groupTrees], ['灌木', world.veg.groupBushes]] as const) {
    const kids = group.children as unknown as {
      name?: string;
      visible: boolean;
      count: number;
      material?: { type?: string; map?: unknown; vertexColors?: boolean };
      geometry?: { attributes?: Record<string, unknown> };
      boundingSphere?: { radius: number; center: { x: number; y: number; z: number } } | null;
      computeBoundingSphere?: () => void;
    }[];
    const vis = kids.filter((k) => k.visible).length;
    out.push(`    ${label}：网格 ${kids.length} 个，可见 ${vis} 个`);
    const first = kids.find((k) => k.visible) ?? kids[0];
    if (!first) {
      out.push(`      ${label} 一个网格都没有 —— attachMeshes() 没跑到`);
      continue;
    }
    const mat = first.material;
    out.push(`      材质 ${mat?.type ?? '(无)'}  贴图=${mat?.map ? '有' : '**无**'}  vertexColors=${mat?.vertexColors ? '开' : '关'}`);
    const attrs = Object.keys(first.geometry?.attributes ?? {});
    out.push(`      几何属性 ${attrs.join('/') || '(空)'}  实例数 ${first.count}`);
    if (first.computeBoundingSphere && first.boundingSphere === null) first.computeBoundingSphere();
    const bs = first.boundingSphere;
    out.push(
      bs
        ? `      包围球 r=${bs.radius.toFixed(1)} 中心(${bs.center.x.toFixed(0)}, ${bs.center.y.toFixed(0)}, ${bs.center.z.toFixed(0)})`
        : '      包围球 **算不出来**',
    );
    // 顶点真实范围。**这一条是「树为什么不画」的关键**：
    // 包围球可能来自 accessor 声明的 min/max（看着正常），
    // 而顶点本身已经飞到别处——两者不一致时只有扫顶点能看出来。
    const pos = (first.geometry as { getAttribute?: (n: string) => { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number } | undefined })?.getAttribute?.('position');
    if (pos) {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < pos.count; i++) {
        const c = [pos.getX(i), pos.getY(i), pos.getZ(i)];
        for (let k = 0; k < 3; k++) {
          if (c[k] < lo[k]) lo[k] = c[k];
          if (c[k] > hi[k]) hi[k] = c[k];
        }
      }
      out.push(
        `      顶点实际范围 x[${lo[0].toFixed(2)}, ${hi[0].toFixed(2)}] y[${lo[1].toFixed(2)}, ${hi[1].toFixed(2)}] z[${lo[2].toFixed(2)}, ${hi[2].toFixed(2)}]  底面 y=${lo[1].toFixed(2)}`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------- 建筑体检
export interface BuildingIssue {
  station: number;
  name: string;
  level: 'err' | 'warn';
  msg: string;
}

/**
 * 体检需要的上下文，**只列它真正用到的三样**。
 *
 * 收窄入参不是为了洁癖，是因为它让"建筑体检"能被无头回归直接跑：
 * `World` 天然满足这个结构（相机、渲染器那些一概不需要），
 * 而 `verify_buildings` 只要造 `Stations + Terrain + Road` 三个真东西，
 * 不用伪造一整个 World 的假字段。
 *
 * 另一半理由更实际：**入参越宽，越容易在某处偷偷加一个字段**，
 * 而建筑体检查错一次（用错地形高度、拿错路口半径）结果就是假绿。
 */
export interface AuditContext {
  stations: { list: StationRuntime[] };
  terrain: { getHeightAt(x: number, z: number): number };
  road: { isOnRoad(x: number, z: number): boolean };
  /**
   * 玩家位置。**可省略**——省略时"未加载"一律不报警。
   *
   * 原因是无头回归里没有 fetch，GLB 根本不会去下载，
   * 那 6 座真模型的 `loaded` 永远是 false。把它判成故障，
   * 等于把**环境限制**报成**代码缺陷**——而这种假红会让人
   * 真的去改一个没坏的地方。所以：只有当玩家已经进了加载半径、
   * 它还赖着不加载时，那才叫问题。
   */
  playerX?: number;
  playerZ?: number;
}

/**
 * 逐座驿站体检。**同一套判据在无头回归里也跑**（`verify_buildings`），
 * 所以「建筑是否正常」不是只能靠眼睛看的一件事。
 *
 * 查五件事，每一件都对应一种"看起来不对"的具体读法：
 *  1. **没加载** —— 那个位置空着，路边少一座房子；
 *  2. **压在路面上** —— `dist` 小于路半宽，房子长在沥青里；
 *  3. **地基不平** —— 建筑底下四个角的地面高度差太大，房子一半悬空一半埋土；
 *  4. **悬空 / 埋土** —— 世界包围盒的最低点明显离地或明显入地；
 *  5. **尺寸离谱** —— 宽到超过 `STATION_FOOT_HALF`，或高到超过站名锚点。
 */
export function auditBuildings(ctx: AuditContext): BuildingIssue[] {
  const issues: BuildingIssue[] = [];
  const box = new Box3();
  const size = new Vector3();
  const center = new Vector3();
  const roadHalf = ROADMESH.TOTAL_HALF_WIDTH;
  const probeR = 6;

  for (const st of ctx.stations.list) {
    const name = st.placement.def.name;
    const push = (level: 'err' | 'warn', msg: string) => issues.push({ station: st.index, name, level, msg });
    const offRecord = offCenterline(st.worldPos.x, st.worldPos.z);

    // 1. 未加载：只有在"已经进了加载半径还赖着"时才算问题。
    //    见 AuditContext.playerX 的说明——无头环境里这不是故障。
    if (!st.loaded) {
      const inRange =
        ctx.playerX !== undefined &&
        ctx.playerZ !== undefined &&
        Math.hypot(st.worldPos.x - ctx.playerX, st.worldPos.z - ctx.playerZ) <= WORLD.STATION_LOAD_DISTANCE;
      if (inRange) push('warn', '在加载半径内但仍未加载，若持续存在说明 GLB 取不到');
    }

    if (!st.object) {
      if (offRecord < roadHalf) push('err', `离中心线只有 ${f1(offRecord)}m < 路半宽 ${f1(roadHalf)}m，长在沥青上`);
      continue;
    }

    box.setFromObject(st.object);
    if (box.isEmpty()) {
      push('err', '对象已在场景里但包围盒是空的');
      continue;
    }
    box.getSize(size);
    box.getCenter(center);

    // 2. 位置记录必须与实际位置一致。
    //    这条是**故意加的**：`worldPos` 与物体实际位置是两份真相，
    //    而 keepout 半径、站名锚点、靠近判定全都只读 `worldPos`。
    //    两者一旦不一致，玩家会在一个空地上完成打卡，而所有"位置"读数都正常。
    //    没有这条，上面那些基于位置的判据全都只量了半边。
    const drift = Math.hypot(center.x - st.worldPos.x, center.z - st.worldPos.z);
    if (drift > 0.5) {
      push('err', `位置记录与实际位置差 ${f1(drift)}m：记录 (${f1(st.worldPos.x)}, ${f1(st.worldPos.z)}) 实际 (${f1(center.x)}, ${f1(center.z)})`);
    }

    // 3. 压路面。用**到路沿的余量**，不用半宽。
    //    半宽是从世界 AABB 量出来的，而矩形绕 Y 转过之后 AABB 必然变大
    //    （15.4m 的驿楼转 30°，AABB 就到 17.2m）——
    //    那个数里混着"朝向"，拿它跟 `STATION_FOOT_HALF` 比，
    //    报出来的会是"这座楼太宽"这种不存在的故障。
    //    真正要守的是**建筑边缘离沥青还有多远**。
    const off = offCenterline(center.x, center.z);
    const halfW = Math.max(size.x, size.z) * 0.5;
    const clearance = off - halfW - roadHalf;
    if (clearance < 0) {
      push('err', `建筑边缘离沥青只剩 ${f2(clearance)}m（会压上路肩）；中心离中心线 ${f1(off)}m，自身半宽 ${f1(halfW)}m`);
    }

    // 4. 地基不平：底面四角取样（用**实际位置**，不是记录值）
    let lo = Infinity;
    let hi = -Infinity;
    for (const [dx, dz] of [[-probeR, -probeR], [probeR, -probeR], [probeR, probeR], [-probeR, probeR]] as const) {
      const h = ctx.terrain.getHeightAt(center.x + dx, center.z + dz);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    const spread = hi - lo;
    if (spread > 3) {
      push('warn', `地基不平：底面四角地面高差 ${f1(spread)}m（>3m），房子会一头悬空一头埋土`);
    }

    // 5. 悬空 / 埋土
    //    注意：模型可能是**架在高台上的**（程序化驿楼有 1.0m 石台基），
    //    所以给 1.5m 容差——低于它是悬空，高于它才是埋土。
    const groundHere = ctx.terrain.getHeightAt(center.x, center.z);
    const gap = box.min.y - groundHere;
    if (gap > 1.5) push('warn', `悬空 ${f2(gap)}m：模型最低点比地面高 ${f2(gap)}m`);
    if (gap < -1.5) push('err', `埋土 ${f2(-gap)}m：模型最低点比地面低 ${f2(-gap)}m`);

    // 6. 尺寸离谱（半宽那条已并入上面的余量判据，这里只管高度）
    if (size.y < 2) push('warn', `只有 ${f1(size.y)}m 高，可能没加载出模型`);
    if (size.y > 40) push('warn', `${f1(size.y)}m 高，远超站名锚点 ${st.labelY}m`);
  }
  return issues;
}

/** 16 座驿站的完整表。给"逐个核对"用 */
export function buildingTable(ctx: AuditContext): string {
  const box = new Box3();
  const s = new Vector3();
  const lines: string[] = [];
  lines.push('驿站体检表（16 座）');
  lines.push(
    '  #  站名      碎片  模型来源        世界坐标            离中心线  尺寸(宽×高×深)   底离地  离沥青  加载',
  );
  for (const st of ctx.stations.list) {
    const src = `GLB#${st.modelIdx}`;
    const frag = st.placement.hasFragment ? st.placement.def.fragment : '·';
    let size = '—';
    let gap = '—';
    let clearance = '—';
    if (st.object) {
      box.setFromObject(st.object);
      if (!box.isEmpty()) {
        box.getSize(s);
        size = `${f1(s.x)}×${f1(s.y)}×${f1(s.z)}`;
        gap = f2(box.min.y - ctx.terrain.getHeightAt(st.worldPos.x, st.worldPos.z));
        const halfW = Math.max(s.x, s.z) * 0.5;
        const off = offCenterline(st.worldPos.x, st.worldPos.z);
        clearance = f2(off - halfW - ROADMESH.TOTAL_HALF_WIDTH);
      }
    }
    lines.push(
      `  ${String(st.index).padStart(2)} ${pad(st.placement.def.name, 9)} ${pad(frag, 4)} ${pad(src, 15)}` +
        ` (${f1(st.worldPos.x)}, ${f1(st.worldPos.z)})  ${f1(offCenterline(st.worldPos.x, st.worldPos.z)).padStart(6)}m` +
        `  ${pad(size, 18)} ${pad(gap, 6)} ${pad(clearance, 6)}  ${st.loaded ? '是' : '否'}`,
    );
  }
  const issues = auditBuildings(ctx);
  const errs = issues.filter((i) => i.level === 'err');
  const warns = issues.filter((i) => i.level === 'warn');
  lines.push('');
  if (issues.length === 0) {
    lines.push('  体检：全部正常（无 err / 无 warn）');
  } else {
    lines.push(`  体检：${errs.length} 个 err、${warns.length} 个 warn`);
    for (const i of issues) lines.push(`    [${i.level}] #${i.station} ${i.name}：${i.msg}`);
  }
  return lines.join('\n');
}

/** 探针的纯文本入口，UI 与 ?probe 都调它 */
export function probe(world: World, q: URLSearchParams, here: { x?: number; z?: number } = {}): string {
  const xStr = q.get('x');
  const zStr = q.get('z');
  const x = xStr !== null ? Number(xStr) : here.x;
  const z = zStr !== null ? Number(zStr) : here.z;
  return probeAt(world, x, z, { buildings: q.has('buildings'), radius: Number(q.get('r') ?? 40) || 40 });
}

/** 供回归用：把体检结果翻成断言能看懂的形状 */
export function auditSummary(ctx: AuditContext): { total: number; errs: number; warns: number; text: string } {
  const issues = auditBuildings(ctx);
  return {
    total: ctx.stations.list.length,
    errs: issues.filter((i) => i.level === 'err').length,
    warns: issues.filter((i) => i.level === 'warn').length,
    text: issues.map((i) => `#${i.station} ${i.name} [${i.level}] ${i.msg}`).join('\n'),
  };
}
