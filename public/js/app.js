// UI controller: capture/upload, run the analyzer, render the report.
// All scoring logic lives in analyzer.js; all advice content comes from the server.

import { analyzePhoto, preloadEngine, AnalysisError, DIMENSIONS } from './analyzer.js';

const $ = (sel) => document.querySelector(sel);
const ENGINE = new URLSearchParams(location.search).get('engine') === 'demo' ? 'demo' : 'face-api';
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_SIDE = 1024; // analysis resolution
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const ACCEPTED_EXT = /\.(jpe?g|png|webp|heic|heif)$/i;

const state = {
  result: null,
  recs: null,
  photo: null, // small display copy of the photo, memory only
  showPoints: true,
  showMidline: true,
  stream: null,
  facing: 'user',
};

// ---------------------------------------------------------------------------
// Navigation

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelector(`#view-${name}`).scrollTop = 0;
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.tab)));
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-goto]');
  if (go) showView(go.dataset.goto);
});

function setFilled(filled) {
  document.querySelectorAll('[data-empty]').forEach((el) => el.classList.toggle('hidden', filled));
  document.querySelectorAll('[data-filled]').forEach((el) => el.classList.toggle('hidden', !filled));
}

// ---------------------------------------------------------------------------
// Feedback: error sheet + toast

const ERROR_ICONS = {
  NO_FACE: '🙂', MULTIPLE_FACES: '👥', TOO_DARK: '🌙', TOO_BRIGHT: '☀️', FACE_TOO_SMALL: '🔍',
  FACE_TURNED: '↩️', UNSUPPORTED_TYPE: '🖼️', FILE_TOO_LARGE: '📦', CAMERA_DENIED: '📷', ENGINE_UNAVAILABLE: '📡',
};

function showError(err) {
  const isKnown = err instanceof AnalysisError;
  if (!isKnown) console.error(err);
  $('#sheet-ic').textContent = ERROR_ICONS[err.code] || '⚠️';
  $('#sheet-title').textContent = isKnown ? err.title : 'Something went wrong';
  $('#sheet-msg').textContent = isKnown ? err.message : "We couldn't analyze that photo. Please try another one.";

  const alt = $('#sheet-alt');
  alt.classList.add('hidden');
  alt.onclick = null;
  if (err.code === 'ENGINE_UNAVAILABLE') {
    alt.textContent = 'Use demo mode instead';
    alt.classList.remove('hidden');
    alt.onclick = () => (location.search = '?engine=demo');
  } else if (err.code === 'CAMERA_DENIED') {
    alt.textContent = 'Upload a photo instead';
    alt.classList.remove('hidden');
    alt.onclick = () => { hideSheet(); $('#file-input').click(); };
  }
  $('#sheet').classList.remove('hidden');
  $('#sheet-retry').focus();
}
function hideSheet() { $('#sheet').classList.add('hidden'); }
$('#sheet-retry').addEventListener('click', hideSheet);
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') hideSheet(); });

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

// ---------------------------------------------------------------------------
// Engine status

function setEngineStatus(kind, text) {
  const pill = $('#engine-pill');
  pill.className = `engine-pill ${kind}`;
  pill.querySelector('.txt').textContent = text;
}

if (ENGINE === 'demo') {
  setEngineStatus('demo', 'Demo mode');
} else {
  preloadEngine(ENGINE)
    .then(() => setEngineStatus('ready', 'On-device AI ready'))
    .catch(() => setEngineStatus('error', 'Model offline'));
}

const hour = new Date().getHours();
$('#greeting').textContent = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

// ---------------------------------------------------------------------------
// Input: upload

$('#btn-upload').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', onFilePicked);
$('#camera-input').addEventListener('change', onFilePicked);

async function onFilePicked(e) {
  const input = e.target;
  const file = input.files?.[0];
  input.value = ''; // drop the reference so the same file can be re-picked
  if (!file) return;
  try {
    const canvas = await fileToCanvas(file);
    await runAnalysis(canvas);
  } catch (err) {
    showError(err);
  }
}

