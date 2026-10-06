/**
 * 可摸索的旧物 —— **全作最原创的那个设定，第一次变成一个动词。**
 *
 * ## 为什么要做这一件
 *
 * 序章用三张卡把主角的本事讲得很清楚：
 *
 * > 我这双手只会做一件事：东西坏了，我修。修之前我要先摸一遍——
 * > 它自己会讲它是谁、在哪儿待过。
 *
 * 然后整个游戏再也没碰过它。没有可摸的物件，没有一次"听见它讲"的交互，
 * 那只青瓷碗只活在旁白里。设定写在了纸上，玩法里没有它。
 *
 * 于是这里放五件旧物，一座碎片驿站一件。走过去、停下、摸一下，
 * 它讲自己是谁。**这是"叙事 3.0"到"叙事 6.0"之间最便宜的一步**：
 * 零新系统（复用 `showStoryCard` 那条已经跑顺了的链路）、
 * 零新资产（几何全是程序化的，几百个三角面），
 * 而它把主角从"一个在骑车的视角"变成"一个在替所有人记住的手"。
 *
 * ## 为什么放在**路肩外**而不是驿站门口
 *
 * 放在驿站门口的话，站在打卡圈里顺手就能触发——那不是"摸一件旧物"，
 * 那是打卡流程里多一个按键。
 *
 * 放在路肩外 2m 就完全是另一件事了：
 *  `verify_offslow` 的路肩惩罚从 +1.5m 开始，所以够得着它**必须**减速、
 * 必须偏出路面、必须放弃速度。玩家为了听一句故事，
 * 要在一条空了很久的路上停一次车。
 * **这是这个游戏里唯一一件"为了一句话而停车"的事**，而它恰好是最该停的那次。
 *
 * 站位由 `RELIC_FROM_STATION` 从驿站往路的方向退出来，
 * 于是"离中心线 8.5m / 路肩外缘外 2.0m"这个关系是算出来的，不是画出来的。
 */
import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  TorusGeometry,
  Color,
} from 'three';
import { CENTERLINE, FRAGMENT_STATIONS, type StationPlacement } from '../data/route';
import { ROADMESH } from '../data/raw';
import type { Terrain } from './terrain';

export type RelicKind = 'bowl' | 'ring' | 'ledger' | 'shoe' | 'key';

export interface RelicDef {
  kind: RelicKind;
  /** 文案键。标题与正文分开取，标题是这件东西的名字，正文是它讲的话。 */
  titleKey: string;
  textKey: string;
  /** 本体颜色（sRGB） */
  color: [number, number, number];
}

/**
 * 五件，一座碎片驿站一件，**顺序与 `FRAGMENT_SLOT_STATION_IDX` 对齐**
 * （云 / 茶 / 琴 / 竹 / 禽）。顺序不是随意的：青瓷碗就是序章里那只，
 * 它出现在第一位是**回扣**——玩家读到序章第三张卡的时候，
 * 那只碗已经在这条路上了，只是他还没有走过去。
 */
export const RELICS: RelicDef[] = [
  {
    kind: 'bowl',
    titleKey: 'relic_bowl_title',
    textKey: 'relic_bowl_text',
    color: [0.72, 0.78, 0.74],
  },
  {
    kind: 'ring',
    titleKey: 'relic_ring_title',
    textKey: 'relic_ring_text',
    color: [0.55, 0.42, 0.24],
  },
  {
    kind: 'ledger',
    titleKey: 'relic_ledger_title',
    textKey: 'relic_ledger_text',
    color: [0.58, 0.48, 0.36],
  },
  {
    kind: 'shoe',
    titleKey: 'relic_shoe_title',
    textKey: 'relic_shoe_text',
    color: [0.34, 0.26, 0.24],
  },
  {
    kind: 'key',
    titleKey: 'relic_key_title',
    textKey: 'relic_key_text',
    color: [0.60, 0.46, 0.26],
  },
];

