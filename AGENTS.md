# AGENTS.md

188号礼物 — three.js 版。3D 骑行叙事游戏，面向低配置设备优化。

本文件是**给 AI 协作者的操作约束**。这里最要紧的一条是：验证只有一个入口，
而且不需要反复跑。动手前请读完第 1 节。

---

## 1. 测试只有一个入口，而且是绿的

```bash
npm run verify     # 无头回归：111 条 / 2560 条断言 + 文案三判据（死字 / 缺字 / 界面硬编码中文）
```

**不要因为不放心就重复跑。** 当前基线是 `PASS 111 / FAIL 0 / 没跑成 0`，
断言 2560 条、0 条红。判断要不要跑，按下面的规则，而不是按"改了多少行"：

| 情况 | 动作 |
|---|---|
| 改了 `src/**` 里的逻辑/数据 | 跑 **一次** `npm run verify`，在收尾时 |
| 改了 `submission/**`（参赛提交页） | 跑 **一次**——`verify_submission` 守的就是那一页 |
| 只改了注释、文档、README、样式配色 | **不跑** |
| 只改 `promo/**`、`shots/**` 等素材 | **不跑** |
| 只是想"确认一下没坏" | **不跑**——它已经绿了，上一次跑的结果就是当前基线 |
| 连续改了 5 个文件 | 仍然只跑 **一次**，不是 5 次 |

一次回归约十几秒。反复跑它不会让结论更可靠，只会拖慢迭代；
真正的风险是**改了断言判据本身**——那才是需要立刻重跑并说明理由的场合。

### 退出码不算数，断言才算

`tools/verify-all.mjs` 有意**不信退出码**。一条回归自己抛异常时，
打包进程的退出码仍是 0，于是"一行断言都没打过"的回归看着像跑通了。
所以它判三件事，缺一不可：

1. `asserts > 0`（真的打出断言了）
2. 没有 `[FAIL]`
3. 没有抛异常

汇报结果时**引用这三个数**（`PASS x / FAIL y / 没跑成 z`、`断言 N 条`），
不要只说"测试通过"。看到 `NO-ASSERT` 要当成失败处理并报出来。

### 上面这两个数现在有门守着了

`tools/verify-all.mjs` 末尾多了一道 **`[DOC]` 硬门**：
§1 写的条数、断言数（两处）、§3 写的 `entry.ts` 行数，
和这一轮真实跑出来的对不上就 **退出码 1**。

它放在 runner 而不是 `entry.ts`，是因为**只有那里同时有两个数**：
`results.length` 在包内也拿得到，而 `totalAsserts` 要等全部跑完才累加得出来，
判据自己是在跑的过程中被调用的——在 `entry.ts` 里问「断言总数」会拿到自己还没打的那部分。

所以：**加了或删了一条 `verify_*`，这一轮 `verify` 一定会红一次，
报 `[DOC] AGENTS.md §1 写的是 N 条，实际 M 条`。把那三个数字改成它报的，然后重跑。**
这不是故障，这就是它存在的意义——它连续两轮拦下过过期基线
（67→71→79 那两次都是它本该拦而没拦的）。

### 断言总数会随 `.ts` 文件数变，这不是漏搬

`verify_text_encoding` 的结构是「1 条（扫描范围）+ 3 条（必扫文件）
+ **每个 `.ts` / `.json` 文件 1 条**（查 BOM）」。
所以**每新增一个 `src/` 下的 `.ts` 文件，断言总数就 +1**，
哪怕一条判据都没改。拆 `entry.ts` 时这一点尤其容易误判成"漏搬了"。

正确的验收口径是：**条数不变、除编码那条以外每条的断言数不变**。
本轮拆 `delivery.ts` 时实测 1273 → 1274，差的正好是一个新 `.ts` 文件，
而 `verify_submission` 18→18、`verify_assets_src` 5→5 都没动。

### 想看运行时状态，用 probe，不是新脚本

```bash
npm run probe      # 场景探针：远近草/树木数量、地形高程
```

### 界面里不许写死中文

`tools/i18n-dead.mjs` 现在打三张表，缺一不可：

