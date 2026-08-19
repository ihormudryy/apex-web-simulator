// The instrument cluster along the bottom of the screen.
//
// A view and nothing more: it takes a telemetry snapshot and draws it. It knows
// nothing about the car, the physics, or the track — swap the sampler and this
// keeps working.
//
// It runs on every frame, so the update path is deliberately cheap: nodes are
// cached, text is only written when it changes, bars move with `scaleX` so there
// is no layout, and the circuit outline is stroked once into an offscreen canvas
// and blitted after that.

import { fitPath } from './minimap.js';
import { formatLapTime, formatDelta, formatSector } from './telemetry.js';
import { DASH_CSS } from './dashboard.css.js';

const MAP_WIDTH = 108;
const MAP_HEIGHT = 80;
const G_SIZE = 82;
/** Readouts refresh at this rate. Text changing 60 times a second is unreadable. */
const TEXT_HZ = 20;
/** Seconds of g-force history in the trail. */
const TRAIL_SECONDS = 1.5;
const TRAIL_HZ = 60;
const SHIFT_LEDS = 10;

const COLOUR = {
  ice: '#e9eff8',
  slate: '#7b8798',
  edge: 'rgba(150, 170, 200, 0.18)',
  purple: '#b14bff',
  green: '#35e06b',
  amber: '#ffb020',
  red: '#e8202a',
  blue: '#35b6ff',
};

export class Dashboard {
  /**
   * @param {HTMLElement} container element to mount into.
   * @param {{samples: Array<{x:number,z:number}>}} track for the circuit outline.
   * @param {object} [options]
   * @param {string} [options.circuitName] shown under the map.
   */
  constructor(container, track, { circuitName = 'Circuit' } = {}) {
    this.visible = true;
    this._lastText = new Map();
    this._textAccumulator = 0;
    this._trail = [];
    this._trailAccumulator = 0;
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);

    injectStyleOnce();

    this.root = el('div', 'dash');
    // A readout that updates 20 times a second is hostile to a screen reader, and
    // the canvas is the real content here.
    this.root.setAttribute('aria-hidden', 'true');

    this.root.append(
      this._buildCircuit(track, circuitName),
      this._buildInputs(),
      this._buildSpeed(),
      this._buildTraction(),
      this._buildTiming(),
    );

    const hint = el('div', 'dash__hint');
    hint.textContent = 'H hides';
    this.root.append(hint);

