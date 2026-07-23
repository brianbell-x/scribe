// AcroForm reader/writer. The agent's tools (`list_fields`, `set_field`) call into these.
// All knowledge of pdf-lib lives in this file — every other file deals in plain JS values.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  type PDFField,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
} from "pdf-lib";

// Public shape exposed to the agent. Kept boring — names + types + helpful hints.
export type FieldKind = "text" | "checkbox" | "radio" | "dropdown" | "optionlist" | "unsupported";

export interface FieldInfo {
  name: string;
  kind: FieldKind;
  options?: string[]; // present for radio / dropdown / optionlist
  maxLength?: number; // present for constrained text fields
  currentValue?: string | boolean | string[];
}

// Loaded form handle. Held in memory across the agent loop so each tool call mutates the same
// in-memory PDF; we only write to disk once at the very end.
export interface FormHandle {
  pdf: PDFDocument;
  fields: Map<string, FieldInfo>;
}

export async function loadForm(pdfPath: string): Promise<FormHandle> {
  let bytes: Uint8Array = await readFile(pdfPath);
  let { pdf, rawFields } = await loadPdf(bytes);
  // An encrypted PDF (e.g. USCIS forms) loads but its field references stay unreadable, so it
  // masquerades as a field-less form. When qpdf is on PATH, decrypt transparently and retry;
  // otherwise fail with an explicit message instead of misreporting the file as XFA/flat.
  if (pdf.isEncrypted) {
    bytes = decryptWithQpdf(pdfPath);
    ({ pdf, rawFields } = await loadPdf(bytes));
  }
  if (rawFields.length === 0) {
    throw new Error(
      "no AcroForm fields - this is probably an XFA or flat form; scribe cannot fill it yet",
    );
  }
  const fields = new Map<string, FieldInfo>();
  // Walk every field, normalize to FieldInfo, store both for listing and for later mutation.
  for (const f of rawFields) {
    const name = f.getName();
    if (f instanceof PDFTextField) {
      const maxLength = f.getMaxLength();
      fields.set(name, {
        name,
        kind: "text",
        ...(maxLength === undefined ? {} : { maxLength }),
        currentValue: f.getText() ?? "",
      });
    } else if (f instanceof PDFCheckBox) {
      fields.set(name, { name, kind: "checkbox", currentValue: f.isChecked() });
    } else if (f instanceof PDFRadioGroup) {
      fields.set(name, {
        name,
        kind: "radio",
        options: f.getOptions(),
        currentValue: f.getSelected() ?? "",
      });
    } else if (f instanceof PDFDropdown) {
      fields.set(name, {
        name,
        kind: "dropdown",
        options: f.getOptions(),
        currentValue: f.getSelected()[0] ?? "",
      });
    } else if (f instanceof PDFOptionList) {
      fields.set(name, {
        name,
        kind: "optionlist",
        options: f.getOptions(),
        currentValue: f.getSelected(),
      });
    } else {
      // Signatures, buttons, etc. We surface them as `unsupported` rather than silently dropping
      // them so the agent can tell a human about the gap.
      fields.set(name, { name, kind: "unsupported" });
    }
  }
  return { pdf, fields };
}

// Load with pdf-lib, muting its noisy recovery warnings so CLI output stays readable.
async function loadPdf(bytes: Uint8Array): Promise<{ pdf: PDFDocument; rawFields: PDFField[] }> {
  const warn = console.warn;
  console.warn = (...args) => {
    const msg = String(args[0] ?? "");
    if (
      msg.startsWith("Trying to parse invalid object") ||
      msg.startsWith("Invalid object ref") ||
      msg.startsWith("Removing XFA form data")
    ) {
      return;
    }
    warn(...args);
  };
  return PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false })
    .then((pdf) => ({ pdf, rawFields: pdf.getForm().getFields() }))
    .finally(() => {
      console.warn = warn;
    });
}

