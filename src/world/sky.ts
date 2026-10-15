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
  /**
   * 天穹永远跟着相机，不做平移——平移由 attachTo() 写进 mesh.position，
   * modelViewMatrix 里已经带上它了。
   *
   * ⚠ 这里原来写的是 vec4(position + cameraPosition, 1.0)，而且是在
   * 模型矩阵**之前**加的。两个后果叠在一起：cameraPosition 先被
   * mesh.scale（= camera.far * 0.9，810）放大，再被 mesh.position
   * 加上一遍，球心跑到 cameraPosition 的 811 倍那么远——相机离球面
   * 六万多米，而球半径只有 810m。
   *
   * 也就是说**这个天空球从来没有出现在画面里过**：玩家看到的那片均匀浅蓝
   * 是 renderer 的 clearColor（0x9ab6d8），不是天空。渐变、云、日轮、
   * 星星、月亮、黄昏染色全是死代码。只有在世界原点附近（cameraPosition ≈ 0）
   * 它才偶尔露一下脸，所以这个 bug 在首屏看不出来。
   */
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
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

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
    mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
    u.y);
}

float fbmSky(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  v += a * vnoise2(p);
  p *= 2.03; a *= 0.5;
  v += a * vnoise2(p);
  p *= 2.01; a *= 0.5;
  v += a * vnoise2(p);
  return v;
}

