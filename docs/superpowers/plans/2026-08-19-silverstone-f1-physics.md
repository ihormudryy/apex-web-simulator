# Silverstone GP + F1 Bicycle Physics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the procedural Monaco world with a 1 m/unit Silverstone GP circuit and an F1-style planar bicycle model.

**Architecture:** Pure JS `centerline` + `query` (no Three.js) feeds both Node tests and a `Track` mesh group. `bicycle.step` is the physics kernel; `Car` keeps the existing `cvel` / −Z facing mapping and calls `track.query` each substep. HelloRacer only spawns, fogs, and forwards the track into `updatePhysics`.

**Tech Stack:** ES modules, Three.js r183 (meshes only), Node.js built-in test runner (`node --test`), no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-19-silverstone-f1-physics-design.md`

## Global Constraints

- 1 unit = 1 metre; Silverstone GP target length 5.891 km ± 5%; clockwise; spawn on Hamilton Straight facing Abbey.
- Planar only; no physics engine, GLTF circuit, gears, ERS, DRS, weather, tire wear.
- `query` surfaces: `tarmac` | `kerb` | `grass`; barrier only when `|lateral| > wallLimit`.
- Physics: mass 800 kg; wheelbase 3.3928 m; 46/54 weight; 650 kW; ρ=1.225; CdA=1.55; ClA=4.6; μ tarmac 1.6 / kerb 1.2 / grass 0.35.
- Keep `cvel` mapping: `position.z -= dt * cvel.x`, `position.x += dt * cvel.y`; headingForward `(-sin y, 0, -cos y)`.
- Delete `js/scene/TrackEnvironment.js` and `js/scene/TracksideModels.js`; no Polyhaven track textures.

## File map

| File | Role |
|------|------|
| `js/track/centerline.js` | Sample a closed polyline, `query(x,z)`, arc length |
| `js/track/silverstoneWaypoints.js` | GP waypoints `{x,z,halfWidth,runoff}[]` + `SPAWN_T` |
| `js/track/Track.js` | `THREE.Group` ribbons + `query` delegate |
| `js/track/Silverstone.js` | `new Track(SILVERSTONE_WAYPOINTS)` |
| `js/physics/bicycle.js` | `step(state, input, sample, dt)` |
| `js/track/centerline.test.js` | Node tests for length / surfaces |
| `js/physics/bicycle.test.js` | Node tests for aero top speed / grass |
| `js/Car.js` | Call bicycle + barrier; speed-sensitive steer |
| `js/HelloRacer.js` | Swap scene, fog, spawn, `updatePhysics(dt, track)` |

---

### Task 1: Centerline sampler and query

**Files:**
- Create: `js/track/centerline.js`
- Test: `js/track/centerline.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `export function buildCenterline(waypoints, sampleCount=4000)` → `{ samples, length, query(x,z,hintIndex) }`
- Each sample: `{ x, z, tx, tz, nx, nz, halfWidth, runoff, t }`
- `query` return: `{ tangent:{x,z}, normal:{x,z}, lateral, halfWidth, surface, wallLimit, index, t }`
- `nx,nz` = left of tangent: `(-tz, tx)`
- `lateral` positive = right of travel (`dx*nx+dz*nz` with world offset from center)
- `surface`: `|lat|<halfWidth` tarmac; else if `|lat|<halfWidth+1` kerb; else grass
- `wallLimit`: `halfWidth + runoff`
- Search: start at `hintIndex` ± 80, if best d² > (halfWidth+runoff+40)² fall back to full scan

- [ ] **Step 1: Write the failing test**

```js
// js/track/centerline.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCenterline } from './centerline.js';

const box = [
  { x: 0, z: 0, halfWidth: 6, runoff: 8 },
  { x: 100, z: 0, halfWidth: 6, runoff: 8 },
  { x: 100, z: 50, halfWidth: 6, runoff: 8 },
  { x: 0, z: 50, halfWidth: 6, runoff: 8 },
];

test('closed loop length is perimeter', () => {
  const c = buildCenterline(box, 400);
  assert.ok(Math.abs(c.length - 300) / 300 < 0.08);
});

test('on-center is tarmac, 7m off is kerb, 20m off is grass', () => {
  const c = buildCenterline(box, 400);
  const mid = c.query(50, 0);
  assert.equal(mid.surface, 'tarmac');
  const kerb = c.query(50, 6.5);
  assert.equal(kerb.surface, 'kerb');
  const grass = c.query(50, 20);
  assert.equal(grass.surface, 'grass');
  assert.ok(grass.wallLimit > 10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test js/track/centerline.test.js`  
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `./centerline.js`