// Decrypt an encrypted PDF via qpdf (stdout output, no temp file). USCIS-style forms use an
// empty user password, so `--decrypt` alone is enough. Throws a clear error if qpdf is missing.
function decryptWithQpdf(pdfPath: string): Uint8Array {
  const result = spawnSync("qpdf", ["--decrypt", pdfPath, "-"], {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || result.stdout.length === 0) {
    const detail = result.error
      ? String(result.error)
      : Buffer.from(result.stderr ?? "")
          .toString("utf8")
          .trim();
    throw new Error(
      `PDF is encrypted - install qpdf (e.g. \`winget install QPDF.QPDF\`) so scribe can decrypt it, or run \`qpdf --decrypt\` yourself first. (${detail})`,
    );
  }
  return new Uint8Array(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength);
}

// Pure read for the `list_fields` tool — small payload because the model only needs names+types.
export function listFields(h: FormHandle): FieldInfo[] {
  return [...h.fields.values()];
}

// Mutating write for the `set_field` tool. Returns a short result string the agent reads back
// (the model needs a confirmation OR an error to keep its loop honest).
export function setField(h: FormHandle, name: string, value: unknown): string {
  const info = h.fields.get(name);
  if (!info) return `error: no field named "${name}"`;
  const form = h.pdf.getForm();

  try {
    switch (info.kind) {
      case "text": {
        const text =
          typeof value === "string"
            ? value
            : typeof value === "number" && Number.isFinite(value)
              ? String(value)
              : null;
        if (text === null) {
          return `error: field "${name}" expects text; send a string such as "37203" or a finite number`;
        }
        if (info.maxLength !== undefined && text.length > info.maxLength) {
          return `error: value exceeds maxLength=${info.maxLength} for this field (got ${text.length} chars). Check the field constraints and retry with a valid value.`;
        }
        form.getTextField(name).setText(text);
        info.currentValue = text;
        return `ok: set ${name} = ${JSON.stringify(text)}`;
      }
      case "checkbox": {
        const bool = coerceBool(value);
        if (bool === null) return `error: field "${name}" expects true/false`;
        const cb = form.getCheckBox(name);
        if (bool) cb.check();
        else cb.uncheck();
        info.currentValue = bool;
        return `ok: set ${name} = ${bool}`;
      }
      case "radio": {
        if (typeof value !== "string") return `error: field "${name}" expects a string option`;
        if (info.options && !info.options.includes(value)) {
          return `error: ${name} options are ${JSON.stringify(info.options)}`;
        }
        form.getRadioGroup(name).select(value);
        info.currentValue = value;
        return `ok: set ${name} = ${JSON.stringify(value)}`;
      }
      case "dropdown": {
        if (typeof value !== "string") return `error: field "${name}" expects a string option`;
        if (info.options && !info.options.includes(value)) {
          return `error: ${name} options are ${JSON.stringify(info.options)}`;
        }
        form.getDropdown(name).select(value);
        info.currentValue = value;
        return `ok: set ${name} = ${JSON.stringify(value)}`;
      }
      case "optionlist": {
        const arr = Array.isArray(value)
          ? value.map(String)
          : typeof value === "string"
            ? [value]
            : null;
        if (!arr) return `error: field "${name}" expects an array of option strings`;
        if (info.options && arr.some((v) => !info.options?.includes(v))) {
          return `error: ${name} options are ${JSON.stringify(info.options)}`;
        }
        form.getOptionList(name).select(arr);
        info.currentValue = arr;
        return `ok: set ${name} = ${JSON.stringify(arr)}`;
      }
      default:
        return `error: field "${name}" has unsupported kind`;
    }
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// Persist the in-memory PDF to disk. Done once, after the agent finishes.
export async function saveForm(h: FormHandle, outPath: string): Promise<void> {
  // Flatten=false: we keep the form interactive so a human can still tweak it.
  const bytes = await h.pdf.save();
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, bytes);
}

// Models sometimes send `"true"` (string) instead of `true` (bool) for tool args. Accept both,
// reject everything else so the model gets a clear error and self-corrects.
function coerceBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}
