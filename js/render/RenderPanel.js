/**
 * Foldable render / FX overlay: scene lighting sliders, FX toggles, FPS.
 * Styled like the motorsport dash (dark translucent carbon HUD).
 */

import {
  defaultRenderValues,
  FX_FLAGS,
  RENDER_SLIDERS,
  sanitizeRenderValues,
} from './renderPanelState.js';

const STYLE_ID = 'render-panel-style';

const CSS = `
.rpanel {
  --carbon: rgba(9, 11, 15, 0.82);
  --carbon-well: rgba(0, 0, 0, 0.45);
  --edge: rgba(163, 186, 219, 0.28);
  --edge-bright: rgba(198, 221, 252, 0.48);
  --ice: #e9eff8;
  --slate: #7b8798;
  --blue: #35b6ff;

  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 200;
  width: 248px;
  pointer-events: auto;
  font-family: ui-monospace, "SF Mono", "Roboto Mono", Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--ice);
  -webkit-font-smoothing: antialiased;
}
.rpanel__shell {
  background: var(--carbon);
  border: 1px solid var(--edge);
  box-shadow: inset 0 1px 0 rgba(214, 232, 255, 0.13);
  backdrop-filter: blur(14px) saturate(115%);
  -webkit-backdrop-filter: blur(14px) saturate(115%);
  clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
}
.rpanel__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin: 0;
  padding: 8px 11px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
}
.rpanel__head:hover { color: #fff; }
.rpanel__title {
  flex: none;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-size: 10px;
  color: var(--slate);
}
.rpanel__fps {
  flex: 1;
  text-align: right;
  color: var(--ice);
  font-size: 10px;
  letter-spacing: 0.02em;
}
.rpanel__chevron {
  flex: none;
  color: var(--slate);
  font-size: 9px;
  transition: transform 140ms ease;
}
.rpanel--open .rpanel__chevron { transform: rotate(90deg); }
.rpanel__body {
  display: none;
  padding: 0 11px 11px;
  max-height: min(70vh, 520px);
  overflow-y: auto;
}
.rpanel--open .rpanel__body { display: block; }
.rpanel__section {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(163, 186, 219, 0.14);
}
.rpanel__section-label {
  font-size: 9px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--slate);
  margin-bottom: 6px;
}
.rpanel__row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px 8px;
  align-items: baseline;
  margin-top: 6px;
}
.rpanel__row label { color: #b6bfcc; }
.rpanel__val {
  color: var(--ice);
  min-width: 36px;
  text-align: right;
}
.rpanel__row input[type=range] {
  grid-column: 1 / -1;
  width: 100%;
  margin: 0;
  accent-color: var(--blue);
}
.rpanel__toggles {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 10px;
}
.rpanel__toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  color: #b6bfcc;
  cursor: pointer;
  user-select: none;
}
.rpanel__toggle input {
  accent-color: var(--blue);
  margin: 0;
}
.rpanel__hint {
  margin-top: 8px;
  font-size: 9px;
  color: var(--slate);
  letter-spacing: 0.04em;
}
`;

function injectStyleOnce() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const SLIDER_ROWS = [
  { key: 'toneExposure', label: 'Exposure' },
  { key: 'envIntensity', label: 'Env / IBL' },
  { key: 'sunIntensity', label: 'Sun' },
  { key: 'shadowIntensity', label: 'Shadow' },
  { key: 'hemiIntensity', label: 'Hemisphere' },
  { key: 'rimIntensity', label: 'Rim' },
  { key: 'reflectivity', label: 'Reflectivity' },
  { key: 'aoBlend', label: 'AO blend' },
];

const TOGGLE_ROWS = [
  { key: 'ssao', label: 'AO / GTAO', hint: '1' },
  { key: 'bounce', label: 'Bounce', hint: '2' },
  { key: 'csm', label: 'CSM', hint: '3' },
  { key: 'taa', label: 'TAA', hint: 'T' },
  { key: 'grade', label: 'Grade', hint: 'G' },
];

