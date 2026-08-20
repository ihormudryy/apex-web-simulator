/**
 * The grading pass.
 *
 * Runs **after** `OutputPass`, which is where tone mapping and the sRGB transfer
 * happen — grading is display-referred by definition, and a curve authored in
 * 0..1 display units applied to linear HDR would do something else entirely.
 *
 * The curve itself lives in `grading.js`, in JavaScript and in GLSL from the same
 * constants, so there is one definition and the JS one can be measured against the
 * rendering dashboard's own histogram before anything is rendered.
 */

import * as THREE from 'three';
import { TONE_CURVE_GLSL, SATURATION, LUMA_WEIGHTS } from './grading.js';

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
uniform float uSaturation;
uniform float uAmount;

${TONE_CURVE_GLSL}

void main() {
  vec4 src = texture2D(tDiffuse, vUv);
  vec3 curved = vec3(toneCurve(src.r), toneCurve(src.g), toneCurve(src.b));
  float luma = dot(curved, vec3(${LUMA_WEIGHTS.r}, ${LUMA_WEIGHTS.g}, ${LUMA_WEIGHTS.b}));
  vec3 graded = clamp(mix(vec3(luma), curved, uSaturation), 0.0, 1.0);
  // uAmount exists so the pass can be turned down rather than only off, which is
  // what a measurement sweep needs. (No backticks in here: this is a template
  // literal, and one would end it.)
  gl_FragColor = vec4(mix(src.rgb, graded, uAmount), src.a);
}`;

export function createGradingPass(Pass, FullScreenQuad) {
  class GradingPass extends Pass {
    constructor() {
      super();
      this.needsSwap = true;
      this.material = new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          uSaturation: { value: SATURATION },
          uAmount: { value: 1 },
        },
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        depthTest: false,
        depthWrite: false,
      });
      this._quad = new FullScreenQuad(this.material);
    }

    render(renderer, writeBuffer, readBuffer) {
      this.material.uniforms.tDiffuse.value = readBuffer.texture;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      if (this.clear) renderer.clear();
      this._quad.render(renderer);
    }

    dispose() {
      this.material.dispose();
      this._quad.dispose();
    }
  }
  return new GradingPass();
}
