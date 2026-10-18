// Analyzer module — the only file that knows how scoring works.
//
// Public API (swap this file to change the analysis backend):
//   preloadEngine(engine)            -> Promise<void>
//   analyzePhoto(canvas, { engine }) -> Promise<AnalysisResult>
//   AnalysisError                    -> thrown with a user-facing `code` + message
//
// Engines:
//   "face-api" (default) — real on-device face detection + 68 landmarks +
//                          expression via @vladmandic/face-api (TensorFlow.js),
//                          then heuristic image measurements per region.
//   "demo"               — placeholder scoring with no face detection, for
//                          offline demos. Results are clearly marked in the UI.
//
// Everything runs in the browser. The photo is never uploaded.

const FACE_API_VERSION = '1.7.13';
const FACE_API_URL = `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@${FACE_API_VERSION}/dist/face-api.esm.js`;
const MODEL_URL = `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@${FACE_API_VERSION}/model/`;

export const DIMENSIONS = [
  { id: 'skin', label: 'Skin', weight: 0.25 },
  { id: 'symmetry', label: 'Symmetry', weight: 0.15 },
  { id: 'grooming', label: 'Grooming', weight: 0.2 },
  { id: 'hair', label: 'Hair', weight: 0.15 },
  { id: 'presentation', label: 'Presentation', weight: 0.25 },
];

export class AnalysisError extends Error {
  constructor(code, title, message) {
    super(message);
    this.code = code;
    this.title = title;
  }
}

// ---------------------------------------------------------------------------
// Engine loading

let faceapi = null;
let loadPromise = null;

export function preloadEngine(engine = 'face-api') {
  if (engine === 'demo') return Promise.resolve();
  if (!loadPromise) {
    loadPromise = (async () => {
      const mod = await import(FACE_API_URL);
      const api = mod.default?.nets ? mod.default : mod;
      await api.tf.ready();
      await Promise.all([
        api.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
        api.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        api.nets.faceExpressionNet.loadFromUri(MODEL_URL),
      ]);
      // Warm up the GPU shaders once so the first real scan is fast.
      const warm = document.createElement('canvas');
      warm.width = warm.height = 160;
      await api.detectAllFaces(warm, new api.SsdMobilenetv1Options()).withFaceLandmarks().withFaceExpressions();
      faceapi = api;
    })().catch((err) => {
      loadPromise = null; // allow retry
      console.error(err);
      throw new AnalysisError(
        'ENGINE_UNAVAILABLE',
        "Couldn't load the analysis engine",
        'The face-analysis model downloads from a CDN the first time. Check your internet connection and try again, or switch to demo mode.'
      );
    });
  }
  return loadPromise;
}

// ---------------------------------------------------------------------------
// Small math + pixel helpers

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const mean = (arr) => arr.reduce((s, v) => s + v, 0) / (arr.length || 1);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const avgPt = (pts) => ({ x: mean(pts.map((p) => p.x)), y: mean(pts.map((p) => p.y)) });
const lumOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Maps value v from [bad, good] to [0, 1] (works for either direction). */
const score01 = (v, bad, good) => clamp((v - bad) / (good - bad), 0, 1);

function imageLuminanceStats(canvas) {
  const w = 64;
  const h = Math.max(1, Math.round((canvas.height / canvas.width) * 64));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  let sum = 0;
  let hash = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = lumOf(d[i], d[i + 1], d[i + 2]);
    sum += l;
    hash = (hash * 31 + (l | 0)) >>> 0;
  }
  return { mean: sum / (w * h), hash };
}

/**
 * A face-aligned copy of the photo: eyes level, inter-ocular distance = IOD px.
 * Every measurement happens in this space so results don't depend on photo size.
 */
const NORM = { W: 360, H: 480, IOD: 100, EYE_X: 180, EYE_Y: 210 };