| 表 | 治什么 |
|---|---|
| 文案死字 | 翻译了、写进表了，代码里一次都没 `t()` |
| 缺字 | `t('key')` 引用了表里根本没有的键 → 界面上显示 `⟨key⟩` |
| **界面硬编码中文** | 玩家眼前的中文直接写在代码里，切到英文也不会消失 |

第三条扫的是**玩家真的能读到字的文件**：`index.html`（启动屏骨架）、
`src/ui/**`、`src/main.ts`，以及 `src/core/{capability,touch,settings}.ts`
（它们产出的短标签会被画进面板）。不扫 `src/world` / `src/game`——
那些文件里的中文全是 `console.warn`、`throw new Error` 的诊断串。

确实不面向玩家的登记进 `tools/i18n-hardcode-allow.json`（要写 `why`），
和死字白名单一个规矩：**白名单之外出现任何新的 → FAIL，只能减不能增。**

配套的两条约定：

- 面向玩家的字面文案一律走 `t()`，键补在 `tools/i18n-supplement.json`
  **和** `src/data/generated/i18n.json` 两侧（后者是 `extract-data.mjs` 的产物，
  而那一步要 Godot 源项目才能跑，所以两份要一起改）。
- 数据自带双语的字段（站名、商品名）走 `byLang(中文, 英文)` 或
  `stationNameOf(def)`，**不要**自己写 `isEnglish() ? a_en : a_zh`——
  参数顺序写反一次的症状和漏翻一模一样。

默认语言是**英语**（`src/i18n/index.ts` 的 `DEFAULT_LANG`），
刻意的：默认中文时任何漏翻在开发机上都不会露出来。`verify_i18n` 里有断言钉住它。

---

## 2. 不许再造一次性调试脚本

这是本项目明确禁止的行为。以前每次排查都会往 `tools/` 里塞一个
`xxx-test.mjs` / `shot.mjs` / `dbg-*.ps1`，跑完既不删也不再引用，
最后仓库里堆了十几个只有作者自己看得懂的临时文件，还会让下一个 AI
把它们误当成正式回归反复执行。

**替代做法，按优先级：**

1. **能变成断言的，就写进 `src/verify/`。** 如果你这次排查得到了一条
   以后还会再犯的判据（比如"植被不许压路面""极值跳高不超过 0.1m"），
   把它加成一条 `verify_*` 注册进 `src/verify/entry.ts`。
   这是本项目**唯一**鼓励的"新增测试"方式。
2. **一次性的观察，放 `.cache/`。** 该目录已被 `.gitignore` 忽略，
   随手写随手删，不会污染仓库。
3. **实在需要留一个工具**，放进 `tools/` 的同时必须：挂到 `package.json`
   的 scripts 上、写清用法注释、并且有对应的 `verify_*` 判据兜底。

**不许**放在仓库根目录，**不许**只留一个没人引用的 `.mjs`。

### 不要用 Playwright 截图/录屏来"验证"

不要为了确认游戏能跑就拉起 Chrome 录屏、截图、再用 ffmpeg 剪片。
那套流程产出的都是几十 GB 的中间帧，对代码正确性零信息量。
`npm run verify` 已经在 Node 里真的把车开起来了（`verify_ride` 会跑
1s 满油、满舵 0.5s、跳跃、离路检测），要行为证据就用它。

---

## 3. 工具脚本的技术约定

- `tools/*.mjs` 里的回归靠 `esbuild` 把 `src/verify/*.ts` 打成单文件 ESM
  在 Node 里跑。**不要把 three 标成 external**——它不走 WebGL，只用
  向量/矩阵/Object3D 树，在 Node 里能跑，标了反而会 `Cannot find package 'three'`。
- `esbuild` 已显式声明在 `devDependencies` 里（被 5 个工具 import，
  之前只是靠 vite 传递依赖，属于隐患）。
- JSON 导入是 esbuild 内置能力：`loader: { '.json': 'json' }`。
  `resolveJsonModule` 是 tsc 的开关，esbuild 不认，传了会直接抛。
- 资源管线（`assets:*`）会就地改写 `public/models`、`public/textures`，
  缓存写在 `.cache/`。**只有真的要重新生成资源时才跑**，别拿它当体检命令。

