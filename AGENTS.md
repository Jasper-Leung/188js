# AGENTS.md

188号礼物：TypeScript + three.js + Vite 骑行叙事游戏，Tauri 桌面客户端；低配、触控、英文默认。本文是唯一项目操作规则；历史案例见 [docs/lessons-archive.md](docs/lessons-archive.md)，v1.0.2 设计/验收见 [docs/v1.0.2-plan.md](docs/v1.0.2-plan.md)。

## 1. 验证与文案

```bash
npm run verify     # 无头回归 + 文案三判据
npm run facts      # 重新生成唯一那份公开数字
```

**公开数字只有一份**：[docs/release-facts.md](docs/release-facts.md)——回归条数、断言数、产物体积、文案键数都在那里。别处只指向它，不许再写第二份；`npm run verify` 的 [DOC] 门会抓。
改 src/** 逻辑/数据或 submission/** 后收尾跑一次；只改文档、注释、配色、素材不跑。新增改动、实际失败或修改判据后才重跑，不做重复“体检”。数字变了就再跑一次 `npm run facts`，**只提交那一个文件**。

- 通过必须同时满足 `asserts > 0`、无 `[FAIL]`、无异常；`NO-ASSERT` 是失败。汇报 `PASS x / FAIL y / 没跑成 z` 和断言数。
- `[DOC]` 门核对本文三处回归数字、entry.ts 行数、follow 示例。新增判据/文件可能先因旧基线报红；按真实结果更新数字并复跑。每新增一个 src 下 TS/JSON 文件会给编码扫描增加一条断言。
- 玩家文案用 `t()`；新键同时补 `tools/i18n-supplement.json` 与 `src/data/generated/i18n.json`。数据自带双语用 `byLang(中文, 英文)` / `stationNameOf()`。
- 默认语言英语。文案死字、缺字、界面硬编码中文三门都要绿；白名单仅用于确实不面向玩家的文字并写明 why，不得掩盖新漏翻。

## 2. 工具与运行

```bash
npm run dev        # Vite，默认 http://127.0.0.1:5180
npm run probe      # 场景探针
npm run preview    # 已构建产物 http://127.0.0.1:4173
npm run desktop:dev
```

持久判据只放 src/verify/，注册进唯一 verify 入口；一次性观察放 .cache/，用完删除。新正式工具须挂 package.json scripts、写用法并有对应 verify_*。不在根目录或 tools/ 堆无引用脚本。
代码行为靠回归；不要为“确认能跑”录大量帧/视频。布局、触控和观感需实际浏览器/真机检查，自动通过不能冒充人工验收。

## 3. 构建约定与检查拆分

- esbuild 打单文件 ESM，**three 不设 external**；JSON 用 `loader: { '.json': 'json' }`，`resolveJsonModule` 属于 tsc。
- `assets:*` 会覆盖模型/纹理，只在确需再生成时运行。外部 Godot/Tripo 源与 `GIFT188_SRC_MODELS` / `GIFT188_SRC_BIKE` / `GIFT188_SRC_EXTRA` 用法见归档。自行车源已入库，其余高模并非都在库中。
- `tripo-bake.mjs` 的 sharp 和 gltf-transform/functions 必须分进程；修改后用干净 Node 进程验证，不靠 npm ls 判断。
- 拆分导出 `registerXxxChecks(check)`，在 entry.ts **原位置**调用；禁止模块顶层 check 或副作用 import 改注册顺序。注册表留 entry.ts，expect/fakeCtx/stripComments 共用 harness.ts。
- 先查 import/helper 依赖，机械搬移须保持条数与逐条断言数（编码扫描 +1 除外）。只在无他人在途修改时拆分。本轮已满足干净起点条件。
- `entry.ts` 的当前行数见 [docs/release-facts.md](docs/release-facts.md)。按 `split('\n').length` 计，不能用只计非空行的工具。

## 4. 提交与发布

```bash
npm run typecheck
npm run build
npm run verify
npm run facts      # 数字变了才跑：刷新 docs/release-facts.md
```

必须先 build 再 verify：verify_payload 读 dist 的真实字节。每批按相关检查验证，整合后回归一次。
逐文件核对再暂存，看 `git diff --cached --stat` 和差异；不混入未完成的并行修改，不覆盖或撤销他人暂存。dist/ 不入库；**package-lock.json 已跟踪，依赖变更须同步**（CI 用 npm ci）。
发版同步 package.json、Tauri 配置、Cargo 版本和锁文件；tag `v<version>` 触发现有三平台 Release 流水线，所有包成功才公开。发布完成需核对 CI、Release 资产和 Pages 结果。

## 5. 提交信息

标题 `中文标题 / English title`；正文中文小节后接英文对应小节。路径、数字、代码与 verify_* 不翻译。用 UTF-8 无 BOM 文件交给 `git commit -F`（Windows 不用 Set-Content/重定向）。未推送可 amend 措辞，已推送不改写历史。

## 6. AI 可玩接口

```bash
npm run ai:play
npm run ai:play -- --follow 90
npm run ai:play -- --script offroad
npm run ai:play -- --jsonl
```

浏览器 `window.__gift188.help()` / `observe()` / `act()` / `tap()`；策略只从 `observe().available` 选动作。
- 动作走现有键码与 KeyboardEvent，不开平行输入；新增动作同时维护 AI_KEYS、describeActions 和键位契约。
- 导航观测读 `ui.navNext`，离路读 `ride.lateral`，不得重算另一份算法。
- 无头只能骑车/经济数值，完整打卡/对白/小游戏/商店需浏览器。follow 复用 demoAim/demoInput；只写一次 --follow，闭环成绩不是真人手感证据。
- UI 结构断言证明已知失效结构不存在，不证明实际看得见。
