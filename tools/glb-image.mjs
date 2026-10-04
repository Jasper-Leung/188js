/**
 * 极简 GLB 二进制读写 —— 只为换贴图。
 *
 * 为什么要自己写：gltf-transform 取出来的贴图字节（`tex.getImage()`）喂给
 * sharp，会在同一个进程里报 "colourspace: parameter space not set"，
 * 而**完全相同的字节**从 `fs.readFileSync` 喂进去就正常（681244 字节，
 * 头 ffd8ffe0，两边一致，146KB 输出）。这是 libvips 初始化时序上
 * 跟 gltf-transform 抢线程池的结果，不是数据的问题。
 *
 * 与其在那个交互里刨根因，不如把两件事拆开：
 *   阶段 A（本文件）—— 自己解 GLB，把 BIN 段里的图换成压好的，产出一个中间文件
 *   阶段 B（gltf-transform）—— 只做焊接 / 简化 / Meshopt，**一个字节的图都不碰**
 *
 * GLB 结构：12 字节头（magic/version/length）+ 若干 chunk。
 * chunk 头 8 字节（length + type），第一个是 JSON，其余是 BIN。
 */

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

function pad4(n) {
  return (n + 3) & ~3;
}

export function readGlb(buf) {
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('不是 GLB 文件');
  const total = buf.readUInt32LE(8);
  let off = 12;
  let json = null;
  let bin = null;
  while (off < Math.min(total, buf.length)) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const start = off + 8;
    if (type === CHUNK_JSON) json = JSON.parse(buf.subarray(start, start + len).toString('utf8'));
    else if (type === CHUNK_BIN) bin = buf.subarray(start, start + len);
    off = start + pad4(len);
  }
  if (!json) throw new Error('GLB 缺 JSON chunk');
  return { json, bin: bin ?? Buffer.alloc(0) };
}

export function writeGlb(json, bin) {
  const jsonRaw = Buffer.from(JSON.stringify(json), 'utf8');
  // GLB 2.0 规范：每个 chunk 的 chunkLength **必须已经是 4 的倍数，并且含填充**。
  // JSON 用空格(0x20) 填，BIN 用零(0x00) 填。
  // 写成"未填充长度"会让所有读取方算错 BIN 段的起点：
  // gltf-transform 那边是 `binByteOffset = 20 + jsonChunkLength`，
  // 拿到一个没对齐的数，下一行的 `new Uint32Array(..., binByteOffset)` 当场抛
  // "start offset of Uint32Array should be a multiple of 4"。
  // 这个问题只在这一份文件的 JSON 长度恰好是 4 的倍数时不会发生——
  // 自行车那份就是，所以它能过而别的模型全挂。这种"有的过有的不过"
  // 最耗时间，因为看上去像是数据坏了。
  const jsonLen = pad4(jsonRaw.length);
  const jsonBuf = Buffer.alloc(jsonLen, 0x20);
  jsonRaw.copy(jsonBuf);

  const binLen = pad4(bin.length);
  const binBuf = Buffer.alloc(binLen, 0);
  bin.copy(binBuf);
  const hasBin = binLen > 0;

  const total = 12 + 8 + jsonLen + (hasBin ? 8 + binLen : 0);
  const out = Buffer.alloc(total);
  let o = 0;
  out.writeUInt32LE(GLB_MAGIC, o);
  o += 4;
  out.writeUInt32LE(2, o);
  o += 4;
  out.writeUInt32LE(total, o);
  o += 4;

  out.writeUInt32LE(jsonLen, o);
  o += 4;
  out.writeUInt32LE(CHUNK_JSON, o);
  o += 4;
  jsonBuf.copy(out, o);
  o += jsonLen;

  if (hasBin) {
    out.writeUInt32LE(binLen, o);
    o += 4;
    out.writeUInt32LE(CHUNK_BIN, o);
    o += 4;
    binBuf.copy(out, o);
  }
  return out;
}

/**
 * 取出全部 bufferView 支撑的图（外部 URI 的图原样留着不动）。
 * 返回 { index, mimeType, bytes }。
 */
export function extractEmbeddedImages(glb) {
  const { json, bin } = readGlb(glb);
  const out = [];
  (json.images ?? []).forEach((im, index) => {
    if (im.uri || im.bufferView == null) return;
    const bv = json.bufferViews[im.bufferView];
    if (!bv) return;
    const start = bv.byteOffset ?? 0;
    out.push({
      index,
      mimeType: im.mimeType ?? guessMime(bin, start),
      bytes: Buffer.from(bin.subarray(start, start + bv.byteLength)),
    });
  });
  return out;
}

