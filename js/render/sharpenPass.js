/**
 * Lightweight unsharp mask for the WebGL composer.
 *
 * Sits after temporal AA to restore edge acutance without the smear of a heavy
 * history blend. Kept as a separate pass so MSAA + light TAA + sharpen can be
 * toggled independently.
 */

import * as THREE from 'three';

const VERTEX = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAGMENT = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
uniform float uAmount;

void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  vec3 n = texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb
         + texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb
         + texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb
         + texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb;
  vec3 blur = n * 0.25;
  gl_FragColor = vec4(mix(c, c + (c - blur), uAmount), 1.0);
}`;

/** @param {number} [amount=0.42] 0 = off, ~0.5 = crisp without halos */
export const SHARPEN_AMOUNT = 0.42;

/**
 * @param {typeof import('three/addons/postprocessing/Pass.js').Pass} Pass
 * @param {typeof import('three/addons/postprocessing/Pass.js').FullScreenQuad} FullScreenQuad
 * @param {{ width: number, height: number, amount?: number }} opts
 */
export function createSharpenPass(Pass, FullScreenQuad, { width, height, amount = SHARPEN_AMOUNT }) {
  class SharpenPass extends Pass {
    constructor() {
      super();
      this.needsSwap = true;
      this.enabled = true;
      this._material = new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          uTexel: { value: new THREE.Vector2(1 / width, 1 / height) },
          uAmount: { value: amount },
        },
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        depthTest: false,
        depthWrite: false,
      });
      this._quad = new FullScreenQuad(this._material);
    }

    setAmount(v) {
      this._material.uniforms.uAmount.value = v;
    }

    setSize(w, h) {
      this._material.uniforms.uTexel.value.set(1 / w, 1 / h);
    }

    render(renderer, writeBuffer, readBuffer) {
      this._material.uniforms.tDiffuse.value = readBuffer.texture;
      this._quad.material = this._material;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      if (this.clear) renderer.clear();
      this._quad.render(renderer);
    }

    dispose() {
      this._material.dispose();
      this._quad.dispose();
    }
  }

  return new SharpenPass();
}
