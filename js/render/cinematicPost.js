/**
 * The cinematic tail of the WebGPU node graph: depth of field, velocity-driven
 * motion blur, bloom and a lens flare.
 *
 * ## Where this sits, and why it matters
 *
 * `RenderPipeline.outputColorTransform` is true by default, so the pipeline
 * wraps whatever `outputNode` produces in the renderer's tone mapping (ACES,
 * set in `rendererBackend.js`) and output colour space. Everything built here
 * therefore runs in **linear HDR**, upstream of the tone curve — which is the
 * only correct place for it. Bloom thresholded after ACES would key off
 * display-referred values and bloom the whole sky; motion blur after ACES would
 * average tone-mapped values and darken every streak. This is the same reason
 * the WebGL composer puts TAA ahead of `OutputPass`.
 *
 * ## Order
 *
 * Depth of field, then motion blur, then bloom — Unreal's order. Both of the
 * first two are lens effects and could swap without much visible difference,
 * but bloom must come last: it is a bright-pass, and blurring after it would
 * smear the glow rather than the image that produced it.
 *
 * ## Motion blur, and why the car stays sharp
 *
 * The blur direction is the per-pixel screen-space velocity the pre-pass
 * already writes for temporal AA — not a radial guess. With a chase camera the
 * car is nearly stationary in screen space while the road pours past it, so the
 * velocity buffer is close to zero on the bodywork and large on the asphalt.
 * The effect the brief asks for — track streaking, car crisp — is not something
 * this has to fake; it is what the buffer already says.
 *
 * Features are graph shape, not uniforms: turning depth of field off removes
 * its 64 taps a pixel from the shader instead of multiplying them by zero. That
 * costs a pipeline rebuild on toggle (`RenderPipeline.needsUpdate`), which is
 * why sliders are uniforms and only the four checkboxes rebuild.
 */

import {
  convertToTexture, uniform, vec2, vec3, vec4, float, int,
  length as tslLength, min as tslMin, max as tslMax,
  clamp as tslClamp, mix as tslMix, dot as tslDot, renderOutput,
} from 'three/tsl';
import {
  TOE_LIFT, TOE_RANGE, SHOULDER, SHOULDER_FROM, SATURATION, LUMA_WEIGHTS,
} from './grading.js';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { lensflare } from 'three/addons/tsl/display/LensflareNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import {
  BLOOM_INPUT_CLAMP,
  CINEMATIC_DEFAULTS, MAX_STREAK_UV, MOTION_BLUR_SAMPLES, NDC_TO_UV,
} from './cinematicState.js';

/**
 * Lens-flare bright-pass, linear HDR — deliberately higher than bloom's.
 *
 * `LensflareNode` keeps `max(sample - threshold, 0)`, so the threshold decides
 * what is allowed to throw a ghost at all. At 1.25 the car's own sunlit white
 * bodywork qualified, and the ghosts landed above the car as visible grey
 * blobs: an artifact, not a lens. Sitting it just under the bloom clamp
 * restricts flares to what is nearly blowing the sensor — the sun, and
 * specular hits off glass and carbon.
 */
const FLARE_THRESHOLD = 4.5;
/** Ghosts pivot around the screen centre; four is enough to read as a lens. */
const FLARE_GHOSTS = 4;
/** Warm, so the flare reads as glass rather than as a bug. */
const FLARE_TINT = [1.0, 0.86, 0.72];
/**
 * The flare buffer's downsample. The addon defaults to 4, which at 720p is
 * blocky enough that the ghosts read as squares; 2 costs little because the
 * pass is four samples of a small target.
 */
const FLARE_DOWNSAMPLE = 2;

/**
 * `grading.js`'s tone curve, in TSL, from the same constants.
 *
 * Branch-free, and exactly equivalent: `max(0, 1 - v/TOE_RANGE)` is the
 * `if (v < TOE_RANGE)` guard, because the term reaches zero precisely at the
 * range and stays there. Same for the shoulder. TSL has no `if` over a varying,
 * and a `select` here would cost more than the two multiplies it saved.
 *
 * @param {object} v a float node in display-referred 0..1
 */
function toneCurveNode(v) {
  const x = tslClamp(v, 0, 1);
  const toe = tslMax(float(0), float(1).sub(x.div(float(TOE_RANGE))));
  const lifted = x.add(toe.mul(toe).mul(float(TOE_LIFT)));
  const shoulder = tslMax(
    float(0), lifted.sub(float(SHOULDER_FROM)).div(float(1 - SHOULDER_FROM)),
  );
  return tslClamp(lifted.sub(shoulder.mul(shoulder).mul(float(SHOULDER))), 0, 1);
}

/**
 * The grade, applied to a display-referred vec4 — the WebGPU counterpart of
 * `gradingPass.js`, which runs after `OutputPass` on the WebGL composer.
 *
 * Saturation is a `mix` past 1.0 on purpose: that extrapolates away from
 * luminance, which is what `mix(vec3(luma), curved, 1.06)` does in the GLSL.
 */
function gradeNode(display) {
  const curved = vec3(
    toneCurveNode(display.r), toneCurveNode(display.g), toneCurveNode(display.b),
  );
  const luma = tslDot(curved, vec3(LUMA_WEIGHTS.r, LUMA_WEIGHTS.g, LUMA_WEIGHTS.b));
  const saturated = tslMix(vec3(luma), curved, float(SATURATION));
  return vec4(tslClamp(saturated, 0, 1), display.a);
}

/**
 * Runtime-tunable values, as uniform nodes. Shared across every pipeline that
 * embeds a tail, so one slider moves both the cheap and the full stacks.
 *
 * @param {Record<string, number>} [values]
 */
