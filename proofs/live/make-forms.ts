import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PDFDocument, type PDFFont, type PDFForm, type PDFPage, StandardFonts, rgb } from "pdf-lib";

const LIVE_DIR = resolve("proofs/live");
const ink = rgb(0.12, 0.16, 0.22);
const muted = rgb(0.35, 0.4, 0.47);
const line = rgb(0.65, 0.69, 0.74);
const paper = rgb(0.985, 0.98, 0.96);
const accent = rgb(0.1, 0.35, 0.55);

interface FormContext {
  form: PDFForm;
  page: PDFPage;
  regular: PDFFont;
  bold: PDFFont;
}

function drawHeader(ctx: FormContext, title: string, subtitle: string): void {
  const { page, bold, regular } = ctx;
  page.drawRectangle({ x: 0, y: 718, width: 612, height: 74, color: accent });
  page.drawText(title, { x: 42, y: 755, size: 22, font: bold, color: rgb(1, 1, 1) });
  page.drawText(subtitle, {
    x: 42,
    y: 735,
    size: 9,
    font: regular,
    color: rgb(0.88, 0.94, 0.98),
  });
}

function drawSection(ctx: FormContext, text: string, y: number): void {
  ctx.page.drawText(text.toUpperCase(), {
    x: 42,
    y,
    size: 9,
    font: ctx.bold,
    color: accent,
  });
  ctx.page.drawLine({
    start: { x: 42, y: y - 6 },
    end: { x: 570, y: y - 6 },
    thickness: 0.7,
    color: line,
  });
}

function addTextField(
  ctx: FormContext,
  name: string,
  label: string,
  x: number,
  y: number,
  width: number,
  options: { height?: number; multiline?: boolean; maxLength?: number } = {},
): void {
  const height = options.height ?? 24;
  ctx.page.drawText(label, { x, y: y + height + 5, size: 8.5, font: ctx.bold, color: muted });
  const field = ctx.form.createTextField(name);
  if (options.multiline) field.enableMultiline();
  if (options.maxLength !== undefined) field.setMaxLength(options.maxLength);
  field.addToPage(ctx.page, {
    x,
    y,
    width,
    height,
    borderColor: line,
    backgroundColor: rgb(1, 1, 1),
    borderWidth: 0.8,
    textColor: ink,
  });
  field.setFontSize(10);
}

function addCheckbox(ctx: FormContext, name: string, label: string, x: number, y: number): void {
  const field = ctx.form.createCheckBox(name);
  field.addToPage(ctx.page, {
    x,
    y,
    width: 14,
    height: 14,
    borderColor: line,
    backgroundColor: rgb(1, 1, 1),
    borderWidth: 0.8,
  });
  ctx.page.drawText(label, { x: x + 21, y: y + 2, size: 9, font: ctx.regular, color: ink });
}

function addDropdown(
  ctx: FormContext,
  name: string,
  label: string,
  options: string[],
  x: number,
  y: number,
  width: number,
): void {
  ctx.page.drawText(label, { x, y: y + 29, size: 8.5, font: ctx.bold, color: muted });
  const field = ctx.form.createDropdown(name);
  field.addOptions(options);
  field.addToPage(ctx.page, {
    x,
    y,
    width,
    height: 24,
    borderColor: line,
    backgroundColor: rgb(1, 1, 1),
    borderWidth: 0.8,
    textColor: ink,
  });
  field.setFontSize(10);
}

async function createDocument(): Promise<{ pdf: PDFDocument; ctx: FormContext }> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  page.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: paper });
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  return { pdf, ctx: { form: pdf.getForm(), page, regular, bold } };
}

async function writePdf(pdf: PDFDocument, path: string, font: PDFFont): Promise<void> {
  pdf.getForm().updateFieldAppearances(font);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, await pdf.save());
}

