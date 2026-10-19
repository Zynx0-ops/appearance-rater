// Turns analyzer output (dimension scores + findings) into a prioritized list
// of focus areas, each with steps and matching products.
//
// Content lives in data/suggestions.json and data/products.json so it can be
// edited without touching code. Runs in the browser; the catalog is passed in
// so this module also works under Node for tests.

export const DIMENSION_IDS = ['skin', 'symmetry', 'grooming', 'hair', 'presentation'];
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

let catalogPromise = null;

/** Loads both JSON catalogs once (relative URLs, so it works under any base path). */
export function loadCatalog() {
  if (!catalogPromise) {
    const get = (file) =>
      fetch(new URL(`../data/${file}`, import.meta.url)).then((r) => {
        if (!r.ok) throw new Error(`Failed to load ${file}: HTTP ${r.status}`);
        return r.json();
      });
    catalogPromise = Promise.all([get('suggestions.json'), get('products.json')])
      .then(([suggestions, products]) => ({ suggestions, products }))
      .catch((err) => {
        catalogPromise = null; // allow retry
        throw err;
      });
  }
  return catalogPromise;
}

function clampScore(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
}

function validateInput(input, suggestions) {
  if (!input || typeof input !== 'object') throw new Error('Expected an object');

  const scores = {};
  for (const dim of DIMENSION_IDS) {
    const v = clampScore(input.scores?.[dim]);
    if (v === null) throw new Error(`Missing score for "${dim}"`);
    scores[dim] = v;
  }

  const findings = [];
  for (const f of Array.isArray(input.findings) ? input.findings.slice(0, 30) : []) {
    const id = typeof f === 'string' ? f : f?.id;
    if (typeof id !== 'string' || id.startsWith('_') || !suggestions[id]) continue; // ignore unknown ids
    const severity = Math.max(0, Math.min(1, Number(f?.severity ?? 0.5) || 0));
    findings.push({ id, severity });
  }
  return { scores, findings };
}

export function buildRecommendations(input, catalog) {
  const { suggestions, products } = catalog;
  const { scores, findings } = validateInput(input, suggestions);

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
  const byScore = [...DIMENSION_IDS].sort((a, b) => scores[a] - scores[b]);
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
