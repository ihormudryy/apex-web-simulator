/**
 * Renderer factory. Default boot uses WebGPU (three.webgpu.js) unless the
 * user opted into WebGL via `?renderer=webgl` or localStorage preference.
 * Preference cannot hot-swap Three builds — toggle saves + reloads (see index.html).
 */

export const RENDERER_PREF_KEY = 'helloracer.renderer';

/**
 * @param {string} [search]
 * @param {'webgl' | 'webgpu' | null} [stored]
 * @returns {'webgl' | 'webgpu'}
 */
export function parseRendererMode(search = '', stored = null) {
  const param = new URLSearchParams(search).get('renderer');
  if (param === 'webgpu' || param === 'webgl') return param;
  if (stored === 'webgpu' || stored === 'webgl') return stored;
  return 'webgpu';
}

/**
 * @param {Pick<Storage, 'getItem'> | null | undefined} [storage]
 * @returns {'webgl' | 'webgpu' | null}
 */
export function readStoredRendererPreference(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem?.(RENDERER_PREF_KEY);
    if (value === 'webgpu' || value === 'webgl') return value;
  } catch {
    /* private mode / denied */
  }
  return null;
}

/**
 * @param {'webgl' | 'webgpu'} mode
 * @param {Pick<Storage, 'setItem'> | null | undefined} [storage]
 */
export function writeStoredRendererPreference(mode, storage = globalThis.localStorage) {
  if (mode !== 'webgpu' && mode !== 'webgl') return;
  try {
    storage?.setItem?.(RENDERER_PREF_KEY, mode);
  } catch {
    /* private mode / denied */
  }
}

/**
 * @param {{ search?: string, storage?: Pick<Storage, 'getItem'> | null }} [opts]
 * @returns {'webgl' | 'webgpu'}
 */
export function resolveRendererMode({ search = '', storage } = {}) {
  const stored = storage === undefined
    ? readStoredRendererPreference()
    : readStoredRendererPreference(storage);
  return parseRendererMode(search, stored);
}

export function wantsWebGpuRenderer() {
  if (typeof location === 'undefined') return true;
  return resolveRendererMode({ search: location.search }) === 'webgpu';
}

/**
 * Persist preference and reload so the import map / Three build match.
 * Updates or clears a conflicting `?renderer=` query so the choice sticks.
 * @param {'webgl' | 'webgpu'} mode
 * @param {{ storage?: Pick<Storage, 'setItem'>, assign?: (url: string) => void, href?: string }} [opts]
 */
export function setRendererPreferenceAndReload(mode, opts = {}) {
  if (mode !== 'webgpu' && mode !== 'webgl') return;
  writeStoredRendererPreference(mode, opts.storage);
  const href = opts.href ?? (typeof location !== 'undefined' ? location.href : '');
  const url = new URL(href, 'http://localhost');
  url.searchParams.set('renderer', mode);
  const next = `${url.pathname}${url.search}${url.hash}`;
  const assign = opts.assign ?? ((target) => {
    location.assign(target);
  });
  assign(next);
}

function configureRenderer(renderer, THREE) {
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  if (renderer.shadowMap) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
  }
}

/**
 * @returns {Promise<{ renderer, backend: 'webgl'|'webgpu', useCsm: boolean, useComposer: boolean, useRenderPipeline: boolean }>}
 */
export async function createRendererBackend(THREE, { antialias = true } = {}) {
  if (wantsWebGpuRenderer()) {
    const renderer = new THREE.WebGPURenderer({ antialias, forceWebGL: false });
    await renderer.init();
    configureRenderer(renderer, THREE);
    const onWebGl = renderer.backend?.isWebGLBackend === true;
    console.info(
      `[HelloRacer] WebGPURenderer (${onWebGl ? 'WebGL2 fallback' : 'WebGPU backend'}) — CSMShadowNode + TSL GTAO`,
    );
    return {
      renderer,
      backend: 'webgpu',
      useCsm: true,
      useComposer: false,
      useRenderPipeline: true,
    };
  }

  const renderer = new THREE.WebGLRenderer({ antialias });
  configureRenderer(renderer, THREE);
  return {
    renderer,
    backend: 'webgl',
    useCsm: true,
    useComposer: true,
    useRenderPipeline: false,
  };
}
