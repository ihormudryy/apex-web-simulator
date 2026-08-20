/**
 * Temporal antialiasing by depth reprojection.
 *
 * The plan calls TAA the single largest image-quality win available, and it is
 * right: this scene is almost nothing but thin geometry — kerb stripes, 0.14 m
 * centre-line dashes, barrier rails, catch-fence wire, wing elements, and 34 000
 * grass cutouts. MSAA resolves edge coverage and does nothing for a 0.14 m dash
 * two hundred metres away that is a third of a pixel wide; anisotropic filtering
 * and mipmapping fixed the *texture* half of the problem and left the geometry.
 *
 * ## Why not the built-in passes
 *
 * three's `TAARenderPass` and `SSAARenderPass` accumulate jittered frames only
 * while the camera is still, and reset the moment it moves. In a driving game the
 * camera never stops moving, so they contribute exactly nothing. `TRAAPass` is real
 * temporal AA but it is WebGPU/TSL only, and the WebGL2 path is the one that has
 * to work.
 *
 * ## What this does instead
 *
 * The standard TAA loop, with the camera as the only motion source:
 *
 *   1. Jitter the projection by a sub-pixel Halton offset each frame.
 *   2. Reproject last frame's pixel: unproject this frame's depth to a world
 *      point, project it through *last* frame's view-projection, and sample the
 *      history there. For a static world and a moving camera this is exact.
 *   3. Clamp the history to the current frame's 3×3 neighbourhood, widened a
 *      little. This is what removes the trails that reprojection-without-velocity
 *      would otherwise leave behind moving objects — the car, and the wheels.
 *   4. Blend, and keep.
 *
 * The honest limitation: no per-object velocity buffer, so a fast-moving object
 * against a contrasting background relies entirely on the neighbourhood clamp.
 * That is a real trade, and it is the right one here — the world is static, the
 * car occupies a small part of the frame, and a velocity pass would mean a second
 * geometry pass with custom materials on everything in the scene.
 */

import * as THREE from 'three';
import {
  jitterAt, JITTER_PERIOD, HISTORY_WEIGHT, CLIP_EXPAND,
} from './haltonJitter.js';

const VERTEX = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAGMENT = /* glsl */`
precision highp float;
precision highp sampler2D;

varying vec2 vUv;

uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform float uHistoryWeight;
uniform float uClipExpand;
uniform bool uFirstFrame;
/** Current inverse view-projection, and the previous frame's view-projection. */
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
/**
 * 0 normal, 1 show the reprojection displacement, 2 show the depth.
 *
 * Not decoration. "Is the reprojection happening at all" is the first question
 * when TAA looks like a blur, and it is not answerable by staring at the frame.
 */
uniform int uDebug;

void main() {
  vec3 current = texture2D(tCurrent, vUv).rgb;

  if (uFirstFrame) {
    gl_FragColor = vec4(current, 1.0);
    return;
  }

  float depth = texture2D(tDepth, vUv).r;

  // Sky and anything at the far plane has no reliable world position to
  // reproject, and it is also the part of the image that changes least, so hold
  // the history in place rather than inventing a motion for it.
  vec2 historyUv = vUv;
  if (depth < 1.0) {
    vec4 clip = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 world = uInvViewProj * clip;
    world /= world.w;
    vec4 prevClip = uPrevViewProj * world;
    // Behind the previous camera: nothing to reproject from.
    if (prevClip.w > 0.0) {
      historyUv = (prevClip.xy / prevClip.w) * 0.5 + 0.5;
    }
  }

  // Off screen last frame — a disocclusion. Take the current pixel and start
  // accumulating again, rather than clamping the edge and dragging it inward.
  if (historyUv.x < 0.0 || historyUv.x > 1.0 || historyUv.y < 0.0 || historyUv.y > 1.0) {
    gl_FragColor = vec4(current, 1.0);
    return;
  }

  if (uDebug == 1) {
    gl_FragColor = vec4(vec3(length(historyUv - vUv) * 120.0), 1.0);
    return;
  }
  if (uDebug == 2) {
    gl_FragColor = vec4(vec3(pow(depth, 40.0)), 1.0);
    return;
  }

  vec3 history = texture2D(tHistory, historyUv).rgb;

  // Neighbourhood clamp. The 3x3 min/max of the current frame bounds what the
  // history is allowed to be; a smeared pixel is by definition outside the range
  // of its neighbours. Widened a little, because a pixel on a thin edge
  // legitimately differs from all eight of them and clamping it to their range
  // would throw away the sub-pixel detail this exists to recover.
  vec3 lo = current;
  vec3 hi = current;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      if (x == 0 && y == 0) continue;
      vec3 s = texture2D(tCurrent, vUv + vec2(float(x), float(y)) * uTexel).rgb;
      lo = min(lo, s);
      hi = max(hi, s);
    }
  }
  vec3 centre = (lo + hi) * 0.5;
  vec3 half_ = (hi - lo) * 0.5 * (1.0 + uClipExpand);
  history = clamp(history, centre - half_, centre + half_);

  gl_FragColor = vec4(mix(current, history, uHistoryWeight), 1.0);
}`;

