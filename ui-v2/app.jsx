// app.jsx — Scribe operator review surface.
// Form-as-document layout: filled PDF (mocked as an HTML render of its
// AcroForm fields) sits at the page center; left margin holds per-field
// source quotes; right margin holds the set_field tool events. A scrubbable
// event timeline runs along the bottom of the viewport. Per the brief, the
// transcript is replayed from disk — there is no live engine connection.

const { useState, useEffect, useMemo, useRef, useLayoutEffect, useCallback } = React;

// ─────────────────────────────────────────────────────────────────────────────
// Tweak defaults — persisted by the host so a refresh remembers your view.
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "variant": "ok",
  "showFieldNames": true,
  "showLeaders": true,
  "showStream": false
}/*EDITMODE-END*/;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers

function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function jsonShort(v) {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return `"${v}"`;
  return JSON.stringify(v);
}

// Replay the transcript up to (but not including) step `scrubIndex+1`.
// scrubIndex < 0 → empty pre-state; scrubIndex == toolCalls.length-1 → final.
function deriveStateAt(run, scrubIndex) {
  const values = {};
  const errors = {};
  const events = {};
  for (const f of run.fields) {
    values[f.name] = f.kind === "checkbox" ? false : "";
    events[f.name] = [];
  }
  let listFieldsAt = -1;
  let finishAt = -1;
  for (let i = 0; i <= Math.min(scrubIndex, run.toolCalls.length - 1); i++) {
    const tc = run.toolCalls[i];
    if (tc.name === "list_fields") {
      listFieldsAt = i;
    } else if (tc.name === "set_field") {
      const fname = tc.arguments.name;
      const isErr = tc.result.startsWith("error:");
      // Bucket the event under the field the agent NAMED, even if that
      // field doesn't exist (e.g. "FAKE"). Those orphan events get their
      // own row in the right margin so they're not invisible.
      if (!events[fname]) events[fname] = [];
      events[fname].push({ step: i, tc });
      if (!isErr) {
        values[fname] = tc.arguments.value;
        delete errors[fname];
      } else {
        errors[fname] = tc.result;
      }
    } else if (tc.name === "finish") {
      finishAt = i;
    }
  }
  return { values, errors, events, listFieldsAt, finishAt };
}

// Tag a substring of `text` with <mark> by matching the literal quote. Used
// to highlight the slice of source notes that justified a written field.
function HighlightedText({ text, quote, active }) {
  if (!quote) return <>{text}</>;
  const idx = text.indexOf(quote);
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className={active ? "active" : ""}>{text.slice(idx, idx + quote.length)}</mark>
      {text.slice(idx + quote.length)}
    </>
  );
}

