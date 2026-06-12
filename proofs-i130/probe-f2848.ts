import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";

const bytes = await readFile("proofs-i130/f2848.pdf");
const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false });
const fields = doc.getForm().getFields();
console.log("field count:", fields.length);
const kinds: Record<string, number> = {};
for (const f of fields) kinds[f.constructor.name] = (kinds[f.constructor.name] || 0) + 1;
console.log("kinds:", JSON.stringify(kinds));
console.log("sample:", fields.slice(0, 6).map((f) => f.getName()).join(" | "));
