import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { BinLoader } from './BinLoader.js';
import { Car } from './Car.js';

const DEG90 = Math.PI / 2;

// Application entry point – owns the renderer, scene, camera, and game loop
class HelloRacer {
  constructor() {
    this.scene    = null;
    this.camera   = null;
    this.renderer = null;
    this.stats    = null;
    this.car      = null;

    // Camera follow state
    this._camOffset = new THREE.Vector3(0, 2.5, 7); // behind & above car
    this._camTarget = new THREE.Vector3();
    this._camPos    = new THREE.Vector3();

    this._lastTime = 0;
  }

  // Build the Three.js scene, renderer, lights, and car; then start the loop
  init() {
    const container = document.getElementById('container');

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xffffff);

    this.camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.01, 200000);
    this.camera.position.set(0, 2, 8);

    this._setupLights();

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.stats = new Stats();
    this.stats.domElement.style.cssText = 'position:absolute;top:0;z-index:100';
    container.appendChild(this.stats.domElement);

    window.addEventListener('resize',   () => this._onResize());
    document.addEventListener('keydown', e => this._onKeyDown(e));
    document.addEventListener('keyup',   e => this._onKeyUp(e));

    this.car = new Car(this.scene);
    this.car.loadAssets();
    this._loadLogo();

    this._lastTime = performance.now();
    this._animate();
  }

  // Add ambient, key, back, and fill lights to the scene
  _setupLights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.8));

    const key = new THREE.DirectionalLight(0xffffff, 3.0);
    key.position.set(2, 4, 2).normalize();
    this.scene.add(key);

    const back = new THREE.DirectionalLight(0x8899ff, 1.2);
    back.position.set(-1, 2, -2).normalize();
    this.scene.add(back);

    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(0, -1, 1).normalize();
    this.scene.add(fill);
  }

  // Load the flat HelloEnjoy logo and drop-shadow plane
  _loadLogo() {
    BinLoader.load('obj/js/HelloEnjoy.bin', geo => {
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x000000 }));
      mesh.position.y = 0.01;
      mesh.rotation.x = -DEG90;
      this.scene.add(mesh);
    });

    const tl     = new THREE.TextureLoader();
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(7.5, 7.5),
      new THREE.MeshBasicMaterial({
        map: (() => { const t = tl.load('obj/textures/Shadow.jpg'); t.colorSpace = THREE.SRGBColorSpace; return t; })(),
        transparent: true
      })
    );
    shadow.position.set(-0.4, -0.001, 0);
    shadow.rotation.x = -DEG90;
    shadow.rotation.z = -DEG90;
    this.car.root.add(shadow);
  }

  // Main render loop
  _animate() {
    requestAnimationFrame(() => this._animate());
    const now = performance.now();
    const dt  = (now - this._lastTime) * 0.001;
    this._lastTime = now;

    this.car.updateSteering(dt);
    this.car.updatePhysics(dt);
    this._updateCamera(dt);

    this.renderer.render(this.scene, this.camera);
    this.stats.update();
  }

  // Smoothly follow the car from behind using exponential lerp
  _updateCamera(dt) {
    const ry  = this.car.root.rotation.y;
    const sin = Math.sin(ry), cos = Math.cos(ry);
    const off = this._camOffset;

    // Rotate the fixed offset by the car's current yaw
    const ox = off.x * cos - off.z * sin;
    const oz = off.x * sin + off.z * cos;

    this._camPos.set(
      this.car.root.position.x + ox,
      this.car.root.position.y + off.y,
      this.car.root.position.z + oz
    );
    this._camTarget.set(
      this.car.root.position.x,
      this.car.root.position.y + 0.6,
      this.car.root.position.z
    );

    this.camera.position.lerp(this._camPos, 1 - Math.pow(0.01, dt));
    this.camera.lookAt(this._camTarget);
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  _onKeyDown(e) {
    const i = this.car.input;
    switch (e.keyCode) {
      case 38: case 87: i.forward = true;  break;
      case 40: case 83: i.reverse = true;  break;
      case 37: case 65: i.right   = true;  break;
      case 39: case 68: i.left    = true;  break;
      case 32:          i.brake   = true;  break;
    }
  }

  _onKeyUp(e) {
    const i = this.car.input;
    switch (e.keyCode) {
      case 38: case 87: i.forward = false; break;
      case 40: case 83: i.reverse = false; break;
      case 37: case 65: i.right   = false; break;
      case 39: case 68: i.left    = false; break;
      case 32:          i.brake   = false; break;
    }
  }
}

new HelloRacer().init();
