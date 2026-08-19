// js/physics/bicycle.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { step, MASS, ENGINE_FX_MAX } from './bicycle.js';
import {
  createVehicle, advance, updateSteering, forwardSpeed, lateralSpeed,
} from './vehicle.js';

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

test('lateral tire force restores positive sideslip', () => {
  const dt = 0.01;
  const s = step({ vx: 40, vy: 1, av: 0, axPrev: 0 },
    { throttle: 0, brake: false, steer: 0 }, tarmac, dt);
  assert.ok(s.fy < 0, `fy=${s.fy} should oppose +vy sideslip`);
  assert.ok(s.vy < 1, `vy grew to ${s.vy}`);
});

test('straight reverse crawl stays laterally neutral', () => {
  const dt = 0.01;
  const s = step({ vx: -1, vy: 0, av: 0, axPrev: 0 },
    { throttle: -0.25, brake: false, steer: 0 }, tarmac, dt);
  assert.ok(Math.abs(s.fy) < 100, `fy=${s.fy}`);
  assert.ok(Math.abs(s.vy) < 0.01, `vy=${s.vy}`);
});

test('drive force uses rear longitudinal budget', () => {
  const dt = 0.01;
  const s = step({ vx: 3, vy: 0, av: 0, axPrev: 0 },
    { throttle: 1, brake: false, steer: 0 }, tarmac, dt);
  const fx = (s.vx - 3) / dt * MASS;
  const frontOnly = 1.6 * MASS * 9.81 * 0.46;
  assert.ok(fx > frontOnly * 1.02, `fx=${fx} capped at front grip ${frontOnly}`);
});

test('reverse steering reverses lateral and yaw response', () => {
  const dt = 0.01;
  const input = { throttle: 0, brake: false, steer: 0.1 };
  const base = { vy: 0, av: 0, axPrev: 0 };
  const f = step({ ...base, vx: 1 }, input, tarmac, dt);
  const r = step({ ...base, vx: -1 }, input, tarmac, dt);
  assert.ok(f.fy * r.fy < 0, `fy same sign: forward=${f.fy} reverse=${r.fy}`);
  assert.ok(f.av * r.av < 0, `yaw same sign: forward=${f.av} reverse=${r.av}`);
});

test('steady left steer curves left without excessive sideslip', () => {
  const dt = 1 / 240;
  const steer = 18 * Math.PI / 180;
  let state = { vx: 40, vy: 0, av: 0, axPrev: 0 };
  let worldVx = 0;
  let worldVz = -40;
  let x = 0;
  let z = 0;
  let yaw = 0;

  for (let i = 0; i < 3 / dt; i++) {
    const sinY = Math.sin(yaw);
    const cosY = Math.cos(yaw);
    state = {
      ...state,
      vx: cosY * -worldVz - sinY * worldVx,
      vy: sinY * -worldVz + cosY * worldVx,
    };
    const result = step(state,
      { throttle: 0, brake: false, steer }, tarmac, dt);

    const ax = (result.vx - state.vx) / dt;
    const ay = (result.vy - state.vy) / dt;
    worldVz -= dt * (cosY * ax + sinY * ay);
    worldVx += dt * (-sinY * ax + cosY * ay);
    x += dt * worldVx;
    z += dt * worldVz;
    yaw += dt * result.av;

    state = {
      vx: result.vx,
      vy: result.vy,
      av: result.av,
      axPrev: result.axPrev,
    };
  }

  const sideslip = Math.atan2(
    Math.sin(yaw) * -worldVz + Math.cos(yaw) * worldVx,
    Math.cos(yaw) * -worldVz - Math.sin(yaw) * worldVx,
  );
  assert.ok(x < -20, `left steer should curve toward -X, x=${x}, z=${z}`);
  assert.ok(Math.abs(sideslip) < 15 * Math.PI / 180,
    `sideslip=${sideslip * 180 / Math.PI}°`);
});

