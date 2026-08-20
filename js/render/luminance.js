/** sRGB byte → linear luminance (Rec. 709). */
export function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Plan Phase 0 verify: no ground sample may sit below this sRGB level. */
export const LUMINANCE_FLOOR = 12;

/** Sunlit dry tarmac target band (sRGB, before ACES display). */
export const TARMAC_ALBEDO_MIN = 80;
export const TARMAC_ALBEDO_MAX = 110;

/**
 * Sample mean luminance at normalized image coordinates.
 * @param {Uint8Array|Uint8ClampedArray} rgba length width*height*4
 */
export function sampleMeanLuminance(rgba, width, height, points) {
  let sum = 0;
  for (const [u, v] of points) {
    const x = Math.min(width - 1, Math.max(0, Math.round(u * (width - 1))));
    const y = Math.min(height - 1, Math.max(0, Math.round(v * (height - 1))));
    const i = (y * width + x) * 4;
    sum += luminance(rgba[i], rgba[i + 1], rgba[i + 2]);
  }
  return sum / points.length;
}

export function allSamplesAboveFloor(rgba, width, height, points, floor = LUMINANCE_FLOOR) {
  for (const [u, v] of points) {
    const x = Math.min(width - 1, Math.max(0, Math.round(u * (width - 1))));
    const y = Math.min(height - 1, Math.max(0, Math.round(v * (height - 1))));
    const i = (y * width + x) * 4;
    if (rgba[i] < floor || rgba[i + 1] < floor || rgba[i + 2] < floor) return false;
  }
  return true;
}
