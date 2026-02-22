import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';

const DEG2RAD = Math.PI / 180;
const DEG90 = Math.PI / 2;

let camera, scene, renderer, stats;
let ambientLight, directionalLight;
let car, body, lfw, rfw, lrw, rrw, bm;
let dt, ta;

let sa = 0, s1 = 0;
let fs = false, rs = false, ur = false, ul = false, uu = false, ud = false;

const cvel = new THREE.Vector2();
const vel  = new THREE.Vector2();
const a2d  = new THREE.Vector2();
const force= new THREE.Vector2();
const res  = new THREE.Vector2();
const acc  = new THREE.Vector2();
const ft   = new THREE.Vector2();
const flf  = new THREE.Vector2();
const flr  = new THREE.Vector2();

let av = 0, aa = 0;

const camOffset = new THREE.Vector3(0, 2.5, 7);  // behind & above car
const camTarget = new THREE.Vector3();
const camPos    = new THREE.Vector3();

// ── Binary parser (old Three.js .bin format) ─────────────────────────────────

function parseBin(buf) {
  const a = new Uint8Array(buf);

  function q(p)       { return a[p]; }
  function k(p)       { return a[p] | (a[p+1] << 8); }
  function j(p)       { return a[p] | (a[p+1]<<8) | (a[p+2]<<16) | (a[p+3]<<24); }
  function n(p)       { const v = a[p]; return v > 127 ? v - 256 : v; }
  function h(p) {       // float32 little-endian
    const tmp = new Uint8Array(4);
    tmp[0]=a[p]; tmp[1]=a[p+1]; tmp[2]=a[p+2]; tmp[3]=a[p+3];
    return new Float32Array(tmp.buffer)[0];
  }

  let F = 0;
  const hdr = {
    header_bytes:           q(F+8),
    vertex_coordinate_bytes:q(F+9),
    normal_coordinate_bytes:q(F+10),
    uv_coordinate_bytes:    q(F+11),
    vertex_index_bytes:     q(F+12),
    normal_index_bytes:     q(F+13),
    uv_index_bytes:         q(F+14),
    material_index_bytes:   q(F+15),
    nvertices:   j(F+16),
    nnormals:    j(F+20),
    nuvs:        j(F+24),
    ntri_flat:       j(F+28),
    ntri_smooth:     j(F+32),
    ntri_flat_uv:    j(F+36),
    ntri_smooth_uv:  j(F+40),
    nquad_flat:      j(F+44),
    nquad_smooth:    j(F+48),
    nquad_flat_uv:   j(F+52),
    nquad_smooth_uv: j(F+56),
  };
  F += hdr.header_bytes;

  const vb = hdr.vertex_coordinate_bytes;
  const nb = hdr.normal_coordinate_bytes;
  const ub = hdr.uv_coordinate_bytes;
  const vi = hdr.vertex_index_bytes;
  const ni = hdr.normal_index_bytes;
  const ui = hdr.uv_index_bytes;
  const mi = hdr.material_index_bytes;

  // read vertices
  const vertices = [];
  for (let i = 0; i < hdr.nvertices; i++, F += vb*3) {
    vertices.push(h(F), h(F+vb), h(F+vb*2));
  }

  // read normals
  const normals = [];
  for (let i = 0; i < hdr.nnormals; i++, F += nb*3) {
    normals.push(n(F)/127, n(F+nb)/127, n(F+nb*2)/127);
  }

  // read uvs
  const uvs = [];
  for (let i = 0; i < hdr.nuvs; i++, F += ub*2) {
    uvs.push(h(F), 1 - h(F+ub));
  }

  // face index helpers
  function readIdx(p, bytes) {
    return bytes === 4 ? j(p) : bytes === 2 ? k(p) : q(p);
  }

  // collect triangles as flat arrays
  const posArr = [], normArr = [], uvArr = [];

  function addTri(v0,v1,v2, n0,n1,n2, u0,u1,u2) {
    for (const vi of [v0,v1,v2]) {
      posArr.push(vertices[vi*3], vertices[vi*3+1], vertices[vi*3+2]);
    }
    if (n0 !== -1) {
      for (const ni of [n0,n1,n2]) {
        normArr.push(normals[ni*3], normals[ni*3+1], normals[ni*3+2]);
      }
    }
    if (u0 !== -1) {
      for (const ui of [u0,u1,u2]) {
        uvArr.push(uvs[ui*2], uvs[ui*2+1]);
      }
    }
  }

  function addQuad(v0,v1,v2,v3, n0,n1,n2,n3, u0,u1,u2,u3) {
    addTri(v0,v1,v2, n0,n1,n2, u0,u1,u2);
    addTri(v0,v2,v3, n0,n2,n3, u0,u2,u3);
  }

  function readFaces(count, stride, hasNormals, hasUVs, isQuad) {
    const vCount = isQuad ? 4 : 3;
    for (let i = 0; i < count; i++, F += stride) {
      let p = F;
      const vi = [];
      for (let x = 0; x < vCount; x++, p += vi_bytes) vi.push(readIdx(p, vi_bytes));
      p += mi; // skip material index
      const ni = [];
      if (hasNormals) for (let x = 0; x < vCount; x++, p += ni_bytes) ni.push(readIdx(p, ni_bytes));
      const ui = [];
      if (hasUVs) for (let x = 0; x < vCount; x++, p += ui_bytes) ui.push(readIdx(p, ui_bytes));

      const n_ = hasNormals ? ni : [-1,-1,-1,-1];
      const u_ = hasUVs    ? ui : [-1,-1,-1,-1];
      if (isQuad) addQuad(vi[0],vi[1],vi[2],vi[3], n_[0],n_[1],n_[2],n_[3], u_[0],u_[1],u_[2],u_[3]);
      else        addTri (vi[0],vi[1],vi[2],        n_[0],n_[1],n_[2],       u_[0],u_[1],u_[2]);
    }
  }

  const vi_bytes = vi, ni_bytes = ni, ui_bytes = ui;

  const s_tri_flat      = vi*3 + mi;
  const s_tri_smooth    = vi*3 + mi + ni*3;
  const s_tri_flat_uv   = vi*3 + mi + ui*3;
  const s_tri_smooth_uv = vi*3 + mi + ni*3 + ui*3;
  const s_quad_flat     = vi*4 + mi;
  const s_quad_smooth   = vi*4 + mi + ni*4;
  const s_quad_flat_uv  = vi*4 + mi + ui*4;
  const s_quad_smooth_uv= vi*4 + mi + ni*4 + ui*4;

  readFaces(hdr.ntri_flat,       s_tri_flat,       false, false, false);
  readFaces(hdr.ntri_smooth,     s_tri_smooth,     true,  false, false);
  readFaces(hdr.ntri_flat_uv,    s_tri_flat_uv,    false, true,  false);
  readFaces(hdr.ntri_smooth_uv,  s_tri_smooth_uv,  true,  true,  false);
  readFaces(hdr.nquad_flat,      s_quad_flat,      false, false, true);
  readFaces(hdr.nquad_smooth,    s_quad_smooth,    true,  false, true);
  readFaces(hdr.nquad_flat_uv,   s_quad_flat_uv,   false, true,  true);
  readFaces(hdr.nquad_smooth_uv, s_quad_smooth_uv, true,  true,  true);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posArr), 3));
  if (normArr.length) geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normArr), 3));
  else geo.computeVertexNormals();
  if (uvArr.length)   geo.setAttribute('uv',     new THREE.BufferAttribute(new Float32Array(uvArr),  2));
  return geo;
}

