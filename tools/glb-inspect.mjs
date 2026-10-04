/**
 * 列出 GLB 里每个 mesh 的节点名、顶点数与世界包围盒。
 *
 * 存在的理由很具体：画面里出现一个"正方体"时，能给出的证据往往只有一张
 * 截图，而"那是哪个模型、哪个部件、多大"必须从资产本身读出来。
 * 三方库在这里帮不上——我们要的是**未缩放的原始尺度**，
 * 而 gltf-transform 的场景图在 transform 树上要自己走一遍。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'public/models';

for (const name of readdirSync(dir).filter((f) => f.endsWith('.glb')).sort()) {
  const buf = readFileSync(join(dir, name));
  if (buf.readUInt32LE(0) !== 0x46546c67) {
    console.log(`${name}: 不是 GLB`);
    continue;
  }
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));

  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const types = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
  const binOff = 20 + jsonLen + 8;
  const bin = buf.subarray(binOff, buf.readUInt32LE(20 + jsonLen) + binOff);

  const readVec = (idx) => {
    const acc = json.accessors[idx];
    const bv = json.bufferViews[acc.bufferView];
    const n = comps[acc.type];
    const arr = new types[bv.componentType](bin.buffer, bin.byteOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0), acc.count * n);
    return Array.from(arr);
  };
  const bounds = (idx) => {
    const acc = json.accessors[idx];
    if (acc.min && acc.max) return { min: acc.min, max: acc.max };
    return null;
  };

  const nodeBox = new Map();
  const nodeOfMesh = new Map();
  json.nodes.forEach((n, i) => { if (n.mesh !== undefined) nodeOfMesh.set(n.mesh, i); });

  console.log(`\n=== ${name}  ${(buf.length / 1024).toFixed(0)}KB  nodes=${json.nodes.length} meshes=${json.meshes.length} ===`);

  json.meshes.forEach((m, mi) => {
    const ni = nodeOfMesh.get(mi);
    const node = ni !== undefined ? json.nodes[ni] : null;
    const prim = m.primitives[0];
    const pos = prim?.attributes?.POSITION;
    if (pos === undefined) return;
    const b = bounds(pos);
    const acc = json.accessors[pos];
    const nm = node?.name || m.name || '(无名)';
    if (b) {
      const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]].map((v) => v.toFixed(3)).join(' x ');
      const ctr = [0, 1, 2].map((k) => ((b.min[k] + b.max[k]) / 2).toFixed(2)).join(', ');
      const low = [0, 1, 2].map((k) => b.min[k].toFixed(2)).join(', ');
      nodeBox.set(mi, { size, ctr, low });
      console.log(
        `  mesh${String(mi).padStart(2)} ${String(nm).padEnd(24)} verts=${String(acc.count).padStart(6)}` +
        ` size=${size.padEnd(22)} min=${low.padEnd(22)} ctr=${ctr}`,
      );
    } else {
      // 没有 min/max 就真读一遍
      const v = readVec(pos);
      const mn = [Infinity, Infinity, Infinity];
      const mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < v.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          mn[k] = Math.min(mn[k], v[i + k]);
          mx[k] = Math.max(mx[k], v[i + k]);
        }
      }
      const size = [0, 1, 2].map((k) => (mx[k] - mn[k]).toFixed(3)).join(' x ');
      const low = [0, 1, 2].map((k) => mn[k].toFixed(2)).join(', ');
      console.log(
        `  mesh${String(mi).padStart(2)} ${String(nm).padEnd(24)} verts=${String(acc.count).padStart(6)}` +
        ` size=${size.padEnd(22)} min=${low}`,
      );
    }
  });
}