- [ ] **Step 3: Write minimal implementation**

```js
// js/track/centerline.js
export function buildCenterline(waypoints, sampleCount = 4000) {
  const n = waypoints.length;
  const accum = [0];
  for (let i = 0; i < n; i++) {
    const a = waypoints[i], b = waypoints[(i + 1) % n];
    const dx = b.x - a.x, dz = b.z - a.z;
    accum.push(accum[i] + Math.hypot(dx, dz));
  }
  const length = accum[n];
  const samples = new Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const s = (i / sampleCount) * length;
    let seg = 0;
    while (seg < n - 1 && accum[seg + 1] < s) seg++;
    const a = waypoints[seg], b = waypoints[(seg + 1) % n];
    const span = accum[seg + 1] - accum[seg] || 1;
    const u = (s - accum[seg]) / span;
    const x = a.x + (b.x - a.x) * u;
    const z = a.z + (b.z - a.z) * u;
    const tx = (b.x - a.x) / span;
    const tz = (b.z - a.z) / span;
    const nx = -tz, nz = tx;
    samples[i] = {
      x, z, tx, tz, nx, nz,
      halfWidth: a.halfWidth + (b.halfWidth - a.halfWidth) * u,
      runoff: a.runoff + (b.runoff - a.runoff) * u,
      t: i / sampleCount,
    };
  }

  function query(qx, qz, hintIndex = 0) {
    const lim = samples.length;
    let bestI = 0, bestD2 = Infinity;
    const window = 80;
    const start = ((hintIndex % lim) + lim) % lim;
    const consider = (i) => {
      const s = samples[i];
      const d2 = (s.x - qx) ** 2 + (s.z - qz) ** 2;
      if (d2 < bestD2) { bestD2 = d2; bestI = i; }
    };
    for (let d = 0; d <= window; d++) {
      consider((start + d) % lim);
      if (d) consider((start - d + lim) % lim);
    }
    const hw0 = samples[bestI].halfWidth + samples[bestI].runoff + 40;
    if (bestD2 > hw0 * hw0) {
      for (let i = 0; i < lim; i++) consider(i);
    }
    const s = samples[bestI];
    const lateral = (qx - s.x) * s.nx + (qz - s.z) * s.nz;
    const ad = Math.abs(lateral);
    const surface = ad < s.halfWidth ? 'tarmac' : ad < s.halfWidth + 1 ? 'kerb' : 'grass';
    return {
      tangent: { x: s.tx, z: s.tz },
      normal: { x: s.nx, z: s.nz },
      lateral,
      halfWidth: s.halfWidth,
      surface,
      wallLimit: s.halfWidth + s.runoff,
      index: bestI,
      t: s.t,
    };
  }

  return { samples, length, query };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --test js/track/centerline.test.js`  
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add js/track/centerline.js js/track/centerline.test.js
git commit -m "feat: add planar centerline sampler and surface query"
```

---

### Task 2: Silverstone GP waypoints

**Files:**
- Create: `js/track/silverstoneWaypoints.js`
- Create: `scripts/fetch-silverstone.mjs` (optional generator)
- Modify: `js/track/centerline.test.js` (add length test)

**Interfaces:**
- Consumes: `buildCenterline`
- Produces: `export const SILVERSTONE_WAYPOINTS` — closed ring, **do not repeat the first point at the end**
- Each point: `{ x, z, halfWidth, runoff }` in metres
- `export const SILVERSTONE_SPAWN_T` — fraction along lap on Hamilton Straight (~0.0)
- After `buildCenterline(SILVERSTONE_WAYPOINTS, 4000)`, `length` in **[5596, 6186]** (5891 ± 5%)
- Clockwise: at spawn, tangent must point toward Abbey (next corner is a fast right, so `normal` points left of that tangent)
- `halfWidth` 6–8.5 (12–17 m total); 8.5 on Hamilton Straight; `runoff` 6 at The Loop, 18–25 at Stowe/Copse/Club, ~12 elsewhere

Prefer fetching OSM relation **51160** (Silverstone Grand Prix) via Overpass, project lon/lat to local metres, downsample to 80–120 vertices, scale uniformly so length is 5891 m, rotate so index 0 is the start/finish nearest `(-1.0169, 52.0736)`, and wind clockwise.

If Overpass fails, use this fallback ring (already ~Silverstone-shaped). After paste, **scale** by `5891 / buildCenterline(raw, 800).length`:

```js
// Approximate GP loop, metres, clockwise from Hamilton Straight toward Abbey.
// Arena (Village/Loop) is +X; Hangar Straight is the long +Z run.
export const SILVERSTONE_WAYPOINTS_UNSCALED = [
  { x:  820, z:   40, halfWidth: 8.5, runoff: 14 }, // Hamilton Straight
  { x:  780, z: -220, halfWidth: 7.5, runoff: 16 }, // Abbey
  { x:  700, z: -380, halfWidth: 7.0, runoff: 14 }, // Farm
  { x:  520, z: -470, halfWidth: 7.0, runoff: 12 }, // Village
  { x:  310, z: -430, halfWidth: 6.5, runoff: 6  }, // The Loop
  { x:  280, z: -280, halfWidth: 7.0, runoff: 12 }, // Aintree
  { x:  120, z:  -40, halfWidth: 7.5, runoff: 14 }, // Wellington Straight
  { x: -180, z:  220, halfWidth: 7.5, runoff: 14 },
  { x: -420, z:  280, halfWidth: 7.0, runoff: 12 }, // Brooklands
  { x: -620, z:  180, halfWidth: 7.0, runoff: 12 }, // Luffield
  { x: -680, z:  -40, halfWidth: 7.5, runoff: 16 }, // Woodcote
  { x: -600, z: -280, halfWidth: 7.5, runoff: 22 }, // Copse
  { x: -420, z: -420, halfWidth: 7.0, runoff: 16 }, // Maggotts
  { x: -220, z: -500, halfWidth: 7.0, runoff: 16 }, // Becketts
  { x:  -40, z: -620, halfWidth: 7.0, runoff: 14 }, // Chapel
  { x:  180, z: -900, halfWidth: 7.5, runoff: 18 }, // Hangar Straight
  { x:  420, z:-1180, halfWidth: 7.5, runoff: 18 },
  { x:  640, z:-1280, halfWidth: 7.5, runoff: 24 }, // Stowe
  { x:  820, z:-1120, halfWidth: 7.0, runoff: 16 }, // Vale
  { x:  880, z: -820, halfWidth: 7.5, runoff: 20 }, // Club
  { x:  860, z: -400, halfWidth: 8.5, runoff: 14 },
];
```

Scale in `silverstoneWaypoints.js`:

```js
import { buildCenterline } from './centerline.js';

