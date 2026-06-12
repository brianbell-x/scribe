import assert from "node:assert/strict";
import { listFields, loadForm, setField } from "../pdf.ts";

const form = await loadForm("proofs-i130/f2848.pdf");
const f2848 = listFields(form);
const designation = "topmostSubform[0].Page2[0].Table_PartII[0].BodyRow1[0].Designation1[0]";

assert.equal(f2848.length, 92);
assert.match(setField(form, designation, "CPA"), /error: value exceeds maxLength=1/);
assert.match(setField(form, designation, "C"), /^ok:/);
assert.equal(listFields(form).find((f) => f.name === designation)?.maxLength, 1);

await assert.rejects(
  () => loadForm("proofs-i130/i-130.pdf"),
  /no AcroForm fields - this is probably an XFA or flat form; scribe cannot fill it yet/,
);

console.log("ok: gov forms");