async function fileToCanvas(file) {
  const typeOk = ACCEPTED_TYPES.includes(file.type) || (!file.type && ACCEPTED_EXT.test(file.name));
  if (!typeOk) {
    throw new AnalysisError('UNSUPPORTED_TYPE', 'Unsupported file type', `"${file.name}" isn't a supported image. Please use a JPEG, PNG or WebP photo.`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new AnalysisError('FILE_TOO_LARGE', 'Photo is too large', 'Please choose a photo under 15 MB.');
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const heic = /heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
    throw new AnalysisError(
      'UNSUPPORTED_TYPE',
      heic ? "HEIC photos aren't supported here" : "Couldn't read that image",
      heic
        ? 'This browser can\'t open HEIC files. Export the photo as JPEG, or set your camera to "Most Compatible" in Settings → Camera → Formats.'
        : 'The file may be damaged or in an unusual format. Please try a JPEG or PNG.'
    );
  }
  const canvas = drawScaled(bitmap, bitmap.width, bitmap.height, MAX_SIDE);
  bitmap.close?.();
  return canvas;
}

function drawScaled(source, w, h, maxSide, mirror = false) {
  const s = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * s);
  canvas.height = Math.round(h * s);
  const ctx = canvas.getContext('2d');
  if (mirror) {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// ---------------------------------------------------------------------------
// Input: live camera

$('#btn-camera').addEventListener('click', openCamera);
$('#cam-close').addEventListener('click', closeCamera);
$('#cam-flip').addEventListener('click', () => {
  state.facing = state.facing === 'user' ? 'environment' : 'user';
  startStream().catch(showError);
});
$('#cam-shutter').addEventListener('click', async () => {
  const video = $('#video');
  if (!video.videoWidth) return;
  // Save as the user saw it in the preview (mirrored for the front camera).
  const canvas = drawScaled(video, video.videoWidth, video.videoHeight, MAX_SIDE, state.facing === 'user');
  closeCamera();
  try {
    await runAnalysis(canvas);
  } catch (err) {
    showError(err);
  }
});

async function openCamera() {
  // getUserMedia needs a secure context (https or localhost). Otherwise, fall
  // back to the native camera picker, which works everywhere on mobile.
  if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
    $('#camera-input').click();
    return;
  }
  $('#camera').classList.remove('hidden');
  try {
    await startStream();
  } catch (err) {
    closeCamera();
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
      showError(new AnalysisError('CAMERA_DENIED', 'Camera access was blocked', 'Allow camera access in your browser settings, or upload a photo instead.'));
    } else if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
      showError(new AnalysisError('CAMERA_DENIED', 'No camera found', "We couldn't find a camera on this device. You can upload a photo instead."));
    } else {
      showError(err);
    }
  }
}

async function startStream() {
  stopStream();
  state.stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: state.facing, width: { ideal: 1280 }, height: { ideal: 1280 } },
    audio: false,
  });
  $('#video').srcObject = state.stream;
  $('#camera').classList.toggle('rear', state.facing !== 'user');
}

function stopStream() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
}

