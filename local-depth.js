/**
 * local-depth.js — lazy-loaded by embed.js when [local] attribute is present.
 * Exports:
 *   getDepthPipeline(onProgress)   → pipeline singleton
 *   encodePhotoToMspz(file, grid)  → { mspzBytes, imgW, imgH }
 *   encodePhotoToSplat(file, grid) → { mspzBytes, plyBytes, spzBytes, imgW, imgH, depthMs, buildMs }
 *   generatePly(splat)             → Uint8Array (3DGS PLY, binary little-endian)
 *   generateSpz(splat)             → Promise<Uint8Array> (Scaniverse SPZ, gzip-compressed)
 */

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js';
const DEPTH_MODEL      = 'onnx-community/depth-anything-v2-small';

const SH_C0           = 0.28209479177387814;
const COLOR_SCALE     = 0.15;
const FRACTIONAL_BITS = 12;
const MSPZ_MAGIC      = 0x5A50534D;
const MSPZ_HDR_SIZE   = 56;
const FLAG_HAS_DELTA  = 0x01;
const FLAG_ISOTROPIC  = 0x08;

// ── Singleton depth pipeline ──────────────────────────────────────────────────

let _pipelinePromise = null;

export function getDepthPipeline(onProgress) {
  if (!_pipelinePromise) {
    _pipelinePromise = (async () => {
      const { pipeline, env } = await import(TRANSFORMERS_URL);
      env.allowLocalModels = false;
      return pipeline('depth-estimation', DEPTH_MODEL, {
        progress_callback: onProgress,
      });
    })();
  }
  return _pipelinePromise;
}

// ── Float-precision splat data ────────────────────────────────────────────────

function _computeSplat(depthMap, photoGrid, imgW, imgH, gW, gH) {
  const N      = gW * gH;
  const dW     = depthMap.width, dH = depthMap.height;
  const depth  = depthMap.data;
  const photo  = photoGrid.data;
  const aspect = imgW / imgH;
  const Z_NEAR = 0.3, Z_FAR = 0.7;

  const positions = new Float32Array(N * 3);
  const shColors  = new Float32Array(N * 3);  // true SH DC, not quantized
  const opacities = new Float32Array(N);       // logit
  const logScales = new Float32Array(N);       // log of world-space scale

  for (let row = 0; row < gH; row++) {
    for (let col = 0; col < gW; col++) {
      const idx   = row * gW + col;
      const di    = Math.round(row * (dH - 1) / (gH - 1));
      const dj    = Math.round(col * (dW - 1) / (gW - 1));
      const dNorm = depth[Math.min(dH - 1, di) * dW + Math.min(dW - 1, dj)] / 255;
      const xN    = (col + 0.5) / gW - 0.5;
      const yN    = (row + 0.5) / gH - 0.5;
      const zW    = Z_FAR - dNorm * (Z_FAR - Z_NEAR);

      positions[idx * 3]     = xN * aspect * zW;
      positions[idx * 3 + 1] = yN * zW;
      positions[idx * 3 + 2] = zW;

      const pOff = idx * 4;
      shColors[idx * 3]     = (photo[pOff]     / 255 - 0.5) / SH_C0;
      shColors[idx * 3 + 1] = (photo[pOff + 1] / 255 - 0.5) / SH_C0;
      shColors[idx * 3 + 2] = (photo[pOff + 2] / 255 - 0.5) / SH_C0;

      const a = 252 / 255;
      opacities[idx] = Math.log(a / (1 - a));  // logit

      const sc = Math.max(1e-10, zW / gH * 1.2);
      logScales[idx] = Math.log(sc);
    }
  }

  return { positions, shColors, opacities, logScales };
}

// ── PLY generator (standard 3DGS binary PLY) ─────────────────────────────────

