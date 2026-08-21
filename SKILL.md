---
name: scroll-cinema
category: frontend
version: 0.2.0
description: "Build a scroll-driven cinematic web page — the effect where scrolling moves a camera through a photoreal world — and generate the footage for it end to end. There is NO 3D involved: the depth is parallax baked into pre-rendered camera movement, and scroll only assigns `video.currentTime` across a chain of clips whose endpoints are pinned to authored stills. Covers the whole flow: storyboard.json → keyframe stills → first/last-frame conditioned clips → dense-GOP conform → invariant + budget gates → a two-decoder runtime with bounded memory. USE WHEN scroll-driven video, scrollytelling, scroll controls the camera, cinematic landing page, scroll scrubbing, video scrub on scroll, immersive scroll site, Apple-style scroll animation, tea-leaf scroll effect, keyframe chain, first frame last frame video, tail_image_url, conform video for scrubbing, dense GOP, generate a scroll narrative. NOT FOR anything that must respond to input OTHER than scroll (hover, drag-orbit, configurators, live data in-scene) — the camera path is baked at build time and cannot answer those, use real 3D (React Three Fiber) instead. NOT FOR text/overlay reveals alone (use CSS `animation-timeline: scroll`, which is native and free). NOT FOR general video editing or transcription."
author: broomva
repo: github.com/broomva/scroll-cinema
tags:
  - content-engine
  - ui-generation
  - architecture-decision
---

# scroll-cinema

Scroll is a camera, not a scrollbar.

Installed as `@broomva/scroll-cinema`.

**What ships in the package:** the runtime, `scripts/conform.sh`,
`scripts/budget.mjs`, and the whole `pipeline/`. Those you can run straight from
`node_modules`.

**What does not:** `bun run dogfood`, `bun run demo:serve` and
`scripts/link-demo-assets.sh`. All three drive `demo/`, which is not published —
they are repo-only, so clone the repository if you want them.

## Decide first: bake or build?

One question settles the whole approach.

> **Does anything other than scroll position need to change the image?**

- **No** → bake the camera path. Pre-rendered video is photoreal for the price
  of a video file, and this package is the whole toolchain.
- **Yes** (hover, drag-orbit, configurator, live data) → you need real geometry.
  Stop here and use React Three Fiber. A baked path cannot answer input it was
  not rendered for.

Do not skip this. The technique looks like 3D and is not, and the difference is
invisible until someone asks for a hover state.

## The asset contract

**N clips require N+1 stills.** Clip `i` starts on still `i` and ends on still
`i+1`. That is not a convention, it is the mechanism:

- Pinning **both** endpoints turns open-ended generation (which drifts) into a
  bounded interpolation. A bad generation damages one segment, re-rolled alone.
- Each seam is a crossfade between frames that converge to identical, so no cut
  is perceivable.
- The stills do triple duty: narrative keyframes, `poster` layer, and the entire
  `prefers-reduced-motion` experience.

## Flow

```
storyboard.json
   │  pipeline/cinema.mjs build
   ├─► stills/     N+1 keyframes        (iterate HERE — cheap, and image
   │                                     fidelity caps video fidelity)
   ├─► raw/        N clips, endpoints pinned
   ├─► video/      dense-GOP, scrubbable   (scripts/conform.sh)
   └─► cinema.manifest.json

   │  pipeline/cinema.mjs verify
   └─► keyframe-chain RMSE + encode gate + budget gate

   │  createScrollCinema({ clips, posters, stage, track })
   └─► two decoders, bounded memory
```

### Generate

```bash
node pipeline/cinema.mjs build storyboard.json --out assets/ --provider mock
node pipeline/cinema.mjs verify assets/
node pipeline/cinema.mjs manifest assets/     # paste-ready arrays
```

Generation is resumable — existing outputs are skipped unless `--force`.

### Providers

| provider | stills | clips | end-frame pinning | verified |
|---|---|---|---|---|
| `mock` | ffmpeg | ffmpeg blend | yes | offline, runs in CI |
| `gemini` | Gemini image models | **Veo 3.1** | **no — gated** | **live, end to end** |
| `fal` | Nano Banana Pro | Kling `tail_image_url` | yes | dry-run only, no key here |

