// AcroForm reader/writer. The agent's tools (`list_fields`, `set_field`) call into these.
// All knowledge of pdf-lib lives in this file — every other file deals in plain JS values.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
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
  currentValue?: string | boolean | string[];
}

// Loaded form handle. Held in memory across the agent loop so each tool call mutates the same
// in-memory PDF; we only write to disk once at the very end.
export interface FormHandle {
  pdf: PDFDocument;
  fields: Map<string, FieldInfo>;
}

export async function loadForm(pdfPath: string): Promise<FormHandle> {
  const bytes = await readFile(pdfPath);
  const pdf = await PDFDocument.load(bytes);
  const form = pdf.getForm();
  const fields = new Map<string, FieldInfo>();

  // Walk every field, normalize to FieldInfo, store both for listing and for later mutation.
  for (const f of form.getFields()) {
    const name = f.getName();
    if (f instanceof PDFTextField) {
      fields.set(name, { name, kind: "text", currentValue: f.getText() ?? "" });
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

  switch (info.kind) {
    case "text": {
      if (typeof value !== "string") return `error: field "${name}" expects a string`;
      form.getTextField(name).setText(value);
      info.currentValue = value;
      return `ok: set ${name} = ${JSON.stringify(value)}`;
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
