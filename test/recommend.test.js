const test = require('node:test');
const assert = require('node:assert');
const { buildRecommendations, loadCatalog } = require('../lib/recommend');

const scores = { skin: 62, symmetry: 84, grooming: 70, hair: 75, presentation: 80 };

test('ranks findings and attaches products', () => {
  const { focusAreas } = buildRecommendations({
    scores,
    findings: [{ id: 'skin_texture', severity: 0.8 }, { id: 'pres_angle', severity: 0.3 }],
  });
  assert.equal(focusAreas[0].id, 'skin_texture');
  assert.ok(focusAreas[0].products.length > 0);
  assert.ok(focusAreas.length >= 3, 'fills up with maintenance tips');
});

test('ignores unknown findings and rejects missing scores', () => {
  const { focusAreas } = buildRecommendations({ scores, findings: ['nope', 'skin_oil'] });
  assert.ok(!focusAreas.some((f) => f.id === 'nope'));
  assert.throws(() => buildRecommendations({ scores: { skin: 50 } }), /Missing score/);
});

test('every suggestion references existing product categories', () => {
  const { suggestions, products } = loadCatalog();
  for (const [id, s] of Object.entries(suggestions)) {
    for (const c of s.products) assert.ok(products[c], `${id} -> ${c}`);
  }
});
