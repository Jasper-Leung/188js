# Gift No.188 — Promotional Materials (English) — v2

Developer: Liang Zhuowen (梁卓文) · Protagonist: **Miles Lu** (路俊航, fictional)

v2 is built around the new story: the Echo mechanic, the eight-hundred-year poet,
and the family business under a thirty-day deadline.

---

## What is here

| File | What it is |
|:---|:---|
| `GiftNo188-Trailer-v2.mp4` | Master trailer. 72s, 1920x1080, 30fps, H.264 + AAC, ~55 MB. |
| `GiftNo188-Trailer-v2-web.mp4` | Same cut, compressed for sharing. ~19 MB. |
| `assets/cover2-final-16x9.jpg` | Finished 16:9 cover with title lockup. 1920x1080. |
| `assets/cover2-16x9.jpg` | Clean key art, no text. 2752x1536. |
| `assets/cover2-3x4.jpg` | Clean key art, portrait, for vertical formats. |
| `deck/output/GiftNo188-Roadshow-Deck-v2.pptx` | 16-slide roadshow deck, 16:9, fully English. |
| `WORK-DESCRIPTION-V2.en.md` | Long-form work description. |
| `PRESS-KIT-V2.en.md` | Store copy, press release, pitches, social posts, facts sheet. |

v1 files are still in place and unchanged, for comparison.

---

## Read this before publishing the v2 trailer

**The story in v2 is not in the build yet.** The repo's current code (commits
`545b93f`, `7dbe584`) adds vehicles, cameras and a title screen. There is no Echo
mechanic, no ancient objects, and no poet in `src/` — the nine new i18n keys are all
`veh_*`, `key_camera_*` and title-screen strings.

So the v2 trailer is honest about what it is: **real footage of the current world,
carrying a story that is specified but not shipped.** The gameplay is genuine; the
story beats on top of it are the pitch, not a recording of a feature. Do not describe
it as gameplay footage of the Echo without implementing it first.

What the v2 trailer *does* show for real, and newly:

- Miles Lu on screen, in all four rides — on foot, bicycle, motorcycle, skateboard
- three camera positions, including the close chase view
- the in-game story cards firing mid-ride: the crossing ("Here the road doubles back")
  and Stele No.188 ("The keeper remembers the road, not himself")

## Two decisions you should review

1. **The eight-hundred-year poet is unnamed in the v2 materials.** You described the
   character but did not give a name, so the copy says "a famous poet" / "the old man"
   throughout. I deliberately did not invent a name, because a promo deck is the last
   place you want a placeholder discovered. Drop the real name in when you have it —
   it appears in `WORK-DESCRIPTION-V2.en.md`, `PRESS-KIT-V2.en.md`, deck slides 4, 7 and
   16, and the trailer's end card.
2. **The mother thread from v1 is gone.** v1 copy led with "the road your mother
   disappeared on". Your new brief describes quitting a job, weighing the family
   business, the lawyer's letter, and the poet — and does not mention her. The v2
   materials follow your new brief, so the v1 premise was dropped rather than merged.
   If both threads are meant to coexist, that is a real story decision and I left it
   to you. The in-game script still contains the v1 mother lines
   (`prologue_2`: "When you left, the mountains were still here, Mother."),
3. **Name mismatch in-game.** The shipping English calls the protagonist
   **"Lu Junhang"** (`prologue_speaker`, `player_speaker` in
   `src/data/generated/i18n.json`). All v2 material says **Miles Lu**. Align the table
   before the trailer runs publicly, or the store page and the game disagree.

---

## How the v2 trailer was made

Gameplay is **real**, captured from your own build with real keypresses — not generated.

1. `tools/route-geom.mjs` reconstructs the exact 961-point, 1228.82 m centreline from
   `src/data/generated/road.json` using the same transform chain as `src/data/route.ts`.
   Self-check (`node tools/route-geom.mjs selftest`) matches live telemetry exactly.
2. `tools/screencast-ride2.mjs` drives the built game in Chrome via `playwright-core`,
   reading `window.gift188.bike` and steering with real `W`/`A`/`D`. It rotates vehicle
   (`E`) and camera (`V`) during the ride. Forward motion makes `arc` **decrease**, so
   the look-ahead samples `arc - LOOKAHEAD`.
3. Frames come from CDP `Page.startScreencast` at JPEG q92 (~55 fps), not Playwright's
   WebM recorder, which visibly softened the image.
4. `tools/trailer-v2.ps1` cuts 8 segments, normalises to 1920x1080 / SAR 1:1, joins,
   burns in the story lines, and muxes the score.

**Autopilot caveat:** rotating vehicles mid-lap changed the handling, and the
controller drifted off the road on roughly the middle third of the lap. The segment
start numbers in `trailer-v2.ps1` were chosen by eye from contact sheets to avoid those
stretches. If you re-record, either tighten the cross-track term or pin the vehicle.

## Environment notes

- `playwright-core` drives your **existing** Chrome; no browser download needed.
- Chrome flags: `--use-gl=angle --enable-unsafe-swiftshader --ignore-gpu-blocklist`.
- `node_modules` was reset during the v2 build; `pptxgenjs` and `playwright-core` were
  reinstalled as devDependencies.

### PowerShell traps that cost real time here

- In a double-quoted string, `$var:` is parsed as a **drive-qualified variable**
  (like `$env:PATH`). Any variable followed by a colon must be `${var}`. Un-braced,
  this produced `fontsize==(w-tw)/2`, and ffmpeg **segfaulted** instead of reporting a
  syntax error — the failure looked like an ffmpeg bug, not a string bug.
- ffmpeg `drawtext` `text=` cannot contain an apostrophe; it closes the filter's
  quoted argument. "someone else's memory" broke the whole filter chain. Same for any
  `:` or unbalanced quote.
- Do **not** set `$ErrorActionPreference = 'Stop'` around native commands. PowerShell 7
  turns any stderr line into a terminating error, so a successful ffmpeg run reads as
  failure. Check `$LASTEXITCODE`.
- `drawbox`/`drawtext` coordinates apply to the frame **after** `scale`. Always scale
  to the target size first, or boxes land on the wrong region and leave hard seams.
- ffmpeg's `concat` **demuxer** mangles Windows absolute paths. `Push-Location` into the
  temp dir and use bare filenames.
- A stale 0-byte output from a failed run makes `Test-Path` look like success. Check
  file size, not existence.
