import {
  engineVoice, engineOrderSpectrum, MAX_ORDER,
  SLEW_UP_RPM_S, SLEW_DOWN_RPM_S, SLEW_SHIFT_RPM_S,
  SHIFT_WINDOW_S, SHIFT_DIP_GAIN, SHIFT_DIP_S, WASTEGATE_S,
} from './engineTone.js';
import { IDLE_RPM, REDLINE_RPM, rpmFor, advanceGear } from '../dash/gearbox.js';
import { loudestScrub, kerbVoice, plankVoice } from './tyreAudio.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const FREQ_TAU = 0.03;
const GAIN_TAU = 0.08;

function setTarget(param, value, time, tau = GAIN_TAU) {
  param.setTargetAtTime(Math.max(0, value), time, tau);
}

function makeNoiseBuffer(ctx, seconds = 1.5) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/**
 * Web Audio voice for the 2010-spec V8. Unlock from a user gesture.
 *
 * The tone comes from two detuned oscillators sharing one PeriodicWave that
 * carries the whole engine-order spectrum at half-order resolution (the
 * oscillator runs at rpm/120, so harmonic k is order k/2). Everything the ear
 * reads as "engine" — firing scream, growl between the orders, mechanical hash —
 * is in that wave; the previous triangle-plus-two-sines voice could only hum.
 */
export class EngineAudio {
  constructor() {
    this._ctx = null;
    this._voice = null;
    this._muted = false;
    this._gear = 1;
    this._rpm = IDLE_RPM;
    this._lastT = null;
    this._shiftUntil = -1;
    this._dipUntil = -1;
    this._nextPopT = 0;
    this._lastThrottle = 0;
    this._liftOff = 0;
    this._popCount = 0;          // observability for the browser checks
  }

  /**
   * @param {BaseAudioContext} [providedCtx] injected for offline rendering in
   *   tests; without it a live AudioContext is created on the first gesture.
   */
  unlock(providedCtx = null) {
    if (this._ctx) {
      if (this._ctx.state === 'suspended') this._ctx.resume();
      return;
    }
    const Ctx = providedCtx ? null : (window.AudioContext || window.webkitAudioContext);
    if (!providedCtx && !Ctx) return;
    const ctx = providedCtx || new Ctx();
    this._ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = 0;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 4200;
    lowpass.Q.value = 0.55;
    // A fixed exhaust-pipe resonance so the voice has a body, not just a pitch.
    const formant = ctx.createBiquadFilter();
    formant.type = 'peaking';
    formant.frequency.value = 560;
    formant.Q.value = 0.8;
    formant.gain.value = 5;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -22;
    compressor.knee.value = 18;
    compressor.ratio.value = 2.4;
    compressor.attack.value = 0.008;
    compressor.release.value = 0.18;
    master.connect(formant);
    formant.connect(lowpass);
    lowpass.connect(compressor);
    compressor.connect(ctx.destination);

    // The order spectrum, baked once into a shared wave (sine phases).
    const mags = engineOrderSpectrum();
    const bins = 2 * MAX_ORDER + 1;
    const real = new Float32Array(bins);
    const imag = new Float32Array(bins);
    for (let k = 1; k < bins; k++) imag[k] = mags[k];
    const wave = ctx.createPeriodicWave(real, imag);

    const makeVoice = detune => {
      const o = ctx.createOscillator();
      o.setPeriodicWave(wave);
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g);
      g.connect(master);
      o.start();
      return { osc: o, gain: g };
    };
    // Two copies a few cents apart: the slow beat between them is exhaust rasp.
    const voiceA = makeVoice(-5);
    const voiceB = makeVoice(+5);

    const noise = ctx.createBufferSource();
    noise.buffer = makeNoiseBuffer(ctx);
    noise.loop = true;

    // Exhaust roar: broad band riding just above the firing series.
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 900;
    band.Q.value = 0.55;
    const exhaustGain = ctx.createGain();
    exhaustGain.gain.value = 0;
    noise.connect(band);
    band.connect(exhaustGain);
    exhaustGain.connect(master);

    // Intake hiss: high, dry, load-dependent.
    const intakeFilter = ctx.createBiquadFilter();
    intakeFilter.type = 'highpass';
    intakeFilter.frequency.value = 3000;
    const intakeGain = ctx.createGain();
    intakeGain.gain.value = 0;
    noise.connect(intakeFilter);
    intakeFilter.connect(intakeGain);
    intakeGain.connect(master);

