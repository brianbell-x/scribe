# Scribe

Scribe text or image inputs onto a PDF form (AcroForm) via an LLM agent.

The agent does not draw on the PDF directly — it uses **tools** (`list_fields`,
`set_field`) so that the UI layer can render each tool call as a live edit on
the form. This repo is the engine; the UI is intentionally out of scope.

## Inputs

- One or more **source documents**: plain text strings and/or image file paths.
- One **target PDF**: must be an AcroForm (i.e. has fillable widget fields).

## Output

- A filled PDF saved next to the input.
- A JSON transcript of every tool call the agent made (this is what a UI would
  replay).

## Setup

```powershell
npm install
Copy-Item .env.example .env   # then paste your OPENROUTER_API_KEY
```

## Run

```powershell
npm run make-fixture          # generate a sample AcroForm PDF + text + image fixtures
npm run scribe -- --form fixtures/sample-form.pdf --text "John Doe, born 1990-04-12, lives in Memphis TN" --out out/filled.pdf
npm run scribe -- --form fixtures/sample-form.pdf --image fixtures/sample-card.png --out out/filled-from-image.pdf
```

`out/filled*.pdf` is the result; `out/filled*.transcript.json` is the tool-call log a
future UI would replay onto the form.

## Verify

```powershell
npm run proof:pdf             # reads AcroForm field list, smoke-writes every kind
npm run proof:agent           # runs a tool-call loop against OpenRouter (text input)
npm run proof:e2e             # full pipeline on the fixture (text input)
npm run proof:image           # full pipeline using only the rendered card image
```

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
npm run ui                    # serves the scribe/ folder over plain HTTP
# Open http://localhost:5173/ui/index.html
```

The UI never calls the model. Every value shown traces to a real file under
`out/` or `fixtures/`. Source: `ui/index.html`, `ui/app.jsx`. No bundler, no
npm dependencies — React, Babel-standalone, and pdf.js are all CDN scripts.

## Conventions

- TypeScript, biome-formatted, no compile step (`tsx` runs `.ts` directly).
- OpenRouter via the OpenAI Node SDK with a custom `baseURL` — no extra agent framework.
- Model: `anthropic/claude-sonnet-4.5` (vision + tool calling, 1M ctx).
