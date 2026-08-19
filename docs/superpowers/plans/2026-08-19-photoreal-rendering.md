# Photoreal rendering — implementation plan

Date: 2026-08-19
Audience: **Cursor** (implementing agent)
Baseline commit: `9674302`
Target: three.js **0.185.1** (already the pinned version in `index.html`)

> **For the implementing agent:** work the phases in order. Each task has a
> *Verify* step with a numeric or pixel-level pass condition. A task is not done
> until its Verify passes. Do not batch phases — Phase 0 exists because three
> separate defects in the current renderer were invisible until someone booted
> the page and read pixels.

---

## Why this plan is ordered the way it is

An audit of the current renderer against the priority list found **11 items done,
6 partial, 7 absent** — and the scene rendering **entirely black below the
horizon**. Features were landing faster than they were verified. Three defects
found by inspection, all of which had shipped:

| Defect | Why it was invisible |
|--------|---------------------|
| `CSM.lightDirection` was given the direction *toward* the sun | Cascade lights sat at y = −163…−894, under the circuit, lighting only downward-facing surfaces. Fixed in `9674302`. |
| `PCFSoftShadowMap` requested | Silently downgraded to hard `PCFShadowMap` in 0.185 — warns on **every boot**, so penumbras were never soft |
| `SSAOPass.minDistance = 0.003`, `maxDistance = 0.09` | These are fractions of the camera's near→far range. With `far = 6000` that is an **18 m–540 m** occlusion window: physically incapable of bodywork-recess AO. Toggling the pass changed nothing. |

The lesson encoded below: **every visual task ships with a measurement**, and
Phase 0 makes "renders black" unable to reach a commit again.

---

## The decision that sets the ceiling: WebGPURenderer

The single highest-leverage choice. Verified against the 0.185.1 package:

- `three/webgpu` → `build/three.webgpu.js` exists, exporting `WebGPURenderer`
- It carries a **`WebGLBackend`** and a `forceWebGL` flag — it **auto-falls back
  to WebGL2**, so this is not a hard browser requirement
- `three/tsl` → `build/three.tsl.js` for the node material / post-processing language

What the TSL node path has that the WebGL `postprocessing/` path does not:

| Capability | WebGL path (current) | WebGPU/TSL path |
|---|---|---|
| Ambient occlusion | `SSAOPass`, `GTAOPass` | **`GTAONode`** + `DenoiseNode` |
| Global illumination | *nothing* | **`SSGINode`** — real screen-space GI |
| Reflections | `SSRPass` (crude) | **`SSRNode`** |
| Temporal AA | `TAARenderPass` (accumulation; static scenes only) | **`TRAANode`** / `TAAUNode` — true temporal reprojection |
| Colour grading | `LUTPass` | **`Lut3DNode`** |
| Micro-contrast | *nothing* | **`SharpenNode`** |
| Perf headroom | *nothing* | **`FSR1Node`** — render low, upscale |
| Denoising | *nothing* | `DenoiseNode`, `RecurrentDenoiseNode` |
| Better IBL | — | `ImportanceSampledEnvironment` |

My earlier advice to *cut* SSR and GI was correct **for the WebGL path** and is
withdrawn for the node path: there, they are first-class and denoisable.

**Recommendation: migrate to `WebGPURenderer` in Phase 2.** Photorealism on the
WebGL path plateaus at roughly "good real-time 2015". Everything in Priorities
3–5 that is still missing is either easier or only possible on the node path.

### If you do NOT migrate

There is still a large, cheap win available in 0.185 WebGL:
`renderer.setEffects([...])`. It is a **built-in compositing pipeline** that
ping-pongs internal targets and **applies tone mapping and colour-space
conversion automatically at the end** (`OutputPass` becomes unnecessary — the
renderer used to warn about exactly that). It requires
`outputBufferType: HalfFloatType | FloatType`.

This matters because the current chain is
`EffectComposer → RenderPass → SSAOPass → OutputPass` writing into an
**8-bit `WebGLRenderTarget`**. SSAO therefore operates on tone-mapped LDR pixels.
That is backwards: AO is a lighting term and must be applied in linear HDR
*before* tone mapping. Any AO tuned in that arrangement is tuned against the
wrong signal.

---

## Phase 0 — Stop the bleeding (do this first, alone)

**Nothing else in this plan is judgeable while the scene is black.**

### 0.1 Finish un-blacking the render

`9674302` fixed the inverted sun; near-ground pixels went `(0,1,2) → (21,22,24)`.
Still far too dark. Three compounding causes, all confirmed by reading source:

1. `asphaltMaps.albedoFromHeight` produces `grey = 38 + h*28` → **38–66 / 255**.
   Real dry asphalt is ~80–110 sRGB. Raise it.
2. Track material `envMapIntensity` is **0.12–0.18** — these were almost
   certainly tuned to compensate for the unlit scene. With the sun working they
   should return to ~1.0.