export function generatePly({ positions, shColors, opacities, logScales }) {
  const N = positions.length / 3;

  const header = [
    'ply',
    'format binary_little_endian 1.0',
    `element vertex ${N}`,
    'property float x',
    'property float y',
    'property float z',
    'property float nx',
    'property float ny',
    'property float nz',
    'property float f_dc_0',
    'property float f_dc_1',
    'property float f_dc_2',
    'property float opacity',
    'property float scale_0',
    'property float scale_1',
    'property float scale_2',
    'property float rot_0',
    'property float rot_1',
    'property float rot_2',
    'property float rot_3',
    'end_header\n',
  ].join('\n');

  const headerBytes = new TextEncoder().encode(header);
  const STRIDE      = 17 * 4;
  const dataBytes   = new Uint8Array(N * STRIDE);
  const dv          = new DataView(dataBytes.buffer);

  for (let i = 0; i < N; i++) {
    const b = i * STRIDE;
    dv.setFloat32(b,      positions[i * 3],     true);
    dv.setFloat32(b +  4, positions[i * 3 + 1], true);
    dv.setFloat32(b +  8, positions[i * 3 + 2], true);
    dv.setFloat32(b + 12, 0, true);  // nx
    dv.setFloat32(b + 16, 0, true);  // ny
    dv.setFloat32(b + 20, 0, true);  // nz
    dv.setFloat32(b + 24, shColors[i * 3],     true);
    dv.setFloat32(b + 28, shColors[i * 3 + 1], true);
    dv.setFloat32(b + 32, shColors[i * 3 + 2], true);
    dv.setFloat32(b + 36, opacities[i], true);
    dv.setFloat32(b + 40, logScales[i], true);  // scale_0
    dv.setFloat32(b + 44, logScales[i], true);  // scale_1
    dv.setFloat32(b + 48, logScales[i], true);  // scale_2
    dv.setFloat32(b + 52, 1, true);  // rot_0 (w)
    dv.setFloat32(b + 56, 0, true);  // rot_1
    dv.setFloat32(b + 60, 0, true);  // rot_2
    dv.setFloat32(b + 64, 0, true);  // rot_3
  }

  const out = new Uint8Array(headerBytes.length + dataBytes.length);
  out.set(headerBytes);
  out.set(dataBytes, headerBytes.length);
  return out;
}

// ── SPZ encoder (Scaniverse format, gzip-compressed) ─────────────────────────

export async function generateSpz({ positions, shColors, opacities, logScales }) {
  const N = positions.length / 3;
  const fractionalBits = 12;
  const FSCALE = 1 << fractionalBits;

  // Planar layout (before gzip): positions (9B/pt), alphas, colors (3B/pt), scales (3B/pt), rots (3B/pt)
  const posArr   = new Uint8Array(N * 9);
  const alphaArr = new Uint8Array(N);
  const colorArr = new Uint8Array(N * 3);
  const scaleArr = new Uint8Array(N * 3);
  const rotArr   = new Uint8Array(N * 3);

  for (let i = 0; i < N; i++) {
    for (let ax = 0; ax < 3; ax++) {
      let v = Math.round(positions[i * 3 + ax] * FSCALE);
      v = Math.max(-8388608, Math.min(8388607, v));
      const uv = v < 0 ? (v + 0x1000000) : v;
      posArr[i * 9 + ax * 3]     =  uv        & 0xFF;
      posArr[i * 9 + ax * 3 + 1] = (uv >>  8) & 0xFF;
      posArr[i * 9 + ax * 3 + 2] = (uv >> 16) & 0xFF;
    }
    alphaArr[i] = Math.min(255, Math.max(0, Math.round(1 / (1 + Math.exp(-opacities[i])) * 255)));
    for (let ci = 0; ci < 3; ci++) {
      colorArr[i * 3 + ci] = Math.min(255, Math.max(0,
        Math.round(shColors[i * 3 + ci] * COLOR_SCALE * 255 + 127.5)
      ));
    }
    const sb = Math.min(255, Math.max(0, Math.round((logScales[i] + 10) * 16)));
    scaleArr[i * 3] = scaleArr[i * 3 + 1] = scaleArr[i * 3 + 2] = sb;
    rotArr[i * 3] = rotArr[i * 3 + 1] = rotArr[i * 3 + 2] = 128; // identity quat xyz→0
  }

  const hdr = new Uint8Array(16);
  const hdv = new DataView(hdr.buffer);
  hdr[0] = 0x73; hdr[1] = 0x70; hdr[2] = 0x7A; hdr[3] = 0x00; // "spz\0"
  hdv.setUint32(4, 1, true);   // version
  hdv.setUint32(8, N, true);   // numPoints
  hdr[12] = 0;                  // shDegree (DC only)
  hdr[13] = fractionalBits;
  hdr[14] = 0;                  // flags
  hdr[15] = 0;                  // reserved

  const raw = new Uint8Array(16 + N * 19);
  let off = 0;
  raw.set(hdr, off);      off += 16;
  raw.set(posArr, off);   off += N * 9;
  raw.set(alphaArr, off); off += N;
  raw.set(colorArr, off); off += N * 3;
  raw.set(scaleArr, off); off += N * 3;
  raw.set(rotArr, off);

  const gz = new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(gz).arrayBuffer());
}

