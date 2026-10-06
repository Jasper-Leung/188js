This build ships the whole game inside the installer: **it plays with the
network unplugged**. No connection, nothing uploaded, no account.

## Which one to take

| Your system | Download this (match the suffix — the version number changes) | How to install |
|:---|:---|:---|
| **Windows** 10 / 11 (64-bit) | the one ending in `_x64-setup.exe`, about 42 MB | double-click, next-next-finish. **No administrator needed** |
| **macOS** (both Apple Silicon and Intel) | the one ending in `_universal.dmg` | open the dmg and drag the app into Applications |
| **Ubuntu / Debian / Mint family** | the one ending in `_amd64.deb` | `sudo apt install ./<the-file-you-just-downloaded>.deb` |
| **Other Linux** (Fedora / Arch / …) | the one ending in `_amd64.AppImage` | `chmod +x`, then double-click |

The macOS build is a **universal binary**, so M-series and Intel Macs use the
same file — there is nothing to pick between.

## Getting blocked on first launch is normal

Neither package is **code-signed** (signing certificates cost money, and there
aren't any here), so the system will stop and ask first:

- **macOS**: right-click the app → Open → click "Open" again in the dialog.
  Or do it once, for good, from a terminal:
  `xattr -dr com.apple.quarantine "/Applications/Gift188.app"`
- **Windows**: "Windows protected your PC" → "More info" → "Run anyway".

After that it launches normally, with sound.

## Rather not install anything?

Play it in the browser: <https://jasper-leung.github.io/no188-gift-web/>

## Notes

- Source code: <https://github.com/Jasper-Leung/188js>
- Build it yourself (Windows): `npm install && npm run desktop:build`,
  artifacts land in `src-tauri/target/release/bundle/`.
- If it won't install or won't run on your machine, please open an issue and say
  so: <https://github.com/Jasper-Leung/188js/issues>

— Made as a gift by one person. Thank you for opening it.