Always `--dry-run` a new provider first; it prints the exact request bodies
without spending. Metered providers also require `--yes` after showing a cost
estimate, so an accidental invocation cannot quietly bill a long storyboard.

### Two chain modes

**Pinned** (default when the provider supports it): every still is authored and
both ends of each clip are pinned. Full art direction over the keyframes.

**Forward** (`--forward`, and automatic when `supportsLastFrame === false`):
only the first still is authored; each later still is the **previous clip's
actual final frame**. The chain invariant still holds *exactly* — still `i+1`
is not merely similar to clip `i`'s ending, it IS that ending — so the seams
stay invisible. What you give up is art-directing the intermediate keyframes,
and drift accumulates along the chain rather than being reset at every stop.

This is not hypothetical: Veo 3.1 documents a `lastFrame` parameter but the
capability is gated off. All three tiers return 400 *"Your use case is currently
not supported"* when it is present, while the identical request without it
succeeds (verified across lite/fast/standard, 2026-08-18). Forward chaining is
what makes Veo usable for this technique anyway.

**Storyboard shape** — see `pipeline/storyboard.example.json`. `motions` has one
entry per **gap** (`scenes.length - 1`), not per scene; the builder rejects a
mismatch rather than silently pairing the wrong motion with the wrong transition.

Prompt craft that actually moves the needle:

| | Form |
|---|---|
| **Still** | `SHOT + LENS + LIGHT + TEXTURE + COMPOSITION + STYLE` — a technical brief, layered not short. Naming real bodies and lenses is the cheapest realism lever. |
| **Motion** | `WHAT moves + HOW it moves + HOW the camera behaves`, ~20–40 words. Do **not** re-describe the still — the model already has it. One shot = one camera move. |

Motion needs an endpoint or the model wanders; here `tail_image_url` supplies it
structurally, which is the same reason the chain exists.

### Bring your own footage

```bash
scripts/conform.sh --out dist/ raw/*.mp4       # encode, then verify the result
scripts/conform.sh --verify-only dist/*.mp4    # audit assets you did not encode
scripts/conform.sh --ladder raw/one.mp4        # measure GOP cost on YOUR footage
```

Ordinary web video **cannot be scrubbed** — seeking decodes forward from the
nearest keyframe and encoders default to GOP 48–250. `conform.sh` re-encodes to
GOP 8 and then asserts the output actually has the properties requested.

On high-motion footage dense GOP cost only **1.13×** the bytes of GOP 48, because
inter-prediction was saving little anyway. On a static scene the penalty is far
larger. Run `--ladder` rather than inheriting that number.

### Run

```ts
import { createScrollCinema } from "@broomva/scroll-cinema";

const cinema = createScrollCinema({
  clips, posters,                              // posters.length === clips.length + 1
  stage: document.querySelector("#stage"),     // position: fixed
  track: document.querySelector("#track"),     // tall; sets the gearing
  onScene: (i) => setCopy(i),
});
```

Gear the track at roughly **110vh of scroll per clip** over a `position: fixed`
stage. Shorter feels frantic; much longer feels like work. Options and defaults
are in the README.

## Using it with GSAP, Lenis, or another scroll library

**It has no runtime dependencies and does not replace any of them.** They operate
at a different layer: GSAP and ScrollTrigger animate arbitrary properties on a
timeline, Lenis smooths the page's scroll position. This package turns a scroll
position into a decoded video frame, and owns the parts those libraries have no
opinion about — dense-GOP encoding, decoder count, resident memory, and reveal
timing against compositor frames.

You can absolutely drive `video.currentTime` from a ScrollTrigger tween. That
mapping is about fifteen lines either way; it was never the hard part.

### With a smooth-scroll library (Lenis, Locomotive)

It works without configuration. The runtime reads
`track.getBoundingClientRect()` every animation frame rather than listening for
scroll events, so a transform-based virtual scroller moves the rect and the
mapping follows without knowing the library exists.

**Do not set `tau: 0` to "avoid double smoothing".** That is the obvious move
and it is wrong. Measured against Lenis 1.3, five clips, ~810 sampled frames:

