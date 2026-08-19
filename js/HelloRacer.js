import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { Car } from './Car.js';
import { MaterialPanel } from './MaterialPanel.js';
import { createSilverstone } from './track/Silverstone.js';
import { nextCameraMode } from './cameraModes.js';

class HelloRacer {
  constructor() {
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.stats = null;

    this.car = null;
    this.track = null;
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

    this._lastTime = 0;
    this._animate = this._animate.bind(this);
  }

  init() {
    const container = document.getElementById('container');

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xa8d6ff);
    this.scene.fog = new THREE.Fog(0xa8d6ff, 250, 1400);

    this.camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.01, 200000);
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
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.stats = new Stats();
    this.stats.domElement.style.cssText = 'position:absolute;top:0;z-index:100';
    container.appendChild(this.stats.domElement);

    window.addEventListener('resize', () => this._onResize());
    document.addEventListener('keydown', e => this._onKeyDown(e));
    document.addEventListener('keyup', e => this._onKeyUp(e));

    this._setupMouseControls();

    this.track = createSilverstone();
    this.scene.add(this.track);

    this.car = new Car(this.scene);
    this.car.loadAssets();
    this._placeCarOnTrack();
    new MaterialPanel(this.car.bodyPaintMat);

    this._lastTime = performance.now();
    this._animate();
  }

  _setupLights() {
    this.scene.add(new THREE.HemisphereLight(0xcce6ff, 0x4a6a3f, 0.9));

    const key = new THREE.DirectionalLight(0xfff1d0, 2.7);
    key.position.set(40, 90, 25);
    this.scene.add(key);

    const back = new THREE.DirectionalLight(0x9fc0ff, 0.9);
    back.position.set(-35, 30, -55);
    this.scene.add(back);

    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(0, 18, 35);
    this.scene.add(fill);
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
    const dt = (now - this._lastTime) * 0.001;
    this._lastTime = now;

    this.car.updateSteering(dt);
    this.car.updatePhysics(dt, this.track);
    this._updateCamera(dt);

    this.renderer.render(this.scene, this.camera);
    this.stats.update();
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
    const speed = car.cvel.length();
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

    this._camPos.set(
      pos.x - hDist * Math.sin(this._followYaw) + this._panOffset.x,
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

new HelloRacer().init();
