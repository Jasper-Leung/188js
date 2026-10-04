/**
 * 探针 —— 只量、不判。给回归抓到的偏差做定位用。
 *
 * 源项目有同样的东西（`tools/probe_water.gd`），它当年就是为了回答
 * "为什么水面在几十倍盆沿之外还没露出岸"而写的——答案是水位定错了。
 * 这类问题**只有看数才看得见**，而看图看不见。
 */
import { CENTERLINE, shapeReport, TOTAL_ARCLENGTH } from '../data/route';
import { naturalHeightAt } from '../world/basins';
import { fbm, noise2d } from '../core/noise';

export function probeAll() {
  probe8Shape();
  probeTerrain();
}

function probe8Shape() {
  const s = shapeReport();
  console.log('');
  console.log('=== 8 字形 ===');
  console.log(`  点数        ${CENTERLINE.length}`);
  console.log(`  总长        ${TOTAL_ARCLENGTH.toFixed(2)} m`);
  console.log(`  包围盒      x [${s.minX.toFixed(2)}, ${s.maxX.toFixed(2)}]  z [${s.minZ.toFixed(2)}, ${s.maxZ.toFixed(2)}]`);
  console.log(`  midX        ${s.midX.toFixed(4)}`);
  console.log(`  交叉（符号变化） ${s.crossings}`);
  console.log(`  左右点数    ${s.leftCount} / ${s.rightCount}`);
  console.log(`  镜像偏差    ${(s.symmetryError * 100).toFixed(3)}%`);
  console.log(`  长宽比      ${s.aspect.toFixed(3)}`);

  // 沿中心线打一条 x 的符号序列，看它到底在哪几次翻转
  const seq: string[] = [];
  let prev = 0;
  let prevIdx = -1;
  for (let i = 0; i < CENTERLINE.length; i++) {
    const sgn = Math.abs(CENTERLINE[i].x - s.midX) < 1e-6 ? 0 : CENTERLINE[i].x > s.midX ? 1 : -1;
    if (sgn === 0) {
      seq.push(`  i=${i} x=0 (中心)`);
      continue;
    }
    if (prev !== 0 && sgn !== prev) seq.push(`  i=${i} ${prev > 0 ? '+→−' : '−→+'}  (x=${CENTERLINE[i].x.toFixed(2)})`);
    prev = sgn;
    prevIdx = i;
  }
  console.log(`  符号翻转位置:`);
  for (const line of seq) console.log(line);
  console.log(`  尾点索引 ${prevIdx}`);

  // 环心
  const l = { x: 0, z: 0, n: 0 };
  const r = { x: 0, z: 0, n: 0 };
  for (const p of CENTERLINE) {
    if (p.x < s.midX) {
      l.x += p.x;
      l.z += p.z;
      l.n++;
    } else if (p.x > s.midX) {
      r.x += p.x;
      r.z += p.z;
      r.n++;
    }
  }
  console.log(`  左环质心 (${(l.x / l.n).toFixed(2)}, ${(l.z / l.n).toFixed(2)})  n=${l.n}`);
  console.log(`  右环质心 (${(r.x / r.n).toFixed(2)}, ${(r.z / r.n).toFixed(2)})  n=${r.n}`);
}

function probeTerrain() {
  console.log('');
  console.log('=== 地形高程分布 ===');
  let min = Infinity;
  let max = -Infinity;
  let atFloor = 0;
  let atCeil = 0;
  const N = 41;
  let total = 0;
  const hist = new Array(12).fill(0);
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const x = (ix / (N - 1)) * 800 - 400;
      const z = (iz / (N - 1)) * 800 - 400;
      const h = naturalHeightAt(x, z);
      min = Math.min(min, h);
      max = Math.max(max, h);
      if (Math.abs(h + 3) < 1e-9) atFloor++;
      if (Math.abs(h - 6) < 1e-9) atCeil++;
      total++;
      const b = Math.min(11, Math.max(0, Math.floor((h + 3) / 0.75)));
      hist[b]++;
    }
  }
  console.log(`  采样 ${total} 点（${N}×${N}）`);
  console.log(`  范围 [${min.toFixed(3)}, ${max.toFixed(3)}]`);
  console.log(`  压在 -3.0 下限 ${atFloor} 点（${((atFloor / total) * 100).toFixed(1)}%）`);
  console.log(`  压在  6.0 上限 ${atCeil} 点（${((atCeil / total) * 100).toFixed(1)}%）`);
  console.log('  直方图（每格 0.75m，从 -3.0 起）:');
  for (let i = 0; i < hist.length; i++) {
    const bar = '#'.repeat(Math.round((hist[i] / total) * 120));
    console.log(`    ${(-3 + i * 0.75).toFixed(2).padStart(6)} ~ ${(-3 + (i + 1) * 0.75).toFixed(2).padStart(6)}  ${bar}`);
  }

  console.log('');
  console.log('=== 噪声本身 ===');
  let nMin = Infinity;
  let nMax = -Infinity;
  let nSum = 0;
  for (let i = 0; i < 20000; i++) {
    const v = noise2d(i * 0.137, i * 0.291);
    nMin = Math.min(nMin, v);
    nMax = Math.max(nMax, v);
    nSum += v;
  }
  console.log(`  noise2d 范围 [${nMin.toFixed(4)}, ${nMax.toFixed(4)}]  均值 ${(nSum / 20000).toFixed(4)}`);
  let fMin = Infinity;
  let fMax = -Infinity;
  let fSum = 0;
  for (let i = 0; i < 20000; i++) {
    const v = fbm(i * 0.011, i * 0.023, 3);
    fMin = Math.min(fMin, v);
    fMax = Math.max(fMax, v);
    fSum += v;
  }
  console.log(`  fbm3   范围 [${fMin.toFixed(4)}, ${fMax.toFixed(4)}]  均值 ${(fSum / 20000).toFixed(4)}`);
  console.log('  理论：noise2d 插值后落在 [-1,1]；fbm3 三个倍频 0.5+0.25+0.125 = ±0.875');
}
