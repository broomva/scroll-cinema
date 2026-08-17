#!/usr/bin/env bash
#
# conform.sh — normalize generator output into scrubbable web video.
#
# Ordinary web video cannot be scrubbed: seeking must decode forward from the
# nearest keyframe, and encoders default to a GOP of 48-250 frames. This script
# re-encodes with a dense GOP so worst-case seek decode is bounded by --gop
# frames, then VERIFIES the result rather than trusting that the flags took.
#
# Measured cost of GOP density on high-motion footage (libx264 CRF 19, 8.04s
# clip): GOP 8 = 1.13x the bytes of GOP 48. On low-motion footage the penalty is
# much larger -- run `--ladder` on your own source before budgeting.
#
# Usage:
#   conform.sh --out dist/ src/*.mp4
#   conform.sh --out dist/ --width 960 --height 540 src/*.mp4
#   conform.sh --ladder src/one-clip.mp4       # measure GOP cost, encode nothing
#
set -euo pipefail

GOP=8
FPS=24
WIDTH=1600
HEIGHT=900
CRF=19
PRESET=slow
OUT=""
LADDER=0
VERIFY_ONLY=0
INPUTS=()

die() { printf 'conform: %s\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --gop)    GOP="$2"; shift 2 ;;
    --fps)    FPS="$2"; shift 2 ;;
    --width)  WIDTH="$2"; shift 2 ;;
    --height) HEIGHT="$2"; shift 2 ;;
    --crf)    CRF="$2"; shift 2 ;;
    --preset) PRESET="$2"; shift 2 ;;
    --out)    OUT="$2"; shift 2 ;;
    --ladder) LADDER=1; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    -h|--help) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)       die "unknown flag: $1" ;;
    *)        INPUTS+=("$1"); shift ;;
  esac
done

