# A sim-grade F1 car in the browser — architecture and plan

Target: a 2022–2026 ground-effect Formula 1 car that behaves like rFactor 2 /
ACC / iRacing physics, rendered in WebGL at a stable 60 fps on mid-high hardware.

**Fixed constraint:** the existing car mesh stays. Everything else is open.

One consequence of that, stated so it is not a surprise later: the mesh is a
2010-era car (13" wheels, no halo, pre-ground-effect bodywork) and the audio
models a 2.4 L V8. The physics target is a 2022+ car. The recommendation is to
keep the mesh, adopt modern physics wholesale, switch the engine voice to a 1.6 L
V6 turbo hybrid, and keep `WHEEL_RADIUS` consistent with the mesh rather than with
18" regulations — a 6 mm radius error is invisible next to a wrong tyre model.

---

## 1. Architecture

### 1.1 The single most important decision: separate the sim clock from the frame clock

Sim-grade tyre and suspension models are stiff. They need 500–1000 Hz. The
renderer runs at whatever the display does, and `requestAnimationFrame` delivers
jittery deltas. Integrating on frame dt — or, as now, choosing a *variable*
number of substeps from frame time — makes the car behave differently on a 60 Hz
laptop and a 165 Hz monitor, and makes bugs irreproducible.

```
input  ─→ [ring buffer, sampled at ≥250 Hz]
                     │
   accumulator += min(frameDt, MAX_CATCHUP)
   while (accumulator >= DT) { kernel.step(DT); accumulator -= DT }   // DT fixed
   alpha = accumulator / DT
                     │
render ─→ lerp(prevState, state, alpha) ─→ three.js scene graph
```

Three properties fall out, all of which the current design lacks:

- **Determinism.** Same inputs, same trajectory, every run, on every machine.
- **Replay.** Record the input ring buffer, replay bit-exact. This is how you
  test a physics change: drive a lap, save the inputs, and diff the trajectory
  after the change. Without it, "does this feel better?" is the only instrument.
- **Smoothness.** Interpolating between the two most recent sim states removes
  the stutter you otherwise get whenever frame rate and sim rate are not integer
  multiples.

`MAX_CATCHUP` (≈0.1 s) prevents the death spiral where a slow frame demands more
substeps, which makes the next frame slower.

### 1.2 Do not use a physics library

Ammo.js, Cannon-es and Rapier are general rigid-body solvers with generic contact
handling. `btRaycastVehicle` and its equivalents are arcade-grade: a raycast per
wheel, a lumped friction model, no slip transients. No credible racing simulator
uses one for vehicle dynamics — rFactor 2, AC and iRacing all run purpose-built
multibody and tyre code.

What this car actually needs is narrow and cheap: four wheels, each with one
angular degree of freedom and one suspension degree of freedom along a known
kinematic axis, plus a tyre model. That is a few hundred flops per wheel per
step. A generic solver adds cost, indeterminism and a worse tyre model.

**Custom kernel. No physics library.** Consider Rapier later, and only for
barrier collision and debris, never for the car's own dynamics.

### 1.3 Where the kernel runs

Main thread first, Web Worker later. The worker is worth it — it isolates physics
from render hitches and from main-thread GC — but it needs `SharedArrayBuffer`
for zero-copy state, and that needs cross-origin isolation
(`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`). Without those headers SAB is
unavailable and you are back to `postMessage` copying. Design the kernel so it
does not care: pure functions over a flat `Float64Array` state vector.

**The state must be a flat typed array, and the inner loop must not allocate.**
The current kernel returns a fresh object literal from every `step()`. At 600 Hz
that is 600 objects a second, plus the four-element `omega` array inside it —
straight into the nursery, and GC pauses show up as exactly the kind of
micro-stutter that destroys the feeling of a stable platform.

---

## 2. Tyres — the model that decides everything

Nothing else matters as much. Every "the car feels wrong" complaint in a sim
traces back to the tyre model, and every "the car communicates grip" compliment
does too.

### 2.1 Steady-state force

Pacejka Magic Formula per wheel, in the wheel's own frame:

```
slip ratio    κ = (ω·R_eff − v_x) / max(|v_x|, v_ref)
slip angle    α = atan2(v_y, max(|v_x|, v_ref))

MF(s) = D · sin( C · atan( B·s − E·(B·s − atan(B·s)) ) )
```

`B` stiffness, `C` shape, `D` peak, `E` curvature. The codebase already has
B/C/E and load sensitivity, which is the right foundation:

```
load sensitivity   D = μ · Fz · (Fz / Fz_ref)^(k − 1),   k ≈ 0.85
```

Grip growing sub-linearly with load is what makes load transfer matter at all —
without it, moving load between wheels is free and the car has no balance.

### 2.2 Transient response — the biggest single feel upgrade

Steady-state MF applied instantaneously is the difference between a sim and a
game. Real tyres build force over a **relaxation length** σ ≈ 0.2–0.6 m for
slicks: the carcass has to deflect before the contact patch can generate force.

```
dα_lag/dt = (|v| / σ) · (α − α_lag)        // use α_lag in the MF, not α
dκ_lag/dt = (|v| / σ_x) · (κ − κ_lag)
```

This is ~4 lines and it is what makes the car settle instead of snapping, makes
catching a slide possible, and makes steering feel connected rather than digital.
Note the `|v|/σ` term: at low speed the lag becomes long, which is also why cars
feel vague in slow corners. It falls out for free.

### 2.3 The rest, in order of what you notice

1. **Combined slip.** Friction-ellipse clipping (present) is acceptable. Proper
   MF combined slip uses the slip magnitude with separate longitudinal and
   lateral shape factors; worth doing once the basics are in.
2. **Wheel angular DOF driven by torque.** Not solved toward a target speed:
   `I·ω̇ = T_drive − T_brake·sign(ω) − Fx·R_eff`. This is the difference between
   modelling wheelspin and clamping a force. It is also why a target-speed
   solver cannot launch the car from rest — there is nothing to spin the wheel.
3. **Self-aligning torque `Mz`** via pneumatic trail. Needed for any steering
   feel at all, and it is the channel through which a real driver feels the front
   axle approaching the limit.
4. **Thermal model.** Surface temperature and carcass temperature, with a grip
   curve that peaks in a window (Pirelli slicks are narrow). Heat from slip power
   `|Fx·v_slip_x| + |Fy·v_slip_y|`, cooling by conduction and airflow. This is
   what turns "drive fast" into "manage the tyre".
5. **Wear**, degrading both peak grip and thermal capacity.
6. **Camber thrust.** F1 runs −3° to −4° static; it matters.
7. **Vertical stiffness.** The tyre is a spring (~250–350 kN/m). With 2022+
   18" low-profile construction the sidewall is stiffer and contributes less
   compliance, which is precisely why the current cars ride kerbs so badly.

---

## 3. Ground-effect aerodynamics (2022–2026)

This is the defining characteristic of the era, and the thing that will make the
car feel modern rather than like a 2010 car with new paint.

### 3.1 Ride-height-dependent downforce

On these cars the floor and diffuser generate the majority of the downforce, and
that contribution is a strong, **non-monotonic** function of ride height: as the
floor gets closer to the ground the venturi accelerates the flow and downforce
rises — until the underbody stalls, and it collapses.

```
q = ½ · ρ · V²
Fz_front = q · ClA_front(h_f, h_r, β)
Fz_rear  = q · ClA_rear (h_f, h_r, β, drs)
Drag     = q · CdA(h, β, drs)
```

Model each `ClA` as a curve that rises as `h` falls to `h_opt` and drops sharply
below it. The sharpness is the point: a linear `ClA` gives you a fast car, not a
ground-effect car.

### 3.2 Porpoising is the acid test

Couple ride-height-dependent `ClA` to a real suspension and the 2022 season's
signature instability emerges on its own:

> more downforce → ride height falls → more downforce → floor stalls →
> downforce collapses → car rises → flow reattaches → repeat, at 5–10 Hz

**If porpoising does not appear at high speed on a stiff setup, the aero and
suspension are not actually coupled** — something is being applied as a constant.
That makes it a uniquely good self-check: an emergent behaviour you can look for
rather than a number you can tune to.

### 3.3 The rest

- **Aero balance moves with pitch, rake and ride height.** Separate front and
  rear `ClA` as above and the centre of pressure moves on its own — which is why
  the car understeers into a high-speed corner under braking and why it changes
  balance with speed. A single lumped downforce number cannot express this.
- **Yaw sensitivity.** Downforce falls in yaw; a sliding car loses grip on top of
  losing direction. Scale by sideslip angle β.
- **DRS** multiplies the rear wing terms only — less `ClA_rear`, much less `CdA`.
- **Skid plank contact** when ride height goes negative: sparks, and a real
  vertical force spike. Physics and visuals from the same event.

---

## 4. Suspension

Modern F1 is extremely stiff, because ride height controls the floor and the
floor is the car. Wheel rates are high, travel is tiny (20–30 mm), and the car
runs on bump stops at speed. Do not soften it to feel nice.

Per corner: spring + damper (separate bump/rebound, ideally digressive), plus
anti-roll bars front and rear, plus bump stops and packers. F1 practice also uses
heave elements (third springs) that act on symmetric compression only — worth
modelling because it is how these cars separate ride-height control from roll
control.

**Roll stiffness distribution front-to-rear is the primary balance tool**, and it
is the thing the current four-corner load model cannot express: it applies one
lateral load-transfer term equally to both axles. Until lateral transfer is split
by roll stiffness there is no setup lever for understeer/oversteer at all.

### Stability warning — this is where explicit integration dies

```
wheel-hop mode ≈ sqrt(k_tyre / m_unsprung) ≈ sqrt(300000 / 15) ≈ 141 rad/s ≈ 22 Hz
```

An explicit integrator needs `dt` well under 1/(2π·22) to stay stable, and stiff
springs plus small unsprung mass punish it hard. Either run the suspension at
≥1 kHz, or integrate it semi-implicitly (backward Euler on the spring-damper
term), which is unconditionally stable and lets you keep the outer loop at
600 Hz. Semi-implicit is the better answer and is about ten lines.

---

## 5. Power unit (2022–2026)

```
T_wheel = ( T_ice(rpm, throttle, boost) + T_mguk(SoC, mode) ) · r_gear · r_final · η
rpm     = ω_wheel · r_gear · r_final          (plus clutch slip at launch)
```

Today the drive force is `min(POWER/v, F_max)`, keyed to road speed. That means
**gear has no effect on acceleration** — identical thrust in first and seventh —
and rpm is derived backwards from speed for the dashboard and the engine note.
Replacing this with a torque path through real ratios gives, in one change: gears
that matter, a power band, short-shifting, wheelspin, engine braking that is
actually driveline drag, and an engine note driven by the drivetrain instead of
by how fast the scenery is moving.

Era specifics worth having:

- 1.6 L V6 turbo, ~15,000 rpm limit but raced nearer 10,500–12,500
- MGU-K 120 kW deploy and harvest; battery 4 MJ usable, 4 MJ/lap deployment
- Torque fill at low rpm is why these cars launch so hard
- **Brake-by-wire on the rear axle**: rear friction pressure is modulated to
  blend with MGU-K regeneration, so brake balance shifts as the battery fills.
  A genuine, felt characteristic of the era.
- 8 fixed ratios, ~40 ms shifts
- 2026 as a config: ~50/50 ICE/electric, 350 kW MGU-K, active aero

---

## 6. Brakes

Carbon-carbon has strongly temperature-dependent μ: poor below ~250 °C, optimum
roughly 400–800 °C, fading above ~1000 °C. Model per-corner temperature with
heating from brake power and cooling from airflow. Cold brakes on lap one out of
the pits is a real and characteristic feel, and brake temperature is what drives
believable **brake glow** in the renderer — one model, two outputs.

---

## 7. Track — the other half of the tyre model

The current track is a flat ribbon: `y = 0` everywhere, with layered strips at
millimetre offsets, and a single surface type sampled for the whole car. For a
simulator that is the largest remaining gap after the tyre, because the surface
*is* what the tyre talks to.

Priority order:

1. **Per-wheel surface query** returning `{ height, normal, μ, roughness }` at a
   world position. This one interface change enables everything else, and fixes a
   present bug: putting two wheels on grass currently drops the *whole car* to
   μ = 0.35 instead of generating an asymmetric yaw moment. A wheel on the grass
   should pull the car, not teleport it onto ice.
2. **Elevation, banking and cross-slope.** Real circuits are three-dimensional
   and drainage crowns are 1–2%. Silverstone has meaningful elevation change.
3. **Bumps as physical geometry**, sampled per wheel — a height field or
   parametric bumps along the centreline. Bumps are most of what makes a real
   circuit recognisable to drive.
4. **Kerb profiles** with real height, so a kerb strike upsets the platform
   through the suspension rather than changing a friction coefficient.

---

## 8. Rendering (car mesh unchanged)

Already good and not to be redone: HDRI + grounded skybox, 4-cascade CSM, ACES,
procedural asphalt with racing-line rubber build-up, instanced 3D grass with
distance thinning, WebGPU path with TSL parity.

Highest value remaining, in order:

1. **TAA.** This scene is nothing but thin geometry — kerb stripes, 0.14 m
   centre-line dashes, barrier rails, wing elements, and now grass blades. It is
   the single largest image-quality win available.
2. **Physics-driven effects.** Each of these is one model feeding both systems:
   - brake glow from brake temperature (blackbody ramp, 400–1000 °C)
   - sparks from skid-plank contact — the ride-height model already knows
   - tyre smoke keyed to slip power × load
   - tyre marks accumulated into a track-space texture where slip exceeds a
     threshold, which also makes the racing-line rubber dynamic instead of baked
   - heat haze behind the exhaust and brake ducts
3. **Car materials.** Anisotropic carbon weave (`MeshPhysicalMaterial` supports
   anisotropy), clearcoat over the livery, correct metal for suspension links.
4. **Cockpit camera driven by chassis acceleration**, not by the mesh — with the
   halo in view. Perceived speed and grip come mostly from this.
5. Colour grading LUT and restrained bloom, last, on a correct image.

---

## 9. Feel and feedback — and an honest limitation

**Real force feedback is not available in the browser.** The Gamepad API exposes
no force-feedback axis; `vibrationActuator` ("dual-rumble") is the ceiling, and
WebHID/WebUSB wheel drivers are device-specific and not a viable target. Plan
around it rather than for it:

- Steering torque *is* computed (from tyre `Mz`) — surface it as rumble intensity
  and as an optional on-screen load meter.
- Move grip communication into the channels that do work: tyre scrub audio keyed
  to the slip the kernel already computes, camera motion from vertical and
  lateral acceleration, visible tyre slip and smoke, and audio for kerbs.

---

## 10. Browser and WebGL limits that hurt realism

| Limit | Consequence | Workaround |
|---|---|---|
| No `SharedArrayBuffer` without COOP/COEP | worker physics must copy state | serve isolation headers, or keep kernel on main thread behind a flat state array |
| GC pauses | micro-stutter that reads as an unstable platform | allocation-free inner loop, flat `Float64Array` state, no object literals per step |
| `performance.now()` coarsened for security | sub-ms timing unreliable | never integrate on measured dt; fixed `DT` + accumulator |
| rAF is vsync-locked and jittery | variable substep counts, non-determinism | accumulator + interpolation |
| No compute shaders in WebGL2 | GPU physics impossible | keep physics on CPU; the existing WebGPU path has compute if ever needed |
| Float32 precision, large world coordinates | z-fighting and jitter — already seen on this track, which sits ~1 km from the origin | camera-relative rendering / origin rebasing; keep physics in float64 |
| Depth precision across a 1 km circuit | coplanar track ribbons fight | already handled with polygonOffset; keep near/far tight |
| Texture upload stalls | frame spikes on first sight of an asset | KTX2/Basis, upload during load, warm shaders |
| Tab throttling | huge dt on refocus | clamp dt (already done) |
| JS numeric throughput | if 1 kHz × 4 wheels ever gets tight | WASM (Rust) for the tyre+suspension kernel — likely unnecessary |

---

## 11. Validation targets

"As realistic as possible" is not actionable without numbers. These are the
reference figures a 2022–2026 car should reproduce; approximate public data, good
enough to catch a model that is wrong by tens of percent.

| Quantity | Target |
|---|---|
| Mass (incl. driver, no fuel) | 798 kg |
| Fuel at race start | up to 110 kg |
| Combined peak power | ~735 kW (~1000 PS) |
| 0–100 km/h | ~2.6 s (traction limited) |
| 0–200 km/h | ~4.8 s |
| 0–300 km/h | ~9 s |
| Top speed | ~330 km/h, ~340 with DRS |
| 100–0 km/h | ~17 m |
| 200–0 km/h | ~65 m |
| 300–0 km/h | ~125 m |
| Peak braking deceleration | 5–6 g at speed, ~2 g mechanical |
| Peak lateral | ~2 g low speed, 5–6 g in fast corners |
| Downforce at 300 km/h | ~1800–2200 kg |
| Silverstone pole | ~1:26–1:27 (2010 was 1:29.6) |

The existing model's lateral capability already tracks reality well — 1.66 g at
36 km/h rising to 5.28 g at 288 km/h. That is worth protecting with a test, and
nothing currently protects it.

---

## 12. Baseline, measured

`npm run validate` — 11 of 12 reference figures within tolerance:

| quantity | model | target |
|---|---|---|
| 0–100 km/h | 2.78 s | 2.6 s |
| 0–200 km/h | 5.10 s | 4.8 s |
| 0–300 km/h | 12.14 s | 9.0 s (+35%, the one miss) |
| top speed | 311 km/h | 330 km/h |
| 100–0 / 200–0 / 300–0 km/h | 21.5 / 65.5 / 111 m | 17 / 65 / 125 m |
| downforce @200 / @300 km/h | 886 / 1994 kg | 1000 / 2000 kg |
| peak lateral @100 / 200 / 290 km/h | 2.06 / 2.60 / 3.77 g | 2.2 / 3.8 / 5.2 g |

Straight-line performance and aero load are close. Cornering is where the model
falls down, and the shape of the failure is more informative than the numbers.

### The car reaches ~70% of its own grip and then departs

Sweeping steer at fixed speed and holding each angle to a steady state:

```
290 km/h — analytic grip ceiling 5.33 g, steering lock 6.0 deg
  steer    ay      sideslip
   2.5    3.22 g     2.6 deg
   3.0    3.57 g     3.1 deg
   3.5    3.78 g     3.7 deg     <- best sustained
   4.0    2.15 g    31.1 deg     <- departed
   4.5    2.15 g    28.0 deg
```

The same shape at 200 km/h (2.30 g at 2.4 deg, then 33.6 deg of sideslip), and
*not* at 100 km/h, where 2.08 g against a 2.04 g ceiling means mechanical grip is
essentially exact.

So: low-speed grip is right, and everything aero-dependent tops out around 70% of
what the tyres could carry, at which point the car snaps into a sustained 20–30°
drift. That is a bifurcation, not a limit — a real car is progressive here, and at
290 km/h it does not drift at 30°, it understeers or it spins. Three causes worth
attacking in this order:

1. **No tyre relaxation length.** Force appears the instant slip does, so the rear
   axle has no time to build up and the departure is a step change. This is also
   the fix that most improves how the car communicates the limit.
2. **Yaw damping is a fudge.** `newAv *= 1 - dt * 1.2` is a fixed first-order
   decay on yaw rate, independent of speed, load or tyre state. Real directional
   damping comes from the tyres' own response to yaw rate through the LF/LR moment
   arms, plus aero yaw damping. A constant cannot stand in for either, and it is
   distorting the moment balance that decides where the car departs.
3. **Aero balance never moves.** Downforce is split 40/60 front/rear at all times.
   On a ground-effect car the balance moves with ride height, pitch and yaw, and
   that movement is most of what the car tells the driver as speed rises.

## 13. Rendering baseline, measured

`npm run validate:visual` — captured on the real GPU (ANGLE/Metal), because
SwiftShader filters differently and any image-quality number from it is fiction.
The headline metric is **sub-pixel instability**: the frame is captured twice, the
second time with the projection jittered half a pixel via `setViewOffset`, and the
two compared. Aliasing is by definition an image that changes when the sampling
grid moves a fraction of a pixel, and this scene is almost entirely thin edges.

| metric | before | after | target |
|---|---|---|---|
| sub-pixel instability | 6.01 | **3.79** | <= 4 /255 |
| high-frequency detail | 23.17% | **9.28%** | <= 6% of pixels |
| worst-case edge crawl (p99) | 48.3 | 48.3 | <= 32 /255 |
| mean luminance | 127 | 127 | 85–175 |
| clipped / crushed | 0.4% / 4.95% | same | <= 1.5% / <= 2% |
| contrast, saturation | 205, 0.14 | same | >= 90, 0.08–0.34 |

**The fix that moved it: texture filtering.** `THREE.DataTexture` defaults to
`NearestFilter` with no mip chain, and `Track._asphaltDataTexture` never overrode
it — so the asphalt and the grass ground, which between them occupy most of the
screen and recede to the horizon, were being point sampled. MSAA cannot help with
that; it resolves edge coverage, not texture minification. Linear mipmapping cut
overall instability by 37% and unresolved single-pixel detail by 60%.

Worth recording: several textures still request a mipmapped `minFilter` while
`generateMipmaps` is false, which asks the sampler for levels that were never
uploaded — the car body maps and the skybox HDRI among them.

**Two hypotheses measured and rejected**, so they are not retried blind:

- `alphaToCoverage` on the 34 689 grass cutouts, on the theory that blade-shaped
  stencils were the worst-case crawl. Slightly *worse*: p99 48.3 -> 52.7.
- Anisotropy 8 -> 16, aimed at the far-track band where the dashboard localises
  the worst instability. No measurable change: 3.79 -> 3.82.

The remaining p99 of 48 is concentrated in the far-track and horizon bands and is
not the ground textures, the grass cutout, or anisotropy. Next candidates: the
barrier rails and catch fence (thin geometry, and the fence is alpha-textured),
and specular aliasing on the car. TAA remains the general answer.

## 14. Roadmap

**Phase 0 — the measuring instrument.** Reference data plus a runner that reports
model against target. Deterministic fixed-step kernel with input recording and
replay. Telemetry export. Nothing else can be evaluated without this.

**Phase 1 — physics core.** Torque-driven wheels and a real powertrain; tyre
relaxation length, `Mz`, thermal; semi-implicit suspension with roll stiffness
distribution; ride-height-dependent ground-effect aero with DRS; per-wheel
surface query; carbon brake thermal model with brake-by-wire blending.

**Phase 2 — track.** Elevation, banking, cross-slope, bumps, kerb profiles, and
per-wheel surface properties.

**Phase 3 — visuals.** TAA; brake glow, plank sparks, slip-driven smoke, tyre
mark accumulation, heat haze; carbon anisotropy; cockpit camera from chassis
motion; grading last.

**Phase 4 — feel and tools.** Setup screen (wings, ARB, springs, ride height,
brake bias, differential, tyre pressures, fuel), telemetry overlay, delta and
ghost, slip-keyed audio.
