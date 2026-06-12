// Thin agent loop over OpenRouter. Uses the OpenAI Node SDK with `baseURL` swapped to
// OpenRouter — no agent framework, the loop is small enough to debug at a glance.
//
// This file also owns the conversion of raw user inputs (strings + image paths) into the
// chat content parts the model reads. The two concerns share the same "talking to the model"
// boundary, so they live together rather than in a 50-line inputs.ts sibling.
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import OpenAI from "openai";
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import type { FormHandle } from "./pdf.ts";
import { listFields, setField } from "./pdf.ts";

// ─── Input shaping ──────────────────────────────────────────────────────────────────────────

export interface SourceInputs {
  texts: string[]; // plain strings: notes, OCR output, transcripts, etc.
  images: string[]; // filesystem paths to PNG / JPEG / WebP / GIF
}

// Chat content part types — narrowed to just what OpenAI / OpenRouter consume.
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export async function buildUserContent(inputs: SourceInputs): Promise<ContentPart[]> {
  const parts: ContentPart[] = [];

  if (inputs.texts.length > 0) {
    // Combine all text inputs into a single labeled block so the model sees them as one corpus.
    parts.push({
      type: "text",
      text: [
        "Source notes / extracted text:",
        ...inputs.texts.map((t, i) => `[${i + 1}] ${t}`),
      ].join("\n"),
    });
  }

  // Read all images in parallel — at 1–10 images this turns N×disk-latency into ~1×.
  const imageParts = await Promise.all(
    inputs.images.map(async (path): Promise<ContentPart> => {
      const bytes = await readFile(path);
      const url = `data:${mimeFor(path)};base64,${bytes.toString("base64")}`;
      return { type: "image_url", image_url: { url } };
    }),
  );
  parts.push(...imageParts);
  return parts;
}

function mimeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

// ─── Tool schemas & system prompt ───────────────────────────────────────────────────────────

// We define the schemas inline so the JSON the model receives matches exactly what the loop
// dispatches on below. Four tools total.
export const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "list_fields",
      description:
        "List every fillable field on the target PDF form. Returns name, kind (text/checkbox/radio/dropdown/optionlist), maxLength for constrained text fields, available options for choice fields, and currentValue. Call this once at the start to plan.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_field",
      description:
        "Write a value into one field on the PDF. Respect list_fields constraints: text maxLength, checkbox true/false, dropdown/radio exact listed option, optionlist array of listed options.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Exact field name from list_fields." },
          value: { description: "string | boolean | string[] depending on the field kind" },
        },
        required: ["name", "value"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "flag_uncertain",
      description:
        "Mark one form field for human review without changing the PDF. Use after set_field for best guesses, or for fields you could not fill.",
      parameters: {
        type: "object",
        properties: {
          field: { type: "string", description: "Exact field name from list_fields." },
          reason: { type: "string", description: "Brief reason this field needs review." },
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
      description:
        "End the run. Pass a short human-readable summary of what was filled and any fields you left blank (and why).",
      parameters: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false,
      },
    },
  },
];

const SYSTEM_PROMPT = `
You are Scribe, an agent that copies information from source inputs (text and/or images)
onto a PDF form. You never see the rendered PDF; you only see field names and types via
the list_fields tool.

Rules:
- Start by calling list_fields exactly once to learn the form.
- For every relevant field you can support, call set_field with the correct value.
- If evidence is uncertain but a plausible value exists, set the best-guess value with
  set_field first, then call flag_uncertain with field, reason, and low/medium confidence.
- Do not leave fields empty out of caution. Leave a field blank only when no plausible value
  exists; if that field matters, call flag_uncertain with why it could not be filled.
- Before calling set_field, respect list_fields constraints: text maxLength and listed options.
- For dates, use the format implied by the field label (YYYY-MM-DD if unclear).
- When done, call the finish tool with a one-paragraph summary of what was filled and what
  was deliberately left blank (and why).
- Do not repeat set_field calls for the same value. Do not loop.
`.trim();

// ─── Agent loop ─────────────────────────────────────────────────────────────────────────────

// Persistent record of every tool call. This *is* the audit log; the UI replays it later.
export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: string;
}

