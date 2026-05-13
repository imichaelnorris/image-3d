# `<image-3d>`

[![Powered by mukba.ng](https://img.shields.io/badge/Powered_by-mukba.ng-7eb0ff?style=for-the-badge&labelColor=0a0a0c)](https://mukba.ng/)

A drop-in web component that turns a 2D image URL into an interactive 3D embed. Drag to rotate, pinch to zoom.

[**Live demo & docs →**](https://mukba.ng/image-3d/docs/)

## Install

Drop these two lines into any HTML page:

```html
<script src="https://mukba.ng/image-3d/embed.js" defer></script>
<image-3d src="/your-photo.jpg"></image-3d>
```

The `mukba.ng` worker fetches the image, generates the 3D artifacts (mesh preview + gaussian splat), and the client crossfades from poster → mesh → splat as each piece loads.

## Add it with Claude Code

Paste this prompt into [Claude Code](https://claude.com/claude-code) in your project directory:

```
Add the <image-3d> web component to this project.

Reference docs: https://mukba.ng/image-3d/docs/

Steps:
1. Add this script tag once, in the <head> of the main HTML template
   (or shared layout):
   <script src="https://mukba.ng/image-3d/embed.js" defer></script>
2. Then ask me which photo I want to convert. To swap one, replace its
   <img> with:
     <image-3d src="/same/photo/url.jpg"></image-3d>
   It's a standard custom element — no wrapper needed in React/Vue/
   Svelte/etc.
3. Show me the diff before committing.
```

## Attributes

| Attribute | Description |
|---|---|
| `src` *(required)* | Source image URL. The mukba.ng worker fetches this and generates the 3D artifacts. |
| `width` / `height` | Explicit pixel dimensions. Overrides the default 600px / 80vh caps. Bare numbers are interpreted as px; full CSS values (`50%`, `40vw`) work too. |
| `loading="lazy"` | Defer the fetch until the element scrolls near the viewport. |
| `nobrand` | Hide the "mukba.ng" attribution pill in the bottom-right corner. |
| `renderer="custom"` | Use the tiny hand-rolled WebGL renderer for the mesh-preview phase instead of Three.js. Much smaller payload (~10KB vs ~150KB) and ~6s faster on slow networks. Default still ships Three.js until visual parity is confirmed everywhere. |

## CSS custom properties

The element uses shadow DOM, so the host page's CSS can't bleed in. Set these on the host element to restyle.

| Property | Default | Notes |
|---|---|---|
| `--image-3d-max-width` | `600px` | Hard cap on rendered width. |
| `--image-3d-max-height` | `80vh` | Hard cap on poster height (and thus overall height). |
| `--image-3d-radius` | `8px` | Host corner radius. Set `0` for sharp. |
| `--image-3d-width` / `--image-3d-height` | `auto` | Set by the corresponding attributes; you can also set these directly via CSS. |

## Lifecycle events

The element dispatches `CustomEvent`s on itself. Listen the way you would on any DOM element.

```js
const el = document.querySelector('image-3d');
el.addEventListener('image-3d:loading',  (e) => console.log('start'));
el.addEventListener('image-3d:progress', (e) => console.log('progress', e.detail));
el.addEventListener('image-3d:ready',    ()  => console.log('ready'));
el.addEventListener('image-3d:error',    (e) => console.warn('error', e.detail.error));
```

## Behavior notes

- **Mesh first, splat second.** The small mesh preview (~11KB) paints almost immediately; the larger splat crossfades over once it loads.
- **Long-press to reset.** Press and hold without dragging for a blue scrim; release to recenter the camera. Pinch / scroll to zoom; drag to orbit.
- **Shadow DOM.** Nothing on the host page can override the embed's internal styling unless you use the documented CSS custom properties.
- **Graceful failure.** If the worker fails or returns garbage, the poster image stays visible and an `image-3d:error` event fires. The user always sees something.

---

Made by [mukba.ng](https://mukba.ng/) · © [Fncore, Inc.](https://fncore.com/about)
