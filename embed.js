/**
 * <image-3d> — embeddable gaussian-splat image viewer
 *
 * Usage:
 *   <script src="https://mukba.ng/image-3d/embed.js" defer></script>
 *   <image-3d src="https://example.com/dish.jpg" poster="..."></image-3d>
 *
 * On first view (or on connect if loading != "lazy"), the component fetches
 * MSPZ bytes from ${convertBase}?url=<encoded src>, decodes them, and swaps
 * the poster <img> for a 3D canvas. If the fetch fails the poster stays up.
 *
 * See repo: imichaelnorris/mukbang-web — issue #61 for the design + worker
 * contract this component speaks to.
 */
(function () {
  'use strict';

  if (customElements.get('image-3d')) return; // idempotent re-include

  // ----- Bootstrap configuration -----

  // sha256(sourceUrl) as a lowercase hex string. The worker derives R2
  // keys the same way, so the client knows the artifact URLs without
  // asking the server for them.
  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    const bytes = new Uint8Array(buf);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  // Derive base URLs from this script's own src so the embed works from any
  // origin that mirrors it. document.currentScript is set during initial
  // parsing of a classic script tag — we capture it immediately.
  const SCRIPT_SRC = (() => {
    if (document.currentScript && document.currentScript.src) {
      return document.currentScript.src;
    }
    // Fallback: look for a script tag pointing at embed.js
    const scripts = document.getElementsByTagName('script');
    for (let i = scripts.length - 1; i >= 0; i--) {
      const s = scripts[i].src || '';
      if (/\/image-3d\/embed\.js(\?|$)/.test(s)) return s;
    }
    return null;
  })();

  // /image-3d/embed.js  →  /image-3d/
  const EMBED_DIR = SCRIPT_SRC ? SCRIPT_SRC.replace(/embed\.js(\?.*)?$/, '') : null;
  // The base for content-addressed artifact URLs (and the generation
  // endpoint). Same /image-3d/ prefix the embed script is served from.
  const WORKER_BASE = EMBED_DIR || 'https://mukba.ng/image-3d/';
  // The shared viewer module lives one level up under /assets/.
  const DEFAULT_VIEWER_MODULE = EMBED_DIR
    ? new URL('../assets/mspz-image-viewer.js', EMBED_DIR).href
    : null;
  // CDN deps. Pinned versions matching what /p uses today.
  const FZSTD_UMD = 'https://cdn.jsdelivr.net/npm/fzstd@0.1.1/umd/index.min.js';
  // ?bundle pulls all transitive deps into a single file. Without it
  // esm.sh fans out to dozens of small files (tslib, lib.module.*,
  // fastest-deep-iterator, etc.) that each take a roundtrip; on a
  // throttled connection that's tens of seconds of trickling
  // requests before any 3D code is ready to run.
  const GS3D_ESM = 'https://esm.sh/@mkkellogg/gaussian-splats-3d@0.4.7?bundle';
  const LOTTIE_UMD = 'https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js';
  // Absolute URL so the swipe-hand animation loads from any origin embedding us.
  const LOTTIE_PATH = EMBED_DIR
    ? new URL('../assets/lottie/swipe-hand.json', EMBED_DIR).href
    : 'https://mukba.ng/assets/lottie/swipe-hand.json';

  // ----- Shared dep loaders (one promise per dep across all instances) -----

  // Decode the custom .bin mesh-preview format produced by the Modal pipeline:
  //   20B header (magic "MESH", grid dims, fy, payload size, img dims)
  //   gzip(int16 positions, row-major, scale 1/512)
  //   raw WebP/JPEG/PNG texture bytes appended (auto-detect from magic)
  // ~11KB at the default preview tier. Decompression via DecompressionStream
  // (no fzstd / pako needed).
  async function decodeMeshPreviewBin(url, signal) {
    const resp = await fetch(url, { signal });
    if (!resp.ok) throw new Error(`mesh preview fetch failed: ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = dv.getUint32(0, true);
    if (magic !== 0x4853454D /* "MESH" LE */) throw new Error('mesh preview: bad magic');
    const gridW       = dv.getUint16(4, true);
    const gridH       = dv.getUint16(6, true);
    const fy          = dv.getFloat32(8, true);
    const payloadSize = dv.getUint32(12, true);
    const imgW        = dv.getUint16(16, true);
    const imgH        = dv.getUint16(18, true);
    const meshGz = bytes.subarray(20, 20 + payloadSize);
    const meshRaw = new Uint8Array(await new Response(
      new Blob([meshGz]).stream().pipeThrough(new DecompressionStream('gzip'))
    ).arrayBuffer());
    const positions = new Int16Array(meshRaw.buffer, meshRaw.byteOffset, gridH * gridW * 3);
    const texBytes = bytes.subarray(20 + payloadSize);
    let mime = 'image/webp';
    if (texBytes[0] === 0xFF && texBytes[1] === 0xD8) mime = 'image/jpeg';
    else if (texBytes[0] === 0x89 && texBytes[1] === 0x50) mime = 'image/png';
    const textureUrl = URL.createObjectURL(new Blob([texBytes], { type: mime }));
    return { gridW, gridH, fy, imgW, imgH, positions, textureUrl };
  }

  // Prepare the raw mesh arrays (positions, uvs, indices) from a decoded
  // .bin. Renderer-agnostic — Three.js and the custom WebGL renderer
  // both consume the same data.
  function prepMeshArrays(decoded) {
    const { gridW, gridH, positions, textureUrl } = decoded;
    const nVerts = gridW * gridH;
    const posArr = new Float32Array(nVerts * 3);
    const uvArr = new Float32Array(nVerts * 2);
    // SHARP world coords directly (x_int, y_int, z_int — scaled by 1/512).
    // Shares the same coordinate system the splat lives in.
    for (let row = 0; row < gridH; row++) {
      for (let col = 0; col < gridW; col++) {
        const idx = row * gridW + col;
        posArr[idx * 3 + 0] = positions[idx * 3 + 0] / 512;
        posArr[idx * 3 + 1] = positions[idx * 3 + 1] / 512;
        posArr[idx * 3 + 2] = positions[idx * 3 + 2] / 512;
        uvArr[idx * 2 + 0] = col / (gridW - 1);
        uvArr[idx * 2 + 1] = 1 - row / (gridH - 1);
      }
    }
    // 2 triangles per quad, indices implicit by row-major order.
    const nQuads = (gridW - 1) * (gridH - 1);
    const idxArr = new Uint32Array(nQuads * 6);
    let o = 0;
    for (let row = 0; row < gridH - 1; row++) {
      for (let col = 0; col < gridW - 1; col++) {
        const a = row * gridW + col;
        const b = (row + 1) * gridW + col;
        const c = row * gridW + col + 1;
        const d = (row + 1) * gridW + col + 1;
        idxArr[o++] = a; idxArr[o++] = b; idxArr[o++] = c;
        idxArr[o++] = c; idxArr[o++] = b; idxArr[o++] = d;
      }
    }
    return { positions: posArr, uvs: uvArr, indices: idxArr, textureUrl };
  }

  // ---- Inlined custom WebGL mesh renderer (was mesh-renderer.js) ----
  // Replaces Three.js + OrbitControls (~hundreds of KB from esm.sh)
  // with a tiny WebGL-1 path purpose-built for our textured heightmap
  // mesh + drag-to-orbit camera. Inlined into embed.js so the mesh
  // path is a single roundtrip instead of two — saves ~300ms of
  // TTFB/TLS overhead per fresh load on slow networks.

  // Tiny mat4 helpers (column-major, OpenGL convention).
  function _m4Mul(out, a, b) {
    const a00=a[0],a01=a[1],a02=a[2],a03=a[3];
    const a10=a[4],a11=a[5],a12=a[6],a13=a[7];
    const a20=a[8],a21=a[9],a22=a[10],a23=a[11];
    const a30=a[12],a31=a[13],a32=a[14],a33=a[15];
    for (let i = 0; i < 4; i++) {
      const b0=b[i*4],b1=b[i*4+1],b2=b[i*4+2],b3=b[i*4+3];
      out[i*4  ] = b0*a00 + b1*a10 + b2*a20 + b3*a30;
      out[i*4+1] = b0*a01 + b1*a11 + b2*a21 + b3*a31;
      out[i*4+2] = b0*a02 + b1*a12 + b2*a22 + b3*a32;
      out[i*4+3] = b0*a03 + b1*a13 + b2*a23 + b3*a33;
    }
    return out;
  }
  function _m4Perspective(out, fovYRad, aspect, near, far) {
    const f = 1.0 / Math.tan(fovYRad / 2);
    const nf = 1 / (near - far);
    out[0]=f/aspect; out[1]=0; out[2]=0; out[3]=0;
    out[4]=0; out[5]=f; out[6]=0; out[7]=0;
    out[8]=0; out[9]=0; out[10]=(far + near) * nf; out[11]=-1;
    out[12]=0; out[13]=0; out[14]=2 * far * near * nf; out[15]=0;
    return out;
  }
  function _m4LookAt(out, eye, target, up) {
    let zx=eye[0]-target[0], zy=eye[1]-target[1], zz=eye[2]-target[2];
    let zLen = Math.hypot(zx, zy, zz);
    if (zLen === 0) { zx=0; zy=0; zz=1; zLen=1; }
    zx/=zLen; zy/=zLen; zz/=zLen;
    let xx = up[1]*zz - up[2]*zy;
    let xy = up[2]*zx - up[0]*zz;
    let xz = up[0]*zy - up[1]*zx;
    let xLen = Math.hypot(xx, xy, xz);
    if (xLen === 0) { xx=1; xy=0; xz=0; xLen=1; }
    xx/=xLen; xy/=xLen; xz/=xLen;
    const yx = zy*xz - zz*xy, yy = zz*xx - zx*xz, yz = zx*xy - zy*xx;
    out[0]=xx; out[1]=yx; out[2]=zx; out[3]=0;
    out[4]=xy; out[5]=yy; out[6]=zy; out[7]=0;
    out[8]=xz; out[9]=yz; out[10]=zz; out[11]=0;
    out[12]=-(xx*eye[0]+xy*eye[1]+xz*eye[2]);
    out[13]=-(yx*eye[0]+yy*eye[1]+yz*eye[2]);
    out[14]=-(zx*eye[0]+zy*eye[1]+zz*eye[2]);
    out[15]=1;
    return out;
  }
  const _MR_VERT = 'attribute vec3 a_position;attribute vec2 a_uv;uniform mat4 u_mvp;varying vec2 v_uv;void main(){gl_Position=u_mvp*vec4(a_position,1.0);v_uv=a_uv;}';
  const _MR_FRAG = 'precision mediump float;varying vec2 v_uv;uniform sampler2D u_tex;void main(){gl_FragColor=texture2D(u_tex,v_uv);}';
  function _compileShader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh); gl.deleteShader(sh);
      throw new Error('shader compile: ' + log);
    }
    return sh;
  }
  function _linkProgram(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p); gl.deleteProgram(p);
      throw new Error('program link: ' + log);
    }
    return p;
  }
  function createCustomMeshRenderer({ container, arrays, fovDeg = 50 }) {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;';
    container.appendChild(canvas);
    const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true });
    if (!gl) { container.removeChild(canvas); throw new Error('webgl1 unavailable'); }
    const vs = _compileShader(gl, gl.VERTEX_SHADER, _MR_VERT);
    const fs = _compileShader(gl, gl.FRAGMENT_SHADER, _MR_FRAG);
    const program = _linkProgram(gl, vs, fs);
    const aPos = gl.getAttribLocation(program, 'a_position');
    const aUv = gl.getAttribLocation(program, 'a_uv');
    const uMvp = gl.getUniformLocation(program, 'u_mvp');
    const uTex = gl.getUniformLocation(program, 'u_tex');
    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, arrays.positions, gl.STATIC_DRAW);
    const uvBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, arrays.uvs, gl.STATIC_DRAW);
    const idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    let indices = arrays.indices;
    let indexType = gl.UNSIGNED_INT;
    if (indices instanceof Uint32Array && !gl.getExtension('OES_element_index_uint')) {
      const u16 = new Uint16Array(indices.length);
      for (let i = 0; i < indices.length; i++) u16[i] = indices[i];
      indices = u16;
      indexType = gl.UNSIGNED_SHORT;
    } else if (indices instanceof Uint16Array) {
      indexType = gl.UNSIGNED_SHORT;
    } else {
      gl.getExtension('OES_element_index_uint');
    }
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    const indexCount = indices.length;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const readyPromise = new Promise((resolve) => {
      img.onload = () => {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        // flipY=true matches Three's TextureLoader default. Our UV
        // math (1 - row/(H-1)) was written assuming the flip; without
        // it the mesh's texture renders vertically inverted.
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        resolve();
      };
      img.onerror = () => resolve();
    });
    img.src = arrays.textureUrl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0, 0, 0, 0);
    const fovYRad = fovDeg * Math.PI / 180;
    function dpr() { return window.devicePixelRatio || 1; }
    // Match the Three.js path exactly: camera at world origin looking
    // toward (0, 0, 0.5), up=-Y. No bounds fit. The mesh positions are
    // already in SHARP world coords (1/512 units), so this lands the
    // same view as the splat-side camera in mspz-image-viewer.js.
    let theta = 0;
    let phi = Math.PI / 2;
    const target = [0, 0, 0.5];
    const up = [0, -1, 0];
    let radius = 0.5;
    let radiusTarget = radius;
    // Match mspz-image-viewer.js MIN/MAX_ZOOM_DISTANCE for consistency
    // with the splat viewer the user will see right after the mesh.
    const MIN_RADIUS = 0.1;
    const MAX_RADIUS = 3.0;
    let thetaTarget = theta;
    let phiTarget = phi;
    const DAMPING = 0.12;
    let dragging = false;
    let lastX = 0, lastY = 0;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
      const dx = (e.clientX - lastX) / w * Math.PI * 1.5;
      const dy = (e.clientY - lastY) / h * Math.PI * 1.5;
      lastX = e.clientX; lastY = e.clientY;
      thetaTarget -= dx;
      // Vertical drag direction is inverted because the camera up axis
      // is (0,-1,0). Three.js OrbitControls flips its rotateUp sign
      // when camera.up points down so the gesture feels right; we
      // match by subtracting dy instead of adding.
      phiTarget = Math.max(0.01, Math.min(Math.PI - 0.01, phiTarget - dy));
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    // Zoom: mouse wheel and Mac trackpad pinch both come through
    // 'wheel'; pinch has ctrlKey=true (browser convention) and a
    // smaller deltaY per tick, so we amplify it a bit so the gesture
    // feels responsive. Exponential scaling keeps zoom feel
    // consistent regardless of current radius.
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const scale = e.ctrlKey ? 0.02 : 0.003;
      radiusTarget = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, radiusTarget * Math.exp(e.deltaY * scale)));
    }, { passive: false });
    function resize() {
      const w = container.clientWidth || 600;
      const h = container.clientHeight || 600;
      const r = dpr();
      const bw = Math.max(1, Math.round(w * r));
      const bh = Math.max(1, Math.round(h * r));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      gl.viewport(0, 0, bw, bh);
    }
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();
    const proj = new Float32Array(16);
    const view = new Float32Array(16);
    const mvp = new Float32Array(16);
    let running = true;
    let firstPaint = false;
    function frame() {
      if (!running) return;
      theta  += (thetaTarget  - theta)  * DAMPING;
      phi    += (phiTarget    - phi)    * DAMPING;
      radius += (radiusTarget - radius) * DAMPING;
      const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
      const sinTheta = Math.sin(theta), cosTheta = Math.cos(theta);
      const offX = radius * sinPhi * sinTheta;
      const offY = radius * cosPhi * -1;
      const offZ = radius * -1 * sinPhi * cosTheta;
      const eye = [target[0] + offX, target[1] + offY, target[2] + offZ];
      const w = canvas.width, h = canvas.height;
      const aspect = w / Math.max(1, h);
      _m4Perspective(proj, fovYRad, aspect, 0.01, 1000);
      _m4LookAt(view, eye, target, up);
      _m4Mul(mvp, proj, view);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
      gl.enableVertexAttribArray(aUv);
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(uTex, 0);
      gl.uniformMatrix4fv(uMvp, false, mvp);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
      gl.drawElements(gl.TRIANGLES, indexCount, indexType, 0);
      if (!firstPaint) {
        firstPaint = true;
        window.image3dLog?.phase('mesh:first-paint(custom)');
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); running = false; });
    return {
      readyPromise,
      stop() {
        running = false;
        ro.disconnect();
        gl.deleteBuffer(posBuf);
        gl.deleteBuffer(uvBuf);
        gl.deleteBuffer(idxBuf);
        gl.deleteTexture(tex);
        gl.deleteProgram(program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
        URL.revokeObjectURL(arrays.textureUrl);
      },
    };
  }

  let lottiePromise = null;
  function loadLottie() {
    if (typeof window !== 'undefined' && window.lottie) return Promise.resolve(window.lottie);
    if (lottiePromise) return lottiePromise;
    lottiePromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = LOTTIE_UMD;
      s.async = true;
      s.onload = () => {
        if (window.lottie) resolve(window.lottie);
        else reject(new Error('lottie loaded but global is missing'));
      };
      s.onerror = () => reject(new Error('failed to load lottie UMD'));
      document.head.appendChild(s);
    });
    return lottiePromise;
  }

  let fzstdPromise = null;
  function loadFzstd() {
    if (typeof window !== 'undefined' && window.fzstd) return Promise.resolve(window.fzstd);
    if (fzstdPromise) return fzstdPromise;
    fzstdPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = FZSTD_UMD;
      s.async = true;
      s.onload = () => {
        if (window.fzstd) resolve(window.fzstd);
        else reject(new Error('fzstd loaded but global is missing'));
      };
      s.onerror = () => reject(new Error('failed to load fzstd UMD'));
      document.head.appendChild(s);
    });
    return fzstdPromise;
  }

  let gs3dPromise = null;
  function loadGS3D() {
    if (!gs3dPromise) gs3dPromise = import(/* @vite-ignore */ GS3D_ESM);
    return gs3dPromise;
  }

  let viewerPromise = null;
  function loadViewerModule(overrideUrl) {
    const url = overrideUrl || DEFAULT_VIEWER_MODULE;
    if (!url) return Promise.reject(new Error('viewer module URL unresolved'));
    if (!viewerPromise) viewerPromise = import(/* @vite-ignore */ url);
    return viewerPromise;
  }

  // ----- Custom element -----

  const SHADOW_STYLE = `
    /* Sensible defaults: shrink-to-fit so the embed never blows past a
       reasonable size when dropped into an arbitrary page. Embedders can
       override via attributes (width=/height=) or CSS custom properties
       (--image-3d-max-width, --image-3d-max-height). */
    :host {
      display: block;
      position: relative;
      width: var(--image-3d-width, 100%);
      max-width: min(100%, var(--image-3d-max-width, 600px));
      max-height: var(--image-3d-max-height, 80vh);
      /* Host sizes via aspect-ratio (default square) rather than from a
         2D poster. JS updates --image-3d-aspect-ratio once the mesh
         preview's .bin header arrives with real img dims. */
      aspect-ratio: var(--image-3d-aspect-ratio, 1 / 1);
      line-height: 0;
      overflow: hidden;
      background: #000;
      border-radius: var(--image-3d-radius, 8px);
      /* Own the touch surface so long-press / double-tap reach the viewer
         instead of the host page's context menu / zoom defaults. */
      touch-action: none;
      -webkit-touch-callout: none;
      -webkit-user-select: none;
      user-select: none;
    }
    .stack {
      position: absolute;
      inset: 0;
    }
    /* Poster only renders if the embedder explicitly sets a [poster]
       attribute. Default <image-3d src> never fetches a 2D image —
       the mesh preview owns the visible loading state. */
    .poster {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
      transition: opacity 220ms ease-out;
      opacity: 1;
    }
    .poster:not([src]), .poster[src=""] { display: none; }
    /* Canvas is layered ON TOP of the poster, always visible. GS3D clears
       the canvas with alpha 0, so areas without rendered splats show the
       (blurred) poster through. As splats stream in they appear over the
       poster — that IS the streaming visualization. */
    .viewer-root {
      position: absolute;
      inset: 0;
    }
    /* Low-poly GLB preview, on top of viewer-root while the splat scene
       is still loading. Interactive (OrbitControls). Fades out when the
       MSPZ is ready and the splat scene takes over. */
    .glb-root {
      position: absolute;
      inset: 0;
      opacity: 1;
      transition: opacity 280ms ease-out;
    }
    .glb-root canvas { display: block; width: 100% !important; height: 100% !important; }
    :host([data-state="ready"]) .glb-root { opacity: 0; pointer-events: none; }
    /* When the model is fully loaded the poster fades out entirely. */
    :host([data-state="ready"]) .poster { opacity: 0; }
    .viewer-root canvas { display: block; width: 100% !important; height: 100% !important; }

    /* Long-press overlay — blue tint that fades in when the user holds
       (without dragging) and fades out on release or drag. 1:1 with the
       /p and homepage versions; scoped to the embed via absolute pos. */
    .long-press-overlay {
      position: absolute;
      inset: 0;
      background-color: rgba(77, 128, 255, 0.25);
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.15s ease-out;
      z-index: 50;
    }
    .long-press-overlay.active { opacity: 1; }

    /* Rotate hint — "Drag to explore" text + swipe-hand lottie. Shown
       briefly after the model loads, hidden on first interaction. */
    .rotate-hint-overlay {
      position: absolute;
      inset: 0;
      z-index: 60;
      pointer-events: none;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-end;
      padding-bottom: 24px;
      box-sizing: border-box;
      opacity: 0;
      transition: opacity 0.3s ease-out;
    }
    .rotate-hint-overlay.visible { opacity: 1; }
    .rotate-hint-overlay .hint-text {
      color: white;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 16px;
      font-weight: 600;
      text-shadow: 0 0 4px rgba(0, 0, 0, 0.9), 0 0 8px rgba(0, 0, 0, 0.7);
      background: rgba(0, 0, 0, 0.65);
      padding: 8px 18px;
      border-radius: 20px;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
    }
    .rotate-hint-overlay .lottie-container {
      width: 72px;
      height: 72px;
      margin-top: 4px;
    }

    /* Brand footer — clickable mukba.ng attribution. Embedders who want
       a clean look can hide it with the [nobrand] attribute. */
    .brand-footer {
      position: absolute;
      bottom: 8px;
      right: 8px;
      z-index: 70;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px 4px 6px;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-radius: 999px;
      color: #fff;
      font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      text-decoration: none;
      letter-spacing: 0.01em;
      opacity: 0.85;
      transition: opacity 150ms ease-out, transform 150ms ease-out;
      pointer-events: auto;
    }
    .brand-footer:hover, .brand-footer:focus-visible {
      opacity: 1;
      transform: translateY(-1px);
      outline: none;
    }
    .brand-footer img {
      width: 16px;
      height: 16px;
      display: block;
      border-radius: 4px;
    }
    :host([nobrand]) .brand-footer { display: none; }

    /* Built-in loading UI. Embedders can hide it via attribute or override
       slot if they want custom progress chrome. */
    .indicator {
      position: absolute;
      inset: 0;
      pointer-events: none;
      opacity: 0;
      transition: opacity 180ms ease-out;
    }
    :host([data-state="loading"]) .indicator { opacity: 1; }
    :host([noindicator]) .indicator { display: none; }
    .spinner {
      position: absolute;
      top: 50%;
      left: 50%;
      width: 36px;
      height: 36px;
      margin: -18px 0 0 -18px;
      border-radius: 50%;
      border: 3px solid rgba(255, 255, 255, 0.25);
      border-top-color: #fff;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.15), 0 1px 6px rgba(0, 0, 0, 0.25);
      animation: image-3d-spin 0.9s linear infinite;
    }
    @keyframes image-3d-spin { to { transform: rotate(360deg); } }
    .progress-track {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 3px;
      background: rgba(0, 0, 0, 0.25);
    }
    .progress-fill {
      height: 100%;
      width: 0;
      background: #fff;
      transition: width 200ms ease-out;
      box-shadow: 0 0 6px rgba(255, 255, 255, 0.7);
    }
    .scrim {
      position: absolute;
      inset: 0;
      background: linear-gradient(rgba(0,0,0,0.0), rgba(0,0,0,0.25));
    }
  `;

  class ImageThreeD extends HTMLElement {
    static get observedAttributes() {
      return ['src', 'poster', 'loading'];
    }

    constructor() {
      super();
      this._shadow = this.attachShadow({ mode: 'open' });
      this._loaded = false;
      this._loading = false;
      this._observer = null;
      this._viewer = null;
      this._abortCtrl = null;
    }

    connectedCallback() {
      window.image3dLog?.phase('connectedCallback');
      if (!this._shadow.firstChild) this._renderShadow();
      this._updatePoster();
      this._updateSize();

      const lazy = this.getAttribute('loading') === 'lazy';
      if (lazy && 'IntersectionObserver' in window) {
        this._observer = new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              this._observer.disconnect();
              this._observer = null;
              this._kickoff();
              break;
            }
          }
        }, { rootMargin: '256px' });
        this._observer.observe(this);
      } else {
        // microtask defer so attributes set after element creation are visible
        Promise.resolve().then(() => this._kickoff());
      }
    }

    disconnectedCallback() {
      if (this._observer) { this._observer.disconnect(); this._observer = null; }
      if (this._abortCtrl) { this._abortCtrl.abort(); this._abortCtrl = null; }
      if (this._swayRaf) { cancelAnimationFrame(this._swayRaf); this._swayRaf = null; }
      // Note: MspzImageViewer doesn't expose a teardown today. Re-attach will
      // create a fresh instance; we accept some leakage on disconnect for v1.
    }

    attributeChangedCallback(name, oldValue, newValue) {
      if (oldValue === newValue) return;
      if (name === 'poster' || name === 'src') this._updatePoster();
    }

    _renderShadow() {
      const style = document.createElement('style');
      style.textContent = SHADOW_STYLE;
      const stack = document.createElement('div');
      stack.className = 'stack';
      const poster = document.createElement('img');
      poster.className = 'poster';
      poster.alt = this.getAttribute('alt') || '';
      poster.decoding = 'async';
      const viewerRoot = document.createElement('div');
      viewerRoot.className = 'viewer-root';

      const glbRoot = document.createElement('div');
      glbRoot.className = 'glb-root';

      const indicator = document.createElement('div');
      indicator.className = 'indicator';
      const scrim = document.createElement('div');
      scrim.className = 'scrim';
      const spinner = document.createElement('div');
      spinner.className = 'spinner';
      const track = document.createElement('div');
      track.className = 'progress-track';
      const fill = document.createElement('div');
      fill.className = 'progress-fill';
      track.appendChild(fill);
      indicator.appendChild(scrim);
      indicator.appendChild(spinner);
      indicator.appendChild(track);

      const longPress = document.createElement('div');
      longPress.className = 'long-press-overlay';

      const rotateHint = document.createElement('div');
      rotateHint.className = 'rotate-hint-overlay';
      const hintText = document.createElement('span');
      hintText.className = 'hint-text';
      hintText.textContent = 'Drag to explore';
      const lottieContainer = document.createElement('div');
      lottieContainer.className = 'lottie-container';
      rotateHint.appendChild(hintText);
      rotateHint.appendChild(lottieContainer);

      const brand = document.createElement('a');
      brand.className = 'brand-footer';
      brand.href = 'https://mukba.ng/?ref=image-3d-embed';
      brand.target = '_blank';
      brand.rel = 'noopener noreferrer';
      brand.setAttribute('aria-label', 'Made with mukba.ng — open in new tab');
      const brandIcon = document.createElement('img');
      brandIcon.src = EMBED_DIR
        ? new URL('../assets/icon.png', EMBED_DIR).href
        : 'https://mukba.ng/assets/icon.png';
      brandIcon.alt = '';
      brandIcon.decoding = 'async';
      brandIcon.loading = 'lazy';
      const brandText = document.createElement('span');
      brandText.textContent = 'mukba.ng';
      brand.appendChild(brandIcon);
      brand.appendChild(brandText);

      stack.appendChild(poster);
      stack.appendChild(viewerRoot);
      stack.appendChild(glbRoot);
      stack.appendChild(indicator);
      stack.appendChild(longPress);
      stack.appendChild(rotateHint);
      stack.appendChild(brand);
      this._shadow.appendChild(style);
      this._shadow.appendChild(stack);
      this._posterEl = poster;
      this._viewerRoot = viewerRoot;
      this._glbRoot = glbRoot;
      this._progressFill = fill;
      this._longPressOverlay = longPress;
      this._rotateHintOverlay = rotateHint;
      this._lottieContainer = lottieContainer;
    }

    _updatePoster() {
      if (!this._posterEl) return;
      // No auto-fallback to src — the embed is mesh-preview-first. If an
      // embedder wants a 2D placeholder behind the preview they have to
      // ask for one explicitly with poster=.
      const poster = this.getAttribute('poster');
      if (poster) {
        if (this._posterEl.src !== poster) this._posterEl.src = poster;
      } else if (this._posterEl.hasAttribute('src')) {
        this._posterEl.removeAttribute('src');
      }
    }

    _updateSize() {
      const w = this.getAttribute('width');
      const h = this.getAttribute('height');
      // Explicit attrs win: set the poster's dimension AND drop the default
      // max-* cap so the embedder's request isn't silently shrunk.
      if (w) {
        const val = /^\d+$/.test(w) ? w + 'px' : w;
        this.style.setProperty('--image-3d-width', val);
        this.style.setProperty('--image-3d-max-width', 'none');
      }
      if (h) {
        const val = /^\d+$/.test(h) ? h + 'px' : h;
        this.style.setProperty('--image-3d-height', val);
        this.style.setProperty('--image-3d-max-height', 'none');
      }
    }

    async _kickoff() {
      if (this._loaded || this._loading) return;
      window.image3dLog?.phase('_kickoff');
      // mspz-src is an escape hatch for testing — points directly at a
      // pre-generated MSPZ, bypasses the worker + mesh-preview pipeline.
      const explicit = this.getAttribute('mspz-src');
      const src = this.getAttribute('src');
      if (!explicit && !src) {
        this._emit('image-3d:error', { error: new Error('missing src') });
        return;
      }
      this._loading = true;
      this.setAttribute('data-state', 'loading');
      this._emit('image-3d:loading', { src: explicit || src });
      try {
        if (explicit) {
          await this._loadDirectMspz(explicit);
        } else {
          await this._loadAndRender(src);
        }
        this._loaded = true;
        this.setAttribute('data-state', 'ready');
        this._emit('image-3d:ready', {});
        this._maybePlayIntroSway();
      } catch (err) {
        this.setAttribute('data-state', 'error');
        this._emit('image-3d:error', { error: err });
        // Always log — silent failures are worse than the noise. Embedders
        // can suppress by listening for image-3d:error and calling preventDefault.
        console.warn('[image-3d]', err);
      } finally {
        this._loading = false;
      }
    }

    // Intro sway: rotates the model left-right around the yaw axis once
    // the splat is ready, then settles back to center. On by default; opt
    // out per-embed by adding the `nosway` attribute to the tag:
    //
    //   <image-3d src="..." nosway></image-3d>
    //
    // URL params can override amplitude/duration for in-page tuning. They
    // also accept `image3d_sway=0` as a page-wide disable for testing
    // without editing markup:
    //
    //   ?image3d_sway=0           disable for the whole page
    //   ?image3d_sway_deg=N       peak yaw, degrees (default 8)
    //   ?image3d_sway_ms=N        total animation time, ms; one full sine
    //                             cycle center→right→center→left→center
    //                             (default 1800)
    //   ?image3d_sway_mode=decay  amplitude decays to 0 over duration (default)
    //   ?image3d_sway_mode=steady amplitude stays constant for the duration
    //
    // Stops on first pointerdown on the viewer so user interaction always
    // wins. Requires the viewer's MODEL_ROTATION code path (the default —
    // disabled by ?orbit), since we drive _yaw and call _applyModelRotation.
    _maybePlayIntroSway() {
      if (this.hasAttribute('nosway')) return;
      const viewer = this._viewer;
      if (!viewer || typeof viewer._applyModelRotation !== 'function') return;
      let params = null;
      try { params = new URLSearchParams(location.search); } catch (_) {}
      if (params && params.get('image3d_sway') === '0') return;
      const deg = parseFloat((params && params.get('image3d_sway_deg')) || '8');
      const ms = parseFloat((params && params.get('image3d_sway_ms')) || '1800');
      if (!isFinite(deg) || !isFinite(ms) || ms <= 0) return;
      const steady = !!(params && params.get('image3d_sway_mode') === 'steady');
      const amplitude = deg * Math.PI / 180;
      const start = performance.now();
      const stop = () => {
        if (this._swayRaf) { cancelAnimationFrame(this._swayRaf); this._swayRaf = null; }
        if (this._swayPointerStop) {
          this._viewerRoot?.removeEventListener('pointerdown', this._swayPointerStop, true);
          this._swayPointerStop = null;
        }
        viewer._yaw = 0;
        viewer._applyModelRotation();
      };
      this._swayPointerStop = stop;
      this._viewerRoot?.addEventListener('pointerdown', stop, true);
      const tick = (now) => {
        const elapsed = now - start;
        if (elapsed >= ms) { stop(); return; }
        const t = elapsed / ms;
        const env = steady ? 1 : (1 - t);
        viewer._yaw = amplitude * Math.sin(t * 2 * Math.PI) * env;
        viewer._applyModelRotation();
        this._swayRaf = requestAnimationFrame(tick);
      };
      this._swayRaf = requestAnimationFrame(tick);
    }

    async _renderMeshPreview(previewUrl) {
      window.image3dLog?.phase('mesh:start');
      return this._renderMeshCustom(previewUrl);
    }

    async _renderMeshCustom(previewUrl) {
      const container = this._glbRoot;
      // Custom renderer is inlined into embed.js, so the only network
      // dependency for this path is the .bin itself.
      const decoded = await decodeMeshPreviewBin(previewUrl, this._abortCtrl?.signal);
      window.image3dLog?.phase('mesh:bin-decoded');
      if (decoded.imgW > 0 && decoded.imgH > 0) {
        this.style.setProperty('--image-3d-aspect-ratio', `${decoded.imgW} / ${decoded.imgH}`);
        this._aspectRatioSet = true;
      }
      const arrays = prepMeshArrays(decoded);
      const fov = (decoded.fy > 0 && decoded.imgH > 0)
        ? 2 * Math.atan2(decoded.imgH / 2, decoded.fy) * 180 / Math.PI
        : 50;
      window.image3dLog?.phase('mesh:geometry-built');
      const handle = createCustomMeshRenderer({ container, arrays, fovDeg: fov });
      // Custom renderer's first paint is logged from inside the module
      // (sees 'mesh:first-paint(custom)'). We do nothing else here.
      this._glbState = {
        custom: true,
        stop: handle.stop,
      };
    }

    async _readMspzAspectFromHeader(response) {
      // Pull just the first 56 bytes (MSPZ header) off a cloned stream so
      // we can size the host before any rendering. img_w/img_h live at
      // offsets 40/44 little-endian per the format. Cheap (one TCP chunk
      // usually covers it) and leaves the original response untouched.
      if (this._aspectRatioSet) return;
      try {
        const reader = response.clone().body.getReader();
        let buf = new Uint8Array(0);
        while (buf.length < 56) {
          const { value, done } = await reader.read();
          if (value) {
            const next = new Uint8Array(buf.length + value.length);
            next.set(buf);
            next.set(value, buf.length);
            buf = next;
          }
          if (done) break;
        }
        reader.cancel('header-only').catch(() => {});
        if (buf.length >= 56) {
          const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
          const imgW = dv.getUint32(40, true);
          const imgH = dv.getUint32(44, true);
          if (imgW > 0 && imgH > 0) {
            this.style.setProperty('--image-3d-aspect-ratio', `${imgW} / ${imgH}`);
            this._aspectRatioSet = true;
          }
        }
      } catch (err) {
        // Non-fatal — host stays at the default 1/1 until decode kicks in.
        console.warn('[image-3d] aspect-ratio read failed', err);
      }
    }

    async _loadAndRender(sourceUrl) {
      // Worker rejects bare paths; resolve against the page so callers
      // can pass relative src like "/photo.jpg".
      sourceUrl = new URL(sourceUrl, document.baseURI).href;
      this._abortCtrl = new AbortController();
      this._glbRenderPromise = null;
      this._aspectRatioSet = false;

      // Content-addressed URLs. The `?url=` query is what tells the
      // worker which source to generate on cache miss — same generation
      // is globally deduped via Durable Object, so both fetches can race
      // and they share the same Modal call. On cache hit ?url= is just
      // ignored. One fetch each, no separate "trigger then refetch"
      // dance.
      const hash = await sha256Hex(sourceUrl);
      const q = `?url=${encodeURIComponent(sourceUrl)}`;
      const mspzUrl = `${WORKER_BASE}r2/v1/mspz/${hash}.mspz${q}`;
      const meshUrl = `${WORKER_BASE}r2/v1/mesh/${hash}.bin${q}`;

      window.image3dLog?.phase('_loadAndRender');
      // Mesh preview races in parallel — non-fatal if it fails.
      this._glbRenderPromise = this._renderMeshPreview(meshUrl).catch((err) => {
        if (err?.name !== 'AbortError') {
          console.warn('[image-3d] mesh preview failed', err);
        }
        this._glbRenderPromise = null;
      });

      // Wait for the mesh preview to finish painting before kicking off
      // the splat-side heavy deps (GS3D ~hundreds of KB, mspz-image-
      // viewer.js ~33KB, fzstd, lottie). On a 450 Kbps link, running
      // them in parallel with the mesh path was costing the mesh ~13s
      // of bandwidth contention. Mesh is small (.bin ~11KB + tiny
      // renderer), so this serialization adds maybe ~1–2s to splat-
      // ready time on slow networks but lets the user see SOMETHING
      // in ~2s instead of ~18s.
      try { await this._glbRenderPromise; } catch (_) { /* mesh fail is non-fatal */ }
      window.image3dLog?.phase('mesh:done-serialize-splat');

      // Fetch the mspz bytes. With ?url= the worker either returns
      // cached bytes immediately OR blocks the response until Modal
      // generates the artifact, then returns the bytes. Either way: one
      // request, one response, no separate trigger step.
      window.image3dLog?.phase('mspz:fetch-start');
      const mspzResp = await fetch(mspzUrl, { signal: this._abortCtrl.signal });
      window.image3dLog?.phase('mspz:headers');
      if (!mspzResp.ok) {
        throw new Error(`mspz fetch failed: ${mspzResp.status}`);
      }

      // Now load deps for the splat path. Sequential phase log so we
      // can see which CDN is slowest.
      const viewerModuleUrl = this.getAttribute('viewer-module') || null;
      const depPromise = Promise.all([
        loadFzstd().then((x) => { window.image3dLog?.phase('dep:fzstd'); return x; }),
        loadGS3D().then((x) => { window.image3dLog?.phase('dep:gs3d'); return x; }),
        loadViewerModule(viewerModuleUrl).then((x) => { window.image3dLog?.phase('dep:viewer'); return x; }),
      ]);
      loadLottie().catch(() => null);
      const [, gs3d, viewerMod] = await depPromise;
      window.image3dLog?.phase('deps:all-ready');
      const { MspzImageViewer } = viewerMod;

      const viewer = new MspzImageViewer({
        rootElement: this._viewerRoot,
        modelId: this._stableModelId(mspzUrl),
        clip: false,
        longPressOverlay: this._longPressOverlay,
        rotateHintOverlay: this._rotateHintOverlay,
        lottieContainer: this._lottieContainer,
        lottiePath: LOTTIE_PATH,
        gestureTarget: this,
        progressiveStream: true,
        onError: (err) => this._emit('image-3d:error', { error: err }),
      });
      this._viewer = viewer;

      // Size the host from the MSPZ header before initialization so the
      // viewer's canvas sets up at the correct aspect. No-op if the
      // mesh-preview path already set the aspect ratio.
      await this._readMspzAspectFromHeader(mspzResp);

      window.image3dLog?.phase('viewer:init-start');
      await viewer.init(gs3d);
      window.image3dLog?.phase('viewer:init-end');
      // No await on the mesh promise — splat path is independent.
      // Whichever path finishes first paints into its layer; data-state
      // = "ready" fades the mesh out when the splat completes. (Camera
      // transfer between the two is a follow-up; previously gating
      // here just made the splat wait for the mesh on slow networks
      // without producing a visible benefit.)
      window.image3dLog?.phase('viewer:loadMspz-start');
      await viewer.loadMspz(mspzUrl, null, { preFetched: Promise.resolve(mspzResp) });
      window.image3dLog?.phase('viewer:loadMspz-end');

      // Drop the mesh renderer once the splat has actually painted so
      // it stops eating a RAF loop. If the mesh promise is still in
      // flight here (it 404'd or is on slow CDN), we let it resolve
      // and clean itself up via the catch in tryMesh.
      if (this._glbState) {
        await new Promise((r) => requestAnimationFrame(r));
        this._glbState.stop();
        this._glbState = null;
      }
    }

    async _loadDirectMspz(mspzUrl) {
      // mspz-src escape hatch. Skip the hash/generation flow entirely
      // — just fetch the bytes and hand them to the viewer. No mesh
      // preview, no completion stream.
      mspzUrl = new URL(mspzUrl, document.baseURI).href;
      this._abortCtrl = new AbortController();
      this._glbRenderPromise = null;
      const r = await fetch(mspzUrl, { signal: this._abortCtrl.signal });
      if (!r.ok) throw new Error(`mspz-src fetch failed: ${r.status}`);
      const viewerModuleUrl = this.getAttribute('viewer-module') || null;
      const [, gs3d, viewerMod] = await Promise.all([
        loadFzstd(), loadGS3D(), loadViewerModule(viewerModuleUrl),
      ]);
      loadLottie().catch(() => null);
      const { MspzImageViewer } = viewerMod;
      const viewer = new MspzImageViewer({
        rootElement: this._viewerRoot,
        modelId: this._stableModelId(mspzUrl),
        clip: false,
        longPressOverlay: this._longPressOverlay,
        rotateHintOverlay: this._rotateHintOverlay,
        lottieContainer: this._lottieContainer,
        lottiePath: LOTTIE_PATH,
        gestureTarget: this,
        progressiveStream: true,
        onError: (err) => this._emit('image-3d:error', { error: err }),
      });
      this._viewer = viewer;
      await this._readMspzAspectFromHeader(r);
      await viewer.init(gs3d);
      await viewer.loadMspz(mspzUrl, null, { preFetched: Promise.resolve(r) });
    }


    _stableModelId(url) {
      // Cheap stable hash for telemetry / debug. Not security-sensitive.
      let h = 0;
      for (let i = 0; i < url.length; i++) h = ((h << 5) - h + url.charCodeAt(i)) | 0;
      return 'img3d_' + Math.abs(h).toString(36);
    }

    _emit(type, detail) {
      this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
    }
  }

  customElements.define('image-3d', ImageThreeD);
})();