function buildNormalizedFace(src, landmarks) {
  const L = avgPt(landmarks.slice(36, 42));
  const R = avgPt(landmarks.slice(42, 48));
  const mid = { x: (L.x + R.x) / 2, y: (L.y + R.y) / 2 };
  const iod = dist(L, R);
  const angle = Math.atan2(R.y - L.y, R.x - L.x);
  const s = NORM.IOD / iod;
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);

  const canvas = document.createElement('canvas');
  canvas.width = NORM.W;
  canvas.height = NORM.H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.translate(NORM.EYE_X, NORM.EYE_Y);
  ctx.rotate(-angle);
  ctx.scale(s, s);
  ctx.translate(-mid.x, -mid.y);
  ctx.drawImage(src, 0, 0);

  const pts = landmarks.map((p) => {
    const dx = (p.x - mid.x) * s;
    const dy = (p.y - mid.y) * s;
    return { x: dx * cos - dy * sin + NORM.EYE_X, y: dx * sin + dy * cos + NORM.EYE_Y };
  });

  const { data } = ctx.getImageData(0, 0, NORM.W, NORM.H);
  const n = NORM.W * NORM.H;
  const gray = new Float32Array(n);
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    gray[i] = lumOf(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    alpha[i] = data[i * 4 + 3] > 200 ? 1 : 0;
  }

  // Release the canvas memory right away — we only keep numbers.
  canvas.width = canvas.height = 0;
  return { data, gray, alpha, pts, iodOriginal: iod, rollDeg: (angle * 180) / Math.PI, upscale: s };
}

function rectAround(cx, cy, w, h) {
  return { x0: Math.round(cx - w / 2), y0: Math.round(cy - h / 2), x1: Math.round(cx + w / 2), y1: Math.round(cy + h / 2) };
}

/** Color, brightness, texture and specular stats for one rectangle. */
function regionStats(face, rect) {
  const { data, gray, alpha } = face;
  const W = NORM.W;
  const x0 = clamp(rect.x0, 1, W - 2);
  const x1 = clamp(rect.x1, 1, W - 2);
  const y0 = clamp(rect.y0, 1, NORM.H - 2);
  const y1 = clamp(rect.y1, 1, NORM.H - 2);
  let n = 0, total = 0, r = 0, g = 0, b = 0, l = 0, l2 = 0, lap = 0, spec = 0, red = 0, red2 = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      total++;
      const i = y * W + x;
      if (!alpha[i]) continue;
      n++;
      const R = data[i * 4], G = data[i * 4 + 1], B = data[i * 4 + 2];
      const L = gray[i];
      r += R; g += G; b += B; l += L; l2 += L * L;
      const rd = R - (G + B) / 2;
      red += rd; red2 += rd * rd;
      lap += Math.abs(4 * L - gray[i - 1] - gray[i + 1] - gray[i - W] - gray[i + W]);
      if (L > 235 && Math.max(R, G, B) - Math.min(R, G, B) < 30) spec++;
    }
  }
  if (!n) return { visible: 0, n: 0 };
  const lm = l / n;
  const rm = red / n;
  return {
    visible: n / Math.max(1, total),
    n,
    rgb: [r / n, g / n, b / n],
    lum: lm,
    lumStd: Math.sqrt(Math.max(0, l2 / n - lm * lm)),
    texture: lap / n, // mean absolute Laplacian = fine detail / roughness
    specular: spec / n,
    redness: rm,
    rednessStd: Math.sqrt(Math.max(0, red2 / n - rm * rm)),
  };
}

function colorDist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// ---------------------------------------------------------------------------
// Dimension scorers. Each returns { score, label, findings[], notes{} }.

// Mirror pairs from the 68-point landmark scheme (left index, right index).
const MIRROR_PAIRS = [
  [0, 16], [1, 15], [2, 14], [3, 13], [4, 12], [5, 11], [6, 10], [7, 9],
  [17, 26], [18, 25], [19, 24], [20, 23], [21, 22],
  [36, 45], [37, 44], [38, 43], [39, 42], [40, 47], [41, 46],
  [31, 35], [32, 34], [48, 54], [49, 53], [50, 52], [59, 55], [58, 56], [60, 64], [61, 63], [67, 65],
];

