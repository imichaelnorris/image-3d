/**
 * local-depth.js — lazy-loaded by embed.js when [local] attribute is present.
 * Provides:
 *   getDepthPipeline(onProgress)  → transformers.js depth-estimation pipeline (singleton)
 *   encodePhotoToMspz(file, grid) → { mspzBytes: Uint8Array, imgW, imgH }
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

// ── Photo → MSPZ bytes ────────────────────────────────────────────────────────

export async function encodePhotoToMspz(file, grid = 512, onProgress) {
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

    const result   = await pipe(blobUrl);
    const depthMap = result.depth;

    const tmpC = document.createElement('canvas');
    tmpC.width = grid; tmpC.height = grid;
    const ctx = tmpC.getContext('2d');
    ctx.drawImage(img, 0, 0, grid, grid);
    const photoGrid = ctx.getImageData(0, 0, grid, grid);

    const mspzBytes = _encode(depthMap, photoGrid, imgW, imgH, grid, grid);
    return { mspzBytes, imgW, imgH };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
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

function _encode(depthMap, photoGrid, imgW, imgH, gW, gH) {
  const N      = gW * gH;
  const dW     = depthMap.width, dH = depthMap.height;
  const depth  = depthMap.data;
  const photo  = photoGrid.data;
  const aspect = imgW / imgH;
  const Z_NEAR = 0.3, Z_FAR = 0.7;
  const FSCALE = 1 << FRACTIONAL_BITS;

  const packedPos   = new Uint8Array(N * 9);
  const packedAlpha = new Uint8Array(N);
  const packedColor = new Uint8Array(N * 3);
  const packedScale = new Uint8Array(N);

  for (let row = 0; row < gH; row++) {
    for (let col = 0; col < gW; col++) {
      const idx  = row * gW + col;
      const di   = Math.round(row * (dH - 1) / (gH - 1));
      const dj   = Math.round(col * (dW - 1) / (gW - 1));
      const dNorm = depth[Math.min(dH - 1, di) * dW + Math.min(dW - 1, dj)] / 255;
      const xN   = (col + 0.5) / gW - 0.5;
      const yN   = (row + 0.5) / gH - 0.5;
      const zW   = Z_FAR - dNorm * (Z_FAR - Z_NEAR);
      const xW   = xN * aspect * zW;
      const yW   = yN * zW;

      for (const [ax, v] of [[0, xW], [1, yW], [2, zW]]) {
        const vi = Math.round(v * FSCALE) & 0xFFFFFF;
        packedPos[idx * 9 + ax * 3]     =  vi        & 0xFF;
        packedPos[idx * 9 + ax * 3 + 1] = (vi >>  8) & 0xFF;
        packedPos[idx * 9 + ax * 3 + 2] = (vi >> 16) & 0xFF;
      }

      packedAlpha[idx] = 252;

      const pOff = idx * 4;
      for (const [ci, raw] of [[0, photo[pOff]], [1, photo[pOff+1]], [2, photo[pOff+2]]]) {
        const shDC = (raw / 255 - 0.5) / SH_C0;
        packedColor[idx * 3 + ci] = Math.min(255, Math.max(0, Math.round(shDC * COLOR_SCALE * 255 + 127.5)));
      }

      const sc = Math.max(1e-10, zW / gH * 1.2);
      packedScale[idx] = Math.min(255, Math.max(0, Math.round((Math.log(sc) + 10) * 16)));
    }
  }

  const BPP      = 14;
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

  const origSize   = N * BPP;
  const idxBytes   = new Uint8Array(16);
  const idv        = new DataView(idxBytes.buffer);
  idv.setUint32(0,  0,         true);
  idv.setUint32(4,  origSize,  true);
  idv.setUint32(8,  0,         true);
  idv.setUint32(12, totalComp, true);

  const hdr  = new Uint8Array(MSPZ_HDR_SIZE);
  const hdv  = new DataView(hdr.buffer);
  hdv.setUint32(0,  MSPZ_MAGIC,     true);
  hdv.setUint32(4,  4,              true);
  hdv.setUint32(8,  N,              true);
  hdv.setUint32(12, 1,              true);
  hdv.setUint32(16, origSize,       true);
  hdv.setUint32(20, totalComp,      true);
  hdv.setUint32(24, MSPZ_HDR_SIZE,  true);
  hdv.setUint32(28, 0,              true);
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
