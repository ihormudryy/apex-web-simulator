import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { Car } from './Car.js';
import { MaterialPanel } from './MaterialPanel.js';
import { createSilverstone } from './track/Silverstone.js';
import { nextCameraMode } from './cameraModes.js';
import { Dashboard } from './dash/Dashboard.js';
import { createTelemetry } from './dash/telemetry.js';
import { CSM } from 'three/addons/csm/CSM.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import {
  directionFromEquirectUV, sunDirectionFromEquirect, horizonColorFromEquirect,
} from './render/equirect.js';
import { outdoorSkyData, DEFAULT_SUN_U, DEFAULT_SUN_V } from './render/outdoorSky.js';

const SKY_COLOR = 0xa8d6ff;
const FOG_NEAR = 250;
const FOG_FAR = 1400;
// Only has to reach past the ground plane, which extends fog.far beyond the
// circuit. Everything past FOG_FAR is solid fog colour, so nothing pops in.
const VIEW_FAR = 6000;
// Longest frame the simulation and camera will honour, seconds.
const MAX_FRAME_DT = 0.05;
const SHADOW_RADIUS = 40;
const SHADOW_DISTANCE = 90;
const HDRI_URL = 'obj/textures/sky/kloofendal_48d_partly_cloudy_puresky_2k.hdr';

class HelloRacer {
  constructor() {
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.stats = null;

    this.car = null;
    this.track = null;
    this.dashboard = null;
    this.telemetry = null;
    this._camRadius = 7.5;
    this._pitch = 0.32;
    this._yaw = 0;
    this._panOffset = new THREE.Vector3();
    this._camTarget = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._lookSmoothed = new THREE.Vector3();
    this._followYaw = 0;
    this._camRoll = 0;
    this._chaseReady = false;
    this._baseFov = 35;
    this._dragButton = -1;
    this._lastMouse = { x: 0, y: 0 };

    this._viewMode = 'chase';

    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._sunDir = new THREE.Vector3();
    this._envMap = null;
    this._csm = null;
    this._composer = null;
    this._ssaoPass = null;
    this._csmMaterialsReady = false;
    this._csmMaterialSet = new WeakSet();
    this._csmMaterialScanFrames = 120;
    this._bounceLight = null;
    this._fx = {
      csm: true,
      ssao: true,
      bounce: true,
    };

    this._lastTime = 0;
    this._animate = this._animate.bind(this);
  }

  init() {
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
      35, window.innerWidth / window.innerHeight, 0.25, VIEW_FAR);
    this.camera.position.set(0, 2, 8);

    this._setupLights();

    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch (err) {
      container.innerHTML = '<p style="font:14px sans-serif;padding:2em;text-align:center">This demo needs a browser with WebGL.</p>';
      return;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this._setupCSMAndPost();

    this.stats = new Stats();
    this.stats.dom.style.cssText = 'position:absolute;top:0;z-index:100';
    container.appendChild(this.stats.dom);

    window.addEventListener('resize', () => this._onResize());
    document.addEventListener('keydown', e => this._onKeyDown(e));
    document.addEventListener('keyup', e => this._onKeyUp(e));

    this._setupMouseControls();

    // The ground has to reach past the fog, or its edge shows on the horizon.
    this.track = createSilverstone({ groundMargin: FOG_FAR * 1.15 });
    this.scene.add(this.track);

    this._loadEnvironment();

    this.car = new Car(this.scene);
    // Materials that explicitly receive `envMap` need it wired in; otherwise
    // dielectrics go unnaturally dark (no ambient IBL).
    this.car.loadAssets(this._envMap);
    this._placeCarOnTrack();
    new MaterialPanel(this.car.bodyPaintMat);

    this.telemetry = createTelemetry({ lapLength: this.track.centerline.length });
    this.dashboard = new Dashboard(container, this.track, { circuitName: 'Silverstone' });

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
    this.scene.background = source;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromEquirectangular(source).texture;
    pmrem.dispose();
    if (this._envMap) this._envMap.dispose();
    this._envMap = env;
    this.scene.environment = env;
    this.scene.environmentIntensity = 1.05;
    this.renderer.toneMappingExposure = 1.05;

    const img = source.image;
    if (img && img.data && img.width && img.height) {
      const sun = sunDirectionFromEquirect(img.data, img.width, img.height);
      this._sunDir.set(sun.x, sun.y, sun.z);
      const hz = horizonColorFromEquirect(img.data, img.width, img.height);
      this.scene.fog.color.setRGB(hz.r / (1 + hz.r), hz.g / (1 + hz.g), hz.b / (1 + hz.b));
    }
    if (this._csm) this._csm.lightDirection.copy(this._sunDir);
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

    const rim = new THREE.DirectionalLight(0xbcd8ff, 0.35);
    rim.position.set(-35, 30, -55);
    this.scene.add(rim);

    // “GI” approximation: hemisphere bounce from sky (top) to dark asphalt
    // (bottom). This is fast but sells underside fill much better than pure
    // hemispherical defaults.
    this._bounceLight = new THREE.HemisphereLight(
      new THREE.Color(SKY_COLOR),
      new THREE.Color(0x4a4a54),
      0.45,
    );
    this.scene.add(this._bounceLight);
  }