function headPose(pts) {
  const jawMidX = (pts[0].x + pts[16].x) / 2;
  const faceW = pts[16].x - pts[0].x;
  return { yaw: (pts[30].x - jawMidX) / faceW };
}

function scoreSymmetry(face, pose) {
  const { pts } = face;
  const mids = MIRROR_PAIRS.map(([a, b]) => (pts[a].x + pts[b].x) / 2).sort((a, b) => a - b);
  const midX = mids[Math.floor(mids.length / 2)];
  const errs = MIRROR_PAIRS.map(([a, b]) => {
    const dx = Math.abs((pts[a].x + pts[b].x) / 2 - midX);
    const dy = Math.abs(pts[a].y - pts[b].y);
    return (dx + dy) / NORM.IOD;
  });
  const raw = mean(errs);
  // Turning the head creates fake asymmetry; discount part of it.
  const asym = Math.max(0, raw - Math.abs(pose.yaw) * 0.35);
  const score = clamp(98 - Math.max(0, asym - 0.02) * 420, 55, 97);

  const findings = [];
  if (score < 82) findings.push({ id: 'symmetry_balance', severity: score01(score, 82, 60) });
  return {
    score,
    label: score >= 85 ? 'Balanced' : score >= 72 ? 'Typical' : 'Asymmetric',
    findings,
    notes: { asymmetry: +raw.toFixed(3) },
  };
}

function scoreSkin(face) {
  const { pts } = face;
  const I = NORM.IOD;
  const cheekL = regionStats(face, rectAround((pts[2].x * 0.4 + pts[31].x * 0.6), (pts[41].y + pts[31].y) / 2 + 6, 0.26 * I, 0.22 * I));
  const cheekR = regionStats(face, rectAround((pts[14].x * 0.4 + pts[35].x * 0.6), (pts[46].y + pts[35].y) / 2 + 6, 0.26 * I, 0.22 * I));
  const browY = (pts[19].y + pts[24].y) / 2;
  const forehead = regionStats(face, rectAround(pts[27].x, browY - 0.28 * I, 0.6 * I, 0.18 * I));
  const nose = regionStats(face, rectAround(pts[29].x, pts[29].y, 0.14 * I, 0.22 * I));
  const underL = regionStats(face, rectAround(avgPt(pts.slice(36, 42)).x, pts[41].y + 0.15 * I, 0.22 * I, 0.08 * I));
  const underR = regionStats(face, rectAround(avgPt(pts.slice(42, 48)).x, pts[46].y + 0.15 * I, 0.22 * I, 0.08 * I));

  const cheeks = [cheekL, cheekR].filter((r) => r.n);
  if (!cheeks.length) return { score: 70, label: 'Unclear', findings: [], notes: {} };
  const skinRgb = [0, 1, 2].map((k) => mean(cheeks.map((c) => c.rgb[k])));
  const cheekLum = mean(cheeks.map((c) => c.lum));

  // Texture: fine-detail energy relative to brightness (so dark photos aren't punished).
  const texRegions = [...cheeks, forehead].filter((r) => r.n);
  const texture = mean(texRegions.map((r) => r.texture / Math.max(40, r.lum))) * 100;
  // Blotchiness: how much redness varies inside the cheeks.
  const blotch = mean(cheeks.map((c) => c.rednessStd));
  // Relative redness: cheeks vs forehead (independent of skin tone & white balance).
  const relRed = forehead.n ? mean(cheeks.map((c) => c.redness)) - forehead.redness : 0;
  // Tone evenness: forehead vs cheek brightness difference.
  const toneGap = forehead.n ? Math.abs(forehead.lum - cheekLum) / Math.max(40, cheekLum) : 0;
  // Shine: blown-out, low-saturation pixels on T-zone and cheeks.
  const shine = mean([forehead, nose, ...cheeks].filter((r) => r.n).map((r) => r.specular));
  // Under-eye darkness relative to cheeks.
  const under = [underL, underR].filter((r) => r.n);
  const underRatio = under.length ? mean(under.map((r) => r.lum)) / Math.max(1, cheekLum) : 1;

  const pTexture = score01(texture, 3.0, 9.0);
  const pBlotch = score01(blotch, 5, 14);
  const pRed = score01(relRed, 6, 20);
  const pTone = score01(toneGap, 0.08, 0.3);
  const pShine = score01(shine, 0.01, 0.08);
  const pUnder = score01(underRatio, 0.9, 0.72);

  const score = clamp(
    96 - pTexture * 18 - Math.max(pBlotch, pRed) * 12 - pTone * 8 - pShine * 8 - pUnder * 8,
    45,
    97
  );

  const findings = [];
  if (pTexture > 0.25) findings.push({ id: 'skin_texture', severity: pTexture });
  if (Math.max(pBlotch, pRed) > 0.3) findings.push({ id: 'skin_redness', severity: Math.max(pBlotch, pRed) });
  if (pTone > 0.3) findings.push({ id: 'skin_tone', severity: pTone });
  if (pShine > 0.3) findings.push({ id: 'skin_oil', severity: pShine });
  if (pUnder > 0.3) findings.push({ id: 'skin_undereye', severity: pUnder });

  return {
    score,
    label: score >= 85 ? 'Clear' : score >= 70 ? 'Balanced' : 'Needs care',
    findings,
    skinRgb,
    cheekLum,
    cheekL,
    cheekR,
    notes: { texture: +texture.toFixed(2), blotch: +blotch.toFixed(1), relRed: +relRed.toFixed(1), toneGap: +toneGap.toFixed(3), shine: +shine.toFixed(3), underRatio: +underRatio.toFixed(2) },
  };
}