export function createCinematicUniforms(values = {}) {
  const v = { ...CINEMATIC_DEFAULTS, ...values };
  return {
    motionBlurStrength: uniform(v.motionBlurStrength),
    bloomStrength: uniform(v.bloomStrength),
    bloomRadius: uniform(v.bloomRadius),
    bloomThreshold: uniform(v.bloomThreshold),
    flareAmount: uniform(v.flareAmount),
    // Metres. Driven per-frame from the camera-to-car distance, so the car is
    // what the lens is focused on. See `focusDistanceFor`.
    dofFocus: uniform(6),
    dofRange: uniform(v.dofRange),
    dofBokeh: uniform(v.dofBokeh),
  };
}

/**
 * Push slider values into the uniforms. Only keys that are present are
 * touched, so this doubles as the render panel's change handler.
 *
 * @param {ReturnType<typeof createCinematicUniforms> | null} uniforms
 * @param {Record<string, number>} values
 */
export function applyCinematicValues(uniforms, values = {}) {
  if (!uniforms) return;
  const set = (key, value) => {
    if (typeof value === 'number' && Number.isFinite(value) && uniforms[key]) {
      uniforms[key].value = value;
    }
  };
  set('motionBlurStrength', values.motionBlurStrength);
  set('bloomStrength', values.bloomStrength);
  set('bloomRadius', values.bloomRadius);
  set('bloomThreshold', values.bloomThreshold);
  set('flareAmount', values.flareAmount);
  set('dofRange', values.dofRange);
  set('dofBokeh', values.dofBokeh);
}

/** @param {ReturnType<typeof createCinematicUniforms> | null} uniforms @param {number} metres */
export function setCinematicFocus(uniforms, metres) {
  if (uniforms?.dofFocus && Number.isFinite(metres)) uniforms.dofFocus.value = metres;
}

/**
 * Build the tail.
 *
 * @param {object} args
 * @param {object} args.color scene colour, linear HDR — a texture or pass node
 * @param {object} [args.velocity] the pre-pass velocity target (NDC delta)
 * @param {object} [args.viewZ] view-space depth node, for the circle of confusion
 * @param {ReturnType<typeof createCinematicUniforms>} args.uniforms
 * @param {{motionBlur:boolean,bloom:boolean,flare:boolean,dof:boolean}} args.features
 * @returns {object} a vec4 node in linear HDR
 */
export function buildCinematicOutput({ color, velocity, viewZ, uniforms, features }) {
  let image = convertToTexture(color);

  if (features.dof && viewZ) {
    image = convertToTexture(
      dof(image, viewZ, uniforms.dofFocus, uniforms.dofRange, uniforms.dofBokeh),
    );
  }

  if (features.motionBlur && velocity) {
    // NDC delta → UV streak, Y flipped. Mirrors `ndcVelocityToUv`, which is
    // where the constants are unit-tested.
    const raw = velocity.xy
      .mul(vec2(NDC_TO_UV, -NDC_TO_UV))
      .mul(uniforms.motionBlurStrength);
    // Clamp the length, not the components, so a capped streak keeps its
    // direction. Without this the frame after a reset or a camera cut smears
    // edge to edge, because the previous-frame matrices describe another place.
    const len = tslLength(raw);
    const capped = raw.mul(tslMin(len, float(MAX_STREAK_UV)).div(tslMax(len, float(1e-6))));
    image = convertToTexture(motionBlur(image, capped, int(MOTION_BLUR_SAMPLES)));
  }

  if (!features.bloom) return gradeIfAsked(image, features);

  // Clamp what the bright-pass may see. See BLOOM_INPUT_CLAMP: the sun in the
  // shipped HDRI is four orders of magnitude brighter than the sky around it,
  // and unclamped it blooms the entire frame to white. `BloomNode` reads its
  // input as a value rather than sampling it, so this costs no render target.
  const bright = vec4(image.rgb.min(vec3(BLOOM_INPUT_CLAMP)), image.a);

  const glow = bloom(
    bright, uniforms.bloomStrength, uniforms.bloomRadius, uniforms.bloomThreshold,
  );
  // Additive, rgb only: the bloom and flare targets carry no meaningful alpha,
  // and the pipeline's output transform reads the alpha it is given.
  let rgb = image.rgb.add(glow.rgb);

  if (features.flare) {
    // The clamped image again, for the same reason: the flare subtracts its
    // threshold and keeps the remainder, so an unclamped sun would put tens of
    // thousands of units into four ghost samples.
    const flare = lensflare(bright, {
      threshold: float(FLARE_THRESHOLD),
      ghostSamples: float(FLARE_GHOSTS),
      ghostTint: vec3(FLARE_TINT[0], FLARE_TINT[1], FLARE_TINT[2]),
      downSampleRatio: FLARE_DOWNSAMPLE,
    });
    rgb = rgb.add(flare.rgb.mul(uniforms.flareAmount));
  }

  return gradeIfAsked(vec4(rgb, image.a), features);
}

/**
 * The one exit every path takes, so grading cannot be skipped by whichever
 * effect happened to return early.
 *
 * `renderOutput` is what makes this legal: it applies the renderer's tone
 * mapping (with its exposure) and output colour space right here, so the grade
 * that follows sees display-referred 0..1 — the same input the WebGL pass gets
 * downstream of `OutputPass`. The caller must then clear
 * `RenderPipeline.outputColorTransform`, or the frame is transformed twice;
 * `attachCinematicTail` keeps the two in step.
 */
function gradeIfAsked(hdr, features) {
  return features.grade ? gradeNode(renderOutput(hdr)) : hdr;
}
