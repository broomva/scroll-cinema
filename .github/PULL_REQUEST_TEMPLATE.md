## What and why

<!-- What changes, and what problem it solves. -->

## Evidence

Please show the gate output rather than describing it.

- [ ] `bun run check` green
- [ ] `bun run dogfood` green (if the runtime changed)
- [ ] `pipeline/cinema.mjs verify <dir>` green (if the pipeline changed)

**If this fixes a bug:** paste the test failing *before* the fix. A test that
was never red has not been shown to test anything.

```
before:
after:
```

**If this adds an assertion or metric:** what would a broken run print? If it
prints the same thing as a healthy run, the check is vacuous.

## Notes

<!-- Anything you could not verify, and why. An honestly-labelled unverified
     change is fine; one claimed to work and never exercised is not. -->
