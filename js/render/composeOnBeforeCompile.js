/**
 * Keep a shader injection alive when something else assigns `onBeforeCompile`
 * afterwards.
 *
 * CSM calls `setupMaterial` on every standard material in the scene, and
 * HelloRacer rescans for materials that arrive late, so anything that sets
 * `material.onBeforeCompile = fn` directly is overwritten without a word. The
 * failure is silent in both directions: assign before CSM and the injection
 * disappears; assign after and CSM loses the per-material shader it stashes to
 * drive its cascade uniforms, which breaks shadows instead.
 *
 * Both must run, so the property becomes an accessor: reads return a wrapper
 * that calls the injection and then whatever was assigned last.
 *
 * No Three.js here — it only needs an object with a settable property, which is
 * what makes the ordering testable.
 */
export function composeOnBeforeCompile(material, inject, cacheKeyTag) {
  let later = null;
  Object.defineProperty(material, 'onBeforeCompile', {
    configurable: true,
    // One function literal, so `toString()` is stable and the renderer's program
    // cache key does not change from frame to frame.
    get: () => function composedOnBeforeCompile(shader, renderer) {
      inject(shader, renderer);
      if (later) later.call(material, shader, renderer);
    },
    set: fn => { later = fn; },
  });
  // The wrapper hides the late function's source from the default cache key, so
  // state whether one is present; otherwise a material with a late injection
  // could share a compiled program with one without.
  material.customProgramCacheKey = () => `${cacheKeyTag}|${later ? 'late' : 'plain'}`;
  return material;
}
