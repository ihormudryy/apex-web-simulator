#!/usr/bin/env node
/**
 * Rendering quality dashboard — the visual counterpart to `npm run validate`.
 *
 *   npm run validate:visual
 *
 * Measured on the real GPU, because SwiftShader rasterises and filters
 * differently and any image-quality number taken on it is meaningless.
 *
 * The headline metric is **sub-pixel instability**. Aliasing is, by definition,
 * an image that changes a lot when the sampling grid moves a fraction of a pixel,
 * so the frame is captured twice — once normally, once with the projection
 * jittered half a pixel via `Camera.setViewOffset`, which is exactly how temporal
 * antialiasing jitters. A well-filtered image barely moves; an aliased one shifts
 * hard along every thin edge, and this scene is almost entirely thin edges: kerb
 * stripes, 0.14 m centre-line dashes, barrier rails, wing elements, grass blades.
 *
 * The grass wind is stopped before capturing, or real motion would swamp the
 * comparison.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { launchChrome, findChrome } from '../scratchpad/cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const C = { pass: '\x1b[32m', off: '\x1b[33m', dim: '\x1b[2m', end: '\x1b[0m' };
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

/** Full PNG decoder — all five filter types, unlike the filter-0 helper. */
function decodePng(buf) {
  let pos = 8;
  let width = 0; let height = 0; let colour = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') {
      width = buf.readUInt32BE(pos + 8);
      height = buf.readUInt32BE(pos + 12);
      colour = buf[pos + 17];
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(pos + 8, pos + 8 + len));
    }
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const ch = colour === 6 ? 4 : 3;
  const stride = width * ch;
  const out = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c); const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
  }
  return { data: out, width, height, ch };
}

const lum = (d, o) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];

function analyse(a, b) {
  const { data: A, width: w, height: h, ch } = a;
  const B = b.data;
  const y0 = Math.round(h * 0.28);   // below the dashboard overlay
  const y1 = Math.round(h * 0.98);
  const diffs = []; const lums = []; const sats = [];
  // Five horizontal bands, so the report can say *where* the instability is
  // rather than only how much. Guessing at the culprit already cost one wrong fix.
  const BANDS = 5;
  const band = new Float64Array(BANDS);
  const bandN = new Float64Array(BANDS);
  let edges = 0; let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * ch;
      let d = 0;
      for (let k = 0; k < 3; k++) d += Math.abs(A[o + k] - B[o + k]);
      diffs.push(d / 3);
      const bi = Math.min(BANDS - 1, Math.floor(((y - y0) / (y1 - y0)) * BANDS));
      band[bi] += d / 3;
      bandN[bi] += 1;
      const L = lum(A, o);
      lums.push(L);
      const mx = Math.max(A[o], A[o + 1], A[o + 2]);
      const mn = Math.min(A[o], A[o + 1], A[o + 2]);
      if (mx > 10) sats.push((mx - mn) / mx);
      if (x > 0 && x < w - 1 && y > y0 && y < y1 - 1) {
        const lap = Math.abs(4 * L
          - lum(A, o - ch) - lum(A, o + ch)
          - lum(A, o - w * ch) - lum(A, o + w * ch));
        if (lap > 24) edges++;
        n++;
      }
    }
  }
  const mean = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
  const q = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s[Math.floor(p * s.length)]; };
  return {
    instability: mean(diffs),
    instabilityP99: q(diffs, 0.99),
    edgeFraction: (100 * edges) / n,
    meanLuma: mean(lums),
    clipped: (100 * lums.filter(v => v >= 250).length) / lums.length,
    crushed: (100 * lums.filter(v => v <= 5).length) / lums.length,
    contrast: q(lums, 0.95) - q(lums, 0.05),
    saturation: mean(sats),
    bands: [...band].map((v, i) => v / bandN[i]),
  };
}

/**
 * Judgement calls, written down so they can be argued with. The instability
 * figures come from what this scene measures with and without a half-pixel
 * jitter; the exposure and saturation bands are the ranges outside which a frame
 * reads as broken rather than as a choice.
 */
