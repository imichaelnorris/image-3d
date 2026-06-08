# `<image-3d>`

[<img alt="mukba.ng" src="https://mukba.ng/assets/image-3d-badge.svg" height="28">](https://mukba.ng/?ref=image-3d-embed)

A drop-in web component that turns a photo into an interactive 3D Gaussian splat. Drag to rotate, pinch to zoom. Runs entirely in the browser — no server required.

[**Live demo & docs →**](https://mukba.ng/image-3d/docs/)

## Install

```html
<script src="https://mukba.ng/image-3d/embed.js" defer></script>
```

## Usage

```html
<!-- Drop zone: user picks a photo -->
<image-3d></image-3d>

<!-- Auto-infer on load -->
<image-3d src="/photo.jpg"></image-3d>

<!-- Load a pre-generated MSPZ, no inference -->
<image-3d model="/model.mspz"></image-3d>
```

### `src="photo.jpg"` ⚠️ resource-intensive

Runs depth estimation automatically when the element loads.

- Downloads a ~30 MB int8-quantized ONNX model on first visit (cached after that)
- Expands to **~1 GB RAM** at runtime during inference
- Takes a few seconds on fast hardware (Apple Silicon, modern GPU); slower devices may take 10–30s
- The model is a singleton — multiple elements on the same page share one instance

If you have a pre-generated splat, use `model="..."` instead.

## Attributes

| Attribute | Description |
|---|---|
| `src="photo.jpg"` | Auto-run inference on this photo on load. ⚠️ See above. |
| `model="file.mspz"` | Load a pre-generated MSPZ directly. No inference, no model download. |
| `width` / `height` | Explicit dimensions. Bare numbers → px; CSS values (`50%`, `40vw`) work too. |
| `nobrand` | Hide the mukba.ng attribution pill. |
| `nosway` | Disable the intro rotation animation. |
| `no-download` | Hide the download button. |

## CSS custom properties

| Property | Default | Notes |
|---|---|---|
| `--image-3d-max-width` | `600px` | Cap on rendered width. |
| `--image-3d-max-height` | `80vh` | Cap on height. |
| `--image-3d-radius` | `8px` | Corner radius. `0` for sharp. |
| `--image-3d-width` / `--image-3d-height` | `auto` | Also settable via `width`/`height` attributes. |

## Lifecycle events

```js
const el = document.querySelector('image-3d');
el.addEventListener('image-3d:loading',  (e) => console.log('start'));
el.addEventListener('image-3d:progress', (e) => console.log('progress', e.detail));
el.addEventListener('image-3d:ready',    ()  => console.log('ready'));
el.addEventListener('image-3d:error',    (e) => console.warn('error', e.detail.error));
```

## Behavior notes

- **Controls.** Drag to orbit, pinch or scroll to zoom.
- **Long-press to reset.** Hold without dragging → blue scrim; release to recenter the camera.
- **Shadow DOM.** Use the documented CSS custom properties to restyle; host-page CSS can't bleed in.
- **Singleton model.** The depth model is shared across all `<image-3d>` elements on the page — downloaded once, loaded once.
- **Graceful failure.** If inference fails, an `image-3d:error` event fires. The drop zone stays interactive so the user can try again.

---

Made by [mukba.ng](https://mukba.ng/) · © [Fncore, Inc.](https://fncore.com/about)
