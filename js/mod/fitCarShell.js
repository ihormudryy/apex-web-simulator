/**
 * Fitting an arbitrary car shell to the HelloRacer rig.
 *
 * A downloaded glTF is authored to whatever scale and origin its author felt
 * like. The AMR23 in the catalog measures 3.93 m nose to tail where a real 2023
 * car is about 5.6 m, and it arrives with `scale` untouched at 1 — so it loaded
 * visibly smaller than the rig's own tyres, sunk into the road, with the rig's
 * wheels still drawn through it.
 *
 * Scale is derived from the shell's own **wheelbase**, not its overall length,
 * because length is dominated by wings and nose cones that differ by era and by
 * how much of the car the author modelled, while the distance between the axles
 * is the one dimension every open-wheeler shares with the physics rig. Fall back
 * to length only when the wheels cannot be found.
 *
 * Scale and lift are not enough. Sketchfab origins sit wherever the author
 * clicked "export" — the W14's is 0.79 m behind its axle midpoint. Adopting
 * the named wheel groups onto the physics hubs then leaves the body that far
 * forward of the tyres. After yaw and scale, shift XZ so the shell's front
 * axle lands on the rig's front hubs.
 *
 * Adopted wheels are then scaled onto the physics radius. Wheelbase fit does
 * not make the tyres the right size: the W14's fronts and rears differ, and
 * reparenting onto the spin pivot turns the shell's 90° yaw into a squashed
 * local scale.
 *
 * Pure: takes local-space bounding boxes, returns numbers. The three.js side of
 * the job (walking the graph, reparenting) lives in `Car.loadExternalModel`.
 */

/**
 * One mesh of the shell, as its local-space axis-aligned bounding box.
 *
 * @typedef {{
 *   name: string,
 *   cx: number, cy: number, cz: number,
 *   sx: number, sy: number, sz: number,
 * }} ShellPart
 */

/** Names authors actually use for wheels, across the catalog shells. */
export const WHEEL_NAME = /wheel|tyre|tire|rim|hub|brake.?disc|(^|[^a-z0-9])(fl|fr|rl|rr)([^a-z0-9]|$)|rear[ _-]?left|rear[ _-]?right|front[ _-]?left|front[ _-]?right/i;

export function isWheelName(name) {
  return WHEEL_NAME.test(name || '');
}

/**
 * Prefer an ancestor whose name is a wheel.
 *
 * Sketchfab's W14 names the *group* `FL_6` and leaves every mesh as
 * `Object_7`. Matching only the mesh name would miss the wheels, fall back to
 * overall length, and leave a second set of tyres turning through the shell.
 *
 * @param {{ name?: string, parent?: object | null }} node
 * @param {object | null} [root]
 * @returns {string}
 */
export function partNameFromNode(node, root = null) {
  let n = node;
  while (n && n !== root) {
    if (isWheelName(n.name)) return n.name;
    n = n.parent;
  }
  return node?.name || '';
}

/**
 * The objects to reparent onto the rig's spin pivots: the named wheel *group*,
 * not every decal mesh hanging under it.
 *
 * @param {{ name?: string, children?: object[] }} root
 * @param {string[]} names
 * @returns {object[]}
 */
export function outermostWheelNodes(root, names) {
  const wanted = new Set(names);
  const found = [];
  const visit = (o) => {
    if (!o) return;
    if (wanted.has(o.name || '')) {
      found.push(o);
      return;
    }
    for (const c of o.children || []) visit(c);
  };
  visit(root);
  return found;
}

/**
 * Yaw about Y that puts the shell's nose on visualRoot +X.
 *
 * visualRoot itself is already +90° from the physics root (−Z forward), so
 * visualRoot +X is track-forward. Three.js `makeRotationY(+π/2)` sends model
 * `(0,0,1)` to `(1,0,0)`; `−π/2` sends it to `(-1,0,0)` — which is why the
 * previous sign laid every Sketchfab car backwards.
 *
 * @param {ShellPart[]} parts
 * @returns {number} radians
 */
