/**
 * The start-light gantry, drawn from the pure sequence state in
 * js/race/startLights.js. Five lamps, top centre, in the HUD's own visual
 * language; a JUMP START verdict replaces the lamps when the sequence is
 * broken early.
 */
const LIGHTS_CSS = `
.startlights {
  position: absolute;
  top: 96px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 150;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: rgba(9, 11, 15, 0.78);
  border: 1px solid rgba(163, 186, 219, 0.26);
  box-shadow: inset 0 1px 0 rgba(214, 232, 255, 0.13);
  backdrop-filter: blur(14px) saturate(115%);
  -webkit-backdrop-filter: blur(14px) saturate(115%);
  clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
  transition: opacity 260ms ease;
}
.startlights--off { opacity: 0; }
.startlights__row { display: flex; gap: 10px; }
.startlights__lamp {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #1c1417;
  border: 1px solid rgba(163, 186, 219, 0.22);
  transition: background 80ms linear, box-shadow 80ms linear;
}
.startlights__lamp--lit {
  background: #e01818;
  box-shadow: 0 0 14px 3px rgba(224, 24, 24, 0.55);
}
.startlights__verdict {
  font-family: ui-monospace, "SF Mono", "Roboto Mono", Menlo, Consolas, monospace;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #ff5a3c;
  display: none;
}
.startlights--jump .startlights__verdict { display: block; }
@media (prefers-reduced-motion: reduce) {
  .startlights { transition: none; }
}
`;

let styleInjected = false;

function injectStyleOnce() {
  if (styleInjected) return;
  styleInjected = true;
  const el = document.createElement('style');
  el.textContent = LIGHTS_CSS;
  document.head.appendChild(el);
}

export class StartLightsHud {
  /** @param {HTMLElement} container */
  constructor(container) {
    injectStyleOnce();

    this.root = document.createElement('div');
    this.root.className = 'startlights';
    this.root.setAttribute('aria-hidden', 'true');

    const row = document.createElement('div');
    row.className = 'startlights__row';
    this._lamps = [];
    for (let i = 0; i < 5; i++) {
      const lamp = document.createElement('div');
      lamp.className = 'startlights__lamp';
      this._lamps.push(lamp);
      row.appendChild(lamp);
    }
    this.root.appendChild(row);

    this._verdict = document.createElement('div');
    this._verdict.className = 'startlights__verdict';
    this._verdict.textContent = 'Jump start';
    this.root.appendChild(this._verdict);

    container.appendChild(this.root);
  }

  /** @param {{ phase: string, lit: number }} state from advanceStartLights */
  update(state) {
    this.root.classList.toggle('startlights--off', state.phase === 'done');
    this.root.classList.toggle('startlights--jump', state.phase === 'jump');
    for (let i = 0; i < 5; i++) {
      this._lamps[i].classList.toggle('startlights__lamp--lit', i < state.lit);
    }
  }
}
