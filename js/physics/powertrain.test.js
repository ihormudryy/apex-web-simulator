import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  engineTorque, enginePower, IDLE_RPM, LIMITER_RPM, ICE_POWER_SCALE,
  ENGINE_DRAG_NM_AT_LIMITER, boostStep, SPOOL_UP,
  GEAR_RATIOS, FINAL_DRIVE, TOP_GEAR, REVERSE_RATIO, totalRatio,
  DRIVELINE_EFFICIENCY, SHIFT_TIME, SHIFT_UP_RPM, SHIFT_DOWN_RPM,
  createGearboxState, gearboxStep, engineRpm, clutchSlip, wheelTorque,
  MGUK_POWER, MGUK_TORQUE_LIMIT, BATTERY_CAPACITY, mgukTorque,
  createErsState, ersStep, socFraction, MODE_OFF, MODE_DEPLOY, MODE_HARVEST,
  brakeMu, C_DISC, createBrakeState, brakeThermalStep, brakeTemperature,
  brakeByWire, MIN_REGEN_SPEED,
  ERA_2022, ERA_2026,
} from './powertrain.js';
import { WHEEL_RADIUS } from './wheel.js';

const DT = 1 / 600;
const RPM_TO_RAD = 2 * Math.PI / 60;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

test('combined peak power lands on the ~735 kW reference figure', () => {
  let peak = 0;
  for (let rpm = 1000; rpm <= LIMITER_RPM; rpm += 25) {
    peak = Math.max(peak, enginePower(rpm, 1, 1));
  }
  const combined = peak + MGUK_POWER;
  assert.ok(
    Math.abs(combined - 735000) < 735000 * 0.05,
    `${(combined / 1000).toFixed(0)} kW combined, target 735`,
  );
});

test('the power peak is where a raced F1 engine puts it, not at the limiter', () => {
  let peak = 0;
  let at = 0;
  for (let rpm = 1000; rpm <= LIMITER_RPM; rpm += 25) {
    const p = enginePower(rpm, 1, 1);
    if (p > peak) { peak = p; at = rpm; }
  }
  assert.ok(at > 10500 && at < 13000, `power peaks at ${at} rpm`);
  assert.ok(at < LIMITER_RPM - 1500, 'a peak at the limiter means the curve is wrong');
});

test('the engine has a power band — torque falls away either side of the plateau', () => {
  const plateau = engineTorque(11000, 1, 1);
  assert.ok(engineTorque(5000, 1, 1) < plateau * 0.75, 'must be soft down low');
  assert.ok(engineTorque(15000 - 1, 1, 1) < plateau * 0.75, 'must fall off up top');
  assert.ok(engineTorque(12000, 1, 1) > plateau * 0.9, 'and the plateau must be broad');
});

test('the limiter cuts, which is what makes it audible', () => {
  assert.equal(engineTorque(LIMITER_RPM, 1, 1), 0);
  assert.ok(engineTorque(LIMITER_RPM - 100, 1, 1) > 0);
});

test('a closed throttle gives driveline drag, rising with rpm', () => {
  const low = engineTorque(5000, 0, 0);
  const high = engineTorque(13000, 0, 0);
  assert.ok(low < 0 && high < 0, 'off throttle must retard');
  assert.ok(high < low, 'and must retard harder at high rpm');
  assert.ok(Math.abs(high) <= ENGINE_DRAG_NM_AT_LIMITER);
});

test('part throttle interpolates between drag and full power', () => {
  const rpm = 11000;
  const half = engineTorque(rpm, 0.5, 1);
  assert.ok(half > engineTorque(rpm, 0, 1));
  assert.ok(half < engineTorque(rpm, 1, 1));
});

test('boost costs torque, but a modern turbo is not a hole', () => {
  const spooled = engineTorque(11000, 1, 1);
  const flat = engineTorque(11000, 1, 0);
  assert.ok(flat < spooled, 'no boost must cost torque');
  assert.ok(flat > spooled * 0.55, 'a 1.6 turbo still makes real torque off boost');
});

