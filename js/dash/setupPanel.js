/**
 * The setup screen.
 *
 * `setup.js` owns what the parameters are and what they do; this owns showing
 * them. Two things it deliberately does that a slider panel usually does not:
 *
 *   - **It reports the derived quantities.** "Front bar 6" tells a driver nothing;
 *     "58.7% front roll stiffness" is the number that decides the balance, and it
 *     moves when either bar or either spring does. Showing only the clicks hides
 *     the thing being set.
 *
 *   - **It says what each control does**, from the schema, so the panel cannot
 *     drift out of step with the physics. If a parameter's effect changes, the
 *     text changes with it because there is one copy.
 *
 * Applying a setup rebuilds the car, because half of it lives in derived state
 * (roll stiffness, corner loads, the suspension's own rates) and mutating one
 * value in place would leave the rest describing the old car.
 */

import { SETUP_SCHEMA, defaultSetup, applySetup, describeSetup } from '../physics/setup.js';

const STYLE_ID = 'setup-panel-style';

const CSS = `
.setup {
  /* Above the dashboard (150) and the render panel (200). A modal that renders
     under the HUD it is meant to replace is worse than no modal. */
  position: fixed; inset: 0; z-index: 300;
  display: none; align-items: center; justify-content: center;
  background: rgba(8, 10, 14, 0.72);
  backdrop-filter: blur(3px);
  font: 12px/1.45 ui-monospace, "SF Mono", Menlo, monospace;
  color: #dfe4ea;
}
.setup--on { display: flex; }
.setup__sheet {
  width: min(760px, 94vw); max-height: 88vh; overflow-y: auto;
  background: #12151b; border: 1px solid #262c36; border-radius: 10px;
  padding: 18px 20px 20px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.55);
}
.setup__title {
  display: flex; justify-content: space-between; align-items: baseline;
  margin: 0 0 14px; font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase;
  color: #8b95a5;
}
.setup__derived {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 6px 14px; margin: 0 0 16px; padding: 10px 12px;
  background: #171b22; border: 1px solid #232935; border-radius: 6px;
}
.setup__derived b { color: #f2f5f8; font-weight: 600; }
.setup__row {
  display: grid; grid-template-columns: 168px 1fr 84px; gap: 12px;
  align-items: center; padding: 5px 0;
}
.setup__row + .setup__row { border-top: 1px solid #1d222b; }
.setup__name { color: #b6bfcc; }
.setup__value { text-align: right; color: #f2f5f8; }
.setup__effect {
  grid-column: 1 / -1; margin: -2px 0 2px; color: #6f7987; font-size: 11px;
}
.setup input[type=range] { width: 100%; accent-color: #4f9bf5; }
.setup__buttons { display: flex; gap: 8px; margin-top: 16px; }
.setup__btn {
  font: inherit; padding: 7px 14px; border-radius: 5px; cursor: pointer;
  background: #1e2530; color: #dfe4ea; border: 1px solid #2c3542;
}
.setup__btn:hover { background: #26303e; }
.setup__btn--primary { background: #2b62a8; border-color: #3b78c4; }
.setup__btn--primary:hover { background: #3472c0; }
`;

function injectStyleOnce() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export class SetupPanel {
  /**
   * @param {HTMLElement} container
   * @param {object} options
   * @param {function} options.onApply called with the new setup object.
   * @param {object} [options.initial]
   */
  constructor(container, { onApply, initial } = {}) {
    injectStyleOnce();
    this.visible = false;
    this._onApply = onApply ?? (() => {});
    this._values = { ...defaultSetup(), ...(initial ?? {}) };
    this._rows = new Map();

    this.root = el('div', 'setup');
    const sheet = el('div', 'setup__sheet');

    const title = el('div', 'setup__title');
    title.append(el('span', null, 'Car setup'), el('span', null, 'P closes'));
    sheet.append(title);

    this._derived = el('div', 'setup__derived');
    sheet.append(this._derived);

    for (const p of SETUP_SCHEMA) {
      const row = el('div', 'setup__row');
      const name = el('div', 'setup__name', p.label);
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(p.min);
      slider.max = String(p.max);
      slider.step = String(p.step);
      slider.value = String(this._values[p.key]);
      const value = el('div', 'setup__value');

      slider.addEventListener('input', () => {
        this._values[p.key] = Number(slider.value);
        this._refresh();
      });

      row.append(name, slider, value);
      sheet.append(row);
      // The effect text comes from the schema, so it cannot drift from the physics.
      sheet.append(el('div', 'setup__effect', p.effect));
      this._rows.set(p.key, { slider, value, spec: p });
    }

    const buttons = el('div', 'setup__buttons');
    const apply = el('button', 'setup__btn setup__btn--primary', 'Apply and reset car');
    apply.addEventListener('click', () => this.apply());
    const reset = el('button', 'setup__btn', 'Back to baseline');
    reset.addEventListener('click', () => {
      this._values = defaultSetup();
      for (const [key, row] of this._rows) row.slider.value = String(this._values[key]);
      this._refresh();
    });
    const close = el('button', 'setup__btn', 'Close');
    close.addEventListener('click', () => this.hide());
    buttons.append(apply, reset, close);
    sheet.append(buttons);

    this.root.append(sheet);
    container.appendChild(this.root);
    this._refresh();
  }

  /** Current slider values, which may not yet have been applied to the car. */
  get values() {
    return { ...this._values };
  }

  _refresh() {
    for (const [key, row] of this._rows) {
      const v = this._values[key];
      row.value.textContent = row.spec.unit
        ? `${v}${row.spec.unit.startsWith('%') || row.spec.unit === '' ? '' : ' '}${row.spec.unit}`
        : String(v);
    }
    // Derived quantities, recomputed from the whole setup rather than from the
    // control that moved: roll stiffness depends on both bars and both springs.
    const d = describeSetup(applySetup(this._values));
    this._derived.replaceChildren();
    for (const [label, text] of [
      ['Balance', d.rollBalance],
      ['Load transfer', d.transferBalance],
      ['Rake', d.rake],
      ['Mass', d.mass],
      ['Aero', d.wings],
    ]) {
      const cell = el('div');
      cell.append(el('span', null, `${label}: `), Object.assign(el('b'), { textContent: text }));
      this._derived.append(cell);
    }
  }

  apply() {
    this._onApply(this.values);
    this.hide();
  }

  show() {
    this.visible = true;
    this.root.classList.add('setup--on');
  }

  hide() {
    this.visible = false;
    this.root.classList.remove('setup--on');
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }
}
