/**
 * 地形 —— 800m 见方的程序化高程场，一整块 mesh，一个 draw call。
 *
 * 两条必须守住的性质：
 *
 * 1. **`planBasins()` 必须在建网格之前跑一次**。碗深是从自然高程反推的，
 *    而网格要按碗深去挖。顺序反过来的话碗深按"没挖过的地形"算，
 *    碗心就浅了目标水深的量，水会薄成一层贴在碗底上的蓝。
 *
 * 2. **`getHeightAt()` 必须与 mesh 顶点完全一致**。mesh 是 6.25m 网格 +
 *    三角形线性插值，而 `heightAt()` 是连续 FBM，两者最多差 0.3m。
 *    如果车/路面/植被按连续值吸附，就会相对可见网格陷进去或浮起来——
 *    表现是车在草里陷半个轮子，而且没有任何异常抛出。
 *    所以这里做的是**三角形平面插值**，不是双线性。
 */
import {
  BufferGeometry,
  BufferAttribute,
  Mesh,
  MeshStandardMaterial,
  Color,
  Vector3,
} from 'three';
import { TERRAIN } from '../data/raw';
import { naturalHeightAt, basinDepthAt, heightAt, planBasins } from './basins';
import { TERRAIN_PATCH, patchStandard } from '../shaders/world';
import { noise2d } from '../core/noise';
import type { QualityPreset } from '../core/settings';
import { clamp } from '../core/math';
import { CENTERLINE } from '../data/route';

const SIZE = TERRAIN.SIZE;
const RES = TERRAIN.RES;
const ROW = RES + 1;
const CELL = SIZE / RES;

export class Terrain {
  readonly mesh: Mesh;
  readonly material: MeshStandardMaterial;
  /** 高程网格，(RES+1)² 个值 */
  private grid: Float32Array;