test('the turbo spools within a few tenths and bleeds off throttle', () => {
  const state = { boost: 0 };
  for (let i = 0; i < 600 * 0.6; i++) boostStep(state, 12000, 1, DT);
  assert.ok(state.boost > 0.85, `only ${state.boost.toFixed(2)} boost after 0.6 s`);
  for (let i = 0; i < 600 * 0.5; i++) boostStep(state, 12000, 0, DT);
  assert.ok(state.boost < 0.25, `boost held at ${state.boost.toFixed(2)} off throttle`);
});

test('boost builds slower at low rpm — there is less exhaust to work with', () => {
  const low = { boost: 0 };
  const high = { boost: 0 };
  for (let i = 0; i < 600 * 0.25; i++) {
    boostStep(low, 5000, 1, DT);
    boostStep(high, 12500, 1, DT);
  }
  assert.ok(low.boost < high.boost, `${low.boost.toFixed(3)} vs ${high.boost.toFixed(3)}`);
});

test('boost is stable and bounded at any step size', () => {
  for (const dt of [DT, 1 / 30, 1, 10]) {
    const state = { boost: 0 };
    for (let i = 0; i < 100; i++) boostStep(state, 12000, 1, dt);
    assert.ok(state.boost >= 0 && state.boost <= 1.0000001, `dt=${dt}: ${state.boost}`);
  }
});

// ---------------------------------------------------------------------------
// Transmission
// ---------------------------------------------------------------------------

test('there are eight forward ratios and they are monotonically taller', () => {
  assert.equal(GEAR_RATIOS.length, 8);
  for (let i = 1; i < GEAR_RATIOS.length; i++) {
    assert.ok(GEAR_RATIOS[i] < GEAR_RATIOS[i - 1], `gear ${i + 1} is not taller than ${i}`);
  }
});

test('gear steps close up towards the top, as a real box does', () => {
  const step = i => GEAR_RATIOS[i] / GEAR_RATIOS[i + 1];
  assert.ok(step(0) > step(6), 'first-to-second must be a bigger step than seventh-to-eighth');
});

test('top gear puts the drag-limited top speed near 330 km/h, not the limiter', () => {
  const kmh = rpm => (rpm * RPM_TO_RAD / totalRatio(TOP_GEAR)) * WHEEL_RADIUS * 3.6;
  assert.ok(kmh(12500) > 300 && kmh(12500) < 345, `${kmh(12500).toFixed(0)} km/h at 12500 rpm`);
  assert.ok(kmh(LIMITER_RPM) > 360, 'the limiter must not be what stops the car');
});

test('first gear is short enough to be traction-limited on the way out', () => {
  const crankNm = engineTorque(9000, 1, 1);
  const wheelN = crankNm * totalRatio(1) * DRIVELINE_EFFICIENCY / WHEEL_RADIUS;
  assert.ok(wheelN > 15000, `only ${wheelN.toFixed(0)} N at the contact patch in first`);
});

test('gear matters — the same crank torque gives very different thrust', () => {
  const first = wheelTorque(500, 1, false);
  const eighth = wheelTorque(500, 8, false);
  assert.ok(first > eighth * 2.5, `first ${first.toFixed(0)} vs eighth ${eighth.toFixed(0)} Nm`);
});

test('neutral transmits nothing and reverse transmits backwards', () => {
  assert.equal(totalRatio(0), 0);
  assert.equal(wheelTorque(500, 0, false), 0);
  assert.ok(totalRatio(-1) < 0);
  assert.ok(REVERSE_RATIO < 0);
});

test('the driveline loses a realistic slice, and only one slice', () => {
  assert.ok(DRIVELINE_EFFICIENCY > 0.88 && DRIVELINE_EFFICIENCY < 0.98);
  assert.ok(Math.abs(wheelTorque(100, 4, false) - 100 * totalRatio(4) * DRIVELINE_EFFICIENCY) < 1e-9);
});

test('rpm follows wheel speed through the ratio, not road speed directly', () => {
  const omega = 200;
  assert.ok(engineRpm(omega, 3) > engineRpm(omega, 6), 'a lower gear must spin the engine faster');
});

