/**
 * Node's counterpart to the page importmap.
 *
 * The renderer modules import the bare specifier `three`, which the browser
 * resolves through index.html's importmap. Node has no importmap, so the test
 * runner is started with `--import` pointing here, and this registers a
 * resolver that maps `three` to the vendored copy in test/vendor/three — the
 * same pinned build the page loads from the CDN (a test asserts the versions
 * agree). That is what lets the scene-graph tests construct the REAL Car and
 * measure world transforms instead of re-deriving them.
 */
import { register } from 'node:module';

register('./three-test-resolver.mjs', import.meta.url);
