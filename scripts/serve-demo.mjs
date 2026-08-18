#!/usr/bin/env node
/**
 * serve-demo.mjs — serve the demo so a human can actually scroll it.
 *
 * The dogfood harness had the only static server in the repo, and it exits as
 * soon as its self-test finishes. Range support matters here: without 206
 * responses the browser cannot seek within a clip, which is the entire effect.
 *
 *   bun run demo:serve            # then open the printed URL and scroll
 */

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const DEMO = resolve(new URL("../demo", import.meta.url).pathname);
const PORT = Number(process.env.PORT ?? 8899);

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mp4": "video/mp4",
  ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".css": "text/css", ".json": "application/json",
};

if (!existsSync(join(DEMO, "dist", "demo.js"))) {
  console.error("demo/dist/demo.js missing — run `bun run demo:build` first");
  process.exit(1);
}
if (!existsSync(join(DEMO, "assets"))) {
  console.error("demo/assets missing — run `scripts/link-demo-assets.sh <dir>` first");
  process.exit(1);
}

createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  const rel = normalize(url === "/" ? "/index.html" : url).replace(/^(\.\.[/\\])+/, "");
  const file = join(DEMO, rel);
  if (!file.startsWith(DEMO) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  const body = readFileSync(file);
  const type = TYPES[extname(file)] ?? "application/octet-stream";

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range) {
    const start = range[1] === "" ? body.length - Number(range[2]) : Number(range[1]);
    const end = range[1] === "" || range[2] === "" ? body.length - 1 : Number(range[2]);
    if (!Number.isFinite(start) || start < 0 || start > end || end >= body.length) {
      res.writeHead(416, { "content-range": `bytes */${body.length}` }).end();
      return;
    }
    res.writeHead(206, {
      "content-type": type, "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end}/${body.length}`,
      "content-length": end - start + 1,
    });
    res.end(body.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": body.length });
  res.end(body);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`\n  scroll-cinema demo → http://localhost:${PORT}\n`);
  console.log("  scroll slowly; the page is 650vh so the camera moves with you.");
  console.log("  ctrl-c to stop.\n");
});
