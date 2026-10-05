# 录制指南 —— `?cine=1`

针对三个具体问题：**录出来 60fps 却卡**、**UI 挡画面**、**机位不能调**。

```bash
npm run preview          # 另开一个窗口，跑着
node tools/capture.mjs road 1200
ffmpeg -f concat -safe 0 -r 60 -i shots/cine/road.txt \
       -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -r 60 road.mp4
```

---

## 1. 录出来"60fps"还是卡 —— 病因不是帧率

`GameLoop.tick()` 取的是**墙上时钟**：

```ts
let frameDt = (now - this.lastTime) / 1000;   // 16.7ms / 33ms / 8ms 随机
```

于是第 N 帧推进 16.7ms，第 N+1 帧撞上 GC 推进 33ms，第 N+2 帧只推进 8ms。
拿这种**帧时间不均匀**的画面去录，编码器要凑成恒定帧率只能**丢帧或复制帧**。
复制出来的重复画面，就是"文件写着 60fps、看着一顿一顿"的来源。

**`?cine=1` 打开后 `frameDt` 恒等于 `fixedDt`（1/60 秒）。**
每张截图都正好推进 1/60 秒，帧与帧之间的运动量完全相等。
机器慢只会让录制整体变慢放，**不会**产生停顿帧。

实测（`tools/capture.mjs` 录 240 帧）：

```
输入 241 帧 → mpdecimate 去重后 240 帧
```

只掉了第一帧（它没有前一帧可比）。**零重复帧。**

---

## 2. UI 遮挡 —— 一次 `display:none` 就够了

整个 UI 是**一个** `div#ui-root`，HUD、小地图、道具栏、对白卡、遮罩全在它里面。
`?cine=1` 直接把它设成 `display:none`，不用改任何游戏代码，也不会漏掉某个新加的面板。

---

## 3. 机位不能调 —— 你的代码里其实已经有自由机位

`src/world/ride.ts:495` 早就有 `placeCamera(x,y,z, lookX,lookY,lookZ)`，
配合 `setCameraLocked(true)` 就能接管。`?cine=1` 把它们暴露成：

| 调用 | 作用 |
|:---|:---|
| `cine.orbit(yaw, pitch, dist, height)` | 绕角色转，`yaw/pitch` 是角度、`dist` 是米 |
| `cine.pose(x,y,z, lx,ly,lz)` | 完全手动给机位和看向点 |
| `cine.follow()` | 交还给第一/第三人称 |
| `cine.speed = 0.25` | 慢放，0 = 定格 |
| `cine.freeze()` / `cine.play()` | 定格 / 恢复 |
| `cine.frame` | 当前帧序号，录制脚本靠它对拍 |

---

## 机位表怎么写

`tools/capture.mjs` 从 **JSON 文件**读机位表，不走命令行：

```json
[
  [0,   { "follow": 1 }],
  [60,  { "orbit": [125, 16, 8, 2.6] }],
  [120, { "orbit": [205, 30, 13, 4.0] }],
  [180, { "pose": [10, 6, 30, 0, 1, 0] }]
]
```

左边是**从第几帧开始**切，右边是动作。`orbit` 的参数是
`[偏航角, 俯仰角, 距离, 高度]`。

```bash
node tools/capture.mjs road 1200 --shots=promo/shortfilm/shots-demo.json
```

> 机位表**必须走文件**。`--shot='[[0,{"follow":1}]]'` 传进 PowerShell
> 会被吃掉引号，变成 `[[0,{\follow\:1}]]`，`JSON.parse` 直接报错。

---

## 编码时最容易踩的坑

```bash
# 错：concat 会退回 25fps，240 帧变成 9.6 秒的慢放
ffmpeg -f concat -safe 0 -i list.txt -c:v libx264 out.mp4

# 对：-r 60 要给到**输入**，输出再写一次
ffmpeg -f concat -safe 0 -r 60 -i list.txt -c:v libx264 -r 60 out.mp4
```

录 1200 帧就正好是 **20 秒**成片。片长和帧数是对得上的，可以拿它反过来算要录多久。

---

## 关于无头 Chrome

我之前的录制用的是 `--use-gl=angle --enable-unsafe-swiftshader`，也就是
**软件光栅化**。它跑不满 60fps（实测 34–48fps），画面也偏软。
`tools/capture.mjs` 里加了两条：

```
--disable-frame-rate-limit --disable-gpu-vsync
```

在**有独显**的机器上录制时，把 `--enable-unsafe-swiftshader` 去掉，
让 Chrome 走真正的 GPU 编码路径，画质会好很多。
即便如此，确定性模式依然有价值——它保证的是**运动均匀**，这和帧率高低是两件事。

---

## 验证脚本

```bash
node tools/cine-verify.mjs
```

会打印 UI 是否隐藏、帧序号是否在走、1 秒墙上时钟换算成多少游戏时间，
并输出三个不同机位的对照图。
