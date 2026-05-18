// Build a tiny AcroForm PDF + sample inputs used by every proof and the README example.
// We intentionally do not depend on the deleted Form.pdf (which turned out to be flat).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";

// Field layout: name -> {kind, label, options?}
// Keep this small but mixed so each tool branch is exercised end-to-end.
const FIELDS = [
  { name: "full_name", kind: "text", label: "Full Name" },
  { name: "date_of_birth", kind: "text", label: "Date of Birth (YYYY-MM-DD)" },
  { name: "city", kind: "text", label: "City" },
  { name: "state", kind: "text", label: "State (2-letter)" },
  { name: "email", kind: "text", label: "Email" },
  { name: "us_citizen", kind: "checkbox", label: "US Citizen" },
  {
    name: "purpose",
    kind: "dropdown",
    label: "Purpose",
    options: ["Personal", "Business", "Investment"],
  },
] as const;

async function buildSampleForm(outPath: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]); // US Letter
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const form = pdf.getForm();

  // Title bar.
  page.drawText("Sample Scribe Form", { x: 50, y: 740, size: 22, font: bold });
  page.drawText("Filled by the scribe agent via tool calls.", { x: 50, y: 718, size: 11, font });

  // Each field gets a left-aligned label and a same-line widget. Widgets are placed in a single
  // column so the layout is trivially predictable.
  let y = 680;
  for (const f of FIELDS) {
    page.drawText(`${f.label}:`, { x: 50, y: y + 6, size: 11, font });
    if (f.kind === "text") {
      const w = form.createTextField(f.name);
      w.addToPage(page, { x: 220, y, width: 320, height: 22, borderWidth: 1 });
    } else if (f.kind === "checkbox") {
      const w = form.createCheckBox(f.name);
      w.addToPage(page, { x: 220, y: y + 2, width: 18, height: 18, borderWidth: 1 });
    } else {
      const w = form.createDropdown(f.name);
      w.addOptions([...f.options]);
      w.addToPage(page, { x: 220, y, width: 320, height: 22, borderWidth: 1 });
    }
    y -= 36;
  }

  const bytes = await pdf.save();
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, bytes);
}

// Two source documents — one text blob, one tiny "ID card" image so vision is exercised too.
async function buildSampleText(outPath: string): Promise<void> {
  const body = [
    "Applicant intake notes:",
    "Name on record: Jane A. Doe",
    "DOB: 1990-04-12, citizen of the United States.",
    "Lives in Memphis, TN. Reach her at jane.doe@example.com.",
    "Purpose of the application is Business.",
  ].join("\n");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, body, "utf8");
}

// Render an applicant info "card" as a real PNG. Vision models can read the text and the
// image-only proof uses it as the sole source. Different person than the text fixture so a
// dual-input run shows the model handling two distinct sources.
async function buildSampleCardImage(outPath: string): Promise<void> {
  const w = 480;
  const h = 280;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");

  // White background with a soft border so it reads as a "card".
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#999";
  ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, w - 16, h - 16);

  // Title.
  ctx.fillStyle = "#111";
  ctx.font = "bold 22px sans-serif";
  ctx.fillText("Applicant Card", 28, 50);

  // Body lines.
  ctx.font = "18px sans-serif";
  const lines = [
    "Name:    Alex P. Kim",
    "DOB:     1985-07-03",
    "City:    Nashville, TN",
    "Email:   alex.kim@example.com",
    "Citizen: Yes",
    "Purpose: Investment",
  ];
  let y = 90;
  for (const line of lines) {
    ctx.fillText(line, 28, y);
    y += 28;
  }

  const bytes = canvas.toBuffer("image/png");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, bytes);
}

async function main(): Promise<void> {
  const root = resolve(process.cwd(), "fixtures");
  await buildSampleForm(`${root}/sample-form.pdf`);
  await buildSampleText(`${root}/sample-notes.txt`);
  await buildSampleCardImage(`${root}/sample-card.png`);
  console.log(`Wrote ${root}/sample-form.pdf`);
  console.log(`Wrote ${root}/sample-notes.txt`);
  console.log(`Wrote ${root}/sample-card.png`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
