import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { Car } from './Car.js';
import { createDefaultCircuit, DEFAULT_CIRCUIT_NAME } from './track/defaultCircuit.js';
import { GltfDropZone } from './mod/gltfDrop.js';
import { CarPicker } from './dash/CarPicker.js';
import { DEFAULT_CAR_ID, readStoredCarId } from './mod/carCatalog.js';
import { loadCarGlb } from './mod/loadCarGlb.js';
import { RenderPanel } from './render/RenderPanel.js';
import { defaultRenderValues, DEFAULT_RENDER_SCALE } from './render/renderPanelState.js';
import {
  BLOOM_INPUT_CLAMP, CINEMATIC_DEFAULTS, CINEMATIC_SLIDERS, WEBGL_BLOOM_SCALE,
  cinematicFeatures, focusDistanceFor, motionBlurStrengthForSpeed,
} from './render/cinematicState.js';
import {
  applyCinematicValues, setCinematicFocus,
} from './render/cinematicPost.js';
import { nextCameraMode, DRIVER_CAMERA, CAMERA_NEAR, adjustChaseZoom, CHASE_ZOOM, FINISH_CAMERA } from './cameraModes.js';
import {
  createChassisCamera, updateChassisCamera, speedFov,
} from './render/chassisCamera.js';
import { Dashboard } from './dash/Dashboard.js';
import { ControlHints } from './dash/ControlHints.js';
import { createTelemetry } from './dash/telemetry.js';
import { SetupPanel } from './dash/setupPanel.js';
import { PhysicsModePanel, ensureTopRightStack } from './dash/PhysicsModePanel.js';
import {
  readStoredPhysicsMode, resolvePhysicsMode, writeStoredPhysicsMode,
} from './physics/physicsMode.js';
import { defaultSetup } from './physics/setup.js';
import {
  createGhostState, recordGhostStep, completeLap, advanceGhost, ghostTime,
} from './physics/ghost.js';
import {
  createTelemetryRecorder, downloadLogCSV, logLength,
} from './physics/telemetryLog.js';
import {
  directionFromEquirectUV, sunDirectionFromEquirect, horizonColorFromEquirect,
} from './render/equirect.js';
import { outdoorSkyData, DEFAULT_SUN_U, DEFAULT_SUN_V } from './render/outdoorSky.js';
import { createRendererBackend, setRendererPreferenceAndReload, wantsWebGpuRenderer, applyRenderScale } from './render/rendererBackend.js';
import { prepareCarEffectsBackend } from './render/carEffects.js';
import {
  followDirectionalSun,
  HEMISPHERE_INTENSITY,
  RIM_INTENSITY,
  ENVIRONMENT_INTENSITY,
  TONE_EXPOSURE,
  SUN_INTENSITY,
  SHADOW_INTENSITY,
} from './render/lightingBalance.js';
import { OVERCAST_LIGHTING, qualityPreset, nextQualityPreset } from './render/renderQuality.js';
import {
  createQualityScaler, stepQualityScaler, setQualityManual, qualityCaption,
} from './render/qualityScaler.js';
import { EngineAudio } from './audio/EngineAudio.js';
import {
  setPose, resetVehicle, createVehicle, replayStep, renderPose, telemetryOf,
} from './physics/vehicle.js';
import { resetGhost as resetGhostState } from './physics/ghost.js';
import { GroundedSkybox } from 'three/addons/objects/GroundedSkybox.js';

const SKY_COLOR = 0xa8d6ff;
const FOG_NEAR = 250;
const FOG_FAR = 1400;
// Only has to reach past the ground plane, which extends fog.far beyond the
// circuit. Everything past FOG_FAR is solid fog colour, so nothing pops in.
const VIEW_FAR = 6000;
// Longest frame the simulation and camera will honour, seconds.
const MAX_FRAME_DT = 0.05;

// Rear chase camera. Everything speed-dependent here is deliberately gentle: the
// boom used to grow 5.5 m while the lens widened 13 degrees, and the two together
// made the car render about 2.4x smaller at 300 km/h than at a standstill. The
// sense of speed comes from the ground going past, not from backing away from it.
const CHASE_DISTANCE = 5.2;          // metres behind the car, at rest
const CHASE_SPEED_PULLBACK = 0.6;    // extra metres by the reference speed
const CHASE_LOOK_AHEAD = 0.8;        // metres ahead of the car to aim at, at rest
const CHASE_LOOK_AHEAD_FAR = 4.0;    // and by the reference speed
const CHASE_LOOK_HEIGHT = 0.75;      // metres up the car to aim at
const CHASE_PITCH = 0.24;            // radians above the car
const CHASE_HEIGHT_BIAS = 0.38;      // metres of lift on top of the boom's own rise
const CHASE_FOV_GAIN = 5;            // degrees of extra field of view at speed
const CHASE_REFERENCE_SPEED = 80;    // m/s, near the car's top speed
const CHASE_FOLLOW_STIFFNESS = 0.02; // lower follows harder; 0.08 lagged ~0.4 s
const HDRI_URL = 'obj/textures/sky/kloofendal_48d_partly_cloudy_puresky_2k.hdr';
// Ground-projected dome: radius must exceed fog.far; height sets where the
// horizon meets the track plane.
const SKYBOX_HEIGHT = 1.6;
const SKYBOX_RADIUS = 2200;
// `GroundedSkybox` flattens its lower hemisphere into a disc at `position.y -
// height`. That disc is opaque terrain-height geometry, so it has to sit below
// every real surface or it submerges them. The circuit's surfaces sit at the
// elevation profile (around y = 0 on the grid, ± a few metres of hill), and
// the real ground reaches 1610 m with fog at 1400 m, so the disc is never needed
// as ground — it only has to stay out of the way.
const SKYBOX_GROUND_Y = -0.35;
const SKYBOX_Y = SKYBOX_HEIGHT + SKYBOX_GROUND_Y;

class HelloRacer {
  constructor() {
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.stats = null;

    this.car = null;
    this.track = null;
    this.dashboard = null;
    this.controlHints = null;
    this._launched = false;
    this.telemetry = null;
    this._camRadius = CHASE_DISTANCE;
    this._pitch = CHASE_PITCH;
    this._yaw = 0;
    this._panOffset = new THREE.Vector3();
    this._camTarget = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._lookSmoothed = new THREE.Vector3();
    this._camOffset = new THREE.Vector3();
    this._lookOffset = new THREE.Vector3();
    this._followYaw = 0;
    this._camRoll = 0;
    this._camAv = 0;
    this._chaseReady = false;
    this._telemetryRecorder = createTelemetryRecorder();
    this._renderScale = DEFAULT_RENDER_SCALE;
    /** Tap Space toggles the log; hold (~180 ms) engages brake without logging a false pedal. */
    this._spaceBrakePending = false;
    this._spaceBrakeTimer = null;
    this._baseFov = 35;
    this._dragButton = -1;
    this._lastMouse = { x: 0, y: 0 };

    this._viewMode = 'chase';
    this._qualityId = 'ultra';
    this._qualityScaler = createQualityScaler({ preset: this._qualityId });
    this._atmosphere = 'overcast';

    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._sunDir = new THREE.Vector3();
    this._envMap = null;
    this._skybox = null;
    this._rendererBackend = 'webgl';
    this._useCsm = true;
    this._useComposer = true;
    this._useRenderPipeline = false;
    this._csm = null;
    this._sunLight = null;
    this._webgpuCsm = null;
    this._renderPipeline = null;
    this._webgpuPost = null;
    this._composer = null;
    this._aoPass = null;
    this._csmMaterialsReady = false;
    this._csmMaterialSet = new WeakSet();
    this._csmMaterialScanFrames = 120;
    this._bounceLight = null;
    this._rimLight = null;
    this._sunIntensity = OVERCAST_LIGHTING.sunIntensity;
    this._shadowIntensity = OVERCAST_LIGHTING.shadowIntensity;
    this._envIntensity = OVERCAST_LIGHTING.envIntensity;
    this._toneExposure = OVERCAST_LIGHTING.toneExposure;
    this.renderPanel = null;
    this.physicsModePanel = null;
    this.physicsMode = resolvePhysicsMode(
      typeof location !== 'undefined' ? location.search : '',
      readStoredPhysicsMode(),
    );
    this._headCam = createChassisCamera();
    this.setup = null;
    this.setupPanel = null;
    this.ghost = null;
    this.ghostCar = null;
    this._ghostMesh = null;
    this._ghostWasVisible = false;
    this._lastLapCount = 0;
    this.engineAudio = new EngineAudio();
    this._fx = {
      csm: true,
      // GTAO (replaces SSAO): depth+normal AO in linear HDR before OutputPass.
      // Default off — on WebGPU the full TSL stack is ~2× scene cost (pre-pass +
      // lit pass + GTAO + SSGI + TRAA); WebGL uses GTAOPass. Toggle in Render panel.
      ssao: false,
      bounce: true,
      /** MSAA + light temporal + sharpen. Toggle with `T`. */
      taa: true,
      grade: true,
      /**
       * Cinematic post: velocity-driven motion blur, bloom, lens flare, DoF.
       *
       * On the WebGPU path these live in a node graph whose tail is rebuilt
       * when one of these flags changes (see `cinematicPost.js`), so each one
       * is genuinely absent from the shader when off rather than multiplied by
       * zero. Bloom and motion blur are the default look; depth of field is a
       * replay effect and stays off until asked for.
       *
       * On WebGL only bloom is available — motion blur and DoF need the
       * per-pixel velocity buffer, and the WebGL composer has no pre-pass that
       * writes one. That asymmetry is the reason WebGPU is the default.
       */
      motionBlur: CINEMATIC_DEFAULTS.motionBlur,
      bloom: CINEMATIC_DEFAULTS.bloom,
      flare: CINEMATIC_DEFAULTS.flare,
      dof: CINEMATIC_DEFAULTS.dof,
    };
    this._bloomPass = null;

    this._lastTime = 0;
    this._animate = this._animate.bind(this);
  }

