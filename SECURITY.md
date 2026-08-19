# Security Policy

## Supported versions

Pre-1.0: only the latest published version receives fixes.

## Reporting a vulnerability

Please report privately via
[GitHub Security Advisories](https://github.com/broomva/scroll-cinema/security/advisories/new)
rather than a public issue. Expect an initial response within 7 days.

## Notes for auditors

Two areas are worth attention:

- **`pipeline/providers/*`** send prompts and image bytes to third-party APIs
  and read credentials from the environment (`GEMINI_API_KEY`, `FAL_KEY`).
  Keys are never written to the manifest, logged, or embedded in output. The
  build refuses to spend without an explicit `--yes`.
- **`scripts/conform.sh`** and `pipeline/cinema.mjs` shell out to `ffmpeg`
  with caller-supplied paths. They are developer tools intended for
  locally-controlled input, not a service boundary; do not wire them to
  untrusted user input without adding your own validation.

The browser runtime makes no network requests other than fetching the clip and
poster URLs you pass it.
