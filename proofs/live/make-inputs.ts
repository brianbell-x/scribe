import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LIVE_DIR = resolve("proofs/live");

const textInputs: Record<string, string> = {
  "client-intake-notes.txt": `new client / Maya Elise Rios
DOB 7/8/88. home: 214 Cedar Ave apt 5B, Nashville TN 37203.
cell 615-555-0187; maya.rios@example.net.
email + texts are OK, no voice calls please.
Mostly needs monthly books, though she said maybe a consult first — put Bookkeeping for now & review.
Comments (copy): Bluebird Bakery owner; mornings only.
`,
  "expense-reimbursement-notes.txt": `EXP REIMB — Samir Patel
rpt covers 6/1/26 thru 06-15-2026; submitted June 18 2026.
1) 6-3-26 Uber to airport — 48.70, travel.
2) Jun 4 client lunch — receipt smudge: looks like 86.20 (could be 88.20). use 86.20 provisional + flag it.
Line 2 category = meals. Total requested 134.90 using the provisional amt.
receipts attached yes. reimburse via direct deposit.
Manager / operator comment (copy exactly): Client visit expenses.
`,
  "irs-fw9-notes.txt": `AP vendor setup / Form W-9.
Line 1 tax name: Rowan Quinn
Line 2 business/disregarded entity: Acme Studio LLC
Federal tax classification: LLC, entered tax code S (not the separate S-corporation box).
Address: 410 Market St, Suite 9
City/state/ZIP: Denver, CO 80202
Requester's name/address field: Northstar Events AP
No exempt payee or FATCA codes. EIN and vendor account are on the attached vendor card.
`,
  "irs-fw4-notes.txt": `2026 W-4 intake for Lena M. Ortiz
home 98 Meadow Ln, Madison WI 53703.
Only one job. Filing status = Head of household.
1 qualifying child under 17 + 1 other dependent. Put 2200 in 3(a), 500 in 3(b), total 2700.
Expected other income (bank interest): 1200. No deductions adjustment.
Extra withholding each pay period: 75-ish? Payroll penciled in 75 provisional; employee needs to confirm, so use 75 and flag it.
Identity/SSN reminder is on the attached intake card.
`,
};