const TARGET = 5891;
const raw = SILVERSTONE_WAYPOINTS_UNSCALED;
const len = buildCenterline(raw, 800).length;
const k = TARGET / len;
export const SILVERSTONE_WAYPOINTS = raw.map(p => ({
  x: p.x * k, z: p.z * k, halfWidth: p.halfWidth, runoff: p.runoff,
}));
export const SILVERSTONE_SPAWN_T = 0;
```

- [ ] **Step 1: Write the failing length test** (append to `centerline.test.js`)

```js
import { SILVERSTONE_WAYPOINTS } from './silverstoneWaypoints.js';

test('Silverstone GP length is 5.891 km ± 5%', () => {
  const c = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  assert.ok(c.length > 5596 && c.length < 6186, `length ${c.length}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test js/track/centerline.test.js`  
Expected: FAIL — cannot find `silverstoneWaypoints.js`

- [ ] **Step 3: Add waypoints module** (fallback scaled ring above, or OSM-derived if fetch succeeds)

- [ ] **Step 4: Run tests**

Run: `node --test js/track/centerline.test.js`  
Expected: PASS including Silverstone length

- [ ] **Step 5: Commit**

```bash
git add js/track/silverstoneWaypoints.js js/track/centerline.test.js
git commit -m "feat: add Silverstone GP centerline waypoints"
```

---

### Task 3: Track mesh group

**Files:**
- Create: `js/track/Track.js`
- Create: `js/track/Silverstone.js`

**Interfaces:**
- Consumes: `buildCenterline`, `SILVERSTONE_WAYPOINTS`
- Produces: `export class Track extends THREE.Group` with `query(x,z)` and `spawn()` → `{ x, z, tx, tz }`
- Constructor: `new Track(waypoints, { sampleCount = 4000 } = {})`
- `this._hint = 0`; `query` uses and stores hint index
- `spawn()` uses sample at `t = SILVERSTONE_SPAWN_T` (index `floor(t * samples.length)`)

Visuals (reuse ribbon idea from deleted TrackEnvironment, **local materials only**):

- Grass plane 4000×4000, color `0x3d6b32`, y = −0.08
- Runoff ribbon width `2*(halfWidth+runoff)` color `0x4a7a3c`
- Asphalt ribbon width `2*halfWidth` color `0x2a2a2e`
- Kerb ribbons 1 m, canvas red/white (copy `_makeCurbTexture` from old TrackEnvironment)
- White edge lines 0.2 m at `±(halfWidth-0.1)`
- Dashed centre from canvas
- Barrier boxes/extrusion at `±wallLimit`, height 1.1 m, color `0xcccccc`
- Start/finish: two white 0.4×12 m planes on Hamilton Straight sample, 8 m apart

Fog/sky are HelloRacer’s job, not Track’s.

- [ ] **Step 1: No WebGL unit test** — mesh is visual. Sanity-check query via Node by instantiating only `buildCenterline` (already tested). Skip Three in Node.

- [ ] **Step 2: Implement `Track.js` and `Silverstone.js`**

`Silverstone.js`:

```js
import { Track } from './Track.js';
import { SILVERSTONE_WAYPOINTS, SILVERSTONE_SPAWN_T } from './silverstoneWaypoints.js';

export function createSilverstone() {
  return new Track(SILVERSTONE_WAYPOINTS, { spawnT: SILVERSTONE_SPAWN_T });
}
```

Ribbon helper must use **per-sample** `halfWidth` / `runoff` (not a constant width). For each sample i, left/right edges at `±offset` along `(nx,nz)`.

- [ ] **Step 3: Syntax-check**

Run: `node --check js/track/Track.js && node --check js/track/Silverstone.js`  
Expected: exit 0 (`Track.js` may fail `node --check` only if it uses `import` from `three` — that is OK; `node --check` still parses)

- [ ] **Step 4: Commit**

```bash
git add js/track/Track.js js/track/Silverstone.js
git commit -m "feat: build Silverstone asphalt, kerbs, runoff, and barriers"
```

---

### Task 4: Bicycle physics kernel

**Files:**
- Create: `js/physics/bicycle.js`
- Test: `js/physics/bicycle.test.js`

**Interfaces:**
- Consumes: a `query`-shaped sample (`surface`, `wallLimit`, `lateral`, `normal`)
- Produces:

```js
export const MU = { tarmac: 1.6, kerb: 1.2, grass: 0.35 };
export function step(state, input, sample, dt);
```

`state`: `{ vx, vy, av, axPrev }` car-local: `vx` forward, `vy` lateral, `av` yaw rate, `axPrev` last long. accel for load transfer  
`input`: `{ throttle }` in `[-0.25, 1]` (reverse crawl 0.25 max), `{ brake: boolean, steer: radians }`  
`step` returns new `{ vx, vy, av, axPrev, fx, fy }` (forces for debug optional)

Constants inside `bicycle.js`:

```js
export const MASS = 800;
export const WB = 3.3928;
export const LF = WB * 0.46; // CoM to front (54% rear static → lf = 0.54*WB? )
```

Static: 46% front → distance to **rear** is 0.46*WB, distance to **front** is 0.54*WB:

```js
export const LF = WB * 0.54; // CoM → front axle
export const LR = WB * 0.46; // CoM → rear axle
export const POWER = 650000;
export const RHO = 1.225;
export const CDA = 1.55;
export const CLA = 4.6;
export const G = 9.81;
export const H_CG = 0.32;
export const BRAKE_DEMAND = 18000;
export const ENGINE_FX_MIN = -2000;
export const ENGINE_FX_MAX = 14000;
export const PACEJKA_B = 12;
export const PACEJKA_C = 1.35;
```

Aero: `Fd = 0.5*RHO*v*v*CDA` opposing `vx`; `FL = 0.5*RHO*v*v*CLA` added to axle loads (split 40/60 front/rear).  
`FzF = MASS*G*LR/WB + 0.4*FL - MASS*axPrev*H_CG/WB` (clamp ≥ 200)  
`FzR = MASS*G*LF/WB + 0.6*FL + MASS*axPrev*H_CG/WB` (clamp ≥ 200)  
μ from `MU[sample.surface]`  
`Dlat = μ*Fz`, `Fx max` same for friction circle: `F = hypot(Fx,Fy) <= μ Fz`.  
Pacejka lat: `Fy = Dlat * sin(C * atan(B * alpha))`.  
Engine: if throttle>0, `FxEng = clamp(POWER / max(vx, 3), ENGINE_FX_MIN, ENGINE_FX_MAX) * throttle`; if throttle<0 and vx<8, `FxEng = throttle * 4000`.  
Brake: `FxBrk = -sign(vx) * BRAKE_DEMAND` if brake and |vx|>0.3.  
Net Fx clipped to rear+front long. budget.  
Yaw inertia `Iz = MASS * WB * WB * 0.12`.  
Integrate: `vx += dt*Fx/MASS`, `vy += dt*Fy/MASS`, `av += dt * (FyF*LF - FyR*LR) / Iz` with small yaw damp `av *= (1 - min(1, dt*1.2))`.

Barrier is **not** inside `step`; Car applies `applyWallImpulse` after converting to world. `step` only uses sample for μ.

- [ ] **Step 1: Write failing tests**

```js
// js/physics/bicycle.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { step, MASS } from './bicycle.js';

const tarmac = { surface: 'tarmac', wallLimit: 20, lateral: 0, normal: { x: 1, z: 0 } };

test('straight-line pull exceeds 83 m/s', () => {
  let s = { vx: 1, vy: 0, av: 0, axPrev: 0 };
  const dt = 1 / 120;
  for (let i = 0; i < 120 * 25; i++) {
    s = step(s, { throttle: 1, brake: false, steer: 0 }, tarmac, dt);
  }
  assert.ok(s.vx >= 83, `vx=${s.vx}`);
});

test('grass μ is lower than tarmac at 40 m/s 2° slip', () => {
  const slip = 2 * Math.PI / 180;
  const a = step({ vx: 40, vy: 40 * Math.tan(slip), av: 0, axPrev: 0 },
    { throttle: 0, brake: false, steer: 0 }, tarmac, 0.008);
  const g = step({ vx: 40, vy: 40 * Math.tan(slip), av: 0, axPrev: 0 },
    { throttle: 0, brake: false, steer: 0 }, { ...tarmac, surface: 'grass' }, 0.008);
  assert.ok(Math.abs(a.fy) > Math.abs(g.fy) * 2);
});
```

Return `fy` from `step` as the lateral force in car space.

- [ ] **Step 2: Run tests — expect FAIL** (module missing)

Run: `node --test js/physics/bicycle.test.js`

- [ ] **Step 3: Implement `bicycle.js`** so both tests pass. Tune `Iz` / yaw damp only if the straight-line test is affected (it should not be).

- [ ] **Step 4: Run tests — expect PASS**

Run: `node --test js/physics/bicycle.test.js`

- [ ] **Step 5: Commit**

```bash
git add js/physics/bicycle.js js/physics/bicycle.test.js
git commit -m "feat: add F1 planar bicycle kernel with aero and Pacejka"
```

---

### Task 5: Wire Car to bicycle + track

**Files:**
- Modify: `js/Car.js`

**Interfaces:**
- Consumes: `step` from `bicycle.js`; `track.query(x,z,hint)`
- Produces: `updatePhysics(dt, track)`  
  `updateSteering`: `steerAngle = -smooth * maxSteer`, `maxSteer = (18 - 12 * clamp(speed/80,0,1)) * DEG2RAD` so ~6° at 80 m/s  
  Store `this._trackHint = 0`  
  Substeps: `n = 4`, `h = min(dt,0.05)/n`  
  Convert world `cvel` → local via existing `_rotateYaw`  
  `state.vx, vy = vel.x, vel.y`  
  After `step`, convert acc to world the same way as today (`_a2d`, `cvel`, `position`, `rotation.y += h*av`)  
  Barrier: if `abs(sample.lateral) > sample.wallLimit`, `applyWallImpulse(sample.normal.x, sample.normal.z, sign, penetration)` with `penetration = abs(lateral)-wallLimit`  
  NaN: if `!Number.isFinite(cvel.x)` reset to spawn pose `this._spawn` `{x,z,yaw}` set by `setSpawn(x,z,yaw)`  
  Reverse: `throttle = input.reverse && !input.forward ? -0.25 : (input.forward?1:0)`  
  Brake lights unchanged

- [ ] **Step 1: Add `setSpawn` and change `updatePhysics(dt, track)`** as above. Do not keep the old 1500 kg / linear slip model.

- [ ] **Step 2: Syntax-check**

Run: `node --check js/Car.js`  
Expected: exit 0

- [ ] **Step 3: Run physics + centerline tests still pass**

Run: `node --test js/track/centerline.test.js js/physics/bicycle.test.js`  
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add js/Car.js
git commit -m "feat: drive the car with track-aware F1 bicycle physics"
```

---

### Task 6: Swap HelloRacer world and delete Monaco

**Files:**
- Modify: `js/HelloRacer.js`
- Delete: `js/scene/TrackEnvironment.js`
- Delete: `js/scene/TracksideModels.js`

**Interfaces:**
- Consumes: `createSilverstone()` → `Track`
- Replace `TrackEnvironment` import with `createSilverstone` from `./track/Silverstone.js`
- `this.track = createSilverstone(); this.scene.add(this.track);`
- Fog: `new THREE.Fog(0xa8d6ff, 250, 1400)`
- `_placeCarOnTrack`: `const s = this.track.spawn(); this.car.root.position.set(s.x, 0, s.z); this.car.setHeadingFromTangent(s.tx, s.tz); this.car.setSpawn(s.x, s.z, this.car.root.rotation.y);`
- Remove `_resolveWallCollision` entirely
- `_animate`: `this.car.updatePhysics(dt, this.track);` — no wall pass
- Lights: keep hemisphere + key/fill; maybe lower key intensity slightly for overcast Silverstone, not required

- [ ] **Step 1: Wire HelloRacer as specified**

- [ ] **Step 2: Delete `js/scene/TrackEnvironment.js` and `js/scene/TracksideModels.js`. Grep the repo for `TrackEnvironment`, `TracksideModels`, `polyhaven`, `MONACO` — zero JS references.**

Run: `rg -n "TrackEnvironment|TracksideModels|polyhaven|MONACO" --glob '*.js' --glob '*.html'`  
Expected: no matches in `js/` or `index.html`

- [ ] **Step 3: Syntax-check HelloRacer and run Node tests**

Run:

```
node --check js/HelloRacer.js
node --test js/track/centerline.test.js js/physics/bicycle.test.js
```

Expected: PASS

- [ ] **Step 4: Manual browser pass** (`python3 server.py` → `http://localhost:8000`)

1. No tunnel, no MONACO sign, no Polyhaven asphalt URL traffic (Network panel).
2. Circuit is a large clockwise GP-shaped loop; spawn on a wide straight heading into a fast right (Abbey).
3. Full throttle on the long straight (Hangar) reaches ~300 km/h feel (if you add a temporary `console.log` of `car.forwardSpeed()*3.6`, ≥ 300).
4. Grass is slippery; walls only after runoff.
5. WASD + space + chase camera + `C` flythrough still work.

- [ ] **Step 5: Commit**

```bash
git add js/HelloRacer.js
git add -u js/scene
git commit -m "feat: replace procedural Monaco with Silverstone GP"
```

---

## Spec coverage

| Spec item | Task |
|-----------|------|
| Delete TrackEnvironment / TracksideModels | 6 |
| `Silverstone.js` waypoints | 2 |
| `Track.js` + `query` | 1, 3 |
| 5.891 km ± 5% | 2 |
| Surfaces + barrier after runoff | 1, 5 |
| Bicycle numbers, Pacejka, aero | 4 |
| `updatePhysics(dt, track)` + substeps | 5 |
| Fog / spawn Abbey | 6 |
| NaN snap to spawn | 5 |
| Manual checks | 6 |
| No elevation/gears/GLTF | all (omitted) |
