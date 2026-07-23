# Scribe

A lightweight agent that fills an **AcroForm PDF** from your notes and images.
It runs an LLM (via OpenRouter) with four tools — `list_fields`, `set_field`,
`flag_uncertain`, `finish` — and writes the filled PDF plus a JSON transcript of
every tool call. Headless CLI first, with a minimal web UI for non-technical users.

Flat and XFA PDFs are **not** supported — Scribe tells you so up front.

Encrypted PDFs (e.g. USCIS forms) are decrypted automatically when `qpdf` is on
`PATH` (`winget install QPDF.QPDF`); without it, Scribe fails with a clear message.

## Install

```sh
npm install
cp .env.example .env   # then paste your OPENROUTER_API_KEY
```

## CLI

```sh
npm run scribe -- --form x.pdf --out y.pdf --text "John Doe, born 1990-04-12, lives in Memphis TN"
npm run scribe -- --form x.pdf --out y.pdf --image z.png
```

`--text` and `--image` may be repeated; at least one is required. Output is the
filled PDF plus `y.transcript.json` next to it.

## Web UI

```sh
npm run serve   # http://127.0.0.1:8787
```

Drop a PDF form, drop/paste notes and images, click the button, download the
filled PDF. The server is a single `POST /api/run` endpoint — no run history,
no live progress.

## Environment

- `OPENROUTER_API_KEY` (required)
- `SCRIBE_MODEL` (optional; defaults to `anthropic/claude-sonnet-4.5`)
- `PORT` (optional; UI server, default 8787)

## Verify

```sh
npm run typecheck
npm run lint
npm run proof:e2e   # full pipeline on the fixture, offline mock model, no API key needed
npm run proof:live  # four real-model AcroForm runs; skips cleanly when the API key is absent
```

## Conventions

- TypeScript, biome-formatted, no compile step (`tsx` runs `.ts` directly).
- OpenRouter via the OpenAI Node SDK with a custom `baseURL` — no agent framework.
