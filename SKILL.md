---
name: scroll-cinema
category: frontend
version: 0.2.0
description: "Build a scroll-driven cinematic web page — the effect where scrolling moves a camera through a photoreal world — and generate the footage for it end to end. There is NO 3D involved: the depth is parallax baked into pre-rendered camera movement, and scroll only assigns `video.currentTime` across a chain of clips whose endpoints are pinned to authored stills. Covers the whole flow: storyboard.json → keyframe stills → first/last-frame conditioned clips → dense-GOP conform → invariant + budget gates → a two-decoder runtime with bounded memory. USE WHEN scroll-driven video, scrollytelling, scroll controls the camera, cinematic landing page, scroll scrubbing, video scrub on scroll, immersive scroll site, Apple-style scroll animation, tea-leaf scroll effect, keyframe chain, first frame last frame video, tail_image_url, conform video for scrubbing, dense GOP, generate a scroll narrative. NOT FOR anything that must respond to input OTHER than scroll (hover, drag-orbit, configurators, live data in-scene) — the camera path is baked at build time and cannot answer those, use real 3D (React Three Fiber) instead. NOT FOR text/overlay reveals alone (use CSS `animation-timeline: scroll()`, which is native and free). NOT FOR general video editing or transcription."
author: broomva
repo: github.com/broomva/scroll-cinema
tags:
  - content-engine
  - ui-generation
  - architecture-decision
---

# scroll-cinema

Scroll is a camera, not a scrollbar.

**Status: reference implementation, not production-ready.** Four cross-model
review rounds took it 2/10 → 6/10 and the final verdict was still SHIP: NO. Four
findings remain open (one blocker) — see [Limits](#limits) before adopting.

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

`--provider mock` synthesizes real mp4s with ffmpeg — no API key, no network.
Use it to exercise the wiring before spending money. `--provider fal` uses Nano
Banana Pro for stills and Kling `tail_image_url` for the pinned clips; pair it
with `--dry-run` first to inspect the exact request bodies. Generation is
resumable: existing outputs are skipped unless `--force`.

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

## Gates — and what each one uniquely catches

Run all of them; they do not overlap.

| Gate | Command | Catches what nothing else does |
|---|---|---|
| Unit | `bun run check` | the scroll→frame arithmetic |
| Chain | `cinema.mjs verify` | **a provider that ignored the end-frame parameter.** The clip is still valid, scrubbable video and passes every other gate |
| Encode | `conform.sh --verify-only` | a flag that was silently dropped, so the file is unscrubbable |
| Budget | `budget.mjs` | first-interaction weight and resident memory |
| Runtime | `bun run dogfood` | decoder thrash, URL leaks, and whether seeks actually land |

The dogfood harness exists because the first version of this package **passed 33
unit tests and a green browser run while rebinding a decoder to the wrong clip
on every frame.** The harness had asserted `held.length <= 2`, which two slots
satisfy unconditionally. The assertion that works is a cumulative counter: 5
`src` binds when correct, 247 when the bug is reintroduced.

Carry that lesson into anything you add here: **before reporting a number as
evidence, say what a broken system would print. If it is the same number, the
metric proves nothing.**

## Limits

Open findings (BRO-2173) — do not treat as production-ready:

1. **Residency can transiently overshoot.** After a backgrounded-tab snap,
   progress jumps several segments; the old pair is still *held* and not
   evictable while the new pair downloads, so `resident ∪ inFlight` can reach 4
   against a bound of 3. The harness's smooth sweep never takes that path.
2. **The `visible-unpresented` assertion is tautological** — `presented` gates
   opacity, so it cannot fail. Needs an independent signal
   (`requestVideoFrameCallback`).
3. **Retry accounting never resets on success** and has no backoff.
4. **`maxResident` is documented as a maximum but silently raised to 3.**

Also inherent to the technique, not bugs: the camera path is frozen at build
time (changing a move means regenerating that segment — keep the stills as the
durable artifact); bandwidth is the real constraint, so this suits a hero or a
landing narrative, not a page visited daily; and scrubbing lets a viewer park on
any frame, so review the contact sheet rather than the playback.

## Anti-rationalization

| Excuse | Reality |
|---|---|
| "I'll just use Three.js, it's more flexible." | If scroll is the only input, you are paying a large runtime and a modelling budget for flexibility you will never use — and losing photorealism. Ask the decide-first question honestly. |
| "The clips look fine, skip `verify`." | Looking fine is exactly what a broken chain does. A clip that ignored the end frame is valid video; only the RMSE check sees the seam will jump. |
| "I'll conform later." | Un-conformed video is not scrubbable at all. There is no "later" in which the effect works. |
| "I'll test with the real API, the mock isn't realistic." | The mock is not there for realism, it is there so the wiring is exercised before you spend money on a long storyboard. Run it first, every time. |
| "The dogfood passed, so it works." | It passed once on a build with a blocker in it. Check that each assertion *could* fail before trusting that it didn't. |
| "N+1 posters is fiddly, I'll reuse one." | Then every seam is a visible cut and reduced-motion users get one image for the whole story. |
