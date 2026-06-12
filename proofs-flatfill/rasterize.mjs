#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const HELP = `
Usage:
  node proofs-flatfill/rasterize.mjs --pdf proofs-i130/i-130.pdf --out out/i130-pages --pages 1 --playwright-python <python>

Best-effort PDF-to-PNG helper. It runs the supplied Python with Playwright Chromium and
saves page-N.png files. If local Playwright/browser PDF rendering is unavailable, render
page 1 with Poppler, then pass that directory to the runner:
  pdftoppm -png -f 1 -l 1 -r 200 proofs-i130/i-130.pdf out/i130-pages/page
  tsx proofs-flatfill/run-i130-overlay.ts --pages <dir>
`.trim();

const args = parse(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
for (const k of ["pdf", "out", "playwright-python"]) {
  if (!args[k]) throw new Error(`missing --${k}\n${HELP}`);
}
mkdirSync(String(args.out), { recursive: true });
const py = spawn(
  String(args["playwright-python"]),
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
import argparse, pathlib, sys, time
from playwright.sync_api import sync_playwright
p = argparse.ArgumentParser()
p.add_argument("--pdf", required=True); p.add_argument("--out", required=True); p.add_argument("--pages", default="1")
a = p.parse_args()
out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    for n in [int(x) for x in a.pages.split(",") if x]:
        page = browser.new_page(viewport={"width": 1600, "height": 2200}, device_scale_factor=1)
        page.goto(pathlib.Path(a.pdf).as_uri() + f"#page={n}&zoom=page-width", wait_until="networkidle")
        page.wait_for_timeout(1500)
        page.screenshot(path=str(out / f"page-{n}.png"), full_page=True)
        page.close()
    browser.close()
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
