import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

process.noDeprecation = true;

const { scribe } = await import("../src/scribe.ts");

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lwHu9QAAAABJRU5ErkJggg==",
  "base64",
);

async function main(): Promise<void> {
  await mkdir("out", { recursive: true });
  await rm("out/flatfill-fake-python.log", { force: true });
  const formPath = "out/flatfill-mode-source.pdf";
  const py = await fakePython("out/flatfill-fake-python");
  await flatPdf(formPath);

  let turn = 0;
  const seenMessages: any[][] = [];
  const result = await scribe({
    formPath,
    outPath: "out/flatfill-mode-filled.pdf",
    inputs: { texts: ["Write FIRST and mark the visible checkbox."], images: [] },
    apiKey: "offline",
    model: "mock-flat",
    pythonPath: py,
    complete: async (req: any) => {
      seenMessages.push(req.messages);
      const batches = [
        [tc("view_page", { page: 1 })],
        [
          tc("place_text", { page: 1, xPct: 20, yPct: 25, size: 10, value: "FIRST" }),
          tc("place_mark", { page: 1, xPct: 30, yPct: 35 }),
        ],
        [tc("place_text", { page: 1, xPct: 21, yPct: 26, size: 10, value: "FIRST" })],
        [tc("place_text", { page: 1, xPct: 22, yPct: 27, size: 10, value: "FIRST" })],
        [
          tc("place_text", { page: 1, xPct: 23, yPct: 28, size: 10, value: "FIRST" }),
          tc("flag_uncertain", {
            field: "page1@22,27: FIRST",
            reason: "Placement was bounded after two correction rounds.",
            confidence: "medium",
          }),
          tc("finish", { summary: "Flat placement proof complete." }),
        ],
      ];
      return { choices: [{ message: { role: "assistant", tool_calls: batches[turn++] } }] };
    },
  });

  assert.equal(result.modelUsed, "mock-flat");
  assert.equal(result.summary, "Flat placement proof complete.");
  assert.equal(result.uncertainFlags.length, 1);
  assert(result.toolCallCount >= 8);

  const transcript = JSON.parse(await readFile(result.transcriptPath, "utf8"));
  assert.equal(transcript.toolCalls.at(-1).name, "finish");
  assert(
    transcript.toolCalls.some((c: any) => c.name === "view_page" && /^ok: rendered/.test(c.result)),
  );
  assert(
    transcript.toolCalls.some((c: any) => c.name === "place_mark" && /^ok: placed/.test(c.result)),
  );
  assert(
    transcript.toolCalls.some(
      (c: any) => c.name === "place_text" && /^error: correction limit reached/.test(c.result),
    ),
  );
  assert(transcript.toolCalls.some((c: any) => /page1@22,27: FIRST/.test(c.result)));
  assert(
    seenMessages.flat().some((m: any) => String(JSON.stringify(m.content)).includes("image_url")),
  );
  assert.equal(
    (await readFile("out/flatfill-fake-python.log", "utf8")).match(/rasterize/g)?.length,
    4,
  );
  assert.equal((await readFile(result.outPath)).subarray(0, 4).toString(), "%PDF");
  await serverAcceptsFlat(formPath, py);
  console.log("ok: flatfill mode tools, bounded iterate loop, transcript shape");
}

function tc(name: string, args: Record<string, unknown>) {
  return {
    id: `call_${name}_${Math.random().toString(16).slice(2)}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

async function flatPdf(path: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Flat source PDF", { x: 72, y: 720, size: 18, font });
  page.drawRectangle({ x: 180, y: 580, width: 180, height: 18, borderWidth: 1 });
  page.drawRectangle({ x: 180, y: 540, width: 12, height: 12, borderWidth: 1 });
  await writeFile(path, await pdf.save());
}

async function fakePython(root: string): Promise<string> {
  const js = `${root}.mjs`;
  const cmd = `${root}.cmd`;
  await writeFile(
    js,
    `
import { appendFileSync, copyFileSync, writeFileSync } from "node:fs";
const png = Buffer.from("${png.toString("base64")}", "base64");
const a = process.argv.slice(2), get = (k) => a[a.indexOf(k) + 1];
appendFileSync("out/flatfill-fake-python.log", get("--op") + "\\n");
if (get("--op") === "normalize") copyFileSync(get("--in"), get("--out"));
else writeFileSync(get("--out"), png);
`,
  );
  await writeFile(
    cmd,
    `@echo off\r\n"${process.execPath}" "%~dp0${resolve(js).split(/[\\/]/).at(-1)}" %*\r\n`,
  );
  return resolve(cmd);
}

async function serverAcceptsFlat(formPath: string, pythonPath: string): Promise<void> {
  const oldKey = process.env.OPENROUTER_API_KEY;
  const oldPython = process.env.SCRIBE_PYTHON;
  process.env.OPENROUTER_API_KEY = "";
  process.env.SCRIBE_PYTHON = pythonPath;
  const { createServer } = await import("../src/server.ts");
  const server = createServer(process.cwd());
  server.listen(0);
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pdf: (await readFile(formPath)).toString("base64"),
        sources: [
          {
            name: "notes.txt",
            type: "text/plain",
            data: Buffer.from("FIRST").toString("base64"),
          },
        ],
      }),
    });
    const text = await res.text();
    assert.equal(res.ok, true, text);
    assert.match(JSON.parse(text).id, /^run_/);
  } finally {
    server.close();
    process.env.OPENROUTER_API_KEY = oldKey;
    process.env.SCRIBE_PYTHON = oldPython;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
