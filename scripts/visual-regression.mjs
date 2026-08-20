#!/usr/bin/env node
/**
 * Phase 0.2 regression guard — samples the live frame via CDP screenshot.
 * Requires Chrome and a local server (started automatically).
 *
 * Usage:
 *   npm run test:visual
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  launchChrome, navigateAndSettle, captureScreenshot, findChrome,
} from '../scratchpad/cdp.mjs';
import {
  LUMINANCE_FLOOR, sampleMeanLuminance, allSamplesAboveFloor,
} from '../js/render/luminance.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_URL = 'http://127.0.0.1:8000/';
// Upper canvas — avoids stats (top-left) and the solid fog/sky strip.
const SAMPLE_POINTS = [
  [0.5, 0.48], [0.38, 0.52], [0.62, 0.52], [0.45, 0.45], [0.55, 0.55],
];

async function waitForRacer(cdp, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'Boolean(window.racer && window.racer.renderer && window.racer.track)',
      returnByValue: true,
    });
    if (result?.value) return;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('HelloRacer did not boot (window.racer missing)');
}

async function main() {
  if (!findChrome()) {
    console.log('skip: Chrome not found (set CHROME_PATH)');
    process.exit(0);
  }

  const server = spawn('python3', ['server.py'], { cwd: root, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 400));

  let chromeProc;
  try {
    const { cdp, proc } = await launchChrome({ width: 1280, height: 720 });
    chromeProc = proc;
    await navigateAndSettle(cdp, PAGE_URL, 500);
    await waitForRacer(cdp);
    await new Promise(r => setTimeout(r, 1500));
    const { rgba, width, height } = await captureScreenshot(cdp);
    cdp.close();

    const mean = sampleMeanLuminance(rgba, width, height, SAMPLE_POINTS);
    const ok = allSamplesAboveFloor(rgba, width, height, SAMPLE_POINTS, LUMINANCE_FLOOR)
      && mean >= 35 && mean < 250;

    console.log(`visual-regression: mean=${mean.toFixed(1)} floor=${LUMINANCE_FLOOR} pass=${ok}`);

    if (!ok) {
      console.error('luminance guard failed — scene may be too dark');
      process.exit(1);
    }
  } finally {
    server.kill();
    chromeProc?.kill();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
