#!/usr/bin/env node
/**
 * cinema.mjs — storyboard -> stills -> first/last-frame clips -> conform -> verify.
 *
 * Closes the loop that the runtime alone leaves open. The output layout is
 * exactly what `scripts/link-demo-assets.sh` expects, so a generated set drops
 * straight into the dogfood harness:
 *
 *   <out>/stills/NN-id.<ext>     N+1 authored keyframes (also posters, also
 *                                the entire reduced-motion experience)
 *   <out>/raw/NN-a-to-b.mp4      provider output, unconformed
 *   <out>/video/NN-a-to-b.mp4    dense-GOP, scrubbable
 *   <out>/cinema.manifest.json   ready to paste into createScrollCinema
 *
 * Commands:
 *   build <storyboard.json>   generate + conform (resumable; --force to redo)
 *   verify <dir>              measure the keyframe-chain invariant + gates
 *   manifest <dir>            print the clips/posters arrays
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = resolve(new URL("..", import.meta.url).pathname);

const argv = process.argv.slice(2);
const cmd = argv[0];
const positional = argv.slice(1).filter((a) => !a.startsWith("--"));
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const die = (m) => {
  console.error(`cinema: ${m}`);
  process.exit(1);
};
const pad = (i) => String(i + 1).padStart(2, "0");

// ---------------------------------------------------------------- storyboard
const DEFAULTS = { width: 1600, height: 900, fps: 24, seconds: 5, gop: 8 };

function loadStoryboard(path) {
  if (!existsSync(path)) die(`no such storyboard: ${path}`);
  let sb;
  try {
    sb = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    die(`storyboard is not valid JSON: ${e.message}`);
  }
  const s = { ...DEFAULTS, ...sb };
  if (!Array.isArray(s.scenes) || s.scenes.length < 2) {
    die("storyboard needs at least 2 scenes (N scenes produce N-1 clips)");
  }
  s.scenes.forEach((sc, i) => {
    if (!sc.id) die(`scene ${i} has no id`);
    if (!sc.image) die(`scene "${sc.id}" has no \`image\` prompt`);
  });

  // Motion prompts are per-GAP, not per-scene. Getting this off by one silently
  // pairs the wrong motion with the wrong transition.
  const gaps = s.scenes.length - 1;
  s.motions = s.motions ?? [];
  if (s.motions.length && s.motions.length !== gaps) {
    die(`storyboard has ${s.motions.length} motions but ${gaps} gaps (scenes - 1)`);
  }
  if (!s.motions.length) {
    console.warn(
      `cinema: no \`motions\` given; using a generic camera move for all ${gaps} gaps.\n` +
        "        Motion prompts want WHAT moves + HOW it moves + HOW the camera behaves\n" +
        "        (~20-40 words, one camera move per shot, never re-describing the image).",
    );
    s.motions = Array.from({ length: gaps }, () => "slow continuous forward dolly, steady pace, no cuts");
  }
  return s;
}

// ------------------------------------------------------------------- build
async function build() {
  const sbPath = positional[0] ?? die("usage: cinema.mjs build <storyboard.json>");
  const sb = loadStoryboard(sbPath);
  const out = resolve(opt("out", "assets"));
  const dryRun = flag("dry-run");
  const force = flag("force");
  const providerName = opt("provider", "mock");

  const provider = await import(`./providers/${providerName}.mjs`).catch(() =>
    die(`unknown provider "${providerName}" (have: mock, fal)`),
  );
  if (provider.requiresKey && !process.env[provider.keyEnv] && !dryRun) {
    die(`provider "${providerName}" needs ${provider.keyEnv} in the environment`);
  }

  // Pre-flight cost estimate. A metered provider must never start spending
  // without first saying what it is about to spend -- and `--yes` is required
  // so an accidental invocation cannot quietly bill a long storyboard.
  if (!dryRun && provider.requiresKey && provider.VIDEO_RATE) {
    const vModel = sb.models?.video ?? provider.defaults?.videoModel;
    const iModel = sb.models?.image ?? provider.defaults?.imageModel;
    const secs = provider.snapDuration ? provider.snapDuration(sb.seconds) : sb.seconds;
    const gaps = sb.scenes.length - 1;
    const vCost = (provider.VIDEO_RATE[vModel] ?? 0) * secs * gaps;
    const iCost = (provider.IMAGE_RATE?.[iModel] ?? 0) * sb.scenes.length;
    console.log(
      `\ncost estimate (${providerName}):\n` +
        `  ${sb.scenes.length} stills x ${iModel} = $${iCost.toFixed(2)}\n` +
        `  ${gaps} clips x ${secs}s x ${vModel} = $${vCost.toFixed(2)}\n` +
        `  total ~ $${(vCost + iCost).toFixed(2)}` +
        (secs !== sb.seconds ? `   (duration snapped ${sb.seconds}s -> ${secs}s)` : ""),
    );
    if (!flag("yes")) {
      die("refusing to spend without --yes (or re-run with --dry-run to inspect the requests)");
    }
    console.log("  --yes given, proceeding\n");
  }

  for (const d of ["stills", "raw", "video"]) mkdirSync(join(out, d), { recursive: true });

  // Chain mode. `pinned` authors every still and pins BOTH ends of each clip.
  // `forward` authors only the first still, then adopts each clip's real last
  // frame as the next still -- which keeps the chain invariant exact when a
  // provider cannot accept an end frame, at the cost of art-directing the
  // intermediate keyframes.
  const forward = flag("forward") || provider.supportsLastFrame === false;
  if (forward && !flag("forward")) {
    console.log(
      `\nnote: provider "${providerName}" does not accept an end frame, so the run` +
        "\n      uses FORWARD chaining: still 0 is authored, every later still is the" +
        "\n      previous clip's final frame. Continuity is preserved and the chain" +
        "\n      invariant still holds exactly; intermediate keyframes are not art-directed.",
    );
  }

  const imgExt = providerName === "mock" ? "png" : "jpg";
  const stills = sb.scenes.map((sc, i) => join(out, "stills", `${pad(i)}-${sc.id}.${imgExt}`));
  const raws = sb.scenes.slice(0, -1).map((sc, i) =>
    join(out, "raw", `${pad(i)}-${sc.id}-to-${sb.scenes[i + 1].id}.mp4`),
  );

  const log = [];

  // --- stage 1: keyframes ----------------------------------------------
  // Iterate here, not on the clips: stills are cheap and fast, and image
  // fidelity caps video fidelity.
  const authored = forward ? sb.scenes.slice(0, 1) : sb.scenes;
  console.log(`\n[1/4] keyframes  (${authored.length}${forward ? ` authored, ${sb.scenes.length - 1} derived` : ""})`);
  for (const [i, sc] of authored.entries()) {
    const outPath = stills[i];
    if (existsSync(outPath) && !force) {
      console.log(`  skip  ${basename(outPath)} (exists; --force to redo)`);
      continue;
    }
    const prompt = [sb.style, sc.image].filter(Boolean).join(" — ");
    const r = await provider.image({
      prompt,
      negative: sb.negative,
      width: sb.width,
      height: sb.height,
      outPath,
      dryRun,
      models: sb.models,
    });
    log.push({ stage: "image", scene: sc.id, ...r });
    console.log(`  ${dryRun ? "plan" : "ok  "}  ${basename(outPath)}`);
  }

  // --- stage 2: motion between adjacent keyframes -----------------------
  console.log(`\n[2/4] clips  (${raws.length}, ${forward ? "forward-chained" : "endpoints pinned"})`);
  for (let i = 0; i < raws.length; i++) {
    const outPath = raws[i];
    if (existsSync(outPath) && !force) {
      console.log(`  skip  ${basename(outPath)} (exists; --force to redo)`);
      continue;
    }
    const base = opt("frame-base-url");
    const r = await provider.video({
      firstFrame: stills[i],
      // In forward mode the model is given no end frame; the next still is
      // derived from what it actually produced, below.
      lastFrame: forward ? undefined : stills[i + 1],
      firstFrameUrl: base ? `${base.replace(/\/$/, "")}/${basename(stills[i])}` : undefined,
      lastFrameUrl: base ? `${base.replace(/\/$/, "")}/${basename(stills[i + 1])}` : undefined,
      prompt: sb.motions[i],
      negative: sb.negative,
      seconds: sb.seconds,
      fps: sb.fps,
      width: sb.width,
      height: sb.height,
      outPath,
      dryRun,
      models: sb.models,
      onProgress: (elapsed) => process.stdout.write(`\r  ...   ${basename(outPath)} ${elapsed}s`),
    });
    if (!dryRun) process.stdout.write("\r\x1b[K");

    // Adopt the clip's real final frame as the next keyframe. This is what
    // makes the chain exact without end-frame conditioning: still i+1 is not
    // merely similar to the clip's ending, it IS the clip's ending.
    if (forward && !dryRun && !existsSync(stills[i + 1])) {
      await run("ffmpeg", [
        "-v", "error", "-y", "-sseof", "-0.5", "-i", outPath, "-update", "1", stills[i + 1],
      ]);
      console.log(`  ok    ${basename(stills[i + 1])} (derived from ${basename(outPath)})`);
    }

    log.push({ stage: "video", gap: `${sb.scenes[i].id}->${sb.scenes[i + 1].id}`, ...r });
    console.log(`  ${dryRun ? "plan" : "ok  "}  ${basename(outPath)}`);
  }

  if (dryRun) {
    console.log("\n[dry-run] requests that WOULD be sent:\n");
    console.log(JSON.stringify(log, null, 2));
    return;
  }

  // --- stage 3: conform -------------------------------------------------
  console.log("\n[3/4] conform  (dense GOP, the thing that makes video scrubbable)");
  await run("bash", [
    join(ROOT, "scripts", "conform.sh"),
    "--out", join(out, "video"),
    "--gop", String(sb.gop),
    "--fps", String(sb.fps),
    "--width", String(sb.width),
    "--height", String(sb.height),
    ...raws,
  ]).then(
    ({ stdout }) => process.stdout.write(stdout),
    (e) => {
      process.stdout.write(e.stdout ?? "");
      die("conform failed — the encode did not meet spec");
    },
  );

  // --- stage 4: posters + manifest --------------------------------------
  console.log("\n[4/4] posters + manifest");
  const enc = await posterEncoder();
  console.log(`  using ${enc.note} -> .${enc.ext}`);
  const posters = [];
  for (const s of stills) {
    const dst = join(out, "stills", `${basename(s).replace(/\.[^.]+$/, "")}.${enc.ext}`);
    if (!existsSync(dst) || force) {
      await enc.encode(s, dst).catch((e) => die(`poster encode failed for ${basename(s)}: ${e.message}`));
    }
    posters.push(dst);
  }

  const clips = raws.map((r) => join(out, "video", basename(r)));
  const manifest = {
    title: sb.title ?? basename(sbPath),
    generatedFrom: basename(sbPath),
    provider: providerName,
    width: sb.width, height: sb.height, fps: sb.fps, seconds: sb.seconds, gop: sb.gop,
    posterExt: enc.ext,
    scenes: sb.scenes.map((s) => ({ id: s.id, title: s.title, body: s.body })),
    clips: clips.map((c) => rel(out, c)),
    posters: posters.map((p) => rel(out, p)),
    log,
  };
  const mPath = join(out, "cinema.manifest.json");
  writeFileSync(mPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`  ok    ${rel(out, mPath)}  (${clips.length} clips, ${posters.length} posters)`);

  console.log("\nnext:");
  console.log(`  node pipeline/cinema.mjs verify ${out}`);
  console.log(`  scripts/link-demo-assets.sh ${out} && bun run dogfood`);
}

const rel = (root, p) => p.replace(`${root}/`, "");

/**
 * Pick a poster encoder from what this machine actually has.
 *
 * Poster weight IS the first-interaction budget, so webp is worth reaching for
 * -- but many ffmpeg builds ship webp DECODE without ENCODE (they will happily
 * read a .webp and then fail to write one), so probe rather than assume.
 */
