# Scribe

Scribe text or image inputs onto a PDF form via an LLM agent. AcroForm PDFs are
filled through native fields; flat/XFA PDFs can be filled with overlay placements
when a Python rasterizer is configured.

The agent uses **tools** (`list_fields`, `set_field`, or flat-mode `view_page`,
`place_text`, `place_mark`) so the UI layer can render each tool call as a live
edit on the form. Flat mode draws, re-renders via pdfium, and gives the model up
to two correction rounds per page before it must finish or flag uncertainty.

## Inputs

- One or more **source documents**: plain text strings and/or image file paths.
- One **target PDF**: AcroForm preferred. Flat/XFA PDFs require Python with
  `pypdf` and `pypdfium2`.

## Output

- A filled PDF saved next to the input.
- A JSON transcript of every tool call the agent made (this is what a UI would
  replay).

## Setup

```powershell
npm install
Copy-Item .env.example .env   # then paste your OPENROUTER_API_KEY
# Optional for flat/XFA PDFs:
# SCRIBE_PYTHON=C:\path\to\python.exe
```

## Run

```powershell
npm run make-fixture          # generate a sample AcroForm PDF + text + image fixtures
npm run scribe -- --form fixtures/sample-form.pdf --text "John Doe, born 1990-04-12, lives in Memphis TN" --out out/filled.pdf
npm run scribe -- --form fixtures/sample-form.pdf --image fixtures/sample-card.png --out out/filled-from-image.pdf
npm run scribe -- --form proofs-i130/i-130.pdf --text "<intake notes>" --out out/i130-flat.pdf --python C:\path\to\python.exe
```

`out/filled*.pdf` is the result; `out/filled*.transcript.json` is the tool-call log a
future UI would replay onto the form.

## Verify

```powershell
npm run proof:pdf             # reads AcroForm field list, smoke-writes every kind
npm run proof:agent           # runs a tool-call loop against OpenRouter (text input)
npm run proof:e2e             # full pipeline on the fixture (text input)
npm run proof:image           # full pipeline using only the rendered card image
npm run proof:flatfill-mode   # offline mocked model, flat tools, bounded verify loop
npm run proof:server          # local HTTP/SSE/review/export endpoints
```

Set `SCRIBE_OFFLINE=1` to force `proof:agent`, `proof:e2e`, and `proof:image`
onto their mocked model path even when `.env` contains an API key.

## Review surface (static UI)

A small static UI replays the most recent end-to-end run as a 3-column
workbench: the agent's source notes on the left, the filled PDF rendered via
pdf.js with per-field overlays in the middle (plus a finish-summary card
below it), and the chronological tool-call stream on the right. A full-width
replay scrubber along the bottom steps through every `set_field` and meta
call. A literal `indexOf` lookup highlights the slice of the source notes
that matched whichever field the operator selects.

```powershell
npm run proof:e2e             # produces out/e2e-filled.pdf + .transcript.json
npm run serve                 # serves web/ over plain HTTP
# Open http://127.0.0.1:8787
```

The UI never calls the model. Every value shown traces to a real file under
`out/` or `fixtures/`. Source: `web/index.html`, `web/app.js`. No bundler, no
client build step.

## Conventions

- TypeScript, biome-formatted, no compile step (`tsx` runs `.ts` directly).
- OpenRouter via the OpenAI Node SDK with a custom `baseURL` - no extra agent framework.
- Model: `anthropic/claude-sonnet-4.5` (vision + tool calling, 1M ctx).
