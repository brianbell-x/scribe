#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const HELP = `
Usage:
  node proofs-flatfill/rasterize.mjs --pdf proofs-i130/i-130.pdf --out out/i130-pages --pages 1 --python <python>

PDF-to-PNG helper matching product flat mode: the supplied Python must have pypdfium2.
`.trim();

const args = parse(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
for (const k of ["pdf", "out", "python"]) if (!args[k]) throw new Error(`missing --${k}\n${HELP}`);
mkdirSync(String(args.out), { recursive: true });
const py = spawn(
  String(args.python),
  [
    "-",
    "--pdf",
    resolve(String(args.pdf)),
    "--out",
    resolve(String(args.out)),
    "--pages",
    String(args.pages ?? "1"),
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);
py.stdin.end(String.raw`
import argparse, pathlib
import pypdfium2 as pdfium
p = argparse.ArgumentParser()
p.add_argument("--pdf", required=True); p.add_argument("--out", required=True); p.add_argument("--pages", default="1")
a = p.parse_args()
doc = pdfium.PdfDocument(a.pdf)
out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
for n in [int(x) for x in a.pages.split(",") if x]:
    doc[n - 1].render(scale=200 / 72).to_pil().save(out / f"page-{n}.png")
`);
py.on("exit", (code) => process.exit(code ?? 1));

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i] ?? "";
  }
  return out;
}
