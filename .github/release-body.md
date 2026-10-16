# Gift No.188 v__VERSION__

## 新内容

- 七处现有建筑接入经营：备料、制作、接单、服务、交付、赚旅币与口碑、升级设施，四段经营故事与原主线衔接。沿用 v3 存档，旧进度保留。
- 手机触控增加换载具，支持左右手布局、安全区和横屏提示；暂停、经营面板不再被骑行控件遮挡。
- 琴音林修正到实际站点，保留小游戏和自由演奏两个入口；恢复模型等比缩放、清理附近树木。
- 人物脚与踏板使用同一相位和节奏，覆盖慢速至加速。
- 固定种子生成路灯、路肩反光桩和田垄；默认五分钟完成一天，支持现实同步、倍率、偏移、暂停和固定时刻。视觉时间不消耗原主线天数。
- 湖边支持普通全景与钓鱼；设备支持 WebXR 时可请求沉浸 VR，拒绝或不支持时保留普通交互。

## Changes

Seven existing locations now support a complete business loop: gather, craft, serve orders, earn coins and reputation, upgrade and unlock four story milestones. Existing v3 saves carry over.

Touch controls add vehicle switching, mirrored layouts, safe-area spacing and a landscape prompt. Qin Grove offers both practice and free play at the correct location, with proportional scenery. Bicycle pedals and feet share their animation clock. Seeded roadside lamps, reflectors and fields accompany a configurable five-minute day/night cycle. The lakeside remains playable as a panorama when immersive WebXR is unavailable.

## Validation / 验证边界

TypeScript, production build and the full regression entry were run locally: **116 checks / 3774 assertions, no failures or checks without assertions**. The business loop, upgrades and reload persistence were also operated in Chrome. Responsive desktop Chrome checks do not replace physical iOS/Android, VR headset or desktop installer testing; see `docs/v1.0.2-validation.md` for the exact coverage and remaining checklist.

本机没有完成手机真机、头显或三系统安装包实玩。各平台构建状态以本次 Release 对应的 GitHub Actions 为准。经营资源免费补给，经营收入会放宽原玩法的旅币预算。

## Downloads / 下载

| Platform | File |
|---|---|
| Windows 10/11, x64 | `*_x64-setup.exe` |
| macOS, Apple Silicon + Intel | `*_universal.dmg` |
| Ubuntu / Debian | `*_amd64.deb` |
| Other Linux distributions | `*_amd64.AppImage` |

Desktop packages contain the game assets and support offline play. Packages are unsigned; use the security policy appropriate to your device. / 桌面包内置资源、可离线游玩；安装包未签名，按设备的安全策略处理。

[Play in the browser / 浏览器游玩](https://jasper-leung.github.io/188js/) · [Source / 源码](https://github.com/Jasper-Leung/188js) · [Issues / 反馈](https://github.com/Jasper-Leung/188js/issues)
