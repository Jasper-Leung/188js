/**
 * 程序化驿站建筑 —— 给 7 类地标生成真正的几何体。
 *
 * ## 为什么要写这个模块
 *
 * 源项目的资产包里，13 个站模型只有 5 个是真建筑（`station_0..4`，2.3~3.3MB）。
 * 另外 7 个——驿楼、茶寮、岭台、神苑、凉亭、廊、亭灯——是作者自己搭的**灰盒**：
 * 每个部件就是一个长方体，整站 24~84 个顶点、8~28 个三角形，文件 8~13KB。
 * 加上 `tree.glb` 顶替的"榕树下"，16 座驿站里有 9 座在屏幕上就是几个方块。
 *
 * 灰盒在黑客松里是可以接受的（它在 16 座里占 9 座，而评审大多在打卡而不是远看）。
 * 正式版不行：玩家要绕着它骑、要停在它前面打卡，方块会在整个环线上反复出现，
 * 而"路边有几个灰盒子"会把玩家对这个世界全部的认真判断一起拉低。
 *
 * ## 为什么是程序化而不是找美术补模型
 *
 * 三个理由，按重要性排：
 *
 * 1. **零贴图是这个项目的一等约束**。路面、地形、草皮、水面全是着色器算出来的，
 *    整个 dist 只有 8.6MB。新加 7 个 GLB 哪怕各压到 300KB 也是 +2MB，
 *    而程序化几何一共不到 3k 个三角形、**0 字节**。
 * 2. **低配友好**。程序化几何是一次性的 BufferGeometry，7 座合起来 7 次 draw call，
 *    三角形比原来的灰盒还少（灰盒虽然面数低，但 9 座各占一个 draw call 且要下载）。
 * 3. **可维护**。建筑长什么样就是几行参数，改一次屋顶坡度不用重导模型。
 *
 * ## 怎么保证不改动玩法
 *
 * 站的**位置、半径、高度锚点**全部来自提取出来的数据，一个数都没动：
 * 位置仍由 `data/route.ts` 的 `STATIONS` 算（它依赖 `STATION_FOOT_HALF = 8`），
 * 标签与光柱锚点仍用 `STATION_GLB_CONFIG` 里的 `label_y / glow_y / glow_range`。
 * 所以这里只替换"长什么样"，不动"在哪儿、多大、什么时候触发"。
 *
 * **几何体直接以米为单位生成，不再乘 `cfg.scale`。**
 * 灰盒是"小模型 × 大缩放"（驿楼 ×10、凉亭 ×12、亭灯 ×14），而程序化几何
 * 直接就是最终尺寸——两套缩放同时生效会把站撑到 2 倍，把
 * `verify_stations` 那条"离中心线 ≥ 路宽 + 0.9×foot_half"判据顶穿。
 */

/** 灰盒模型对应的建筑类型。键是 `STATION_GLB_CONFIG` 的下标。 */
export type ArchKind = 'inn' | 'teahut' | 'terrace' | 'shrine' | 'pavilion' | 'corridor' | 'lantern';

/**
 * `STATION_GLB_CONFIG` 下标 → 建筑类型。
 *
 * 0~4 是真模型（不动），5 是 `tree.glb`（"榕树下"这个地标本来就是一棵树，不动），
 * 6~12 是灰盒。**这张表是资产现状的记录，不是设计选择**——
 * 换成真模型之后删掉对应条目即可，`stations.ts` 会自动回到加载 GLB 的路径。
 */
export const ARCH_BY_MODEL_IDX: Record<number, ArchKind> = {
  6: 'inn',
  7: 'teahut',
  8: 'terrace',
  9: 'shrine',
  10: 'pavilion',
  11: 'corridor',
  12: 'lantern',
};

export function archKindFor(modelIdx: number): ArchKind | null {
  return ARCH_BY_MODEL_IDX[modelIdx] ?? null;
}

// ---------------------------------------------------------------- 配色
/**
 * 六个常量就是这个项目全部的建筑色彩预算。
 *
 * 灰盒之所以"读成方块"，一大半原因是**它是单色的**——一个没有明暗层次的
 * 灰色体积，看不出是墙还是屋顶。这里给每类构件一个独立颜色，
 * 再叠一层廉价的假 AO（见 MeshBuilder.push），让体积自己分层。
 *
 * 深色瓦顶 + 暖木柱 + 冷灰石台基是中国园林建筑最容易读出来的三件套，
 * 也是零贴图条件下信息量最高的组合：即使剪影全糊，三块颜色仍然分得开。
 */
const C = {
  /** 深色瓦屋顶。压到接近沥青的明度，免得在黄昏的低太阳下和路面糊在一起 */
  tile: [0.128, 0.113, 0.094],
  /** 屋檐底面（望板 + 椽子）。比瓦面暖一点，让檐口有厚度感 */
  soffit: [0.222, 0.166, 0.117],
  /** 木柱与木构件 */
  wood: [0.404, 0.212, 0.128],
  /** 木构件的暗部（栏杆、窗棂） */
  woodDark: [0.262, 0.138, 0.086],
  /** 石台基 / 石阶 / 石柱 */
  stone: [0.475, 0.462, 0.428],
  /** 石构件的暗部（勒脚、柱础） */
  stoneDark: [0.322, 0.314, 0.294],
  /** 灯笼纸面：全场唯一的高亮色块，也是"这里有人住"的信号 */
  paper: [0.96, 0.78, 0.47],
  /** 灰白墙板。中式建筑墙面是素的——它存在的意义就是给深色屋顶一个对比底 */
  plaster: [0.72, 0.69, 0.62],
} as const;

