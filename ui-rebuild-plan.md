# Operator UI rebuild — plan (2026-06-12)

Grounded in adversarially-verified research on OSS agent operator surfaces (LangChain Agent Inbox/HITL middleware, OpenHands SDK, AWS GenAI IDP, MuleSoft IDP, Mindee — 23/25 claims confirmed 3-0). Full report: session workflow `wshw4l5eb`.

## Architecture: headless core + thin local web client (one agent, many surfaces)

The convergent pattern everywhere: agent stays a headless core exposing a small local API; UI is a separate thin client; CLI remains a peer surface. Scribe's engine (scribe.ts/agent.ts/pdf.ts) does not change.

**server.ts** — local HTTP server over the existing run pipeline:
- `POST /api/runs` — JSON {pdf: base64, sources: [{name, type, data: base64}]} → starts run, returns id (base64 JSON over multipart: zero new deps)
- `GET /api/runs/:id/events` — SSE stream of transcript events as the loop emits them (SSE over WS: zero deps, one-way is all we need)
- `GET /api/runs/:id` — state: fields, values, flags, missing-required list
- `POST /api/runs/:id/fields` — {field, value} inline correction via the same set-field path the agent uses
- `GET /api/runs/:id/export` — filled PDF
- serves the static client; runs/artifacts live in out/ (no DB)

## Review model: review-by-exception (AWS/MuleSoft/Mindee convergence)

Only exceptions reach the operator: fields the agent `flag_uncertain`ed + required fields left unset. Everything else is presumed good and shown in a collapsed all-fields list. Per-field color coding: green = set & unflagged, orange = flagged medium, red = flagged low or missing-required. Display the flag REASON, not a fake numeric confidence (research caveat: displayed confidence anchors reviewers; scribe's signal is categorical anyway). Corrections are inline edits; one explicit **Export PDF** commits — no per-field approve/reject ceremony.

## Replay: portable artifact, secondary tab (OpenHands pattern)

Transcript JSONs stay portable. Replay tab loads them by file picker or `?file=` param and renders the step timeline. Demo/debug/share artifact — not the operator's primary surface.

## Post-run review, not mid-run interrupts

LangChain's HITL pauses mid-loop with a checkpointer; scribe's runs are short and the form is fully revisable after the run, so post-run review delivers the same human control with none of the checkpointer machinery. Revisit only if runs get long enough that mid-run correction matters.

## Skip at demo/self-use scope (explicit, from research + AGENTS.md decision rule)
- hosted deployment, auth, multi-user
- databases (files + memory only)
- mid-run interrupt/checkpointer infra
- separate LLM confidence-assessment pass (AWS pattern; single-vendor, costs a second inference — flag_uncertain already covers it)
- four-decision approve/edit/reject/respond vocabulary (collapses to "edit + single submit" when review is post-run)

## Vertical
First target workflow: immigration paralegal I-130 intake (see .decisions/scribe.md). The surface above is form-generic; the I-130 proof exercises it with real multimodal source docs.
