# 建筑资产替换：Tripo 批量生成参考

这个目录是 `ref_*.jpg` / `ref_corridor.png` 九张**纯白底产品图**，
用来喂 Tripo 的 image-to-model。目标是替掉场上最弱的九座建筑。

出图风格刻意选"白底产品图"而不是黄昏氛围图：Tripo 从白底图提取的几何
比从氛围图里提取的干净得多，不会把天空、地面、远山一起吞进去变成底板。
氛围是游戏里 `sky.ts` / `water.ts` 那套着色器的事，不该由模型自带。

---

## 1. 要替的是哪九座

| # | 名称 | 现在是什么 | 落点 |
|---|---|---|---|
| 1 | 驿楼 | 灰盒 GLB（8KB）+ 程序化几何 | `ARCH_BY_MODEL_IDX[6]` |
| 2 | 茶寮 | 同上 | `[7]` |
| 3 | 岭台 | 同上 | `[8]` |
| 4 | 神苑 | 同上 | `[9]` |
| 5 | 凉亭 | 同上 | `[10]` |
| 6 | 廊 | 同上 | `[11]` |
| 7 | 亭灯 | 同上 | `[12]` |
| 8 | 圆屋 | `mod_house.glb`（0.80MB） | `scenery.ts` 远景 |
| 9 | 塔楼 | `mod_tower.glb`（0.72MB） | `scenery.ts` 远景 |

前七座是源项目里作者自己搭的灰盒——每个部件就是一个长方体，全站
24~84 个顶点。16 座驿站里有 9 座在屏幕上读成方块，玩家要绕着它骑、
停在它前面打卡，方块会在整条环线上反复出现。

后两座是远处的现代建筑，不受 `label_y` 约束，但离路 60~230m，
主要影响天际线，对几何精度要求最低。

---

## 2. 硬约束（`verify_stations` 守着，改超了直接红）

前七座有两条**互相独立**的约束：

- **水平半宽 ≤ 8m**（`STATION_FOOT_HALF`）。超了会压到路面上。
- **总高 < 该站 `label_y`**。超了站名标签会插进屋顶里。

反方向也有一条：**必须比灰盒矮**。不守这条的话将来有人"顺手改精细"，
建筑膨胀起来没人拦。

### 模型单位必须和 `cfg.scale` 对齐 ⚠️

这是最容易踩的一个坑，而且症状很像别的 bug。

`stations.ts:270` 加载 GLB 时会乘 `cfg.scale`：

```ts
const scale = cfg.scale;
g.scale.set(scale * sx, scale * sy, scale * sx);
```

所以**模型单位高度 × `cfg.scale` = 场景里的米数**。Tripo 导出的模型
单位是随意的，不做归一化的话驿楼会长到 20m 或者缩成一团。

| 名称 | `cfg.scale` | `label_y` 上限 | 建议模型单位高 | 对应米数 | 半宽上限（单位） |
|---|---|---|---|---|---|
| 驿楼 | 10 | 11m | 1.05 | 10.5m | ≤ 0.80 |
| 茶寮 | 10 | 10m | 0.80 | 8.0m | ≤ 0.80 |
| 岭台 | 10 | 12m | 1.10 | 11.0m | ≤ 0.80 |
| 神苑 | 10 | 9m | 0.85 | 8.5m | ≤ 0.80 |
| 凉亭 | **12** | 8m | 0.625 | 7.5m | ≤ 0.667 |
| 廊 | 10 | 8m | 0.75 | 7.5m | ≤ 0.80 |
| 亭灯 | **14** | 10m | 0.535 | 7.5m | ≤ 0.571 |

半宽上限 = 8m ÷ `cfg.scale`。凉亭和亭灯的除数是 12 / 14 不是 10，
按 0.80 去归一化就会压路面。

**不要去改 `world.json` 的 `scale`。** 它是 `extract-data.mjs` 的产物，
而那一步要 Godot 源项目才能跑——手改会被下一次提取覆盖掉。
归一化 GLB 是唯一稳的路子。

### 后两座

远景走 `scenery.ts` 的区间，`assets.ts:152` 用 `setScalar(scale)`：

- `mod_tower`：`scale: [34, 44]` → 模型归一化到 **1.0 单位高**，
  成品 34~44m，一座塔楼正好。
- `mod_house`：`scale: [11, 16]` → 1.0 单位高会变成 11~16m 的圆屋，太高了。
  要么把模型压到 **0.42 单位高**（成品 4.6~6.7m），要么改 `scenery.ts`
  的区间到 `[1.2, 1.8]`。后者是源码不是产物，改起来更自由。

---

## 3. 出图用的提示词（英文原文，可直接复跑）

