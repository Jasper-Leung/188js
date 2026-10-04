/**
 * 程序化着色器 —— 全部零贴图。
 *
 * 这是"低配兼容"里最实在的一块：路面、地形、草皮、水面这一整套地表，
 * 一个字节的贴图都不加载。对弱 GPU 来说这不是省内存，是省**采样**——
 * 一片草皮铺满屏幕时，每多采一次图就是一次全屏的纹理带宽，
 * 而核显的纹理单元往往正是瓶颈。
 *
 * 做法是 `onBeforeCompile` 往 three.js 的标准材质里注入，而不是自己写
 * `ShaderMaterial`。原因很具体：自己写就得自己实现方向光、阴影、
 * 半球环境光、雾、色调映射，而阴影贴图那一套（`getShadowMask`、
 * `shadowmap_pars_fragment`）自己接一遍会写错，而且换 three 版本就废。
 * 注入只改颜色与法线，光照全部走引擎管线——质量与正确性都是白拿的。
 *
 * 噪声工具函数与 Godot 版逐字一致（lacunarity 同样取 2.02），
 * 这样地面与路面的斑驳在同一处世界的粗细是一致的，肉眼看不出接缝。
 */

const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
    mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
    u.y);
}
float fbm3(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  float f = 1.0;
  v += a * vnoise(p);     f *= 2.02; a *= 0.5;
  v += a * vnoise(p * f); f *= 2.02; a *= 0.5;
  v += a * vnoise(p * f);
  return v;
}
float fbm2(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  v += a * vnoise(p);
  v += a * vnoise(p * 2.02);
  return v;
}
`;

/** 给一个 MeshStandardMaterial 挂上"自定义片元"钩子 */
export type PatchUniforms = Record<
  string,
  { value: number | number[] | [number, number, number] | import('three').Color }
>;

export interface PatchHooks {
  vertexHead?: string;
  vertexBody?: string;
  fragmentHead?: string;
  fragmentBody?: string;
  /** 替换掉 diffuseColor 的计算 */
  colorExpr?: string;
  /** 扰动法线（用 #include <normal_fragment_maps> 之后拿到的 `normal`） */
  normalExpr?: string;
  roughnessExpr?: string;
  metalnessExpr?: string;
  /**
   * 在 `#include <fog_fragment>` **之前**插一段。
   *
   * 位置很要紧：`fog_fragment` 自己会 `gl_FragColor.rgb = mix(色, fogColor, fogFactor)`，
   * 所以任何"按距离做别的处理"的代码都必须插在它**之前**，
   * 插在它之后就会被雾直接覆盖掉——而覆盖掉这件事不报错，
   * 只是那段代码看起来完全没生效。
   *
   * 段内可以读到 three 声明好的 `fogColor` 与 `vFogDepth`/`vFogDepth varying`。
   */
  fogHint?: string;
}

export function patchStandard(
  material: import('three').MeshStandardMaterial,
  hooks: PatchHooks,
  uniforms: PatchUniforms = {},
): PatchUniforms {
  material.onBeforeCompile = (shader: import('three').WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms);
    material.userData.shader = shader;

    if (hooks.vertexHead || hooks.vertexBody) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${NOISE_GLSL}\n${hooks.vertexHead ?? ''}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${hooks.vertexBody ?? ''}`);
    }
    if (hooks.fragmentHead || hooks.fragmentBody || hooks.colorExpr || hooks.fogHint) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${NOISE_GLSL}\n${hooks.fragmentHead ?? ''}`)
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
${hooks.fragmentBody ?? ''}
${hooks.colorExpr ?? ''}`,
        );
      if (hooks.roughnessExpr) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>\n${hooks.roughnessExpr}`,
        );
      }
      if (hooks.metalnessExpr) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <metalnessmap_fragment>',
          `#include <metalnessmap_fragment>\n${hooks.metalnessExpr}`,
        );
      }
      if (hooks.normalExpr) {
        // normal_fragment_maps 之后 `normal` 已经从 vNormal 建好，
        // 在这里改它就是改最终的着色法线。
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>\n${hooks.normalExpr}`,
        );
      }
      if (hooks.fogHint) {
        // 必须在 fog_fragment 之前：那段自己会把颜色 mix 向雾色，
        // 插在它后面就等于什么都没做（而且不报错）。
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <fog_fragment>',
          `${hooks.fogHint}\n#include <fog_fragment>`,
        );
      }
    }
  };
  // onBeforeCompile 变了必须换 key，否则 three 会复用旧程序
  material.customProgramCacheKey = () => Object.keys(hooks).join('|') + JSON.stringify(Object.keys(uniforms));
  return uniforms;
}

