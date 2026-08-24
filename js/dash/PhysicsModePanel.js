/**
 * Simulator / arcade toggle — compact widget stacked with the Render panel.
 */

import {
  PHYSICS_MODES, physicsPreset,
} from '../physics/physicsMode.js';

const STYLE_ID = 'physics-mode-panel-style';

const CSS = `
.top-right-stack {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 200;
  width: 248px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: none;
}
.top-right-stack > * { pointer-events: auto; }

.ppanel {
  --carbon: rgba(9, 11, 15, 0.82);
  --carbon-well: rgba(0, 0, 0, 0.45);
  --edge: rgba(163, 186, 219, 0.28);
  --edge-bright: rgba(198, 221, 252, 0.48);
  --ice: #e9eff8;
  --slate: #7b8798;
  --blue: #35b6ff;

  width: 100%;
  font-family: ui-monospace, "SF Mono", "Roboto Mono", Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--ice);
  -webkit-font-smoothing: antialiased;
}
.ppanel__shell {
  background: var(--carbon);
  border: 1px solid var(--edge);
  box-shadow: inset 0 1px 0 rgba(214, 232, 255, 0.13);
  backdrop-filter: blur(14px) saturate(115%);
  -webkit-backdrop-filter: blur(14px) saturate(115%);
  clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
  padding: 8px 11px 9px;
}
.ppanel__label {
  font-size: 9px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--slate);
  margin-bottom: 6px;
}
.ppanel__seg {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
}
.ppanel__btn {
  margin: 0;
  padding: 6px 4px;
  border: 1px solid rgba(163, 186, 219, 0.22);
  background: var(--carbon-well);
  color: var(--slate);
  font: inherit;
  font-size: 9px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  cursor: pointer;
  user-select: none;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
.ppanel__btn:hover {
  color: var(--ice);
  border-color: var(--edge-bright);
}
.ppanel__btn--on {
  background: rgba(53, 182, 255, 0.18);
  border-color: rgba(53, 182, 255, 0.55);
  color: var(--ice);
}
.ppanel__btn:focus-visible {
  outline: 1px solid var(--blue);
  outline-offset: 1px;
}
.ppanel__blurb {
  margin-top: 6px;
  font-size: 9px;
  color: var(--slate);
  letter-spacing: 0.04em;
  line-height: 1.45;
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

/** @param {HTMLElement} container — usually `.top-right-stack` */
export function ensureTopRightStack(container) {
  injectStyleOnce();
  let stack = container.querySelector('.top-right-stack');
  if (stack) return stack;
  stack = el('div', 'top-right-stack');
  container.appendChild(stack);
  return stack;
}

export class PhysicsModePanel {
  /**
   * @param {HTMLElement} container
   * @param {object} options
   * @param {'sim' | 'arcade'} [options.initial='arcade']
   * @param {(mode: 'sim' | 'arcade') => void} [options.onChange]
   */
  constructor(container, { initial = 'arcade', onChange } = {}) {
    injectStyleOnce();
    this._onChange = onChange ?? (() => {});
    this._mode = physicsPreset(initial).id;
    this._buttons = new Map();

    this.root = el('div', 'ppanel');
    const shell = el('div', 'ppanel__shell');
    shell.append(el('div', 'ppanel__label', 'Physics'));
    const seg = el('div', 'ppanel__seg');
    for (const preset of Object.values(PHYSICS_MODES)) {
      seg.append(this._makeButton(preset));
    }
    shell.append(seg);
    this._blurb = el('div', 'ppanel__blurb', physicsPreset(this._mode).blurb);
    shell.append(this._blurb);
    this.root.append(shell);
    container.appendChild(this.root);
  }

  /** @returns {'sim' | 'arcade'} */
  get mode() {
    return this._mode;
  }

  /** @param {'sim' | 'arcade'} mode */
  setMode(mode) {
    const preset = physicsPreset(mode);
    if (preset.id === this._mode) return;
    this._mode = preset.id;
    for (const [id, btn] of this._buttons) {
      btn.classList.toggle('ppanel__btn--on', id === this._mode);
      btn.setAttribute('aria-pressed', String(id === this._mode));
    }
    this._blurb.textContent = preset.blurb;
  }

  _makeButton(preset) {
    const btn = el('button', 'ppanel__btn', preset.short);
    btn.type = 'button';
    btn.title = preset.label;
    const on = preset.id === this._mode;
    btn.classList.toggle('ppanel__btn--on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.addEventListener('click', () => {
      if (preset.id === this._mode) return;
      this.setMode(preset.id);
      this._onChange(preset.id);
    });
    this._buttons.set(preset.id, btn);
    return btn;
  }
}
