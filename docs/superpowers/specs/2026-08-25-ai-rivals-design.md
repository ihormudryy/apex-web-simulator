# AI rivals — design

Date: 2026-08-25
Status: design, approved in chat; not yet implemented

## Goal

Race a single AI opponent, side by side from a standing start, over a set race
distance, to a finish and a result.

The rival is a **solid car**: contact has consequences both ways, and it defends
its line. Its pace is set by a difficulty level rather than adapting to the
player, so a good lap is rewarded and a bad one is punished.

The start is a light sequence the player arms with an on-screen button.

**Race distance** is 3 laps by default, held in the race config rather than
hardcoded, and shown on the HUD. Three is long enough that a mistake costs the
race and short enough to re-run often at ~131 s a lap.

## Non-goals

Deliberately out of scope for this slice, in the order they would be added next:

- A full grid. The design makes a field of N a loop bound rather than a rewrite,
  but ships with one rival.
- Pit stops, tyre strategy, fuel, flags, penalties.
- Rival damage modelling beyond what the existing `damage.js` already does to
  any vehicle.
- Distinct rival car shells. The rival is a recolour of the default shell — the
  catalog shells are gitignored user downloads and are absent on a fresh clone
  and on the deployed site.

## Why the rival is a real car

The rival is a second `createVehicle()` driven by an AI that emits the **same
input object the keyboard produces** — `{forward, reverse, left, right, brake}` —
and is then advanced through the same `updateSteering` / `advance` path. It
never sets `reverse`; the field returns a stranded rival to the grid rather than
modelling a recovery, which is out of scope here. It gets
no privileged access to the physics: if the AI can do something, so can the
player, and vice versa.

Two alternatives were considered and rejected:

- **Kinematic rival on a spline.** Cheap and perfectly paced, but a kinematic
  body colliding with a dynamic one cannot be pushed, so contact becomes a wall
  that happens to be car-shaped. Incompatible with "solid".
- **Replay-driven rival**, reusing `ghost.js`. Free and perfectly paced, but it
  cannot react, so it cannot defend, and any contact desynchronises it
  permanently.

The cost of the chosen approach was measured before committing to it, driving
real vehicles over the real circuit at 600 Hz:

| Vehicles | ms per rendered frame | per vehicle |
|---|---|---|
| 1 | 0.143 | 0.143 |
| 2 | 0.249 | 0.124 |
| 5 | 0.613 | 0.123 |
| 10 | 1.199 | 0.120 |
| 20 | 2.389 | 0.119 |

**~0.12 ms per vehicle per frame, scaling linearly**, against a 16.7 ms budget at
60 Hz and a measured render cost of ~6.5 ms (WebGL) / ~3.0 ms (WebGPU). One
rival is free. A full grid would also fit, which is why the field seam is worth
building now.

## Components

All of these are pure and testable in Node except the two DOM panels. Tests are
colocated as `foo.test.js`, per repo convention.

### `js/race/racingLine.js`

Computes a racing line from centerline samples, once, at load.

**Representation.** A lateral offset `o[i]` per station, clamped to
`±(halfWidth[i] − CORRIDOR_MARGIN)`. `CORRIDOR_MARGIN` is `HALF_WIDTH` (0.98 m,
from `collision.js`) plus a margin, so the line never asks for a wheel off the
asphalt.

**Method.** Iterative curvature minimisation: repeatedly move each offset toward
the value that reduces the discrete curvature of the resulting polyline, then
clamp back into the corridor. This is the standard minimum-curvature relaxation.
Deterministic, no RNG, no new assets, and it re-derives itself for any circuit —
which matters because `defaultCircuit.js` exists precisely to allow others.

**Output.** Per station: world `x, z`, unit tangent, signed curvature, and a
speed limit `sqrt(latG · g / |curvature|)` capped by a top speed.

**Rejected alternative.** Shipping TUMFTM's `racelines/Silverstone.csv`. It is
real optimiser output, but it is LGPL data keyed to the *surveyed* geometry,
while our centerline was recentred, elbow-relaxed and rescaled to 5891 m — so it
would need the same transform pipeline the import script applies, adds licence
surface, and does not generalise to another circuit.

**Tests.**
- Every point lies inside the corridor (this is the safety property).
- Total absolute curvature is strictly lower than the centerline's.
- The offset sign flips through a corner — it actually cuts an apex rather than
  just smoothing.
- Deterministic: same input, byte-identical output.
- A lap driven on the line is faster than the same driver on the centerline.

### `js/race/aiDriver.js`

`(vehicleState, line, difficulty, opponents) → input`

- **Steering:** pure pursuit against the racing line. The lookahead scales with
  speed. The existing `makeDriver` in `lap.test.js` is the proven seed for this;
  note its comment that the target must be normalised by the lock available *at
  this speed*, not the lock at rest.
- **Speed:** scan curvature ahead over a braking distance, take the lowest speed
  any of it allows, and brake to arrive at it. `lap.test.js` records the trap
  here: planning braking at the car's peak 3 g spins it at the hairpins, so the
  planner uses a deliberately lower figure than the car's true limit.
- **Difficulty:** scales the planner's cornering and braking g-budget. The rival
  therefore always drives the same car the player does and simply uses less of
  it. Levels are calibrated by measurement, not guessed — see Calibration.
- **Defending:** a bounded lateral bias on the line when the player is close
  behind, applied only where it reads as racecraft rather than blocking. This is
  the parameter most likely to need tuning against feel after first drive.
- **Awareness:** the driver will not steer into a car alongside it.

**Tests.**
- Completes laps at every difficulty level without leaving the road.
- Lap time is monotonic in difficulty.
- Never commands steering beyond the lock available at its current speed.
- With an opponent alongside, the commanded steering does not close the gap.

