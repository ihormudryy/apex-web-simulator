// Fit a circuit into a small box, keeping its shape.
//
// Pure geometry: returns the outline to stroke and a projection for moving things
// like the car. Drawing belongs to the dashboard.

/**
 * @param {Array<{x:number,z:number}>} samples centerline stations.
 * @param {object} box
 * @param {number} box.width pixels
 * @param {number} box.height pixels
 * @param {number} [box.padding=6] pixels of margin on every side
 * @returns {{points: Array<{x:number,y:number}>, project(x,z): {x,y}, scale: number,
 *            bounds: {minX,maxX,minZ,maxZ}}}
 */
export function fitPath(samples, { width, height, padding = 6 } = {}) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of samples) {
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.z < minZ) minZ = s.z;
    if (s.z > maxZ) maxZ = s.z;
  }

  const spanX = Math.max(maxX - minX, 1e-6);
  const spanZ = Math.max(maxZ - minZ, 1e-6);
  const usableWidth = Math.max(width - 2 * padding, 1);
  const usableHeight = Math.max(height - 2 * padding, 1);
  // One scale for both axes, so the circuit keeps its proportions.
  const scale = Math.min(usableWidth / spanX, usableHeight / spanZ);

  // Centre whatever slack the tighter axis leaves over.
  const offsetX = padding + (usableWidth - spanX * scale) / 2;
  const offsetY = padding + (usableHeight - spanZ * scale) / 2;

  const project = (x, z) => ({
    x: offsetX + (x - minX) * scale,
    y: offsetY + (z - minZ) * scale,
  });

  return {
    points: samples.map(s => project(s.x, s.z)),
    project,
    scale,
    bounds: { minX, maxX, minZ, maxZ },
  };
}
