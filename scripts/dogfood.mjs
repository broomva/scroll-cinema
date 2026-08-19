#!/usr/bin/env node
/**
 * dogfood.mjs — drive the real runtime in a real browser and assert its invariants.
 *
 * Unit tests cover the arithmetic; they cannot observe how many decoders exist,
 * whether a seek actually landed, or whether the resident set stayed bounded
 * while a user scrolled. This does, by serving the demo over HTTP, loading it in
 * headless Chrome with `?selftest=1`, and reading the report the page produces.
 *
 * Requires demo assets (gitignored, third-party) — see demo/README.md.
 *
 *   node scripts/dogfood.mjs [--keep]
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const STRATEGY = process.argv.includes("--stream") ? "stream" : "blob";
const DEMO = join(ROOT, "demo");
const PORT = 8788 + (process.pid % 200);

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mp4": "video/mp4",
  ".webp": "image/webp",
  ".css": "text/css",
  ".json": "application/json",
};

function fail(msg) {
  console.error(`dogfood: ${msg}`);
  process.exit(1);
}

if (!existsSync(join(DEMO, "dist", "demo.js"))) {
  fail("demo/dist/demo.js missing — run `bun run demo:build` first");
}
if (!existsSync(join(DEMO, "assets", "video"))) {
  fail("demo/assets/video missing — see demo/README.md for how to supply assets");
}

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) fail(`no Chrome found; looked in:\n  ${CHROME_CANDIDATES.join("\n  ")}`);

// ---------------------------------------------------------------- server
let resolveReport;
const reportPromise = new Promise((r) => {
  resolveReport = r;
});

let rangeRequests = 0;

const server = createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];

  if (req.method === "POST" && url === "/__report") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(204).end();
      resolveReport(body);
    });
    return;
  }

  const rel = normalize(url === "/" ? "/index.html" : url).replace(/^(\.\.[/\\])+/, "");
  const file = join(DEMO, rel);
  if (!file.startsWith(DEMO) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  const body = readFileSync(file);
  const type = TYPES[extname(file)] ?? "application/octet-stream";

  // Honour Range properly. Advertising `accept-ranges` while always returning
  // 200 would let a `strategy: "stream"` run pass without ever exercising the
  // range-seeking the dense-GOP encode exists to make cheap.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range) {
    rangeRequests++;
    const start = range[1] === "" ? body.length - Number(range[2]) : Number(range[1]);
    const end = range[1] === "" || range[2] === "" ? body.length - 1 : Number(range[2]);
    if (!Number.isFinite(start) || start < 0 || start > end || end >= body.length) {
      res.writeHead(416, { "content-range": `bytes */${body.length}` }).end();
      return;
    }
    res.writeHead(206, {
      "content-type": type,
      "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end}/${body.length}`,
      "content-length": end - start + 1,
    });
    res.end(body.subarray(start, end + 1));
    return;
  }

  res.writeHead(200, {
    "content-type": type,
    "accept-ranges": "bytes",
    "content-length": body.length,
  });
  res.end(body);
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
console.log(`dogfood: serving ${DEMO} on http://127.0.0.1:${PORT}`);

// ---------------------------------------------------------------- browser
// Deliberately no --virtual-time-budget: it fast-forwards timers but not media
// decode, so the page's settle loop would finish before a single clip loaded.
const args = [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--hide-scrollbars",
  "--autoplay-policy=no-user-gesture-required",
  "--window-size=1280,900",
  `--user-data-dir=${join(ROOT, "node_modules", ".dogfood-profile")}`,
  `http://127.0.0.1:${PORT}/index.html?selftest=1&strategy=${STRATEGY}`,
];

const keep = process.argv.includes("--keep");
const browser = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
let chromeErr = "";
browser.stderr.on("data", (d) => (chromeErr += d));
browser.on("error", (e) => fail(`could not launch Chrome: ${e.message}`));

const TIMEOUT_MS = 120_000;
const raw = await Promise.race([
  reportPromise,
  new Promise((r) => setTimeout(() => r(null), TIMEOUT_MS)),
]);

if (!keep) browser.kill("SIGTERM");
server.close();

// ---------------------------------------------------------------- assert
if (raw === null) {
  fail(
    `no report after ${TIMEOUT_MS / 1000}s — the self-test never finished.` +
      (chromeErr ? `\nchrome stderr:\n${chromeErr.slice(0, 600)}` : ""),
  );
}

let report;
try {
  report = JSON.parse(raw);
} catch (e) {
  fail(`report was not valid JSON: ${e.message}\n${String(raw).slice(0, 500)}`);
}

const s = report.samples ?? [];
console.log(`\nstrategy          : ${report.strategy}`);
console.log(`first clip loaded : ${report.firstClipLoaded}`);
console.log(`samples           : ${s.length}`);
console.log(`segments visited  : ${(report.segments ?? []).join(" -> ")}`);
console.log(`distinct time states: ${report.distinctTimeStates}`);
console.log(`decoders (per sample): ${s.map((x) => x.decoders).join(",")}`);
console.log(`resident (per sample): ${s.map((x) => x.resident.length).join(",")}`);
console.log(
  `currentTime slot0  : ${s.map((x) => (x.times[0] ?? 0).toFixed(2)).join(", ")}`,
);
console.log(
  `currentTime slot1  : ${s.map((x) => (x.times[1] ?? 0).toFixed(2)).join(", ")}`,
);
const pk = report.peaks ?? {};
console.log(`total src binds   : ${report.totalBinds}  (thrash detector; expect ~clip count)`);
console.log(`frames observed   : ${pk.samples}  (every-frame sampling, not settled snapshots)`);
console.log(`peak resident-union: ${pk.union}  (completed + in-flight; bound is 3)`);
console.log(`peak in-flight    : ${pk.inFlight}`);
console.log(`peak live objectURLs: ${pk.live}  (bound is 3)`);
console.log(`compositor frames  : ${pk.framesSeen}  (rVFC; 0 would make the next check vacuous)`);
console.log(`visible-unpresented: ${pk.visibleUnpresented}  (must be 0 — checked against rVFC)`);
console.log(`visible-unsettled  : ${pk.visibleUnsettled}  (same check vs our own flag, for comparison)`);
console.log(`posters before scroll: ${report.postersBeforeScroll}  (must be 1 — resource timing, independent of runtime flags)`);
console.log(`Range requests    : ${rangeRequests}`);

// In stream mode the runtime seeks over HTTP, so the dense-GOP range behaviour
// must actually have been exercised -- otherwise this run proves nothing about it.
if (STRATEGY === "stream" && rangeRequests === 0) {
  fail("stream run served zero Range requests — the range path was not exercised");
}

if (!report.pass) {
  console.error(`\nFAIL (${report.failures.length}):`);
  for (const f of report.failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log("\nok  all runtime invariants held in a real browser");