// ---------------------------------------------------------------- 地形
export const TERRAIN_PATCH: PatchHooks = {
  vertexHead: /* glsl */ `
    varying vec3 v_world;
    varying float v_viewDist;
  `,
  vertexBody: /* glsl */ `
    v_world = (modelMatrix * vec4(transformed, 1.0)).xyz;
    v_viewDist = distance(v_world, cameraPosition);
  `,
  fragmentHead: /* glsl */ `
    varying vec3 v_world;
    varying float v_viewDist;
    uniform vec3 ground_color;
    uniform vec3 ground_dark;
    uniform vec3 ground_dry;
    uniform float mottle_scale;
    uniform float clump_scale;
    uniform float speckle_strength;
    uniform float detail_fade_near;
    uniform float detail_fade_far;
    uniform float normal_strength;
    uniform float ao_strength;
    uniform float ground_detail;
    uniform float ground_detail_radius;
  `,
  fragmentBody: /* glsl */ `
    vec2 wp = v_world.xz;

    // 底色 → 低频大色块
    // 对比度压到 0.45（原来 0.75）：真实的草田色块变化是"看得出但不抢眼"，
    // 而 0.75 叠上去之后读成地面上一摊摊深色的水渍。
    float mottle = fbm2(wp * mottle_scale);
    vec3 gcol = mix(ground_color, ground_dark, smoothstep(0.40, 0.95, mottle) * 0.45);

    // 中频草丛斑驳：偏黄的一层，是"草原有变化"的主要来源
    float clump = fbm3(wp * clump_scale);
    gcol = mix(gcol, ground_dry, smoothstep(0.52, 0.95, clump) * 0.38);

    // 高频麻点，只在近处看得见
    float speck = fbm2(wp * 6.0);
    gcol = mix(gcol, ground_dark, smoothstep(0.55, 0.95, speck) * speckle_strength);

    /**
     * 近场草丛质感 —— 替代被移除的草皮几何体。
     *
     * 为什么要做进地形而不是做成卡片：草这个信号**只在近距离成立**。
     * 12cm 宽的叶片在 30m 外小于一个像素，无论怎么排都只会混成一块颜色；
     * 而卡片在 5m 内又会露出"一片立着的绿矩形"的底。
     * 两个距离下都不成立，正是它被移除的原因。
     *
     * 换成地表纹理之后，两个距离都对：近处看到的是**成簇的短纹**
     * （有方向、有疏密，读作被踩过的草），远处自然融进大色块。
     * 代价是 0 个三角形、0 次 alphaTest。
     */
    if (ground_detail > 0.5) {
      // 随距离淡出：半径外只剩大色块，不去硬切，避免看见一圈边界
      float gd = 1.0 - smoothstep(ground_detail_radius * 0.45, ground_detail_radius, v_viewDist);
      if (gd > 0.01) {
        // 草丛斑块：中频，疏密不均
        float tuft = fbm3(wp * 2.6 + vec2(0.0, 0.0));
        // 方向性短纹：把坐标沿一个固定角度拉长，读作倒伏的草茎
        float ca = 0.86, sa = 0.51;
        vec2 rot = vec2(wp.x * ca - wp.y * sa, wp.x * sa + wp.y * ca);
        float blade = fbm2(vec2(rot.x * 9.0, rot.y * 2.2));
        // 草丛边界：只在斑块里长，不是均匀撒
        float inTuft = smoothstep(0.44, 0.62, tuft);
        gcol = mix(gcol, gcol * 0.82, inTuft * smoothstep(0.52, 0.78, blade) * 0.8 * gd);
        // 逆光的草尖：斑块边缘提亮一点，这是"草"最强的单个线索
        gcol = mix(gcol, gcol * 1.14, inTuft * smoothstep(0.40, 0.52, blade) * (1.0 - smoothstep(0.52, 0.66, blade)) * gd);
        if (ground_detail > 1.5) {
          // 高档再加一层更细的碎草，抹掉低档能看出的重复
          float fine = fbm2(vec2(rot.x * 26.0, rot.y * 6.5));
          gcol = mix(gcol, gcol * 0.88, smoothstep(0.55, 0.85, fine) * inTuft * 0.5 * gd);
        }
      }
    }

    /**
     * 去饱和 + 提暖 —— 让它读成"照片里的草"而不是"游戏里的绿"。
     *
     * 现实的草地饱和度比直觉低不少：真实照片里的草大多在 sRGB (0.30, 0.36, 0.20)
     * 附近，而且带着土黄的偏色。屏幕上那种"鲜绿"是渲染里把
     * 色相拉到 120° 饱和度拉满的结果，一眼就假。
     *
     * 做法是往亮度方向拉 28%（降饱和）再往暖色偏一点，
     * 大尺度色块变化保留——真实的草田本来就是一块一块的。
     */
    float lum = dot(gcol, vec3(0.2126, 0.7152, 0.0722));
    gcol = mix(gcol, vec3(lum), 0.28);
    gcol *= vec3(1.04, 1.0, 0.93);

    // 顶点明暗（0.82~1.0）。在 Godot 里是 COLOR.rgb，
    // 这里对应 three 的 color 属性，标准材质的 vColor 已经乘进 diffuseColor。
    float crevice = 1.0 - smoothstep(0.25, 0.75, clump);
    float terrainAO = mix(1.0, 1.0 - 0.45 * crevice, ao_strength);
  `,
  colorExpr: /* glsl */ `
    diffuseColor.rgb *= gcol * terrainAO;
  `,
  /**
   * 大气透视 —— 让远山退进空气里。
   *
   * 为什么这一段值钱：`fog` 是**线性**混向雾色的，而现实里的空气散射
   * 跟距离不是线性的——它先慢后快（近处几乎透明，越远越糊）。
   * 而且**远山不只变糊，还变蓝、变淡**（散射把短波打散，蓝色被留在天上）。
   * 一条线性雾做不出这个，所以远处的山在渲染里永远是"同样清晰的绿"，
   * 一眼就出戏。
   *
   * 做法是在 `fog_fragment` 之前叠一层**距离平方**的雾，并把它偏向天色。
   * 平方项让近处几乎不动（0~30m 差别不到 0.06），远处迅速吃掉对比度。
   * 黄昏那一档用 `fog_fragment` 自己算出来的雾色来偏色，不再另取常量。
   */
  fogHint: /* glsl */ `
    {
      float dcam = v_viewDist;
      // 8e-6：100m 处 7.7%、200m 处 27%、400m 处 72%。
      // （第一版写的是 2.2e-6，注释却说"100m 给 0.22"——
      //  实际只有 0.022，比自己写的意图弱十倍，近景完全看不出效果。
      //  这一类"注释与代码对不上"的错只有把两处都写下来才抓得到。）
      //
      // 为什么不一步到位：linear fog 已经在 260m（高档 400m）处起作用了，
      // 这一层叠在上面，所以要留出余量——直接上 0.22/100m 会把中景洗成一片灰。
      float aerial = 1.0 - exp(-dcam * dcam * 0.000008);
      float lum2 = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      // hazeCol 用 linear fog 的结果色：白天是雾色，黄昏是暗红，两档都对
      vec3 hazeCol = fogColor * 1.02;
      vec3 des = mix(vec3(lum2), hazeCol, 0.55);
      diffuseColor.rgb = mix(diffuseColor.rgb, des, clamp(aerial, 0.0, 1.0));
    }
  `,
  normalExpr: /* glsl */ `
    // 法线扰动必须随距离淡出，而且系数要比路面小一个量级。
    // 路面那套 fbm2(wp*11) + 差分放大 16.0 是给 13m 宽、4m 视高的路面调的；
    // 直接搬到 800m 地形上，地面会渲染成揉皱的锡纸而不是草。
    float detailFade = 1.0 - smoothstep(detail_fade_near, detail_fade_far, v_viewDist);
    if (detailFade > 0.001) {
      vec2 dp = wp * 9.0;
      float d0 = fbm2(dp);
      float dxn = fbm2(dp + vec2(0.35, 0.0));
      float dzn = fbm2(dp + vec2(0.0, 0.35));
      vec3 micro = vec3((d0 - dxn) * 5.0, 1.0, (d0 - dzn) * 5.0);
      normal = normalize(mix(normal, normalize(micro), normal_strength * detailFade));
    }
  `,
  roughnessExpr: /* glsl */ `roughnessFactor = 0.95;`,
};