test('the clutch holds the engine at idle from rest, so the car can launch', () => {
  assert.equal(engineRpm(0, 1), IDLE_RPM);
  assert.equal(clutchSlip(0, 1), 1, 'a stationary car in gear is fully slipping');
  assert.equal(clutchSlip(300, 1), 0, 'and locked once it is rolling');
});

test('rpm is capped at the limiter rather than running away', () => {
  assert.equal(engineRpm(10000, 1), LIMITER_RPM);
});

test('the box upshifts near the power peak and holds through the shift', () => {
  const state = createGearboxState();
  // Wheel speed that puts first gear past the upshift point.
  const omega = SHIFT_UP_RPM * RPM_TO_RAD / totalRatio(1) + 5;
  gearboxStep(state, omega, 1, DT);
  assert.equal(state.gear, 2);
  assert.ok(state.shiftTimer > 0 && state.shifting);
  const before = state.gear;
  gearboxStep(state, omega * 4, 1, DT);
  assert.equal(state.gear, before, 'no shift may start while one is in progress');
});

test('a shift takes about 40 ms and cuts torque while it does', () => {
  assert.ok(SHIFT_TIME > 0.02 && SHIFT_TIME < 0.08, `${SHIFT_TIME * 1000} ms`);
  assert.equal(wheelTorque(500, 3, true), 0, 'a shift must cut the torque');
});

test('the box downshifts as the car slows', () => {
  const state = createGearboxState();
  state.gear = 5;
  const omega = SHIFT_DOWN_RPM * RPM_TO_RAD / totalRatio(5) - 1;
  gearboxStep(state, omega, 0, DT);
  assert.equal(state.gear, 4);
});

test('downshifts never leave the engine bouncing off the limiter', () => {
  const state = createGearboxState();
  state.gear = TOP_GEAR;
  // Brake from top speed all the way to a stop, one shift at a time.
  for (let v = 90; v > 1; v -= 0.05) {
    state.shiftTimer = 0;
    const omega = v / WHEEL_RADIUS;
    gearboxStep(state, omega, 0, DT);
    assert.ok(
      engineRpm(omega, state.gear) <= LIMITER_RPM,
      `gear ${state.gear} at ${(v * 3.6).toFixed(0)} km/h overspeeds the engine`,
    );
  }
  assert.equal(state.gear, 1, 'must end up in first');
});

test('it never shifts above top or below first', () => {
  const top = createGearboxState();
  top.gear = TOP_GEAR;
  gearboxStep(top, 1e5, 1, DT);
  assert.equal(top.gear, TOP_GEAR);

  const bottom = createGearboxState();
  gearboxStep(bottom, 0, 0, DT);
  assert.equal(bottom.gear, 1);
});

// ---------------------------------------------------------------------------
// ERS
// ---------------------------------------------------------------------------

test('MGU-K is torque-limited low down and power-limited up top', () => {
  const low = mgukTorque(BATTERY_CAPACITY, MODE_DEPLOY, IDLE_RPM);
  const high = mgukTorque(BATTERY_CAPACITY, MODE_DEPLOY, 13000);
  assert.ok(low <= MGUK_TORQUE_LIMIT + 1e-9, 'the inverter limit must bind low down');
  assert.ok(high < low, 'and constant power must taper it up top');
  const powerAtHigh = high * 13000 * RPM_TO_RAD;
  assert.ok(Math.abs(powerAtHigh - MGUK_POWER) < MGUK_POWER * 0.02);
});

test('electric torque fill is what makes the launch — it is there where boost is not', () => {
  const electric = mgukTorque(BATTERY_CAPACITY, MODE_DEPLOY, IDLE_RPM);
  const iceOffBoost = engineTorque(IDLE_RPM, 1, 0);
  assert.ok(electric > iceOffBoost * 0.4, `${electric.toFixed(0)} Nm of fill vs ${iceOffBoost.toFixed(0)} Nm of ICE`);
});

test('an empty store cannot deploy and a full one cannot harvest', () => {
  assert.equal(mgukTorque(0, MODE_DEPLOY, 11000), 0);
  assert.equal(mgukTorque(BATTERY_CAPACITY, MODE_HARVEST, 11000), 0);
  assert.equal(mgukTorque(BATTERY_CAPACITY, MODE_OFF, 11000), 0);
});

