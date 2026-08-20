/**
 * The four-wheel kernel.
 *
 * One fixed `DT` step of the whole car: four tyres each with their own load,
 * surface, temperature and angular velocity; a torque path from the engine to the
 * contact patch; the seven-DOF vertical system; and ride-height-dependent aero.
 *
 * Purpose-built rather than delegated to a physics library. Ammo, Cannon and
 * Rapier are general rigid-body solvers with generic contact handling, and their
 * vehicle helpers — `btRaycastVehicle` and its equivalents — are arcade-grade: a
 * raycast per wheel, a lumped friction model, no slip transients. No credible
 * racing simulator uses one for vehicle dynamics. What this car needs is narrow
 * and cheap: four wheels, one angular DOF and one suspension DOF each, and a good
 * tyre model. A generic solver would add cost, indeterminism and a worse tyre.
 *
 * ## What replaced what
 *
 * The planar model this supersedes had three specific failures, diagnosed by
 * measurement rather than by feel:
 *
 *   - **No tyre relaxation**, so force appeared the instant slip did and the rear
 *     axle had no time to build up. Departure was a step change.
 *   - **Yaw damping was a fudge** — `av *= 1 − dt·1.2`, a fixed first-order decay
 *     independent of speed, load and tyre state. Real directional damping comes
 *     from the tyres' own response to yaw rate through the front and rear moment
 *     arms, plus aero yaw damping. It is now both of those and no constant.
 *   - **Aero balance never moved**, split 40/60 at all times.
 *
 * Between them those produced a bifurcation rather than a limit: the car reached
 * ~70% of its own grip and then snapped into a sustained 20–30° drift.
 *
 * ## Sign conventions, once
 *
 *   - World: the car faces −Z at yaw 0. Forward is `(−sin yaw, −cos yaw)`.
 *   - Body: x forward, y **right**. Wheel order FL, FR, RL, RR.
 *   - `av` is yaw-*left* positive, matching three.js `rotation.y`.
 *   - A force `F` at body position `(x, y)` contributes `y·Fx − x·Fy` to the
 *     yaw-left moment.
 *   - Steer is positive-left, and rotates the wheel frame by
 *     `[long, lat] = [c·vl − s·vt, s·vl + c·vt]`.
 */

import {
  MASS, G, LF, LR, WB, IZ, TRACK_HALF, V_RELAX, V_CREEP, RHO,
} from './constants.js';
import {
  WHEEL_RADIUS, WHEEL_INERTIA, peakGrip, combinedSlipForces, slipRatio, slipAngle,
  relaxationLength, lagSlip, SIGMA_LAT, SIGMA_LONG,
  aligningTorque, gripScale, gripFromTemperature, gripFromWear,
  thermalStep, wearStep, slipPower, camberThrust,
  STATIC_CAMBER_FRONT, STATIC_CAMBER_REAR,
  wheelAngularStep, T_TRACK, muScaleFor,
} from './wheel.js';
import { wheelNormalLoads } from './loadTransfer.js';
import {
  createSuspensionState, step as suspensionStep, resetSuspension,
  RIDE_HEIGHT_FRONT, RIDE_HEIGHT_REAR, FZ_STATIC,
} from './suspension.js';
import {
  createAeroState, groundEffect, PLANK_FRICTION,
} from './aero.js';
import {
  engineTorque, boostStep, gearboxStep, createGearboxState, engineRpm, clutchSlip,
  wheelTorque, totalRatio, DRIVELINE_EFFICIENCY,
  mgukTorque, createErsState, ersStep, MODE_DEPLOY, MODE_HARVEST, MODE_OFF,
  BATTERY_CAPACITY, brakeMu, createBrakeState, brakeThermalStep, brakeByWire,
  IDLE_RPM, TOP_GEAR,
} from './powertrain.js';
import {
  createSurfaceSamples, sampleWheelSurfaces, fitGroundPlane, createGroundPlane,
  WHEEL_X, WHEEL_Y,
} from './surface.js';
import { applySetup, defaultSetup } from './setup.js';
import * as S_ from './state.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Tuning that belongs to the kernel rather than to a subsystem
// ---------------------------------------------------------------------------

