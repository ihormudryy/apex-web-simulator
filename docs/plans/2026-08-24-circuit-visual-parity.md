# Circuit visual parity program (WebGPU desktop)

Date: 2026-08-24  
Status: in progress — Phases A–D visual path shipped except rivals / pits

## Goal

Approach the permanent-circuit / finish-line reference look in-browser on desktop WebGPU, with highest practical image quality and playable frame times.

## Shipped

### Phase A — Hardscape
- Concrete Jersey barriers (procedural PBR, trapezoid profile)
- Grass verge strip against the wall
- Secondary Armco rail outside Jersey
- Finish gantry (truss + FINISH board) at start/finish
- Checkered finish stripe

### Phase B — World depth
- Denser near/far tree rings + grandstand billboards
- Mountain / ridge backdrop with aerial tint
- Overcast lighting preset (softer sun, higher fill)

### Phase C — Atmosphere
- Softer, longer tyre-smoke envelopes + larger WebGPU sprites

### Phase D — Experience
- Finish broadcast camera (`C` cycles: chase → driver → front → finish)
- Quality presets Ultra / High / Balanced (`Q` to cycle; pauses auto)
- Auto frame-time quality scaler (drops/climbs presets around 60 fps)
- Soft particle depth fade vs scene depth (WebGPU viewport depth; WebGL last-frame harvest)

## Remaining

- AI / multi-car rivals with distinct liveries (ghost can stand in for now)
- Pit building block geometry (stands are billboards only)

## Controls

| Key | Action |
|-----|--------|
| C | Cycle camera (includes finish) |
| Q | Cycle quality preset (pauses auto) |
| T | TAA |
| G | Grade |
