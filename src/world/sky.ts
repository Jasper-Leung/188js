/**
 * 天穹、太阳与昼夜。
 *
 * 昼夜是**第二圈才切**的（第一圈恒定白天，第二圈起随进度推进到黄昏），
 * 这一点是从原作沿用的：玩家在第一圈建立"这里是白天"的印象，
 * 第二个循环才把灯一盏盏亮起来。反转的代价是玩家可能错过，
 * 所以顶栏会在切换那一刻给一行提示。
 *
 * 实现上刻意做成"一个 ShaderMaterial 的几个 uniform 在动"，
 * 而不是每帧重建天空几何：天空在低配上占了满屏，
 * 它的成本必须是一个全屏三角形的片元着色，而不是几百个顶点。
 */
import {
  Mesh,
  SphereGeometry,
  ShaderMaterial,
  BackSide,
  Color,
  Vector3,
  DirectionalLight,
  HemisphereLight,
  AmbientLight,
  Scene,
} from 'three';

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  // 天穹永远跟着相机，不做平移
  vec4 mv = modelViewMatrix * vec4(position + cameraPosition, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w * 0.999999;
}
`;

const SKY_FRAG = /* glsl */ `
precision mediump float;
varying vec3 vDir;
uniform vec3 zenith_day;
uniform vec3 horizon_day;
uniform vec3 zenith_dusk;
uniform vec3 horizon_dusk;
uniform float dusk;
uniform vec3 sun_dir;
uniform vec3 sun_color;
uniform float star_amount;
uniform float moon_amount;