function scoreGrooming(face, skin) {
  const { pts } = face;
  const I = NORM.IOD;
  const cheekLum = skin.cheekLum || 128;
  const relTex = (r) => r.texture / Math.max(40, r.lum);
  const cheekTex = mean([skin.cheekL, skin.cheekR].filter((r) => r?.n).map(relTex)) || 0.02;
  // Facial hair is darker than the cheeks *and* more textured. Requiring both
  // keeps jaw shadows on clean-shaven faces from reading as a beard.
  const darkness = (r) => {
    if (!r.n) return 0;
    const dark = clamp((cheekLum - r.lum) / Math.max(40, cheekLum), 0, 1);
    return dark * score01(relTex(r) / cheekTex, 1.15, 2.0);
  };

  // Facial-hair regions: chin and both jaw sides.
  const chin = regionStats(face, rectAround(pts[57].x, (pts[57].y + pts[8].y) / 2, (pts[54].x - pts[48].x) * 0.8, (pts[8].y - pts[57].y) * 0.6));
  const jawL = regionStats(face, rectAround((pts[5].x + pts[48].x) / 2, (pts[5].y + pts[48].y) / 2, 0.22 * I, 0.22 * I));
  const jawR = regionStats(face, rectAround((pts[11].x + pts[54].x) / 2, (pts[11].y + pts[54].y) / 2, 0.22 * I, 0.22 * I));
  const beard = { chin: darkness(chin), L: darkness(jawL), R: darkness(jawR) };
  const beardAmount = (beard.chin + beard.L + beard.R) / 3;
  const beardSideGap = Math.abs(beard.L - beard.R);

  // Brows: density (darkness vs forehead) on each side + shape difference.
  const browBox = (idx) => {
    const p = idx.map((i) => pts[i]);
    const xs = p.map((q) => q.x), ys = p.map((q) => q.y);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys) - 4, y1: Math.max(...ys) + 8 };
  };
  const browL = regionStats(face, browBox([17, 18, 19, 20, 21]));
  const browR = regionStats(face, browBox([22, 23, 24, 25, 26]));
  const browDensityGap = browL.n && browR.n ? Math.abs(browL.lum - browR.lum) / Math.max(40, cheekLum) : 0;
  const browShapeGap = mean([[17, 26], [18, 25], [19, 24], [20, 23], [21, 22]].map(([a, b]) => Math.abs(pts[a].y - pts[b].y))) / I;

  // Lips: rough texture can read as dry lips.
  const lips = regionStats(face, rectAround(pts[66].x, pts[66].y, (pts[54].x - pts[48].x) * 0.7, (pts[57].y - pts[51].y) * 0.7));
  const lipTexture = lips.n ? (lips.texture / Math.max(40, lips.lum)) * 100 : 0;

  const pPatchy = beardAmount > 0.12 ? score01(beardSideGap, 0.06, 0.25) : 0;
  const pUndefined = beardAmount > 0.18 ? score01(beardAmount, 0.18, 0.45) * 0.6 : 0; // longer beards benefit most from sharp lines
  const pBrows = Math.max(score01(browDensityGap, 0.06, 0.2), score01(browShapeGap, 0.05, 0.14));
  const pLips = score01(lipTexture, 6, 14);

  const score = clamp(94 - pPatchy * 20 - pUndefined * 8 - pBrows * 12 - pLips * 6, 55, 97);

  const findings = [];
  if (pPatchy > 0.3) findings.push({ id: 'beard_patchy', severity: pPatchy });
  else if (pUndefined > 0.25) findings.push({ id: 'beard_define', severity: pUndefined });
  if (pBrows > 0.35) findings.push({ id: 'brows_tidy', severity: pBrows });
  if (pLips > 0.4) findings.push({ id: 'lips_care', severity: pLips * 0.6 });

  return {
    score,
    label: score >= 85 ? 'Sharp' : score >= 72 ? 'Neat' : 'Could tidy',
    findings,
    notes: { beardAmount: +beardAmount.toFixed(2), beardSideGap: +beardSideGap.toFixed(2), browDensityGap: +browDensityGap.toFixed(3), browShapeGap: +browShapeGap.toFixed(3), lipTexture: +lipTexture.toFixed(1) },
  };
}