test('full throttle at a non-zero heading does not spin', () => {
  // Integrated through `vehicle.js` rather than a copy of its maths here: the
  // hand-rolled version in this file was where the tests drifted away from the
  // app's own world-to-body transform.
  const yaw0 = 159.44 * Math.PI / 180;
  const car = createVehicle({ yaw: yaw0 });
  const input = { forward: true, reverse: false, left: false, right: false, brake: false };
  const flat = { query: () => ({ surface: 'tarmac', wallLimit: 1e9, lateral: 0, normal: { x: 1, z: 0 } }) };

  for (let f = 0; f < 180; f++) {
    updateSteering(car, input, 1 / 60);
    advance(car, input, flat, 1 / 60);
  }

  const spun = (car.yaw - yaw0) * 180 / Math.PI;
  assert.ok(Math.abs(spun) < 5, `spun ${spun.toFixed(1)}° under throttle`);
  assert.ok(forwardSpeed(car) > 20, `did not accelerate, ${forwardSpeed(car)} m/s`);
  assert.ok(Math.abs(lateralSpeed(car)) < 1, `sideslip ${lateralSpeed(car)} m/s`);
});

// --- Regressions for the dynamics defects found while migrating ---

function coast(state, input, surface, seconds, h = 1 / 240) {
  let s = { ...state };
  for (let i = 0; i < Math.round(seconds / h); i++) {
    s = step(s, input, { surface }, h);
  }
  return s;
}

test('full brakes reach 4-5 g once aero has loaded the tyres', () => {
  const h = 1 / 240;
  let s = { vx: 80, vy: 0, av: 0, axPrev: 0 };
  let peak = 0;
  for (let i = 0; i < 240 * 6 && s.vx > 1; i++) {
    const prev = s.vx;
    s = step(s, { throttle: 0, brake: true, steer: 0 }, tarmac, h);
    peak = Math.max(peak, (prev - s.vx) / h / 9.81);
  }
  // 18 kN of brake demand could never exceed 2.3 g on an 800 kg car, which is
  // what the spec's own 4-5 g target asks for.
  assert.ok(peak > 4 && peak < 5.6, `peak deceleration ${peak.toFixed(2)} g`);
});

test('low-speed braking is limited by mechanical grip, not by pedal', () => {
  const h = 1 / 240;
  let s = { vx: 12, vy: 0, av: 0, axPrev: 0 };
  let peak = 0;
  for (let i = 0; i < 240 * 4 && s.vx > 1; i++) {
    const prev = s.vx;
    s = step(s, { throttle: 0, brake: true, steer: 0 }, tarmac, h);
    peak = Math.max(peak, (prev - s.vx) / h / 9.81);
  }
  assert.ok(peak > 1.2 && peak < 2.2,
    `peak deceleration ${peak.toFixed(2)} g should sit near the 1.6 mu limit`);
});

test('a coasting car comes to rest', () => {
  const rolled = coast({ vx: 40, vy: 0, av: 0, axPrev: 0 },
    { throttle: 0, brake: false, steer: 0 }, 'tarmac', 25);
  // With drag as the only retarding force this still had 12 m/s left after 25 s
  // and never actually stopped.
  assert.ok(Math.abs(rolled.vx) < 0.2, `still rolling at ${rolled.vx.toFixed(2)} m/s`);
});

test('off-throttle deceleration is engine braking, not just drag', () => {
  const h = 1 / 240;
  const s = step({ vx: 40, vy: 0, av: 0, axPrev: 0 },
    { throttle: 0, brake: false, steer: 0 }, tarmac, h);
  const decel = (40 - s.vx) / h;
  const dragAlone = 0.5 * 1.225 * 40 * 40 * 1.55 / MASS;
  assert.ok(decel > dragAlone * 1.5,
    `${decel.toFixed(2)} m/s2 is barely more than drag alone (${dragAlone.toFixed(2)})`);
});

test('lateral velocity settles instead of limit-cycling at a standstill', () => {
  const h = 1 / 240;
  let s = { vx: 0, vy: 0.02, av: 0, axPrev: 0 };
  const history = [];
  for (let i = 0; i < 40; i++) {
    s = step(s, { throttle: 0, brake: false, steer: 0 }, tarmac, h);
    history.push(s.vy);
  }
  // Dividing by the true vx sent the slip angle to 90 degrees at rest, saturating
  // the tyre and flipping vy's sign every single substep, forever.
  const flips = history.slice(1).filter((v, i) => v * history[i] < 0).length;
  assert.equal(flips, 0, `lateral velocity changed sign ${flips} times: ${history.slice(0, 6)}`);
  assert.ok(Math.abs(s.vy) < 0.002, `residual lateral creep ${s.vy}`);
});

