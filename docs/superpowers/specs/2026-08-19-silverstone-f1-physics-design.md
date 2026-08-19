# Silverstone GP track + F1 bicycle physics

Date: 2026-08-19  
Status: requirements approved in session; awaiting spec sign-off before implementation plan

## Goal

Remove the procedural Monaco-style world. Replace it with a Silverstone Grand Prix layout at **1 unit = 1 metre**, and retune the car to a planar F1-style bicycle model (Pacejka tires, load transfer, downforce). Chase camera and keyboard controls stay.

## Constraints (settled)

- Planar track (Silverstone elevation ~11 m is ignored).
- No physics engine, no GLTF circuit, no licensed F1 mesh.
- No gears / ERS / DRS / weather / tire wear / ABS-TC UI.
- Reverse is a slow recovery crawl, not a race direction.
- Surroundings are a grass/runoff skirt only (no tunnel, grandstands, pit building, or trackside glTF clutter).

## Architecture

### Delete

- `js/scene/TrackEnvironment.js` — Monaco ribbons, tunnel, MONACO gantry, Polyhaven texture world
- `js/scene/TracksideModels.js` — unused duck/car/lantern scatter
- HelloRacer `wallOffset` barrier logic that assumes a constant Monaco wall distance

### Add

| Module | Responsibility |
|--------|----------------|
| `js/track/Silverstone.js` | GP centerline waypoints, per-segment half-width and runoff, spawn pose |
| `js/track/Track.js` | `THREE.Group` that builds meshes from a centerline and exposes `query(x, z)` |

`Car.updatePhysics(dt, track)` reads `track.query` each physics substep. HelloRacer owns renderer, camera, input; it does not compute surface type or wall distance itself.

### Frame loop

1. `car.updateSteering(dt)`
2. `car.updatePhysics(dt, track)` — 2–4 substeps, `dt` total clamped to 0.05 s
3. Chase camera (existing Forza-style boom)
4. Render

### `query(x, z)` contract

Returns:

- `tangent` — unit XZ forward along the circuit (clockwise)
- `normal` — unit XZ left-hand perpendicular
- `lateral` — signed distance from centerline (positive = right of travel)
- `halfWidth` — tarmac half-width at that station (m)
- `surface` — `'tarmac'` \| `'kerb'` \| `'grass'`
- `wallLimit` — distance from centerline to barrier (m)

Surface: `|lateral| < halfWidth` → tarmac; next 1 m → kerb; else grass.  
Barrier impulse only when `|lateral| > wallLimit`.

Nearest-station search uses a precomputed sample table (~4000 points) and a last-index window so Hangar Straight does not scan the whole lap every substep.

## Track mesh (Silverstone GP)

- Length target: **5.891 km** (FIA GP layout).
- Direction: clockwise. Start/finish: **Hamilton Straight**, car spawned on the grid facing **Abbey**.
- Centerline: ~80–100 hand-authored waypoints matching the 2011– corner sequence and relative straight lengths (not a GPS survey). Scale the closed loop so arc length is 5891 m ± 5%.

Corner order:

Hamilton Straight → Abbey (T1) → Farm → Village → The Loop → Aintree → Wellington Straight → Brooklands → Luffield → Woodcote → Copse → Maggotts–Becketts–Chapel → Hangar Straight → Stowe → Vale → Club → Hamilton Straight.

Visuals generated from the centerline:

- Asphalt ribbon, 12–17 m total width (17 m on the grid)
- Red/white kerbs, white edge lines, dashed centre line
- Green runoff, wider at Stowe / Copse / Club, tighter at The Loop
- Barrier only at the outside of runoff
- Grass skirt as the only world; sky colour + fog far enough for Hangar Straight (~700 m+ `fog.far`, camera far plane already large)
- Start/finish marks on Hamilton Straight

No Polyhaven remote textures required; procedural canvas / solid PBR materials are enough for asphalt, grass, and kerbs.

## Physics

Keep the existing `cvel` mapping and −Z car facing so the chase camera stays valid.

| Parameter | Value |
|-----------|--------|
| Mass | 800 kg |
| Wheelbase | 3.3928 m (mesh) |
| Static weight | 46% front / 54% rear |
| Peak power | 650 kW, force = power / max(\|vx\|, 3), torque-capped at low speed |
| Aero | `F_d = 0.5 ρ v² CdA`, `F_L = 0.5 ρ v² ClA` with ρ = 1.225, **CdA = 1.55**, **ClA = 4.6** (downforce). Hangar Straight target **≥ 83 m/s** (~300 km/h) in a straight-line pull |
| Drive cap | Engine Fx = clamp(power / max(\|vx\|, 3), −2000, 14000) N before tire clip |
| Brakes | Brake demand 18 kN, clipped by tire Fx; **4–5 g** when aero is loaded on tarmac |
| Steer | 18° max at rest, reduced with speed (about 5–6° at 80 m/s) |
| Reverse | Low-speed crawl only |

