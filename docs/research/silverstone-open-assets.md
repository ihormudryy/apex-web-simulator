# Open assets & geodata for a more realistic Silverstone

Research notes, 2026-08-21. Question: what open-source / freely-licensed 3D assets and geodata
exist for making the Silverstone scene more realistic — given that our track is generated
procedurally from waypoints (`js/track/silverstoneWaypoints.js`, filleted to 5891 m), so **input
data for the generator is at least as valuable as finished meshes**. Every claim cited inline.
Not legal advice.

---

## 1. Geometry data for the generator

### 1.1 TUMFTM `racetrack-database` — surveyed centerline **with per-point widths** (best fit)

- Repo: <https://github.com/TUMFTM/racetrack-database> (TU Munich, used in their global-raceline-optimization papers). Contains centerlines + track widths for 20+ F1/DTM circuits; **Silverstone is included**. License: **LGPL-3.0**. README: centerlines "fetched as GPS points from the OpenStreetMap project", widths "extracted from satellite images using an image processing algorithm"; quality "varies greatly depending on the location".
- File: <https://raw.githubusercontent.com/TUMFTM/racetrack-database/master/tracks/Silverstone.csv> — header `x_m,y_m,w_tr_right_m,w_tr_left_m`. **Verified by download (2026-08-21): 1178 points at ~5.00 m spacing, closed-loop length 5887 m (official 5891 m → 0.07 % off), total width 11.3–17.8 m, mean 13.8 m.** So it is the current (post-2011 Arena) GP layout, and the widths are exactly the `halfWidth` input our generator wants.
- There is also `racelines/Silverstone.csv` (`x_m,y_m`, minimum-curvature raceline) — useful as an AI driving line.
- Provenance caveat: because the centerline derives from OSM, the CSV is arguably an ODbL derivative regardless of the LGPL label; attributing OpenStreetMap as well (see 1.2) costs nothing and covers it.

### 1.2 OpenStreetMap — track edges, pit lanes, and building footprints

Silverstone is mapped in detail (all ids verified via Nominatim / Overpass API, 2026-08-21):

