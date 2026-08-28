import { lerpCorners, quadArea, sortCorners } from './math.js';

export class ScreenTracker {
  constructor(cv, { analysisWidth = 480, redetectEvery = 8 } = {}) {
    this.cv = cv;
    this.analysisWidth = analysisWidth;
    this.redetectEvery = redetectEvery;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prevGray = null;
    this.prevCorners = null;
    this.smoothedCorners = null;
    this.frameIndex = 0;
    this.forceDetect = true;
    this.lastVideoTime = -1;
    this.lastConfidence = 0;
  }

  reset() {
    this.prevGray?.delete();
    this.prevGray = null;
    this.prevCorners = null;
    this.smoothedCorners = null;
    this.frameIndex = 0;
    this.forceDetect = true;
    this.lastVideoTime = -1;
    this.lastConfidence = 0;
  }

  requestDetection() {
    this.forceDetect = true;
  }

  setOutputCorners(corners, video) {
    if (!corners || !video?.videoWidth) return;
    const sx = this.canvas.width / video.videoWidth;
    const sy = this.canvas.height / video.videoHeight;
    this.prevCorners = corners.map((p) => ({ x: p.x * sx, y: p.y * sy }));
    this.smoothedCorners = corners.map((p) => ({ ...p }));
  }

  process(video, { hMin = 32, hMax = 96, sMin = 45, vMin = 45 } = {}) {
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return this.result();
    if (Math.abs(video.currentTime - this.lastVideoTime) < 0.001 && this.smoothedCorners) return this.result();
    this.lastVideoTime = video.currentTime;

    const width = Math.min(this.analysisWidth, video.videoWidth);
    const height = Math.max(2, Math.round(video.videoHeight * (width / video.videoWidth)));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.reset();
    }

    this.ctx.drawImage(video, 0, 0, width, height);
    const rgba = this.cv.imread(this.canvas);
    const gray = new this.cv.Mat();
    this.cv.cvtColor(rgba, gray, this.cv.COLOR_RGBA2GRAY);

    const mustDetect = this.forceDetect || !this.prevGray || !this.prevCorners || this.frameIndex % this.redetectEvery === 0;
    let nextCorners = null;
    let confidence = 0;
    let mode = 'detect';

    if (!mustDetect) {
      const tracked = this.trackWithOpticalFlow(this.prevGray, gray, this.prevCorners);
      if (tracked?.corners) {
        nextCorners = tracked.corners;
        confidence = tracked.confidence;
        mode = 'optical-flow';
      }
    }

    if (!nextCorners || mustDetect || confidence < 0.45) {
      const detected = this.detectGreenQuad(rgba, { hMin, hMax, sMin, vMin });
      if (detected?.corners) {
        if (nextCorners && confidence > 0.45) {
          nextCorners = lerpCorners(nextCorners, detected.corners, 0.72);
        } else {
          nextCorners = detected.corners;
        }
        confidence = Math.max(confidence, detected.confidence);
        mode = 'green-detect';
      }
    }

    if (nextCorners && this.isValidQuad(nextCorners, width, height)) {
      this.prevCorners = sortCorners(nextCorners);
      const sx = video.videoWidth / width;
      const sy = video.videoHeight / height;
      const output = this.prevCorners.map((p) => ({ x: p.x * sx, y: p.y * sy }));
      this.smoothedCorners = lerpCorners(this.smoothedCorners, output, this.smoothedCorners ? 0.52 : 1);
      this.lastConfidence = confidence;
    } else {
      this.lastConfidence *= 0.85;
    }

    this.prevGray?.delete();
    this.prevGray = gray.clone();
    rgba.delete();
    gray.delete();

