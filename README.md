# @broomva/scroll-cinema

[![check](https://github.com/broomva/scroll-cinema/actions/workflows/check.yml/badge.svg)](https://github.com/broomva/scroll-cinema/actions/workflows/check.yml)
[![npm](https://img.shields.io/npm/v/@broomva/scroll-cinema)](https://www.npmjs.com/package/@broomva/scroll-cinema)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Scroll-driven cinematic video scrubbing. Two decoders, bounded memory,
frame-rate-independent easing.

```bash
npm i @broomva/scroll-cinema     # or: bun add @broomva/scroll-cinema
```

The package ships `SKILL.md` alongside the code, so an agent that installs it
also gets the usage contract — the decision rule, the asset invariant, and the
gate table — without being told separately. `scripts/conform.sh`,
`scripts/budget.mjs` and the whole `pipeline/` are in the tarball and runnable
from `node_modules`.

Reverse-engineered from `amirmushichge/tea-leaf-scroll-world` and rebuilt
without its four defects. The analysis behind it — the frame-matching that
revealed the keyframe chain, and the GOP-cost measurements — is summarised in
the sections below.

## What this is for

Photoreal narrative pages where **scroll is the only input**. The depth is
parallax baked into pre-rendered camera movement — there is no 3D, no WebGL and
no canvas. If anything other than scroll position must change the image (hover,
drag-orbit, a configurator, live data), the camera path cannot be baked and you
need real geometry instead.

## Asset model: the keyframe chain

`N` clips need `N + 1` posters. Clip `i` starts on poster `i` and ends on poster
`i + 1`, so the crossfade at each seam terminates on identical frames and no cut
is perceivable. The posters are also the `poster` layer and the entire
reduced-motion experience — one asset doing three jobs.

Generate them by authoring the stills first, then generating each clip with
**both endpoints pinned** (start frame = still `i`, end frame = still `i + 1`).
That converts open-ended generation, which drifts, into a bounded interpolation
whose blast radius is one segment.

## Usage

```ts
import { createScrollCinema } from "@broomva/scroll-cinema";

const cinema = createScrollCinema({
  clips: ["01.mp4", "02.mp4", "03.mp4"],
  posters: ["a.webp", "b.webp", "c.webp", "d.webp"], // clips.length + 1
  stage: document.querySelector("#stage"),           // position: fixed
  track: document.querySelector("#track"),           // tall; sets the gearing
  onScene: (i) => setCopy(i),
});

// later
cinema.destroy;
```

Gear the track at roughly **110vh of scroll per clip** over a `position: fixed`
stage. Shorter feels frantic; much longer feels like work.

### Options

| Option | Default | Meaning |
|---|---|---|
| `tau` | `0.096` | Inertia time constant, seconds. Reproduces the reference feel at 60Hz. |
| `fade` | `0.1` | Fraction of each clip spent crossfading into the next. |
| `maxResident` | `3` | Clips held in memory at once. **This is the memory bound.** |
| `seekEpsilon` | `1/48` | Seek deadband, seconds — half a frame at 24fps. |
| `strategy` | `"blob"` | `blob` fully buffers for instant seeks; `stream` relies on dense-GOP range requests. |
| `reducedMotion` | auto | Override the `prefers-reduced-motion` read. |
| `view` | `window` | Injectable, for tests. |

`debug` exposes live internals (decoder count, resident set, per-slot
`currentTime`) — that is what the browser self-test asserts against.

## Generating the footage

The package ships the generation pipeline too, so the flow is end to end and
reusable on any subject:

```bash
node pipeline/cinema.mjs build storyboard.json --out assets/ --provider mock
node pipeline/cinema.mjs verify assets/
node pipeline/cinema.mjs manifest assets/
```

`bun run cinema:demo` runs the whole thing on the bundled example storyboard.

**Providers.** `mock` (ffmpeg, no key, runs in CI) · `gemini` (Gemini image
models + Veo 3.1, **validated live end to end**) · `fal` (Nano Banana Pro +
Kling `tail_image_url`, dry-run verified only). The adapter interface is small on
purpose: models rotate quarterly, the system is the durable asset. Metered
providers print a cost estimate and require `--yes`.

**Chain modes.** `pinned` authors every still and pins both ends of each clip.
`forward` authors only the first still and adopts each clip's real final frame as
the next one — the invariant still holds exactly, at the cost of art-directing
intermediate keyframes. Forward is selected automatically when a provider cannot
accept an end frame, which is the case for Veo 3.1: it documents `lastFrame` but
gates the capability off on every tier (400 *"Your use case is currently not
supported"*; the identical request without it succeeds — verified lite/fast/
standard, 2026-08-18).

**Storyboard.** See `pipeline/storyboard.example.json`. `motions` carries one
entry per **gap** (`scenes.length - 1`), not per scene — the builder rejects a
mismatch rather than silently pairing the wrong motion with the wrong transition.
Stills use `SHOT + LENS + LIGHT + TEXTURE + COMPOSITION + STYLE`; motions use
`WHAT moves + HOW it moves + HOW the camera behaves` in ~20–40 words, without
re-describing the still.

**`verify` measures the chain, it does not assume it.** Each clip's first and
last frame are RMSE-matched against every still, and the predicted match must win
by a clear margin — the same measurement that discovered the pattern in the
original assets. This is the only gate that catches a provider silently ignoring
the end-frame parameter: such a clip is still valid, scrubbable video and passes
everything else. Proven by mutation — pointing one clip at the wrong end still
yields `last frame expected still 1, matched 3 → FAIL 9/10`.

Generation is resumable; existing outputs are skipped unless `--force`.

## Preparing footage

Ordinary web video **cannot be scrubbed**: seeking decodes forward from the
nearest keyframe, and encoders default to a GOP of 48–250 frames.

```bash
scripts/conform.sh --out dist/ raw/*.mp4        # encode, then verify the result
scripts/conform.sh --verify-only dist/*.mp4     # audit assets you did not encode
scripts/conform.sh --ladder raw/one.mp4         # measure GOP cost on YOUR footage
```

`conform.sh` re-encodes to GOP 8 (worst-case seek decode: 8 frames) and then
asserts the output actually has the properties requested — no audio, correct
dimensions, keyframe gap within budget, faststart. A flag that was silently
ignored is the failure that check exists to catch.

**Measure the cost yourself.** On the high-motion reference footage, GOP 8 cost
only **1.13×** the bytes of GOP 48, because inter-prediction was saving little
to begin with. On low-motion footage (static scene, talking head) the penalty is
far larger. `--ladder` reports the real ratio for your source.

## Budget gate

```bash
node scripts/budget.mjs --clips 'dist/*.mp4' --posters 'stills/*.webp'
```

Asserts first interaction costs one poster (not the whole payload) and that
worst-case resident memory stays bounded. Exits non-zero when a budget is
exceeded, so it can gate CI.

First interaction is charged as the **largest** poster, not poster 0: the
runtime assigns `poster.src` only from the first tick, using the real scroll
position, so a deep link never pays for poster 0 and then discards it. That
single-request behaviour is verified in the browser, not assumed — the harness
reads `performance.getEntriesByType("resource")` before any scroll and requires
exactly one image.

## Development

```bash
bun install
bun run check       # typecheck + lint + unit tests
bun run dogfood     # build the demo and drive it in headless Chrome
bun run demo:serve  # serve it at localhost:8899 so you can scroll it yourself
```

`demo:serve` needs assets linked first (`scripts/link-demo-assets.sh <dir>`). It
honours Range requests, which is not optional — without 206 responses the
browser cannot seek within a clip, and seeking is the entire effect.

`bun run check` covers the arithmetic. `bun run dogfood` covers what unit tests
structurally cannot, running **both** strategies in headless Chrome and asserting:

| Invariant | Why it exists |
|---|---|
| `decoders === 2` | the core memory claim |
| resident set ≤ 3 | retention bound, completed clips |
| in-flight ≤ 3 | retention bound, *downloads* — a fast traversal must not buffer the story |
| total `src` binds ≈ clip count | **decoder thrash.** A slot-collision bug rebinds every frame; measured 5 when correct, 247 when reintroduced |
| no visible unsettled decoder | a revealed clip must have presented a frame from its source, not frame 0. **Known-weak, see limitations** |
| exactly 1 poster before first scroll | the first-interaction claim, measured via browser **resource timing** — independent of any runtime flag |
| stream run served Range requests | otherwise the 206 path is untested and the run proves nothing about streaming |

Both are required — see `demo/README.md` for supplying assets.

The thrash and in-flight counters exist because the first version of this
package passed 33 unit tests *and* a green browser run while binding the wrong
clip to a decoder on every frame. The harness had asserted `held.length <= 2`,
which two slots satisfy unconditionally.

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

## What was fixed relative to the reference

| # | Reference behaviour | Here |
|---|---|---|
| D1 | `Promise.all(clips.map(fetch))` blocked first interaction on all 43.8 MB | Interaction costs one poster; clips stream in behind it |
| D2 | `preload` hint was dead code, overwritten by a blob `src` | Explicit `maxResident` window, current + lookahead only |
| D3 | Five live `<video>` decoders | Exactly two, via `slot = segment % 2` — constant in story length |
| D4 | Per-frame easing constant, framerate-dependent | `k = 1 - exp(-dt / tau)`, identical at 60Hz, 120Hz and under jank |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). The short version: a change should
come with a test that **fails before the fix**, and any new metric should come
with an answer to "what would a broken run print?"

Also: [CHANGELOG](./CHANGELOG.md) · [SECURITY](./SECURITY.md) ·
[CODE_OF_CONDUCT](./CODE_OF_CONDUCT.md)

## Credit

The technique was reverse-engineered from
[`amirmushichge/tea-leaf-scroll-world`](https://github.com/amirmushichge/tea-leaf-scroll-world),
a ChatGPT Sites export. No code or assets from it are used here — the analysis
and the measurements are in the playbook, and this implementation is
independent.

## License

MIT © Carlos D. Escobar-Valbuena
