/**
 * 场景自检（`?dump=1`）—— 把"玩家眼前到底有什么"打印成可读文本。
 *
 * ## 为什么需要它
 *
 * 图形 bug 有一个讨厌的性质：**看代码永远看不出画面里是什么**。
 * "草地上有正方体"这句话，落到代码上可能是草卡的 alphaTest 没生效、
 * 可能是某个 GLB 没加载出来只剩了个盒子、也可能是相机埋进了树冠里。
 * 三者的修法完全不同，而只有最后一种能从代码看出来。
 *
 * 之前定位"相机卡在树里"就是这么解决的：`?caps` 之外再加一个
 * 能列出附近可渲染对象的面板，答案直接写在屏幕上，不用猜。
 *
 * ## 为什么是 DOM 而不是 console
 *
 * console 的输出在远端排障时拿不到（用户只会给你一张截图），
 * 而 DOM 文本可以用任何"读页面文字"的手段取到——包括无头浏览器。
 * 这个项目里已经有一条同样的思路：`document.title` 写启动进度。
 *
 * 面板每 0.5s 刷新一次，因为要看的东西本身就在动（草皮在重打包、
 * 相机在跟着车走）。静态快照只能回答"某一瞬间长什么样"。
 */
import { Box3, Vector3, type Mesh, type InstancedMesh, type Object3D } from 'three';
import type { World } from '../world/world';

const REFRESH_MS = 500;
/** 列出多远以内的可渲染对象。再远的东西在雾里，看不见也测不到 */
const NEAR_M = 90;
/** 最多列几条。超过这个数说明半径给大了，不是世界有问题 */
const MAX_ROWS = 22;

/**
 * 永远要列出来的东西，不管它在多远。
 *
 * 这几个都是"包围盒不代表它实际在哪"的：路面/地形/水面的包围盒是整个世界，
 * 草皮的包围盒是原点的模板四边形。按距离一滤，它们就一起消失，
 * 而它们恰恰是最该被检查的——草皮整片变黑那次，它压根没出现在列表里。
 */
const KEY_OBJECTS = ['road', 'terrain', 'grass', 'water', 'sky'];

export class SceneDump {
  readonly root: HTMLPreElement;
  private world: World;
  private timer = 0;
  private box = new Box3();
  private v = new Vector3();
  private shown = false;

  constructor(parent: HTMLElement, world: World) {
    this.world = world;
    this.root = document.createElement('pre');
    this.root.className = 'g-dump g-hidden';
    parent.appendChild(this.root);
  }

  /**
   * 默认**不显示**，F9 切换。
   *
   * 这一点是被截图逼出来的：面板铺满屏幕时，恰好挡住了它要帮忙诊断的东西。
   * 一个看不见世界的调试工具，等于把工具本身变成新的故障。
   */
  toggle(): void {
    this.shown = !this.shown;
    this.root.classList.toggle('g-hidden', !this.shown);
    if (this.shown) this.paint();
  }

  get isShown(): boolean {
    return this.shown;
  }

  /** 每帧调；内部自己按 0.5s 节流 */
  update(dt: number): void {
    if (!this.shown) return;
    this.timer += dt * 1000;
    if (this.timer < REFRESH_MS) return;
    this.timer = 0;
    this.paint();
  }