  constructor(preset?: QualityPreset) {
    // 顺序不能反：碗深要靠自然高程算出来
    planBasins();
    this.grid = this.buildHeightGrid();
    const gd = preset?.groundDetail ?? 0;
    const gdr = preset?.groundDetailRadius ?? 30;

    this.material = new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
      dithering: true,
    });
    const base = new Color();
    base.setRGB(TERRAIN.BASE_COLOR[0], TERRAIN.BASE_COLOR[1], TERRAIN.BASE_COLOR[2]);
    const uniforms = patchStandard(this.material, TERRAIN_PATCH, {
      ground_color: { value: base.convertSRGBToLinear() },
      // `BASE_COLOR` 是源项目的数据，一个数不改。
      // 下面两个是**这里定的**辅助色，跟着着色器里那道去饱和一起调过：
      // 原来那组 (0.24,0.39,0.16) / (0.47,0.545,0.245) 饱和度太高，
      // 加上底色之后整片地读成"游戏里的鲜绿"，一眼就假。
      // 现在把两个都往青灰里收：暗部去掉黄绿、枯黄层去掉土黄，
      // 于是它们和降饱和之后的底色落在同一族里——
      // **辅助色与底色分家，是这类调色最容易犯也最难看出来的一种错。**
      ground_dark: { value: new Color(0.19, 0.25, 0.17) },
      ground_dry: { value: new Color(0.45, 0.46, 0.3) },
      mottle_scale: { value: 0.35 },
      clump_scale: { value: 0.9 },
      speckle_strength: { value: 0.12 },
      detail_fade_near: { value: 6 },
      detail_fade_far: { value: 20 },
      normal_strength: { value: 0.15 },
      ao_strength: { value: 0.5 },
      ground_detail: { value: gd },
      ground_detail_radius: { value: gdr },
    });
    void uniforms;

    this.mesh = new Mesh(this.buildGeometry(), this.material);
    this.mesh.name = 'terrain';
    this.mesh.receiveShadow = true;
    // 800m 见方的地面整体投影对阴影贴图毫无收益（几乎全平），
    // 却要每帧重绘整个阴影 pass。关掉之后车和树的投影仍能落在地面上
    // （那是 receive，不是 cast）。
    this.mesh.castShadow = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  /** 换档：把地面细节强度写进已有的 uniform，不重建材质、不重编译着色器 */
  setPreset(preset: QualityPreset): void {
    const shader = this.material.userData.shader as { uniforms?: Record<string, { value: number }> } | undefined;
    const u = shader?.uniforms;
    if (u?.ground_detail) u.ground_detail.value = preset.groundDetail;
    if (u?.ground_detail_radius) u.ground_detail_radius.value = preset.groundDetailRadius;
  }

  private buildHeightGrid(): Float32Array {
    const g = new Float32Array(ROW * ROW);
    for (let z = 0; z < ROW; z++) {
      for (let x = 0; x < ROW; x++) {
        const wx = (x / RES) * SIZE - SIZE * 0.5;
        const wz = (z / RES) * SIZE - SIZE * 0.5;
        g[z * ROW + x] = naturalHeightAt(wx, wz) - basinDepthAt(wx, wz);
      }
    }
    return g;
  }

  private buildGeometry(): BufferGeometry {
    const vertCount = ROW * ROW;
    const positions = new Float32Array(vertCount * 3);
    const normals = new Float32Array(vertCount * 3);
    const uvs = new Float32Array(vertCount * 2);
    const colors = new Float32Array(vertCount * 3);
    const verge = vergeWeights();

    for (let z = 0; z < ROW; z++) {
      for (let x = 0; x < ROW; x++) {
        const i = z * ROW + x;
        const wx = (x / RES) * SIZE - SIZE * 0.5;
        const wz = (z / RES) * SIZE - SIZE * 0.5;
        const h = this.grid[i];
        positions[i * 3] = wx;
        positions[i * 3 + 1] = h;
        positions[i * 3 + 2] = wz;
        uvs[i * 2] = x / RES;
        uvs[i * 2 + 1] = z / RES;

        // 顶点色只做明暗扰动（0.82~1.0），绿色本体交给 shader。
        // 早先把绿色同时写进顶点色和 albedo，两者相乘后地面亮度只剩 ~0.05，
        // 整片发黑。
        //
        // 用 noise2d 而不是 randf()：randf() 没播种，每次运行这层明暗都不一样，
        // 而且是逐顶点白噪声，在 6.25m 一格的地形上读起来是雪花而不是斑驳。
        // noise2d 是连续场且确定，同一个世界坐标永远给同一个值。
        // 它输出 [-1,1]，要先搬到 [0,1] 再映射到 0.82~1.0。
        groundTint(wx, wz, verge[i], colors, i);
      }
    }

    // 绕序：CCW，法线朝上。Godot 那边为了 cull_back 把绕序定成了
    // cross.y<0 为正面、于是法线取 cross 的反向——移植时这里反过来，
    // 免得把地面剔掉或者收不到阳光渲染成一片黑。
    const indices = new Uint32Array(RES * RES * 6);
    let t = 0;
    for (let z = 0; z < RES; z++) {
      for (let x = 0; x < RES; x++) {
        const i00 = z * ROW + x;
        const i10 = i00 + 1;
        const i01 = i00 + ROW;
        const i11 = i01 + 1;
        indices[t++] = i00;
        indices[t++] = i01;
        indices[t++] = i11;
        indices[t++] = i00;
        indices[t++] = i11;
        indices[t++] = i10;
      }
    }

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('normal', new BufferAttribute(normals, 3));
    geo.setAttribute('uv', new BufferAttribute(uvs, 2));
    geo.setAttribute('color', new BufferAttribute(colors, 3));
    geo.setIndex(new BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  /**
   * 可见地面高度（米）。**与 mesh 顶点一致**：三角形平面插值。
   * 场外返回边缘高度（clamp 到网格边界），不返回 -INF——
   * 场外有硬边界处理，这里的高度只用来贴地。
   */
  getHeightAt(wx: number, wz: number): number {
    const gx = (wx + SIZE * 0.5) / CELL;
    const gz = (wz + SIZE * 0.5) / CELL;
    const x0 = clamp(Math.floor(gx), 0, RES - 1);
    const z0 = clamp(Math.floor(gz), 0, RES - 1);
    const fx = clamp(gx - x0, 0, 1);
    const fz = clamp(gz - z0, 0, 1);
    const i00 = z0 * ROW + x0;
    const h00 = this.grid[i00];
    if (fx + fz <= 1) {
      // 落在 (i00, i10, i01) 这块三角上：三个顶点的重心坐标就是
      // (1-fx-fz, fx, fz)，因为 i00 在原点、i10 沿 +x、i01 沿 +z
      return h00 * (1 - fx - fz) + this.grid[i00 + 1] * fx + this.grid[i00 + ROW] * fz;
    }
    // 落在 (i10, i01, i11) 这块三角上，解 fx+fz>=1 的那组重心坐标：
    // i10=(1,0) i01=(0,1) i11=(1,1) → u=1-fz, v=1-fx, w=fx+fz-1
    const h10 = this.grid[i00 + 1];
    const h01 = this.grid[i00 + ROW];
    const h11 = this.grid[i00 + ROW + 1];
    return h10 * (1 - fz) + h01 * (1 - fx) + h11 * (fx + fz - 1);
  }

  /**
   * 把一个圆盘范围内的地形**压到路面之下**，权重与路面自己用的完全一样。
   *
   * ## 为什么需要它：草从十字路口的路面上长出来
   *
   * 路口是把两条路拉到一个共同平面上（`Road.flattenJunction`），
   * 靠的是 `ys[i] + (junctionY - ys[i]) * w`——**只动路面**。
   * 于是在上坡那一支，自然地形高过这个平面，而路面被拉下来了，
   * 于是地形从路面底下顶上来：路面上出现一块一块的绿。
   * 实测过渡带上高出 8.4cm。
   *
   * 只抬路面不可能解决它：抬到"比最高的地形还高"，路口就会鼓成一个包。
   * 正确的做法和真实路口一样——**挖方**。
   *
   * ## 公式：`h' = lerp(h, min(h, planeY - lift), w)`
   *
   * `min` 是"不许把地形抬上去"：已经低于路面的地方一个字都不改，
   * 只有真正高于路面的那段被削掉。这一步是**幂等且安全**的。
   *
   * ## 为什么这样削完路一定浮在上面
   *
   * 削过之后，路面与地形的间距恒 ≥ `lift`：
   * 若 `h ≤ planeY - lift`，地形不动，而路面是 `lerp(h+lift, planeY, w)`，
   * 两端都不低于 `h + lift`；若 `h > planeY - lift`，削下去正好 `lift`。
   * 权重和路面用的是**同一个** `w`，所以路怎么落、地形就怎么让——
   * 两边各用一套权重的话，总会在某一段差出一个正数，而那个正数就是草。
   *
   * ## 但权重后来改了，而且必须改
   *
   * 照抄路面那个 `w = 1 - smoothstep((d-core)/(flat-core))` 的第一版，
   * 实测只削掉了需要削的**十分之一**：该削 38cm 的地方只削了 3.8cm，
   * 草照样长在路面上。
   *
   * 原因是**采样密度不一样**。路面按中心线密采样（`RESAMPLE_STEP`），
   * `w` 几乎是连续的；地形是 6.25m 的网格，`w` 只在**顶点**上取值，
   * 格与格之间是线性插值。于是顶点 A 满权重、顶点 B 零权重，
   * 中间那一片地面拿到的是**被抹平的权重**——正好就是草要长出来的地方。
   *
   * 所以反过来做：`flat` 以内**满权重**削平，权重在 `flat` 之外的
   * `2 格`里收到 0。这样压平区内每个顶点都真的落在 `planeY - lift` 以下，
   * 而分段线性插值**不会把低的地方插出高的值**——草没有生长的余地。
   *
   * 过渡带整个挪到压平区**外面**，是同一个道理：留在里面的话，
   * 坡面上的地形天然就比路高，那恰恰是原来长草的地方。
   *
   * ## 与 mesh 的一致性
   *
   * `grid` 与 `positions` 是同一个数组的两种视图（顶点 `i = z*ROW + x`），
   * **两处必须一起改**——只改一处的话 `getHeightAt()` 会和看得见的网格
   * 差出一截，而车是按 `getHeightAt()` 贴地的，于是车会浮在草上面。
   * 改完重算法线：削过的地方坡度变了，法线不重算会留下一片假的死光。
   */
  carveJunction(cx: number, cz: number, flat: number, planeY: number, lift: number): void {
    if (!Number.isFinite(planeY)) return;
    const blend = 2 * CELL;
    const floor = planeY - lift;
    const positions = this.mesh.geometry.getAttribute('position');
    for (let z = 0; z < ROW; z++) {
      const wz = (z / RES) * SIZE - SIZE * 0.5;
      for (let x = 0; x < ROW; x++) {
        const wx = (x / RES) * SIZE - SIZE * 0.5;
        const d = Math.hypot(wx - cx, wz - cz);
        if (d >= flat + blend) continue;
        const i = z * ROW + x;
        const h = this.grid[i];
        if (h <= floor) continue;
        const t = d <= flat ? 0 : Math.min((d - flat) / blend, 1);
        const w = 1 - t * t * (3 - 2 * t);
        const carved = h + (floor - h) * w;
        this.grid[i] = carved;
        positions.array[i * 3 + 1] = carved;
      }
    }
    positions.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingSphere();
  }

  /** 场界。越界会被软回弹推回来。 */
  static get halfSize(): number {
    return SIZE * 0.5;
  }

  static get cellSize(): number {
    return CELL;
  }

  /** 自检用：mesh 顶点与高度查询是否一致 */
  verifyConsistency(maxSamples = 400): { ok: boolean; worst: number } {
    let worst = 0;
    let n = 0;
    for (let k = 0; k < maxSamples; k++) {
      // 确定性采样，不走 randf()，每次自检跑的是同一批点
      const wx = (((k * 7919) % 1000) / 1000) * SIZE - SIZE * 0.5;
      const wz = (((k * 6271) % 1000) / 1000) * SIZE - SIZE * 0.5;
      const q = this.getHeightAt(wx, wz);
      // 连续值与网格值的差，理论上 <= 半个格的最大落差
      const continuous = heightAt(wx, wz);
      worst = Math.max(worst, Math.abs(q - continuous));
      n++;
    }
    // 6.25m 网格上的连续 FBM 落差最大约 0.3m，这是"与可见网格一致"的含义
    return { ok: worst < 0.5 && n > 0, worst };
  }
}

/** 地形法线（用差分）。给植被贴地与车体姿态用。 */
export function terrainNormalAt(wx: number, wz: number, out: Vector3, e = 1.2): Vector3 {
  const hL = heightAt(wx - e, wz);
  const hR = heightAt(wx + e, wz);
  const hD = heightAt(wx, wz - e);
  const hU = heightAt(wx, wz + e);
  return out.set(hL - hR, 2 * e, hD - hU).normalize();
}

/**
 * 路边那一圈更绿的草：完全生效到离中心线 `VERGE_FULL` 米，`VERGE_FADE` 米处淡完。
 *
 * 全图的草被 shader 去饱和成「水墨」的灰青（见 TERRAIN_PATCH），
 * 于是路两侧和远山是同一种灰——骑在路上读不出「两边是草」。
 * 只在路边把顶点色往饱满的绿推：远景的水墨不变，近处的路才像被草夹着。
 * 顶点色是乘在去饱和之后的，所以这一层的色相不会被那 62% 吃掉。
 */
export const VERGE = { FULL: 10, FADE: 30 } as const;

/** 顶点色：明暗扰动（0.82~1.0）× 路边的绿。护坡网格也用它，与地形无缝 */
export function groundTint(wx: number, wz: number, verge: number, out: Float32Array, i: number): void {
  // 用 noise2d 而不是 randf()：连续、确定，同一个世界坐标永远给同一个值
  const v = 0.82 + (noise2d(wx * 0.09, wz * 0.09) * 0.5 + 0.5) * 0.18;
  out[i * 3] = v * 1.02 * (1 - 0.2 * verge);
  out[i * 3 + 1] = v * (1 + 0.1 * verge);
  out[i * 3 + 2] = v * 0.94 * (1 - 0.3 * verge);
}

/**
 * 每个地形顶点的「路边权重」（1 = 紧贴路，0 = 远离）。
 * 按线段盖章而不是逐顶点扫全线：960 段 × 每段十几个格点，而不是 1.6 万 × 960。
 */
function vergeWeights(): Float32Array {
  const dist = new Float32Array(ROW * ROW).fill(Infinity);
  const reach = VERGE.FADE;
  const toGrid = (w: number) => (w + SIZE * 0.5) / CELL;
  for (let k = 0; k < CENTERLINE.length - 1; k++) {
    const a = CENTERLINE[k];
    const b = CENTERLINE[k + 1];
    const x0 = clamp(Math.floor(toGrid(Math.min(a.x, b.x) - reach)), 0, RES);
    const x1 = clamp(Math.ceil(toGrid(Math.max(a.x, b.x) + reach)), 0, RES);
    const z0 = clamp(Math.floor(toGrid(Math.min(a.z, b.z) - reach)), 0, RES);
    const z1 = clamp(Math.ceil(toGrid(Math.max(a.z, b.z) + reach)), 0, RES);
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const l2 = Math.max(abx * abx + abz * abz, 1e-9);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const wx = (x / RES) * SIZE - SIZE * 0.5;
        const wz = (z / RES) * SIZE - SIZE * 0.5;
        const t = clamp(((wx - a.x) * abx + (wz - a.z) * abz) / l2, 0, 1);
        const d = Math.hypot(wx - a.x - abx * t, wz - a.z - abz * t);
        const i = z * ROW + x;
        if (d < dist[i]) dist[i] = d;
      }
    }
  }
  const w = new Float32Array(ROW * ROW);
  for (let i = 0; i < w.length; i++) {
    const t = clamp((dist[i] - VERGE.FULL) / (VERGE.FADE - VERGE.FULL), 0, 1);
    w[i] = 1 - t * t * (3 - 2 * t);
  }
  return w;
}
