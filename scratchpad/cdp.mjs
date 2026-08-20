#!/usr/bin/env node
/**
 * Minimal Chrome DevTools Protocol client (no npm deps).
 * Used by scripts/visual-regression.mjs for headless pixel checks.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'google-chrome',
  'chromium',
  'chromium-browser',
].filter(Boolean);

export function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (p.includes('/') && existsSync(p)) return p;
  }
  return CHROME_CANDIDATES.find(p => !p.includes('/')) ?? null;
}

let nextId = 1;

export class CdpSession {
  constructor(ws) {
    this._ws = ws;
    this._pending = new Map();
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id == null) return;
      const entry = this._pending.get(msg.id);
      if (!entry) return;
      this._pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    });
  }

  send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this._ws.close();
  }
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.gpu] Use the real GPU (ANGLE) instead of SwiftShader.
 *   Software rasterisation antialiases differently, so any image-quality metric
 *   has to be taken on hardware to mean anything.
 */
export async function launchChrome({ port, width = 1280, height = 720, gpu = false } = {}) {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome/Chromium not found — set CHROME_PATH');

  const dbgPort = port ?? 9300 + Math.floor(Math.random() * 500);

  const userDataDir = `/tmp/hr-cdp-${createHash('sha1').update(randomBytes(8)).digest('hex').slice(0, 8)}`;
  const args = [
    '--headless=new',
    `--remote-debugging-port=${dbgPort}`,
    `--window-size=${width},${height}`,
    ...(gpu
      ? ['--use-angle=metal', '--enable-gpu-rasterization']
      : ['--enable-unsafe-swiftshader']),
    '--ignore-gpu-blocklist',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ];

  const proc = spawn(chrome, args, { stdio: 'ignore' });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${dbgPort}/json/version`);
      if (!res.ok) throw new Error(String(res.status));
      await res.json();
      const pages = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
      const page = pages.find(t => t.type === 'page') ?? pages[0];
      if (!page?.webSocketDebuggerUrl) throw new Error('no page target');
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
      });
      const cdp = new CdpSession(ws);
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      return { cdp, proc, port: dbgPort };
    } catch {
      await new Promise(r => setTimeout(r, 120));
    }
  }
  proc.kill();
  throw new Error('Chrome CDP did not become ready');
}

/** Decode 8-bit RGBA PNG (filter type 0 only — Chrome screenshots). */
export function pngToRgba(pngBuffer) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (pngBuffer[i] !== sig[i]) throw new Error('not a PNG');
  }
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  let p = 8;
  while (p < pngBuffer.length) {
    const len = pngBuffer.readUInt32BE(p); p += 4;
    const type = pngBuffer.toString('ascii', p, p + 4); p += 4;
    const data = pngBuffer.subarray(p, p + len); p += len; p += 4;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported PNG ${bitDepth}-bit colorType ${colorType}`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const px = colorType === 6 ? 4 : 3;
  const stride = width * px;
  const filtered = unfilterPng(raw, width, height, px);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const si = y * stride + x * px;
      const di = (y * width + x) * 4;
      out[di] = filtered[si];
      out[di + 1] = filtered[si + 1];
      out[di + 2] = filtered[si + 2];
      out[di + 3] = colorType === 6 ? filtered[si + 3] : 255;
    }
  }
  return { rgba: out, width, height };
}

function unfilterPng(raw, width, height, px) {
  const stride = width * px;
  const out = new Uint8Array(height * stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    for (let i = 0; i < stride; i++) {
      const x = raw[src++];
      const left = i >= px ? out[y * stride + i - px] : 0;
      const up = y > 0 ? out[(y - 1) * stride + i] : 0;
      const upLeft = (y > 0 && i >= px) ? out[(y - 1) * stride + i - px] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = (x + left) & 255; break;
        case 2: v = (x + up) & 255; break;
        case 3: v = (x + Math.floor((left + up) / 2)) & 255; break;
        case 4: {
          const p = left + up - upLeft;
          const pr = Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - upLeft)
            ? left
            : Math.abs(p - up) <= Math.abs(p - upLeft) ? up : upLeft;
          v = (x + pr) & 255;
          break;
        }
        default: throw new Error(`PNG filter ${filter} not supported`);
      }
      out[y * stride + i] = v;
    }
  }
  return out;
}

export async function captureScreenshot(cdp) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  return pngToRgba(Buffer.from(data, 'base64'));
}

export async function navigateAndSettle(cdp, url, ms = 3500) {
  await cdp.send('Page.navigate', { url });
  await new Promise(r => setTimeout(r, ms));
}
