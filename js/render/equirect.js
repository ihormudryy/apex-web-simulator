/**
 * Equirectangular mapping matching Three.js `equirectUv`:
 *   u = atan2(z, x) / 2π + 0.5
 *   v = asin(y) / π + 0.5
 * so v = 1 is +Y (zenith) and v = 0 is −Y.
 */

export function directionFromEquirectUV(u, v) {
  const lon = (u - 0.5) * Math.PI * 2;
  const lat = (v - 0.5) * Math.PI;
  const cosLat = Math.cos(lat);
  return {
    x: cosLat * Math.cos(lon),
    y: Math.sin(lat),
    z: cosLat * Math.sin(lon),
  };
}

function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Direction toward the brightest pixel in the sky hemisphere of an HDR
 * equirect. `data` is packed RGB(A) row-major. `rowZero: 'zenith'` means the
 * first row is the top of a typical HDRI file (zenith), which is v = 1 in
 * Three's shader.
 */
export function sunDirectionFromEquirect(data, width, height, {
  channels = 4,
  rowZero = 'zenith',
} = {}) {
  let best = -Infinity;
  let bestU = 0.5;
  let bestV = 0.75;
  for (let y = 0; y < height; y++) {
    const v = rowZero === 'zenith'
      ? 1 - (y + 0.5) / height
      : (y + 0.5) / height;
    if (v <= 0.5) continue;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const lum = luminance(data[i], data[i + 1], data[i + 2]);
      if (lum > best) {
        best = lum;
        bestU = (x + 0.5) / width;
        bestV = v;
      }
    }
  }
  return directionFromEquirectUV(bestU, bestV);
}

/** Mean linear RGB of a thin band around the horizon, for fog. */
export function horizonColorFromEquirect(data, width, height, {
  channels = 4,
  rowZero = 'zenith',
  band = 0.04,
} = {}) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < height; y++) {
    const v = rowZero === 'zenith'
      ? 1 - (y + 0.5) / height
      : (y + 0.5) / height;
    if (Math.abs(v - 0.5) > band) continue;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      r += data[i]; g += data[i + 1]; b += data[i + 2];
      n++;
    }
  }
  if (!n) return { r: 0.66, g: 0.84, b: 1 };
  return { r: r / n, g: g / n, b: b / n };
}
