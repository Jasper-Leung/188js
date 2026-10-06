# `assets-src/` — 仓库自带的源资产

这里是**提交进版本库的模型源文件**。绝大多数源资产不在仓库里
（Godot 源项目、后来补进来的车模，都在 `D:/code/…` 那些路径上，不提交），
只有这一件进来了，理由写在下面。

## 现在有什么

| 文件 | 大小 | 是什么 | 压成什么 |
|:---|---:|:---|:---|
| `vehicles/bicycle_clean.glb` | 21.50 MB | Tripo 导出的自行车，25 个零件 / 175,178 顶点 / **184,433 面** / 21 张贴图 | `public/models/bicycle.glb` **2.79 MB**（Meshopt + 贴图 1024） |

`public/models/bicycle.glb` 是它压出来的产物，本来就在版本库里。
所以这台车**高模和产物都在仓库里**。

## 为什么偏偏是它

三个理由叠起来才够：

1. **它是玩家第一眼看到的东西。** `vehicle.ts` 里主角骑的就是它，
   而它落在首屏关键路径上——README 里"第一屏先下载什么"那一节讲的就是它。
2. **它压不出来。** 它的源在 `D:/code/20261001/modelbone/vehicle_switch/public/models/`
   那个项目里，不提交。一个**谁都压不出来**的关键路径资产，
   等于所有关于它的数字都没有出处——README 的资产表就是这么错的。
3. **21.5MB 是能接受的代价。** 换来的是：任何人克隆下来都能重跑
   `npm run assets:all` 把这台车压出来，而不用先找到某个人的 D 盘。

其余几族（摩托车 24.4MB、角色 5.3MB、松树、竹、两栋现代建筑）**没有**进来：
它们不在首屏上，`public/models/` 里已经有压好的产物，要重压就把
`GIFT188_SRC_EXTRA` / `SRC_VEHICLE` 指过去。

## 怎么用

`tools/extra-models.mjs` 里那一项已经指向本目录，所以什么都不用配：

```bash
npm run assets:tex   # 21.5MB → .cache/tex/bicycle.glb（贴图压到 1024）
npm run assets:geo   # → public/models/bicycle.glb（简化 + Meshopt）
```

干净克隆上跑不了的是**别的**几族（Godot 源项目那份），它们会逐条告警并跳过；
`jobs.length === 0` 时才红灯退出。也就是说：**这台车在干净克隆上压得出来**，
其余要指源。

## ⚠ 别和另一台车搞混

`D:/code/20260926/no188/assets/bike.glb`（1.83 MB）是**外部下载**的
**另一台**自行车，不是这一个，而且**轮子不转**。
`compress-textures.mjs` 里的 `SRC_BIKE` 指的是**那台**，
它和 `public/models/bicycle.glb` 没有关系——本目录这一台才是游戏在骑的。

## 判据

`verify_assets_src` 守着这个文件在不在、以及清单里指的还是不是本目录。
它不在的话，"干净克隆能重压自行车"这句话就变成了一句空话——
而那正是这个文件当初被删掉时的症状。