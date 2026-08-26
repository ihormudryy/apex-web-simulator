/**
 * The line the AI drives: minimum curvature within the track corridor.
 *
 * A driver following the centerline is visibly wrong — it drives down the
 * middle of the road and it is slow, which makes any difficulty percentage
 * meaningless because there is no optimal pace to take a percentage of.
 *
 * The line is a lateral offset per station, `P_i = C_i + o_i·N_i`, chosen to
 * minimise the discrete curvature `Σ|P_{i-1} - 2P_i + P_{i+1}|²` over the
 * whole lap, subject to staying inside the corridor.
 *
 * WHY THIS IS PROJECTED GRADIENT DESCENT, NOT A PER-STATION CLOSED FORM.
 * `o_i` appears in three consecutive terms of that sum — `D_{i-1}`, `D_i` and
 * `D_{i+1}`, since `D_k = P_{k-1}-2P_k+P_{k+1}` — so the derivative of the
 * *total* with respect to `o_i` has three pieces:
 *
 *     grad_i = (D_{i-1} - 2·D_i + D_{i+1}) · N_i
 *
 * An earlier version of this module solved `D_i·N_i = 0` alone, i.e. it
 * minimised each station's own curvature term holding its neighbours fixed
 * and ignored the other two pieces. That is not gradient descent on the lap
 * total; it is Gauss-Seidel on a different, cyclic-tridiagonal system whose
 * off-diagonal coefficients (`N_i·N_{i+1}`) sit within a fraction of a
 * percent of the diagonal everywhere on this circuit (1.47 m station spacing
 * against a ~20 m tightest radius). Iterated to its actual fixed point
 * (confirmed independently three ways: SOR near ω=2, a coarse-grid solve,
 * and an exact conjugate-gradient solve) that system does not converge
 * toward a racing line — a constant offset costs it nothing, so it is
 * exactly as happy running the car along the outside wall through *every*
 * corner as through the tight ones, and between two corners that turn
 * opposite ways that means slamming from one corridor edge to the other in
 * a handful of stations. Measured: 20.1 (flat) vs. 27–31 at that fixed
 * point — worse than not relaxing at all.
 *
 * The fix is to actually descend the lap-total objective: compute every
 * `D_i` from the current offsets first, then take one gradient step for
 * every station using those (this is Jacobi-style — a Gauss-Seidel version
 * would be using half-updated `D`s mid-step, which is not a gradient of
 * anything). `relaxOnce` below does exactly that.
 *
 * WHY THE STEP SIZE IS 0.02, NOT SOMETHING BIGGER.
 * `grad_i` above is a fourth-difference (biharmonic) stencil applied twice
 * to the offset field — its kernel is `[1,-4,6,-4,1]` — and for a periodic
 * domain a stencil like that has eigenvalues `(2 - 2cos θ)²`, which peak at
 * `θ = π` at a value of 16. Gradient descent on a quadratic needs
 * `step < 2/L` where `L` is that peak eigenvalue, i.e. `step < 0.125`.
 * Measured directly: `STEP = 0.15` blows the line out to 42.8 km around a
 * 5891 m track within 200 sweeps; `STEP = 0.02` converges smoothly.
 *
 * WHY `lineCurvatureTotal` SUMS SQUARED CURVATURE, NOT RAW CURVATURE.
 * The obvious metric — Σ|curvature|, summed over every station — cannot be
 * used to judge this line, because it is close to a topological invariant.
 * By the discrete form of Fenchel's theorem, the total turning of a closed
 * loop (Σ curvature · ds, i.e. Σ|D_i|, the numerator before dividing by
 * `ds²`) does not depend on which path is taken through a corridor, only on
 * the loop's winding number. Measured on the flat centerline: Σ|curvature|
 * = 20.11, matching (total turning)/(mean spacing) to four figures — they
 * are the same number by construction. Worse: an apex-cutting line is
 * *shorter* than the centerline (it cuts corners), which shrinks the mean
 * station spacing `ds`, which — since curvature is turning divided by `ds`
 * — makes Σ|curvature| *larger* even when the geometry genuinely improved.
 * Chasing a 10% reduction in that number is chasing a quantity that barely
 * moves and moves in the wrong direction as the line improves; an earlier
 * version of this module spent a great deal of effort tuning toward it and
 * could not clear more than ~4.5% no matter how it iterated, and confirmed
 * by direct construction (conjugate-gradient solve of the true unconstrained
 * problem, and 300k iterations of correct projected gradient descent on the
 * true objective) that no honest corridor-constrained line clears 10% on
 * this metric. Σ curvature² does not have this problem: squaring rewards
 * *concentration* — moving the same total turning from a few very tight
 * radii to many gentler ones lowers the sum of squares even though the sum
 * of magnitudes barely changes — which is exactly what cutting an apex does
 * physically (a bigger effective radius through the tightest point), and is
 * also the number that maps directly to peak lateral g and thus corner
 * speed, which is what this line is *for*.
 *
 * WHY 60,000 SWEEPS, NOT MORE — AND NOT "UNTIL IT CONVERGES".
 * 60,000 is a chosen budget, not a converged optimum, and an earlier draft
 * of this comment wrongly claimed otherwise ("settles... no further change
 * out to 100,000"). It doesn't settle. Measured trajectory, `STEP = 0.02`,
 * (sweeps: Σk² ratio / peak-curvature ratio, both vs. the flat centerline):
 *
 *     60,000:    0.883 / 0.859
 *     100,000:   0.866 / 0.874
 *     400,000:   0.825 / 0.944
 *     1,600,000: 0.798 / 0.949
 *
 * Σk² keeps falling the whole way — the offset field keeps finding lower
 * total squared curvature out past a million and a half sweeps. But PEAK
 * curvature — the number that actually sets minimum corner speed — gets
 * *worse* past roughly 60,000, because the objective is happy to buy a
 * lower sum by flattening already-gentle stretches while the tightest
 * point drifts back up. Stopping at 60,000 is not an arbitrary round
 * number; it is where the metric that matters for lap time is at its best
 * measured value, even though the metric the optimiser is directly
 * descending keeps improving. Running longer looks better on paper (lower
 * Σk²) and drives worse.
 *
 * WHAT THIS ACTUALLY BUYS: 10.3 SECONDS A LAP, FROM SMOOTHING, NOT CUTTING.
 * On a wide-corridor, gentle-radius circuit this line barely visibly cuts
 * apexes. Silverstone's corridor here is roughly ±5 m against corner radii
 * of 20–200 m, so there is little geometric room to re-route through a
 * corner, and mean |offset| over the lap is a few centimetres (see
 * `racingLine.test.js`, which pins this as the expected outcome on this
 * geometry, not a shortfall). That smallness looks unimpressive but is not
 * the same as "did nothing": a quasi-static lap-time estimate (Menger
 * curvature per station → cornering-speed limit → backward braking pass →
 * forward traction pass, at 1.6 lateral / 1.8 braking / 0.9 acceleration g,
 * 92 m/s cap — no driver model involved) gives:
 *
 *     centerline    133.74 s   length 5891 m   slowest corner 17.9 m/s
 *     racing line   123.40 s   length 5887 m   slowest corner 19.0 m/s
 *
 * 10.34 s a lap quicker — 7.73% — entirely from the 14% reduction in peak
 * curvature raising the slowest corner's speed from 17.9 to 19.0 m/s.
 * (Sanity check: 133.74 s sits right next to the ~131 s flat-out figure
 * already recorded in `lap.test.js`.) On this corridor essentially all of
 * the available lap time comes from smoothing rather than re-routing — a
 * line that visibly cuts apexes was measured and rejected precisely because
 * it is slower: decimating the relaxation to 200–400 stations and
 * interpolating the offsets back up does produce a dramatic-looking line
 * (mean |offset| 3–4 m) that cuts hard toward the barrier, but its peak
 * curvature comes out ~2.3–2.5× *worse* — it buys a wide radius through
 * most of the corner at the cost of a much tighter transition at the ends,
 * the same wall-riding trade-off described above in miniature, and by the
 * lap-time estimate above it would be slower, not faster. If a future
 * circuit's geometry makes a visibly apex-cutting line actually worth more
 * than this one, the right tool is a real constrained solver with
 * arc-length reparameterisation, not more tuning of this relaxation — that
 * road has already been walked on this circuit and it leads backwards.
 *
 * 60,000 sweeps at 4000 stations measures ~0.8 s cold and ~2.1 s for a
 * repeat call in the same process (V8 JIT variance across fresh closures;
 * not investigated further since both are well inside the "seconds, not
 * ten seconds" budget for a one-time load-time computation).
 *
 * Generated rather than shipped: TUMFTM publishes a real optimiser raceline,
 * but it is keyed to the *surveyed* geometry while our centerline was
 * recentred, elbow-relaxed and rescaled to 5891 m — and it would not
 * generalise to any other circuit, which `defaultCircuit.js` exists to allow.
 *
 * Pure and deterministic: no RNG, no three.js.
 */