### 拆 `src/verify/entry.ts`：必须保序，形状已经定好了

`entry.ts` 连着四轮只涨不跌，现在已经搬出去六族：

| 族 | 文件 | 大约 |
|---|---|---:|
| 车辆 / 骨骼 / 骑姿 | `src/verify/vehicle.ts` | 1,506 行 |
| 交付（提交页 / 资产源 / 编码 / 湖边场景） | `src/verify/delivery.ts` | 449 行 |
| 两条界面回归（第九轮新加） | `src/verify/ui_regressions.ts` | 344 行 |
| 景物布置 | `src/verify/scenery.ts` | 566 行 |
| AI 可玩接口契约 | `src/verify/ai.ts` | 802 行 |
| 本轮三件新内容（茶倒水 / 躲避挑战 / 古琴） | `src/verify/features.ts` | 814 行 |

**这张表只列了一种形状，而实际有两种。** 第二种是「导出单个 `assertXxx()`，
被上面某个族 import 走」——它自己**不注册**判据，所以不在上表里，
但它同样是搬出去的行数，同样要跟着一起搬：

| 文件 | 行数 | 谁拉它 |
|---|---:|---|
| `src/verify/ride.ts` | 890 | `vehicle.ts` 拉 `assertRide` / `assertDemoDrive` / **`assertSpawnHeading`** |
| `src/verify/submission.ts` | 291 | `delivery.ts` 拉 `assertSubmission` |

另外两个不注册判据、也不被拉：`src/verify/probe.ts`（142 行）和
`src/verify/spawn.ts`（78 行）是 `npm run probe` 那一侧，
`src/verify/harness.ts`（97 行）是两边共用的 `expect` + `fakeCtx` +
`stripComments`。**`fakeCtx` 为什么搬进去**：它原来住在 `entry.ts`，
而 `features.ts` 也需要一份；两份假 ctx 只要有一个 `measureText` 的行为不一样，
就会有一条判据在假环境里绿、另一条不是——而两边各自"对"着跑，
症状是判据之间互相打架，谁都说不出为什么。

⚠ **行数是量的，不是估的**：上面每一行都用 `split('\n').length` 数过
（`[DOC]` 门数 `entry.ts` 用的也是这个算法）。
**别用 PowerShell 的 `Measure-Object -Line` 重新数**——它只数非空行，
会把 `entry.ts` 报成 8,395，差 576 行，量出来是「表格过期」而其实没过期。

`entry.ts` 仍有 **9,376 行**。**要再拆的话，照抄这个形状：**

- 拆出去的模块导出 **`registerXxxChecks(check)`**，由 `entry.ts`
  **在原来的位置调用一次**。
- **绝对不要**写成模块顶层直接 `check(...)`，也**不要**只加一句 `import './xxx'`：
  ESM 的 import 会被提升，那一族会排到 `entry.ts` 的任何一行之前，
  **注册顺序就变了**——而顺序在这个项目里是有语义的
  （`verify_toast_reply` 的注释写死了"谁先装上 DOM 桩后面那条就会拿到残桩"）。
- 注册表（`results` / `check` / `runAll` / `checkNames`）**留在 `entry.ts`**，
  拆出去的族只拿得到 `CheckFn`，碰不到 `results`。
- `expect` 在 `src/verify/harness.ts`，两边共用。
- 搬之前**先查依赖**：只被这几族用到的 import 与顶层 helper 一起搬，
  别处还在用的必须留在 `entry.ts`。

**验收口径：条数不变、每条的断言数不变。**
少一条就是漏搬了——这是唯一能证伪"机械搬移"的东西。
（**断言总数会因新增 `.ts` 文件而 +1**，那是编码判据在扫 BOM，
理由与例见第 1 节末尾那条，别误判成漏搬。）

### 什么时候再拆：2026-10-11 的明确决定

这件事连续三轮在评审里被重新决定一次（第八轮搬了、第九轮涨回去、
本轮又涨了 172 行），所以在这里定死，**不要再每轮重新决定一次**。

**决定：等本批在途改动提交之后，再搬一族；在此之前不要动 `entry.ts` 的结构。**

