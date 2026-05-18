// Tiny CLI wrapper around scribe(). Accepts repeatable --text and --image flags.
//   npm run scribe -- --form fixtures/sample-form.pdf --text "..." --image photo.png --out out/filled.pdf
import "dotenv/config";
import { resolve } from "node:path";
import { scribe } from "./scribe.ts";

interface Args {
  form?: string;
  out?: string;
  texts: string[];
  images: string[];
  model?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { texts: [], images: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) break;
    if (flag === "--form") {
      args.form = value;
      i++;
    } else if (flag === "--out") {
      args.out = value;
      i++;
    } else if (flag === "--text") {
      args.texts.push(value);
      i++;
    } else if (flag === "--image") {
      args.images.push(value);
      i++;
    } else if (flag === "--model") {
      args.model = value;
      i++;
    }
  }
  return args;
}

function usage(): never {
  console.error(
    [
      "Usage:",
      '  npm run scribe -- --form <pdf> --out <pdf> [--text "..."]... [--image <path>]... [--model <slug>]',
      "",
      "Notes:",
      "  --text and --image may be repeated. At least one of them is required.",
      "  The form PDF must have AcroForm fields (use `npm run make-fixture` for a sample).",
    ].join("\n"),
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.form || !args.out) usage();
  if (args.texts.length === 0 && args.images.length === 0) usage();

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is not set. Copy .env.example to .env and paste your key.");
    process.exit(1);
  }

  const result = await scribe({
    formPath: resolve(args.form),
    outPath: resolve(args.out),
    inputs: { texts: args.texts, images: args.images },
    apiKey,
    model: args.model,
  });

  console.log(`Filled PDF: ${result.outPath}`);
  console.log(`Transcript: ${result.transcriptPath}`);
  console.log(`Model:      ${result.modelUsed}`);
  console.log(`Tool calls: ${result.toolCallCount}`);
  console.log("");
  console.log(`Summary: ${result.summary}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
