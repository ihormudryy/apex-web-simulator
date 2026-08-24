/**
 * Cinematic post-processing parameters, and the small amount of maths that has
 * to agree between JS and the TSL graph.
 *
 * Free of three.js so the ranges, the defaults and the velocity conversion can
 * be unit-tested. `cinematicPost.js` builds the node graph from these values;
 * nothing here knows what a renderer is.
 *
 * The one number worth explaining is the velocity conversion. Three's `velocity`
 * MRT output is a **normalised-device-coordinate delta** — `ndcNow - ndcPrev`,
 * so a full screen spans 2 units and +Y is up. `motionBlur()` offsets **UVs**,
 * where a full screen spans 1 unit and +Y is down. The conversion is therefore
 * `(x, y) * (0.5, -0.5)`, which is exactly what `TRAANode` does with the same
 * buffer. Getting the 0.5 wrong doubles every streak; getting the sign wrong
 * streaks vertically the wrong way, which is only visible over a crest and is
 * exactly the kind of thing that ships.
 */

/** NDC delta → UV delta. Half the scale, and Y is flipped. */
export const NDC_TO_UV = 0.5;

/**
 * Longest motion streak, as a fraction of screen height.
 *
 * A cap rather than a taste setting. On the frame a reset or a camera cut
 * happens the previous-frame matrices describe somewhere else entirely, so the
 * raw velocity is enormous and the whole frame smears. Clamping the streak
 * costs nothing in normal driving — at 300 km/h the ground moves a few percent
 * of the screen per frame — and removes that flash completely.
 */
export const MAX_STREAK_UV = 0.028;

/**
 * Taps along the streak. 16 is the addon's default and the knee of the quality
 * curve; below about 8 a fast pan reads as ghost images rather than blur.
 */
export const MOTION_BLUR_SAMPLES = 16;

/**
 * Ceiling on what the bright-pass may see, linear HDR.
 *
 * This is not taste, it is the difference between bloom and a white screen.
 * Decoding the shipped sky (`kloofendal_48d_partly_cloudy_puresky_2k.hdr`)
 * gives a sky whose median luminance is **0.35** and whose 99th percentile is
 * **2.1** — but whose sun disc reaches **72,559**. Bloom's high-pass passes the
 * *whole* value through, not the excess over the threshold, so those few sun
 * pixels carry more energy than the rest of the frame combined; blurred down
 * the mip chain they wash everything to white. Measured: at a threshold of 3,
 * which admits only 0.57% of sky pixels, the frame was still blown out.
 *
 * Clamping the input bounds that energy without touching where the glow
 * appears — the sun still blooms hardest, it just can no longer contribute
 * nine thousand times more than a bright cloud. Every engine has this knob;
 * Unreal calls it the bloom clamp.
 */
export const BLOOM_INPUT_CLAMP = 6;

/**
 * WebGL bloom strength, relative to the WebGPU value.
 *
 * `UnrealBloomPass` accumulates five mip levels with its own internal weights,
 * so its `strength` runs hotter than `BloomNode`'s for the same number.
 * Measured by differencing bloom-on against bloom-off at the grid: the shared
 * default lifted the WebGL frame by +20.5/255 against +7/255 on WebGPU, and
 * the extra haze turned the tyres grey. A third brings the two backends to
 * about the same place.
 */
export const WEBGL_BLOOM_SCALE = 1 / 3;

/**
 * Defaults, tuned by screenshot against the HDRI sky at exposure 0.95.
 *
 * `bloomThreshold` is in **linear HDR**, upstream of ACES, so it is not a
 * 0..1 brightness — 1.0 is "as bright as a fully lit white surface". Above
 * that only genuinely hot things bloom: the sun, its reflection off the
 * bodywork, the sky right at the horizon.
 *
 * Depth of field is off by default. It is a broadcast-replay and grid-walk
 * effect; a driver's eye does not have a 4 px bokeh, and it is the most
 * expensive node in the chain (64 taps a pixel).
 */
export const CINEMATIC_DEFAULTS = {
  motionBlur: true,
  motionBlurStrength: 0.55,
  bloom: true,
  // Measured rather than eyeballed. Differencing bloom-on against bloom-off at
  // the grid, this lifts the frame by a mean of ~7/255 and newly clips 94
  // pixels out of 810,000 — a halo around the highlights rather than a loss of
  // detail. For comparison, 0.42 at a threshold of 2.6 measured +19.5/255.
  bloomStrength: 0.16,
  // A wide radius weights the coarsest mips hardest, which spreads a highlight
  // across the whole frame as haze rather than putting a halo around it. 0.85
  // measured as a frame-wide lift; 0.5 keeps the glow attached to its source.
  bloomRadius: 0.5,
  // Comfortably above the sky's 99th percentile (2.07 in the shipped HDRI), so
  // the passband is the narrow [threshold, clamp] window where only the sun and
  // sharp speculars live. Sunlit white bodywork reaches ~3 on its own.
  bloomThreshold: 3.5,
  flare: true,
  flareAmount: 0.10,
  dof: false,
  dofRange: 14,
  dofBokeh: 4,
};

