/**
 * Provider-neutral model interface. The orchestrator only ever talks to this, so the
 * same orchestration, validation, retry and tracing code runs against the scripted
 * fixture provider (tests/CI) and the live Anthropic provider.
 */

export type AgentTask = "classify" | "gather_context" | "draft_reply";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type TranscriptEntry =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      toolCalls: ToolCall[];
      /** Provider-specific raw content (e.g. thinking blocks) replayed verbatim on the next turn. */
      providerRaw?: unknown;
    }
  | { role: "tool_results"; results: { toolCallId: string; output: string; isError: boolean }[] };

export interface ModelRequest {
  task: AgentTask;
  system: string;
  transcript: TranscriptEntry[];
  tools?: ToolSpec[];
  /** When set, the provider should constrain the final answer to this JSON Schema. */
  outputSchema?: Record<string, unknown>;
  maxTokens: number;
  effort: "low" | "medium" | "high";
  timeoutMs: number;
  /** Aborted when the caller's timeout fires, so the provider can cancel the in-flight request. */
  signal?: AbortSignal;
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
  usage: { inputTokens: number; outputTokens: number };
  /** Model latency. Real for live providers; simulated (deterministic) for the fixture. */
  latencyMs: number;
  model: string;
  providerRaw?: unknown;
}

export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  generate(req: ModelRequest): Promise<ModelResponse>;
}

/** Thrown for failures worth retrying (timeouts, rate limits, 5xx, connection resets). */
export class TransientModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientModelError";
  }
}

/** US$ per million tokens, list price. Used to estimate cost from token counts. */
export const PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING_PER_MTOK[model] ?? PRICING_PER_MTOK["claude-opus-5-5"]!;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
