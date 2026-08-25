# Apex Web Simulator

Browser open-wheel racing prototype: four-corner physics, WebGPU rendering (WebGL fallback), and optional user mods via drag-and-drop `.glb` / `.gltf`.

**Play:** [https://ihormudryy.github.io/apex-web-simulator/](https://ihormudryy.github.io/apex-web-simulator/)

## Disclaimer

This project is an **independent fan/engineering demo**. It is **not** affiliated with, endorsed by, or connected to Formula One, Formula One Licensing B.V., Silverstone Circuits Limited, or any team, circuit operator, or sponsor.

The bundled track is a **generic procedural layout** labelled *Northamptonshire Circuit* — not an official track map or trademarked venue name. The default car meshes are **placeholder art** from the original HelloRacer demo; replace them with your own models if you ship publicly.

**Custom mods are your responsibility.** Only upload 3D assets you have the rights to use.

## Controls

| Key | Action |
|-----|--------|
| W / ↑ | Throttle |
| S / ↓ | Brake / reverse |
| A / D | Steer |
| Esc / Reset | Return to grid |
| C | Camera mode |
| H | Hide HUD |
| + / − | Rear camera zoom |
| 1–3, T, G | Render FX toggles (see Render panel) |

## Mods / car catalog

Use the **Car** panel (top-right) to pick a shell. The bundled **Ferrari** is the
default. Mercedes W14 and AMR23 load from `obj/cars/` — see
[obj/cars/README.md](obj/cars/README.md) for the Sketchfab zip layout.

You can also drag a `.glb` / `.gltf` onto the page:

- **Car-shaped** files replace the default body shell (wheels and physics stay on the built-in rig).
- **Large flat** files are treated as scenery and added beside the procedural track.

Only use assets you have rights to. Team liveries are not official F1 content.

## Local development

```bash
python3 server.py
# open http://localhost:8000
```

Run tests:

```bash
npm test
```

## Renderer

WebGPU is the default. Use `?renderer=webgl` or the **Render → WebGPU** toggle (reloads) to switch backends.

## License

MIT — see [LICENSE](LICENSE). This covers the code. The world is built from
third-party data and assets under their own licences; see Credits.

## Credits and data attribution

The circuit geometry is derived from open survey data, and crediting it is a
licence obligation rather than a courtesy. The same list is shown in-app,
bottom-right.

> Map data © OpenStreetMap contributors, ODbL

| Part | Source | Licence |
|---|---|---|
| Circuit centerline and track widths | [TUMFTM racetrack-database](https://github.com/TUMFTM/racetrack-database) | LGPL-3.0 |
| Survey traces underlying that centerline | [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) | ODbL |
| Georeferencing cross-check for the grid | [bacinger/f1-circuits](https://github.com/bacinger/f1-circuits) | MIT |
| Sky HDRI, grass normal and roughness maps | [Poly Haven](https://polyhaven.com) | CC0 |
| Placeholder car and driver meshes | [HelloRacer WebGL demo](https://helloracer.com/webgl/) | Demo art — replace before shipping publicly |
| Renderer | [three.js](https://threejs.org) | MIT |

The TUMFTM centerline is fetched from OpenStreetMap traces, so it is arguably an
ODbL derivative regardless of its LGPL label — OpenStreetMap is credited on both
counts. The rendered scene is a *Produced Work* under ODbL, so attribution and a
licence notice are what is required; share-alike attaches to derivative
*databases*, and `js/track/silverstoneSurvey.js` — the extracted centerline —
stays open in this repo. Its header carries the full provenance, including the
pinned upstream commit and every transformation applied.

`obj/cars/` shells are user-supplied CC-BY assets and are gitignored; attribute
them yourself if you redistribute a build that includes them.

## Livery

The default body texture uses **fictional** “Apex Racing” sponsor art (midnight blue / orange). To regenerate it from a local legacy UV mask (kept out of git):

```bash
npm run assets:livery
```

Place the old map at `obj/textures/BodyPaint.legacy.jpg` only on your machine if you need to re-run the script; never commit that file.
