# AGENTS.md

188号礼物 — three.js 版。3D 骑行叙事游戏，面向低配置设备优化。

本文件是**给 AI 协作者的操作约束**。这里最要紧的一条是：验证只有一个入口，
而且不需要反复跑。动手前请读完第 1 节。

---

## 1. 测试只有一个入口，而且是绿的

```bash
npm run verify     # 无头回归：59 条 / 841 条断言 + 文案三判据（死字 / 缺字 / 界面硬编码中文）
```

**不要因为不放心就重复跑。** 当前基线是 `PASS 59 / FAIL 0 / 没跑成 0`，
断言 841 条、0 条红。判断要不要跑，按下面的规则，而不是按"改了多少行"：

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

---

## 4. 提交前

```bash
npm run typecheck   # strict + noUnusedLocals + noUnusedParameters
npm run build       # tsc --noEmit && vite build
npm run verify      # 59 条 / 841 断言
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
`public/models` 现在是 **16.84 MB**（22 个 GLB，全部已过 Meshopt），
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
> 中间产物落在被 gitignore 的 `.cache/tex/`。判据只有一个：**有没有活可干**。
> `jobs.length === 0` 时 `exit(1)`；缺的族逐条告警并跳过。
> 它不会"成功"地产出一个空缓存——那是上一版的行为（空数组 + `exit(0)`），
> 也是 README 里 `8.6MB` / `5.0MB` 那些数字能一直错的原因。

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
