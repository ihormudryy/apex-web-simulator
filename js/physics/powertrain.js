/**
 * Power unit, transmission and brakes.
 *
 * The model this replaces computed drive force as `min(POWER / v, F_max)` — keyed
 * to *road speed*. Three consequences, all of them felt:
 *
 *   - **Gear had no effect on acceleration.** Identical thrust in first and
 *     seventh, because neither appeared in the expression.
 *   - **There was nothing to spin.** A force keyed to speed cannot launch a
 *     stationary car and cannot model wheelspin, because no wheel state exists
 *     for the torque to act on.
 *   - **rpm was derived backwards from speed** for the tacho and the engine note,
 *     so the engine sounded like a function of how fast the scenery was moving.
 *
 * Routing torque through real ratios fixes all three at once, and brings gears
 * that matter, a power band, short-shifting, engine braking that is genuinely
 * driveline drag, and a tacho that means something.
 *
 *   T_wheel = ( T_ice(rpm, throttle, boost) + T_mguk(SoC, mode) ) · r_gear · r_final · η
 *   rpm     = ω_wheel · r_gear · r_final                (plus clutch slip at launch)
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const RAD_PER_S_TO_RPM = 60 / (2 * Math.PI);
const RPM_TO_RAD_PER_S = 1 / RAD_PER_S_TO_RPM;

// ---------------------------------------------------------------------------
// Internal combustion engine — 1.6 L V6 turbo
// ---------------------------------------------------------------------------

export const IDLE_RPM = 4000;
/** The regulations allow 15 000. Nobody uses it; the power peak is lower. */
export const LIMITER_RPM = 15000;
export const SHIFT_UP_RPM = 12600;
export const SHIFT_DOWN_RPM = 8800;

/**
 * Full-boost, full-throttle crank torque, N·m against rpm.
 *
 * A table rather than a formula, because the shape is the point: a turbo V6 has a
 * broad plateau either side of 11 000 and falls away toward the limiter, and no
 * two-parameter curve reproduces both the plateau and the fall.
 */
const TORQUE_RPM = [0, 2500, 4000, 6000, 8000, 10000, 11000, 12000, 12500, 13500, 15000];
const TORQUE_NM = [0, 210, 300, 400, 470, 505, 515, 505, 470, 415, 320];

/**
 * Scales the whole curve so that ICE peak plus MGU-K deployment lands on the
 * ~735 kW (~1000 PS) combined figure in the reference table. Tuning the table
 * entries by hand to hit a total is how a torque curve stops being a shape and
 * becomes a fudge; one scalar keeps the shape honest.
 */
export const ICE_POWER_SCALE = 0.969;

/** Linear interpolation on the table. Flat outside it rather than extrapolating. */
function tableLookup(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  const n = xs.length;
  if (x >= xs[n - 1]) return ys[n - 1];
  let i = 1;
  while (i < n - 1 && xs[i] < x) i++;
  const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
  return ys[i - 1] + t * (ys[i] - ys[i - 1]);
}

/**
 * Off-throttle driveline drag, referred to the crank. This is what engine
 * braking actually *is* — pumping losses and friction, rising with rpm — rather
 * than the fixed rearward force the old model applied at the contact patch.
 */
export const ENGINE_DRAG_NM_AT_LIMITER = 95;

/**
 * @param {number} rpm crank speed
 * @param {number} throttle 0..1
 * @param {number} boost 0..1 — turbo spool state, see `boostStep`
 * @returns {number} crank torque, N·m. Negative off-throttle.
 */
export function engineTorque(rpm, throttle, boost = 1) {
  if (rpm >= LIMITER_RPM) {
    // A hard cut, which is what a real limiter does and what makes it audible.
    return throttle > 0 ? 0 : -ENGINE_DRAG_NM_AT_LIMITER;
  }
  const drag = -ENGINE_DRAG_NM_AT_LIMITER * clamp(rpm / LIMITER_RPM, 0, 1);
  const wot = ICE_POWER_SCALE * tableLookup(TORQUE_RPM, TORQUE_NM, rpm);
  // Boost multiplies the pressure-charged part only; the naturally aspirated
  // fraction is available immediately, which is why a modern turbo has far less
  // of a hole than a 1980s one.
  const NA_FRACTION = 0.62;
  const charged = wot * (NA_FRACTION + (1 - NA_FRACTION) * clamp(boost, 0, 1));
  return drag + clamp(throttle, 0, 1) * (charged - drag);
}

