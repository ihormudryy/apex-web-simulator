// Unpack the legacy Three.js .bin mesh format into tightly packed vertex
// attributes. Face lists can mix UV and non-UV triangles; every vertex must
// still have the same attribute set or WebGL rejects the draw
// (`glDrawArrays: Vertex buffer is not big enough`).

export function unpackBinMesh(buf) {
  const a = new Uint8Array(buf);
  const dv = new DataView(buf);

  const q = p => a[p];
  const k = p => dv.getUint16(p, true);
  const j = p => dv.getUint32(p, true);
  const n = p => dv.getInt8(p);
  const h = p => dv.getFloat32(p, true);

  let F = 0;
  const hdr = {
    header_bytes:            q(F+8),
    vertex_coordinate_bytes: q(F+9),
    normal_coordinate_bytes: q(F+10),
    uv_coordinate_bytes:     q(F+11),
    vertex_index_bytes:      q(F+12),
    normal_index_bytes:      q(F+13),
    uv_index_bytes:          q(F+14),
    material_index_bytes:    q(F+15),
    nvertices:   j(F+16), nnormals: j(F+20), nuvs: j(F+24),
    ntri_flat:       j(F+28), ntri_smooth:     j(F+32),
    ntri_flat_uv:    j(F+36), ntri_smooth_uv:  j(F+40),
    nquad_flat:      j(F+44), nquad_smooth:    j(F+48),
    nquad_flat_uv:   j(F+52), nquad_smooth_uv: j(F+56),
  };
  F += hdr.header_bytes;

  const { vertex_coordinate_bytes: vb, normal_coordinate_bytes: nb,
          uv_coordinate_bytes: ub, vertex_index_bytes: vi,
          normal_index_bytes: ni, uv_index_bytes: ui,
          material_index_bytes: mi } = hdr;

  const vertices = new Float32Array(hdr.nvertices * 3);
  for (let i = 0; i < hdr.nvertices; i++, F += vb*3) {
    vertices[i*3]     = h(F);
    vertices[i*3 + 1] = h(F+vb);
    vertices[i*3 + 2] = h(F+vb*2);
  }

  const normals = new Float32Array(hdr.nnormals * 3);
  for (let i = 0; i < hdr.nnormals; i++, F += nb*3) {
    normals[i*3]     = n(F) / 127;
    normals[i*3 + 1] = n(F+nb) / 127;
    normals[i*3 + 2] = n(F+nb*2) / 127;
  }

  const uvs = new Float32Array(hdr.nuvs * 2);
  for (let i = 0; i < hdr.nuvs; i++, F += ub*2) {
    uvs[i*2]     = h(F);
    uvs[i*2 + 1] = 1 - h(F+ub);
  }

  const readIdx = (p, bytes) =>
    bytes === 4 ? j(p) : bytes === 2 ? k(p) : q(p);

  const triCount =
    hdr.ntri_flat + hdr.ntri_smooth + hdr.ntri_flat_uv + hdr.ntri_smooth_uv +
    2 * (hdr.nquad_flat + hdr.nquad_smooth + hdr.nquad_flat_uv + hdr.nquad_smooth_uv);

  const anyUv = hdr.ntri_flat_uv + hdr.ntri_smooth_uv + hdr.nquad_flat_uv + hdr.nquad_smooth_uv > 0;
  const anyNorm = hdr.ntri_smooth + hdr.ntri_smooth_uv + hdr.nquad_smooth + hdr.nquad_smooth_uv > 0
    || hdr.ntri_flat + hdr.ntri_flat_uv + hdr.nquad_flat + hdr.nquad_flat_uv > 0;

  const posArr = new Float32Array(triCount * 9);
  const normArr = new Float32Array(triCount * 9);
  const uvArr = new Float32Array(triCount * 6);
  let posN = 0, normN = 0, uvN = 0;

  const pushTri = (v0, v1, v2, n0, n1, n2, u0, u1, u2) => {
    const vs = [v0, v1, v2];
    for (const v of vs) {
      posArr[posN++] = vertices[v * 3];
      posArr[posN++] = vertices[v * 3 + 1];
      posArr[posN++] = vertices[v * 3 + 2];
    }
    if (anyNorm) {
      if (n0 !== -1) {
        for (const ni_ of [n0, n1, n2]) {
          normArr[normN++] = normals[ni_ * 3];
          normArr[normN++] = normals[ni_ * 3 + 1];
          normArr[normN++] = normals[ni_ * 3 + 2];
        }
      } else {
        const ax = vertices[v1 * 3]     - vertices[v0 * 3];
        const ay = vertices[v1 * 3 + 1] - vertices[v0 * 3 + 1];
        const az = vertices[v1 * 3 + 2] - vertices[v0 * 3 + 2];
        const bx = vertices[v2 * 3]     - vertices[v0 * 3];
        const by = vertices[v2 * 3 + 1] - vertices[v0 * 3 + 1];
        const bz = vertices[v2 * 3 + 2] - vertices[v0 * 3 + 2];
        let nx = ay * bz - az * by;
        let ny = az * bx - ax * bz;
        let nz = ax * by - ay * bx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        for (let i = 0; i < 3; i++) {
          normArr[normN++] = nx;
          normArr[normN++] = ny;
          normArr[normN++] = nz;
        }
      }
    }
    if (anyUv) {
      const us = u0 !== -1 ? [u0, u1, u2] : [-1, -1, -1];
      for (const u of us) {
        if (u === -1) {
          uvArr[uvN++] = 0;
          uvArr[uvN++] = 0;
        } else {
          uvArr[uvN++] = uvs[u * 2];
          uvArr[uvN++] = uvs[u * 2 + 1];
        }
      }
    }
  };

  const pushQuad = (v0, v1, v2, v3, n0, n1, n2, n3, u0, u1, u2, u3) => {
    pushTri(v0, v1, v2, n0, n1, n2, u0, u1, u2);
    pushTri(v0, v2, v3, n0, n2, n3, u0, u2, u3);
  };

  const vIdx = [0, 0, 0, 0], nIdx = [0, 0, 0, 0], uIdx = [0, 0, 0, 0];

  const readFaces = (count, stride, withNormals, withUVs, isQuad) => {
    const vCount = isQuad ? 4 : 3;
    for (let i = 0; i < count; i++, F += stride) {
      let p = F;
      for (let x = 0; x < vCount; x++, p += vi) vIdx[x] = readIdx(p, vi);
      p += mi;
      if (withNormals) for (let x = 0; x < vCount; x++, p += ni) nIdx[x] = readIdx(p, ni);
      if (withUVs)     for (let x = 0; x < vCount; x++, p += ui) uIdx[x] = readIdx(p, ui);

      const n0 = withNormals ? nIdx[0] : -1;
      const n1 = withNormals ? nIdx[1] : -1;
      const n2 = withNormals ? nIdx[2] : -1;
      const n3 = withNormals ? nIdx[3] : -1;
      const u0 = withUVs ? uIdx[0] : -1;
      const u1 = withUVs ? uIdx[1] : -1;
      const u2 = withUVs ? uIdx[2] : -1;
      const u3 = withUVs ? uIdx[3] : -1;
      if (isQuad) pushQuad(vIdx[0], vIdx[1], vIdx[2], vIdx[3], n0, n1, n2, n3, u0, u1, u2, u3);
      else        pushTri(vIdx[0], vIdx[1], vIdx[2], n0, n1, n2, u0, u1, u2);
    }
  };

  const s = (v, nrm, u) => vi * v + mi + ni * nrm + ui * u;
  readFaces(hdr.ntri_flat,       s(3, 0, 0), false, false, false);
  readFaces(hdr.ntri_smooth,     s(3, 3, 0), true,  false, false);
  readFaces(hdr.ntri_flat_uv,    s(3, 0, 3), false, true,  false);
  readFaces(hdr.ntri_smooth_uv,  s(3, 3, 3), true,  true,  false);
  readFaces(hdr.nquad_flat,      s(4, 0, 0), false, false, true);
  readFaces(hdr.nquad_smooth,    s(4, 4, 0), true,  false, true);
  readFaces(hdr.nquad_flat_uv,   s(4, 0, 4), false, true,  true);
  readFaces(hdr.nquad_smooth_uv, s(4, 4, 4), true,  true,  true);

  return {
    position: posArr.slice(0, posN),
    normal: anyNorm ? normArr.slice(0, normN) : null,
    uv: anyUv ? uvArr.slice(0, uvN) : null,
  };
}
