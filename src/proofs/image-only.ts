// Phase proof: image-only input. Confirms the vision branch — model reads the card PNG,
// extracts the applicant info, and fills the form via tool calls. No text input at all.
import "dotenv/config";
import { scribe } from "../scribe.ts";

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY missing");
    process.exit(1);
  }

  const result = await scribe({
    formPath: "fixtures/sample-form.pdf",
    outPath: "out/image-only-filled.pdf",
    inputs: { texts: [], images: ["fixtures/sample-card.png"] },
    apiKey,
  });

  console.log("Filled PDF :", result.outPath);
  console.log("Transcript :", result.transcriptPath);
  console.log("Model      :", result.modelUsed);
  console.log("Tool calls :", result.toolCallCount);
  console.log("\nSummary    :", result.summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
