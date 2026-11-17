import { parseArgs } from "node:util";
import { triageMessage } from "./agents/orchestrator.js";
import { openDatabase, PropertyRepository } from "./db.js";
import { selectProvider } from "./model/index.js";
import type { PromptVersion } from "./prompts.js";

/** Triage one message: npm run triage -- --from t.okafor@example.com "The kitchen tap is still dripping" */
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { from: { type: "string", default: "t.okafor@example.com" }, prompt: { type: "string", default: "v2" }, trace: { type: "boolean", default: false } },
  });
  const body = positionals.join(" ").trim();
  if (!body) throw new Error('usage: npm run triage -- --from <email> "message text"');
  const db = await openDatabase();
  const result = await triageMessage(
    { provider: selectProvider(), repo: new PropertyRepository(db), promptVersion: values.prompt as PromptVersion, now: new Date("2026-11-17T09:00:00Z") },
    { id: "cli", from: values.from!, received_at: new Date().toISOString(), body },
  );
  const { trace, ...rest } = result;
  console.log(JSON.stringify(values.trace ? result : { ...rest, trace: { total_latency_ms: trace.total_latency_ms, total_cost_usd: trace.total_cost_usd, spans: trace.spans.length } }, null, 2));
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
