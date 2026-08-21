/** Resolve the bare `three` specifier to the vendored test build. */
const THREE_URL = new URL('../test/vendor/three/three.module.js', import.meta.url).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'three') {
    return { shortCircuit: true, url: THREE_URL };
  }
  return nextResolve(specifier, context);
}
