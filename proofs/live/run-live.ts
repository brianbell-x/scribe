import "dotenv/config";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolCallRecord, UncertainFlag } from "../../src/agent.ts";
import { listFields, loadForm } from "../../src/pdf.ts";
import { collectUncertainFlags } from "../../src/scribe.ts";
import { type DownloadedForm, OFFICIAL_SOURCES, downloadOfficialForms } from "./download-forms.ts";
import { createCustomForms } from "./make-forms.ts";
import { createInputFixtures } from "./make-inputs.ts";

const LIVE_DIR = resolve("proofs/live");
const OUT_DIR = resolve("out/live");
const REPORT_PATH = resolve(OUT_DIR, "REPORT.md");

interface LiveCase {
  label: string;
  form: string;
  output: string;
  textFiles: string[];
  imageFiles: string[];
  expected: Record<string, unknown>;
  expectedUncertain: string[];
}

interface Transcript {
  model: string;
  summary: string;
  toolCalls: ToolCallRecord[];
}

interface FieldCheck {
  name: string;
  expected: unknown;
  actual: unknown;
  passed: boolean;
}

interface VerifiedRun {
  test: LiveCase;
  transcript: Transcript;
  checks: FieldCheck[];
  uncertainFlags: UncertainFlag[];
  missingUncertain: string[];
  unexpectedValues: Array<{ name: string; value: unknown }>;
  toolErrors: ToolCallRecord[];
  passed: boolean;
}

const W9_PREFIX = "topmostSubform[0].Page1[0]";
const W9_BOXES = `${W9_PREFIX}.Boxes3a-b_ReadOrder[0]`;
const W4_PREFIX = "topmostSubform[0].Page1[0]";

const LIVE_CASES: LiveCase[] = [
  {
    label: "Generated client intake — image only",
    form: "client-intake-form.pdf",
    output: "client-intake-filled.pdf",
    textFiles: [],
    imageFiles: ["client-intake-card.png"],
    expected: {
      applicant_full_legal_name: "Maya Elise Rios",
      applicant_birth_date_mmddyyyy: "07/08/1988",
      residential_street_address: "214 Cedar Ave, Apt 5B",
      residential_city_name: "Nashville",
      residential_state_code: "TN",
      residential_postal_code: "37203",
      primary_contact_phone_number: "615-555-0187",
      primary_contact_email_address: "maya.rios@example.net",
      contact_permission_email: true,
      contact_permission_sms: true,
      contact_permission_voice_call: false,
      service_program_interest: "Bookkeeping",
      intake_case_comments: "Bluebird Bakery owner; mornings only.",
    },
    expectedUncertain: ["service_program_interest"],
  },
  {
    label: "Generated expense reimbursement — text only",
    form: "expense-reimbursement-form.pdf",
    output: "expense-reimbursement-filled.pdf",
    textFiles: ["expense-reimbursement-notes.txt"],
    imageFiles: [],
    expected: {
      employee_full_legal_name: "Samir Patel",
      report_period_start_iso: "2026-06-01",
      report_period_end_iso: "2026-06-15",
      claim_submission_date_iso: "2026-06-18",
      preferred_reimbursement_method: "Direct Deposit",
      supporting_receipts_attached: true,
      line_1_transaction_date_iso: "2026-06-03",
      line_1_business_description: "Uber to airport",
      line_1_claimed_amount_usd: "48.70",
      line_1_expense_category: "Travel",
      line_2_transaction_date_iso: "2026-06-04",
      line_2_business_description: "Client lunch",
      line_2_claimed_amount_usd: "86.20",
      line_2_expense_category: "Meals",
      reimbursement_total_usd: "134.90",
      manager_review_comments: "Client visit expenses.",
    },
    expectedUncertain: ["line_2_claimed_amount_usd"],
  },
  {
    label: "Official IRS W-9 — text + image",
    form: "irs-fw9.pdf",
    output: "irs-fw9-filled.pdf",
    textFiles: ["irs-fw9-notes.txt"],
    imageFiles: ["irs-fw9-vendor-card.png"],
    expected: {
      [`${W9_PREFIX}.f1_01[0]`]: "Rowan Quinn",
      [`${W9_PREFIX}.f1_02[0]`]: "Acme Studio LLC",
      [`${W9_BOXES}.c1_1[0]`]: false,
      [`${W9_BOXES}.c1_1[1]`]: false,
      [`${W9_BOXES}.c1_1[2]`]: false,
      [`${W9_BOXES}.c1_1[3]`]: false,
      [`${W9_BOXES}.c1_1[4]`]: false,
      [`${W9_BOXES}.c1_1[5]`]: true,
      [`${W9_BOXES}.f1_03[0]`]: "S",
      [`${W9_BOXES}.c1_1[6]`]: false,
      [`${W9_BOXES}.c1_2[0]`]: false,
      [`${W9_PREFIX}.Address_ReadOrder[0].f1_07[0]`]: "410 Market St, Suite 9",
      [`${W9_PREFIX}.Address_ReadOrder[0].f1_08[0]`]: "Denver, CO 80202",
      [`${W9_PREFIX}.f1_09[0]`]: "Northstar Events AP",
      [`${W9_PREFIX}.f1_10[0]`]: "VN-204",
      [`${W9_PREFIX}.f1_14[0]`]: "84",
      [`${W9_PREFIX}.f1_15[0]`]: "7654321",
    },
    expectedUncertain: [`${W9_PREFIX}.f1_10[0]`],
  },
  {
    label: "Official IRS W-4 — text + image",
    form: "irs-fw4.pdf",
    output: "irs-fw4-filled.pdf",
    textFiles: ["irs-fw4-notes.txt"],
    imageFiles: ["irs-fw4-intake-card.png"],
    expected: {
      [`${W4_PREFIX}.Step1a[0].f1_01[0]`]: "Lena M.",
      [`${W4_PREFIX}.Step1a[0].f1_02[0]`]: "Ortiz",
      [`${W4_PREFIX}.Step1a[0].f1_03[0]`]: "98 Meadow Ln",
      [`${W4_PREFIX}.Step1a[0].f1_04[0]`]: "Madison, WI 53703",
      [`${W4_PREFIX}.f1_05[0]`]: "123-45-6789",
      [`${W4_PREFIX}.c1_1[0]`]: false,
      [`${W4_PREFIX}.c1_1[1]`]: false,
      [`${W4_PREFIX}.c1_1[2]`]: true,
      [`${W4_PREFIX}.c1_2[0]`]: false,
      [`${W4_PREFIX}.Step3_ReadOrder[0].f1_06[0]`]: "2200",
      [`${W4_PREFIX}.Step3_ReadOrder[0].f1_07[0]`]: "500",
      [`${W4_PREFIX}.f1_08[0]`]: "2700",
      [`${W4_PREFIX}.f1_09[0]`]: "1200",
      [`${W4_PREFIX}.f1_10[0]`]: "",
      [`${W4_PREFIX}.f1_11[0]`]: "75",
      [`${W4_PREFIX}.c1_3[0]`]: false,
    },
    expectedUncertain: [`${W4_PREFIX}.f1_11[0]`],
  },
];

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "" || value === false) return false;
  return !Array.isArray(value) || value.length > 0;
}