function loadBin(url, callback) {
  fetch(url)
    .then(r => r.arrayBuffer())
    .then(buf => callback(parseBin(buf)))
    .catch(e => console.error('Failed to load', url, e));
}

// ── Scene setup ───────────────────────────────────────────────────────────────

function init() {
  const container = document.getElementById('container');

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.01, 200000);
  camera.position.set(0, 2, 8);

  ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
  scene.add(ambientLight);

  directionalLight = new THREE.DirectionalLight(0xffffff, 3.0);
  directionalLight.position.set(2, 4, 2).normalize();
  scene.add(directionalLight);

  const backLight = new THREE.DirectionalLight(0x8899ff, 1.2);
  backLight.position.set(-1, 2, -2).normalize();
  scene.add(backLight);

  const fillLight = new THREE.DirectionalLight(0xffffff, 0.6);
  fillLight.position.set(0, -1, 1).normalize();
  scene.add(fillLight);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  scene.background = new THREE.Color(0xffffff);

  stats = new Stats();
  stats.domElement.style.position = 'absolute';
  stats.domElement.style.top = '0px';
  stats.domElement.style.zIndex = 100;
  container.appendChild(stats.domElement);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  CreateCar();
  LoadCar();

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

  ta = performance.now();
  animate();
}

function CreateCar() {
  car = new THREE.Object3D();
  scene.add(car);

  body = new THREE.Object3D();
  body.rotation.y = DEG90;
  car.add(body);

  lfw = new THREE.Object3D();
  lfw.position.set(1.3928, 0.34, -0.69);
  car.add(lfw);

  rfw = new THREE.Object3D();
  rfw.position.set(1.4, 0.34, 0.69);
  car.add(rfw);

  lrw = new THREE.Object3D();
  lrw.position.set(-2, 0.34, -0.69);
  car.add(lrw);

  rrw = new THREE.Object3D();
  rrw.position.set(-2, 0.34, 0.69);
  car.add(rrw);
}

