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
  const glowSize2 = (sunSize * 2.5) * (sunSize * 2.5);

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
        // Display-referred linear. This map is the scene background and the IBL
        // source; a ×4 sky plus a wide corona averaged to ~3.6 nits and ACES
        // washed every material. Keep fill around 0.3–1.2 and a small hot sun
        // so the directional light can own direct lighting and shadows.
        r = 0.42 * (1 - t) + 0.08 * t;
        g = 0.58 * (1 - t) + 0.18 * t;
        b = 0.88 * (1 - t) + 0.62 * t;
      }

      const du = Math.min(Math.abs(u - sunU), 1 - Math.abs(u - sunU));
      const dv = v - sunV;
      const d2 = du * du + dv * dv;
      if (elev > -0.02) {
        const glow = Math.exp(-d2 / glowSize2);
        r += 1.4 * glow;
        g += 1.15 * glow;
        b += 0.8 * glow;
        const core = Math.exp(-d2 / (sunSize2 * 0.35));
        r += 28 * core;
        g += 24 * core;
        b += 18 * core;
      }

      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 1;
    }
  }

  return { data, width, height, sunU, sunV };
}
