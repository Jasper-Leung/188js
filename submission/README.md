# 官网（submission page）

这个仓库本身就是《188号礼物》的**官网**（同时也是参赛提交页）。`submission/` 是站点上
**除了游戏本体之外的那一页**：录屏、下载入口、以及（将来放开的）在线 Demo 都在这里。

`npm run build` 之后它被原样拷到 `dist/submission/`。游戏仍然在 `dist/` 根 ——
它的位置一个字没动（`base: './'` 决定了它只能在根，详见 `vite.config.ts` 的注释）。

| 部署 | 官网地址 | 游戏本体 |
|:---|:---|:---|
| 本仓库自带的 Pages workflow | `https://jasper-leung.github.io/188js/submission/` | `https://jasper-leung.github.io/188js/` |
| Cloudflare Static Assets（`npm run deploy`） | `https://gift-no188.<子域>.workers.dev/submission/` | 同域根 |

---

## 现在页面上是什么

| 区块 | 状态 | 来自 |
|:---|:---|:---|
| 01 演示录屏视频 | ✅ 有 | `media/demo.mp4`（母版见下） |
| 在线 Demo | ⏸ **暂时收起** | `site.json` 的 `demoHidden: true` |
| 02 下载 | ✅ 有 | 桌面版安装包 → `releases/latest`；另有源码 zip |

## 三种「没有地址」的处理方式

页面上任何一个外链只有三种状态，由 `submission/site.json` 决定：

| 配置 | 页面上 |
|:---|:---|
| 填了 `https://…` | 正常链接 |
| 留空 `""` | **占位**：摘掉 `href`、打上 `data-todo`，画成虚线的「待填 / TBD」 |
| `demoHidden: true` | **整块收起**：所有 `data-demo` 元素打上 `hidden` |

三者都不给访客留死链。摘掉 `href` 而不是留 `href=""` 是有意的：
没有 `href` 的 `<a>` 在 HTML 层面本来就不是链接——不可聚焦、不可点、读屏也不会念成链接。

## 改链接：只改 `site.json`

页面里每个用到链接的地方都标了 `data-cfg="键名"`，`tools/build-submission.mjs`
构建时按 `site.json` 覆写，`verify_submission` 反过来断言 HTML 里的默认值与之一致。
所以改地址只改 `site.json`，改了 HTML 会被回归拦下。

```bash
npm run submission:links   # 只校验并打印清单，不写文件
npm run build              # 构建（顺带打印同一份清单）
```

清单里会明确列出**还欠着的地址**，以及每一处该去改哪个键。

### 开放在线 Demo

```jsonc
"demoHidden": false,                                  // ① 先把整块放回来
"demoUrl": "https://<正式地址>/",                     // ② 再填地址
```

然后 `npm run build`。卡片编号会自己从 01 / 02 重排，不用手改 HTML。

### 换下载地址

`releaseUrl` 填的是**桌面版安装包**（Windows / macOS / Linux，由
`.github/workflows/release.yml` 在 tag 上构建，产物是 Tauri 的 nsis / dmg / deb / AppImage）。
现在填的是 `releases/latest` 而不是某个具体文件——那个地址永远指向最新一版，
而文件名里带版本号与架构，填死了下次发版就过期。

`sourceZipUrl` 是另一回事：GitHub 对 `main` 分支的源码归档。

## 换演示录屏

母版在 `promo/footage/07-walkthrough-vo.mp4`（334 MB / 1920×1080 / 60fps / 3:52 / 英配解说）。
仓库里跟页面走的是压过的网页版 `media/demo.mp4`：

```bash
ffmpeg -i promo/footage/07-walkthrough-vo.mp4 -vf scale=1280:-2,fps=30 \
  -c:v libx264 -preset slow -crf 31 -pix_fmt yuv420p -profile:v high -level 4.0 \
  -c:a aac -b:a 128k -ar 48000 -ac 2 -movflags +faststart \
  submission/media/demo.mp4
```

为什么是这组参数（都是量出来的，不是拍的）：

| 设置 | 体积 | 取舍 |
|:---|---:|:---|
| 1080p60 CRF 27 | — | 母版，12 Mbps，网页不能直接用 |
| 720p30 CRF 27 | 41 MB | 太重，观众不一定等 |
| **720p30 CRF 31** | **23.3 MB** | **当前选择** |
| 540p30 CRF 28 | 23 MB | 同样体积下不如 720p 清楚 |

`-movflags +faststart` 不能省：母版的 `moov` 在文件尾，不加它观众得点一下才出画面。

换完片子记得跑一次 `npm run verify`——`verify_submission` 会核对页面上写的体积
与文件真实体积一致，不一致直接红。

**不想让仓库带 23 MB**：把 `site.json` 的 `videoSrc` 填成站外 https 直链，
构建脚本会照抄、不再找本地文件；或者构建时加 `--no-media`，页面会自动收起播放器、
换成一句说明（不会给访客一个点了没反应的播放器）。

## 三处需要守住的说法

这一页是上线给所有人看的，所以下面三条由 `verify_submission` 守着（写进页面就会红）：

1. **不承诺没实现的东西。** The Echo、八百年诗人都还没进 `src/`（表单 §0.1）。
2. **不说「零贴图」。** 准确说法是：路面/地形/草皮/水面不下载任何贴图文件（着色器算），
   13 个驿站模型里 7 座代码生成、0 图片字节，5 座碎片驿站是 Tripo 模型、自带贴图。
   全项目共 258 张内嵌贴图，说成「零贴图」被人数一遍就穿了（表单 §0.3）。
3. **包体数字用实测值**：游戏本体 20.77 MB / 首屏 3.45 MB / JS 280 KB gzip，
   不写 press kit 里那个 12.8 MB，也不写 README 里过期的 8.6 MB（表单 §0.2）。

## 本地预览

```bash
npm run submission:build && npm run preview
# 打开 http://127.0.0.1:4173/submission/
```

也可以直接双击 `submission/index.html`：页面里所有文字都写在 HTML 里，
JS 只做语言切换与复制按钮，脚本不跑也只是少两个功能，不会缺块。
（注意：源码里在线 Demo 那几块是**展开**的，收起是构建时做的。）

## 文件

| 文件 | 是什么 |
|:---|:---|
| `index.html` | 页面本体。链接处标 `data-cfg`，由构建脚本按 `site.json` 覆写 |
| `landing.css` | 样式。配色取自游戏自己的 UI 变量，字体直接借用 `dist/fonts/ui.woff2` |
| `landing.js` | 只有两件事：语言切换、复制按钮。无依赖、不生成内容 |
| `site.json` | **链接与开关的唯一来源**。`_` 开头的键是给人看的注释，构建时忽略 |
| `media/hero.jpg` | 抬头主视觉，即游戏标题美术（`public/ui/titleart.jpg` 的副本） |
| `media/poster.jpg` | 播放器海报，取自录屏 3:16 处的一帧 |
| `media/demo.mp4` | 演示录屏网页版（见上） |