function LoadCar() {
  const envUrls = ['right','left','top','bottom','front','back']
    .map(f => `obj/textures/envmap/envmap_${f}.jpg`);
  const envMap = new THREE.CubeTextureLoader().load(envUrls);

  const tl = new THREE.TextureLoader();
  const loadTex = url => { const t = tl.load(url); t.colorSpace = THREE.SRGBColorSpace; return t; };

  envMap.mapping = THREE.CubeReflectionMapping;

  const parts = {
    BodyPaint:     { parent: 'body', x:0,       y:0.5859,  z:0,       mat: new THREE.MeshPhongMaterial({ map: loadTex('obj/textures/BodyPaint.jpg'), envMap, combine: THREE.MixOperation, reflectivity: 0.5, specular: 0x882222, shininess: 120 }) },
    Suspension:    { parent: 'body', x:0,       y:0.4044,  z:-0.3071, mat: new THREE.MeshPhongMaterial({ color: 0x333333, specular: 0x222222, shininess: 20 }) },
    InsideBlack:   { parent: 'body', x:0,       y:0.5773,  z:0.729,   mat: new THREE.MeshBasicMaterial({ color: 0x111111 }) },
    GlossyBlack:   { parent: 'body', x:0,       y:0.4115,  z:-0.7112, mat: new THREE.MeshPhongMaterial({ color: 0x111111, specular: 0xaaaaaa, shininess: 150 }) },
    Chrome:        { parent: 'body', x:0,       y:0.5867,  z:0.3202,  mat: new THREE.MeshPhongMaterial({ color: 0xcccccc, envMap, combine: THREE.MixOperation, reflectivity: 1.0, specular: 0xffffff, shininess: 300 }) },
    Bolts:         { parent: 'body', x:0,       y:0.5694,  z:0.8672,  mat: new THREE.MeshPhongMaterial({ color: 0x666666, specular: 0x555555, shininess: 60 }) },
    Windshield:    { parent: 'body', x:0,       y:0.6777,  z:0.5647,  mat: new THREE.MeshPhongMaterial({ color: 0xaaccff, envMap, combine: THREE.MixOperation, reflectivity: 0.7, transparent: true, opacity: 0.35, specular: 0xffffff, shininess: 200, side: THREE.DoubleSide }) },
    RearLight:     { parent: 'body', x:0,       y:0.4652,  z:-2.34,   mat: new THREE.MeshBasicMaterial({ color: 0x800000, map: loadTex('obj/textures/RearLights.jpg') }) },
    RearLightGlass:{ parent: 'body', x:0,       y:0.4652,  z:-2.34,   mat: new THREE.MeshPhongMaterial({ color: 0xff2200, envMap, combine: THREE.MixOperation, reflectivity: 0.4, transparent: true, opacity: 0.7, specular: 0xff6600, shininess: 120, side: THREE.DoubleSide }) },
    SteeringWheel: { parent: 'body', x:0,       y:0.5933,  z:0.5054,  mat: new THREE.MeshPhongMaterial({ map: loadTex('obj/textures/SteeringWheel.jpg'), specular: 0x333333, shininess: 40 }) },
    DriverBody:    { parent: 'body', x:-0.0113, y:0.4063,  z:0.5277,  mat: new THREE.MeshPhongMaterial({ map: loadTex('obj/textures/Driver.jpg') }) },
    Helmet:        { parent: 'body', x:0.0016,  y:0.7287,  z:-0.0175, mat: new THREE.MeshPhongMaterial({ map: loadTex('obj/textures/Helmet.jpg'), envMap, combine: THREE.MixOperation, reflectivity: 0.4, specular: 0xaaaaaa, shininess: 150 }) },
    Visor:         { parent: 'body', x:0.0016,  y:0.6993,  z:0.052,   mat: new THREE.MeshPhongMaterial({ map: loadTex('obj/textures/Visor.jpg'),  envMap, combine: THREE.MixOperation, reflectivity: 0.7, specular: 0xffffff, shininess: 200, side: THREE.DoubleSide }) },
    Tyre:          { parent: 'wheel',x:0,       y:0,       z:0,       mat: new THREE.MeshPhongMaterial({ map: loadTex('obj/textures/Tyre.jpg'), specular: 0x111111, shininess: 5 }) },
    Rim:           { parent: 'wheel',x:0,       y:0,       z:0,       mat: new THREE.MeshPhongMaterial({ map: loadTex('obj/textures/Rim.jpg'), envMap, combine: THREE.MixOperation, reflectivity: 0.7, specular: 0xdddddd, shininess: 200 }) },
    WheelBase:     { parent: 'wheel',x:0,       y:0,       z:0,       mat: new THREE.MeshBasicMaterial({ color: 0x111111 }) },
  };

  // store RearLight material for brake light color changes
  bm = parts.RearLight.mat;

  for (const [name, p] of Object.entries(parts)) {
    loadBin(`obj/js/${name}.bin`, geo => {
      if (p.parent === 'body') {
        const mesh = new THREE.Mesh(geo, p.mat);
        mesh.position.set(p.x, p.y, p.z);
        body.add(mesh);
      } else {
        for (const [wheel, sign] of [[lfw,-1],[rfw,1],[lrw,-1],[rrw,1]]) {
          const mesh = new THREE.Mesh(geo, p.mat);
          mesh.position.set(p.x, p.y, p.z);
          mesh.rotation.y = sign * DEG90;
          wheel.add(mesh);
        }
      }
    });
  }

  // HelloEnjoy logo
  loadBin('obj/js/HelloEnjoy.bin', geo => {
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x000000 }));
    mesh.position.y = 0.01;
    mesh.rotation.x = -DEG90;
    scene.add(mesh);
  });

  // Shadow plane
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(7.5, 7.5),
    new THREE.MeshBasicMaterial({ map: loadTex('obj/textures/Shadow.jpg'), transparent: true })
  );
  shadow.position.set(-0.4, -0.001, 0);
  shadow.rotation.x = -DEG90;
  shadow.rotation.z = -DEG90;
  car.add(shadow);
}

