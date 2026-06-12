const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const state = { runId: "", run: null, events: [], es: null, replay: null, step: 0 };

$$(".tab").forEach((b) =>
  b.addEventListener("click", () => {
    $$(".tab,.view").forEach((x) => x.classList.remove("is-active"));
    b.classList.add("is-active");
    $(`#${b.dataset.tab}`).classList.add("is-active");
    if (b.dataset.tab === "review") renderReview();
  }),
);

$("#runForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pdf = $("#pdf").files[0];
  const files = [...$("#sources").files];
  if (!pdf || !files.length) return;
  state.events = [];
  renderEvents();
  const body = {
    pdf: await b64(pdf),
    sources: await Promise.all(files.map(async (f) => ({ name: f.name, type: f.type, data: await b64(f) }))),
  };
  const res = await fetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = await res.json();
  if (!res.ok) return addEvent("run_error", out);
  state.runId = out.id;
  openEvents(out.id);
  await loadRun();
});

function openEvents(id) {
  state.es?.close();
  state.es = new EventSource(`/api/runs/${id}/events`);
  for (const name of ["run_started", "tool_call", "run_done", "run_error", "field_corrected"]) {
    state.es.addEventListener(name, async (e) => {
      addEvent(name, JSON.parse(e.data));
      if (name !== "run_started") await loadRun();
      if (name === "run_done" || name === "run_error") selectTab("review");
    });
  }
}

async function loadRun() {
  if (!state.runId) return;
  const res = await fetch(`/api/runs/${state.runId}`);
  state.run = res.ok ? await res.json() : null;
  renderReview();
}

function renderReview() {
  const root = $("#reviewBody");
  const run = state.run;
  if (!run) {
    root.className = "empty";
    root.textContent = "No run selected.";
    return;
  }
  const flags = Object.fromEntries(run.flags.map((f) => [f.field, f]));
  const missing = new Set(run.missingRequired);
  const issue = (f) => missing.has(f.name) ? 0 : flags[f.name]?.confidence === "low" ? 1 : flags[f.name] ? 2 : 3;
  const fields = [...run.fields].sort((a, b) => issue(a) - issue(b) || a.name.localeCompare(b.name));
  const exceptions = fields.filter((f) => issue(f) < 3);
  const ok = fields.filter((f) => issue(f) === 3);
  root.className = "";
  root.innerHTML = `
    <div class="review-head">
      <div><b>${esc(run.id)}</b><span class="pill ${run.status}">${esc(run.status)}</span></div>
      <a class="export" href="/api/runs/${encodeURIComponent(run.id)}/export">Export PDF</a>
    </div>
    ${run.error ? `<p class="error">${esc(run.error)}</p>` : ""}
    <h2>Exceptions ${exceptions.length ? `<span>${exceptions.length}</span>` : ""}</h2>
    <div class="field-list">${exceptions.length ? exceptions.map((f) => row(f, run, flags[f.name], missing.has(f.name))).join("") : `<p class="empty inline">No exceptions.</p>`}</div>
    <details>
      <summary>All fields (${ok.length})</summary>
      <div class="field-list">${ok.map((f) => row(f, run, null, false)).join("")}</div>
    </details>`;
  $$("[data-save]", root).forEach((b) => b.addEventListener("click", () => saveField(b)));
}

function row(f, run, flag, missing) {
  const v = run.values[f.name];
  const tone = missing || flag?.confidence === "low" ? "bad" : flag ? "warn" : "good";
  const reason = missing ? "Required field is blank." : flag ? flag.reason : "Set and unflagged.";
  return `<article class="field-row ${tone}" data-name="${esc(f.name)}" data-kind="${f.kind}">
    <div class="field-meta"><code>${esc(f.name)}</code><small>${esc(f.kind)} - ${esc(reason)}</small></div>
    ${control(f, v)}
    <button data-save="${esc(f.name)}">Save</button>
  </article>`;
}

