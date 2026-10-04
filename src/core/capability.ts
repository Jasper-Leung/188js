/**
 * 设备能力探测 —— 决定这台机器开局落在哪一档。
 *
 * 只用来决定**开局默认档**，绝不在这之后偷偷改档。
 *
 * 为什么不做"跑起来自动降档"：Godot 版把这条明确列为**故意不做**，
 * 理由在这儿同样成立——玩家没改任何设置，却看到画面在脚下变了，
 * 这比卡顿更让人不信任。而且"自动降档"要降的那一刀，往往正是玩家
 * 正在盯着看的东西（分辨率一降，文字和细线立刻糊）。所以：
 *   探测 → 给一个诚实的默认档 → 面板上随时可改 → 改完记住 → 永不自动回退。
 *
 * 唯一例外是**自适应分辨率**，因为它只动内部渲染分辨率、不动任何画面元素，
 * 而且默认关闭、开了就在面板上标着。理由见 loop.ts。
 */

export interface Capability {
  /** 是否支持 WebGL2。three.js r163+ 只认 WebGL2 */
  webgl2: boolean;
  /** 未屏蔽的 GPU 型号（可能为空，隐私模式下浏览器会藏） */
  renderer: string;
  /** 判定为软件渲染（SwiftShader / llvmpipe / Microsoft Basic Render） */
  softwareRenderer: boolean;
  /** navigator.deviceMemory（GB），部分浏览器不给 */
  deviceMemory: number;
  /** navigator.hardwareConcurrency，逻辑核心数 */
  cores: number;
  /** 触屏设备 */
  touch: boolean;
  /** 移动端 UA */
  mobile: boolean;
  /** 估算的档位 */
  suggestedTier: 0 | 1 | 2;
  /** 判定理由，写进设置面板让玩家知道自己被当成了什么机器 */
  reason: string;
}

export const TIER_LOW = 0 as const;
export const TIER_MEDIUM = 1 as const;
export const TIER_HIGH = 2 as const;
export type Tier = 0 | 1 | 2;

const SOFTWARE_HINTS = [
  'swiftshader',
  'llvmpipe',
  'software rasterizer',
  'basic render',
  'microsoft basic',
  'mesa offscreen',
  'apple software',
];

const WEAK_GPU_HINTS = [
  'mali-4', // Mali-400/410
  'mali-t6', // Mali-T600/T610/T720
  'mali-t7',
  'mali-g3',
  'adreno 3',
  'adreno 4',
  'adreno 5',
  'powervr',
  'intel(r) hd graphics 2000',
  'intel(r) hd graphics 3000',
  'intel(r) hd graphics 4000',
  'intel(r) hd graphics 4200',
  'intel(r) hd graphics 4400',
  'intel(r) hd graphics 4600',
  'intel(r) hd graphics 5000',
  'intel(r) graphics',
  'uhd graphics 600',
  'uhd graphics 605',
  'uhd graphics 610',
  'uhd graphics 620',
  'iris plus',
  'apple a9', // iPhone 6/7
  'apple a10',
];

const STRONG_GPU_HINTS = [
  'rtx',
  'geforce gtx',
  'geforce rtx',
  'radeon rx',
  'apple m1',
  'apple m2',
  'apple m3',
  'apple m4',
  'arc a',
  'geforce gt',
];

/**
 * 拿一个真实的 WebGL2 context 去问。**不能只看 `!!window.WebGL2RenderingContext`**
 * ——那个 API 在关掉了硬件加速的浏览器上照样存在，创建一个 context 才会失败。
 * 而"浏览器能创建 context"和"这张卡真的跑得动"是两件事，所以还要读型号。
 */
export function detectCapability(): Capability {
  let webgl2 = false;
  let renderer = '';
  let maxTexture = 0;

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext('webgl2', {
      failIfMajorPerformanceCaveat: false,
      powerPreference: 'high-performance',
    });
  } catch {
    gl = null;
  }

  if (gl) {
    webgl2 = true;
    maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '');
    }
    if (!renderer) renderer = String(gl.getParameter(gl.RENDERER) ?? '');
    // 立刻丢掉：探测用的 context 也占显存，在只有 128MB 可用的机器上
    // 留着它就是白占一块，而后面正主 renderer 还要再建一个。
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  const nav = navigator as Navigator & {
    deviceMemory?: number;
    hardwareConcurrency?: number;
  };
  const deviceMemory = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 0;
  const cores = typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : 0;
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const ua = navigator.userAgent || '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua);

  const rl = renderer.toLowerCase();
  const softwareRenderer = SOFTWARE_HINTS.some((h) => rl.includes(h));

  const { tier, reason } = decideTier({
    webgl2,
    renderer: rl,
    rawRenderer: renderer,
    softwareRenderer,
    deviceMemory,
    cores,
    mobile,
    maxTexture,
  });

  return {
    webgl2,
    renderer,
    softwareRenderer,
    deviceMemory,
    cores,
    touch,
    mobile,
    suggestedTier: tier,
    reason,
  };
}

