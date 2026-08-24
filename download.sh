#!/usr/bin/env bash
# Fetch photoreal assets referenced by HelloRacer. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p obj/textures/sky obj/textures/grass

SKY_URL="https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/kloofendal_48d_partly_cloudy_puresky_2k.hdr"
GRASS_NOR="https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/leafy_grass/leafy_grass_nor_gl_2k.jpg"
GRASS_ROU="https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/leafy_grass/leafy_grass_rough_2k.jpg"
GRASS_NOR_1K="https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/leafy_grass/leafy_grass_nor_gl_1k.jpg"
GRASS_ROU_1K="https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/leafy_grass/leafy_grass_rough_1k.jpg"

fetch() {
  local url="$1" dest="$2"
  if [[ -f "$dest" ]]; then
    echo "ok  $dest"
    return
  fi
  echo "get $dest"
  curl -fsSL "$url" -o "$dest"
}

fetch "$SKY_URL" "obj/textures/sky/kloofendal_48d_partly_cloudy_puresky_2k.hdr"
fetch "$GRASS_NOR" "obj/textures/grass/leafy_grass_nor_gl_2k.jpg"
fetch "$GRASS_ROU" "obj/textures/grass/leafy_grass_rough_2k.jpg"
# Optional 1k fallbacks for the Track.js load error path.
fetch "$GRASS_NOR_1K" "obj/textures/grass/leafy_grass_nor_gl_1k.jpg"
fetch "$GRASS_ROU_1K" "obj/textures/grass/leafy_grass_rough_1k.jpg"

echo "Assets ready. These are re-fetchable CC0 downloads and stay out of git;"
echo "run this (or npm run assets) after a fresh clone."