/** WebGPU only, apart from bloom — see `_fx` in HelloRacer. */
const CINEMATIC_TOGGLE_ROWS = [
  { key: 'motionBlur', label: 'Motion blur', hint: '4' },
  { key: 'bloom', label: 'Bloom', hint: '5' },
  { key: 'flare', label: 'Lens flare', hint: '' },
  { key: 'dof', label: 'Depth of field', hint: '6' },
];

const CINEMATIC_SLIDER_ROWS = [
  { key: 'motionBlurStrength', label: 'Blur amount' },
  { key: 'bloomStrength', label: 'Bloom' },
  { key: 'bloomRadius', label: 'Bloom radius' },
  { key: 'bloomThreshold', label: 'Bloom threshold' },
  { key: 'flareAmount', label: 'Flare' },
  { key: 'dofRange', label: 'Focus falloff' },
  { key: 'dofBokeh', label: 'Bokeh' },
];

/**
 * @typedef {ReturnType<typeof defaultRenderValues>} RenderValues
 */

export class RenderPanel {
  /**
   * @param {HTMLElement} container
   * @param {object} options
   * @param {'webgl' | 'webgpu'} [options.backend]
   * @param {Partial<RenderValues>} [options.initial]
   * @param {(key: string, value: number | boolean, values: RenderValues) => void} [options.onChange]
   * @param {(enabled: boolean) => void} [options.onWebGpuChange] — persists + reload; cannot hot-swap Three
   */
  constructor(container, { backend = 'webgpu', initial = {}, onChange, onWebGpuChange } = {}) {
    injectStyleOnce();
    this._onChange = onChange ?? (() => {});
    this._onWebGpuChange = onWebGpuChange ?? (() => {});
    this._backend = backend === 'webgpu' ? 'webgpu' : 'webgl';
    this._values = sanitizeRenderValues({
      ...defaultRenderValues(this._backend),
      ...initial,
    });
    this._open = false;
    this._fpsFrames = 0;
    this._fpsAccum = 0;
    this._sliders = new Map();
    this._toggles = new Map();

    this.root = el('div', 'rpanel');
    const shell = el('div', 'rpanel__shell');

    this._head = el('button', 'rpanel__head');
    this._head.type = 'button';
    this._head.append(
      el('span', 'rpanel__title', 'Render'),
      (this._fpsEl = el('span', 'rpanel__fps', '— fps')),
      el('span', 'rpanel__chevron', '▸'),
    );
    this._head.addEventListener('click', () => this.toggle());

    this._body = el('div', 'rpanel__body');

    const backendSection = el('div', 'rpanel__section');
    backendSection.append(el('div', 'rpanel__section-label', 'Backend'));
    backendSection.append(this._makeWebGpuToggle());
    backendSection.append(el('div', 'rpanel__hint', 'Reload required to switch Three build'));
    this._body.append(backendSection);

    const lightSection = el('div', 'rpanel__section');
    lightSection.append(el('div', 'rpanel__section-label', 'Lighting'));
    for (const row of SLIDER_ROWS) {
      lightSection.append(this._makeSlider(row.key, row.label));
    }
    this._body.append(lightSection);

    const fxSection = el('div', 'rpanel__section');
    fxSection.append(el('div', 'rpanel__section-label', 'FX'));
    const toggles = el('div', 'rpanel__toggles');
    for (const row of TOGGLE_ROWS) {
      toggles.append(this._makeToggle(row.key, row.label, row.hint));
    }
    fxSection.append(toggles);
    fxSection.append(el('div', 'rpanel__hint', 'Keys 1 · 2 · 3 · T · G sync here'));
    this._body.append(fxSection);

    const cineSection = el('div', 'rpanel__section');
    cineSection.append(el('div', 'rpanel__section-label', 'Cinematic'));
    const cineToggles = el('div', 'rpanel__toggles');
    for (const row of CINEMATIC_TOGGLE_ROWS) {
      cineToggles.append(this._makeToggle(row.key, row.label, row.hint));
    }
    cineSection.append(cineToggles);
    for (const row of CINEMATIC_SLIDER_ROWS) {
      cineSection.append(this._makeSlider(row.key, row.label));
    }
    cineSection.append(el('div', 'rpanel__hint', 'Keys 4 · 5 · 6 sync here'));
    this._body.append(cineSection);

    shell.append(this._head, this._body);
    this.root.append(shell);
    container.appendChild(this.root);
  }