function redact(value: string): string {
  const key = process.env.OPENROUTER_API_KEY;
  const withoutKey = key ? value.replaceAll(key, "[REDACTED]") : value;
  return withoutKey.length > 5_000
    ? `${withoutKey.slice(0, 5_000)}\n[output truncated]`
    : withoutKey;
}

async function runCli(test: LiveCase): Promise<void> {
  const args = [
    fileURLToPath(import.meta.resolve("tsx/cli")),
    resolve("src/cli.ts"),
    "--form",
    resolve(LIVE_DIR, test.form),
    "--out",
    resolve(OUT_DIR, test.output),
  ];
  for (const textFile of test.textFiles) {
    args.push("--text", await readFile(resolve(LIVE_DIR, textFile), "utf8"));
  }
  for (const imageFile of test.imageFiles) {
    args.push("--image", resolve(LIVE_DIR, imageFile));
  }

  console.log(`Running ${test.label} through the Scribe CLI...`);
  const command = process.execPath;
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolveRun, rejectRun) => {
      const child = spawn(command, args, {
        cwd: resolve("."),
        env: process.env,
        shell: false,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill();
        rejectRun(new Error(`CLI timed out after 10 minutes while running ${test.label}.`));
      }, 10 * 60_000);
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        rejectRun(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        resolveRun({ code, stdout, stderr });
      });
    },
  );

  if (result.code !== 0) {
    const detail = redact([result.stdout, result.stderr].filter(Boolean).join("\n").trim());
    throw new Error(
      `The Scribe CLI failed during ${test.label} (exit ${String(result.code)}). ${detail}`,
    );
  }
}

async function readTranscript(test: LiveCase): Promise<Transcript> {
  const transcriptPath = resolve(OUT_DIR, test.output.replace(/\.pdf$/i, ".transcript.json"));
  const transcript = JSON.parse(await readFile(transcriptPath, "utf8")) as Transcript;
  if (
    typeof transcript.model !== "string" ||
    typeof transcript.summary !== "string" ||
    !Array.isArray(transcript.toolCalls)
  ) {
    throw new Error(`Transcript has an unexpected shape: ${transcriptPath}`);
  }
  return transcript;
}