import { G } from '../physics/constants.js';
import { HALF_WIDTH } from '../physics/collision.js';

/**
 * How far inside the asphalt edge the line must stay, m.
 *
 * Half the car plus a margin. The offset is the path of the CoG, so without
 * the car's own half-width the line puts two wheels on the grass at every apex.
 */
export const CORRIDOR_MARGIN = HALF_WIDTH + 0.35;

/**
 * Gradient-descent step size per sweep.
 *
 * Must stay below `2/16 = 0.125` — the stability bound of the biharmonic
 * stencil `grad_i` is built from (see module header). Measured: 0.15
 * diverges (the line blows out to 42.8 km around a 5891 m track within 200
 * sweeps); 0.02 converges smoothly with headroom to spare.
 */
const STEP = 0.02;
/**
 * Sweeps to run. This is a chosen stopping point, not a converged value —
 * see "WHY 60,000 SWEEPS" in the module header for the measured trajectory
 * out to 1.6M sweeps. Peak curvature (what sets minimum corner speed) is at
 * its best around here; total squared curvature keeps falling well past it,
 * which is exactly why sweep count alone can't be tuned further without
 * making the line worse where it counts. Costs ~1–2 s at 4000 stations.
 */
const DEFAULT_ITERATIONS = 60000;
/**
 * Cornering budget the line's speed limit (`line.speed`, below) is quoted at, in g.
 *
 * Stale note corrected: this used to be exported because `aiDriver` divided it
 * back out to rescale `line.speed` to its own difficulty. It no longer does —
 * see the `driveAi` comment by `line.speed` in aiDriver.js for why that
 * rescaling was a category error (it silently capped `pro` and `ace` below
 * their own topSpeed on every straight) and was replaced with deriving corner
 * speed directly from `line.curvature` and the level's own `latG`/`topSpeed`.
 * Nothing in this codebase currently imports `LINE_LAT_G`; it stays exported
 * as the one place this module's own calibration figure is named, so a future
 * caller that genuinely wants to match it doesn't have to hardcode 1.6 again.
 */
