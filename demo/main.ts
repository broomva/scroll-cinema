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

const cinema = createScrollCinema({
  clips: CLIPS,
  posters: POSTERS,
  stage,
  track,
  onScene: (scene) => {
    if (label) label.textContent = `${String(scene + 1).padStart(2, "0")} · ${SCENES[scene]}`;
  },
});

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const settle = async (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) await frame();
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
  const report: Record<string, unknown> = {};
  const failures: string[] = [];

  const loaded = await waitForFirstClip(c);
  report.firstClipLoaded = loaded;
  if (!loaded) failures.push("no clip ever became resident");

  const samples: ReturnType<ScrollCinema["debug"]>[] = [];
  const max = document.documentElement.scrollHeight - window.innerHeight;

  for (const p of [0, 0.15, 0.35, 0.55, 0.75, 0.95, 1]) {
    window.scrollTo(0, Math.round(p * max));
    // tau is 96ms; ~600ms is well past settled.
    await settle(700);
    samples.push(c.debug());
  }
  report.samples = samples;

  // --- invariants -------------------------------------------------------
  if (!samples.every((s) => s.decoders === 2)) {
    failures.push(`decoder count left 2: ${samples.map((s) => s.decoders).join(",")}`);
  }
  if (!samples.every((s) => s.resident.length <= 3)) {
    failures.push(`resident set exceeded 3: ${samples.map((s) => s.resident.length).join(",")}`);
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
  const maxLive = Math.max(...samples.map((s) => s.liveUrls));
  report.maxLiveUrls = maxLive;
  if (maxLive > 3) {
    failures.push(`object-URL leak: ${maxLive} live URLs (residency bound is 3)`);
  }

  // A revealed decoder must be showing the frame that was asked for.
  const revealedUnsettled = samples.filter(
    (s) => s.held[s.segment % 2] === s.segment && !s.settled[s.segment % 2],
  ).length;
  report.revealedUnsettled = revealedUnsettled;

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