    // Overrun crackle: the same noise, but released as discrete scheduled pops —
    // a steady gain here is hiss, which is what the old voice got wrong.
    const crackleFilter = ctx.createBiquadFilter();
    crackleFilter.type = 'highpass';
    crackleFilter.frequency.value = 2200;
    const crackleGain = ctx.createGain();
    crackleGain.gain.value = 0;
    noise.connect(crackleFilter);
    crackleFilter.connect(crackleGain);
    crackleGain.connect(master);

    // --- turbo and MGU-K ---------------------------------------------------
    // Two tones, because that is what they are: a compressor at 100 000 rpm and an
    // inverter switching at a fixed multiple of shaft speed. Both bypass the
    // engine lowpass — they are not exhaust, and filtering them with it takes the
    // whine off the top of the note, which is the part that says "turbo era".
    const makeWhine = (type, q) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 2000;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 2000;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(f);
      f.connect(g);
      g.connect(master);
      o.start();
      return { osc: o, filter: f, gain: g };
    };
    const turbo = makeWhine('sawtooth', 3.5);
    const mguk = makeWhine('triangle', 8);

    // Wastegate flutter on a lift: filtered noise, not a tone.
    const wastegateFilter = ctx.createBiquadFilter();
    wastegateFilter.type = 'bandpass';
    wastegateFilter.frequency.value = 2600;
    wastegateFilter.Q.value = 1.2;
    const wastegateGain = ctx.createGain();
    wastegateGain.gain.value = 0;
    noise.connect(wastegateFilter);
    wastegateFilter.connect(wastegateGain);
    wastegateGain.connect(master);

    // --- tyres, kerbs and the plank ---------------------------------------
    // These go to their own bus, not through the engine chain: the engine lowpass
    // exists to dull the exhaust with load, and a tyre squeal has no reason to get
    // quieter when the driver lifts.
    const surfaceBus = ctx.createGain();
    surfaceBus.gain.value = 1;
    surfaceBus.connect(ctx.destination);

    // Scrub: a resonant tone for the squeal plus broadband for the slide, which is
    // the split `tyreAudio.scrubVoice` reports.
    const scrubTone = ctx.createBiquadFilter();
    scrubTone.type = 'bandpass';
    scrubTone.frequency.value = 700;
    scrubTone.Q.value = 7;
    const scrubToneGain = ctx.createGain();
    scrubToneGain.gain.value = 0;
    noise.connect(scrubTone);
    scrubTone.connect(scrubToneGain);
    scrubToneGain.connect(surfaceBus);

    const scrubNoiseFilter = ctx.createBiquadFilter();
    scrubNoiseFilter.type = 'bandpass';
    scrubNoiseFilter.frequency.value = 900;
    scrubNoiseFilter.Q.value = 0.7;
    const scrubNoiseGain = ctx.createGain();
    scrubNoiseGain.gain.value = 0;
    noise.connect(scrubNoiseFilter);
    scrubNoiseFilter.connect(scrubNoiseGain);
    scrubNoiseGain.connect(surfaceBus);

    // Kerb rattle: amplitude-modulated noise at the rib passing frequency, which
    // is a real frequency rather than a chosen one.
    const kerbFilter = ctx.createBiquadFilter();
    kerbFilter.type = 'bandpass';
    kerbFilter.frequency.value = 160;
    kerbFilter.Q.value = 1.1;
    const kerbGain = ctx.createGain();
    kerbGain.gain.value = 0;
    const kerbLfo = ctx.createOscillator();
    kerbLfo.type = 'square';
    kerbLfo.frequency.value = 20;
    const kerbLfoDepth = ctx.createGain();
    kerbLfoDepth.gain.value = 0;
    kerbLfo.connect(kerbLfoDepth);
    kerbLfoDepth.connect(kerbGain.gain);
    kerbLfo.start();
    noise.connect(kerbFilter);
    kerbFilter.connect(kerbGain);
    kerbGain.connect(surfaceBus);

    // Plank grind: bright, harsh, and keyed to the same contact force as the sparks.
    const plankFilter = ctx.createBiquadFilter();
    plankFilter.type = 'bandpass';
    plankFilter.frequency.value = 2600;
    plankFilter.Q.value = 0.9;
    const plankGain = ctx.createGain();
    plankGain.gain.value = 0;
    noise.connect(plankFilter);
    plankFilter.connect(plankGain);
    plankGain.connect(surfaceBus);

    noise.start();

    this._voice = {
      master, lowpass, voiceA, voiceB, band, exhaustGain, intakeGain, crackleGain,
      turbo, mguk, wastegateGain,
      surfaceBus, scrubTone, scrubToneGain, scrubNoiseFilter, scrubNoiseGain,
      kerbFilter, kerbGain, kerbLfo, kerbLfoDepth, plankFilter, plankGain,
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && this._ctx?.state === 'running') this._ctx.suspend();
        else if (!document.hidden && this._ctx?.state === 'suspended' && !this._muted) {
          this._ctx.resume();
        }
      });
    }
  }

  update(snap) {
    if (!this._voice || this._muted || !this._ctx) return;
    const t = this._ctx.currentTime;
    const dt = this._lastT == null ? 1 / 60 : Math.min(0.05, Math.max(0.001, t - this._lastT));
    this._lastT = t;

    const prevGear = this._gear;
    // The real gear, from the driveline. Deriving it from road speed here meant
    // the engine note was a function of how fast the scenery was moving — it could
    // not hear a shift, a clutch slip, or the rears spinning up.
    this._gear = typeof snap.gear === 'number'
      ? snap.gear
      : advanceGear(this._gear, snap.speedMs, { throttle: snap.throttle });
    if (this._gear !== prevGear) this._beginShift(t, this._gear > prevGear);

    // A shift is a mechanical event: the revs must move in tens of milliseconds,
    // not glide. Outside the shift window, pulls and coasts use gentler rates.
    const targetRpm = Number.isFinite(snap.rpm)
      ? snap.rpm
      : rpmFor(snap.speedMs, this._gear);
    const shifting = t < this._shiftUntil;
    const rate = shifting ? SLEW_SHIFT_RPM_S
      : (targetRpm > this._rpm ? SLEW_UP_RPM_S : SLEW_DOWN_RPM_S);
    if (targetRpm > this._rpm) this._rpm = Math.min(targetRpm, this._rpm + rate * dt);
    else this._rpm = Math.max(targetRpm, this._rpm - rate * dt);

    // Lift-off detection for the wastegate: a sharp drop in throttle, not a low
    // throttle position — rolling off slowly does not dump the boost.
    const throttle = snap.throttle ?? 0;
    const liftOff = clamp((this._lastThrottle - throttle) / Math.max(dt, 1e-3) / 8, 0, 1);
    this._lastThrottle = throttle;
    this._liftOff = Math.max(liftOff, this._liftOff * Math.exp(-dt / WASTEGATE_S));

    const v = engineVoice({
      rpm: this._rpm,
      throttle,
      brake: snap.brake,
      idleRpm: IDLE_RPM,
      redlineRpm: REDLINE_RPM,
      boost: snap.boost ?? 0,
      // Deploying or harvesting either way makes the inverter whine.
      ers: snap.ersActive ?? (throttle > 0.5 ? 1 : (snap.brake ? 0.7 : 0)),
      liftOff: this._liftOff,
    });

    // Lumpy idle: a deterministic wobble on the audible revs, fading with rpm.
    const heardRpm = this._rpm + Math.sin(t * 2 * Math.PI * v.wobbleHz) * v.wobbleRpm;
    const waveHz = Math.max(0, heardRpm) / 120;

    const {
      master, lowpass, voiceA, voiceB, band, exhaustGain, intakeGain, crackleGain,
      turbo, mguk, wastegateGain,
    } = this._voice;
    setTarget(voiceA.osc.frequency, waveHz, t, FREQ_TAU);
    setTarget(voiceB.osc.frequency, waveHz, t, FREQ_TAU);
    setTarget(voiceA.gain.gain, v.voiceGain, t);
    setTarget(voiceB.gain.gain, v.voiceGain, t);
    setTarget(band.frequency, v.bandHz, t, FREQ_TAU);
    setTarget(lowpass.frequency, v.lowpassHz, t, FREQ_TAU);
    setTarget(exhaustGain.gain, v.noiseExhaust, t);
    setTarget(intakeGain.gain, v.noiseIntake, t);
    // During the shift dip the ramps own the master gain; a same-tick setTarget
    // alongside them is spec-ambiguous and can swallow the dip.
    if (t >= this._dipUntil) setTarget(master.gain, v.master, t);

    // Turbo, MGU-K and wastegate.
    setTarget(turbo.osc.frequency, v.turboHz, t, FREQ_TAU);
    setTarget(turbo.filter.frequency, v.turboHz, t, FREQ_TAU);
    setTarget(turbo.gain.gain, v.turboGain, t);
    setTarget(mguk.osc.frequency, v.mgukHz, t, FREQ_TAU);
    setTarget(mguk.filter.frequency, v.mgukHz, t, FREQ_TAU);
    setTarget(mguk.gain.gain, v.mgukGain, t);
    setTarget(wastegateGain.gain, v.wastegateGain, t);

    this._updateSurface(snap, t);
    this._scheduleCrackle(t, v, crackleGain);
  }

  /**
   * Tyres, kerbs and the plank.
   *
   * The plan's honest limitation is that real force feedback is not available in
   * the browser, so grip communication has to move into the channels that do work
   * — and this is the loudest of them. Every input is a quantity the tyre model
   * already computes, which is what makes it worth listening to: the scrub rises
   * because the tyre is sliding, not because a key was pressed.
   */
  _updateSurface(snap, t) {
    const {
      scrubTone, scrubToneGain, scrubNoiseFilter, scrubNoiseGain,
      kerbFilter, kerbGain, kerbLfo, kerbLfoDepth, plankFilter, plankGain,
    } = this._voice;

    const slip = snap.slipSpeed;
    const load = snap.wheelLoad;
    if (slip && load) {
      const mus = this._mus ??= [1.85, 1.85, 1.85, 1.85];
      const mu = snap.surface === 'grass' ? 0.4 : snap.surface === 'kerb' ? 1.35 : 1.85;
      for (let i = 0; i < 4; i++) mus[i] = mu;
      const scrub = loudestScrub(slip, load, mus, this._scrub ??= {});
      setTarget(scrubTone.frequency, scrub.hz, t, FREQ_TAU);
      setTarget(scrubNoiseFilter.frequency, scrub.hz * 1.4, t, FREQ_TAU);
      setTarget(scrubToneGain.gain, scrub.squeal * 0.5, t);
      setTarget(scrubNoiseGain.gain, scrub.noise * 0.22, t);
    }

    const kerb = kerbVoice(snap.surface === 'kerb', snap.speedMs ?? 0,
      load ? Math.max(...load) : 0);
    setTarget(kerbLfo.frequency, Math.max(4, kerb.hz), t, FREQ_TAU);
    setTarget(kerbLfoDepth.gain, kerb.gain * 0.25, t);
    setTarget(kerbGain.gain, kerb.gain * 0.28, t);
    void kerbFilter;

    // The plank penetration is the negative part of the ride height, which is the
    // same quantity the spark emitter uses.
    const depth = Math.max(0, -(snap.rideFront ?? 1), -(snap.rideRear ?? 1));
    const plank = plankVoice(depth * 8e6, snap.speedMs ?? 0);
    setTarget(plankFilter.frequency, plank.hz, t, FREQ_TAU);
    setTarget(plankGain.gain, plank.gain * 0.3, t);
  }

  /** Torque-cut dip and, on upshifts, a bark: the gearbox event you hear. */
  _beginShift(t, isUpshift) {
    this._shiftUntil = t + SHIFT_WINDOW_S;
    this._dipUntil = t + SHIFT_DIP_S;
    const { master, crackleGain } = this._voice;
    const g = master.gain;
    g.cancelScheduledValues(t);
    // Down fast, back up over the dip time; setTarget afterwards resumes control.
    g.setValueAtTime(Math.max(1e-4, g.value), t);
    g.linearRampToValueAtTime(Math.max(1e-4, g.value * SHIFT_DIP_GAIN), t + 0.02);
    g.linearRampToValueAtTime(Math.max(1e-4, g.value), t + SHIFT_DIP_S);
    if (isUpshift) this._pop(crackleGain, t + 0.01, 0.16, 0.03);
  }

  /** Discrete pops, not a steady gain: crackle is impulsive by definition. */
  _scheduleCrackle(t, v, crackleGain) {
    if (v.crackleRate <= 0) {
      this._nextPopT = t;
      return;
    }
    if (t < this._nextPopT) return;
    this._pop(crackleGain, t, v.cracklePop * (0.6 + Math.random() * 0.8), 0.02 + Math.random() * 0.025);
    const mean = 1 / v.crackleRate;
    this._nextPopT = t + mean * (0.4 + Math.random() * 1.2);
  }

  _pop(gainNode, t, amplitude, decay) {
    const g = gainNode.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(amplitude, t);
    g.exponentialRampToValueAtTime(1e-3, t + decay);
    g.setValueAtTime(0, t + decay + 0.001);
    this._popCount++;
  }
}
