#!/usr/bin/env python3
"""
Measure the keyframe-chain invariant.

Clip i must START on still i and END on still i+1 -- that is what bounds
generative drift to one segment and makes every seam a crossfade between
converging frames. A generator that quietly ignored the end-frame parameter
would still produce plausible clips that pass every other gate in this repo, so
the property is measured here rather than assumed.

Method is deliberately the same one that discovered the pattern in the original
tea-leaf assets: downscale to 64x36 and compare RMSE against EVERY still, then
require the predicted match to win by a clear margin. Absolute RMSE alone is not
enough -- a washed-out clip could sit close to everything.

    chain_rmse.py <frames-dir> <clip-count>
"""
import sys, os

try:
    from PIL import Image
except ImportError:
    print("chain_rmse: Pillow not installed (pip install Pillow) — SKIPPED, not verified")
    sys.exit(0)

MAX_RMSE = 26.0   # a real endpoint match; codec + resample noise sits well under this
MIN_RATIO = 2.0   # predicted match must beat the runner-up by at least this factor


def load(path, size=(64, 36)):
    return Image.open(path).convert("RGB").resize(size)


def rmse(a, b):
    pa, pb = a.load(), b.load()
    total = n = 0
    for x in range(a.size[0]):
        for y in range(a.size[1]):
            for c in range(3):
                total += (pa[x, y][c] - pb[x, y][c]) ** 2
                n += 1
    return (total / n) ** 0.5


def main():
    d, count = sys.argv[1], int(sys.argv[2])
    stills = [load(os.path.join(d, f"s{i}.png")) for i in range(count + 1)]

    print(f"--- keyframe chain ({count} clips vs {count + 1} stills) ---")
    print(f"{'clip':<6}{'first -> still':<22}{'last -> still':<22}{'verdict'}")
    failures = 0

    for i in range(count):
        row = []
        for end, expect in (("first", i), ("last", i + 1)):
            frame = load(os.path.join(d, f"c{i}-{end}.png"))
            scores = sorted((rmse(frame, s), j) for j, s in enumerate(stills))
            best_v, best_j = scores[0]
            second_v = scores[1][0]
            ok = best_j == expect and best_v <= MAX_RMSE and second_v >= best_v * MIN_RATIO
            if not ok:
                failures += 1
            row.append((f"{best_j} ({best_v:.1f}, next {second_v:.1f})", ok, expect, best_j))
        (a_txt, a_ok, a_exp, a_got), (b_txt, b_ok, b_exp, b_got) = row
        verdict = "ok" if (a_ok and b_ok) else "FAIL"
        print(f"{i:<6}{a_txt:<22}{b_txt:<22}{verdict}")
        if not a_ok:
            print(f"       ^ first frame expected still {a_exp}, matched {a_got}")
        if not b_ok:
            print(f"       ^ last frame expected still {b_exp}, matched {b_got}")

    print(
        f"\n{'FAIL' if failures else 'ok  '}  chain endpoints: "
        f"{2 * count - failures}/{2 * count} matched their authored still"
    )
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