    this.frameIndex += 1;
    this.forceDetect = false;
    return this.result(mode);
  }

  result(mode = 'idle') {
    return {
      corners: this.smoothedCorners?.map((p) => ({ ...p })) ?? null,
      confidence: this.lastConfidence,
      mode,
    };
  }

  detectGreenQuad(rgba, { hMin, hMax, sMin, vMin }) {
    const rgb = new this.cv.Mat();
    const hsv = new this.cv.Mat();
    const mask = new this.cv.Mat();
    const contours = new this.cv.MatVector();
    const hierarchy = new this.cv.Mat();
    const kernel = this.cv.Mat.ones(5, 5, this.cv.CV_8U);
    let bestContour = null;
    let bestArea = 0;

    try {
      this.cv.cvtColor(rgba, rgb, this.cv.COLOR_RGBA2RGB);
      this.cv.cvtColor(rgb, hsv, this.cv.COLOR_RGB2HSV);
      const low = new this.cv.Mat(hsv.rows, hsv.cols, hsv.type(), [hMin, sMin, vMin, 0]);
      const high = new this.cv.Mat(hsv.rows, hsv.cols, hsv.type(), [hMax, 255, 255, 255]);
      this.cv.inRange(hsv, low, high, mask);
      low.delete();
      high.delete();

      this.cv.morphologyEx(mask, mask, this.cv.MORPH_CLOSE, kernel);
      this.cv.morphologyEx(mask, mask, this.cv.MORPH_OPEN, kernel);
      this.cv.findContours(mask, contours, hierarchy, this.cv.RETR_EXTERNAL, this.cv.CHAIN_APPROX_SIMPLE);

      for (let i = 0; i < contours.size(); i += 1) {
        const contour = contours.get(i);
        const area = this.cv.contourArea(contour, false);
        if (area > bestArea) {
          bestContour?.delete();
          bestContour = contour.clone();
          bestArea = area;
        }
        contour.delete();
      }

      const frameArea = rgba.cols * rgba.rows;
      if (!bestContour || bestArea < frameArea * 0.006) return null;

      const perimeter = this.cv.arcLength(bestContour, true);
      const approx = new this.cv.Mat();
      this.cv.approxPolyDP(bestContour, approx, perimeter * 0.018, true);
      let points = this.pointsFromMat(approx);
      approx.delete();

      if (points.length !== 4) points = this.extremeQuad(this.pointsFromMat(bestContour));
      if (points.length !== 4) return null;

      points = sortCorners(points);
      if (!this.isValidQuad(points, rgba.cols, rgba.rows)) return null;

      const occupancy = Math.min(1, bestArea / Math.max(1, quadArea(points)));
      const sizeScore = Math.min(1, bestArea / (frameArea * 0.08));
      return { corners: points, confidence: Math.max(0.5, occupancy * 0.7 + sizeScore * 0.3) };
    } finally {
      bestContour?.delete();
      rgb.delete();
      hsv.delete();
      mask.delete();
      contours.delete();
      hierarchy.delete();
      kernel.delete();
    }
  }

  trackWithOpticalFlow(prevGray, gray, prevCorners) {
    const data = prevCorners.flatMap((p) => [p.x, p.y]);
    const prevPts = this.cv.matFromArray(4, 1, this.cv.CV_32FC2, data);
    const nextPts = new this.cv.Mat();
    const status = new this.cv.Mat();
    const error = new this.cv.Mat();
    const winSize = new this.cv.Size(25, 25);
    const criteria = new this.cv.TermCriteria(this.cv.TERM_CRITERIA_EPS | this.cv.TERM_CRITERIA_COUNT, 20, 0.03);

    try {
      this.cv.calcOpticalFlowPyrLK(prevGray, gray, prevPts, nextPts, status, error, winSize, 3, criteria);
      const corners = [];
      let good = 0;
      let totalError = 0;

      for (let i = 0; i < 4; i += 1) {
        const ok = status.data[i] === 1;
        if (ok) {
          good += 1;
          totalError += error.data32F?.[i] ?? 0;
        }
        corners.push({
          x: ok ? nextPts.data32F[i * 2] : prevCorners[i].x,
          y: ok ? nextPts.data32F[i * 2 + 1] : prevCorners[i].y,
        });
      }

      if (good < 4) return null;
      const avgError = totalError / 4;
      const confidence = Math.max(0, Math.min(1, 1 - avgError / 45));
      return { corners: sortCorners(corners), confidence };
    } catch {
      return null;
    } finally {
      prevPts.delete();
      nextPts.delete();
      status.delete();
      error.delete();
    }
  }

  pointsFromMat(mat) {
    const data = mat.data32S;
    const points = [];
    for (let i = 0; i + 1 < data.length; i += 2) points.push({ x: data[i], y: data[i + 1] });
    return points;
  }

  extremeQuad(points) {
    if (!points.length) return [];
    const minSum = points.reduce((a, b) => (a.x + a.y < b.x + b.y ? a : b));
    const maxSum = points.reduce((a, b) => (a.x + a.y > b.x + b.y ? a : b));
    const maxDiff = points.reduce((a, b) => (a.x - a.y > b.x - b.y ? a : b));
    const minDiff = points.reduce((a, b) => (a.x - a.y < b.x - b.y ? a : b));
    const result = [minSum, maxDiff, maxSum, minDiff];
    const unique = new Set(result.map((p) => `${p.x},${p.y}`));
    return unique.size === 4 ? result : [];
  }

  isValidQuad(points, width, height) {
    if (!points || points.length !== 4) return false;
    if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
    const area = quadArea(sortCorners(points));
    return area > width * height * 0.003 && area < width * height * 0.96;
  }
}