/** Crank power, W. Useful for validation and for nothing else. */
export function enginePower(rpm, throttle, boost = 1) {
  return engineTorque(rpm, throttle, boost) * rpm * RPM_TO_RAD_PER_S;
}

/**
 * Turbo spool, in place on a state object.
 *
 * Boost builds faster at high rpm — there is more exhaust energy to work with —
 * and bleeds away off throttle. The MGU-H that used to hold the compressor
 * spooled is gone from 2026, so this lag is a real characteristic to keep rather
 * than an artefact to eliminate.
 */
export const SPOOL_UP = 4.5;
export const SPOOL_DOWN = 7.0;

export function boostStep(state, rpm, throttle, dt) {
  const target = clamp(throttle, 0, 1) * clamp(rpm / 9000, 0.15, 1);
  const rate = target > state.boost
    ? SPOOL_UP * clamp(rpm / 11000, 0.25, 1)
    : SPOOL_DOWN;
  // Exponential approach, integrated exactly so the step size cannot destabilise it.
  state.boost += (target - state.boost) * (1 - Math.exp(-rate * dt));
  return state.boost;
}

// ---------------------------------------------------------------------------
// Transmission
// ---------------------------------------------------------------------------

/**
 * Eight fixed forward ratios, progressively spaced — big steps low where torque
 * is plentiful, close steps high where holding the power band matters.
 *
 * Chosen so that eighth gives ~322 km/h at 12 500 rpm, which puts the
 * drag-limited top speed on the ~330 km/h reference figure without the limiter
 * being what stops the car. A gearbox where the limiter sets top speed is a
 * gearbox with the wrong ratios.
 */
export const GEAR_RATIOS = [3.90, 3.15, 2.62, 2.24, 1.95, 1.72, 1.52, 1.32];
export const FINAL_DRIVE = 3.7;
export const REVERSE_RATIO = -3.2;
export const DRIVELINE_EFFICIENCY = 0.93;
/** Seamless-shift boxes are quick but not instant, and the cut is felt. */
export const SHIFT_TIME = 0.04;
export const TOP_GEAR = GEAR_RATIOS.length;

/** Total ratio for a gear index. 0 is neutral, -1 is reverse. */
export function totalRatio(gear) {
  if (gear === 0) return 0;
  if (gear < 0) return REVERSE_RATIO * FINAL_DRIVE;
  return GEAR_RATIOS[Math.min(gear, TOP_GEAR) - 1] * FINAL_DRIVE;
}

export function createGearboxState() {
  return { gear: 1, shiftTimer: 0, boost: 0, shifting: false };
}

/**
 * Crank speed from driven-wheel speed.
 *
 * Floored at idle, which stands in for the clutch: below the speed at which the
 * engine would stall in gear, the clutch slips and the engine sits at idle. That
 * is enough to launch the car properly without a separate clutch DOF, and it is
 * why `clutchSlip` is reported — the audio and the dashboard both want to know.
 */
export function engineRpm(wheelOmega, gear) {
  const ratio = Math.abs(totalRatio(gear));
  if (ratio === 0) return IDLE_RPM;
  const geared = Math.abs(wheelOmega) * ratio * RAD_PER_S_TO_RPM;
  return Math.max(IDLE_RPM, Math.min(geared, LIMITER_RPM));
}

export function clutchSlip(wheelOmega, gear) {
  const ratio = Math.abs(totalRatio(gear));
  if (ratio === 0) return 1;
  const geared = Math.abs(wheelOmega) * ratio * RAD_PER_S_TO_RPM;
  return geared < IDLE_RPM ? 1 - geared / IDLE_RPM : 0;
}

/**
 * Automatic shift logic, in place. Upshifts near the power peak, downshifts to
 * keep the engine in the band, and holds the gear while a shift is in progress.
 *
 * Downshift protection matters: without the projected-rpm check, braking from
 * 300 km/h runs down through the whole box in a few hundred milliseconds and
 * every one of those shifts is a rear-axle torque spike.
 */
export function gearboxStep(state, wheelOmega, throttle, dt) {
  if (state.shiftTimer > 0) {
    state.shiftTimer = Math.max(0, state.shiftTimer - dt);
    state.shifting = state.shiftTimer > 0;
    return state;
  }
  state.shifting = false;
  const rpm = engineRpm(wheelOmega, state.gear);

  if (state.gear < TOP_GEAR && rpm >= SHIFT_UP_RPM && throttle > 0.1) {
    state.gear++;
    beginShift(state);
  } else if (state.gear > 1 && rpm <= SHIFT_DOWN_RPM) {
    // Only if the lower gear will not immediately bounce off the limiter.
    const projected = engineRpm(wheelOmega, state.gear - 1);
    if (projected < SHIFT_UP_RPM - 200) {
      state.gear--;
      beginShift(state);
    }
  }
  return state;
}

