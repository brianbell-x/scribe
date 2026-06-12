import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import { PDFDocument, type PDFPage, StandardFonts, rgb } from "pdf-lib";
import type { ChatComplete, ContentPart, ScribeRunResult, ToolCallRecord } from "./agent.ts";
import type { FieldInfo } from "./pdf.ts";

export type FlatPlacement =
  | { page: number; xPct: number; yPct: number; size: number; value: string }
  | { page: number; xPct: number; yPct: number; mark: true };

type FlatHandle = {
  basePath: string;
  currentPath: string;
  outPath: string;
  pageCount: number;
  pythonPath: string;
  workDir: string;
  version: number;
  placements: FlatPlacement[];
  extraFields: Map<string, FieldInfo>;
  renders: Map<string, string>;
  batches: Map<number, number>;
};

const MAX_TURNS = 16;
const MAX_BATCHES_PER_PAGE = 3;

const FLAT_SYSTEM = `
You are Scribe in flat-fill overlay mode. The target PDF has no usable AcroForm fields.
Use view_page to inspect pages, then place_text and place_mark with percentage coordinates
from the visible page box: xPct 0 is left, yPct 0 is top. After each placement batch, an
updated page image is returned; compare it against the intended form location and correct
misplaced overlays. Each page allows the first placement batch plus two correction batches.
If a location remains uncertain, call flag_uncertain. Finish with a short summary.
`.trim();

