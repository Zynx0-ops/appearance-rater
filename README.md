# Appearance Rater

Take a selfie (or upload a photo) and get an encouraging appearance report: an overall score, a breakdown across five dimensions, prioritized tips, and product ideas matched to those tips.

## Summary: what was built

- **A mobile-first web app** with four tabs: Analyze, Report, Improve and Products. It has a dark, card-based design: ring gauge for the overall score, color-coded score cards and numbered focus areas.
- **Real on-device face analysis.** [face-api.js](https://github.com/vladmandic/face-api) (TensorFlow.js) runs in the browser to detect the face, find 68 facial landmarks and read the expression. Then hand-written image heuristics score skin, symmetry, grooming, hair and presentation.
- **A zero-dependency Node server.** It serves the app and turns scores into ranked suggestions and products. The tips and products live in editable JSON files.
- **Privacy:** the photo never leaves the browser. Only the five numeric scores and finding IDs are sent to the server. Nothing is written to disk.

**Limitations (please read):**

- Face detection and landmarks come from a trained model. **The scores themselves are heuristics** (hand-tuned formulas over pixel statistics), not a model trained on human ratings. They respond to real signals such as texture, redness, landmark symmetry, lighting and sharpness. They have only been calibrated on a small number of photos.
- Lighting, camera quality, angle and compression affect results a lot. The app shows a confidence level and warnings for this.
- Hair scoring is the weakest dimension. It separates hair from skin and background by color, so dark hair against a dark background is treated as "unclear" rather than scored down.
- The face-analysis models (~6 MB) load from the jsDelivr CDN on first use, so the first scan needs internet. If they can't load, the app offers **demo mode** (`?engine=demo`), which returns **placeholder scores that are not based on your face** and labels them clearly.

> **Disclaimer:** Scores are an approximate, subjective, opinion-based estimate from a single photo. They are not an objective measure of attractiveness or worth, and they are not medical advice. For skin concerns, see a dermatologist.

---

## Quick start

Requires **Node.js 18+**. There are no npm dependencies to install.

```bash
git clone https://github.com/Zynx0-ops/appearance-rater.git
cd appearance-rater
npm start
```

Open **http://localhost:3000**. Use `PORT=4000 npm start` to change the port.

### On your phone

The server prints a `Network:` URL (for example `http://192.168.1.20:3000`). Open it on a phone on the same Wi-Fi.

- **Upload a photo** works everywhere.
- **Take a selfie** uses the live in-app camera on `localhost` or HTTPS. Over plain-HTTP LAN addresses, browsers block `getUserMedia`, so the app falls back to the phone's native camera picker. That still works. You just don't get the in-app oval guide.

### Tests

```bash
npm test
```

---

## How it works

```
Browser                                              Node server (server.js)
───────────────────────────────────────────────      ──────────────────────────────
camera / file ─► canvas (≤1024px)                    
             ─► analyzer.js                          
                  face-api: detect + 68 landmarks    
                  heuristics ─► 5 scores + findings ─► POST /api/recommendations
                                                         lib/recommend.js
                                                         + data/suggestions.json
                                                         + data/products.json
             ◄─ report, plan, products ◄───────────── ranked focus areas + products
```

### Project layout

| Path | What it is |
| --- | --- |
| `server.js` | Static file server + JSON API (Node built-ins only) |
| `lib/recommend.js` | Ranks findings into focus areas and attaches products |
| `data/suggestions.json` | Every tip the app can give: title, summary, steps, product categories |
| `data/products.json` | Example products per category, each with a reason it fits |
| `public/js/analyzer.js` | **The swappable analysis module.** It contains all scoring logic. |
| `public/js/app.js` | UI: capture, upload, errors, rendering |
| `public/index.html`, `public/css/styles.css` | Markup and styling |
| `test/` | Unit tests for the recommendation engine |

### Scoring

Before scoring, the face is rotated so the eyes are level and rescaled to a fixed size. Measurements therefore don't depend on photo resolution. Each dimension is 0–100:

| Dimension | Weight | What it measures |
| --- | --- | --- |
| **Skin** | 25% | Fine texture on cheeks and forehead (Laplacian energy), blotchiness and cheek-vs-forehead redness, tone evenness, specular shine, under-eye darkness |
| **Symmetry** | 15% | Average left/right offset across 29 mirrored landmark pairs, corrected for head turn |
| **Grooming** | 20% | Facial-hair evenness (dark *and* textured regions on each jaw side), brow density/shape match, lip texture |
| **Hair** | 15% | How much of the area above the brows is hair, and how jagged the hair outline is (flyaways) |
| **Presentation** | 25% | Lighting level and balance, sharpness, head tilt/turn, expression (from the model), framing |

- **Overall** is the weighted average.
- **Potential** estimates where the overall score could go with consistent effort. It assumes the changeable dimensions (skin, grooming, hair, presentation) close part of their gap, while symmetry barely moves.
- **Confidence** drops when there are lighting, blur, pose or hair-visibility warnings.
- Each detected issue becomes a **finding** with a severity (e.g. `skin_redness: 0.6`). The server ranks findings by dimension score, severity and how improvable that dimension is. It then attaches products from the matching categories.

Raw measurements are logged to the browser console (`[analysis] …`) after every scan. This makes it easy to tune the thresholds in `analyzer.js`.

### Swapping the analysis backend

`public/js/analyzer.js` exports `analyzePhoto(canvas, { engine })` and returns:

```js
{
  overall, potential, confidence,
  scores:   { skin, symmetry, grooming, hair, presentation },  // 0–100
  labels:   { skin: 'Clear', ... },
  findings: [{ id: 'skin_texture', severity: 0.4 }, ...],    // ids from data/suggestions.json
  warnings: ['...'],
  overlay:  { points, midline, sourceWidth },                   // for the photo overlay
  engine
}
```

To use a different model or a cloud vision API, replace the internals and keep this shape. Throw `AnalysisError(code, title, message)` for user-facing problems.

### Editing tips and products

- Add or change products in `data/products.json`. Each category is a list of `{ name, brand, price, reason }`.
- Change the advice in `data/suggestions.json`. Each suggestion's `products` array lists which categories to pull from.

The server re-reads both files on every request, so edits show up without a restart. The products are illustrative examples, not endorsements or affiliate links.

### Error handling

| Situation | What the user sees |
| --- | --- |
| No face found | "No face detected", with framing tips |
| Two or more similar-sized faces | "2 faces detected — use a photo with only you" (small background faces are ignored) |
| Very dark / overexposed / face in shadow | "Too dark" / "Photo is overexposed", with lighting tips |
| Face too small or turned away | Prompt to move closer or face the camera |
| Non-image or unreadable file, HEIC on unsupported browsers, files over 15 MB | Clear message with what to use instead |
| Camera blocked or missing | Explanation plus an "Upload a photo instead" button |
| Model can't load (offline) | Retry, or switch to demo mode |
| Uneven light, blur, tilt | Results still shown, with warnings and lower confidence |

### Privacy

- The photo is decoded and analyzed entirely in the browser, and is never uploaded.
- Only scores and finding IDs (a few hundred bytes) go to `/api/recommendations`. The server rejects bodies over 16 KB and stores nothing.
- The full-size image is discarded right after analysis. A small display copy stays in memory for the report until you close the tab or tap ✕ on the report.

## License

[MIT](LICENSE)
