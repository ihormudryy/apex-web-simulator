/**
 * Car shell picker — swaps the visual body via the catalog under `obj/cars/`.
 */

import {
  CAR_CATALOG, carById, readStoredCarId, writeStoredCarId, DEFAULT_CAR_ID,
} from '../mod/carCatalog.js';
import { carAssetExists } from '../mod/loadCarGlb.js';

const STYLE_ID = 'car-picker-style';

const CSS = `
.car-picker {
  --carbon: rgba(9, 11, 15, 0.82);
  --edge: rgba(163, 186, 219, 0.28);
  --ice: #e9eff8;
  --slate: #7b8798;
  --blue: #35b6ff;
  --warn: #ffb347;
  --err: #ff5a4a;
  --ok: #35e06b;

  width: 100%;
  font-family: ui-monospace, "SF Mono", "Roboto Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--ice);
}
.car-picker__shell {
  background: var(--carbon);
  border: 1px solid var(--edge);
  backdrop-filter: blur(14px) saturate(115%);
  -webkit-backdrop-filter: blur(14px) saturate(115%);
  clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
  padding: 8px 11px 9px;
}
.car-picker__label {
  font-size: 9px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--slate);
  margin-bottom: 6px;
}
.car-picker__row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.car-picker__select {
  flex: 1;
  background: rgba(0,0,0,0.45);
  border: 1px solid var(--edge);
  color: var(--ice);
  font: inherit;
  padding: 5px 6px;
  min-width: 0;
}
.car-picker__select:focus { outline: 1px solid var(--blue); }
.car-picker__status {
  margin-top: 6px;
  font-size: 9px;
  color: var(--slate);
  line-height: 1.35;
  min-height: 1.2em;
}
.car-picker__status[data-kind=ok] { color: var(--ok); }
.car-picker__status[data-kind=warn] { color: var(--warn); }
.car-picker__status[data-kind=error] { color: var(--err); }
.car-picker__attr {
  margin-top: 4px;
  font-size: 8px;
  color: var(--slate);
  opacity: 0.85;
  line-height: 1.3;
}
`;

export class CarPicker {
  /**
   * @param {HTMLElement} container
   * @param {{
   *   initial?: string,
   *   onChange: (id: string, entry: import('../mod/carCatalog.js').CarCatalogEntry) => void | Promise<void>,
   * }} opts
   */
  constructor(container, { initial = readStoredCarId(), onChange }) {
    this._onChange = onChange;
    this._busy = false;
    this._id = carById(initial) ? initial : DEFAULT_CAR_ID;

    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    this.root = document.createElement('div');
    this.root.className = 'car-picker';
    this.root.innerHTML = `
      <div class="car-picker__shell">
        <div class="car-picker__label">Car</div>
        <div class="car-picker__row">
          <select class="car-picker__select" aria-label="Car model"></select>
        </div>
        <div class="car-picker__status" aria-live="polite"></div>
        <div class="car-picker__attr"></div>
      </div>
    `;
    this._select = this.root.querySelector('.car-picker__select');
    this._status = this.root.querySelector('.car-picker__status');
    this._attr = this.root.querySelector('.car-picker__attr');

    for (const entry of CAR_CATALOG) {
      const opt = document.createElement('option');
      opt.value = entry.id;
      opt.textContent = entry.label;
      if (entry.id === this._id) opt.selected = true;
      this._select.appendChild(opt);
    }

    this._select.addEventListener('change', () => this._pick(this._select.value));
    this._showAttribution(carById(this._id));

    container.appendChild(this.root);
    this._probeAssets();
  }

  /** Grey out catalog rows whose files are not on disk yet. */
  async _probeAssets() {
    for (const opt of this._select.options) {
      const entry = carById(opt.value);
      if (!entry?.url) continue;
      const ok = await carAssetExists(entry.url);
      if (ok) continue;
      opt.disabled = true;
      if (!opt.textContent.includes('missing')) {
        opt.textContent = `${entry.label} (file missing)`;
      }
    }
  }

  /** Current catalog id. */
  get id() {
    return this._id;
  }

  /**
   * Apply a pick without firing from the select control (boot / restore).
   * @param {string} id
   */
  async apply(id) {
    this._select.value = id;
    await this._pick(id);
  }

  /**
   * @param {string} text
   * @param {'ok'|'warn'|'error'|''} [kind]
   */
  setStatus(text, kind = '') {
    this._status.textContent = text;
    if (kind) this._status.dataset.kind = kind;
    else delete this._status.dataset.kind;
  }

  /** @param {import('../mod/carCatalog.js').CarCatalogEntry | undefined} entry */
  _showAttribution(entry) {
    if (!entry) {
      this._attr.textContent = '';
      return;
    }
    const bits = [entry.attribution, entry.license].filter(Boolean);
    if (entry.notes) bits.push(entry.notes);
    this._attr.textContent = bits.join(' · ');
  }

  /** @param {string} id */
  async _pick(id) {
    const entry = carById(id);
    if (!entry || this._busy) {
      this._select.value = this._id;
      return;
    }
    this._busy = true;
    this._select.disabled = true;
    this.setStatus(entry.url ? `Loading ${entry.label}…` : 'Restoring default…', '');
    this._showAttribution(entry);
    try {
      await this._onChange(id, entry);
      this._id = id;
      writeStoredCarId(id);
      this.setStatus(`${entry.label} ready`, 'ok');
    } catch (err) {
      this._select.value = this._id;
      const msg = err?.message || String(err);
      this.setStatus(
        msg.includes('404') || msg.includes('Not Found') || msg.includes('failed')
          ? `Missing file — put GLB at ${entry.url}`
          : `Load failed: ${msg}`,
        'error',
      );
      console.error(err);
    } finally {
      this._busy = false;
      this._select.disabled = false;
    }
  }
}
