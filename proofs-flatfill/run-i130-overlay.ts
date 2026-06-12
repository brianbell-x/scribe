// ORCHESTRATOR LEGACY PROOF: product flat mode now lives behind:
//   npm run scribe -- --form proofs-i130/i-130.pdf --text "<intake notes>" --out out/i130-flat.pdf --python <python>
// This script remains as the original live probe for pre-rendered page PNGs + drawable PDF.
import "dotenv/config";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import OpenAI from "openai";
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { buildUserContent } from "../src/agent.ts";
import { type Placement, drawOverlay } from "./draw.ts";

const INSTRUCTIONS = `
Live flat-fill overlay proof.
Requires: OPENROUTER_API_KEY, page PNGs in --pages, and a pdf-lib drawable --pdf.
Default output: out/i130-overlay.pdf plus out/i130-overlay-debug.pdf.
`.trim();

const SYSTEM = `
You place text and checkbox marks on a PDF form from a page screenshot.
Return only strict JSON: {"placements":[{"page":1,"xPct":0-100,"yPct":0-100,"size":number,"value":"text"} or {"page":1,"xPct":0-100,"yPct":0-100,"mark":true}]}.
Coordinates are percentages from the visible page box: xPct 0 is left, yPct 0 is top.
Place only the requested sample values. No commentary.
`.trim();

async function main(): Promise<void> {
  console.log(INSTRUCTIONS);
  const args = parse(process.argv.slice(2));
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");
  const pagesDir = args.pages ?? "out/i130-pages";
  const pdf = args.pdf ?? "proofs-i130/i-130.pdf";
  const out = args.out ?? "out/i130-overlay.pdf";
  const pngs = (await readdir(pagesDir))
    .filter((f) => /\.png$/i.test(f))
    .sort()
    .map((f) => join(pagesDir, f));
  if (!pngs.length) throw new Error(`no PNG pages found in ${pagesDir}`);

  const prompt = `
Sample values to overlay on I-130 page 1:
- Petitioner family name: FLATFILL
- Petitioner given name: PROOF
- Mark the checkbox for "Spouse" if that relationship checkbox is visible.
Use 10pt text unless a field visibly needs smaller text.
`.trim();
  const userContent = await buildUserContent({ texts: [prompt], images: pngs });
  const client = new OpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1" });
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: userContent as ChatCompletionContentPart[] },
  ];
  const resp = await client.chat.completions.create({
    model: args.model ?? process.env.SCRIBE_MODEL ?? "anthropic/claude-sonnet-4.5",
    messages,
    response_format: { type: "json_object" },
    temperature: 0,
  });
  const raw = resp.choices[0]?.message.content;
  if (!raw) throw new Error("model returned no placement JSON");
  const placements = parsePlacements(raw);
  await drawOverlay(pdf, out, placements);
  await drawOverlay(pdf, out.replace(/\.pdf$/i, "-debug.pdf"), placements, true);
  console.log(`wrote ${out} and ${out.replace(/\.pdf$/i, "-debug.pdf")}`);
  console.log(JSON.stringify({ placements }, null, 2));
}

function parsePlacements(raw: string): Placement[] {
  const stripped = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const json = JSON.parse(stripped) as { placements?: unknown[] };
  if (!Array.isArray(json.placements)) throw new Error("JSON must contain placements[]");
  return json.placements.map((p) => {
    if (!p || typeof p !== "object") throw new Error("placement must be an object");
    const o = p as Record<string, unknown>;
    const page = num(o.page, "page");
    const xPct = num(o.xPct, "xPct");
    const yPct = num(o.yPct, "yPct");
    if (typeof o.value === "string")
      return { page, xPct, yPct, size: num(o.size, "size"), value: o.value };
    if (o.mark === true) return { page, xPct, yPct, mark: true };
    throw new Error("placement needs value or mark:true");
  });
}

function num(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
  return v;
}

function parse(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key?.startsWith("--")) out[key.slice(2)] = argv[++i] ?? "";
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
