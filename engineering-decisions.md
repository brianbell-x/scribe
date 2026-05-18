# Scribe — Engineering Decisions

This document tracks the *why* behind every non-obvious choice made while
building Scribe. It is updated as the build progresses, and converted to HTML at
the end so you can review it in a browser.

---

## 0. Goal (from the user)

> A simple workflow that takes images **or** text as input, and separately a
> PDF of a form to be scribed. The inputs are scribed onto the form. The
> agent uses tools to interact with the form (the UI will render this). UI is
> out of scope for this phase. Use OpenRouter for models, biome for
> formatting, prune for clean-up.

---

## 1. Wiped the old `scribe/` codebase

**What was there**: a Form Filler product — Python FastAPI backend (around 31
`.py` files, OpenAI Agents SDK + PyMuPDF) and a React+Vite frontend (about 6,800
lines). Two-stage "Prepare/Review" UI with a chat-based review surface.

**Why I wiped it**:

- The new direction is a **headless** scribe engine: tools in, filled PDF out.
  The old project was 80% UI/UX product surface.
- The old backend was committed to `OPENAI_API_KEY` + the OpenAI Agents Python
  SDK. The new direction is OpenRouter + TypeScript (biome implies TS, and the
  user said "agent SDK or client SDK — pick best").
- `AGENTS.md` build-sequence rule: "Prefer a small, boring structure; most AI
  Tools do not justify more than five implementation files." The old codebase
  violated this.

**What I preserved**:

- `scribe/.git` — per repo convention this folder is its own git repo.
- `scribe/.env` — already had `OPENROUTER_API_KEY` set (root `.env` only has
  `GEMINI_API_KEY`).
- I did **not** preserve `scribe/backend/assets/Form.pdf` because a 5-line
  probe showed it is a **flat** PDF, not an AcroForm — no `/AcroForm` dict,
  zero `/Widget` annots, zero `/T` field-name keys. It was unsuitable as a
  fixture for a tool-based filling agent. I generate a synthetic AcroForm
  fixture instead.
- Two tiny `.tmp` directories owned by another security principal could not be
  deleted without admin; I renamed them to `_locked_*` and gitignored them.

---

## 2. Language & toolchain: TypeScript + biome + `tsx`

- The user named **biome**, which is JS/TS-first, so the engine is TypeScript.
- `tsx` runs `.ts` files directly — no `dist/` step, no watch mode to manage.
- `biome.json` mirrors the workspace's other TS project
  (`shelby-county-landbank`) so the formatting rules are consistent across this
  repo of repos.
- `tsconfig` is strict + `noUncheckedIndexedAccess` because the codebase is
  small enough that the strictness pays for itself immediately.

---

## 3. AI stack: OpenAI Node SDK pointed at OpenRouter

**Decision**: use the bare `openai` npm package and override `baseURL` to
`https://openrouter.ai/api/v1`. No `@openai/agents`, no Vercel AI SDK.

**Why**:

- The agent loop here is tiny — 2 to 3 tools, one model, a few turns. An
  agent framework would hide the loop behind an abstraction that costs more to
  debug than it saves to write.
- OpenRouter is fully OpenAI-compatible for chat completions, tool calls, and
  `image_url` vision inputs (verified against the live `/api/v1/models` catalog
  and the OpenRouter docs).
- This matches the workspace `lessons-learned.md` guidance: "agents over-do a
  lot … for most problems you just need to define the workflow."

**Model selection** (verified against the live catalog, *not* WebFetch's
summarizer which fabricated slugs in two attempts):

- Primary: `anthropic/claude-sonnet-4.5` — vision + tool-calling + 1M context,
  $3 / $15 per million tokens. The best price/quality vision+tool model on
  OpenRouter today.
- Override via `SCRIBE_MODEL` env var if a caller wants a cheaper or stronger
  model. No code change required.

---

## 4. The tool surface (the contract the UI will render)

Three tools, designed so a UI can replay them as live edits on the form:

- `list_fields()` → `[{ name, type, options?, currentValue? }, …]`. Returns the
  whole field catalogue once so the agent can plan.
- `set_field({ name, value })` → confirms the write or returns an error message
  ("field not found", "checkbox values must be true/false", etc.). This is the
  *only* mutating tool — every change a UI shows comes from this call.
- `finish({ summary })` → ends the loop with a short summary the human can read.

This is intentionally minimal. Earlier versions of the design considered a
`get_field_info(name)` tool, but `list_fields` already returns enough metadata
for the model to act, so the extra tool was pruned.

**Audit log**: the persisted tool-call transcript *is* the audit log. There is
no separate "decisions" file — one source of truth, one thing for the UI to
replay.

---

## 5. PDF strategy: AcroForm only

The agent's tool surface is field-name oriented. That maps cleanly to AcroForm
PDFs via `pdf-lib`:

- `PDFDocument.load(buffer).getForm().getFields()` → names + types directly.
- `getTextField(name).setText(value)`, `getCheckBox(name).check()`, etc.

Non-AcroForm (flat) PDFs are out of scope for now. A flat PDF would require
either (a) a vision-driven coordinate detection pass or (b) a hand-authored
JSON sidecar of field rectangles. Both add real complexity and the user's spec
("a PDF of form to be scribed") fits the AcroForm shape — so we lean on the
strong contract instead of building two filling paths.

If the user wants flat-PDF support later, it'd be a follow-up phase: keep the
same tool surface, swap the filler implementation.