test('aero drag is not clipped by the tyre friction circle', () => {
  // Drag acts on the body, so the same speed must give the same drag whatever
  // the tyres are standing on.
  const at = surface => {
    const s = step({ vx: 80, vy: 0, av: 0, axPrev: 0 },
      { throttle: 0, brake: false, steer: 0 }, { surface }, 1 / 240);
    return (s.vx - 80) * 240;
  };
  const tarmacDecel = at('tarmac');
  const grassDecel = at('grass');
  const expectedDrag = -0.5 * 1.225 * 80 * 80 * 1.55 / MASS;
  assert.ok(tarmacDecel < expectedDrag * 0.9,
    `tarmac deceleration ${tarmacDecel.toFixed(2)} does not even cover drag`);
  // Grass loses tyre-borne braking, but it must not lose drag.
  assert.ok(grassDecel < expectedDrag * 0.9,
    `grass deceleration ${grassDecel.toFixed(2)} lost its drag to the friction circle`);
});

test('downforce follows total speed, so a slide keeps its aero', () => {
  const straight = step({ vx: 60, vy: 0, av: 0, axPrev: 0 },
    { throttle: 0, brake: true, steer: 0 }, tarmac, 1 / 240);
  const sliding = step({ vx: 0.001, vy: 60, av: 0, axPrev: 0 },
    { throttle: 0, brake: false, steer: 0 }, tarmac, 1 / 240);
  // A car travelling 60 m/s sideways still has 60 m/s of dynamic pressure, so it
  // must still generate a large lateral tyre force from the loaded tyres.
  assert.ok(Math.abs(sliding.fy) > Math.abs(straight.fx) * 0.4,
    `sideways at 60 m/s produced only ${sliding.fy.toFixed(0)} N of lateral force`);
});

test('a drive demand the tyre cannot deliver does not cost cornering grip', () => {
  // 4° of rear slip at 30 m/s, once with no drive and once with the engine asking
  // for far more than the rear circle holds. The lateral force must not care.
  const slip = 4 * Math.PI / 180;
  const state = { vx: 30, vy: 30 * Math.tan(slip), av: 0, axPrev: 0 };
  const coasting = step(state, { throttle: 0, brake: false, steer: 0 }, tarmac, 1 / 240);
  const flatOut = step(state, { throttle: 1, brake: false, steer: 0 }, tarmac, 1 / 240);

  // Scaling both components together used to cut the lateral force by a third.
  const ratio = Math.abs(flatOut.fy) / Math.abs(coasting.fy);
  assert.ok(ratio > 0.9,
    `full throttle left only ${(ratio * 100).toFixed(0)}% of the cornering force`);
  // And the drive that does get through is bounded by the grip left over.
  assert.ok(flatOut.fx > 0 && flatOut.fx < ENGINE_FX_MAX,
    `drive force ${flatOut.fx.toFixed(0)} N ignored the traction limit`);
});

test('a launch is traction limited, not engine limited', () => {
  const s = step({ vx: 0.5, vy: 0, av: 0, axPrev: 0 },
    { throttle: 1, brake: false, steer: 0 }, tarmac, 1 / 240);
  const g = s.fx / MASS / 9.81;
  // 14 kN of engine on 800 kg would be 1.78 g, but the rear tyres carry 54% of
  // 800 kg at mu 1.6, so about 1 g is all that can reach the road from rest.
  assert.ok(g > 0.8 && g < 1.3, `launch acceleration ${g.toFixed(2)} g`);
});

test('cornering at the limit leaves no drive force at all', () => {
  // 12° of slip is the peak of the tyre curve: all of the grip is cornering.
  const s = step({ vx: 30, vy: 30 * Math.tan(12 * Math.PI / 180), av: 0, axPrev: 0 },
    { throttle: 1, brake: false, steer: 0 }, tarmac, 1 / 240);
  const rearOnlyDrive = Math.max(0, s.fx);
  assert.ok(rearOnlyDrive < 2000,
    `${rearOnlyDrive.toFixed(0)} N of drive at the cornering limit`);
});
