import * as THREE from 'three';
import { BinLoader } from './BinLoader.js';
import { step } from './physics/bicycle.js';

const DEG2RAD = THREE.MathUtils.DEG2RAD;
const DEG90   = Math.PI / 2;

export class Car {
  constructor(scene) {
    this.root = new THREE.Object3D();
    scene.add(this.root);

    this.body = new THREE.Object3D();
    this.body.rotation.y = DEG90;
    this.root.add(this.body);

    this.lfw = this._makeWheel( 1.3928, 0.34, -0.69);
    this.rfw = this._makeWheel( 1.4,    0.34,  0.69);
    this.lrw = this._makeWheel(-2,      0.34, -0.69);
    this.rrw = this._makeWheel(-2,      0.34,  0.69);

    this.cvel = new THREE.Vector2();
    this.av   = 0;
    this.axPrev = 0;

    this._vel   = new THREE.Vector2();
    this._a2d   = new THREE.Vector2();
    this._acc   = new THREE.Vector2();
    this._trackHint = 0;
    this._spawn = { x: 0, z: 0, yaw: 0 };

    this.steerAngle   = 0;
    this._steerSmooth = 0;
    this._braking     = false;

    this.brakeMat     = null;
    this.bodyPaintMat = null;

    this.input = { forward: false, reverse: false, left: false, right: false, brake: false };
  }

  _makeWheel(x, y, z) {
    const w = new THREE.Object3D();
    w.position.set(x, y, z);
    w._spinPivot = new THREE.Object3D();
    w.add(w._spinPivot);
    this.root.add(w);
    return w;
  }

