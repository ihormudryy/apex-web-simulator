const HINTS_CSS = `
.hints {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 150;
  pointer-events: none;
  font-family: ui-monospace, "SF Mono", "Roboto Mono", Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  line-height: 1.55;
  letter-spacing: 0.06em;
  color: #7b8798;
  background: rgba(9, 11, 15, 0.78);
  border: 1px solid rgba(163, 186, 219, 0.26);
  box-shadow: inset 0 1px 0 rgba(214, 232, 255, 0.13);
  backdrop-filter: blur(14px) saturate(115%);
  -webkit-backdrop-filter: blur(14px) saturate(115%);
  padding: 10px 12px;
  clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
  transition: opacity 180ms ease, transform 180ms ease;
}
.hints.hints--off {
  opacity: 0;
  transform: translateY(8px);
}
.hints__row { display: flex; gap: 8px; white-space: nowrap; }
.hints__key {
  min-width: 3.2em;
  color: #e9eff8;
  text-transform: uppercase;
}
.hints__rec {
  margin-top: 6px;
  color: #ff6b6b;
  letter-spacing: 0.12em;
}
@media (prefers-reduced-motion: reduce) {
  .hints { transition: none; }
}
`;

let styleInjected = false;

function injectStyleOnce() {
  if (styleInjected) return;
  styleInjected = true;
  const el = document.createElement('style');
  el.textContent = HINTS_CSS;
  document.head.appendChild(el);
}

/** @param {string} tag @param {string} [className] @param {string} [text] */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const HINT_ROWS = [
  ['WASD', 'drive'],
  ['Space', 'tap log · hold brake'],
  ['C', 'camera (finish)'],
  ['Q', 'quality (auto)'],
  ['+ / −', 'rear zoom'],
  ['START', 'race the rival'],
  ['H', 'hide HUD'],
  ['Esc', 'reset'],
];

export class ControlHints {
  /** @param {HTMLElement} container */
  constructor(container) {
    this.visible = true;
    injectStyleOnce();

    this.root = el('div', 'hints');
    this.root.setAttribute('aria-hidden', 'true');

    for (const [key, action] of HINT_ROWS) {
      const row = el('div', 'hints__row');
      row.append(el('span', 'hints__key', key), document.createTextNode(action));
      this.root.append(row);
    }

    container.appendChild(this.root);

    this._recRow = el('div', 'hints__row hints__rec');
    this._recRow.style.display = 'none';
    this._recRow.append(el('span', 'hints__key', 'REC'), document.createTextNode('logging'));
    this.root.append(this._recRow);
  }

  /** @param {boolean} active */
  setRecording(active) {
    if (this._recRow) this._recRow.style.display = active ? 'flex' : 'none';
  }

  toggle() {
    this.visible = !this.visible;
    this.root.classList.toggle('hints--off', !this.visible);
  }

  /** @param {boolean} visible */
  setVisible(visible) {
    this.visible = visible;
    this.root.classList.toggle('hints--off', !visible);
  }
}
