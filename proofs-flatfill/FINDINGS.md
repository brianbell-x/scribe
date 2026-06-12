# Flat-fill / overlay proof findings

## Status
- Phase proof only. Not wired into product code.
- Deterministic overlay core writes text and checkbox marks with percentage coordinates.
- Live AI placement runner requires pre-rendered page PNGs and a pdf-lib drawable PDF.
- Raster fallback command: `pdftoppm -png -f 1 -l 1 -r 200 proofs-i130/i-130.pdf out/i130-pages/page`.

## Offline proof
- `npm run proof:flatfill-draw` verifies save/reload integrity and content-stream growth on a page-loadable government PDF.
- Direct drawing on `proofs-i130/i-130.pdf` is currently blocked: pdf-lib cannot resolve the encrypted object-stream page tree (`Expected instance of PDFDict, but got instance of undefined`).

## Live-run questions
- Placement accuracy: does the model land petitioner family name, given name, and one checkbox within field bounds on page 1?
- Iteration need: can one pass place values acceptably, or does it need debug-PDF feedback and a second placement pass?
- Coordinate drift: do the same percentage placements survive page-size differences between screenshot, normalized PDF, and original PDF?
- Normalization boundary: what local/orchestrator tool should produce the drawable PDF when a government XFA PDF cannot be page-loaded by pdf-lib?
- Checkbox semantics: is a simple `X` acceptable for all target checkboxes, or do some forms need filled squares/checkmarks?

## Live run results (2026-06-12, orchestrator)
Chain proven end to end: pypdf normalization (raw I-130 unparseable by pdf-lib AND pypdf-without-cryptography; AES decrypt needs the cryptography package) -> pypdfium2 rasterization (headless Chromium CANNOT render PDFs via file://; pdfium is the dependable rasterizer) -> vision placement proposals (model returned fenced JSON; parser strips fences now) -> deterministic percentage-coordinate drawing.

Placement accuracy on I-130 page 1 (3 placements): 1 exact (text inside the intended comb field), 1 near-miss (~1-2% high, clips field border), 1 zone-miss (checkbox X landed outside the target box, ~3-4% off both axes).

VERDICT: flat-fill is viable; single-pass placement is not production-accurate. Production design must include a verify-iterate loop (draw -> re-render via pdfium -> model compares against intent -> adjusted placements), mirroring the refinement-loop finding from web-design-lead-gen. Integration into the product should bundle: normalization step, pdfium rasterizer, placement tool with iteration, and the existing flag_uncertain pattern for placements the model cannot confidently locate.
