/**
 * Renderer factory. Default boot uses WebGLRenderer + three.module.js.
 * `?renderer=webgpu` loads three.webgpu.js first (see index.html) so textures
 * and WebGPURenderer share one namespace.
 */

export function parseRendererMode(search = '') {
  return new URLSearchParams(search).get('renderer') === 'webgpu' ? 'webgpu' : 'webgl';
}

export function wantsWebGpuRenderer() {
  if (typeof location === 'undefined') return false;
  return parseRendererMode(location.search) === 'webgpu';
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
