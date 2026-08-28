import './style.css';
import { HomographyRenderer } from './renderer.js';
import { ScreenTracker } from './tracker.js';

const $ = (id) => document.getElementById(id);
const els = {
  baseInput: $('baseInput'), replacementInput: $('replacementInput'),
  baseMeta: $('baseMeta'), replacementMeta: $('replacementMeta'),
  autoTrack: $('autoTrack'), detectBtn: $('detectBtn'), resetBtn: $('resetBtn'),
  overscan: $('overscan'), overscanValue: $('overscanValue'),
  greenMin: $('greenMin'), greenMinValue: $('greenMinValue'),
  dominance: $('dominance'), dominanceValue: $('dominanceValue'),
  exportBtn: $('exportBtn'), playBtn: $('playBtn'), timeline: $('timeline'), timeLabel: $('timeLabel'),
  renderCanvas: $('renderCanvas'), overlayCanvas: $('overlayCanvas'), previewStage: $('previewStage'),
  emptyState: $('emptyState'), opencvStatus: $('opencvStatus'), trackStatus: $('trackStatus'), fpsStatus: $('fpsStatus'),
  baseVideo: $('baseVideo'), replacementVideo: $('replacementVideo'), replacementImage: $('replacementImage'),
};

let tracker = null;
let renderer = null;
let replacementSource = null;
let baseUrl = null;
let replacementUrl = null;
let currentCorners = null;
let draggingCorner = -1;
let exporting = false;
let lastFrameTs = performance.now();
let framesThisSecond = 0;

try {
  renderer = new HomographyRenderer(els.renderCanvas);
} catch (error) {
  els.opencvStatus.textContent = error.message;
}

waitForOpenCV()
  .then((cv) => {
    tracker = new ScreenTracker(cv);
    els.opencvStatus.textContent = 'OpenCV ready';
  })
  .catch((error) => {
    els.opencvStatus.textContent = `OpenCV unavailable: ${error.message}`;
  });

els.baseInput.addEventListener('change', () => loadBaseVideo(els.baseInput.files?.[0]));
els.replacementInput.addEventListener('change', () => loadReplacement(els.replacementInput.files?.[0]));

els.playBtn.addEventListener('click', async () => {
  if (!els.baseVideo.src) return;
  if (els.baseVideo.paused) await playMedia();
  else pauseMedia();
});

els.baseVideo.addEventListener('play', () => {
  els.playBtn.textContent = 'Pause';
  syncReplacement(true);
});
els.baseVideo.addEventListener('pause', () => {
  els.playBtn.textContent = 'Play';
  if (replacementSource === els.replacementVideo) els.replacementVideo.pause();
});
els.baseVideo.addEventListener('timeupdate', updateTimeline);
els.baseVideo.addEventListener('ended', () => { els.playBtn.textContent = 'Play'; });
els.baseVideo.addEventListener('seeking', () => {
  syncReplacement(false);
  tracker?.requestDetection();
});

els.timeline.addEventListener('input', () => {
  if (!Number.isFinite(els.baseVideo.duration)) return;
  els.baseVideo.currentTime = Number(els.timeline.value) * els.baseVideo.duration;
  syncReplacement(false);
});

els.detectBtn.addEventListener('click', () => {
  tracker?.requestDetection();
  els.trackStatus.textContent = 'Detecting green screen…';
});

els.resetBtn.addEventListener('click', () => {
  tracker?.reset();
  currentCorners = null;
  els.autoTrack.checked = true;
  els.trackStatus.textContent = 'Track reset';
});

els.autoTrack.addEventListener('change', () => {
  if (els.autoTrack.checked && currentCorners && tracker) tracker.setOutputCorners(currentCorners, els.baseVideo);
});

for (const input of [els.overscan, els.greenMin, els.dominance]) {
  input.addEventListener('input', updateControlLabels);
}
updateControlLabels();

els.overlayCanvas.addEventListener('pointerdown', onPointerDown);
els.overlayCanvas.addEventListener('pointermove', onPointerMove);
els.overlayCanvas.addEventListener('pointerup', onPointerUp);
els.overlayCanvas.addEventListener('pointercancel', onPointerUp);

els.exportBtn.addEventListener('click', exportVideo);
requestAnimationFrame(renderLoop);