function closeCamera() {
  stopStream();
  $('#video').srcObject = null;
  $('#camera').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Analysis flow

const STEPS = ['Detecting face…', 'Mapping landmarks…', 'Reading skin & lighting…', 'Checking symmetry…', 'Building your plan…'];

async function runAnalysis(canvas) {
  const overlay = $('#analyzing');
  const preview = $('#scan-preview');
  preview.width = canvas.width;
  preview.height = canvas.height;
  preview.getContext('2d').drawImage(canvas, 0, 0);
  overlay.classList.remove('hidden');

  let step = 0;
  const setStep = () => {
    $('#scan-step').textContent = STEPS[Math.min(step, STEPS.length - 1)];
    $('#scan-bar').style.width = `${Math.min(95, ((step + 1) / STEPS.length) * 100)}%`;
  };
  setStep();
  const ticker = setInterval(() => { step++; setStep(); }, 650);
  const minTime = new Promise((r) => setTimeout(r, 2200)); // let the animation breathe

  try {
    const result = await analyzePhoto(canvas, { engine: ENGINE });
    let recs = null;
    try {
      const res = await fetch('/api/recommendations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scores: result.scores, findings: result.findings }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      recs = await res.json();
    } catch (e) {
      console.warn('Recommendations unavailable', e);
      toast("Couldn't load tips from the server — scores are still shown.");
    }
    await minTime;
    $('#scan-bar').style.width = '100%';

    // Keep only a small display copy of the photo, in memory for this tab.
    state.photo = drawScaled(canvas, canvas.width, canvas.height, 720);
    state.result = result;
    state.recs = recs;
    console.info('[analysis]', result.debug);
    renderAll();
    showView('report');
  } finally {
    clearInterval(ticker);
    overlay.classList.add('hidden');
    preview.width = preview.height = 0;
    canvas.width = canvas.height = 0; // release the full-size pixels
  }
}

$('#btn-clear').addEventListener('click', () => {
  state.result = state.recs = state.photo = null;
  setFilled(false);
  $('#latest-card').classList.add('hidden');
  showView('analyze');
  toast('Photo and results deleted');
});

// ---------------------------------------------------------------------------
// Rendering

function tierOf(score) {
  if (score >= 80) return { name: 'Strong', short: 'Strong', color: 'var(--green)' };
  if (score >= 68) return { name: 'Good', short: 'Good', color: 'var(--yellow)' };
  if (score >= 55) return { name: 'Developing', short: 'Focus', color: 'var(--orange)' };
  return { name: 'Room to grow', short: 'Focus', color: 'var(--red)' };
}

const ICONS = {
  skin: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  symmetry: '<path d="M12 3v18M8 7H5v10h3M16 7h3v10h-3"/>',
  grooming: '<circle cx="6" cy="7" r="2.5"/><circle cx="6" cy="17" r="2.5"/><path d="M8 8.5 20 17M8 15.5 20 7"/>',
  hair: '<path d="M4 14c0-6 4-10 8-10s8 4 8 10M7 14c0-4 2-7 5-7s5 3 5 7M10 11c1-1 3-1 4 0"/>',
  presentation: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderAll() {
  setFilled(true);
  renderReport();
  renderImprove();
  renderProducts();
  renderLatest();
}

function renderReport() {
  const r = state.result;
  $('#report-date').textContent = new Date(r.analyzedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  $('#demo-badge').classList.toggle('hidden', r.engine !== 'demo');
  drawPhoto();

  const t = tierOf(r.overall);
  const overallCard = document.querySelector('.overall');
  overallCard.style.setProperty('--tier', t.color);
  $('#overall-ring').innerHTML = ringSvg(r.overall, 'Overall');
  $('#overall-tier').textContent = t.name;
  $('#overall-potential').innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M7 17 17 7M9 7h8v8"/></svg> Potential: ${r.potential}`;
  $('#overall-confidence').textContent = `Confidence: ${r.confidence} · approximate`;
  requestAnimationFrame(() => {
    const val = overallCard.querySelector('.ring-val');
    if (val) val.style.strokeDashoffset = val.dataset.target;
  });

  const warn = $('#warnings');
  warn.innerHTML = r.warnings.map((w) => `<div>⚠️ ${esc(w)}</div>`).join('');
  warn.classList.toggle('hidden', !r.warnings.length);

  // Fastest gain: biggest realistic improvement among changeable dimensions.
  const top = state.recs?.focusAreas?.[0];
  $('#fastest-gain').innerHTML = top
    ? `Your fastest gains likely come from <b>${esc(DIMENSIONS.find((d) => d.id === top.dimension).label.toLowerCase())}</b>: ${esc(top.title.toLowerCase())}. Small, consistent changes here could move your score toward <b>${r.potential}</b>.`
    : `Nice work — keep your routine consistent and re-check in a few weeks.`;

  $('#breakdown').innerHTML = DIMENSIONS.map(({ id, label }) => {
    const s = r.scores[id];
    const tt = tierOf(s);
    return `
      <div class="score-card" style="--tier:${tt.color}">
        <div class="score-top">
          <span class="score-ic"><svg viewBox="0 0 24 24">${ICONS[id]}</svg></span>
          <div class="score-num"><b>${s}</b><span class="chip">${tt.short}</span></div>
        </div>
        <span class="score-name">${label}</span>
        <span class="score-sub">${esc(r.labels[id])}</span>
        <div class="bar"><i data-w="${s}"></i></div>
      </div>`;
  }).join('');
  requestAnimationFrame(() => document.querySelectorAll('#breakdown .bar i').forEach((i) => (i.style.width = `${i.dataset.w}%`)));
}

function ringSvg(value, label) {
  const R = 52;
  const C = 2 * Math.PI * R;
  const target = C * (1 - value / 100);
  return `
    <svg viewBox="0 0 128 128">
      <circle class="ring-track" cx="64" cy="64" r="${R}" fill="none" stroke-width="11"/>
      <circle class="ring-val" cx="64" cy="64" r="${R}" fill="none" stroke-width="11"
        stroke-dasharray="${C}" stroke-dashoffset="${C}" data-target="${target}"/>
    </svg>
    <div class="ring-label"><b>${value}</b><span>${label}</span></div>`;
}

function drawPhoto() {
  const canvas = $('#report-photo');
  const photo = state.photo;
  if (!photo) return;
  const scale = photo.width / (state.result.overlay.sourceWidth || photo.width);
  canvas.width = photo.width;
  canvas.height = photo.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(photo, 0, 0);

  const ov = state.result.overlay;
  const k = canvas.width / 360;
  if (state.showMidline && ov.midline) {
    const [a, b] = ov.midline.map((p) => ({ x: p.x * scale, y: p.y * scale }));
    const dx = b.x - a.x, dy = b.y - a.y;
    ctx.save();
    ctx.strokeStyle = 'rgba(160, 150, 255, .85)';
    ctx.lineWidth = 1.5 * k;
    ctx.setLineDash([6 * k, 6 * k]);
    ctx.beginPath();
    ctx.moveTo(a.x - dx * 0.6, a.y - dy * 0.6);
    ctx.lineTo(b.x + dx * 0.15, b.y + dy * 0.15);
    ctx.stroke();
    ctx.restore();
  }
  if (state.showPoints) {
    for (const p of ov.points) {
      ctx.beginPath();
      ctx.arc(p.x * scale, p.y * scale, 4.5 * k, 0, Math.PI * 2);
      ctx.fillStyle = '#2ee59d';
      ctx.shadowColor = 'rgba(46, 229, 157, .8)';
      ctx.shadowBlur = 8 * k;
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }
}

function toggle(btn, key) {
  state[key] = !state[key];
  btn.classList.toggle('active', state[key]);
  btn.setAttribute('aria-pressed', String(state[key]));
  drawPhoto();
}
$('#tgl-points').addEventListener('click', (e) => toggle(e.currentTarget, 'showPoints'));
$('#tgl-midline').addEventListener('click', (e) => toggle(e.currentTarget, 'showMidline'));

function productCard(p) {
  const q = encodeURIComponent(`${p.brand === 'Haircut idea' ? '' : p.brand + ' '}${p.name}`.trim());
  const isCut = p.category === 'haircut_styles';
  const href = isCut ? `https://www.google.com/search?tbm=isch&q=${q}+haircut` : `https://www.google.com/search?q=${q}`;
  return `
    <div class="product">
      <div class="product-top"><span class="product-brand">${esc(p.brand)}</span><span class="price">${esc(p.price)}</span></div>
      <div class="product-name">${esc(p.name)}</div>
      <div class="product-why">${esc(p.reason)}</div>
      <a href="${href}" target="_blank" rel="noopener noreferrer">${isCut ? 'See examples' : 'Find it'} →</a>
    </div>`;
}

function renderImprove() {
  const areas = state.recs?.focusAreas || [];
  if (!areas.length) {
    $('#focus-list').innerHTML = '<p class="muted">Tips are unavailable right now. Make sure the server is running and try again.</p>';
    return;
  }
  $('#focus-list').innerHTML = areas.map((a, i) => {
    const t = tierOf(a.score);
    const dim = DIMENSIONS.find((d) => d.id === a.dimension).label;
    return `
      <details class="focus" style="--tier:${t.color}" ${i === 0 ? 'open' : ''}>
        <summary>
          <span class="rank">${a.rank}</span>
          <div class="focus-head"><b>${esc(a.title)}</b><span>#${a.rank} Priority · ${dim}</span></div>
          <span class="score-badge">${a.score}/100</span>
          <svg class="chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </summary>
        <div class="focus-body">
          <p>${esc(a.summary)}</p>
          <ol class="steps">${a.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
          ${a.products.length ? `<div class="mini-products">${a.products.map(productCard).join('')}</div>` : ''}
        </div>
      </details>`;
  }).join('');
}

function renderProducts() {
  const areas = (state.recs?.focusAreas || []).filter((a) => a.products.length);
  $('#product-groups').innerHTML = areas.length
    ? areas.map((a) => `
        <div class="product-group">
          <h3>${esc(a.title)} <span class="cat-tag">· ${DIMENSIONS.find((d) => d.id === a.dimension).label}</span></h3>
          ${a.products.map(productCard).join('')}
        </div>`).join('')
    : '<p class="muted">No product suggestions for this scan — your top tips are habit or photo changes. Check the Improve tab.</p>';
}

function renderLatest() {
  const r = state.result;
  $('#latest-card').classList.remove('hidden');
  $('#latest-score').textContent = r.overall;
  $('#latest-score').style.color = tierOf(r.overall).color;
  $('#latest-potential').textContent = `↗ Potential: ${r.potential}`;
  const thumb = $('#latest-thumb');
  thumb.width = 168;
  thumb.height = 208;
  const ctx = thumb.getContext('2d');
  const p = state.photo;
  const s = Math.max(thumb.width / p.width, thumb.height / p.height);
  ctx.drawImage(p, (thumb.width - p.width * s) / 2, (thumb.height - p.height * s) / 2, p.width * s, p.height * s);
}