  private paint(): void {
    const w = this.world;
    const p = w.ride.pos;
    const s = w.renderer.stats();
    const cam = w.ride.camera;
    const lines: string[] = [];

    lines.push(`player  x=${p.x.toFixed(1)} y=${p.y.toFixed(1)} z=${p.z.toFixed(1)}  speed=${w.ride.speedValue.toFixed(1)}  onRoad=${w.ride.onRoad()}`);
    lines.push(`camera  x=${cam.position.x.toFixed(1)} y=${cam.position.y.toFixed(1)} z=${cam.position.z.toFixed(1)}`);
    lines.push(`draw=${s.calls} tris=${s.triangles} scale=${s.scale.toFixed(2)}`);
    lines.push(`veg     ${JSON.stringify(w.veg.stats)}`);
    lines.push('');

    const rows: { d: number; line: string }[] = [];
    w.scene.traverse((o: Object3D) => {
      const m = o as Mesh;
      if (!m.isMesh || !m.geometry) return;
      const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
      if (mats.length === 0) return;

      this.box.setFromObject(o);
      if (this.box.isEmpty()) return;

      // 距离按**包围盒**算，不按中心点。
      // 路面、地形、草皮、水面这四个的包围盒中心都在世界原点附近，
      // 而玩家就在原点附近——按中心点算它们会被判成"在一公里外"，
      // 于是恰好是最该看的东西被过滤掉了。踩过一次就够了。
      //
      // 但草皮是另一个方向的坑：它的包围盒是**模板四边形**（原点的 1×1），
      // 与实例位置无关（`frustumCulled = false`，GPU 端才展开）。
      // 所以它离玩家 200m 也得像现在这样被按距离滤掉——
      // 而它恰恰是最需要看的一个（曾经它的 NaN 法线让它整片变黑，
      // 而它在列表里根本没出现过）。给关键对象开一个不受距离限制的口子。
      const d = boxDistXZ(this.box, p.x, p.z);
      const key = KEY_OBJECTS.some((k) => o.name.includes(k));
      if (d > NEAR_M && !key) return;

      this.box.getCenter(this.v);
      const size = this.box.getSize(new Vector3());
      const inst = o as InstancedMesh;
      const count = inst.isInstancedMesh ? inst.count : 1;
      const verts = m.geometry.getAttribute('position')?.count ?? 0;
      const tris = Math.floor(verts / 3) * (inst.isInstancedMesh ? count : 1);
      const mat = mats[0] as {
        type?: string;
        color?: { getHexString(): string };
        map?: unknown;
        vertexColors?: boolean;
        alphaTest?: number;
        side?: number;
        emissive?: { getHexString(): string };
      };
      const alpha = mat.alphaTest ?? 0;
      const side = mat.side ?? 0;

      rows.push({
        d,
        line:
          `${d.toFixed(1).padStart(6)}m  ${(o.name || '(无名)').slice(0, 20).padEnd(20)}` +
          ` inst=${String(count).padStart(4)} vis=${o.visible ? 1 : 0}` +
          ` bbox=${size.x.toFixed(1).padStart(6)}x${size.y.toFixed(1).padStart(5)}x${size.z.toFixed(1).padStart(6)}` +
          ` @${this.v.x.toFixed(0).padStart(5)},${this.v.y.toFixed(0).padStart(4)},${this.v.z.toFixed(0).padStart(5)}` +
          ` mat=${(mat.type || '?').replace('Mesh', '').replace('Material', '')}` +
          ` col=${mat.color ? mat.color.getHexString() : '-'}` +
          ` map=${mat.map ? 'Y' : 'n'}` +
          ` vc=${mat.vertexColors ? 'Y' : 'n'}` +
          ` aT=${alpha} sd=${side}` +
          ` tris=${tris}`,
      });
    });

    rows.sort((a, b) => a.d - b.d);
    lines.push(`包围盒落在 ${NEAR_M}m 内的可渲染对象：${rows.length}`);
    for (const r of rows.slice(0, MAX_ROWS)) lines.push(r.line);
    if (rows.length > MAX_ROWS) lines.push(`… 还有 ${rows.length - MAX_ROWS} 条`);

    this.root.textContent = lines.join('\n');
  }

  dispose(): void {
    this.root.remove();
  }
}

/** 点到轴对齐包围盒在 XZ 上的最短距离。点在盒内返回 0 */
function boxDistXZ(box: Box3, x: number, z: number): number {
  const dx = Math.max(box.min.x - x, 0, x - box.max.x);
  const dz = Math.max(box.min.z - z, 0, z - box.max.z);
  return Math.hypot(dx, dz);
}