/**
 * Total brake torque at optimum pad μ, N·m. Sized for the reference stopping
 * distances: 14 kN·m over a 0.334 m radius is 42 kN of retarding force, which on
 * 798 kg loaded by 2 tonnes of downforce is the 5–6 g the car should pull at
 * speed, and is friction-clipped back to a mechanical ~2 g when the aero is gone.
 */
export const BRAKE_TORQUE_MAX = 14000;
export const BRAKE_MU_REFERENCE = 0.62;
export const BRAKE_BIAS_FRONT = 0.58;

/**
 * Differential. A fully open diff sends equal *torque* to both wheels, so one
 * spinning wheel takes the drive away from the other; fully locked forces equal
 * *speed*. Real F1 runs a limited-slip somewhere between, and this is the fraction
 * of the way toward locked.
 */
export const DIFF_LOCK = 0.55;

/** Rolling resistance, as a fraction of vertical load. */
export const ROLLING_RESISTANCE = 0.014;

/**
 * Crank and driveline rotational inertia, kg·m².
 *
 * Small in itself, and dominant where it matters. Reflected through a gear ratio
 * it scales as `ratio²`, so in first gear (14.4:1 overall) it contributes 16.6
 * kg·m² at the wheels against the wheel's own 1.5 — eleven times as much.
 *
 * Leaving it out is not a small error. With the wheels carrying only their own
 * inertia, full throttle from rest spun them to 320 rad/s in a fraction of a
 * second: slip ratio 18, the tyre far past its peak delivering 1.6 kN instead of
 * 3.5, the engine chasing the wheels to the limiter, and the car crawling away at
 * 5 km/h after thirty seconds. Accelerating the engine is most of what a low gear
 * asks of the tyre at launch.
 */
export const ENGINE_INERTIA = 0.08;
export const DRIVEN_WHEELS = 2;

/** Reverse is a recovery crawl. */
export const REVERSE_TORQUE = 1400;
export const REVERSE_SPEED_LIMIT = 8;

/** ERS strategy: deploy on throttle, harvest on the brakes. */
export const DEPLOY_THROTTLE = 0.5;
/**
 * Deployment works from a standstill. It has to: constant-torque electric drive
 * below the corner speed is precisely the torque fill that makes these cars launch
 * as hard as they do, and gating it to 5 m/s threw that away exactly where it
 * mattered most.
 */
export const DEPLOY_MIN_SPEED = 0.2;

/**
 * Temperatures a warmed car starts at. Tyre blankets, and brakes brought up on
 * the way to the grid.
 *
 * Not a convenience. The tyres previously started at track temperature, where the
 * grip multiplier is 0.70 — so a standing start threw away 30% of the available
 * grip, and the brakes at 80 °C had a pad μ of 0.12 against an optimum of 0.62.
 * Both are correct behaviour for a cold car and neither is what the reference
 * figures describe, since those are what the car does with everything at
 * temperature.
 */
export const BLANKET_TYRE_T = 80;
export const WARM_BRAKE_T = 500;

// ---------------------------------------------------------------------------
// Car — the state vector plus the subsystem state it does not flatten
// ---------------------------------------------------------------------------

/**
 * The suspension, aero, gearbox, ERS and brake subsystems keep their own small
 * objects rather than being packed into the flat vector directly. They contain
 * only numbers and preallocated arrays, so the inner loop still allocates nothing;
 * what they cost is that a snapshot of the flat vector alone would be incomplete.
 *
 * `syncToState` mirrors their DOFs into the vector every step — 28 float stores,
 * which at 600 Hz is invisible — so the vector *is* a complete snapshot and the
 * worker and replay stories both hold. The alternative, indexing the seven-DOF
 * solver into a shared array, costs the readability of the one piece of code here
 * most worth being able to read.
 */
