// Dashboard styling, kept beside the component that injects it.
//
// The palette is the motorsport timing-screen code rather than a decorative one:
// purple is a fastest time, green is an improvement, amber is caution, red is the
// limit. Those colours carry meaning to anyone who has watched a race, so the
// dashboard can say "purple sector" without printing a legend.
//
// The panels are chamfered rather than rounded — smoked perspex in a machined
// bezel, the way instruments are actually mounted, and it keeps the cluster from
// reading as a row of generic cards.

export const DASH_CSS = `
.dash {
  --carbon: rgba(9, 11, 15, 0.78);
  --carbon-well: rgba(0, 0, 0, 0.45);
  --edge: rgba(163, 186, 219, 0.26);
  --edge-bright: rgba(198, 221, 252, 0.46);
  --ice: #e9eff8;
  --slate: #7b8798;
  --slate-dim: #4d5765;
  --purple: #b14bff;
  --green: #35e06b;
  --amber: #ffb020;
  --red: #e8202a;
  --blue: #35b6ff;

  position: absolute;
  left: 0; right: 0; bottom: 0;
  display: flex;
  justify-content: center;
  align-items: flex-end;
  gap: 10px;
  padding: 0 14px 14px;
  z-index: 150;
  /* A readout must never eat the drag-to-orbit controls on the canvas. */
  pointer-events: none;
  font-family: ui-monospace, "SF Mono", "Roboto Mono", Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
  transition: opacity 180ms ease, transform 180ms ease;
}
.dash[hidden] { display: none; }
.dash.dash--off { opacity: 0; transform: translateY(8px); }

.dash__panel {
  position: relative;
  box-sizing: border-box;
  height: 140px;
  display: flex;
  flex-direction: column;
  background: var(--carbon);
  border: 1px solid var(--edge);
  /* A milled highlight along the top edge, the way a bezel catches light. */
  box-shadow: inset 0 1px 0 rgba(214, 232, 255, 0.13);
  backdrop-filter: blur(14px) saturate(115%);
  -webkit-backdrop-filter: blur(14px) saturate(115%);
  padding: 10px 13px 11px;
  /* Chamfered on the diagonal, like a machined instrument surround. */
  clip-path: polygon(14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px);
}
.dash__panel--centre {
  padding: 10px 22px 12px;
  justify-content: center;
  border-color: var(--edge-bright);
}

.dash__label {
  flex: none;
  font-size: 9px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--slate);
  margin-bottom: 6px;
  white-space: nowrap;
}
.dash__row { display: flex; align-items: baseline; gap: 8px; }

/* ---- bars: throttle, brake, steering ---- */
.dash__meter { margin-bottom: 6px; }
.dash__meter:last-child { margin-bottom: 0; }
.dash__meter-head {
  display: flex; justify-content: space-between; align-items: baseline;
  font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--slate); margin-bottom: 3px;
}
.dash__meter-value { color: var(--ice); font-size: 10px; letter-spacing: 0; }
.dash__track {
  position: relative; width: 132px; height: 7px;
  background: var(--carbon-well);
  border: 1px solid var(--edge);
  overflow: hidden;
}
.dash__fill {
  position: absolute; inset: 0;
  transform-origin: left center;
  /* scaleX only, so a 60 Hz update never triggers layout. */
  transform: scaleX(0);
  will-change: transform;
}
.dash__fill--throttle { background: linear-gradient(90deg, #1f9e4a, var(--green)); }
.dash__fill--brake { background: linear-gradient(90deg, #8f1219, var(--red)); }
/* Steering grows from the centre in whichever direction the wheel is turned. */
.dash__fill--steer {
  left: 50%; right: auto; width: 50%;
  transform-origin: left center;
  background: linear-gradient(90deg, var(--blue), #8fd8ff);
}
.dash__centre-tick {
  position: absolute; left: 50%; top: -1px; bottom: -1px;
  width: 1px; background: var(--edge-bright);
}

/* ---- speed and gear ---- */
.dash__lights { display: flex; gap: 3px; justify-content: center; margin-bottom: 7px; }
.dash__led {
  width: 12px; height: 5px;
  background: var(--carbon-well);
  border: 1px solid var(--edge);
}
.dash__led--on { border-color: transparent; }
.dash__speed-row {
  display: flex; align-items: flex-end; justify-content: center; gap: 18px;
}
.dash__stack { display: flex; flex-direction: column; align-items: center; }
.dash__stack--gear { align-items: center; }
.dash__speed {
  font-size: 54px; line-height: 0.84; font-weight: 600;
  color: var(--ice); letter-spacing: -0.03em;
}
.dash__unit {
  font-size: 9px; letter-spacing: 0.18em; color: var(--slate);
  text-transform: uppercase; margin-top: 5px;
}
.dash__gear {
  min-width: 50px; padding: 2px 0; text-align: center;
  border: 1px solid var(--edge-bright);
  background: var(--carbon-well);
  font-size: 32px; line-height: 1.1; font-weight: 600; color: var(--ice);
}
.dash__rpm { font-size: 10px; color: var(--slate); text-align: center; margin-top: 9px; }
.dash__rpm strong { color: var(--ice); font-weight: 500; }

/* ---- traction ---- */
.dash__gmeter { display: block; }
.dash__gfoot {
  display: flex; justify-content: space-between; gap: 10px;
  font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--slate); margin-top: 5px;
}
.dash__gfoot b { color: var(--ice); font-weight: 500; letter-spacing: 0; }

/* ---- timing ---- */
.dash__time { font-size: 21px; color: var(--ice); line-height: 1.15; flex: none; }
.dash__field {
  display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
  font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--slate); margin-top: 4px; flex: none;
}
.dash__delta { font-size: 14px; letter-spacing: 0; }
.dash__delta--up { color: var(--red); }
.dash__delta--down { color: var(--green); }
.dash__delta--none { color: var(--slate-dim); }
.dash__best { font-size: 14px; letter-spacing: 0; color: var(--purple); }
.dash__rule { height: 1px; background: var(--edge); margin: 5px 0; flex: none; }
.dash__spacer { flex: 1 1 auto; }
.dash__sectors { display: flex; gap: 4px; margin-top: 6px; }
.dash__sector {
  flex: 1; height: 4px;
  background: var(--carbon-well);
  border: 1px solid var(--edge);
}
.dash__sector--done { background: var(--green); border-color: transparent; }
.dash__sector--best { background: var(--purple); border-color: transparent; }
.dash__sector--live { background: var(--amber); border-color: transparent; }
.dash__meta {
  display: flex; justify-content: space-between;
  font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--slate); margin-top: 6px;
}

/* ---- circuit ---- */
.dash__mapfoot {
  display: flex; justify-content: space-between; align-items: baseline;
  font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--slate); margin-top: 5px;
}
.dash__surface { color: var(--green); }
.dash__surface--kerb { color: var(--amber); }
.dash__surface--grass { color: var(--red); }

.dash__hint {
  position: absolute; right: 16px; bottom: 4px;
  font-size: 8px; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--slate-dim);
}

@media (max-width: 1080px) {
  .dash { gap: 7px; padding: 0 8px 8px; }
  .dash__panel--optional { display: none; }
  .dash__track { width: 104px; }
  .dash__speed { font-size: 42px; }
  .dash__panel { height: 128px; }
}
@media (max-width: 720px) {
  .dash__panel--compact { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .dash { transition: none; }
}
`;
