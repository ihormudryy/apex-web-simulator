/**
 * Ribbon UVs. Two modes:
 *   metres      — one UV unit is `tileMetres` of road, so a PBR tile repeats in
 *                 physical space even as the strip width changes
 *   normalized  — U runs 0→1 once around the lap, V across the strip; used by
 *                 the kerb and dash canvases that size themselves with texture.repeat
 */
export function ribbonTileUV({
  alongMetres = 0,
  left = 0,
  right = 0,
  tileMetres = 1,
  station = 0,
  stationCount = 1,
  mode = 'metres',
} = {}) {
  if (mode === 'normalized') {
    const u = station / stationCount;
    return { u0: u, v0: 0, u1: u, v1: 1 };
  }
  const u = alongMetres / tileMetres;
  return {
    u0: u,
    v0: left / tileMetres,
    u1: u,
    v1: right / tileMetres,
  };
}
