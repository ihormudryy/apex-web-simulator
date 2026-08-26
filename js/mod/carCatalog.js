/**
 * Built-in car catalog — local glTF shells under `obj/cars/`.
 *
 * Physics stays on the HelloRacer rig; these entries only swap the body mesh.
 * The bundled **Apex GT1** is the default: the original HelloRacer placeholder
 * mesh, wearing the fictional "Apex Racing" livery (see `Car.js`'s `livery`
 * option and `carProceduralMaps.js`'s `hueRotateRGBA`) — no real marque, so
 * nothing here needs the trademark disclaimer the downloaded shells below do.
 * AMR23 and W14 are the Sketchfab shells from the Downloads folder (you place
 * the files; we do not redistribute) — real, trademarked cars, covered by
 * `obj/cars/README.md`'s own license/trademark section.
 *
 *   - AMR23: https://sketchfab.com/3d-models/aston-martin-f1-amr23-2023-f6ba825a43b146a9b669934a4e1fd529
 *   - W14:   https://sketchfab.com/3d-models/mercedes-f1-w14-free-26fda66f3e8a48d5a636056f8a64e299
 */

/** @typedef {{
 *   id: string,
 *   label: string,
 *   url: string | null,
 *   attribution: string,
 *   license: string,
 *   sourceUrl: string | null,
 *   notes?: string,
 *   hasOwnWheels?: boolean,
 * }} CarCatalogEntry */

/**
 * `hasOwnWheels` exists because it cannot be detected reliably.
 *
 * A shell whose wheels are separate, recognisably named nodes gets them moved
 * onto the rig's spin pivots automatically, so they steer and rotate with the
 * physics (see `Car._adoptShellWheels`). But an exporter is free to bake the
 * whole car into a handful of nameless chunks — the AMR23 arrives as `Object_4`
 * through `Object_9`, every one of them a slice of the entire body with the
 * wheels welded in. There is nothing there to find and nothing to reparent, and
 * guessing wrong is bad in both directions: hide the rig's wheels for a
 * body-only shell and the car floats, keep them for a complete one and two sets
 * of tyres turn through each other. So whoever adds the entry says. The loader
 * also tries to peel nameless welded tyres off by position (AMR23); `hasOwnWheels`
 * remains the fallback if that split cannot find four corners.
 *
 * The W14 is the other case: wheels are groups named `FL_6` / `rear left_18`
 * with nameless `Object_*` meshes under them. The fitter walks up to those
 * groups; `hasOwnWheels` stays false so the groups can be reparented.
 */

/** @type {CarCatalogEntry[]} */
export const CAR_CATALOG = [
  {
    id: 'apex',
    label: 'Apex GT1',
    url: null,
    attribution: 'Bundled HelloRacer placeholder mesh',
    license: 'Project MIT (placeholder art)',
    sourceUrl: null,
  },
  {
    id: 'w14',
    label: 'Mercedes W14 (2023)',
    url: 'obj/cars/w14/scene.gltf',
    attribution: '3dblenderlol — Mercedes F1 W14 [FREE!!]',
    license: 'CC-BY-4.0',
    sourceUrl: 'https://sketchfab.com/3d-models/mercedes-f1-w14-free-26fda66f3e8a48d5a636056f8a64e299',
    notes: 'Separate wheel groups — they steer and spin on the rig',
    hasOwnWheels: false,
  },
  {
    id: 'amr23',
    label: 'AMR23 (2023)',
    url: 'obj/cars/amr23/scene.gltf',
    attribution: 'Redgrund — Aston Martin F1 AMR23 2023',
    license: 'CC-BY-4.0',
    sourceUrl: 'https://sketchfab.com/3d-models/aston-martin-f1-amr23-2023-f6ba825a43b146a9b669934a4e1fd529',
    notes: '~645k tris — welded tyres are peeled onto the rig so they spin',
    hasOwnWheels: true,
  },
];

export const DEFAULT_CAR_ID = 'apex';

/**
 * @param {string} id
 * @returns {CarCatalogEntry | undefined}
 */
export function carById(id) {
  return CAR_CATALOG.find(c => c.id === id);
}

/**
 * Persist last pick across reloads.
 *
 * `ferrari` is a legacy value: the bundled entry's id until the trademarked
 * label was renamed away (see the module header). Mapping it forward here —
 * the same shape as the pre-existing `default` shim — means a returning
 * player's saved pick still resolves to the same bundled car instead of
 * silently landing on whatever `DEFAULT_CAR_ID` happens to be today.
 *
 * @param {Pick<Storage, 'getItem'> | null | undefined} [storage]
 * @returns {string}
 */
export function readStoredCarId(storage = globalThis.localStorage) {
  try {
    let v = storage?.getItem?.('helloracer.carId');
    if (v === 'default' || v === 'ferrari') v = DEFAULT_CAR_ID;
    if (v && carById(v)) return v;
  } catch {
    /* private mode */
  }
  return DEFAULT_CAR_ID;
}

/**
 * @param {string} id
 * @param {Pick<Storage, 'setItem'> | null | undefined} [storage]
 */
export function writeStoredCarId(id, storage = globalThis.localStorage) {
  try {
    storage?.setItem?.('helloracer.carId', id);
  } catch {
    /* private mode */
  }
}
