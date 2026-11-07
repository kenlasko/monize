#!/bin/sh
# Convert the user guide's screenshots to WebP for the backend image's in-app
# help (backend/Dockerfile, the help-images stage).
#
# Usage: convert-help-images.sh SRC OUT
#
# Every SRC/<name>.png becomes OUT/<name>.webp, the light twins
# (<name>.light.png) included. Near-lossless keeps full chroma, so the small
# coloured text in a screenshot stays sharp, and it is the smallest of the fast
# settings: 31 MB of PNG becomes about 13 MB
# (docs/future-plans/in-app-help-screenshots.md has the measurements).
#
# Fails when any conversion fails or OUT ends up with a different number of
# pictures than SRC, so an image never ships with a picture missing.
set -eu

src=$1
out=$2
mkdir -p "$out"

# xargs exits non-zero when any cwebp did, which `set -e` turns into a failure.
find "$src" -maxdepth 1 -type f -name '*.png' -print0 |
  xargs -0 -P "$(nproc)" -n 1 sh -c \
    'cwebp -quiet -near_lossless 40 -z 6 -metadata none "$2" -o "$1/$(basename "$2" .png).webp"' \
    convert-help-image "$out"

pngs=$(find "$src" -maxdepth 1 -type f -name '*.png' | wc -l)
webps=$(find "$out" -maxdepth 1 -type f -name '*.webp' -size +0 | wc -l)
if [ "$pngs" -eq 0 ] || [ "$pngs" -ne "$webps" ]; then
  echo "convert-help-images: $webps WebP from $pngs PNG in $src" >&2
  exit 1
fi
echo "convert-help-images: $webps pictures, $(du -sk "$out" | cut -f1) KiB"