function scoreHair(face, skin) {
  const { pts, data, alpha } = face;
  const I = NORM.IOD;
  const W = NORM.W;
  const browY = Math.min(pts[19].y, pts[24].y);
  const x0 = Math.round(clamp(pts[0].x, 0, W - 1));
  const x1 = Math.round(clamp(pts[16].x, 0, W - 1));
  const yTop = Math.round(clamp(browY - 1.6 * I, 0, NORM.H - 1));
  const yBottom = Math.round(clamp(browY - 0.55 * I, 0, NORM.H - 1));

  // Background reference: the top corners of the aligned frame (when in frame).
  const corners = [rectAround(18, 18, 30, 30), rectAround(W - 18, 18, 30, 30)]
    .map((r) => regionStats(face, r))
    .filter((r) => r.n > 100);
  const skinRgb = skin.skinRgb || [180, 140, 120];

  let inFrame = 0, total = 0, hairPx = 0, notSkinPx = 0;
  const topEdge = [];
  for (let x = x0; x <= x1; x += 2) {
    let first = -1;
    for (let y = yTop; y <= yBottom; y++) {
      total++;
      const i = y * W + x;
      if (!alpha[i]) continue;
      inFrame++;
      const rgb = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
      const notSkin = colorDist(rgb, skinRgb) > 55;
      const notBg = corners.every((c) => colorDist(rgb, c.rgb) > 45);
      if (notSkin) notSkinPx++;
      if (notSkin && notBg) {
        hairPx++;
        if (first < 0) first = y;
      }
    }
    topEdge.push(first);
  }

  const visible = inFrame / Math.max(1, total);
  if (visible < 0.5) {
    return { score: 72, label: 'Not in frame', findings: [{ id: 'hair_not_visible', severity: 0.3 }], lowConfidence: true, notes: { visible: +visible.toFixed(2) } };
  }

  const coverage = hairPx / Math.max(1, inFrame);
  // Roughness of the hair outline: flyaways make a jagged top edge.
  const edge = topEdge.filter((v) => v >= 0);
  let rough = 0;
  for (let k = 2; k < edge.length; k++) rough += Math.abs(edge[k] - 2 * edge[k - 1] + edge[k - 2]);
  rough = edge.length > 4 ? rough / (edge.length - 2) / I : 0;

  // Hair that matches the background color (dark hair, dark room) can't be
  // separated reliably, so don't treat it as low coverage.
  const ambiguous = coverage < 0.4 && notSkinPx / Math.max(1, inFrame) > 0.6;
  const pFrizz = coverage > 0.25 ? score01(rough, 0.06, 0.25) : 0;
  const pShape = ambiguous ? 0 : score01(coverage, 0.4, 0.12);
  const score = clamp(93 - pFrizz * 18 - pShape * 16, 55, 96);

  const findings = [];
  if (pFrizz > 0.3) findings.push({ id: 'hair_frizz', severity: pFrizz });
  if (pShape > 0.4) findings.push({ id: 'hair_shape', severity: pShape * 0.7 });
  return {
    score,
    label: score >= 85 ? 'Styled' : score >= 72 ? 'Neat' : 'Could shape',
    findings,
    notes: { visible: +visible.toFixed(2), coverage: +coverage.toFixed(2), ambiguous, roughness: +rough.toFixed(3) },
  };
}

