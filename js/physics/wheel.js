/**
 * The tyre model.
 *
 * Nothing in a driving simulator matters as much. Every "the car feels wrong"
 * complaint traces back to here, and so does every "the car communicates grip"
 * compliment. The steady-state force curve is the easy half; the transients are
 * what separate a sim from a game.
 *
 * Layout:
 *   1. Magic Formula, and load sensitivity            — steady-state force
 *   2. Relaxation length                              — transient response
 *   3. Combined slip                                  — the friction ellipse
 *   4. Self-aligning torque                           — steering feel
 *   5. Thermal and wear                               — tyre management
 *   6. Camber and vertical stiffness                  — the rest of the contact
 *   7. Wheel angular DOF                              — torque in, spin out
 *
 * Everything here is a pure function over scalars or over a small mutable state
 * object it writes in place. Nothing allocates: at 600 Hz × 4 wheels, an object
 * literal per call is 2400 objects a second into the nursery, and the resulting
 * GC pauses read as exactly the micro-stutter that makes a platform feel
 * unstable.
 */

// ---------------------------------------------------------------------------
// 1. Magic Formula
// ---------------------------------------------------------------------------

/**
 * MF(s) = D · sin( C · atan( B·s − E·(B·s − atan(B·s)) ) )
 *
 * `B` stiffness — how fast force builds with slip.
 * `C` shape — how much force falls away past the peak.
 * `D` peak — the friction limit, and where load sensitivity enters.
 * `E` curvature — where the peak sits, and how sharp it is.
 *
 * The old model had B and C but not E, which meant the peak sat wherever B and C
 * put it. E is what lets the peak slip angle be placed where a real slick's is
 * (6–8°) independently of how stiff the initial rise is.
 */
export function magicFormula(d, b, c, e, s) {
  const bs = b * s;
  return d * Math.sin(c * Math.atan(bs - e * (bs - Math.atan(bs))));
}

/**
 * Lateral coefficients, chosen to put the peak at 7° of slip with a slick's
 * fall-off past it: 94% of peak at 14°, 87% at 21°, asymptotically 65%.
 *
 * `B` is not a free choice once the peak angle and `C` are fixed — it is solved
 * for. The old B = 12 with no `E` put the peak at 11°, which is a road tyre.
 * Cornering stiffness comes out at B·C·D ≈ 23·D, or about 2.3 kN/deg at a
 * typical loaded front, which is the right order for an F1 front slick.
 */
export const ALPHA_PEAK_TARGET = 7 * Math.PI / 180;
export const PACEJKA_C = 1.55;
export const PACEJKA_E = 0.30;

/**
 * Longitudinal peaks earlier and sharper than lateral — 11% slip ratio, and a
 * steeper drop past it, which is why wheelspin runs away where a slide does not.
 */
export const KAPPA_PEAK_TARGET = 0.11;
export const PACEJKA_CX = 1.65;
export const PACEJKA_EX = 0.30;

/** Exponent on Fz for peak grip — below 1.0 grip grows sub-linearly with load. */
export const LOAD_SENS_EXP = 0.85;
export const FZ_REF = 2000;

export const WHEEL_RADIUS = 0.334;
/** Front and rear differ on a real car; one figure is inside the noise here. */
export const WHEEL_INERTIA = 1.5;

/**
 * Peak force available at a given load.
 *
 * `D = μ · Fz · (Fz / Fz_ref)^(k − 1)` with k ≈ 0.85. Grip growing sub-linearly
 * with load is what makes load transfer matter at all: without it, moving load
 * between wheels is free and the car has no balance to set up or to lose.
 *
 * `scale` folds in temperature and wear, which multiply the peak rather than
 * reshaping the curve — a cold or worn tyre has less grip, not a different
 * character.
 */
export function peakGrip(mu, fz, scale = 1) {
  const f = Math.max(fz, 50);
  return scale * mu * f * (f / FZ_REF) ** (LOAD_SENS_EXP - 1);
}

/**
 * Stiffness factors, solved once at load so that the peak lands where it was
 * asked to. Tuning `B` by hand against a moving `C` and `E` is how a tyre ends up
 * peaking at 34° without anybody noticing.
 */
export const PACEJKA_B = solveStiffness(ALPHA_PEAK_TARGET, PACEJKA_C, PACEJKA_E);
export const PACEJKA_BX = solveStiffness(KAPPA_PEAK_TARGET, PACEJKA_CX, PACEJKA_EX);

