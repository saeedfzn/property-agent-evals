import Anthropic from "@anthropic-ai/sdk";
import type { ModelProvider, ModelRequest, ModelResponse, ToolCall, TranscriptEntry } from "./provider.js";
import { TransientModelError } from "./provider.js";

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaToolUnion = Anthropic.Beta.Messages.BetaToolUnion;
type BetaCreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** The subset of the SDK client this provider uses, so tests can inject a fake. */
export interface MessagesClient {
  beta: { messages: { create(body: BetaCreateParams, options?: { timeout?: number; maxRetries?: number; signal?: AbortSignal }): Promise<Anthropic.Beta.Messages.BetaMessage> } };
}

/** Keywords some structured-output schema validators reject; zod adds them, we validate them ourselves after. */
const UNSUPPORTED_SCHEMA_KEYS = new Set(["$schema", "minLength", "maxLength", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]);

/** Keys whose value is a map of NAME -> schema: the names are data, not keywords, and are never stripped. */
const NAME_MAPS = new Set(["properties", "$defs", "definitions"]);

export function sanitiseSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitiseSchema);
  if (schema && typeof schema === "object") {
    return Object.fromEntries(
      Object.entries(schema as Record<string, unknown>)
        .filter(([k]) => !UNSUPPORTED_SCHEMA_KEYS.has(k))
        .map(([k, v]) => [
          k,
          NAME_MAPS.has(k) && v && typeof v === "object" && !Array.isArray(v)
            ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([name, s]) => [name, sanitiseSchema(s)]))
            : sanitiseSchema(v),
        ]),
    );
  }
  return schema;
}

export function toAnthropicMessages(transcript: TranscriptEntry[]): BetaMessageParam[] {
  return transcript.map((e): BetaMessageParam => {
    if (e.role === "user") return { role: "user", content: e.text };
    if (e.role === "assistant") {
      // Replay the provider's own content verbatim (keeps thinking blocks valid across tool turns).
      if (e.providerRaw) return { role: "assistant", content: e.providerRaw as BetaContentBlockParam[] };
      const blocks: BetaContentBlockParam[] = [];
      if (e.text) blocks.push({ type: "text", text: e.text });
      for (const c of e.toolCalls) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input as Record<string, unknown> });
      return { role: "assistant", content: blocks };
    }
    // All results for one assistant turn go back in a single user message.
    return {
      role: "user",
      content: e.results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.toolCallId, content: r.output, is_error: r.isError })),
    };
  });
}

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly client: MessagesClient;

  constructor(opts: { apiKey?: string; model?: string; client?: MessagesClient }) {
    this.model = opts.model ?? "claude-opus-5-5";
    if (opts.client) this.client = opts.client;
    else {
      if (!opts.apiKey) throw new Error("AnthropicProvider needs an explicit apiKey");
      // maxRetries: 0 -> retries are owned (and traced) by the orchestrator.
      this.client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 0 });
    }
  }

  buildRequest(req: ModelRequest): BetaCreateParams {
    const tools: BetaToolUnion[] | undefined = req.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { ...(sanitiseSchema(t.inputSchema) as Record<string, unknown>), type: "object" as const },
      strict: true,
    }));
    return {
      model: this.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: toAnthropicMessages(req.transcript),
      // Opus 5.5: thinking is adaptive by default and cannot be disabled; depth is set with effort.
      // No temperature/top_p, no forced tool_choice, no prefill on this model.
      output_config: {
        effort: req.effort,
        ...(req.outputSchema && !tools ? { format: { type: "json_schema" as const, schema: sanitiseSchema(req.outputSchema) as Record<string, unknown> } } : {}),
      },
      ...(tools ? { tools } : {}),
      // Server-side refusal fallback: a request declined by a safety classifier is re-run on the
      // model Anthropic recommends for that refusal category. The response's `model` is whichever
      // model answered, and the tracer prices the call by that model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const started = performance.now();
    let msg: Anthropic.Beta.Messages.BetaMessage;
    try {
      msg = await this.client.beta.messages.create(this.buildRequest(req), { timeout: req.timeoutMs, maxRetries: 0, signal: req.signal });
    } catch (err) {
      // Most specific first. Retryable: rate limit, overload/5xx, connection and timeout errors.
      if (err instanceof Anthropic.RateLimitError) throw new TransientModelError(`rate limited: ${err.message}`);
      if (err instanceof Anthropic.InternalServerError) throw new TransientModelError(`server error ${err.status}: ${err.message}`);
      if (err instanceof Anthropic.APIConnectionError) throw new TransientModelError(`connection/timeout: ${err.message}`);
      throw err; // 400/401/403/404 etc. are bugs or config errors: do not retry.
    }
    const toolCalls: ToolCall[] = [];
    let text = "";
    for (const block of msg.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
    const stop = msg.stop_reason;
    return {
      text,
      toolCalls,
      stopReason: stop === "end_turn" || stop === "tool_use" || stop === "max_tokens" || stop === "refusal" ? stop : "other",
      usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
      latencyMs: Math.round(performance.now() - started),
      model: msg.model,
      providerRaw: msg.content,
    };
  }
}
