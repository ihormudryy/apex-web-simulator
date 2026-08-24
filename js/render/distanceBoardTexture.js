/**
 * Canvas texture for brake-distance boards along the lap.
 */

/**
 * @param {number} labelM distance in metres (e.g. 200, 400)
 * @returns {HTMLCanvasElement}
 */
export function drawDistanceBoardCanvas(labelM) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.fillStyle = '#f2eee4';
  ctx.fillRect(0, 0, 256, 128);
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 5;
  ctx.strokeRect(4, 4, 248, 120);

  ctx.fillStyle = '#111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 56px system-ui, sans-serif';
  ctx.fillText(String(labelM), 128, 58);
  ctx.font = '600 22px system-ui, sans-serif';
  ctx.fillText('metres', 128, 98);

  return canvas;
}

/**
 * @param {number} labelM
 * @param {typeof import('three')} THREE
 */
export function distanceBoardTexture(labelM, THREE) {
  const canvas = drawDistanceBoardCanvas(labelM);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