export type UncertaintyConfidence = "low" | "medium";
export interface UncertainFlag {
  field: string;
  reason: string;
  confidence: UncertaintyConfidence;
}

export interface ScribeRunResult {
  summary: string;
  toolCalls: ToolCallRecord[];
  modelUsed: string;
}

// Bound the loop. In practice we settle in 2–5 round-trips on the sample form; the ceiling
// exists so a runaway model never spins forever.
const MAX_TURNS = 12;

export async function runAgent(args: {
  apiKey: string;
  model: string;
  userContent: ContentPart[];
  form: FormHandle;
  onToolCall?: (record: ToolCallRecord) => void;
}): Promise<ScribeRunResult> {
  const client = new OpenAI({ apiKey: args.apiKey, baseURL: "https://openrouter.ai/api/v1" });

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: args.userContent as ChatCompletionContentPart[] },
  ];
  const toolCalls: ToolCallRecord[] = [];
  let summary = "";
  let stopReason: "finish" | "no-tool-calls" | "max-turns" = "max-turns";

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await client.chat.completions.create({
      model: args.model,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
    });
    const choice = resp.choices[0];
    if (!choice) throw new Error("OpenRouter returned no choices");
    const msg = choice.message;
    messages.push(msg);

    // No tool calls → the model decided the work is done. Capture content as summary and stop.
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      summary = (msg.content as string | undefined) ?? "";
      stopReason = "no-tool-calls";
      break;
    }

    let finished = false;
    for (const call of msg.tool_calls) {
      const outcome = executeToolCall(call, args.form);
      if (outcome.finished) {
        finished = true;
        summary = outcome.summary ?? summary;
      }
      toolCalls.push(outcome.record);
      args.onToolCall?.(outcome.record);
      messages.push({ role: "tool", tool_call_id: call.id, content: outcome.record.result });
    }

    if (finished) {
      stopReason = "finish";
      break;
    }
  }

  if (stopReason === "max-turns") {
    throw new Error(
      `agent did not call finish within ${MAX_TURNS} turns; partial transcript has ${toolCalls.length} calls`,
    );
  }

  return { summary, toolCalls, modelUsed: args.model };
}

// Pure dispatch for a single tool call. Returns the record we keep + whether the loop ends.
function executeToolCall(
  call: ChatCompletionMessageToolCall,
  form: FormHandle,
): { record: ToolCallRecord; finished: boolean; summary?: string } {
  const name = call.function.name;
  const rawArgs = call.function.arguments ?? "";
  let parsedArgs: Record<string, unknown>;
  try {
    parsedArgs = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return {
      record: { id: call.id, name, arguments: {}, result: "error: invalid JSON tool arguments" },
      finished: false,
    };
  }

  if (name === "list_fields") {
    return {
      record: {
        id: call.id,
        name,
        arguments: parsedArgs,
        result: JSON.stringify(listFields(form)),
      },
      finished: false,
    };
  }
  if (name === "set_field") {
    const fieldName = typeof parsedArgs.name === "string" ? parsedArgs.name : "";
    const result = setField(form, fieldName, parsedArgs.value);
    return { record: { id: call.id, name, arguments: parsedArgs, result }, finished: false };
  }
  if (name === "flag_uncertain") {
    const field = typeof parsedArgs.field === "string" ? parsedArgs.field : "";
    const reason = typeof parsedArgs.reason === "string" ? parsedArgs.reason : "";
    const confidence = parsedArgs.confidence;
    let result = "";
    if (!form.fields.has(field)) result = `error: no field named "${field}"`;
    else if (!reason) result = "error: flag_uncertain requires a reason";
    else if (confidence !== "low" && confidence !== "medium") {
      result = 'error: confidence must be "low" or "medium"';
    } else result = `ok: flagged ${field} uncertain (${confidence})`;
    return { record: { id: call.id, name, arguments: parsedArgs, result }, finished: false };
  }
  if (name === "finish") {
    const summary = String(parsedArgs.summary ?? "");
    return {
      record: { id: call.id, name, arguments: parsedArgs, result: "ok: run finished" },
      finished: true,
      summary,
    };
  }
  return {
    record: { id: call.id, name, arguments: parsedArgs, result: `error: unknown tool "${name}"` },
    finished: false,
  };
}