// ── MSPZ v4 encoder ───────────────────────────────────────────────────────────

function _rawZstdFrame(data) {
  const n   = data.length;
  const out = new Uint8Array(12 + n);
  const dv  = new DataView(out.buffer);
  dv.setUint32(0, 0xFD2FB528, true);
  out[4] = 0xA0;
  dv.setUint32(5, n, true);
  const bh = 1 | (n << 3);
  out[9]  =  bh        & 0xFF;
  out[10] = (bh >>  8) & 0xFF;
  out[11] = (bh >> 16) & 0xFF;
  out.set(data, 12);
  return out;
}

function _encodeMspz({ positions, shColors, logScales }, imgW, imgH, gW, gH) {
  const N      = gW * gH;
  const FSCALE = 1 << FRACTIONAL_BITS;

  const packedPos   = new Uint8Array(N * 9);
  const packedAlpha = new Uint8Array(N);
  const packedColor = new Uint8Array(N * 3);
  const packedScale = new Uint8Array(N);

  for (let i = 0; i < N; i++) {
    for (let ax = 0; ax < 3; ax++) {
      const vi = Math.round(positions[i * 3 + ax] * FSCALE) & 0xFFFFFF;
      packedPos[i * 9 + ax * 3]     =  vi        & 0xFF;
      packedPos[i * 9 + ax * 3 + 1] = (vi >>  8) & 0xFF;
      packedPos[i * 9 + ax * 3 + 2] = (vi >> 16) & 0xFF;
    }

    packedAlpha[i] = 252;

    for (let ci = 0; ci < 3; ci++) {
      packedColor[i * 3 + ci] = Math.min(255, Math.max(0,
        Math.round(shColors[i * 3 + ci] * COLOR_SCALE * 255 + 127.5)
      ));
    }

    packedScale[i] = Math.min(255, Math.max(0,
      Math.round((logScales[i] + 10) * 16)
    ));
  }

  const posAcc   = new Uint8Array(9);
  const colorAcc = new Uint8Array(3);
  let   scaleAcc = 0;
  const posPlanes   = Array.from({length: 9}, () => new Uint8Array(N));
  const alphaPlane  = new Uint8Array(N);
  const colorPlanes = Array.from({length: 3}, () => new Uint8Array(N));
  const scalePlane  = new Uint8Array(N);

  for (let i = 0; i < N; i++) {
    for (let j = 0; j < 9; j++) {
      const v = packedPos[i * 9 + j];
      posPlanes[j][i] = (v - posAcc[j]) & 0xFF;
      posAcc[j] = v;
    }
    alphaPlane[i] = packedAlpha[i];
    for (let j = 0; j < 3; j++) {
      const v = packedColor[i * 3 + j];
      colorPlanes[j][i] = (v - colorAcc[j]) & 0xFF;
      colorAcc[j] = v;
    }
    const sv = packedScale[i];
    scalePlane[i] = (sv - scaleAcc) & 0xFF;
    scaleAcc = sv;
  }

  const allPlanes = [...posPlanes, alphaPlane, ...colorPlanes, scalePlane];
  const frames    = allPlanes.map(_rawZstdFrame);
  let totalComp   = 0;
  for (const f of frames) totalComp += f.length;
  const compData  = new Uint8Array(totalComp);
  let cOff = 0;
  for (const f of frames) { compData.set(f, cOff); cOff += f.length; }

  const BPP      = 14;
  const origSize = N * BPP;

  const idxBytes = new Uint8Array(16);
  const idv      = new DataView(idxBytes.buffer);
  idv.setUint32(0,  0,         true);
  idv.setUint32(4,  origSize,  true);
  idv.setUint32(8,  0,         true);
  idv.setUint32(12, totalComp, true);

  const hdr = new Uint8Array(MSPZ_HDR_SIZE);
  const hdv = new DataView(hdr.buffer);
  hdv.setUint32(0,  MSPZ_MAGIC,    true);
  hdv.setUint32(4,  4,             true);
  hdv.setUint32(8,  N,             true);
  hdv.setUint32(12, 1,             true);
  hdv.setUint32(16, origSize,      true);
  hdv.setUint32(20, totalComp,     true);
  hdv.setUint32(24, MSPZ_HDR_SIZE, true);
  hdv.setUint32(28, 0,             true);
  hdr[32] = 3; hdr[33] = 0; hdr[34] = FRACTIONAL_BITS;
  hdr[35] = FLAG_HAS_DELTA | FLAG_ISOTROPIC;
  hdv.setFloat32(36, imgH, true);
  hdv.setUint32(40,  imgW, true);
  hdv.setUint32(44,  imgH, true);

  const out = new Uint8Array(MSPZ_HDR_SIZE + 16 + totalComp);
  out.set(hdr, 0);
  out.set(idxBytes, MSPZ_HDR_SIZE);
  out.set(compData, MSPZ_HDR_SIZE + 16);
  return out;
}

