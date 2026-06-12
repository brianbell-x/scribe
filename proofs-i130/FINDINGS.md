# Government-form proof findings (2026-06-12)

## I-130 (USCIS): NOT fillable by the current engine
- `loadForm` hard-fails: the PDF is encrypted (empty owner password) — pdf-lib needs `ignoreEncryption: true` plus tolerance for invalid object refs.
- With those options it loads but exposes **0 AcroForm fields**: the I-130 is an XFA form; fields live in XFA XML, which pdf-lib does not support at all.
- Consequence: IDEA.md's premise for the immigration vertical ("I-130 is AcroForm, no engine work needed") is falsified. Immigration requires either XFA flattening (lossy, tool-dependent) or a flat-fill/overlay capability (draw values at coordinates — also unlocks scanned/flat forms generally).

## IRS f2848 (power of attorney): fillable TODAY
- 92 AcroForm fields (70 text, 21 checkbox, 1 button), XFA-hybrid with a live AcroForm half.
- Field names are structured (`topmostSubform[0].Page1[0].TaxpayerName[0]`), well within the agent's demonstrated ability.

## Decisions
1. Vertical proof bed: **tax-representation intake (f2848)** — externally observable role (tax-resolution firms), engine-ready, costly-mistake domain.
2. Immigration (I-130) deferred behind the flat-fill/overlay engine extension — queued as the next engine milestone.
3. Engine fix needed now: `loadForm` passes `ignoreEncryption: true` and survives invalid-object warnings (gov PDFs ship this way; fill-and-save remains legal/permitted on these forms).
