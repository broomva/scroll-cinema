import { describe, expect, test } from "bun:test";
import {
  bindTargets,
  clamp,
  clamp01,
  easeToward,
  fadeAt,
  placement,
  residentSet,
  shouldSeek,
  slotFor,
  timeFor,
  trackProgress,
} from "../src/map.js";

describe("placement", () => {
  test("maps the start of the track to the first frame of the first clip", () => {
    expect(placement(0, 5)).toEqual({ segment: 0, local: 0 });
  });

  test("maps the end of the track to the last frame of the last clip", () => {
    // The naive floor() lands on index 5 here; the clamp is what keeps the
    // final scroll position showing a frame instead of overrunning the chain.
    expect(placement(1, 5)).toEqual({ segment: 4, local: 1 });
  });

  test("splits mid-track into the right clip and offset", () => {
    expect(placement(0.5, 5)).toEqual({ segment: 2, local: 0.5 });
    expect(placement(0.1, 5)).toEqual({ segment: 0, local: 0.5 });
  });

  test("clamps out-of-range progress rather than producing a bad index", () => {
    expect(placement(-1, 5)).toEqual({ segment: 0, local: 0 });
    expect(placement(2, 5)).toEqual({ segment: 4, local: 1 });
  });

  test("survives a zero-length chain", () => {
    expect(placement(0.5, 0)).toEqual({ segment: 0, local: 0 });
  });

  test("never lets a non-finite input become a NaN clip index", () => {
    // `clips[NaN]` is silently `undefined` rather than an error, so a NaN must
    // be stopped here rather than reaching the runtime.
    expect(placement(Number.NaN, 5)).toEqual({ segment: 0, local: 0 });
    expect(placement(Number.POSITIVE_INFINITY, 5).segment).toBe(4);
    expect(placement(0.5, Number.NaN)).toEqual({ segment: 0, local: 0 });
  });

  test("every segment index it returns is a valid clip index", () => {
    for (let n = 1; n <= 12; n++) {
      for (let i = 0; i <= 100; i++) {
        const { segment, local } = placement(i / 100, n);
        expect(segment).toBeGreaterThanOrEqual(0);
        expect(segment).toBeLessThan(n);
        expect(local).toBeGreaterThanOrEqual(0);
        expect(local).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("easeToward", () => {
  test("converges toward the target", () => {
    let v = 0;
    for (let i = 0; i < 100; i++) v = easeToward(v, 1, 1 / 60, 0.096);
    expect(v).toBeGreaterThan(0.99);
  });

  test("is frame-rate independent — the fix over the reference implementation", () => {
    const tau = 0.1;
    const total = 0.5;

    let at60 = 0;
    for (let i = 0; i < 30; i++) at60 = easeToward(at60, 1, total / 30, tau);

    let at120 = 0;
    for (let i = 0; i < 60; i++) at120 = easeToward(at120, 1, total / 60, tau);

    let janky = 0;
    for (const dt of [0.004, 0.05, 0.008, 0.033, 0.405]) {
      janky = easeToward(janky, 1, dt, tau);
    }

    expect(Math.abs(at60 - at120)).toBeLessThan(1e-9);
    expect(Math.abs(at60 - janky)).toBeLessThan(1e-9);
  });

  test("POLARITY: a per-frame constant is NOT frame-rate independent", () => {
    // This is the reference implementation's `current += (desired - current) * 0.16`.
    // If this assertion ever fails, the test above has stopped proving anything.
    //
    // Sampled over 0.1s (6 frames at 60Hz vs 12 at 120Hz) rather than to
    // convergence: given enough frames both saturate at 1 and look identical.
    // The divergence exists only while the value is still moving -- which is
    // precisely when a user perceives it.
    const perFrame = (c: number, t: number) => c + (t - c) * 0.16;
    let at60 = 0;
    for (let i = 0; i < 6; i++) at60 = perFrame(at60, 1);
    let at120 = 0;
    for (let i = 0; i < 12; i++) at120 = perFrame(at120, 1);
    expect(Math.abs(at60 - at120)).toBeGreaterThan(0.2);

    // The real implementation, sampled the same way, agrees to float precision.
    let ours60 = 0;
    for (let i = 0; i < 6; i++) ours60 = easeToward(ours60, 1, 0.1 / 6, 0.096);
    let ours120 = 0;
    for (let i = 0; i < 12; i++) ours120 = easeToward(ours120, 1, 0.1 / 12, 0.096);
    expect(Math.abs(ours60 - ours120)).toBeLessThan(1e-12);
  });

  test("degenerate tau or dt snaps to the target instead of stalling", () => {
    expect(easeToward(0, 1, 0.016, 0)).toBe(1);
    expect(easeToward(0, 1, 0, 0.1)).toBe(1);
    expect(easeToward(Number.NaN, 1, 0.016, 0.1)).toBe(1);
  });
});

describe("fadeAt", () => {
  test("is fully transparent for the bulk of a segment", () => {
    expect(fadeAt(0, 0.1)).toBe(0);
    expect(fadeAt(0.5, 0.1)).toBe(0);
    expect(fadeAt(0.89, 0.1)).toBe(0);
  });

  test("reaches full opacity exactly at the seam", () => {
    expect(fadeAt(1, 0.1)).toBe(1);
    expect(fadeAt(0.95, 0.1)).toBeCloseTo(0.5, 10);
  });

  test("is monotonic across the fade window", () => {
    let prev = -1;
    for (let i = 0; i <= 50; i++) {
      const v = fadeAt(0.9 + (i / 50) * 0.1, 0.1);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  test("a zero fade window never fades", () => {
    expect(fadeAt(1, 0)).toBe(0);
  });
});

describe("slotFor", () => {
  test("alternates so only two decoders are ever needed", () => {
    expect([0, 1, 2, 3, 4, 5].map(slotFor)).toEqual([0, 1, 0, 1, 0, 1]);
  });

  test("adjacent segments never share a slot", () => {
    for (let i = 0; i < 50; i++) expect(slotFor(i)).not.toBe(slotFor(i + 1));
  });

  test("never yields a negative index", () => {
    expect(slotFor(-1)).toBe(1);
    expect(slotFor(-2)).toBe(0);
  });

  test("always returns a usable array index, whatever a JS caller passes", () => {
    // The `0 | 1` type is erased at runtime; `%` on a fractional or infinite
    // input would yield 0.5 / NaN and index nothing.
    for (const bad of [0.5, 2.7, -1.5, Number.NaN, Number.POSITIVE_INFINITY, -Infinity]) {
      const s = slotFor(bad);
      expect(s === 0 || s === 1).toBe(true);
    }
  });
});

describe("bindTargets", () => {
  test("binds only the current clip and the one it fades into", () => {
    expect(bindTargets(2, 5)).toEqual([2, 3]);
    expect(bindTargets(0, 5)).toEqual([0, 1]);
    expect(bindTargets(4, 5)).toEqual([4]);
  });

  test("REGRESSION: bind targets never collide on a slot", () => {
    // The original implementation fed `residentSet` (which includes the
    // PREVIOUS clip) to the binder. slotFor(n-1) === slotFor(n+1), so the
    // previous clip evicted the incoming clip from its decoder every frame.
    // Unit tests could not see it and the browser self-test asserted only
    // `held.length <= 2`, which two slots satisfy unconditionally.
    for (let n = 1; n <= 30; n++) {
      for (let s = 0; s < n; s++) {
        const slots = bindTargets(s, n).map(slotFor);
        expect(new Set(slots).size).toBe(slots.length);
      }
    }
  });

  test("REGRESSION: residentSet is NOT safe to bind — it collides", () => {
    // Polarity for the test above: proves the collision was real, so the
    // invariant is not vacuously true of any list we might pass.
    const slots = residentSet(2, 5, 3).map(slotFor);
    expect(residentSet(2, 5, 3)).toEqual([2, 3, 1]);
    expect(new Set(slots).size).toBeLessThan(slots.length);
  });

  test("stays inside the chain and rejects nonsense", () => {
    expect(bindTargets(0, 1)).toEqual([0]);
    expect(bindTargets(-5, 5)).toEqual([]);
    expect(bindTargets(Number.NaN, 5)).toEqual([]);
    expect(bindTargets(0, 0)).toEqual([]);
  });
});

describe("timeFor", () => {
  test("never seeks to exactly duration", () => {
    const d = 8.041667;
    expect(timeFor(1, d)).toBeLessThan(d);
    expect(timeFor(2, d)).toBeLessThan(d);
  });

  test("scales linearly through the clip", () => {
    expect(timeFor(0, 10)).toBe(0);
    // Within a frame of the true midpoint — asserted as a property rather than
    // by recomputing the implementation's own end-guard arithmetic.
    expect(Math.abs(timeFor(0.5, 10) - 5)).toBeLessThan(1 / 24);
  });

  test("REGRESSION: the end guard is temporal, not fractional", () => {
    // A fractional ceiling (0.998) scales with clip length: a 300s clip would
    // stop 600ms early and never reach its authored end frame, breaking the
    // seam that the keyframe chain depends on.
    for (const d of [8.04, 60, 300, 1800]) {
      const gap = d - timeFor(1, d);
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThan(1 / 24);
    }
  });

  test("returns 0 for a decoder that has no metadata yet", () => {
    expect(timeFor(0.5, Number.NaN)).toBe(0);
    expect(timeFor(0.5, 0)).toBe(0);
    expect(timeFor(0.5, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("shouldSeek", () => {
  test("ignores sub-threshold deltas that would only thrash the decoder", () => {
    expect(shouldSeek(1.0, 1.0 + 1 / 200, 1 / 48)).toBe(false);
  });

  test("seeks once the delta would show a different frame", () => {
    expect(shouldSeek(1.0, 1.2, 1 / 48)).toBe(true);
  });

  test("refuses to act on non-finite times", () => {
    expect(shouldSeek(Number.NaN, 1, 1 / 48)).toBe(false);
    expect(shouldSeek(1, Number.NaN, 1 / 48)).toBe(false);
  });
});

describe("residentSet", () => {
  test("prioritises current, then next, then previous", () => {
    expect(residentSet(2, 5, 3)).toEqual([2, 3, 1]);
  });

  test("is bounded by max — this is the memory guarantee", () => {
    for (let n = 1; n <= 40; n++) {
      for (let s = 0; s < n; s++) {
        expect(residentSet(s, n, 3).length).toBeLessThanOrEqual(3);
      }
    }
  });

  test("always includes the clip being shown", () => {
    for (let n = 1; n <= 20; n++) {
      for (let s = 0; s < n; s++) expect(residentSet(s, n, 3)).toContain(s);
    }
  });

  test("never names a clip outside the chain", () => {
    expect(residentSet(0, 5, 3)).toEqual([0, 1]);
    expect(residentSet(4, 5, 3)).toEqual([4, 3]);
    for (const i of residentSet(0, 1, 3)) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(1);
    }
  });

  test("honours a tighter budget", () => {
    expect(residentSet(2, 5, 1)).toEqual([2]);
    expect(residentSet(2, 5, 2)).toEqual([2, 3]);
    expect(residentSet(2, 5, 0)).toEqual([]);
  });
});

describe("trackProgress", () => {
  test("reports fractional scroll position", () => {
    expect(trackProgress(500, 2000, 1000)).toBeCloseTo(0.5, 10);
    expect(trackProgress(1000, 2000, 1000)).toBe(1);
  });

  test("returns 0 when the track is not taller than the viewport", () => {
    // Happens transiently during layout; must not produce NaN or Infinity.
    expect(trackProgress(0, 1000, 1000)).toBe(0);
    expect(trackProgress(0, 500, 1000)).toBe(0);
  });

  test("clamps overscroll", () => {
    expect(trackProgress(99999, 2000, 1000)).toBe(1);
    expect(trackProgress(-200, 2000, 1000)).toBe(0);
  });

  test("does not propagate non-finite geometry", () => {
    expect(trackProgress(Number.NaN, 2000, 1000)).toBe(0);
    expect(trackProgress(500, Number.NaN, 1000)).toBe(0);
    expect(trackProgress(500, Number.POSITIVE_INFINITY, 1000)).toBe(0);
  });
});

describe("clamp helpers", () => {
  test("clamp bounds both ends", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });

  test("clamp01 is the 0..1 case", () => {
    expect(clamp01(2)).toBe(1);
    expect(clamp01(-2)).toBe(0);
  });
});