  get values() {
    return { ...this._values };
  }

  get open() {
    return this._open;
  }

  toggle() {
    this.setOpen(!this._open);
  }

  setOpen(open) {
    this._open = Boolean(open);
    this.root.classList.toggle('rpanel--open', this._open);
  }

  /**
   * Sync FX toggles when keyboard shortcuts flip them.
   * @param {Partial<Pick<RenderValues, 'ssao' | 'bounce' | 'csm' | 'taa' | 'grade'>>} fx
   */
  syncFx(fx) {
    for (const key of FX_FLAGS) {
      if (fx[key] === undefined) continue;
      const on = Boolean(fx[key]);
      this._values[key] = on;
      const input = this._toggles.get(key);
      if (input) input.checked = on;
    }
  }

  /**
   * Sync a single numeric control from outside (e.g. after env load).
   * @param {keyof RenderValues} key
   * @param {number} value
   */
  setValue(key, value) {
    if (!(key in RENDER_SLIDERS)) return;
    const range = RENDER_SLIDERS[key];
    const v = sanitizeRenderValues({ [key]: value })[key];
    this._values[key] = v;
    const row = this._sliders.get(key);
    if (!row) return;
    row.input.value = String(v);
    row.val.textContent = formatSlider(v, range.step);
  }

  /**
   * Call once per frame with frame delta in seconds.
   * @param {number} dt
   */
  update(dt) {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    if (step <= 0) return;
    this._fpsFrames += 1;
    this._fpsAccum += step;
    if (this._fpsAccum < 0.4) return;
    const fps = this._fpsFrames / this._fpsAccum;
    const ms = 1000 / fps;
    this._fpsEl.textContent = `${fps.toFixed(0)} fps · ${ms.toFixed(1)} ms`;
    this._fpsFrames = 0;
    this._fpsAccum = 0;
  }

  _makeSlider(key, label) {
    const range = RENDER_SLIDERS[key];
    const value = this._values[key];
    const row = el('div', 'rpanel__row');
    row.append(el('label', null, label));
    const val = el('span', 'rpanel__val', formatSlider(value, range.step));
    row.append(val);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    input.value = String(value);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      this._values[key] = v;
      val.textContent = formatSlider(v, range.step);
      this._onChange(key, v, this.values);
    });
    row.append(input);
    this._sliders.set(key, { input, val });
    return row;
  }

  _makeToggle(key, label, hint) {
    const wrap = el('label', 'rpanel__toggle');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(this._values[key]);
    input.addEventListener('change', () => {
      const on = input.checked;
      this._values[key] = on;
      this._onChange(key, on, this.values);
    });
    wrap.append(input, document.createTextNode(`${label} (${hint})`));
    this._toggles.set(key, input);
    return wrap;
  }

  _makeWebGpuToggle() {
    const wrap = el('label', 'rpanel__toggle');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this._backend === 'webgpu';
    input.addEventListener('change', () => {
      this._onWebGpuChange(input.checked);
    });
    wrap.append(input, document.createTextNode('WebGPU'));
    this._webGpuInput = input;
    return wrap;
  }
}

function formatSlider(v, step) {
  if (step >= 1) return String(Math.round(v));
  if (step >= 0.1) return v.toFixed(1);
  return v.toFixed(2);
}
