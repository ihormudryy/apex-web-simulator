#!/usr/bin/env python3
"""
Regenerate obj/textures/BodyPaint.jpg with fictional sponsor marks.

Uses the original UV layout only as a mask (logo islands). Output livery is
Apex Racing — no real trademarks. Keeps BodyPaint.legacy.jpg as the prior art.
"""

from __future__ import annotations

import shutil
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "obj/textures/BodyPaint.jpg"
LEGACY = ROOT / "obj/textures/BodyPaint.legacy.jpg"
SRC = LEGACY if LEGACY.exists() else OUT

# Fictional team palette (not Ferrari trade dress)
BASE = (12, 28, 58)          # midnight blue
ACCENT = (255, 92, 26)       # orange
PANEL = (18, 40, 78)
INK = (240, 244, 252)
INK_DIM = (180, 196, 220)

FAKE_BRANDS = [
    "APEX", "ZEPHYR OIL", "VELOCE", "HEXADRIVE", "TORQSYNC",
    "PRISM GP", "NEXUS", "ORBITAL", "STRATUS", "FLUX",
    "HORIZON", "VORTEX", "LUMEN", "CIPHER", "NOVA",
    "PULSE", "AETHER", "GRIDLINE", "SUMMIT", "RIVET",
    "AXIOM", "QUANT", "HELIX", "SPARK", "DRIFT",
]

# Original Ferrari-red reference for finding logo islands on the legacy map
LEGACY_RED = np.array([196, 0, 0], dtype=np.int16)
RED_THRESH = 42
MIN_REGION = 180


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ):
        p = Path(path)
        if p.exists():
            try:
                return ImageFont.truetype(str(p), size=size)
            except OSError:
                continue
    return ImageFont.load_default()


def logo_mask(arr: np.ndarray) -> np.ndarray:
    dist = np.linalg.norm(arr.astype(np.int16) - LEGACY_RED, axis=2)
    return dist > RED_THRESH


def find_regions(mask: np.ndarray) -> list[tuple[int, int, int, int, int]]:
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    regions: list[tuple[int, int, int, int, int]] = []
    for y0 in range(h):
        for x0 in range(w):
            if not mask[y0, x0] or seen[y0, x0]:
                continue
            q: deque[tuple[int, int]] = deque([(x0, y0)])
            seen[y0, x0] = True
            minx = maxx = x0
            miny = maxy = y0
            n = 0
            while q:
                x, y = q.popleft()
                n += 1
                minx, maxx = min(minx, x), max(maxx, x)
                miny, maxy = min(miny, y), max(maxy, y)
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        q.append((nx, ny))
            if n >= MIN_REGION:
                regions.append((minx, miny, maxx, maxy, n))
    regions.sort(key=lambda r: -r[4])
    return regions


def fit_font(draw: ImageDraw.ImageDraw, text: str, max_w: int, max_h: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for size in range(min(max_h, 120), 8, -2):
        font = load_font(size)
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        if tw <= max_w * 0.92 and th <= max_h * 0.88:
            return font
    return load_font(10)


def draw_brand(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], name: str, idx: int) -> None:
    x0, y0, x1, y1 = box
    w, h = x1 - x0 + 1, y1 - y0 + 1
    pad = max(2, min(w, h) // 16)
    inner = (x0 + pad, y0 + pad, x1 - pad, y1 - pad)
    fill = ACCENT if idx % 5 == 0 else PANEL
    draw.rectangle(inner, fill=fill, outline=INK_DIM, width=max(1, pad // 2))
    font = fit_font(draw, name, inner[2] - inner[0], inner[3] - inner[1])
    bbox = draw.textbbox((0, 0), name, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = inner[0] + (inner[2] - inner[0] - tw) / 2 - bbox[0]
    ty = inner[1] + (inner[3] - inner[1] - th) / 2 - bbox[1]
    draw.text((tx, ty), name, fill=INK if fill == PANEL else BASE, font=font)


def draw_accent_strips(draw: ImageDraw.ImageDraw, size: int) -> None:
    """Racing stripes that read on wings/nose without using legacy logo positions."""
    stripe = ACCENT
    for y in (size // 8, size // 2 + size // 16):
        draw.rectangle((0, y, size, y + size // 64), fill=stripe)
    draw.rectangle((size // 3, 0, size // 3 + size // 80, size), fill=stripe)


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"Missing source texture: {SRC}")

    if not LEGACY.exists() and OUT.exists():
        shutil.copy2(OUT, LEGACY)
        print(f"Backed up legacy livery → {LEGACY.relative_to(ROOT)}")

    legacy = Image.open(SRC).convert("RGB")
    w, h = legacy.size
    arr = np.array(legacy)
    mask = logo_mask(arr)
    regions = find_regions(mask)

    img = Image.new("RGB", (w, h), BASE)
    draw = ImageDraw.Draw(img)
    draw_accent_strips(draw, w)

    for i, (minx, miny, maxx, maxy, _area) in enumerate(regions):
        name = FAKE_BRANDS[i % len(FAKE_BRANDS)]
        draw_brand(draw, (minx, miny, maxx, maxy), name, i)

    # Large centre wing / nose slab (often barcode on legacy map)
    draw.rectangle((w // 4, h // 16, 3 * w // 4, h // 6), fill=PANEL, outline=ACCENT, width=4)
    font = fit_font(draw, "APEX RACING", w // 2, h // 12)
    bbox = draw.textbbox((0, 0), "APEX RACING", font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(
        ((w - tw) / 2 - bbox[0], h // 16 + (h // 12 - th) / 2 - bbox[1]),
        "APEX RACING",
        fill=INK,
        font=font,
    )

    img.save(OUT, format="JPEG", quality=92, optimize=True)
    print(f"Wrote {OUT.relative_to(ROOT)} ({w}x{h}, {len(regions)} sponsor islands)")


if __name__ == "__main__":
    main()