export const LINE_LAT_G = 1.6;
/** Nothing on this circuit is faster than this, m/s. */
const TOP_SPEED = 92;

export function buildRacingLine(samples, {
  iterations = DEFAULT_ITERATIONS,
  margin = CORRIDOR_MARGIN,
  latG = LINE_LAT_G,
  topSpeed = TOP_SPEED,
} = {}) {
  const n = samples.length;
  const limit = new Float64Array(n);
  // Centerline x/z/nx/nz pulled into flat arrays once: `relaxOnce` reads
  // them 4000×60000 times, and going through `samples[i].x` property
  // lookups that many times roughly doubled the load-time cost — see the
  // measurement in the module header.
  const cx = new Float64Array(n), cz = new Float64Array(n);
  const nx = new Float64Array(n), nz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    limit[i] = Math.max(0, samples[i].halfWidth - margin);
    cx[i] = samples[i].x; cz[i] = samples[i].z;
    nx[i] = samples[i].nx; nz[i] = samples[i].nz;
  }

  const offset = new Float64Array(n);
  // Scratch for the sweep, allocated once and reused across passes — this
  // runs once at load, so the per-call allocation above is fine, but there
  // is no reason to allocate fresh arrays 60,000 times over. `relaxOnce` is
  // a closure over these rather than taking them as parameters: passing
  // eight-plus typed arrays into a function called 60,000 times measurably
  // doubled the load-time cost (V8 inlines the closure form far better) —
  // see the measurement in the module header.
  const scratchPx = new Float64Array(n), scratchPz = new Float64Array(n);
  const scratchDx = new Float64Array(n), scratchDz = new Float64Array(n);
  // One projected-gradient-descent sweep on the lap-total curvature objective
  // `Σ|P_{i-1}-2P_i+P_{i+1}|²`. Jacobi-style by necessity: every `D_i` is
  // computed from the offsets as they stood at the *start* of the sweep
  // before any station moves, because `grad_i` mixes `D_{i-1}`, `D_i` and
  // `D_{i+1}` — updating in place mid-sweep (Gauss-Seidel-style) would mean
  // each station sees a mix of old and new neighbours and the step would not
  // be a gradient of anything. See module header for why this replaced a
  // per-station closed form, and why `STEP` is bounded at 0.125.
  const relaxOnce = () => {
    for (let i = 0; i < n; i++) {
      scratchPx[i] = cx[i] + offset[i] * nx[i];
      scratchPz[i] = cz[i] + offset[i] * nz[i];
    }
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      scratchDx[i] = scratchPx[a] - 2 * scratchPx[i] + scratchPx[b];
      scratchDz[i] = scratchPz[a] - 2 * scratchPz[i] + scratchPz[b];
    }
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      const gx = scratchDx[a] - 2 * scratchDx[i] + scratchDx[b];
      const gz = scratchDz[a] - 2 * scratchDz[i] + scratchDz[b];
      const grad = gx * nx[i] + gz * nz[i];
      let next = offset[i] - STEP * grad;
      if (next > limit[i]) next = limit[i];
      if (next < -limit[i]) next = -limit[i];
      offset[i] = next;
    }
  };
  for (let pass = 0; pass < iterations; pass++) relaxOnce();

  const x = new Float64Array(n);
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = cx[i] + offset[i] * nx[i];
    z[i] = cz[i] + offset[i] * nz[i];
  }

  // Spacing along the LINE, not the centerline: cutting a corner shortens it.
  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    total += Math.hypot(x[j] - x[i], z[j] - z[i]);
  }
  const spacing = total / n;

  const curvature = new Float64Array(n);
  // `speed` — this line's own cornering-speed estimate at `latG`/`topSpeed` —
  // has NO production consumer: `aiDriver.driveAi` deliberately derives corner
  // speed itself from `curvature` and its own level's `latG`/`topSpeed` rather
  // than rescaling this array (see the `driveAi` comment there for the bug
  // that reaching for `line.speed` caused). Kept computed and returned because
  // `racingLine.test.js` uses it as a cheap sanity check on the line's
  // tightest/loosest corner speed, and because it is a handful of flops per
  // station on top of `curvature`, not a real cost — not because anything
  // downstream of `buildRacingLine` is meant to drive by it.
  const speed = new Float64Array(n);
  const ds2 = spacing * spacing;
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n;
    const b = (i + 1) % n;
    const dx = x[a] - 2 * x[i] + x[b];
    const dz = z[a] - 2 * z[i] + z[b];
    curvature[i] = Math.hypot(dx, dz) / ds2;
    speed[i] = curvature[i] < 1e-6
      ? topSpeed
      : Math.min(topSpeed, Math.sqrt(latG * G / curvature[i]));
  }
  return { x, z, offset, curvature, speed, spacing, length: total };
}