// ---------------------------------------------------------------- 屋面
/**
 * 一次 `upturnedRoof` 的解析记录。
 *
 * 判据「屋面不许浮空」要量的是"屋面下表面与正下方支撑顶面的最小间距"，
 * 而在网格里靠"顶部若干高度带"找哪些三角形是屋面**必然误判**——
 * 柱头、瓦当、宝顶都落在同一条带里（神苑四根石灯柱的柱头实测就在顶部 25% 带内）。
 * 存下参数就能**解析地**算屋面底高度，不依赖任何网格分类。
 *
 * `triFrom/triTo` 是本屋面在三角形数组里的区间。**判据必须靠它把屋面自己排除掉**：
 * 屋面底面是由 seg×seg 个**平面小片**拼出来的，而举折是凹曲面，
 * 于是平片的弦恒定落在解析曲面**之下**——不排除的话，每片屋面底面都会
 * 被当成"它正下方的支撑"，量出来永远是 0.002m 那样的假接触。
 *
 * 下面三个函数是 `upturnedRoof` 与本记录**共用**的同一份公式：
 * 抄两份公式的判据，一定会在某次改参数后悄悄失效。
 */
export interface RoofSpan {
  cx: number;
  /** 檐口零平面（t=1 处的屋面顶高度）。`upturnedRoof` 的 `cy` 就是它 */
  cy: number;
  cz: number;
  hw: number;
  hd: number;
  h: number;
  lift: number;
  thickness: number;
  /** 屋面下表面（望板）在归一化平面坐标 (u,v) 处的高度。u/v ∈ [-1,1] */
  soffitAt(u: number, v: number): number;
}

/** 一座屋面：解析参数 + 它在网格里占的三角形区间 */
export interface RoofPart {
  span: RoofSpan;
  triFrom: number;
  triTo: number;
}

/** 举折 + 角部起翘。t 是到檐口的切比雪夫距离，`corner` 是角部权重 */
function roofRise(h: number, lift: number, t: number, corner: number): number {
  const eave = ss(0.5, 1, t);
  return h * Math.pow(1 - t, 1.7) + lift * eave * eave * corner;
}

/** 角部起翘权重：只在四角起作用，不让整条檐线一起翘成弧形 */
function roofCornerWeight(u: number, v: number): number {
  return ss(0.55, 1, Math.abs(u)) * ss(0.55, 1, Math.abs(v));
}

/** 檐口封边厚度：檐口那圈要厚一点，当封檐板看 */
function roofShellThickness(thickness: number, t: number): number {
  return thickness * (0.4 + 0.6 * t);
}

function makeRoofSpan(
  cx: number, cy: number, cz: number,
  hw: number, hd: number, h: number, lift: number, thickness: number,
): RoofSpan {
  return {
    cx, cy, cz, hw, hd, h, lift, thickness,
    soffitAt: (u, v) => {
      const t = Math.max(Math.abs(u), Math.abs(v));
      return cy + roofRise(h, lift, t, roofCornerWeight(u, v)) - roofShellThickness(thickness, t);
    },
  };
}

/**
 * 求"让屋面坐在 `seatY` 上"的 `cy`。
 *
 * ## 为什么不能直接把 `cy` 写成柱高
 *
 * `upturnedRoof` 的 `cy` 是**檐口零平面**（t=1 处屋面顶的高度），不是脊高。
 * 而支撑（柱子、额枋、墙顶）立在 t<1 的位置，那里屋面按 `(1−t)^1.7` 抬起来了。
 * 于是"`cy = 柱顶`"会让屋面整体**浮在支撑上方**：
 *
 *     净空 = h·(1−t)^1.7 + lift·eave²·corner − thickness·(0.4+0.6·t)
 *
 * 岭台实测 t=0.435 时净空 **+0.32m** —— 一眼就能看出来的"顶凭空多了一个"。
 * 这个函数把净空解掉，让屋面**下表面**正好压在支撑顶面上。
 *
 * `u,v` 是支撑所在位置的归一化屋面坐标（`支撑半宽 / 屋面半宽`）。
 * 支撑是一圈柱子或一圈额枋，屋面对称，四个角上抬的量一样，取哪个角都一样。
 */
function roofCyToSeatOn(
  h: number,
  lift: number,
  thickness: number,
  u: number,
  v: number,
  seatY: number,
): number {
  const t = Math.max(Math.abs(u), Math.abs(v));
  const clearance = roofRise(h, lift, t, roofCornerWeight(u, v)) - roofShellThickness(thickness, t);
  return seatY - clearance;
}