/**
 * `shifting` has to be set on the same step the shift starts, not on the next
 * one. Setting it only in the countdown branch left one step of full torque going
 * through a gearbox that was mid-change — a small window, but the wrong sign of
 * wrong: the cut is what the shift *is*.
 */
function beginShift(state) {
  state.shiftTimer = SHIFT_TIME;
  state.shifting = true;
}

/** Wheel torque from crank torque. Zero through a shift — the cut is real. */
export function wheelTorque(crankTorque, gear, shifting) {
  if (shifting || gear === 0) return 0;
  return crankTorque * totalRatio(gear) * DRIVELINE_EFFICIENCY;
}

// ---------------------------------------------------------------------------
// ERS — MGU-K and battery
// ---------------------------------------------------------------------------

/** 2022–2025 regulations. `ERA_2026` below swaps these. */
export const MGUK_POWER = 120000;
export const MGUK_TORQUE_LIMIT = 220;
/** Usable store, joules. 4 MJ. */
export const BATTERY_CAPACITY = 4e6;
export const HARVEST_POWER = 120000;

export const MODE_OFF = 0;
export const MODE_DEPLOY = 1;
export const MODE_HARVEST = 2;

export function createErsState(soc = BATTERY_CAPACITY * 0.7) {
  return { soc, mode: MODE_OFF, deployed: 0, harvested: 0 };
}

/**
 * MGU-K crank torque. Positive deploys, negative harvests.
 *
 * Constant *power* above the corner speed and constant *torque* below it, which
 * is what an inverter-limited electric machine does — and which is exactly the
 * torque fill that makes these cars launch as hard as they do, because the
 * electric torque is there at 4000 rpm where the turbo is not.
 */
export function mgukTorque(soc, mode, rpm, power = MGUK_POWER) {
  const omega = Math.max(rpm, IDLE_RPM) * RPM_TO_RAD_PER_S;
  const byPower = power / omega;
  const limited = Math.min(byPower, MGUK_TORQUE_LIMIT);
  if (mode === MODE_DEPLOY) return soc > 0 ? limited : 0;
  if (mode === MODE_HARVEST) return soc < BATTERY_CAPACITY ? -limited : 0;
  return 0;
}

/**
 * Move energy in or out of the store, in place. Round-trip efficiency is applied
 * on the harvest side, which is where it is felt: you get back less than the
 * brakes threw away.
 */
export const ERS_EFFICIENCY = 0.92;

export function ersStep(ers, crankTorque, rpm, dt) {
  const omega = Math.max(rpm, IDLE_RPM) * RPM_TO_RAD_PER_S;
  const power = crankTorque * omega;
  if (power > 0) {
    const drawn = Math.min(ers.soc, power * dt / ERS_EFFICIENCY);
    ers.soc -= drawn;
    ers.deployed += drawn;
  } else if (power < 0) {
    const stored = Math.min(BATTERY_CAPACITY - ers.soc, -power * dt * ERS_EFFICIENCY);
    ers.soc += stored;
    ers.harvested += stored;
  }
  return ers;
}

export const socFraction = ers => ers.soc / BATTERY_CAPACITY;

// ---------------------------------------------------------------------------
// Brakes — carbon-carbon
// ---------------------------------------------------------------------------

/**
 * Carbon-carbon friction against disc temperature.
 *
 * Genuinely poor cold — under about 250 °C a carbon disc barely retards the car,
 * which is why lap one out of the pits is a real and characteristic hazard rather
 * than a detail. Optimum is a broad plateau from 400 to 800 °C, and it fades
 * above 1000. This is one model with two outputs: it sets stopping power, and it
 * sets brake glow in the renderer.
 */
const BRAKE_MU_T = [0, 100, 200, 250, 350, 400, 800, 900, 1000, 1100, 1300];
const BRAKE_MU = [0.10, 0.13, 0.22, 0.33, 0.52, 0.60, 0.62, 0.58, 0.50, 0.38, 0.28];

export function brakeMu(discT) {
  return tableLookup(BRAKE_MU_T, BRAKE_MU, discT);
}

