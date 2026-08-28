import { homographyFrom4, rowMajorToGLMat3 } from './math.js';

const VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uBase;
uniform sampler2D uReplacement;
uniform mat3 uOutputToSource;
uniform float uGreenMin;
uniform float uDominance;
uniform float uHasReplacement;
uniform float uHasHomography;

void main() {
  vec4 base = texture(uBase, vUv);
  if (uHasReplacement < 0.5 || uHasHomography < 0.5) {
    outColor = base;
    return;
  }

  // Tracking coordinates use a conventional top-left origin.
  vec2 frameTopLeft = vec2(vUv.x, 1.0 - vUv.y);
  vec3 projected = uOutputToSource * vec3(frameTopLeft, 1.0);
  if (abs(projected.z) < 0.00001) {
    outColor = base;
    return;
  }

  vec2 sourceTopLeft = projected.xy / projected.z;
  bool inside = sourceTopLeft.x >= 0.0 && sourceTopLeft.x <= 1.0 &&
                sourceTopLeft.y >= 0.0 && sourceTopLeft.y <= 1.0;
  if (!inside) {
    outColor = base;
    return;
  }

  vec4 replacement = texture(uReplacement, vec2(sourceTopLeft.x, 1.0 - sourceTopLeft.y));

  // Keep black phone bezels / hands / foreground untouched. Only pixels that
  // are sufficiently green are replaced. Soft thresholds reduce green edges.
  float maxRB = max(max(base.r, base.b), 0.001);
  float dominance = base.g / maxRB;
  float greenStrength = smoothstep(uGreenMin, uGreenMin + 0.10, base.g) *
                        smoothstep(uDominance, uDominance + 0.16, dominance);
  float alpha = clamp(greenStrength * replacement.a, 0.0, 1.0);
  outColor = mix(base, replacement, alpha);
}`;

export class HomographyRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!this.gl) throw new Error('WebGL2 is not available in this browser.');

    this.program = this.createProgram(VERTEX_SHADER, FRAGMENT_SHADER);
    this.baseTexture = this.createTexture(0);
    this.replacementTexture = this.createTexture(1);
    this.locations = {
      position: this.gl.getAttribLocation(this.program, 'aPosition'),
      base: this.gl.getUniformLocation(this.program, 'uBase'),
      replacement: this.gl.getUniformLocation(this.program, 'uReplacement'),
      matrix: this.gl.getUniformLocation(this.program, 'uOutputToSource'),
      greenMin: this.gl.getUniformLocation(this.program, 'uGreenMin'),
      dominance: this.gl.getUniformLocation(this.program, 'uDominance'),
      hasReplacement: this.gl.getUniformLocation(this.program, 'uHasReplacement'),
      hasHomography: this.gl.getUniformLocation(this.program, 'uHasHomography'),
    };

    const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    const buffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.STATIC_DRAW);

    this.gl.useProgram(this.program);
    this.gl.enableVertexAttribArray(this.locations.position);
    this.gl.vertexAttribPointer(this.locations.position, 2, this.gl.FLOAT, false, 0, 0);
    this.gl.uniform1i(this.locations.base, 0);
    this.gl.uniform1i(this.locations.replacement, 1);
    this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, true);
  }

  resize(width, height) {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
  }

  render(baseVideo, replacementSource, corners, { overscan = 1.5, greenMin = 0.22, dominance = 1.18 } = {}) {
    if (!baseVideo?.videoWidth || baseVideo.readyState < 2) return;
    this.resize(baseVideo.videoWidth, baseVideo.videoHeight);

    const gl = this.gl;
    gl.useProgram(this.program);
    this.uploadTexture(this.baseTexture, 0, baseVideo);

    const replacementReady = this.isSourceReady(replacementSource);
    if (replacementReady) this.uploadTexture(this.replacementTexture, 1, replacementSource);

    let matrix = null;
    if (corners?.length === 4) {
      const destination = corners.map((p) => ({
        x: p.x / this.canvas.width,
        y: p.y / this.canvas.height,
      }));
      const margin = Math.max(0, Math.min(0.08, Number(overscan) / 200));
      const source = [
        { x: margin, y: margin },
        { x: 1 - margin, y: margin },
        { x: 1 - margin, y: 1 - margin },
        { x: margin, y: 1 - margin },
      ];
      matrix = homographyFrom4(destination, source);
    }

    gl.uniform1f(this.locations.greenMin, Number(greenMin));
    gl.uniform1f(this.locations.dominance, Number(dominance));
    gl.uniform1f(this.locations.hasReplacement, replacementReady ? 1 : 0);
    gl.uniform1f(this.locations.hasHomography, matrix ? 1 : 0);
    if (matrix) gl.uniformMatrix3fv(this.locations.matrix, false, rowMajorToGLMat3(matrix));

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  isSourceReady(source) {
    if (!source) return false;
    if (source instanceof HTMLVideoElement) return source.readyState >= 2 && source.videoWidth > 0;
    if (source instanceof HTMLImageElement) return source.complete && source.naturalWidth > 0;
    return false;
  }

  uploadTexture(texture, unit, source) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch {
      // The frame can transiently be unavailable while seeking. Keep the last texture.
    }
  }

  createTexture(unit) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return texture;
  }

  createProgram(vertexSource, fragmentSource) {
    const gl = this.gl;
    const vertex = this.compileShader(gl.VERTEX_SHADER, vertexSource);
    const fragment = this.compileShader(gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'Unable to link WebGL program.');
    }
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    return program;
  }

  compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || 'Unable to compile WebGL shader.');
    }
    return shader;
  }
}