// ---------------------------------------------------------------- 沥青路面
export const ROAD_PATCH: PatchHooks = {
  vertexHead: /* glsl */ `
    varying vec2 v_roadWorld;
    varying vec2 v_roadPos;
    uniform float road_half_width;
    uniform float total_width;
    uniform float tile_size;
  `,
  vertexBody: /* glsl */ `
    v_roadWorld = vec2((uv.x - 0.5) * total_width, uv.y * tile_size);
    // 世界 XZ。交叉口的标线抑制必须按**世界距离**算，
    // 而 v_roadWorld 是每条 ribbon 自己的局部坐标——
    // 两条 ribbon 在路口各有各的"横向 0 米"，拿它判路口会得出两套互相矛盾的答案。
    v_roadPos = (modelMatrix * vec4(position, 1.0)).xz;
  `,
  fragmentHead: /* glsl */ `
    varying vec2 v_roadWorld;
    varying vec2 v_roadPos;
    uniform vec3 asphalt_color;
    uniform vec3 grain_dark_color;
    uniform vec3 dirt_color;
    uniform vec3 edge_line_color;
    uniform vec3 center_line_color;
    uniform float road_half_width;
    uniform float total_half_width;
    uniform float roughness_base;
    uniform vec2 junction_center;
    uniform vec2 junction_axis_a;
    uniform vec2 junction_axis_b;
    uniform float junction_paved;
    uniform float junction_center_fade;
    uniform float junction_edge_fade;
    uniform float junction_wide;
  `,
  fragmentBody: /* glsl */ `
    float lateral = v_roadWorld.x;   // 横向米数，0 = 路面中心
    float along   = v_roadWorld.y;   // 沿路米数
    float edge    = abs(lateral);
    vec2 wp = vec2(lateral, along);

    // ---- 交叉口：标线抑制 ----
    //
    // 判据不是"到路口中心多远"，而是**到另一条支路中心线有多远**。
    //
    // 换成径向判据是这一版修掉的 bug：两条支路各自算出的停笔半径相同，
    // 而它们真正需要的是"别画到对方的沥青上"——那是一个横向量，
    // 两条路差了一个 sin(夹角)。于是总有一条边线画穿路口。
    //
    // dA / dB 是本片元到两条支路中心线的**横向**距离；
    // 本片元必然贴在其中一条上（dA≈0 或 dB≈0），所以"另一条"就是较大的那个。
    vec2 rel = v_roadPos - junction_center;
    float dA = abs(dot(rel, junction_axis_a));
    float dB = abs(dot(rel, junction_axis_b));
    float dOther = dA < dB ? dB : dA;

    // 两条线用**同一个内边界** junction_paved，为的是留下一条能被验的不变量：
    //   只要还压在别人的铺面上（dOther < junction_paved），两条线都必然为 0。
    // 分开的只有恢复速度——边线晚回来是"一条白线横穿路口"，
    // 中线晚回来只是"缺一截"，所以边线多花 1m。
    // junction_paved 不是手写的：它由铺面半宽推出来（见 world/road.ts）。
    float markCenter = smoothstep(junction_paved, junction_paved + junction_center_fade, dOther);
    float markEdge   = smoothstep(junction_paved, junction_paved + junction_edge_fade,   dOther);
    // 起灰与路肩过渡用宽容的那条
    float mark = markCenter;
    // 路口的沥青比单边车道宽（转角填角）
    float wide = mix(1.0, junction_wide, 1.0 - markCenter);

    // 沥青基底：骨料颗粒 + 中频斑驳 + 低频大块色差。
    // 这几个反照率是实测的沥青样本值，不是调出来的观感：
    // 旧的 0.168 折成线性只有 0.023，比真实沥青暗四五倍，
    // 近处路面读成蓝紫霉斑，而黄昏把太阳压低时路面直接黑掉。
    float grain  = pow(fbm3(wp * 9.0), 1.55);
    float mottle = fbm3(wp * 1.4 + vec2(3.1, 7.7));
    // 低频色差改用世界坐标：路口是两条 ribbon 叠在一起，
    // 用各自的局部坐标会在叠合边界上留下一道可见的接缝——
    // 那是"这里贴了两块沥青"最直接的证据。世界坐标让两边共用一张场。
    float large  = fbm2(v_roadPos * 0.22 + vec2(11.0, 5.0));

    vec3 rcol = asphalt_color;
    rcol = mix(rcol, grain_dark_color, grain * 0.45);
    rcol *= 0.80 + 0.40 * mottle;
    rcol *= 0.88 + 0.28 * large;

    // 轮胎带：每车道中心两侧各一条黑色胎痕。
    // 路口**保留**胎痕——车确实从这儿碾过去，而且它让路口的沥青
    // 读成"被走过的路"而不是"新铺的一块补丁"。
    float lane = road_half_width * 0.5;
    float tracks = 0.0;
    for (int s = -1; s <= 1; s += 2) {
      for (int w = -1; w <= 1; w += 2) {
        float cx = float(s) * lane + float(w) * 0.62;
        tracks = max(tracks, 1.0 - smoothstep(0.24, 0.44, abs(lateral - cx)));
      }
    }
    tracks *= 0.4 + 0.6 * vnoise(vec2(along * 0.18, 3.7));
    rcol *= 1.0 - 0.34 * tracks;

    // 路缘起灰
    float dust = smoothstep(road_half_width * 0.60, road_half_width, edge);
    dust *= 0.4 + 0.6 * vnoise(vec2(along * 0.18, 9.1));
    rcol = mix(rcol, dirt_color * 1.12, dust * 0.5 * mark);

    // 潮湿斑块
    float wet = smoothstep(0.42, 0.56, fbm2(wp * 0.13 + vec2(7.0, 2.0)));
    rcol *= 1.0 - 0.18 * wet;

    // 路肩 → 泥土过渡。路口把这条边界推远（wide），标线一起淡出（mark）
    float shoulder = smoothstep(road_half_width * wide, total_half_width * wide, edge);
    rcol = mix(rcol, dirt_color, shoulder * mark);

    // 标线：中央白虚线（线长 4m / 间隔 6m）。路口内不画
    float asp_mask = 1.0 - smoothstep(road_half_width - 0.06, road_half_width, edge);
    float phase = mod(along, 10.0);
    float dash = smoothstep(0.0, 0.12, phase) * (1.0 - smoothstep(3.88, 4.0, phase));
    float center_lines = (1.0 - smoothstep(0.070, 0.100, abs(lateral))) * dash * asp_mask * mark;
    rcol = mix(rcol, center_line_color, center_lines);
    rcol = mix(rcol, rcol * (0.84 + 0.32 * grain), center_lines * 0.3);

    // 边线：贴着沥青外沿**内侧**的一条实线。
    // 中心线断续是因为它在路中间；路缘线的作用是定住那条边界，
    // 断续的话边界反而读不出来。没有它，沥青到泥土是靠 smoothstep
    // 混出来的，而泥土偏黄、沥青偏冷，两色直接相接读成"路面画到一半断了"。
    float d_edge = abs(abs(lateral) - (road_half_width - 0.18));
    float edge_line = (1.0 - smoothstep(0.06, 0.12, d_edge)) * markEdge;
    rcol = mix(rcol, edge_line_color, edge_line);
    rcol = mix(rcol, rcol * (0.84 + 0.32 * grain), edge_line * 0.3);
  `,
  colorExpr: /* glsl */ `
    diffuseColor.rgb *= rcol;
  `,
  roughnessExpr: /* glsl */ `
    float rgh = roughness_base;
    rgh += (grain - 0.5) * 0.16;
    rgh -= 0.20 * wet;
    rgh = mix(rgh, 0.96, shoulder);
    roughnessFactor = clamp(rgh, 0.06, 1.0);
  `,
  metalnessExpr: /* glsl */ `
    // 湿斑区的金属度。沥青不是金属；0.12 那版等于把它变成一面朝天的镜子，
    // 映的是天空。0.03 只留一点湿意。
    metalnessFactor = wet * 0.03;
  `,
  normalExpr: /* glsl */ `
    // 微观凹凸：砂石颗粒的法线扰动。
    // 三个数是一组的：特征要大于一个像素。玩家眼高 1.6m、看 1~3m 处的路面时
    // 一个像素盖住好几个特征，特征太密就是走样（蓝紫胡椒盐），不是斑块。
    vec2 dp = wp * 6.0;
    float d0 = fbm2(dp);
    float dxn = fbm2(dp + vec2(0.35, 0.0));
    float dzn = fbm2(dp + vec2(0.0, 0.35));
    vec3 micro = vec3((d0 - dxn) * 4.0, 1.0, (d0 - dzn) * 4.0);
    normal = normalize(mix(normal, normalize(micro), 0.22));
  `,
};