/**
 * Thermal mass per corner, J/K. Lumps disc, pads and the near part of the
 * caliper — separating them would add state without changing what is felt.
 *
 * Sized so that a 300 km/h stop raises a front disc by ~600 K, which takes it
 * from a warm 400 °C to the 1000 °C where fade begins. That is the real number,
 * and it is why brake management exists as a thing drivers talk about.
 */
export const C_DISC = 5200;
/** Ducted convection, W/K: a standing term plus one scaling with road speed. */
export const H_DISC_0 = 8;
export const H_DISC_V = 0.9;
/**
 * Radiation, W/K⁴ — ε·σ·A for a glowing carbon disc. Negligible when warm and
 * dominant above 700 °C, which is what actually caps peak temperature and what
 * makes the disc visibly glow. A purely convective model runs away.
 */
export const RADIATION_COEFF = 4.08e-9;
export const T_ZERO_K = 273.15;

export function createBrakeState(t0 = 80) {
  return { discT: [t0, t0, t0, t0] };
}

/**
 * Advance one corner's disc temperature. `brakePower` is the mechanical power the
 * friction brake is dissipating at that corner, W.
 *
 * Semi-implicit on the convective term and explicit on radiation: radiation is
 * `T⁴` so it cannot be inverted cheaply, but it is also strongly self-limiting,
 * so an explicit treatment is stable in the range that matters. The convective
 * term is the one with the short time constant, and it is handled implicitly.
 */
export function brakeThermalStep(state, corner, brakePower, speed, dt, ambient = 30) {
  const t = state.discT[corner];
  const h = H_DISC_0 + H_DISC_V * Math.abs(speed);
  const tK = t + T_ZERO_K;
  const ambK = ambient + T_ZERO_K;
  const qRad = RADIATION_COEFF * (tK * tK * tK * tK - ambK * ambK * ambK * ambK);
  const next = (t + (dt / C_DISC) * (Math.max(0, brakePower) - qRad + h * ambient))
    / (1 + (dt / C_DISC) * h);
  state.discT[corner] = Math.max(ambient, next);
  return state.discT[corner];
}

/** Convenience for the capability probe and the dashboard. */
export function brakeTemperature(state, corner) {
  return state.discT[corner];
}

// ---------------------------------------------------------------------------
// Brake-by-wire
// ---------------------------------------------------------------------------

/**
 * Split a rear brake torque demand between MGU-K regeneration and friction.
 *
 * On these cars the rear friction pressure is modulated by the ECU so that
 * regeneration plus friction equals what the driver asked for. The consequence is
 * that **brake balance shifts as the battery fills**: with an empty store the
 * MGU-K takes a large share of the rear axle, and once it is full the friction
 * brakes take all of it and the rear does more of the work. That is a genuine
 * felt characteristic of the era, and it falls out of getting the blend right
 * rather than being added on top.
 *
 * Writes into `out` so the sim loop allocates nothing.
 */
export function brakeByWire(demandNm, soc, rpm, gear, speed, out) {
  // Referred to the wheel, because that is the axis the demand is expressed on.
  const regenWheelNm = Math.abs(mgukTorque(soc, MODE_HARVEST, rpm))
    * Math.abs(totalRatio(gear)) * DRIVELINE_EFFICIENCY;
  // Regeneration is useless below a crawl: there is no shaft speed to harvest at.
  const usable = speed > MIN_REGEN_SPEED && soc < BATTERY_CAPACITY ? regenWheelNm : 0;
  out.regen = Math.max(0, Math.min(Math.max(0, demandNm), usable));
  out.friction = Math.max(0, demandNm - out.regen);
  return out;
}

/** Below this road speed the MGU-K cannot usefully harvest. */
export const MIN_REGEN_SPEED = 5;

// ---------------------------------------------------------------------------
// Era configuration
// ---------------------------------------------------------------------------

/**
 * 2026 as a config rather than a fork: near 50/50 ICE/electric split, 350 kW from
 * the MGU-K, and active aero (which aero.js reads).
 */
export const ERA_2022 = {
  name: '2022',
  mgukPower: MGUK_POWER,
  icePowerScale: ICE_POWER_SCALE,
  activeAero: false,
};

export const ERA_2026 = {
  name: '2026',
  mgukPower: 350000,
  // Less ICE, much more electric, for a similar combined figure.
  icePowerScale: ICE_POWER_SCALE * 0.62,
  activeAero: true,
};
