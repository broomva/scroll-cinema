/**
 * Google Gemini provider — Gemini image models for stills, Veo 3.1 for clips.
 *
 * Verified against the LIVE API on 2026-08-18 with a real key:
 *   image  POST /v1beta/models/{m}:generateContent
 *          -> candidates[0].content.parts[].inlineData{mimeType,data}
 *   video  POST /v1beta/models/{m}:predictLongRunning
 *          instances[0].{prompt, image, lastFrame}   <- BOTH endpoints, inline
 *          parameters{aspectRatio, durationSeconds, resolution}
 *          -> operation.name; poll GET /v1beta/{name} until `done`
 *          -> response.generateVideoResponse.generatedSamples[0].video.uri
 *
 * `instances[0].lastFrame` is the reason this provider exists: Veo 3.1
 * interpolates between two authored frames, which IS the keyframe chain
 * expressed natively. Unlike the fal path it takes inline base64, so stills
 * never have to be uploaded to public URLs first.
 *
 * Note on credentials: the Gemini-CLI / Antigravity OAuth token does NOT work
 * here -- it returns 403 "insufficient authentication scopes" against this
 * endpoint (verified 2026-08-18). Veo through a Google AI Pro/Ultra
 * subscription is surfaced in Flow, a web UI, not an API. Automated generation
 * requires a pay-as-you-go GEMINI_API_KEY.
 *
 * COSTS REAL MONEY: Veo 3.1 lite $0.05/s @720p, fast $0.10/s, standard $0.40/s;
 * Gemini 2.5 Flash Image $0.039/image. The builder prints an estimate first.
 */

import { readFile, writeFile } from "node:fs/promises";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export const name = "gemini";
/**
 * Veo 3.1 exposes `lastFrame` in its schema but the capability is gated: all
 * three tiers return 400 "Your use case is currently not supported" when it is
 * present, while the identical request without it succeeds (verified across
 * lite/fast/standard, 2026-08-18). The pipeline therefore falls back to forward
 * chaining for this provider.
 */
export const supportsLastFrame = false;
export const requiresKey = true;
export const keyEnv = "GEMINI_API_KEY";

const DEFAULTS = {
  imageModel: "gemini-2.5-flash-image",
  videoModel: "veo-3.1-lite-generate-preview",
};

/** USD per second at 720p / per image — used for the pre-flight estimate. */
export const VIDEO_RATE = {
  "veo-3.1-generate-preview": 0.4,
  "veo-3.1-fast-generate-preview": 0.1,
  "veo-3.1-lite-generate-preview": 0.05,
};
export const IMAGE_RATE = {
  "gemini-2.5-flash-image": 0.039,
  "gemini-3-pro-image": 0.134,
  "gemini-3-pro-image-preview": 0.134,
};
export const defaults = DEFAULTS;

/** Veo accepts a discrete set of durations; snapping is explicit so a run
 *  cannot silently cost more seconds than the storyboard asked for. */
export const snapDuration = (s) =>
  [4, 6, 8].reduce((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a));

function headers() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("gemini provider: GEMINI_API_KEY is not set");
  return { "x-goog-api-key": key, "Content-Type": "application/json" };
}

function aspectOf(w, h) {
  const r = w / h;
  if (Math.abs(r - 9 / 16) < 0.06) return "9:16";
  return "16:9";
}

