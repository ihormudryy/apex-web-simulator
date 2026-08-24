/**
 * Soft contact patches under each tyre.
 *
 * The chassis blob (`Shadow.jpg`) darkens a wide area under the body. Cascaded
 * sun shadows still miss the tyre contact at close range, so each wheel gets a
 * small multiply disc that sits on the asphalt. Opacity tracks vertical load so
 * an airborne wheel does not paint a floating shadow.
 *
 * Pure numbers + pixel buffers — Three.js wiring lives in `Car.js`.
 */

/** Metres above the asphalt plane. Same stack height as the chassis blob. */
export const CONTACT_PATCH_Y = 0.026;

/** Disc diameter, m — slightly wider than a slick contact patch. */
export const CONTACT_PATCH_SIZE = 0.58;

/** Chassis blob opacity when CSM is already darkening the area. */
export const CONTACT_CHASSIS_OPACITY_CSM = 0.42;
export const CONTACT_CHASSIS_OPACITY_FULL = 1;

/** Per-tyre disc peak opacity (before load scaling). */
export const CONTACT_PATCH_OPACITY_CSM = 0.50;
export const CONTACT_PATCH_OPACITY_FULL = 0.88;

/**
 * Opacity for one tyre contact disc.
 *
 * @param {number} fz vertical load, N
 * @param {number} staticFz static corner weight, N
 * @param {boolean} csmActive
 */
export function contactPatchOpacity(fz, staticFz, csmActive) {
  const base = csmActive ? CONTACT_PATCH_OPACITY_CSM : CONTACT_PATCH_OPACITY_FULL;
  if (!(staticFz > 0) || !(fz > 0)) return 0;
  // Soft knee: light load still reads a little contact; unload goes to zero.
  const load = Math.max(0, Math.min(1.25, fz / staticFz));
  return base * Math.min(1, load * 1.05);
}

/**
 * Soft radial disc for MultiplyBlending: black centre, white surround.
 *
 * @param {number} [size=64]
 * @returns {{ data: Uint8ClampedArray, size: number }}
 */
export function softContactDiscRGBA(size = 64) {
  const data = new Uint8ClampedArray(size * size * 4);
  const mid = (size - 1) * 0.5;
  const rMax = mid * 0.98;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - mid) / rMax;
      const dy = (y - mid) / rMax;
      // Slightly elliptical along X so the patch reads as a tyre contact, not a
      // coin, when the camera is behind the car.
      const d = Math.hypot(dx * 1.15, dy * 0.92);
      const soft = Math.max(0, 1 - d);
      // Sharper falloff near the edge so the white surround stays clean.
      const shade = soft * soft * (0.35 + 0.65 * soft);
      const v = Math.round(255 * (1 - shade));
      const o = (y * size + x) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { data, size };
}