  loadAssets() {
    const envMap = new THREE.CubeTextureLoader().load(
      ['right','left','top','bottom','front','back']
        .map(f => `obj/textures/envmap/envmap_${f}.jpg`)
    );
    envMap.mapping = THREE.CubeReflectionMapping;

    const tl  = new THREE.TextureLoader();
    const tex = url => { const t = tl.load(url); t.colorSpace = THREE.SRGBColorSpace; return t; };

    const blackMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9, metalness: 0 });

    this.bodyPaintMat = new THREE.MeshLambertMaterial({
      map: tex('obj/textures/BodyPaint.jpg'), envMap, combine: THREE.MixOperation, reflectivity: 0.6
    });
    this.brakeMat = new THREE.MeshStandardMaterial({
      color: 0x800000, map: tex('obj/textures/RearLights.jpg'),
      roughness: 0.5, metalness: 0, emissive: 0x330000, emissiveIntensity: 0.4
    });

    const bodyParts = {
      BodyPaint:     { x:0,       y:0.5859,  z:0,       mat: this.bodyPaintMat },
      Suspension:    { x:0,       y:0.4044,  z:-0.3071, mat: new THREE.MeshStandardMaterial({ color:0x333333, roughness:0.7, metalness:0.4 }) },
      InsideBlack:   { x:0,       y:0.5773,  z:0.729,   mat: blackMat },
      GlossyBlack:   { x:0,       y:0.4115,  z:-0.7112, mat: new THREE.MeshStandardMaterial({ color:0x111111, roughness:0.1, metalness:0.5 }) },
      Chrome:        { x:0,       y:0.5867,  z:0.3202,  mat: new THREE.MeshStandardMaterial({ color:0xcccccc, envMap, envMapIntensity:1.0, roughness:0.05, metalness:1.0 }) },
      Bolts:         { x:0,       y:0.5694,  z:0.8672,  mat: new THREE.MeshStandardMaterial({ color:0x666666, roughness:0.5, metalness:0.6 }) },
      Windshield:    { x:0,       y:0.6777,  z:0.5647,  mat: new THREE.MeshStandardMaterial({ color:0xaaccff, envMap, envMapIntensity:0.7, roughness:0.05, metalness:0.1, transparent:true, opacity:0.35, side:THREE.DoubleSide }) },
      RearLight:     { x:0,       y:0.4652,  z:-2.34,   mat: this.brakeMat },
      RearLightGlass:{ x:0,       y:0.4652,  z:-2.34,   mat: new THREE.MeshStandardMaterial({ color:0xff2200, envMap, envMapIntensity:0.4, roughness:0.05, metalness:0.1, transparent:true, opacity:0.7, side:THREE.DoubleSide }) },
      SteeringWheel: { x:0,       y:0.5933,  z:0.5054,  mat: new THREE.MeshPhongMaterial({ map:tex('obj/textures/SteeringWheel.jpg'), specular:0x333333, shininess:40 }) },
      DriverBody:    { x:-0.0113, y:0.4063,  z:0.5277,  mat: new THREE.MeshPhongMaterial({ map:tex('obj/textures/Driver.jpg'), shininess:10 }) },
      Helmet:        { x:0.0016,  y:0.7287,  z:-0.0175, mat: new THREE.MeshStandardMaterial({ map:tex('obj/textures/Helmet.jpg'), envMap, envMapIntensity:0.4, roughness:0.2, metalness:0.3 }) },
      Visor:         { x:0.0016,  y:0.6993,  z:0.052,   mat: new THREE.MeshStandardMaterial({ map:tex('obj/textures/Visor.jpg'),  envMap, envMapIntensity:0.7, roughness:0.05, metalness:0.1, transparent:true, opacity:0.8, side:THREE.DoubleSide }) },
    };

    const wheelParts = {
      Tyre:      new THREE.MeshPhongMaterial({ map:tex('obj/textures/Tyre.jpg'), specular:0x333333, shininess:40 }),
      Rim:       new THREE.MeshStandardMaterial({ map:tex('obj/textures/Rim.jpg'), envMap, envMapIntensity:0.7, roughness:0.15, metalness:0.9 }),
      WheelBase: blackMat,
    };

    for (const [name, p] of Object.entries(bodyParts)) {
      BinLoader.load(`obj/js/${name}.bin`, geo => {
        const mesh = new THREE.Mesh(geo, p.mat);
        mesh.position.set(p.x, p.y, p.z);
        this.body.add(mesh);
      });
    }

    const rotLeft  = new THREE.Matrix4().makeRotationY(-DEG90);
    const rotRight = new THREE.Matrix4().makeRotationY( DEG90);

    for (const [name, mat] of Object.entries(wheelParts)) {
      BinLoader.load(`obj/js/${name}.bin`, geo => {
        const leftGeo  = geo.clone().applyMatrix4(rotLeft);
        const rightGeo = geo.clone().applyMatrix4(rotRight);
        this.lfw._spinPivot.add(new THREE.Mesh(leftGeo,  mat));
        this.lrw._spinPivot.add(new THREE.Mesh(leftGeo,  mat));
        this.rfw._spinPivot.add(new THREE.Mesh(rightGeo, mat));
        this.rrw._spinPivot.add(new THREE.Mesh(rightGeo, mat));
      });
    }

    const shadowTex = tl.load('obj/textures/Shadow.jpg');
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(7.2, 7.2),
      new THREE.MeshBasicMaterial({
        map: shadowTex, transparent: true, depthWrite: false,
        blending: THREE.MultiplyBlending, premultipliedAlpha: true
      })
    );
    shadow.position.set(-0.35, 0.01, 0.08);
    shadow.rotation.x = -Math.PI / 2;
    shadow.rotation.z = -Math.PI / 2;
    this.root.add(shadow);
  }

  // Car meshes face -Z at yaw 0, so visual left is +yaw.
  setHeadingFromTangent(tx, tz) {
    this.root.rotation.y = Math.atan2(-tx, -tz);
  }

  headingForward(out) {
    const y = this.root.rotation.y;
    return out.set(-Math.sin(y), 0, -Math.cos(y));
  }

  headingForwardAt(yaw, out) {
    return out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  }

  // Matches root.rotation.y: travel direction in XZ from the legacy cvel mapping.
  travelYaw() {
    if (this.cvel.lengthSq() < 0.16) return this.root.rotation.y;
    return Math.atan2(-this.cvel.y, this.cvel.x);
  }

  forwardSpeed() {
    const y = this.root.rotation.y;
    return this.cvel.y * -Math.sin(y) + (-this.cvel.x) * -Math.cos(y);
  }

  setSpawn(x, z, yaw) {
    this._spawn = { x, z, yaw };
  }

  applyWallImpulse(nx, nz, sign, penetration) {
    const pos = this.root.position;
    pos.x -= sign * penetration * nx;
    pos.z -= sign * penetration * nz;

    const vx = this.cvel.y;
    const vz = -this.cvel.x;
    const vDotN = vx * nx + vz * nz;
    if (vDotN * sign > 0) {
      this.cvel.y -= sign * vDotN * nx * 1.2;
      this.cvel.x += sign * vDotN * nz * 1.2;
      this.av *= 0.5;
    }
  }

  updateSteering(dt) {
    const rate   = 2.5 * dt;
    const target = (this.input.left ? -1 : 0) + (this.input.right ? 1 : 0);
    if (target === 0) {
      const clamp = Math.min(rate, Math.abs(this._steerSmooth));
      this._steerSmooth += this._steerSmooth > 0 ? -clamp : clamp;
    } else if (target > this._steerSmooth) {
      this._steerSmooth += rate;
    } else {
      this._steerSmooth -= rate;
    }
    this._steerSmooth = THREE.MathUtils.clamp(this._steerSmooth, -1, 1);
    const speed = Math.abs(this.forwardSpeed());
    const maxSteer = (18 - 12 * THREE.MathUtils.clamp(speed / 80, 0, 1)) * DEG2RAD;
    this.steerAngle = -this._steerSmooth * maxSteer;
  }

  _rotateYaw(localX, localY, sinY, cosY, out) {
    out.x =  cosY * localY + sinY * localX;
    out.y = -sinY * localY + cosY * localX;
    return out;
  }

  updatePhysics(dt, track) {
    const n = 4;
    const h = Math.min(dt, 0.05) / n;
    const throttle = this.input.reverse && !this.input.forward
      ? -0.25
      : (this.input.forward ? 1 : 0);

    const braking = this.input.brake || this.input.reverse;
    if (this.brakeMat && braking !== this._braking) {
      this._braking = braking;
      this.brakeMat.emissive.setHex(braking ? 0xff1100 : 0x330000);
      this.brakeMat.emissiveIntensity = braking ? 1.5 : 0.4;
    }

    let wheelSpin = 0;
    if (h > 0) {
      for (let i = 0; i < n; i++) {
        const gy = this.root.rotation.y;
        const sinY = Math.sin(gy);
        const cosY = Math.cos(gy);
        const vel = this._rotateYaw(this.cvel.x, this.cvel.y, sinY, cosY, this._vel);
        const sample = track.query(this.root.position.x, this.root.position.z);
        this._trackHint = sample.index;

        const result = step(
          { vx: vel.x, vy: vel.y, av: this.av, axPrev: this.axPrev },
          { throttle, brake: this.input.brake, steer: this.steerAngle },
          sample,
          h
        );

        this._acc.set((result.vx - vel.x) / h, (result.vy - vel.y) / h);
        this.av = result.av;
        this.axPrev = result.axPrev;
        this._rotateYaw(this._acc.x, this._acc.y, sinY, cosY, this._a2d);
        this.cvel.x += h * this._a2d.x;
        this.cvel.y += h * this._a2d.y;

        this.root.position.z -= h * this.cvel.x;
        this.root.position.x += h * this.cvel.y;
        this.root.rotation.y += h * this.av;

        if (Math.abs(sample.lateral) > sample.wallLimit) {
          const sign = sample.lateral > 0 ? -1 : 1;
          const penetration = Math.abs(sample.lateral) - sample.wallLimit;
          this.applyWallImpulse(sample.normal.x, sample.normal.z, sign, penetration);
        }

        if (!Number.isFinite(this.cvel.x)) {
          this.cvel.set(0, 0);
          this.av = 0;
          this.axPrev = 0;
          this.root.position.x = this._spawn.x;
          this.root.position.z = this._spawn.z;
          this.root.rotation.y = this._spawn.yaw;
          break;
        }

        wheelSpin += h * result.vx / 0.334;
      }
    }

    this.lfw.rotation.y = this.steerAngle;
    this.rfw.rotation.y = this.steerAngle;

    for (const w of [this.lfw, this.rfw, this.lrw, this.rrw])
      w._spinPivot.rotation.z -= wheelSpin;
  }
}
