import { openDatabase, PropertyRepository } from "../src/db.js";
import { FixtureProvider } from "../src/model/fixture.js";
import type { AgentTask, ModelProvider, ModelRequest, ModelResponse } from "../src/model/provider.js";

export const NOW = new Date("2026-11-17T09:00:00Z");

export async function freshRepo() {
  const db = await openDatabase();
  return { db, repo: new PropertyRepository(db) };
}

/** Fixture with no injected faults, so tests control exactly what goes wrong. */
export const cleanFixture = () => new FixtureProvider({ faults: { invalidJsonOnCall: {}, transientOnCall: {} } });

/** Wraps a provider and lets a test replace the output for chosen tasks/calls. */
export class OverrideProvider implements ModelProvider {
  readonly name = "override";
  readonly model: string;
  readonly calls: Record<AgentTask, number> = { classify: 0, gather_context: 0, draft_reply: 0 };
  constructor(
    private readonly inner: ModelProvider,
    private readonly override: (req: ModelRequest, n: number, real: () => Promise<ModelResponse>) => Promise<ModelResponse> | ModelResponse | null,
  ) {
    this.model = inner.model;
  }
  async generate(req: ModelRequest): Promise<ModelResponse> {
    const n = ++this.calls[req.task];
    const real = () => this.inner.generate(req);
    const o = await this.override(req, n, real);
    return o ?? real();
  }
}

export const textResponse = (text: string): ModelResponse => ({
  text,
  toolCalls: [],
  stopReason: "end_turn",
  usage: { inputTokens: 10, outputTokens: 10 },
  latencyMs: 5,
  model: "claude-opus-5-5",
});