七座地标共用这个后缀——白底、均匀光、无人物无植被、不裁切：

```
Single isolated structure centered on a seamless pure white background, soft even
neutral studio lighting with no dramatic shadows, no color grading, three-quarter
front view from slightly above eye level, entire structure fully visible and not
cropped, clean 3D asset reference sheet, no people, no props, no vegetation, no
terrain, no surrounding scenery, sharp focus, high structural detail.
```

### 驿楼 `ref_inn.jpg`

```
Two-story traditional Chinese timber guest house (yilou) standing on a rectangular
grey stone plinth 12 m wide by 8.6 m deep. Ground floor: white plaster walls framed
by red-brown round timber columns, one central dark recessed doorway and two
recessed windows, a timber inter-column band separating the floors. The upper floor
cantilevers about 0.8 m outward beyond the ground floor, wrapped on three sides by a
slender timber railing, three recessed windows. Crowning it is a massive hipped
tiled roof with a concave sagging profile and corners sweeping upward, dark grey
clay tiles, deep overhanging eaves, no ridge beam. Three stone steps lead up to the
front door. Footprint within 16 m, total height about 11 m.
```

### 茶寮 `ref_teahut.jpg`

> 这张重出过一轮。第一版取景过近被切边，第二版加了"宽取景 + 明确四柱"才干净。

```
ONE single small open-sided Chinese tea shed, and nothing else in the frame. Wide
framing: the whole building is small in the center of the image with generous empty
white space on all four sides, clear margin between the roof and the image edge,
nothing cropped. The tea shed stands on a low grey stone platform about 9 m wide and
7 m deep. Exactly FOUR red-brown square timber posts, one at each platform corner,
carrying a simple horizontal beam frame near the top, completely open on all four
sides with no walls. Low built-in timber benches line the back and both sides. A
single shallow dark grey tiled roof of bamboo mat rests on slim purlins, sloping
gently down to all four sides with slightly upturned corners, overhanging the posts by
about 1 m. Only one roof, no duplicate roof, no second building.
```

### 岭台 `ref_terrace.jpg`

> 同样重出过——第一版画了两个屋顶，一个浮在半空。

```
ONE single open-air stone lookout terrace, and nothing else in the frame. Wide
framing: the whole structure is centered with generous empty white space on all sides
and nothing cropped. A large flat rectangular grey stone platform 15 m wide by 11 m
deep and 0.85 m high, paved with stone slabs. A waist-high stone railing of squat
posts and solid panels runs around the rear and both sides, the front side
interrupted by a two-step stone stair. Standing at the BACK of the platform is ONE
small roofed stone-stele niche: four slim timber columns on a low stone base holding
a single upright grey stone tablet, capped by ONE small dark grey tiled roof with
upturned corners. There is exactly ONE roof on this building and it sits directly on
the four columns of the niche, touching them. No floating roof, no second roof, no
duplicate architecture, no second building. Two low stone blocks near two opposite
corners of the platform.
```

### 神苑 `ref_shrine.jpg`

```
Circular stone shrine altar, about 9.2 m across and 9 m tall. Three concentric round
tiers of grey stone rise in steps to a low central platform. A small octagonal stone
offering table stands in the middle. Four slender hexagonal-section stone lamp posts
stand evenly spaced on a diagonal around the middle tier, each on a small square base
and topped by a simple capital. At the back edge stands a small roofed stele niche
with four slim timber columns, an upright stone tablet and a dark grey tiled roof with
upturned corners. Eight low scattered stones of uneven size ring the outer tier.
Strictly circular silhouette, no rectangular walls anywhere.
```

### 凉亭 `ref_pavilion.jpg`

```
Chinese garden pavilion: an octagonal grey stone base 7.8 m across and 0.55 m high.
Four red-brown timber columns stand on small octagonal stone plinths, leaving the front
and rear sides open. Curved timber benches with back rails fit against only the two
side faces. Above, a square pyramidal tiled roof with four concave sagging slopes
sweeping upward at the corners, dark grey tiles, deep overhanging eaves, and a small
stone ball finial on top. Total height about 8 m, base 7.8 m across, eaves slightly
wider than the column spacing.
```

### 廊 `ref_corridor.png`

> 同样重出过——第一版画了两条廊，上面那条还在发虚。

