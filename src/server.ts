// Local operator server.
// Usage:
//   npm run serve
//   open http://127.0.0.1:8787
// API:
//   POST /api/runs with {pdf: base64, sources:[{name,type,data:base64}]}
//   GET  /api/runs/:id/events for SSE tool-call progress
//   GET  /api/runs/:id, POST /api/runs/:id/fields, GET /api/runs/:id/export
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  type IncomingMessage,
  type ServerResponse,
  createServer as createHttpServer,
} from "node:http";
import { basename, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolCallRecord, UncertainFlag } from "./agent.ts";
import {
  type FlatPlacement,
  drawFlatPdf,
  flatFieldInfo,
  flatFieldName,
  prepareFlatPdf,
} from "./flat.ts";
import {
  type FieldInfo,
  type FormHandle,
  isNoAcroFormError,
  listFields,
  loadForm,
  saveForm,
  setField,
} from "./pdf.ts";
import { type ScribeEvent, type SourceInputs, collectUncertainFlags, scribe } from "./scribe.ts";

type Status = "running" | "done" | "error";
type ApiSource = { name?: string; type?: string; data?: string };
type RunEvent = { event: string; data: unknown };
type Run = {
  id: string;
  mode: "acroform" | "flat";
  dir: string;
  formPath: string;
  outPath: string;
  pythonPath?: string;
  flatPlacements?: FlatPlacement[];
  transcriptPath?: string;
  status: Status;
  fields: FieldInfo[];
  values: Record<string, unknown>;
  required: Set<string>;
  flags: UncertainFlag[];
  toolCalls: ToolCallRecord[];
  events: RunEvent[];
  clients: Set<ServerResponse>;
  summary?: string;
  error?: string;
};

const runs = new Map<string, Run>();

export function createServer(root = process.cwd()) {
  const webRoot = resolve(root, "web");
  const outRoot = resolve(root, "out");
  return createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "POST" && url.pathname === "/api/runs") {
        return send(res, 200, { id: await createRun(await readJson(req), outRoot) });
      }
      const m = /^\/api\/runs\/([^/]+)(?:\/(events|fields|export))?$/.exec(url.pathname);
      if (m) return await handleRunRoute(req, res, m[1] ?? "", m[2]);
      if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
      return await serveStatic(res, webRoot, url.pathname);
    } catch (err) {
      return send(res, err instanceof SyntaxError ? 400 : 500, { error: messageOf(err) });
    }
  });
}

