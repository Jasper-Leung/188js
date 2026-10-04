/**
 * 渲染器装配 —— 低配策略在这里落地。
 *
 * ## 内部渲染分辨率是这一层最重要的一刀
 *
 * three 的 `setPixelRatio` 与 canvas 的 CSS 尺寸解耦：
 * 我们把 drawingBuffer 画成 `cssSize × renderScale`，
 * 由浏览器负责放大到 CSS 尺寸。核显的瓶颈几乎永远是填充率，
 * 0.6 倍就是 36% 的像素——帧率直接翻接近三倍，
 * 而雾会把放大后的那点糊盖住，看不出来。
 *
 * ## 为什么不用后处理
 *
 * 心神遮罩（画面压暗）原本是一个全屏后处理 pass。在 Web 上它不值得：
 * 用一个 DOM 覆盖层做同样的事，GPU 开销是 **0**，
 * 而且它跟着 UI 走、不参与任何后处理链，在低配上省掉的是一整趟全屏 blit。
 * 见 `ui/moodMask.ts`。
 *
 * ## 色彩管线
 *
 * 全部程序化材质给出的颜色常量都是 **sRGB**（Godot 的 `source_color` 也是 sRGB），
 * 所以开 `SRGBColorSpace` 输出 + `ACESFilmicToneMapping`。
 * 关掉色调映射的话，黄昏那一档（太阳压到 9°）会直接烧成一片白。
 */
import { WebGLRenderer, PCFSoftShadowMap, PCFShadowMap, BasicShadowMap, ACESFilmicToneMapping, SRGBColorSpace, Scene, Fog, Color, NoToneMapping } from 'three';
import type { PerspectiveCamera } from 'three';
import type { QualityPreset } from './settings';
import type { Tier } from './capability';
import { verticalFovForAspect } from './fov';

export class Renderer {
  readonly gl: WebGLRenderer;
  readonly scene: Scene;
  readonly fog: Fog;

  /** CSS 尺寸（画布占多大） */
  private cssW = 1;
  private cssH = 1;
  private preset: QualityPreset;
  private tier: Tier;
  private scale = 1;
  private onResizeCb: (() => void) | null = null;

  /**
   * 相机由 World 创建并传进来，**不在这里 new**。
   *
   * 原因：骑行模块要写相机的位置与朝向（跟随机位 + 打卡过场的接管），
   * 而渲染器要读它的投影矩阵。两处各建一个的结果是"镜头动了但渲染的
   * 还是那个"——症状是世界看起来完全没动，而两边都不报任何错。
   */
  readonly camera: PerspectiveCamera;

  constructor(canvas: HTMLCanvasElement, tier: Tier, preset: QualityPreset, cam: PerspectiveCamera) {
    this.tier = tier;
    this.preset = preset;
    this.camera = cam;

    this.gl = new WebGLRenderer({
      canvas,
      antialias: false, // 低配上 MSAA 的代价大于收益；用地形/路面着色器里的软边
      powerPreference: 'high-performance',
      stencil: false, // 这个游戏不用模板，深度预通道省一块
      depth: true,
      alpha: false,
      // 低配笔记本的集显常常是"共享显存"，而浏览器在没有这个提示时
      // 会按独显去申请。premultipliedAlpha 不影响，但 preserveDrawingBuffer
      // 会让某些机器多留一份后备缓冲——关掉。
      preserveDrawingBuffer: false,
    });

    this.gl.outputColorSpace = SRGBColorSpace;
    this.gl.toneMapping = ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.gl.shadowMap.enabled = preset.shadowMapSize > 0;
    // PCFSoft 是三张里最贵的。核显上 PCF（不 soft）已经够用，
    // 而两者的差别只在阴影边缘那一像素。
    this.gl.shadowMap.type = preset.shadowMapSize >= 2048 ? PCFSoftShadowMap : PCFShadowMap;
    if (preset.shadowMapSize === 0) this.gl.shadowMap.type = BasicShadowMap;
    this.gl.setClearColor(0x9ab6d8, 1);

    this.scene = new Scene();
    this.fog = new Fog(new Color(0.72, 0.8, 0.9), preset.fogNear, preset.fogFar);
    this.scene.fog = this.fog;
    this.scene.add(this.camera);

    this.applyPreset(preset);
  }

  applyPreset(preset: QualityPreset) {
    this.preset = preset;
    this.gl.shadowMap.enabled = preset.shadowMapSize > 0;
    this.gl.shadowMap.type =
      preset.shadowMapSize === 0 ? BasicShadowMap : preset.shadowMapSize >= 2048 ? PCFSoftShadowMap : PCFShadowMap;
    this.fog.near = preset.fogNear;
    this.fog.far = preset.fogFar;
    // 高档才开色调映射：ACES 在暗部会提亮，低档为了省那点算力直接线性输出，
    // 代价是黄昏会暗一点——而低档本来就已经是"能跑优先"。
    this.gl.toneMapping = tierAtLeast(this.tier, 1) ? ACESFilmicToneMapping : NoToneMapping;
    this.resize();
  }

  setTier(tier: Tier) {
    this.tier = tier;
    this.applyPreset(this.preset);
  }

  onResize(cb: () => void) {
    this.onResizeCb = cb;
  }

  /** 内部渲染分辨率倍率。自适应调节会调它。 */
  setRenderScale(s: number) {
    const next = Math.min(Math.max(s, 0.3), 1);
    if (Math.abs(next - this.scale) < 0.005) return;
    this.scale = next;
    this.resize();
  }

  get renderScale() {
    return this.scale;
  }

  resize() {
    const parent = this.gl.domElement.parentElement;
    const w = Math.max(1, Math.floor(parent?.clientWidth ?? window.innerWidth));
    const h = Math.max(1, Math.floor(parent?.clientHeight ?? window.innerHeight));
    this.cssW = w;
    this.cssH = h;

    // DPR 与 renderScale 相乘后再夹上限。
    // 两者都乘是高配上白白丢清晰度（DPR 2 × 0.85 = 1.7 仍被 cap 掉，
    // 而实际只需要 1.7 的采样就够），但**必须相乘**：低配上
    // renderScale 0.6 而 DPR 不管的话，一块 4K 屏仍会画 4K 像素。
    const dpr = Math.min(window.devicePixelRatio || 1, this.preset.pixelRatioCap);
    const effective = dpr * this.scale;

    this.gl.setPixelRatio(effective);
    this.gl.setSize(w, h, false);
    this.camera.aspect = w / h;
    // 竖直 FOV 由画幅比例连续推出，而不是 `aspect < 0.8 ? 74 : 62`
    // ——那个三元在 0.8 处是跳变的，而竖屏手机上水平视野只剩 31°。
    // 推导规则与取舍见 core/fov.ts。
    this.camera.fov = verticalFovForAspect(this.camera.aspect);
    this.camera.updateProjectionMatrix();
    this.onResizeCb?.();
  }

  get size() {
    return { cssW: this.cssW, cssH: this.cssH, bufferW: this.gl.domElement.width, bufferH: this.gl.domElement.height };
  }

  render() {
    this.gl.render(this.scene, this.camera);
  }

  /** 统计，给调试面板 */
  stats() {
    const i = this.gl.info;
    return {
      calls: i.render.calls,
      triangles: i.render.triangles,
      geometries: i.memory.geometries,
      textures: i.memory.textures,
      programs: i.programs?.length ?? 0,
      scale: this.scale,
    };
  }

  dispose() {
    this.gl.dispose();
  }
}

function tierAtLeast(t: Tier, min: Tier) {
  return t >= min;
}
