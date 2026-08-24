/**
 * Copy scene depth to a sampleable colour target for the next frame's particles.
 *
 * Soft particles cannot read the depth attachment they are drawing into, so
 * WebGL smoke samples this harvest from the previous frame. One frame of lag
 * is invisible on a drifting plume.
 */

const VERTEX = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAGMENT = /* glsl */`
varying vec2 vUv;
uniform sampler2D tDepth;
void main() {
  gl_FragColor = vec4(texture2D(tDepth, vUv).xxx, 1.0);
}`;

/**
 * @param {typeof import('three')} THREE
 * @param {typeof import('three/addons/postprocessing/Pass.js').Pass} Pass
 * @param {typeof import('three/addons/postprocessing/Pass.js').FullScreenQuad} FullScreenQuad
 */
export function createDepthHarvestPass(THREE, Pass, FullScreenQuad, { width, height }) {
  const target = new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: false,
    magFilter: THREE.NearestFilter,
    minFilter: THREE.NearestFilter,
  });

  const material = new THREE.ShaderMaterial({
    uniforms: { tDepth: { value: null } },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new FullScreenQuad(material);

  class DepthHarvestPass extends Pass {
    constructor() {
      super();
      this.needsSwap = false;
      this.texture = target.texture;
    }

    render(renderer, writeBuffer, readBuffer) {
      const depth = readBuffer?.depthTexture;
      if (!depth) return;
      material.uniforms.tDepth.value = depth;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      quad.render(renderer);
      renderer.setRenderTarget(prev);
    }

    setSize(w, h) {
      target.setSize(w, h);
    }

    dispose() {
      target.dispose();
      material.dispose();
      quad.dispose?.();
    }
  }

  return new DepthHarvestPass();
}