// Render the tool-call arguments object as colorised mono. Strings are
// quoted and green; booleans blue.
function ArgsInline({ args }) {
  const keys = Object.keys(args);
  if (keys.length === 0) return <span className="event-args">{"{}"}</span>;
  return (
    <span className="event-args">
      {"{ "}
      {keys.map((k, i) => (
        <React.Fragment key={k}>
          <span className="arg-key">{k}</span>
          {": "}
          {(() => {
            const v = args[k];
            if (typeof v === "string") return <span className="arg-val s">{`"${v}"`}</span>;
            if (typeof v === "boolean") return <span className="arg-val b">{String(v)}</span>;
            return <span className="arg-val">{JSON.stringify(v)}</span>;
          })()}
          {i < keys.length - 1 ? ", " : ""}
        </React.Fragment>
      ))}
      {" }"}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Floating utility toolbar (top-right) — replaces the old surface header.
// Two icon buttons: download the filled PDF, and toggle Run details.

function UtilBar({ openArtifact, showStream, setShowStream }) {
  return (
    <div className="util-bar" role="toolbar" aria-label="Run actions">
      <button
        className="util-btn"
        onClick={() => openArtifact("pdf")}
        data-tip="Download filled.pdf"
        aria-label="Download filled.pdf"
      >
        {/* download glyph: tray with down arrow */}
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 2.5v7m0 0 3-3m-3 3-3-3" />
          <path d="M3 11.5v1.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1.5" />
        </svg>
      </button>
      <button
        className={`util-btn ${showStream ? "is-on" : ""}`}
        onClick={() => setShowStream(!showStream)}
        data-tip={showStream ? "Hide run details" : "Show run details"}
        aria-label="Toggle run details"
        aria-pressed={showStream}
      >
        {/* details glyph: three horizontal dots */}
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="8"   cy="8" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
        </svg>
      </button>
    </div>
  );
}

// StatusStrip was removed — the status pill now lives in the header, and every
// technical metric (counts, retries, elapsed, paths, model, run id) is
// progressively disclosed inside the right-side "Run details" panel.

// ─────────────────────────────────────────────────────────────────────────────
// Source preamble — the inputs the agent looked at

function SourceCard({ source, activeQuote }) {
  if (source.kind === "text") {
    return (
      <article className="source-card text-source">
        <header className="src-head">
          <span className="src-icon">▤</span>
          <span className="src-name">{source.label}</span>
          <span className="src-size">{source.bytes} B</span>
        </header>
        <pre className="src-body"><HighlightedText text={source.body} quote={activeQuote?.sourceId === source.id ? activeQuote.quote : null} active={true} /></pre>
      </article>
    );
  }
  // image source — render a styled ID card thumbnail in place of a JPEG
  return (
    <article className="source-card image-source">
      <header className="src-head">
        <span className="src-icon">▣</span>
        <span className="src-name">{source.label}</span>
        <span className="src-size">{(source.bytes / 1024).toFixed(0)} KB</span>
      </header>
      <IdCard data={source.thumb} />
    </article>
  );
}

function IdCard({ data }) {
  return (
    <div className="id-card">
      <div className="id-strip">{data.title}</div>
      <div className="id-sub">{data.subtitle}</div>
      <div className="id-body">
        <div className="id-photo"></div>
        <div className="id-info">
          <div><span>Name</span><b>{data.name}</b></div>
          <div><span>DOB</span><b>{data.dob}</b></div>
          <div><span>Addr</span><b>{data.addr}</b></div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Form rendering — the centerpiece

function FormPaper({ run, state, selectedField, setSelectedField, operatorEdits, setOperatorValue, clearOperatorValue, paperRef }) {
  const sections = useMemo(() => {
    const groups = new Map();
    for (const f of run.fields) {
      const meta = run.fieldMeta[f.name] || {};
      const sectionName = meta.section || "Fields";
      if (!groups.has(sectionName)) groups.set(sectionName, []);
      groups.get(sectionName).push(f);
    }
    return [...groups.entries()];
  }, [run]);

  const [pageIdx, setPageIdx] = useState(0);

  // Auto-flip to the page that contains the currently-selected field, so
  // clicking an event in the stream or a quote in the sources reveals it.
  useEffect(() => {
    if (!selectedField) return;
    const idx = sections.findIndex(([_, fields]) =>
      fields.some((f) => f.name === selectedField));
    if (idx >= 0 && idx !== pageIdx) setPageIdx(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedField, sections]);

  // Reset to the first sheet whenever the run changes.
  useEffect(() => { setPageIdx(0); }, [run]);

  // Keyboard nav — ← / → flips pages (unless the user is typing in a field).
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft")  { setPageIdx((i) => Math.max(0, i - 1)); }
      else if (e.key === "ArrowRight") { setPageIdx((i) => Math.min(sections.length - 1, i + 1)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sections.length]);

  // Per-page status — drives the colored dot on each tab and the deck nav.
  const pageStatus = useMemo(() => sections.map(([_, fields]) => {
    let blanks = 0, errors = 0, filled = 0, unsupported = 0, operator = 0;
    for (const f of fields) {
      const v = state.values[f.name];
      const err = state.errors[f.name];
      const isOp = state.operatorFilled?.has(f.name);
      if (isOp) operator++;
      if (f.kind === "unsupported") unsupported++;
      else if (err) errors++;
      else if (f.kind === "checkbox" ? v === true : v !== "") filled++;
      else blanks++;
    }
    return { total: fields.length, blanks, errors, filled, unsupported, operator };
  }), [sections, state]);

  const formIdText = `${run.formTitle.split(" — ")[1] || "Form"} · ${run.formSubtitle}`;

  return (
    <div className="paper-deck" ref={paperRef}>
      <div className="deck-stage">
        <div className="deck-stack" style={{ '--page-count': sections.length }}>
          {sections.map(([sectionName, fields], i) => {
            const offset = i - pageIdx;
            let cls = "deck-hidden-back";
            if (offset === 0) cls = "deck-front";
            else if (offset > 0 && offset <= 3) cls = "deck-behind";
            else if (offset > 3) cls = "deck-hidden-back";
            else if (offset === -1) cls = "deck-flipped";
            else cls = "deck-flipped";
            const isFront = offset === 0;
            return (
              <article
                key={sectionName}
                className={`paper ${cls}`}
                data-depth={offset}
                aria-hidden={!isFront}
                onClick={isFront ? undefined : (e) => {
                  if (offset > 0) { e.stopPropagation(); setPageIdx(i); }
                }}
              >
                <header className="form-head">
                  <div className="form-id-row">
                    <span className="form-id-text">{formIdText}</span>
                    <span className="form-page-stamp">Page {i + 1} / {sections.length}</span>
                  </div>
                  <h1 className="form-title">{run.formTitle.split(" — ")[0]}</h1>
                  <div className="form-subtitle">
                    <span style={{ fontStyle: "normal", fontFamily: "var(--serif)", fontWeight: 600, color: "var(--ink)" }}>
                      {String(i + 1).padStart(2, "0")} {sectionName}
                    </span>
                    <span style={{ marginLeft: 8 }}>
                      · {fields.length} field{fields.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                </header>
                <div className="field-grid">
                  {fields.map((f) => (
                    <FormFieldRow
                      key={f.name}
                      field={f}
                      meta={run.fieldMeta[f.name] || {}}
                      value={state.values[f.name]}
                      error={state.errors[f.name]}
                      isOperator={state.operatorFilled?.has(f.name)}
                      selected={selectedField === f.name}
                      onSelect={() => setSelectedField(selectedField === f.name ? null : f.name)}
                      setOperatorValue={setOperatorValue}
                      clearOperatorValue={clearOperatorValue}
                    />
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      </div>
      <DeckNav
        sections={sections}
        pageIdx={pageIdx}
        setPageIdx={setPageIdx}
        pageStatus={pageStatus}
      />
    </div>
  );
}

// Deck nav — prev/next arrows + a numbered tab strip with per-page status.
// Tabs are clickable to jump directly; arrows flick one sheet at a time.
function DeckNav({ sections, pageIdx, setPageIdx, pageStatus }) {
  const last = sections.length - 1;
  return (
    <nav className="deck-nav" aria-label="Form pages">
      <button
        className="deck-nav-arrow"
        onClick={() => setPageIdx(Math.max(0, pageIdx - 1))}
        disabled={pageIdx === 0}
        aria-label="Previous page"
        title="Previous page (←)"
      >←</button>
      <ol className="deck-tabs">
        {sections.map(([name, fields], i) => {
          const s = pageStatus[i];
          let statusCls = "s-ok";
          if (s.errors > 0) statusCls = "s-error";
          else if (s.unsupported > 0) statusCls = "s-warn";
          else if (s.blanks > 0) statusCls = "s-blank";
          const opCls = s.operator > 0 ? "has-operator" : "";
          const isActive = i === pageIdx;
          // Compact counts under the section name: filled/total, plus issues.
          const issues = s.errors + s.blanks + s.unsupported;
          const countsText = issues > 0
            ? `${s.filled}/${s.total} · ${issues} open`
            : `${s.filled}/${s.total}`;
          return (
            <li key={name} style={{ listStyle: "none" }}>
              <button
                className={`deck-tab ${statusCls} ${opCls} ${isActive ? "is-active" : ""}`}
                onClick={() => setPageIdx(i)}
                aria-current={isActive ? "page" : undefined}
                title={`Page ${i + 1}: ${name}`}
              >
                <div className="tab-row">
                  <span className="tab-num">{String(i + 1).padStart(2, "0")}</span>
                  <span className="tab-name">{name}</span>
                  <span className="tab-status" aria-hidden="true"></span>
                </div>
                <span className="tab-counts">{countsText}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <button
        className="deck-nav-arrow"
        onClick={() => setPageIdx(Math.min(last, pageIdx + 1))}
        disabled={pageIdx === last}
        aria-label="Next page"
        title="Next page (→)"
      >→</button>
    </nav>
  );
}

function FormFieldRow({ field, meta, value, error, isOperator, selected, onSelect, setOperatorValue, clearOperatorValue }) {
  const isUnsupported = field.kind === "unsupported";
  const isCheckbox = field.kind === "checkbox";
  const isBlank = !isUnsupported && (isCheckbox ? value === false : value === "");
  const isFilled = !isBlank && !isUnsupported;
  const hasError = !!error;
  const width = meta.width || "wide";
  const tweaks = window.__scribeTweaks || {};
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef(null);

  const beginEdit = () => {
    if (isCheckbox) {
      // Checkboxes toggle directly; no inline input needed.
      setOperatorValue(field.name, !value);
      return;
    }
    setDraft(value || "");
    setEditing(true);
  };

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      if (inputRef.current.select) inputRef.current.select();
    }
  }, [editing]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      // Empty commit removes any operator edit, reverting to agent state.
      clearOperatorValue(field.name);
    } else {
      setOperatorValue(field.name, trimmed);
    }
    setEditing(false);
  };
  const cancel = () => setEditing(false);

  const onKey = (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  };

  const handleClick = (e) => {
    e.stopPropagation();
    onSelect();
    // One click selects + enters edit mode in one motion. The form is a
    // form; click it to write. Hold shift to just inspect without editing.
    if (!editing && !e.shiftKey) beginEdit();
  };

  const classNames = [
    "field",
    `kind-${field.kind}`,
    `w-${width}`,
    isFilled && "is-filled",
    isBlank && "is-blank",
    isUnsupported && "is-unsupported",
    hasError && "is-error",
    selected && "is-selected",
    isOperator && "is-operator-filled",
    editing && "is-editing",
  ].filter(Boolean).join(" ");

  // Dropdown options pulled from field schema (if present).
  const options = field.kind === "dropdown" ? (field.options || meta.options || []) : null;

  return (
    <div data-field={field.name} className={classNames} onClick={handleClick}>
      <div className="field-label">
        <span className="label-text">{meta.label || field.name}</span>
        {tweaks.showFieldNames && <span className="field-name">{field.name}</span>}
      </div>
      <div className="field-box">
        {isCheckbox ? (
          <>
            <span className="check-box">
              {value === true && <span className="check-mark">✓</span>}
            </span>
            <span className="agent-value" style={{ fontSize: 13 }}>
              {value === true ? "Yes" : ""}
            </span>
          </>
        ) : editing && field.kind === "dropdown" && options && options.length > 0 ? (
          <select
            ref={inputRef}
            className="field-input kind-dropdown"
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setOperatorValue(field.name, e.target.value); setEditing(false); }}
            onBlur={() => setEditing(false)}
            onClick={(e) => e.stopPropagation()}
          >
            <option value="">— select —</option>
            {options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : editing ? (
          <input
            ref={inputRef}
            type="text"
            className="field-input"
            value={draft}
            placeholder={meta.hint || "—"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            onBlur={commit}
            onClick={(e) => e.stopPropagation()}
          />
        ) : field.kind === "dropdown" ? (
          <>
            <span className="agent-value">
              {value ? value : <em className="blank-placeholder">{meta.hint || "— select one —"}</em>}
            </span>
            <span className="dropdown-caret">▾</span>
          </>
        ) : isUnsupported ? (
          <span className="unsupported-mark">{value ? value : "signature widget"}</span>
        ) : (
          <span className="agent-value">
            {value ? value : <em className="blank-placeholder">{meta.hint ? meta.hint : "—"}</em>}
          </span>
        )}
      </div>
      {isOperator && !editing && <span className="field-byline">your edit</span>}
      {(hasError || isBlank || isUnsupported) && !isOperator && <span className="field-status-dot" />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Source panel (left column) — sources stacked, with quote highlighting.

function SourcePanel({ run, state, activeQuote, finishVisible, openArtifact, extraSources, addSource }) {
  const total = run.sources.length + extraSources.length;
  return (
    <section className="col-sources">
      <div className="sources">
        {run.sources.map((src) => (
          <SourceCard key={src.id} source={src} activeQuote={activeQuote} />
        ))}
        {extraSources.map((src) => (
          <ExtraSourceCard key={src.id} source={src} />
        ))}
      </div>
      <FinishCard
        run={run}
        state={state}
        finishVisible={finishVisible}
        openArtifact={openArtifact}
      />
      {finishVisible && <AddSourceCard onAdd={addSource} run={run} state={state} />}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Add-source card — a blank dashed sheet at the bottom of the source stack.
// Click / paste / drop a file. Submit hands it to the scribe as a new source.

function AddSourceCard({ onAdd, run, state }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [files, setFiles] = useState([]);
  const [dragging, setDragging] = useState(false);
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const rootRef = useRef(null);

  useEffect(() => {
    if (open && taRef.current) taRef.current.focus();
    if (open && rootRef.current) {
      // Scroll the sources column so the open card is fully visible.
      const scroller = rootRef.current.closest(".col-sources");
      if (scroller) {
        requestAnimationFrame(() => {
          scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
        });
      }
    }
  }, [open]);

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    setOpen(true);
    const dropped = Array.from(e.dataTransfer?.files || []);
    if (dropped.length) {
      setFiles((cur) => [...cur, ...dropped]);
    }
    const pastedText = e.dataTransfer?.getData?.("text/plain");
    if (pastedText) {
      setText((t) => t ? `${t}\n\n${pastedText}` : pastedText);
    }
  };

  const canSubmit = text.trim().length > 0 || files.length > 0;
  const cancel = () => { setOpen(false); setText(""); setFiles([]); };
  const submit = () => {
    if (!canSubmit) return;
    onAdd({
      id: `op-src-${Date.now()}`,
      text: text.trim(),
      files: files.map((f) => ({ name: f.name, size: f.size })),
      ts: new Date(),
    });
    setText(""); setFiles([]); setOpen(false);
  };

  const onKey = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  const onPickFiles = (e) => {
    const picked = Array.from(e.target.files || []);
    if (picked.length) setFiles((cur) => [...cur, ...picked]);
    e.target.value = "";
  };

  // Contextual prompt: when the finish summary flagged blanks/unsupported,
  // nudge the operator that more source material might help.
  const blanksCount = useMemo(() => {
    if (!run || !state) return 0;
    return run.fields.filter((f) => {
      if (f.kind === "unsupported") return false;
      const v = state.values[f.name];
      return f.kind === "checkbox" ? v === false : v === "";
    }).length;
  }, [run, state]);
  const collapsedTitle = blanksCount > 0
    ? `Missing info? Hand the scribe another source.`
    : `Hand the scribe more text`;
  const collapsedSub = blanksCount > 0
    ? `${blanksCount} field${blanksCount !== 1 ? "s" : ""} left blank · paste, drop, or type below`
    : `paste an email, drop a file, or type — the scribe re-reads with it`;

  // Collapsed: a blank sheet of paper waiting below the finish summary.
  if (!open) {
    return (
      <div
        ref={rootRef}
        className={`source-add ${dragging ? "drag-over" : ""}`}
        onClick={() => setOpen(true)}
        onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={(e) => {
          if (rootRef.current && !rootRef.current.contains(e.relatedTarget)) setDragging(false);
        }}
        onDrop={handleDrop}
      >
        <div className="source-add-head">
          <span className="source-add-glyph">+</span>
          <span>{collapsedTitle}</span>
        </div>
        <div className="source-add-sub">{collapsedSub}</div>
      </div>
    );
  }

  // Expanded: a fresh sheet the operator writes on.
  return (
    <div
      ref={rootRef}
      className="source-add is-open"
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      <div className="source-add-head">
        <span className="source-add-glyph">✎</span>
        <span>New source</span>
        <button className="source-add-close" onClick={cancel} aria-label="Cancel">✕</button>
      </div>
      <textarea
        ref={taRef}
        placeholder="Paste an email, a transcript, a note — anything the scribe should read alongside the existing sources."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      {files.length > 0 && (
        <div className="source-add-attached">
          {files.map((f, i) => (
            <span key={i} className="source-add-clip">
              📎 {f.name}
              <button onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))} aria-label="Remove">✕</button>
            </span>
          ))}
        </div>
      )}
      <div className="source-add-foot">
        <button className="source-add-attach" onClick={() => fileRef.current?.click()}>
          <span className="glyph">+</span> attach file
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={onPickFiles}
        />
        <span className="source-add-hint"><kbd>⌘</kbd><kbd>↵</kbd> to hand off</span>
        <button className="source-add-submit" disabled={!canSubmit} onClick={submit}>
          Hand to scribe <span style={{ fontFamily: "var(--mono)" }}>→</span>
        </button>
      </div>
    </div>
  );
}

// A source card the operator just added. Same paper as agent sources, blue-ink
// edge for the audit trail, plus a brief "scribing…" state right after add.
function ExtraSourceCard({ source }) {
  const [running, setRunning] = useState(true);
  useEffect(() => {
    const id = setTimeout(() => setRunning(false), 1800);
    return () => clearTimeout(id);
  }, [source.id]);
  const time = source.ts instanceof Date
    ? source.ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";
  const label = source.text
    ? `Pasted text · ${time}`
    : source.files.length === 1
      ? source.files[0].name
      : `${source.files.length} files · ${time}`;
  const bytes = (source.text?.length || 0) + source.files.reduce((s, f) => s + (f.size || 0), 0);
  return (
    <article className="source-card is-from-operator">
      <header className="src-head">
        <span className="src-icon">✎</span>
        <span className="src-name">{label}</span>
        <span className={`src-rerun ${running ? "is-running" : ""}`}>
          {running ? <><span className="spinner"></span> scribing…</> : <>read · added to run</>}
        </span>
      </header>
      {source.text && (
        <pre className="src-body">{source.text.length > 400 ? source.text.slice(0, 400) + "…" : source.text}</pre>
      )}
      {source.files.length > 0 && (
        <div className="src-attachments">
          {source.files.map((f, i) => (
            <span key={i} className="clip">📎 {f.name}</span>
          ))}
        </div>
      )}
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Form column (middle) — the filled PDF + finish summary below it.

function FormColumn({ run, state, selectedField, setSelectedField, operatorEdits, setOperatorValue, clearOperatorValue }) {
  return (
    <section className="col-form">
      <div className="paper-wrap">
        <FormPaper
          run={run}
          state={state}
          selectedField={selectedField}
          setSelectedField={setSelectedField}
          operatorEdits={operatorEdits}
          setOperatorValue={setOperatorValue}
          clearOperatorValue={clearOperatorValue}
        />
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Event stream (right column) — chronological tool-call timeline.

function EventStream({ run, state, scrubIndex, selectedField, setSelectedField, openPdfViewer, openArtifact, showFieldNames, setShowFieldNames }) {
  const listRef = useRef(null);
  // Sub-disclosures inside the details panel — most users will never open
  // these. Defaults: stream open (it's the headline of the panel), the rest
  // collapsed.
  const [openStream, setOpenStream] = useState(true);
  const [openMeta, setOpenMeta] = useState(false);
  const [openLegend, setOpenLegend] = useState(false);

  // When a field is selected, scroll the matching event card into view.
  useEffect(() => {
    if (!selectedField || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-field-event="${selectedField}"]`);
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [selectedField]);

  // Compute blank + unsupported fields (operator-action items).
  const blanks = run.fields.filter((f) => {
    if (f.kind === "unsupported") return false;
    const v = state.values[f.name];
    return f.kind === "checkbox" ? v === false : v === "";
  });
  const unsupported = run.fields.filter((f) => f.kind === "unsupported");

  // Tally metrics for the run-info block.
  const setFieldCalls = run.toolCalls.filter((t) => t.name === "set_field");
  const errCalls = setFieldCalls.filter((t) => t.result.startsWith("error:"));
  const filled = run.fields.filter((f) => {
    const v = state.values[f.name];
    return f.kind === "checkbox" ? v === true : v !== "" && v !== false;
  }).length;

  return (
    <section className="col-events" ref={listRef}>
      <header className="col-head">
        <span>Run details</span>
        <span className="count">technical · for debugging</span>
      </header>

      {/* Run metadata — paths, model, run id, elapsed. Collapsed by default. */}
      <details className="rd-block" open={openMeta} onToggle={(e) => setOpenMeta(e.target.open)}>
        <summary className="rd-summary">
          <span className="rd-caret">▸</span>
          <span className="rd-title">Run metadata</span>
          <span className="rd-hint">{run.model} · {fmtMs(run.elapsedMs)}</span>
        </summary>
        <div className="rd-body">
          <dl className="rd-dl">
            <dt>input</dt><dd><code>{run.formPath}</code></dd>
            <dt>output</dt><dd><code>{run.outPath}</code></dd>
            <dt>model</dt><dd><code>{run.model}</code></dd>
            <dt>run id</dt><dd><code>{run.runId}</code></dd>
            <dt>elapsed</dt><dd><code>{fmtMs(run.elapsedMs)}</code></dd>
            <dt>written</dt><dd><code>{filled} / {run.fields.length}</code></dd>
            {blanks.length > 0 && <><dt>blank</dt><dd><code>{blanks.length}</code></dd></>}
            {unsupported.length > 0 && <><dt>unsupported</dt><dd><code>{unsupported.length}</code></dd></>}
            {errCalls.length > 0 && <><dt>retries</dt><dd><code>{errCalls.length}</code></dd></>}
          </dl>
          <div className="rd-actions">
            <button className="event-action" onClick={() => openArtifact("transcript")}>
              <span>↓</span> transcript.json
            </button>
            <label className="rd-toggle">
              <input
                type="checkbox"
                checked={!!showFieldNames}
                onChange={(e) => setShowFieldNames(e.target.checked)}
              />
              <span>Show field-name codes on form</span>
            </label>
          </div>
        </div>
      </details>

      {/* Legend — what the dots and colors mean. */}
      <details className="rd-block" open={openLegend} onToggle={(e) => setOpenLegend(e.target.open)}>
        <summary className="rd-summary">
          <span className="rd-caret">▸</span>
          <span className="rd-title">Legend</span>
        </summary>
        <div className="rd-body">
          <div className="legend">
            <span className="legend-item"><span className="legend-swatch ls-amber"></span> agent write</span>
            <span className="legend-item"><span className="legend-swatch ls-err"></span> error</span>
            <span className="legend-item"><span className="legend-swatch ls-warn"></span> unsupported widget</span>
            <span className="legend-item"><span className="legend-swatch ls-blank"></span> blank</span>
          </div>
        </div>
      </details>

      {/* Tool-call stream — the meat of the panel; open by default. */}
      <details className="rd-block rd-stream" open={openStream} onToggle={(e) => setOpenStream(e.target.open)}>
        <summary className="rd-summary">
          <span className="rd-caret">▸</span>
          <span className="rd-title">Tool-call stream</span>
          <span className="rd-hint">{run.toolCalls.length} calls</span>
        </summary>
        <div className="rd-body">

      <ol className="stream-list">
        {run.toolCalls.map((tc, i) => (
          <StreamItem
            key={tc.id}
            tc={tc}
            step={i}
            run={run}
            isCurrent={scrubIndex === i}
            isSelected={tc.name === "set_field" && tc.arguments.name === selectedField}
            onFieldClick={(name) => setSelectedField(name === selectedField ? null : name)}
            openPdfViewer={openPdfViewer}
          />
        ))}
      </ol>

        </div>
      </details>

      {(blanks.length > 0 || unsupported.length > 0) && (
        <>
          {blanks.length > 0 && (
            <div className="stream-sub">
              <div className="stream-sub-head">
                <span className="dot" style={{ background: "var(--ink-faint)" }}></span>
                Listed but never written · {blanks.length}
              </div>
              {blanks.map((f) => (
                <div
                  key={f.name}
                  className="stream-sub-row"
                  data-field-event={f.name}
                  onClick={() => setSelectedField(f.name === selectedField ? null : f.name)}
                >
                  <code>{f.name}</code>
                  <span className="reason">
                    <b>{run.fieldMeta[f.name]?.label || f.name}</b> — left blank by the agent. See finish summary for why.
                  </span>
                  <button className="event-action" onClick={(e) => { e.stopPropagation(); openPdfViewer(f.name); }}>
                    Fill in viewer →
                  </button>
                </div>
              ))}
            </div>
          )}
          {unsupported.length > 0 && (
            <div className="stream-sub warn">
              <div className="stream-sub-head">
                <span className="dot" style={{ background: "var(--warn)" }}></span>
                Unsupported widgets · {unsupported.length}
              </div>
              {unsupported.map((f) => (
                <div
                  key={f.name}
                  className="stream-sub-row"
                  data-field-event={f.name}
                  onClick={() => setSelectedField(f.name === selectedField ? null : f.name)}
                >
                  <code>{f.name}</code>
                  <span className="reason">
                    <b>{run.fieldMeta[f.name]?.label || f.name}</b> — {f.kind} widget. pdf-lib cannot write; must be filled in a viewer.
                  </span>
                  <button className="event-action primary" onClick={(e) => { e.stopPropagation(); openPdfViewer(f.name); }}>
                    Open in viewer →
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

// One event card inside the stream.
function StreamItem({ tc, step, run, isCurrent, isSelected, onFieldClick, openPdfViewer }) {
  const isError = tc.result.startsWith("error:");
  const isMeta = tc.name === "list_fields" || tc.name === "finish";
  const fieldName = tc.arguments?.name;
  const cls = [
    "stream-item",
    isError && "is-error",
    isMeta && "is-meta",
    isCurrent && "is-current",
    isSelected && "is-selected",
  ].filter(Boolean).join(" ");
  return (
    <li className={cls} data-field-event={fieldName || undefined}>
      <span className="stream-step">#{String(step + 1).padStart(2, "0")}</span>
      <div className="stream-tick"><div className="stream-dot"></div></div>
      <div
        className="stream-content"
        onClick={() => {
          if (fieldName) onFieldClick(fieldName);
        }}
      >
        <div className="stream-row">
          <code className="stream-tool">{tc.name}</code>
          {fieldName && (
            <code className="stream-field-pill">{fieldName}</code>
          )}
          <span className="stream-time">t={fmtMs(tc.tMs)}</span>
        </div>
        {tc.name === "set_field" && (
          <div className="stream-args">
            <span className="arg-key">value</span>: {(() => {
              const v = tc.arguments.value;
              if (typeof v === "string") return <span className="arg-val s">{`"${v}"`}</span>;
              if (typeof v === "boolean") return <span className="arg-val b">{String(v)}</span>;
              if (typeof v === "number") return <span className="arg-val n">{v}</span>;
              return <span className="arg-val">{JSON.stringify(v)}</span>;
            })()}
          </div>
        )}
        {tc.name === "list_fields" && (
          <div className="stream-args">
            <span className="arg-key">→</span> returned <b style={{fontFamily:"var(--mono)",fontSize:11}}>{JSON.parse(tc.result).length}</b> field{JSON.parse(tc.result).length !== 1 ? "s" : ""}
            <span style={{color: "var(--ink-faint)", marginLeft: 8}}>
              {JSON.parse(tc.result).map(f => f.name).join(", ")}
            </span>
          </div>
        )}
        {tc.name === "finish" && (
          <div className="stream-args" style={{ fontFamily: "var(--serif)", fontStyle: "italic", color: "var(--ink-soft)", fontSize: 12 }}>
            {tc.arguments.summary.length > 120
              ? tc.arguments.summary.slice(0, 120) + "…"
              : tc.arguments.summary}
          </div>
        )}
        {(isError || isCurrent || isSelected || tc.name === "finish") && (
          <div className={`stream-result ${isError ? "is-error" : "is-ok"}`}>
            {tc.result.length > 160 ? tc.result.slice(0, 160) + "…" : tc.result}
          </div>
        )}
        {isError && (() => {
          // recovery hint — was there a successful retry on a later step?
          const nextOk = run.toolCalls.findIndex(
            (t, i) => i > step && t.name === "set_field" && t.arguments.name === fieldName && t.result.startsWith("ok:")
          );
          const correctedFakeName = isError && /no field named/.test(tc.result);
          if (nextOk >= 0) {
            return (
              <div className="stream-recover">
                <span>Recovered on step #{String(nextOk + 1).padStart(2, "0")}.</span>
              </div>
            );
          }
          if (correctedFakeName) {
            return (
              <div className="stream-recover">
                <span>No form change. Agent wrote the correct field on a later call.</span>
              </div>
            );
          }
          return (
            <div className="stream-recover recover-error">
              <a onClick={(e) => { e.stopPropagation(); openPdfViewer(fieldName); }}>
                Open in PDF viewer to edit by hand →
              </a>
            </div>
          );
        })()}
      </div>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Finish summary

function FinishCard({ run, state, finishVisible, openArtifact }) {
  if (!finishVisible) return null;
  const finishCall = run.toolCalls.find((t) => t.name === "finish");
  const setFieldErrors = run.toolCalls.filter((t) => t.name === "set_field" && t.result.startsWith("error:")).length;
  const blanks = run.fields.filter((f) => {
    if (f.kind === "unsupported") return false;
    const v = state.values[f.name];
    return f.kind === "checkbox" ? v === false : v === "";
  }).length;
  const mixed = setFieldErrors > 0 || blanks > 0 || run.fields.some(f => f.kind === "unsupported");

  return (
    <aside className={`finish-card ${mixed ? "mixed" : ""}`}>
      <div className="finish-head">
        <span className="finish-tag">finish.summary</span>
        <span className="finish-author">— agent's note</span>
      </div>
      <p className="finish-summary">{finishCall.arguments.summary}</p>
    </aside>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Recovery modal — opens when the operator clicks "Open in PDF viewer". This
// stands in for the user's real PDF viewer; the UI does NOT write back to the
// engine — edits land in the interactive PDF on disk.

function PdfViewerModal({ run, fieldName, onClose }) {
  if (!fieldName) return null;
  const field = run.fields.find((f) => f.name === fieldName);
  const meta = run.fieldMeta[fieldName] || {};
  const isSig = field.kind === "unsupported";
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="pdf-viewer" onClick={(e) => e.stopPropagation()}>
        <header className="pdf-vw-head">
          <span>PDF Viewer · system default</span>
          <code>{run.outPath}#field={fieldName}</code>
          <button className="close" onClick={onClose}>✕</button>
        </header>
        <div className="pdf-vw-body">
          <div className="note">
            Scribe writes the filled PDF without flattening, so every widget stays
            interactive. Edits you make here are saved to the file on disk — they do
            <b> not</b> flow back to the agent.
          </div>
          <label>{meta.label || fieldName}{" "}
            <code style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-faint)", marginLeft: 4 }}>{fieldName}</code>
          </label>
          {isSig ? (
            <div className="sig-pad">Click and drag to sign</div>
          ) : (
            <input type="text" defaultValue={field.currentValue || ""} placeholder={meta.hint || ""} autoFocus />
          )}
          <p style={{ marginTop: 18, color: "var(--ink-mute)", fontSize: 12, fontFamily: "var(--sans)" }}>
            Showing the field your viewer would jump to. In the real environment, your OS PDF reader opens; this dialog is a stand-in.
          </p>
        </div>
        <footer className="pdf-vw-foot">
          <button className="hbtn" style={{ background: "transparent", color: "var(--ink)", border: "1px solid var(--rule)" }} onClick={onClose}>Cancel</button>
          <button className="hbtn primary" style={{ background: "var(--ink)", color: "var(--paper)", border: "1px solid var(--ink)" }} onClick={onClose}>Save to file</button>
        </footer>
      </div>
    </div>
  );
}

// Artifact download / open — toy stand-in: pop a small toast.
function useArtifactSink() {
  const [toast, setToast] = useState(null);
  const open = useCallback((kind, run) => {
    const msg =
      kind === "pdf" ? `↓ ${run.outPath}` :
      kind === "transcript" ? `↓ ${run.transcriptPath}` :
      kind === "viewer" ? `Opening ${run.outPath} in your PDF viewer…` :
      "—";
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  }, []);
  return [toast, open];
}

function Toast({ msg }) {
  if (!msg) return null;
  return (
    <div style={{
      position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
      background: "oklch(0.16 0.012 75)", color: "var(--paper)",
      padding: "10px 16px", borderRadius: 6,
      fontFamily: "var(--mono)", fontSize: 12,
      boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
      zIndex: 100,
    }}>{msg}</div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Floating "your edits" pill — only visible when the operator has written
// something on the form. Lives at the bottom-right, doesn't take a row.

function EditsPill({ operatorEdits, clearAllOperatorEdits }) {
  const count = Object.keys(operatorEdits).length;
  if (count === 0) return null;
  return (
    <div className="edits-pill" role="status">
      <span className="edits-pill-count">{count}</span>
      <span className="edits-pill-label">your edit{count !== 1 ? "s" : ""}</span>
      <button className="edits-pill-undo" onClick={clearAllOperatorEdits}>undo all</button>
      <button className="edits-pill-save">Save to PDF</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// App

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  // Stash tweaks for FormFieldRow to read without prop-drilling.
  window.__scribeTweaks = t;
  const run = window.RUNS[t.variant];
  const [selectedField, setSelectedField] = useState(null);
  const [scrubIndex] = useState(run.toolCalls.length - 1);
  const [extraSources, setExtraSources] = useState([]);
  const addSource = useCallback((src) => {
    setExtraSources((xs) => [...xs, src]);
  }, []);

  const [pdfViewerField, setPdfViewerField] = useState(null);
  // operatorEdits: { [fieldName]: value } — direct in-place writes by the
  // operator. Layered on top of the agent's transcript state.
  const [operatorEdits, setOperatorEdits] = useState({});
  const [toast, openArtifact] = useArtifactSink();

  const setOperatorValue = useCallback((name, value) => {
    setOperatorEdits((e) => ({ ...e, [name]: value }));
  }, []);
  const clearOperatorValue = useCallback((name) => {
    setOperatorEdits((e) => {
      const n = { ...e };
      delete n[name];
      return n;
    });
  }, []);
  const clearAllOperatorEdits = useCallback(() => setOperatorEdits({}), []);

  // Reset state when the variant changes.
  useEffect(() => {
    setSelectedField(null);
    setOperatorEdits({});
    setExtraSources([]);
  }, [t.variant]);

  // The design is built for 1440-1920px desktop viewports. On narrower
  // viewports (preview panes, small laptops) zoom-to-fit so the whole
  // three-column workbench stays visible without breaking the layout.
  useEffect(() => {
    const DESIGN_W = 1280;
    const fit = () => {
      const z = Math.min(1, window.innerWidth / DESIGN_W);
      document.documentElement.style.zoom = z;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const baseState = useMemo(() => deriveStateAt(run, scrubIndex), [run, scrubIndex]);
  // Layer operator edits over the agent's state so the rest of the UI just
  // sees one combined view. We also track which field names came from the
  // operator so the form can render them in blue ink.
  const state = useMemo(() => {
    const values = { ...baseState.values };
    const operatorFilled = new Set();
    for (const [name, v] of Object.entries(operatorEdits)) {
      values[name] = v;
      operatorFilled.add(name);
    }
    return { ...baseState, values, operatorFilled };
  }, [baseState, operatorEdits]);
  const finishVisible = state.finishAt >= 0;
  const activeQuote = selectedField ? run.evidence[selectedField] : null;

  return (
    <>
      <UtilBar
        openArtifact={(k) => openArtifact(k, run)}
        showStream={t.showStream}
        setShowStream={(v) => setTweak("showStream", v)}
      />

      <main className={`workbench ${t.showStream ? "with-stream" : ""}`}>
        <SourcePanel
          run={run}
          state={state}
          activeQuote={activeQuote}
          finishVisible={finishVisible}
          openArtifact={(k) => openArtifact(k, run)}
          extraSources={extraSources}
          addSource={addSource}
        />
        <FormColumn
          run={run}
          state={state}
          selectedField={selectedField}
          setSelectedField={setSelectedField}
          operatorEdits={operatorEdits}
          setOperatorValue={setOperatorValue}
          clearOperatorValue={clearOperatorValue}
        />
        {t.showStream && (
          <EventStream
            run={run}
            state={state}
            scrubIndex={scrubIndex}
            selectedField={selectedField}
            setSelectedField={setSelectedField}
            openPdfViewer={setPdfViewerField}
            openArtifact={(k) => openArtifact(k, run)}
            showFieldNames={t.showFieldNames}
            setShowFieldNames={(v) => setTweak("showFieldNames", v)}
          />
        )}
      </main>

      <EditsPill
        operatorEdits={operatorEdits}
        clearAllOperatorEdits={clearAllOperatorEdits}
      />

      <PdfViewerModal run={run} fieldName={pdfViewerField} onClose={() => setPdfViewerField(null)} />
      <Toast msg={toast} />

      <TweaksPanel>
        <TweakSection label="Run">
          <TweakRadio
            label="Variant"
            value={t.variant}
            options={[{ value: "ok", label: "all ok" }, { value: "exceptions", label: "exceptions" }]}
            onChange={(v) => setTweak("variant", v)}
          />
        </TweakSection>
      </TweaksPanel>
    </>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
