/**
 * Renderer factory. Default boot uses WebGPU (three.webgpu.js) unless the
 * user opted into WebGL via `?renderer=webgl` or localStorage preference.
 * Preference cannot hot-swap Three builds — toggle saves + reloads (see index.html).
 */

export const RENDERER_PREF_KEY = 'apex-web-simulator.renderer';
export const LEGACY_RENDERER_PREF_KEY = 'helloracer.renderer';

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
    const value = storage?.getItem?.(RENDERER_PREF_KEY)
      ?? storage?.getItem?.(LEGACY_RENDERER_PREF_KEY);
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

export const DEFAULT_RENDER_SCALE = 1.0;
/** Extra supersample headroom on high-DPR displays (~11 ms frame budget). */
export const MAX_RENDER_SCALE = 1.25;

/** Apply supersampling scale at runtime (Render panel slider). */
export function applyRenderScale(renderer, renderScale = DEFAULT_RENDER_SCALE) {
  const scale = Math.min(MAX_RENDER_SCALE, Math.max(0.75, renderScale));
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2) * scale);
}

function configureRenderer(renderer, THREE, { renderScale = DEFAULT_RENDER_SCALE } = {}) {
  applyRenderScale(renderer, renderScale);
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
 * Sampled-texture headroom we ask the WebGPU device for.
 *
 * WebGPU's default `maxSampledTexturesPerShaderStage` is 16, and the car's
 * paint material alone wants map + roughness + metalness + normal + specular
 * intensity + clearcoat roughness + clearcoat normal + environment. Add the
 * ambient-occlusion texture the full pipeline threads into the material context
 * and the fragment stage asks for 17, one over the line — at which point the
 * bind-group layout is rejected, the pipeline for that material never builds,
 * and the car is drawn *without its bodywork*: sidepods, engine cover and rear
 * wing simply absent whenever AO was switched on.
 *
 * 32 is roughly double the default with room for another map or two, and small
 * enough that most adapters have it (the one measured here reports 48).
 */
const WANTED_SAMPLED_TEXTURES = 32;

/**
 * Ask for more sampled textures per stage, but never more than the adapter
 * advertises: `requestDevice` rejects a limit the adapter cannot meet, and
 * failing to create the renderer at all would be a far worse trade than losing
 * ambient occlusion. Returns undefined when the default is all we can get.
 */
async function webGpuRequiredLimits() {
  try {
    const adapter = await globalThis.navigator?.gpu?.requestAdapter?.();
    const supported = adapter?.limits?.maxSampledTexturesPerShaderStage ?? 0;
    if (supported > 16) {
      return {
        maxSampledTexturesPerShaderStage: Math.min(supported, WANTED_SAMPLED_TEXTURES),
      };
    }
  } catch {
    /* no WebGPU, or the adapter refused — fall through to the defaults */
  }
  return undefined;
}

/**
 * @returns {Promise<{ renderer, backend: 'webgl'|'webgpu', useCsm: boolean, useComposer: boolean, useRenderPipeline: boolean }>}
 */
export async function createRendererBackend(THREE, { antialias = true, renderScale } = {}) {
  if (wantsWebGpuRenderer()) {
    // MSAA is deliberately off here, and `antialias` is ignored on this path.
    // The node pipeline reads the scene depth (TRAA reprojection, DoF circle of
    // confusion, GTAO, SSGI) via `pass.getTextureNode('depth')`, and WebGPU
    // cannot resolve a multisampled depth attachment with a texture copy: with
    // MSAA on, every frame raised
    //   "Source [Texture depth] sample count (4) and destination ... (1) do not
    //    match" -> "[Invalid CommandBuffer ... copyTextureToTexture]"
    // twice a frame (~120/s, measured at default settings), so the depth those
    // passes sampled was never the depth that had just been drawn. TRAA plus
    // the sharpen pass is this path's antialiasing — that is what `hybridAa`
    // means — and it needs valid depth far more than it needs MSAA on top.
    const renderer = new THREE.WebGPURenderer({
      antialias: false,
      forceWebGL: false,
      requiredLimits: await webGpuRequiredLimits(),
    });
    await renderer.init();
    configureRenderer(renderer, THREE, { renderScale });
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
  configureRenderer(renderer, THREE, { renderScale });
  return {
    renderer,
    backend: 'webgl',
    useCsm: true,
    useComposer: true,
    useRenderPipeline: false,
  };
}
