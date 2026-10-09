## What changed in v1.0.1

A patch release: **no new content, no balance changes** — five fixes to things
that made the game harder to play than it meant to be. Your save carries over.

All five are the same shape of problem: **the interface was correct, and the
player still had no idea what to do.** None of them throws an error, none crash,
and none of the 69 automated checks could see them.

**The Skip button threw away the story.** One press made all three lines vanish,
including the ones you had not read — and those lines are the narrative. It now
jumps to the last line and shows it complete; press once more to move on.

**Nobody knew the black panels were clickable.** `cursor: pointer` only exists
while the mouse is pointing at it, so touch players had no way to tell and simply
waited it out (the seven prologue lines need 86 seconds in English). "Tap to
dismiss" now appears once per run and withdraws itself after 2.6 seconds.

**Nobody knew why they were playing a minigame.** The seam between "the dialogue
ends" and "the minigame starts" was empty, and the purpose — light this station's
pip, collect its fragment — was never stated by anything.

**The minigame backgrounds looked unfinished.** Not too little drawing — three
layers crammed into the same brightness. Measured contrast between the two
ridges: bamboo 1.19 → 3.27, zither 1.59 → 3.27, cloud 1.54 → 2.45. The sky was
also four flat colour bands, i.e. four visible seams; it is a real gradient now.

**Bamboo Rain Courtyard's header was never translated.** On your second and
third visit the story card's header read 竹雨庭 even in English. Two other places
in the same code path were already correct — only that one line took the Chinese
name. It went unnoticed for six review rounds because the card only appears on
the second and third visit.

Two new checks came with it (69 checks / 1066 assertions, all green), and a
defect in the test harness itself got fixed: the minimal DOM stub's `remove()`
had never actually removed a node.

---

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

Play it in the browser: <https://jasper-leung.github.io/188js/>

## Notes

- Source code: <https://github.com/Jasper-Leung/188js>
- Build it yourself (Windows): `npm install && npm run desktop:build`,
  artifacts land in `src-tauri/target/release/bundle/`.
- If it won't install or won't run on your machine, please open an issue and say
  so: <https://github.com/Jasper-Leung/188js/issues>

— Made as a gift by one person. Thank you for opening it.