float hash13(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 zenith = mix(zenith_day, zenith_dusk, dusk);
  vec3 horizon = mix(horizon_day, horizon_dusk, dusk);
  // 幂次把地平线附近的过渡拉长，天空才不会在头顶有一道明显的色带
  float t = pow(h, 0.55);
  vec3 col = mix(horizon, zenith, t);

  // 日轮与它的光晕。sun_dir 指向太阳本身。
  float sd = max(dot(normalize(vDir), normalize(sun_dir)), 0.0);
  col += sun_color * pow(sd, 900.0) * 3.0;          // 盘面
  col += sun_color * pow(sd, 12.0) * 0.35;          // 晕
  col += sun_color * pow(sd, 3.0) * 0.10;           // 大范围散射

  // 星星：只有黄昏档才出现，且只在天空上半
  if (star_amount > 0.001) {
    vec3 g = floor(vDir * 320.0);
    float s = hash13(g);
    float star = step(0.9975, s) * smoothstep(0.0, 0.35, vDir.y);
    col += vec3(star) * star_amount * (0.6 + 0.4 * sin(s * 90.0));
  }
  // 月亮：一个柔和的盘
  if (moon_amount > 0.001) {
    vec3 md = normalize(vec3(-sun_dir.x, abs(sun_dir.y) * 0.6 + 0.25, -sun_dir.z));
    float m = max(dot(normalize(vDir), md), 0.0);
    col += vec3(0.85, 0.88, 0.95) * pow(m, 2200.0) * 1.4 * moon_amount;
    col += vec3(0.5, 0.55, 0.7) * pow(m, 30.0) * 0.05 * moon_amount;
  }

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

export interface DayState {
  /** 0 = 白天, 1 = 黄昏 */
  dusk: number;
  sunDir: Vector3;
  sunColor: Color;
  fogColor: Color;
  ambient: number;
}

export class Sky {
  readonly mesh: Mesh;
  readonly sun = new DirectionalLight(0xfff2dd, 2.4);
  readonly hemi = new HemisphereLight(0xbfd8ff, 0x4a5a3a, 0.9);
  readonly ambient = new AmbientLight(0xffffff, 0.25);
  readonly state: DayState = {
    dusk: 0,
    sunDir: new Vector3(0.4, 0.7, 0.3).normalize(),
    sunColor: new Color(1, 0.95, 0.87),
    fogColor: new Color(0.72, 0.8, 0.9),
    ambient: 1,
  };

  private mat: ShaderMaterial;
  private t = 0;
  /** 0 = 白天, 1 = 黄昏。`state.dusk` 是同一份值的对外只读视图。 */
  private duskValue = 0;

  constructor(scene: Scene, shadowMapSize: number, shadowDistance: number) {
    // 球够大就行：它跟着相机，永远在远裁剪面之内
    const geo = new SphereGeometry(1, 24, 16);
    this.mat = new ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: {
        zenith_day: { value: new Color(0.29, 0.5, 0.86) },
        horizon_day: { value: new Color(0.78, 0.86, 0.94) },
        zenith_dusk: { value: new Color(0.11, 0.13, 0.28) },
        horizon_dusk: { value: new Color(0.92, 0.55, 0.32) },
        dusk: { value: 0 },
        sun_dir: { value: [0.4, 0.7, 0.3] },
        sun_color: { value: new Color(1, 0.93, 0.8) },
        star_amount: { value: 0 },
        moon_amount: { value: 0 },
      },
    });
    this.mesh = new Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.scale.setScalar(1);
    scene.add(this.mesh);

    if (shadowMapSize > 0) {
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
      this.sun.shadow.camera.near = 1;
      this.sun.shadow.camera.far = 400;
      this.sun.shadow.camera.left = -shadowDistance;
      this.sun.shadow.camera.right = shadowDistance;
      this.sun.shadow.camera.top = shadowDistance;
      this.sun.shadow.camera.bottom = -shadowDistance;
      this.sun.shadow.bias = -0.0008;
      this.sun.shadow.normalBias = 0.035;
    }
    scene.add(this.sun, this.sun.target, this.hemi, this.ambient);
  }

  /**
   * 推进昼夜。`lap` 是第几圈（1 起），`progress` 是这一圈走了多少（0~1）。
   * 第一圈恒定白天；第二圈起从 0.45 推到 1.0。
   */
  setByProgress(lap: number, progress: number) {
    const target = lap <= 1 ? 0 : Math.min(Math.max((progress - 0.35) / 0.65, 0) * 1.0, 1);
    this.setDusk(target);
  }

  setDusk(v: number) {
    this.duskValue = Math.min(Math.max(v, 0), 1);
    this.state.dusk = this.duskValue;
    this.apply();
  }

  get dusk() {
    return this.duskValue;
  }

  private apply() {
    const d = this.duskValue;
    const u = this.mat.uniforms;
    u.dusk.value = d;
    (u.star_amount.value as number) = Math.max(0, (d - 0.55) / 0.45) * 0.9;
    (u.moon_amount.value as number) = Math.max(0, (d - 0.7) / 0.3);

    // 太阳从头顶偏西落到地平线附近。低角度是黄昏的全部来源：
    // 沥青那层反照率在 9° 太阳下就开始偏色，这条轨迹必须真的压下去。
    const elev = (1 - d) * (Math.PI * 0.42) - 0.06;
    const azim = 0.9 + d * 0.7;
    this.state.sunDir.set(Math.cos(elev) * Math.cos(azim), Math.sin(elev), Math.cos(elev) * Math.sin(azim)).normalize();

    const sd = this.state.sunDir;
    (u.sun_dir.value as number[])[0] = sd.x;
    (u.sun_dir.value as number[])[1] = sd.y;
    (u.sun_dir.value as number[])[2] = sd.z;

    const sunDay = new Color(1, 0.95, 0.87);
    const sunDusk = new Color(1, 0.62, 0.38);
    this.state.sunColor.copy(sunDay).lerp(sunDusk, d);
    (u.sun_color.value as Color).copy(this.state.sunColor);

    const fogDay = new Color(0.72, 0.8, 0.9);
    const fogDusk = new Color(0.45, 0.33, 0.34);
    this.state.fogColor.copy(fogDay).lerp(fogDusk, d);

    this.state.ambient = 1 - d * 0.55;
    this.sun.intensity = 2.4 * this.state.ambient;
    this.sun.color.copy(this.state.sunColor);
    this.hemi.intensity = 0.9 * this.state.ambient;
    this.hemi.color.setHex(0xbfd8ff).lerp(new Color(0x6a6a90), d);
    this.hemi.groundColor.setHex(0x4a5a3a).lerp(new Color(0x2a2434), d);
    this.ambient.intensity = 0.25 * this.state.ambient;
  }

  /** 阴影相机要跟着玩家走，否则 800m 的世界里阴影只在原点附近有效 */
  updateShadowFocus(x: number, y: number, z: number) {
    this.sun.position.set(x + this.state.sunDir.x * 160, y + this.state.sunDir.y * 160, z + this.state.sunDir.z * 160);
    this.sun.target.position.set(x, y, z);
    this.sun.target.updateMatrixWorld();
  }

  /** 天空球挂在相机上，避免玩家走出球外看到黑 */
  attachTo(camera: import('three').PerspectiveCamera) {
    this.mesh.position.copy(camera.position);
    this.mesh.scale.setScalar(camera.far * 0.9);
  }

  tick(dt: number) {
    this.t += dt;
  }

  setShadowsEnabled(on: boolean) {
    this.sun.castShadow = on;
  }
}
