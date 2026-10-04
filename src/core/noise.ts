/**
 * 确定性噪声 —— 地形高程的唯一出处。
 *
 * 逐行对译 Godot 版 TerrainBuilder 的 _hash2d / _noise2d / _fbm，
 * 包括那几个看起来"很奇怪"的位运算。**不要把它们换成更漂亮的噪声**：
 * 世界是程序化生成的，而驿站、水碗、植被、道路全都按这份高程对位。
 * 换一个噪声函数，等于把整张地图挪了一遍，而每一处摆放仍然"看起来合理"，
 * 于是没有任何报错、没有任何异常，只有一张和设计稿不一样的世界。
 *
 * 移植时特意保留的坑：
 *   · `n & 0x7fffffff` 是无符号化——负的整数在 JS 里没有同样的位型，
 *     直接算会得到完全不同的分布，所以显式取低 31 位。
 *   · Godot 的整数是 64 位，JS 的位运算是 32 位。乘法会溢出，
 *     所以这里用 Math.imul 保住低位乘法，再靠取模收回来。
 */

function hash2d(ix: number, iz: number): number {
  let n = Math.imul(ix, 127) + Math.imul(iz, 311);
  n = (n << 13) ^ n;
  n = (Math.imul(n, Math.imul(Math.imul(n, n), 15731) + 789221) + 1376312589) | 0;
  // `n & 0x7fffffff` 落在 [0, 2^31)，直接除以 2^30 会得到 [0, 2)，
  // 于是返回值最高能到 2.95 而不是 1 —— 而噪声插值之后要落在 [-1, 1]。
  // 源项目在这里有一层 fmod(..., 1.0)，它不是可有可无的修饰，
  // **是让分布回到 [-1,1] 的唯一那一步**。漏掉它的症状很隐蔽：
  // 地形高程均值变成 +6.3，于是 clamp 的**上限**吃掉 79% 的采样点，
  // 而全部断言（点数、总长、范围）都是绿的——世界只是变成了一片高原。
  const v = (n & 0x7fffffff) % 1073741824;
  return (v / 1073741824) * 2 - 1;
}

export function noise2d(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2d(ix, iz);
  const b = hash2d(ix + 1, iz);
  const c = hash2d(ix, iz + 1);
  const d = hash2d(ix + 1, iz + 1);
  const top = a + (b - a) * ux;
  const bottom = c + (d - c) * ux;
  return top + (bottom - top) * uz;
}

export function fbm(x: number, z: number, octaves: number): number {
  let val = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    val += noise2d(x * freq, z * freq) * amp;
    amp *= 0.5;
    freq *= 2;
  }
  return val;
}

/**
 * 另一个 hash：着色器里那族 `hash12` 的 CPU 对应物。
 * 植被按"格 + 序号"确定性地放置，靠它保证同一格每次跑出来完全一样。
 */
export function hashGrid(x: number, y: number, seed = 0): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 确定性伪随机序列（mulberry32）。植被散布用，种子固定 → 世界固定。 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
