// Minimal local server for the Scribe UI.
//   npm run serve   →   http://127.0.0.1:8787
// One endpoint: POST /api/run with {pdf: base64, sources:[{name,type,data:base64}]}
// (JSON, or multipart with a `pdf` file, source files, and `text` fields).
// Responds with {filledPdfBase64, transcript, summary, uncertainFlags}. No run persistence.
import "dotenv/config";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceInputs } from "./agent.ts";
import { scribe } from "./scribe.ts";

type ApiSource = { name: string; type: string; data: string };

export function createApp(root = process.cwd()) {
  const indexPath = resolve(root, "web", "index.html");
  return createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/api/run") {
        return send(res, 200, await run(await readBody(req)));
      }
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        const body = await readFile(indexPath);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(body);
      }
      send(res, 404, { error: "not found" });
    } catch (err) {
      send(res, err instanceof SyntaxError ? 400 : 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

async function run(body: { pdf?: string; sources?: ApiSource[] }) {
  if (typeof body.pdf !== "string") throw new Error("pdf base64 is required");
  if (!Array.isArray(body.sources) || body.sources.length === 0) {
    throw new Error("at least one source is required");
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const dir = await mkdtemp(join(tmpdir(), "scribe-"));
  try {
    const formPath = join(dir, "form.pdf");
    const outPath = join(dir, "filled.pdf");
    await writeFile(formPath, Buffer.from(body.pdf, "base64"));
    const inputs = await writeSources(body.sources, dir);
    const result = await scribe({ formPath, outPath, inputs, apiKey });
    const transcript = JSON.parse(await readFile(result.transcriptPath, "utf8"));
    return {
      filledPdfBase64: (await readFile(outPath)).toString("base64"),
      transcript: transcript.toolCalls,
      summary: result.summary,
      uncertainFlags: result.uncertainFlags,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeSources(sources: ApiSource[], dir: string): Promise<SourceInputs> {
  const inputs: SourceInputs = { texts: [], images: [] };
  for (const [i, s] of sources.entries()) {
    if (typeof s?.data !== "string") throw new Error(`source ${i + 1} missing base64 data`);
    const name = basename(s.name || `source-${i + 1}.txt`).replace(/[^\w.-]+/g, "_");
    const bytes = Buffer.from(s.data, "base64");
    if (s.type?.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(name)) {
      const path = join(dir, name);
      await writeFile(path, bytes);
      inputs.images.push(path);
    } else {
      inputs.texts.push(bytes.toString("utf8"));
    }
  }
  return inputs;
}

async function readBody(req: IncomingMessage): Promise<{ pdf?: string; sources?: ApiSource[] }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > 60_000_000) throw new Error("request body too large");
  }
  const buf = Buffer.concat(chunks);
  const type = req.headers["content-type"] ?? "";
  if (type.startsWith("multipart/form-data")) return parseMultipart(buf, type);
  return JSON.parse(buf.toString("utf8") || "{}");
}

// Bare-minimum multipart parser: `pdf` file, any other files become sources, `text` fields
// become text sources. Enough for curl-style clients; the bundled UI posts JSON.
function parseMultipart(buf: Buffer, contentType: string) {
  const boundary = /--([^\s;]+)/.exec(contentType)?.[1];
  if (!boundary) throw new Error("multipart boundary missing");
  const body: { pdf?: string; sources: ApiSource[] } = { sources: [] };
  for (const part of buf.toString("binary").split(`--${boundary}`).slice(1, -1)) {
    const [rawHead, ...rest] = part.split("\r\n\r\n");
    const data = Buffer.from(rest.join("\r\n\r\n").replace(/\r\n$/, ""), "binary");
    const name = /name="([^"]+)"/.exec(rawHead ?? "")?.[1] ?? "";
    const filename = /filename="([^"]+)"/.exec(rawHead ?? "")?.[1];
    const mime = /content-type:\s*(\S+)/i.exec(rawHead ?? "")?.[1] ?? "text/plain";
    if (name === "pdf" && filename) body.pdf = data.toString("base64");
    else if (name === "text")
      body.sources.push({ name: "notes.txt", type: "text/plain", data: data.toString("base64") });
    else if (filename)
      body.sources.push({ name: filename, type: mime, data: data.toString("base64") });
  }
  return body;
}

function send(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  createApp().listen(port, "127.0.0.1", () => {
    console.log(`Scribe UI: http://127.0.0.1:${port}`);
  });
}