理由不是"忙不过来"，是**现在动它最容易出 §4 那个事故**：
`entry.ts` 此刻压着一批**未提交的并行改动**（1,679 行 diff），
而 §4 记的那个坑正是"整份 `add` 了一份混着别人东西的文件，
提交上去编译不过、Pages 部署失败"。在一个正在被别人改的文件上
做 900 行机械搬移，是眼下风险最高、收益最低的一个动作。

**触发条件（满足任一就搬）：**
- 本批在途改动提交完毕，工作树里 `entry.ts` 没有未提交 diff；或
- 下一次因为别的原因（非拆分）要改 `entry.ts` 时，顺手搬一族。

**搬哪一族**：剩下的六族里挑**依赖最干净**的一族——先查它的 import
有没有被 `entry.ts` 别处用着（见上面"搬之前先查依赖"），
优先搬**只在这一族里用到那些 helper** 的那一族。
现有五族（vehicle / delivery / ui_regressions / scenery / ai）都是好形状，照抄。

⚠ **「剩下的六族」这个说法要当心**：它数的是**还留在 `entry.ts` 里**的判据族，
不包括上面那张第二形状表里的 `ride.ts`（831 行）与 `submission.ts`（291 行）。
这两族已经被搬出去了，**但它们是"被别人拉"的**——
真要动它们，得同时改 `vehicle.ts` / `delivery.ts` 的 import，
不能照抄 `registerXxxChecks(check)` 那个形状。

---

## 4. 提交前

```bash
npm run typecheck   # strict + noUnusedLocals + noUnusedParameters
npm run build       # tsc --noEmit && vite build
npm run verify      # 111 条 / 2560 断言
```

### 暂存要逐个文件核对，不要整份 add 就完事

**这个工作区会有并行的改动落进来。** 踩过的坑：修植被剔除时
`git add src/verify/entry.ts` 整份暂存，而那份文件里同时出现了另一条
正在进行的屋面判据——它引用的实现（`architecture.ts` 里的 `MeshBuilder.roofs`）
**当时还没提交**。结果推上去的提交**编译不过**
（`entry.ts:401 Property 'roofs' does not exist on type 'MeshBuilder'`），
Pages 部署失败，线上停在旧版本。

所以：

- `git add` 之后**先看 `git diff --cached --stat` 的行数对不对得上你这次的改动**。
  272 行而你只写了 150 行，那就是混进了别人的东西；
- 提交前跑一次 `npm run typecheck`——它专治"只暂存了一半实现"这一类；
- 暂存区里出现你没写过的文件，直接 `git restore --staged <file>` 退回去，
  不要"反正是一起改的就一起提交"。

三条都过再提交。`dist/` 与 `package-lock.json` 不进版本库；
`public/models` 现在是 **17.47 MB**（22 个 GLB，全部已过 Meshopt），
**其中 53% 压在三个文件上**：`motorcycle.glb` 4.82 / `bicycle.glb` 2.79 /
`survivor.glb` 1.33 MB。`bicycle.glb` 在首屏关键路径上。

