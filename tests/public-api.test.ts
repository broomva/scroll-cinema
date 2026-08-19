import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as pkg from "../src/index.js";

/**
 * Guards the PUBLIC surface, not the internals.
 *
 * `bindTargets` shipped unexported: every unit test imports straight from
 * `../src/map.js`, so 41 green tests never touched the barrel, and the gap only
 * surfaced when the packed tarball was installed into a clean directory and
 * imported the way a consumer would. Tests that reach past the public API
 * cannot detect a broken public API.
 */
describe("public API", () => {
  const source = ["src/map.ts", "src/scrubber.ts"]
    .map((f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8"))
    .join("\n");

  const declared = [
    ...source.matchAll(/^export (?:function|const) ([A-Za-z0-9_]+)/gm),
  ].map((m) => m[1]);

  test("every runtime export is re-exported from the barrel", () => {
    expect(declared.length).toBeGreaterThan(5);
    const missing = declared.filter((name) => !(name in pkg));
    expect(missing).toEqual([]);
  });

  test("the entry point exposes the documented surface", () => {
    for (const name of [
      "createScrollCinema",
      "placement",
      "bindTargets",
      "slotFor",
      "easeToward",
      "fadeAt",
      "timeFor",
      "shouldSeek",
      "residentSet",
      "trackProgress",
      "clamp",
      "clamp01",
    ]) {
      expect(typeof pkg[name as keyof typeof pkg]).toBe("function");
    }
  });

  test("POLARITY: the drift check can actually fail", () => {
    // If this ever passes, the test above has stopped proving anything.
    const missing = ["definitelyNotExported"].filter((n) => !(n in pkg));
    expect(missing).toEqual(["definitelyNotExported"]);
  });
});