function scorePresentation(face, ctx) {
  const { skin, pose, expressions, box, imgW, imgH } = ctx;
  const { gray, alpha } = face;
  const W = NORM.W;

  // Lighting: exposure level and left/right balance on the cheeks.
  const lum = skin.cheekLum || 128;
  const lrBalance = skin.cheekL?.n && skin.cheekR?.n ? Math.abs(skin.cheekL.lum - skin.cheekR.lum) / Math.max(40, lum) : 0;
  const lighting = 1 - Math.max(score01(Math.abs(lum - 150), 35, 95), score01(lrBalance, 0.12, 0.45));

  // Sharpness: Laplacian variance over the central face area.
  const pts = face.pts;
  let n = 0, s = 0, s2 = 0;
  for (let y = Math.round(pts[19].y); y < Math.round(pts[57].y); y++) {
    for (let x = Math.round(pts[1].x); x < Math.round(pts[15].x); x++) {
      const i = y * W + x;
      if (x < 1 || x >= W - 1 || !alpha[i]) continue;
      const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - W] - gray[i + W];
      n++; s += v; s2 += v * v;
    }
  }
  const lapVar = n ? s2 / n - (s / n) ** 2 : 0;
  const sharp = score01(lapVar, 15, 80);

  // Pose: head roll and turn.
  const poseOk = 1 - Math.max(score01(Math.abs(face.rollDeg), 5, 18), score01(Math.abs(pose.yaw), 0.06, 0.2));

  // Expression from the model's probabilities.
  const happy = expressions?.happy ?? 0;
  const neutral = expressions?.neutral ?? 0.5;
  const negative = Math.max(expressions?.sad ?? 0, expressions?.angry ?? 0, expressions?.disgusted ?? 0, expressions?.fearful ?? 0);
  const expr = clamp(0.75 + happy * 0.25 - negative * 0.5 + (neutral > 0.6 ? 0.05 : 0), 0, 1);

  // Framing: face width share of the photo and how centered it is.
  const share = box.width / imgW;
  const centerOff = Math.hypot((box.x + box.width / 2) / imgW - 0.5, (box.y + box.height / 2) / imgH - 0.45);
  const framing = 1 - Math.max(score01(Math.abs(share - 0.45), 0.2, 0.4), score01(centerOff, 0.15, 0.35));

  const blend = lighting * 0.35 + sharp * 0.2 + poseOk * 0.15 + expr * 0.15 + framing * 0.15;
  const score = clamp(lerp(55, 97, blend), 50, 97);

  const findings = [];
  if (lighting < 0.7) findings.push({ id: 'pres_lighting', severity: 1 - lighting });
  if (sharp < 0.5) findings.push({ id: 'pres_blur', severity: 1 - sharp });
  if (poseOk < 0.7) findings.push({ id: 'pres_angle', severity: 1 - poseOk });
  if (expr < 0.75) findings.push({ id: 'pres_expression', severity: 1 - expr });
  if (framing < 0.6) findings.push({ id: 'pres_framing', severity: 1 - framing });
  if (!findings.length && score >= 85) findings.push({ id: 'presentation_maintain', severity: 0 });

  return {
    score,
    label: score >= 85 ? 'Polished' : score >= 72 ? 'Good' : 'Improvable',
    findings,
    quality: { lighting, sharp, poseOk },
    notes: { lighting: +lighting.toFixed(2), lapVar: Math.round(lapVar), roll: +face.rollDeg.toFixed(1), yaw: +pose.yaw.toFixed(2), expression: +expr.toFixed(2), framing: +framing.toFixed(2) },
  };
}

