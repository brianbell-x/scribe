// data.js — replayable runs for the operator review surface.
// Two runs are stored: the canonical "ok" run from the brief, and an
// "exceptions" run that exercises every real error class the engine emits
// (type error, enum error, no-such-field, unsupported widget, blank field).

const OK_RUN = {
  runId: "run_2026-05-17T14:23:09Z",
  startedAt: "2026-05-17T14:23:09Z",
  elapsedMs: 6840,
  model: "anthropic/claude-sonnet-4.5",
  formPath: "fixtures/sample-form.pdf",
  outPath: "out/e2e-filled.pdf",
  transcriptPath: "out/e2e-filled.transcript.json",
  formTitle: "Application Intake — Form A-7",
  formSubtitle: "Customer onboarding · revision 2025-08",
  sources: [
    {
      id: "src-notes",
      kind: "text",
      label: "applicant-intake.txt",
      bytes: 218,
      body:
        "Applicant intake notes:\n" +
        "Name on record: Jane A. Doe\n" +
        "DOB: 1990-04-12, citizen of the United States.\n" +
        "Lives in Memphis, TN. Reach her at jane.doe@example.com.\n" +
        "Purpose of the application is Business.",
    },
  ],
  fields: [
    { name: "full_name", kind: "text", currentValue: "" },
    { name: "date_of_birth", kind: "text", currentValue: "" },
    { name: "city", kind: "text", currentValue: "" },
    { name: "state", kind: "text", currentValue: "" },
    { name: "email", kind: "text", currentValue: "" },
    { name: "us_citizen", kind: "checkbox", currentValue: false },
    {
      name: "purpose",
      kind: "dropdown",
      options: ["Personal", "Business", "Investment"],
      currentValue: "",
    },
  ],
  // Friendly labels + the visual treatment for each field in the form layout.
  // These are derived from the form, not the agent — purely UI metadata.
  fieldMeta: {
    full_name:     { label: "Full name",            section: "Applicant", width: "wide" },
    date_of_birth: { label: "Date of birth",        section: "Applicant", width: "half", hint: "YYYY-MM-DD" },
    city:          { label: "City",                 section: "Address",   width: "two-thirds" },
    state:         { label: "State",                section: "Address",   width: "third" },
    email:         { label: "Email",                section: "Contact",   width: "wide" },
    us_citizen:    { label: "U.S. citizen",         section: "Eligibility", width: "checkbox" },
    purpose:       { label: "Purpose",              section: "Eligibility", width: "wide" },
  },
  // Per-field evidence — the slice of source text that justifies the value.
  // sourceId points at sources[].id; quote is the literal substring to highlight.
  evidence: {
    full_name:     { sourceId: "src-notes", quote: "Name on record: Jane A. Doe" },
    date_of_birth: { sourceId: "src-notes", quote: "DOB: 1990-04-12" },
    city:          { sourceId: "src-notes", quote: "Lives in Memphis, TN" },
    state:         { sourceId: "src-notes", quote: "Lives in Memphis, TN" },
    email:         { sourceId: "src-notes", quote: "jane.doe@example.com" },
    us_citizen:    { sourceId: "src-notes", quote: "citizen of the United States" },
    purpose:       { sourceId: "src-notes", quote: "Purpose of the application is Business" },
  },
  summary:
    "Successfully filled all 7 fields on the form with information from the applicant intake notes. Filled: full name (Jane A. Doe), date of birth (1990-04-12), city (Memphis), state (TN), email (jane.doe@example.com), US citizen checkbox (checked), and purpose dropdown (Business). No fields were left blank as all required information was available in the source notes.",
  toolCalls: [
    {
      id: "toolu_bdrk_015G2BqHKK3DNik9kfz9HBNy",
      name: "list_fields",
      arguments: {},
      result:
        '[{"name":"full_name","kind":"text","currentValue":""},{"name":"date_of_birth","kind":"text","currentValue":""},{"name":"city","kind":"text","currentValue":""},{"name":"state","kind":"text","currentValue":""},{"name":"email","kind":"text","currentValue":""},{"name":"us_citizen","kind":"checkbox","currentValue":false},{"name":"purpose","kind":"dropdown","options":["Personal","Business","Investment"],"currentValue":""}]',
      tMs: 240,
    },
    { id: "toolu_bdrk_01Vvb9k75Dh11fFPDv94s4cw", name: "set_field", arguments: { name: "full_name", value: "Jane A. Doe" }, result: 'ok: set full_name = "Jane A. Doe"', tMs: 780 },
    { id: "toolu_bdrk_01AbPSV4B4eVDBmc69L3sYHs", name: "set_field", arguments: { name: "date_of_birth", value: "1990-04-12" }, result: 'ok: set date_of_birth = "1990-04-12"', tMs: 1410 },
    { id: "toolu_bdrk_01G9BHCM65LngTFhgFF7ZDpw", name: "set_field", arguments: { name: "city", value: "Memphis" }, result: 'ok: set city = "Memphis"', tMs: 2080 },
    { id: "toolu_bdrk_01Dc77gjvLU9182jwaAncvJi", name: "set_field", arguments: { name: "state", value: "TN" }, result: 'ok: set state = "TN"', tMs: 2710 },
    { id: "toolu_bdrk_01S8KYTfUs867SiEp5WH9bKH", name: "set_field", arguments: { name: "email", value: "jane.doe@example.com" }, result: 'ok: set email = "jane.doe@example.com"', tMs: 3550 },
    { id: "toolu_bdrk_01NzmV3kSxpSCqkTgQKwCPzj", name: "set_field", arguments: { name: "us_citizen", value: true }, result: "ok: set us_citizen = true", tMs: 4470 },
    { id: "toolu_bdrk_013gATxartHsGHerX2HCHoih", name: "set_field", arguments: { name: "purpose", value: "Business" }, result: 'ok: set purpose = "Business"', tMs: 5390 },
    { id: "toolu_bdrk_01BZhmfTUkcK6nmzxR71t7Nf", name: "finish", arguments: { summary: "Successfully filled all 7 fields on the form with information from the applicant intake notes. Filled: full name (Jane A. Doe), date of birth (1990-04-12), city (Memphis), state (TN), email (jane.doe@example.com), US citizen checkbox (checked), and purpose dropdown (Business). No fields were left blank as all required information was available in the source notes." }, result: "ok: run finished", tMs: 6840 },
  ],
};