// ---------------------------------------------------------------- 水面
export const WATER_VERT = /* glsl */ `
varying vec3 v_waterWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  v_waterWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const WATER_FRAG = /* glsl */ `
precision highp float;
varying vec3 v_waterWorld;
uniform float uTime;
uniform vec3 deep_color;
uniform vec3 shallow_color;
uniform vec3 sky_color;
uniform vec3 dusk_tint;
uniform vec2 center;
uniform float radius;
uniform vec3 sun_dir;
uniform float ripple_scale;
uniform float ripple_speed;
uniform float ripple_amp;
uniform float shore_inner;
uniform float shore_outer;
uniform float sky_mix;
uniform float dusk_mix;
uniform float spec_power;
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;

// 三个方向/频率都不同的正弦。前向差分取法线（3 次求值而不是 5 次）：
// 差分有偏，但湖面上看不出来，而这一项每片元要跑三次。
float wave(vec2 p, float t) {
  float a = sin(p.x * 1.90 + p.y * 0.70 + t * 1.10);
  float b = sin(p.x * 0.60 - p.y * 1.45 + t * 0.80);
  float c = sin(p.x * -0.85 + p.y * 1.95 + t * 1.55);
  return (a + b * 0.62 + c * 0.34) / 1.96;
}

void main() {
  vec2 w = v_waterWorld.xz;
  float t = uTime * ripple_speed;

  // 法线。e 取 0.4m：更小会在远处把波纹算成噪声，更大会把水面推平。
  // ripple_amp 是**倾角**不是高度，三个正弦在 e 上给出的 |Δh| 上限约 0.82，
  // 所以 0.6 → 约 26°（平静的湖面），7.0 → 约 80°（整片锡纸）。
  // 第一版的 7.0 是照着"水面要一直在动"调的，而那个信号在 26° 上就足够——
  // 再往上只买到满屏高光白斑和碎掉的倒影，读成泳池底而不是水。
  const float e = 0.40;
  vec2 p = w * ripple_scale;
  float h0 = wave(p, t);
  float hx = wave(p + vec2(e * ripple_scale, 0.0), t);
  float hz = wave(p + vec2(0.0, e * ripple_scale), t);
  vec3 n = normalize(vec3((h0 - hx) * ripple_amp, 1.0, (h0 - hz) * ripple_amp));

  // 浅水带：从碗心量起的径向距离。没有深度贴图，这是唯一能读出"近岸"的地方。
  float rr = length(w - center) / max(radius, 0.001);
  float shore = smoothstep(shore_inner, shore_outer, rr);

  vec3 col = mix(deep_color, shallow_color, shore * 0.88);

  // 菲涅耳：越平视越像天。这是"这是水"最强的单一信号。
  vec3 view_dir = normalize(cameraPosition - v_waterWorld);
  float fres = pow(1.0 - clamp(dot(n, view_dir), 0.0, 1.0), 3.0);
  col = mix(col, sky_color, clamp(fres, 0.0, 1.0) * sky_mix);

  // 日头在波纹上的碎光
  vec3 refl = reflect(-normalize(sun_dir), n);
  float spec = pow(max(dot(refl, view_dir), 0.0), spec_power);
  col += vec3(1.0, 0.96, 0.86) * spec * 0.85;

  col = mix(col, col * dusk_tint * 2.4, dusk_mix);

  // 雾：手写而不是走 three 的 fog chunk —— 这支是裸 ShaderMaterial，
  // 引入引擎的雾要自己接 vFogDepth 与 fogDepth，收益不抵那点绕路。
  float depth = length(cameraPosition - v_waterWorld);
  float fogFactor = smoothstep(fogNear, fogFar, depth);
  col = mix(col, fogColor, fogFactor);

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

