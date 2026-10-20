# 发布数字 / Release facts

<!--
  本文件由 `npm run facts` 生成（`tools/verify-all.mjs --write-facts`）。
  **请勿手改** —— 改了会被 `npm run verify` 的 [DOC] 门判红，
  因为门会拿它和这一轮真实跑出来的数对账。

  为什么要单独一份：以前同一个数字散在 README、README.zh-CN、
  release-body、AGENTS.md 和提交页里，加一个功能要改五处，
  而漏改任何一处都不会有人知道。改成**只留这一份**之后，
  改一个功能只需要重新生成这一个文件。
-->

| 键 | 含义 | 值 |
|---|---|---|
| `version` | 版本 | `1.0.2` |
| `checks` | 回归条数 | `125` |
| `asserts` | 断言条数 | `4196` |
| `entry_lines` | `src/verify/entry.ts` 行数 | `9415` |
| `i18n_keys` | 文案键数（每种语言） | `626` |
| `js_raw_kb` | JS 原始体积（KB） | `1115` |
| `js_gzip_kb` | JS gzip 体积（KB） | `338` |
| `css_raw_kb` | CSS 原始体积（KB） | `39` |
| `css_gzip_kb` | CSS gzip 体积（KB） | `9` |
| `payload_raw_mb` | 游戏本体原始体积（MB） | `22.94` |
| `payload_gzip_mb` | 游戏本体 gzip 体积（MB） | `19.46` |
| `models_mb` | 模型合计（MB） | `18.21` |
| `model_count` | 模型文件数 | `23` |
| `audio_mb` | 音频合计（MB） | `2.21` |
| `dist_total_mb` | 整个 `dist/` 体积（MB，含提交页） | `46.52` |

其余的公开数字（各别模型的大小、录屏时长、字体子集大小等）
是**资产自身的事实**，不随功能变，所以仍然留在各自的文档里。

看数字的人只需要看这一份；别处请指向它。
