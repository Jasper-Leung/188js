这一版把整个游戏打进了安装包：**装完断网也能玩**。不联网、不上传任何东西、没有账号。

## 装哪个

| 你的系统 | 下哪个（认后缀就行，版本号会变） | 怎么装 |
|:---|:---|:---|
| **Windows** 10 / 11（64 位） | 带 `x64-setup.exe` 的那个，约 19MB | 双击，一路下一步。**不需要管理员** |
| **macOS**（Apple Silicon 和 Intel 都行） | 带 `universal.dmg` 的那个 | 打开 dmg，把 app 拖进「应用程序」 |
| **Ubuntu / Debian / Mint 系** | 带 `.deb` 的那个 | `sudo apt install ./188号礼物__VERSION___amd64.deb` |
| **其它 Linux**（Fedora / Arch / …） | 带 `.AppImage` 的那个 | `chmod +x` 之后双击 |

macOS 那个是**通用二进制**，M 系列芯片和 Intel 的 Mac 用的是同一个文件，不用挑。

## 第一次打开被拦下来，是正常的

两个包都**没有代码签名**（签名证书要花钱，这里没有），所以系统会先拦一下：

- **macOS**：右键点 app → 打开 → 弹窗里再点「打开」。
  或者在终端里一次解决：
  `xattr -dr com.apple.quarantine "/Applications/188号礼物.app"`
- **Windows**：「Windows 已保护你的电脑」→「更多信息」→「仍要运行」。

装完之后正常双击就有声音了。

## 不想装？

浏览器直接玩：<https://jasper-leung.github.io/no188-gift-web/>

## 别的

- 想自己看代码：<https://github.com/Jasper-Leung/188js>
- 想自己打包（Windows）：`npm install && npm run desktop:build`，
  产物在 `src-tauri/target/release/bundle/`。
- 哪台机器上装不动或者跑不起来，开个 issue 说一声：
  <https://github.com/Jasper-Leung/188js/issues>

—— 一个人做的礼物，谢谢你愿意打开它。