async function posterEncoder() {
  const has = async (bin, args) => {
    try {
      await run(bin, args);
      return true;
    } catch {
      return false;
    }
  };

  if (await has("cwebp", ["-version"])) {
    return {
      ext: "webp",
      note: "cwebp",
      encode: (src, dst) => run("cwebp", ["-quiet", "-q", "82", src, "-o", dst]),
    };
  }
  const { stdout } = await run("ffmpeg", ["-hide_banner", "-encoders"]).catch(() => ({ stdout: "" }));
  if (/\blibwebp\b/.test(stdout)) {
    return {
      ext: "webp",
      note: "ffmpeg libwebp",
      encode: (src, dst) => run("ffmpeg", ["-v", "error", "-y", "-i", src, "-c:v", "libwebp", "-q:v", "82", dst]),
    };
  }
  return {
    ext: "jpg",
    note: "ffmpeg mjpeg (no webp encoder found; posters will be larger)",
    encode: (src, dst) => run("ffmpeg", ["-v", "error", "-y", "-i", src, "-q:v", "4", dst]),
  };
}

// ------------------------------------------------------------------ verify
/**
 * Measure the keyframe chain rather than assume it.
 *
 * This is the same 64x36 RMSE match that discovered the pattern in the original
 * tea-leaf assets: clip i must START on still i and END on still i+1, and by a
 * clear margin over every other still. A generator that ignored `tail_image_url`
 * would still emit plausible-looking clips and pass every other check here.
 */