// ---------------------------------------------------------------- 网格构建
/**
 * 非索引、平面着色的网格构建器。
 *
 * **不用索引缓冲**是刻意的：这个项目已经被三角形绕序坑过两次
 * （路面整条背向剔除、路面三角形判据符号写反）。非索引 + 构建期自动定朝向，
 * 让"面朝反了"这件事在构建时就不可能发生——代价是顶点数翻倍，
 * 而这 7 座建筑加起来还不到 6k 个顶点。
 */
export class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];

  /** 每次 `upturnedRoof` 的解析记录。判据靠它算屋面底高度，见 `RoofPart` */
  readonly roofs: RoofPart[] = [];

  /**
   * 假环境光遮蔽：离地越近越暗。
   *
   * 这是零贴图条件下"让一堆盒子读成建筑"最省的一手——真实的 AO 要烘焙进贴图，
   * 而这里只要按顶点高度乘一个系数，柱脚、台阶根部、屋檐下沿就自动沉下去。
   * `aoRange` 3.5m 是"从地面到人眼高度"的经验值：再大就压不到根了。
   */
  private aoGround = 0;
  private aoRange = 3.5;

  setGroundAO(groundY: number, range = 3.5): this {
    this.aoGround = groundY;
    this.aoRange = Math.max(range, 0.5);
    return this;
  }

  private aoAt(y: number): number {
    return 0.7 + 0.3 * ss(0, this.aoRange, y - this.aoGround);
  }

  /**
   * 加一个三角形。`outward` 是希望它朝向的方向（不要求精确，只要大致对）：
   * 算出来的法线与它点积为负就把顶点 1/2 交换。
   */
  tri(
    p0: readonly number[],
    p1: readonly number[],
    p2: readonly number[],
    color: readonly number[],
    outward: readonly number[],
    ao: readonly number[] = [1, 1, 1],
  ) {
    const abx = p1[0] - p0[0];
    const aby = p1[1] - p0[1];
    const abz = p1[2] - p0[2];
    const acx = p2[0] - p0[0];
    const acy = p2[1] - p0[1];
    const acz = p2[2] - p0[2];
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const flip = nx * outward[0] + ny * outward[1] + nz * outward[2] < 0;
    const a = p0;
    const b = flip ? p2 : p1;
    const c = flip ? p1 : p2;
    const ab = flip ? ao[2] : ao[1];
    const ac = flip ? ao[1] : ao[2];
    if (flip) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    // 假 AO 按顶点高度叠上去，和传入的 ao 相乘
    const g0 = this.aoAt(a[1]) * ao[0];
    const g1 = this.aoAt(b[1]) * ab;
    const g2 = this.aoAt(c[1]) * ac;
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.col.push(
      color[0] * g0, color[1] * g0, color[2] * g0,
      color[0] * g1, color[1] * g1, color[2] * g1,
      color[0] * g2, color[1] * g2, color[2] * g2,
    );
  }

  /** 四边形（按 a→b→c→d 绕一圈给点），自动拆成两个同朝向的三角形 */
  quad(
    p0: readonly number[],
    p1: readonly number[],
    p2: readonly number[],
    p3: readonly number[],
    color: readonly number[],
    outward: readonly number[],
    ao?: readonly number[],
  ) {
    const q = ao ?? [1, 1, 1, 1];
    this.tri(p0, p1, p2, color, outward, [q[0], q[1], q[2]]);
    this.tri(p0, p2, p3, color, outward, [q[0], q[2], q[3]]);
  }

  /**
   * 长方体。`c` 是**中心**，`size` 是全长宽高。
   *
   * 六个面各给一次 outward，于是调用方不需要关心绕序——
   * 这是这个模块能一次写对的主要原因。
   */
  box(c: readonly number[], size: readonly number[], color: readonly number[], aoScale = 1) {
    const [w, h, d] = size;
    const hw = w / 2;
    const hh = h / 2;
    const hd = d / 2;
    const [x, y, z] = c;
    // 8 个角：底面 4 个在 -y，顶面 4 个在 +y
    const b0 = [x - hw, y - hh, z - hd];
    const b1 = [x + hw, y - hh, z - hd];
    const b2 = [x + hw, y - hh, z + hd];
    const b3 = [x - hw, y - hh, z + hd];
    const t0 = [x - hw, y + hh, z - hd];
    const t1 = [x + hw, y + hh, z - hd];
    const t2 = [x + hw, y + hh, z + hd];
    const t3 = [x - hw, y + hh, z + hd];
    const lo = aoScale * 0.8;
    const hi = aoScale;
    this.quad(b3, b2, b1, b0, color, [0, -1, 0], [lo, lo, lo, lo]);
    this.quad(t0, t1, t2, t3, color, [0, 1, 0], [hi, hi, hi, hi]);
    this.quad(b0, b1, t1, t0, color, [0, 0, -1], [lo, lo, hi, hi]);
    this.quad(b2, b3, t3, t2, color, [0, 0, 1], [lo, lo, hi, hi]);
    this.quad(b1, b2, t2, t1, color, [1, 0, 0], [lo, lo, hi, hi]);
    this.quad(b3, b0, t0, t3, color, [-1, 0, 0], [lo, lo, hi, hi]);
  }

  /** 底面贴地的长方体（`y` 是底面高度，不是中心） */
  boxOnGround(x: number, z: number, y0: number, w: number, h: number, d: number, color: readonly number[], aoScale = 1) {
    this.box([x, y0 + h / 2, z], [w, h, d], color, aoScale);
  }

  /**
   * 棱柱柱身（`seg` 边的正多边形截面）。`rBot` / `rTop` 不同就是一个收分的柱，
   * 亭子与神苑的石柱要的就是这种。
   */
  prism(
    c: readonly number[],
    rBot: number,
    rTop: number,
    h: number,
    seg: number,
    color: readonly number[],
    cap = true,
  ) {
    const [x, y, z] = c;
    const y0 = y - h / 2;
    const y1 = y + h / 2;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0);
      const s0 = Math.sin(a0);
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1);
      const p0 = [x + c0 * rBot, y0, z + s0 * rBot];
      const p1 = [x + c1 * rBot, y0, z + s1 * rBot];
      const p2 = [x + c1 * rTop, y1, z + s1 * rTop];
      const p3 = [x + c0 * rTop, y1, z + s0 * rTop];
      const mx = (c0 + c1) * 0.5;
      const mz = (s0 + s1) * 0.5;
      this.quad(p0, p1, p2, p3, color, [mx, 0.2, mz]);
      if (cap) {
        this.tri([x, y0, z], p0, p1, color, [0, -1, 0]);
        this.tri([x, y1, z], p3, p2, color, [0, 1, 0]);
      }
    }
  }

  /**
   * 起翘屋顶 —— 整套中国建筑里**信息量最大**的一个构件。
   *
   * 三件事叠在一起才认得出是"中式屋顶"，少一件就退回成金字塔：
   *
   * 1. **举折**：屋面不是直线斜面，而是脊部陡、檐口缓的下凹曲线
   *    （`y = h·(1−t)^1.7`，t 是到檐口的切比雪夫距离）。指数 1.7 是目测调出来的：
   *    1.0 是纯斜面（像车库），2.0 以上檐口又太翘像蒙古包。
   * 2. **起翘**：檐口在正中最低、在四个角上扬。角部权重
   *    `smoothstep(0.55,1,|u|)·smoothstep(0.55,1,|v|)` 保证只在角上起作用，
   *    不然整条檐线会一起翘成弧形，一眼假。
   * 3. **厚度**：檐口是上下两层壳夹出来的，不是零厚度面片——
   *    从下方看过去的檐底（望板）颜色更暖，檐口因此有了"厚度"。
   *
   * 参数都用**米**。`seg` 控制细分：10 段已经能读出起翘，
   * 6 段是低档的取舍（棱角更硬，但剪影一样）。
   */
  upturnedRoof(
    cx: number,
    cy: number,
    cz: number,
    hw: number,
    hd: number,
    h: number,
    lift: number,
    seg: number,
    opts?: { soffit?: readonly number[]; thickness?: number },
  ) {
    const thickness = opts?.thickness ?? 0.26;
    const soffit = opts?.soffit ?? C.soffit;
    const triFrom = this.triangleCount;

    const px = (i: number) => cx + ((i / seg) * 2 - 1) * hw;
    const pz = (j: number) => cz + ((j / seg) * 2 - 1) * hd;

    /** 顶面高度场。三件事叠在一起：中式举折的凹曲屋面 + 角部起翘 + 檐口封边厚度 */
    const yTop = (i: number, j: number) => {
      const u = (i / seg) * 2 - 1;
      const v = (j / seg) * 2 - 1;
      const t = Math.max(Math.abs(u), Math.abs(v));
      return cy + roofRise(h, lift, t, roofCornerWeight(u, v));
    };
    /** 底面跟着顶面走，檐口处更厚（那圈要当封檐板看） */
    const yBot = (i: number, j: number) => {
      const t = Math.max(Math.abs((i / seg) * 2 - 1), Math.abs((j / seg) * 2 - 1));
      return yTop(i, j) - roofShellThickness(thickness, t);
    };
    /** 封边一段。`dir` 是这条边朝外的水平方向 */
    const rim = (i0: number, j0: number, i1: number, j1: number, dirX: number, dirZ: number) => {
      this.quad(
        [px(i0), yTop(i0, j0), pz(j0)],
        [px(i1), yTop(i1, j1), pz(j1)],
        [px(i1), yBot(i1, j1), pz(j1)],
        [px(i0), yBot(i0, j0), pz(j0)],
        soffit,
        [dirX, 0, dirZ],
      );
    };

    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        this.quad(
          [px(i), yTop(i, j), pz(j)],
          [px(i + 1), yTop(i + 1, j), pz(j)],
          [px(i + 1), yTop(i + 1, j + 1), pz(j + 1)],
          [px(i), yTop(i, j + 1), pz(j + 1)],
          C.tile,
          [0, 1, 0],
        );
      }
    }
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        this.quad(
          [px(i), yBot(i, j), pz(j)],
          [px(i), yBot(i, j + 1), pz(j + 1)],
          [px(i + 1), yBot(i + 1, j + 1), pz(j + 1)],
          [px(i + 1), yBot(i + 1, j), pz(j)],
          soffit,
          [0, -1, 0],
        );
      }
    }
    // 四条边的封檐板。四段各自走一遍，角上会自然交叠——这正是
    // 真实屋顶角部"两块封檐板叠合"的样子，不需要额外补角。
    for (let k = 0; k < seg; k++) {
      rim(k, 0, k + 1, 0, 0, -1);
      rim(seg, k, seg, k + 1, 0, 1);
      rim(k, seg, k + 1, seg, 0, 1);
      rim(0, k, 0, k + 1, -1, 0);
    }

    this.roofs.push({
      span: makeRoofSpan(cx, cy, cz, hw, hd, h, lift, thickness),
      triFrom,
      triTo: this.triangleCount,
    });
  }

  build() {
    return {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nrm),
      colors: new Float32Array(this.col),
    };
  }

  get triangleCount(): number {
    return this.pos.length / 9;
  }
}