    container.appendChild(this.root);
  }

  toggle() {
    this.visible = !this.visible;
    this.root.classList.toggle('dash--off', !this.visible);
  }

  /**
   * @param {object} snapshot from `telemetry.sample`
   * @param {number} dt seconds since the last frame
   */
  update(snapshot, dt) {
    if (!this.visible) return;

    this._pushTrail(snapshot, dt);
    // Canvases carry the fast-moving values, so they redraw every frame.
    this._drawMap(snapshot);
    this._drawG(snapshot);
    this._setBars(snapshot);
    this._setLights(snapshot);

    this._textAccumulator += dt;
    if (this._textAccumulator < 1 / TEXT_HZ) return;
    this._textAccumulator = 0;
    this._setText(snapshot);
  }

  // ---- construction -------------------------------------------------------

  _buildCircuit(track, circuitName) {
    const panel = el('div', 'dash__panel dash__panel--compact');
    panel.append(label(circuitName));

    this.mapCanvas = canvas(MAP_WIDTH, MAP_HEIGHT, this._dpr);
    panel.append(this.mapCanvas);

    // The outline never moves, so stroke it once and blit it from then on.
    this.mapFit = fitPath(track.samples, {
      width: MAP_WIDTH, height: MAP_HEIGHT, padding: 7,
    });
    this.mapBase = document.createElement('canvas');
    this.mapBase.width = MAP_WIDTH * this._dpr;
    this.mapBase.height = MAP_HEIGHT * this._dpr;
    const base = this.mapBase.getContext('2d');
    base.scale(this._dpr, this._dpr);
    base.strokeStyle = 'rgba(190, 210, 240, 0.30)';
    base.lineWidth = 3.2;
    base.lineJoin = 'round';
    strokeRing(base, this.mapFit.points);
    base.strokeStyle = 'rgba(12, 15, 20, 0.9)';
    base.lineWidth = 1.1;
    strokeRing(base, this.mapFit.points);

    const foot = el('div', 'dash__mapfoot');
    this.sectorLabel = span('SECTOR 1');
    this.surfaceLabel = span('TARMAC', 'dash__surface');
    foot.append(this.sectorLabel, this.surfaceLabel);
    panel.append(foot);
    return panel;
  }

  _buildInputs() {
    const panel = el('div', 'dash__panel dash__panel--optional');
    panel.append(label('Driver input'));
    this.throttleBar = this._meter(panel, 'Throttle', 'dash__fill--throttle');
    this.brakeBar = this._meter(panel, 'Brake', 'dash__fill--brake');
    this.steerBar = this._meter(panel, 'Steering', 'dash__fill--steer', true);
    return panel;
  }

  _meter(panel, name, fillClass, centred = false) {
    const wrap = el('div', 'dash__meter');
    const head = el('div', 'dash__meter-head');
    const value = span('0', 'dash__meter-value');
    head.append(span(name), value);
    const track = el('div', 'dash__track');
    const fill = el('div', `dash__fill ${fillClass}`);
    track.append(fill);
    if (centred) track.append(el('div', 'dash__centre-tick'));
    wrap.append(head, track);
    panel.append(wrap);
    return { fill, value };
  }

  _buildSpeed() {
    const panel = el('div', 'dash__panel dash__panel--centre');

    this.leds = [];
    const lights = el('div', 'dash__lights');
    for (let i = 0; i < SHIFT_LEDS; i++) {
      const led = el('div', 'dash__led');
      lights.append(led);
      this.leds.push(led);
    }
    panel.append(lights);

    const row = el('div', 'dash__speed-row');

    const speedCol = el('div', 'dash__stack');
    this.speedValue = el('div', 'dash__speed');
    this.speedValue.textContent = '0';
    speedCol.append(this.speedValue, unitLabel('km/h'));

    const gearCol = el('div', 'dash__stack dash__stack--gear');
    this.gearValue = el('div', 'dash__gear');
    this.gearValue.textContent = '1';
    gearCol.append(this.gearValue, unitLabel('gear'));

    row.append(speedCol, gearCol);
    panel.append(row);

    this.rpmValue = el('div', 'dash__rpm');
    this.rpmValue.innerHTML = '<strong>0</strong> rpm';
    this.rpmNumber = this.rpmValue.querySelector('strong');
    panel.append(this.rpmValue);
    return panel;
  }

  _buildTraction() {
    const panel = el('div', 'dash__panel dash__panel--optional');
    panel.append(label('Grip'));
    this.gCanvas = canvas(G_SIZE, G_SIZE, this._dpr, 'dash__gmeter');
    panel.append(this.gCanvas);

    const foot = el('div', 'dash__gfoot');
    this.gValue = span('');
    this.slipValue = span('');
    this.gValue.innerHTML = 'G <b>0.00</b>';
    this.slipValue.innerHTML = 'Slip <b>0&deg;</b>';
    foot.append(this.gValue, this.slipValue);
    this.gNumber = this.gValue.querySelector('b');
    this.slipNumber = this.slipValue.querySelector('b');
    panel.append(foot);
    return panel;
  }

  _buildTiming() {
    const panel = el('div', 'dash__panel');
    panel.append(label('Lap'));

    this.lapValue = el('div', 'dash__time');
    this.lapValue.textContent = formatLapTime(0);
    panel.append(this.lapValue);

    // Labelled fields, so an empty delta reads as "no reference yet" rather than
    // as a row of stray dashes.
    this.deltaValue = span(formatDelta(null), 'dash__delta dash__delta--none');
    panel.append(field('Delta', this.deltaValue));

    panel.append(el('div', 'dash__spacer'), el('div', 'dash__rule'));

    this.bestValue = span(formatLapTime(null), 'dash__best');
    panel.append(field('Best', this.bestValue));

    this.sectorBars = [];
    const bars = el('div', 'dash__sectors');
    for (let i = 0; i < 3; i++) {
      const bar = el('div', 'dash__sector');
      bars.append(bar);
      this.sectorBars.push(bar);
    }
    panel.append(bars);

    const meta = el('div', 'dash__meta');
    this.lapCountLabel = span('LAP 1');
    this.splitLabel = span('--.---');
    meta.append(this.lapCountLabel, this.splitLabel);
    panel.append(meta);
    return panel;
  }

  // ---- per-frame ----------------------------------------------------------

  _pushTrail(snapshot, dt) {
    this._trailAccumulator += dt;
    if (this._trailAccumulator < 1 / TRAIL_HZ) return;
    this._trailAccumulator = 0;
    this._trail.push({ lat: snapshot.latG, long: snapshot.longG });
    const cap = Math.round(TRAIL_SECONDS * TRAIL_HZ);
    while (this._trail.length > cap) this._trail.shift();
  }

  _setBars({ throttle, brake, steer }) {
    this.throttleBar.fill.style.transform = `scaleX(${clamp01(throttle)})`;
    this.brakeBar.fill.style.transform = `scaleX(${clamp01(brake)})`;
    // Grows out of the centre tick: negative is left, so flip the origin.
    const s = Math.max(-1, Math.min(1, steer));
    this.steerBar.fill.style.transformOrigin = s < 0 ? 'right center' : 'left center';
    this.steerBar.fill.style.left = s < 0 ? '0' : '50%';
    this.steerBar.fill.style.transform = `scaleX(${Math.abs(s)})`;
  }

  _setLights({ shift }) {
    const lit = Math.round(shift * SHIFT_LEDS);
    for (let i = 0; i < SHIFT_LEDS; i++) {
      const on = i < lit;
      const led = this.leds[i];
      if (led._on === on && led._lit === lit) continue;
      led._on = on;
      led._lit = lit;
      led.classList.toggle('dash__led--on', on);
      // Green through amber to red, then the whole row goes blue: change up.
      led.style.background = on
        ? (lit >= SHIFT_LEDS ? COLOUR.blue
          : i < 4 ? COLOUR.green : i < 7 ? COLOUR.amber : COLOUR.red)
        : '';
    }
  }

  _setText(s) {
    this._text(this.speedValue, String(Math.round(s.speedKmh)));
    this._text(this.gearValue, String(s.gear));
    this._text(this.rpmNumber, String(Math.round(s.rpm / 10) * 10));

    this._text(this.throttleBar.value, `${Math.round(s.throttle * 100)}%`);
    this._text(this.brakeBar.value, `${Math.round(s.brake * 100)}%`);
    this._text(this.steerBar.value, `${Math.round(Math.abs(s.steer) * 100)}%`);

    this._text(this.gNumber, s.combinedG.toFixed(2));
    this._text(this.slipNumber, `${Math.round(Math.abs(s.slipDeg))}°`);

    this._text(this.sectorLabel, `SECTOR ${s.sector}`);
    this._text(this.surfaceLabel, s.surface.toUpperCase());
    this.surfaceLabel.className =
      `dash__surface${s.surface === 'tarmac' ? '' : ` dash__surface--${s.surface}`}`;

    this._text(this.lapValue, formatLapTime(s.lapTime));
    this._text(this.bestValue, formatLapTime(s.bestLapTime));
    this._text(this.lapCountLabel, `LAP ${s.lapCount + 1}`);

    // Sign carries the news, so colour just reinforces it.
    this._text(this.deltaValue, formatDelta(s.delta));
    const deltaClass = s.delta === null ? 'none' : s.delta > 0 ? 'up' : 'down';
    this.deltaValue.className = `dash__delta dash__delta--${deltaClass}`;

    const lastSplit = [...s.sectorTimes].reverse().find(t => Number.isFinite(t));
    this._text(this.splitLabel, formatSector(lastSplit ?? null));

    for (let i = 0; i < this.sectorBars.length; i++) {
      const done = Number.isFinite(s.sectorTimes[i]);
      const best = s.bestSectorTimes[i];
      // Purple only when this lap's split actually beat the reference.
      const purple = done && Number.isFinite(best) && s.sectorTimes[i] <= best;
      const state = purple ? 'best' : done ? 'done' : (i + 1 === s.sector ? 'live' : '');
      const bar = this.sectorBars[i];
      if (bar._state === state) continue;
      bar._state = state;
      bar.className = `dash__sector${state ? ` dash__sector--${state}` : ''}`;
    }
  }

  _text(node, value) {
    if (this._lastText.get(node) === value) return;
    this._lastText.set(node, value);
    node.textContent = value;
  }

  _drawMap({ position, offTrack }) {
    const ctx = this.mapCanvas._ctx;
    ctx.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    ctx.drawImage(this.mapBase, 0, 0, MAP_WIDTH, MAP_HEIGHT);

    const p = this.mapFit.project(position.x, position.z);
    ctx.fillStyle = offTrack ? COLOUR.red : COLOUR.ice;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /**
   * The g-g diagram: where the car's acceleration sits inside what the tyres can
   * currently carry. The ring is the real limit, so it grows as downforce builds.
   */
  _drawG({ latG, longG, gripLimitG, peakG, tractionUse }) {
    const ctx = this.gCanvas._ctx;
    const c = G_SIZE / 2;
    const limit = Math.max(gripLimitG, 0.5);
    // Keep the ring inside the panel even when the tyres are carrying 5 g.
    const radius = c - 9;
    const perG = radius / limit;

    ctx.clearRect(0, 0, G_SIZE, G_SIZE);

    ctx.strokeStyle = COLOUR.edge;
    ctx.lineWidth = 1;
    for (const g of [1, 2, 3, 4, 5]) {
      if (g >= limit) break;
      ring(ctx, c, g * perG);
    }
    ctx.beginPath();
    ctx.moveTo(c - radius, c); ctx.lineTo(c + radius, c);
    ctx.moveTo(c, c - radius); ctx.lineTo(c, c + radius);
    ctx.stroke();

    // The limit itself.
    ctx.strokeStyle = 'rgba(233, 239, 248, 0.55)';
    ctx.lineWidth = 1.4;
    ring(ctx, c, radius);

    if (peakG > 0.15) {
      ctx.strokeStyle = 'rgba(177, 75, 255, 0.55)';
      ctx.lineWidth = 1;
      ring(ctx, c, Math.min(peakG, limit) * perG);
    }

    // Braking plots upward and acceleration downward, the way a g-g trace reads.
    const px = g => c + g * perG;
    const py = g => c + g * perG;

    if (this._trail.length > 1) {
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      for (let i = 1; i < this._trail.length; i++) {
        const a = this._trail[i - 1], b = this._trail[i];
        ctx.strokeStyle = `rgba(53, 182, 255, ${(i / this._trail.length) * 0.75})`;
        ctx.beginPath();
        ctx.moveTo(px(a.lat), py(a.long));
        ctx.lineTo(px(b.lat), py(b.long));
        ctx.stroke();
      }
    }

    ctx.fillStyle = tractionUse > 0.97 ? COLOUR.red
      : tractionUse > 0.85 ? COLOUR.amber : COLOUR.green;
    ctx.beginPath();
    ctx.arc(px(latG), py(longG), 3.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---- small DOM helpers ----------------------------------------------------

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function span(text, className) {
  const node = el('span', className);
  node.textContent = text;
  return node;
}

function label(text) {
  const node = el('div', 'dash__label');
  node.textContent = text;
  return node;
}

function unitLabel(text) {
  const node = el('div', 'dash__unit');
  node.textContent = text;
  return node;
}

/** A silkscreen label on the left, its value on the right. */
function field(name, valueNode) {
  const row = el('div', 'dash__field');
  row.append(span(name), valueNode);
  return row;
}

function canvas(width, height, dpr, className) {
  const node = el('canvas', className);
  node.width = width * dpr;
  node.height = height * dpr;
  node.style.width = `${width}px`;
  node.style.height = `${height}px`;
  node.style.display = 'block';
  const ctx = node.getContext('2d');
  ctx.scale(dpr, dpr);
  node._ctx = ctx;
  return node;
}

function strokeRing(ctx, points) {
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
}

function ring(ctx, centre, radius) {
  ctx.beginPath();
  ctx.arc(centre, centre, radius, 0, Math.PI * 2);
  ctx.stroke();
}

const clamp01 = v => Math.max(0, Math.min(1, v));

let styled = false;
function injectStyleOnce() {
  if (styled) return;
  styled = true;
  const style = document.createElement('style');
  style.textContent = DASH_CSS;
  document.head.appendChild(style);
}
