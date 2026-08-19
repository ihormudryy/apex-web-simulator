/**
 * Linear-space outdoor equirect. Row 0 is zenith (v = 1 in Three's
 * `equirectUv`), matching HDRLoader's CPU layout with flipY.
 *
 * The sun is a hot disc so `sunDirectionFromEquirect` and the directional
 * shadow light agree, and car paint gets a real specular.
 */

export const DEFAULT_SUN_U = 0.28;
export const DEFAULT_SUN_V = 0.72;

export function outdoorSkyData({
  width = 512,
  height = 256,
  sunU = DEFAULT_SUN_U,
  sunV = DEFAULT_SUN_V,
  sunSize = 0.022,
} = {}) {
  const data = new Float32Array(width * height * 4);
  const sunSize2 = sunSize * sunSize;
  const glowSize2 = (sunSize * 8) * (sunSize * 8);

  for (let y = 0; y < height; y++) {
    const v = 1 - (y + 0.5) / height;
    const lat = (v - 0.5) * Math.PI;
    const elev = lat; // 0 horizon, +π/2 zenith
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const i = (y * width + x) * 4;

      let r, g, b;
      if (elev < 0) {
        const t = Math.min(1, -elev / (Math.PI * 0.5));
        r = 0.03 + 0.01 * t;
        g = 0.055 + 0.02 * t;
        b = 0.02;
      } else {
        const t = Math.min(1, elev / (Math.PI * 0.5));
        // Horizon haze → zenith blue, in linear nits-ish units.
        r = 0.55 * (1 - t) + 0.10 * t;
        g = 0.72 * (1 - t) + 0.22 * t;
        b = 0.95 * (1 - t) + 0.70 * t;
        r *= 4; g *= 4; b *= 4;
      }

      const du = Math.min(Math.abs(u - sunU), 1 - Math.abs(u - sunU));
      const dv = v - sunV;
      const d2 = du * du + dv * dv;
      if (elev > -0.02) {
        const glow = Math.exp(-d2 / glowSize2);
        r += 12 * glow;
        g += 10 * glow;
        b += 7 * glow;
        const core = Math.exp(-d2 / (sunSize2 * 0.35));
        r += 180 * core;
        g += 160 * core;
        b += 120 * core;
      }

      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 1;
    }
  }

  return { data, width, height, sunU, sunV };
}