function ss(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------- 常用构件
/**
 * 一圈木柱。`nx × nz` 根，方形布置在 `(cx,cz)` ± hx / ±hz 上。
 *
 * **`cx`/`cz` 是必须的，不是可选的。**
 * 上一版这个 helper 没有水平中心，七座建筑里五座碰巧都在原点于是看不出来，
 * 而岭台与神苑的小龛是偏置的（`zc=3.4` / `nicheZ=3.3`）——
 * 于是柱子**留在原点**，屋面和碑却建在 3.3m 外：屋顶凭空多出来一个，
 * 下面什么都没有。岭台那一眼就能看出来的"顶浮在空中"就是这个。
 * 默认值给 0 反而会把这个坑重新埋回去，所以这里没有默认值。
 */
function posts(
  mb: MeshBuilder,
  cx: number,
  cz: number,
  y0: number,
  h: number,
  hx: number,
  hz: number,
  nx: number,
  nz: number,
  r: number,
  color: readonly number[],
) {
  for (let i = 0; i < nx; i++) {
    const x = cx + (nx === 1 ? 0 : -hx + (i / (nx - 1)) * hx * 2);
    for (let j = 0; j < nz; j++) {
      const z = cz + (nz === 1 ? 0 : -hz + (j / (nz - 1)) * hz * 2);
      mb.box([x, y0 + h / 2, z], [r * 2, h, r * 2], color);
    }
  }
}

/** 栏杆：一根扶手 + 若干望柱。沿矩形四条边走一圈 */
function railing(
  mb: MeshBuilder,
  y0: number,
  hx: number,
  hz: number,
  h: number,
  step: number,
  color: readonly number[],
) {
  const railY = y0 + h;
  const t = 0.09;
  // 四条扶手
  mb.box([0, railY, -hz], [hx * 2 + t * 2, t * 1.6, t], color);
  mb.box([0, railY, hz], [hx * 2 + t * 2, t * 1.6, t], color);
  mb.box([-hx, railY, 0], [t, t * 1.6, hz * 2], color);
  mb.box([hx, railY, 0], [t, t * 1.6, hz * 2], color);
  // 望柱
  const nx = Math.max(2, Math.round((hx * 2) / step) + 1);
  const nz = Math.max(2, Math.round((hz * 2) / step) + 1);
  for (let i = 0; i < nx; i++) {
    const x = -hx + (i / (nx - 1)) * hx * 2;
    mb.box([x, y0 + h / 2, -hz], [t * 1.5, h, t * 1.5], color);
    mb.box([x, y0 + h / 2, hz], [t * 1.5, h, t * 1.5], color);
  }
  for (let j = 1; j < nz - 1; j++) {
    const z = -hz + (j / (nz - 1)) * hz * 2;
    mb.box([-hx, y0 + h / 2, z], [t * 1.5, h, t * 1.5], color);
    mb.box([hx, y0 + h / 2, z], [t * 1.5, h, t * 1.5], color);
  }
}

/** 正面台阶（朝 -Z，即朝向路的一侧） */
function steps(mb: MeshBuilder, z0: number, w: number, n: number, rise: number, run: number, color: readonly number[]) {
  for (let i = 0; i < n; i++) {
    const h = rise * (n - i);
    mb.boxOnGround(0, z0 - i * run, 0, w, h, run, color);
  }
}

// ---------------------------------------------------------------- 七类地标
/**
 * 生成本地空间的几何体：**原点在地面中心，正面朝 -Z**。
 *
 * 正面朝 -Z 是为了让 `stations.ts` 能把整座建筑转向路——
 * 沿路骑行时一排建筑的门面全对着你，这是"这里有人"最强的读法，
 * 而随机朝向的方块永远读不出来。
 *
 * 所有尺寸都受两条硬约束（都由 `verify_stations` 守）：
 *   · 水平半宽 ≤ `STATION_FOOT_HALF` = 8m，否则会压到路面上；
 *   · 总高接近该站的 `label_y`，否则站名标签会插进屋顶里。
 */
export function buildStationArch(kind: ArchKind, seg: number): MeshBuilder {
  const mb = new MeshBuilder().setGroundAO(0, 4.0);
  switch (kind) {
    case 'inn':
      buildInn(mb, seg);
      break;
    case 'teahut':
      buildTeahut(mb, seg);
      break;
    case 'terrace':
      buildTerrace(mb, seg);
      break;
    case 'shrine':
      buildShrine(mb, seg);
      break;
    case 'pavilion':
      buildPavilion(mb, seg);
      break;
    case 'corridor':
      buildCorridor(mb, seg);
      break;
    case 'lantern':
      buildLantern(mb, seg);
      break;
  }
  return mb;
}

/**
 * 驿楼 —— 两层木构，硬山式起翘大屋顶。
 *
 * 两层而不是一层：驿站在原作里是"过路人落脚的地方"，
 * 二层挑出的楼身 + 栏杆是这个功能最省力的读法。
 * 挑出 0.8m（二层比底层大）也顺手解决了"为什么屋顶这么大"——
 * 屋檐要盖住挑出的那圈，比例才对。
 */
function buildInn(mb: MeshBuilder, seg: number) {
  const plinthH = 1.0;
  mb.boxOnGround(0, 0, 0, 12.0, plinthH, 8.6, C.stone);
  mb.boxOnGround(0, 0, 0.12, 11.2, 0.22, 7.8, C.stoneDark); // 勒脚
  steps(mb, -4.3, 3.6, 3, 0.34, 0.55, C.stone);

  // 一层
  const f1y = plinthH;
  const f1h = 3.4;
  mb.boxOnGround(0, 0, f1y, 10.0, f1h, 7.0, C.plaster);
  posts(mb, 0, 0, f1y, f1h, 4.9, 3.4, 4, 3, 0.17, C.wood);
  // 门与窗：比墙暗一档的内凹板。零贴图下"开口"只能靠明暗做
  mb.box([0, f1y + 1.15, -3.52], [1.9, 2.3, 0.1], C.woodDark);
  for (const sx of [-3.1, 3.1]) {
    mb.box([sx, f1y + 2.0, -3.52], [1.3, 1.1, 0.1], C.woodDark);
  }
  mb.boxOnGround(0, 0, f1y + f1h, 10.4, 0.26, 7.4, C.woodDark); // 腰檐

  // 二层（挑出 0.8m）
  const f2y = f1y + f1h + 0.26;
  const f2h = 2.9;
  mb.boxOnGround(0, 0, f2y, 11.6, f2h, 8.0, C.plaster);
  posts(mb, 0, 0, f2y, f2h, 5.7, 3.9, 5, 3, 0.17, C.wood);
  railing(mb, f2y, 5.8, 4.0, 0.78, 1.5, C.wood);
  for (const sx of [-3.6, 0, 3.6]) {
    mb.box([sx, f2y + 1.7, -4.02], [1.5, 1.2, 0.1], C.woodDark);
  }

  const roofY = f2y + f2h;
  mb.upturnedRoof(0, roofY, 0, 7.6, 4.9, 2.5, 1.5, seg);
  // **这里原来有一根正脊横条，被删掉了。**
  // 删的理由不是"不好看"，是它在几何上是错的：起翘屋顶的脊是一条**线**，
  // 而正脊横条是一条**保持脊高走完全宽的直棱**（15.4m × 0.3m × 0.5m，
  // 放在 roofY + 2.46）。屋面从脊往两侧按 (1−t)^1.7 陡降，
  // 于是横条两头各悬出约 2.5m —— 画面上就是一根浮在屋顶上方的黑杠。
  //
  // 真正的歇山顶确实有正脊，但它只跨**中间那段平脊**，两端就收在屋面里了。
  // 这里不做：庑殿顶本身没有平脊，脊就是一个点，加一条脊线只会更像盒子。
}

/** 茶寮 —— 四面开敞的小茶棚，一根横梁 + 竹席顶。 */
function buildTeahut(mb: MeshBuilder, seg: number) {
  mb.boxOnGround(0, 0, 0, 9.2, 0.45, 7.0, C.stone);
  steps(mb, -3.5, 2.6, 2, 0.22, 0.5, C.stone);
  const postH = 5.2;
  const y0 = 0.45;
  posts(mb, 0, 0, y0, postH, 3.5, 2.6, 2, 2, 0.19, C.wood);
  // 座凳：三面围合，正面（朝路）留空——茶寮是坐下来喝东西的地方
  for (const [cx, cz, w, d] of [
    [0, 2.1, 7.0, 0.7],
    [-3.1, 0, 0.7, 4.6],
    [3.1, 0, 0.7, 4.6],
  ] as const) {
    mb.boxOnGround(cx, cz, y0 + 0.38, w, 0.38, d, C.woodDark);
  }
  // 横枋
  mb.boxOnGround(0, 0, y0 + postH - 0.34, 7.4, 0.3, 5.6, C.wood);
  mb.upturnedRoof(0, y0 + postH - 0.04, 0, 5.4, 3.8, 2.1, 1.25, seg);
}

/**
 * 岭台 —— 一方石台 + 栏板，后面立一座有顶的界碑小龛。
 *
 * 这是七类里最"空"的一个（它本来就是观景台），所以全部造型预算
 * 都花在栏板和那座小龛上。空的东西不靠体量靠**边框**成立：
 * 一圈望柱把视线框起来，读作"这里有边界"。
 */
function buildTerrace(mb: MeshBuilder, seg: number) {
  mb.boxOnGround(0, 0, 0, 15.0, 0.85, 11.0, C.stone);
  railing(mb, 0.85, 7.1, 5.1, 0.95, 2.2, C.stoneDark);
  steps(mb, -5.5, 3.2, 2, 0.42, 0.6, C.stone);

  // 界碑小龛（放在靠里的一端，正面朝路）
  const zc = 3.4;
  const nicheH = 5.4;
  const ny = 0.85;
  // 小龛的水平尺寸：柱心距柱心
  const hx = 1.0;
  const hz = 0.7;
  // 屋面尺寸
  const rw = 2.3;
  const rd = 1.7;
  const rh = 1.3;
  const rlift = 0.85;
  const rth = 0.26;
  const postTop = ny + 0.4 + nicheH;
  mb.boxOnGround(0, zc, ny, 2.6, 0.4, 2.0, C.stoneDark);
  // 柱子必须跟着 zc 走（见 posts 的注释）
  posts(mb, 0, zc, ny + 0.4, nicheH, hx, hz, 2, 2, 0.15, C.wood);
  // 碑：一片立石
  mb.boxOnGround(0, zc, ny + 0.4, 0.85, 2.6, 0.28, C.stone);
  // 屋面**坐在柱顶上**，不是浮在柱顶上方 0.32m
  mb.upturnedRoof(
    0,
    roofCyToSeatOn(rh, rlift, rth, hx / rw, hz / rd, postTop),
    zc, rw, rd, rh, rlift, seg,
  );

  // 角上两块矮石，避免大面积空台读成一块灰板
  mb.box([-5.4, 1.1, -3.4], [1.3, 0.5, 1.3], C.stoneDark);
  mb.box([5.4, 1.1, 3.4], [1.3, 0.5, 1.3], C.stoneDark);
}

/** 神苑 —— 三级圆形祭坛 + 四根石灯柱 + 后面一座有顶的碑龛。 */
function buildShrine(mb: MeshBuilder, seg: number) {
  const tiers: [number, number][] = [[4.6, 0.36], [3.7, 0.36], [2.8, 0.36]];
  let y = 0;
  for (const [r, h] of tiers) {
    mb.prism([0, y + h / 2, 0], r, r, h, 12, C.stone);
    y += h;
  }
  // 中央祭台
  mb.prism([0, y + 0.45, 0], 1.5, 1.35, 0.9, 8, C.stoneDark);
  // 四根石灯柱，方位对角
  const postH = 3.2;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const x = Math.cos(a) * 2.3;
    const z = Math.sin(a) * 2.3;
    mb.boxOnGround(x, z, y, 0.7, 0.22, 0.7, C.stoneDark); // 柱础
    mb.prism([x, y + 0.22 + postH / 2, z], 0.26, 0.22, postH, 6, C.stone);
    mb.boxOnGround(x, z, y + 0.22 + postH, 0.62, 0.2, 0.62, C.stoneDark); // 柱头
  }

  /**
   * 碑龛 —— 神苑**唯一带屋顶的部分**。
   *
   * 上一版没有它，于是这一类在体检报告里"最高的那批顶点"其实是四根柱子的柱头
   * （4.50~4.70，跨 0.2m），屏幕上读作"这站没有屋顶"。
   *
   * 为什么放在最后沿而不是正中心：正中心是祭台，四根石灯柱围着一圈，
   * 中间塞一座 2.4m 宽的龛会把祭台堵死。放在后沿（+Z，正面是 -Z 朝路），
   * 从正前方看过去正好在祭台背后，不挡。
   */
  const nicheZ = 3.3;
  const baseY = y + 0.36;  mb.boxOnGround(0, nicheZ, baseY, 2.6, 0.45, 1.9, C.stoneDark); // 台
  // 柱子必须跟着 nicheZ 走（见 posts 的注释），神苑的碑龛同样偏置
  posts(mb, 0, nicheZ, baseY + 0.45, 2.4, 0.95, 0.6, 2, 2, 0.14, C.wood); // 四柱
  mb.boxOnGround(0, nicheZ, baseY + 0.45, 1.9, 1.6, 0.24, C.stone); // 碑身
  mb.boxOnGround(0, nicheZ, baseY + 2.85, 2.2, 0.16, 1.5, C.woodDark); // 额枋
  // 屋面坐在**额枋**顶面上（额枋 2.2×1.5，屋面 3.8×3.0）
  mb.upturnedRoof(
    0,
    roofCyToSeatOn(1.15, 0.85, 0.26, 1.1 / 1.9, 0.75 / 1.5, baseY + 3.01),
    nicheZ, 1.9, 1.5, 1.15, 0.85, seg,
  );

  // 外圈散石：八个不等高的小方块，给圆形轮廓加一点手工感
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    const s = 0.5 + (i % 3) * 0.16;
    mb.boxOnGround(Math.cos(a) * 3.25, Math.sin(a) * 3.25, 0.72, s, s * 0.8, s, C.stoneDark);
  }
}