export function planShellYaw(parts) {
  const list = parts || [];
  const wheels = list.filter(p => isWheelName(p.name));
  if (wheels.length >= 4) {
    const { longitudinal } = axesFrom(wheels);
    const along = wheels.map(w => w[longitudinal]);
    const mid = (Math.min(...along) + Math.max(...along)) / 2;
    const namedFront = wheels.filter(w => /(^|[^a-z])(fl|fr|front)([^a-z]|$)/i.test(w.name || ''));
    const nose = namedFront.length
      ? namedFront.reduce((s, w) => s + w[longitudinal], 0) / namedFront.length
      : Math.max(...along);
    const noseAtPositive = nose >= mid;
    if (longitudinal === 'cz') {
      return noseAtPositive ? Math.PI / 2 : -Math.PI / 2;
    }
    return noseAtPositive ? 0 : Math.PI;
  }
  if (!list.length) return 0;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of list) {
    minX = Math.min(minX, p.cx - p.sx / 2);
    maxX = Math.max(maxX, p.cx + p.sx / 2);
    minZ = Math.min(minZ, p.cz - p.sz / 2);
    maxZ = Math.max(maxZ, p.cz + p.sz / 2);
  }
  // Welded-wheel shells (AMR23) have no names to steer by. The longer
  // horizontal span is the wheelbase; visualRoot's forward is +X.
  return (maxZ - minZ) >= (maxX - minX) ? Math.PI / 2 : 0;
}

/**
 * A 2023-era F1 car, nose to wing, in metres. Only used when no wheels are
 * found — a shell with no identifiable wheels has nothing better to go on.
 */
export const NOMINAL_CAR_LENGTH = 5.6;

/**
 * Scale factors outside this range mean the guess was wrong, not that the model
 * is unusual: a shell authored in centimetres or inches lands far outside, and
 * so does a mis-detected "wheelbase" spanning two wheels on the same axle.
 * Better to leave the shell alone and say so than to fling it across the map.
 */
export const MIN_FIT_SCALE = 0.02;
export const MAX_FIT_SCALE = 200;

/**
 * @param {ShellPart[]} parts
 * @returns {{ longitudinal: 'x' | 'z', lateral: 'x' | 'z' }}
 */
function axesFrom(parts) {
  // The longer horizontal spread across the wheel centres is the car's length.
  // Two wheels on one axle span the track; four span the wheelbase, which on
  // every open-wheeler is the larger of the two.
  const spread = (key) => {
    const vs = parts.map(p => p[key]);
    return Math.max(...vs) - Math.min(...vs);
  };
  return spread('cx') >= spread('cz')
    ? { longitudinal: 'cx', lateral: 'cz' }
    : { longitudinal: 'cz', lateral: 'cx' };
}

/** Three.js `makeRotationY(yaw)` applied to a ground-plane point. */
function rotateYaw(x, z, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return { x: c * x + s * z, z: -s * x + c * z };
}

/**
 * Translate the scaled, yawed shell so its front axle lands on `frontHubX`
 * and its track is centred on visualRoot Z=0.
 */
function shiftOntoHubs(wheels, { scale, yaw, mid, longitudinal, frontHubX }) {
  let frontX = 0, frontN = 0, trackZ = 0;
  for (const w of wheels) {
    const r = rotateYaw(w.cx, w.cz, yaw);
    trackZ += r.z * scale;
    if (w[longitudinal] > mid) {
      frontX += r.x * scale;
      frontN++;
    }
  }
  return {
    shiftX: frontN ? frontHubX - frontX / frontN : 0,
    shiftZ: wheels.length ? -trackZ / wheels.length : 0,
  };
}

/**
 * Uniform scale that puts a wheel group's AABB onto `targetRadius`.
 *
 * A tyre's box is width × diameter × diameter. The median side is the
 * diameter; using the longest side would shrink a group that still has a
 * brake duct or wishbone stub hanging off it.
 *
 * `attach` onto the rig's spin pivot also decomposes the shell's 90° yaw into
 * a non-uniform local scale (W14 measured Y ≈ 0.58 × X/Z), so the caller
 * resets scale to 1, measures, then applies this factor uniformly.
 *
 * @param {number} sx
 * @param {number} sy
 * @param {number} sz
 * @param {number} targetRadius
 * @returns {number}
 */