async function verifyRun(test: LiveCase): Promise<VerifiedRun> {
  const transcript = await readTranscript(test);
  const outputForm = await loadForm(resolve(OUT_DIR, test.output));
  const values = Object.fromEntries(
    listFields(outputForm).map((field) => [field.name, field.currentValue]),
  );
  const valuesPath = resolve(OUT_DIR, test.output.replace(/\.pdf$/i, ".values.json"));
  await writeFile(valuesPath, JSON.stringify(values, null, 2), "utf8");
  const checks = Object.entries(test.expected).map(([name, expected]) => ({
    name,
    expected,
    actual: values[name],
    passed: sameValue(expected, values[name]),
  }));
  const uncertainFlags = collectUncertainFlags(transcript.toolCalls);
  const missingUncertain = test.expectedUncertain.filter(
    (name) => !uncertainFlags.some((flag) => flag.field === name),
  );
  const expectedNames = new Set(Object.keys(test.expected));
  const unexpectedValues = Object.entries(values)
    .filter(([name, value]) => !expectedNames.has(name) && hasValue(value))
    .map(([name, value]) => ({ name, value }));
  const toolErrors = transcript.toolCalls.filter((call) => call.result.startsWith("error:"));
  const passed =
    checks.every((check) => check.passed) &&
    missingUncertain.length === 0 &&
    unexpectedValues.length === 0 &&
    toolErrors.length === 0;

  return {
    test,
    transcript,
    checks,
    uncertainFlags,
    missingUncertain,
    unexpectedValues,
    toolErrors,
    passed,
  };
}

function mdValue(value: unknown): string {
  const rendered = JSON.stringify(value);
  return `\`${String(rendered).replaceAll("|", "\\|").replaceAll("`", "\\`")}\``;
}

function renderReport(
  downloads: DownloadedForm[],
  runs: VerifiedRun[],
  failure?: { stage: string; message: string },
): string {
  const lines: string[] = [
    "# Scribe live end-to-end proof",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Fixtures and sources",
    "",
    "- Generated AcroForms: `proofs/live/client-intake-form.pdf`, `proofs/live/expense-reimbursement-form.pdf`",
    "- Generated text notes: one `.txt` fixture per form",
    "- Generated image notes: one styled `.html` source and headless-Chrome `.png` screenshot per form",
    "- Output PDFs and transcripts: `out/live/`",
    "",
    "| Official form | Source URL | Probe result |",
    "| --- | --- | --- |",
    ...OFFICIAL_SOURCES.map((source) => {
      const downloaded = downloads.find((item) => item.url === source.url);
      return `| ${source.label} | ${source.url} | ${
        downloaded ? `${downloaded.fieldCount} AcroForm fields` : "not reached"
      } |`;
    }),
    "",
    "Selection note: the USCIS I-130 candidate downloaded successfully during suite construction but `src/pdf.ts` found no AcroForm fields, so it was excluded and the verified IRS W-4 was used instead.",
    "Rejected candidate URL: https://www.uscis.gov/sites/default/files/document/forms/i-130.pdf",
    "",
    "The cursive-font HTML screenshots are controlled approximations of photographed handwritten notes, not samples of real handwriting.",
    "",
    "## Implementation issue found and fixed",
    "",
    "A pre-fix live expense run exhausted the 12-turn agent ceiling after 47 tool calls because numeric-looking text values were repeatedly sent as JSON numbers and rejected by AcroForm text fields. The minimal fix in `src/pdf.ts` converts finite JSON numbers to strings for text fields; all other field-type validation is unchanged. No other `src/` file was modified for this suite.",
    "",
    "Exact checks remain deliberately strict: for example, a currency value of `48.7` fails an expected `48.70` even though the numeric amount is equivalent.",
    "",
    "## Run summary",
    "",
    "| Form / input mode | Model | Tool calls | Field checks | Uncertain checks | Result |",
    "| --- | --- | ---: | ---: | ---: | --- |",
    ...runs.map((run) => {
      const passingFields = run.checks.filter((check) => check.passed).length;
      const uncertainPassing = run.test.expectedUncertain.length - run.missingUncertain.length;
      return `| ${run.test.label} | \`${run.transcript.model}\` | ${run.transcript.toolCalls.length} | ${passingFields}/${run.checks.length} | ${uncertainPassing}/${run.test.expectedUncertain.length} | ${run.passed ? "PASS" : "FAIL"} |`;
    }),
  ];

  if (runs.length === 0) {
    lines.push("| No live runs completed | — | — | — | — | NOT RUN |");
  }

  for (const run of runs) {
    const inputMode =
      run.test.textFiles.length > 0 && run.test.imageFiles.length > 0
        ? "combined text + image"
        : run.test.textFiles.length > 0
          ? "text only"
          : "image only";
    lines.push(
      "",
      `## ${run.test.label}`,
      "",
      `- Form: \`proofs/live/${run.test.form}\``,
      `- Inputs: ${inputMode}; ${[...run.test.textFiles, ...run.test.imageFiles]
        .map((name) => `\`proofs/live/${name}\``)
        .join(", ")}`,
      `- Output: \`out/live/${run.test.output}\``,
      `- Reloaded value dump: \`out/live/${run.test.output.replace(/\.pdf$/i, ".values.json")}\``,
      `- Tool-call count: ${run.transcript.toolCalls.length}`,
      `- Model summary: ${run.transcript.summary || "(empty)"}`,
      "",
      "| Field | Expected | Actual | Result |",
      "| --- | --- | --- | --- |",
      ...run.checks.map(
        (check) =>
          `| \`${check.name}\` | ${mdValue(check.expected)} | ${mdValue(check.actual)} | ${
            check.passed ? "PASS" : "FAIL"
          } |`,
      ),
      "",
      "Uncertain flags:",
      "",
    );

    if (run.uncertainFlags.length === 0) {
      lines.push("- None.");
    } else {
      lines.push(
        ...run.uncertainFlags.map(
          (flag) =>
            `- \`${flag.field}\` [${flag.confidence}]: ${flag.reason.replaceAll("\n", " ")}`,
        ),
      );
    }
    if (run.missingUncertain.length > 0) {
      lines.push(
        "",
        `Expected review flags not emitted: ${run.missingUncertain
          .map((name) => `\`${name}\``)
          .join(", ")}.`,
      );
    }
    if (run.unexpectedValues.length > 0) {
      lines.push(
        "",
        "Unexpected non-empty fields:",
        "",
        ...run.unexpectedValues.map((item) => `- \`${item.name}\` = ${mdValue(item.value)}`),
      );
    }
    if (run.toolErrors.length > 0) {
      lines.push(
        "",
        "Tool-call errors:",
        "",
        ...run.toolErrors.map((call) => `- \`${call.name}\`: ${call.result.replaceAll("\n", " ")}`),
      );
    }
    lines.push("", `Result: **${run.passed ? "PASS" : "FAIL"}**`);
  }

  if (failure) {
    lines.push(
      "",
      "## Live portion stopped",
      "",
      `Stage: ${failure.stage}`,
      "",
      `Error: ${redact(failure.message)}`,
    );
  }

  const passingRuns = runs.filter((run) => run.passed).length;
  lines.push(
    "",
    "## Overall",
    "",
    failure
      ? `The live portion stopped after ${runs.length} completed run(s); see the error above.`
      : `${passingRuns}/${runs.length} form runs passed every exact field, uncertainty, unexpected-value, and tool-error check.`,
    "",
  );
  return lines.join("\n");
}

