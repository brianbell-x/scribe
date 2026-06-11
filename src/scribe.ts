// Top-level orchestration: load form, build inputs, run agent, persist outputs.
// This is the function a future UI would call directly (the CLI is just a thin wrapper).
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import {
  type SourceInputs,
  type ToolCallRecord,
  type UncertainFlag,
  buildUserContent,
  runAgent,
} from "./agent.ts";
import { loadForm, saveForm } from "./pdf.ts";

export type { SourceInputs } from "./agent.ts";

export interface ScribeOptions {
  formPath: string;
  outPath: string;
  inputs: SourceInputs;
  apiKey: string;
  model?: string;
}

export interface ScribeResult {
  outPath: string;
  transcriptPath: string;
  summary: string;
  modelUsed: string;
  toolCallCount: number;
  uncertainFlags: UncertainFlag[];
}

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

export async function scribe(opts: ScribeOptions): Promise<ScribeResult> {
  const model = opts.model ?? process.env.SCRIBE_MODEL ?? DEFAULT_MODEL;

  // Parse the form first so we can fail fast if it's not an AcroForm.
  const form = await loadForm(opts.formPath);
  if (form.fields.size === 0) {
    throw new Error(
      `No AcroForm fields found in ${opts.formPath}. Scribe currently supports AcroForm PDFs only.`,
    );
  }

  const userContent = await buildUserContent(opts.inputs);

  // Run the agent loop. Each set_field tool call mutates `form` in place; we only write at the end.
  const run = await runAgent({ apiKey: opts.apiKey, model, userContent, form });

  // Persist the filled PDF, then write the tool-call transcript next to it.
  await saveForm(form, opts.outPath);
  const uncertainFlags = collectUncertainFlags(run.toolCalls);
  const transcriptPath = resolve(
    dirname(opts.outPath),
    `${basename(opts.outPath, extname(opts.outPath))}.transcript.json`,
  );
  await mkdir(dirname(transcriptPath), { recursive: true });
  await writeFile(
    transcriptPath,
    JSON.stringify(
      {
        model: run.modelUsed,
        formPath: opts.formPath,
        outPath: opts.outPath,
        summary: run.summary,
        toolCalls: run.toolCalls,
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    outPath: opts.outPath,
    transcriptPath,
    summary: run.summary,
    modelUsed: run.modelUsed,
    toolCallCount: run.toolCalls.length,
    uncertainFlags,
  };
}

export function collectUncertainFlags(toolCalls: ToolCallRecord[]): UncertainFlag[] {
  return toolCalls.flatMap((c) => {
    const confidence = c.arguments.confidence;
    return c.name === "flag_uncertain" &&
      c.result.startsWith("ok:") &&
      typeof c.arguments.field === "string" &&
      typeof c.arguments.reason === "string" &&
      (confidence === "low" || confidence === "medium")
      ? [{ field: c.arguments.field, reason: c.arguments.reason, confidence }]
      : [];
  });
}

export function renderCliSummary(result: ScribeResult): string {
  const lines = [
    `Filled PDF: ${result.outPath}`,
    `Transcript: ${result.transcriptPath}`,
    `Model:      ${result.modelUsed}`,
    `Tool calls: ${result.toolCallCount}`,
    "",
    `Summary: ${result.summary}`,
  ];
  if (result.uncertainFlags.length) {
    lines.push(
      "",
      "Uncertain fields:",
      ...result.uncertainFlags.map((f) => `- ${f.field} [${f.confidence}]: ${f.reason}`),
    );
  }
  return lines.join("\n");
}
