# Flat-fill / overlay proof findings

## Status
- Integrated into product code after the live proof verdict.
- AcroForm mode remains the default. Flat/XFA overlay mode activates only when
  `pythonPath`, CLI `--python`, or server `SCRIBE_PYTHON` is configured.
- Deterministic overlay core writes text and checkbox marks with percentage coordinates.
- Product flat mode normalizes via `pypdf` when pdf-lib cannot page-load the raw PDF,
  rasterizes via `pypdfium2`, and auto re-renders changed pages for model correction.

## Offline proof
- `npm run proof:flatfill-draw` verifies save/reload integrity and content-stream growth on a page-loadable government PDF.
- `npm run proof:flatfill-mode` uses a mocked model and controlled Python path to assert
  flat tools, automatic render feedback, two-correction-round bounding, transcript shape,
  and placement fields such as `page1@22,27: FIRST`.
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

## Product flat-mode live run (2026-06-12, I-130 via CLI)
52 tool calls, completed. The verify-iterate loop worked as designed: the model detected its own misalignments from re-renders and flagged them (7 flags; missing source data correctly flagged, not invented). Placement quality on comb-field-dense pages remains below hands-off filling: name fields landed left of their boxes, one address block failed to land. POSITION: flat mode is an assisted-overlay capability requiring operator review (the Review tab surfaces every flag); hands-off accuracy needs anchor-based placement (detect field rectangles, snap proposals) or more iteration rounds - documented future work, not demo-blocking per AGENTS.md accepted-issues rule.