export function wheelScaleFromBox(sx, sy, sz, targetRadius) {
  const dims = [sx, sy, sz].sort((a, b) => a - b);
  const radius = dims[1] / 2;
  if (!(radius > 1e-8) || !(targetRadius > 0)) return 1;
  return targetRadius / radius;
}

/**
 * Plan how to seat a shell on the rig.
 *
 * @param {ShellPart[]} parts every mesh in the shell, local space
 * @param {{
 *   wheelbase: number,
 *   wheelRadius: number,
 *   frontHubX?: number,
 *   rearHubX?: number,
 * }} rig `frontHubX` is visualRoot +X of the physics front axle (LF)
 * @returns {{
 *   scale: number,
 *   lift: number,
 *   yaw: number,
 *   shiftX: number,
 *   shiftZ: number,
 *   method: 'wheelbase' | 'length' | 'none',
 *   shellWheelbase: number | null,
 *   wheelNames: string[],
 * }}
 */
export function planShellFit(parts, rig, { nominalLength = NOMINAL_CAR_LENGTH } = {}) {
  const none = {
    scale: 1, lift: 0, yaw: 0, shiftX: 0, shiftZ: 0,
    method: 'none', shellWheelbase: null, wheelNames: [],
  };
  if (!Array.isArray(parts) || !parts.length) return none;

  const wheels = parts.filter(p => WHEEL_NAME.test(p.name || ''));
  if (wheels.length >= 4) {
    const { longitudinal } = axesFrom(wheels);
    const along = wheels.map(w => w[longitudinal]);
    const mid = (Math.min(...along) + Math.max(...along)) / 2;
    const front = wheels.filter(w => w[longitudinal] > mid);
    const rear = wheels.filter(w => w[longitudinal] <= mid);
    if (front.length && rear.length) {
      const mean = (arr) => arr.reduce((s, w) => s + w[longitudinal], 0) / arr.length;
      const shellWheelbase = Math.abs(mean(front) - mean(rear));
      const scale = shellWheelbase > 1e-6 ? rig.wheelbase / shellWheelbase : 0;
      if (scale >= MIN_FIT_SCALE && scale <= MAX_FIT_SCALE) {
        // Seat the shell so its wheel centres land one wheel radius up, which
        // is where the rig's contact patches are.
        const hubY = wheels.reduce((s, w) => s + w.cy, 0) / wheels.length;
        const yaw = planShellYaw(parts);
        const { shiftX, shiftZ } = shiftOntoHubs(wheels, {
          scale, yaw, mid, longitudinal,
          frontHubX: rig.frontHubX ?? rig.wheelbase * 0.54,
        });
        return {
          scale,
          lift: rig.wheelRadius - hubY * scale,
          yaw, shiftX, shiftZ,
          method: 'wheelbase',
          shellWheelbase,
          wheelNames: wheels.map(w => w.name),
        };
      }
    }
  }

  // No usable wheels: scale by overall length and rest the lowest point on the
  // road. Cruder — a shell whose author included a display plinth will sit high.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of parts) {
    minX = Math.min(minX, p.cx - p.sx / 2);
    maxX = Math.max(maxX, p.cx + p.sx / 2);
    minY = Math.min(minY, p.cy - p.sy / 2);
    minZ = Math.min(minZ, p.cz - p.sz / 2);
    maxZ = Math.max(maxZ, p.cz + p.sz / 2);
  }
  const length = Math.max(maxX - minX, maxZ - minZ);
  const scale = length > 1e-6 ? nominalLength / length : 0;
  if (!(scale >= MIN_FIT_SCALE && scale <= MAX_FIT_SCALE)) return none;
  return {
    scale,
    lift: -minY * scale,
    yaw: planShellYaw(parts),
    shiftX: 0,
    shiftZ: 0,
    method: 'length',
    shellWheelbase: null,
    wheelNames: wheels.map(w => w.name),
  };
}

/**
 * Names given to wheel groups peeled off a nameless welded shell, in hub
 * order: front-left, front-right, rear-left, rear-right.
 */
export const WHEEL_CORNER_NAMES = ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR'];

