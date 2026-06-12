// Vertical proof: fill IRS f2848 from tax-resolution intake notes.
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { scribe } from "../src/scribe.ts";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY missing");
  process.exit(1);
}
const notes = await readFile("proofs-i130/intake-notes.txt", "utf8");

const result = await scribe({
  formPath: "proofs-i130/f2848.pdf",
  outPath: "out/f2848-filled.pdf",
  inputs: { texts: [notes], images: [] },
  apiKey,
});

console.log("Filled PDF :", result.outPath);
console.log("Transcript :", result.transcriptPath);
console.log("Tool calls :", result.toolCallCount);
console.log("Summary    :", result.summary);