export function createCar({ x = 0, z = 0, yaw = 0, shared = false, setup = null } = {}) {
  const S = S_.createState({ shared });
  const tune = applySetup(setup ?? defaultSetup());
  const car = {
    S,
    /** Everything the setup screen moves, derived once. See setup.js. */
    tune,
    suspension: createSuspensionState(tune),
    aero: createAeroState(),
    gearbox: createGearboxState(),
    ers: createErsState(),
    brakes: createBrakeState(),
    surfaces: createSurfaceSamples(),
    ground: createGroundPlane(),
    /**
     * Per-wheel outputs, for telemetry, audio and the renderer.
     *
     * Loads are seeded with the static corner weights rather than zeros: a parked
     * car does carry its own weight, and a dashboard reading zero grip on the
     * first frame before the kernel has stepped is a lie about the car.
     */
    out: {
      fz: [FZ_STATIC[0], FZ_STATIC[1], FZ_STATIC[2], FZ_STATIC[3]],
      fx: [0, 0, 0, 0],
      fy: [0, 0, 0, 0],
      slipRatio: [0, 0, 0, 0],
      slipAngle: [0, 0, 0, 0],
      slipSpeed: [0, 0, 0, 0],
      mz: 0,
      rpm: IDLE_RPM,
      clutch: 0,
      downforce: 0,
      drag: 0,
      aLong: 0,
      aLat: 0,
      steerTorque: 0,
      plankContact: false,
      onBumpStop: false,
      groundHeight: 0,
      gradeLong: 0,
      gradeLat: 0,
      roughness: 0,
    },
    /** Scratch, reused so the step allocates nothing. */
    _force: { fx: 0, fy: 0 },
    _bbw: { regen: 0, friction: 0 },
    _tyre: [tyreScratch(), tyreScratch(), tyreScratch(), tyreScratch()],
    _cond: {
      speed: 0, rideFront: RIDE_HEIGHT_FRONT, rideRear: RIDE_HEIGHT_REAR,
      sideslip: 0, yawRate: 0, drs: false, dt: 0, activeAero: false,
      claWingFront: 0, claWingRear: 0, cdaWings: 0,
    },
    _load: { aeroFront: 0, aeroRear: 0, ax: 0, ay: 0, ground: [0, 0, 0, 0] },
    resets: 0,
    spawn: { x, z, yaw },
    /**
     * Ground height the suspension is referenced to. Set when the car is placed,
     * so spawning on an 8 m plateau is not an 8 m step into the springs.
     */
    datum: 0,
  };
  resetCar(car);
  S[S_.S_X] = x;
  S[S_.S_Z] = z;
  S[S_.S_YAW] = yaw;
  return car;
}

const tyreScratch = () => ({ surfaceT: T_TRACK, carcassT: T_TRACK, wear: 0 });

export function resetCar(car) {
  const S = car.S;
  S.fill(0);
  S[S_.S_X] = car.spawn.x;
  S[S_.S_Z] = car.spawn.z;
  S[S_.S_YAW] = car.spawn.yaw;
  S[S_.S_GEAR] = 1;
  S[S_.S_SOC] = BATTERY_CAPACITY * 0.7;
  S[S_.S_FLOOR_LAG_FRONT] = 1;
  S[S_.S_FLOOR_LAG_REAR] = 1;
  S[S_.S_FUEL] = 100;
  for (let i = 0; i < 4; i++) {
    S[S_.S_TYRE_SURFACE_T + i] = T_TRACK;
    S[S_.S_TYRE_CARCASS_T + i] = T_TRACK;
    S[S_.S_BRAKE_T + i] = 80;
  }
  car.warm = false;
  resetSuspension(car.suspension);
  car.gearbox.gear = 1;
  car.gearbox.shiftTimer = 0;
  car.gearbox.boost = 0;
  car.gearbox.shifting = false;
  car.ers.soc = BATTERY_CAPACITY * 0.7;
  car.ers.mode = MODE_OFF;
  car.aero.floorLagFront = 1;
  car.aero.floorLagRear = 1;
  for (let i = 0; i < 4; i++) car.brakes.discT[i] = 80;
  car.out.rpm = IDLE_RPM;
  return car;
}

/**
 * Bring the tyres and brakes up to temperature — blankets and an out-lap, in one
 * call. Everything the reference measurements are quoted at.
 */
export function warmUp(car) {
  const S = car.S;
  for (let i = 0; i < 4; i++) {
    S[S_.S_TYRE_SURFACE_T + i] = BLANKET_TYRE_T;
    S[S_.S_TYRE_CARCASS_T + i] = BLANKET_TYRE_T - 15;
    S[S_.S_BRAKE_T + i] = WARM_BRAKE_T;
    car.brakes.discT[i] = WARM_BRAKE_T;
  }
  car.warm = true;
  return car;
}