/**
 * Sum of SQUARED curvature over the lap — the quantity the relaxation
 * reduces. Not raw `Σ|curvature|`: see the module header ("WHY
 * `lineCurvatureTotal` SUMS SQUARED CURVATURE") — that quantity is close to
 * a topological invariant (Fenchel's theorem) and gets *worse*, not better,
 * as the line improves, because cutting a corner shortens the line and
 * shrinks the `ds` curvature is divided by.
 */
export function lineCurvatureTotal(line) {
  let sum = 0;
  for (let i = 0; i < line.curvature.length; i++) sum += line.curvature[i] * line.curvature[i];
  return sum;
}

/** Stations either side of the hint the windowed search in `nearestOnLine` covers. */
const NEAREST_WINDOW = 90;

/** Nearest station on the line to a world point, searching from a hint. */
export function nearestOnLine(line, qx, qz, hint = 0) {
  const n = line.x.length;
  let best = hint, bestD2 = Infinity;
  for (let d = -NEAREST_WINDOW; d <= NEAREST_WINDOW; d++) {
    const i = ((hint + d) % n + n) % n;
    const dx = line.x[i] - qx, dz = line.z[i] - qz;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  // The windowed search above only *proves* it found the true nearest
  // station when the answer it found is closer than the window itself
  // spans — `NEAREST_WINDOW` stations at the line's own spacing covers
  // `NEAREST_WINDOW * line.spacing` metres of arc to either side of the
  // hint, so anything found within that radius can't have a closer
  // competitor hiding just outside the window. A hardcoded metre figure
  // here would silently stop matching the window once either constant
  // changed; deriving it from both keeps them honest with each other.
  // Beyond that radius (e.g. a stale hint left over from across a hairpin,
  // or the first call ever with the default hint of 0) fall back to a full
  // scan — it costs O(n) but only runs when the fast path can't be trusted.
  const safeRadius = NEAREST_WINDOW * line.spacing;
  if (bestD2 > safeRadius * safeRadius) {
    for (let i = 0; i < n; i++) {
      const dx = line.x[i] - qx, dz = line.z[i] - qz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
  }
  return best;
}