// Exceptions run — same source notes, but the agent stumbles into every real
// error class the engine emits and recovers. Includes an unsupported signature
// widget and a deliberately-blank phone field.
const EXC_RUN = {
  runId: "run_2026-05-17T14:31:55Z",
  startedAt: "2026-05-17T14:31:55Z",
  elapsedMs: 9620,
  model: "anthropic/claude-sonnet-4.5",
  formPath: "fixtures/sample-form.pdf",
  outPath: "out/e2e-filled.pdf",
  transcriptPath: "out/e2e-filled.transcript.json",
  formTitle: "Application Intake — Form A-7",
  formSubtitle: "Customer onboarding · revision 2025-08",
  sources: [
    {
      id: "src-notes",
      kind: "text",
      label: "applicant-intake.txt",
      bytes: 218,
      body:
        "Applicant intake notes:\n" +
        "Name on record: Jane A. Doe\n" +
        "DOB: 1990-04-12, citizen of the United States.\n" +
        "Lives in Memphis, TN. Reach her at jane.doe@example.com.\n" +
        "Purpose of the application is Business.",
    },
    {
      id: "src-id",
      kind: "image",
      label: "id-card-front.jpg",
      bytes: 184320,
      // Rendered as a CSS card thumbnail by the UI — no external asset.
      thumb: {
        title: "TENNESSEE",
        subtitle: "DRIVER LICENSE",
        name: "DOE, JANE A",
        dob: "04-12-1990",
        addr: "1142 POPLAR AVE, MEMPHIS TN",
      },
    },
  ],
  fields: [
    { name: "full_name", kind: "text", currentValue: "" },
    { name: "date_of_birth", kind: "text", currentValue: "" },
    { name: "city", kind: "text", currentValue: "" },
    { name: "state", kind: "text", currentValue: "" },
    { name: "email", kind: "text", currentValue: "" },
    { name: "phone", kind: "text", currentValue: "" },
    { name: "us_citizen", kind: "checkbox", currentValue: false },
    {
      name: "purpose",
      kind: "dropdown",
      options: ["Personal", "Business", "Investment"],
      currentValue: "",
    },
    { name: "signature", kind: "unsupported", currentValue: "" },
  ],
  fieldMeta: {
    full_name:     { label: "Full name",            section: "Applicant",   width: "wide" },
    date_of_birth: { label: "Date of birth",        section: "Applicant",   width: "half", hint: "YYYY-MM-DD" },
    city:          { label: "City",                 section: "Address",     width: "two-thirds" },
    state:         { label: "State",                section: "Address",     width: "third" },
    email:         { label: "Email",                section: "Contact",     width: "wide" },
    phone:         { label: "Phone",                section: "Contact",     width: "wide", hint: "optional" },
    us_citizen:    { label: "U.S. citizen",         section: "Eligibility", width: "checkbox" },
    purpose:       { label: "Purpose",              section: "Eligibility", width: "wide" },
    signature:     { label: "Applicant signature",  section: "Sign",        width: "signature" },
  },
  evidence: {
    full_name:     { sourceId: "src-notes", quote: "Name on record: Jane A. Doe" },
    date_of_birth: { sourceId: "src-notes", quote: "DOB: 1990-04-12" },
    city:          { sourceId: "src-notes", quote: "Lives in Memphis, TN" },
    state:         { sourceId: "src-notes", quote: "Lives in Memphis, TN" },
    email:         { sourceId: "src-notes", quote: "jane.doe@example.com" },
    us_citizen:    { sourceId: "src-notes", quote: "citizen of the United States" },
    purpose:       { sourceId: "src-notes", quote: "Purpose of the application is Business" },
    // phone + signature have no evidence — they were not filled
  },
  summary:
    "Filled 7 of 9 fields. Left blank intentionally: phone — no phone number appears in the intake notes or the ID image, and the field is marked optional. Did not fill: signature — the widget is a signature field that pdf-lib cannot write to; it must be signed by hand in a PDF viewer. Recovered from three input errors during the run: a misspelled field name (FAKE), a boolean field passed a string (\"yes\"), and a dropdown value not in the option list (\"Work\"). All three were corrected on retry.",
  toolCalls: [
    {
      id: "toolu_x01",
      name: "list_fields",
      arguments: {},
      result:
        '[{"name":"full_name","kind":"text","currentValue":""},{"name":"date_of_birth","kind":"text","currentValue":""},{"name":"city","kind":"text","currentValue":""},{"name":"state","kind":"text","currentValue":""},{"name":"email","kind":"text","currentValue":""},{"name":"phone","kind":"text","currentValue":""},{"name":"us_citizen","kind":"checkbox","currentValue":false},{"name":"purpose","kind":"dropdown","options":["Personal","Business","Investment"],"currentValue":""},{"name":"signature","kind":"unsupported","currentValue":""}]',
      tMs: 260,
    },
    { id: "toolu_x02", name: "set_field", arguments: { name: "full_name", value: "Jane A. Doe" }, result: 'ok: set full_name = "Jane A. Doe"', tMs: 820 },
    // typo — agent tried to write a field that doesn't exist
    { id: "toolu_x03", name: "set_field", arguments: { name: "FAKE", value: "1990-04-12" }, result: 'error: no field named "FAKE"', tMs: 1380, errorClass: "no_such_field" },
    // recovers with the correct name
    { id: "toolu_x04", name: "set_field", arguments: { name: "date_of_birth", value: "1990-04-12" }, result: 'ok: set date_of_birth = "1990-04-12"', tMs: 1960 },
    { id: "toolu_x05", name: "set_field", arguments: { name: "city", value: "Memphis" }, result: 'ok: set city = "Memphis"', tMs: 2540 },
    { id: "toolu_x06", name: "set_field", arguments: { name: "state", value: "TN" }, result: 'ok: set state = "TN"', tMs: 3170 },
    { id: "toolu_x07", name: "set_field", arguments: { name: "email", value: "jane.doe@example.com" }, result: 'ok: set email = "jane.doe@example.com"', tMs: 4010 },
    // type error — passed string to a checkbox
    { id: "toolu_x08", name: "set_field", arguments: { name: "us_citizen", value: "yes" }, result: 'error: field "us_citizen" expects true/false', tMs: 4720, errorClass: "type" },
    { id: "toolu_x09", name: "set_field", arguments: { name: "us_citizen", value: true }, result: "ok: set us_citizen = true", tMs: 5330 },
    // enum error — value not in dropdown options
    { id: "toolu_x10", name: "set_field", arguments: { name: "purpose", value: "Work" }, result: 'error: purpose options are ["Personal","Business","Investment"]', tMs: 6090, errorClass: "enum" },
    { id: "toolu_x11", name: "set_field", arguments: { name: "purpose", value: "Business" }, result: 'ok: set purpose = "Business"', tMs: 6850, recoversFromId: "toolu_x10" },
    {
      id: "toolu_x12",
      name: "finish",
      arguments: {
        summary:
          'Filled 7 of 9 fields. Left blank intentionally: phone — no phone number appears in the intake notes or the ID image, and the field is marked optional. Did not fill: signature — the widget is a signature field that pdf-lib cannot write to; it must be signed by hand in a PDF viewer. Recovered from three input errors during the run: a misspelled field name (FAKE), a boolean field passed a string ("yes"), and a dropdown value not in the option list ("Work"). All three were corrected on retry.',
      },
      result: "ok: run finished",
      tMs: 9620,
    },
  ],
};

window.RUNS = { ok: OK_RUN, exceptions: EXC_RUN };
