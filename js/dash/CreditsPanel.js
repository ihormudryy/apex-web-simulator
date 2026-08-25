/**
 * On-screen attribution: a permanent one-line credit, and the full list behind
 * it.
 *
 * The short line is the part that satisfies ODbL — it names OpenStreetMap and
 * its licence without the player opening anything. The expanded list is the
 * "credits screen" the OSMF Attribution Guidelines allow for the rest.
 *
 * Bottom-right, because bottom-left is the control hints and the dashboard owns
 * the middle. It follows `H` like the rest of the HUD: hiding the interface for
 * a clean screenshot is a deliberate act by the person doing it, and the
 * credits are still in the README and one keypress away.
 */

import { CREDITS, SHORT_ATTRIBUTION } from './creditsData.js';

const CREDITS_CSS = `
.credits {
  position: absolute;
  right: 14px;
  bottom: 14px;
  z-index: 150;
  font-family: ui-monospace, "SF Mono", "Roboto Mono", Menlo, Consolas, monospace;
  font-size: 10px;
  line-height: 1.55;
  letter-spacing: 0.05em;
  color: #7b8798;
  text-align: right;
  transition: opacity 180ms ease, transform 180ms ease;
}
.credits.credits--off {
  opacity: 0;
  transform: translateY(8px);
  pointer-events: none;
}
.credits__line {
  background: rgba(9, 11, 15, 0.78);
  border: 1px solid rgba(163, 186, 219, 0.26);
  box-shadow: inset 0 1px 0 rgba(214, 232, 255, 0.13);
  backdrop-filter: blur(14px) saturate(115%);
  -webkit-backdrop-filter: blur(14px) saturate(115%);
  padding: 7px 10px;
  clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px));
}
.credits__toggle {
  appearance: none;
  background: none;
  border: none;
  margin: 0 0 0 8px;
  padding: 0;
  font: inherit;
  letter-spacing: inherit;
  color: #e9eff8;
  text-transform: uppercase;
  cursor: pointer;
}
.credits__toggle:hover, .credits__toggle:focus-visible { color: #fff; }
.credits__list {
  display: none;
  margin-bottom: 6px;
  max-width: min(78vw, 460px);
  background: rgba(9, 11, 15, 0.86);
  border: 1px solid rgba(163, 186, 219, 0.26);
  backdrop-filter: blur(14px) saturate(115%);
  -webkit-backdrop-filter: blur(14px) saturate(115%);
  padding: 10px 12px;
  clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px));
}
.credits__list.credits__list--open { display: block; }
.credits__row { white-space: normal; }
.credits__what { color: #e9eff8; }
.credits a { color: #7b8798; text-decoration: underline; }
.credits a:hover, .credits a:focus-visible { color: #e9eff8; }
@media (prefers-reduced-motion: reduce) {
  .credits { transition: none; }
}
`;

let styleInjected = false;

function injectStyleOnce() {
  if (styleInjected) return;
  styleInjected = true;
  const el = document.createElement('style');
  el.textContent = CREDITS_CSS;
  document.head.appendChild(el);
}

/** @param {string} tag @param {string} [className] @param {string} [text] */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export class CreditsPanel {
  /** @param {HTMLElement} container */
  constructor(container) {
    this.visible = true;
    this.open = false;
    injectStyleOnce();

    this.root = el('div', 'credits');

    this._list = el('div', 'credits__list');
    for (const c of CREDITS) {
      const row = el('div', 'credits__row');
      row.append(el('span', 'credits__what', `${c.what}: `));
      const link = el('a', null, `${c.source} (${c.licence})`);
      link.href = c.url;
      link.target = '_blank';
      // Third-party target="_blank" without this hands the opener to the tab.
      link.rel = 'noopener noreferrer';
      row.append(link);
      this._list.append(row);
    }

    const line = el('div', 'credits__line');
    const osm = el('a', null, SHORT_ATTRIBUTION);
    osm.href = 'https://www.openstreetmap.org/copyright';
    osm.target = '_blank';
    osm.rel = 'noopener noreferrer';
    line.append(osm);

    // An explicit separator, not just the button's margin: without it the
    // accessibility tree reads the two runs together as "ODbLcredits".
    line.append(document.createTextNode(' · '));
    this._toggle = el('button', 'credits__toggle', 'credits');
    this._toggle.type = 'button';
    this._toggle.setAttribute('aria-expanded', 'false');
    this._toggle.addEventListener('click', () => this.toggleOpen());
    line.append(this._toggle);

    this.root.append(this._list, line);
    container.appendChild(this.root);
  }

  toggleOpen() {
    this.open = !this.open;
    this._list.classList.toggle('credits__list--open', this.open);
    this._toggle.setAttribute('aria-expanded', String(this.open));
  }

  /** @param {boolean} visible */
  setVisible(visible) {
    this.visible = visible;
    this.root.classList.toggle('credits--off', !visible);
    // Collapse on hide, or the list reappears expanded over the next screenshot.
    if (!visible && this.open) this.toggleOpen();
  }
}
