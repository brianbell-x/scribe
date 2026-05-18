# Scribe — IDEA.md

## What is built

A headless TypeScript engine that copies information from source inputs (text
and/or images) onto an **AcroForm PDF** via an LLM agent. The agent never sees
the rendered PDF; it interacts through three tools (`list_fields`, `set_field`,
`finish`) and the persisted tool-call transcript is what a future UI would
replay onto the form.

- 4 implementation files, ~566 LOC, OpenRouter + `anthropic/claude-sonnet-4.5`.
- Verified end-to-end on text-only, image-only, and combined inputs.
- See `engineering-decisions.html` for the build narrative; `README.md` for run
  commands.

This document captures *who would pay for this and why*, not how it works.

## Status: horizontal tool, direction-open

This folder previously held a "Form Filler" generic-product attempt that was
wiped because no buyer/role was named — it tried to be a UI app for an
imaginary user. The new engine is intentionally horizontal: it does one job
(scribe inputs onto a form) and exposes the seam a vertical product would wrap.

**Direction is not committed.** This IDEA.md surfaces the candidate operator
roles where filling forms from source documents is the paid job; the next step
is to run `role-research` against one of them and produce a vertical IDEA.

## Underlying goal (in operator vocabulary)

The operator's underlying goal is **produce a complete, accurate, filed form**
that a downstream system (county, agency, payer, lender, court, broker) will
accept on the first submission. The form itself is the artifact; rework on
rejected forms is the cost they are trying to avoid.

Stage-inside-workflow language (`extract`, `classify`, `validate`, `OCR`,
`route to review`) is *not* the goal — it is a step. Every option below has to
roll back up to "complete, accurate, filed form."

## Generic workflow map

Same five stages regardless of which vertical you pick:

1. **Form acquisition** — operator obtains the blank target form (download,
   carrier portal, vendor library, court repository).
2. **Source acquisition** — client/applicant/claimant supplies messy
   documents: photos of IDs, scanned statements, email threads, intake notes.
3. **Reconciliation** — operator reads sources, decides which field on the
   form they map to, copies them across. **This is the AI job.**
4. **Review & sign-off** — supervisor or the operator themselves verifies the
   filled form against the sources.
5. **Submission** — file the form through the destination system (manual
   upload, email, e-fax, portal, e-filing, courier).

The Scribe engine, as built, owns stage 3 and the artifact that goes into
stages 4–5. It does not yet own stages 1, 2, or 5.

## AI leverage check (why this is not OCR + template fill)

A traditional pipeline would: OCR the source → regex/heuristic match to field
names → template fill. That fails when:

- the source is a photo of a handwritten note, a scanned ID, a screenshot of
  an email thread, or a PDF whose layout is unique to one carrier
- the form's field labels do not match the source's vocabulary
  (`borrower_dob` vs `Date of Birth (mm/dd/yyyy)` vs `D.O.B.`)
- a dropdown's options force the operator to pick one of N choices that don't
  exactly match what the source says
- two sources disagree and the operator has to judge which is current

Each of those is meaningful frontier-model judgment per run; the variability
boundary is real. The engine's tool surface is deliberately small so the model
does the judging and deterministic code does the writing.

## Candidate operator roles (option set)

Each is an **externally observable** role per the workspace's lessons-learned
guidance. For each: who buys, the form, the source, what makes it not cliche,
the tool-harness readiness, and the smallest proof.

### Option A — Property tax appeal preparers (or DIY appellants)

- **Buyer / operator**: independent appeal consultants and property owners
  filing residential or commercial appeals; volume during the county's appeal
  window.
- **Form**: county-specific appeal form (e.g. Shelby County Board of
  Equalization petition, Cook County PTAB, NYC TC108).
- **Source**: assessor record card, comparable-sales evidence, photos of the
  property, owner-supplied receipts and income/expense schedules.
- **Output value**: a filed petition that survives the county's screen; the
  competing offer is paying a consultant 25–50% of first-year tax savings.
- **Not cliche because**: the form is county-specific (real form variability),
  the evidence is multimodal (photo + comp PDFs + ledger), and there's a hard
  filing deadline that creates demand spikes.
- **Tool harness**:

  | Tool | Readiness | Action risk | Notes |
  | --- | --- | --- | --- |
  | County form catalog (downloadable PDFs) | `Path to test` | Read-only | Most counties publish, some paywall behind PIN |
  | AcroForm widget on those forms | `Unknown` | n/a | Many county forms are flat — Scribe's hard constraint |
  | Assessor record-card retrieval | `Path to test` | Read-only | Public web for many counties |
  | Comps data | `Path to test` | Read-only | Public MLS-adjacent listings, some scraped sources |
  | Submission | `Path to test` | External write | County e-file portals vary; some still mail-only |

