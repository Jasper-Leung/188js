// 从 road.json 重建 961 点中心线（与 src/data/route.ts 的 buildPoints 同构）。
// 用来给录制器做自动驾驶：沿中心线找前视点，转向跟着路走。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'generated', 'road.json'), 'utf8'));

// road.json 里向量是 { __v2: [x, y] }，兼容裸数组
const v2 = (p) => (Array.isArray(p) ? p : p.__v2);

function localToCanvas(p) {
  const [px, py] = v2(p);
  const rot = (R.ROT_DEG * Math.PI) / 180;
  const xr = px * Math.cos(rot) - py * Math.sin(rot);
  const yr = px * Math.sin(rot) + py * Math.cos(rot);
  return { x: R.LEMNISCATE_CX + xr * R.LEMNISCATE_SCALE, y: R.LEMNISCATE_CY + yr * R.LEMNISCATE_SCALE };
}

function buildPoints() {
  const out = [];
  const n = R.LEMNISCATE_LOCAL.length;
  for (let i = 0; i < n - 1; i++) {
    const a = localToCanvas(R.LEMNISCATE_LOCAL[i]);
    const b = localToCanvas(R.LEMNISCATE_LOCAL[i + 1]);
    for (let k = 0; k < R._INTERP_PER_SEG; k++) {
      const t = k / R._INTERP_PER_SEG;
      const sx = a.x + (b.x - a.x) * t;
      const sy = a.y + (b.y - a.y) * t;
      out.push({ x: (sx - R.CX) * R.SCALE, z: (sy - R.CY) * R.SCALE });
    }
  }
  const b2 = localToCanvas(R.LEMNISCATE_LOCAL[n - 1]);
  out.push({ x: (b2.x - R.CX) * R.SCALE, z: (b2.y - R.CY) * R.SCALE });
  return out;
}

export const CENTERLINE = buildPoints();

const cum = [0];
for (let i = 1; i < CENTERLINE.length; i++) {
  const dx = CENTERLINE[i].x - CENTERLINE[i - 1].x;
  const dz = CENTERLINE[i].z - CENTERLINE[i - 1].z;
  cum.push(cum[i - 1] + Math.hypot(dx, dz));
}
export const TOTAL_LENGTH = cum[cum.length - 1];
export const POINT_COUNT = CENTERLINE.length;

export function pointAtArc(s) {
  const target = ((s % TOTAL_LENGTH) + TOTAL_LENGTH) % TOTAL_LENGTH;
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= target) lo = mid; else hi = mid;
  }
  const span = cum[hi] - cum[lo] || 1;
  const t = (target - cum[lo]) / span;
  const a = CENTERLINE[lo], b = CENTERLINE[hi];
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, idx: lo };
}

export function arcAt(x, z) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < CENTERLINE.length; i++) {
    const dx = CENTERLINE[i].x - x;
    const dz = CENTERLINE[i].z - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = i; }
  }
  return { arc: cum[best], idx: best, dist: Math.sqrt(bestD) };
}

/** 带符号的弧长差 `a - b`，折进 [-L/2, L/2]。 */
export function arcDelta(a, b) {
  let g = a - b;
  if (g > TOTAL_LENGTH / 2) g -= TOTAL_LENGTH;
  if (g < -TOTAL_LENGTH / 2) g += TOTAL_LENGTH;
  return g;
}

/**
 * **带连续性的**弧长查找：只在离中心线 `maxDist` 米以内的采样点里，
 * 挑**弧长最接近 `prevArc`** 的那个。
 *
 * ## 为什么需要它
 *
 * 8 字形环线有 **4 处自交**。交叉口上「这一支」和「另一支」的位置
 * 几乎重合，`arcAt()` 只看最近距离，于是**同样的坐标会返回差几百米的两个弧长**。
 *
 * 后果不是报错，是**车掉头**：控制器按 `arc + LOOK` 取瞄准点，
 * 一旦 `arcAt` 跳到另一支，瞄准点瞬间落到几百米外，
 * 控制器于是拼命打方向把车转回去——录出来就是走着走着忽然掉头绕圈。
 *
 * 距离在这里几乎无法区分两支（它们本来就重合），
 * **唯一可靠的判据是弧长连续性**：车是顺着走过来的，
 * 上一步在 600m，这一步就不可能在 900m。
 */
