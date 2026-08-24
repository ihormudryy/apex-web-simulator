# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Layout note

The git repository root is `helloracer/webgl/` (this directory), not the `f1/`
parent. All paths and commands below are relative to here.

## No build step

ES modules are served straight from disk. `three` is a bare specifier resolved by
an importmap that `index.html` injects at runtime, pointing at jsDelivr. There is
no bundler, no transpile, no `node_modules` for the page. Editing a `.js` file and
reloading is the whole loop.

## Commands

```bash
python3 server.py                # serve on :8000 — use this, not http.server
npm test                         # full suite (795 tests, ~7 s)
npm run validate                 # physics reference dashboard
npm run validate:drive           # driving-feel probes (braking, steering)
npm run validate:visual          # image-quality dashboard — needs Chrome + GPU
npm run validate:aa              # AA vs 3x supersampled ground truth
npm run test:visual              # CDP screenshot regression — starts its own server
npm run assets                   # re-download the legacy meshes/textures
npm run assets:livery            # regenerate BodyPaint.jpg (needs local legacy mask)
```

One test file, or one test by name:

```bash
node --import ./scripts/test-setup.mjs --test js/physics/wheel.test.js
node --import ./scripts/test-setup.mjs --test --test-name-pattern="camber" js/physics/wheel.test.js
```

`--import ./scripts/test-setup.mjs` is Node's stand-in for the page importmap: it
registers a loader hook mapping `three` to `test/vendor/three/`. Without it any
test that touches three.js fails to resolve.

**`server.py`, not `python3 -m http.server`.** The legacy meshes in `obj/js/*.bin`
are raw gzip streams named `.bin`, so they need `Content-Encoding: gzip` — but a
glTF's `scene.bin` is *not* gzipped, and announcing gzip for it fails the whole
model with `ERR_CONTENT_DECODING_FAILED`. `server.py` sniffs the magic bytes to
tell them apart, and sends `Cache-Control: no-store` so a half-updated module
cache can't surface as a phantom missing export.

### `validate*` are dashboards, not gates

`npm test` is the red/green suite. The `validate*` scripts are reporting tools:
their reference targets are approximate public F1 figures, so failing lines are
expected and normal. `js/physics/reference.test.js` covers the *measuring* code
and does stay green.

## The three.js version pin

`index.html` pins `three@0.185.1` on the CDN. `test/vendor/three/` must be the
**same revision** — `js/sceneGraph.test.js` asserts `THREE.REVISION` matches the
version parsed out of `index.html`. Bumping the CDN version means re-vendoring
`test/vendor/three/{three.module.js,three.core.js}` in the same commit.

Always import the bare specifier `three`. A `Texture` or `Material` constructed
from a different three build than the renderer will not work.

## Architecture

### Sim clock ≠ frame clock

The load-bearing decision. `js/physics/fixedStep.js` runs an accumulator at
`SIM_HZ = 600`, capped by `MAX_CATCHUP` (0.1 s) to prevent the slow-frame death
spiral. Consequences to preserve:

- **Determinism** — same inputs, same trajectory, on any refresh rate.
- **Replay** — `js/physics/replay.js` / `ghost.js` depend on bit-exact repeats.
- **Smoothness** — the renderer reads `renderPose()` (`js/physics/vehicle.js`),
  which lerps the two most recent sim states by `1 - clock.alpha`. **The scene
  graph must never read raw state directly**, or you get 10/10/11-steps-per-frame
  micro-stutter.

### State is one flat Float64Array

`js/physics/state.js` defines `S_*` index constants into a single `Float64Array`.
Two reasons, both worth not breaking: it can be a `SharedArrayBuffer` handed to a
worker, and the 600 Hz inner loop allocates nothing. Float64 not Float32 — the
world is a kilometre across and float32 jitter breaks replay determinism.

### No physics library

`js/physics/kernel.js` is a purpose-built four-corner model: per-wheel load,
surface, temperature, wear and angular velocity; tyre relaxation length; 7-DOF
vertical system; ride-height-dependent ground effect. Ammo/Cannon/Rapier vehicle
helpers are raycast-per-wheel arcade models and were rejected deliberately — the
module header explains what each replacement fixed.

### Sign conventions (get these wrong and nothing looks right)

- **World**: the car faces **−Z** at yaw 0. Forward is `(−sin yaw, −cos yaw)`.
- **Body**: x forward, y **right**. Wheel order is always **FL, FR, RL, RR**.
- `av` is yaw-**left** positive, matching three.js `rotation.y`.
- Steer is positive-left.

### Scene graph: why there are three nested nodes

`js/Car.js` builds `root → attitude → visualRoot → body`, and each level exists
for a bug that shipped once already (`js/sceneGraph.test.js` is the regression
net — it constructs the *real* `Car` on vendored three, drives the *real*
physics, and asserts world-space positions against the authored `.bin` meshes).

