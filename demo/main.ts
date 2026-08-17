/**
 * Demo + self-test harness.
 *
 * Loading `?selftest=1` drives a scripted scroll sweep and writes a machine
 * readable report into #report. `scripts/dogfood.mjs` reads that report and
 * fails the build if the runtime's invariants do not hold in a real browser --
 * unit tests cannot observe decoder count or whether a seek actually landed.
 */

import { createScrollCinema, type ScrollCinema } from "../src/index.js";

const CLIPS = [
  "assets/video/01-valley-to-harvest.mp4",
  "assets/video/02-harvest-to-drying-house.mp4",
  "assets/video/03-drying-to-roasting.mp4",
  "assets/video/04-roasting-to-road.mp4",
  "assets/video/05-road-to-ceremony.mp4",
];

const POSTERS = [
  "assets/stills/01-valley.webp",
  "assets/stills/02-harvest.webp",
  "assets/stills/03-drying-house.webp",
  "assets/stills/04-fire-and-form.webp",
  "assets/stills/05-mountain-road.webp",
  "assets/stills/06-tea-ceremony.webp",
];

const SCENES = ["Origin", "Harvest", "Air", "Fire", "Passage", "Cup"];

const stage = document.querySelector<HTMLElement>("#stage");
const track = document.querySelector<HTMLElement>("#track");
const label = document.querySelector<HTMLElement>("#scene");

if (!stage || !track) throw new Error("demo: missing #stage or #track");

const strategy =
  new URLSearchParams(location.search).get("strategy") === "stream" ? "stream" : "blob";

const cinema = createScrollCinema({
  clips: CLIPS,
  posters: POSTERS,
  stage,
  track,
  strategy,
  onScene: (scene) => {
    if (label) label.textContent = `${String(scene + 1).padStart(2, "0")} · ${SCENES[scene]}`;
  },
});

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

/**
 * Running peaks, sampled EVERY frame.
 *
 * Taking one snapshot after each scroll settles cannot see the states that
 * actually violate the bounds: the transient where an old clip is still held,
 * a new one is downloading, and a decoder is mid-seek. Those last a few frames.
 */
const peaks = { union: 0, inFlight: 0, live: 0, visibleUnpresented: 0, samples: 0 };

function observe(c: ScrollCinema): void {
  const d = c.debug();
  peaks.samples++;
  // Completed and in-flight clips both hold memory, so bound their UNION.
  peaks.union = Math.max(peaks.union, new Set([...d.resident, ...d.inFlight]).size);
  peaks.inFlight = Math.max(peaks.inFlight, d.inFlight.length);
  peaks.live = Math.max(peaks.live, d.liveUrls);
  if (d.opacity.some((o, i) => o > 0 && !d.settled[i])) peaks.visibleUnpresented++;
}

const settle = async (ms: number, c?: ScrollCinema) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    await frame();
    if (c) observe(c);
  }
};

/** Wait until at least one clip has decodable metadata, or give up. */
async function waitForFirstClip(c: ScrollCinema, timeoutMs = 30_000): Promise<boolean> {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    if (c.debug().held.some((h) => h !== null)) {
      await settle(400);
      return true;
    }
    await settle(100);
  }
  return false;
}