// ---------------------------------------------------------------------------
// Main entry point

export async function analyzePhoto(canvas, { engine = 'face-api' } = {}) {
  const imgStats = imageLuminanceStats(canvas);
  if (engine === 'demo') return demoAnalyze(canvas, imgStats);

  await preloadEngine(engine);

  const detections = await faceapi
    .detectAllFaces(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
    .withFaceLandmarks()
    .withFaceExpressions();

  if (!detections.length) {
    if (imgStats.mean < 40) {
      throw new AnalysisError('TOO_DARK', 'Too dark to see your face', 'The photo is very dark. Move toward a window or turn on a light, then try again.');
    }
    throw new AnalysisError('NO_FACE', 'No face detected', "We couldn't find a face. Make sure your whole face is in frame, facing the camera, without sunglasses or a mask.");
  }

  // Ignore tiny background faces; complain only about comparable ones.
  const sorted = detections.slice().sort((a, b) => b.detection.box.width - a.detection.box.width);
  const main = sorted[0];
  const others = sorted.slice(1).filter((d) => d.detection.box.width > main.detection.box.width * 0.45);
  if (others.length) {
    throw new AnalysisError('MULTIPLE_FACES', `${others.length + 1} faces detected`, 'Please use a photo with only you in it so the results are about you.');
  }

  const box = main.detection.box;
  if (box.width < 70) {
    throw new AnalysisError('FACE_TOO_SMALL', 'Face is too small', 'Move closer to the camera so your face fills more of the frame.');
  }

  const landmarks = main.landmarks.positions.map((p) => ({ x: p.x, y: p.y }));
  const face = buildNormalizedFace(canvas, landmarks);
  const pose = headPose(face.pts);

  if (Math.abs(pose.yaw) > 0.28) {
    throw new AnalysisError('FACE_TURNED', 'Face turned away', 'Look straight at the camera so both sides of your face are visible.');
  }

  const skin = scoreSkin(face);
  if (skin.cheekLum < 45) {
    throw new AnalysisError('TOO_DARK', 'Lighting is too dim', 'Your face is in shadow. Face a window or a lamp and try again for an accurate read.');
  }
  if (skin.cheekLum > 235) {
    throw new AnalysisError('TOO_BRIGHT', 'Photo is overexposed', 'Your face is washed out by bright light. Step out of direct light or turn off the flash.');
  }

  const symmetry = scoreSymmetry(face, pose);
  const grooming = scoreGrooming(face, skin);
  const hair = scoreHair(face, skin);
  const presentation = scorePresentation(face, {
    skin, pose, expressions: main.expressions, box, imgW: canvas.width, imgH: canvas.height,
  });

  const dims = { skin, symmetry, grooming, hair, presentation };
  const warnings = [];
  if (presentation.quality.lighting < 0.6) warnings.push('Lighting is uneven, so some scores may be less accurate.');
  if (presentation.quality.sharp < 0.4) warnings.push('The photo looks a bit blurry, which can hide skin detail.');
  if (presentation.quality.poseOk < 0.6) warnings.push('Your head is tilted or turned, which affects symmetry.');
  if (hair.lowConfidence) warnings.push('Hair is mostly out of frame, so its score is a neutral estimate.');

  return finalize(dims, {
    warnings,
    detectionScore: main.detection.score,
    overlay: { ...buildOverlay(landmarks), sourceWidth: canvas.width },
    engine: 'face-api',
  });
}

function finalize(dims, extra) {
  const scores = {};
  const labels = {};
  const findings = [];
  for (const { id } of DIMENSIONS) {
    scores[id] = Math.round(dims[id].score);
    labels[id] = dims[id].label;
    findings.push(...dims[id].findings);
  }
  const overall = Math.round(DIMENSIONS.reduce((s, d) => s + scores[d.id] * d.weight, 0));

  // Potential: what the changeable dimensions could reach with consistent effort.
  const reach = { skin: 0.55, grooming: 0.7, hair: 0.6, presentation: 0.75, symmetry: 0.1 };
  const potential = Math.min(97, Math.round(DIMENSIONS.reduce((s, d) => {
    const v = scores[d.id];
    return s + (v + (95 - v) * reach[d.id] * (v < 95 ? 1 : 0)) * d.weight;
  }, 0)));

  const penalties = extra.warnings.length + (extra.detectionScore < 0.6 ? 1 : 0);
  const confidence = penalties === 0 ? 'High' : penalties === 1 ? 'Medium' : 'Low';

  const debug = Object.fromEntries(DIMENSIONS.map(({ id }) => [id, dims[id].notes]));
  return {
    overall,
    potential: Math.max(potential, overall),
    confidence,
    scores,
    labels,
    findings: findings.map((f) => ({ id: f.id, severity: +clamp(f.severity, 0, 1).toFixed(2) })),
    warnings: extra.warnings,
    overlay: extra.overlay,
    engine: extra.engine,
    debug,
    analyzedAt: new Date().toISOString(),
  };
}

/** A few landmark points + the face midline for the results photo overlay. */
function buildOverlay(lm) {
  const eyeL = avgPt(lm.slice(36, 42));
  const eyeR = avgPt(lm.slice(42, 48));
  return {
    points: [eyeL, eyeR, lm[30], lm[31], lm[35], lm[48], lm[54], lm[51], lm[57], lm[3], lm[13], lm[8], lm[19], lm[24], lm[27]],
    midline: [lm[27], lm[8]],
    outline: lm.slice(0, 17),
  };
}

// ---------------------------------------------------------------------------
// Demo engine: placeholder scores, no face detection. Deterministic per photo.

function demoAnalyze(canvas, imgStats) {
  if (imgStats.mean < 35) {
    throw new AnalysisError('TOO_DARK', 'Too dark', 'The photo is very dark. Try again with more light.');
  }
  let seed = imgStats.hash || 1;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const pick = (lo, hi) => Math.round(lo + rand() * (hi - lo));
  const dims = {
    skin: { score: pick(58, 90), label: 'Balanced', findings: [{ id: 'skin_texture', severity: rand() }] },
    symmetry: { score: pick(72, 92), label: 'Typical', findings: [] },
    grooming: { score: pick(62, 90), label: 'Neat', findings: [{ id: 'brows_tidy', severity: rand() * 0.6 }] },
    hair: { score: pick(62, 90), label: 'Neat', findings: [{ id: 'hair_shape', severity: rand() * 0.6 }] },
    presentation: { score: pick(65, 92), label: 'Good', findings: [{ id: 'pres_lighting', severity: rand() * 0.5 }] },
  };
  const w = canvas.width, h = canvas.height;
  const cx = w / 2, cy = h * 0.45, fw = Math.min(w, h) * 0.18;
  const P = (dx, dy) => ({ x: cx + dx * fw, y: cy + dy * fw });
  return finalize(dims, {
    warnings: ['Demo mode: these scores are placeholders and are not based on your face.'],
    detectionScore: 0,
    overlay: { points: [P(-0.6, -0.3), P(0.6, -0.3), P(0, 0.35), P(-0.45, 0.85), P(0.45, 0.85)], midline: [P(0, -0.8), P(0, 1.6)], outline: [], sourceWidth: w },
    engine: 'demo',
  });
}
