# Contributing

Thanks for looking. This project has an unusual bar, and it is worth knowing why
before you open a PR.

## The bar

**Every gate here exists because something passed the other gates and was still
broken.** The first version of this runtime passed 33 unit tests and a green
browser run while rebinding a decoder to the wrong clip on *every frame*. The
harness had asserted `held.length <= 2` — which two slots satisfy
unconditionally. So:

> Before you report a number as evidence, say what a **broken** system would
> print. If it is the same number, the metric proves nothing.

Concretely, a change is expected to come with a test that **fails before the
fix** and passes after. If you cannot make the test fail, you have not
demonstrated that it tests anything.

## Setup

```bash
bun install
bun run check          # typecheck + lint + unit tests
```

To exercise the runtime you need a clip set. You do not need an API key:

```bash
bun run cinema:demo                          # ffmpeg-synthesised set, offline
scripts/link-demo-assets.sh .cinema-demo
bun run dogfood                              # headless Chrome, both strategies
bun run demo:serve                           # look at it yourself
```

## What each gate catches

Run all of them; they do not overlap.

| gate | command | catches what nothing else does |
|---|---|---|
| Unit | `bun run check` | the scroll→frame arithmetic, and public-API drift |
| Chain | `pipeline/cinema.mjs verify <dir>` | a provider that ignored the end-frame parameter — such a clip is still valid, scrubbable video |
| Encode | `scripts/conform.sh --verify-only` | a flag silently dropped, leaving the file unscrubbable |
| Budget | `scripts/budget.mjs` | first-interaction weight and resident memory |
| Runtime | `bun run dogfood` | decoder thrash, URL leaks, whether seeks actually land |

## Conventions

- **bun** (not npm/yarn) and **Biome** (not ESLint/Prettier) — `bun run lint:fix`
- TypeScript strict; all playback arithmetic lives in `src/map.ts` as pure
  functions so it can be tested by calling the same code the runtime calls
- Comments explain *why*, especially where the obvious approach is wrong
- Conventional-commit subjects (`fix:`, `feat:`, `docs:`)

## Things that will get a PR sent back

- A test that reaches past the public API to prove the public API works
- A new assertion with no demonstration that it can fail
- A metric added without stating what a failing run would show
- Silently widening a documented bound to make a check pass

## Provider adapters

New adapters implement `image()` and `video()` and declare
`supportsLastFrame`. Please include a `--dry-run` transcript in the PR. If you
cannot test against the live API, say so — an adapter marked unverified is
useful; one claimed to work and never called is not.
