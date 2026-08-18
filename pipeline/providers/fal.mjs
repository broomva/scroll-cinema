/**
 * fal.ai provider — Nano Banana Pro for stills, Kling image-to-video for clips.
 *
 * API shapes verified against the vendor docs on 2026-08-18:
 *   - auth header:  `Authorization: Key $FAL_KEY`
 *   - queue:        POST https://queue.fal.run/{model}
 *                   GET  https://queue.fal.run/{model}/requests/{id}/status
 *                   GET  https://queue.fal.run/{model}/requests/{id}
 *                   statuses: IN_QUEUE | IN_PROGRESS | COMPLETED
 *   - kling i2v:    `image_url` (start), `tail_image_url` (end, optional),
 *                   `prompt`, `negative_prompt`, `duration` ("5" | "10"),
 *                   `cfg_scale`; output `{ video: { url } }`
 *
 * `tail_image_url` is the whole reason this provider is wired the way it is:
 * it pins the END of the generated motion to an authored still, which is what
 * bounds drift and makes each seam a crossfade between converging frames.
 *
 * NOT EXECUTED IN CI. There is no key in the build environment, so this adapter
 * is exercised only by `--dry-run` (which asserts the request bodies it would
 * send). Treat a first live run as unverified and check the dry-run output
 * against the current vendor schema before spending money on a long storyboard.
 */

import { writeFile } from "node:fs/promises";

const QUEUE = "https://queue.fal.run";

export const name = "fal";
export const supportsLastFrame = true;
export const requiresKey = true;
export const keyEnv = "FAL_KEY";

const DEFAULTS = {
  imageModel: "fal-ai/nano-banana-pro",
  videoModel: "fal-ai/kling-video/v2.1/pro/image-to-video",
};

function auth() {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("fal provider: FAL_KEY is not set");
  return { Authorization: `Key ${key}`, "Content-Type": "application/json" };
}

/** Submit to the queue and poll until COMPLETED. */
async function submit(model, body, { pollMs = 3000, timeoutMs = 600_000 } = {}) {
  const res = await fetch(`${QUEUE}/${model}`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`fal submit ${model}: HTTP ${res.status} ${await res.text()}`);
  const { request_id } = await res.json();
  if (!request_id) throw new Error(`fal submit ${model}: no request_id in response`);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`fal ${model}: timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, pollMs));
    const s = await fetch(`${QUEUE}/${model}/requests/${request_id}/status`, { headers: auth() });
    if (!s.ok) throw new Error(`fal status: HTTP ${s.status}`);
    const { status } = await s.json();
    if (status === "COMPLETED") break;
    if (status !== "IN_QUEUE" && status !== "IN_PROGRESS") {
      throw new Error(`fal ${model}: unexpected status ${status}`);
    }
  }

  const out = await fetch(`${QUEUE}/${model}/requests/${request_id}`, { headers: auth() });
  if (!out.ok) throw new Error(`fal result: HTTP ${out.status}`);
  return out.json();
}

async function download(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fal download: HTTP ${res.status} for ${url}`);
  await writeFile(outPath, Buffer.from(await res.arrayBuffer()));
}

export async function image({ prompt, negative, width, height, outPath, dryRun, models = {} }) {
  const model = models.image ?? DEFAULTS.imageModel;
  const body = {
    prompt,
    ...(negative ? { negative_prompt: negative } : {}),
    aspect_ratio: aspectOf(width, height),
    num_images: 1,
  };
  if (dryRun) return { path: outPath, dryRun: true, model, body };

  const result = await submit(model, body);
  const url = result?.images?.[0]?.url ?? result?.image?.url;
  if (!url) throw new Error(`fal ${model}: no image url in result: ${JSON.stringify(result).slice(0, 300)}`);
  await download(url, outPath);
  return { path: outPath, provider: name, model, sourceUrl: url };
}

export async function video({
  firstFrameUrl,
  lastFrameUrl,
  prompt,
  negative,
  seconds,
  outPath,
  dryRun,
  models = {},
}) {
  const model = models.video ?? DEFAULTS.videoModel;
  // Kling accepts only "5" or "10". Anything else is silently coerced by the
  // vendor, so coerce explicitly here and let the caller see it in the manifest.
  const duration = Number(seconds) >= 8 ? "10" : "5";
  const body = {
    prompt,
    image_url: firstFrameUrl,
    tail_image_url: lastFrameUrl,
    duration,
    ...(negative ? { negative_prompt: negative } : {}),
  };
  if (dryRun) return { path: outPath, dryRun: true, model, body, coercedDuration: duration };

  if (!/^https?:/.test(firstFrameUrl ?? "") || !/^https?:/.test(lastFrameUrl ?? "")) {
    throw new Error(
      "fal provider needs PUBLIC URLs for the start/end stills. Upload them first " +
        "(fal storage, R2, S3) and pass --frame-base-url, or use --provider mock.",
    );
  }

  const result = await submit(model, body);
  const url = result?.video?.url;
  if (!url) throw new Error(`fal ${model}: no video.url in result: ${JSON.stringify(result).slice(0, 300)}`);
  await download(url, outPath);
  return { path: outPath, provider: name, model, sourceUrl: url, duration };
}

function aspectOf(w, h) {
  const r = w / h;
  if (Math.abs(r - 16 / 9) < 0.05) return "16:9";
  if (Math.abs(r - 9 / 16) < 0.05) return "9:16";
  if (Math.abs(r - 1) < 0.05) return "1:1";
  return "16:9";
}