- Venue polygon: **way 156355633**, `leisure=sports_centre`, "Silverstone Circuit" (<https://nominatim.openstreetmap.org/search?q=Silverstone+Circuit&format=jsonv2>).
- The GP circuit itself is ~89 `highway=raceway` ways in bbox (52.05, −1.06, 52.11, −0.97) — there is **no single relation**; named segments must be stitched. Sample ids from Overpass (<https://overpass-api.de/api/interpreter>): Hamilton Straight 55224167, Abbey 169854842, Copse 169730585, Maggotts 169733768, Becketts 430075118, Chapel Curve 169733766/169733769, Hangar Straight 169733770, Stowe 169848880, Vale 169848881/169848884, Wellington Straight 169618242, Brooklands 169618240/169618241, Luffield 169618245, Woodcote 169730588, National Pit Straight 3571477. Pit lanes are tagged `raceway=pit_lane`: National 227838385, **International (GP) pit lane 227902927**. Mostly `surface=asphalt`; a few segments carry "Estimate" notes. Also present: the Stowe club circuit and the karting track.
- Buildings (Overpass, `building` + `name` in same bbox): **Silverstone Wing way 227332429** (`building:levels=3`, `height=30`), **18 named grandstand footprints** (`building=grandstand`: Copse A/B/C, Becketts, Village B, Farm Curve, Woodcote A/B, National Pit Straight, The View, Luffield, Abbey, International Paddock, Silverstone Six, Wellington, Hamilton Straight A, Chapel), Silverstone Museum 437429280, Hilton Garden Inn 227342443, Porsche Experience Centre 359423684.
- **License: ODbL 1.0** (<https://www.openstreetmap.org/copyright>). Requirements: credit "OpenStreetMap" and make clear the data is ODbL. For an interactive site/game, attribution may live in a corner, a splash/credits screen, or a menu, per the OSMF Attribution Guidelines (<https://osmfoundation.org/wiki/Licence/Attribution_Guidelines>). Share-alike: the rendered 3D scene is a *Produced Work* (attribution + notice only); share-alike attaches to *derivative databases* — i.e. if we ship an extracted/cleaned OSM data file (e.g. `silverstoneOsm.json`) on the public site, that file should stay open under ODbL, which is trivially true for a public GitHub repo (<https://opendatacommons.org/licenses/odbl/summary/>).
- Suggested attribution string: `Map data © OpenStreetMap contributors, ODbL` linked to `openstreetmap.org/copyright`.

### 1.3 `bacinger/f1-circuits` — ready-made GeoJSON centerline (no widths)

- Repo: <https://github.com/bacinger/f1-circuits>. GeoJSON of all F1 circuits, **MIT license** ("Copyright (c) 2019-2025 Tomislav Bacinger"); README disclaims it is unofficial and not approved by Formula One Licensing B.V. Circuits were traced from a Google Maps collection and validated against Wikipedia; altitudes are single per-circuit values from a "Highs and lows" article.
- Silverstone file: `circuits/gb-1948.geojson` (3 962 bytes, listing via <https://api.github.com/repos/bacinger/f1-circuits/contents/circuits>). **Verified by download: a single LineString of 135 points, measured length 5878 m; properties `length: 5891`, `altitude: 196`.** Coarser than TUMFTM (no widths, 44 m average spacing) but WGS84-georeferenced, which TUMFTM's local x/y is not — useful for georeferencing the TUMFTM centerline against the LIDAR raster.

### 1.4 `f1laps/f1-track-vectors` — dead end

- Repo: <https://github.com/f1laps/f1-track-vectors>. README: "SVG files for all Formula 1 tracks", **"This repository is not maintained anymore"**, pointing to www.f1-track-vectors.com. MIT LICENSE file exists, but the repo root now contains **only** `.gitattributes`, `LICENSE`, `README.md` — no data files (<https://api.github.com/repos/f1laps/f1-track-vectors/contents/>). The successor site currently fails TLS (cert for `*.kasserver.com`, checked 2026-08-21). f1laps is an F1-game telemetry company, so any recovered vectors would carry game-derived provenance anyway. Skip; TUMFTM + OSM dominate it.

---

## 2. Elevation (circuit ≈ 52.073 N, −1.015 W → OS grid SP 676 421; Copse–Stowe area, ~150–162 m AOD)

### 2.1 Environment Agency **LIDAR Composite DTM 1 m** — the prize

- Dataset: "LIDAR Composite Digital Terrain Model (DTM) — 1m", Defra Data Services Platform, <https://environment.data.gov.uk/dataset/13787b9a-26a4-4775-8523-806d13af58fc>. 1 m raster from airborne LIDAR (surveys 2000–2022), covering **~99 % of England**, vertical accuracy **±15 cm RMSE**, heights in metres above Newlyn datum. Distributed as **GeoTIFF in 5 km tiles aligned to the OS National Grid**. License: **Open Government Licence v3**.
- Tile: converting the circuit's extents to OSGB (computed WGS84→OSGB, Helmert + TM, accurate to metres): easting 466.6–468.5 km, northing 241.3–243.8 km — i.e. **the entire GP loop fits inside the single 5 km tile `SP64SE`** (E 465–470 km, N 240–245 km; start/finish at ~SP 6747 4270). Download via the Defra Survey Data Download portal: <https://environment.data.gov.uk/survey> (select "LIDAR Composite DTM 2022 1m", tile SP64SE). The circuit is rural lowland Northamptonshire, squarely inside the composite's coverage; confirm the tile visually in the portal when downloading.
- **OGL v3 terms** (<https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/>): free to copy, adapt, and exploit commercially; required attribution where the provider specifies none: **"Contains public sector information licensed under the Open Government Licence v3.0."** For EA data the conventional form is "Contains Environment Agency data © Environment Agency and database right [year]", plus a link to the OGL.

### 2.2 OS Terrain 50 — coarse fallback

- <https://www.ordnancesurvey.co.uk/products/os-terrain-50>: GB-wide DTM, **50 m post spacing** (plus 10 m contours), ASCII grid / GeoPackage / Shapefile, "free to use for everyone" as OS OpenData under **OGL v3** with OS's specified attribution **"Contains OS data © Crown copyright and database right [year]"** (<https://www.ordnancesurvey.co.uk/products/open-data>). 50 m posts would smooth away Silverstone's subtle crests (e.g. the drop into Stowe); only worth it if the LIDAR path fails.

### 2.3 Global fallbacks

- **Copernicus DEM GLO-30**: 30 m global DSM, "available worldwide with a free license"; required notice when distributing: *"© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved"* (modified-data variant prefixed "produced using Copernicus WorldDEM-30…") — <https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM>; also mirrored on AWS Open Data (<https://registry.opendata.aws/copernicus-dem/>).
- **NASA SRTMGL1 v003**: 30 m, 60 N–56 S, "openly shared, without restriction" per NASA EOSDIS use policy, citation requested (<https://www.earthdata.nasa.gov/data/catalog/lpcloud-srtmgl1-003>).
- Both are 30 m DSM/DEM — fine for the surrounding landscape bowl, useless for on-track elevation. Not needed given 2.1.

---

## 3. Finished 3D models (public GitHub Pages site = public redistribution; CC0/CC-BY only)

### 3.1 Sketchfab — mind the fake licenses

Search via the public API (<https://api.sketchfab.com/v3/search?type=models&q=silverstone+circuit&downloadable=true>), licenses verified per model page/API:

- **"Silverstone Circuit 2024 layout"** (uid `bbaf4b12d5244c76998fd44f771fc0b3`, 1.20 M faces) and **"Silverstone Circuit 1999 layout"** (uid `cad872e65ded4292a2061a7cc3b48d78`, 92 k faces), both by Tyler_Dave, both *labelled* CC-BY 4.0 — but both are tagged **`ripped`, `ripped-model`, `asseto-corsa`**, i.e. extracted from Assetto Corsa (<https://sketchfab.com/3d-models/silverstone-circuit-2024-layout-bbaf4b12d5244c76998fd44f771fc0b3>). The uploader cannot grant CC-BY on Kunos's copyrighted content, so the license label is void. **Unusable — this is the exact trap.** (Same author's Daytona/Red Bull Ring uploads follow the pattern.)
- **"Mini Silverstone"** by DylanJade3D (uid `add361cb7e124c9aab1cb869ab43fd13`, 87 k faces, CC-BY 4.0) is an original stylized *karting* circuit — legitimate license, wrong subject.
- Legitimately usable generic trackside sets found (all CC-BY 4.0 unless noted, from `q=grandstand` / `q=race track barrier tyre` searches):
  - **"Race Track Assets Pack"** — Cherk, uid `4a863e7005d647adb2f72775cf41e808`, 563 k faces: concrete barriers, tyre barriers, safety rail, brake markers, cones, light posts. Best single prop pack found.
  - **"Tyre Barrier (Single Model)"** — Cherk, uid `21d2ff0e4e0c4c709b884a152ee8aa88`, 510 k faces (needs decimation for web).
  - **"Seating"** — Krish, uid `9a7040f72e264471a4086a1249822431`, 770 k faces (grandstand seating).
  - CC-BY-**NC** (judgment call; site is non-commercial but NC on a public page is grey — avoid): "Grandstand" (Catholomew, 89 k faces), "Primo Karting" (Nikita Teploukhov).
- No downloadable F1 pit-building model surfaced (`q=pit building f1` returned zero downloadable results).
- Rule of thumb: on Sketchfab, check the tags/description for `ripped`/game names before trusting the license badge; CC-BY requires crediting the author on the site.

### 3.2 Poly Haven — CC0 textures and sky, two exact-fit finds

- License: **everything CC0** — commercial use, no attribution, redistribution all allowed (<https://polyhaven.com/license>).
- Textures (verified via <https://api.polyhaven.com/assets?t=textures&c=asphalt>): **`asphalt_track`** ("dark, fine-grained tarmac… low-gloss, slightly weathered") and **`asphalt_pit_lane`** — purpose-made race-surface PBR sets up to 8K. Plus `worn_asphalt`, `aerial_asphalt_01` for service roads, and grass/ground categories for the infield.
- Models: catalogue (<https://api.polyhaven.com/assets?t=models>) is furniture/props — **no grandstands, fences, or barriers**. Skip for structures.
- HDRIs: large CC0 outdoor/sky library (<https://polyhaven.com/hdris>) — an overcast-English-sky HDRI is the cheapest single realism win for lighting.

### 3.3 Kenney / OpenGameArt / Blend Swap

- **Kenney Racing Kit**: modular low-poly racing kit, **110 models**, **CC0**, FBX/OBJ + Unity (<https://kenney.nl/assets/racing-kit>). Stylized, so it clashes with a realism goal, but fine as placeholder marshal huts/gantries.
- **OpenGameArt "Modular Racetrack – 3D Models"**: Fertile Soil Productions, **CC0**, OBJ; track pieces only, no scenery (<https://opengameart.org/content/modular-racetrack-3d-models>). OGA search otherwise thin for grandstands.
- **Blend Swap**: blocked automated access (HTTP 403, checked 2026-08-21); licenses vary per blend (CC0/CC-BY/CC-BY-NC…). Check manually at <https://www.blendswap.com> and record the per-blend license before use.

### 3.4 Open-source racing sims — no Silverstone, as expected

- **Speed Dreams** (GPLv2+ code, Free Art License media): the official track list has **no Silverstone and no real F1 circuit under its real name** — circuits are fictional or renamed lookalikes (<https://sourceforge.net/p/speed-dreams/wiki/ListOfTracks/>).
- **TORCS** (GPLv2, <https://sourceforge.net/projects/torcs/>): same pattern — its bundled tracks are fictional/renamed (e.g. "Brondehach"); no Silverstone advertised anywhere in the shipped set.
- **Rigs of Rods** (GPLv3): ships "only a small selection of built-in content; most vehicles, terrains… are provided as user-generated mods" distributed separately (<https://github.com/RigsOfRods/rigs-of-rods>) — nothing usable here.
- Conclusion: real-circuit names/scenery are absent from open sims for exactly the trademark/licensing reasons that make this research necessary; there is **no GPL/FAL Silverstone to lift**.

### 3.5 Why Assetto Corsa / rFactor community tracks are out

Free-to-download ≠ freely licensed. Community Silverstones for AC/rFactor (a) ship with **no license grant at all** — default copyright, no redistribution right; (b) are very often conversions of commercial content (laser-scanned Kunos/Studio 397/Codemasters meshes — the Sketchfab uploads in 3.1, tagged `ripped` + `asseto-corsa`, document the practice); and (c) modding-site terms don't transfer any rights to re-host. Redistributing one on a public GitHub Pages site would be straightforward copyright infringement with identifiable provenance. **Out, without exception, including "free" ones.**

---

## 4. Legal notes (brief, practical, not legal advice)

- **Layout as facts**: the shape of a real race track — coordinates, widths, elevations — is factual/geographic data, not a copyrightable work; independently-surveyed datasets of it (OSM, TUMFTM, EA LIDAR) are governed by their *database* licenses (ODbL, LGPL, OGL), all of which permit this use with attribution (sections 1–2). What *is* copyrighted is any particular authored expression: someone's mesh, textures, scan data.
- **ODbL share-alike scope**: our rendered scene is a Produced Work → attribution + license notice suffice; only extracted OSM-derived *data files* we publish must remain open (<https://opendatacommons.org/licenses/odbl/summary/>, <https://osmfoundation.org/wiki/Licence/Attribution_Guidelines>).
- **"Silverstone" as a name**: the venue is operated by Silverstone Circuits Limited (company 00882843, <https://find-and-update.company-information.service.gov.uk/company/00882843>), which licenses the brand commercially; SILVERSTONE marks are registered (check the UKIPO register, <https://trademarks.ipo.gov.uk/ipo-tmtext>, before any commercial step). Using the name *descriptively* in a personal, non-commercial fan sim — "a sim of the Silverstone circuit" — is nominative use and low-risk in practice; risk rises with: implying endorsement, using the circuit's logo/branding/sponsor boards, or monetization. The repo already uses the name; keep a "not affiliated with Silverstone Circuits Ltd / Formula 1" line in the README (bacinger's repo does the same for F1).
- **Attribution block to ship** (footer or credits screen):
  - `Map data © OpenStreetMap contributors (ODbL)` → openstreetmap.org/copyright
  - `Contains Environment Agency LIDAR data © Environment Agency, licensed under the Open Government Licence v3.0`
  - `Track widths: TUMFTM racetrack-database (LGPL-3.0)`
  - Per-asset CC-BY credits for any Sketchfab props used.

---

## 5. Recommended approach — ranked by realism-per-effort for this codebase

The generator already consumes waypoints + halfWidths and samples elevation via `queryWheel`; feed it better numbers before adding any meshes.

1. **(a) Replace the 21 hand waypoints with the surveyed centerline + real widths.** Grab `tracks/Silverstone.csv` from TUMFTM (1.2 above; 1178 pts @ 5 m, loop 5887 m, per-point left/right widths). Resample to whatever density `fillet.js`/`centerline.js` wants, map `w_tr_left_m + w_tr_right_m → halfWidth`, keep `filletToLength` only as a final 5891 m normalizer (0.07 % scale). One CSV, no new dependencies, and every corner radius/width becomes real. **Do this first.**
2. **(b) Real elevation through the existing `queryWheel` path.** Download EA LIDAR Composite DTM 1 m tile **SP64SE** (GeoTIFF, OGL v3, 2.1 above). Offline (Python/GDAL script in `scripts/`): georeference the TUMFTM centerline using bacinger's WGS84 `gb-1948.geojson` (1.3) or the OSM ways, sample the DTM every ~5 m along centerline plus left/right edge offsets (giving camber/banking too), and bake to a small JSON/Float32 array consumed by `js/track/elevation.js`. Silverstone is "flat" but its ~10 m of real roll (Abbey crest, dip into Stowe) is precisely the realism the sim currently lacks.
3. **(c) Extrude OSM footprints for the Wing, grandstands, pit lane.** One Overpass export (bbox in 1.2) → Wing (way 227332429, 3 levels/30 m — extrude with a simple roofline) + 18 grandstand footprints (extrude + instanced seat-row shader) + International pit lane way 227902927 to generate the pit lane ribbon with the existing road generator. All ODbL-attributed data, all procedural — matches the codebase's style, zero mesh downloads.
4. **(d) CC0 surface + sky dressing.** Poly Haven `asphalt_track` + `asphalt_pit_lane` textures on the generated ribbon, grass/ground CC0 sets for the infield, and one overcast-sky HDRI for lighting (3.2). No attribution burden.
5. **(e) Selective CC-BY hero props.** Cherk's "Race Track Assets Pack" / "Tyre Barrier" for tyre stacks, rails, and marker boards (decimate before shipping; credit on the site). Kenney Racing Kit (CC0) only for far-LOD filler.
6. **Do not** use the Sketchfab Silverstone models (AC rips, 3.1/3.5) or any sim-racing mod content, regardless of license badge.