async function createClientIntakeForm(): Promise<string> {
  const { pdf, ctx } = await createDocument();
  drawHeader(
    ctx,
    "Client Intake",
    "New client profile • Complete from operator notes or an intake card",
  );

  drawSection(ctx, "Identity", 694);
  addTextField(ctx, "applicant_full_legal_name", "Full legal name", 42, 640, 326);
  addTextField(ctx, "applicant_birth_date_mmddyyyy", "Date of birth (MM/DD/YYYY)", 388, 640, 182, {
    maxLength: 10,
  });

  drawSection(ctx, "Residence and contact", 610);
  addTextField(ctx, "residential_street_address", "Street address", 42, 556, 528);
  addTextField(ctx, "residential_city_name", "City", 42, 500, 250);
  addTextField(ctx, "residential_state_code", "State", 312, 500, 80, { maxLength: 2 });
  addTextField(ctx, "residential_postal_code", "ZIP code", 412, 500, 158, {
    maxLength: 10,
  });
  addTextField(ctx, "primary_contact_phone_number", "Primary phone", 42, 444, 250);
  addTextField(ctx, "primary_contact_email_address", "Email", 312, 444, 258);

  drawSection(ctx, "Contact preferences", 414);
  addCheckbox(ctx, "contact_permission_email", "Email", 42, 375);
  addCheckbox(ctx, "contact_permission_sms", "Text / SMS", 150, 375);
  addCheckbox(ctx, "contact_permission_voice_call", "Phone call", 285, 375);

  drawSection(ctx, "Service request", 342);
  addDropdown(
    ctx,
    "service_program_interest",
    "Primary service requested",
    ["Consultation", "Tax Preparation", "Bookkeeping", "Other"],
    42,
    288,
    260,
  );
  addTextField(ctx, "intake_case_comments", "Operator comments", 42, 130, 528, {
    height: 118,
    multiline: true,
    maxLength: 400,
  });

  ctx.page.drawText("Internal live-proof fixture • No real personal data", {
    x: 42,
    y: 55,
    size: 8,
    font: ctx.regular,
    color: muted,
  });

  const path = resolve(LIVE_DIR, "client-intake-form.pdf");
  await writePdf(pdf, path, ctx.regular);
  return path;
}

async function createExpenseForm(): Promise<string> {
  const { pdf, ctx } = await createDocument();
  drawHeader(
    ctx,
    "Expense Reimbursement",
    "Employee claim • Enter dates as YYYY-MM-DD and amounts without currency symbols",
  );

  drawSection(ctx, "Report", 694);
  addTextField(ctx, "employee_full_legal_name", "Employee name", 42, 640, 250);
  addTextField(ctx, "report_period_start_iso", "Period start (YYYY-MM-DD)", 312, 640, 120, {
    maxLength: 10,
  });
  addTextField(ctx, "report_period_end_iso", "Period end (YYYY-MM-DD)", 450, 640, 120, {
    maxLength: 10,
  });
  addTextField(ctx, "claim_submission_date_iso", "Submitted (YYYY-MM-DD)", 42, 584, 170, {
    maxLength: 10,
  });
  addDropdown(
    ctx,
    "preferred_reimbursement_method",
    "Payment method",
    ["Direct Deposit", "Payroll", "Paper Check"],
    232,
    584,
    200,
  );
  addCheckbox(ctx, "supporting_receipts_attached", "Receipts attached", 456, 589);

  drawSection(ctx, "Expense line 1", 550);
  addTextField(ctx, "line_1_transaction_date_iso", "Date (YYYY-MM-DD)", 42, 496, 120, {
    maxLength: 10,
  });
  addTextField(ctx, "line_1_business_description", "Description", 182, 496, 244);
  addTextField(ctx, "line_1_claimed_amount_usd", "Amount (USD)", 446, 496, 124);
  ctx.page.drawText("Category", {
    x: 42,
    y: 468,
    size: 8.5,
    font: ctx.bold,
    color: muted,
  });
  const category = ctx.form.createRadioGroup("line_1_expense_category");
  for (const [index, option] of ["Travel", "Meals", "Supplies", "Other"].entries()) {
    const x = 42 + index * 126;
    category.addOptionToPage(option, ctx.page, {
      x,
      y: 439,
      width: 14,
      height: 14,
      borderColor: line,
      backgroundColor: rgb(1, 1, 1),
      borderWidth: 0.8,
    });
    ctx.page.drawText(option, {
      x: x + 21,
      y: 441,
      size: 9,
      font: ctx.regular,
      color: ink,
    });
  }

  drawSection(ctx, "Expense line 2", 410);
  addTextField(ctx, "line_2_transaction_date_iso", "Date (YYYY-MM-DD)", 42, 356, 120, {
    maxLength: 10,
  });
  addTextField(ctx, "line_2_business_description", "Description", 182, 356, 244);
  addTextField(ctx, "line_2_claimed_amount_usd", "Amount (USD)", 446, 356, 124);
  addDropdown(
    ctx,
    "line_2_expense_category",
    "Category",
    ["Travel", "Meals", "Supplies", "Other"],
    42,
    300,
    180,
  );
  addTextField(ctx, "reimbursement_total_usd", "Total requested (USD)", 390, 300, 180);

  drawSection(ctx, "Review note", 266);
  addTextField(ctx, "manager_review_comments", "Manager / operator comment", 42, 134, 528, {
    height: 92,
    multiline: true,
    maxLength: 240,
  });

  ctx.page.drawText("Internal live-proof fixture • No real financial data", {
    x: 42,
    y: 55,
    size: 8,
    font: ctx.regular,
    color: muted,
  });

  const path = resolve(LIVE_DIR, "expense-reimbursement-form.pdf");
  await writePdf(pdf, path, ctx.regular);
  return path;
}

export async function createCustomForms(): Promise<string[]> {
  return Promise.all([createClientIntakeForm(), createExpenseForm()]);
}
