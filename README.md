# HelloRacer WebGL

Browser F1-style racer built on the HelloRacer demo: Silverstone GP circuit, four-wheel physics, WebGPU rendering with a WebGL fallback.

**Play:** [https://ihormudryy.github.io/helloracer-webgl/](https://ihormudryy.github.io/helloracer-webgl/)

## Controls

| Key | Action |
|-----|--------|
| W / ↑ | Throttle |
| S / ↓ | Brake / reverse |
| A / D | Steer |
| Esc / Reset | Return to grid |
| C | Camera mode |
| H | Hide dashboard |
| 1–3, T, G | Render FX toggles (see Render panel) |

## Local development

```bash
python3 server.py
# open http://localhost:8000
```

Run tests:

```bash
node --test js/**/*.test.js
```

## Renderer

WebGPU is the default. Use `?renderer=webgl` or the **Render → WebGPU** toggle (reloads) to switch backends.