/** Fewer triangles than this at a corner means we did not find a tyre. */
export const MIN_WHEEL_TRIANGLES = 32;

/**
 * Which hub a point belongs to, or -1 if it is outside that wheel's volume.
 * The volume is a cylinder along visualRoot Z (the axle): radial distance
 * in XY ≤ `radius`, |z − hub.z| ≤ `halfWidth`.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {{ x: number, y: number, z: number }[]} hubs
 * @param {number} radius
 * @param {number} [halfWidth]
 * @returns {0|1|2|3|-1}
 */
export function nearestHubCorner(x, y, z, hubs, radius, halfWidth = radius) {
  const r2 = radius * radius;
  const hw = halfWidth;
  let best = -1;
  let bestD = r2;
  const list = hubs || [];
  for (let i = 0; i < list.length && i < 4; i++) {
    const h = list[i];
    // Axle is visualRoot ±Z (left/right). A sphere grabbed bargeboards
    // and still missed the outer tread; a wheel-shaped capsule does not.
    if (Math.abs(z - h.z) > hw) continue;
    if (y < h.y - radius * 0.48) continue;
    const dx = x - h.x, dy = y - h.y;
    const d = dx * dx + dy * dy;
    if (d <= bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Split an indexed mesh into body triangles and four wheel-corner triangles.
 * `framePositions` are the same vertices in visualRoot space (used only to
 * classify); returned indices still address the original vertex buffer.
 *
 * @param {ArrayLike<number>} framePositions
 * @param {ArrayLike<number>} indices
 * @param {{ x: number, y: number, z: number }[]} hubs
 * @param {number} [halfWidth] along the axle; defaults to `radius` (a disc)
 * @returns {{ body: number[], wheels: [number[], number[], number[], number[]] }}
 */
export function partitionIndexedTriangles(framePositions, indices, hubs, radius = 0.42, halfWidth = radius) {
  const nVerts = Math.floor((framePositions?.length || 0) / 3);
  const corner = new Int8Array(nVerts);
  for (let i = 0; i < nVerts; i++) {
    corner[i] = nearestHubCorner(
      framePositions[i * 3],
      framePositions[i * 3 + 1],
      framePositions[i * 3 + 2],
      hubs,
      radius,
      halfWidth,
    );
  }
  const body = [];
  const wheels = [[], [], [], []];
  const idx = indices || [];
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (a < 0 || b < 0 || c < 0 || a >= nVerts || b >= nVerts || c >= nVerts) continue;
    const counts = [0, 0, 0, 0];
    const ca = corner[a], cb = corner[b], cc = corner[c];
    if (ca >= 0) counts[ca]++;
    if (cb >= 0) counts[cb]++;
    if (cc >= 0) counts[cc]++;
    let w = -1;
    let bestN = 1;
    for (let i = 0; i < 4; i++) {
      if (counts[i] > bestN) { bestN = counts[i]; w = i; }
    }
    const dest = w >= 0 ? wheels[w] : body;
    dest.push(a, b, c);
  }
  return { body, wheels };
}

/**
 * @param {number[][]} wheels
 * @param {number} [min]
 */
export function allWheelsExtractable(wheels, min = MIN_WHEEL_TRIANGLES) {
  return Array.isArray(wheels)
    && wheels.length === 4
    && wheels.every(w => (w?.length || 0) / 3 >= min);
}

/**
 * Rebuild an index list over only the vertices it actually references, so a
 * tyre peeled from a 65k-vert body slice does not keep the body's bounding box
 * (which would snap the group onto the wrong hub).
 *
 * @param {number} vertexCount
 * @param {ArrayLike<number>} indices
 * @returns {{ count: number, indices: number[], used: Int32Array }}
 */
export function remapIndexedSubset(vertexCount, indices) {
  const used = new Int32Array(vertexCount).fill(-1);
  let count = 0;
  const remapped = new Array(indices?.length || 0);
  for (let i = 0; i < remapped.length; i++) {
    const old = indices[i];
    if (old < 0 || old >= vertexCount) {
      remapped[i] = 0;
      continue;
    }
    if (used[old] < 0) used[old] = count++;
    remapped[i] = used[old];
  }
  return { count, indices: remapped, used };
}