/** 凉亭 —— 四角攒尖顶。底座八角、屋面四角，是亭子最好认的剪影组合。 */
function buildPavilion(mb: MeshBuilder, seg: number) {
  mb.prism([0, 0.28, 0], 3.9, 3.9, 0.56, 8, C.stone);
  const y0 = 0.56;
  const postH = 3.5;
  // 柱础
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    mb.prism([sx * 2.6, y0 + 0.16, sz * 2.6], 0.44, 0.4, 0.32, 8, C.stoneDark);
  }
  posts(mb, 0, 0, y0 + 0.32, postH, 2.6, 2.6, 2, 2, 0.17, C.wood);
  // 美人靠：只在两个侧面，正面与背面留空
  for (const sz of [-1, 1]) {
    mb.boxOnGround(0, sz * 2.15, y0 + 0.32, 4.4, 0.42, 0.5, C.woodDark);
    mb.boxOnGround(0, sz * 2.15, y0 + 0.74, 4.4, 0.16, 0.62, C.wood);
  }
  // 檐枋
  mb.boxOnGround(0, 0, y0 + 0.32 + postH - 0.3, 5.8, 0.26, 5.8, C.wood);
  const roofY = y0 + 0.32 + postH - 0.04;
  mb.upturnedRoof(0, roofY, 0, 4.4, 4.4, 2.0, 1.5, seg);
  // 宝顶
  mb.prism([0, roofY + 2.0 + 0.28, 0], 0.34, 0.1, 0.56, 6, C.stone);
}