export const CINEMATIC_SLIDERS = {
  motionBlurStrength: { min: 0, max: 4, step: 0.05 },
  bloomStrength: { min: 0, max: 2, step: 0.01 },
  bloomRadius: { min: 0, max: 1, step: 0.01 },
  // Ranges to just under the clamp: above it nothing can pass at all.
  bloomThreshold: { min: 0, max: 5.5, step: 0.05 },
  flareAmount: { min: 0, max: 1, step: 0.01 },
  dofRange: { min: 1, max: 60, step: 0.5 },
  dofBokeh: { min: 0, max: 12, step: 0.1 },
};

/** The flags that change the node graph, so flipping one costs a rebuild. */
export const CINEMATIC_TOGGLES = ['motionBlur', 'bloom', 'flare', 'dof'];

/** Focus can never land behind the lens, or inside the next county. */
export const FOCUS_MIN = 0.5;
export const FOCUS_MAX = 400;

/**
 * Velocity in NDC to a UV streak vector, scaled by the artistic strength.
 * The TSL mirrors this exactly; it lives here so the constants are tested.
 *
 * @param {number} vx NDC delta, x
 * @param {number} vy NDC delta, y
 * @param {number} [strength]
 * @returns {{ x: number, y: number }} UV-space streak
 */
export function ndcVelocityToUv(vx, vy, strength = 1) {
  return {
    x: vx * NDC_TO_UV * strength,
    y: -vy * NDC_TO_UV * strength,
  };
}

/**
 * Clamp a streak to `maxLen` without changing its direction.
 *
 * @param {number} x UV-space streak, x
 * @param {number} y UV-space streak, y
 * @param {number} [maxLen]
 */
export function clampStreak(x, y, maxLen = MAX_STREAK_UV) {
  const len = Math.hypot(x, y);
  if (!(len > 0)) return { x: 0, y: 0 };
  const scale = Math.min(len, maxLen) / len;
  return { x: x * scale, y: y * scale };
}

/** Reference speed (~200 km/h) where motion blur reaches full user strength. */
export const MOTION_BLUR_REF_SPEED = 55;

/**
 * Scale blur by car speed so grass and kerbs stay readable at low speed.
 *
 * @param {number} speedMs car speed magnitude, m/s
 * @param {number} userStrength slider value from the render panel
 */
export function motionBlurStrengthForSpeed(speedMs, userStrength) {
  const s = Math.max(0, speedMs);
  const t = Math.min(1, s / MOTION_BLUR_REF_SPEED);
  const curve = t * t * (3 - 2 * t);
  return userStrength * (0.12 + 0.88 * curve);
}

/**
 * Distance from the camera to whatever should be sharp — the car.
 *
 * Depth of field needs a focus plane in metres, and the interesting plane is
 * always the car: that is what a broadcast long lens is focused on, and it is
 * what makes the background and the foreground kerb go soft around it.
 *
 * @param {{x:number,y:number,z:number}} cameraPos
 * @param {{x:number,y:number,z:number}} targetPos
 * @param {{ min?: number, max?: number }} [limits]
 */
export function focusDistanceFor(cameraPos, targetPos, { min = FOCUS_MIN, max = FOCUS_MAX } = {}) {
  const d = Math.hypot(
    targetPos.x - cameraPos.x,
    targetPos.y - cameraPos.y,
    targetPos.z - cameraPos.z,
  );
  if (!Number.isFinite(d)) return min;
  return Math.min(max, Math.max(min, d));
}

/**
 * Everything that changes the shape of the node graph — the lens toggles plus
 * grading.
 *
 * Grading belongs here even though the panel groups it with the lighting flags,
 * because it is display-referred: the curve is authored in 0..1 display units
 * and has to run *after* tone mapping (see `grading.js`). Switching it on
 * therefore moves the output transform out of `RenderPipeline` and into the
 * tail, which is a different graph, not a different uniform.
 */
export const GRAPH_TOGGLES = [...CINEMATIC_TOGGLES, 'grade'];
const GRAPH_DEFAULTS = { ...CINEMATIC_DEFAULTS, grade: true };

/**
 * The subset of values that decides which nodes exist in the graph.
 * @param {Record<string, unknown>} values
 */
export function cinematicFeatures(values = {}) {
  const out = {};
  for (const key of GRAPH_TOGGLES) {
    out[key] = Boolean(values[key] ?? GRAPH_DEFAULTS[key]);
  }
  // A lens flare is generated from the bloom texture, so it cannot outlive it.
  out.flare = out.flare && out.bloom;
  return out;
}

/** @param {Record<string, boolean>} a @param {Record<string, boolean>} b */
export function featuresEqual(a, b) {
  return GRAPH_TOGGLES.every(k => Boolean(a?.[k]) === Boolean(b?.[k]));
}
