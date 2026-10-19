import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { buildRecommendations } from '../public/js/recommend.js';

const read = (f) => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url), 'utf8'));
const catalog = { suggestions: read('suggestions.json'), products: read('products.json') };
const scores = { skin: 62, symmetry: 84, grooming: 70, hair: 75, presentation: 80 };

test('ranks findings and attaches products', () => {
  const { focusAreas } = buildRecommendations({
    scores,
    findings: [{ id: 'skin_texture', severity: 0.8 }, { id: 'pres_angle', severity: 0.3 }],
  }, catalog);
  assert.equal(focusAreas[0].id, 'skin_texture');
  assert.ok(focusAreas[0].products.length > 0);
  assert.ok(focusAreas.length >= 3, 'fills up with maintenance tips');
});

test('ignores unknown findings and rejects missing scores', () => {
  const { focusAreas } = buildRecommendations({ scores, findings: ['nope', '_comment', 'skin_oil'] }, catalog);
  assert.ok(!focusAreas.some((f) => f.id === 'nope' || f.id === '_comment'));
  assert.throws(() => buildRecommendations({ scores: { skin: 50 } }, catalog), /Missing score/);
});

test('every suggestion references existing product categories', () => {
  for (const [id, s] of Object.entries(catalog.suggestions)) {
    if (id.startsWith('_')) continue;
    for (const c of s.products) assert.ok(catalog.products[c], `${id} -> ${c}`);
  }
});
