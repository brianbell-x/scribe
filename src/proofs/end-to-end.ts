// Phase proof: scribe() called with the same inputs the CLI would use, end-to-end.
// Reads fixture, runs agent, writes filled PDF + transcript JSON.
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { scribe } from "../scribe.ts";
import { fixtureComplete } from "./mock-agent.ts";

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const offline = process.env.SCRIBE_OFFLINE === "1" || !apiKey;
  const notes = await readFile("fixtures/sample-notes.txt", "utf8");

  const result = await scribe({
    formPath: "fixtures/sample-form.pdf",
    outPath: "out/e2e-filled.pdf",
    inputs: { texts: [notes], images: [] },
    apiKey: offline ? "offline" : (apiKey ?? "offline"),
    model: offline ? "mock-offline" : process.env.SCRIBE_MODEL,
    complete: offline ? fixtureComplete() : undefined,
  });

  console.log("Filled PDF :", result.outPath);
  console.log("Transcript :", result.transcriptPath);
  console.log("Model      :", result.modelUsed);
  console.log("Tool calls :", result.toolCallCount);
  console.log("");
  console.log("Summary    :", result.summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