```
ONE single covered walkway, and nothing else in the frame. Wide framing: the whole
walkway is centered with generous empty white space above and below, nothing cropped.
A five-bay Chinese covered walkway (lang) on a long low grey stone base 13 m long by
4.6 m deep. Exactly TWO rows of red-brown timber columns, six per row, forming five
equal bays along the length. Continuous low timber benches run along both long inner
sides. One simple horizontal beam frame ties the column tops. ONE single long dark
grey tiled roof spans the entire length, with a shallow ridge, sloping down toward the
two long sides and overhanging about 1 m past each end, corners slightly upturned.
There is exactly ONE roof and ONE walkway; the roof sits directly on the columns, no
floating roof, no duplicate walkway, no second building, no ghost image. Strongly
horizontal proportion, about 8 m tall and roughly three times longer than deep, two
stone steps at the front center.
```

### 亭灯 `ref_lantern.jpg`

```
Tall traditional East Asian stone lantern (tengdeng), about 2.9 m wide at the base and
7 m tall, six stacked parts clearly separated: a square buried base block, a lotus-bud
pedestal, a tall tapering octagonal stone shaft, a square middle platform, a square
fire box with four pale paper-panel windows between short corner posts under a small
flat square cap, a wide flared conical tiled roof cap with four upturned corners, and a
small rounded stone jewel finial on top. All parts in pale weathered grey stone, no
lantern glow, no light source, no flame.
```

> 六件构件一件不少——亭灯是七座里最小的，部件缺一个就读不成"灯"。
> 火袋不要发光：这个项目零贴图，亮色块靠顶点色就够，加自发光要多一份材质。

### 圆屋 `ref_mod_house.jpg`

```
Contemporary modern Chinese round house, circular plan about 10 m in diameter and 6 m
tall, standing on a low grey stone plinth. A cylindrical volume with a flat roof and a
wide overhanging roof slab with a low parapet. The upper wall is wrapped by a ring of
closely spaced vertical timber or bamboo louvers, with large curved floor-to-ceiling
glazing behind them and one recessed entrance. Clean minimal lines, warm off-white
render and natural wood, strictly flat roof, no pitched roof and no traditional
ornament. Simple calm contemporary rural Chinese architecture, strong cylindrical
silhouette.
```

### 塔楼 `ref_mod_tower.jpg`

```
Contemporary Chinese mid-rise residential tower, slender rectangular volume about 14 m
by 14 m in plan, roughly 14 storeys and about 50 m tall. Light grey and off-white
precast panels with continuous vertical bands of dark glazing running the full height,
slender vertical fins between the window bands. A stepped-back crown of two smaller
stacked volumes with a rooftop plant enclosure and parapet, strictly flat roof. Simple
contemporary Chinese apartment tower, strong vertical silhouette, no pitched roof and
no traditional ornament.
```

---

## 4. 导出时的几条要求

Tripo 出完模型，导出前先处理这些，否则接进游戏要返工：

- **原点落在地表中心**，底面贴 y=0。`stations.ts:281` 会用包围盒
  把底面抬到地面，但前提是模型本身没有自带地面平板——Tripo 常常给一张
  地基圆盘，不删掉就会变成浮在地面上一圈凸起的边。
- **正面朝 -Z**。程序化几何是这个约定，`stations.ts:198` 按它把建筑转向路。
  真 GLB 走的是 `cfg.rot_y`（这七座都是 0），所以朝向得在模型里做对。
- **不要贴图**。这个项目零贴图是头等约束，现有 22 个 GLB 全走纯色。
  带贴图进来等于几张图的下载量换了个看不出差别的表面。要材质就用单色
  或顶点色，`applyRoofTint` 会在运行时压屋顶。
- **面数**。驿楼 / 岭台这种主角建筑可以到 2~5 万面；亭灯和远景两座压到
  1 万以内。`public/models` 现在 16.84MB，加九座模型的预算差不多就是
  再加 2~3MB。

---

## 5. 接入步骤

1. 新 GLB 放进 `public/models/`，文件名对上 `world.json` 里
   `STATION_GLB_CONFIG` 的 `path`（前七座是 `station_驿楼.glb` 这类中文名）。
2. **按第 2 节的表归一化单位**。
3. 删掉 `src/world/architecture.ts` 里 `ARCH_BY_MODEL_IDX` 对应的下标条目。
   `archKindFor` 返回 `null` 之后，`stations.ts` 自动回到加载 GLB 的路径，
   程序化几何那套代码不用动。
4. `npm run verify` —— `verify_stations` 会同时验半宽、高度和覆盖。
   红的理由通常就是第 2 节那张表没对齐。
5. 真要调建筑长什么样，改 GLB，不要改 `architecture.ts`——那份代码
   存在的意义就是被真实模型替掉。

---

## 6. 出图记录

九张全部一次批量生成。茶寮 / 岭台 / 廊三张出了重复物体或取景过近的问题，
按"单物体 + 宽取景"重出一轮，第二版全部干净。第一版已删除。

`ref_corridor.png` 是 PNG（16:9 的输出格式），其余是 JPEG。