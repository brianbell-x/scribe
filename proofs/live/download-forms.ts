import { spawnSync } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { listFields, loadForm } from "../../src/pdf.ts";

const LIVE_DIR = resolve("proofs/live");

export const OFFICIAL_SOURCES = [
  {
    label: "IRS Form W-9 (Rev. March 2024)",
    url: "https://www.irs.gov/pub/irs-pdf/fw9.pdf",
    fileName: "irs-fw9.pdf",
  },
  {
    label: "IRS Form W-4 (2026)",
    url: "https://www.irs.gov/pub/irs-pdf/fw4.pdf",
    fileName: "irs-fw4.pdf",
  },
] as const;

export interface DownloadedForm {
  label: string;
  url: string;
  path: string;
  fieldCount: number;
}

export async function downloadOfficialForms(): Promise<DownloadedForm[]> {
  await mkdir(LIVE_DIR, { recursive: true });
  const downloaded: DownloadedForm[] = [];

  for (const source of OFFICIAL_SOURCES) {
    const destination = resolve(LIVE_DIR, source.fileName);
    const partial = `${destination}.partial`;
    await rm(partial, { force: true });
    console.log(`Downloading ${source.label} with curl...`);

    const result = spawnSync(
      "curl",
      [
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--retry",
        "3",
        "--retry-delay",
        "1",
        "--user-agent",
        "Scribe live proof",
        source.url,
        "--output",
        partial,
      ],
      { encoding: "utf8", timeout: 120_000, windowsHide: true },
    );

    if (result.status !== 0) {
      await rm(partial, { force: true });
      const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      throw new Error(
        `curl could not download ${source.url}. Exit status: ${String(result.status)}. ${detail}`,
      );
    }

    await rm(destination, { force: true });
    await rename(partial, destination);
    const fields = listFields(await loadForm(destination));
    if (fields.length === 0) {
      throw new Error(
        `Downloaded PDF has no AcroForm fields: ${source.url}. Choose another official form.`,
      );
    }
    console.log(`Verified ${source.fileName}: ${fields.length} AcroForm fields.`);
    downloaded.push({
      label: source.label,
      url: source.url,
      path: destination,
      fieldCount: fields.length,
    });
  }

  return downloaded;
}
