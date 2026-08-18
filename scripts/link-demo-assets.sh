#!/usr/bin/env bash
#
# link-demo-assets.sh — point the demo at a local clip set for dogfooding.
#
# Assets are never committed: the reference clips this runtime was validated
# against come from a repository published with no license, so they stay on the
# developer's disk. Supply any conforming set instead -- N clips plus N+1
# stills, named so they sort in narrative order.
#
#   scripts/link-demo-assets.sh /path/to/media
#
# expects <src>/video/*.mp4 and <src>/stills/*.webp
#
set -euo pipefail

SRC="${1:-}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/demo/assets"

[ -n "$SRC" ] || { echo "usage: $0 <media-dir>" >&2; exit 2; }
[ -d "$SRC/video" ]  || { echo "missing $SRC/video" >&2; exit 2; }
[ -d "$SRC/stills" ] || { echo "missing $SRC/stills" >&2; exit 2; }

mkdir -p "$DEST"
ln -sfn "$(cd "$SRC/video" && pwd)"  "$DEST/video"
ln -sfn "$(cd "$SRC/stills" && pwd)" "$DEST/stills"

# A pipeline-generated set carries a manifest; the demo prefers it over its
# built-in fallback list, so link it too or the demo silently uses the wrong set.
if [ -f "$SRC/cinema.manifest.json" ]; then
  ln -sfn "$(cd "$SRC" && pwd)/cinema.manifest.json" "$DEST/cinema.manifest.json"
  echo "linked cinema.manifest.json"
fi

clips=$(find -L "$DEST/video" -name '*.mp4' | wc -l | tr -d ' ')
stills=$(find -L "$DEST/stills" -name '*.webp' | wc -l | tr -d ' ')
echo "linked $clips clips and $stills stills into demo/assets"
[ "$stills" -eq $((clips + 1)) ] || echo "warning: expected $((clips + 1)) stills for $clips clips"
