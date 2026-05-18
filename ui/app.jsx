// app.jsx — Scribe operator review surface.
//
// The engine writes two artifacts to disk and exits; this UI replays them:
//   - out/e2e-filled.transcript.json   (tool-call log)
//   - out/e2e-filled.pdf               (rendered via pdf.js, not mocked)
//   - fixtures/sample-notes.txt        (source the agent read)
//
// What's new vs the original review surface:
//   1. Inline edits on the filled PDF — operator overrides layer on top of the
//      agent's writes, and a Save-to-PDF button uses pdf-lib (in-browser) to
//      apply them to a downloadable PDF.
//   2. Per-field screenshot snippets — for each set_field call, a small canvas
//      crop around the field rect is rendered next to the event so operators
//      can verify the agent edited what they think it did (defends against
//      AcroForm field-name salad).
//   3. Add-source affordance — operator can hand the scribe a new note. We
//      stage it in-UI and emit a copy-paste CLI command to re-run the engine
//      (the agent itself is not invoked from this surface).

const { useState, useEffect, useMemo, useRef, useCallback } = React;

const TRANSCRIPT_URL = "/out/e2e-filled.transcript.json";
const PDF_URL = "/out/e2e-filled.pdf";
const NOTES_URL = "/fixtures/sample-notes.txt";

function getPdfjs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  return new Promise((resolve) => {
    const check = () => { if (window.pdfjsLib) resolve(window.pdfjsLib); else setTimeout(check, 30); };
    check();
  });
}

function parseFieldCatalog(toolCalls) {
  const list = toolCalls.find((t) => t.name === "list_fields");
  if (!list) return [];
  try { return JSON.parse(list.result); } catch { return []; }
}

// Replay transcript up to scrubIndex (inclusive). Returns the per-field value
// the agent left behind, plus the last error and the events bucketed by name.
function deriveStateAt(fields, toolCalls, scrubIndex) {
  const values = {};
  const errors = {};
  const events = {};
  for (const f of fields) {
    values[f.name] = f.kind === "checkbox" ? false : "";
    events[f.name] = [];
  }
  let finishAt = -1;
  for (let i = 0; i <= Math.min(scrubIndex, toolCalls.length - 1); i++) {
    const tc = toolCalls[i];
    if (tc.name === "set_field") {
      const fname = tc.arguments.name;
      const isErr = tc.result.startsWith("error:");
      if (!events[fname]) events[fname] = [];
      events[fname].push({ step: i, tc });
      if (!isErr) { values[fname] = tc.arguments.value; delete errors[fname]; }
      else errors[fname] = tc.result;
    } else if (tc.name === "finish") finishAt = i;
  }
  return { values, errors, events, finishAt };
}

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

// ─────────────────────────────────────────────────────────────────────────────
// UtilBar — floating top-right: download filled.pdf, toggle run-details panel.

