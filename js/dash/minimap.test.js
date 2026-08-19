// js/dash/minimap.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitPath } from './minimap.js';
import { buildCenterline } from '../track/centerline.js';
import { SILVERSTONE_WAYPOINTS } from '../track/silverstoneWaypoints.js';

const BOX = { width: 120, height: 96, padding: 8 };

test('every station lands inside the box', () => {
  const samples = buildCenterline(SILVERSTONE_WAYPOINTS, 500).samples;
  const fit = fitPath(samples, BOX);
  for (const p of fit.points) {
    assert.ok(p.x >= BOX.padding - 1e-6 && p.x <= BOX.width - BOX.padding + 1e-6,
      `x ${p.x} escaped the box`);
    assert.ok(p.y >= BOX.padding - 1e-6 && p.y <= BOX.height - BOX.padding + 1e-6,
      `y ${p.y} escaped the box`);
  }
});

test('the circuit keeps its proportions', () => {
  const samples = buildCenterline(SILVERSTONE_WAYPOINTS, 500).samples;
  const fit = fitPath(samples, BOX);
  const worldAspect = (fit.bounds.maxX - fit.bounds.minX) / (fit.bounds.maxZ - fit.bounds.minZ);

  const xs = fit.points.map(p => p.x), ys = fit.points.map(p => p.y);
  const drawnAspect = (Math.max(...xs) - Math.min(...xs)) / (Math.max(...ys) - Math.min(...ys));
  assert.ok(Math.abs(drawnAspect - worldAspect) / worldAspect < 1e-6,
    `aspect went from ${worldAspect} to ${drawnAspect}`);
});

test('the fit touches the box on its tighter axis', () => {
  // Otherwise the map is needlessly small inside its panel.
  const samples = buildCenterline(SILVERSTONE_WAYPOINTS, 500).samples;
  const fit = fitPath(samples, BOX);
  const xs = fit.points.map(p => p.x), ys = fit.points.map(p => p.y);
  const usedWidth = Math.max(...xs) - Math.min(...xs);
  const usedHeight = Math.max(...ys) - Math.min(...ys);
  const filledWidth = usedWidth >= BOX.width - 2 * BOX.padding - 1e-6;
  const filledHeight = usedHeight >= BOX.height - 2 * BOX.padding - 1e-6;
  assert.ok(filledWidth || filledHeight,
    `used ${usedWidth}x${usedHeight} of ${BOX.width - 16}x${BOX.height - 16}`);
});

test('project agrees with the drawn outline', () => {
  const samples = buildCenterline(SILVERSTONE_WAYPOINTS, 64).samples;
  const fit = fitPath(samples, BOX);
  samples.forEach((s, i) => {
    const p = fit.project(s.x, s.z);
    assert.ok(Math.abs(p.x - fit.points[i].x) < 1e-9);
    assert.ok(Math.abs(p.y - fit.points[i].y) < 1e-9);
  });
});

test('a square circuit is centred, not stretched', () => {
  const square = [
    { x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }, { x: 0, z: 100 },
  ];
  const fit = fitPath(square, { width: 200, height: 100, padding: 0 });
  const xs = fit.points.map(p => p.x);
  // 100x100 into 200x100 fits on height, leaving 50px of slack each side.
  assert.ok(Math.abs(Math.min(...xs) - 50) < 1e-6, `left edge at ${Math.min(...xs)}`);
  assert.ok(Math.abs(Math.max(...xs) - 150) < 1e-6, `right edge at ${Math.max(...xs)}`);
});

test('a degenerate circuit does not divide by zero', () => {
  const fit = fitPath([{ x: 5, z: 5 }, { x: 5, z: 5 }], BOX);
  for (const p of fit.points) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${p.x},${p.y}`);
  }
});
