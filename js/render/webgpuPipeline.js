import {
  sample, pass, mrt, normalView, velocity, vec3, vec4, float, mix, add, uniform,
  packNormalToRGB, unpackRGBToNormal, diffuseColor, output, builtinAOContext,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { setSunLightDirection } from './sunLightDirection.js';
import { SUN_INTENSITY, SHADOW_INTENSITY } from './lightingBalance.js';

export { setSunLightDirection } from './sunLightDirection.js';

/**
 * Cascaded sun shadows for WebGPURenderer. WebGLRenderer uses the `CSM` addon instead.
 *
 * @param {typeof import('three/webgpu')} THREE
 */
export function createWebGpuSunLight(THREE, scene, sunDir, {
  maxFar = 1400,
  lightMargin = 80,
  intensity = SUN_INTENSITY,
  mapSize = 2048,
} = {}) {
  const sunLight = new THREE.DirectionalLight(0xffffff, intensity);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(mapSize, mapSize);
  sunLight.shadow.camera.near = 0.5;
  sunLight.shadow.camera.far = maxFar + 200;
  sunLight.shadow.bias = -0.00035;
  sunLight.shadow.normalBias = 0.008;
  sunLight.shadow.radius = 4;
  sunLight.shadow.intensity = SHADOW_INTENSITY;

  const csm = new CSMShadowNode(sunLight, {
    cascades: 4,
    mode: 'practical',
    maxFar,
    lightMargin,
  });
  sunLight.shadow.shadowNode = csm;

  setSunLightDirection(sunLight, sunDir);
  scene.add(sunLight);
  scene.add(sunLight.target);

  return { sunLight, csm };
}

function makePostController(aoEnabled, giEnabled) {
  return {
    aoEnabled,
    giEnabled,
    setAoEnabled(on) {
      aoEnabled.value = on ? 1 : 0;
    },
    setGiEnabled(on) {
      giEnabled.value = on ? 1 : 0;
    },
  };
}

function tuneGtaoPass(aoPass) {
  aoPass.resolutionScale = 0.5;
  aoPass.useTemporalFiltering = true;
  aoPass.radius.value = 0.28;
  aoPass.thickness.value = 1.2;
  aoPass.scale.value = 1;
  aoPass.samples.value = 16;
}

/**
 * Full stack: pre-pass → GTAO + denoise → scene AO → SSGI → TRAA → sharpen.
 *
 * @param {typeof import('three/webgpu')} THREE
 */
function buildFullWebGpuPost(THREE, renderer, scene, camera, aoEnabled, giEnabled, {
  aoBlend = 0.45,
  giStrength = 0.2,
  sharpenAmount = 0.62,
} = {}) {
  const renderPipeline = new THREE.RenderPipeline(renderer);

  const prePass = pass(scene, camera);
  prePass.name = 'Pre-Pass';
  prePass.transparent = false;
  prePass.setMRT(mrt({
    output: packNormalToRGB(normalView),
    velocity,
  }));

  const prePassDepth = prePass.getTextureNode('depth');
  const prePassNormal = sample(uv => unpackRGBToNormal(prePass.getTextureNode().sample(uv)));
  const prePassVelocity = prePass.getTextureNode('velocity');

  const normalTexture = prePass.getTexture('output');
  normalTexture.type = THREE.UnsignedByteType;

  const aoPass = ao(prePassDepth, prePassNormal, camera);
  tuneGtaoPass(aoPass);

  const aoPassOutput = aoPass.getTextureNode();
  const denoisedAo = denoise(aoPassOutput, prePassDepth, prePassNormal, camera);

  const scenePass = pass(scene, camera);
  scenePass.setMRT(mrt({ output, diffuseColor }));

  // DenoiseNode is a vec4 TempNode — not a TextureNode with `.sample()`.
  const aoForContext = mix(float(1), denoisedAo.r, aoEnabled.mul(float(aoBlend)));
  scenePass.contextNode = builtinAOContext(aoForContext);

  const scenePassColor = scenePass.getTextureNode('output');
  const scenePassDiffuse = scenePass.getTextureNode('diffuseColor');

  const diffuseTexture = scenePass.getTexture('diffuseColor');
  diffuseTexture.type = THREE.UnsignedByteType;

  const giPass = ssgi(scenePassColor, prePassDepth, prePassNormal, camera);
  giPass.sliceCount.value = 1;
  giPass.stepCount.value = 6;

  const gi = giPass.getGINode();
  const giContrib = scenePassDiffuse.rgb
    .mul(gi.rgb)
    .mul(float(giStrength))
    .mul(giEnabled)
    .mul(aoEnabled);
  const composite = vec4(add(scenePassColor.rgb, giContrib), scenePassColor.a);

  const traaPass = traa(composite, prePassDepth, prePassVelocity, camera);
  traaPass.useSubpixelCorrection = false;

  renderPipeline.outputNode = sharpen(traaPass, float(sharpenAmount));
  return { renderPipeline, aoPass };
}

/**
 * Fallback when an addon node is missing: single-pass GTAO multiply + TRAA.
 *
 * @param {typeof import('three/webgpu')} THREE
 */
function buildBasicWebGpuPost(THREE, renderer, scene, camera, aoEnabled, giEnabled, {
  aoBlend = 0.45,
} = {}) {
  const renderPipeline = new THREE.RenderPipeline(renderer);

  const prePass = pass(scene, camera);
  prePass.transparent = false;
  prePass.setMRT(mrt({
    output: packNormalToRGB(normalView),
    velocity,
  }));

  const prePassDepth = prePass.getTextureNode('depth');
  const prePassNormal = sample(uv => unpackRGBToNormal(prePass.getTextureNode().sample(uv)));
  const prePassVelocity = prePass.getTextureNode('velocity');

  prePass.getTexture('output').type = THREE.UnsignedByteType;

  const aoPass = ao(prePassDepth, prePassNormal, camera);
  tuneGtaoPass(aoPass);

  const scenePass = pass(scene, camera);
  const scenePassColor = scenePass.getTextureNode('output');
  const aoOut = aoPass.getTextureNode();
  const aoFactor = mix(float(1), aoOut.r, aoEnabled.mul(float(aoBlend)));
  const composite = scenePassColor.mul(vec4(vec3(aoFactor), float(1)));

  renderPipeline.outputNode = traa(composite, prePassDepth, prePassVelocity, camera);
  giEnabled.value = 0;
  return { renderPipeline, aoPass };
}

/**
 * TSL render pipeline for the WebGPU path. Always returns a controller with
 * `setAoEnabled` so HelloRacer can toggle GTAO without caring which tier built.
 *
 * @param {typeof import('three/webgpu')} THREE
 */
export function createWebGpuPost(THREE, renderer, scene, camera, options = {}) {
  const aoEnabled = uniform(0);
  const giEnabled = uniform(1);
  const controller = makePostController(aoEnabled, giEnabled);

  let built;
  try {
    built = buildFullWebGpuPost(THREE, renderer, scene, camera, aoEnabled, giEnabled, options);
  } catch (err) {
    console.warn('[HelloRacer] Full WebGPU post stack unavailable, using basic GTAO + TRAA:', err);
    built = buildBasicWebGpuPost(THREE, renderer, scene, camera, aoEnabled, giEnabled, options);
  }

  return {
    ...built,
    ...controller,
  };
}