- **`root`** — position + **yaw only**. Wheels are children of `root`, so their
  lateral axis *is* ±X. That is why `WHEEL_MESH_YAW` is `[0, π, 0, π]`; the 2011
  demo's ∓90° values belonged to its +X-forward frame and pointed every axle
  fore-aft.
- **`attitude`** — pitch/roll, and it must sit **outside** `visualRoot`. An Euler
  with `y` pinned at 90° gimbal-locks x and z into one lateral rotation, which
  made roll literally unrenderable.
- **`visualRoot`** — constant `rotation.y = 90°`, so **+X is forward** here.
- **`body`** — offset by `MESH_FORWARD_OFFSET`, because **the mesh origin is not
  the CoG**. The physics splits `WB` into `LF`/`LR` about the CoG; the authored
  hubs sit 1.3964 m ahead and 2.0 m behind the mesh origin.

Drawing and physics deliberately disagree on track width: `TRACK_HALF = 0.8`
(handling, `js/physics/constants.js`) vs `AUTHORED_TRACK_HALF = 0.69` (where the
mesh's wishbones actually reach, `js/render/wheelVisual.js`). Don't "fix" this.

### Two renderer backends, one codebase

WebGPU is the default. `?renderer=webgl` or the Render panel switches (the panel
saves and **reloads** — three builds can't hot-swap). `index.html` picks
`three.webgpu.js` vs `three.module.js` in the importmap before any module loads.

- **WebGPU path**: `js/render/webgpuPipeline.js`, TSL nodes — GTAO, SSGI, TRAA,
  sharpen, `CSMShadowNode`.
- **WebGL path**: `EffectComposer`, the grading pass, TAA and the `CSM` addon.
  These are WebGL-**only** because they need `ShaderChunk`, which the WebGPU
  build does not export.

`validate:visual` and `validate:aa` pin `?renderer=webgl` for that reason —
unpinned, they scored whichever pipeline the browser happened to negotiate. Both
also require the real GPU (`gpu: true` in `scratchpad/cdp.mjs`); SwiftShader
filters differently and any image metric from it is fiction.

`window.racer` is the live handle the CDP scripts poll for.

### Directory map

| Path | What lives there |
|---|---|
| `js/HelloRacer.js` | app shell: scene, cameras, lights, FX toggles, input, `_animate()` |
| `js/Car.js` | the car's three.js side — meshes, wheels, shell adoption |
| `js/physics/` | the sim: `kernel`, `state`, `fixedStep`, `vehicle`, tyre/aero/powertrain |
| `js/render/` | procedural PBR maps, post pipelines, visual↔physics glue |
| `js/track/` | circuit construction from waypoints → centerline → ribbon + trackside |
| `js/dash/` | HUD, telemetry, minimap, panels (plain DOM, no framework) |
| `js/mod/` | user/catalog glTF shells: catalog, drop zone, fitting |
| `scripts/` | test loader hooks + the `validate*` dashboards |
| `docs/plans/`, `docs/superpowers/` | design docs; read the plan before extending a phase |

## Conventions

- Tests are colocated: `foo.js` → `foo.test.js`, `node:test` + `node:assert/strict`.
  Pure functions are extracted specifically so they can be tested without a GPU.
- Module headers carry the *why*, often including the measured symptom of the bug
  that motivated the design. When changing such a module, update its header.
- Prefer extracting a pure function into `js/render/` or `js/physics/` over adding
  logic to `HelloRacer.js` or `Car.js` — that's the pattern the test suite relies on.

## Constraints that are not style preferences

- **No trademarked branding in user-facing strings.** The circuit ships as
  `Northamptonshire Circuit` (`js/track/defaultCircuit.js`), the livery is
  fictional "Apex Racing". See the README disclaimer.
- **`obj/textures/BodyPaint.legacy.jpg` must never be committed** — real sponsor
  marks. It is gitignored; keep it that way.
- **`obj/cars/*` is gitignored** (CC-BY Sketchfab shells the user downloads). A
  catalog entry's `hasOwnWheels` flag is set **by hand** on purpose — it cannot
  be detected reliably, and guessing wrong either floats the car or draws two
  sets of tyres. See the comment in `js/mod/carCatalog.js`.
- Preference keys are `apex-web-simulator.*` in localStorage, with
  `helloracer.*` read as a legacy fallback.

## Domain vocabulary (`CONTEXT.md`)

**Circuit** is the physical racing course; **Circuit Definition** is the portable
JSON that constructs one; **Circuit Catalog** is the shipped set, keyed by a
stable id. Avoid "track"/"level"/"scene data" for these in new prose and new
identifiers — the existing `js/track/Track.js` predates the vocabulary.