Tires: simplified Pacejka `D * sin(C * atan(B * slip))` for lateral and for long. force. `D` from vertical load × μ:

- tarmac μ = 1.6
- kerb μ = 1.2
- grass μ = 0.35

Longitudinal load transfer from ax: front unloads on throttle, loads on brake. Combined long/lat clipped to the friction circle.

Barrier: remove outward velocity component, small restitution, yaw damp. Grass is low μ, not a wall.

Brake lights: unchanged (brake or reverse).

## Error handling

- Missing track query (car off samples): treat as grass; barriers still come from the last good `wallLimit`. Do not add a second world AABB wall.
- Mesh load failures stay as today (`BinLoader` console error); track itself is procedural and cannot 404.
- Physics NaN: if `cvel` is non-finite, zero velocity and snap back to spawn.

## Testing

No unit-test runner in the repo. Manual checks after implementation:

1. Procedural Monaco world gone (no tunnel, no MONACO sign, no Polyhaven track fills).
2. Lap distance along centerline ~5.89 km; clockwise from Hamilton Straight into Abbey.
3. Straight-line speed on Hangar Straight ≥ 300 km/h with downforce increasing high-speed grip.
4. The Loop is the slowest corner; Maggotts–Becketts remain high-speed if the car is committed.
5. Grass is slippery; barriers only after runoff.
6. WASD + space still drive; chase camera still follows; `C` flythrough still works.

## Out of scope

Elevation, driveable pit lane, 3D grandstands, photogrammetry, gearbox, DRS, weather, tire degradation, jumping (leave the ground).

---

## Amendments (Three.js r185 migration + bug fix pass)

Recorded so this spec stops contradicting the code. Everything below is verified
by `node --test`.

### Track: corners have radii

The 21-waypoint fallback ring in the plan was taken literally and shipped as a
**polygon**, so every corner had zero radius — up to an 83° instantaneous change of
heading at Farm. That is undrivable at any speed (an autopilot capped at 10 m/s
could not get past it) and it folded the swept ribbon and the barriers back on
themselves on the inside of every turn.

- `js/track/fillet.js` replaces each vertex with a tangent circular arc.
- `SILVERSTONE_CORNERS` now carries a `radius` per corner **in true metres**;
  `filletToLength` scales the control polygon, not the radii, so the lap stays
  5891 m while the corner speeds stay as authored.
- Tightest corner is The Loop at ~30 m (≈80 km/h), Copse ~197 m (≈200 km/h).
- Invariant, tested: every station's turn radius exceeds its own
  `halfWidth + runoff`, which is the condition for a swept ribbon not to
  self-intersect.

### Physics numbers that changed

| Item | Spec said | Now | Why |
|------|-----------|-----|-----|
| Brake demand | 18 kN, "4–5 g" | 30 kN | 18 kN is 2.29 g on 800 kg; the two figures contradicted each other. 30 kN measures 4.95 g at 80 m/s and clips to ~1.7 g at low speed. |
| Brake bias | 40% front | 58% front | Under 5 g the front axle carries ~14.5 kN against the rear's ~11.4 kN. |
| Engine braking | `ENGINE_FX_MIN = -2000` (never reached) | 2.5 kN, fading below 20 m/s | Off-throttle the car only had drag, so it coasted from 40 m/s to 10 m/s over a minute and never stopped. |
| Rolling resistance | absent | 0.015·Fz, plus an arrest below 0.4 m/s | Same reason. |
| Aero | on `\|vx\|`, clipped by the friction circle | on total speed, applied to the body | Drag is not a contact-patch force, and a sliding car keeps its dynamic pressure. |
| Reverse | throttle −0.25 gated to `\|vx\| < 8` | brakes while rolling forward, then crawls, capped at 8 m/s | The key lit the brake lights and did nothing at all above 8 m/s. |
| Slip-angle denominator | `max(\|vx\|, 0.1)` | `max(\|vx\|, 2)` | At rest the slip angle hit 90°, saturating the tyre and making the integrator bang-bang: lateral velocity flipped sign every substep forever. |
| Substeps | fixed `n = 4` | `ceil(dt·240)`, 4–16 | A 20 fps frame integrated three times coarser than a 60 fps one. |

### Architecture

`Car.updatePhysics` no longer owns the integration. `js/physics/vehicle.js` holds
the state, substepping, world↔body transform, barrier impulse and NaN recovery,
free of Three.js; `Car` is the Object3D adapter. The tests drive the same module
the browser drives — the previous duplicate of that maths inside
`bicycle.test.js` is how the tests drifted from the app.

