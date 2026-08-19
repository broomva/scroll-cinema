import { describe, expect, test } from "bun:test";
import { shouldReveal } from "../src/map.js";

/**
 * The reveal gate decides whether a freshly bound slot may be shown.
 *
 * It was previously written inline with an INVERTED predicate — a variable
 * named `confirmed` holding "finite AND outside tolerance" — so a slot with no
 * compositor frame yet (`NaN`) was revealed immediately, bypassing the liveness
 * deadline in exactly the case it exists for. It looked correct in a browser
 * run because the observed worst case was a finite out-of-tolerance frame.
 *
 * Hence these tests, and hence the function being pure.
 */
const TOL = (1 / 48) * 4; // seekEpsilon * 4, as the runtime uses
const TIMEOUT = 1500;

describe("shouldReveal", () => {
  test("reveals when the compositor confirms a frame at the requested time", () => {
    expect(shouldReveal(4.0, 4.0, TOL, 0, TIMEOUT)).toBe(true);
    expect(shouldReveal(4.0 + TOL / 2, 4.0, TOL, 0, TIMEOUT)).toBe(true);
  });

  test("holds while the painted frame is the wrong one", () => {
    expect(shouldReveal(0, 4.02, TOL, 0, TIMEOUT)).toBe(false);
    expect(shouldReveal(0.25, 4.02, TOL, 0, TIMEOUT)).toBe(false);
    expect(shouldReveal(0, 0.9, TOL, 0, TIMEOUT)).toBe(false);
  });

  test("REGRESSION: no frame reported yet must HOLD, not reveal", () => {
    // The inverted predicate returned true here — revealing a slot the
    // compositor had said nothing about, which is the frame-0 flash the gate
    // exists to prevent.
    expect(shouldReveal(Number.NaN, 4.0, TOL, 0, TIMEOUT)).toBe(false);
    expect(shouldReveal(Number.NaN, 4.0, TOL, TIMEOUT - 1, TIMEOUT)).toBe(false);
  });

  test("LIVENESS: reveals once the deadline passes, whatever the compositor said", () => {
    // rVFC promises no timing. Waiting forever means a permanently invisible
    // video; a stale frame is the lesser failure.
    expect(shouldReveal(Number.NaN, 4.0, TOL, TIMEOUT + 1, TIMEOUT)).toBe(true);
    expect(shouldReveal(0, 4.02, TOL, TIMEOUT + 1, TIMEOUT)).toBe(true);
  });

  test("short clips are not a blind spot", () => {
    // An earlier assertion only checked requests deeper than 1.0s, so clips
    // under a second were never covered.
    expect(shouldReveal(0, 0.4, TOL, 0, TIMEOUT)).toBe(false);
    expect(shouldReveal(0.4, 0.4, TOL, 0, TIMEOUT)).toBe(true);
  });

  test("degenerate inputs do not reveal early", () => {
    expect(shouldReveal(Number.NaN, Number.NaN, TOL, 0, TIMEOUT)).toBe(false);
    expect(shouldReveal(4, Number.NaN, TOL, 0, TIMEOUT)).toBe(false);
    expect(shouldReveal(Number.POSITIVE_INFINITY, 4, TOL, 0, TIMEOUT)).toBe(false);
  });

  test("POLARITY: the inverted predicate this replaced fails these tests", () => {
    // If this ever passes, the tests above have stopped distinguishing the bug.
    const inverted = (p: number, t: number, tol: number, el: number, to: number) => {
      const confirmed = Number.isFinite(p) && Math.abs(p - t) > tol;
      return !(confirmed && !(el > to));
    };
    expect(inverted(Number.NaN, 4.0, TOL, 0, TIMEOUT)).toBe(true); // the bug
    expect(shouldReveal(Number.NaN, 4.0, TOL, 0, TIMEOUT)).toBe(false); // the fix
  });
});