---

## 6. Phase proofs (followed the workspace AGENTS.md build sequence)

Per `AGENTS.md` the build sequence is: phase proofs → end-to-end proof → lean
implementation → retest → UI. Three proof scripts live under `src/proofs/`:

- `proof:pdf` — loads the fixture, lists every field, smoke-writes every kind,
  saves a result PDF. Confirms `pdf-lib` understands the fixture.
- `proof:agent` — hits OpenRouter with a small text input and confirms the
  model emits `list_fields` → 7 × `set_field` → `finish` against the same
  fixture (no PDF write — pure tool-call shape check).
- `proof:e2e` — calls the top-level `scribe()` function the way the CLI does
  and writes both the filled PDF and the transcript JSON to `out/` (text input).
- `proof:image` — same as e2e but **image-only**: the source is a `sample-card.png`
  rendered at fixture-time via `@napi-rs/canvas` (an "applicant card" with
  "Name: Alex P. Kim / DOB: 1985-07-03 / …" drawn on it). The model has to read
  the image to know what to write. This is what proves the vision branch of
  `buildUserContent` actually works against a real model.

All four pass on the first live run with `anthropic/claude-sonnet-4.5`. The
`npm run scribe -- ...` CLI is also run directly with `--text` + `--image`
combined, so the user-facing entry point has coverage too.

---

## 7. Review pass: what got pruned, what stayed

After the end-to-end proof passed, four parallel Opus-x-high subagents reviewed
the same five files through different lenses (`prune`, `readable-code`,
`systems-design-review`, `algorithmic-review` + `performance-review`). Findings
applied:

- **Merged `inputs.ts` (50 lines, one consumer) into `agent.ts`.** Both deal
  with the same "talking to the model" boundary; the seam was costing more
  import noise than it earned in clarity. Implementation files now: `cli.ts`,
  `scribe.ts`, `pdf.ts`, `agent.ts` (4 total — under the 5-file ceiling).
- **Loop now throws when `MAX_TURNS` is exhausted without `finish`.** Previously
  the partial transcript was written as if successful. Quoted reviewer
  reason: "Breaks a smooth demo on representative inputs."
- **Dropped the `try/catch` around `JSON.parse` in `executeToolCall`.** A
  malformed args string is now surfaced as a tool result, not swallowed into a
  bogus `{_parse_error: ...}` dispatch.
- **Replaced the hand-rolled `baseName` in `scribe.ts` with
  `node:path.basename(p, extname(p))`.** Less code to read, no subtle drift.
- **Parallelized the image-disk reads in `buildUserContent`** via
  `Promise.all`. At 1–10 images this turns N×disk-latency into ~1×.
- **Typed the message array as `ChatCompletionMessageParam[]`** instead of
  `any[]`. The shape is documented by the SDK; might as well lean on it.
- **Extracted `executeToolCall(call, form)`** out of the for-loop body. The
  loop now reads as "ask the model, run each tool call, stop on finish" — the
  threaded `finished` boolean smell went with the extraction.
- **Removed an unused `zod` dependency** and the dead `buildPlaceholderImage`
  fixture writer (and its 1×1 PNG output).
- **Coerce-bool string acceptance trimmed** to only `"true"` / `"false"` (plus
  real booleans). Models sometimes send strings here, but `"checked"` and
  `"yes"` were speculative.

Findings deliberately **rejected**:

- Don't drop the `optionlist` / `radio` / `unsupported` field-kind branches in
  `pdf.ts`. The fixture only exercises text/checkbox/dropdown, but a real
  user's AcroForm could include the others; the branches are cheap and removing
  them would force a future re-add at the worst time (a stuck demo).
- Don't change `setField`'s return-string protocol into a structured
  `{status, message}` object. The agent reads the result back as plain text,
  and a struct adds shape no consumer benefits from.
- Don't add retry/backoff around the OpenRouter call. Documented as an accepted
  issue per the workspace's `Accepted Issues` decision rule — single-process
  CLI, easy to rerun.

---

## 8. Final file layout

```
scribe/
  package.json            biome.json     tsconfig.json
  .env.example            .gitignore     README.md
  engineering-decisions.md (this file; an HTML copy is generated at the end)
  fixtures/
    sample-form.pdf        sample-notes.txt
  src/
    cli.ts                 # arg parsing + dotenv + calls scribe()
    scribe.ts              # orchestrator: load form, run agent, save outputs
    pdf.ts                 # AcroForm reader/writer (the only file that knows pdf-lib)
    agent.ts               # input shaping + OpenRouter loop + tool dispatch
    fixtures/make-acroform.ts
    proofs/{pdf-fields,agent-tools,end-to-end,image-only}.ts
    scripts/md-to-html.ts  # converts this file → engineering-decisions.html
```

Four implementation files, three proofs, one CLI fixture script, one docs
script — boring, scannable, no catch-all modules.

---

## 9. What a future UI consumes

The UI never has to call the model. It only needs to:

1. Accept a form PDF + text/image inputs from the user.
2. Call `scribe({ formPath, outPath, inputs, apiKey })`.
3. Read `transcriptPath` and stream each `toolCall` onto the rendered form as
   it would appear — one `set_field` per UI mutation, with the same field
   names AcroForm uses.

The `finish` summary is the human-facing closing line. No separate decision log,
no extra metadata file — one transcript, one PDF, that's the whole hand-off.

---