test('harvesting is a negative crank torque', () => {
  assert.ok(mgukTorque(0, MODE_HARVEST, 11000) < 0);
});

test('the store is 4 MJ and deployment drains it in a realistic time', () => {
  assert.equal(BATTERY_CAPACITY, 4e6);
  const ers = createErsState(BATTERY_CAPACITY);
  let t = 0;
  while (ers.soc > 0 && t < 120) {
    ersStep(ers, mgukTorque(ers.soc, MODE_DEPLOY, 11000), 11000, DT);
    t += DT;
  }
  // 4 MJ at 120 kW is 33 s of flat-out deployment, less the round-trip loss.
  assert.ok(t > 25 && t < 40, `store emptied in ${t.toFixed(1)} s`);
});

test('harvesting refills the store, and you get back less than you threw away', () => {
  const ers = createErsState(0);
  for (let i = 0; i < 600 * 5; i++) ersStep(ers, -100, 11000, DT);
  assert.ok(ers.soc > 0, 'braking must recharge');
  const mechanical = 100 * 11000 * RPM_TO_RAD * 5;
  assert.ok(ers.soc < mechanical, 'round-trip efficiency must cost something');
});

test('the store never goes negative or past capacity', () => {
  const empty = createErsState(0);
  for (let i = 0; i < 6000; i++) ersStep(empty, 500, 11000, DT);
  assert.ok(empty.soc >= 0);

  const full = createErsState(BATTERY_CAPACITY);
  for (let i = 0; i < 6000; i++) ersStep(full, -500, 11000, DT);
  assert.ok(full.soc <= BATTERY_CAPACITY);
});

test('socFraction reports 0 to 1', () => {
  assert.equal(socFraction(createErsState(0)), 0);
  assert.equal(socFraction(createErsState(BATTERY_CAPACITY)), 1);
});

// ---------------------------------------------------------------------------
// Brakes
// ---------------------------------------------------------------------------

test('carbon brakes are genuinely poor cold', () => {
  assert.ok(brakeMu(50) < 0.2, `mu ${brakeMu(50)} at 50C is not cold carbon`);
  assert.ok(brakeMu(200) < brakeMu(400) * 0.5, 'under 250C must be a real handicap');
});

test('the optimum is a broad plateau from 400 to 800 C', () => {
  const plateau = [400, 500, 600, 700, 800].map(brakeMu);
  for (const mu of plateau) assert.ok(mu > 0.55, `mu ${mu} inside the window`);
  assert.ok(Math.max(...plateau) - Math.min(...plateau) < 0.08, 'and must be flat');
});

test('brakes fade above 1000 C', () => {
  assert.ok(brakeMu(1100) < brakeMu(700) * 0.75);
  assert.ok(brakeMu(1300) < brakeMu(1100));
});

test('a 300 km/h stop takes a warm front disc to the edge of fade', () => {
  const state = createBrakeState(400);
  // 3.35 s at ~940 kW into one front disc, which is what the reference stop costs.
  for (let i = 0; i < 600 * 3.35; i++) brakeThermalStep(state, 0, 940000, 60, DT);
  const t = brakeTemperature(state, 0);
  assert.ok(t > 800 && t < 1200, `disc reached ${t.toFixed(0)}C — expected the fade region`);
});

test('brake temperature is capped by radiation rather than running away', () => {
  const state = createBrakeState(400);
  for (let i = 0; i < 600 * 60; i++) brakeThermalStep(state, 400000, 70, DT);
  assert.ok(
    Number.isFinite(state.discT[0]) && state.discT[0] < 2000,
    `a minute of braking gave ${state.discT[0]}C`,
  );
});

test('brakes cool down, faster at speed', () => {
  const still = createBrakeState(800);
  const moving = createBrakeState(800);
  for (let i = 0; i < 600 * 10; i++) {
    brakeThermalStep(still, 0, 0, 0, DT);
    brakeThermalStep(moving, 0, 0, 80, DT);
  }
  assert.ok(moving.discT[0] < still.discT[0], 'airflow must help');
  assert.ok(still.discT[0] < 800, 'and radiation alone must still cool it');
});

