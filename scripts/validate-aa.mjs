#!/usr/bin/env node
/**
 * Antialiasing, measured against ground truth.
 *
 *   npm run validate:aa
 *
 * The existing rendering dashboard's headline metric is **sub-pixel
 * instability** — how much the frame changes when the sampling grid moves half a
 * pixel — and it is the right metric for finding aliasing. It is the wrong metric
 * for choosing between antialiasing methods, because **a blurred image also barely
 * changes**. Optimising against it rewards blur, and this script exists because
 * that is exactly what happened: a temporal AA pass took instability from 3.80 to
 * 1.60 and worst-case edge crawl from 46 to 19, every target went green, and the
 * image was worse.
 *
 * So: render the same frame at 3x resolution with no temporal accumulation,
 * box-downsample it, and call that the truth. Then measure how far each candidate
 * sits from it. Neither failure mode can hide — an aliased image is far from a
 * clean reference, and so is a blurred one.
 *
 * Requires Chrome and the real GPU, for the same reason validate-visual does:
 * SwiftShader filters differently and any number from it is fiction.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, findChrome, navigateAndSettle, pngToRgba } from '../scratchpad/cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'http://127.0.0.1:8000/';
const SUPERSAMPLE = 3;
const C = { pass: '\x1b[32m', off: '\x1b[33m', dim: '\x1b[2m', end: '\x1b[0m' };

const shoot = async cdp => {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  return pngToRgba(Buffer.from(data, 'base64'));
};

/** Box-downsample by an integer factor, to float RGB. */
function downsample({ rgba, width, height }, f) {
  const w = Math.floor(width / f);
  const h = Math.floor(height / f);
  const data = new Float64Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const o = ((y * f + dy) * width + (x * f + dx)) * 4;
          r += rgba[o];
          g += rgba[o + 1];
          b += rgba[o + 2];
        }
      }
      const n = f * f;
      const i = (y * w + x) * 3;
      data[i] = r / n;
      data[i + 1] = g / n;
      data[i + 2] = b / n;
    }
  }
  return { data, width: w, height: h };
}

function asFloat({ rgba, width, height }) {
  const data = new Float64Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    data[i * 3] = rgba[i * 4];
    data[i * 3 + 1] = rgba[i * 4 + 1];
    data[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return { data, width, height };
}

/** RMS difference over the part of the frame that is scene rather than overlay. */
function rms(a, b) {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const y0 = Math.round(h * 0.30);
  const y1 = Math.round(h * 0.98);
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < 3; k++) {
        const d = a.data[(y * a.width + x) * 3 + k] - b.data[(y * b.width + x) * 3 + k];
        sum += d * d;
        n++;
      }
    }
  }
  return Math.sqrt(sum / n);
}

const evaluate = async (cdp, expression) => {
  const { result } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true });
  return result.value;
};

async function main() {
  if (!findChrome()) {
    console.error('Chrome not found — this measurement needs the real GPU.');
    process.exit(1);
  }
  const server = spawn('python3', ['server.py'], { cwd: root, stdio: 'ignore', detached: true });
  await new Promise(r => setTimeout(r, 1200));
  let chrome;
  try {
    chrome = await launchChrome({ port: 9366, width: 1280, height: 720, gpu: true });
    const cdp = chrome.cdp;
    await navigateAndSettle(cdp, PAGE, 7000);

    // Stop the grass, and freeze the camera. The chase camera exp-lerps toward a
    // target forever, so even a parked car leaves it micro-moving — and a
    // reference frame is only a reference if it is the same frame twice.
    await evaluate(cdp, `(() => {
      window.racer.scene.traverse(o => {
        const u = o.material?.userData?.windUniforms;
        if (u && u.uWindAmp) u.uWindAmp.value = 0;
      });
      window.racer._frozenCam = {
        p: window.racer.camera.position.clone(),
        q: window.racer.camera.quaternion.clone(),
      };
      window.racer._updateCamera = function () {
        this.camera.position.copy(this._frozenCam.p);
        this.camera.quaternion.copy(this._frozenCam.q);
      };
      return 1;
    })()`);
    await new Promise(r => setTimeout(r, 900));

    const scale = async factor => {
      // captureScreenshot returns CSS pixels, so setPixelRatio alone never reaches
      // the capture — the device scale factor has to change with it.
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1280, height: 720, deviceScaleFactor: factor, mobile: false,
      });
      await evaluate(cdp, `(() => {
        window.racer.renderer.setPixelRatio(window.devicePixelRatio);
        window.racer._onResize();
        return 1;
      })()`);
      await new Promise(r => setTimeout(r, 2200));
    };

    const setMode = async ({ samples, taa }) => {
      await evaluate(cdp, `(() => {
        const c = window.racer._composer;
        for (const rt of [c.renderTarget1, c.renderTarget2]) rt.samples = ${samples};
        window.racer._fx.taa = ${taa};
        if (window.racer._taaPass) {
          window.racer._taaPass.enabled = ${taa};
          window.racer._taaPass.reset();
        }
        window.racer._onResize();
        return 1;
      })()`);
      await new Promise(r => setTimeout(r, 2200));
    };

    await setMode({ samples: 4, taa: false });
    await scale(SUPERSAMPLE);
    const truth = downsample(await shoot(cdp), SUPERSAMPLE);
    await scale(1);

    const CANDIDATES = [
      ['no MSAA', { samples: 0, taa: false }],
      ['MSAA 4x', { samples: 4, taa: false }],
      ['MSAA 8x', { samples: 8, taa: false }],
      ['MSAA 4x + TAA', { samples: 4, taa: true }],
      ['MSAA 8x + TAA', { samples: 8, taa: true }],
    ];
    const results = [];
    for (const [label, mode] of CANDIDATES) {
      await setMode(mode);
      results.push([label, rms(asFloat(await shoot(cdp)), truth)]);
    }
    cdp.close();

    const best = Math.min(...results.map(r => r[1]));
    console.log(`\n  Antialiasing against ${SUPERSAMPLE}x supersampled ground truth`);
    console.log(`  ${C.dim}${'-'.repeat(52)}${C.end}`);
    console.log(`  ${C.dim}${'method'.padEnd(20)}${'RMS /255'.padStart(10)}${C.end}`);
    for (const [label, value] of results) {
      const ok = value <= best * 1.02;
      console.log(
        `  ${label.padEnd(20)}${value.toFixed(3).padStart(10)}  `
        + `${ok ? `${C.pass}best${C.end}` : `${C.dim}+${((value / best - 1) * 100).toFixed(0)}%${C.end}`}`,
      );
    }
    console.log(`\n  ${C.dim}lower is better; a blurred image scores as badly as an aliased one${C.end}\n`);
  } finally {
    if (chrome) await chrome.close?.();
    try { process.kill(-server.pid); } catch { /* already gone */ }
  }
}

main().then(() => process.exit(0));
