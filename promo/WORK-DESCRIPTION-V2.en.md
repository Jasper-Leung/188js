# Gift No.188 — Work Description (English)

**Developer:** Liang Zhuowen (梁卓文)
**Protagonist:** Miles Lu (路俊航) — a fictional character
**Genre:** 3D cycling narrative / exploration
**Platform:** Web (WebGL 2); original build Godot 4.6
**Playtime:** 20–30 minutes
**Language:** English / Simplified Chinese

---

## Logline

A man who has already quit his job rides up the mountain to keep his family's road — and finds out someone kept it eight hundred years before him.

## The short version

*Gift No.188* is a quiet cycling narrative game. You ride a single figure-eight loop of 1,228.8 metres through mist-layered mountains and stop at sixteen roadside stations.

The road is not empty. **Touch an old thing and it remembers.** An ink brush, a chipped cup, a folded letter, a length of frayed silk — put your hand on it and you get a fragment of whoever held it last. A few seconds. A room, a season, a face going out of focus.

You cannot change any of it. You only get to see.

Eight hundred years ago, a famous poet came up this road, gave up the life that was arranged for him, and stayed. He did not die here disappointed. He died here **happy** — and left his things behind, one in every station, like a trail of breadcrumbs for whoever came next.

Miles Lu has his own reasons to be here. He had already walked away from a job, and he was still deciding whether to take over the family business when the lawyer's letter arrived. Something under the hot spring that someone wants. Thirty days to open the inn, or the land goes to someone else.

So he stays. Not to inherit a story someone else already finished — to work out what an old man was doing up here for thirty years, and to keep the place off the auction block while he does it.

No combat. No fail state. At the end, the objects you touched are pressed into a postcard you can write on, or leave blank.

---

## The one mechanic

**The Echo.** Walk up to an old object and touch it. A fragment plays back — someone else's memory, from when they were the one who still had plans.

Three rules, and the third is the whole game:

1. You get a fragment, not a life. Six seconds, no context, no explanation.
2. You get the person, never the explanation. A cup knows who drank from it, not why the cup mattered.
3. **You cannot change the past.** Not one thing you see can be altered, warned about, or fixed. The Echo is a way of finding out, not a way of helping.

Which means the game is mostly about arriving late. You are always reading a record of someone who is already gone.

## Why the road is a figure-eight

Start and finish are the same station. You only discover the loop crosses over itself if you keep riding long enough to come back past where you started — and the story is built the same way, deliberately. The first pass is contemporary: the letter, the deadline, the family business. The second pass is eight centuries old. The road is one ribbon of asphalt, and the two timelines are laid on top of each other like two exposures of the same photograph.

Nothing marks the crossing but the road itself.

## The five small joys

| | Station | What you do |
|:---|:---|:---|
| Cloud | Cloudshadow Terrace | Trace a moving shadow across wet stone steps |
| Tea | Tea Smoke Cottage | Hold to pour; let go and it drains back to zero |
| Music | Zither Grove | A guqin phrase played once — play it back from memory |
| Bamboo | Bamboo Rain Courtyard | Cut bamboo the instant it breaks the surface |
| Bird | Birdsong Cove Flower House | Remember one bird; later, name which one it was |

Three visits each. The joy is not the reward — it is the reason the object ended up in that station.

---

## Design notes

**No cutscenes.** Every story beat arrives in the existing dialogue strip while the bicycle is already moving. Stopping the player is the one thing this game refuses to do: people who stop do not remember the road.

**No fail state.** Composure only falls and never locks, and the tea shop sells a way back up. The only pressure is thirty days in a letter you read once.

**Four ways to ride.** On foot, bicycle, motorcycle, skateboard. Three camera positions. Switching ride and camera never touches game state — you can swap mid-corner without interrupting anything.

**Procedural architecture, zero textures.** Every building on the route is generated in code — upturned roofs, columns, plinths, railings — with no downloaded texture bytes at all. Surface detail on road, terrain, grass and water is computed in shaders. The whole build is roughly 12.8 MB.

**Built for weak hardware.** Three quality tiers cut internal render resolution (0.60× / 0.85× / 1.0×), shadows, and vegetation range. The low tier deletes grass entirely and spends that budget on resolution instead, because grass is fill-rate bound and a slightly softer image is far more visible than slightly thinner grass. No post-processing: the composure vignette is a DOM overlay and costs zero GPU time. Capability detection reads your GPU string, shows you its reasoning, and then never changes tier again on its own.

**Verification as a discipline.** The port carries a headless regression suite with hard invariants: 961 centreline points, 1,228.8 m, four centreline crossings, sixteen stations all reachable, economy totals, water level below terrain, fifteen mini-game sessions each appearing three times, bilingual string parity. Every new assertion is proven to fail before it is trusted.

It has caught real bugs. A missing `fmod` flattened the terrain into a plateau while every count-based assertion stayed green — the mountains simply had no valleys and nothing failed. An interleaved-buffer read placed every roadside tree 949,141 metres above the earth, so none of them ever drew, while the placement tables and the culling statistics both insisted they were there. The lesson in both cases was the same: **a check that counts what you placed is not a check that anything appeared.**

---

## Credits

- **Design, engineering, art direction:** Liang Zhuowen (梁卓文)
- **Protagonist:** Miles Lu (路俊航) — fictional
- **Engine:** three.js r169, TypeScript, Vite (web); Godot 4.6 (original)
- **Third-party:** three.js. No other runtime dependencies.

*Miles Lu, the Eighteenth Post, Route No.188 and the eight-hundred-year poet are fictional. Any resemblance to real persons or places is coincidental.*