test('a disc never cools below ambient', () => {
  const state = createBrakeState(40);
  for (let i = 0; i < 60000; i++) brakeThermalStep(state, 0, 0, 90, DT, 30);
  assert.ok(state.discT[0] >= 30);
});

test('the four corners are tracked separately', () => {
  const state = createBrakeState(300);
  brakeThermalStep(state, 0, 500000, 70, DT);
  assert.ok(state.discT[0] > state.discT[1], 'heating one corner must not heat the others');
});

test('the brake thermal step is stable at frame-sized dt', () => {
  for (const dt of [DT, 1 / 60, 1 / 20, 0.5]) {
    const state = createBrakeState(400);
    for (let i = 0; i < 200; i++) brakeThermalStep(state, 0, 900000, 60, dt);
    assert.ok(Number.isFinite(state.discT[0]) && state.discT[0] < 5000, `dt=${dt}`);
  }
});

// ---------------------------------------------------------------------------
// Brake-by-wire
// ---------------------------------------------------------------------------

test('rear braking is shared between regeneration and friction', () => {
  const out = { regen: 0, friction: 0 };
  brakeByWire(3000, 1e6, 11000, 6, 80, out);
  assert.ok(out.regen > 0 && out.friction > 0, 'both paths must contribute');
  assert.ok(Math.abs(out.regen + out.friction - 3000) < 1e-6, 'and must sum to the demand');
});

test('brake balance shifts rearward as the battery fills — the era characteristic', () => {
  const empty = { regen: 0, friction: 0 };
  const full = { regen: 0, friction: 0 };
  brakeByWire(3000, 0, 11000, 6, 80, empty);
  brakeByWire(3000, BATTERY_CAPACITY, 11000, 6, 80, full);
  assert.ok(empty.regen > 0, 'an empty store must harvest');
  assert.equal(full.regen, 0, 'a full one cannot');
  assert.ok(full.friction > empty.friction, 'so friction must take up the slack');
});

test('the split always sums to the demand, whatever the state', () => {
  const out = { regen: 0, friction: 0 };
  for (const soc of [0, 1e6, 3e6, BATTERY_CAPACITY]) {
    for (const v of [0, 3, 20, 90]) {
      for (const demand of [0, 500, 5000]) {
        brakeByWire(demand, soc, 11000, 6, v, out);
        assert.ok(
          Math.abs(out.regen + out.friction - demand) < 1e-6,
          `soc=${soc} v=${v} demand=${demand} gave ${out.regen}+${out.friction}`,
        );
        assert.ok(out.regen >= 0 && out.friction >= 0);
      }
    }
  }
});

test('there is nothing to harvest at walking pace', () => {
  const out = { regen: 0, friction: 0 };
  brakeByWire(3000, 0, 5000, 1, MIN_REGEN_SPEED - 1, out);
  assert.equal(out.regen, 0);
  assert.equal(out.friction, 3000);
});

// ---------------------------------------------------------------------------
// Era config
// ---------------------------------------------------------------------------

test('2026 is a config, not a fork: more electric, less ICE, active aero', () => {
  assert.ok(ERA_2026.mgukPower > ERA_2022.mgukPower * 2.5, '350 kW vs 120');
  assert.ok(ERA_2026.icePowerScale < ERA_2022.icePowerScale, 'and less ICE');
  assert.equal(ERA_2026.activeAero, true);
  assert.equal(ERA_2022.activeAero, false);
});

test('the 2026 split is near 50/50', () => {
  let icePeak = 0;
  for (let rpm = 1000; rpm <= LIMITER_RPM; rpm += 25) {
    icePeak = Math.max(icePeak, enginePower(rpm, 1, 1));
  }
  const ice2026 = icePeak * (ERA_2026.icePowerScale / ICE_POWER_SCALE);
  const share = ERA_2026.mgukPower / (ice2026 + ERA_2026.mgukPower);
  assert.ok(share > 0.4 && share < 0.6, `electric share ${(share * 100).toFixed(0)}%`);
});
