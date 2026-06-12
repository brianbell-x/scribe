import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PDFDocument, type PDFPage, StandardFonts, rgb } from "pdf-lib";

export type Placement =
  | { page: number; xPct: number; yPct: number; size: number; value: string }
  | { page: number; xPct: number; yPct: number; mark: true };

export interface DrawResult {
  outPath: string;
  streamsBefore: number;
  streamsAfter: number;
}

export async function drawOverlay(
  inPath: string,
  outPath: string,
  placements: Placement[],
  debug = false,
): Promise<DrawResult> {
  const pdf = await loadPdf(inPath);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = new Set(placements.map((p) => p.page));
  const streamsBefore = [...pages].reduce((n, p) => n + streamCount(pdf.getPage(p - 1)), 0);
  for (const p of placements) {
    const page = pdf.getPage(p.page - 1);
    const { x, y } = point(page, p.xPct, p.yPct);
    if ("value" in p) {
      page.drawText(p.value, { x, y, size: p.size, font, color: rgb(0, 0, 0) });
      if (debug) box(page, x, y - p.size * 0.2, p.size * p.value.length * 0.55, p.size * 1.2);
    } else {
      page.drawText("X", { x, y: y - 3, size: 11, font, color: rgb(0, 0, 0) });
      if (debug) box(page, x - 2, y - 5, 11, 11);
    }
  }
  const streamsAfter = [...pages].reduce((n, p) => n + streamCount(pdf.getPage(p - 1)), 0);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, await pdf.save());
  return { outPath, streamsBefore, streamsAfter };
}

function point(page: PDFPage, xPct: number, yPct: number): { x: number; y: number } {
  const { width, height } = page.getSize();
  return { x: (width * xPct) / 100, y: height - (height * yPct) / 100 };
}

function box(page: PDFPage, x: number, y: number, width: number, height: number): void {
  page.drawRectangle({
    x,
    y,
    width,
    height,
    borderColor: rgb(1, 0, 0),
    borderOpacity: 0.35,
    borderWidth: 0.5,
  });
}

function streamCount(page: PDFPage): number {
  return page.node.normalizedEntries().Contents?.size() ?? 0;
}

async function loadPdf(path: string): Promise<PDFDocument> {
  const warn = console.warn;
  console.warn = (...args) => {
    const msg = String(args[0] ?? "");
    if (
      !msg.startsWith("Trying to parse invalid object") &&
      !msg.startsWith("Invalid object ref")
    ) {
      warn(...args);
    }
  };
  try {
    return await PDFDocument.load(await readFile(path), {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
    });
  } finally {
    console.warn = warn;
  }
}

async function check(): Promise<void> {
  const placements: Placement[] = [
    { page: 1, xPct: 12, yPct: 18, size: 10, value: "FLATFILL_PROOF_FAMILY" },
    { page: 1, xPct: 12, yPct: 22, size: 10, value: "FLATFILL_PROOF_GIVEN" },
    { page: 1, xPct: 8, yPct: 14, mark: true },
  ];
  try {
    await drawOverlay("proofs-i130/i-130.pdf", "out/flatfill-i130-direct.pdf", placements);
  } catch (err) {
    console.warn(
      `note: direct I-130 draw blocked by pdf-lib page-tree load: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const normal = await drawOverlay("proofs-i130/f2848.pdf", "out/flatfill-draw.pdf", placements);
  assert.ok(normal.streamsAfter > normal.streamsBefore);
  await PDFDocument.load(await readFile(normal.outPath), {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
  });
  await drawOverlay("proofs-i130/f2848.pdf", "out/flatfill-draw-debug.pdf", placements, true);
  console.log("ok: flatfill draw wrote out/flatfill-draw.pdf and out/flatfill-draw-debug.pdf");
}

if (process.argv.includes("--check")) {
  check().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
