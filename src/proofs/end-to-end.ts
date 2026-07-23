// End-to-end proof: scribe() called with the same inputs the CLI would use, always against
// the injected mock `complete` so it runs headlessly with no API key. Writes the filled PDF
// and transcript to out/ and asserts the expected fields were set.
import { readFile } from "node:fs/promises";
import { loadForm } from "../pdf.ts";
import { scribe } from "../scribe.ts";
import { fixtureComplete } from "./mock-agent.ts";

async function main(): Promise<void> {
  const notes = await readFile("fixtures/sample-notes.txt", "utf8");

  const result = await scribe({
    formPath: "fixtures/sample-form.pdf",
    outPath: "out/e2e-filled.pdf",
    inputs: { texts: [notes], images: [] },
    apiKey: "offline",
    model: "mock-offline",
    complete: fixtureComplete(),
  });

  const form = await loadForm(result.outPath);
  const values = Object.fromEntries([...form.fields.values()].map((f) => [f.name, f.currentValue]));
  const expect: Record<string, unknown> = {
    full_name: "Jane A. Doe",
    date_of_birth: "1990-04-12",
    city: "Memphis",
    state: "TN",
    email: "jane.doe@example.com",
    us_citizen: true,
    purpose: "Business",
  };
  const failures = Object.entries(expect).filter(([k, v]) => values[k] !== v);
  if (failures.length) {
    throw new Error(`field mismatch: ${failures.map(([k]) => k).join(", ")}`);
  }
  if (result.uncertainFlags.length !== 1 || result.uncertainFlags[0]?.field !== "purpose") {
    throw new Error(`unexpected uncertainFlags: ${JSON.stringify(result.uncertainFlags)}`);
  }

  console.log("Filled PDF :", result.outPath);
  console.log("Transcript :", result.transcriptPath);
  console.log("Tool calls :", result.toolCallCount);
  console.log("Summary    :", result.summary);
  console.log("Flags      :", JSON.stringify(result.uncertainFlags));
  console.log("E2E proof passed (offline mock).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