/** Where the curves actually peak. Equal to the targets, by construction. */
export const ALPHA_PEAK = peakSlip(PACEJKA_B, PACEJKA_C, PACEJKA_E);
export const KAPPA_PEAK = peakSlip(PACEJKA_BX, PACEJKA_CX, PACEJKA_EX);

export function pacejkaLateral(d, alpha) {
  return -magicFormula(d, PACEJKA_B, PACEJKA_C, PACEJKA_E, alpha);
}

export function pacejkaLongitudinal(d, kappa) {
  return magicFormula(d, PACEJKA_BX, PACEJKA_CX, PACEJKA_EX, kappa);
}

/** Where MF peaks. Scanned wide enough that a peak cannot hide past the edge. */
function peakSlip(b, c, e) {
  let best = 0;
  let bestF = -1;
  for (let s = 1e-4; s < 3; s += 1e-4) {
    const f = magicFormula(1, b, c, e, s);
    if (f > bestF) { bestF = f; best = s; }
  }
  return best;
}

/** Bisect for the `B` that places the peak at `target`. Monotonic in `B`. */
function solveStiffness(target, c, e) {
  let lo = 1;
  let hi = 300;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (peakSlip(mid, c, e) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// 2. Relaxation length — the single biggest upgrade in feel
// ---------------------------------------------------------------------------

/**
 * Slip relaxation lengths, metres. The carcass has to deflect before the contact
 * patch can generate force, so force lags slip by a distance travelled rather
 * than by a time.
 *
 * Longitudinal is shorter than lateral because it works the tread rather than
 * twisting the whole casing.
 */
export const SIGMA_LAT = 0.35;
export const SIGMA_LONG = 0.18;

/**
 * Relaxation length falls a little as load rises: a more heavily loaded tyre has
 * a longer contact patch and a stiffer effective carcass, so it responds sooner.
 */
export function relaxationLength(fz, sigma0 = SIGMA_LAT) {
  const f = Math.max(fz, 50);
  return sigma0 * (FZ_REF / f) ** 0.25;
}

/**
 * Advance a lagged slip quantity toward its instantaneous value.
 *
 *   dα_lag/dt = (|v| / σ) · (α − α_lag)
 *
 * Integrated exactly over the step rather than explicitly, because `|v|/σ` at
 * 300 km/h with σ = 0.35 m is 240 s⁻¹ — an explicit step would need dt < 8 ms to
 * stay stable, and would ring long before that. The closed form is
 * unconditionally stable, costs one `exp`, and is exact for a slip that holds
 * still across the step.
 *
 * Note the `|v|/σ` factor: at low speed the lag becomes long, which is why cars
 * feel vague in slow corners. That falls out here for free rather than being
 * added as an effect.
 */
export function lagSlip(lagged, target, speed, sigma, dt) {
  const rate = Math.abs(speed) / Math.max(sigma, 1e-4);
  const blend = 1 - Math.exp(-rate * dt);
  return lagged + (target - lagged) * blend;
}

// ---------------------------------------------------------------------------
// 3. Combined slip
// ---------------------------------------------------------------------------

/**
 * Direction-preserving clip to the friction ellipse. Cheap, and adequate.
 */
export function combineSlip(fxPure, fyPure, d) {
  const mag = Math.hypot(fxPure, fyPure);
  if (mag <= d || mag < 1e-6) return { fx: fxPure, fy: fyPure };
  const s = d / mag;
  return { fx: fxPure * s, fy: fyPure * s };
}

/**
 * Proper MF combined slip, written into `out` so it allocates nothing.
 *
 * Rather than computing two pure forces and clipping the result, the combined
 * slip *magnitude* drives one Magic Formula and the force is projected back onto
 * the two axes. Longitudinal and lateral slip are first normalised by their own
 * peak, so a tyre at its peak slip ratio and its peak slip angle sits on the
 * ellipse rather than at 1.41× its own limit.
 *
 * The difference from clipping shows up in the transition: under combined load
 * the peak arrives earlier and the fall-off past it is shared, which is what
 * makes trail-braking behave and what makes a power-on slide progressive.
 */
export function combinedSlipForces(d, kappa, alpha, out) {
  const kn = kappa / KAPPA_PEAK;
  const an = Math.tan(alpha) / Math.tan(ALPHA_PEAK);
  const sn = Math.hypot(kn, an);
  if (sn < 1e-9) {
    out.fx = 0;
    out.fy = 0;
    return out;
  }
  // One curve, evaluated at the combined slip, expressed back in "peaks" units.
  const f = magicFormula(d, PACEJKA_B, PACEJKA_C, PACEJKA_E, sn * ALPHA_PEAK);
  out.fx = f * (kn / sn);
  out.fy = -f * (an / sn);
  return out;
}

export function slipRatio(vLong, omega, vRelax = 2) {
  const denom = Math.max(Math.abs(vLong), vRelax);
  return (omega * WHEEL_RADIUS - vLong) / denom;
}

export function slipAngle(vLat, vLong, vRelax = 2) {
  return Math.atan2(vLat, Math.max(Math.abs(vLong), vRelax));
}

// ---------------------------------------------------------------------------
// 4. Self-aligning torque
// ---------------------------------------------------------------------------

/**
 * Pneumatic trail: how far behind the wheel centre the lateral force acts.
 *
 * It starts at ~40 mm and collapses to zero — and then goes slightly negative —
 * as the contact patch saturates, because the rear of the patch gives up first
 * and the force centroid walks forward. That collapse is *the* channel through
 * which a real driver feels the front axle running out of grip: the wheel goes
 * light before the car starts to slide. Modelling it is what makes the limit
 * findable rather than a surprise.
 */
export const TRAIL_0 = 0.042;

export function pneumaticTrail(alpha, fz = FZ_REF) {
  // The patch is longer under load, so the trail is longer too.
  const scale = (Math.max(fz, 50) / FZ_REF) ** 0.3;
  const x = Math.abs(alpha) / (ALPHA_PEAK * 1.6);
  // Falls to zero at ~1.6·α_peak and reverses mildly beyond, then flattens out.
  return TRAIL_0 * scale * (1 - x) * Math.exp(-0.5 * x * x);
}

/**
 * Self-aligning torque about the wheel's vertical axis.
 *
 * `Mz = −Fy · (t_pneumatic + t_mechanical)`. The mechanical (caster) trail is a
 * geometric constant and does not collapse with slip, which is exactly why real
 * cars keep *some* self-centring past the limit instead of going completely
 * dead.
 */
export const CASTER_TRAIL = 0.012;

export function aligningTorque(fy, alpha, fz = FZ_REF) {
  return -fy * (pneumaticTrail(alpha, fz) + CASTER_TRAIL);
}

/** Alias, because "Mz" is what the channel is called everywhere else. */
export const pacejkaMz = aligningTorque;

// ---------------------------------------------------------------------------
// 5. Thermal and wear
// ---------------------------------------------------------------------------

/**
 * Two temperatures per tyre, because they behave completely differently.
 *
 * The *surface* is thin, heats in a corner and cools on the next straight — it
 * is what makes a single qualifying lap different from the one before it. The
 * *carcass* is thick and has a time constant of minutes — it is what makes an
 * out-lap different from lap five. A single temperature cannot express either.
 */
export const T_AMBIENT = 25;
export const T_TRACK = 35;
export const T_OPT = 100;
/**
 * The window is asymmetric, because a tyre's two failure modes are not
 * symmetric. Cold is a wide, forgiving shoulder — a slick at 60 °C is 93% of
 * peak. Hot is a cliff: past about 130 °C the surface grains and the grip is
 * gone until it cools, which is the whole reason tyre management is a skill.
 */
export const T_WINDOW_COLD = 110;
export const T_WINDOW_HOT = 55;
/** A cold tyre is slow, not frictionless. Roughly what a 30 °C slick offers. */
export const GRIP_FLOOR = 0.70;

/** Surface: small heat capacity, so it moves within a corner. J/K. */
export const C_SURFACE = 1700;
/** Carcass: large, so it moves over a stint. J/K. */
export const C_CARCASS = 26000;
/** Surface↔carcass conduction, W/K. */
export const K_CONDUCTION = 48;
/** Conduction to the track through the contact patch, W/K. Holds a parked tyre
 *  at track temperature rather than at air temperature. */
export const K_TRACK = 6;
/**
 * Convection to air, W/K: a standing term plus one that scales with road speed.
 * A tyre presents roughly half a square metre to the airflow, which at racing
 * speed is 50–70 W/K in total across surface and carcass.
 */
export const H_SURFACE_0 = 9;
export const H_SURFACE_V = 0.70;
/**
 * The carcass standing term is larger than air alone would justify because the
 * wheel rim is in it: a big aluminium heat sink bolted to the inside of the tyre,
 * itself in the airflow. Leaving it out put the carcass at 140 °C on a long run
 * — hotter than the surface and past the point where the tyre would be finished
 * — because at long time constants it was the only path out and there was not
 * enough of it.
 */
export const H_CARCASS_0 = 16;
export const H_CARCASS_V = 0.38;

/**
 * Hysteresis heating: the carcass flexing through the contact patch dissipates
 * work whether or not the tyre is sliding, as `c · Fz · v`.
 *
 * Without it the model is badly wrong in a way that is easy to miss — slip alone
 * puts a tyre at ~55 °C on a fast lap, so it never leaves the cold shoulder and
 * the temperature window has no effect on anything. Hysteresis is what holds a
 * tyre near its operating range on a straight, and it goes into the carcass
 * rather than the surface because that is where the flexing happens.
 */
export const HYSTERESIS_COEFF = 0.016;
/**
 * Hysteresis work is split between tread and carcass. Most of the deformation is
 * in the tread, so most of the heat appears there — which is also what makes the
 * surface the hotter of the two in a corner and the cooler of the two on a
 * straight, where it has the airflow and the carcass does not.
 */
export const HYSTERESIS_TO_SURFACE = 0.6;

export function createTyreState(t0 = T_TRACK) {
  return { surfaceT: t0, carcassT: t0, wear: 0, alphaLag: 0, kappaLag: 0 };
}

/**
 * Grip multiplier from surface temperature — a window, not a ramp.
 *
 * Quadratic in the distance from the optimum, floored: cold is slow, hot is slow,
 * and there is a band in between worth staying in.
 */
export function gripFromTemperature(surfaceT) {
  const d = surfaceT - T_OPT;
  const x = d / (d < 0 ? T_WINDOW_COLD : T_WINDOW_HOT);
  return Math.max(GRIP_FLOOR, 1 - x * x);
}

/** Convenience for the capability probe and for the dashboard. */
export function tyreTemperature(tyre) {
  return tyre.surfaceT;
}

/**
 * Advance one tyre's temperatures in place.
 *
 * Heat in is the slip power the contact patch dissipates,
 * `|Fx·v_slip_x| + |Fy·v_slip_y|`, of which only a fraction reaches the rubber
 * rather than the road and the air. Heat out is conduction to the carcass and
 * convection to airflow, both of which scale with speed.
 *
 * Integrated semi-implicitly. `K_CONDUCTION / C_SURFACE` is 28 s⁻¹, and an
 * explicit step at 600 Hz is only just stable — at 240 Hz it oscillates and at
 * 120 Hz it diverges. Backward Euler on the linear exchange terms costs nothing
 * and cannot blow up whatever the step.
 */
export const SLIP_HEAT_FRACTION = 0.42;

export function thermalStep(tyre, slipPower, fz, speed, dt, ambient = T_AMBIENT) {
  const wearScale = 1 - 0.35 * tyre.wear;   // a worn tyre has less rubber to heat
  const cS = Math.max(200, C_SURFACE * wearScale);
  const cC = C_CARCASS;

  const hS = H_SURFACE_0 + H_SURFACE_V * Math.abs(speed);
  const hC = H_CARCASS_0 + H_CARCASS_V * Math.abs(speed);
  const qHyst = HYSTERESIS_COEFF * Math.max(0, fz) * Math.abs(speed);
  const qSurface = SLIP_HEAT_FRACTION * Math.max(0, slipPower)
    + HYSTERESIS_TO_SURFACE * qHyst
    + K_TRACK * T_TRACK;
  const qCarcass = (1 - HYSTERESIS_TO_SURFACE) * qHyst;

  // Backward Euler on the two coupled linear ODEs:
  //   cS·Ṫs = qSurface − k(Ts − Tc) − hS(Ts − Ta) − K_TRACK·Ts
  //   cC·Ṫc = qCarcass + k(Ts − Tc) − hC(Tc − Ta)
  const k = K_CONDUCTION;
  const aS = 1 + (dt / cS) * (k + hS + K_TRACK);
  const aC = 1 + (dt / cC) * (k + hC);
  const bS = tyre.surfaceT + (dt / cS) * (qSurface + hS * ambient);
  const bC = tyre.carcassT + (dt / cC) * (qCarcass + hC * ambient);
  const cSC = -(dt / cS) * k;
  const cCS = -(dt / cC) * k;

  // 2x2 solve. Determinant is >= 1 for any dt, so this never divides by zero.
  const det = aS * aC - cSC * cCS;
  tyre.surfaceT = (bS * aC - cSC * bC) / det;
  tyre.carcassT = (aS * bC - cCS * bS) / det;
  return tyre;
}

/**
 * Wear, in place. Rate rises with slip power and, sharply, with temperature —
 * an overheated tyre grains, and the standard cure is to slow down and let it
 * come back, which this reproduces because cooling is on the same state.
 */
export const WEAR_RATE = 2.4e-9;

export function wearStep(tyre, slipPower, dt) {
  const hot = Math.max(0, tyre.surfaceT - T_OPT) / T_WINDOW_HOT;
  const rate = WEAR_RATE * Math.max(0, slipPower) * (1 + 2.5 * hot * hot);
  tyre.wear = Math.min(1, tyre.wear + rate * dt);
  return tyre;
}

/** Peak-grip multiplier from wear. A dead tyre is slow, not frictionless. */
export function gripFromWear(wear) {
  return 1 - 0.28 * wear;
}

/** Everything that multiplies the Magic Formula's D, in one number. */
export function gripScale(tyre) {
  return gripFromTemperature(tyre.surfaceT) * gripFromWear(tyre.wear);
}

/** Slip power dissipated in the contact patch, W. The input to both models above. */
export function slipPower(fx, fy, slipVx, slipVy) {
  return Math.abs(fx * slipVx) + Math.abs(fy * slipVy);
}

// ---------------------------------------------------------------------------
// 6. Camber and vertical stiffness
// ---------------------------------------------------------------------------

/** F1 runs a lot of static negative camber. Radians, negative = top leans in. */
export const STATIC_CAMBER_FRONT = -3.5 * Math.PI / 180;
export const STATIC_CAMBER_REAR = -2.0 * Math.PI / 180;
/** Camber thrust per radian per newton of load. */
export const K_CAMBER = 0.95;

/**
 * Camber thrust. A cambered tyre generates lateral force at zero slip angle, in
 * the direction it is leaning. Small — a couple of hundred newtons a corner — but
 * it is a constant bias on the axle, so it shifts the balance rather than just
 * adding grip.
 */
export function camberThrust(fz, camber) {
  return K_CAMBER * Math.max(fz, 0) * camber;
}

/**
 * Vertical stiffness. The tyre is a spring in series with the suspension, and on
 * a 2022+ 18" low-profile construction it is a stiff one: the sidewall is short,
 * so it contributes little compliance. That is precisely why the current cars
 * ride kerbs so badly, and it is why the wheel-hop mode is fast enough to need
 * the semi-implicit integrator in suspension.js.
 */
export const TYRE_K = 310000;
export const TYRE_C = 620;

/**
 * Contact force from tyre deflection. One-sided: a tyre off the ground pulls on
 * nothing, so both the spring and the damper term have to vanish together or an
 * airborne wheel gets sucked back down.
 */
export function tyreVerticalForce(deflection, rate = 0) {
  if (deflection <= 0) return 0;
  return Math.max(0, TYRE_K * deflection + TYRE_C * rate);
}

// ---------------------------------------------------------------------------
// 7. Wheel angular DOF
// ---------------------------------------------------------------------------

/**
 * `I·ω̇ = T_drive − T_brake·sign(ω) − Fx·R_eff`
 *
 * This is the difference between modelling wheelspin and clamping a force. It is
 * also why the old target-speed solver could not launch the car from rest: with
 * `ω` derived from road speed there is nothing to spin, so a stationary car had
 * no mechanism by which the engine could start it moving.
 *
 * Brake torque is handled as an *arrest* rather than a signed torque near zero
 * speed. Applied as `−T·sign(ω)` it overshoots through zero every step at 600 Hz
 * and the wheel buzzes between forward and backward rotation instead of locking.
 */
export function wheelAngularStep(omega, driveTorque, brakeTorque, fx, dt, inertia = WHEEL_INERTIA) {
  const rolling = -fx * WHEEL_RADIUS;
  let next = omega + (dt / inertia) * (driveTorque + rolling);

  if (brakeTorque > 0) {
    const dOmega = (brakeTorque * dt) / inertia;
    // The most the brake can do is stop the wheel; past that it would drive it
    // backwards, which is what makes a locked wheel chatter in a naive model.
    if (Math.abs(next) <= dOmega) next = 0;
    else next -= Math.sign(next) * dOmega;
  }
  return next;
}

/** Brake torque a locked wheel needs, for the friction-limited check. */
export function lockTorque(fz, mu) {
  return peakGrip(mu, fz) * WHEEL_RADIUS;
}
