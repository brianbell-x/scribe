import { resolve } from "node:path";
import { listFields, loadForm } from "../../src/pdf.ts";

async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("Usage: npx tsx proofs/live/probe-form.ts <acroform.pdf> [...]");
    process.exitCode = 2;
    return;
  }

  for (const path of paths) {
    const fullPath = resolve(path);
    const fields = listFields(await loadForm(fullPath));
    console.log(`${path}: ${fields.length} AcroForm fields`);
    console.log(JSON.stringify(fields, null, 2));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