function control(f, v) {
  if (f.kind === "checkbox") return `<input data-edit type="checkbox" ${v ? "checked" : ""} />`;
  if ((f.kind === "dropdown" || f.kind === "radio") && f.options?.length) {
    return `<select data-edit>${["", ...f.options].map((o) => `<option ${o === v ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  }
  return `<input data-edit value="${esc(Array.isArray(v) ? v.join(", ") : v ?? "")}" ${f.kind === "unsupported" ? "disabled" : ""} />`;
}

async function saveField(button) {
  const row = button.closest(".field-row");
  const el = $("[data-edit]", row);
  const value = row.dataset.kind === "checkbox" ? el.checked : row.dataset.kind === "optionlist" ? el.value.split(",").map((s) => s.trim()).filter(Boolean) : el.value;
  const res = await fetch(`/api/runs/${state.runId}/fields`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ field: row.dataset.name, value }),
  });
  const out = await res.json();
  if (!res.ok) return addEvent("run_error", out);
  state.run = out;
  renderReview();
}

function addEvent(event, data) {
  state.events.push({ event, data });
  renderEvents();
}

function renderEvents() {
  $("#events").innerHTML = state.events
    .map(({ event, data }, i) => `<li class="${event}"><span>#${i + 1}</span>${eventLine(event, data)}</li>`)
    .join("");
}

function eventLine(event, data) {
  if (event === "tool_call") return `<code>${esc(data.name)}</code> ${esc(JSON.stringify(data.arguments ?? {}))}<small>${esc(data.result ?? "")}</small>`;
  if (event === "run_error") return `<b>error</b><small>${esc(data.message ?? data.error ?? "")}</small>`;
  if (event === "run_done") return `<b>done</b><small>${esc(data.summary ?? "")}</small>`;
  if (event === "field_corrected") return `<b>corrected</b> <code>${esc(data.field)}</code>`;
  return `<b>${esc(event)}</b>`;
}

$("#replayFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file) setReplay(JSON.parse(await file.text()));
});

const fileParam = new URLSearchParams(location.search).get("file");
if (fileParam) fetch(fileParam).then((r) => r.json()).then(setReplay).catch((e) => ($("#replayBody").textContent = e.message));

function setReplay(run) {
  state.replay = run;
  state.step = Math.max(0, (run.toolCalls?.length ?? 1) - 1);
  selectTab("replay");
  renderReplay();
}

function renderReplay() {
  const root = $("#replayBody");
  const run = state.replay;
  if (!run?.toolCalls?.length) {
    root.className = "empty";
    root.textContent = "No transcript loaded.";
    return;
  }
  const fields = fieldsFrom(run);
  const values = replayValues(fields, run.toolCalls, state.step);
  root.className = "";
  root.innerHTML = `<div class="replay-head">
    <input id="step" type="range" min="0" max="${run.toolCalls.length - 1}" value="${state.step}" />
    <b>Step ${state.step + 1} / ${run.toolCalls.length}</b>
  </div>
  <ol class="timeline">${run.toolCalls.map((c, i) => `<li class="${i === state.step ? "is-now" : ""}"><span>#${i + 1}</span><code>${esc(c.name)}</code><small>${esc(c.result)}</small></li>`).join("")}</ol>
  <div class="values">${fields.map((f) => `<p><code>${esc(f.name)}</code><span>${esc(show(values[f.name]))}</span></p>`).join("")}</div>`;
  $("#step").addEventListener("input", (e) => {
    state.step = Number(e.target.value);
    renderReplay();
  });
}

function fieldsFrom(run) {
  const call = run.toolCalls.find((c) => c.name === "list_fields");
  try {
    return call ? JSON.parse(call.result) : run.fields ?? [];
  } catch {
    return run.fields ?? [];
  }
}

function replayValues(fields, calls, step) {
  const values = Object.fromEntries(fields.map((f) => [f.name, f.currentValue ?? (f.kind === "checkbox" ? false : "")]));
  for (const c of calls.slice(0, step + 1)) if (c.name === "set_field" && !c.result.startsWith("error:")) values[c.arguments.name] = c.arguments.value;
  return values;
}

function selectTab(name) {
  $(`.tab[data-tab="${name}"]`).click();
}

function b64(file) {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] ?? "");
    r.onerror = fail;
    r.readAsDataURL(file);
  });
}

function show(v) {
  return Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v);
}

function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