async function runSelfTest(c: ScrollCinema): Promise<void> {
  const report: Record<string, unknown> = { strategy };
  const failures: string[] = [];

  const loaded = await waitForFirstClip(c);
  report.firstClipLoaded = loaded;
  if (!loaded) failures.push("no clip ever became resident");

  // Independent evidence for the first-interaction claim: the browser's own
  // resource timing, not one of the runtime's flags. Counted BEFORE any scroll,
  // so it is exactly what a visitor pays to see the first frame.
  const postersBeforeScroll = performance
    .getEntriesByType("resource")
    .filter((e) => e.name.endsWith(".webp")).length;
  report.postersBeforeScroll = postersBeforeScroll;
  if (postersBeforeScroll > 1) {
    failures.push(`${postersBeforeScroll} posters fetched before any scroll (expected 1)`);
  }

  const samples: ReturnType<ScrollCinema["debug"]>[] = [];
  const max = document.documentElement.scrollHeight - window.innerHeight;

  for (const p of [0, 0.15, 0.35, 0.55, 0.75, 0.95, 1]) {
    window.scrollTo(0, Math.round(p * max));
    // tau is 96ms; ~600ms is well past settled. Peaks are collected throughout
    // the wait, not just at its end.
    await settle(700, c);
    samples.push(c.debug());
  }
  report.samples = samples;

  // --- invariants -------------------------------------------------------
  if (!samples.every((s) => s.decoders === 2)) {
    failures.push(`decoder count left 2: ${samples.map((s) => s.decoders).join(",")}`);
  }
  // NOTE: asserting `held.length <= 2` is vacuous — there are only two slots.
  // The real invariants are below, and they are what a slot-collision bug trips.

  // Decoder thrash. A forward sweep binds each clip exactly once, so total
  // `src` assignments should equal the clip count. The original implementation
  // fed the binder a list containing the PREVIOUS clip, which shares a slot with
  // the incoming one, so it rebound a decoder on EVERY frame — hundreds of
  // binds. Everything else about that run still looked correct.
  const last = samples[samples.length - 1];
  const totalBinds = (last?.binds ?? []).reduce((a, b) => a + b, 0);
  report.totalBinds = totalBinds;
  if (totalBinds > CLIPS.length * 2) {
    failures.push(
      `decoder thrash: ${totalBinds} src assignments for ${CLIPS.length} clips (expected <= ${CLIPS.length * 2})`,
    );
  }

  // Object-URL leak. Live URLs must stay inside the residency bound no matter
  // how much contention the sweep created.

  // Peak-based assertions. These use the every-frame observations, because the
  // states that break the bounds are transients a settled snapshot never sees.
  report.peaks = peaks;

  // A VISIBLE decoder must have presented a frame from its current source.
  // (Earlier this value was computed and never asserted on, so it could not
  // fail -- an absent verifier reads as green.)
  // KNOWN-WEAK (BRO-2173): `presented` is also what gates opacity, so this
  // comparison is close to tautological and cannot fail on its own. It is kept
  // as a cheap tripwire for a future refactor that decouples the two, but it is
  // NOT evidence that reveal timing is correct. An independent signal
  // (requestVideoFrameCallback frame counts) is required for that.
  if (peaks.visibleUnpresented > 0) {
    failures.push(
      `${peaks.visibleUnpresented}/${peaks.samples} frames showed a decoder that had presented nothing`,
    );
  }

  // Completed + downloading clips both hold memory, so the UNION is the bound.
  if (peaks.union > 3) {
    failures.push(`peak resident-union ${peaks.union} clips (bound is 3)`);
  }
  if (peaks.live > 3) {
    failures.push(`peak live object URLs ${peaks.live} (bound is 3)`);
  }

  // Scrubbing must actually move the decoder, not merely change state.
  const distinctTimes = new Set(
    samples.map((s) => s.times.map((t) => t.toFixed(3)).join("|")),
  );
  report.distinctTimeStates = distinctTimes.size;
  if (distinctTimes.size < 3) {
    failures.push(`currentTime barely moved across the sweep (${distinctTimes.size} states)`);
  }

  // The chain must be traversed end to end.
  const segments = samples.map((s) => s.segment);
  report.segments = segments;
  if (Math.min(...segments) !== 0 || Math.max(...segments) !== CLIPS.length - 1) {
    failures.push(`segments did not span the chain: ${segments.join(",")}`);
  }
  if (segments.some((s, i) => i > 0 && s < (segments[i - 1] ?? 0))) {
    failures.push(`segments went backwards on a forward sweep: ${segments.join(",")}`);
  }

  report.failures = failures;
  report.pass = failures.length === 0;

  const out = document.querySelector("#report");
  if (out) out.textContent = JSON.stringify(report, null, 2);
  document.title = failures.length === 0 ? "SELFTEST PASS" : `SELFTEST FAIL ${failures.length}`;

  // Post the result back rather than letting the harness scrape the DOM: video
  // decode is real I/O, so a one-shot DOM dump races the clips loading.
  try {
    await fetch("/__report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    });
  } catch {
    // Opened by hand rather than by the harness — #report is the output.
  }
}

if (new URLSearchParams(location.search).has("selftest")) {
  void runSelfTest(cinema);
}