/**
 * 廊 —— 五开间的带顶步道。横向拉长是它唯一的辨识特征，所以柱子要密。
 *
 * 屋顶原来只有 1.5m 抬升、罩在 3.1m 高的柱子上，整座 4.96m 高——
 * 从侧面看就是**一条贴着梁的平板**，读不出"屋顶"，
 * 反而像一张浮在柱子上的桌板。现在抬到 2.4m，并让两端各挑出 1.2m。
 */
function buildCorridor(mb: MeshBuilder, seg: number) {
  // 台基 15.0 → 13.0。缩短台基**不是**为了省体积，是为了把出檐让出来：
  // 屋面半宽卡在 `STATION_FOOT_HALF` = 8m（`verify_stations` 守着），
  // 台基缩到 13.0 之后屋面（15.8m）比它多出 1.4m，两端各挑一截——
  // 这才是"廊"该有的出檐，而原来 15.0 的台基配 16.0 的屋面只挑 0.5m，
  // 加上 1.5m 的抬升，整座读出来像"柱子顶上一块板"。
  mb.boxOnGround(0, 0, 0, 13.0, 0.4, 4.6, C.stone);
  steps(mb, -2.3, 2.0, 2, 0.2, 0.45, C.stone);
  const y0 = 0.4;
  const postH = 3.1;
  // 5 开间 = 每侧 6 根柱
  posts(mb, 0, 0, y0, postH, 5.8, 1.9, 6, 2, 0.16, C.wood);
  // 两侧座凳
  for (const sz of [-1.55, 1.55]) {
    mb.boxOnGround(0, sz, y0 + 0.4, 11.0, 0.4, 0.55, C.woodDark);
  }
  // 额枋
  mb.boxOnGround(0, 0, y0 + postH - 0.3, 12.4, 0.26, 4.2, C.wood);
  // 抬升 1.5 → 2.4（原来太浅，读成一块平板），半宽 7.9 贴着限值
  mb.upturnedRoof(0, y0 + postH - 0.04, 0, 7.9, 3.3, 2.4, 1.5, seg);
}