export async function image({ prompt, negative, width, height, outPath, dryRun, models = {} }) {
  const model = models.image ?? DEFAULTS.imageModel;
  const text = negative ? `${prompt}\n\nAvoid: ${negative}` : prompt;
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: { imageConfig: { aspectRatio: aspectOf(width, height) } },
  };
  if (dryRun) return { path: outPath, dryRun: true, model, aspectRatio: aspectOf(width, height) };

  const res = await fetch(`${BASE}/models/${model}:generateContent`, {
    method: "POST", headers: headers(), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`gemini image: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const part = json?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) {
    // A safety block returns 200 with no image; surface why rather than crash later.
    const reason = json?.candidates?.[0]?.finishReason ?? "unknown";
    throw new Error(`gemini image: no image returned (finishReason=${reason})`);
  }
  await writeFile(outPath, Buffer.from(part.inlineData.data, "base64"));
  return { path: outPath, provider: name, model, mimeType: part.inlineData.mimeType };
}

/**
 * predictLongRunning takes `bytesBase64Encoded`, NOT the `inlineData` shape used
 * by generateContent. The published doc example shows `inlineData` and the live
 * API rejects it with 400 "`inlineData` isn't supported by this model"
 * (observed 2026-08-18) -- the two Gemini surfaces do not share an image schema.
 */
const inline = async (p) => ({
  bytesBase64Encoded: (await readFile(p)).toString("base64"),
  mimeType: /\.jpe?g$/i.test(p) ? "image/jpeg" : "image/png",
});

export async function video({
  firstFrame, lastFrame, prompt, negative, seconds, width, height, outPath, dryRun,
  models = {}, pollMs = 10_000, timeoutMs = 900_000, onProgress, allowNegative = false,
}) {
  const model = models.video ?? DEFAULTS.videoModel;
  const dur = snapDuration(seconds);
  const parameters = {
    aspectRatio: aspectOf(width, height),
    // NUMBER, not a string. The published example shows "8" and the live API
    // rejects it: 400 "The value type for `durationSeconds` needs to be a
    // number" (observed 2026-08-18).
    durationSeconds: dur,
    resolution: "720p",
    // `negativePrompt` is NOT accepted by veo-3.1-lite (400 "isn't supported by
    // this model", observed 2026-08-18) even though it is documented for the
    // family. Opt in per storyboard rather than assume, since which models take
    // it is not something this adapter can enumerate without spending to find out.
    ...(negative && allowNegative ? { negativePrompt: negative } : {}),
  };
  if (dryRun) {
    return {
      path: outPath, dryRun: true, model, snappedDuration: dur, parameters,
      instances: [{ prompt, image: `<inline ${firstFrame}>`, ...(lastFrame ? { lastFrame: `<inline ${lastFrame}>` } : {}) }],
    };
  }

  const body = {
    instances: [
      {
        prompt,
        image: await inline(firstFrame),
        // Omitted entirely in forward mode -- and sending it at all is what
        // trips the capability gate on every Veo 3.1 tier.
        ...(lastFrame ? { lastFrame: await inline(lastFrame) } : {}),
      },
    ],
    parameters,
  };
  const res = await fetch(`${BASE}/models/${model}:predictLongRunning`, {
    method: "POST", headers: headers(), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`veo submit: HTTP ${res.status} ${(await res.text()).slice(0, 400)}`);
  const op = await res.json();
  if (!op.name) throw new Error(`veo submit: no operation name (${JSON.stringify(op).slice(0, 200)})`);

  const deadline = Date.now() + timeoutMs;
  let done;
  for (let i = 0; ; i++) {
    if (Date.now() > deadline) throw new Error(`veo: timed out after ${timeoutMs / 1000}s (op ${op.name})`);
    await new Promise((r) => setTimeout(r, pollMs));
    const s = await fetch(`${BASE}/${op.name}`, { headers: headers() });
    if (!s.ok) throw new Error(`veo poll: HTTP ${s.status}`);
    done = await s.json();
    onProgress?.((i + 1) * (pollMs / 1000));
    if (done.done) break;
  }
  if (done.error) throw new Error(`veo: ${JSON.stringify(done.error).slice(0, 400)}`);

  const uri = done?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
  if (!uri) throw new Error(`veo: no video uri (${JSON.stringify(done.response ?? {}).slice(0, 400)})`);

  const dl = await fetch(uri, { headers: { "x-goog-api-key": process.env.GEMINI_API_KEY } });
  if (!dl.ok) throw new Error(`veo download: HTTP ${dl.status}`);
  await writeFile(outPath, Buffer.from(await dl.arrayBuffer()));
  return { path: outPath, provider: name, model, duration: dur, sourceUri: uri };
}