function UtilBar({ downloadPdf, showStream, setShowStream }) {
  return (
    <div className="util-bar" role="toolbar" aria-label="Run actions">
      <button className="util-btn" onClick={downloadPdf} data-tip="Download filled.pdf" aria-label="Download filled.pdf">
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
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
        </svg>
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF render + editable field overlays + snippet capture.

// Crop a region of the canvas around a field rect, with padding. The padding
// gives operator-recognizable context (the label next to the field is what
// proves the agent wrote into the right widget).
function cropCanvas(srcCanvas, rect, pad) {
  const x = Math.max(0, Math.floor(rect.left - pad));
  const y = Math.max(0, Math.floor(rect.top - pad));
  const w = Math.min(srcCanvas.width - x, Math.ceil(rect.width + pad * 2));
  const h = Math.min(srcCanvas.height - y, Math.ceil(rect.height + pad * 2));
  if (w <= 0 || h <= 0) return null;
  const off = document.createElement("canvas");
  off.width = w; off.height = h;
  off.getContext("2d").drawImage(srcCanvas, x, y, w, h, 0, 0, w, h);
  return off.toDataURL("image/png");
}

function PdfPage({
  pdfDoc, pageNum, fields, state, selectedField, setSelectedField,
  setOperatorValue, clearOperatorValue, onSnippets, snippetPadding,
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [rects, setRects] = useState({});
  const [pageSize, setPageSize] = useState({ w: 612, h: 792 });
  const [editing, setEditing] = useState(null); // field name being edited
  const [draft, setDraft] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;
    (async () => {
      const page = await pdfDoc.getPage(pageNum);
      // Pick a render scale that fills the paper width — overlays are
      // positioned in canvas pixel space, so scaling the canvas after the
      // fact would also need a CSS transform on overlays. Rendering at the
      // right scale up front is simpler and crisper.
      const paperW = containerRef.current?.parentElement?.clientWidth || 612;
      const base = page.getViewport({ scale: 1 });
      const scale = Math.max(0.6, paperW / base.width);
      const viewport = page.getViewport({ scale });
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = viewport.width; canvas.height = viewport.height;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const ctx = canvas.getContext("2d");
      try { await page.render({ canvasContext: ctx, viewport }).promise; }
      catch (e) { console.warn("[scribe-ui] render threw:", e.message); return; }

      // Extract rects for fields that live on THIS page. getFieldObjects
      // returns parent + kid widgets; the kid carries the rect and `page`.
      const fieldObjects = await pdfDoc.getFieldObjects();
      const next = {};
      if (fieldObjects) {
        for (const [name, objs] of Object.entries(fieldObjects)) {
          const obj = objs.find((o) => Array.isArray(o.rect) && (o.page === pageNum - 1 || o.page === undefined));
          if (!obj) continue;
          const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(obj.rect);
          next[name] = {
            left: Math.min(x1, x2),
            top: Math.min(y1, y2),
            width: Math.abs(x2 - x1),
            height: Math.abs(y2 - y1),
          };
        }
      }
      if (cancelled) return;
      setPageSize({ w: viewport.width, h: viewport.height });
      setRects(next);

      // Snippet capture — once per render, crop around each field rect and
      // emit dataURLs up to the App so the event stream can display them.
      const snippets = {};
      for (const [name, r] of Object.entries(next)) {
        const url = cropCanvas(canvas, r, snippetPadding);
        if (url) snippets[name] = url;
      }
      onSnippets(snippets);
    })().catch((err) => console.error("pdf.js render failed", err));
    return () => { cancelled = true; };
  }, [pdfDoc, pageNum, onSnippets, snippetPadding]);

  // Focus the inline edit input when it opens.
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      if (inputRef.current.select) inputRef.current.select();
    }
  }, [editing]);

  const beginEdit = (f) => {
    if (f.kind === "checkbox") {
      const cur = state.values[f.name];
      setOperatorValue(f.name, !cur);
      return;
    }
    if (f.kind === "unsupported") return;
    setDraft(state.values[f.name] || "");
    setEditing(f.name);
  };

  const commit = (name) => {
    const t = draft.trim();
    if (t === "") clearOperatorValue(name);
    else setOperatorValue(name, t);
    setEditing(null);
  };

  return (
    <div ref={containerRef} className="pdf-page" style={{ width: pageSize.w, height: pageSize.h, position: "relative" }}>
      <canvas ref={canvasRef} style={{ display: "block" }} />
      {fields.map((f) => {
        const r = rects[f.name];
        if (!r) return null;
        const v = state.values[f.name];
        const isOp = state.operatorFilled?.has(f.name);
        const err = !!state.errors[f.name];
        const filled = f.kind === "checkbox" ? v === true : v !== "" && v != null;
        const selected = selectedField === f.name;
        const cls = [
          "pdf-field-overlay",
          f.kind === "unsupported" && "is-unsupported",
          isOp && "is-operator",
          !isOp && filled && "is-filled",
          !isOp && !filled && !err && "is-blank",
          err && "is-error",
          selected && "is-selected",
        ].filter(Boolean).join(" ");
        const isEditing = editing === f.name;
        const options = f.kind === "dropdown" ? (f.options || []) : null;

        return (
          <div
            key={f.name}
            data-field={f.name}
            className={cls}
            style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
            onClick={(e) => {
              e.stopPropagation();
              setSelectedField(selected ? null : f.name);
              if (!isEditing && !e.shiftKey) beginEdit(f);
            }}
            title={f.name}
          >
            {isEditing && options ? (
              <select
                ref={inputRef}
                className="pdf-field-input kind-dropdown"
                value={draft}
                onChange={(e) => { setOperatorValue(f.name, e.target.value); setEditing(null); }}
                onBlur={() => setEditing(null)}
                onClick={(e) => e.stopPropagation()}
              >
                <option value="">—</option>
                {options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : isEditing ? (
              <input
                ref={inputRef}
                type="text"
                className="pdf-field-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commit(f.name); }
                  else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                }}
                onBlur={() => commit(f.name)}
                onClick={(e) => e.stopPropagation()}
              />
            ) : isOp && f.kind !== "checkbox" ? (
              // Operator overrode the canvas-baked value. Draw the new value
              // over the field so the operator can see what they wrote.
              <span className="pdf-field-input" style={{ display: "flex", alignItems: "center", pointerEvents: "none" }}>
                {String(v ?? "")}
              </span>
            ) : null}
            {isOp && !isEditing && <span className="pdf-field-byline">your edit</span>}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Paper deck — one paper card per PDF page. For single-page PDFs the deck has
// one tab; deck nav is hidden in that case.

function PaperDeck({
  pdfDoc, fields, state, selectedField, setSelectedField,
  setOperatorValue, clearOperatorValue, setSnippets,
}) {
  const [pageIdx, setPageIdx] = useState(0);
  const numPages = pdfDoc?.numPages || 1;

  // Auto-flip to the page containing the selected field.
  useEffect(() => {
    if (!selectedField || !pdfDoc) return;
    (async () => {
      const fieldObjects = await pdfDoc.getFieldObjects();
      if (!fieldObjects) return;
      const objs = fieldObjects[selectedField] || [];
      const widget = objs.find((o) => Array.isArray(o.rect));
      if (widget && typeof widget.page === "number" && widget.page !== pageIdx) {
        setPageIdx(widget.page);
      }
    })();
  }, [selectedField, pdfDoc, pageIdx]);

  // Keyboard nav: ← / → between pages (ignore while typing).
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") setPageIdx((i) => Math.max(0, i - 1));
      else if (e.key === "ArrowRight") setPageIdx((i) => Math.min(numPages - 1, i + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [numPages]);

  // Per-page status — drives the tab dot color.
  const pageStatus = useMemo(() => {
    // Without page-level field grouping we report whole-doc status on every
    // tab. If a future PDF runs multi-page we'd bucket by widget.page.
    let blanks = 0, errors = 0, filled = 0, unsupported = 0, operator = 0;
    for (const f of fields) {
      const v = state.values[f.name];
      const err = state.errors[f.name];
      if (state.operatorFilled?.has(f.name)) operator++;
      if (f.kind === "unsupported") unsupported++;
      else if (err) errors++;
      else if (f.kind === "checkbox" ? v === true : v !== "") filled++;
      else blanks++;
    }
    return { total: fields.length, blanks, errors, filled, unsupported, operator };
  }, [fields, state]);

  const collectSnippets = useCallback((m) => {
    setSnippets((s) => ({ ...s, ...m }));
  }, [setSnippets]);

  return (
    <div className="paper-deck">
      <div className="deck-stage">
        <div className="deck-stack">
          {Array.from({ length: numPages }, (_, i) => {
            const offset = i - pageIdx;
            let cls = "deck-hidden-back";
            if (offset === 0) cls = "deck-front";
            else if (offset > 0 && offset <= 3) cls = "deck-behind";
            else if (offset > 0) cls = "deck-hidden-back";
            else cls = "deck-flipped";
            const isFront = offset === 0;
            return (
              <article
                key={i}
                className={`paper ${cls}`}
                data-depth={offset}
                aria-hidden={!isFront}
                onClick={isFront ? undefined : (e) => {
                  if (offset > 0) { e.stopPropagation(); setPageIdx(i); }
                }}
              >
                {isFront && (
                  <PdfPage
                    pdfDoc={pdfDoc}
                    pageNum={i + 1}
                    fields={fields}
                    state={state}
                    selectedField={selectedField}
                    setSelectedField={setSelectedField}
                    setOperatorValue={setOperatorValue}
                    clearOperatorValue={clearOperatorValue}
                    onSnippets={collectSnippets}
                    snippetPadding={28}
                  />
                )}
              </article>
            );
          })}
        </div>
      </div>
      {numPages > 1 && (
        <nav className="deck-nav" aria-label="Form pages">
          <button
            className="deck-nav-arrow"
            onClick={() => setPageIdx(Math.max(0, pageIdx - 1))}
            disabled={pageIdx === 0}
            aria-label="Previous page"
            title="Previous page (←)"
          >←</button>
          <ol className="deck-tabs">
            {Array.from({ length: numPages }, (_, i) => {
              const s = pageStatus;
              let statusCls = "s-ok";
              if (s.errors > 0) statusCls = "s-error";
              else if (s.unsupported > 0) statusCls = "s-warn";
              else if (s.blanks > 0) statusCls = "s-blank";
              const opCls = s.operator > 0 ? "has-operator" : "";
              return (
                <li key={i} style={{ display: "contents" }}>
                  <button
                    className={`deck-tab ${i === pageIdx ? "is-active" : ""} ${statusCls} ${opCls}`}
                    onClick={() => setPageIdx(i)}
                  >
                    <div className="tab-row">
                      <span className="tab-num">{String(i + 1).padStart(2, "0")}</span>
                      <span className="tab-name">Page {i + 1}</span>
                      <span className="tab-status"></span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ol>
          <button
            className="deck-nav-arrow"
            onClick={() => setPageIdx(Math.min(numPages - 1, pageIdx + 1))}
            disabled={pageIdx === numPages - 1}
            aria-label="Next page"
            title="Next page (→)"
          >→</button>
        </nav>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Source column — original notes + operator-added sources + add-source card.

function SourceCard({ sourceBody, activeQuote }) {
  return (
    <article className="source-card">
      <header className="src-head">
        <span className="src-icon">▤</span>
        <span className="src-name">sample-notes.txt</span>
        <span className="src-size">{sourceBody.length} B</span>
      </header>
      <pre className="src-body">
        <HighlightedText text={sourceBody} quote={activeQuote} active={true} />
      </pre>
    </article>
  );
}

function ExtraSourceCard({ source }) {
  const [running, setRunning] = useState(true);
  useEffect(() => {
    const id = setTimeout(() => setRunning(false), 1400);
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
  return (
    <article className="source-card is-from-operator">
      <header className="src-head">
        <span className="src-icon">✎</span>
        <span className="src-name">{label}</span>
        <span className={`src-rerun ${running ? "is-running" : ""}`}>
          {running ? <><span className="spinner"></span> staging…</> : <>staged · re-run to apply</>}
        </span>
      </header>
      {source.text && (
        <pre className="src-body">{source.text.length > 400 ? source.text.slice(0, 400) + "…" : source.text}</pre>
      )}
      {source.files.length > 0 && (
        <div className="src-attachments">
          {source.files.map((f, i) => <span key={i} className="clip">📎 {f.name}</span>)}
        </div>
      )}
    </article>
  );
}

function AddSourceCard({ onAdd, blanksCount }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [files, setFiles] = useState([]);
  const [dragging, setDragging] = useState(false);
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const rootRef = useRef(null);

  useEffect(() => {
    if (open && taRef.current) taRef.current.focus();
  }, [open]);

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
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  };
  const handleDrop = (e) => {
    e.preventDefault(); e.stopPropagation();
    setDragging(false); setOpen(true);
    const dropped = Array.from(e.dataTransfer?.files || []);
    if (dropped.length) setFiles((cur) => [...cur, ...dropped]);
    const pastedText = e.dataTransfer?.getData?.("text/plain");
    if (pastedText) setText((t) => t ? `${t}\n\n${pastedText}` : pastedText);
  };
  const onPickFiles = (e) => {
    const picked = Array.from(e.target.files || []);
    if (picked.length) setFiles((cur) => [...cur, ...picked]);
    e.target.value = "";
  };

  const collapsedTitle = blanksCount > 0
    ? `Missing info? Hand the scribe another source.`
    : `Hand the scribe more text`;
  const collapsedSub = blanksCount > 0
    ? `${blanksCount} field${blanksCount !== 1 ? "s" : ""} left blank · paste, drop, or type below`
    : `paste an email, drop a file, or type — re-run picks it up`;

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
          <span>+</span> attach file
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
          Hand to scribe →
        </button>
      </div>
    </div>
  );
}

// CTA shown after at least one new source is staged. The engine is one-shot,
// so we render a copy-pasteable re-run command rather than calling the model
// from the browser.
function RerunCta({ extraSources, run, showToast }) {
  if (extraSources.length === 0) return null;
  const textArgs = extraSources
    .filter((s) => s.text)
    .map((s) => `--text ${JSON.stringify(s.text)}`);
  const cmd = `npm run scribe -- --form ${run.formPath} --out ${run.outPath} ${textArgs.join(" ")}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      showToast("re-run command copied to clipboard");
    } catch { showToast("copy failed — select the command manually"); }
  };
  return (
    <div className="rerun-cta">
      <div className="head">Re-run with these sources</div>
      <div style={{ fontSize: 11.5, color: "var(--ink-mute)" }}>
        The scribe doesn't run from this surface. Paste this into a shell to
        regenerate the filled PDF with the staged source{extraSources.length !== 1 ? "s" : ""}.
      </div>
      <code>{cmd}</code>
      <button onClick={copy}>Copy command</button>
    </div>
  );
}

function SourcePanel({ sourceBody, activeQuote, extraSources, addSource, blanksCount, run, finishVisible, showToast }) {
  return (
    <section className="col-sources">
      <div className="sources">
        <SourceCard sourceBody={sourceBody} activeQuote={activeQuote} />
        {extraSources.map((src) => <ExtraSourceCard key={src.id} source={src} />)}
      </div>
      <RerunCta extraSources={extraSources} run={run} showToast={showToast} />
      {finishVisible && <AddSourceCard onAdd={addSource} blanksCount={blanksCount} />}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Form column wrapper.

function FormColumn(props) {
  return (
    <section className="col-form">
      <div className="paper-wrap">
        <PaperDeck {...props} />
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Run details / event stream (right column).

function fmtMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function StreamItem({ tc, step, run, fields, isSelected, onFieldClick, snippets, showSnippets }) {
  const isError = tc.result.startsWith("error:");
  const isMeta = tc.name === "list_fields" || tc.name === "finish";
  const fieldName = tc.arguments?.name;
  const cls = [
    "stream-item",
    isError && "is-error",
    isMeta && "is-meta",
    isSelected && "is-selected",
  ].filter(Boolean).join(" ");

  const recovery = useMemo(() => {
    if (!isError || tc.name !== "set_field") return null;
    const nextOk = run.toolCalls.findIndex(
      (t, i) => i > step && t.name === "set_field" && t.result.startsWith("ok:") &&
        (t.arguments.name === fieldName || /no field named/.test(tc.result)),
    );
    if (nextOk >= 0) return `Recovered on step #${String(nextOk + 1).padStart(2, "0")}.`;
    return null;
  }, [isError, tc, run, step, fieldName]);

  const showSnippet = showSnippets && tc.name === "set_field" && !isError;
  // Resolve which field the agent THINKS it edited — that's `fieldName` even
  // if it's a name salad. If we have a snippet keyed to it, show it. Otherwise
  // the absence is its own signal ("agent named a field that doesn't exist").
  const snippet = showSnippet ? snippets[fieldName] : null;

  return (
    <li className={cls} data-field-event={fieldName || undefined} data-step={step}>
      <span className="stream-step">#{String(step + 1).padStart(2, "0")}</span>
      <div className="stream-tick"><div className="stream-dot"></div></div>
      <div className="stream-content" onClick={() => { if (fieldName) onFieldClick(fieldName); }}>
        <div className="stream-row">
          <code className="stream-tool">{tc.name}</code>
          {fieldName && <code className="stream-field-pill">{fieldName}</code>}
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
        {tc.name === "list_fields" && (() => {
          let parsed = [];
          try { parsed = JSON.parse(tc.result); } catch {}
          return (
            <div className="stream-args">
              <span className="arg-key">→</span> returned <b style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{parsed.length}</b>{" "}field{parsed.length !== 1 ? "s" : ""}
            </div>
          );
        })()}
        {tc.name === "finish" && (
          <div className="stream-args" style={{ fontFamily: "var(--serif)", fontStyle: "italic", color: "var(--ink-soft)", fontSize: 12 }}>
            {tc.arguments.summary.length > 140 ? tc.arguments.summary.slice(0, 140) + "…" : tc.arguments.summary}
          </div>
        )}
        {showSnippet && (
          snippet ? (
            <div className="stream-snippet" title="Crop of the PDF region the agent wrote to">
              <div className="stream-snippet-head">
                <span>snippet · {fieldName}</span>
              </div>
              <img src={snippet} alt={`PDF region for ${fieldName}`} />
            </div>
          ) : (
            <div className="stream-snippet is-missing">
              no rect for <code style={{fontSize: 10.5}}>{fieldName}</code> — name not present on form
            </div>
          )
        )}
        <div className={`stream-result ${isError ? "is-error" : "is-ok"}`}>
          {tc.result.length > 220 ? tc.result.slice(0, 220) + "…" : tc.result}
        </div>
        {recovery && <div className="stream-recover"><span>{recovery}</span></div>}
      </div>
    </li>
  );
}

function EventStream({ run, fields, state, selectedField, setSelectedField, snippets }) {
  const listRef = useRef(null);
  const [openStream, setOpenStream] = useState(true);
  const [openMeta, setOpenMeta] = useState(false);
  const [showSnippets, setShowSnippets] = useState(true);

  useEffect(() => {
    if (!selectedField || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-field-event="${selectedField}"]`);
    if (el?.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedField]);

  const setFieldCalls = run.toolCalls.filter((t) => t.name === "set_field");
  const errCalls = setFieldCalls.filter((t) => t.result.startsWith("error:"));
  const filled = fields.filter((f) => {
    const v = state.values[f.name];
    return f.kind === "checkbox" ? v === true : v !== "" && v !== false;
  }).length;
  const blanks = fields.filter((f) => {
    if (f.kind === "unsupported") return false;
    const v = state.values[f.name];
    return f.kind === "checkbox" ? v === false : v === "";
  });
  const unsupported = fields.filter((f) => f.kind === "unsupported");

  return (
    <section className="col-events" ref={listRef}>
      <details className="rd-block" open={openMeta} onToggle={(e) => setOpenMeta(e.target.open)}>
        <summary className="rd-summary">
          <span className="rd-caret">▸</span>
          <span className="rd-title">Run metadata</span>
          <span className="rd-hint">{run.model}</span>
        </summary>
        <div className="rd-body">
          <dl className="rd-dl">
            <dt>input</dt><dd><code>{run.formPath}</code></dd>
            <dt>output</dt><dd><code>{run.outPath}</code></dd>
            <dt>model</dt><dd><code>{run.model}</code></dd>
            <dt>written</dt><dd><code>{filled} / {fields.length}</code></dd>
            {blanks.length > 0 && <><dt>blank</dt><dd><code>{blanks.length}</code></dd></>}
            {unsupported.length > 0 && <><dt>unsupported</dt><dd><code>{unsupported.length}</code></dd></>}
            {errCalls.length > 0 && <><dt>retries</dt><dd><code>{errCalls.length}</code></dd></>}
          </dl>
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dotted var(--rule)", display: "flex", gap: 12, alignItems: "center" }}>
            <a className="event-action" href={TRANSCRIPT_URL} download="e2e-filled.transcript.json">↓ transcript.json</a>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--ink-soft)", cursor: "pointer" }}>
              <input type="checkbox" checked={showSnippets} onChange={(e) => setShowSnippets(e.target.checked)} />
              show field snippets
            </label>
          </div>
        </div>
      </details>

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
                fields={fields}
                isSelected={tc.name === "set_field" && tc.arguments.name === selectedField}
                onFieldClick={(name) => setSelectedField(name === selectedField ? null : name)}
                snippets={snippets}
                showSnippets={showSnippets}
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
                  onClick={() => setSelectedField(f.name === selectedField ? null : f.name)}
                >
                  <code>{f.name}</code>
                  <span className="reason">left blank by the agent</span>
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
                  onClick={() => setSelectedField(f.name === selectedField ? null : f.name)}
                >
                  <code>{f.name}</code>
                  <span className="reason">{f.kind} widget — pdf-lib cannot write</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <details className="rd-block">
        <summary className="rd-summary">
          <span className="rd-caret">▸</span>
          <span className="rd-title">Finish summary</span>
          <span className="rd-hint">agent's note</span>
        </summary>
        <div className="rd-body">
          <p style={{ fontFamily: "var(--serif)", fontSize: 13, lineHeight: 1.55, color: "var(--ink-soft)", margin: "6px 0 0" }}>
            {run.summary || run.toolCalls.find((t) => t.name === "finish")?.arguments.summary || "—"}
          </p>
        </div>
      </details>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EditsPill — appears bottom-right whenever the operator has staged at least
// one override. Save-to-PDF uses pdf-lib (loaded from CDN) to apply the edits
// to the filled PDF and trigger a download. No backend call.

function EditsPill({ operatorEdits, clearAll, fields, showToast }) {
  const [saving, setSaving] = useState(false);
  const count = Object.keys(operatorEdits).length;
  if (count === 0) return null;

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const bytes = await fetch(PDF_URL).then((r) => {
        if (!r.ok) throw new Error(`fetch pdf ${r.status}`);
        return r.arrayBuffer();
      });
      const PDFDocument = window.PDFLib.PDFDocument;
      const doc = await PDFDocument.load(bytes);
      const form = doc.getForm();
      for (const [name, value] of Object.entries(operatorEdits)) {
        const f = fields.find((x) => x.name === name);
        if (!f) continue;
        try {
          if (f.kind === "text") {
            form.getTextField(name).setText(String(value ?? ""));
          } else if (f.kind === "checkbox") {
            const cb = form.getCheckBox(name);
            if (value) cb.check(); else cb.uncheck();
          } else if (f.kind === "dropdown") {
            form.getDropdown(name).select(String(value));
          } else if (f.kind === "radio") {
            form.getRadioGroup(name).select(String(value));
          }
        } catch (e) {
          console.warn(`[edits] could not apply ${name}:`, e.message);
        }
      }
      const out = await doc.save();
      const blob = new Blob([out], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "e2e-filled.edited.pdf";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(`saved ${count} edit${count !== 1 ? "s" : ""} → e2e-filled.edited.pdf`);
    } catch (e) {
      console.error(e);
      showToast(`save failed: ${e.message}`);
    } finally { setSaving(false); }
  };

  return (
    <div className="edits-pill" role="status">
      <span className="edits-pill-count">{count}</span>
      <span className="edits-pill-label">your edit{count !== 1 ? "s" : ""}</span>
      <button className="edits-pill-undo" onClick={clearAll}>undo all</button>
      <button className="edits-pill-save" disabled={saving} onClick={save}>
        {saving ? "Saving…" : "Save to PDF"}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// App

function App() {
  const [run, setRun] = useState(null);
  const [fields, setFields] = useState([]);
  const [sourceBody, setSourceBody] = useState("");
  const [loadError, setLoadError] = useState(null);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [selectedField, setSelectedField] = useState(null);
  const [extraSources, setExtraSources] = useState([]);
  const [operatorEdits, setOperatorEdits] = useState({});
  const [showStream, setShowStream] = useState(false);
  const [snippets, setSnippets] = useState({});
  const [toast, setToast] = useState(null);
  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  // Fetch transcript + notes + PDF document.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [tr, notes, pdfjs] = await Promise.all([
          fetch(TRANSCRIPT_URL).then((r) => { if (!r.ok) throw new Error(`transcript ${r.status}`); return r.json(); }),
          fetch(NOTES_URL).then((r) => { if (!r.ok) throw new Error(`notes ${r.status}`); return r.text(); }),
          getPdfjs(),
        ]);
        if (cancelled) return;
        const doc = await pdfjs.getDocument(PDF_URL).promise;
        if (cancelled) return;
        setRun(tr);
        setFields(parseFieldCatalog(tr.toolCalls));
        setSourceBody(notes);
        setPdfDoc(doc);
      } catch (e) {
        console.error(e);
        if (!cancelled) setLoadError(String(e.message || e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Below the design width, zoom-fit so the 3-col layout stays usable.
  useEffect(() => {
    const DESIGN_W = 1280;
    const fit = () => {
      const z = Math.min(1, window.innerWidth / DESIGN_W);
      document.documentElement.style.setProperty("--page-zoom", z);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const setOperatorValue = useCallback((name, value) => {
    setOperatorEdits((e) => ({ ...e, [name]: value }));
  }, []);
  const clearOperatorValue = useCallback((name) => {
    setOperatorEdits((e) => { const n = { ...e }; delete n[name]; return n; });
  }, []);
  const clearAllEdits = useCallback(() => setOperatorEdits({}), []);
  const addSource = useCallback((src) => setExtraSources((xs) => [...xs, src]), []);

  const downloadPdf = () => {
    const a = document.createElement("a");
    a.href = PDF_URL;
    a.download = "e2e-filled.pdf";
    a.click();
  };

  if (loadError) {
    return <div className="empty">Failed to load engine artifacts: {loadError}. Did you run <code>npm run proof:e2e</code>?</div>;
  }
  if (!run || !pdfDoc) return <div className="empty">Loading transcript + PDF…</div>;

  const baseState = deriveStateAt(fields, run.toolCalls, run.toolCalls.length - 1);
  const operatorFilled = new Set(Object.keys(operatorEdits));
  const values = { ...baseState.values, ...operatorEdits };
  const state = { ...baseState, values, operatorFilled };
  const finishVisible = state.finishAt >= 0;

  const activeValue = selectedField ? state.values[selectedField] : null;
  const activeQuote =
    typeof activeValue === "string" && activeValue && sourceBody.indexOf(activeValue) >= 0
      ? activeValue : null;

  const blanksCount = fields.filter((f) => {
    if (f.kind === "unsupported") return false;
    const v = state.values[f.name];
    return f.kind === "checkbox" ? v === false : v === "";
  }).length;

  return (
    <>
      <UtilBar downloadPdf={downloadPdf} showStream={showStream} setShowStream={setShowStream} />
      <main className={`workbench ${showStream ? "with-stream" : ""}`}>
        <SourcePanel
          sourceBody={sourceBody}
          activeQuote={activeQuote}
          extraSources={extraSources}
          addSource={addSource}
          blanksCount={blanksCount}
          run={run}
          finishVisible={finishVisible}
          showToast={showToast}
        />
        <FormColumn
          pdfDoc={pdfDoc}
          fields={fields}
          state={state}
          selectedField={selectedField}
          setSelectedField={setSelectedField}
          setOperatorValue={setOperatorValue}
          clearOperatorValue={clearOperatorValue}
          setSnippets={setSnippets}
        />
        {showStream && (
          <EventStream
            run={run}
            fields={fields}
            state={state}
            selectedField={selectedField}
            setSelectedField={setSelectedField}
            snippets={snippets}
          />
        )}
      </main>
      <EditsPill
        operatorEdits={operatorEdits}
        clearAll={clearAllEdits}
        fields={fields}
        showToast={showToast}
      />
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