  async init() {
    const container = document.getElementById('container');

    this.scene = new THREE.Scene();
    // Fog only tints geometry; the HDRI background is unfogged. Horizon colour
    // is sampled from the equirect so the ground plane fades into the sky
    // rather than a mismatched solid blue.
    this.scene.background = new THREE.Color(SKY_COLOR);
    this.scene.fog = new THREE.Fog(SKY_COLOR, FOG_NEAR, FOG_FAR);

    // The circuit is about 1.8 km across, so `far` only has to clear the sky
    // dome. The old 0.01–200000 range spent essentially all of its depth
    // precision on nothing: at 100 m it could only resolve ~6 cm, while the track
    // ribbons are stacked 2–25 mm apart, which z-fights.
    this.camera = new THREE.PerspectiveCamera(
      35, window.innerWidth / window.innerHeight, CAMERA_NEAR, VIEW_FAR);
    this.camera.position.set(0, 2, 8);

    this._setupLights();

    try {
      const backend = await createRendererBackend(THREE, {
        antialias: true,
        renderScale: this._renderScale,
      });
      this.renderer = backend.renderer;
      this._rendererBackend = backend.backend;
      this._useCsm = backend.useCsm;
      this._useComposer = backend.useComposer;
      this._useRenderPipeline = backend.useRenderPipeline;
    } catch (err) {
      container.innerHTML = '<p style="font:14px sans-serif;padding:2em;text-align:center">This demo needs a browser with WebGL.</p>';
      console.error(err);
      return;
    }
    container.appendChild(this.renderer.domElement);

    if (this._useRenderPipeline) {
      // Post-processing is optional; the world is not. A throw in here used to
      // propagate out of `init()` long before the track and car were built, so a
      // single bad node in the pipeline produced an entirely empty scene rather
      // than an unfiltered one — and the only clue was one line in the console.
      // `render()` already falls back to `renderer.render()` when
      // `_renderPipeline` is null, so degrading is safe.
      try {
        await this._setupWebGpuPipeline();
      } catch (err) {
        this._renderPipeline = null;
        console.error(
          '[HelloRacer] WebGPU render pipeline failed to build — '
          + 'continuing without post-processing.',
          err,
        );
      }
    } else if (this._useCsm) {
      await this._setupCSMAndPost();
    }

    // FPS lives in the foldable Render panel; keep Stats for its timers only.
    this.stats = new Stats();

    window.addEventListener('resize', () => this._onResize());
    document.addEventListener('keydown', e => this._onKeyDown(e));
    document.addEventListener('keyup', e => this._onKeyUp(e));

    this._setupMouseControls();
    const unlockAudio = () => this.engineAudio.unlock();
    document.addEventListener('pointerdown', unlockAudio, { once: true });
    document.addEventListener('keydown', unlockAudio, { once: true });

    // NodeMaterial never runs `onBeforeCompile`, so the WebGPU path builds the
    // asphalt surface variation and the grass sway as TSL node graphs instead.
    // That module statically imports `three/tsl`, which pulls in the whole WebGPU
    // build, so the WebGL path must never load it — hence the dynamic import.
    let surfaceNodes = null;
    if (this._rendererBackend === 'webgpu') {
      surfaceNodes = await import('./render/tslSurfaceNodes.js');
      await prepareCarEffectsBackend('webgpu');
    }
    // The ground has to reach past the fog, or its edge shows on the horizon.
    this.track = createDefaultCircuit({ groundMargin: FOG_FAR * 1.15, surfaceNodes });
    this.scene.add(this.track);
    this._modScenery = new THREE.Group();
    this._modScenery.name = 'userScenery';
    this.scene.add(this._modScenery);

    this._loadEnvironment();

    this.car = new Car(this.scene, {
      backend: this._rendererBackend,
      physicsMode: this.physicsMode,
    });
    // Materials that explicitly receive `envMap` need it wired in; otherwise
    // dielectrics go unnaturally dark (no ambient IBL).
    this.car.loadAssets(this._envMap);
    this._placeCarOnTrack();
    const topRight = ensureTopRightStack(container);
    this._mountRenderPanel(topRight);
    this._mountPhysicsModePanel(topRight);
    this._mountCarPicker(topRight);

    this.telemetry = createTelemetry({ lapLength: this.track.centerline.length });
    this.dashboard = new Dashboard(container, this.track, { circuitName: DEFAULT_CIRCUIT_NAME });
    this.controlHints = new ControlHints(container);
    this._mountModLoader(container);

    // Setup screen. Applying one rebuilds the car, because half of a setup lives in
    // derived state — roll stiffness, corner loads, the suspension's own rates —
    // and mutating one value in place would leave the rest describing the old car.
    this.setupPanel = new SetupPanel(container, {
      onApply: setup => this._applySetup(setup),
    });

    // Ghost lap. The recorder is attached to the player's vehicle so inputs are
    // captured on the sim clock, which is the only clock a replay can trust.
    this.ghost = createGhostState();
    this.ghostCar = createVehicle({ physicsMode: this.physicsMode });
    this.car.vehicle.recorder = this.ghost.current;
    this._syncTelemetryObserver();
    this._setupResetControl(container);

    this._applyQualityPreset(this._qualityId);
    this._lastTime = performance.now();
    this._animate();
  }

  /**
   * Outdoor IBL. Prefers a Polyhaven HDRI if present; otherwise a linear
   * equirect with a hot sun, so chrome and the shadow light share a direction.
   * `obj/textures/envmap/` stays unused — it is a dark studio.
   */
  _loadEnvironment() {
    this._applyHdrEnvironment(this._makeOutdoorSkyTexture());
    this._tryLoadPackedHdri();
  }

  _tryLoadPackedHdri() {
    fetch(HDRI_URL).then(response => {
      if (!response.ok) return null;
      return response.arrayBuffer();
    }).then(buffer => {
      if (!buffer) return;
      const loader = new HDRLoader().setDataType(THREE.FloatType);
      const texData = loader.parse(buffer);
      if (!texData?.width || texData.width < 512) return;
      const texture = new THREE.DataTexture(texData.data, texData.width, texData.height);
      texture.type = texData.type;
      texture.format = THREE.RGBAFormat;
      texture.colorSpace = texData.colorSpace;
      texture.minFilter = texData.minFilter;
      texture.magFilter = texData.magFilter;
      texture.generateMipmaps = texData.generateMipmaps;
      texture.flipY = texData.flipY;
      this._applyHdrEnvironment(texture);
    }).catch(() => {});
  }

  _makeOutdoorSkyTexture() {
    const { data, width, height } = outdoorSkyData();
    const texture = new THREE.DataTexture(data, width, height);
    texture.type = THREE.FloatType;
    texture.format = THREE.RGBAFormat;
    texture.colorSpace = THREE.LinearSRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.flipY = true;
    texture.needsUpdate = true;
    return texture;
  }

  _applyHdrEnvironment(source) {
    source.mapping = THREE.EquirectangularReflectionMapping;
    source.needsUpdate = true;
    this.scene.background = null;
    this._setGroundedSkybox(source);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromEquirectangular(source).texture;
    pmrem.dispose();
    if (this._envMap) this._envMap.dispose();
    this._envMap = env;
    this.scene.environment = env;
    this.scene.environmentIntensity = this._envIntensity;
    this.renderer.toneMappingExposure = this._toneExposure;

    const img = source.image;
    if (img && img.data && img.width && img.height) {
      const sun = sunDirectionFromEquirect(img.data, img.width, img.height);
      this._sunDir.set(sun.x, sun.y, sun.z);
      const hz = horizonColorFromEquirect(img.data, img.width, img.height);
      this.scene.fog.color.setRGB(hz.r / (1 + hz.r), hz.g / (1 + hz.g), hz.b / (1 + hz.b));
    }
    // CSM wants the direction the light travels, which is away from the sun.
    // Handing it `_sunDir` put all four cascade lights below the ground shining
    // upward, so every upward-facing surface — the whole circuit — went unlit.
    if (this._csm?.lightDirection) {
      this._csm.lightDirection.copy(this._sunDir).negate().normalize();
    } else if (this._sunLight) {
      followDirectionalSun(this._sunLight, this._sunDir, this.camera.position);
    }
  }

