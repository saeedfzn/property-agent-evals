import { z } from "zod";
import type { AgentTask, ModelProvider, ModelResponse, TranscriptEntry } from "../model/provider.js";
import { withRetry, withTimeout } from "../reliability.js";
import type { Tracer } from "../trace.js";

export interface CallOptions {
  task: AgentTask;
  maxTokens: number;
  effort: "low" | "medium" | "high";
  timeoutMs: number;
  transientRetries: number;
}

// Thinking counts against max_tokens on current models, so the cap is generous; output length is set by the schema.
export const DEFAULT_CALL: Omit<CallOptions, "task"> = { maxTokens: 16_000, effort: "low", timeoutMs: 120_000, transientRetries: 2 };

/** One model call with a timeout, retried on transient errors, with every attempt traced. */
export async function callModel(
  provider: ModelProvider,
  tracer: Tracer,
  opts: CallOptions,
  req: { system: string; transcript: TranscriptEntry[]; tools?: Parameters<ModelProvider["generate"]>[0]["tools"]; outputSchema?: Record<string, unknown> },
  spanName: string,
): Promise<ModelResponse> {
  return withRetry(
    async (attempt) => {
      const t0 = performance.now();
      try {
        const res = await withTimeout(
          (signal) => provider.generate({ task: opts.task, maxTokens: opts.maxTokens, effort: opts.effort, timeoutMs: opts.timeoutMs, signal, ...req }),
          opts.timeoutMs,
          spanName,
        );
        const notes = [res.stopReason !== "end_turn" ? res.stopReason : "", res.model !== provider.model ? `served by ${res.model}` : ""].filter(Boolean).join("; ");
        tracer.model_call(spanName, attempt, true, res.latencyMs, res.usage.inputTokens, res.usage.outputTokens, notes || undefined, res.model);
        return res;
      } catch (err) {
        tracer.model_call(spanName, attempt, false, Math.round(performance.now() - t0), 0, 0, String(err));
        throw err;
      }
    },
    { retries: opts.transientRetries, baseDelayMs: 50, jitter: Math.random },
  );
}

export const errorText = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 200);

/** Strict JSON parse: the whole output must be one JSON value (no prose, no fences). */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text.trim()) };
  } catch (e) {
    return { ok: false, error: `not valid JSON (${(e as Error).message})` };
  }
}

export function validate<S extends z.ZodType>(schema: S, text: string): { ok: true; value: z.infer<S> } | { ok: false; error: string } {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  const r = schema.safeParse(parsed.value);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: z.prettifyError(r.error) };
}

export interface StructuredResult<T> {
  value: T | null;
  schemaFailures: number;
  lastError: string | null;
}

/**
 * Ask for a JSON object, validate it with zod, and on failure reject it and retry ONCE
 * with the validation error fed back. Two strikes -> null, and the caller degrades safely.
 * A model call that still fails after its retries (outage, rate limit, bad request) also
 * returns null instead of throwing, so one failing sub-agent never loses the whole message.
 */
export async function callStructured<S extends z.ZodType>(
  provider: ModelProvider,
  tracer: Tracer,
  opts: CallOptions,
  system: string,
  userText: string,
  schema: S,
): Promise<StructuredResult<z.infer<S>>> {
  const transcript: TranscriptEntry[] = [{ role: "user", text: userText }];
  const outputSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  let failures = 0;
  let lastError: string | null = null;
  for (let round = 1; round <= 2; round++) {
    let res: ModelResponse;
    try {
      res = await callModel(provider, tracer, opts, { system, transcript, outputSchema }, `${opts.task}${round > 1 ? ":repair" : ""}`);
    } catch (err) {
      return { value: null, schemaFailures: failures, lastError: `model call failed: ${errorText(err)}` };
    }
    if (res.stopReason === "refusal") {
      tracer.record(`${opts.task}:validate`, "validation", false, 0, "model refused");
      return { value: null, schemaFailures: failures + 1, lastError: "refusal" };
    }
    const v = validate(schema, res.text);
    tracer.record(`${opts.task}:validate`, "validation", v.ok, 0, v.ok ? undefined : v.error.slice(0, 200));
    if (v.ok) return { value: v.value, schemaFailures: failures, lastError };
    failures++;
    lastError = v.error;
    transcript.push({ role: "assistant", text: res.text, toolCalls: [], providerRaw: res.providerRaw });
    transcript.push({
      role: "user",
      text: `Your previous output was rejected: ${v.error}\nReturn ONLY a single JSON object that matches the schema. No prose.`,
    });
  }
  return { value: null, schemaFailures: failures, lastError };
}
