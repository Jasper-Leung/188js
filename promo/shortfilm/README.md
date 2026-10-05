# Gift No.188 — Short Film (English)

Developer: Liang Zhuowen (梁卓文) · Protagonist: **Miles Lu** (路俊航, fictional)

## Files

| File | What it is |
|:---|:---|
| `GiftNo188-ShortFilm-v2.mp4` | **Master (v2).** 78s, 1920x1080, 30fps, H.264 + AAC, ~35 MB. |
| `GiftNo188-ShortFilm-v2-web.mp4` | Same cut (v2), compressed for sharing. ~11 MB. |
| `assets/literati.mp4` | The ancient-literati cutaway on its own (AI-generated, 8s, 768P). |

## Shot list

| Time | Shot | Source |
|:---|:---|:---|
| 0.0 - 5.5 s | **Smile** on parchment. | Chrome-rendered typography |
| 5.5 - 13.5 s | **Ancient literati gathering** — scholars around a low table, guqin, tea, misty peaks. | AI-generated video (MiniMax-H3-Max, 768P) |
| 13.5 - 21.5 s | Back to **Smile**; the `S` slides to the end and turns lowercase, the `m` grows to a capital -> **Miles** | Chrome-rendered typography (FLIP) |
| 21.5 - 29.0 s | He quit the job he was supposed to stay in. | Chrome-rendered typography |
| 29.0 - 34.0 s | **Lu** | Chrome-rendered typography |
| 34.0 - 39.0 s | **Lu** -> **路** (cross-fade) | Chrome-rendered typography |
| 39.0 - 43.0 s | **Road** | Chrome-rendered typography |
| 43.0 - 51.0 s | **Old buildings** — pavilions and tea sheds along the road. First-person, on foot. | Real gameplay capture |
| 51.0 - 59.0 s | **The development** — three towers, four round houses, off in the southeast. | Real gameplay capture |
| 59.0 - 73.0 s | **Exploring the truth** — real in-game dialogue over the road. | Real gameplay capture |
| 73.0 - 78.0 s | End card. | | Cover art + ffmpeg |

## The dialogue in the last act

These are actual shipping strings from `src/data/generated/i18n.json`, lightly
de-punctuated so they read as subtitles:

| On screen | Source key |
|:---|:---|
| "Past the fork to the south there is an old road bed no map records." | `villain_2_1` |
| "We dug an inscribed stone out of it." | `villain_2_1` |
| "She went to see that same stone. After that, she never came back." | `villain_2_2` |
| "Marked No.188. This road knows everyone who has walked it." | `stele_3_line` |
| "The letters have been chiselled away. Half a 188 is all that is left." | `stele_4_line` |
| "He came back to find out what the old road was keeping." | new, this version's story beat |

## Two deliberate production choices

**First-person, on foot.** The vehicle feature is mid-repair, so this film never
shows a vehicle or the rider model. The `first` camera in `src/world/ride.ts` is
`{ back: 0.15, up: 1.62 }` — true eye height, character clipped out by the near
plane. Gameplay segments are cut from frames `f03500` onward; earlier frames in
that capture still carry the character and are excluded on purpose.

**The two building types are the story.** Old = the sixteen roadside stations
(procedural East Asian architecture, faces turned to the road). Modern = three
`towers` and four `round houses` placed 60-230 m off-road in the **southeast
quadrant only** — `src/world/scenery.ts` keeps them in `quad: [1, 1]` and
`src/verify/entry.ts` asserts they never appear in the same quadrant as the
bamboo, specifically so the development reads as *the other side of the map*.
The cut points were chosen to put both in one frame where possible.

## Pipeline

1. `tools/route-geom.mjs` rebuilds the 961-point, 1228.82 m centreline from
   `road.json` (self-check matches live telemetry exactly).
2. `tools/fp-capture.mjs` drives the built game in Chrome, walking the route on
   real `W`/`A`/`D` keypresses with the `first` camera, capturing via CDP
   screencast. It logs per-frame `(x, z)` so the southeast quadrant can be found
   afterwards — that is how the modern-district shot was located.
3. `promo/typo/typo.template.html` + `promo/typo/scenes.js` drive the typography.
   `tools/typo-render.mjs` writes the frame index into the page, waits two
   `requestAnimationFrame`s, then screenshots — so frame *N* is exactly *N*/30 s.
4. `tools/shortfilm.ps1` cuts, overlays dialogue, joins, muxes the score.

## Traps hit while building this

Worth keeping if you re-run any of it:

- **`String.replace` only replaces the first occurrence.** The placeholder
  `__DURATION__` also appeared in a comment, so the real one survived and Chrome
  threw `__DURATION__ is not defined`. Use `replaceAll`.
- **A page-driven rAF clock outruns a screenshot loop.** Letting the page
  increment its own frame counter at 60 fps while screenshots ran at ~25 fps meant
  frame 570 was already at time 49000 ms — past the end of the timeline, so every
  frame came out as blank parchment. Drive the index from the loop instead.
- **`insertBefore(src, kids[i])` inserts *before* index i, not at it.** The
  `S` landed between `l` and `e` (`"milse"`) until the FLIP used `appendChild`
  for the last slot.
- **A hardcoded 120 px letter advance is wrong** because `'S'` is wider than
  `'s'`. Measure with `getBoundingClientRect` and let the reorder do the work.
- **ffmpeg `drawtext` `text=` cannot contain an apostrophe** — it closes the
  filter's quoted argument and the whole chain fails. "someone else's" broke it
  in the v2 trailer. Avoid `'`, and be careful with `:`.
- **`drawbox`/`drawtext` coordinates are post-`scale`.** Without a `scale` first,
  a 1920x1080 box lands on the top-left of a 2752x1536 source and leaves a hard seam.
- In PowerShell, `"$var:"` is a **drive-qualified variable**; write `${var}`.
- Do not set `$ErrorActionPreference = 'Stop'` around ffmpeg — PowerShell 7 turns
  any stderr line into a terminating error, so successful runs read as failures.
- ffmpeg's `concat` **demuxer** mangles Windows absolute paths. `Push-Location`
  into the temp dir and use bare filenames.

## What is not in this film

The Echo mechanic and the eight-hundred-year poet are specified but **not
implemented in the build yet** — see `promo/README-v2.md`. The literati cutaway is
AI-generated, not a capture of anything in the game. Everything in the three
gameplay sections is a real recording of the current build.
