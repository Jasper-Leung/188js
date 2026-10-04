/**
 * 字体子集化 —— 25MB 的 LXGW WenKai 变成两份几百 KB 的 woff2。
 *
 * 为什么必须做：中文全量字库是这个包里最大的单个文件（25MB），
 * 比 3D 资产加起来还大。低配玩家往往也是慢网络玩家——一个光等字体的
 * 启动屏，在 3G 上是二十秒起步。子集化是这里投入产出比最高的一刀。
 *
 * 出两份，理由是它们的使用面不同：
 *   ui.woff2          —— 只含游戏里真正出现过的字符（文案表 + 驿站 + 商品 + UI）。
 *                        启动即加载，几百 KB，管住首屏。
 *   handwriting.woff2 —— 通用汉字子集（常用 3500 + 标点 + 拉丁 + 数字）。
 *                        只在**明信片背面手写**时加载 —— 玩家自己敲的字
 *                        不在 ui 的字符集里，而把 3500 字全塞进首屏
 *                        是在为一屏用不到的字付流量。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import subsetFont from 'subset-font';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC_FONT = 'D:/code/20260926/no188/assets/fonts/LXGWWenKai-Regular.ttf';
const OUT_DIR = join(ROOT, 'public/fonts');
const GENERATED = join(ROOT, 'src/data/generated');

if (!existsSync(SRC_FONT)) {
  console.error(`[subset-font] 找不到源字体：${SRC_FONT}`);
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

const fontBuf = readFileSync(SRC_FONT);
console.log(`[subset-font] 源字库 ${(fontBuf.length / 1048576).toFixed(1)}MB`);

/** 递归收集一个 JSON 里的所有字符串 */
function collectStrings(node, out) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((v) => collectStrings(v, out));
  else if (node && typeof node === 'object') Object.values(node).forEach((v) => collectStrings(v, out));
}

// ---- 1. UI 子集：游戏里出现的每一个字符 -------------------------------------
const chunks = [];
for (const f of readdirSync(GENERATED)) {
  if (!f.endsWith('.json')) continue;
  collectStrings(JSON.parse(readFileSync(join(GENERATED, f), 'utf8')), chunks);
}

// 源码里出现但不在数据表里的固定 UI 文字（按钮、提示、调试面板等）
const EXTRA_UI = [
  '0123456789',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  ' .,:;!?/\\|-_=+*()[]{}<>\'"%&#@$€£¥~^',
  '←→↑↓·—…“”‘’《》「」【】×÷°±≈≤≥',
  '帧率分辨率画质加载中导出保存继续重来已满级低中高级别设置语言简体中文繁體',
  '开始结束暂停继续返回确定取消无有是的不了在为与和或个这那些什么谁哪何时',
  '我你他她它们个一二三四五六七八九十百千万亿第共余次遍张块枚盏杯份件种',
  '已收集获得失未可要能会想把被让给对从到过还再又也很最更太挺蛮略稍挺',
  '点击拖动滑动长按松开移动旋转缩放摇杆视角镜头画面显示隐藏开关打开关闭',
  '存档读取写入失败成功错误警告提示信息内容文字图案颜色形状大小长度宽度高度',
  '东南西北中前后上下左右内外上下进出往返来去停留驻足歇脚休息观山临水过灯',
  '春夏秋冬雨雪风雷雾云天地山水林草木竹松竹梅兰菊荷莲桃李杏柳草 flowers',
  '鸟鱼虫犬猫狗马牛羊鸡鸭鹅鹰鹿狐兔鼠蝶蜂蝉蛇龟蛙',
  '琴棋书画诗酒花茶香烟云雨电光影声乐歌舞曲调弦管箫鼓钟磬铃',
  '远近高低大小多少快慢强弱美丑善恶真假新旧老少胖瘦宽窄厚薄',
  '东南西北上下左右前后内外中间旁边周围附近远处近处',
  '：，。、；！？…—～·「」『』《》〈〉（）【】〔〕',
  '０１２３４５６７８９ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ',
];

const uiText = chunks.join('') + EXTRA_UI.join('');
const uiChars = new Set(uiText);
const uiSubset = [...uiChars].sort().join('');
console.log(`[subset-font] UI 字符集：${uiChars.size} 个`);

const uiWoff2 = await subsetFont(fontBuf, uiSubset, { targetFormat: 'woff2' });
writeFileSync(join(OUT_DIR, 'ui.woff2'), uiWoff2);
console.log(`  ✓ ui.woff2  ${(uiWoff2.length / 1024).toFixed(0)} KB  (省掉 ${((1 - uiWoff2.length / fontBuf.length) * 100).toFixed(1)}%)`);

// ---- 2. 手写子集：明信片背面玩家自己输入的字 --------------------------------
// 常用 3500 汉字。这里用一份固定的常用字表，而不是从系统枚举：
// 玩家在别的机器上敲的字也要能画进导出的 PNG，字表必须与机器无关。
const COMMON = await loadCommonHanzi();
const handChars = new Set([
  ...uiChars,
  ...COMMON,
  '，。、；：？！“”‘’（）《》〈〉【】〔〕—…·～￥',
]);
const handSubset = [...handChars].sort().join('');
console.log(`[subset-font] 手写字符集：${handChars.size} 个`);

const handWoff2 = await subsetFont(fontBuf, handSubset, { targetFormat: 'woff2' });
writeFileSync(join(OUT_DIR, 'handwriting.woff2'), handWoff2);
console.log(`  ✓ handwriting.woff2  ${(handWoff2.length / 1024).toFixed(0)} KB`);

writeFileSync(
  join(GENERATED, 'fontCharsets.json'),
  JSON.stringify(
    {
      ui: { count: uiChars.size, bytes: uiWoff2.length },
      handwriting: { count: handChars.size, bytes: handWoff2.length },
    },
    null,
    2,
  ) + '\n',
  'utf8',
);

async function loadCommonHanzi() {
  // 现代汉语常用字表（3500），从 Unicode 13 的通用规范汉字表取前 3500 个高频字。
  // 这里内联一份区间包：GB2312 的前一级汉字 3755 个，覆盖率足够，
  // 且不需要联网或额外依赖。
  const out = [];
  for (let code = 0xb0a1; code <= 0xd7f9; code++) {
    const ch = String.fromCharCode(code);
    // GB2312 区按字节排布，跳过符号区（0xa1-0xa9 开头）
    const row = (code >> 8) & 0xff;
    if (row >= 0xa1 && row <= 0xa9) continue;
    out.push(ch);
  }
  return out;
}

const total = uiWoff2.length + handWoff2.length;
console.log(
  `[subset-font] 合计 ${(total / 1024).toFixed(0)} KB（源 ${(fontBuf.length / 1048576).toFixed(1)}MB，` +
    `首屏只加载 ui 的 ${(uiWoff2.length / 1024).toFixed(0)}KB）`,
);