  _setGroundedSkybox(source) {
    if (this._skybox) {
      this.scene.remove(this._skybox);
      this._skybox.geometry.dispose();
      this._skybox.material.map = null;
      this._skybox.material.dispose();
      this._skybox = null;
    }
    this._skybox = new GroundedSkybox(source, SKYBOX_HEIGHT, SKYBOX_RADIUS);
    this._skybox.position.y = SKYBOX_Y;
    this._skybox.frustumCulled = false;
    // The sky is what fog fades *into*, so fogging it is circular. The dome sits
    // at radius 2200 while fog.far is 1400, which saturated the fog factor at
    // 1.0 over every pixel of it: the whole sky rendered as one flat wash of
    // fog colour and the HDRI's clouds never appeared. `scene.background` was
    // immune to this because backgrounds are not fogged — meshes are.
    this._skybox.material.fog = false;
    this._skybox.material.needsUpdate = true;
    this.scene.add(this._skybox);
  }

  /**
   * User-supplied glTF / glb — car body or scenery. IP is the uploader's problem.
   */
  _mountModLoader(container) {
    new GltfDropZone(container, {
      // A dropped file is an unknown quantity: assume it brings its own wheels
      // only if the fitter can actually find them, which `loadExternalModel`
      // decides for itself.
      onCar: root => this.car?.loadExternalModel(root),
      onTrack: root => {
        while (this._modScenery.children.length) {
          this._modScenery.remove(this._modScenery.children[0]);
        }
        this._modScenery.add(root);
      },
      onError: () => {},
    });
  }

  /**
   * Foldable lighting / FX overlay. Reflectivity used to live in MaterialPanel;
   * everything scene-relevant sits here so keys and sliders share one state.
   */
  _mountRenderPanel(container) {
    const backend = this._rendererBackend === 'webgpu' ? 'webgpu' : 'webgl';
    const initial = {
      ...defaultRenderValues(backend),
      ...this._fx,
      toneExposure: this._toneExposure,
      envIntensity: this._envIntensity,
      sunIntensity: this._sunIntensity,
      shadowIntensity: this._shadowIntensity,
      hemiIntensity: this._bounceLight?.intensity
        ?? defaultRenderValues(backend).hemiIntensity,
      rimIntensity: this._rimLight?.intensity
        ?? defaultRenderValues(backend).rimIntensity,
      reflectivity: this.car?.bodyPaintMat?.reflectivity ?? 0.45,
      aoBlend: this._aoPass?.blendIntensity ?? 0.45,
      renderScale: this._renderScale,
    };
    this.renderPanel = new RenderPanel(container, {
      backend,
      initial,
      onChange: (key, value) => this._onRenderPanelChange(key, value),
      onWebGpuChange: (enabled) => {
        setRendererPreferenceAndReload(enabled ? 'webgpu' : 'webgl');
      },
    });
  }

  _mountCarPicker(container) {
    this.carPicker = new CarPicker(container, {
      initial: readStoredCarId(),
      onChange: (id, entry) => this._applyCatalogCar(id, entry),
    });
    // Restore last pick after the default body has started loading.
    const stored = readStoredCarId();
    if (stored !== DEFAULT_CAR_ID) {
      queueMicrotask(() => this.carPicker.apply(stored).catch(() => {}));
    }
  }

  /**
   * Swap the visual body from the car catalog. `default` restores the bundled mesh.
   * @param {string} id
   * @param {import('./mod/carCatalog.js').CarCatalogEntry} entry
   */
  async _applyCatalogCar(id, entry) {
    if (!this.car) return;
    if (!entry.url) {
      this.car.clearExternalModel();
      return;
    }
    const root = await loadCarGlb(entry.url);
    this.car.loadExternalModel(root, { hasOwnWheels: entry.hasOwnWheels === true });
  }

  _mountPhysicsModePanel(container) {
    this.physicsModePanel = new PhysicsModePanel(container, {
      initial: this.physicsMode,
      onChange: mode => this._applyPhysicsMode(mode),
    });
  }

  _applyPhysicsMode(mode) {
    this.physicsMode = mode;
    writeStoredPhysicsMode(mode);
    const setup = this.setup ?? defaultSetup();
    this.car.rebuild(setup, { physicsMode: mode });
    this.car.vehicle.recorder = this.ghost.current;
    this.ghostCar = createVehicle({ physicsMode: mode });
    this._placeCarOnTrack();
    this._syncTelemetryObserver();
    this.telemetry.reset?.();
    resetGhostState(this.ghost);
  }

  /** Sample the physics log on the sim clock while recording is active. */
  _syncTelemetryObserver() {
    const rec = this._telemetryRecorder;
    const track = this.track;
    this.car.vehicle.observer = rec.active
      ? v => { rec.observe(v, track); }
      : null;
  }

