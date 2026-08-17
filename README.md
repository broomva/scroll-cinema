# @broomva/scroll-cinema

Scroll-driven cinematic video scrubbing. Two decoders, bounded memory,
frame-rate-independent easing.

Reverse-engineered from `amirmushichge/tea-leaf-scroll-world` and rebuilt
without its four defects. Full analysis, measurements and art-direction notes:
[`docs/specs/2026-08-17-scroll-cinema-playbook.html`](../../docs/specs/2026-08-17-scroll-cinema-playbook.html)
(BRO-2167).

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
cinema.destroy();
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

`debug()` exposes live internals (decoder count, resident set, per-slot
`currentTime`) — that is what the browser self-test asserts against.

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

## Development

```bash
bun install
bun run check      # typecheck + lint + unit tests
bun run dogfood    # build the demo and drive it in headless Chrome
```

`bun run check` covers the arithmetic. `bun run dogfood` covers what unit tests
structurally cannot, running **both** strategies in headless Chrome and asserting:

| Invariant | Why it exists |
|---|---|
| `decoders === 2` | the core memory claim |
| resident set ≤ 3 | retention bound, completed clips |
| in-flight ≤ 3 | retention bound, *downloads* — a fast traversal must not buffer the story |
| total `src` binds ≈ clip count | **decoder thrash.** A slot-collision bug rebinds every frame; measured 5 when correct, 247 when reintroduced |
| no visible unsettled decoder | a revealed clip must have presented the requested frame, not frame 0 |
| stream run served Range requests | otherwise the 206 path is untested and the run proves nothing about streaming |

Both are required — see `demo/README.md` for supplying assets.

The thrash and in-flight counters exist because the first version of this
package passed 33 unit tests *and* a green browser run while binding the wrong
clip to a decoder on every frame. The harness had asserted `held.length <= 2`,
which two slots satisfy unconditionally.

## Known limitations — open findings, do not treat as production-ready

Four cross-model review rounds took this from 2/10 to 6/10. The final verdict was
still **SHIP: NO**, and the fix budget (3 rounds) is spent, so these are recorded
rather than fixed. Tracked in BRO-2168.

| # | Finding | Status |
|---|---|---|
| 1 | **The residency bound can transiently overshoot.** After a `RESUME_GAP` snap (backgrounded tab), progress can jump several segments; downloads start for the new pair while the old pair is still *held* and therefore not evictable, so `resident ∪ inFlight` can reach 4 against a bound of 3. The smooth sweep in the harness never takes the snap path. | open |
| 2 | **The `visible-unpresented` harness assertion is tautological.** `presented` is what gates opacity, so asserting "opacity > 0 implies presented" cannot fail. It must compare against an independent signal (e.g. a `requestVideoFrameCallback` frame count) to mean anything. | open |
| 3 | **Retry accounting never resets on success**, and retries have no backoff — three isolated transient failures across a session permanently disable a segment, and a brief outage can burn all three on consecutive frames. | open |
| 4 | **`maxResident` is documented as a maximum but silently raised to 3.** Either reject values below the floor or document the minimum. | open |

Verified sound: the two-decoder invariant, decoder-thrash bound (5 binds for 5
clips; 247 when the collision is reintroduced), object-URL dedup and revocation,
abort-on-destroy, frame-rate-independent easing, the temporal end guard, and
every `conform.sh` / `budget.mjs` assertion (each proven against input it must
reject as well as input it must accept).

## What was fixed relative to the reference

| # | Reference behaviour | Here |
|---|---|---|
| D1 | `Promise.all(clips.map(fetch))` blocked first interaction on all 43.8 MB | Interaction costs one poster; clips stream in behind it |
| D2 | `preload` hint was dead code, overwritten by a blob `src` | Explicit `maxResident` window, current + lookahead only |
| D3 | Five live `<video>` decoders | Exactly two, via `slot = segment % 2` — constant in story length |
| D4 | Per-frame easing constant, framerate-dependent | `k = 1 - exp(-dt / tau)`, identical at 60Hz, 120Hz and under jank |
