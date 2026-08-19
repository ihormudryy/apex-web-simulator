import * as THREE from 'three';
import { buildCenterline } from './centerline.js';

const DEG90 = Math.PI / 2;

export class Track extends THREE.Group {
  constructor(waypoints, { sampleCount = 4000, spawnT = 0 } = {}) {
    super();

    this.centerline = buildCenterline(waypoints, sampleCount);
    this.samples = this.centerline.samples;
    this.spawnT = spawnT;
    this._hint = 0;

    this._build();
  }

  query(x, z) {
    const result = this.centerline.query(x, z, this._hint);
    this._hint = result.index;
    return result;
  }

  spawn() {
    const index = Math.floor(this.spawnT * this.samples.length);
    const s = this.samples[index];
    return { x: s.x, z: s.z, tx: s.tx, tz: s.tz };
  }

  _build() {
    const curbTexture = this._makeCurbTexture();
    const dashedTexture = this._makeDashedTexture();

    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000),
      new THREE.MeshStandardMaterial({ color: 0x3d6b32, roughness: 1, metalness: 0 })
    );
    grass.rotation.x = -DEG90;
    grass.position.y = -0.08;
    this.add(grass);

    this.add(this._ribbon(
      s => s.halfWidth + s.runoff,
      s => -(s.halfWidth + s.runoff),
      new THREE.MeshStandardMaterial({ color: 0x4a7a3c, roughness: 1, metalness: 0 }),
      -0.04
    ));
    this.add(this._ribbon(
      s => s.halfWidth,
      s => -s.halfWidth,
      new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.95, metalness: 0.02 }),
      0
    ));

    const curbMaterial = new THREE.MeshStandardMaterial({
      map: curbTexture,
      roughness: 0.6,
      metalness: 0.04,
    });
    const edgeMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.65,
      metalness: 0,
    });
    const barrierMaterial = new THREE.MeshStandardMaterial({
      color: 0xcccccc,
      roughness: 0.4,
      metalness: 0.5,
    });

    for (const side of [-1, 1]) {
      this.add(this._ribbon(
        s => side * (s.halfWidth + (side > 0 ? 1 : 0)),
        s => side * (s.halfWidth + (side > 0 ? 0 : 1)),
        curbMaterial,
        0.01
      ));
      this.add(this._ribbon(
        s => side * (s.halfWidth - 0.1) + 0.1,
        s => side * (s.halfWidth - 0.1) - 0.1,
        edgeMaterial,
        0.02
      ));
      this.add(this._barrier(side, barrierMaterial));
    }

    this.add(this._ribbon(
      () => 0.14,
      () => -0.14,
      new THREE.MeshStandardMaterial({
        map: dashedTexture,
        transparent: true,
        roughness: 0.7,
        metalness: 0,
      }),
      0.018
    ));

    const spawnIndex = Math.floor(this.spawnT * this.samples.length);
    const hamilton = this.samples[spawnIndex];
    const startMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.65,
      metalness: 0,
    });
    this.add(this._startLine(hamilton, -4, startMaterial));
    this.add(this._startLine(hamilton, 4, startMaterial));
  }

  _ribbon(leftOffset, rightOffset, material, y) {
    const n = this.samples.length;
    const vertices = new Float32Array((n + 1) * 6);
    const uvs = new Float32Array((n + 1) * 4);
    const indices = new Uint32Array(n * 6);

    for (let i = 0; i <= n; i++) {
      const s = this.samples[i % n];
      const left = leftOffset(s);
      const right = rightOffset(s);
      const vertex = i * 6;
      vertices[vertex] = s.x + s.nx * left;
      vertices[vertex + 1] = 0;
      vertices[vertex + 2] = s.z + s.nz * left;
      vertices[vertex + 3] = s.x + s.nx * right;
      vertices[vertex + 4] = 0;
      vertices[vertex + 5] = s.z + s.nz * right;
      const u = i / n;
      uvs[i * 4] = u;
      uvs[i * 4 + 1] = 0;
      uvs[i * 4 + 2] = u;
      uvs[i * 4 + 3] = 1;
    }

    for (let i = 0; i < n; i++) {
      const a = i * 2;
      const index = i * 6;
      indices[index] = a;
      indices[index + 1] = a + 2;
      indices[index + 2] = a + 1;
      indices[index + 3] = a + 1;
      indices[index + 4] = a + 2;
      indices[index + 5] = a + 3;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = y;
    return mesh;
  }

  _barrier(side, material) {
    const height = 1.1;
    const halfThickness = 0.06;
    const n = this.samples.length;
    const vertices = new Float32Array((n + 1) * 12);
    const indices = [];
    const corners = [
      [-halfThickness, 0],
      [halfThickness, 0],
      [halfThickness, height],
      [-halfThickness, height],
    ];

    for (let i = 0; i <= n; i++) {
      const s = this.samples[i % n];
      const wallLimit = s.halfWidth + s.runoff;
      const cx = s.x + s.nx * side * wallLimit;
      const cz = s.z + s.nz * side * wallLimit;
      for (let corner = 0; corner < corners.length; corner++) {
        const offset = corners[corner][0];
        const vertex = (i * 4 + corner) * 3;
        vertices[vertex] = cx + s.nx * offset;
        vertices[vertex + 1] = corners[corner][1];
        vertices[vertex + 2] = cz + s.nz * offset;
      }
    }

    for (let i = 0; i < n; i++) {
      for (let face = 0; face < 4; face++) {
        const a = i * 4 + face;
        const b = i * 4 + (face + 1) % 4;
        const c = (i + 1) * 4 + face;
        const d = (i + 1) * 4 + (face + 1) % 4;
        indices.push(a, b, c, b, d, c);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, material);
  }

  _startLine(sample, longitudinalOffset, material) {
    const cx = sample.x + sample.tx * longitudinalOffset;
    const cz = sample.z + sample.tz * longitudinalOffset;
    const halfLength = 6;
    const halfWidth = 0.2;
    const vertices = new Float32Array([
      cx + sample.nx * halfLength - sample.tx * halfWidth, 0, cz + sample.nz * halfLength - sample.tz * halfWidth,
      cx - sample.nx * halfLength - sample.tx * halfWidth, 0, cz - sample.nz * halfLength - sample.tz * halfWidth,
      cx + sample.nx * halfLength + sample.tx * halfWidth, 0, cz + sample.nz * halfLength + sample.tz * halfWidth,
      cx - sample.nx * halfLength + sample.tx * halfWidth, 0, cz - sample.nz * halfLength + sample.tz * halfWidth,
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setIndex([0, 2, 1, 1, 2, 3]);
    geometry.computeVertexNormals();
    const line = new THREE.Mesh(geometry, material);
    line.position.y = 0.025;
    return line;
  }

  _canvasTexture(draw, width, height, repeatX) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    draw(canvas.getContext('2d'));
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeatX, 1);
    texture.anisotropy = 4;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  _makeCurbTexture() {
    return this._canvasTexture(ctx => {
      const s = 24;
      for (let x = 0; x < 512; x += s) {
        ctx.fillStyle = ((x / s) % 2 === 0) ? '#c8180f' : '#efefef';
        ctx.fillRect(x, 0, s, 64);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.08)';
      ctx.fillRect(0, 0, 512, 6);
      ctx.fillRect(0, 58, 512, 6);
    }, 512, 64, 26);
  }

  _makeDashedTexture() {
    return this._canvasTexture(ctx => {
      ctx.clearRect(0, 0, 512, 32);
      ctx.fillStyle = '#ffffff';
      for (let x = 0; x < 512; x += 88) ctx.fillRect(x, 11, 44, 10);
    }, 512, 32, 40);
  }
}