let stage = "startup";
let downloads: DownloadedForm[] = [];
const completedRuns: VerifiedRun[] = [];

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    console.log(
      "SKIP proof:live: OPENROUTER_API_KEY is not set. No network calls or live outputs were created.",
    );
    return;
  }

  stage = "preparing output directory";
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  stage = "downloading and probing official forms";
  downloads = await downloadOfficialForms();

  stage = "generating custom forms";
  const customForms = await createCustomForms();
  for (const path of customForms) {
    const fieldCount = listFields(await loadForm(path)).length;
    console.log(`Verified ${basename(path)}: ${fieldCount} AcroForm fields.`);
  }

  stage = "rendering text and image inputs";
  const inputs = await createInputFixtures();
  console.log(`Generated ${inputs.length} text/HTML/PNG input files.`);

  for (const test of LIVE_CASES) {
    stage = `live model run: ${test.label}`;
    await runCli(test);
    const verified = await verifyRun(test);
    completedRuns.push(verified);
    const passing = verified.checks.filter((check) => check.passed).length;
    console.log(
      `Verified ${test.output}: ${passing}/${verified.checks.length} exact fields; ${verified.transcript.toolCalls.length} tool calls; ${verified.passed ? "PASS" : "FAIL"}.`,
    );
  }

  stage = "writing report";
  await writeFile(REPORT_PATH, renderReport(downloads, completedRuns), "utf8");
  const passingRuns = completedRuns.filter((run) => run.passed).length;
  console.log(`Live report: ${relative(resolve("."), REPORT_PATH)}`);
  console.log(`Live proof result: ${passingRuns}/${completedRuns.length} form runs passed.`);
  if (passingRuns !== completedRuns.length) process.exitCode = 1;
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(REPORT_PATH, renderReport(downloads, completedRuns, { stage, message }), "utf8");
  console.error(`Live proof stopped during ${stage}: ${redact(message)}`);
  console.error(`Partial report: ${relative(resolve("."), REPORT_PATH)}`);
  process.exitCode = 1;
});