async function verify() {
  const dir = resolve(positional[0] ?? die("usage: cinema.mjs verify <dir>"));
  const mPath = join(dir, "cinema.manifest.json");
  if (!existsSync(mPath)) die(`no cinema.manifest.json in ${dir} — run \`build\` first`);
  const m = JSON.parse(readFileSync(mPath, "utf8"));

  const tmp = join(dir, ".verify");
  mkdirSync(tmp, { recursive: true });

  const clips = m.clips.map((c) => join(dir, c));
  const posters = m.posters.map((p) => join(dir, p));

  for (const [i, clip] of clips.entries()) {
    await run("ffmpeg", ["-v", "error", "-y", "-i", clip, "-frames:v", "1", join(tmp, `c${i}-first.png`)]);

    // Grab the LAST frame without guessing a time offset: seek to a window at
    // the end, then let every decoded frame overwrite the same output file, so
    // the final one survives. Seeking to (duration - epsilon) instead lands
    // past the last frame whenever epsilon < a frame interval, and ffmpeg then
    // writes nothing at all -- a missing file rather than a failed assertion.
    const lastPath = join(tmp, `c${i}-last.png`);
    await run("ffmpeg", [
      "-v", "error", "-y", "-sseof", "-0.5", "-i", clip,
      "-update", "1", lastPath,
    ]).catch(async () => {
      // Very short clip: -sseof can overshoot the whole file.
      await run("ffmpeg", ["-v", "error", "-y", "-i", clip, "-update", "1", lastPath]);
    });
    if (!existsSync(lastPath)) die(`could not extract the last frame of ${basename(clip)}`);
  }
  for (const [i, p] of posters.entries()) {
    await run("ffmpeg", ["-v", "error", "-y", "-i", p, join(tmp, `s${i}.png`)]);
  }

  // A non-zero exit here is a real verdict, not a crash: surface the report.
  const chain = await run("python3", [
    join(ROOT, "pipeline", "chain_rmse.py"), tmp, String(clips.length),
  ]).catch((e) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "", failed: true }));
  process.stdout.write(chain.stdout);
  if (chain.stderr?.trim()) process.stderr.write(`${chain.stderr}\n`);
  const failed = chain.failed === true || /FAIL/.test(chain.stdout);

  console.log("\n--- encode gate ---");
  await run("bash", [
    join(ROOT, "scripts", "conform.sh"), "--verify-only",
    "--gop", String(m.gop), "--fps", String(m.fps),
    "--width", String(m.width), "--height", String(m.height),
    ...clips,
  ]).then(
    ({ stdout: o }) => process.stdout.write(o),
    (e) => {
      process.stdout.write(e.stdout ?? "");
      process.exitCode = 1;
    },
  );

  console.log("\n--- budget gate ---");
  await run("node", [
    join(ROOT, "scripts", "budget.mjs"),
    "--clips", join(dir, "video", "*.mp4"),
    "--posters", join(dir, "stills", `*.${m.posterExt ?? "webp"}`),
  ]).then(
    ({ stdout: o }) => process.stdout.write(o),
    (e) => {
      process.stdout.write(e.stdout ?? "");
      process.exitCode = 1;
    },
  );

  if (failed) process.exitCode = 1;
  console.log(
    process.exitCode ? "\nFAIL  generated set did not pass every gate" : "\nok    generated set passes every gate",
  );
}

// ---------------------------------------------------------------- manifest
function manifestCmd() {
  const dir = resolve(positional[0] ?? die("usage: cinema.mjs manifest <dir>"));
  const m = JSON.parse(readFileSync(join(dir, "cinema.manifest.json"), "utf8"));
  console.log("const CLIPS = " + JSON.stringify(m.clips, null, 2) + ";\n");
  console.log("const POSTERS = " + JSON.stringify(m.posters, null, 2) + ";\n");
  console.log("const SCENES = " + JSON.stringify(m.scenes, null, 2) + ";");
}

switch (cmd) {
  case "build": await build(); break;
  case "verify": await verify(); break;
  case "manifest": manifestCmd(); break;
  default:
    console.log("usage: cinema.mjs <build|verify|manifest> [...]\n");
    console.log("  build <storyboard.json> [--out DIR] [--provider mock|fal] [--force] [--dry-run]");
    console.log("  verify <DIR>");
    console.log("  manifest <DIR>");
    process.exit(cmd ? 1 : 0);
}
