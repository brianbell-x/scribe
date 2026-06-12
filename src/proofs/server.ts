import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";

process.noDeprecation = true;
process.env.OPENROUTER_API_KEY = "";

const { createServer } = await import("../server.ts");
const { loadForm } = await import("../pdf.ts");

async function json(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, init);
  assert.equal(res.ok, true, `${path} -> ${res.status}`);
  return res.json();
}

async function main(): Promise<void> {
  const server = createServer(process.cwd());
  server.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const html = await fetch(`${base}/`).then((r) => r.text());
    assert.match(html, /Scribe Operator/);

    const pdf = (await readFile("fixtures/sample-form.pdf")).toString("base64");
    const data = Buffer.from("Jane Doe, jane@example.com").toString("base64");
    const { id } = await json(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pdf, sources: [{ name: "notes.txt", type: "text/plain", data }] }),
    });
    assert.match(id, /^run_/);

    const ac = new AbortController();
    const events = await fetch(`${base}/api/runs/${id}/events`, { signal: ac.signal });
    assert.equal(events.headers.get("content-type")?.startsWith("text/event-stream"), true);
    const first = await events.body?.getReader().read();
    ac.abort();
    assert.match(new TextDecoder().decode(first?.value), /event: run_started/);

    const state = await json(`${base}/api/runs/${id}`);
    assert.equal(
      state.fields.some((f: { name: string }) => f.name === "full_name"),
      true,
    );
    assert.deepEqual(state.missingRequired, []);

    await json(`${base}/api/runs/${id}/fields`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ field: "full_name", value: "Offline Operator" }),
    });
    const corrected = await json(`${base}/api/runs/${id}`);
    assert.equal(corrected.values.full_name, "Offline Operator");

    const exported = await fetch(`${base}/api/runs/${id}/export`);
    assert.equal(exported.headers.get("content-type"), "application/pdf");
    const bytes = Buffer.from(await exported.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
    await writeFile("out/proof-server-export.pdf", bytes);
    const form = await loadForm("out/proof-server-export.pdf");
    assert.equal(form.fields.get("full_name")?.currentValue, "Offline Operator");
    console.log("ok: server endpoints, SSE, correction, export");
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
