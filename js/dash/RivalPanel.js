/**
 * Rival difficulty selector + live race readout — stacked with the Render and
 * Physics panels, top-right.
 *
 * Two jobs in one widget because they are the same fact seen two ways: the
 * buttons choose how hard the AI in `js/race/aiDriver.js` drives, and the
 * readout (position, lap, gap) is how the player finds out it worked. Follows
 * `PhysicsModePanel.js` for the selector idiom and `CreditsPanel.js` for style
 * injection and button wiring.
 *
 * The constructor takes no `initial` level, unlike `PhysicsModePanel` — this
 * panel owns its own persisted preference (read on construction, written on
 * every change) rather than making the caller thread storage through. It
 * still fires `onLevelChange` once at construction with whatever level that
 * resolves to, so the owner can re-level a rival that was already created
 * with the hardcoded default before this panel ever mounted.
 *
 * Preference key follows `js/physics/physicsMode.js` / `js/render/rendererBackend.js`:
 * an `apex-web-simulator.*` key, with a `helloracer.*` fallback for anyone
 * carrying settings from before the rename.
 */

import { DIFFICULTY, DIFFICULTY_ORDER } from '../race/aiDriver.js';
import { standings, RACE_LAPS, rivalGapDisplay } from '../race/raceField.js';
import { formatDelta, formatLapTime } from './telemetry.js';

export const RIVAL_PREF_KEY = 'apex-web-simulator.rivalLevel';
export const LEGACY_RIVAL_PREF_KEY = 'helloracer.rivalLevel';

/**
 * @param {Pick<Storage, 'getItem'> | null | undefined} [storage]
 * @returns {string | null} a valid `DIFFICULTY` key, or null if nothing usable is stored
 */
export function readStoredRivalLevel(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem?.(RIVAL_PREF_KEY) ?? storage?.getItem?.(LEGACY_RIVAL_PREF_KEY);
    if (DIFFICULTY[value]) return value;
  } catch {
    /* private mode / denied */
  }
  return null;
}

/**
 * @param {string} level
 * @param {Pick<Storage, 'setItem'> | null | undefined} [storage]
 */
export function writeStoredRivalLevel(level, storage = globalThis.localStorage) {
  if (!DIFFICULTY[level]) return;
  try {
    storage?.setItem?.(RIVAL_PREF_KEY, level);
  } catch {
    /* private mode / denied */
  }
}

/**
 * @param {string | null | undefined} stored
 * @returns {string} a valid `DIFFICULTY` key, defaulting to 'pro'
 */
export function resolveRivalLevel(stored) {
  return DIFFICULTY[stored] ? stored : 'pro';
}

const STYLE_ID = 'rival-panel-style';

const CSS = `
.rpanel {
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
  transition: opacity 180ms ease, transform 180ms ease;
}
.rpanel.rpanel--off {
  opacity: 0;
  transform: translateY(8px);
  pointer-events: none;
}
.rpanel__shell {
  background: var(--carbon);
  border: 1px solid var(--edge);
  box-shadow: inset 0 1px 0 rgba(214, 232, 255, 0.13);
  backdrop-filter: blur(14px) saturate(115%);
  -webkit-backdrop-filter: blur(14px) saturate(115%);
  clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
  padding: 8px 11px 9px;
}
.rpanel__label {
  font-size: 9px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--slate);
  margin-bottom: 6px;
}
.rpanel__seg {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 4px;
}
.rpanel__btn {
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
.rpanel__btn:hover {
  color: var(--ice);
  border-color: var(--edge-bright);
}
.rpanel__btn--on {
  background: rgba(53, 182, 255, 0.18);
  border-color: rgba(53, 182, 255, 0.55);
  color: var(--ice);
}
.rpanel__btn:focus-visible {
  outline: 1px solid var(--blue);
  outline-offset: 1px;
}
.rpanel__readout {
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px solid rgba(163, 186, 219, 0.16);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.rpanel__row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 10px;
}
.rpanel__key {
  color: var(--slate);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.rpanel__value {
  color: var(--ice);
}
`;

function injectStyleOnce() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** @param {string} tag @param {string} [className] @param {string} [text] */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Renders the decision `rivalGapDisplay` (`raceField.js`) already made — this
 * function only picks a format per `kind`, it does not decide which `kind`
 * applies. `+`/`-` on the lap count follows the same "positive = trailing"
 * convention as `formatDelta`'s seconds.
 * @param {ReturnType<import('../race/raceField.js').rivalGapDisplay>} display
 * @returns {string}
 */
