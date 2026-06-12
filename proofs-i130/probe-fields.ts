import { loadForm, listFields } from "../src/pdf";

const h = await loadForm("proofs-i130/i-130.pdf");
const fields = listFields(h);
console.log("field count:", fields.length);
const kinds: Record<string, number> = {};
for (const f of fields) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
console.log("kinds:", JSON.stringify(kinds));
console.log("sample:", fields.slice(0, 8).map((f) => f.name).join(" | "));