command -v ffmpeg  >/dev/null || die "ffmpeg not found"
command -v ffprobe >/dev/null || die "ffprobe not found"
command -v python3 >/dev/null || die "python3 not found (needed to parse MP4 atoms)"
[ ${#INPUTS[@]} -gt 0 ] || die "no input files given"

# ---------------------------------------------------------------- ladder mode
# Encode the same source across GOP sizes and report the real bitrate cost, so
# the budget comes from measurement rather than from this script's defaults.
if [ "$LADDER" -eq 1 ]; then
  src="${INPUTS[0]}"
  [ -f "$src" ] || die "no such file: $src"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  printf '%-6s %-12s %-9s %s\n' GOP BYTES MB 'vs GOP 48'
  base=0
  for g in 1 4 8 24 48; do
    ffmpeg -v error -y -i "$src" -an \
      -vf "fps=${FPS},scale=${WIDTH}:${HEIGHT}:flags=lanczos" \
      -c:v libx264 -profile:v high -pix_fmt yuv420p \
      -g "$g" -keyint_min "$g" -sc_threshold 0 \
      -crf "$CRF" -preset medium -movflags +faststart "$tmp/g$g.mp4"
    b=$(wc -c < "$tmp/g$g.mp4" | tr -d ' ')
    [ "$g" = 48 ] && base=$b
  done
  for g in 1 4 8 24 48; do
    b=$(wc -c < "$tmp/g$g.mp4" | tr -d ' ')
    awk -v g="$g" -v b="$b" -v base="$base" \
      'BEGIN{printf "%-6s %-12d %-9.2f %.2fx\n", g, b, b/1000000, (base>0? b/base : 0)}'
  done
  exit 0
fi

if [ "$VERIFY_ONLY" -eq 0 ]; then
  [ -n "$OUT" ] || die "--out is required (or pass --verify-only)"
  mkdir -p "$OUT"
fi

# ------------------------------------------------------------------- verify
# Assert the encode actually has the properties we asked for. A flag that was
# silently ignored is the failure this function exists to catch.
verify() {
  local f="$1" fail=0

  local streams; streams=$(ffprobe -v error -show_entries stream=codec_type -of csv=p=0 "$f" | tr -d ',')
  if printf '%s\n' "$streams" | grep -qx audio; then
    printf '  FAIL audio stream present (expected none)\n'; fail=1
  else
    printf '  ok   no audio stream\n'
  fi

  local dims; dims=$(ffprobe -v error -select_streams v:0 \
    -show_entries stream=width,height -of csv=p=0 "$f")
  if [ "$dims" = "${WIDTH},${HEIGHT}" ]; then
    printf '  ok   %sx%s\n' "$WIDTH" "$HEIGHT"
  else
    printf '  FAIL dimensions %s (expected %sx%s)\n' "$dims" "$WIDTH" "$HEIGHT"; fail=1
  fi

  local fps_actual
  fps_actual=$(ffprobe -v error -select_streams v:0 \
    -show_entries stream=r_frame_rate -of csv=p=0 "$f" | tr -d ',')
  if awk -v a="$fps_actual" -v want="$FPS" \
       'BEGIN{split(a,p,"/"); r=(p[2]?p[1]/p[2]:p[1]); exit !(r>want-0.01 && r<want+0.01)}'; then
    printf '  ok   %s fps\n' "$FPS"
  else
    printf '  FAIL frame rate %s (expected %s)\n' "$fps_actual" "$FPS"; fail=1
  fi

  # Worst-case seek cost is the largest run of NON-keyframes, which includes the
  # run before the first keyframe and the run after the last. Measuring only the
  # gaps BETWEEN keyframes would pass a file whose entire tail is predicted
  # frames. Uses the real `key_frame` flag: pict_type=I is not the same thing
  # (an I-frame need not be a seekable sync sample).
  local maxgap
  maxgap=$(ffprobe -v error -select_streams v:0 -show_entries frame=key_frame \
    -of csv=p=0 "$f" | tr -d ',' \
    | awk 'BEGIN{last=-1;max=0;n=0}
           {if($1==1){ if(last<0){ if(n>max) max=n } else { d=n-last-1; if(d>max) max=d } last=n } n++}
           END{ if(last<0){ print n+0 } else { d=n-1-last; if(d>max) max=d; print max+0 } }')
  local decode_cost=$((maxgap + 1))
  if [ "$decode_cost" -le "$GOP" ]; then
    printf '  ok   worst-case seek decode %s frames (<= %s)\n' "$decode_cost" "$GOP"
  else
    printf '  FAIL worst-case seek decode %s frames (expected <= %s)\n' "$decode_cost" "$GOP"; fail=1
  fi

  # moov must precede mdat or the browser cannot seek without fetching the tail.
  # Walk the real top-level atom table: grepping bytes would be fooled by the
  # string "moov" appearing anywhere inside mdat payload.
  local order
  order=$(python3 - "$f" <<'PY'
import struct, sys
path = sys.argv[1]
out = []
with open(path, "rb") as fh:
    off = 0
    while True:
        fh.seek(off)
        hdr = fh.read(8)
        if len(hdr) < 8:
            break
        size = struct.unpack(">I", hdr[:4])[0]
        typ = hdr[4:8].decode("latin1", "replace")
        out.append(typ)
        # Stop as soon as the ordering question is answered, not at a fixed count.
        if "moov" in out and "mdat" in out:
            break
        if size == 1:
            ext = fh.read(8)
            if len(ext) < 8:
                break
            size = struct.unpack(">Q", ext)[0]
        elif size == 0:
            break
        if size < 8:
            break
        off += size
print(" ".join(out))
PY
)
  case " $order " in
    *" moov "*)
      if [ "${order%%mdat*}" != "$order" ] && \
         [ "$(printf '%s' "$order" | awk '{for(i=1;i<=NF;i++){if($i=="moov"){print i; exit}}}')" -gt \
           "$(printf '%s' "$order" | awk '{for(i=1;i<=NF;i++){if($i=="mdat"){print i; exit}}}')" ]; then
        printf '  FAIL not faststart (moov after mdat: %s)\n' "$order"; fail=1
      else
        printf '  ok   faststart (atoms: %s)\n' "$order"
      fi
      ;;
    *) printf '  FAIL no moov atom found (atoms: %s)\n' "$order"; fail=1 ;;
  esac

  return $fail
}

# -------------------------------------------------------------- verify-only
# Audit existing assets against the same assertions the encoder applies. Also
# the polarity check for `verify` itself: run it on non-conforming input and it
# must report failures, or the checks above prove nothing.
if [ "$VERIFY_ONLY" -eq 1 ]; then
  status=0
  for src in "${INPUTS[@]}"; do
    [ -f "$src" ] || die "no such file: $src"
    printf '\n%s\n' "$src"
    verify "$src" || status=1
  done
  exit $status
fi

# ------------------------------------------------------------------- encode
status=0
for src in "${INPUTS[@]}"; do
  [ -f "$src" ] || die "no such file: $src"
  dst="$OUT/$(basename "${src%.*}").mp4"
  printf '\n%s -> %s\n' "$src" "$dst"

  ffmpeg -v error -y -i "$src" -an \
    -vf "fps=${FPS},scale=${WIDTH}:${HEIGHT}:flags=lanczos" \
    -c:v libx264 -profile:v high -pix_fmt yuv420p \
    -g "$GOP" -keyint_min "$GOP" -sc_threshold 0 \
    -crf "$CRF" -preset "$PRESET" \
    -movflags +faststart "$dst"

  if verify "$dst"; then
    awk -v b="$(wc -c < "$dst" | tr -d ' ')" \
      'BEGIN{printf "  ->   %.2f MB\n", b/1000000}'
  else
    printf '  encode did not meet spec\n'; status=1
  fi
done

exit $status