async function waitForOpenCV() {
  const timeoutAt = performance.now() + 30000;
  while (performance.now() < timeoutAt) {
    if (window.cv) {
      if (typeof window.cv.then === 'function') window.cv = await window.cv;
      if (window.cv?.Mat && window.cv?.calcOpticalFlowPyrLK) return window.cv;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out loading OpenCV.js');
}

function loadBaseVideo(file) {
  if (!file) return;
  if (baseUrl) URL.revokeObjectURL(baseUrl);
  baseUrl = URL.createObjectURL(file);
  els.baseVideo.src = baseUrl;
  els.baseVideo.load();
  els.baseMeta.textContent = `${file.name} · ${formatBytes(file.size)}`;

  els.baseVideo.onloadedmetadata = () => {
    const { videoWidth: w, videoHeight: h, duration } = els.baseVideo;
    els.previewStage.style.aspectRatio = `${w} / ${h}`;
    els.renderCanvas.width = w;
    els.renderCanvas.height = h;
    els.overlayCanvas.width = w;
    els.overlayCanvas.height = h;
    els.baseMeta.textContent = `${file.name} · ${w}×${h} · ${formatTime(duration)}`;
    els.playBtn.disabled = false;
    els.timeline.disabled = false;
    els.exportBtn.disabled = !replacementSource;
    els.emptyState.style.display = 'none';
    tracker?.reset();
    currentCorners = null;
    els.trackStatus.textContent = 'Ready to detect';
    updateTimeline();
  };
}

function loadReplacement(file) {
  if (!file) return;
  if (replacementUrl) URL.revokeObjectURL(replacementUrl);
  replacementUrl = URL.createObjectURL(file);

  if (file.type.startsWith('video/')) {
    els.replacementImage.removeAttribute('src');
    els.replacementVideo.src = replacementUrl;
    els.replacementVideo.load();
    replacementSource = els.replacementVideo;
    els.replacementVideo.onloadedmetadata = () => {
      els.replacementMeta.textContent = `${file.name} · ${els.replacementVideo.videoWidth}×${els.replacementVideo.videoHeight} · ${formatTime(els.replacementVideo.duration)}`;
      els.exportBtn.disabled = !els.baseVideo.src;
      syncReplacement(false);
    };
  } else if (file.type.startsWith('image/')) {
    els.replacementVideo.pause();
    els.replacementVideo.removeAttribute('src');
    els.replacementImage.src = replacementUrl;
    replacementSource = els.replacementImage;
    els.replacementImage.onload = () => {
      els.replacementMeta.textContent = `${file.name} · ${els.replacementImage.naturalWidth}×${els.replacementImage.naturalHeight}`;
      els.exportBtn.disabled = !els.baseVideo.src;
    };
  }
}

async function playMedia() {
  syncReplacement(false);
  await els.baseVideo.play();
}

function pauseMedia() {
  els.baseVideo.pause();
  if (replacementSource === els.replacementVideo) els.replacementVideo.pause();
}

function syncReplacement(shouldPlay) {
  if (replacementSource !== els.replacementVideo || !Number.isFinite(els.replacementVideo.duration) || els.replacementVideo.duration <= 0) return;
  const target = els.baseVideo.currentTime % els.replacementVideo.duration;
  if (Math.abs(els.replacementVideo.currentTime - target) > 0.18) els.replacementVideo.currentTime = target;
  if (shouldPlay && !els.baseVideo.paused) els.replacementVideo.play().catch(() => {});
}

function renderLoop(ts) {
  if (renderer && els.baseVideo.readyState >= 2) {
    if (tracker && (els.autoTrack.checked || tracker.forceDetect) && draggingCorner < 0) {
      const result = tracker.process(els.baseVideo);
      if (result.corners) {
        currentCorners = result.corners;
        const pct = Math.round(result.confidence * 100);
        els.trackStatus.textContent = `${result.mode} · ${pct}% confidence`;
      }
    }

    renderer.render(els.baseVideo, replacementSource, currentCorners, {
      overscan: Number(els.overscan.value),
      greenMin: Number(els.greenMin.value),
      dominance: Number(els.dominance.value),
    });
    drawOverlay();

    framesThisSecond += 1;
    if (ts - lastFrameTs >= 1000) {
      els.fpsStatus.textContent = `${Math.round(framesThisSecond * 1000 / (ts - lastFrameTs))} preview fps`;
      framesThisSecond = 0;
      lastFrameTs = ts;
    }
  }
  requestAnimationFrame(renderLoop);
}

function drawOverlay() {
  const canvas = els.overlayCanvas;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!currentCorners?.length) return;

  const scale = Math.max(1, canvas.width / 1080);
  ctx.lineWidth = 2 * scale;
  ctx.strokeStyle = 'rgba(86, 238, 161, 0.95)';
  ctx.fillStyle = 'rgba(86, 238, 161, 0.95)';
  ctx.beginPath();
  currentCorners.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.closePath();
  ctx.stroke();

  currentCorners.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#07120d';
    ctx.font = `${10 * scale}px ui-sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), p.x, p.y + 0.5 * scale);
    ctx.fillStyle = 'rgba(86, 238, 161, 0.95)';
  });
}

function onPointerDown(event) {
  if (!currentCorners) return;
  const point = pointerToVideo(event);
  const rect = els.overlayCanvas.getBoundingClientRect();
  const threshold = 28 * (els.overlayCanvas.width / rect.width);
  let best = -1;
  let bestDistance = Infinity;
  currentCorners.forEach((corner, i) => {
    const d = Math.hypot(corner.x - point.x, corner.y - point.y);
    if (d < threshold && d < bestDistance) { best = i; bestDistance = d; }
  });
  if (best >= 0) {
    draggingCorner = best;
    els.autoTrack.checked = false;
    els.overlayCanvas.setPointerCapture(event.pointerId);
  }
}

function onPointerMove(event) {
  if (draggingCorner < 0 || !currentCorners) return;
  currentCorners[draggingCorner] = pointerToVideo(event);
  els.trackStatus.textContent = 'Manual corner edit';
}

function onPointerUp(event) {
  if (draggingCorner < 0) return;
  draggingCorner = -1;
  try { els.overlayCanvas.releasePointerCapture(event.pointerId); } catch {}
  tracker?.setOutputCorners(currentCorners, els.baseVideo);
}

function pointerToVideo(event) {
  const rect = els.overlayCanvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(els.overlayCanvas.width, (event.clientX - rect.left) / rect.width * els.overlayCanvas.width)),
    y: Math.max(0, Math.min(els.overlayCanvas.height, (event.clientY - rect.top) / rect.height * els.overlayCanvas.height)),
  };
}

async function exportVideo() {
  if (exporting || !renderer || !els.baseVideo.src || !replacementSource) return;
  if (!window.MediaRecorder || !els.renderCanvas.captureStream) {
    alert('This browser does not support local canvas recording. Try a recent Chrome, Edge or Firefox.');
    return;
  }

  exporting = true;
  els.exportBtn.disabled = true;
  els.exportBtn.textContent = 'Exporting…';
  const wasPaused = els.baseVideo.paused;
  pauseMedia();
  await seekMedia(els.baseVideo, 0);
  if (replacementSource === els.replacementVideo) await seekMedia(els.replacementVideo, 0);
  tracker?.reset();
  currentCorners = null;

  const fps = guessFrameRate();
  const canvasStream = els.renderCanvas.captureStream(fps);
  const outputStream = new MediaStream(canvasStream.getVideoTracks());
  let sourceStream = null;
  try {
    const capture = els.baseVideo.captureStream || els.baseVideo.mozCaptureStream;
    if (capture) {
      sourceStream = capture.call(els.baseVideo);
      sourceStream.getAudioTracks().forEach((track) => outputStream.addTrack(track));
    }
  } catch {}

  const mimeType = bestRecordingMime();
  const recorder = new MediaRecorder(outputStream, mimeType ? { mimeType, videoBitsPerSecond: 12_000_000 } : { videoBitsPerSecond: 12_000_000 });
  const chunks = [];
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };

  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
  recorder.start(500);
  await playMedia();
  await new Promise((resolve) => els.baseVideo.addEventListener('ended', resolve, { once: true }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  recorder.stop();
  await stopped;

  const type = recorder.mimeType || mimeType || 'video/webm';
  const blob = new Blob(chunks, { type });
  const extension = type.includes('mp4') ? 'mp4' : 'webm';
  downloadBlob(blob, `screenforge-${Date.now()}.${extension}`);

  canvasStream.getTracks().forEach((track) => track.stop());
  sourceStream?.getTracks().forEach((track) => track.stop());
  exporting = false;
  els.exportBtn.disabled = false;
  els.exportBtn.textContent = 'Export locally';
  if (!wasPaused) await playMedia();
}

function bestRecordingMime() {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function guessFrameRate() {
  // Browser APIs do not expose reliable source FPS metadata. 30 is a safe V1 default.
  return 30;
}

function seekMedia(media, time) {
  return new Promise((resolve) => {
    if (!media.duration || Math.abs(media.currentTime - time) < 0.002) {
      media.currentTime = time;
      resolve();
      return;
    }
    media.addEventListener('seeked', resolve, { once: true });
    media.currentTime = time;
  });
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function updateControlLabels() {
  els.overscanValue.value = `${Number(els.overscan.value).toFixed(1)}%`;
  els.greenMinValue.value = Number(els.greenMin.value).toFixed(2);
  els.dominanceValue.value = `${Number(els.dominance.value).toFixed(2)}×`;
}

function updateTimeline() {
  const duration = Number.isFinite(els.baseVideo.duration) ? els.baseVideo.duration : 0;
  const current = els.baseVideo.currentTime || 0;
  els.timeline.value = duration ? current / duration : 0;
  els.timeLabel.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '00:00';
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(i ? 1 : 0)} ${units[i]}`;
}