  _setupCSMAndPost() {
    this._csm = new CSM({
      camera: this.camera,
      parent: this.scene,
      cascades: 4,
      mode: 'practical',
      maxFar: FOG_FAR,
      shadowMapSize: 2048,
      shadowBias: -0.00035,
      lightDirection: this._sunDir.clone(),
      lightIntensity: 3.0,
      lightNear: 0.5,
      lightFar: FOG_FAR + 200,
      lightMargin: 80,
    });

    this._composer = new EffectComposer(this.renderer);
    const renderPass = new RenderPass(this.scene, this.camera);
    this._composer.addPass(renderPass);

    this._ssaoPass = new SSAOPass(this.scene, this.camera, 512, 512, 32);
    // Less aggressive: crushed blacks were dominated by over-darkening.
    this._ssaoPass.kernelRadius = 5;
    this._ssaoPass.minDistance = 0.004;
    this._ssaoPass.maxDistance = 0.06;
    this._ssaoPass.enabled = this._fx.ssao;
    this._composer.addPass(this._ssaoPass);

    this._composer.addPass(new OutputPass());
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
      this._camRadius = THREE.MathUtils.clamp(this._camRadius + e.deltaY * 0.01, 2, 30);
    }, { passive: true });
  }

  _placeCarOnTrack() {
    const s = this.track.spawn();
    this.car.root.position.set(s.x, 0, s.z);
    this.car.setHeadingFromTangent(s.tx, s.tz);
    this.car.setSpawn(s.x, s.z, this.car.root.rotation.y);
  }

  _animate() {
    requestAnimationFrame(this._animate);

    const now = performance.now();
    // Clamped once, here. A backgrounded tab or a long asset stall hands over a
    // multi-second delta; unclamped that slams the steering to full lock and
    // teleports the camera, since both integrate against dt directly.
    const dt = Math.min((now - this._lastTime) * 0.001, MAX_FRAME_DT);
    this._lastTime = now;

    this.car.updateSteering(dt);
    this.car.updatePhysics(dt, this.track);

    if (this._csm) {
      // Car meshes arrive asynchronously (BinLoader). Scan for a short window
      // and inject CSM defines into any late materials exactly once.
      if (!this._csmMaterialsReady && this._csmMaterialScanFrames > 0) {
        this.scene.traverse(obj => {
          if (!obj.isMesh) return;
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) {
            if (!m) continue;
            if (this._csmMaterialSet.has(m)) continue;
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

    if (this._composer) {
      this._composer.render(dt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    this.stats.update();

    // After the render, so a slow dashboard frame never holds up the picture.
    if (this.dashboard.visible) {
      this.dashboard.update(this.telemetry.sample(this.car, this.track, dt), dt);
    }
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

  _setCameraFov(fov) {
    if (Math.abs(this.camera.fov - fov) > 0.02) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  _updateOnboardCamera(alongFwd, height, lookAhead, lookY, fov) {
    const car = this.car;
    const pos = car.root.position;
    car.headingForward(this._forward);
    this.camera.position.set(
      pos.x + this._forward.x * alongFwd,
      pos.y + height,
      pos.z + this._forward.z * alongFwd
    );
    this._camTarget.set(
      pos.x + this._forward.x * lookAhead,
      pos.y + lookY,
      pos.z + this._forward.z * lookAhead
    );
    this.camera.lookAt(this._camTarget);
    this._setCameraFov(fov);
    this._camRoll = 0;
    this._chaseReady = false;
  }

  _updateCamera(dt) {
    if (this._viewMode === 'driver') {
      this._updateOnboardCamera(0.12, 1.06, 16, 0.88, 58);
      return;
    }
    if (this._viewMode === 'front') {
      this._updateOnboardCamera(2.55, 0.42, 22, 0.32, 52);
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

    const dist = this._camRadius + THREE.MathUtils.clamp(speed * 0.11, 0, 5.5);
    const hDist = dist * Math.cos(this._pitch);
    const vDist = dist * Math.sin(this._pitch);

    const lookAhead = THREE.MathUtils.clamp(3.2 + Math.max(0, fwdSpeed) * 0.22, 3.2, 12);
    car.headingForwardAt(this._lerpAngle(this._followYaw, facingYaw, 0.35), this._forward);

    this._camTarget.set(
      pos.x + this._forward.x * lookAhead + this._panOffset.x,
      pos.y + 0.95 + this._panOffset.y,
      pos.z + this._forward.z * lookAhead + this._panOffset.z
    );

    // Directly opposite `headingForwardAt(followYaw)`, which is
    // (-sin, -cos): the boom is therefore (+sin, +cos). Negating x instead put
    // the camera off to one side at every heading but 0 and 180 degrees.
    this._camPos.set(
      pos.x + hDist * Math.sin(this._followYaw) + this._panOffset.x,
      pos.y + vDist + 0.45 + this._panOffset.y,
      pos.z + hDist * Math.cos(this._followYaw) + this._panOffset.z
    );

    const posStiffness = this._dragButton === 0 ? 0.001 : 0.08;
    const lookStiffness = 0.018;
    if (!this._chaseReady) {
      this.camera.position.copy(this._camPos);
      this._lookSmoothed.copy(this._camTarget);
      this._chaseReady = true;
    } else {
      this.camera.position.lerp(this._camPos, 1 - Math.pow(posStiffness, dt));
      this._lookSmoothed.lerp(this._camTarget, 1 - Math.pow(lookStiffness, dt));
    }

    const targetRoll = THREE.MathUtils.clamp(-car.steerAngle * 0.28 - car.av * 0.06, -0.12, 0.12);
    this._camRoll = this._expLerp(this._camRoll, this._dragButton === -1 ? targetRoll : 0, 0.05, dt);

    this.camera.lookAt(this._lookSmoothed);
    this.camera.rotateZ(this._camRoll);

    const targetFov = this._baseFov + THREE.MathUtils.clamp(speed / 38, 0, 1) * 13;
    const nextFov = this._expLerp(this.camera.fov, targetFov, 0.04, dt);
    if (Math.abs(nextFov - this.camera.fov) > 0.02) {
      this.camera.fov = nextFov;
      this.camera.updateProjectionMatrix();
    }
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (this._composer) this._composer.setSize(window.innerWidth, window.innerHeight);
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
      case 'Space':
        i.brake = down;
        e.preventDefault();
        break;
      default:
        break;
    }
  }

  _onKeyDown(e) {
    if (e.code === 'KeyH') {
      if (!e.repeat) this.dashboard.toggle();
      return;
    }
    if (e.code === 'Digit1') {
      if (this._ssaoPass && !e.repeat) {
        this._fx.ssao = !this._fx.ssao;
        this._ssaoPass.enabled = this._fx.ssao;
      }
      return;
    }
    if (e.code === 'Digit2') {
      if (this._bounceLight && !e.repeat) {
        this._fx.bounce = !this._fx.bounce;
        this._bounceLight.visible = this._fx.bounce;
      }
      return;
    }
    if (e.code === 'Digit3') {
      if (!e.repeat) this._fx.csm = !this._fx.csm;
      return;
    }
    if (e.code === 'KeyC') {
      if (e.repeat) return;
      this._viewMode = nextCameraMode(this._viewMode);
      this._yaw = 0;
      this._panOffset.set(0, 0, 0);
      this._chaseReady = false;
      return;
    }
    this._setDriveInput(e, true);
  }

  _onKeyUp(e) {
    this._setDriveInput(e, false);
  }
}

const racer = new HelloRacer();
racer.init();

// Handle for the console and for the browser smoke checks: there is no other way
// to reach the live scene, camera or vehicle state from outside the module.
window.racer = racer;