/**
 * 把 BIN 段里若干张图换成新字节，写出一个新的 GLB。
 *
 * 一次构造新的 BIN 段（而不是就地改）：换了之后每张图长度都变了，
 * 后面所有 bufferView 的 byteOffset 都要跟着挪，就地改要重排整段。
 * 8 个模型、总共 16 张图，重排的成本可以忽略，换来的是不会算错偏移。
 */
export function replaceEmbeddedImages(glb, replacements) {
  const { json, bin } = readGlb(glb);
  const byIndex = new Map();
  for (const [i, bytes] of replacements) byIndex.set(i, bytes);
  if (byIndex.size === 0) return glb;

  // 收集要重排的区间
  const edits = [];
  for (const [i, bytes] of byIndex) {
    const im = json.images[i];
    const bv = json.bufferViews[im.bufferView];
    const start = bv.byteOffset ?? 0;
    edits.push({ i, start, end: start + bv.byteLength, bytes });
  }
  edits.sort((a, b) => a.start - b.start);

  // 拼新 BIN。每张替换图之后补到 4 字节对齐：
  // glTF 要求 bufferView.byteOffset 是 4 的倍数，而这个偏移相对 BIN 段起点。
  // 少补这四个字节，后面每一个 typed array 的起点都会错位——
  // 读的时候报 "start offset of Uint32Array should be a multiple of 4"，
  // 在浏览器里用 three.js 加载则是整片模型的顶点乱飞。
  //
  // 顺带把"旧偏移 → 新偏移"的变化量记下来：一张图变短，后面每一个
  // bufferView（顶点、索引、法线……）都得跟着往前挪，只改贴图那一个是不够的。
  const pieces = [];
  let cursor = 0;
  let out = 0;
  /** 每一处编辑的净变化量（新的占用 − 旧的占用），按旧起点排序 */
  const deltas = [];
  for (const e of edits) {
    if (e.start > cursor) {
      const chunk = bin.subarray(cursor, e.start);
      pieces.push(chunk);
      out += chunk.length;
    }
    pieces.push(e.bytes);
    out += e.bytes.length;
    const pad = (4 - (out % 4)) % 4;
    if (pad > 0) {
      pieces.push(Buffer.alloc(pad));
      out += pad;
    }
    deltas.push({ end: e.end, delta: e.bytes.length + pad - (e.end - e.start) });
    cursor = e.end;
  }
  if (cursor < bin.length) {
    pieces.push(bin.subarray(cursor));
    out += bin.length - cursor;
  }
  const newBin = Buffer.concat(pieces);

  /** 旧的 bufferView 起点 → 新的起点 */
  const remap = (oldOffset) => {
    let delta = 0;
    for (const d of deltas) if (d.end <= oldOffset) delta += d.delta;
    return oldOffset + delta;
  };

  // 一次遍历修好所有 bufferView。贴图那几个改长度，其余只挪位置。
  const resized = new Map(); // bufferView index -> 新长度
  for (const i of byIndex.keys()) resized.set(json.images[i].bufferView, byIndex.get(i).length);

  json.bufferViews.forEach((bv, vi) => {
    const oldOffset = bv.byteOffset ?? 0;
    if (resized.has(vi)) {
      bv.byteLength = resized.get(vi);
      bv.byteOffset = remap(oldOffset);
    } else {
      bv.byteOffset = remap(oldOffset);
    }
  });

  for (const i of byIndex.keys()) {
    json.images[i].mimeType = 'image/jpeg';
    delete json.images[i].uri;
  }
  if (json.buffers && json.buffers[0]) json.buffers[0].byteLength = newBin.length;

  return writeGlb(json, newBin);
}

function guessMime(buf, start) {
  if (buf[start] === 0x89) return 'image/png';
  if (buf[start] === 0xff && buf[start + 1] === 0xd8) return 'image/jpeg';
  return 'application/octet-stream';
}

/** 读 PNG / JPEG 的宽高，纯粹为了在报告里好看。 */
export function imageSize(buf) {
  if (buf[0] === 0x89) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff) {
    for (let i = 2; i < buf.length - 9; ) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return { w: 0, h: 0 };
}