/**
 * 旧物中心离中心线多少米。**由路宽推出来，不是一个孤立的数。**
 *
 * = 路面总半宽 + 2.0m，也就是**路肩外缘再往外 2.0m**。
 * 2.0m 配上下面的 `RELIC_REACH` 2.8m，够得着的姿态正好是
 * "骑到路肩上、把车停住、探身出去摸一下"。
 *
 * ## 为什么不写成"从驿站退 N 米"
 *
 * 原来那一版是 `RELIC_FROM_STATION = 9.5`（驿站 → 路方向退 9.5m），
 * 注释里按"驿站横向偏出约 18m"推算出 2.0m——**那个 18m 是估的**。
 * 实测驿站偏出 20.5m，于是五件全都落在路肩外 4.5m，`RELIC_REACH` 2.8m
 * 够不着。`verify_relics` 第一次跑就红了（这也是它存在的理由）。
 *
 * 更要紧的是它**依赖了一个会变的量**：驿站横向偏移由 `STATION_FOOT_HALF`
 * 与路宽推出来，改路宽或改站脚半宽都会让这个数漂，而那时
 * "够不着"这件事没有任何几何判据会报——`verify_stations` 量的是
 * 驿站离路多远，量不到旧物。
 *
 * 所以改成直接规定"离中心线多远"：它只依赖路宽，路宽是稳定的数据常量。
 * 落位沿"驿站 → 最近中心线点"这条方向二分求解，不含近似。
 */
export const RELIC_FROM_ROAD = ROADMESH.TOTAL_HALF_WIDTH + 2.0;

/** 伸手够得到的距离（米）。 */
export const RELIC_REACH = 2.8;

/** 多少米内亮起"这儿有东西"的提示圈。再远就该靠眼睛找了。 */
export const RELIC_CUE_RADIUS = 18;

// ---------------------------------------------------------------- 几何

/**
 * 一件旧物的本体。**零贴图、零下载**，全部程序化。
 *
 * 每一件都压在 200 三角面以内：它们在屏幕上只有几十个像素，
 * 面数花在看不见的地方没有意义，而这是低配优先的项目。
 * 真正干活的是"它在那儿"这件事，不是它的面数。
 */
function buildRelicBody(kind: RelicKind, color: [number, number, number]): Group {
  const g = new Group();
  const mat = new MeshStandardMaterial({
    color: new Color(color[0], color[1], color[2]),
    roughness: 0.78,
    metalness: kind === 'ring' || kind === 'key' ? 0.55 : 0.05,
  });

  switch (kind) {
    case 'bowl': {
      // 碗：半球 + 一圈口沿。压扁的球比 lathe 便宜得多，而 40px 上看不出差别。
      const bowl = new Mesh(new SphereGeometry(0.17, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), mat);
      bowl.position.y = 0.16;
      bowl.rotation.x = Math.PI;
      g.add(bowl);
      const rim = new Mesh(new TorusGeometry(0.165, 0.012, 4, 14), mat);
      rim.position.y = 0.163;
      rim.rotation.x = Math.PI / 2;
      g.add(rim);
      break;
    }
    case 'ring': {
      // 门环：环 + 一小块残存的木门。环挂在门上，门只剩一截。
      const ring = new Mesh(new TorusGeometry(0.13, 0.022, 5, 16), mat);
      ring.position.set(0, 0.5, 0.09);
      g.add(ring);
      const door = new Mesh(new BoxGeometry(0.05, 0.62, 0.46), new MeshStandardMaterial({
        color: new Color(0.36, 0.26, 0.2),
        roughness: 0.94,
      }));
      door.position.set(0, 0.31, 0);
      g.add(door);
      break;
    }
    case 'ledger': {
      // 账本：两页夹一块板，微微翻开——翻开的角度让"这是一本账"读得出来。
      const cover = new Mesh(new BoxGeometry(0.3, 0.05, 0.4), mat);
      cover.position.y = 0.05;
      g.add(cover);
      const pages = new Mesh(new BoxGeometry(0.27, 0.04, 0.36), new MeshStandardMaterial({
        color: new Color(0.87, 0.84, 0.74),
        roughness: 0.95,
      }));
      pages.position.set(0.02, 0.095, 0);
      pages.rotation.z = 0.18;
      g.add(pages);
      break;
    }
    case 'shoe': {
      // 一只鞋：鞋帮 + 鞋底，朝向路边——它是被脱下来扔下的，不是掉的。
      const upper = new Mesh(new BoxGeometry(0.11, 0.1, 0.26), mat);
      upper.position.set(0, 0.1, 0.02);
      g.add(upper);
      const sole = new Mesh(new BoxGeometry(0.12, 0.035, 0.29), new MeshStandardMaterial({
        color: new Color(0.24, 0.2, 0.18),
        roughness: 0.98,
      }));
      sole.position.set(0, 0.018, 0.02);
      g.add(sole);
      const heel = new Mesh(new BoxGeometry(0.11, 0.06, 0.08), mat);
      heel.position.set(0, 0.08, -0.09);
      g.add(heel);
      break;
    }
    case 'key': {
      // 钥匙：杆 + 齿 + 环。挂在半截绳子上，绳子还连着地。
      const shaft = new Mesh(new CylinderGeometry(0.016, 0.016, 0.24, 6), mat);
      shaft.position.set(0, 0.16, 0);
      g.add(shaft);
      const bow = new Mesh(new TorusGeometry(0.05, 0.014, 4, 12), mat);
      bow.position.y = 0.31;
      bow.rotation.x = Math.PI / 2;
      g.add(bow);
      for (const y of [0.06, 0.1]) {
        const bit = new Mesh(new BoxGeometry(0.05, 0.018, 0.016), mat);
        bit.position.set(0.032, y, 0);
        g.add(bit);
      }
      break;
    }
  }
  return g;
}

