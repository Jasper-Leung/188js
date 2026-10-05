# Gift No.188 -- Promotional Materials (English)

Developer: Liang Zhuowen (liangzhuowen)
Protagonist: **Miles Lu** (fictional character)

---

## What is here

| File | What it is |
|:---|:---|
| `GiftNo188-Trailer.mp4` | Master trailer. 72s, 1920x1080, 30fps, H.264 + AAC, ~53 MB. Real gameplay + generated score. |
| `GiftNo188-Trailer-web.mp4` | Same cut, compressed for sharing. ~20 MB. |
| `assets/cover-final-16x9.jpg` | Finished 16:9 cover with title lockup. 1920x1080. |
| `assets/cover-16x9.jpg` | Clean key art, no text. 2752x1536. Use this if you need your own title. |
| `assets/cover-3x4.jpg` | Clean key art, portrait. Use for vertical / story formats. |
| `deck/output/GiftNo188-Roadshow-Deck.pptx` | 16-slide roadshow pitch deck, 16:9, fully English. |
| `WORK-DESCRIPTION.en.md` | Long-form work description / game intro. |
| `PRESS-KIT.en.md` | Store copy, press release, elevator pitches, social posts, facts sheet. |

---

## How the trailer was made

The gameplay is **real**. It was captured from your own build, not generated:

1. `tools/route-geom.mjs` reconstructs the exact 961-point, 1228.82 m centreline from
   `src/data/generated/road.json`, using the same transform chain as `src/data/route.ts`.
   Verified against live telemetry: point count, total length, and the start position
   all match to 2 decimals.
2. `tools/screencast-ride.mjs` drives the built game in Chrome via `playwright-core`.
   It reads `window.gift188.bike`, works out a look-ahead point on the centreline, and
   steers with real `W`/`A`/`D` keypresses -- so the bike genuinely rides the route.
   Forward motion makes `arc` *decrease*, which is why the look-ahead samples
   `arc - LOOKAHEAD`.
3. Frames are captured over CDP `Page.startScreencast` at JPEG q92 (~38 fps) rather
   than through Playwright's WebM recorder, which was visibly softening the image.
4. `tools/trailer2.ps1` normalises every segment to 1920x1080 / SAR 1:1, joins them,
   burns in the story lines, and muxes the score.

One lap is 1,228.8 m at roughly 6 m/s, so a full clean circuit is about 3.5 minutes.

## Environment notes (if you re-run these)

- `playwright-core` drives your **existing** Chrome; no browser download needed.
- Chrome flags used: `--use-gl=angle --enable-unsafe-swiftshader --ignore-gpu-blocklist`.
  It renders at 60 fps at 1920x1080.
- PowerShell gotchas that cost real time here, in case you edit the scripts:
  - In a double-quoted PowerShell string, `$var:` is parsed as a **drive-qualified
    variable** (like `$env:PATH`). Any variable followed by a colon must be written
    `${var}`. This silently produced `fontsize==(w-tw)/2`, which made ffmpeg
    segfault instead of reporting a syntax error.
  - Do **not** set `$ErrorActionPreference = 'Stop'` around native commands --
    PowerShell 7 turns any stderr line into a terminating error, so a successful
    ffmpeg run reads as a failure. Check `$LASTEXITCODE` instead.
  - Avoid backtick line continuations; use argument arrays.
  - ffmpeg's `concat` **demuxer** mangles Windows absolute paths. The script does
    `Push-Location` into the temp dir and uses bare filenames instead.

## Two things worth knowing about the game

Found while capturing this material, not reported by anything you had:

1. **The 90-second demo does not actually ride.** `startDemo()` sets `demoActive`
   and advances dialogue on a timer, but nothing drives the bicycle forward -- the
   bike sits at speed 0 for the whole demo. Anyone reviewing the build will see a
   static scene with text over it. The footage in this trailer had to be produced
   with real key input.
2. **The in-game English calls the protagonist "Lu Junhang"**, not "Miles Lu".
   The promo materials here use **Miles Lu** throughout, per your instruction. The
   i18n table still says `prologue_speaker: "Lu Junhang"` and `player_speaker: "Lu Junhang"`
   in `src/data/generated/i18n.json`. Worth aligning before any public trailer
   runs, or the store page and the game will disagree about the main character's name.