- **Smallest proof**: take one county whose appeal form is an AcroForm
  (verify), fill it for one real property using the assessor card + one comp
  photo, and produce a petition that an experienced appeal consultant would
  sign without edits.

### Option B — Immigration paralegals (family-based visa intake)

- **Buyer / operator**: small immigration firms doing I-130 / I-485 / I-765
  packages; paralegal time per case is the bottleneck.
- **Form**: USCIS forms — public, downloadable, AcroForm-fillable PDFs (this
  matches Scribe's hard constraint).
- **Source**: client passport scans, marriage certificates, employer letters,
  birth certificates, prior immigration history.
- **Output value**: a filed package that USCIS does not reject for omitted
  fields; rework after rejection is days of paralegal time.
- **Not cliche because**: USCIS forms are notoriously brittle, the source
  documents are heterogeneous and multilingual, and accuracy is high-stakes.
  Multiple paid SaaS products (Docketwise, Clio Grow add-ons) target this,
  proving willingness to pay.
- **Tool harness**:

  | Tool | Readiness | Action risk | Notes |
  | --- | --- | --- | --- |
  | USCIS AcroForm PDFs | `Verified` (externally) | Read-only | Forms are public AcroForms |
  | Source document intake (photos, scans) | `Verified` | Read-only | Scribe's vision branch already handles this |
  | Multilingual source handling | `Path to test` | Read-only | Sonnet 4.5 vision supports most scripts |
  | Submission to USCIS | `Path to test` | External write | Filed via mail or USCIS online — outside engine scope |
  | Compliance / privilege boundaries | `Path to test` | n/a | Cannot give legal advice; can prepare attorney-supervised drafts |

- **Smallest proof**: take a sample I-130 with five synthetic supporting docs
  (no real PII), produce a filled PDF a paralegal would forward to the
  supervising attorney with minimal correction.

### Option C — Residential real-estate disclosure prep

- **Buyer / operator**: residential agents preparing state-required seller
  disclosure forms (e.g. Tennessee TREC Residential Property Disclosure).
- **Form**: state-specific disclosure — public, sometimes AcroForm, sometimes
  flat with a Docusign overlay.
- **Source**: seller's emailed answers, inspector reports, prior repair
  receipts, HOA letters.
- **Output value**: a filled disclosure ready for the seller to review and
  sign at the kitchen-table closing meeting; reduces back-and-forth.
- **Not cliche because**: the source is heterogeneous (emails + PDFs +
  handwritten notes) and the form's questions are nuanced ("any known issue
  with…") that benefit from model judgment about what counts.
- **Tool harness**:

  | Tool | Readiness | Action risk | Notes |
  | --- | --- | --- | --- |
  | TREC / state disclosure forms | `Path to test` | Read-only | Need to confirm AcroForm vs flat |
  | Agent's CRM (Follow Up Boss, etc.) | `Unknown` | Read-only | Each agent uses something different |
  | Docusign / Dotloop submission | `Path to test` | External write | Outside engine scope |

- **Smallest proof**: scribe a TREC disclosure from one real seller's email
  thread (anonymized) and one inspector report. Have a licensed agent rate
  it.

### Option D — Small-firm tax intake worksheets

- **Buyer / operator**: solo CPA / EA practices in tax season; intake is
  manual data entry from client W-2s, 1099s, 1098s into the firm's intake
  worksheet before it goes into Drake/Lacerte/UltraTax.
- **Form**: firm-specific intake worksheet (often flat PDF or Excel) — may
  not be an AcroForm, **fails Scribe's hard constraint without a flat-PDF
  fill path**.
- **Output value**: hours per return saved; preparers bill the saved time.
- **Tool harness**: marked **`not with current data`** until Scribe supports
  flat-PDF fill via coordinate overlays (a real follow-up phase, ~1 week of
  work).

### Option E — Sold as a developer SDK / harness

- **Buyer / operator**: builders of vertical form-filling apps who don't want
  to write their own agent loop, PDF integration, and tool surface.
- **Output value**: time to vertical-product MVP. Pricing as a per-form
  metered API or as a code library.
- **Not cliche because**: the engine already exposes the seam every vertical
  product would need (tool transcript = UI replay log).
- **Tool harness**:

  | Tool | Readiness | Action risk | Notes |
  | --- | --- | --- | --- |
  | TypeScript engine | `Verified` | Internal write | Already built |
  | Public hosted endpoint | `Unknown` | External write | Would need infra + per-key billing |
  | Flat-PDF fallback | `Path to test` | Internal write | A vertical wrapper would expect this |
  | UI replay reference implementation | `Path to test` | n/a | Would unlock buyers who want a head start |

- **Marked `not now`**: developer-tool businesses are slow-revenue and the
  workspace's bias has been toward operator products with paid deliverables,
  not API plumbing. Revisit after one vertical has been proven.

### Hard no

- **Healthcare prior-authorization workflow** — source documents live inside
  EHRs that are not externally observable; access is gated by HIPAA, BAAs,
  and integration agreements per workspace lessons-learned (research only
  externally-observable roles).
- **Pro-se court self-help (one-off individual filings)** — no aggregating
  buyer, no recurring volume, every form is a different jurisdiction. Real
  work, no paid operator.
- **Multi-agent "form-filling crew" theater** — agent count is not the
  product. One model + tool calls is enough; orchestration drama would be a
  weak-signal under the idea-handling skill.

## Tool harness — engine itself

What is already built and what is missing for a vertical to land cleanly.

| Capability | Readiness | Action risk | Notes |
| --- | --- | --- | --- |
| AcroForm read (`list_fields`) | `Verified` | Read-only | Every widget kind walked |
| AcroForm write (`set_field`) | `Verified` | Internal write | text / checkbox / radio / dropdown / optionlist |
| Vision input (image_url base64) | `Verified` | Read-only | Proven against rendered "applicant card" PNG |
| Multi-source reconciliation | `Verified` | Internal write | Combined text + image run on the CLI worked |
| Flat-PDF (no AcroForm) fill via coords | `Unknown` | Internal write | Hard constraint today; ~1 week to add |
| Per-field uncertainty / confidence flagging | `Path to test` | Internal write | Tool could emit `set_field_uncertain` with a reason |
| Human-in-the-loop review surface | `Unknown` | n/a | Out of scope for engine; a UI's job |
| Submission to a destination system | `Unknown` | External write | Per-vertical; not the engine's job |
| Audit / replay log for UI | `Verified` | Read-only | Transcript JSON is already the replay primitive |
| Multilingual source handling | `Path to test` | Read-only | Sonnet 4.5 handles many scripts; needs eval |

## Architecture stance

The engine should stay a `workflow with one agent step`:

- deterministic pre-flight (load form, list fields, build content parts)
- one bounded agent loop (≤12 turns, has to call `finish`)
- deterministic post-flight (save filled PDF, persist transcript)

Reject as theater any redesign that introduces multi-agent handoff, a
"planner/executor split", or an "auditor agent" — the loop is small enough
that the *model* plans and executes; the *deterministic code* audits via the
tool dispatch. Adding agents would buy nothing the current architecture is
missing.

For verticals that need flagged-for-review behavior, the cleanest extension
is a fourth tool (`flag_uncertain({name, reason})`) — still one agent, more
expressive transcript.

## Smallest commercial proof per direction (recap)

| Option | Smallest manual proof | Cost to attempt |
| --- | --- | --- |
| A. Tax appeal | Fill one county's appeal form from real assessor card + comp evidence | Low — public surfaces, demand-spike business |
| B. USCIS intake | Fill one I-130 from synthetic supporting docs; show it to a paralegal | Lowest — forms are already AcroForm, no flat-PDF work needed |
| C. RE disclosure | Fill one TREC disclosure from real email thread + inspector report | Low if the disclosure is an AcroForm; medium if flat |
| D. Tax intake | (Blocked until flat-PDF support) | Medium |
| E. Dev SDK | Public reference UI + hosted endpoint | Highest infra cost; weak commercial signal |

## Recommendation

**Option B (USCIS intake paralegal)** is the strongest candidate to
role-research first:

- USCIS forms already match Scribe's hard constraint (AcroForm) — no
  engine work needed before proof.
- The role is externally observable: USCIS forms are public, paralegal
  training material is online, immigration firms publish process pages, and
  there are existing paid SaaS products in the niche to study.
- Source documents are exactly the multimodal mix the engine was built for
  (passport scans, employment letters, prior I-94s).
- Mistakes are expensive *and* observable, which creates a clear willingness
  to pay.

**Suggested next step**: run `role-research` against the immigration-paralegal
role (or DIY family-petition applicant, depending on whose pain we shape
around), then write a vertical IDEA.md inside `scribe/role-research/` or a
sibling folder.

The other options stay live; their `not now` status is documented above with
the condition that would justify a revisit (flat-PDF support for D, one
proven vertical for E).
