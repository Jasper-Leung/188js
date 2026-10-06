# Gift No.188 · three.js edition

> **English** · [简体中文](README.zh-CN.md)

The web edition of *Gift No.188*, originally written in Godot 4.6. Gameplay,
numbers and text are carried over 1:1; the presentation layer and the project
structure were rebuilt, with **low-end compatibility** treated as a first-class
design goal.

## From Godot to three.js

Started from zero during the jam. **The first version was written in Godot 4.6**,
running locally and leaning on the engine's own import pipeline to compress
assets. It was then rewritten for the web in three.js — presentation layer and
project structure rebuilt from scratch, with gameplay, numbers and text carried
over 1:1.

**The three.js version is what was submitted**, and it is what you can download
below. The reason is practical: the web build asks nothing of the machine (no
engine to install, no administrator rights), and "low-end compatibility" is only
achievable when you control the internal render resolution yourself — Godot has
no controllable internal render resolution, so scaling there is actually slower.

Both versions were written from zero during the jam. The three.js build is not a
conversion of the Godot one; it is a second implementation of the same game.

## Download

If you would rather not set anything up, grab a built version — Windows, macOS
and Linux are all covered:
**[Releases](https://github.com/Jasper-Leung/188js/releases)**
(or play in the browser: <https://jasper-leung.github.io/no188-gift-web/>)

| Your system | Which one to take | How to install |
|:---|:---|:---|
| Windows 10 / 11 (64-bit) | the `x64-setup.exe` one, ~42 MB | double-click, next-next-finish, **no administrator needed** |
| macOS (universal: Apple Silicon + Intel) | the `universal.dmg` one | drag into Applications |
| Ubuntu / Debian / Mint family | the `.deb` one | `sudo apt install ./<package>.deb` |
| Other Linux | the `.AppImage` one | `chmod +x`, then double-click |

**The packages are unsigned**, so the system blocking you on first launch is
expected: on macOS right-click → Open, on Windows click "More info" → "Run
anyway". Building it yourself is covered in [Deployment](#deployment).

## Development

```bash
npm install
npm run data:extract     # mechanically extract data tables from the Godot source project (output is committed, so skippable)
npm run assets:all       # font subsetting + GLB compression
npm run dev              # http://127.0.0.1:5180
npm run verify           # headless regression suite
npm run build            # output lands in dist/
```

Debug entry points: `?caps` runs capability detection only and skips world
building; `?tier=0|1|2` forces a quality tier; `?touch=1` / `?touch=0` forces
touch controls on / off.
`window.gift188` is a read-only state export (where you are, distance off-road,
draw call count).
**F8** opens the performance panel: fps / draw calls / triangles / render
resolution / **speed / on-road or not** / quality tier.

---

## The website

This repository is also the game's **website**. `npm run build` produces two
things:

- the root of `dist/` — the game itself (wherever you deploy it, it plays)
- `dist/submission/` — the landing page: screencast, download entry points, and
  a live demo

The source of that page lives in [`submission/`](submission/README.md). The
single source of truth for its links and switches is `submission/site.json`,
baked into the HTML at build time and guarded by `verify_submission` —

| Section | Status |
|:---|:---|
| Demo screencast | ✅ `media/demo.mp4` (a 334 MB master compressed to a 23.3 MB web copy, embedded playback + direct download) |
| Live demo | ⏸ hidden for now (`demoHidden: true`) — it comes back by flipping one key once the URL is settled |
| Download | ✅ desktop installers (Windows / macOS / Linux) · source zip · three commands to run it locally |

Not a single link on the page is dead: an empty address renders as a dashed
"coming soon" placeholder, and a section that isn't open yet collapses entirely
— so a visitor never gets a button that does nothing when clicked.

```bash
npm run submission:links   # prints the addresses currently advertised, and the ones still owed
npm run package:web        # builds an offline-distributable web package (release/)
```

The game itself still lives at the root of `dist/`, unmoved (which is what
`base: './'` forces — see the comment in `vite.config.ts`); that page takes the
un-bundled route instead, so it works on any host.

---

## What kind of game this is

A ride with a mood. Cycle a hand-constructed figure-eight loop, visit five
waystations three times each, and combine fifteen fragments into a postcard you
can write on and export as a PNG.

No combat, no failure screen that ends your run. A full playthrough takes about
20–30 minutes.

| | |
|:---|:---|
| Route | figure-eight lemniscate, measured **1228.8 m**, closed loop, centreline 961 points |
| Waystations | 16 (5 fragment stations + 11 you only pass) |
| Check-ins | **3 visits** to each fragment station to fill it, 15 sessions in all |
| Delights | five minigames — cloud, tea, qin, bamboo, bird — rotating on `(fragment slot + visit index) % 5` |
| Economy | travel coins. Three shops, ten goods, and one budget that *requires* subtraction |
| Spirits | 1–5. Falls but never locks; floor of 1. There is a way back up (the tea shop's clearing tea) |
| Ending | four postcard ranks — first journey / explorer / pilgrim / master; a final two-way choice |

---

## Three rules for the port

### One: never retype data

The source project has 11k lines of GDScript, hundreds of strings and dozens of
numbers. **Typing any of it once is a typo**, and a typo in data like this is
almost invisible — a station name off by one character, a fragment colour off by
one channel. It plays as "something feels slightly off", and the regression
suite stays green.

So there is `tools/gd-parse.mjs`: a parser that only understands GDScript
literals, and moves the data tables out of `road_data.gd` / `shop_data.gd` /
`Localization.gd` / `TerrainBuilder.gd` and a dozen other files verbatim into
JSON (`src/data/generated/`) — not one character changed. The moment it meets a
function call or an expression it errors out and exits: failing is fine, guessing
is not.

After the move the Chinese model filenames (`station_亭灯.glb`) survive intact,
and both sides of the 234-key string table match exactly.

### Two: translate geometry point by point

Terrain elevation, road mesh and station placement are translated line by line,
and the "why is this value this value" reasoning from the source comments comes
across with them. Ten hard invariants are guarded by `npm run verify`:

```
verify_8_shape     961 points / 1228.8 m / 4 crossings of the midline / both loops mirror-symmetric
verify_stations    16 stations / 5 fragments / slots cloud-tea-qin-bamboo-bird / all outside the shoulder and all reachable
verify_economy     all-clear 799 / all-buy 1010 / shortfall 211 / riding only 424
verify_water       3 bowls / water level -3.4 always below the terrain floor / shoreline ≥ 16 m from the road
verify_mini_game   15 sessions × 3 tries each / first visit = your own item / never two of the same in a row
verify_quality     three tiers monotonic / fog distance ≥ vegetation radius / low tier kills shadows and grass
verify_mood        mask 0→0.34 never fills the screen / there is a way back up / sight has a floor
verify_checkin     "already collected" and "nothing more to do here" are two different things
verify_i18n        234 strings consistent across languages / no distances in copy / station counts carry no denominator
verify_terrain     800 m / 128 cells / 6.25 m per cell
```

**This suite caught a real bug during the port**: `hash2d` was missing one of
the source project's `fmod(..., 1.0)` layers, so the noise range became
`[-0.98, 2.96]` with a mean of +0.99 — which lifted the whole terrain and let
the **upper** clamp swallow 79% of samples. And the point count, total length and
range assertions were **all green**. The world had simply become a plateau with
no valleys in it. That is exactly why the suite exists.

### Three: turn non-robust criteria into robust ones

The source project's `verify_8_shape` counts "sign changes of the centreline's
x coordinate" and gets 4. The same criterion on the port gets 3. Digging in: the
figure-eight passes exactly through the centre at parameters 0 and 0.5, so those
two points have an x exactly equal to the midline — and the criterion *skips*
points that sit exactly on it. The source project's own sample points don't land
on the midline, which is why it counts 4.

In other words **that 4 was a coincidence of sampling, not a property of the
shape**. Counting once more with the tail joined back to the head gives 4 as
well, and is immune to resampling. The source comments carry a piece of
methodology that turns out to apply here again:

> When a regression suite throws an exception, the exit code is 0 — and a
> regression that never printed a single assertion looks like it passed. So the
> judge does not trust exit codes. It trusts exactly two things: was there a
> `[FAIL]`, and did anything get asserted at all.

`tools/verify-all.mjs` flags `asserts === 0` separately as `NO-ASSERT` and does
not count it as a pass.

---

## Low-end compatibility: what this edition actually did

The original game had three quality tiers, and they only switched **shadows and
vegetation radius**. That was the right call at the time — Godot has no
controllable internal render resolution, so upscaling there is only slower. On
the web that premise no longer holds, so this edition promotes **render
resolution** to a first-class knob and re-sorts every tier's trade-offs around
"what does this machine actually lack".

### What each tier switches

| | Low | Medium | High |
|:---|:---|:---|:---|
| **Internal render resolution** | **0.60×** | 0.85× | 1.0× |
| Shadows | off | 1024 / 55 m | 2048 / 130 m |
| Grass | **off** | 105 m · 70% | 190 m · 100% |
| Street trees | 52 m · 35% | 92 m · 75% | 160 m · 100% |
| Fog distance | 130 m | 260 m | 400 m |
| Landmark load distance | 130 m | 220 m | 320 m |
| Ambient audio layers | 1 (wind) | 2 | 3 |
| Tone mapping | off | ACES | ACES |
| Distant landmarks | silhouette stand-in | real model | real model |

The low tier's **two cuts** are reasoned like this:

- **0.6× render resolution** is the core of this tier. The bottleneck on
  integrated graphics is almost always fill rate; 0.6² = 36% of the pixels
  roughly triples the frame rate, and the fog hides what the upscale blurs.
- **Grass is turned off entirely**, and that budget is **moved into
  resolution**. Grass is the most expensive item in this family (full-screen
  translucent cards are a fill-rate killer), but halving it only buys you "the
  grass is still grass, just thinner". Cutting it for 36% of the pixels across
  the whole screen makes **the entire game** smoother instead.

### A few other things

- **Zero textures.** The road, terrain, grass and water all get their surface
  from shaders. On a weak GPU that isn't about saving memory, it's about saving
  **samples** — when a grass layer covers the screen, every extra texture fetch
  is a full screen of texture bandwidth, and integrated GPUs are often bound
  exactly there.
- **No post-processing.** The spirits mask is a DOM overlay, so it costs zero
  GPU time. A textbook case of "do the same thing more cheaply".
- **Vegetation streams by chunk.** One chunk every 12 m along the centreline,
  each with its own bounding sphere, so three's frustum culling actually bites
  (an InstancedMesh covering the whole map has a bounding sphere covering the
  whole map and culls not a single triangle). Grass is the exception: it is too
  dense and too small, so it becomes **one draw call of dynamically packed
  visible instances** instead.
- **Landmarks load progressively by distance**, at most one entering every 0.4 s.
  Sixteen GLBs arriving at once causes a visible hitch on a weak machine, and
  the player cannot tell that "for an instant there was one more pavilion".
- **Stopping in the background.** The whole rAF loop halts on
  `visibilitychange`. When you close the lid and come back, dt can be ten-odd
  seconds, and without clamping it the vehicle teleports across the entire map
  in one frame.
- **Fixed-step physics** (1/60) + dt clamped at 0.1 s + at most 5 catch-up steps.
  On a 25 fps machine, variable-step integration makes the vehicle trace a
  different line through the same corner, with no error of any kind.
- **Adaptive resolution** (off by default). It only touches internal sampling,
  never any on-screen element — no LOD popping, no effects vanishing, no text
  distorting. It has hysteresis and a cooldown, and only ever goes **down, never
  up**, so the picture never "breathes". The panel says when it's on.

### Capability detection

At startup it reads the GPU name via `WEBGL_debug_renderer_info`, adds
`deviceMemory` and `hardwareConcurrency`, picks an honest default tier, and
writes the **reason for its decision** back to the player in the settings panel
("Discrete GPU: AMD Radeon RX 5500 XT").

**Detection only sets the starting tier; it never changes tier afterwards.** The
original game explicitly listed "auto-downgrade" as deliberately not done, and
the same reasoning holds here: a picture changing under the player's feet without
them having touched anything is more unsettling than a stutter.

### Touch controls

Joystick bottom-left, check-in bottom-right, pause/mute top-right. The joystick
also accepts the arrow keys, so external keyboards and assistive tech work too.

**Detection ORs four signals** rather than trusting `pointer: coarse` alone:

| Signal | What it catches |
|:---|:---|
| `pointer: coarse` | genuinely has no fine pointer |
| `navigator.maxTouchPoints > 0` | has touch points, so assume the user may be using a finger |
| viewport short edge < 900px | phone / small tablet in landscape |
| **a `touchstart` has happened** | a finger has actually touched the screen |

The fourth is the useful addition: it is the most accurate on hybrid devices
(Windows touch laptops, Android desktop mode, rotated tablets), and it can't hurt
a pure desktop — nobody touches the screen in the first 30 seconds, so the
controls don't mount and don't eat the bottom-left click area.

Automatic detection gets it wrong sometimes, and questions like "where is the
joystick" have **no answer without a hint**. So there is a **tri-state switch**
in the pause menu (auto / on / off), it exists by default, and underneath it says
which signal caused it to mount. Detection only supplies the default; it doesn't
decide for the player — the same principle as the quality tier.

The joystick only exists inside the world, not on the title or onboarding pages:
putting a live joystick there is actively harmful, because the player will push
it twice, get no response, and conclude "this game can't be played on a phone".
**Controls that don't appear can't be mis-tried.**

`verify_touch` guards the joystick's sign convention (pushing up must be
`moveY = -1`) — that class of bug raises no error at all. The joystick still
drags, the UI looks fine, it's just mirrored, and since there is no joystick on
desktop it necessarily slips through every desktop test.

### Download managers (IDM and friends)

**Symptom**: on machines with IDM installed, a download dialog pops up for every
single asset as it loads.

None of the assets are actually navigation downloads (they're fetched via
`fetch` / XHR), but two things get hijacked anyway:

1. **Media elements.** `HTMLAudioElement` is a channel browsers consider
   "should be handed to a downloader", and IDM's default filter list includes
   audio. The whole audio layer has been replaced with `fetch` +
   `decodeAudioData` + `AudioBufferSourceNode` — **never touching a media
   element**, which closes that route. Two side benefits: seamless looping
   (previously the seam was covered by playing two copies offset by half a
   period), decoded once and kept resident, and volume that can be smoothed with
   `setTargetAtTime`.
2. **`<a download>`.** The postcard export uses it, and it is something the
   browser **explicitly marks as a download**. It now prefers
   `showSaveFilePicker` — that's a file picker (the user is choosing where to
   save, not being handed a file), so download managers leave it alone; and
   cancelling is not treated as a failure.

Two protocol-level safeguards were added as well: `X-Content-Type-Options:
nosniff` (no MIME sniffing) and `Content-Disposition: inline` (on both dev and
preview).

**If it still pops**: that's IDM's own settings and there is nothing left to do
in the project. Add `localhost` / `127.0.0.1` to IDM → Options → Downloads →
site exclusion list, or turn off its browser integration.

---

## Assets

| | Source | Output | How |
|:---|:---|:---|:---|
| 3D models | 22.3 MB | **5.0 MB** | textures down to 768/1024 + JPEG q76; vertex welding; error-threshold simplification; Meshopt compression |
| Textures | 3.9 MB | 1.3 MB | as above |
| Font | 24.4 MB | **181 KB** (first screen) | subset to the 880 characters that actually appear in the game + WOFF2 |
| Font (handwritten) | 24.4 MB | 404 KB (lazy) | the ~3500 most common Chinese characters, loaded only when the back of the postcard is opened |
| Audio | 2.2 MB | 2.2 MB | as-is (already ogg; recompressing hurts the ambience) |

**Meshopt rather than Draco**: a 20 KB decoder versus 250 KB, with no hitch on
first decode. On a low-end machine "the decode stutters for a moment" costs more
than 2 MB of extra transfer.

Texture compression and geometry compression **run in two processes**, and that
isn't fastidiousness: libvips opens a thread pool sized to the CPU count at
init, and importing gltf-transform and meshoptimizer (WASM) takes a batch of
threads too. If they're in the same process, every image blows up at the
write-out step with `colourspace: parameter space not set` — while **byte-for-
byte identical** files read from disk behave fine. Once the investigation
drifts toward "this particular image is bad", it goes round in circles forever.

First-screen payload ≈ 5.5 MB (JS ~0.5 MB + bicycle 0.3 MB + terrain and road
generated on the fly + UI font 0.18 MB + audio warming up); the rest arrives by
distance.

---

## Layout

```
src/
  core/      loop(fixed step + adaptive) capability(detection) settings(tiers) renderer perf
             audio(three buses + per-station variation) math noise(terrain noise)
  data/      raw(typed JSON) route(figure-eight geometry + station placement) generated/
  world/     terrain road water vegetation stations sky ride world(orchestration)
  shaders/   world.ts  (GLSL injected via onBeforeCompile)
  game/      state(progress/economy/spirits) minigameHost minigames/(the five delights) postcard/
  ui/        titleScreen onboarding hud minimap dialogue shopPanel pausePanel
             synthesisPanel endCard touchControls toast moodMask perfPanel
  i18n/      index.ts
  verify/    entry.ts(regression) probe.ts(geometry probe) spawn.ts(spawn-point probe)
tools/       gd-parse extract-data compress-textures optimize-assets
             subset-font verify-all probe glb-image
```

`src/verify/probe.ts` and `spawn.ts` exist to localise the deviations the
regression suite catches. They are the result of three real failures, each of
which read differently:

| Failure | What reading the code tells you | What you only see by measuring |
|:---|:---|:---|
| Noise missing `fmod` | a perfectly normal `hash2d` | terrain elevation mean +6.3, the upper clamp eating 79% of samples |
| Road winding-order criterion inverted | a correct `if (crossY > 0)` | the entire road back-face culled, nothing left on the ground |
| Vegetation spacing used the chunk length | a perfectly reasonable density table | one tree every 6 metres, camera buried in canopy |

---

## Deployment

This is a **pure static** build: no server code, no API, no Worker logic.
`dist/` is the whole thing.

### Cloudflare (currently in use)

```bash
npm run deploy:dry    # dry run first: reads the artifact, checks config, deploys nothing
npm run deploy        # npm run build && wrangler deploy
npm run preview:cf    # run the built artifact inside workerd
```

There is **no `main` in `wrangler.jsonc`** — so this isn't a Worker, it's pure
static asset hosting, and not one request ever enters workerd. Wrapping 21 MB of
`.glb` / `.ogg` in an isolate would only add a hop for nothing.

The `assets.directory` line is mandatory — that's what actually tells wrangler
what to upload. Without it, write only `not_found_handling` and the symptom is
**deploy succeeds, you get a domain, and it 404s**.

The `plugins: []` in `vite.config.ts` is equally mandatory — `wrangler deploy`
comes to edit that file and errors out if it can't find a `plugins` array. It
**has always been empty**: the official scaffold wants to put
`@cloudflare/vite-plugin` there, which exists so `vite dev` can route requests
into a workerd preview Worker. No request in this project enters a Worker, so the
plugin is useless here, and it would put the whole `vite dev` inside workerd,
making three.js HMR slow and turning "can I get a WebGL context inside an
isolate at all" into a daily gamble. Use `preview:cf` to try things in workerd.

### GitHub Pages

`.github/workflows/pages.yml` builds and deploys on every push to main. **Two
deployments exist at once** — remember which one you're changing.

### Desktop releases (cross-platform)

Tauri depends on each platform's native webkit and toolchain, and
**cross-compilation does not work** — a package built on your machine won't run
elsewhere. So the macOS / Windows / Linux artifacts are three runners each
building their own, driven by
[`.github/workflows/release.yml`](.github/workflows/release.yml):

```bash
# 1. change the version in src-tauri/tauri.conf.json
# 2. tag the same version
git tag v1.0.0
# 3. push the tag; the pipeline runs to completion and publishes
git push origin v1.0.0
```

| Platform | Artifact | Notes |
|:---|:---|:---|
| macOS | `.dmg` | **universal**: one file for both M-series and Intel, so the downloader doesn't have to work out which kind of Mac they have |
| Windows | `-setup.exe` | NSIS, `installMode: currentUser`, no administrator needed |
| Linux | `.deb` + `.AppImage` | the former for Ubuntu/Debian family, the latter for everything else |

Three easy traps, all of them learned while editing this pipeline:

- **The version number comes only from `tauri.conf.json`**; the tag is just a
  label. Artifact names use the former, so CI fails outright when the tag and
  `version` disagree — otherwise the page says v1.2.0 and the package inside is
  really 1.0.0, a mistake that all three jobs report as green.
- **The release is created as a draft and only published once every artifact is
  uploaded.** A failure halfway through means the version simply doesn't appear,
  rather than appearing with two platforms missing. Re-running the pipeline
  picks up that same draft.
- **`--bundles` is written per platform**, because it's validated against the
  current OS (writing `--bundles deb` on Windows fails outright with `invalid
  value`). To add `msi` / `rpm`, edit that one matrix row and nothing else.

`npm run verify` also acts as the release gate: the desktop build embeds the
entire `dist/` into the binary, so a failing assertion would become a bug present
in **every platform's installer**.

Building locally (Windows): `npm run desktop:build`, artifacts land in
`src-tauri/target/release/bundle/`.

### Two assumptions that must both hold

- `vite.config.ts`'s `base: './'` — change it to anything else without changing
  CI in step, and the symptom is quiet: everything works locally, and production
  is a white screen and a 404.
- `dist/.nojekyll` — Pages needs it or it treats underscore-prefixed
  directories as Jekyll.

---

## Measured results

Run against a production build (`vite preview`) on an **AMD Radeon RX 5500 XT /
32 GB / 8 cores**:

| Measurement | Result |
|:---|:---|
| World build (bowl placement + road indexing + vegetation placement + sky) | **77–111 ms** |
| Time to an interactive title screen | 200–350 ms (with HTTP cache) |
| JS bundle | 820 KB raw / **229 KB gzip** |
| CSS | 18.7 KB raw / 4 KB gzip |
| Total artifact | **8.6 MB** (of which 2.2 MB audio loads in the background, not on the first-screen path) |
| Spawn point to centreline | all 16 stations **0.000 m** |
| `nearestArcParam` round-trip error | **0.00000** |

Capability detection on this machine reports `Discrete GPU: AMD Radeon RX 5500
XT` → high tier, with the reason displayed verbatim on the title screen.

### The critical path was rewritten by a measurement

The first version pulled all 17 audio files (including `bgm.ogg` at **1667 KB**)
concurrently at t=0, competing for the same bandwidth as `bike.glb` (299 KB, but
that's the first thing the player looks at). The network timeline showed
`bike.glb` taking 3.4 s when it should have taken about 134 ms.

More fundamentally: **browsers won't make a sound before a user gesture**, so at
startup not one of those bytes was usable. After switching to a serial background
warm-up once the world is interactive, the first screen downloads zero audio
bytes.

### Four real bugs found by playing it on real hardware

1. **Road triangles wound the wrong way.** `n.y = abz*acx - abx*acz > 0` *is*
   already the up-facing case, and I flipped on that condition anyway, so the
   entire road was back-face culled. The symptom is extremely quiet: terrain,
   vehicle, minimap and stations are all fine, only "the road is gone" — which
   looks exactly like assets failing to load.
2. **Vegetation density was four times the source project's.** The source has
   `TreeScatter.SPACING = 25m` (roughly one tree every 25 metres); I was
   scattering two trees every 12 m of chunk, i.e. one every 6 m. Changed to
   spacing by arc length, then bucketed into chunks for culling.
3. **The last vegetation chunk's parameter ran past 1.0**, so the index went out
   of bounds and read `undefined`. `103 × 12 / 1228.82 = 1.006`. The top of the
   stack was in the vegetation module; the actual cause was the **number of
   chunks** — that class of "the error is over there but reported here" costs
   the most time.
4. **Demo mode got stuck on the first line of dialogue.** Dialogue advances on a
   keypress, and in the demo nobody presses anything. Added automatic dialogue
   advance; the demo also skips minigames (auto-exits after 3.5 s) and shops.

---

## Differences from the original

**Deliberate**

- Render resolution promoted to a first-class quality knob (only possible on the
  web)
- The spirits mask changed from a post-processing pass to a DOM overlay
- UI changed from hand-drawn `_draw()` calls to DOM + CSS: composited by the
  browser so it costs zero GPU time, and text is always crisp. **As a
  side-effect the original's "cancel button is not keyboard-reachable" bug
  disappears on its own**
- 21 new strings for the web edition (`tools/i18n-supplement.json`, additions
  only)
- Font subsetting and model compression (the original relied on Godot's import
  pipeline)

**Not done** (gaps the original listed itself; still gaps here)

- **The tea has no genuine failure state.** It's the one minigame that cannot be
  lost, and the original author wrote in the comments "whether to give it a real
  way to fail — leave that to the polish round". This edition respects that and
  doesn't decide it on the author's behalf.
- **Only the steles of the roadside easter eggs**: four `stele_*_line` triggers
  fire within 11 m. The original planned a whole set of roadside events.
- **No coherent art direction board.** Colour and layout are scattered as
  constants across modules.
- The bird minigame's outline is a little heavy in the observation phase (at
  `sc≈2.57` the outline gets multiplied twice). **Copied verbatim during the port
  and marked ⚠** — fixing it changes the look, and that isn't the porter's call.

**Added by this edition** (not in the original)

- **Per-station musical variation.** Filtering plus slight playback-rate detuning
  gives the five fragment stations five "delight" timbres (cloud bright, tea
  warm, qin restrained, bamboo crisp, bird brightest), with no new audio assets.
  Deliberately timbre-only, never melody: `playbackRate` offsets are capped at
  0.4%, past which it's audibly out of tune, and that would turn a piece that is
  supposed to be calm into something uneasy.
- **28 new strings** for the web edition (`tools/i18n-supplement.json`,
  additions only, with strictly matching key sets on both sides). Mostly panel
  text the original drew with `_draw()` and never put into the string table.

**Unverified**

- **How the crossings and the procedural buildings actually look.** The numbers
  are already guarded by regression (crossing coplanar deviation 0.3 cm, 0/97
  sample points off-road within 48 m of either crossing, all 7 procedural
  landmarks half-width ≤ 8 m), but regression cannot answer "does it look
  right" — that needs a look on your machine.
- The actual size and glyphs of the postcard PNG. The export path waits on
  `document.fonts.load` for the handwritten font; it's logically correct, but it
  needs one real browser clicking export to confirm.
- Touch controls. The code is there (four-signal detection + tri-state switch in
  the pause menu) but it has never been tried on a real device.

---

## Debug system

Three layers with non-overlapping jobs. **All of them output text** — because
their main consumer is a person who needs to read a description while working,
and an AI assistant; people can look at images, they can't read them.

| Layer | Entry point | What it answers | Used by |
|---|---|---|---|
| **Scene probe** | `?debug` (F10) / console `gift188.probe()` | where am I, what state is the camera in, what is this place | human + AI |
| **Station health check** | `?buildings` / press `B` after F10 / `gift188.buildings()` | are all 16 buildings fine | human + AI + regression |
| **Scene self-check** | `?dump=1` (F9) | which three render objects exist in the scene | human (the render layer) |

The last two have different failure modes, so both exist: `dump` catches "extra
things that shouldn't be there", `probe` catches "things that should be there and
aren't".

### What the probe prints

```
=== 场景探针 ===
位置 世界=(-164.1, -137.5)  地形高=1.06  路面高=1.52
      弧长 31.2%（383/1228m）  最近 起程驿楼 #0 18m  离中心线=18.0m  在路面上=否
      距 8 字交叉口 205.3m（压平半径 16m，标线让开 9.03m）
      最近水面 水1 34m  水位高=-3.40
      天色 dusk=0.00  太阳=(0.40, 0.70, 0.30)
玩家 速度=15.0m/s 朝向=-12.4° 骑过驿=7/16 碎片=0/5 当前目标=收齐五件乐事
镜头
    相机 pos=(...)  朝向 yaw=...° pitch=...° 视向=(...)
    视场 竖62.0° / 横93.8°（画幅 1280×720 = 1.78，绘制 1280×720，倍率 1.00）
    裁剪 near=0.25 far=900
    渲染 draw=58 三角面=627768 程序=9 贴图=4
附近（40m 内）
  驿站/建筑
    驿站 #00 起程驿楼 距 18.0m  无碎片  模型=arch/inn 程序化 inn  半径=7.7m  锚点高=7m
  植被 本帧可见：块=29 树=14 灌木=30 草=164 draw=56
```

**Every position gets two sets of coordinates**, on purpose: world coordinates
`(x, z)` are good for algorithms (`getHeightAt` wants exactly that) and bad for
people — `(0, 43)` is the self-intersection and nobody can say where `(-164,
-137)` is. So every position also reports **percentage along the arc + metres +
the nearest station**.

**On "aperture"**: the game camera has no physical aperture. three's
`PerspectiveCamera` is a pinhole model — no focal length, no iris blades, no
depth of field. The only things that correspond are **field of view, near/far
clip planes and aspect ratio**, the three quantities that decide "what the camera
can see", so the probe reports those three instead of inventing an `f/2.8`.
Vertical *and* horizontal FOV are both reported: what the player experiences is
the latter, and it is entirely determined by the aspect ratio — a 9:19.5 portrait
screen and a 16:9 landscape screen sharing a vertical FOV differ by 3× in
horizontal view.

### The station health check

`?buildings` prints the full table for all 16 stations (name / fragment / model
source / world position / distance from centreline / size / ground clearance /
distance from asphalt / loaded), ending in a verdict.

**This panel runs the same function as the headless regression suite**
(`auditBuildings`), so what the panel calls "fine / not fine" and what
`npm run verify` reports can never disagree. Each criterion maps to one concrete
way "this looks wrong" gets read:

| Criterion | Which reading it corresponds to |
|---|---|
| Not loaded (and within the load radius) | there's a gap there; the roadside is missing a building |
| **Recorded position differs from actual position by > 0.5 m** | the check-in point and the model aren't in the same place — the player checks in on empty ground while every position readout looks fine |
| Building edge closer to the asphalt than 0 m | the building is sitting on the road shoulder |
| Foundation corner height difference > 3 m | floating at one end, buried at the other (invisible from a riding camera, obvious from the side) |
| Ground clearance > +1.5 m / < −1.5 m | floating / buried |
| Height < 2 m or > 40 m | the model didn't come out / the scale is wrong |

**Why "half-width ≤ `STATION_FOOT_HALF`" is not a criterion**: half-width is
measured from the world AABB, and a rectangle rotated about Y necessarily grows
its AABB (a 15.4 m waystation rotated 30° has an AABB of 17.2 m) — orientation is
mixed into that number. What actually needs guarding is **how far the building's
edge still is from the asphalt**.

### Proving the criteria can go red

```
node tools/verify-buildings-red.mjs
```

It deliberately introduces seven real failures (raise everything, change only
the recorded position, push the asphalt out, bury it underground, put a plinth
underneath, stand next to an unloaded model, plus a baseline) and confirms one by
one that the health check catches them. **7/7 as expected.**

A piece of methodology carried over from the source project:
> Every new assertion must first be proven able to go red — break it on purpose,
> watch it go red, then revert.

The first run gave **5/7**: two criteria couldn't catch their failure, and those
two exposed a real problem — `worldPos` and the object's actual position are two
sources of truth, and only the latter was being checked. Only after fixing that
was the "recorded position vs actual position" invariant added.

### Troubleshooting entry points at a glance

| Entry point | What it does |
|---|---|
| `?debug` | opens the scene probe panel, toggled with F10; `P` probe / `B` station table |
| `?probe` | shows the probe immediately and logs the result to the console |
| `?buildings` | shows the 16-station health table immediately |
| `?x=12&z=-34` | probe a specific coordinate (so a link with coordinates in it puts the next person in exactly the same scene) |
| `?dump=1` | three render object self-check, toggled with F9 |
| `?arc= &yaw=` | park the vehicle at a point on the centreline with a given heading |
| `?caps` | run capability detection only, don't build the world |
| `?tier=0\|1\|2` | force a quality tier |
| `?touch=1\|0` | force touch controls on/off |
| **F8** | performance panel (fps/draws/triangles/render resolution/speed/on-road/phase/quality tier) |
| **F9 / F10 / P / B** | scene self-check / probe / toggle probe / toggle station table |
| Console | `gift188.probe()`, `gift188.probe(x, z)`, `gift188.buildings()`, `gift188` |

---

## Look-and-feel corrections (round two)

Driven by playtesting feedback on real hardware. All four changed **criteria**,
not vibes.

### 1. The "strange pillar" on top of the waystation

The procedural waystation has a ridge bar (15.4 m × 0.3 m × 0.5 m, placed at
`roofY + 2.46`). It is geometrically wrong: the ridge of an upturned roof is a
**line**, while a bar is a straight prism that holds the ridge height across the
full width. The roof falls away from the ridge toward both sides by `(1−t)^1.7`,
so the bar overhangs about 2.5 m at each end — on screen, a black bar floating
above the roof. **Deleted.**
For a hip roof the ridge is a single point anyway; adding a ridge line only makes
it look more like a box.

### 2. The shrine had no roof

Of the seven landmark types, `shrine` is the only one that doesn't call
`upturnedRoof`. The "tallest vertices" in the health report were actually the
capitals of four stone lantern posts (4.50–4.70, spanning **0.2 m**), which read
on screen as "this station has no roof". **A shrine niche with a proper upturned
roof has been added behind the altar** (placed at the rear rather than dead
centre: the centre is the altar, and a 2.4 m-wide niche there would block it).

The corridor's roof was fixed at the same time: it used to rise only 1.5 m and
cover 3.1 m columns, making the whole thing 4.96 m tall — from the side, "a flat
slab glued to a beam". Raised to 2.4 m, with the plinth narrowed from 15.0 to
13.0, buying 1.4 m of eave at each end.

**New criteria** (`verify_stations`, +2):
- Every type must have a **real roof**: `roofVerts ≥ 12` **and** a roof band
  with thickness ≥ 0.8 m. The thickness part is the key — it's what separates a
  real roof from a row of post capitals, which is only 0.2 m.
- Each station's world bounding box **Y span must equal** the Y span of that
  type's native geometry. Stations rotate about Y to face the road, and a rigid
  rotation about Y **does not change Y span**, so any mismatch means the model was
  additionally translated or scaled, or something went wrong on attach. This one
  exists specifically to catch "the roof is in the wrong place".

New `node tools/arch-roofs.mjs`: prints eave/ridge heights, roof dimensions and
roof band thickness per type.

### 3. Grass cards removed

The grass layer (crossed cards + alphaTest + wind sway + cull radius, about 200
lines) was **deleted outright**.

**The reason is that it doesn't read as grass.** Up close it's a few upright
green rectangles; at distance, because the blades are only 12 cm wide and mix
into a slightly greener square inside one pixel — and at neither distance does
that look like grass. But "looks like grass" is the *entire* value of the grass
signal, so if it can't be read, it should go. Keeping it also costs more than
looks: full-screen translucent cards are a fill-rate killer.

The grassy quality moved into the **terrain shader**: patches of turf +
directional short streaks stretched along a fixed angle + backlit grass tips.
The same amount of information with **0 extra triangles, 0 alpha tests, 0 draw
calls** — and it doesn't turn into paper up close, which is what the zero-texture
route actually calls for.

The quality tiers' `grassEnabled / grassRadius / grassDensity` knobs were
removed together and replaced with `groundDetail: 0|1|2` + `groundDetailRadius`
(low 0, medium 34 m, high 58 m).

### 4. Believability

**The difference between "looks like a photo" and "looks like a game" is mostly in
four places**, all changed in existing code, with no added geometry and no added
draw calls:

| What changed | Before | Now | Why |
|---|---|---|---|
| Grass desaturation | — | pulled 28% toward brightness, then multiplied by (1.04, 1.00, 0.93) to warm it | grass in a real photograph is far less saturated than intuition suggests; that "vivid green" on screen is what you get when rendering pulls the hue to 120° and saturates it fully, and it reads as fake at a glance |
| Accent desaturation | `(0.24,0.39,0.16)` / `(0.47,0.545,0.245)` | `(0.20,0.28,0.135)` / `(0.44,0.47,0.255)` | as above. `BASE_COLOR` is source project data and not one number was changed |
| Large-scale colour block contrast | 0.75 | 0.45 | 0.75 read as patches of dark water stains on the ground |
| Procedural cloud band | none | project the view ray onto the y=1 plane for uv + two layers of fbm + separate colours for cloud base and top | a sky without clouds is a **gradient**, and a gradient reads as "rendering". A real photograph almost always has clouds, even if it's just a cumulus edge on the horizon |
| Atmospheric perspective | linear fog only | an extra **squared-distance** fog layer tinted towards the sky | real air scattering isn't linear in distance, and **distant hills don't only get blurrier, they get bluer**. A single linear fog can't do that, which is why distant hills are always "the same crisp green" |

`patchStandard` gained a `fogHint` hook, inserted **before**
`#include <fog_fragment>` — inserted after it, the fog overwrites it, and not
overwriting raises no error, so that code just silently appears to do nothing.

**One comment that didn't match its code**, noted while passing: the first
version of the atmospheric perspective coefficient was written as `2.2e-6` while
the comment said "0.22 at 100 m" — the actual value was only 0.022, **ten times
weaker than intended**, with no visible effect in the foreground. It's now `8e-6`
(100 m / 7.7%, 200 m / 27%, 400 m / 72%), and comment and code agree.

---

## Repository

Source at `https://github.com/Jasper-Leung/188js`, branch `main`.

```bash
npm install
npm run dev        # dev server
npm run typecheck  # strict + noUnusedLocals + noUnusedParameters
npm run build      # output into dist/
npm run verify     # headless regression: 32 suites / 468 assertions + dead-string scan
```

**One non-obvious trap**: on this machine the first `git push` failed with
`Recv failure: Connection was reset`, while `Invoke-WebRequest` against the same
URL returned 200. The cause is git's bundled HTTP/2 negotiation being reset by
something in between. This repository has therefore set

```
git config http.version HTTP/1.1
```

If you clone elsewhere and push hits the same error, try that first.

**Two decisions in the ignore rules**:
- `dist/` and `node_modules/` are ignored (both rebuildable).
- **`public/` is not ignored** — those 8.8 MB are the game itself
  (models/fonts/audio), already compressed once in the source project
  (22.3 MB → 5 MB). Ignore it and the repository is left with only code; clone it
  and the build produces an empty field.
- `*.import` is ignored: those are Godot's import stubs, useless to a web build,
  and leaving them makes the question "does this project depend on Godot?" vaguer.

---

## Development plan

See **[PLAN.md](PLAN.md)**. In one sentence: **the story isn't missing, it was
never delivered** — `prologue_1/2/3` spell out every premise (the lawyer's letter,
the thirty-day deadline, the mother, the cost the waystation keeper pays), and
all three are translated into both languages, but nothing in the code ever plays
them. The entire amount of narrative a player receives on this run is 3 phone
calls and 4 lines of roadside text.

---

## Fixed in this round (first release round)

Real bugs, not intentional design changes:

1. **8 of the 16 stations were greyboxes.** Of the source project's 13 station
   models only 5 are real buildings; the other 7 (waystation / tea house /
   ridge terrace / shrine / pavilion / corridor / lantern) were the author's
   cuboids, plus the banyan-tree stand-in built from `tree.glb` — 9 stations that
   are a few boxes on screen, recurring all the way around a 1228 m loop.
   → New `src/world/architecture.ts`: genuinely procedural buildings for those
   seven types (concave curved roof + upturned corners + columns + plinth +
   balustrade), zero textures, 5512 triangles and 7 draw calls for all seven,
   0 bytes downloaded.
   The geometry is now generated **in metres** and no longer multiplied by
   `cfg.scale` — the greyboxes were "small model × large scale", and with both
   scalings live at once they ballooned to twice the width, punching straight
   through the "≥ road width + 0.9×foot_half from the centreline" invariant.

2. **Vegetation culling never took effect.** `setVisible(group, c.index * 3, …)`
   used the chunk number as an index into `children`, but `groupTrees.children`
   only holds **chunks that have trees** (12 m chunks, 25 m spacing, so nearly
   half of them have none), so out-of-range indices were swallowed by `if (child)`
   and the near chunks that should have been hidden never were. The symptom is
   extremely quiet: the frame rate drops by a few points, nothing errors, and no
   criterion goes red.
   → Replaced with an explicit "chunk number → mesh" map. **Triangles 1.43 M →
   620 k, draw calls 58 → 11.**

3. **The spirits mask coefficient was computed and thrown away.** `treeR =
   preset.treeRadius * visibilityFactor` was calculated and then `void`ed, with
   the decision still using `preset.*Radius` — so "low spirits → see less far"
   had never taken effect anywhere in the game, and the lanterns, the sachet and
   the mask were all writing accounts against a number nobody read. `verify_mood`
   guards the formula itself, so it can't catch this.
   → It actually goes into the radius now.

4. **The grass geometry was missing its `normal` attribute.** three's
   `beginnormal_vertex` reads `vec3 objectNormal = vec3(normal);`, and when the
   attribute doesn't exist WebGL supplies the default (0,0,0), so `vNormal =
   normalize(vec3(0))` is NaN, and the shadow path's
   `inverseTransformDirection(transformedNormal, viewMatrix)` is NaN too —
   **every pixel that passed alphaTest was computed as black**. That's half of
   "black squares on the grass" (the other half is the greybox stations).
   → Added the `normal` attribute and recomputed normals in the vertex shader as
   "cards face the camera" (bottom lying flat toward the camera, tips curving up).

5. **Grass repacking duplicated the current chunk when d = 0.** The two indices
   `[cur + d, cur - d]` are both `cur` when d = 0, and the criterion's `d > 0`
   doesn't hold — so the grass in the player's own chunk doubled for free, two
   clumps of grass growing in the same spot, one on top of the other, and
   completely invisible on screen.

6. **The figure-eight crossing had a disc laid over it.** The source project put
   a 12 m radius disc at the self-intersection (it wasn't convenient to mark a
   crossing from Godot's side), and it covered both the height difference between
   the two ribbons (a measured 0.16 m of Z-fighting) and the lane markings running
   straight through the junction — but it *covers* rather than *does*. Inside the
   disc the road becomes a 24 m circle, and riding round it you don't notice you
   came back to where you started.
   → Replaced by two real things: **flattening** (using the crossing point's own
   height as the datum, pulling both ribbons onto one plane) and **world-distance
   suppression of the markings** (the shader fades out the centre/edge/shoulder
   lines). Note the datum height must come from the crossing point **itself**,
   not from the whole radius — taking the maximum over 12 m means the sample
   11 m out is already climbing the slope, and the lower branch gets lifted by
   0.58 m, so the middle of the junction bulges for no reason.

7. **Opening the game in a background tab leaves it stuck at 62% of loading.**
   `nextFrame()` relies purely on `requestAnimationFrame`, and browsers
   **completely suspend** rAF in background tabs. A player who clicks the link in
   another tab and switches back sees the progress bar frozen at 62% and nothing
   else happening. → Race rAF against a 20 ms timer.

8. The never-referenced `GRASS_PATCH` in `src/shaders/world.ts` was deleted — it
   referenced an undeclared `vUvG`, so the moment anyone used it would be a
   compile error, and the copy actually in use has been inlined in
   `vegetation.ts` for a long time, so the two had drifted apart.

**New debugging entry points** (not present in the shipped release)

| Entry point | What it does |
|---|---|
| `?dump=1` + **F9** | scene self-check: lists the name, instance count, bounding box, texture presence, alphaTest and triangle count of every renderable near the player. It answers "what exactly is that box on the left of the screen" — a question code can't answer |
| `?arc=0.462` | place the vehicle at centreline parameter 0.462 |
| `?yaw=90` | then set the heading (degrees) |
| `?caps` | run capability detection only, don't build the world |
| `?tier=0\|1\|2` | force a quality tier |
| `?touch=1\|0` | force touch controls on/off |
| **F8** | performance panel (fps/draws/triangles/render resolution/speed/on-road/phase/quality tier) |

`?arc` + `?yaw` were added together: you cannot look at the same view twice, and
"to see the figure-eight crossing clearly you have to ride to it", so missing it
means riding the whole loop again. With `tools/crossings.mjs` (computes all
self-intersections and angles along the loop) and `tools/glb-inspect.mjs` (lists
every GLB part's vertex count and bounding box), this whole class of "there's
something on screen and I don't know what it is" finally has a definite answer.

---

## Criteria that were changed

- Figure-eight crossing count: changed to counting once more with the tail
  joined to the head (see above)
- `hash2d` restored the `fmod` the source project dropped (that's a bug fix, not
  something the port introduced)
- The minigames' `CANCELLED` split into `lose` (failed the round) and `cancel`
  (the player pressed Esc): the original routes both to the same exit, yet they
  decide station rewards completely differently
- **New**: 5 hard geometric constraints on procedural landmarks (half-width ≤
  `STATION_FOOT_HALF`, not buried in the ground, height not exceeding the station
  name label, ≤ 60 k triangles for all seven, every type actually used). How each
  of them goes red is written in the comments in `src/verify/entry.ts`.
- **New**: 3 crossing constraints (core-region coplanar deviation ≤ 5 cm, plane
  clearance ≤ 0.4 m, on-road and height-stable at every step within 48 m of the
  junction).

---

## Legal / naming

This game uses no real historical waystation names. The route is a
self-constructed mathematical figure-eight and reproduces no real road. Common
cultural motifs are free to use and form the basis of this game's subject
matter, including Su Shi's *Sixteen Things That Delight the Heart* (1037–1101)
and the idea of "scenic cycling" itself.

Suggested wording: fictional narrative demo / fictional route geometry /
public-domain poetry.
Suggested to avoid: inspired by a specific real road / official collaboration /
official endorsement / faithful recreation of a real scenic route.