async function createRun(body: any, outRoot: string): Promise<string> {
  if (typeof body?.pdf !== "string") throw new Error("pdf base64 is required");
  if (!Array.isArray(body.sources) || body.sources.length === 0) {
    throw new Error("at least one source is required");
  }
  const id = `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const dir = resolve(outRoot, id);
  const formPath = resolve(dir, "form.pdf");
  const outPath = resolve(dir, "filled.pdf");
  const pdfBytes = Buffer.from(body.pdf, "base64");
  const pythonPath = process.env.SCRIBE_PYTHON;
  await mkdir(dir, { recursive: true });
  await writeFile(formPath, pdfBytes);
  let mode: Run["mode"] = "acroform";
  let fields: FieldInfo[] = [];
  let required = new Set<string>();
  try {
    const form = await loadForm(formPath);
    if (form.fields.size === 0) throw new Error("No AcroForm fields found in uploaded PDF.");
    await saveForm(form, outPath);
    fields = cloneFields(listFields(form));
    required = requiredNames(form);
  } catch (err) {
    if (!pythonPath || !isNoAcroFormError(err)) throw err;
    mode = "flat";
    await writeFile(outPath, pdfBytes);
  }
  const inputs = await writeSources(body.sources, dir);
  const run: Run = {
    id,
    mode,
    dir,
    formPath,
    outPath,
    pythonPath,
    status: "running",
    fields,
    values: valuesOf(fields),
    required,
    flags: [],
    toolCalls: [],
    events: [],
    clients: new Set(),
  };
  runs.set(id, run);
  emit(run, "run_started", { id });
  void runScribe(run, inputs);
  return id;
}

async function runScribe(run: Run, inputs: SourceInputs): Promise<void> {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
    const result = await scribe({
      formPath: run.formPath,
      outPath: run.outPath,
      inputs,
      apiKey,
      model: process.env.SCRIBE_MODEL,
      pythonPath: run.pythonPath,
      onEvent: (e) => applyScribeEvent(run, e),
    });
    run.status = "done";
    run.summary = result.summary;
    run.transcriptPath = result.transcriptPath;
    if (run.mode === "acroform") await syncFields(run, run.outPath);
    emit(run, "run_done", result);
  } catch (err) {
    run.status = "error";
    run.error = messageOf(err);
    emit(run, "run_error", { message: run.error });
  }
}

function applyScribeEvent(run: Run, e: ScribeEvent): void {
  run.toolCalls.push(e.record);
  run.fields = cloneFields(e.fields);
  run.values = valuesOf(run.fields);
  run.flags = collectUncertainFlags(run.toolCalls);
  if (run.mode === "flat") run.flatPlacements = flatPlacements(run.toolCalls);
  emit(run, "tool_call", e.record);
}

async function handleRunRoute(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  leaf?: string,
): Promise<void> {
  const run = runs.get(id);
  if (!run) return send(res, 404, { error: "unknown run" });
  if (req.method === "GET" && !leaf) return send(res, 200, stateOf(run));
  if (req.method === "GET" && leaf === "events") return openEvents(res, run);
  if (req.method === "GET" && leaf === "export") return sendPdf(res, run.outPath);
  if (req.method === "POST" && leaf === "fields") {
    if (run.status === "running") return send(res, 409, { error: "run is still running" });
    const body = await readJson(req);
    if (typeof body.field !== "string") return send(res, 400, { error: "field is required" });
    if (run.mode === "flat") return await correctFlatField(res, run, body.field, body.value);
    const form = await loadForm(run.outPath);
    const result = setField(form, body.field, body.value);
    if (result.startsWith("error:")) return send(res, 400, { error: result });
    await saveForm(form, run.outPath);
    run.flags = run.flags.filter((f) => f.field !== body.field);
    await syncFields(run, run.outPath);
    emit(run, "field_corrected", { field: body.field, value: body.value, result });
    return send(res, 200, stateOf(run));
  }
  return send(res, 405, { error: "method not allowed" });
}

async function correctFlatField(
  res: ServerResponse,
  run: Run,
  field: string,
  value: unknown,
): Promise<void> {
  if (!run.pythonPath) return send(res, 400, { error: "flat correction requires SCRIBE_PYTHON" });
  const placements = [...(run.flatPlacements ?? flatPlacements(run.toolCalls))];
  const i = placements.findIndex((p) => flatFieldName(p) === field);
  if (i < 0) return send(res, 400, { error: `error: no field named "${field}"` });
  const p = placements[i];
  if (!p) return send(res, 400, { error: `error: no field named "${field}"` });
  if ("value" in p) p.value = String(value ?? "");
  else if (value === false) placements.splice(i, 1);
  const base = await prepareFlatPdf(run.formPath, run.pythonPath);
  await drawFlatPdf(base.path, run.outPath, placements);
  run.flatPlacements = placements;
  run.fields = [
    ...placements.map(flatFieldInfo),
    ...run.fields.filter((f) => f.kind === "unsupported"),
  ];
  run.values = valuesOf(run.fields);
  run.flags = run.flags.filter((f) => f.field !== field);
  emit(run, "field_corrected", { field, value, result: `ok: set ${field}` });
  return send(res, 200, stateOf(run));
}

function openEvents(res: ServerResponse, run: Run): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const e of run.events) writeEvent(res, e);
  run.clients.add(res);
  res.on("close", () => run.clients.delete(res));
}

function emit(run: Run, event: string, data: unknown): void {
  const e = { event, data };
  run.events.push(e);
  for (const client of run.clients) writeEvent(client, e);
}

function writeEvent(res: ServerResponse, e: RunEvent): void {
  res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
}

async function writeSources(sources: ApiSource[], dir: string): Promise<SourceInputs> {
  const inputs: SourceInputs = { texts: [], images: [] };
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (!s || typeof s.data !== "string") throw new Error(`source ${i + 1} missing base64 data`);
    const name = safeName(s.name, i);
    const bytes = Buffer.from(s.data, "base64");
    const path = resolve(dir, name);
    await writeFile(path, bytes);
    if (isImage(name, s.type)) inputs.images.push(path);
    else if (isText(name, s.type)) inputs.texts.push(bytes.toString("utf8"));
    else throw new Error(`unsupported source type for ${name}; use text or image files`);
  }
  return inputs;
}

async function syncFields(run: Run, path: string): Promise<void> {
  const form = await loadForm(path);
  run.fields = cloneFields(listFields(form));
  run.values = valuesOf(run.fields);
  run.required = requiredNames(form);
}

function stateOf(run: Run) {
  return {
    id: run.id,
    status: run.status,
    summary: run.summary,
    error: run.error,
    fields: run.fields,
    values: run.values,
    flags: run.flags,
    missingRequired: run.fields
      .filter((f) => run.required.has(f.name) && emptyValue(run.values[f.name]))
      .map((f) => f.name),
    toolCalls: run.toolCalls,
    outPath: run.outPath,
    transcriptPath: run.transcriptPath,
  };
}

function valuesOf(fields: FieldInfo[]): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((f) => [f.name, f.currentValue ?? (f.kind === "checkbox" ? false : "")]),
  );
}

function flatPlacements(calls: ToolCallRecord[]): FlatPlacement[] {
  const out: FlatPlacement[] = [];
  for (const c of calls) {
    if (!c.result.startsWith("ok: placed")) continue;
    const a = c.arguments;
    const page = typeof a.page === "number" ? a.page : 0;
    const xPct = typeof a.xPct === "number" ? a.xPct : 0;
    const yPct = typeof a.yPct === "number" ? a.yPct : 0;
    const p =
      c.name === "place_text" && typeof a.value === "string" && typeof a.size === "number"
        ? { page, xPct, yPct, size: a.size, value: a.value }
        : c.name === "place_mark"
          ? { page, xPct, yPct, mark: true as const }
          : null;
    if (!p) continue;
    const i =
      "value" in p
        ? out.findIndex((x) => "value" in x && x.page === p.page && x.value === p.value)
        : out.filter((x) => "mark" in x && x.page === p.page).length === 1
          ? out.findIndex((x) => "mark" in x && x.page === p.page)
          : -1;
    if (i >= 0) out[i] = p;
    else out.push(p);
  }
  return out;
}

function cloneFields(fields: FieldInfo[]): FieldInfo[] {
  return fields.map((f) => ({ ...f, options: f.options ? [...f.options] : undefined }));
}

function requiredNames(form: FormHandle): Set<string> {
  return new Set(
    form.pdf
      .getForm()
      .getFields()
      .filter((f) => (f as { isRequired?: () => boolean }).isRequired?.())
      .map((f) => f.getName()),
  );
}

function emptyValue(v: unknown): boolean {
  return v === "" || v === false || v == null || (Array.isArray(v) && v.length === 0);
}

function safeName(name: unknown, i: number): string {
  return (
    basename(typeof name === "string" ? name : `source-${i + 1}.txt`).replace(/[^\w.-]+/g, "_") ||
    `source-${i + 1}.txt`
  );
}

function isImage(name: string, type = ""): boolean {
  return type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(name);
}

function isText(name: string, type = ""): boolean {
  return type.startsWith("text/") || /\.(txt|md|csv|json)$/i.test(name);
}

async function readJson(req: IncomingMessage): Promise<any> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 60_000_000) throw new Error("request body too large");
  }
  return JSON.parse(body || "{}");
}

function send(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function sendPdf(res: ServerResponse, path: string): Promise<void> {
  const body = await readFile(path);
  res.writeHead(200, { "content-type": "application/pdf", "content-length": body.length });
  res.end(body);
}

async function serveStatic(res: ServerResponse, webRoot: string, pathname: string): Promise<void> {
  const rel = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const file = resolve(webRoot, `.${rel}`);
  if (file !== webRoot && !file.startsWith(`${webRoot}${sep}`))
    return send(res, 403, { error: "forbidden" });
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": mime(file), "content-length": body.length });
    res.end(body);
  } catch {
    send(res, 404, { error: "not found" });
  }
}

function mime(path: string): string {
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
    }[extname(path).toLowerCase()] ?? "application/octet-stream"
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  createServer().listen(port, "127.0.0.1", () => {
    console.log(`Scribe operator UI: http://127.0.0.1:${port}`);
  });
}
