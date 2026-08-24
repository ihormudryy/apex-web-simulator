# External car shells

Place downloaded glTF packages here. The in-game **Car** picker loads them as
body visuals only — physics stays on the HelloRacer rig. The bundled **Ferrari**
is the default and does not need a file here.

## Catalog

| Path | Catalog label | Source |
|------|---------------|--------|
| *(bundled)* | Ferrari | HelloRacer placeholder mesh |
| `w14/scene.gltf` (+ `scene.bin`, `textures/`) | Mercedes W14 (2023) | [W14 FREE](https://sketchfab.com/3d-models/mercedes-f1-w14-free-26fda66f3e8a48d5a636056f8a64e299) |
| `amr23/scene.gltf` (+ `scene.bin`, `textures/`) | AMR23 (2023) | [AMR23](https://sketchfab.com/3d-models/aston-martin-f1-amr23-2023-f6ba825a43b146a9b669934a4e1fd529) |

Unpack each Sketchfab **glTF** zip into its folder (`obj/cars/w14/`, `obj/cars/amr23/`). A lone `.glb` also works if you point the catalog `url` at it.

## Licenses & trademarks

- **W14** is **CC-BY-4.0** — credit 3dblenderlol.
- **AMR23** is **CC-BY-4.0** — credit Redgrund.
- Team names, liveries and logos may be trademarked even when the mesh is CC-licensed. This project’s README disclaimer still applies; do not treat these as official F1 assets.

## Performance

AMR23 (~645k tris) is heavy for a browser sim. Prefer **W14** if frame time suffers, or decimate in Blender.

## Scale and wheels are handled for you

A downloaded shell is authored to whatever scale its author used, so each one is
measured and fitted on load:

- **Scale** comes from the shell's own **wheelbase** where its wheels can be
  found (including Sketchfab groups named `FL_6` / `rear left`, not just meshes
  called "wheel"). Failing that, it falls back to overall length against a
  nominal 5.6 m. A fit that would need a scale outside 0.02–200× is refused.
- **Seating** puts the wheel hubs exactly one wheel radius off the road.
- **Wheels** are moved onto the rig's spin pivots when they are separate
  named groups — then the shell's own rims steer, spin and squash with the
  physics.

### `hasOwnWheels`

Set this on a catalog entry when the wheels are welded into nameless body
chunks (AMR23: `Object_4`…`Object_9`). The rig's wheels are then hidden
wholesale. Leave it off for the W14, whose corner groups can be reparented.

## Note for local development

`server.py` serves `.bin` with `Content-Encoding: gzip` only when the file really
is a gzip stream. The project's own meshes under `obj/js/` are gzipped despite the
extension; a glTF's `scene.bin` buffer is not.