World velocity is stored as plain XZ (`vx`, `vz`) instead of the rotated `cvel`
pair. The external contract is unchanged: the car still faces −Z at yaw 0 and
`headingForward` is still `(-sin y, 0, -cos y)`, so the camera code is unaffected.

### Rendering

- Chase-camera boom was at `pos.x - hDist·sin(yaw)`; opposite `headingForward`
  means `+sin`. The camera sat to one side at every heading but 0/180°.
- `scene.environment` is a generated sky-to-grass gradient run through
  `PMREMGenerator`. `obj/textures/envmap/` is a dark studio interior from the
  original showroom demo and is no longer used for lighting — reflecting a black
  room on an outdoor circuit is worse than reflecting nothing.
- Barrier faces each carry their own flat normal. Sharing vertices round the
  profile and calling `computeVertexNormals()` averaged the wall with the cap into
  45° normals, half tilted downward, which is what made the barriers read navy.
- Kerb stripes and centre-line dashes are sized in metres (0.75 m blocks, 3 m
  dash / 6 m gap) rather than by a fixed texture-repeat count over the lap, which
  had produced 10.6 m kerb blocks and 12.7 m dashes.
- Camera range is 0.25–6000 m, and the coplanar track strips are separated with
  `polygonOffset` rather than by height alone. Depth bias is measured in
  depth-buffer units, so it holds at any distance; height alone lost the asphalt
  to the runoff beneath it beyond ~600 m and the road rendered as grass.
- Ground plane is centred on the circuit and extends past `fog.far`. Centred on
  the origin its edge sat ~1 km from the east side of the track, inside fog range.
- The blob shadow is `toneMapped: false`. `MultiplyBlending` makes the fragment
  colour the blend factor, and ACES maps white to ~0.8, so the texture's white
  surround was tinting a whole 7.2 m square 10% grey with a hard rectangular edge.
- Start/finish line spans the road it is painted on instead of a fixed 12 m.
- Frame delta is clamped once in `_animate`. Unclamped it reached
  `updateSteering` and the camera, so a backgrounded tab slammed full lock.

**Corrected mid-pass:** `scene.background` was briefly replaced with a
tone-mapped sky dome on the theory that a background `Color` and `Fog` could not
match. They do match — Three keeps `fog.color` in *output* space and mixes it
after tone mapping, exactly as it clears with `background` — so the dome was the
thing creating a seam. Reverted.

### Grip allocation — the "drives like it's on ice" fix

The kernel has no wheel-speed state, so longitudinal force is a **demand**: the
engine asks `POWER / max(|vx|, 3)` capped at `ENGINE_FX_MAX`. Below about 46 m/s
that cap binds at a flat 14 kN, which is more than the rear tyres can transmit —
the rear friction circle is ~11 kN at mid-corner speeds.

The old `clipFriction` scaled **both** components down by the same factor to fit
the circle. Measured at a steady 40 m/s corner it was scaling by 0.63, so a car on
the throttle surrendered 35-40% of its rear cornering force to a drive force the
contact patch could never have delivered. Steady-state sideslip at 40 m/s was 16°,
and full throttle at 25 m/s with lock on spun the car inside 2.5 s.

`allocateGrip` replaces it: cornering force is taken first, and the drive force is
whatever the friction ellipse has left, `sqrt(maxF² - fy²)`. That is what a contact
patch does once it starts to spin, and it puts the loss where it belongs — you
cannot accelerate hard mid-corner, but asking for it no longer costs you the corner.

Straight-line performance is untouched, because with no cornering force the whole
circle is available: 0-100 km/h stays at 2.63 s and a launch is still
traction-limited to about 1 g from rest.

Measured sideslip, step steer, before → after:

| Manoeuvre | Before | After |
|-----------|--------|-------|
| 6° @ 40 m/s, speed held | 16.5° steady | **3.0°** |
| 12° @ 40 m/s, full throttle | 11° peak | **3°** |
| 18° @ 25 m/s, full throttle | 118°, spun at 2.5 s | **3°** |
| 18° @ 15 m/s, full throttle | 126°, spun at 1.6 s | **2°** |
| Autopilot at 1.4 g / 45 m/s | 0 laps, spun at 17.6 s | **3 clean laps, 141 s, 5° peak** |

The car is not on rails: trail-braking into a corner at 40 m/s still spins it to
66°, because the front uses all its grip cornering and leaves the braking to the
rear alone. An autopilot targeting 1.8 g still runs wide at Abbey, as it should.

### The yaw damper stays

`newAv *= 1 - min(1, dt * 1.2)` is artificial, standing in for tyre relaxation and
aero yaw damping. It was re-tested after the grip fix and it is still load-bearing:
without it a coasting car at 6° of lock and 40 m/s spins to 177°. It also *reduces*
turn-in overshoot rather than dulling the response (3.8° peak with, 5.3° without).
