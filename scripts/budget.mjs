#!/usr/bin/env node
/**
 * budget.mjs — assert an asset set stays inside the interaction budget.
 *
 * The reference implementation this package replaces blocked first interaction
 * on 43.8 MB, because it fetched every clip before enabling scroll. The whole
 * point of the two-decoder runtime is that interaction costs one poster and
 * resident memory is bounded. This gate makes both machine-checkable so the
 * property cannot silently regress.
 *
 * Usage:
 *   node scripts/budget.mjs --clips 'dist/*.mp4' --posters 'stills/*.webp'
 *   node scripts/budget.mjs --clips ... --posters ... --max-resident 3 --first-interaction-kb 400
 *
 * Exits non-zero when a budget is exceeded.
 */

import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

/**
 * A silently-NaN budget disables the check it configures: `.slice(0, NaN)`
 * selects nothing and the gate then passes at 0 MB. Reject rather than coerce.
 */
const num = (name, fallback, { integer = false } = {}) => {
  const raw = opt(name, null);
  if (raw === null) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0 || (integer && !Number.isInteger(v))) {
    console.error(`budget: --${name} must be a positive ${integer ? "integer" : "number"}, got "${raw}"`);
    process.exit(2);
  }
  return v;
};

const clipGlob = opt("clips", null);
const posterGlob = opt("posters", null);
const maxResident = num("max-resident", 3, { integer: true });
const firstInteractionKb = num("first-interaction-kb", 400);
const residentMb = num("resident-mb", 40);

if (!clipGlob || !posterGlob) {
  console.error("usage: budget.mjs --clips '<glob>' --posters '<glob>'");
  process.exit(2);
}

/** Minimal glob: directory + `*` + extension. Avoids a dependency for one job. */
function expand(pattern) {
  const dir = dirname(pattern);
  const pat = basename(pattern);
  const [prefix, suffix] = pat.split("*");
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    console.error(`budget: cannot read directory ${dir}`);
    process.exit(2);
  }
  return entries
    .filter((f) => f.startsWith(prefix ?? "") && f.endsWith(suffix ?? ""))
    .sort()
    .map((f) => join(dir, f));
}

const clips = expand(clipGlob);
const posters = expand(posterGlob);

if (clips.length === 0) {
  console.error(`budget: no clips matched ${clipGlob}`);
  process.exit(2);
}
if (posters.length !== clips.length + 1) {
  console.error(
    `budget: expected ${clips.length + 1} posters for ${clips.length} clips, found ${posters.length}`,
  );
  process.exit(1);
}

const size = (f) => statSync(f).size;
const clipSizes = clips.map(size);
const posterSizes = posters.map(size);

// First interaction costs exactly ONE poster: the runtime assigns poster.src
// only from the first tick, using the real scroll position, so a deep link does
// not pay for poster 0 and then discard it. The worst case is therefore the
// LARGEST poster -- budgeting only poster 0 would let a heavy poster elsewhere
// in the chain pass unnoticed.
const firstInteraction = Math.max(...posterSizes);

// Worst case memory is the largest `maxResident` clips held at once.
const worstResident = [...clipSizes]
  .sort((a, b) => b - a)
  .slice(0, maxResident)
  .reduce((a, b) => a + b, 0);

const total = clipSizes.concat(posterSizes).reduce((a, b) => a + b, 0);
const mb = (b) => (b / 1e6).toFixed(2);
const kb = (b) => (b / 1e3).toFixed(1);

const checks = [
  {
    name: `first interaction <= ${firstInteractionKb} KB`,
    actual: `${kb(firstInteraction)} KB (largest of ${posterSizes.length} posters; exactly one is fetched)`,
    pass: firstInteraction <= firstInteractionKb * 1e3,
  },
  {
    name: `worst-case resident (${maxResident} clips) <= ${residentMb} MB`,
    actual: `${mb(worstResident)} MB`,
    pass: worstResident <= residentMb * 1e6,
  },
];

console.log(`clips   ${clips.length}  total ${mb(clipSizes.reduce((a, b) => a + b, 0))} MB`);
console.log(`posters ${posters.length}  total ${mb(posterSizes.reduce((a, b) => a + b, 0))} MB`);
console.log(`payload ${mb(total)} MB (all assets, lazily fetched)\n`);

let failed = 0;
for (const c of checks) {
  console.log(`${c.pass ? "ok  " : "FAIL"} ${c.name}\n       actual: ${c.actual}`);
  if (!c.pass) failed++;
}

process.exit(failed > 0 ? 1 : 0);