3. Three ambient sources are stacked: `AmbientLight(0.32)` +
   `HemisphereLight(0.85)` + `environmentIntensity 1.35`. Delete the
   `AmbientLight` (it is flat and unconditional, the worst of the three) and
   rebalance the other two.

Tune these **together, in that order** — they are one system, and changing one
without the others tells you nothing.

*Verify:* boot headless, sample pixels at ≥5 points around the circuit. Sunlit
tarmac in the **(80, 80, 85) – (120, 120, 130)** range; grass green channel
> 100; no sample below (12,12,12). Compare against a reference screenshot at
each of 3 camera modes.

### 0.2 Regression guard against a black world

A test that boots the page headless, drives to a fixed track station, samples
the ground, and **fails** if mean luminance is below a floor.

*Verify:* the guard **fails** when pointed at commit `fbb8f1f`, and passes on
`HEAD`. A guard that has never failed is not a guard.

There is a working CDP harness to build on: `scratchpad/cdp.mjs` launches
headless Chrome, collects console/`Network.loadingFailed`, evaluates in-page and
captures screenshots. Note the canvas is **not** `preserveDrawingBuffer` — read
pixels from CDP screenshots, never `drawImage` + `getImageData`.

### 0.3 Track the assets

`obj/textures/sky/` (6 MB HDRI) and `obj/textures/grass/` are **untracked**.
`fbb8f1f` ships code referencing files a fresh clone will not have; the HDRI
404s on a clean checkout. `git add` them, or fetch them in `download.sh`.

### 0.4 Fix the two known-bad settings

- `PCFSoftShadowMap` → **do not** reach for `VSMShadowMap` first. Verified in the
  0.185.1 build: the plain-PCF branch **honours `shadow.radius`**. Set radius on
  the four cascade lights — near-free. `VSMShadowMap` costs 8 blur passes/frame
  (H+V × 4 cascades) and introduces light bleed; use it only if PCF+radius is
  visually insufficient *and* the frame budget survives.
- `SSAOPass` min/max → re-derive for `near 0.25 / far 6000`, or (better) replace
  with `GTAOPass`, which is the modern WebGL AO and is depth+normal based.

### 0.5 Measure the frame budget — **blocking gate**

Nobody has measured this. Already committed: **four 2048² cascade shadow maps**,
32-sample SSAO, and a 4× MSAA composite target.

*Verify:* record ms/frame on real hardware (not headless — SwiftShader numbers
are meaningless) at 1080p and 1440p, in all 3 camera modes, on the busiest part
of the circuit. **Write the numbers into this file.** If the budget is already
past ~10 ms/frame, Phases 2–4 must start with subtraction, and `FSR1Node`
becomes mandatory rather than optional.

---

## Phase 1 — Finish Priority 1 (car), cheap and self-contained

### 1.1 Verify the decal-UV claim before acting on it
The priority list says "fix UV mapping distortion on all car decals". **No
distortion is visible** in any screenshot taken so far — the ETIHAD, Santander
and acer decals all render cleanly. Before scheduling any work: render the car
with a UV-checker texture and photograph the actual stretch.

If distortion *is* real, note that this is the **most expensive item on the whole
list**, not a cheap win: the UVs are baked into the 2011-era `.bin` geometry, so
fixing them means a remap or a re-authored mesh. Do not start it without a
decision.

### 1.2 Tyre sidewall deformation
`_tyreTempFront/_tyreTempRear` are scaffolded but sidewall deformation is absent.
Cheapest credible version: drive a small vertical squash on the wheel pivots from
the vertical load the physics already computes, plus a bulge via the existing
tyre normal map. Real geometry deformation is not worth it.

*Verify:* contact-patch flattening visible at 4 g cornering and invisible when
parked; wheel radius change < 15 mm so the tacho (which shares `WHEEL_RADIUS`)
stays honest.

### 1.3 Specular response
Add `specularIntensityMap` / `specularColorMap` to the paint. Only judgeable
after Phase 0.

---

## Phase 2 — Renderer migration (the ceiling-raiser)

### 2.1 Spike first, behind a flag
Add `WebGPURenderer` with `forceWebGL` fallback, selected by a URL flag
(`?renderer=webgpu`), keeping the WebGL path fully working. Do not delete the old
path until Phase 4.

Node materials are not the same objects as `MeshStandardMaterial`. Expect to
port: the CSM setup, the procedural `DataTexture` maps, the `MultiplyBlending`
contact shadow (blend modes differ), and the `polygonOffset` depth-layering on
the track ribbons.

**The `polygonOffset` layering is load-bearing** — the track is a stack of
near-coplanar strips 2–25 mm apart viewed down a kilometre of straight. Height
alone loses the asphalt to the runoff beyond ~600 m (the road renders as grass).
Whatever the node path's equivalent is, it must be verified at 1 km.

*Verify:* both paths render the same scene within a few pixel counts at 3 fixed
camera poses; ms/frame recorded for both.