const TARGETS = [
  ['sub-pixel instability', 'instability', 4.0, 'max', '/255 mean'],
  ['worst-case edge crawl', 'instabilityP99', 32, 'max', '/255 p99'],
  ['high-frequency detail', 'edgeFraction', 6.0, 'max', '% of pixels'],
  ['mean luminance', 'meanLuma', [85, 175], 'band', '/255'],
  ['clipped highlights', 'clipped', 1.5, 'max', '%'],
  ['crushed shadows', 'crushed', 2.0, 'max', '%'],
  ['contrast (p95-p5)', 'contrast', 90, 'min', '/255'],
  ['mean saturation', 'saturation', [0.08, 0.34], 'band', '0-1'],
];

async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'eval failed');
  return result?.value;
}

async function shoot(cdp) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  return decodePng(Buffer.from(data, 'base64'));
}

async function main() {
  if (!findChrome()) {
    console.log('skip: Chrome not found (set CHROME_PATH)');
    process.exit(0);
  }
  const server = spawn('python3', ['server.py'], { cwd: root, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 500));

  let proc;
  try {
    const launched = await launchChrome({ width: 1280, height: 800, gpu: true });
    proc = launched.proc;
    const { cdp } = launched;
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8000/' });

    const booted = await evaluate(cdp, `(async () => {
      const end = performance.now() + 40000;
      while (performance.now() < end) {
        if (window.racer?.track && window.racer?.renderer) return true;
        await new Promise(r => setTimeout(r, 150));
      }
      return false;
    })()`);
    if (!booted) throw new Error('HelloRacer did not boot');
    await new Promise(r => setTimeout(r, 3500));

    const gpu = await evaluate(cdp, `(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
    })()`);

    // Stop the grass moving, or real motion dominates the jitter comparison.
    const stilled = await evaluate(cdp, `(() => {
      let n = 0;
      window.racer.scene.traverse(o => {
        const u = o.material?.userData?.windUniforms;
        if (u && u.uWindAmp && 'value' in u.uWindAmp) { u.uWindAmp.value = 0; n++; }
      });
      return n;
    })()`);
    await new Promise(r => setTimeout(r, 600));

    const a = await shoot(cdp);
    await evaluate(cdp, `(() => {
      const c = window.racer.camera;
      c.setViewOffset(innerWidth, innerHeight, 0.5, 0.5, innerWidth, innerHeight);
      c.updateProjectionMatrix();
      return 1;
    })()`);
    await new Promise(r => setTimeout(r, 600));
    const b = await shoot(cdp);
    await evaluate(cdp, `(() => { window.racer.camera.clearViewOffset(); return 1; })()`);
    cdp.close();

    const m = analyse(a, b);

    console.log(`\n  Rendering quality — ${a.width}x${a.height} on ${gpu}`);
    console.log(`  ${C.dim}grass wind stopped on ${stilled} material(s) before capture${C.end}`);
    console.log(`  ${C.dim}${'-'.repeat(68)}${C.end}`);
    console.log(`  ${C.dim}${pad('metric', 26)}${padL('measured', 10)}${padL('target', 14)}${C.end}`);

    let passes = 0;
    for (const [label, key, target, kind, unit] of TARGETS) {
      const v = m[key];
      const ok = kind === 'max' ? v <= target
        : kind === 'min' ? v >= target
          : v >= target[0] && v <= target[1];
      if (ok) passes++;
      const shown = kind === 'band' ? `${target[0]}-${target[1]}`
        : `${kind === 'max' ? '<=' : '>='} ${target}`;
      console.log(
        `  ${pad(label, 26)}${padL(v.toFixed(2), 10)}${padL(shown, 14)}  `
        + `${ok ? C.pass : C.off}${ok ? 'ok' : 'off'}${C.end} ${C.dim}${unit}${C.end}`,
      );
    }
    console.log(`\n  ${passes}/${TARGETS.length} within target`);
    const labels = ['horizon', 'far track', 'mid track', 'near track', 'foreground'];
    console.log(`\n  ${C.dim}where the instability is (mean diff by band, top to bottom)${C.end}`);
    const worst = Math.max(...m.bands);
    m.bands.forEach((v, i) => {
      const bar = '#'.repeat(Math.round((v / worst) * 34));
      console.log(`  ${pad(labels[i], 12)}${padL(v.toFixed(2), 7)}  ${v === worst ? C.off : C.dim}${bar}${C.end}`);
    });
    console.log('');
  } finally {
    server.kill();
    proc?.kill();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
