# 视觉资产图

两类，用途不同，别混用。

## A. 实拍静帧 (8 张, 1920×1080)

从 `promo/footage/` 的空镜 mp4 里抽的。**真实游戏画面**——无 UI、无人、无载具，
和游戏里的像素完全一致。适合放商店页、社交帖、deck 里"这是实机"的配图。

| 文件 | 画面 |
|:---|:---|
| `road-through-pines.jpg` | 松林里的弯道，远处有现代建筑 |
| `road-far-view.jpg` | 长直路，视线收在远处的树线 |
| `tea-shed-and-lantern.jpg` | **茶寮在左、石灯在右、竹林在后**（构图最好的一张） |
| `tea-shed-approach.jpg` | 茶寮 + 支路 + 竹林 |
| `road-beside-water.jpg` | 湖岸，公路贴着水面 |
| `bamboo-grove.jpg` | 竹林夹道 |
| `modern-district.jpg` | 现代建筑与中式亭子同框 |
| `pines-backlit.jpg` | 密林双车道，逆光 |

> 抽帧时特意避开了 `03-lakeside` 的前两个候选——那两帧相机是对着空地/水面的，
> 画面里什么都没有。`shots/stills-cand/_sheet.jpg` 是 24 张候选的接触印相。

## B. AI 主视觉 (2 张)

**不是游戏实拍**，是按世界观生成的概念图。适合做封面、宣传头图、deck 封面。

| 文件 | 内容 | 尺寸 |
|:---|:---|:---|
| `keyart-loop.jpg` | **8 字环线的俯视全景**，远处山间有现代城区 | 2752×1536 |
| `keyart-object.jpg` | 桌面旧物（笔 / 缺口青瓷杯 / 系绳信 / 旧绢），每件上方浮着金色的残影 | 3:4 竖版 |

`keyart-loop.jpg` 把这个游戏最核心的一个视觉点说清楚了：**一条路，自己压过自己**。
真机里那个交叉口在地面上被树挡着，概念图能一眼讲明白。

---

## 要不要再抽

```bash
node tools/stills.mjs     # 每条抽 4 张候选 + 拼接触印相
node tools/sheet.mjs      # 重新拼 contact sheet
```

候选落在 `shots/stills-cand/`，印相是 `_sheet.jpg`。

---

## 版本关系

- 这里的静帧来自 **v2 空镜**（修好载具 + 第一视角不挡人之后录的）
- 更早那批带 UI、带角色的截图在 `promo/frames/` 和 `promo/shortfilm/check/`
- 整条 `promo/` 是 gitignore 的，这些图不会进仓库