### `js/race/startLights.js`

Restored from `a1b25d3^` — five reds one per second, a randomised hold, then out
together, with a jump-start rule that returns the car to the grid. That module
was well factored (72 lines, 70 lines of tests) and is recovered rather than
rebuilt.

**The one change:** a new `idle` phase before `sequence`. The sequence is armed
by the player rather than starting automatically on grid reset.

```
idle --(START pressed)--> sequence --> green --> done
 ^                           |
 |                           +--(throttle early)--> jump --> grid reset
 +-------------------------------------------------------------+
```

After a jump start the field returns to the grid and the lights return to
`idle` — the player re-arms with START. The rival is reset with the player, so
both cars always begin a race from the same state.

**Determinism.** The hold is randomised so it cannot be learned, but `ghost.js`
and `replay.js` require bit-exact repeats. The RNG is therefore seeded per race:
a replayed race reproduces exactly, while a fresh race is still unlearnable. The
existing `createStartLights(rng)` already injects the RNG, so this is a caller
change, not a module change.

### `js/physics/carContact.js`

Two-body planar contact — the moving-vs-moving sibling of `collision.js`, which
handles only static walls.

It reuses that module's footprint and method: corners at `NOSE_X = LF + 1.05`,
`TAIL_X = −(LR + 0.85)`, `HALF_WIDTH = 0.98`, an impulse at the deepest
penetrating corner with restitution and Coulomb friction, and positional
correction. The difference is that both bodies receive equal and opposite
impulses, split by mass and yaw inertia (`MASS = 800`, `IZ = MASS·WB²·0.12`);
with two equal cars that is half each.

Car-to-car restitution is its own constant, not the Armco value — carbon on
carbon is not steel on carbon.

**Tests.**
- Contact never increases total kinetic energy. This is the failure that turns a
  nudge into a launch, and it is the single most important test in the feature.
- Linear and angular momentum are conserved for a frictionless head-on case.
- A glancing blow costs less speed than a square one.
- Two cars at rest, overlapping, separate rather than jitter.
- Symmetry: swapping which car is A and which is B mirrors the result.

### `js/race/raceField.js`

Owns the field and the race.

- `stepField(field, playerInput, track, dt)` — advance the player with its input
  and each rival with its AI's input, then resolve pairwise contact.
- Positions and gaps, ordered by `(lapsCompleted, t)`.
- Race state: laps to run, per-car finish, final classification.

**Per-vehicle track cursors.** `Track` keeps a single `_hint` / `_wheelHint` on
the instance. Sharing one across cars measured ~15% slower per car (0.142 ms vs
0.123 ms with cars spread around the lap), and more importantly it is the exact
failure the module's own comments warn about. The field gives each vehicle its
own cursor.

**Grid.** There is no multi-slot grid today — `Track` exposes a single spawn
station. The field places two staggered slots at the start/finish: laterally
offset either side of the centerline, longitudinally staggered, as a real grid
is. Both cars launch on lights out.

**Tests.**
- Two cars, fixed inputs, deterministic over many steps.
- Positions order correctly across a lap boundary (the seam where `t` wraps).
- A car that finishes stops being classified as racing.
- Contact between field members is resolved exactly once per step.

### DOM

- `js/dash/StartLightsHud.js` — restored, plus the START button that arms the
  sequence.
- `js/dash/RivalPanel.js` — difficulty selector and a gap/position readout,
  following the plain-DOM, injected-style pattern of `ControlHints` and
  `PhysicsModePanel`.

### `js/BinLoader.js`

Add a geometry cache keyed by URL. `BinLoader.load` currently has none, so a
second `Car` would re-fetch and re-parse every mesh and duplicate the geometry on
the GPU. The mod system benefits from the same fix.

### Rival livery

A recolour of the default shell. `carProceduralMaps.js` already generates
material maps from the shipped base textures, which is the hook: the rival gets a
hue-shifted variant of `BodyPaint.jpg`. No new assets, works on a fresh clone and
on the deployed site.

## Calibration

Difficulty levels are set by measurement rather than assertion. `lap.test.js`
records roughly 131 s for a flat-out lap and around 150 s for a cautious
planner, so **three levels** ship, chosen by running the AI across a range of g-budgets,
recording the resulting lap times, and picking the three that best span
"beatable by a careful driver" through "quicker than the reference lap". The
level names and their measured lap times are filled in from that run and
recorded in the module header; the monotonicity test guards the ordering.

If no g-budget produces a rival quicker than a good human lap, that is a finding
to report rather than paper over — it means the driver model, not the level
table, is what needs work.

## Risks

**Racing-line quality is the whole feature.** A bad line makes the AI look drunk
at every difficulty. It is the part most likely to need iteration after first
drive, and the corridor and curvature tests bound correctness but not elegance.

**Defending is a feel parameter.** Subtle reads as racecraft; overdone reads as
blocking. Only the user can judge where that line sits, so it ships conservative
and gets tuned against real driving.

**Contact plus AI defending can feel cheap.** The energy test prevents launches,
but not every unsatisfying nudge.

## Implementation order

Each step is independently verifiable, and the feature is drivable from step 5.

1. `BinLoader` geometry cache — unblocks a second car cheaply.
2. `racingLine.js` + tests. Verify it beats the centerline on lap time.
3. `aiDriver.js` + tests, driving on the line. Calibrate difficulty here.
4. `carContact.js` + tests, including the energy property.
5. `raceField.js` + tests; wire one rival into the shell and drive it.
6. `startLights.js` restored with the `idle` phase, plus the HUD and START
   button.
7. `RivalPanel.js`, the recoloured livery, and the README/controls update.
