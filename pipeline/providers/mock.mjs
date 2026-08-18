/**
 * mock provider — synthesizes real assets with ffmpeg. No network, no API key.
 *
 * This exists so the ENTIRE pipeline is verifiable offline and in CI. A
 * generation pipeline that can only be exercised with a metered API key is a
 * pipeline nobody runs, and one whose wiring bugs surface in production. The
 * clips it produces are deliberately ugly but structurally exact: clip i starts
 * on still i and ends on still i+1, so the keyframe-chain invariant can be
 * measured rather than assumed.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Deterministic colour per prompt, so scenes are visually distinct and stable. */
function paletteFor(text) {
  const h = createHash("sha256").update(text).digest();
  const hex = (i) => h[i].toString(16).padStart(2, "0");
  return { a: `0x${hex(0)}${hex(1)}${hex(2)}`, b: `0x${hex(3)}${hex(4)}${hex(5)}` };
}

export const name = "mock";
export const requiresKey = false;

export async function image({ prompt, width, height, outPath, dryRun }) {
  const { a, b } = paletteFor(prompt);
  const label = prompt.slice(0, 28).replace(/[':\\%]/g, " ");
  const args = [
    "-v", "error", "-y",
    "-f", "lavfi",
    "-i", `gradients=s=${width}x${height}:c0=${a}:c1=${b}:type=radial:duration=1`,
    "-frames:v", "1",
    "-vf", `drawtext=text='${label}':fontsize=${Math.round(height / 14)}:fontcolor=white@0.85:x=(w-tw)/2:y=(h-th)/2:borderw=3:bordercolor=black@0.6`,
    outPath,
  ];
  if (dryRun) return { path: outPath, dryRun: true, cmd: `ffmpeg ${args.join(" ")}` };
  await run("ffmpeg", args);
  return { path: outPath, provider: name };
}

export async function video({ firstFrame, lastFrame, seconds, fps, outPath, dryRun }) {
  // Normalise by the LAST frame's timestamp, not the duration: the final frame
  // sits at (seconds - 1/fps), so dividing by `seconds` would leave the clip a
  // fraction short of its end keyframe and blur the very invariant we verify.
  const lastT = (seconds - 1 / fps).toFixed(6);
  const args = [
    "-v", "error", "-y",
    "-loop", "1", "-t", String(seconds), "-i", firstFrame,
    "-loop", "1", "-t", String(seconds), "-i", lastFrame,
    "-filter_complex",
    `[0:v][1:v]blend=all_expr='A*(1-min(T/${lastT},1))+B*min(T/${lastT},1)',fps=${fps},format=yuv420p[v]`,
    "-map", "[v]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-movflags", "+faststart",
    outPath,
  ];
  if (dryRun) return { path: outPath, dryRun: true, cmd: `ffmpeg ${args.join(" ")}` };
  await run("ffmpeg", args);
  return { path: outPath, provider: name };
}
