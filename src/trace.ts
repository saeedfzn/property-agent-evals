import type { Span } from "./schemas.js";
import { estimateCostUsd } from "./model/provider.js";

/** Per-message trace: one span per model call, tool call, rule check and validation. */
export class Tracer {
  readonly spans: Span[] = [];
  constructor(private readonly model: string) {}

  /** `servedBy` is the model that answered; it differs from the requested one after a server-side fallback. */
  model_call(name: string, attempt: number, ok: boolean, latencyMs: number, inputTokens: number, outputTokens: number, note?: string, servedBy?: string): void {
    this.spans.push({
      name,
      kind: "model",
      ok,
      attempt,
      latency_ms: latencyMs,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: estimateCostUsd(servedBy ?? this.model, inputTokens, outputTokens),
      ...(note ? { note } : {}),
    });
  }

  record(name: string, kind: "tool" | "rule" | "validation", ok: boolean, latencyMs: number, note?: string): void {
    this.spans.push({ name, kind, ok, attempt: 1, latency_ms: latencyMs, input_tokens: 0, output_tokens: 0, cost_usd: 0, ...(note ? { note } : {}) });
  }

  async time<T>(name: string, kind: "tool" | "rule", fn: () => Promise<T> | T, note?: (v: T) => string): Promise<T> {
    const t0 = performance.now();
    try {
      const v = await fn();
      this.record(name, kind, true, round(performance.now() - t0), note?.(v));
      return v;
    } catch (err) {
      this.record(name, kind, false, round(performance.now() - t0), String(err));
      throw err;
    }
  }

  totals() {
    const sum = (k: "latency_ms" | "input_tokens" | "output_tokens" | "cost_usd") => this.spans.reduce((a, s) => a + s[k], 0);
    return {
      spans: this.spans,
      total_latency_ms: round(sum("latency_ms")),
      total_input_tokens: sum("input_tokens"),
      total_output_tokens: sum("output_tokens"),
      total_cost_usd: Number(sum("cost_usd").toFixed(6)),
    };
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