### 2.2 Then, in this order
1. **`GTAONode` + `DenoiseNode`** — replaces SSAO. AO now applied in linear HDR.
2. **`TRAANode`** — temporal AA. Biggest single image-quality win on thin
   geometry, and this scene is *full* of thin geometry: kerb stripes, 0.14 m
   centre-line dashes, barrier rails, front-wing elements.
3. **`SSGINode` + `RecurrentDenoiseNode`** — the "GI" item, for real. This is
   what puts bounce light from the tarmac onto the car's underside.
4. **`SSRNode`** — reflections. Accept that it cannot reflect off-screen
   geometry; the PMREM environment remains the fallback for that.
5. **`FSR1Node`** — if Phase 0.5 says the budget is tight, this buys it back.

*Verify each:* A/B screenshot at 3 fixed poses + ms/frame delta. Any node costing
> 2 ms without a visible A/B difference gets reverted.

---

## Phase 3 — Environment & content

### 3.1 Sky — leave the current design alone
The progressive load (procedural sky immediately, `HDRLoader` swap when the HDRI
arrives) is **correct engineering**, not redundancy — and it is exactly what
saved the scene from a black sky when the HDRI 404'd. Keep it. Two upgrades:
- `UltraHDRLoader` — much smaller than the 6 MB `.hdr` for equal quality
- `GroundedSkybox` (`examples/jsm/objects/GroundedSkybox.js`) — projects the HDRI
  onto a ground-anchored dome so the horizon sits on the track instead of
  floating. Large realism win for one object.

### 3.2 White-line wear
Currently flat `0xffffff` with no map. Needs a wear/scuff map with rubber pickup
and eroded edges. Cheap, and it removes one of the strongest "prototype" tells.

### 3.3 Grass and trackside
Textures are already wired. Missing is geometry:
- **`InstancedMesh`** for grass tufts near the track only, density falling off
  with distance — one geometry repeated many times.
- **`BatchedMesh`** for trackside props. Verified exported from core 0.185.1
  (`src/objects/BatchedMesh.js`). This is the right tool where the geometry
  *differs* per object — marshal posts, boards, tyre stacks — because it merges
  many distinct meshes into one draw call while keeping per-instance culling,
  which `InstancedMesh` cannot do. Use `InstancedMesh` for repeats,
  `BatchedMesh` for variety.
- Trackside: marshal posts, distance boards, tyre stacks, catch fencing.
  Fencing is high-value: transparent, and it reads as "real circuit".
- **`THREE.LOD`** for the above (present in core), plus distant terrain.

*Verify:* draw calls and triangles before/after; ms/frame delta. This phase is
the most likely to blow the budget — instance aggressively, and gate density on
the Phase 0.5 numbers.

### 3.4 Texture compression
`KTX2Loader` is available. The grass set alone is 3.2 MB of JPEG. Worth doing
once texture count grows — GPU memory and upload cost, not just download.

---

## Phase 4 — Grade and polish

1. **`Lut3DNode`** colour grading + **`SharpenNode`** micro-contrast. This is the
   step that makes the car "pop", and it is worth more than any single earlier
   effect. Do it last, on a correct image.
2. **Bloom** (`BloomNode`) — keep subtle; sun glints off carbon and chrome only.
3. **Film grain** — very light. It hides banding in the sky gradient.
4. **Heat haze / tyre dust** — a refraction quad behind the diffuser; dust as
   instanced particles driven by the slip the physics already reports
   (`telemetry.slipDeg`, `tractionUse`).
5. **Driver / helmet** — the last "prototype" tell once the car is right. Highest
   asset cost on the list; schedule honestly.

### Deliberately NOT in this plan

| Item | Why |
|---|---|
| **Depth of field** | Blurs the thing you steer toward. Sims confine it to replays. `DepthOfFieldNode` exists — use it for a photo mode, never in play. |
| **Chromatic aberration** | Reads as a lens defect and fights the kerb detail added in 3.2. |
| **Reflection probes / `CubeCamera`** | On a car at 80 m/s the PMREM environment is adequate; `SSRNode` covers the rest. Not worth the render targets. |

---

## Standing rules

1. **One visual change at a time, each with a measurement.** Every defect in the
   audit came from stacking unverified changes.
2. **Numbers in commit messages.** "ground (0,1,2) → (95,97,102)" is reviewable;
   "improved lighting" is not.
3. **Read the console every boot.** The `PCFSoftShadowMap` warning printed on
   every single boot for the entire life of the feature.
4. **`git add` assets in the same commit as the code that loads them.**
5. **Concurrency:** if two agents work this repo, use `git worktree` so collisions
   become visible conflicts instead of silent clobbers. The lighting chain
   (Phase 0.1) is one indivisible system — it must have a single owner.

## Definition of done

- Regression guard passes; guard demonstrably fails on `fbb8f1f`
- ms/frame recorded in this file for both renderer paths, 1080p + 1440p
- Zero console warnings or 404s on a clean clone
- `node --test` green (126 tests at the time of writing)
- Before/after screenshots at 3 fixed camera poses per phase