// ── Game loop ─────────────────────────────────────────────────────────────────

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  dt = (now - ta) * 0.001;
  ta = now;
  UpdateCar();
  SteerWheels();
  UpdateCamera();
  renderer.render(scene, camera);
  stats.update();
}

function SteerWheels() {
  const rate = 2.5 * dt;
  let target = (ul ? -1 : 0) + (ur ? 1 : 0);
  if (target === 0) { const clamp = Math.min(rate, Math.abs(s1)); s1 += s1 > 0 ? -clamp : clamp; }
  else if (target > s1) s1 += rate;
  else if (target < s1) s1 -= rate;
  s1 = Math.max(-1, Math.min(1, s1));
  sa = s1 * 20 * DEG2RAD;
}

function UpdateCar() {
  const drag = 8, linDamp = 80, frontSlip = -5, rearSlip = -5.2;
  const maxForce = 2, frontMass = 1, rearMass = 1;
  const totalMass = frontMass + rearMass;
  const gy = car.rotation.y;
  const sinY = Math.sin(gy), cosY = Math.cos(gy);

  vel.x =  cosY * cvel.y + sinY * cvel.x;
  vel.y = -sinY * cvel.y + cosY * cvel.x;

  const steerAngle = vel.x > 0 ? sa : -sa;
  let slipAngle = totalMass * 0.5 * av;

  const throttle = (uu ? 100 : 0) + (ud ? -100 : 0);

  if (Math.abs(vel.x) < 0.2 && !uu && !ud) {
    vel.x = vel.y = slipAngle = 0;
    cvel.set(0, 0); av = 0;
    flf.set(0, 0); flr.set(0, 0); force.set(0, 0);
  } else {
    const bodySlip = Math.atan2(vel.y, Math.abs(vel.x));
    const frontAngle = bodySlip + Math.atan2(slipAngle, Math.abs(vel.x)) - steerAngle;
    const rearAngle  = bodySlip - Math.atan2(slipAngle, Math.abs(vel.x));
    const mass = 1500, halfWeight = mass * 9.8 * 0.5;

    flf.y = Math.max(-maxForce, Math.min(maxForce, frontSlip * frontAngle)) * halfWeight * (fs ? 0.5 : 1);
    flr.y = Math.max(-maxForce, Math.min(maxForce, rearSlip  * rearAngle))  * halfWeight * (rs ? 0.7 : 1);
    flf.x = flr.x = 0;

    ft.set(100 * throttle, 0);
    bm.color.setHex(ud ? 0xff0000 : 0x800000);
    if (rs) ft.x *= 0.5;

    res.x = -(linDamp * vel.x + drag * vel.x * Math.abs(vel.x));
    res.y = -(linDamp * vel.y + drag * vel.y * Math.abs(vel.y));

    force.x = ft.x + Math.sin(steerAngle) * flf.x + flr.x + res.x;
    force.y = ft.y + Math.cos(steerAngle) * flf.y + flr.y + res.y;

    const torque = frontMass * flf.y - rearMass * flr.y;
    acc.set(force.x / mass, force.y / mass);
    aa = torque / mass;

    a2d.x = cosY * acc.y + sinY * acc.x;
    a2d.y = -sinY * acc.y + cosY * acc.x;
    cvel.x += dt * a2d.x;
    cvel.y += dt * a2d.y;
    av += dt * aa;
  }

  car.position.z -= dt * cvel.x;
  car.position.x += dt * cvel.y;
  car.rotation.y += dt * av;

  lfw.rotation.y = sa;
  rfw.rotation.y = sa;

  const wheelSpin = 0.012 * vel.x / 0.334;
  lfw.rotation.z -= wheelSpin;
  rfw.rotation.z -= wheelSpin;
  lrw.rotation.z -= wheelSpin;
  rrw.rotation.z -= wheelSpin;
}

function UpdateCamera() {
  const ry = car.rotation.y;
  const sin = Math.sin(ry), cos = Math.cos(ry);

  // rotate offset by car yaw
  const ox = camOffset.x * cos - camOffset.z * sin;
  const oz = camOffset.x * sin + camOffset.z * cos;

  camPos.set(car.position.x + ox, car.position.y + camOffset.y, car.position.z + oz);
  camTarget.set(car.position.x, car.position.y + 0.6, car.position.z);

  const lerpSpeed = 1 - Math.pow(0.01, dt);
  camera.position.lerp(camPos, lerpSpeed);
  camera.lookAt(camTarget);
}

function onKeyDown(e) {
  switch (e.keyCode) {
    case 38: case 87: uu = true;  break;
    case 40: case 83: ud = true;  break;
    case 37: case 65: ur = true;  break;
    case 39: case 68: ul = true;  break;
    case 32: rs = true; break;
  }
}

function onKeyUp(e) {
  switch (e.keyCode) {
    case 38: case 87: uu = false; break;
    case 40: case 83: ud = false; break;
    case 37: case 65: ur = false; break;
    case 39: case 68: ul = false; break;
    case 32: rs = false; break;
  }
}

init();