const COPY_FRAGMENT = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
void main() { gl_FragColor = texture2D(tDiffuse, vUv); }`;

/**
 * A `Pass`-compatible TAA resolve.
 *
 * Constructed with the `Pass` base class passed in rather than imported, because
 * three's post-processing addons are loaded dynamically here (the importmap points
 * at a CDN and the WebGPU build has a different module graph), and a static import
 * of `postprocessing/Pass.js` would break the WebGPU path at load time.
 */
export function createTaaPass(Pass, FullScreenQuad, { width, height }) {
  class TaaPass extends Pass {
    constructor() {
      super();
      this.needsSwap = true;
      this.frame = 0;
      this.enabled = true;

      const options = {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        // Linear HDR in, linear HDR out: this runs before tone mapping, so the
        // accumulation happens in the space the light is actually in. Averaging
        // sRGB values is a different and wrong average.
        colorSpace: THREE.NoColorSpace,
      };
      this._history = new THREE.WebGLRenderTarget(width, height, options);
      this._historyPrev = new THREE.WebGLRenderTarget(width, height, options);

      this._resolveMaterial = new THREE.ShaderMaterial({
        uniforms: {
          tCurrent: { value: null },
          tHistory: { value: null },
          tDepth: { value: null },
          uTexel: { value: new THREE.Vector2(1 / width, 1 / height) },
          uHistoryWeight: { value: HISTORY_WEIGHT },
          uClipExpand: { value: CLIP_EXPAND },
          uFirstFrame: { value: true },
          uDebug: { value: 0 },
          uInvViewProj: { value: new THREE.Matrix4() },
          uPrevViewProj: { value: new THREE.Matrix4() },
        },
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        depthTest: false,
        depthWrite: false,
      });
      this._copyMaterial = new THREE.ShaderMaterial({
        uniforms: { tDiffuse: { value: null } },
        vertexShader: VERTEX,
        fragmentShader: COPY_FRAGMENT,
        depthTest: false,
        depthWrite: false,
      });
      this._quad = new FullScreenQuad(this._resolveMaterial);

      /**
       * An extra, fixed sub-pixel offset added to the jitter.
       *
       * This exists for the visual dashboard, which measures aliasing by shifting
       * the sampling grid half a pixel and comparing the two frames. TAA jitters
       * through the same `setViewOffset`, so without somewhere for the measurement
       * to live the pass simply overwrote it — and the metric then read near zero
       * whatever the image looked like, which is a false pass obtained by breaking
       * the instrument rather than by fixing the picture.
       */
      this.measureOffset = { x: 0, y: 0 };

      this._unjitteredProj = new THREE.Matrix4();
      this._prevViewProj = new THREE.Matrix4();
      this._viewProj = new THREE.Matrix4();
      this._invViewProj = new THREE.Matrix4();
      this._hasPrev = false;
    }

    /**
     * Apply this frame's jitter to a camera, and record the matrices the resolve
     * will need.
     *
     * Called from the frame loop *before* the scene is rendered, because the
     * jitter has to be in the projection matrix by the time geometry is drawn and
     * a `Pass` only gets control afterwards.
     */
    jitter(camera, width, height) {
      const m = this.measureOffset;
      // The UNJITTERED projection, captured before the offset goes on.
      //
      // Reprojection has to use unjittered matrices. Sampling the history through
      // a jittered view-projection puts it up to a whole pixel off target, every
      // frame, and at a 0.9 history weight that error compounds — measured as a
      // 69% loss of Laplacian energy while moving, which is simply blur.
      camera.clearViewOffset();
      camera.updateProjectionMatrix();
      this._unjitteredProj.copy(camera.projectionMatrix);

      if (!this.enabled) {
        if (m.x !== 0 || m.y !== 0) {
          camera.setViewOffset(width, height, m.x, m.y, width, height);
          camera.updateProjectionMatrix();
        } else {
          camera.clearViewOffset();
        }
        return;
      }
      const offset = jitterAt(this.frame, this._offset ??= { x: 0, y: 0 });
      // setViewOffset shifts the frustum by a fraction of a pixel, which is
      // exactly a sub-pixel sample position — the same mechanism the visual
      // dashboard uses to *measure* aliasing.
      camera.setViewOffset(
        width, height, offset.x + m.x, offset.y + m.y, width, height);
      camera.updateProjectionMatrix();
    }

    /** Throw away the accumulated history. Used when the scene jumps. */
    reset() {
      this._hasPrev = false;
      this.frame = 0;
    }

    /**
     * Record the unjittered view-projection for this frame, and keep the previous
     * one. Called after `jitter`, which is what captures the unjittered projection.
     */
    captureCamera(camera) {
      this._prevViewProj.copy(this._hasPrev ? this._viewProj : this._unjitteredProj);
      this._viewProj.multiplyMatrices(this._unjitteredProj, camera.matrixWorldInverse);
      if (!this._hasPrev) this._prevViewProj.copy(this._viewProj);
      this._invViewProj.copy(this._viewProj).invert();
    }

    setSize(width, height) {
      this._history.setSize(width, height);
      this._historyPrev.setSize(width, height);
      this._resolveMaterial.uniforms.uTexel.value.set(1 / width, 1 / height);
      // The accumulated history is the wrong size now; start again rather than
      // stretching it, which would smear the whole frame for a sixth of a second.
      this._hasPrev = false;
      this.frame = 0;
    }

    render(renderer, writeBuffer, readBuffer) {
      const u = this._resolveMaterial.uniforms;
      u.tCurrent.value = readBuffer.texture;
      u.tHistory.value = this._historyPrev.texture;
      u.tDepth.value = readBuffer.depthTexture ?? null;
      u.uFirstFrame.value = !this._hasPrev || !readBuffer.depthTexture;
      u.uInvViewProj.value.copy(this._invViewProj);
      u.uPrevViewProj.value.copy(this._prevViewProj);

      // Resolve into the history, then copy the history out. Resolving straight
      // into `writeBuffer` and copying back would work too, but this keeps the
      // accumulated image in a target of known format regardless of what the
      // composer hands over.
      this._quad.material = this._resolveMaterial;
      renderer.setRenderTarget(this._history);
      renderer.clear();
      this._quad.render(renderer);

      this._copyMaterial.uniforms.tDiffuse.value = this._history.texture;
      this._quad.material = this._copyMaterial;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      if (this.clear) renderer.clear();
      this._quad.render(renderer);

      // Ping-pong.
      const swap = this._historyPrev;
      this._historyPrev = this._history;
      this._history = swap;
      this._hasPrev = true;
      this.frame = (this.frame + 1) % JITTER_PERIOD;
    }

    dispose() {
      this._history.dispose();
      this._historyPrev.dispose();
      this._resolveMaterial.dispose();
      this._copyMaterial.dispose();
      this._quad.dispose();
    }
  }

  return new TaaPass();
}
