// Convert the engineering decisions markdown to a styled standalone HTML page.
// Boring on purpose — `marked` + an inline <style> block.
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { marked } from "marked";

// Single light theme with every text-bearing element given an explicit color, so the page
// can't get hijacked by a browser's dark-mode override or system high-contrast setting and
// end up with white-on-white inline code.
const STYLE = `
:root { color-scheme: light; }
html, body { background: #ffffff; color: #1a1a1a; }
body {
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  max-width: 760px;
  margin: 40px auto;
  padding: 0 24px 80px;
}
h1, h2, h3 { letter-spacing: -0.01em; color: #1a1a1a; }
h1 { font-size: 28px; margin: 0 0 4px; }
h2 {
  font-size: 20px;
  margin: 32px 0 8px;
  padding-top: 16px;
  border-top: 1px solid #e5e5e5;
}
h3 { font-size: 16px; margin: 20px 0 4px; }
p, li { color: #1a1a1a; }
strong { color: #000; }
em { color: #1a1a1a; }
code {
  background: #f0f0f3;
  color: #b3274d;
  padding: 1px 6px;
  border-radius: 4px;
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
pre {
  background: #f6f6f8;
  border: 1px solid #e5e5e5;
  border-radius: 6px;
  padding: 12px 14px;
  overflow-x: auto;
}
pre code {
  background: transparent;
  color: #1a1a1a;
  padding: 0;
  border-radius: 0;
}
blockquote {
  border-left: 3px solid #999;
  margin: 16px 0;
  padding: 6px 16px;
  color: #444;
  background: #fafafa;
}
hr { border: none; border-top: 1px solid #e5e5e5; margin: 32px 0; }
a { color: #0a66c2; }
ul, ol { padding-left: 22px; }
`.trim();

async function main(): Promise<void> {
  const [inputArg, outputArg] = process.argv.slice(2);
  if (!inputArg || !outputArg) {
    console.error("Usage: tsx src/scripts/md-to-html.ts <input.md> <output.html>");
    process.exit(2);
  }
  const md = await readFile(resolve(inputArg), "utf8");
  const body = marked.parse(md, { async: false }) as string;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${basename(inputArg, ".md")}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
  await writeFile(resolve(outputArg), html, "utf8");
  console.log(`Wrote ${outputArg}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
