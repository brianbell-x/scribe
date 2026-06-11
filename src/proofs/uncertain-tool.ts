import assert from "node:assert/strict";

process.noDeprecation = true;
const { TOOLS } = await import("../agent.ts");
const { collectUncertainFlags, renderCliSummary } = await import("../scribe.ts");

const tool = TOOLS.find((t) => t.function.name === "flag_uncertain");
assert(tool, "flag_uncertain tool is registered");
const schema = JSON.parse(JSON.stringify(tool.function.parameters));
assert.deepEqual(schema.required, ["field", "reason", "confidence"]);
assert.deepEqual(schema.properties.confidence.enum, ["low", "medium"]);

const summary = renderCliSummary({
  outPath: "out/filled.pdf",
  transcriptPath: "out/filled.transcript.json",
  summary: "Filled one field.",
  modelUsed: "offline",
  toolCallCount: 3,
  uncertainFlags: collectUncertainFlags([
    {
      id: "toolu_test",
      name: "flag_uncertain",
      arguments: {
        field: "date_of_birth",
        reason: "Source image is partly cut off.",
        confidence: "low",
      },
      result: "ok: flagged date_of_birth uncertain (low)",
    },
  ]),
});
assert.match(summary, /Uncertain fields:/);
assert.match(summary, /- date_of_birth \[low\]: Source image is partly cut off\./);
console.log("ok: flag_uncertain schema and CLI summary");
