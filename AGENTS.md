# AGENTS.md

188号礼物 — three.js 版。3D 骑行叙事游戏，面向低配置设备优化。

本文件是**给 AI 协作者的操作约束**。这里最要紧的一条是：验证只有一个入口，
而且不需要反复跑。动手前请读完第 1 节。

---

## 1. 测试只有一个入口，而且是绿的

```bash
npm run verify     # 无头回归：46 条 / 709 条断言 + 文案三判据（死字 / 缺字 / 界面硬编码中文）
```

**不要因为不放心就重复跑。** 当前基线是 `PASS 46 / FAIL 0 / 没跑成 0`，
断言 709 条、0 条红。判断要不要跑，按下面的规则，而不是按"改了多少行"：

| 情况 | 动作 |
|---|---|
| 改了 `src/**` 里的逻辑/数据 | 跑 **一次** `npm run verify`，在收尾时 |
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
npm run verify      # 46 条 / 709 断言
```

三条都过再提交。`dist/` 与 `package-lock.json` 不进版本库；
`public/` 里的资产已经压到 ~5MB，**提交时确认没被压回原图**。