> ⚠ **资产管线在干净克隆上跑不全，但这不是能靠重跑解决的。**
> `tools/compress-textures.mjs` 的输入分两族：
>
> · **自行车在版本库里** —— `assets-src/vehicles/bicycle_clean.glb`
>   （21.5MB / 184,433 面），清单默认指向它，所以**干净克隆至少压得出这台车**。
>   判据 `verify_assets_src` 守着它在。
> · **其余全在仓库之外** —— Godot 源项目（默认 `D:/code/20260926/no188/…`），
>   以及摩托车 / 角色 / 松树 / 竹 / 现代建筑。可用 `GIFT188_SRC_MODELS` /
>   `GIFT188_SRC_BIKE` / `GIFT188_SRC_EXTRA` 覆盖。
>
> 九座 Tripo 建筑（7 座驿站地标 + `mod_house` / `mod_tower`）走
> `npm run assets:tripo`，输入 `assets-src/tripo/*.glb` **同样不在版本库里**
> （58MB 高模）；进库的是参考图 `ref_*.jpg` 与 `PROMPTS.md`——
> 那是"重新生成"的说明书。产物已经是 `public/models/*.glb`，
> 硬约束由 `verify_station_models` 守（半宽、高度、零贴图、顶点色、Meshopt）。
>
> 中间产物落在被 gitignore 的 `.cache/tex/`。判据只有一个：**有没有活可干**。
> `jobs.length === 0` 时 `exit(1)`；缺的族逐条告警并跳过。
> 它不会"成功"地产出一个空缓存——那是上一版的行为（空数组 + `exit(0)`），
> 也是 README 里 `8.6MB` / `5.0MB` 那些数字能一直错的原因。
>
> ⚠ **改 `tools/tripo-bake.mjs` 之前先知道这件事：`sharp` 和
> `@gltf-transform/functions` 不能待在同一个进程里。**
> `node_modules` 底下躺着一个坏掉的 `sharp@0.35.5`（嵌在 `ndarray-pixels` 里面），
> 它一被 require 就把**顶层那个能用的 `sharp@0.33.5`** 一起弄坏——
> 症状是 `sharp is not a function`，而 `npm ls sharp` 看着一切正常。
> 所以管线拆成两个进程：`tripo-station.mjs`（JOBS 表、调度）用子进程调
> `tripo-bake.mjs`，**烘焙那一侧只 require `sharp`、绝不 require
> `@gltf-transform/functions`**。
> 症状一样但原因不同的还有一种：两者在同一个进程里被**先后**require，顺序反过来
> 就好——所以别靠"我这儿能跑"来判断，改完要另起一个干净的 `node` 试。

---

## 5. 提交信息：中英双语

**标题一行两半，正文按小节成对。** 一节中文、紧跟一节英文，两边都是完整的：

    中文标题 / English title

    **中文小节标题**

    中文正文

    ---

    **English section title**

    English body

代码块、路径、数字、判据名（`verify_veg_cull` 这类）**两边都保持原样，不要翻译**——
它们在仓库里就长那样，翻了词反而对不上。

**为什么是双语而不是挑一种。** 这个游戏的默认语言是英语（第 1 节里
`DEFAULT_LANG` 那条已经钉住了），而代码注释与判据说明是中文。只写一种，
就有一边的人读不懂自己的项目。提交信息是同一件事的另一个出口。

### 落盘方式（Windows 上这一步会真的咬人）

**别用 `Set-Content` 或 `>` 重定向写 message 文件。** 前者默认写 UTF-8 带 BOM，
后者按控制台编码走——中文会被洗成乱码，而乱码在 `git log` 里不报错，
要等到在网页上读出来才发现。正确做法：

```bash
# 用 Write 类工具落成 UTF-8 无 BOM，再交给 git
git commit -F .cache/commit-msg.txt
```

`.cache/` 已被 gitignore 放，message 文件可以随手留在那儿。
写完想自查有没有真的存成 UTF-8，用 Read 工具读回来，别看终端回显。

### 还没推的时候

措辞不满意、或者像这次一样要改语言，**直接 `--amend` 改写**，
不要为了措辞再叠一个提交——`git log` 是给人读的，两个只差措辞的提交只会稀释它。
已经推上去了就别改写（那要 force-push），补一个新提交说明即可。

---

## 6. AI 可游玩接口

这个游戏**可以被 AI 玩**。三条路，一份契约，全在 `src/game/api/`。

```bash
npm run ai:play                       # 无头会话：开一辆车巡航 30 秒
npm run ai:play -- --follow           # 自己跟着路骑 30 秒（闭环，见下）
npm run ai:play -- --follow 90         # 跟路骑 90 秒
npm run ai:play -- --script offroad   # 内置脚本（--list 看全部）
npm run ai:play -- --seconds 60       # 跑 60 秒
npm run ai:play -- --jsonl            # 每帧一行 JSON，给程序读
```

浏览器里控制台敲 `window.__gift188.help()` 拿接口说明，
`window.__gift188.observe()` 读一帧，`act(action, down)` 按住，`tap(action)` 点一下。

### `--follow`：把「手感」从形容词变成一个数

`npm run ai:play -- --follow` 让车**自己跟着路走** N 秒，报三个数：
**在路面上的帧占比**、最远偏出中心线多少米、里程与速度区间。