| configuration | first-reveal violations |
|---|---|
| Lenis + `tau: 0` | **85 / 812 — fails** |
| Lenis + `tau: 0.03` | 0 |
| Lenis + `tau: 0.096` (default) | 0 |

`tau` is not only a feel knob. It is what lets the requested time *converge*, so
the decoder can land on a frame and the reveal gate can confirm it. With `tau: 0`
the target moves every frame, confirmation never happens, and the liveness
deadline eventually reveals a stale frame instead.

So: keep the default, or lower it to taste. `0.03` still passes and feels
tighter under Lenis, which is already doing its own smoothing. Zero does not.

### With GSAP / ScrollTrigger

Let ScrollTrigger own the trigger and pinning if you already use it, and give
this the resulting progress — `track` is optional, and the runtime falls back to
document scroll when it is absent. Do not tween `currentTime` yourself in
parallel: two writers fighting over the same property produces exactly the
decoder thrash the `src`-bind counter in `bun run dogfood` exists to catch.

Reproduce the numbers above with `node scripts/dogfood.mjs --lenis --tau 0`
(Lenis is a devDependency for this test only and is never shipped).

## Gates — and what each one uniquely catches

Run all of them; they do not overlap.

| Gate | Command | Catches what nothing else does |
|---|---|---|
| Unit | `bun run check` | the scroll→frame arithmetic |
| Chain | `cinema.mjs verify` | **a provider that ignored the end-frame parameter.** The clip is still valid, scrubbable video and passes every other gate |
| Encode | `conform.sh --verify-only` | a flag that was silently dropped, so the file is unscrubbable |
| Budget | `budget.mjs` | first-interaction weight and resident memory |
| Runtime | `bun run dogfood` *(repo only)* | decoder thrash, URL leaks, and whether seeks actually land |

The dogfood harness exists because the first version of this package **passed 33
unit tests and a green browser run while rebinding a decoder to the wrong clip
on every frame.** The harness had asserted `held.length <= 2`, which two slots
satisfy unconditionally. The assertion that works is a cumulative counter: 5
`src` binds when correct, 247 when the bug is reintroduced.

Carry that lesson into anything you add here: **before reporting a number as
evidence, say what a broken system would print. If it is the same number, the
metric proves nothing.**

## Limits

The four findings that previously blocked production use are **closed**:
the residency bound now holds across a backgrounded-tab snap, the presentation
check is measured against compositor frames rather than our own flag, retry
accounting resets on success and backs off, and `maxResident` warns instead of
silently overriding you. Each was closed red-to-green against a harness case
that reproduced it first.

What remains is inherent to the technique, not defects:

- **The camera path is frozen at build time.** Changing a move means
  regenerating that segment — keep the stills as the durable artifact.
- **Bandwidth is the real constraint.** This suits a hero or a landing
  narrative, not a page someone visits daily.
- **Scrubbing lets a viewer park on any frame**, so generation artifacts that
  are invisible at 24fps become visible. Review the contact sheet, not the
  playback.
- **Mobile decoder limits are untested.** The two-decoder design exists partly
  to stay inside them, but no iOS device has been measured.

## Anti-rationalization

| Excuse | Reality |
|---|---|
| "I'll just use Three.js, it's more flexible." | If scroll is the only input, you are paying a large runtime and a modelling budget for flexibility you will never use — and losing photorealism. Ask the decide-first question honestly. |
| "The clips look fine, skip `verify`." | Looking fine is exactly what a broken chain does. A clip that ignored the end frame is valid video; only the RMSE check sees the seam will jump. |
| "I'll conform later." | Un-conformed video is not scrubbable at all. There is no "later" in which the effect works. |
| "I'll test with the real API, the mock isn't realistic." | The mock is not there for realism, it is there so the wiring is exercised before you spend money on a long storyboard. Run it first, every time. |
| "The dogfood passed, so it works." | It passed once on a build with a blocker in it. Check that each assertion *could* fail before trusting that it didn't. |
| "N+1 posters is fiddly, I'll reuse one." | Then every seam is a visible cut and reduced-motion users get one image for the whole story. |
