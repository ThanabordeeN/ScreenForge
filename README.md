# ScreenForge

ScreenForge is a browser-based green-screen screen replacement tool. Video processing stays on the user's device.

## V1 pipeline

```text
Base video
  -> green-screen detection (OpenCV.js)
  -> 4-corner extraction
  -> Lucas-Kanade optical-flow tracking
  -> periodic green re-detection
  -> homography
  -> WebGL2 perspective warp
  -> green-only composite
  -> local MediaRecorder export
```

Black phone bezels, fingers and other non-green foreground pixels remain from the original footage, so replacement content appears underneath them. Replacement content defaults to 1.5% overscan and can be adjusted from 0–4%.

## Run locally

Requirements: Node.js 20+.

```bash
npm install
npm run dev
```

Open the URL printed by Vite, then:

1. Load a base video containing a green device screen.
2. Load a replacement video or image.
3. Let Auto Track detect the screen, or click **Detect screen**.
4. Drag any of the four corner handles if manual correction is needed.
5. Adjust Overscan / Green minimum / Green dominance.
6. Click **Export locally**.

## Browser support

The app requires WebGL2 and uses OpenCV.js from the official OpenCV 4.x build. Local export uses `HTMLCanvasElement.captureStream()` + `MediaRecorder`, so output format depends on the browser (MP4 when supported, otherwise WebM).

Recent desktop Chrome, Edge and Firefox are the primary V1 targets. Mobile browsers can run the preview, but high-resolution export performance depends on the device.

## Privacy / compute

Base footage and replacement media are loaded through local object URLs. The application does not upload source media to a backend. Tracking, warp, compositing and export run in the browser.

## Current V1 limitations

- Tracking uses the four screen corners with periodic green re-detection; it does not yet estimate homography from a dense feature set.
- Export runs in real time rather than offline faster-than-realtime encoding.
- Green thresholds are global for the clip.
- MediaRecorder codec/container support varies by browser.

## Development

```bash
npm run build
npm run preview
```