export function arcAtNear(x, z, prevArc, maxDist = 20) {
  if (prevArc === null || prevArc === undefined) return arcAt(x, z);
  const lim = maxDist * maxDist;
  let best = -1, bestGap = Infinity, bestD2 = Infinity;
  for (let i = 0; i < CENTERLINE.length; i++) {
    const dx = CENTERLINE[i].x - x;
    const dz = CENTERLINE[i].z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 > lim) continue;
    const gap = Math.abs(arcDelta(cum[i], prevArc));
    // 弧长差为主判据；弧长相近（±0.5m，都是同一段）时才比距离。
    // 不能让距离当主判据——交叉口两支的距离本来就几乎一样。
    if (best < 0 || gap < bestGap - 0.5 || (gap < bestGap + 0.5 && d2 < bestD2)) {
      best = i; bestGap = gap; bestD2 = d2;
    }
  }
  if (best < 0) return { ...arcAt(x, z), jumped: true };
  return { arc: cum[best], idx: best, dist: Math.sqrt(bestD2), gap: bestGap, jumped: false };
}

/** 找出所有自交点（两条相距很远的采样支靠得很近的地方）。自检用。 */
export function findCrossings(minSep = 120) {
  const out = [];
  for (let i = 0; i < CENTERLINE.length; i++) {
    for (let j = i + 1; j < CENTERLINE.length; j++) {
      // 要**绝对值**：arcDelta 会折进 [-L/2, L/2]，
      // 只写 `> minSep` 的话相隔超过半圈的那些（折成负数）反而不会被排除，
      // 于是把整条线自己都算成"自交"。
      if (Math.abs(arcDelta(cum[j], cum[i])) < minSep) continue;   // 太近，是相邻点
      const d = Math.hypot(CENTERLINE[j].x - CENTERLINE[i].x, CENTERLINE[j].z - CENTERLINE[i].z);
      if (d < 1.2) out.push({ i, j, d, arcA: cum[i], arcB: cum[j] });
    }
  }
  return out;
}

if (process.argv[2] === 'selftest') {
  console.log('points :', POINT_COUNT, '(expect 961)');
  console.log('length :', TOTAL_LENGTH.toFixed(4), '(expect 1228.8199)');
  const a = arcAt(-14.07, 77.5);
  console.log('start arc norm :', (a.arc / TOTAL_LENGTH).toFixed(4), '(expect 0.0303) idx', a.idx);
  const p = pointAtArc(a.arc);
  console.log('start point    :', p.x.toFixed(2), p.z.toFixed(2), '(expect -14.07 77.50)');

  // 自交点 + 连续性。
  // 几何上环线只有 **1 处物理交叉**（两支在同一坐标重合），
  // 但弧长参数化会把它记成**两次**（起点侧和半圈处），
  // 所以"两支重合"的采样对数是 2 —— 这里如实打印，不硬断言某个数。
  const xs = findCrossings();
  console.log('self-overlap pairs :', xs.length, '(1 处物理交叉 x 2 支 -> 2 对)');
  let bad = 0;
  for (const c of xs) {
    const q = pointAtArc(c.arcA);
    // 用 A 支的弧长当 prevArc 查 A 支的点，必须还对得上
    const n = arcAtNear(q.x, q.z, c.arcA, 20);
    const stayed = Math.abs(arcDelta(n.arc, c.arcA)) < 2;
    if (!stayed) bad++;
    console.log(`  @${c.arcA.toFixed(0).padStart(4)}m (另一支 ${c.arcB.toFixed(0)}m, 相距 ${c.d.toFixed(2)}m)` +
      ` -> arcAtNear=${n.arc.toFixed(0)}m ${stayed ? 'OK' : '跳支了!'}`);
  }
  console.log(bad ? `  ✗ ${bad} 处自交跳支` : '  ✓ 自交点全部保持连续');
}