// ── Gzip helper (browser native — no external dep) ───────────────────────────

async function _gzipBytes(bytes) {
  const gz = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(gz).arrayBuffer());
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function encodePhotoToSplat(file, grid = 512, onProgress) {
  const pipe = await getDepthPipeline(onProgress);

  const blobUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = blobUrl;
    });
    const imgW = img.naturalWidth, imgH = img.naturalHeight;

    const t0Depth = performance.now();
    const result  = await pipe(blobUrl);
    const depthMs = performance.now() - t0Depth;

    const t0Build = performance.now();
    const tmpC    = document.createElement('canvas');
    tmpC.width = grid; tmpC.height = grid;
    const ctx = tmpC.getContext('2d');
    ctx.drawImage(img, 0, 0, grid, grid);
    const photoGrid = ctx.getImageData(0, 0, grid, grid);

    const splat      = _computeSplat(result.depth, photoGrid, imgW, imgH, grid, grid);
    const mspzBytes  = _encodeMspz(splat, imgW, imgH, grid, grid);
    const mspzGzBytes = await _gzipBytes(mspzBytes);
    const plyBytes   = generatePly(splat);
    const spzBytes   = await generateSpz(splat);
    const buildMs    = performance.now() - t0Build;

    return { mspzBytes, mspzGzBytes, plyBytes, spzBytes, imgW, imgH, depthMs, buildMs };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

// Backward-compatible wrapper used by embed.js _setupLocalMode
export async function encodePhotoToMspz(file, grid = 512, onProgress) {
  const { mspzBytes, imgW, imgH } = await encodePhotoToSplat(file, grid, onProgress);
  return { mspzBytes, imgW, imgH };
}
