# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Documented interop with GSAP / ScrollTrigger and smooth-scroll libraries,
  with measured numbers rather than reasoning. `node scripts/dogfood.mjs
  --lenis --tau <n>` reproduces them; Lenis is a devDependency for that test
  only and is never shipped.

### Notes
- Setting `tau: 0` alongside Lenis to "avoid double smoothing" is wrong and now
  documented as such: 85/812 first-reveal violations against 0 at `tau: 0.03`
  or the default. `tau` is what lets the requested time converge so the decoder
  can land on a frame — not only a feel knob.

## [0.2.0] — 2026-08-19

First public release.

### Added
- `createScrollCinema()` — scroll-driven video scrubber: exactly two decoders
  via `slot = segment % 2`, bounded resident memory, frame-rate-independent
  easing (`k = 1 - exp(-dt / tau)`).
- Generation pipeline (`pipeline/cinema.mjs` — `build` / `verify` / `manifest`)
  taking a storyboard to a verified, scrubbable asset set.
- Providers: `mock` (ffmpeg, offline, runs in CI), `gemini` (Gemini image models
  + Veo 3.1, validated live end to end), `fal` (Nano Banana Pro + Kling,
  dry-run verified only).
- Forward chaining for providers that cannot pin an end frame — the next still
  is the previous clip's actual final frame, so the chain invariant holds
  exactly.
- `scripts/conform.sh` — dense-GOP encode that then verifies its own output
  (no audio, dimensions, frame rate, max non-keyframe run, faststart via a real
  MP4 atom walk). `--verify-only` audits assets you did not encode;
  `--ladder` measures GOP cost on your own footage.
- `scripts/budget.mjs` — first-interaction and resident-memory gates.
- `pipeline/chain_rmse.py` — measures the keyframe-chain invariant instead of
  assuming it; the only gate that catches a provider silently ignoring the
  end-frame parameter.
- `SKILL.md` ships inside the package, so an agent that installs the code also
  gets the usage contract.

### Fixed
Relative to the reference implementation this was reverse-engineered from:
- First interaction costs one poster, not the entire payload.
- Explicit residency window rather than a `preload` hint overwritten by a blob
  `src`.
- Two live decoders rather than five.
- Frame-rate-independent easing rather than a per-frame constant that ran twice
  as fast at 120Hz.

And, found by cross-model review of this package itself:
- Decoder thrash — the binder was fed a memory-retention list containing the
  previous clip, which shares a slot with the incoming one, rebinding a decoder
  on every frame (5 `src` binds when correct; 247 when reintroduced).
- Object-URL leak under fetch contention; no abort on `destroy()`.
- Residency bound overshooting after a backgrounded-tab snap.
- A presentation check that compared opacity against the flag gating opacity,
  and so could never fail.
- Retry accounting that never reset on success and had no backoff.
- `bindTargets` missing from the public barrel — caught only by installing the
  packed tarball into a clean directory.

[0.2.0]: https://github.com/broomva/scroll-cinema/releases/tag/v0.2.0