/**
 * 亭灯 —— 石灯笼。原型是灰盒里那 6 个方块的原样：
 * 基础 / 莲座 / 竿 / 中台 / 火袋 / 笠，一件不少。
 *
 * 火袋用亮纸色而不是自发光：自发光要单独一份材质（多一次 draw call），
 * 而这里只需要它在逆光下比周围都亮——零贴图下这个差别已经足够读成"灯"。
 */
function buildLantern(mb: MeshBuilder, seg: number) {
  // 基础
  mb.boxOnGround(0, 0, 0, 2.9, 0.42, 2.9, C.stoneDark);
  // 莲座
  mb.prism([0, 0.67, 0], 1.2, 0.98, 0.5, 8, C.stone);
  // 竿
  const poleH = 3.1;
  mb.prism([0, 0.92 + poleH / 2, 0], 0.44, 0.38, poleH, 8, C.stone);
  // 中台
  const platY = 0.92 + poleH;
  mb.boxOnGround(0, 0, platY, 2.1, 0.3, 2.1, C.stone);
  // 火袋：四角柱 + 四面纸窗 + 顶盖
  const boxY = platY + 0.3;
  const boxH = 1.5;
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    mb.box([sx * 0.66, boxY + boxH / 2, sz * 0.66], [0.2, boxH, 0.2], C.stone);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const x = Math.cos(a) * 0.66;
    const z = Math.sin(a) * 0.66;
    mb.box([x, boxY + boxH / 2, z], [1.34, boxH * 0.72, 0.9], C.paper, 1.0);
  }
  mb.boxOnGround(0, 0, boxY + boxH, 1.7, 0.16, 1.7, C.stone);
  // 笠（顶盖）
  const roofY = boxY + boxH + 0.16;
  mb.upturnedRoof(0, roofY, 0, 1.55, 1.55, 0.85, 0.72, seg);
  // 宝珠
  mb.prism([0, roofY + 0.85 + 0.22, 0], 0.3, 0.08, 0.44, 6, C.stone);
}

