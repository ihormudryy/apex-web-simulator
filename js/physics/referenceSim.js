/**
 * Binds the reference measurements to the four-wheel kernel, on an empty tarmac
 * plane.
 *
 * Everything the measurements need goes through this adapter, so `reference.js`
 * never imports the kernel and can be tested against a toy whose answers are known
 * on paper. Free of three.js, like the rest of `js/physics`.
 *
 * Two things here are deliberate and worth stating, because both look like
 * cheating and neither is:
 *
 *   - **The car is warmed up.** The reference figures describe what the car does
 *     with tyres and brakes at temperature. Measured from cold the same car takes
 *     4.6 s to 100 km/h rather than 3.2, because a 35 °C tyre has 70% of its grip
 *     and an 80 °C carbon disc has a fifth of its friction. Both are correct
 *     behaviour, and neither is what the targets are quoting.
 *
 *   - **Throttle goes through the driver model.** "0–100 km/h ~2.6 s (traction
 *     limited)" is an optimally modulated launch. With the throttle simply pinned,
 *     600 kW spins the rear tyres to a slip ratio of 3 and the figure becomes 4.6 s
 *     — measuring a car nobody would drive that way.
 */
import {
  createCar, step, warmUp, launch, resetCar,
  forwardSpeed, lateralSpeed, speedOf, yawRate, sideslipOf,
} from './kernel.js';
import {
  createDriverState, tractionThrottle, brakeModulation, resetDriver,
} from './driver.js';
import { DT } from './fixedStep.js';
import { MASS, G, RHO } from './constants.js';
import {
  createAeroState, groundEffect, clAtRideHeight,
} from './aero.js';
import {
  createSuspensionState, step as suspensionStep,
  RIDE_HEIGHT_FRONT, RIDE_HEIGHT_REAR,
} from './suspension.js';
import * as ST from './state.js';

/** Flat dry tarmac, no barriers — a proving ground rather than a circuit. */
export const OPEN_TARMAC = {
  query: () => ({
    surface: 'tarmac',
    lateral: 0,
    wallLimit: Number.MAX_SAFE_INTEGER,
    normal: { x: 0, z: 0 },
  }),
};

export function createReferenceSim() {
  return {
    MASS, G, RHO,

    create: () => {
      const car = createCar({ x: 0, z: 0, yaw: 0 });
      warmUp(car);
      car.driver = createDriverState();
      return car;
    },

    launch: (car, mps) => launch(car, mps),

    /**
     * One measurement frame. `advance` is handed a frame time, and steps the
     * kernel at the fixed `DT` — the same accumulator-free path a replay uses, so
     * a measurement is reproducible to the bit.
     */
    advance: (car, input, frameDt) => {
      const steps = Math.max(1, Math.round(frameDt / DT));
      for (let i = 0; i < steps; i++) {
        const vLong = forwardSpeed(car);
        // `throttle` as a number where the caller has one, `forward` as the
        // boolean shorthand. A skid-pad measurement needs a steady pedal: bang-bang
        // at 120 Hz kicks the rear axle every switch, and the resulting 0.3 rad/s
        // of yaw-rate ripple is indistinguishable from a car that will not settle.
        const demand = typeof input.throttle === 'number'
          ? input.throttle
          : (input.forward ? 1 : 0);
        const throttle = tractionThrottle(car.driver, car.S, demand, vLong, DT);
        const brake = brakeModulation(
          car.driver, car.S, input.brake ? 1 : 0, vLong, DT);
        step(car, {
          throttle,
          brake,
          steer: car._measureSteer ?? 0,
          drs: Boolean(input.drs),
        }, OPEN_TARMAC, DT);
      }
    },

    /** Set the road-wheel angle directly, bypassing the keyboard ramp. */
    steer: (car, rad) => { car._measureSteer = rad; },

    forward: forwardSpeed,
    lateral: lateralSpeed,
    yawRate,
    position: car => [car.S[ST.S_X], car.S[ST.S_Z]],

    /**
     * `step` catches a non-finite state and snaps back to spawn, so checking the
     * numbers alone would see a healthy car. `resets` is the tell.
     */
    finite: car => car.resets === 0
      && Number.isFinite(car.S[ST.S_X]) && Number.isFinite(car.S[ST.S_Z])
      && Number.isFinite(car.S[ST.S_VX]) && Number.isFinite(car.S[ST.S_VZ])
      && Number.isFinite(car.S[ST.S_AV]),

    /**
     * Downforce at a speed, in kilogrammes.
     *
     * This used to be analytic — `½ρv²·ClA/g` from a constant. That constant no
     * longer exists: ClA is now a function of the ride height the car settles at,
     * which is itself a function of the downforce. So the only correct way to
     * measure it is to let the coupled system find its own equilibrium and then
     * read it off, which is what this does.
     */
    downforceAt: speedKmh => {
      const s = createSuspensionState();
      const a = createAeroState();
      const load = { ground: [0, 0, 0, 0], aeroFront: 0, aeroRear: 0 };
      const cond = {
        speed: speedKmh / 3.6, rideFront: RIDE_HEIGHT_FRONT, rideRear: RIDE_HEIGHT_REAR,
        sideslip: 0, yawRate: 0, drs: false, dt: DT,
      };
      // Eight seconds is well past the settling time, and past the point at which
      // any porpoising has reached its steady amplitude.
      const n = Math.round(8 / DT);
      let sum = 0;
      let counted = 0;
      for (let i = 0; i < n; i++) {
        cond.rideFront = s.rideFront;
        cond.rideRear = s.rideRear;
        groundEffect(a, cond);
        load.aeroFront = a.fzFront - a.plankFront;
        load.aeroRear = a.fzRear - a.plankRear;
        suspensionStep(s, load, DT);
        // Average the last second, so a porpoising car reports its mean rather
        // than wherever in the cycle the clock happened to stop.
        if (i > n - Math.round(1 / DT)) { sum += a.downforce; counted++; }
      }
      return counted ? sum / counted / G : NaN;
    },

    /** Steady-state ClA at the optima, for the capability report. */
    claAtOptimum: () => clAtRideHeight(0.012, true) + clAtRideHeight(0.038, false),

    reset: car => {
      resetCar(car);
      warmUp(car);
      resetDriver(car.driver);
      car._measureSteer = 0;
    },
  };
}
