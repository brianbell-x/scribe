// Phase proof: read the fixture AcroForm and print every field's metadata.
// If this proof passes, the agent's list_fields tool is wired correctly.
import { listFields, loadForm, saveForm, setField } from "../pdf.ts";

const FIXTURE = "fixtures/sample-form.pdf";
const OUT = "out/proof-pdf-fields.pdf";

async function main(): Promise<void> {
  const form = await loadForm(FIXTURE);
  const before = listFields(form);
  console.log(`Found ${before.length} fields in ${FIXTURE}:`);
  for (const f of before) {
    const opts = f.options ? ` options=${JSON.stringify(f.options)}` : "";
    console.log(`  - ${f.name} (${f.kind})${opts}`);
  }

  // Smoke-test set_field on every kind so we know the mutation paths work end-to-end.
  console.log("\nSmoke-write each field:");
  console.log(" ", setField(form, "full_name", "Probe McProbeface"));
  console.log(" ", setField(form, "date_of_birth", "1990-04-12"));
  console.log(" ", setField(form, "city", "Memphis"));
  console.log(" ", setField(form, "state", "TN"));
  console.log(" ", setField(form, "email", "probe@example.com"));
  console.log(" ", setField(form, "us_citizen", true));
  console.log(" ", setField(form, "purpose", "Business"));
  console.log(" ", setField(form, "nonexistent", "x")); // expect error

  await saveForm(form, OUT);
  console.log(`\nWrote ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