export function setSpawn(car, x, z, yaw, groundHeight = null) {
  car.spawn.x = x;
  car.spawn.z = z;
  car.spawn.yaw = yaw;
  car.S[S_.S_X] = x;
  car.S[S_.S_Z] = z;
  car.S[S_.S_YAW] = yaw;
  if (groundHeight !== null) car.datum = groundHeight;
}

/**
 * Re-reference the suspension to the ground under the car right now.
 *
 * Called after a teleport. Without it, dropping the car onto a part of the circuit
 * 6 m above where it was placed is a 6 m step into springs that resolve
 * millimetres, which is a spectacular way to lose a car.
 */
export function rebaseToGround(car, track) {
  sampleWheelSurfaces(track, car.S[S_.S_X], car.S[S_.S_Z], car.S[S_.S_YAW], car.surfaces);
  fitGroundPlane(car.surfaces, car.ground);
  car.datum = car.ground.height;
  return car.datum;
}

/** Launch the car at a speed, for a measurement that starts mid-track. */
export function launch(car, mps) {
  const S = car.S;
  const yaw = S[S_.S_YAW];
  S[S_.S_VX] = -Math.sin(yaw) * mps;
  S[S_.S_VZ] = -Math.cos(yaw) * mps;
  const omega = mps / WHEEL_RADIUS;
  for (let i = 0; i < 4; i++) S[S_.S_OMEGA + i] = omega;
  // Pick a gear that does not have the engine on the limiter or below idle.
  let gear = 1;
  while (gear < TOP_GEAR && engineRpm(omega, gear) >= 12000) gear++;
  car.gearbox.gear = gear;
  S[S_.S_GEAR] = gear;
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

/**
 * Advance one fixed step.
 *
 * @param {object} car from `createCar`
 * @param {{throttle:number, brake:number, steer:number, drs:boolean}} input
 *   throttle and brake in [0, 1] (throttle may be negative for reverse), steer in
 *   radians, positive left.
 * @param {object} track anything `sampleWheelSurfaces` understands.
 * @param {number} dt seconds — always the fixed `DT` in practice.
 */
export function step(car, input, track, dt) {
  const S = car.S;
  const out = car.out;
  const throttle = clamp(input.throttle ?? 0, -1, 1);
  const brakePedal = clamp(input.brake ?? 0, 0, 1);
  const steer = input.steer ?? 0;
  S[S_.S_STEER] = steer;
  S[S_.S_DRS] = input.drs ? 1 : 0;

  const yaw = S[S_.S_YAW];
  const sinY = Math.sin(yaw);
  const cosY = Math.cos(yaw);
  const vx = S[S_.S_VX];
  const vz = S[S_.S_VZ];
  const av = S[S_.S_AV];

  // Body-frame velocity. Recomputing this from world velocity each step is what
  // supplies the Coriolis terms without writing them out.
  const vLong = vx * -sinY + vz * -cosY;
  const vLat = vx * cosY + vz * -sinY;
  const speed = Math.hypot(vx, vz);
  const sideslip = Math.atan2(vLat, Math.max(Math.abs(vLong), V_RELAX));

  sampleWheelSurfaces(track, S[S_.S_X], S[S_.S_Z], yaw, car.surfaces);
  // Plane plus residual: the plane is where the car is and how steep the road is,
  // the residual is the bumps. Handing absolute height to a suspension that works
  // in displacement-from-static would compress every spring by the hill.
  const ground = fitGroundPlane(car.surfaces, car.ground);

  // ---- aero, from the ride heights the suspension last reported -----------
  // A one-step lag, which at 600 Hz is 1.7 ms. Solving it simultaneously would
  // mean iterating aero against suspension every step for no measurable gain.
  const cond = car._cond;
  cond.speed = speed;
  cond.rideFront = car.suspension.rideFront;
  cond.rideRear = car.suspension.rideRear;
  cond.sideslip = sideslip;
  cond.yawRate = av;
  cond.drs = Boolean(input.drs);
  cond.dt = dt;
  cond.claWingFront = car.tune.claWingFront;
  cond.claWingRear = car.tune.claWingRear;
  cond.cdaWings = car.tune.cdaWings;
  const aero = groundEffect(car.aero, cond);
  S[S_.S_FLOOR_LAG_FRONT] = aero.floorLagFront;
  S[S_.S_FLOOR_LAG_REAR] = aero.floorLagRear;

  // ---- vertical system ---------------------------------------------------
  const load = car._load;
  // The plank pushes UP, so it comes off the downward aero load rather than onto
  // it. Adding it drove the coupled system to NaN above 280 km/h.
  load.aeroFront = aero.fzFront - aero.plankFront;
  load.aeroRear = aero.fzRear - aero.plankRear;
  load.ax = S[S_.S_A_LONG];
  load.ay = S[S_.S_A_LAT];
  // Raw wheel heights, less the datum the car was placed at. The suspension's
  // heave, pitch and roll are free DOFs, so it settles onto any plane by itself
  // and the springs return to static — while a kerb, a crest and a compression
  // all arrive as the transients they actually are. Handing it the plane residual
  // instead deleted every one of them: two wheels on a kerb is indistinguishable
  // from banking once you have subtracted a plane.
  for (let i = 0; i < 4; i++) load.ground[i] = car.surfaces[i].height - car.datum;
  suspensionStep(car.suspension, load, dt);

  // ---- powertrain --------------------------------------------------------
  const omegaRear = 0.5 * (S[S_.S_OMEGA + S_.RL] + S[S_.S_OMEGA + S_.RR]);
  car.gearbox.gear = S[S_.S_GEAR];
  car.gearbox.shiftTimer = S[S_.S_SHIFT_TIMER];
  car.gearbox.boost = S[S_.S_BOOST];
  gearboxStep(car.gearbox, omegaRear, throttle, dt);
  const gear = car.gearbox.gear;
  const rpm = engineRpm(omegaRear, gear);
  boostStep(car.gearbox, rpm, Math.max(0, throttle), dt);
  S[S_.S_GEAR] = gear;
  S[S_.S_SHIFT_TIMER] = car.gearbox.shiftTimer;
  S[S_.S_BOOST] = car.gearbox.boost;

  car.ers.soc = S[S_.S_SOC];
  const deploying = throttle > DEPLOY_THROTTLE && speed > DEPLOY_MIN_SPEED;
  car.ers.mode = deploying ? MODE_DEPLOY : (brakePedal > 0.05 ? MODE_HARVEST : MODE_OFF);

  let crankTorque = engineTorque(rpm, Math.max(0, throttle), car.gearbox.boost);
  const deployTorque = deploying
    ? mgukTorque(car.ers.soc, MODE_DEPLOY, rpm)
    : 0;
  crankTorque += deployTorque;

  // Engine braking goes through the clutch, and near a standstill the clutch is
  // out. Without this the car crept backwards forever: at rest the engine still
  // made -25 N·m of pumping drag, which through a 14.4:1 first gear is -336 N·m at
  // the rear axle, and the standstill arrest settled at an equilibrium of
  // -0.16 m/s rather than at zero.
  const slip = clutchSlip(omegaRear, gear);
  if (crankTorque < 0) crankTorque *= 1 - slip;

  let driveTorque = wheelTorque(crankTorque, gear, car.gearbox.shifting);
  if (throttle < 0 && vLong > -REVERSE_SPEED_LIMIT) {
    driveTorque = throttle * REVERSE_TORQUE;
  }

  // ---- brakes -----------------------------------------------------------
  const demandTotal = BRAKE_TORQUE_MAX * brakePedal;
  const demandFront = demandTotal * car.tune.brakeBiasFront;
  const demandRear = demandTotal * (1 - car.tune.brakeBiasFront);
  // Brake-by-wire: the MGU-K takes what it can of the rear, friction the rest, so
  // the balance moves rearward as the battery fills.
  const bbw = brakeByWire(demandRear, car.ers.soc, rpm, gear, speed, car._bbw);
  const regenWheelTorque = bbw.regen;

  // ---- per wheel --------------------------------------------------------
  const fzW = wheelNormalLoads(
    S[S_.S_A_LONG], S[S_.S_A_LAT], aero.downforce, aero.balanceFront, car.tune);
  // Prefer the suspension's own loads once it is carrying the car: they include
  // bumps, kerbs and a wheel in the air, which the algebraic model cannot.
  const suspFz = car.suspension.fz;
  const suspTotal = suspFz[0] + suspFz[1] + suspFz[2] + suspFz[3];
  const useSuspension = suspTotal > car.tune.mass * G * 0.2;

  let sumFx = 0;
  let sumFy = 0;
  let sumMav = 0;
  let mzTotal = 0;

  const cosD = Math.cos(steer);
  const sinD = Math.sin(steer);
  const driven = [false, false, true, true];

  // Inertia the engine adds at each driven wheel, through the square of the ratio.
  const ratio = totalRatio(gear);
  const reflectedInertia = car.gearbox.shifting || ratio === 0
    ? 0
    : ENGINE_INERTIA * ratio * ratio / DRIVEN_WHEELS;

  // Open-to-locked differential: torque is shared by the lock fraction toward the
  // slower wheel, so a spinning inside rear does not take all the drive with it.
  const rearSlipBias = S[S_.S_OMEGA + S_.RL] - S[S_.S_OMEGA + S_.RR];
  const diffTransfer = car.tune.diffLock * clamp(rearSlipBias * 0.05, -0.5, 0.5);

  for (let i = 0; i < 4; i++) {
    const isFront = i < 2;
    const surf = car.surfaces[i];
    const fz = useSuspension ? suspFz[i] : fzW[i];
    out.fz[i] = fz;

    // Contact-patch velocity: yaw rate adds `+av·y` longitudinally and `−av·x`
    // laterally, from the yaw-left convention.
    const vLongW = vLong + av * WHEEL_Y[i];
    const vLatW = vLat - av * WHEEL_X[i];

    // Into the wheel's own frame. Only the fronts are steered.
    const wLong = isFront ? vLongW * cosD - vLatW * sinD : vLongW;
    const wLat = isFront ? vLongW * sinD + vLatW * cosD : vLatW;

    const omega = S[S_.S_OMEGA + i];
    const kappa = slipRatio(wLong, omega, V_RELAX);
    const alpha = slipAngle(wLat, wLong, V_RELAX);
    out.slipRatio[i] = kappa;
    out.slipAngle[i] = alpha;

    // Relaxation length. This is the change that turns a step departure into a
    // progressive one, and it is why the car can be caught.
    const sigmaLat = relaxationLength(fz, SIGMA_LAT);
    const sigmaLong = relaxationLength(fz, SIGMA_LONG);
    const travelSpeed = Math.max(Math.abs(wLong), 0.5);
    const alphaLag = lagSlip(S[S_.S_ALPHA_LAG + i], alpha, travelSpeed, sigmaLat, dt);
    const kappaLag = lagSlip(S[S_.S_KAPPA_LAG + i], kappa, travelSpeed, sigmaLong, dt);
    S[S_.S_ALPHA_LAG + i] = alphaLag;
    S[S_.S_KAPPA_LAG + i] = kappaLag;

    // Peak force, with temperature and wear folded in.
    const tyre = car._tyre[i];
    tyre.surfaceT = S[S_.S_TYRE_SURFACE_T + i];
    tyre.carcassT = S[S_.S_TYRE_CARCASS_T + i];
    tyre.wear = S[S_.S_TYRE_WEAR + i];
    // The per-axle scale is what makes the rear tyre a bigger tyre.
    const d = peakGrip(surf.mu, fz,
      gripScale(tyre) * (isFront ? car.tune.muScaleFront : car.tune.muScaleRear));

    combinedSlipForces(d, kappaLag, alphaLag, car._force);
    let fxW = car._force.fx;
    let fyW = car._force.fy;
    // Camber thrust. Both wheels of an axle lean their tops inward, so their
    // thrusts point at each other and cancel in a straight line — the sign has to
    // flip left to right. Applied with one sign to all four wheels it produced
    // 880 N of unopposed lateral force and a yaw moment that spun the car up to
    // 0.7 rad/s on a full-throttle launch with the steering dead centre.
    //
    // In a corner they no longer cancel, because load transfer makes the outer
    // one bigger, and the surplus points into the turn. That asymmetry is the
    // reason to run camber at all.
    const camber = Math.abs(isFront ? STATIC_CAMBER_FRONT : STATIC_CAMBER_REAR);
    fyW += -Math.sign(WHEEL_Y[i]) * camberThrust(fz, camber);

    // Rolling resistance opposes travel and shares the contact patch.
    const rr = ROLLING_RESISTANCE * fz;
    fxW -= Math.sign(wLong || 1) * Math.min(rr, Math.abs(d));

    // Self-aligning torque. Small in the yaw balance, and the whole of the
    // steering feel.
    const mz = aligningTorque(fyW, alphaLag, fz);
    mzTotal += isFront ? mz : 0;

    // ---- wheel angular DOF -------------------------------------------------
    let wheelDrive = 0;
    if (driven[i]) {
      const share = i === S_.RL ? 0.5 - diffTransfer : 0.5 + diffTransfer;
      wheelDrive = driveTorque * share;
    }
    // Friction brake torque follows pad μ, so cold brakes genuinely fail to stop
    // the car — the pedal commands a clamping force, not a torque.
    const discT = S[S_.S_BRAKE_T + i];
    const muScale = brakeMu(discT) / BRAKE_MU_REFERENCE;
    const frictionDemand = isFront ? demandFront / 2 : bbw.friction / 2;
    const brakeTorque = frictionDemand * muScale;
    const regenTorque = driven[i] ? regenWheelTorque / 2 : 0;

    const inertia = WHEEL_INERTIA + (driven[i] ? reflectedInertia : 0);
    S[S_.S_OMEGA + i] = wheelAngularStep(
      omega, wheelDrive, brakeTorque + regenTorque, fxW, dt, inertia);

    // ---- back to body axes -------------------------------------------------
    const fxB = isFront ? fxW * cosD + fyW * sinD : fxW;
    const fyB = isFront ? -fxW * sinD + fyW * cosD : fyW;
    out.fx[i] = fxB;
    out.fy[i] = fyB;

    sumFx += fxB;
    sumFy += fyB;
    sumMav += WHEEL_Y[i] * fxB - WHEEL_X[i] * fyB;

    // ---- thermal and wear --------------------------------------------------
    const slipVx = omega * WHEEL_RADIUS - wLong;
    const slipVy = wLat;
    out.slipSpeed[i] = Math.hypot(slipVx, slipVy);
    const power = slipPower(fxW, fyW, slipVx, slipVy);
    thermalStep(tyre, power, fz, speed, dt);
    wearStep(tyre, power, dt);
    S[S_.S_TYRE_SURFACE_T + i] = tyre.surfaceT;
    S[S_.S_TYRE_CARCASS_T + i] = tyre.carcassT;
    S[S_.S_TYRE_WEAR + i] = tyre.wear;

    // Brake disc: heated by the friction brake only. Regeneration goes into the
    // battery, which is the entire point of it.
    const brakePower = brakeTorque * Math.abs(S[S_.S_OMEGA + i]);
    brakeThermalStep(car.brakes, i, brakePower, speed, dt);
    S[S_.S_BRAKE_T + i] = car.brakes.discT[i];
  }

  // ---- ERS energy accounting --------------------------------------------
  const harvestCrankTorque = regenWheelTorque > 0 && totalRatio(gear) !== 0
    ? -regenWheelTorque / (Math.abs(totalRatio(gear)) * DRIVELINE_EFFICIENCY)
    : 0;
  ersStep(car.ers, deployTorque + harvestCrankTorque, rpm, dt);
  S[S_.S_SOC] = car.ers.soc;

  // ---- aero and plank on the body ---------------------------------------
  // Drag opposes the velocity vector, so a sliding car keeps its drag.
  const dragScale = speed > 1e-6 ? (aero.drag + aero.plankDrag) / speed : 0;
  const dragLong = -dragScale * vLong;
  const dragLat = -dragScale * vLat;
  sumFx += dragLong;
  sumFy += dragLat + aero.sideForce;
  sumMav += aero.yawMoment - mzTotal;

  // Gravity along the road. This is what makes a hill cost time going up and give
  // it back coming down, and what makes a banked corner hold the car in.
  sumFx -= car.tune.mass * G * ground.gradeLong;
  sumFy -= car.tune.mass * G * ground.gradeLat;

  // ---- integrate --------------------------------------------------------
  const mass = car.tune.mass;
  const aLong = sumFx / mass;
  const aLat = sumFy / mass;
  const avDot = sumMav / IZ;

  S[S_.S_A_LONG] = aLong;
  S[S_.S_A_LAT] = aLat;
  S[S_.S_AV] = av + dt * avDot;

  // Back to world along the same two basis vectors.
  S[S_.S_VX] = vx + dt * (-sinY * aLong + cosY * aLat);
  S[S_.S_VZ] = vz + dt * (-cosY * aLong - sinY * aLat);

  // At a standstill with no drive, arrest rather than creeping forever: drag is a
  // few newtons at walking pace and rolling resistance alone takes minutes.
  if (Math.abs(vLong) < V_CREEP && throttle === 0) {
    const decay = 1 - Math.min(1, dt * 8);
    S[S_.S_VX] *= decay;
    S[S_.S_VZ] *= decay;
    S[S_.S_AV] *= decay;
  }

  S[S_.S_X] += dt * S[S_.S_VX];
  S[S_.S_Z] += dt * S[S_.S_VZ];
  S[S_.S_YAW] += dt * S[S_.S_AV];
  S[S_.S_TIME] += dt;

  // ---- outputs ----------------------------------------------------------
  out.mz = mzTotal;
  out.steerTorque = mzTotal;
  out.rpm = rpm;
  out.clutch = slip;
  out.downforce = aero.downforce;
  out.drag = aero.drag;
  out.aLong = aLong;
  out.aLat = aLat;
  out.plankContact = aero.plankContact;
  out.onBumpStop = car.suspension.onBumpStop;
  out.groundHeight = ground.height;
  out.gradeLong = ground.gradeLong;
  out.gradeLat = ground.gradeLat;
  out.roughness = 0.25 * (car.surfaces[0].roughness + car.surfaces[1].roughness
    + car.surfaces[2].roughness + car.surfaces[3].roughness);

  syncToState(car);

  if (!S_.stateIsFinite(S)) {
    resetCar(car);
    car.resets++;
  }
}

/**
 * Mirror the subsystem DOFs into the flat vector, so the vector is a complete
 * snapshot. 28 stores; measured at well under 1% of step cost.
 */
function syncToState(car) {
  const S = car.S;
  const s = car.suspension;
  S[S_.S_ZC] = s.zc;
  S[S_.S_PITCH] = s.pitch;
  S[S_.S_ROLL] = s.roll;
  S[S_.S_VC] = s.vc;
  S[S_.S_V_PITCH] = s.vPitch;
  S[S_.S_V_ROLL] = s.vRoll;
  for (let i = 0; i < 4; i++) {
    S[S_.S_ZW + i] = s.zw[i];
    S[S_.S_VW + i] = s.vw[i];
  }
}

/** The inverse, for restoring a snapshot into a live car. */
export function syncFromState(car) {
  const S = car.S;
  const s = car.suspension;
  s.zc = S[S_.S_ZC];
  s.pitch = S[S_.S_PITCH];
  s.roll = S[S_.S_ROLL];
  s.vc = S[S_.S_VC];
  s.vPitch = S[S_.S_V_PITCH];
  s.vRoll = S[S_.S_V_ROLL];
  for (let i = 0; i < 4; i++) {
    s.zw[i] = S[S_.S_ZW + i];
    s.vw[i] = S[S_.S_VW + i];
  }
  car.gearbox.gear = S[S_.S_GEAR];
  car.gearbox.shiftTimer = S[S_.S_SHIFT_TIMER];
  car.gearbox.boost = S[S_.S_BOOST];
  car.ers.soc = S[S_.S_SOC];
  car.aero.floorLagFront = S[S_.S_FLOOR_LAG_FRONT];
  car.aero.floorLagRear = S[S_.S_FLOOR_LAG_REAR];
  for (let i = 0; i < 4; i++) car.brakes.discT[i] = S[S_.S_BRAKE_T + i];
  return car;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

export const forwardSpeed = car => {
  const S = car.S;
  return S[S_.S_VX] * -Math.sin(S[S_.S_YAW]) + S[S_.S_VZ] * -Math.cos(S[S_.S_YAW]);
};

export const lateralSpeed = car => {
  const S = car.S;
  return S[S_.S_VX] * Math.cos(S[S_.S_YAW]) + S[S_.S_VZ] * -Math.sin(S[S_.S_YAW]);
};

export const speedOf = car => Math.hypot(car.S[S_.S_VX], car.S[S_.S_VZ]);
export const yawRate = car => car.S[S_.S_AV];
export const sideslipOf = car =>
  Math.atan2(lateralSpeed(car), Math.max(Math.abs(forwardSpeed(car)), V_RELAX));

/** Lateral acceleration read off the trajectory: yaw rate times forward speed. */
export const lateralG = car => Math.abs(yawRate(car) * forwardSpeed(car)) / G;

export { S_ as STATE };
