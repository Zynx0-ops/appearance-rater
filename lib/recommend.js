// Turns analyzer output (dimension scores + findings) into a prioritized list
// of focus areas, each with steps and matching products.
//
// Content lives in data/suggestions.json and data/products.json so it can be
// edited without touching code.

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DIMENSIONS = ['skin', 'symmetry', 'grooming', 'hair', 'presentation'];
const MAX_FOCUS_AREAS = 5;
const MAX_PRODUCTS_PER_AREA = 3;

// How much a dimension can realistically change with effort. Symmetry is mostly
// structural, so it's de-prioritized compared with skin or grooming.
const IMPROVABILITY = { skin: 1, grooming: 1, hair: 1, presentation: 0.9, symmetry: 0.3 };

const MAINTAIN_TAG = {
  skin: 'skin_maintain',
  grooming: 'grooming_maintain',
  hair: 'hair_maintain',
  presentation: 'presentation_maintain',
  symmetry: 'symmetry_balance',
};

function readJson(file) {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  delete raw._comment;
  return raw;
}

// Re-read on every call so edits to the JSON files show up without a restart.
function loadCatalog() {
  return { suggestions: readJson('suggestions.json'), products: readJson('products.json') };
}

function clampScore(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
}

function validateInput(body, suggestions) {
  if (!body || typeof body !== 'object') throw Object.assign(new Error('Expected a JSON object'), { status: 400 });

  const scores = {};
  for (const dim of DIMENSIONS) {
    const v = clampScore(body.scores?.[dim]);
    if (v === null) throw Object.assign(new Error(`Missing score for "${dim}"`), { status: 400 });
    scores[dim] = v;
  }

  const findings = [];
  for (const f of Array.isArray(body.findings) ? body.findings.slice(0, 30) : []) {
    const id = typeof f === 'string' ? f : f?.id;
    if (typeof id !== 'string' || !suggestions[id]) continue; // ignore unknown ids
    const severity = Math.max(0, Math.min(1, Number(f?.severity ?? 0.5) || 0));
    findings.push({ id, severity });
  }
  return { scores, findings };
}

function buildRecommendations(body) {
  const { suggestions, products } = loadCatalog();
  const { scores, findings } = validateInput(body, suggestions);

  const seen = new Set();
  const ranked = [];

  for (const { id, severity } of findings) {
    if (seen.has(id)) continue;
    seen.add(id);
    const s = suggestions[id];
    const gap = 100 - scores[s.dimension];
    // Priority blends how far the dimension is from 100, how strong the
    // finding was, and how changeable that dimension is.
    const priority = (gap * 0.6 + severity * 40) * (IMPROVABILITY[s.dimension] ?? 1);
    ranked.push({ id, priority, severity });
  }

  // Fill with "maintain" tips for the lowest dimensions that have no finding,
  // so there are always a few useful suggestions.
  const covered = new Set(ranked.map((r) => suggestions[r.id].dimension));
  const byScore = [...DIMENSIONS].sort((a, b) => scores[a] - scores[b]);
  for (const dim of byScore) {
    if (ranked.length >= 3) break;
    if (covered.has(dim) || seen.has(MAINTAIN_TAG[dim])) continue;
    ranked.push({ id: MAINTAIN_TAG[dim], priority: (100 - scores[dim]) * 0.2, severity: 0 });
    seen.add(MAINTAIN_TAG[dim]);
  }

  ranked.sort((a, b) => b.priority - a.priority);

  const usedProducts = new Set();
  const focusAreas = ranked.slice(0, MAX_FOCUS_AREAS).map((r, i) => {
    const s = suggestions[r.id];
    const picks = [];
    for (const category of s.products || []) {
      for (const p of products[category] || []) {
        const key = `${p.brand}|${p.name}`;
        if (usedProducts.has(key)) continue;
        usedProducts.add(key);
        picks.push({ ...p, category });
        break; // one product per category keeps the list varied
      }
      if (picks.length >= MAX_PRODUCTS_PER_AREA) break;
    }
    return {
      rank: i + 1,
      id: r.id,
      dimension: s.dimension,
      score: Math.round(scores[s.dimension]),
      title: s.title,
      summary: s.summary,
      steps: s.steps,
      products: picks,
    };
  });

  return { focusAreas };
}

module.exports = { buildRecommendations, loadCatalog, DIMENSIONS };
