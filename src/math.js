export function sortCorners(points) {
  if (!points || points.length !== 4) return points;
  const bySum = [...points].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const tl = bySum[0];
  const br = bySum[3];
  const remaining = bySum.slice(1, 3).sort((a, b) => (b.x - b.y) - (a.x - a.y));
  const tr = remaining[0];
  const bl = remaining[1];
  return [tl, tr, br, bl];
}

export function quadArea(points) {
  if (!points || points.length !== 4) return 0;
  let area = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) * 0.5;
}

export function lerpCorners(a, b, t) {
  if (!a) return b?.map((p) => ({ ...p })) ?? null;
  if (!b) return a?.map((p) => ({ ...p })) ?? null;
  return a.map((p, i) => ({
    x: p.x + (b[i].x - p.x) * t,
    y: p.y + (b[i].y - p.y) * t,
  }));
}

export function homographyFrom4(src, dst) {
  if (!src || !dst || src.length !== 4 || dst.length !== 4) return null;
  const A = [];
  const B = [];

  for (let i = 0; i < 4; i += 1) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    B.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    B.push(v);
  }

  const h = solveLinearSystem(A, B);
  return h ? [...h, 1] : null;
}

function solveLinearSystem(A, B) {
  const n = B.length;
  const M = A.map((row, i) => [...row, B[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    }
    if (Math.abs(M[pivot][col]) < 1e-10) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];

    const div = M[col][col];
    for (let j = col; j <= n; j += 1) M[col][j] /= div;

    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = M[row][col];
      for (let j = col; j <= n; j += 1) M[row][j] -= factor * M[col][j];
    }
  }

  return M.map((row) => row[n]);
}

export function rowMajorToGLMat3(h) {
  return new Float32Array([
    h[0], h[3], h[6],
    h[1], h[4], h[7],
    h[2], h[5], h[8],
  ]);
}