function formatGapDisplay(display) {
  switch (display.kind) {
    case 'finished':
      return formatLapTime(display.finishTime);
    case 'laps': {
      const n = Math.abs(display.delta);
      return `${display.delta >= 0 ? '+' : '-'}${n} LAP${n === 1 ? '' : 'S'}`;
    }
    case 'seconds':
    default:
      return formatDelta(display.seconds);
  }
}

export class RivalPanel {
  /**
   * @param {HTMLElement} container — usually the `.top-right-stack`
   * @param {object} [options]
   * @param {(level: string) => void} [options.onLevelChange] called on every
   *   change, INCLUDING once synchronously here at construction with the
   *   resolved starting level (persisted, or 'pro') — the race field is
   *   built before this panel mounts, so the owner needs that first call to
   *   bring the rival's AI in line with whatever the player last chose.
   */
  constructor(container, { onLevelChange } = {}) {
    injectStyleOnce();
    this.visible = true;
    this._onLevelChange = onLevelChange ?? (() => {});
    this._level = resolveRivalLevel(readStoredRivalLevel());
    this._buttons = new Map();
    this._lastReadoutKey = null;

    this.root = el('div', 'rpanel');
    const shell = el('div', 'rpanel__shell');
    shell.append(el('div', 'rpanel__label', 'Rival'));

    const seg = el('div', 'rpanel__seg');
    for (const id of DIFFICULTY_ORDER) {
      seg.append(this._makeButton(DIFFICULTY[id]));
    }
    shell.append(seg);

    const readout = el('div', 'rpanel__readout');
    const pos = this._makeRow('Pos');
    const lap = this._makeRow('Lap');
    const gap = this._makeRow('Gap');
    readout.append(pos.row, lap.row, gap.row);
    this._posValue = pos.value;
    this._lapValue = lap.value;
    this._gapValue = gap.value;
    shell.append(readout);

    this.root.append(shell);
    container.appendChild(this.root);

    this._onLevelChange(this._level);
  }

  /** @returns {string} the current `DIFFICULTY` key */
  get level() {
    return this._level;
  }

  /** @param {string} level */
  setLevel(level) {
    if (!DIFFICULTY[level] || level === this._level) return;
    this._level = level;
    for (const [id, btn] of this._buttons) {
      btn.classList.toggle('rpanel__btn--on', id === this._level);
      btn.setAttribute('aria-pressed', String(id === this._level));
    }
    writeStoredRivalLevel(this._level);
    this._onLevelChange(this._level);
  }

  /**
   * Position, lap and gap — read straight off `raceField.js`'s own field
   * shape, nothing cached or re-derived here. The gap's *shape* (seconds vs.
   * lap count vs. a finish time) is decided by `rivalGapDisplay`, which is
   * pure and tested on its own; this method only asks it and formats the
   * answer.
   * @param {ReturnType<import('../race/raceField.js').createRaceField> | null} field
   */
  update(field) {
    if (!field?.entries?.length) return;
    const player = field.entries.find(e => e.isPlayer);
    if (!player) return;
    const other = field.entries.find(e => e !== player);
    const order = standings(field);
    const position = order.indexOf(player) + 1;
    const lap = Math.min(player.laps + 1, RACE_LAPS);

    let gapText = '—';
    if (other) {
      gapText = formatGapDisplay(rivalGapDisplay(player, other, field.line.length));
    }

    const key = `${position}|${order.length}|${lap}|${gapText}`;
    if (key === this._lastReadoutKey) return;
    this._lastReadoutKey = key;
    this._posValue.textContent = `P${position} / ${order.length}`;
    this._lapValue.textContent = `${lap} / ${RACE_LAPS}`;
    this._gapValue.textContent = gapText;
  }

  /** @param {boolean} visible */
  setVisible(visible) {
    this.visible = visible;
    this.root.classList.toggle('rpanel--off', !visible);
  }

  _makeButton(preset) {
    const btn = el('button', 'rpanel__btn', preset.label);
    btn.type = 'button';
    btn.title = preset.label;
    const on = preset.id === this._level;
    btn.classList.toggle('rpanel__btn--on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.addEventListener('click', () => this.setLevel(preset.id));
    this._buttons.set(preset.id, btn);
    return btn;
  }

  _makeRow(label) {
    const row = el('div', 'rpanel__row');
    row.append(el('span', 'rpanel__key', label));
    const value = el('span', 'rpanel__value', '—');
    row.append(value);
    return { row, value };
  }
}
