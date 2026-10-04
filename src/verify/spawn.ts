/**
 * 出生点探针。
 *
 * 「相机卡在树里、车不在路上」这件事，读代码只会得到一堆看起来都对的
 * 表达式：最近点算对了、参数化算对了、夹取也做了。所以直接量。
 * 这条路是从源项目学来的——`tools/probe_water.gd` 当年就是为了回答
 * "为什么水面在几十倍盆沿之外还没露出岸"，而答案是水位定错了。
 * 这类问题只有看数才看得见。
 */
import { STATIONS, CENTERLINE, TOTAL_ARCLENGTH, nearestArcParam, pointAtArcLength } from '../data/route';

function minDistToCenterline(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < CENTERLINE.length - 1; i++) {
    const a = CENTERLINE[i];
    const b = CENTERLINE[i + 1];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const l2 = abx * abx + abz * abz;
    let u = 0;
    if (l2 > 1e-9) u = Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / l2));
    const dx = x - (a.x + abx * u);
    const dz = z - (a.z + abz * u);
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** 复刻 World 构造函数末尾的出生点计算 */
function spawnFor(stationIndex: number) {
  const st = STATIONS[stationIndex];
  const t = nearestArcParam(st.x, st.z);
  const p = pointAtArcLength(t * TOTAL_ARCLENGTH).pos;
  return { st, t, p };
}

export function probeSpawn() {
  console.log('=== 出生点 ===');
  for (const i of [0, 1, 2, 4, 7, 10, 13, 14]) {
    const { st, t, p } = spawnFor(i);
    const d = minDistToCenterline(p.x, p.z);
    console.log(
      `  站 ${String(i).padStart(2)} ${st.def.name.padEnd(12)}` +
        ` 站位 (${st.x.toFixed(1)}, ${st.z.toFixed(1)})` +
        ` → t=${t.toFixed(4)}` +
        ` → 出生 (${p.x.toFixed(2)}, ${p.z.toFixed(2)})` +
        ` 离中线 ${d.toFixed(3)}m` +
        `${d > 3 ? '   ✗ 不在路上' : '   ✓'}`,
    );
  }

  console.log('');
  console.log('=== nearestArcParam 自洽性（扫全路径对照） ===');
  let worst = 0;
  let worstAt = 0;
  for (let k = 0; k < 40; k++) {
    const t = k / 40;
    const p = pointAtArcLength(t * TOTAL_ARCLENGTH).pos;
    const back = nearestArcParam(p.x, p.z);
    const err = Math.abs(back - t);
    if (err > worst) {
      worst = err;
      worstAt = t;
    }
  }
  console.log(`  最大往返误差 ${worst.toFixed(5)}（在 t=${worstAt.toFixed(3)}）${worst > 0.02 ? '  ✗' : '  ✓'}`);

  console.log('');
  console.log('=== 环线上任意点的最近点误差 ===');
  let worstOnLine = 0;
  for (let k = 0; k < 60; k++) {
    const p = pointAtArcLength((k / 60) * TOTAL_ARCLENGTH).pos;
    worstOnLine = Math.max(worstOnLine, minDistToCenterline(p.x, p.z));
  }
  console.log(`  最大 ${worstOnLine.toFixed(4)}m ${worstOnLine < 0.6 ? ' ✓' : ' ✗'}`);
}