void main() {
  float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 zenith = mix(zenith_day, zenith_dusk, dusk);
  vec3 horizon = mix(horizon_day, horizon_dusk, dusk);
  // 幂次把地平线附近的过渡拉长，天空才不会在头顶有一道明显的色带
  float t = pow(h, 0.55);
  vec3 col = mix(horizon, zenith, t);

  /**
   * 程序化云带。
   *
   * 没有云的天空是**渐变**，而渐变读作"渲染"；真实照片里的天空几乎总是
   * 有云的——哪怕万里无云，地平线上方也有一条积云的边。
   * 这是"像不像照片"里性价比最高的一笔：它不加任何几何、不加任何 draw call，
   * 只在已有的那个全屏三角形里多做两次 fbm。
   *
   * 投影方式：把视线方向投到 y=1 的平面上取 uv。天空球是 normalize(position)，
   * 所以 vDir 就是单位方向，vDir.xz / vDir.y 就是那个交点。
   * 代价是地平线附近 uv 会爆掉——所以同时按 vDir.y 做一道软遮罩把噪声压下去。
   */
  if (vDir.y > 0.02) {
    vec2 cuv = vDir.xz / vDir.y;
    // 压扁：把 uv 沿 y 方向拉长，云层才是"横铺"的而不是正对着看的一团
    vec2 c2 = vec2(cuv.x * 0.55, cuv.y * 0.16);
    float n = fbmSky(c2 * 0.9 + vec2(0.0, 0.0));
    float n2 = fbmSky(c2 * 2.7 + vec2(5.2, 1.3));
    // 积云：只有高处才成形（n 的阈值随高度变化）
    float cover = mix(0.72, 0.42, smoothstep(0.02, 0.45, vDir.y));
    float cloud = smoothstep(cover, cover + 0.20, n * 0.7 + n2 * 0.3);
    // 地平线上淡出，免得看见噪声被投影拉成条纹
    cloud *= smoothstep(0.02, 0.20, vDir.y);
    // 云底偏灰、云顶偏亮——这是云看起来"厚"而不是"一层纱"的唯一原因
    float lit = smoothstep(cover, cover + 0.32, n * 0.7 + n2 * 0.3);
    vec3 cloudCol = mix(horizon * 0.94, horizon * 1.10, lit);
    cloudCol = mix(cloudCol, zenith * 1.05, 0.25);
    // 黄昏时云底染色，日落那一层红就是这么来的
    cloudCol = mix(cloudCol, mix(vec3(0.95, 0.62, 0.40), cloudCol, 0.45), dusk);
    col = mix(col, cloudCol, cloud * (0.62 - 0.18 * dusk));
  }

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

/** `attachTo()` 每帧要读一次相机的世界位置，别在热路径里 new。 */
const _skyPos = new Vector3();

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
  /**
   * 主体补光。**不投阴影**，位置跟着相机走。
   *
   * ## 为什么世界级的三盏灯救不了它
   *
   * `sun` 的方向随一天里的时刻走，`hemi` 从天顶补——而三种机位里，
   * 玩家看到的**永远是骑手的背**（`first` 更是把角色藏了）。
   * 背对着太阳的那一面只剩 `hemi` 的下半球（`groundColor` 是暗绿），
   * 于是骑手和车在画面正中读成**一团黑**，看不出是个人在骑车。
   *
   * 而这件事不能靠调 `sun`/`hemi` 解决：抬高它们会把整张画面一起抬亮，
   * 草地、路面、树全跟着变淡，主体还是那团黑——只是黑得没那么明显。
   *
   * ## 为什么放在"相机这一侧"
   *
   * 位置**跟着相机走**：落在"相机与主体之间、略偏上偏侧"，
   * 所以不管玩家在 `forward` / `chase` / `first` 哪一个机位、
   * 也不管他把车转向哪边，主体的**正面永远有一盏灯对着它**。
   * 固定在世界坐标里的灯做不到这件事：车一转过去它就又背光了。
   *
   * ## 它**照得到全世界**，这一点必须写下来
   *
   * three.js 没有"这盏灯只照这几个物体"这回事：`Light.layers`
   * 只决定这盏灯**要不要参与渲染**（拿 `camera.layers` 比），
   * 一旦参与，它对场景里每一个受光材质都生效。
   * 我先按"灯锁一层、物体额外开一层"写过一版，实测主体亮度回到关灯时的
   * 97.1 —— 那一层直接让这盏灯被整个剔除了，等于没加。
   *
   * 所以范围这件事只能交给**强度**去换：抬到能把主体救回来（0.9）就停，
   * 再往上主体就发白。中间试过给载具与角色的材质加 `emissive`，
   * 指标漂亮（主体平均 117.7、暗像素 0%）而玩家一眼看出"变白了"——
   * emissive 是漫反射之后的常数，背光面和受光面抬得一样多，
   * 那不是"被太阳照到"，是刷了一层漆。已删；
   * `verify_subject_lighting` 现在守着"载具与角色的材质一个字节都不许动"。
   */
  readonly rim = new DirectionalLight(0xfff0dd, 0.85);
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
    scene.add(this.sun, this.sun.target, this.hemi, this.ambient, this.rim, this.rim.target);
  }

  /**
   * 推进昼夜。
   *
   * ## 现在有两个来源，取较大的那个
   *
   * · **圈内进度**（原来的）：第 1 圈恒定白天，第 2 圈起从 0.45 推到 1.0。
   *   它管的是"这一圈里天黑得怎么样"。
   * · **日期**（新的）：从第 1 天的 0 线性推到期限那天的 0.85。
   *   它管的是"这一趟走到哪儿了"。
   *
   * 为什么必须有第二个：日期会因**打卡**推进，而打卡发生在圈内——
   * 只看圈内进度的话，一个把所有碎片都在第一圈里收完的玩家
   * 会在一个已经收齐的下午看到天一点不暗，
   * 三十日期限于是又一次只存在于律师函里。
   * 加上日期之后，**磨蹭的人和赶路的人看到的是不同的天色**，
   * 而这正是"期限在走"唯一不需要一行字就能表达的方式。
   *
   * 0.85 而不是 1.0：期限那天不应该是全黑的——
   * 玩家还得看得见路，而"天色变了"不需要变成"看不见了"才成立。
   */
  setByProgress(lap: number, progress: number, day = 1, dayLimit = 30) {
    const byLap = lap <= 1 ? 0 : Math.min(Math.max((progress - 0.35) / 0.65, 0), 1);
    const byDay = dayLimit > 1 ? Math.min(Math.max((day - 1) / (dayLimit - 1), 0), 1) * 0.85 : 0;
    this.setDusk(Math.max(byLap, byDay));
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
    // 补光跟着一起暗，否则黄昏时主体会比整张画面还亮。
    // 1.5 是实测出来的：主体区域的平均亮度 97.1 → 109.1，暗像素（<40）8.1% → 3.2%。
    this.rim.intensity = 0.9 * this.state.ambient;
    this.rim.color.copy(this.state.sunColor).lerp(new Color(1, 0.97, 0.94), 0.5);
  }

  /** 阴影相机要跟着玩家走，否则 800m 的世界里阴影只在原点附近有效 */
  updateShadowFocus(x: number, y: number, z: number) {
    this.sun.position.set(x + this.state.sunDir.x * 160, y + this.state.sunDir.y * 160, z + this.state.sunDir.z * 160);
    this.sun.target.position.set(x, y, z);
    this.sun.target.updateMatrixWorld();
  }

  /**
   * 补光跟着**相机**走：落在相机与主体之间、略偏上偏侧。
   *
   * `dx/dz` 是"主体 → 相机"的水平方向（由调用方从相机位置反推，
   * 因为 `Sky` 不该知道 `Ride` 的机位）。灯放在这条线上，
   * 于是主体的正面永远朝着相机那一侧有光——这正是三个机位共缺的那一盏。
   *
   * 侧偏 0.35、抬高 0.55：全打在正前方会拍平成一张证件照，
   * 偏一点才有"从旁边来的光"的体积感。
   */
  updateRimFocus(dx: number, dz: number, x: number, y: number, z: number) {
    // 相机正好压在主体上时（`first` 之外不该发生，但别除以零）
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    // 右手侧 = 视线方向左转 90°
    const sx = -uz;
    const sz = ux;
    this.rim.position.set(x + ux * 6 + sx * 2.1, y + 3.3, z + uz * 6 + sz * 2.1);
    this.rim.target.position.set(x, y, z);
    this.rim.target.updateMatrixWorld();
  }

  /** 天空球挂在相机上，避免玩家走出球外看到黑 */
  attachTo(camera: import('three').PerspectiveCamera) {
    // **用世界位置**，不是 `camera.position`。相机可能挂在挂架下
    // （`World.rig`，XR 会话里它是非零的），那时 `position` 是挂架内的
    // 局部坐标，拿它当世界坐标摆天穹会让球心偏出去一整个挂架位移。
    camera.getWorldPosition(_skyPos);
    this.mesh.position.copy(_skyPos);
    this.mesh.scale.setScalar(camera.far * 0.9);
  }

  tick(dt: number) {
    this.t += dt;
  }

  setShadowsEnabled(on: boolean) {
    this.sun.castShadow = on;
  }

  /**
   * 开/关天穹本身。
   *
   * 湖边那一屏用全景照片当背景（`Lakeside` 的 `LAKESIDE_PANO`），
   * 而两个都是"跟着相机的大球"——同时开着只是白画一遍满屏。
   *
   * ⚠ 关掉之后要**靠 `World.setWorldVisible()` 打开**：那个方法里
   * 对 `sky.mesh` 有一条"永远可见"的特例。所以从湖边出来不必再调一次。
   */
  setVisible(on: boolean) {
    this.mesh.visible = on;
  }
}