/**
 * 把显卡型号收拾成一句能读的话。
 *
 * ANGLE 报出来的是一整串驱动链：
 *   `ANGLE (AMD, AMD Radeon RX 5500 XT (0x00007340) Direct3D11 vs_5_0 ps_5_0, D3D11)`
 * 直接截前 40 个字符会截在 `0x0000` 这种地方，读起来像坏了。
 * 这里剥掉 ANGLE 包装与驱动后缀，留芯片名本身。
 */
function prettyRenderer(raw: string): string {
  let s = raw.trim();
  const m = s.match(/^ANGLE \(([^,]+),\s*(.+?)\s*\)$/);
  if (m) s = m[2];
  s = s.replace(/\s*\(0x[0-9a-f]+\)/gi, '');
  s = s.replace(/\s*(Direct3D\d|OpenGL|Vulkan|Metal|D3D\d+).*$/i, '');
  s = s.replace(/\s*vs_\d+_\d+.*$/i, '');
  s = s.replace(/^ANGLE \((.*)\)$/i, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 30 ? `${s.slice(0, 30)}…` : s;
}

interface DecideInput {
  webgl2: boolean;
  renderer: string;
  rawRenderer: string;
  softwareRenderer: boolean;
  deviceMemory: number;
  cores: number;
  mobile: boolean;
  maxTexture: number;
}

/**
 * 档位判定。**顺序有意义**：越硬的否决条件越靠前。
 * 一个判据一旦命中就返回，不再看后面的——不然"内存 8G 的核显笔记本"
 * 会被后面的独显关键字（显卡名里带 GTX 的少见但存在）翻上去。
 */
function decideTier(c: DecideInput): { tier: Tier; reason: string } {
  if (!c.webgl2) {
    // 走到这里说明这台机器连 WebGL2 都开不出来。不给档位，给一句人话——
    // 后面 main.ts 会拿它渲染一张"为什么"而不是"游戏卡住了"。
    return { tier: TIER_LOW, reason: '这台浏览器没有可用的 WebGL2' };
  }

  if (c.softwareRenderer) {
    return {
      tier: TIER_LOW,
      reason: '显卡在用软件渲染（没开硬件加速）——画质已压到最低，能跑但会慢',
    };
  }

  if (c.mobile) {
    return { tier: TIER_LOW, reason: '移动设备' };
  }

  // 内存是最硬的信号之一：<4GB 的机器上，1.0 倍分辨率的 WebGL
  // 很容易被浏览器自己判成"页面卡住"然后杀掉标签页。
  if (c.deviceMemory > 0 && c.deviceMemory < 4) {
    return { tier: TIER_LOW, reason: `设备内存 ${c.deviceMemory}GB` };
  }

  if (STRONG_GPU_HINTS.some((h) => c.renderer.includes(h))) {
    return { tier: TIER_HIGH, reason: `独显：${prettyRenderer(c.rawRenderer)}` };
  }

  if (WEAK_GPU_HINTS.some((h) => c.renderer.includes(h))) {
    return { tier: TIER_LOW, reason: `核显：${prettyRenderer(c.rawRenderer)}` };
  }

  // 双核以下基本可以判定这台机器是十年前的
  if (c.cores > 0 && c.cores <= 2) {
    return { tier: TIER_LOW, reason: `只有 ${c.cores} 个逻辑核心` };
  }

  if (c.deviceMemory >= 8 && c.cores >= 8) {
    return { tier: TIER_HIGH, reason: `${c.deviceMemory}GB 内存 / ${c.cores} 核` };
  }

  // 显卡型号被浏览器藏起来了（隐私模式 / 某些 Linux 驱动），
  // 就按中档起步：这是"多数台式机"的形状，而且中档在集显上也是能跑的。
  return { tier: TIER_MEDIUM, reason: c.renderer ? '未识别显卡，按中档起步' : '浏览器未提供显卡型号，按中档起步' };
}