export const FLAT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "view_page",
      description: "Render one PDF page to a PNG image so you can inspect the flat form.",
      parameters: {
        type: "object",
        properties: { page: { type: "integer", minimum: 1 } },
        required: ["page"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "place_text",
      description: "Place text on a flat PDF page at percentage coordinates.",
      parameters: {
        type: "object",
        properties: {
          page: { type: "integer", minimum: 1 },
          xPct: { type: "number", minimum: 0, maximum: 100 },
          yPct: { type: "number", minimum: 0, maximum: 100 },
          size: { type: "number", minimum: 1 },
          value: { type: "string" },
        },
        required: ["page", "xPct", "yPct", "size", "value"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "place_mark",
      description: "Place an X mark on a flat PDF page at percentage coordinates.",
      parameters: {
        type: "object",
        properties: {
          page: { type: "integer", minimum: 1 },
          xPct: { type: "number", minimum: 0, maximum: 100 },
          yPct: { type: "number", minimum: 0, maximum: 100 },
        },
        required: ["page", "xPct", "yPct"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "flag_uncertain",
      description:
        "Mark one placement or missing flat-form target for human review. Use an existing placement field name or a pageN: label.",
      parameters: {
        type: "object",
        properties: {
          field: { type: "string" },
          reason: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium"] },
        },
        required: ["field", "reason", "confidence"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "finish",
      description: "End the run with a short summary.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false,
      },
    },
  },
];

export async function runFlatAgent(args: {
  apiKey: string;
  model: string;
  userContent: ContentPart[];
  formPath: string;
  outPath: string;
  pythonPath: string;
  complete?: ChatComplete;
  onToolCall?: (record: ToolCallRecord, fields: FieldInfo[]) => void;
}): Promise<ScribeRunResult> {
  const ready = await prepareFlatPdf(args.formPath, args.pythonPath);
  const h: FlatHandle = {
    basePath: ready.path,
    currentPath: ready.path,
    outPath: args.outPath,
    pageCount: ready.pageCount,
    pythonPath: args.pythonPath,
    workDir: ready.workDir,
    version: 0,
    placements: [],
    extraFields: new Map(),
    renders: new Map(),
    batches: new Map(),
  };
  const complete =
    args.complete ??
    (async (req: any) => {
      const { default: OpenAI } = await import("openai");
      return new OpenAI({
        apiKey: args.apiKey,
        baseURL: "https://openrouter.ai/api/v1",
      }).chat.completions.create(req);
    });
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: FLAT_SYSTEM },
    { role: "user", content: args.userContent as ChatCompletionContentPart[] },
  ];
  const toolCalls: ToolCallRecord[] = [];
  let summary = "";

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await complete({
      model: args.model,
      messages,
      tools: FLAT_TOOLS,
      tool_choice: "auto",
    });
    const msg = resp.choices[0]?.message;
    if (!msg) throw new Error("OpenRouter returned no choices");
    messages.push(msg);
    if (!msg.tool_calls?.length)
      return await finishFlat(h, toolCalls, args.model, String(msg.content ?? ""));

    let done = false;
    const viewed = new Set<number>();
    const affected = new Set<number>();
    for (const call of msg.tool_calls) {
      const out = await executeFlatTool(call, h, affected);
      if (out.viewPage) viewed.add(out.viewPage);
      if (out.affectedPage) affected.add(out.affectedPage);
      if (out.summary !== undefined) {
        done = true;
        summary = out.summary;
      }
      toolCalls.push(out.record);
      args.onToolCall?.(out.record, flatFields(h));
      messages.push({ role: "tool", tool_call_id: call.id, content: out.record.result });
    }

    if (affected.size) {
      for (const page of affected) h.batches.set(page, (h.batches.get(page) ?? 0) + 1);
      await drawFlatPdf(h.basePath, h.outPath, h.placements);
      h.currentPath = h.outPath;
      h.version++;
      h.renders.clear();
      await addPageImages(
        messages,
        h,
        affected,
        "Updated flat-fill page render. Verify placements against the form and correct misplaced overlays.",
      );
    } else if (viewed.size) {
      await addPageImages(messages, h, viewed, "Rendered flat-fill page image.");
    }
    if (done) return await finishFlat(h, toolCalls, args.model, summary);
  }
  throw new Error(`flat agent did not call finish within ${MAX_TURNS} turns`);
}

export async function prepareFlatPdf(
  inPath: string,
  pythonPath: string,
): Promise<{ path: string; pageCount: number; workDir: string }> {
  const workDir = join(tmpdir(), `scribe-flat-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });
  try {
    return { ...(await checkedPdf(inPath)), workDir };
  } catch {
    const out = join(workDir, "normalized.pdf");
    await runPython(pythonPath, NORMALIZE_PY, ["--op", "normalize", "--in", inPath, "--out", out]);
    return { ...(await checkedPdf(out)), workDir };
  }
}

export async function drawFlatPdf(
  inPath: string,
  outPath: string,
  placements: FlatPlacement[],
): Promise<void> {
  if (!placements.length) {
    await mkdir(dirname(outPath), { recursive: true });
    await copyFile(inPath, outPath);
    return;
  }
  const pdf = await PDFDocument.load(await readFile(inPath), {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
  });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const p of placements) {
    const page = pdf.getPage(p.page - 1);
    const { x, y } = point(page, p.xPct, p.yPct);
    if ("value" in p) page.drawText(p.value, { x, y, size: p.size, font, color: rgb(0, 0, 0) });
    else page.drawText("X", { x, y: y - 3, size: 11, font, color: rgb(0, 0, 0) });
  }
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, await pdf.save());
}

async function finishFlat(
  h: FlatHandle,
  toolCalls: ToolCallRecord[],
  modelUsed: string,
  summary: string,
): Promise<ScribeRunResult> {
  if (!h.placements.length) await drawFlatPdf(h.basePath, h.outPath, []);
  return { summary, toolCalls, modelUsed };
}

async function executeFlatTool(
  call: ChatCompletionMessageToolCall,
  h: FlatHandle,
  affectedThisTurn: Set<number>,
): Promise<{ record: ToolCallRecord; viewPage?: number; affectedPage?: number; summary?: string }> {
  const name = call.function.name;
  const parsed = parseArgs(call);
  if (!parsed.ok) return rec(call.id, name, {}, "error: invalid JSON tool arguments");
  const a = parsed.args;
  if (name === "view_page") {
    const page = intArg(a.page);
    const result = validPage(h, page)
      ? "ok: rendered page image returned to model"
      : pageError(h, page);
    return {
      ...rec(call.id, name, a, result),
      ...(result.startsWith("ok:") ? { viewPage: page } : {}),
    };
  }
  if (name === "place_text" || name === "place_mark") {
    const page = intArg(a.page);
    const result = validPlacement(h, a, page, name, affectedThisTurn);
    if (result) return rec(call.id, name, a, result);
    const placement =
      name === "place_text"
        ? {
            page,
            xPct: numArg(a.xPct),
            yPct: numArg(a.yPct),
            size: numArg(a.size),
            value: String(a.value),
          }
        : { page, xPct: numArg(a.xPct), yPct: numArg(a.yPct), mark: true as const };
    upsertPlacement(h, placement);
    return rec(call.id, name, a, `ok: placed ${flatFieldName(placement)}`, page);
  }
  if (name === "flag_uncertain") {
    const field = typeof a.field === "string" ? a.field : "";
    const reason = typeof a.reason === "string" ? a.reason : "";
    const confidence = a.confidence;
    let result = "";
    if (!field) result = "error: flag_uncertain requires a field";
    else if (!reason) result = "error: flag_uncertain requires a reason";
    else if (confidence !== "low" && confidence !== "medium")
      result = 'error: confidence must be "low" or "medium"';
    else {
      if (!flatFields(h).some((f) => f.name === field))
        h.extraFields.set(field, { name: field, kind: "unsupported", currentValue: "" });
      result = `ok: flagged ${field} uncertain (${confidence})`;
    }
    return rec(call.id, name, a, result);
  }
  if (name === "finish") {
    return { ...rec(call.id, name, a, "ok: run finished"), summary: String(a.summary ?? "") };
  }
  return rec(call.id, name, a, `error: unknown tool "${name}"`);
}

function rec(
  id: string,
  name: string,
  args: Record<string, unknown>,
  result: string,
  affectedPage?: number,
): { record: ToolCallRecord; affectedPage?: number } {
  return {
    record: { id, name, arguments: args, result },
    ...(affectedPage ? { affectedPage } : {}),
  };
}

function validPlacement(
  h: FlatHandle,
  a: Record<string, unknown>,
  page: number,
  name: string,
  affectedThisTurn: Set<number>,
): string {
  if (!validPage(h, page)) return pageError(h, page);
  if (!affectedThisTurn.has(page) && (h.batches.get(page) ?? 0) >= MAX_BATCHES_PER_PAGE)
    return "error: correction limit reached for this page; finish or flag_uncertain";
  for (const k of ["xPct", "yPct"]) {
    const n = numArg(a[k]);
    if (!Number.isFinite(n) || n < 0 || n > 100) return `error: ${k} must be 0-100`;
  }
  if (name === "place_text") {
    if (typeof a.value !== "string" || !a.value) return "error: place_text requires value";
    if (!Number.isFinite(numArg(a.size)) || numArg(a.size) <= 0)
      return "error: size must be positive";
  }
  return "";
}

function upsertPlacement(h: FlatHandle, p: FlatPlacement): void {
  const i =
    "value" in p
      ? h.placements.findIndex((x) => "value" in x && x.page === p.page && x.value === p.value)
      : h.placements.filter((x) => "mark" in x && x.page === p.page).length === 1
        ? h.placements.findIndex((x) => "mark" in x && x.page === p.page)
        : -1;
  if (i >= 0) h.placements[i] = p;
  else h.placements.push(p);
}

function flatFields(h: FlatHandle): FieldInfo[] {
  return [...h.placements.map(flatFieldInfo), ...h.extraFields.values()];
}

export function flatFieldInfo(p: FlatPlacement): FieldInfo {
  return "value" in p
    ? { name: flatFieldName(p), kind: "text", currentValue: p.value }
    : { name: flatFieldName(p), kind: "checkbox", currentValue: true };
}

export function flatFieldName(p: FlatPlacement): string {
  return `page${p.page}@${fmt(p.xPct)},${fmt(p.yPct)}: ${"value" in p ? p.value : "X"}`;
}

async function addPageImages(
  messages: ChatCompletionMessageParam[],
  h: FlatHandle,
  pages: Set<number>,
  text: string,
): Promise<void> {
  const content: ContentPart[] = [{ type: "text", text }];
  for (const page of pages)
    content.push({ type: "image_url", image_url: { url: await renderPage(h, page) } });
  messages.push({ role: "user", content: content as ChatCompletionContentPart[] });
}

async function renderPage(h: FlatHandle, page: number): Promise<string> {
  const key = `${h.version}:${page}`;
  const cached = h.renders.get(key);
  if (cached) return cached;
  const out = join(h.workDir, `page-${page}-v${h.version}.png`);
  await runPython(h.pythonPath, RASTERIZE_PY, [
    "--op",
    "rasterize",
    "--pdf",
    h.currentPath,
    "--page",
    String(page),
    "--out",
    out,
  ]);
  const url = `data:image/png;base64,${(await readFile(out)).toString("base64")}`;
  h.renders.set(key, url);
  return url;
}

async function checkedPdf(path: string): Promise<{ path: string; pageCount: number }> {
  const pdf = await PDFDocument.load(await readFile(path), {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
  });
  const pageCount = pdf.getPageCount();
  if (pageCount < 1) throw new Error("flat PDF has no pages");
  pdf.getPage(0);
  return { path, pageCount };
}

function parseArgs(
  call: ChatCompletionMessageToolCall,
): { ok: true; args: Record<string, unknown> } | { ok: false } {
  try {
    return { ok: true, args: call.function.arguments ? JSON.parse(call.function.arguments) : {} };
  } catch {
    return { ok: false };
  }
}

function intArg(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) ? v : Number.NaN;
}

function numArg(v: unknown): number {
  return typeof v === "number" ? v : Number.NaN;
}

function validPage(h: FlatHandle, page: number): boolean {
  return Number.isInteger(page) && page >= 1 && page <= h.pageCount;
}

function pageError(h: FlatHandle, page: number): string {
  return `error: page must be 1-${h.pageCount} (got ${String(page)})`;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

function point(page: PDFPage, xPct: number, yPct: number): { x: number; y: number } {
  const { width, height } = page.getSize();
  return { x: (width * xPct) / 100, y: height - (height * yPct) / 100 };
}

async function runPython(pythonPath: string, script: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(pythonPath, ["-", ...args], {
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(pythonPath),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`python failed (${code}): ${stderr || stdout}`)),
    );
    child.stdin.end(script);
  });
}

const NORMALIZE_PY = `
import argparse
from pypdf import PdfReader, PdfWriter
p = argparse.ArgumentParser()
p.add_argument("--op")
p.add_argument("--in", dest="inp", required=True)
p.add_argument("--out", required=True)
a = p.parse_args()
r = PdfReader(a.inp)
if getattr(r, "is_encrypted", False):
    r.decrypt("")
w = PdfWriter()
for page in r.pages:
    w.add_page(page)
with open(a.out, "wb") as f:
    w.write(f)
`;

const RASTERIZE_PY = `
import argparse
import pypdfium2 as pdfium
p = argparse.ArgumentParser()
p.add_argument("--op")
p.add_argument("--pdf", required=True)
p.add_argument("--page", type=int, required=True)
p.add_argument("--out", required=True)
a = p.parse_args()
doc = pdfium.PdfDocument(a.pdf)
page = doc[a.page - 1]
page.render(scale=200 / 72).to_pil().save(a.out)
`;