> ⚠ **秒数只写一次 `--follow`**：`--follow 90`，不要写成 `--follow --follow 90`。
> 重复写过去会**静默跑成默认的 30 秒**，而 30 秒的报告看起来完全合理
> （100% 在路面、均 10.6 m/s），唯一的征兆是"我明明要 90 秒"。
> 解析现在取**最后一个** `--follow`（`tools/argv-flag.mjs`），
> 所以三种写法其实都等价，但文档只教一种——
> **上面这几行示例由 `verify` 的 `[DOC]` 门逐行拿真函数验过**，
> 改成本文件时那条门会红。

它不是第五个内置脚本——脚本是死的动作序列，`--follow` 是**闭环**：
每帧读观测、算方向、再落回键码。控制器直接复用演示模式那一套
`demoAim` / `demoInput`，而那套已经被 `verify_demo_drive` 验过不会自己开进草地。
**不复用它等于再写一份，而两份控制器早晚会漂。**

**为什么加它。** 评审里「手感」那一栏连续七轮沿用一个没人复核过的数，
因为无头环境里没有"骑一会儿"这个动作。加了它之后，
「这游戏好不好骑」是**每次都能跑的一个数字**，不再靠手感打分。

**它仍然证明不了什么**：控制器逐帧 60Hz 且有预瞄，真人两样都没有。
所以它是**上限**，不是手感——别拿它当"好上手"的证据。
`verify_spawn_heading` 是它的一个具体用例：出生朝向不对的话，
这个占比会立刻塌下去。

### 最重要的一条设计：**告诉调用方此刻能按什么**

这个游戏的动词几乎全部带相位闸门：空格只在驿站附近打卡，
小游戏期间键盘被整体吃掉。一份只说"你可以按 WASD"的接口是**有害**的——
调用方会反复按那些此刻什么都不会发生的键，然后在观察里看不到任何变化，
于是学会"这个接口没用"。

所以 `observe()` 里有一个 `available` 字段，由 `describeActions()` 从相位、
面板可见性、对白、小游戏四个信号算出来。**策略只该从里面挑。**

### 动手改之前必须知道的三条约定

1. **动作只往下"塞键码"**，由游戏自己的键盘监听去消费。
   浏览器侧合成真的 `KeyboardEvent` 派发到 `window`，**不许另开一条平行输入**——
   七个监听键盘的地方（宿主 / 对白 / 结算 / 明信片 / 小游戏 / 触屏 / HUD）
   只有走真事件才收得到，而漏掉一处的症状像"小游戏坏了"。

2. **观测里的数字不许重算。** `nextStation` / `nextDistance` / `nextArrow`
   直接读 HUD 上一帧算好的（`ui.navNext`）；离路距离读 `ride.lateral`
   并按 `OFFROAD` 那套阈值换算。两份算法早晚会漂，而漂了以后症状是
   "AI 朝着玩家看不见的方向骑"，几乎不可能被归因。

3. **无头那一侧是"半个游戏"，必须被当成半个游戏用。**
   能骑车、能算天数旅币心神；**不能**打卡、对话、小游戏、商店、结算、明信片——
   那些要 DOM 与画布。要玩完整的走浏览器那个。

### 加一个动作要改哪几处

`src/game/api/types.ts` 的 `AI_KEYS` 加一条 → `verify_ai_actions` 会守住它有键位、
方向和 `keyToVec()` 一致 → `AI_HELP` 自动多一行。
`describeActions()` 里决定它**什么时候**可用。
**不要**为了绕过判据去改 `verify_ai_actions`——它红的时候通常是对的那一方。

### 判据守的是"契约不许悄悄变"

`src/verify/ai.ts` 守五件事：动作集不许少一个、每个相位都有出口、
HUD 与接口的箭头是同一个函数、三条接线都还在（数出现次数，不是数"有没有提到"）、
无头会话开得动刹得住方向对。

`src/verify/ui_regressions.ts` 守那两条"全绿地活下来"的界面回归。
**它证不了"看得见"**（无头没有排版引擎），所以改去证
**当初让它消失的那个结构已经不存在了**——这是这一族的方法，不是妥协。