/** 提示圈：一个贴地的细环。近了才亮，远处是"你自己找"。 */
function buildCueRing(): Mesh {
  // 4×28 的环是 224 三角面 × 5 = 1120，**占掉整个预算的一半**，
  // 而它在屏幕上就是一圈两像素的淡线。降到 3×20（120 面）看不出来，
  // 省下来的 500 多面正好留给本体。
  const ring = new Mesh(
    new TorusGeometry(0.62, 0.02, 3, 20),
    new MeshBasicMaterial({ color: new Color(0.92, 0.86, 0.66), transparent: true, opacity: 0.75 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.05;
  ring.renderOrder = 2;
  return ring;
}

// ---------------------------------------------------------------- 落位

/** 到中心线的最近距离。够了：只需要"离路多远"，不需要最近点是谁。 */
export function distToCenterline(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < CENTERLINE.length - 1; i++) {
    const a = CENTERLINE[i];
    const b = CENTERLINE[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    let t = 0;
    if (l2 > 1e-9) t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const d = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/**
 * 一件旧物的落位：沿"驿站 → 最近中心线点"这条方向，走到**离中心线
 * `RELIC_FROM_ROAD` 米**的位置。
 *
 * 二分而不是"退固定米数"：驿站离路的距离是推出来的、会变，
 * 而"离路多远"是设计要钉住的关系。二分 24 次的误差远小于 1cm，
 * 且只在建世界时跑一次。
 */
export function relicSite(def: StationPlacement, fromRoad = RELIC_FROM_ROAD): { x: number; z: number } {
  let nx = 0;
  let nz = 0;
  let bd = Infinity;
  for (const q of CENTERLINE) {
    const d = (q.x - def.x) * (q.x - def.x) + (q.z - def.z) * (q.z - def.z);
    if (d < bd) {
      bd = d;
      nx = q.x;
      nz = q.z;
    }
  }
  let ax = def.x - nx;
  let az = def.z - nz;
  const l = Math.hypot(ax, az);
  if (l < 1e-6) {
    ax = 1;
    az = 0;
  } else {
    ax /= l;
    az /= l;
  }
  // 距离沿这条射线是单调递减的（驿站一定在路外），所以可以二分。
  let lo = 0;
  let hi = l;
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) / 2;
    const px = def.x - ax * mid;
    const pz = def.z - az * mid;
    if (distToCenterline(px, pz) > fromRoad) lo = mid;
    else hi = mid;
  }
  const t = (lo + hi) / 2;
  return { x: def.x - ax * t, z: def.z - az * t };
}

export interface RelicPlacement {
  def: RelicDef;
  index: number;
  x: number;
  z: number;
  y: number;
  /** 离中心线多少米（给回归量） */
  roadDist: number;
}

export class Relics {
  readonly group = new Group();
  readonly placements: RelicPlacement[] = [];
  private cues: Mesh[] = [];
  private bodies: Object3D[] = [];
  private heard = new Set<number>();
  private time = 0;

  constructor(terrain: Terrain) {
    this.group.name = 'relics';
    for (let i = 0; i < RELICS.length; i++) {
      const st = FRAGMENT_STATIONS[i];
      if (!st) continue;
      const def = RELICS[i];
      const site = relicSite(st);
      const y = terrain.getHeightAt(site.x, site.z);

      const holder = new Group();
      holder.position.set(site.x, y, site.z);
      // 物件朝向路：玩家从路上走过来，他看到的是正面。
      holder.rotation.y = Math.atan2(st.x - site.x, st.z - site.z);

      const body = buildRelicBody(def.kind, def.color);
      holder.add(body);
      this.bodies.push(body);

      const cue = buildCueRing();
      holder.add(cue);
      this.cues.push(cue);
      cue.visible = false;

      this.group.add(holder);
      this.placements.push({
        def,
        index: i,
        x: site.x,
        z: site.z,
        y,
        roadDist: distToCenterline(site.x, site.z),
      });
    }
  }

  /** 提示圈与轻微的呼吸。`px/pz` 是玩家位置。 */
  update(dt: number, px: number, pz: number) {
    this.time += dt;
    for (let i = 0; i < this.placements.length; i++) {
      const p = this.placements[i];
      const d = Math.hypot(px - p.x, pz - p.z);
      const cue = this.cues[i];
      const show = !this.heard.has(i) && d < RELIC_CUE_RADIUS;
      cue.visible = show;
      if (show) {
        // 越近越实。远处是一圈很淡的提示，近处才像"这儿有东西"。
        const k = 1 - d / RELIC_CUE_RADIUS;
        (cue.material as MeshBasicMaterial).opacity = 0.18 + 0.52 * k;
        const s = 0.9 + 0.1 * Math.sin(this.time * 1.6 + i);
        cue.scale.setScalar(s);
      }
      // 旧物在轻轻转。静止的东西读成道具，转的才读成"可以碰"。
      this.bodies[i].rotation.y = Math.sin(this.time * 0.5 + i * 1.3) * 0.12;
      this.bodies[i].position.y = Math.sin(this.time * 0.9 + i) * 0.012;
    }
  }

  /** 面前够得着的那一件。够不着返回 index = -1。 */
  nearest(px: number, pz: number): { index: number; distance: number } {
    return this.nearestWithin(px, pz, RELIC_REACH);
  }

  /**
   * 半径可变的同一件事。
   *
   * 存在的理由是**两个距离对应两种提示，而它们必须来自同一个判据**：
   *  · `RELIC_CUE_RADIUS`（18m）："那边有东西" —— 玩家该减速了。
   *  · `RELIC_REACH`（2.8m）："这件叫什么，按 F" —— 玩家已经停下了。
   *
   * 两处各写一次 `for` 循环的话，圈会慢慢和够得着的范围对不上，
   * 于是出现"提示圈亮着但按 F 没反应"或者反过来——后者更糟：
   * 玩家在一件东西面前站了十几秒，什么都没发生。
   */
  nearestWithin(px: number, pz: number, radius: number): { index: number; distance: number } {
    let best = -1;
    let bestD = Infinity;
    for (const p of this.placements) {
      const d = Math.hypot(px - p.x, pz - p.z);
      if (d < bestD) {
        bestD = d;
        best = p.index;
      }
    }
    if (best < 0 || bestD > radius) return { index: -1, distance: Infinity };
    return { index: best, distance: bestD };
  }

  markHeard(i: number) {
    this.heard.add(i);
  }

  isHeard(i: number): boolean {
    return this.heard.has(i);
  }

  get heardCount(): number {
    return this.heard.size;
  }

  /** 三角面预算。给回归量，也给"这几件东西到底有多贵"一个答案。 */
  triangleCount(): number {
    let n = 0;
    this.group.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      const g = m.geometry as BufferGeometry;
      const idx = g.getIndex();
      n += idx ? idx.count / 3 : g.getAttribute('position').count / 3;
    });
    return n;
  }
}