  /**
   * Space toggles CSV telemetry capture. Brake still uses the same key on hold;
   * a short tap only toggles the recorder so the CSV does not get a spurious
   * brake sample on the keydown that starts or stops logging.
   */
  _toggleTelemetryRecord() {
    const rec = this._telemetryRecorder;
    const nowRecording = rec.toggle();
    this._syncTelemetryObserver();
    this.controlHints?.setRecording(nowRecording);
    if (nowRecording) return;

    const samples = logLength(rec.log);
    if (samples > 0) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      downloadLogCSV(rec.log, `telemetry-${stamp}.csv`);
    }
  }

  _onRenderPanelChange(key, value) {
    switch (key) {
      case 'toneExposure':
        this._toneExposure = value;
        if (this.renderer) this.renderer.toneMappingExposure = value;
        break;
      case 'renderScale':
        this._renderScale = value;
        if (this.renderer) {
          applyRenderScale(this.renderer, value);
          this._onResize();
        }
        break;
      case 'envIntensity':
        this._envIntensity = value;
        if (this.scene) this.scene.environmentIntensity = value;
        break;
      case 'sunIntensity':
        this._sunIntensity = value;
        this._applySunAndShadow();
        break;
      case 'shadowIntensity':
        this._shadowIntensity = value;
        this._applySunAndShadow();
        break;
      case 'hemiIntensity':
        if (this._bounceLight) this._bounceLight.intensity = value;
        break;
      case 'rimIntensity':
        if (this._rimLight) this._rimLight.intensity = value;
        break;
      case 'reflectivity':
        if (this.car?.bodyPaintMat) {
          this.car.bodyPaintMat.reflectivity = value;
          this.car.bodyPaintMat.needsUpdate = true;
        }
        break;
      case 'aoBlend':
        if (this._aoPass && this._aoPass.blendIntensity !== undefined) {
          this._aoPass.blendIntensity = value;
        }
        if (this._webgpuPost?.aoPass?.scale) {
          this._webgpuPost.aoPass.scale.value = value * 2.2;
        }
        break;
      case 'ssao':
        this._setFxSsao(value);
        break;
      case 'bounce':
        this._setFxBounce(value);
        break;
      case 'csm':
        this._setFxCsm(value);
        break;
      case 'taa':
        this._setFxTaa(value);
        break;
      case 'grade':
        this._setFxGrade(value);
        break;
      case 'motionBlur':
        this._setFxMotionBlur(value);
        break;
      case 'bloom':
        this._setFxBloom(value);
        break;
      case 'flare':
        this._setFxFlare(value);
        break;
      case 'dof':
        this._setFxDof(value);
        break;
      default:
        if (key in CINEMATIC_SLIDERS) this._applyCinematicSlider(key, value);
        break;
    }
  }

  _applySunAndShadow() {
    // WebGL CSM owns an array of cascade DirectionalLights; WebGPU uses one
    // sun light + CSMShadowNode (no `.lights` list to poke).
    if (this._rendererBackend === 'webgl' && this._csm?.lights) {
      for (const light of this._csm.lights) {
        light.intensity = this._sunIntensity;
        // The cascade lights are where WebGL's shadows come from, so this is
        // what the CSM toggle has to reach. `_setFxCsm` can only see
        // `_sunLight`, which is null on this backend — so before this line the
        // toggle moved and nothing happened at all.
        light.castShadow = this._fx.csm;
        if (light.shadow) light.shadow.intensity = this._shadowIntensity;
      }
      if (this._csm.lightIntensity !== undefined) {
        this._csm.lightIntensity = this._sunIntensity;
      }
    }
    if (this._sunLight) {
      // Key-light intensity has nothing to do with the shadow cascade. This
      // read `this._fx.csm ? this._sunIntensity : 0`, so switching shadows off
      // switched the sun off with them and the frame went *darker* — measured
      // 13/255 darker, where removing shadows can only ever brighten.
      this._sunLight.intensity = this._sunIntensity;
      // And the shadow is gated by its own intensity rather than by
      // `castShadow`, because clearing `castShadow` on a light that carries a
      // `CSMShadowNode` does not retire the cascade — the lookup goes stale and
      // reads as fully shadowed, which measured *darker* again (under-car road
      // 15.7 -> 9.5). Zeroing the intensity is the one knob that resolves at
      // runtime without rebuilding every material that samples the cascade.
      this._sunLight.shadow.intensity = this._fx.csm ? this._shadowIntensity : 0;
    }
  }

  _setFxSsao(on) {
    this._fx.ssao = Boolean(on);
    if (this._aoPass?.enabled !== undefined) this._aoPass.enabled = this._fx.ssao;
    this._setWebGpuAoEnabled(this._fx.ssao);
    this.renderPanel?.syncFx({ ssao: this._fx.ssao });
  }

  _setFxBounce(on) {
    this._fx.bounce = Boolean(on);
    if (this._bounceLight) this._bounceLight.visible = this._fx.bounce;
    this.renderPanel?.syncFx({ bounce: this._fx.bounce });
  }

  _setFxCsm(on) {
    this._fx.csm = Boolean(on);
    // `castShadow` is deliberately left alone on the WebGPU sun — see
    // `_applySunAndShadow`, which gates the cascade by shadow intensity and
    // carries the flag to the WebGL cascade lights, a different set of lights.
    this._applySunAndShadow();
    this.renderPanel?.syncFx({ csm: this._fx.csm });
  }

  _setFxTaa(on) {
    this._fx.taa = Boolean(on);
    if (this._taaPass) this._taaPass.enabled = this._fx.taa;
    if (this._sharpenPass) this._sharpenPass.enabled = this._fx.taa;
    if (!this._fx.taa && this.camera) this.camera.clearViewOffset();
    this.renderPanel?.syncFx({ taa: this._fx.taa });
  }

  _setFxGrade(on) {
    this._fx.grade = Boolean(on);
    if (this._gradingPass) this._gradingPass.enabled = this._fx.grade;
    // WebGPU has no grading *pass*: the curve is a node at the end of the
    // cinematic tail, so switching it changes the graph and needs a rebuild.
    // Without this the checkbox moved and nothing happened on the default
    // backend — measured 8.76% of the frame crushed at or below 5/255 either
    // way, against the 2% this curve exists to deliver.
    this._syncCinematicFeatures();
    this.renderPanel?.syncFx({ grade: this._fx.grade });
  }

  /** Cycle Ultra → High → Balanced. Hotkey `Q`. Pauses auto for a few seconds. */
  _cycleQuality() {
    this._qualityId = nextQualityPreset(this._qualityId || 'ultra');
    setQualityManual(this._qualityScaler, this._qualityId);
    this._applyQualityPreset(this._qualityId);
  }

  _applyQualityPreset(id) {
    const q = qualityPreset(id);
    this._qualityId = id;
    this._renderScale = q.renderScale;
    if (this.renderer) {
      applyRenderScale(this.renderer, q.renderScale);
      this._onResize();
    }
    this._setFxCsm(q.csm);
    this._setFxTaa(q.taa);
    this._setFxGrade(q.grade);
    this._fx.ssao = q.ssao;
    this._fx.bounce = q.bounce;
    this._fx.motionBlur = q.motionBlur;
    this._fx.bloom = q.bloom;
    this._fx.flare = q.flare;
    this._fx.motionBlurStrength = q.motionBlurStrength;
    if (this._aoPass) this._aoPass.blendIntensity = q.aoBlend;
    this.track?.setGrassDensity(q.grassDensity);
    this.car?.setSmokeBudget(q.smokeBudget);
    this._syncCinematicFeatures();
    this.renderPanel?.syncFx({
      ssao: this._fx.ssao,
      bounce: this._fx.bounce,
      csm: this._fx.csm,
      taa: this._fx.taa,
      grade: this._fx.grade,
      motionBlur: this._fx.motionBlur,
      bloom: this._fx.bloom,
      flare: this._fx.flare,
    });
    this.renderPanel?.setMeterExtra(qualityCaption(this._qualityScaler));
  }

  _tickQualityScaler(frameMs) {
    if (!this._qualityScaler) return;
    const step = stepQualityScaler(this._qualityScaler, frameMs);
    if (step.changed) this._applyQualityPreset(step.preset);
    else this.renderPanel?.setMeterExtra(qualityCaption(this._qualityScaler));
  }

  /**
   * Key light is the same sun the HDRI shows, and its shadow frustum is a
   * 80 m square around the car — a map over the whole circuit would be mush.
   * Sky fill comes from `scene.environment`; a weak rim keeps the shaded
   * body from going flat in the onboard cameras.
   */
  _setupLights() {
    const sun = directionFromEquirectUV(DEFAULT_SUN_U, DEFAULT_SUN_V);
    this._sunDir.set(sun.x, sun.y, sun.z);

    const backend = wantsWebGpuRenderer() ? 'webgpu' : 'webgl';
    const hemi = OVERCAST_LIGHTING.hemiIntensity[backend] ?? OVERCAST_LIGHTING.hemiIntensity.webgl;
    const rimI = OVERCAST_LIGHTING.rimIntensity[backend] ?? OVERCAST_LIGHTING.rimIntensity.webgl;

    const rim = new THREE.DirectionalLight(0xbcd8ff, rimI);
    rim.position.set(-35, 30, -55);
    this.scene.add(rim);
    this._rimLight = rim;

    // Fill into CSM shadows. AmbientLight was removed — it is flat and stacked
    // badly with hemisphere + IBL. The sun + env map own direct lighting now.
    // Overcast preset: higher fill, softer sun — matches the reference still.
    this._bounceLight = new THREE.HemisphereLight(
      new THREE.Color(SKY_COLOR),
      new THREE.Color(0x5a5348),
      hemi,
    );
    this.scene.add(this._bounceLight);
  }

  async _setupCSMAndPost() {
    const { CSM } = await import('three/addons/csm/CSM.js');
    const { EffectComposer } = await import('three/addons/postprocessing/EffectComposer.js');
    const { RenderPass } = await import('three/addons/postprocessing/RenderPass.js');
    const { GTAOPass } = await import('three/addons/postprocessing/GTAOPass.js');
    const { OutputPass } = await import('three/addons/postprocessing/OutputPass.js');
    const { UnrealBloomPass } = await import('three/addons/postprocessing/UnrealBloomPass.js');
    const { Pass, FullScreenQuad } = await import('three/addons/postprocessing/Pass.js');
    const { createTaaPass } = await import('./render/taaPass.js');
    const { createSharpenPass } = await import('./render/sharpenPass.js');
    const { createGradingPass } = await import('./render/gradingPass.js');

    this._csm = new CSM({
      camera: this.camera,
      parent: this.scene,
      cascades: 4,
      mode: 'practical',
      maxFar: FOG_FAR,
      shadowMapSize: 2048,
      shadowBias: -0.00035,
      lightDirection: this._sunDir.clone().negate().normalize(),
      lightIntensity: SUN_INTENSITY,
      lightNear: 0.5,
      lightFar: FOG_FAR + 200,
      lightMargin: 80,
    });
    for (const light of this._csm.lights) {
      light.shadow.intensity = SHADOW_INTENSITY;
      // 4 cm of normal bias lifted the painted lines (16–20 mm up) out of the
      // shadow test, so the white stripe stayed fully lit through the car.
      light.shadow.normalBias = 0.008;
      light.shadow.radius = 4;
    }

    // Composer render targets have no MSAA unless asked. The canvas
    // `antialias: true` only applies to renderer.render(), so a composer frame
    // has to ask for `samples` itself or it is worse than the plain path.
    //
    // A depth texture is attached because TAA needs it: reprojecting last frame's
    // pixel means unprojecting this frame's depth to a world point and projecting
    // it through the previous view-projection. Without depth there is no
    // reprojection and TAA degenerates to a blur.
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const sceneTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    sceneTarget.depthTexture = new THREE.DepthTexture(size.x, size.y);
    sceneTarget.depthTexture.type = THREE.UnsignedIntType;
    this._composer = new EffectComposer(this.renderer, sceneTarget);
    this._composer.setSize(window.innerWidth, window.innerHeight);
    this._composer.addPass(new RenderPass(this.scene, this.camera));

    const { createDepthHarvestPass } = await import('./render/depthHarvest.js');
    this._depthHarvest = createDepthHarvestPass(THREE, Pass, FullScreenQuad, {
      width: size.x, height: size.y,
    });
    this._composer.addPass(this._depthHarvest);

    this._aoPass = new GTAOPass(this.scene, this.camera, size.x, size.y);
    this._aoPass.output = GTAOPass.OUTPUT.Default;
    this._aoPass.blendIntensity = 0.45;
    this._aoPass.updateGtaoMaterial({
      radius: 0.28,
      distanceExponent: 1,
      thickness: 1.2,
      scale: 1,
      samples: 16,
      screenSpaceRadius: true,
    });
    this._aoPass.updatePdMaterial({ samples: 8, rings: 2, radius: 8 });
    this._aoPass.enabled = this._fx.ssao;
    this._composer.addPass(this._aoPass);
    this._applySunAndShadow();

    // TAA before OutputPass, so the accumulation happens in linear HDR. Averaging
    // tone-mapped sRGB values is a different and wrong average.
    this._taaPass = createTaaPass(Pass, FullScreenQuad, {
      width: size.x, height: size.y,
    });
    this._taaPass.enabled = this._fx.taa;
    this._composer.addPass(this._taaPass);

    this._sharpenPass = createSharpenPass(Pass, FullScreenQuad, {
      width: size.x, height: size.y,
    });
    this._sharpenPass.enabled = this._fx.taa;
    this._composer.addPass(this._sharpenPass);

    /**
     * Bloom, ahead of `OutputPass` so it thresholds **linear HDR** rather than
     * the display-referred 0..1 that ACES hands out. This is the same reasoning
     * the grading pass records for sitting on the other side of the line, and it
     * matters more here: after tone mapping nothing exceeds 1, so an HDR
     * threshold would either catch everything or nothing.
     *
     * The WebGL tier is bloom only. Motion blur and depth of field need the
     * per-pixel velocity and view-depth buffers, which the WebGPU pre-pass
     * writes as MRT targets and this composer has no equivalent for.
     */
    this._bloomPass = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      CINEMATIC_DEFAULTS.bloomStrength * WEBGL_BLOOM_SCALE,
      CINEMATIC_DEFAULTS.bloomRadius,
      CINEMATIC_DEFAULTS.bloomThreshold,
    );
    /**
     * Clamp what the bright-pass sees — the same fix as the WebGPU tail, and
     * for the same measured reason: the sun in the shipped HDRI is 72,559 in
     * linear units, `UnrealBloomPass` has no clamp of its own, and no threshold
     * can help because the high-pass keeps the whole value rather than the
     * excess. Without this the WebGL frame renders pure white.
     *
     * Patched onto the high-pass material only, so the scene image keeps its
     * full HDR range for ACES to roll off.
     */
    this._bloomPass.materialHighPassFilter.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4 texel = texture2D( tDiffuse, vUv );',
        `vec4 texel = min( texture2D( tDiffuse, vUv ), vec4( ${BLOOM_INPUT_CLAMP.toFixed(1)} ) );`,
      );
    };
    this._bloomPass.materialHighPassFilter.needsUpdate = true;
    this._bloomPass.enabled = this._fx.bloom;
    this._composer.addPass(this._bloomPass);

    this._composer.addPass(new OutputPass());

    /**
     * No bloom. `UnrealBloomPass` could not be made to composite correctly here,
     * in either position, and the tell is that **it fails at strength zero** —
     * which rules out the bloom amount and the luminosity threshold together.
     *
     * Ahead of OutputPass, in linear HDR where it belongs, the frame came out at a
     * mean luminance of 254 of 255 for every threshold from 0.86 to 12. Moved
     * after OutputPass, where the input is the display-referred 0..1 its threshold
     * assumes, it lifts mean luminance from 124 to 178 — still at strength zero.
     * It is not blooming too hard; it is not compositing.
     *
     * Grading is the part of this the plan actually asked for a result from, and
     * it has a measured job: the rendering dashboard's crushed-shadow metric. That
     * works. Bloom is cosmetic, and shipping a pass that brightens the whole frame
     * by a third whatever it is set to is worse than not having it.
     */

    // Grading last: it is a display-referred curve, and the dashboard's
    // crushed-shadow metric is measured on display values.
    this._gradingPass = createGradingPass(Pass, FullScreenQuad);
    this._gradingPass.enabled = this._fx.grade;
    this._composer.addPass(this._gradingPass);
  }

  async _setupWebGpuPipeline() {
    const { createWebGpuSunLight, createWebGpuPost } = await import('./render/webgpuPipeline.js');
    const { sunLight, csm } = createWebGpuSunLight(
      THREE,
      this.scene,
      this._sunDir,
      { maxFar: FOG_FAR, lightMargin: 80 },
    );
    this._sunLight = sunLight;
    this._webgpuCsm = csm;
    this._csm = csm;
    this._applySunAndShadow();

    const post = createWebGpuPost(THREE, this.renderer, this.scene, this.camera, {
      values: { ...CINEMATIC_DEFAULTS, ...this._fx },
      hybridAa: this._fx.taa !== false,
      sharpenAmount: 0.28,
    });
    this._webgpuPost = post;
    this._aoPass = post.aoPass;
    // Full post stack is expensive — only wired when GTAO is toggled on in Render panel.
    this._renderPipeline = null;
    if (typeof post.setAoEnabled === 'function') {
      post.setAoEnabled(this._fx.ssao);
    } else if (post.aoEnabled) {
      post.aoEnabled.value = this._fx.ssao ? 1 : 0;
    }
  }

  _setWebGpuAoEnabled(on) {
    const post = this._webgpuPost;
    if (!post) return;
    if (typeof post.setAoEnabled === 'function') {
      post.setAoEnabled(on);
    } else if (post.aoEnabled) {
      post.aoEnabled.value = on ? 1 : 0;
    }
  }

  /** Is any effect that needs the cinematic node graph switched on? */
  _wantsCinematicPass() {
    if (this._rendererBackend !== 'webgpu' || !this._webgpuPost) return false;
    const f = this._effectiveCinematicFeatures();
    return f.motionBlur || f.bloom || f.dof || f.grade || this._fx.taa;
  }

  /** DoF follows the ghost car during replay comparison, off while driving. */
  _effectiveCinematicFeatures() {
    const ghostReplay = Boolean(
      this._ghostMesh?.visible && this.ghost?.active && this.ghost?.best != null,
    );
    return cinematicFeatures({
      ...this._fx,
      dof: this._fx.dof || ghostReplay,
    });
  }

  _syncCinematicFeatures() {
    this._webgpuPost?.setCinematicFeatures(this._effectiveCinematicFeatures());
  }

  /**
   * Point the lens at the car.
   *
   * Depth of field wants a focus plane in metres, and the plane worth having is
   * whatever the broadcast camera would be focused on: the car. Driving it from
   * the live camera-to-car distance keeps the car sharp while the barriers and
   * the kerb either side of it go soft, which is the whole effect.
   */
  _updateCinematicFocus() {
    const uniforms = this._webgpuPost?.cinematicUniforms;
    const f = this._effectiveCinematicFeatures();
    if (uniforms && f.dof && this.car && this.camera) {
      setCinematicFocus(
        uniforms,
        focusDistanceFor(this.camera.position, this.car.root.position),
      );
    }
    if (uniforms && f.motionBlur && this.car) {
      const base = this.renderPanel?.values?.motionBlurStrength
        ?? CINEMATIC_DEFAULTS.motionBlurStrength;
      applyCinematicValues(uniforms, {
        motionBlurStrength: motionBlurStrengthForSpeed(this.car.speed(), base),
      });
    }
  }

  /**
   * Flip one cinematic effect. On WebGPU this rebuilds the node graph, so the
   * disabled effect's taps leave the shader entirely rather than being
   * multiplied by zero — one hitched frame, then the cost is gone.
   */
  _setCinematicFlag(key, on) {
    this._fx[key] = Boolean(on);
    this._syncCinematicFeatures();
    if (key === 'bloom' && this._bloomPass) this._bloomPass.enabled = this._fx.bloom;
    this.renderPanel?.syncFx({ [key]: this._fx[key] });
  }

  _setFxMotionBlur(on) { this._setCinematicFlag('motionBlur', on); }
  _setFxBloom(on) { this._setCinematicFlag('bloom', on); }
  _setFxFlare(on) { this._setCinematicFlag('flare', on); }
  _setFxDof(on) { this._setCinematicFlag('dof', on); }

  /** Cinematic sliders are uniforms on WebGPU and pass fields on WebGL. */
  _applyCinematicSlider(key, value) {
    applyCinematicValues(this._webgpuPost?.cinematicUniforms, { [key]: value });
    if (!this._bloomPass) return;
    if (key === 'bloomStrength') this._bloomPass.strength = value * WEBGL_BLOOM_SCALE;
    if (key === 'bloomRadius') this._bloomPass.radius = value;
    if (key === 'bloomThreshold') this._bloomPass.threshold = value;
  }

  _setupMouseControls() {
    const el = this.renderer.domElement;
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('mousedown', e => {
      this._dragButton = e.button;
      this._lastMouse.x = e.clientX;
      this._lastMouse.y = e.clientY;
    });
    el.addEventListener('mouseup', () => { this._dragButton = -1; });
    el.addEventListener('mouseleave', () => { this._dragButton = -1; });

    el.addEventListener('mousemove', e => {
      if (this._viewMode !== 'chase' || this._dragButton === -1) return;

      const dx = e.clientX - this._lastMouse.x;
      const dy = e.clientY - this._lastMouse.y;

      if (this._dragButton === 0) {
        this._yaw -= dx * 0.005;
        this._pitch = THREE.MathUtils.clamp(this._pitch + dy * 0.005, -0.1, 1.2);
      } else if (this._dragButton === 1) {
        const panScale = this._camRadius * 0.001;
        this.camera.getWorldDirection(this._right);
        this._right.cross(this.camera.up).normalize();
        this._panOffset.addScaledVector(this._right, -dx * panScale);
        this._panOffset.addScaledVector(this.camera.up, dy * panScale);
      }

      this._lastMouse.x = e.clientX;
      this._lastMouse.y = e.clientY;
    });

    el.addEventListener('wheel', e => {
      if (this._viewMode !== 'chase') return;
      this._camRadius = adjustChaseZoom(this._camRadius, e.deltaY * 0.01);
    }, { passive: true });
  }

  _adjustChaseZoom(delta) {
    if (this._viewMode !== 'chase') return;
    this._camRadius = adjustChaseZoom(this._camRadius, delta);
  }

  _toggleHud() {
    this.dashboard.toggle();
    this.controlHints.setVisible(this.dashboard.visible);
  }

  /**
   * The kernel's flat state vector is authoritative, and `v.vx` and friends are
   * copies made once a frame. Clearing the copies by hand left the real state
   * untouched, so a reset car drove off with the velocity it had before.
   */
  _zeroVehicle(v) {
    resetVehicle(v, this.track);
  }

  _placeCarOnTrack() {
    const s = this.track.spawn();
    const yaw = Math.atan2(-s.tx, -s.tz);
    this.car.root.position.set(s.x, 0, s.z);
    this.car.root.rotation.y = yaw;
    setPose(this.car.vehicle, s.x, s.z, yaw, this.track);
    this._zeroVehicle(this.car.vehicle);
  }

  _clearCarForGridReset() {
    this._cancelSpaceBrakeArm();
    const i = this.car.input;
    i.forward = false;
    i.reverse = false;
    i.left = false;
    i.right = false;
    i.brake = false;
    this.car._braking = false;
    this.car._steerVisual = 0;
    if (this.car._steerPivot) this.car._steerPivot.rotation.z = 0;
    for (const w of [this.car.lfw, this.car.rfw, this.car.lrw, this.car.rrw]) {
      if (!w) continue;
      w.rotation.y = 0;
      if (w._spinPivot) w._spinPivot.rotation.x = 0;
    }
    this.car._tyreTempFront = 0;
    this.car._tyreTempRear = 0;
    if (this.car.brakeMat) {
      this.car.brakeMat.emissive.setHex(0x330000);
      this.car.brakeMat.emissiveIntensity = 0.4;
    }
  }

  /**
   * The run starts when the driver does: the lap clock is re-zeroed on the
   * first throttle after a grid reset, so it reads driving time rather than
   * however long the car sat parked.
   */
  _checkLaunch() {
    if (this._launched) return;
    const input = this.car.input;
    if (input.forward || input.reverse) {
      this._launched = true;
      this.telemetry.reset?.();
    }
  }

  _resetRace() {
    this._clearCarForGridReset();
    this._placeCarOnTrack();
    this.car.restoreMeshDamage();
    this._launched = false;
    if (this.telemetry?.reset) this.telemetry.reset();
    this._chaseReady = false;
    this._followYaw = this.car.root.rotation.y;
    this._lookSmoothed.copy(this.car.root.position);
    this._camRoll = 0;
    this._camAv = 0;
    if (this._telemetryRecorder?.active) {
      this._telemetryRecorder.stop();
      this._syncTelemetryObserver();
      this.controlHints?.setRecording(false);
    }
  }

  _setupResetControl(container) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Reset';
    btn.title = 'Return to the grid (Esc)';
    btn.style.cssText = [
      'position:absolute',
      'bottom:14px',
      'right:14px',
      'z-index:50',
      'font:600 12px/1 system-ui,sans-serif',
      'letter-spacing:0.04em',
      'text-transform:uppercase',
      'padding:8px 12px',
      'border:1px solid rgba(150,170,200,0.35)',
      'border-radius:4px',
      'background:rgba(8,12,18,0.72)',
      'color:#e9eff8',
      'cursor:pointer',
    ].join(';');
    btn.addEventListener('click', () => this._resetRace());
    container.appendChild(btn);
  }

  _animate() {
    requestAnimationFrame(this._animate);

    const now = performance.now();
    // Clamped once, here. A backgrounded tab or a long asset stall hands over a
    // multi-second delta; unclamped that slams the steering to full lock and
    // teleports the camera, since both integrate against dt directly.
    const rawMs = now - this._lastTime;
    const dt = Math.min(rawMs * 0.001, MAX_FRAME_DT);
    this._lastTime = now;
    this._tickQualityScaler(rawMs);

    this._checkLaunch();
    this.car.updateSteering(dt);
    this.car.updatePhysics(dt, this.track);
    // The car's effect set is built on its first physics frame, so the handover of
    // the tyre-mark texture to the asphalt happens here rather than at setup.
    if (!this._marksConnected && this.car.tyreMarkTexture) {
      this.track.setTyreMarkTexture(this.car.tyreMarkTexture);
      this._marksConnected = true;
    }

    if (this._skybox) {
      this._skybox.position.set(
        this.camera.position.x,
        SKYBOX_Y,
        this.camera.position.z,
      );
    }

    // The baked blob is the car shadow only while the real-time one is off —
    // both at once multiply into a double-dark patch under the chassis.
    this.car.setContactShadowEnabled(this._fx.csm);

    if (this._csm && this._rendererBackend === 'webgl') {
      // Car meshes arrive asynchronously (BinLoader). Scan for a short window
      // and inject CSM defines into any late materials exactly once.
      if (!this._csmMaterialsReady && this._csmMaterialScanFrames > 0) {
        this.scene.traverse(obj => {
          if (!obj.isMesh) return;
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) {
            if (!m) continue;
            if (this._csmMaterialSet.has(m)) continue;
            // MeshBasic (contact blob) and unlit materials must not get CSM
            // shader defines — that turned the multiply shadow into a black quad.
            if (!m.isMeshStandardMaterial && !m.isMeshPhysicalMaterial) {
              this._csmMaterialSet.add(m);
              continue;
            }
            this._csm.setupMaterial(m);
            this._csmMaterialSet.add(m);
          }
        });
        this._csmMaterialScanFrames--;
        if (this._csmMaterialScanFrames <= 0) this._csmMaterialsReady = true;
      }
      if (this._fx.csm) this._csm.update();
    }
    this._updateCamera(dt);

    if (this._rendererBackend === 'webgpu' && this._sunLight) {
      // Anchor the sun on the camera so CSM cascades cover the car, not the
      // world origin kilometres away from Silverstone.
      followDirectionalSun(this._sunLight, this._sunDir, this.camera.position);
      // Only the sun's *direction* is a per-frame concern. Intensity and shadow
      // strength belong to `_applySunAndShadow`, and re-deriving them here beat
      // it to the punch every frame: the sliders appeared to work because they
      // route through the same fields, but the CSM toggle's own fix was undone
      // 120 times a second, which is why zeroing `shadow.intensity` measured as
      // having no effect whatsoever.
      this._applySunAndShadow();
      if (this._webgpuCsm?.camera) this._webgpuCsm.updateFrustums();
    }
    this.track.updateTracksideLOD(this.camera);

    // The jitter has to be in the projection matrix before geometry is drawn, and
    // a Pass only gets control afterwards — so it is applied here rather than
    // inside the pass. Run on every path, because the measurement offset has to
    // work with TAA off as well as on.
    this._applyJitter();

    this._updateCinematicFocus();

    if (this._rendererBackend === 'webgl' && this._depthHarvest) {
      this.car?.bindParticleDepth({
        depthTexture: this._depthHarvest.texture,
        resolution: this.renderer.getDrawingBufferSize(this._drawSize ??= new THREE.Vector2()),
        camera: this.camera,
      });
    }

    if (this._fx.ssao && this._webgpuPost?.renderPipeline) {
      this._setWebGpuAoEnabled(true);
      this._webgpuPost.renderPipeline.render();
    } else if (this._wantsCinematicPass()) {
      // The cheap tier — scene plus velocity plus the cinematic tail. Without
      // this branch the whole node graph was reachable only behind the AO
      // toggle, so the default frame was a plain forward render with no post
      // at all: no bloom, no motion blur, and no velocity buffer to blur with.
      const cine = this._webgpuPost.getCinematicPipeline();
      if (cine) cine.pipeline.render();
      else this.renderer.render(this.scene, this.camera);
    } else if (this._composer
      && (this._fx.ssao || this._fx.taa || this._fx.grade)) {
      this._composer.render(dt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    this.stats.update();
    this.renderPanel?.update(dt);

    const snap = this.telemetry.sample(this.car, this.track, dt);
    this._updateGhost(snap, dt);
    this.engineAudio.update(snap);
    if (this.dashboard.visible) this.dashboard.update(snap, dt);
  }

  _applyJitter() {
    if (!this._taaPass) return;
    this._taaPass.enabled = this._fx.taa;
    const size = this.renderer.getDrawingBufferSize(this._drawSize ??= new THREE.Vector2());
    this._taaPass.jitter(this.camera, size.x, size.y);
    this.camera.updateMatrixWorld();
    this._taaPass.captureCamera(this.camera);
  }

  /**
   * Rebuild the car on a new setup, and put it back where it was.
   *
   * A rebuild rather than a mutation: the derived state — roll stiffness, the
   * lateral transfer arms, the suspension's rates, the corner loads — is computed
   * once from the whole setup, and writing one value into a live car leaves the
   * rest of it describing the previous one.
   */
  _applySetup(setup) {
    this.setup = setup;
    this.car.rebuild(setup, { physicsMode: this.physicsMode });
    this.car.vehicle.recorder = this.ghost.current;
    this._placeCarOnTrack();
    this.telemetry.reset?.();
    resetGhostState(this.ghost);
  }

  /**
   * Advance the ghost, and hand a completed lap to it.
   *
   * The lap boundary comes from the telemetry rather than being detected again
   * here: two independent lap detectors on the same track eventually disagree, and
   * the one that matters is the one showing the time.
   */
  _updateGhost(snap, dt) {
    if (snap.lapCount !== this._lastLapCount) {
      this._lastLapCount = snap.lapCount;
      if (Number.isFinite(snap.lastLapTime)) {
        completeLap(this.ghost, snap.lastLapTime);
        this.ghostCar.recorder = null;
        setPose(this.ghostCar, this.car.vehicle.spawn.x, this.car.vehicle.spawn.z,
          this.car.vehicle.spawn.yaw, this.track);
        resetVehicle(this.ghostCar, this.track);
      }
    }
    // The mesh can only be built once the body has loaded, which is after the
    // first frame — so it is created lazily rather than at setup.
    if (!this._ghostMesh) {
      const mesh = this.car.makeGhostMesh();
      if (mesh) {
        this._ghostMesh = mesh;
        this.scene.add(mesh);
      }
    }
    const steps = advanceGhost(this.ghost, dt,
      input => replayStep(this.ghostCar, input, this.track));
    if (this._ghostMesh) {
      const visible = this.ghost.active && steps >= 0 && this.ghost.best !== null;
      if (visible !== this._ghostWasVisible) {
        this._ghostWasVisible = visible;
        this._syncCinematicFeatures();
      }
      this._ghostMesh.visible = visible;
      if (visible) {
        const pose = renderPose(this.ghostCar, this._ghostPose ??= { x: 0, z: 0, yaw: 0 });
        this._ghostMesh.position.set(pose.x, pose.chassisY, pose.z);
        this._ghostMesh.rotation.y = pose.yaw;
      }
    }
    this._ghostDelta = this.ghost.active
      ? this.telemetry.lapTime - ghostTime(this.ghost)
      : null;
  }

  _lerpAngle(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  _expLerp(from, to, stiffness, dt) {
    return from + (to - from) * (1 - Math.pow(stiffness, dt));
  }

  _setCameraLens(fov, near = CAMERA_NEAR) {
    let dirty = false;
    if (Math.abs(this.camera.fov - fov) > 0.02) {
      this.camera.fov = fov;
      dirty = true;
    }
    if (Math.abs(this.camera.near - near) > 0.001) {
      this.camera.near = near;
      dirty = true;
    }
    if (dirty) {
      this.camera.updateProjectionMatrix();
      if (this._webgpuCsm) this._webgpuCsm.updateFrustums();
    }
  }

  /**
   * Onboard camera, moved by the chassis rather than bolted to it.
   *
   * The plan puts most of the *perceived* speed and grip in this rather than in
   * the image, and it is right in a way that is easy to underrate: a camera that
   * leans under braking, shakes over a kerb and settles as the car takes a set
   * tells you what the car is doing continuously, without a number. Nothing here
   * is keyed to an input — a camera that lurches when the brake key goes down
   * rather than when the car decelerates lies about a locked wheel.
   */
  _updateOnboardCamera(alongFwd, height, lookAhead, lookY, fov, near = CAMERA_NEAR, dt = 0) {
    const car = this.car;
    const pos = car.root.position;
    car.headingForward(this._forward);
    const sim = car.simState();
    const head = updateChassisCamera(this._headCam, {
      aLong: sim.aLong,
      aLat: sim.aLat,
      // The chassis attitude already contains the road — the suspension is fed raw
      // wheel heights and settles parallel to whatever plane it is on. Adding
      // `gradeLong` doubled the pitch and put the plane fit's per-frame noise into
      // the camera, which is where a driver would notice it most.
      pitch: sim.pitch,
      roll: sim.roll,
      heave: sim.heave,
      roughness: sim.roughness,
      speed: car.speed(),
    }, dt);

    // The head offset is in body axes; forward is the car's heading and right is
    // perpendicular to it.
    const rx = -this._forward.z;
    const rz = this._forward.x;
    this.camera.position.set(
      pos.x + this._forward.x * (alongFwd + head.x) + rx * head.z,
      pos.y + height + head.y,
      pos.z + this._forward.z * (alongFwd + head.x) + rz * head.z
    );
    // Aim through the head's pitch, so leaning under braking actually changes
    // where the driver is looking rather than only where their eyes are.
    this._camTarget.set(
      pos.x + this._forward.x * lookAhead + rx * head.z,
      pos.y + lookY + head.y - head.pitch * lookAhead,
      pos.z + this._forward.z * lookAhead + rz * head.z
    );
    this.camera.lookAt(this._camTarget);
    this.camera.rotateZ(head.roll);
    this._setCameraLens(speedFov(fov, car.speed()), near);
    this._camRoll = 0;
    this._chaseReady = false;
    this._camAv = 0;
  }

  /** Broadcast finish-line camera — elevated outside the wall at start/finish. */
  _updateFinishCamera() {
    const c = FINISH_CAMERA;
    const idx = this.track?._spawnIndex?.() ?? 0;
    const sample = this.track?.samples?.[idx];
    const car = this.car;
    if (!sample || !car) {
      this._updateOnboardCamera(2.99, 0.42, 22, 0.32, 52, CAMERA_NEAR, 0);
      return;
    }
    const side = 1;
    const wall = sample.halfWidth + sample.runoff + c.outward;
    const camX = sample.x + sample.nx * side * wall;
    const camZ = sample.z + sample.nz * side * wall;
    const scratch = this._finishCamScratch ?? (this._finishCamScratch = {
      surface: 'tarmac', mu: 1, height: 0, roughness: 0, curvature: 0, nx: 0, nz: 0,
    });
    if (this.track.queryWheel) this.track.queryWheel(camX, camZ, scratch);
    const groundY = scratch.height || car.root.position.y;
    this.camera.position.set(camX, groundY + c.height, camZ);
    const pos = car.root.position;
    this._camTarget.set(
      sample.x * 0.25 + pos.x * 0.75 + sample.tx * c.lookAlong * 0.15,
      groundY * 0.25 + (pos.y + 0.55) * 0.75,
      sample.z * 0.25 + pos.z * 0.75 + sample.tz * c.lookAlong * 0.15,
    );
    this.camera.lookAt(this._camTarget);
    this._setCameraLens(c.fov, c.near);
    this._camRoll = 0;
    this._chaseReady = false;
  }

  _updateCamera(dt) {
    if (this._viewMode === 'driver') {
      const c = DRIVER_CAMERA;
      this._updateOnboardCamera(
        c.alongFwd, c.height, c.lookAhead, c.lookY, c.fov, c.near, dt);
      return;
    }
    if (this._viewMode === 'front') {
      // Just ahead of the nose tip, which sits 2.95 m forward of the pose now
      // that the body carries MESH_FORWARD_OFFSET.
      this._updateOnboardCamera(2.99, 0.42, 22, 0.32, 52, CAMERA_NEAR, dt);
      return;
    }
    if (this._viewMode === 'finish') {
      this._updateFinishCamera();
      return;
    }

    const car = this.car;
    const pos = car.root.position;
    const speed = car.speed();
    const facingYaw = car.root.rotation.y;
    const fwdSpeed = car.forwardSpeed();

    if (speed > 0.5 && this._dragButton === -1) {
      this._yaw *= 1 - Math.min(1, dt * Math.min(1, speed * 0.05) * 2.2);
    }

    // Behind the chassis when reversing; otherwise blend facing toward travel.
    const velBlend = fwdSpeed > 1
      ? THREE.MathUtils.clamp((speed - 2) / 22, 0, 0.82)
      : 0;
    const driveYaw = this._lerpAngle(facingYaw, car.travelYaw(), velBlend);
    const targetFollowYaw = driveYaw + this._yaw;

    const yawStiffness = this._dragButton === 0 ? 0.0008 : (speed > 2 ? 0.06 : 0.012);
    if (!this._chaseReady) {
      this._followYaw = targetFollowYaw;
    } else {
      this._followYaw = this._lerpAngle(this._followYaw, targetFollowYaw, 1 - Math.pow(yawStiffness, dt));
    }

    const speedFraction = THREE.MathUtils.clamp(speed / CHASE_REFERENCE_SPEED, 0, 1);
    const dist = this._camRadius + CHASE_SPEED_PULLBACK * speedFraction;
    const hDist = dist * Math.cos(this._pitch);
    const vDist = dist * Math.sin(this._pitch);

    // Aiming far ahead pushes the car down and back in frame, which reads as
    // distance even when the boom has not moved.
    const lookAhead = CHASE_LOOK_AHEAD + (CHASE_LOOK_AHEAD_FAR - CHASE_LOOK_AHEAD)
      * THREE.MathUtils.clamp(Math.max(0, fwdSpeed) / CHASE_REFERENCE_SPEED, 0, 1);
    car.headingForwardAt(this._lerpAngle(this._followYaw, facingYaw, 0.35), this._forward);

    this._camTarget.set(
      this._forward.x * lookAhead + this._panOffset.x,
      CHASE_LOOK_HEIGHT + this._panOffset.y,
      this._forward.z * lookAhead + this._panOffset.z
    );

    // Directly opposite `headingForwardAt(followYaw)`, which is
    // (-sin, -cos): the boom is therefore (+sin, +cos). Negating x instead put
    // the camera off to one side at every heading but 0 and 180 degrees.
    //
    // Both of these are offsets from the car, not world positions, because they
    // are about to be smoothed. Smoothing a world position against a moving car
    // leaves a first-order lag of speed x time-constant: at 200 km/h that was
    // 14 m of pure lag on top of a 5.6 m boom, which is most of why the camera
    // appeared to back away as the car sped up. Smoothing the offset instead
    // tracks the car's travel rigidly and still eases changes of boom direction,
    // length and pitch, which is all that wanted easing.
    this._camPos.set(
      hDist * Math.sin(this._followYaw) + this._panOffset.x,
      vDist + CHASE_HEIGHT_BIAS + this._panOffset.y,
      hDist * Math.cos(this._followYaw) + this._panOffset.z
    );

    const posStiffness = this._dragButton === 0 ? 0.001 : CHASE_FOLLOW_STIFFNESS;
    const lookStiffness = 0.05;
    if (!this._chaseReady) {
      this._camOffset.copy(this._camPos);
      this._lookOffset.copy(this._camTarget);
      this._chaseReady = true;
    } else {
      this._camOffset.lerp(this._camPos, 1 - Math.pow(posStiffness, dt));
      this._lookOffset.lerp(this._camTarget, 1 - Math.pow(lookStiffness, dt));
    }
    this.camera.position.copy(pos).add(this._camOffset);
    this._lookSmoothed.copy(pos).add(this._lookOffset);

    // Yaw rate moves at tyre frequency; the boom should not roll at that rate.
    const pose = renderPose(car.vehicle, this._chasePose ??= {});
    this._camAv = this._expLerp(this._camAv, pose.av, 0.10, dt);
    const targetRoll = THREE.MathUtils.clamp(
      -car.steerAngle * 0.22 - this._camAv * 0.032, -0.10, 0.10);
    this._camRoll = this._expLerp(this._camRoll, this._dragButton === -1 ? targetRoll : 0, 0.04, dt);

    this.camera.lookAt(this._lookSmoothed);
    this.camera.rotateZ(this._camRoll);

    const targetFov = this._baseFov + CHASE_FOV_GAIN * speedFraction;
    const nextFov = this._expLerp(this.camera.fov, targetFov, 0.04, dt);
    this._setCameraLens(nextFov, CAMERA_NEAR);
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    applyRenderScale(this.renderer, this._renderScale);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (this._composer) this._composer.setSize(window.innerWidth, window.innerHeight);
    const size = this.renderer.getDrawingBufferSize(this._drawSize ??= new THREE.Vector2());
    this._taaPass?.setSize(size.x, size.y);
    this._sharpenPass?.setSize(size.x, size.y);
    this._depthHarvest?.setSize(size.x, size.y);
    if (this._webgpuCsm?.camera) this._webgpuCsm.updateFrustums();
  }

  _setDriveInput(e, down) {
    const i = this.car.input;
    switch (e.code) {
      case 'ArrowUp':
      case 'KeyW':
        i.forward = down;
        break;
      case 'ArrowDown':
      case 'KeyS':
        i.reverse = down;
        break;
      case 'ArrowLeft':
      case 'KeyA':
        i.left = down;
        break;
      case 'ArrowRight':
      case 'KeyD':
        i.right = down;
        break;
      default:
        break;
    }
  }

  /** ~180 ms — long enough to distinguish a log toggle tap from a brake hold. */
  static SPACE_BRAKE_HOLD_MS = 180;

  _armSpaceBrake() {
    this._cancelSpaceBrakeArm();
    this._spaceBrakePending = true;
    this._spaceBrakeTimer = setTimeout(() => {
      this._spaceBrakeTimer = null;
      if (this._spaceBrakePending) this.car.input.brake = true;
    }, HelloRacer.SPACE_BRAKE_HOLD_MS);
  }

  _cancelSpaceBrakeArm() {
    this._spaceBrakePending = false;
    if (this._spaceBrakeTimer != null) {
      clearTimeout(this._spaceBrakeTimer);
      this._spaceBrakeTimer = null;
    }
  }

  _onKeyDown(e) {
    if (e.code === 'KeyH') {
      if (!e.repeat) this._toggleHud();
      return;
    }
    // `P` for the setup panel: `S` is the brake, and stealing a driving key for a
    // menu is how a car ends up in a barrier.
    if (e.code === 'KeyP' && !e.repeat && this.setupPanel) {
      this.setupPanel.toggle();
      return;
    }
    if (e.code === 'KeyG') {
      if (!e.repeat) this._setFxGrade(!this._fx.grade);
      return;
    }
    if (e.code === 'KeyT') {
      if (!e.repeat) this._setFxTaa(!this._fx.taa);
      return;
    }
    if (e.code === 'KeyC') {
      if (e.repeat) return;
      this._viewMode = nextCameraMode(this._viewMode);
      this._yaw = 0;
      this._panOffset.set(0, 0, 0);
      this._chaseReady = false;
      this._camAv = 0;
      return;
    }
    if (e.code === 'KeyQ' && !e.repeat) {
      this._cycleQuality();
      return;
    }
    if (this._viewMode === 'chase' && !e.repeat) {
      if (e.code === 'Equal' || e.code === 'NumpadAdd') {
        this._adjustChaseZoom(-CHASE_ZOOM.step);
        e.preventDefault();
        return;
      }
      if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
        this._adjustChaseZoom(CHASE_ZOOM.step);
        e.preventDefault();
        return;
      }
    }
    if (e.code === 'Escape') {
      if (!e.repeat) this._resetRace();
      e.preventDefault();
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) {
        this._toggleTelemetryRecord();
        this._armSpaceBrake();
      } else {
        this._cancelSpaceBrakeArm();
        this.car.input.brake = true;
      }
      return;
    }
    this._setDriveInput(e, true);
  }

  _onKeyUp(e) {
    if (e.code === 'Space') {
      this._cancelSpaceBrakeArm();
      this.car.input.brake = false;
      e.preventDefault();
      return;
    }
    this._setDriveInput(e, false);
  }
}

const racer = new HelloRacer();
// Handle for the console and for the browser smoke checks: there is no other way
// to reach the live scene, camera or vehicle state from outside the module.
window.racer = racer;
racer.init().catch(err => console.error(err));
