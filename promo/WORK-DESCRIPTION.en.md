# Gift No.188 — Work Description

**Developer:** Liang Zhuowen (梁卓文)
**Genre:** 3D cycling narrative / exploration
**Platform:** Web (WebGL 2), also shipped as a Godot 4.6 original
**Playtime:** 20–30 minutes
**Language:** Chinese (Simplified) / English, full bilingual

---

## Logline

A man rides up the mountain to walk the road his mother disappeared on, one more time.

## Short description

*Gift No.188* is a quiet cycling narrative game. You ride a single figure-eight loop of 1,228.8 metres through mist-layered mountains, stop at sixteen roadside stations, and re-enact five small joys — watching cloudshadow, pouring tea, playing a remembered zither phrase, cutting bamboo in the rain, listening for a bird. The game has no combat and no fail state. When the ride ends, the five things you collected are pressed into a postcard you can write on and export.

## Longer description

The lawyer's letter arrived first. The Eighteenth Post inn — your mother's — has stood empty for six years. Open it within thirty days, or the land is taken by law.

So you ride.

The route is not a straight line out and back. It is a figure-eight that crosses over itself at the centre, and you only discover that if you keep riding long enough to come back around to the place you started. Sixteen stations sit along it. Five of them hold a fragment of something your mother used to do. Each one wants three visits to give it up, so a complete run is fifteen stops across five stations, not five.

Alongside you, Zheng Duo of Yunling Cultural Tourism wants the thing under the hot spring, and he will tell you so three times — politely, then insistently, then without pretending. His offer is reasonable. His reason is not.

And the mountain keeps its own account. The keeper of the road remembers the road, not himself. You will remember the way home for everyone you pass. The price is that no one remembers you.

The game never states this directly. You get it from four worn stone markers, three unanswered phone calls, and the fact that every station knows your name but no one knows theirs.

### The five joys

| | Station | What you do |
|:---|:---|:---|
| Cloud | Cloudshadow Terrace | Trace the moving shadow of a cloud across stone steps |
| Tea | Tea Smoke Cottage | Hold to pour; let go and it drains back to zero |
| Music | Zither Grove | Watch a guqin phrase played once, then play it back from memory |
| Bamboo | Bamboo Rain Courtyard | Cut bamboo the instant it surfaces |
| Bird | Birdsong Cove Flower House | Remember one bird; later, name which one it was |

### What you leave with

A postcard. Five fragments land on the front; every extra visit adds a piece. Write a line on the back — or leave it blank. Two endings, and the one you don't choose is gone.

---

## Design notes

**The road is the argument.** The figure-eight is not decoration. Start and finish are the same station, and the player rides through their own origin without a cutscene telling them. Space says it first; text summarises later.

**No cutscenes.** Everything the story needs is delivered in the existing dialogue strip while the bicycle is already moving. Stopping the player is the one thing this game refuses to do — people who stop, do not remember the road.

**No fail state.** You cannot lose the ride. Composure only falls and never locks, and the tea shop sells a way back up. The only pressure is the thirty days in a letter you read once.

**Procedural architecture, zero textures.** Every building on the route is generated in code — upturned roofs, columns, plinths, railings — with no downloaded texture bytes at all. Surface detail on road, terrain, grass and water is computed in shaders. The whole build is roughly 12.8 MB.

**Built for weak hardware.** Three quality tiers cut internal render resolution (0.60× / 0.85× / 1.0×), shadows, and vegetation range. The low tier's headline move is deleting grass entirely and spending that budget on resolution instead, because grass is fill-rate bound and a softer resolution is more visible than thinner grass. No post-processing: the composure vignette is a DOM overlay, so it costs zero GPU time. Capability detection picks a starting tier, reads your GPU string, and shows you its reasoning — then never changes tier again on its own.

**Verification as a discipline.** The port carries a headless regression suite with hard invariants: 961 centreline points, 1,228.8 m, four centreline crossings, sixteen stations all reachable, economy totals, water level below terrain, fifteen mini-game sessions each appearing three times, bilingual string parity. It has caught real bugs — a missing `fmod` that flattened the terrain into a plateau while every count-based assertion stayed green, and an interleaved-buffer read that placed every roadside tree 940 kilometres above the earth so none of them ever drew.

---

## Credits

- **Design, engineering, art direction:** Liang Zhuowen (梁卓文)
- **Protagonist:** Miles Lu (路俊航) — a fictional character
- **Antagonist:** Zheng Duo, Yunling Cultural Tourism
- **Engine:** three.js r169, TypeScript, Vite (web); Godot 4.6 (original)
- **Third-party:** three.js. No other runtime dependencies.

*Miles Lu, the Eighteenth Post, Route No.188 and Zheng Duo are fictional. Any resemblance to real persons or places is coincidental.*
