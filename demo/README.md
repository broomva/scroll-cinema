# demo assets

`demo/assets/` is **gitignored and not shipped**. The clips this runtime was
reverse-engineered and validated against come from a repository published with
`"license": null`, so they stay on the developer's disk rather than being
vendored here.

Point the demo at any conforming set — `N` clips plus `N + 1` stills, named so
they sort in narrative order:

```bash
scripts/link-demo-assets.sh /path/to/media
#   expects <media>/video/*.mp4 and <media>/stills/*.webp
```

Then:

```bash
bun run dogfood     # build + drive in headless Chrome, assert invariants
```

If you have no assets at hand, produce a synthetic set with ffmpeg — the
self-test only cares that clips decode and seek, not what they depict:

```bash
mkdir -p /tmp/sc/{video,stills}
for i in 1 2 3; do
  ffmpeg -y -f lavfi -i "testsrc=size=1600x900:rate=24:duration=8" \
    -c:v libx264 -g 8 -keyint_min 8 -sc_threshold 0 -crf 23 \
    -pix_fmt yuv420p -movflags +faststart /tmp/sc/video/0$i-clip.mp4
done
for i in 1 2 3 4; do
  ffmpeg -y -f lavfi -i "testsrc=size=1600x900" -frames:v 1 /tmp/sc/stills/0$i-still.webp
done
scripts/link-demo-assets.sh /tmp/sc
```

Note the demo hardcodes the reference filenames in `demo/main.ts`; adjust the
`CLIPS` and `POSTERS` arrays to match your set.
