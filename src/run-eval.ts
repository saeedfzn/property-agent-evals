import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { triageMessage } from "./agents/orchestrator.js";
import { openDatabase, PropertyRepository } from "./db.js";
import { selectProvider } from "./model/index.js";
import { PROMPT_VERSIONS, type PromptVersion } from "./prompts.js";
import type { InboundMessage } from "./schemas.js";

/**
 * Runs the agent over the golden set and writes raw results for the Python graders.
 * Only each case's `input` is passed to the agent; `expected` never leaves this file's
 * reader, so neither the agent nor the fixture provider can see the answers.
 */
export const EVAL_NOW = new Date("2026-11-17T09:00:00Z");

async function main() {
  const { values } = parseArgs({
    options: {
      prompt: { type: "string", default: "v2" },
      golden: { type: "string", default: "evals/golden/cases.jsonl" },
      out: { type: "string" },
    },
  });
  const version = values.prompt as PromptVersion;
  if (!PROMPT_VERSIONS.includes(version)) throw new Error(`--prompt must be one of ${PROMPT_VERSIONS.join(", ")}`);
  const outDir = values.out ?? path.join("evals", "runs", version);

  const lines = (await readFile(values.golden!, "utf8")).split("\n").filter((l) => l.trim());
  const inputs: InboundMessage[] = lines.map((l) => {
    const c = JSON.parse(l) as { id: string; input: { from: string; received_at: string; body: string } };
    return { id: c.id, from: c.input.from, received_at: c.input.received_at, body: c.input.body };
  });

  const db = await openDatabase();
  const repo = new PropertyRepository(db);
  const provider = selectProvider();
  const before = await repo.countWorkOrders();

  const results: string[] = [];
  for (const msg of inputs) {
    try {
      const r = await triageMessage({ provider, repo, promptVersion: version, now: EVAL_NOW }, msg);
      results.push(JSON.stringify(r));
    } catch (err) {
      // A crash is recorded as an invalid result, which the graders count against validity.
      results.push(JSON.stringify({ message_id: msg.id, crashed: true, error: String(err) }));
    }
  }
  const after = await repo.countWorkOrders();

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "results.jsonl"), results.join("\n") + "\n");
  await writeFile(path.join(outDir, "snapshot.json"), JSON.stringify(await repo.snapshot(), null, 2) + "\n");
  await writeFile(
    path.join(outDir, "run.json"),
    JSON.stringify(
      { prompt_version: version, provider: provider.name, model: provider.model, cases: inputs.length, eval_now: EVAL_NOW.toISOString(), work_orders_before: before, work_orders_after: after },
      null,
      2,
    ) + "\n",
  );
  await db.close();
  console.log(`[eval] ${provider.name}/${provider.model} prompt=${version}: ${results.length} cases -> ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