const imageCards: Record<string, { title: string; lines: string[]; tint: string }> = {
  "client-intake-card.html": {
    title: "new client — Maya Elise Rios",
    tint: "#fff6dc",
    lines: [
      "DOB: 07 / 08 / 1988",
      "214 Cedar Ave, Apt 5B",
      "Nashville, TN 37203",
      "cell 615-555-0187",
      "maya.rios@example.net",
      "contact: email + text ✓   phone calls ✗",
      "service: Bookkeeping? monthly books; maybe consult first",
      "Put Bookkeeping for now — please review",
      "Comments (copy): Bluebird Bakery owner; mornings only.",
    ],
  },
  "expense-reimbursement-card.html": {
    title: "Samir — reimbursement",
    tint: "#f8f1df",
    lines: [
      "period 6/1/26 → 6/15/26 • submit 6/18",
      "6/3 Uber / airport — $48.70 — travel",
      "6/4 client lunch — $86.20? — meals",
      "receipt could read 88.20; use 86.20 provisional",
      "total = 134.90 • receipts attached",
      "direct deposit",
      "note: Client visit expenses.",
    ],
  },
  "irs-fw9-vendor-card.html": {
    title: "ACME vendor card",
    tint: "#edf4e4",
    lines: [
      "Tax ID type: EIN",
      "84 – 7654321",
      "vendor acct: VN-204 ?",
      "old CRM once says VN-240",
      "AP says use VN-204 for now — verify",
      "no exemption codes",
    ],
  },
  "irs-fw4-intake-card.html": {
    title: "Lena M. Ortiz — W-4",
    tint: "#edf1fb",
    lines: [
      "SSN 123 – 45 – 6789",
      "filing: HEAD OF HOUSEHOLD",
      "only one job (do not check multiple-jobs box)",
      "1 child under 17 + mom as other dependent",
      "extra withholding $75 ? confirm",
    ],
  },
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderCard(title: string, lines: string[], tint: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    @import url("https://fonts.googleapis.com/css2?family=Caveat:wght@500;600&display=swap");
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; }
    body {
      display: grid;
      place-items: center;
      overflow: hidden;
      background:
        radial-gradient(circle at 20% 15%, rgba(30, 45, 65, .08), transparent 30%),
        #d9d6cf;
    }
    .note {
      position: relative;
      width: 880px;
      min-height: 590px;
      padding: 44px 56px 42px;
      transform: rotate(-1.25deg);
      color: #26313a;
      background:
        repeating-linear-gradient(
          to bottom,
          transparent 0,
          transparent 52px,
          rgba(72, 117, 153, .17) 53px,
          transparent 54px
        ),
        ${tint};
      border: 1px solid rgba(74, 66, 48, .15);
      box-shadow: 0 20px 40px rgba(30, 33, 36, .22);
      font-family: "Caveat", "Segoe Print", "Bradley Hand", cursive;
    }
    .note::before {
      content: "";
      position: absolute;
      left: 32px;
      top: 0;
      bottom: 0;
      width: 2px;
      background: rgba(192, 78, 76, .25);
    }
    h1 {
      margin: 0 0 20px;
      font-size: 48px;
      line-height: 1;
      font-weight: 600;
      color: #283d52;
    }
    .line {
      min-height: 43px;
      font-size: 28px;
      line-height: 1.28;
      font-weight: 500;
      letter-spacing: .2px;
    }
    .pin {
      position: absolute;
      right: 38px;
      top: 24px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: #bd4d47;
      box-shadow: 1px 3px 3px rgba(20, 20, 20, .24);
    }
  </style>
</head>
<body>
  <main class="note">
    <span class="pin"></span>
    <h1>${escapeHtml(title)}</h1>
    ${lines.map((line) => `<div class="line">${escapeHtml(line)}</div>`).join("\n    ")}
  </main>
</body>
</html>
`;
}

function findHeadlessBrowser(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter((candidate): candidate is string => Boolean(candidate));

  const browser = candidates.find((candidate) => existsSync(candidate));
  if (browser) return browser;

  throw new Error(
    "No headless Chrome or Edge executable was found. Set CHROME_PATH to an installed browser and rerun proof:live.",
  );
}

async function screenshotHtml(
  browser: string,
  profilePath: string,
  htmlPath: string,
  pngPath: string,
): Promise<void> {
  const result = spawnSync(
    browser,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-mode",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-gpu",
      "--hide-scrollbars",
      `--user-data-dir=${profilePath}`,
      "--run-all-compositor-stages-before-draw",
      "--virtual-time-budget=3500",
      "--window-size=1000,700",
      `--screenshot=${pngPath}`,
      pathToFileURL(htmlPath).href,
    ],
    { encoding: "utf8", timeout: 30_000, windowsHide: true },
  );

  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      `Headless browser could not render ${htmlPath}. Exit status: ${String(result.status)}. ${detail}`,
    );
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await stat(pngPath)).size > 0) return;
    } catch {
      // Chrome on Windows can hand work to a child process; wait for its screenshot file.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Headless browser exited without creating a screenshot: ${pngPath}`);
}

export async function createInputFixtures(): Promise<string[]> {
  await mkdir(LIVE_DIR, { recursive: true });
  const created: string[] = [];

  for (const [name, content] of Object.entries(textInputs)) {
    const path = resolve(LIVE_DIR, name);
    await writeFile(path, content, "utf8");
    created.push(path);
  }

  const browser = findHeadlessBrowser();
  const staleProfilePath = resolve(LIVE_DIR, ".headless-chrome-profile");
  await rm(staleProfilePath, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 500,
  });
  const profilePaths: string[] = [];
  try {
    for (const [index, [name, card]] of Object.entries(imageCards).entries()) {
      const htmlPath = resolve(LIVE_DIR, name);
      const pngPath = htmlPath.replace(/\.html$/, ".png");
      const profilePath = resolve(LIVE_DIR, `.headless-chrome-profile-${index}`);
      profilePaths.push(profilePath);
      await rm(profilePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      await writeFile(htmlPath, renderCard(card.title, card.lines, card.tint), "utf8");
      await rm(pngPath, { force: true });
      await screenshotHtml(browser, profilePath, htmlPath, pngPath);
      if ((await stat(pngPath)).size === 0) {
        throw new Error(`Headless browser created an empty screenshot: ${pngPath}`);
      }
      created.push(htmlPath, pngPath);
    }
  } finally {
    for (const profilePath of profilePaths) {
      await rm(profilePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
  }

  return created;
}
