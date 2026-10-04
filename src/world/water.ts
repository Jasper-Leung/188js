/**
 * 水面 —— 三片碗各一张平面网格，共用一个着色器。
 *
 * 水读成"水"靠三件事，缺一件就变成一张蓝纸：
 *   1. 一直在动的法线（静水面在实时光照下是一块死掉的镜面）
 *   2. 菲涅耳的天空色（掠射角越平越亮，这是水最像水的那个信号）
 *   3. 岸边要淡（从径向距离现算浅水带，没有深度贴图时的替代品）
 *
 * 波形用三个不同频率/方向的解析正弦叠加，**不用噪声纹理**：
 * 零贴图是硬约束，而且正弦的前向差分法线在远景不会像噪声那样糊成一片。
 * 代价是波纹有明显的方向性重复——湖面上看不出来，溪那种细长的一眼里几乎看不见。
 */
import { Mesh, PlaneGeometry, ShaderMaterial, Color, Vector3, DoubleSide, Group } from 'three';
import { WATER_VERT, WATER_FRAG } from '../shaders/world';
import { getBasins, type Basin } from './basins';

export class Water {
  readonly group = new Group();
  private materials: ShaderMaterial[] = [];
  private meshes: Mesh[] = [];
  private sunDir = new Vector3(0.4, 0.7, 0.3);
  private fogColor = new Color(0.7, 0.78, 0.88);
  private fogNear = 40;
  private fogFar = 260;
  private detail: 0 | 1 | 2 = 1;


  constructor(detail: 0 | 1 | 2) {
    this.detail = detail;
    this.group.name = 'water';
    this.rebuild();
  }

  /** 碗定好之后才能建（见 basins.planBasins）。 */
  rebuild() {
    for (const m of this.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    for (const m of this.materials) m.dispose();
    this.materials = [];
    this.meshes = [];

    for (const b of getBasins()) {
      this.addBasin(b);
    }
  }

  private addBasin(b: Basin) {
    // 碗是沿路方向拉长的，所以水面网格要跟着转，否则溪会变成一个正圆
    const size = b.radius * 2.4;
    const seg = this.detail === 0 ? 8 : this.detail === 1 ? 16 : 28;
    const geo = new PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);

    const mat = new ShaderMaterial({
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      side: DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        deep_color: { value: new Color(0.075, 0.15, 0.175) },
        shallow_color: { value: new Color(0.23, 0.375, 0.34) },
        sky_color: { value: new Color(0.52, 0.66, 0.86) },
        dusk_tint: { value: new Color(0.19, 0.17, 0.23) },
        center: { value: [0, 0] },
        radius: { value: b.radius },
        sun_dir: { value: [this.sunDir.x, this.sunDir.y, this.sunDir.z] },
        ripple_scale: { value: 0.55 },
        ripple_speed: { value: 0.9 },
        ripple_amp: { value: b.radius > 25 ? 0.6 : 0.9 },
        shore_inner: { value: 0.42 },
        shore_outer: { value: 1.02 },
        sky_mix: { value: 0.42 },
        dusk_mix: { value: 0 },
        spec_power: { value: 84 },
        fogColor: { value: new Color(0.7, 0.78, 0.88) },
        fogNear: { value: 40 },
        fogFar: { value: 260 },
      },
    });
    this.materials.push(mat);

    const mesh = new Mesh(geo, mat);
    // 平面在局部 XY，转成 XZ；再把"世界空间的碗心"折回局部空间
    mesh.rotation.y = Math.atan2(b.ax, b.az);
    mesh.position.set(b.cx, b.level, b.cz);
    // 碗是 squash 拉长的，水面网格也跟着拉
    mesh.scale.set(1 / b.squash, 1, 1);
    mesh.renderOrder = 1;
    mesh.frustumCulled = true;
    this.meshes.push(mesh);
    this.group.add(mesh);
  }

  /**
   * 浅水带的中心要的是**世界空间**的碗心，而网格为了跟碗对齐做过缩放与旋转，
   * 所以这里把世界中心反变换回局部再传给着色器。
   * 早先直接传 b.cx/b.cz 时，溪那种被 squash 拉长的碗的岸边会整圈偏移——
   * 表现是水面的一边顶到岸上、另一边悬在半空，而碗是照常渲染的。
   */
  private syncCenters() {
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i];
      // 因为 mesh 的中心**就是**碗心（position 直接设在 b.cx/b.cz），
      // 世界空间碗心落在局部原点，所以 center 传 (0,0) 就对了。
      (m.material as ShaderMaterial).uniforms.center.value = [0, 0];
    }
  }

  update(time: number, sunDir: Vector3, fog: { color: Color; near: number; far: number }, dusk: number) {
    this.sunDir.copy(sunDir);
    this.fogColor.copy(fog.color);
    this.fogNear = fog.near;
    this.fogFar = fog.far;

    for (const m of this.materials) {
      m.uniforms.uTime.value = time;
      (m.uniforms.sun_dir.value as number[])[0] = this.sunDir.x;
      (m.uniforms.sun_dir.value as number[])[1] = this.sunDir.y;
      (m.uniforms.sun_dir.value as number[])[2] = this.sunDir.z;
      (m.uniforms.dusk_mix.value as number) = dusk;
      (m.uniforms.fogColor.value as Color).copy(this.fogColor);
      m.uniforms.fogNear.value = this.fogNear;
      m.uniforms.fogFar.value = this.fogFar;
    }
    this.syncCenters();
  }

  setDetail(d: 0 | 1 | 2) {
    if (d === this.detail) return;
    this.detail = d;
    this.rebuild();
  }

  dispose() {
    for (const m of this.meshes) m.geometry.dispose();
    for (const m of this.materials) m.dispose();
    this.group.clear();
  }
}
