// Phase proof: hit OpenRouter and confirm the model emits a list_fields call, then set_field
// calls, then finish — all targeting the real fixture form.
import "dotenv/config";
import { buildUserContent, runAgent } from "../agent.ts";
import { loadForm } from "../pdf.ts";

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY missing");
    process.exit(1);
  }
  const form = await loadForm("fixtures/sample-form.pdf");
  const userContent = await buildUserContent({
    texts: [
      "Jane A. Doe, born 1990-04-12. Lives in Memphis, TN. Email jane.doe@example.com. US citizen. Purpose: Business.",
    ],
    images: [],
  });
  const result = await runAgent({
    apiKey,
    model: process.env.SCRIBE_MODEL ?? "anthropic/claude-sonnet-4.5",
    userContent,
    form,
  });
  console.log(`Model: ${result.modelUsed}`);
  console.log(`Tool calls: ${result.toolCalls.length}`);
  for (const c of result.toolCalls) {
    const args = JSON.stringify(c.arguments);
    const short = c.result.length > 100 ? `${c.result.slice(0, 100)}...` : c.result;
    console.log(`  ${c.name}(${args}) -> ${short}`);
  }
  console.log(`\nSummary: ${result.summary}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
