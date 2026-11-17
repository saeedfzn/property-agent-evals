import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicProvider, type MessagesClient, sanitiseSchema } from "../src/model/anthropic.js";
import { FixtureProvider } from "../src/model/fixture.js";
import { selectProvider } from "../src/model/index.js";
import { estimateCostUsd, TransientModelError, type ModelRequest } from "../src/model/provider.js";
import { TOOL_SPECS } from "../src/tools.js";

type Body = Parameters<MessagesClient["beta"]["messages"]["create"]>[0];

function fakeClient(respond: (body: Body) => unknown) {
  const sent: Body[] = [];
  const client: MessagesClient = {
    beta: {
      messages: {
        create: async (body) => {
          sent.push(body);
          return respond(body) as Anthropic.Beta.Messages.BetaMessage;
        },
      },
    },
  };
  return { client, sent };
}

const baseReq: ModelRequest = {
  task: "classify",
  system: "sys",
  transcript: [{ role: "user", text: "hello" }],
  outputSchema: { type: "object", properties: { summary: { type: "string", minLength: 3 } }, required: ["summary"], additionalProperties: false },
  maxTokens: 1024,
  effort: "low",
  timeoutMs: 1000,
};

const message = (content: unknown[], stop = "end_turn") => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason: stop,
  usage: { input_tokens: 120, output_tokens: 30 },
});

describe("provider selection", () => {
  it("defaults to the fixture provider even when an API key is present", () => {
    const p = selectProvider({ ANTHROPIC_API_KEY: "sk-ant-test-not-real" });
    expect(p).toBeInstanceOf(FixtureProvider);
  });

  it("requires an explicit opt-in AND a key for the live provider", () => {
    expect(() => selectProvider({ MODEL_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
    const p = selectProvider({ MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-test-not-real" });
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.model).toBe("claude-opus-5-5");
  });

  it("model id is configurable", () => {
    expect(selectProvider({ ANTHROPIC_MODEL: "claude-sonnet-5-5" }).model).toBe("claude-sonnet-5-5");
  });

  it("rejects unknown providers", () => {
    expect(() => selectProvider({ MODEL_PROVIDER: "other" })).toThrow(/Unknown/);
  });
});

describe("AnthropicProvider (fake client, no network)", () => {
  it("builds a request that is valid for Opus 5.5", async () => {
    const { client, sent } = fakeClient(() => message([{ type: "text", text: '{"summary":"ok"}' }]));
    const p = new AnthropicProvider({ client });
    const res = await p.generate(baseReq);
    const body = sent[0]! as unknown as Record<string, unknown>;
    expect(body.model).toBe("claude-opus-5-5");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("thinking");
    expect(body.output_config).toEqual({
      effort: "low",
      format: { type: "json_schema", schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false } },
    });
    expect(body.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(body.fallbacks).toBe("default");
    expect(res).toMatchObject({ text: '{"summary":"ok"}', stopReason: "end_turn", usage: { inputTokens: 120, outputTokens: 30 } });
  });

  it("sends strict tools and maps tool_use blocks; replays raw content on the next turn", async () => {
    const raw = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "tool_use", id: "toolu_1", name: "get_unit", input: { unit_id: "U-ASH-1" } },
    ];
    const { client, sent } = fakeClient(() => message(raw, "tool_use"));
    const p = new AnthropicProvider({ client });
    const res = await p.generate({ ...baseReq, task: "gather_context", tools: TOOL_SPECS, outputSchema: undefined });
    const body = sent[0]!;
    expect(body.tools?.every((t) => "strict" in t && t.strict === true)).toBe(true);
    expect(res.toolCalls).toEqual([{ id: "toolu_1", name: "get_unit", input: { unit_id: "U-ASH-1" } }]);

    await p.generate({
      ...baseReq,
      task: "gather_context",
      tools: TOOL_SPECS,
      outputSchema: undefined,
      transcript: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "", toolCalls: res.toolCalls, providerRaw: res.providerRaw },
        { role: "tool_results", results: [{ toolCallId: "toolu_1", output: "{}", isError: false }] },
      ],
    });
    const second = sent[1]!;
    expect(second.messages[1]).toEqual({ role: "assistant", content: raw });
    expect(second.messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{}", is_error: false }] });
  });

  it("maps rate limits to a retryable error and leaves 400s alone", async () => {
    const limited = new AnthropicProvider({
      client: fakeClient(() => {
        throw new Anthropic.RateLimitError(429, undefined, "slow down", new Headers());
      }).client,
    });
    await expect(limited.generate(baseReq)).rejects.toBeInstanceOf(TransientModelError);
    const bad = new AnthropicProvider({
      client: fakeClient(() => {
        throw new Anthropic.BadRequestError(400, undefined, "bad", new Headers());
      }).client,
    });
    await expect(bad.generate(baseReq)).rejects.toBeInstanceOf(Anthropic.BadRequestError);
  });

  it("maps 5xx and connection errors to retryable errors, and passes the timeout and abort signal to the SDK", async () => {
    const overloaded = new AnthropicProvider({
      client: fakeClient(() => {
        throw new Anthropic.InternalServerError(529, undefined, "overloaded", new Headers());
      }).client,
    });
    await expect(overloaded.generate(baseReq)).rejects.toBeInstanceOf(TransientModelError);
    const offline = new AnthropicProvider({
      client: fakeClient(() => {
        throw new Anthropic.APIConnectionError({ message: "socket hang up" });
      }).client,
    });
    await expect(offline.generate(baseReq)).rejects.toBeInstanceOf(TransientModelError);

    let options: unknown;
    const signal = new AbortController().signal;
    const client: MessagesClient = { beta: { messages: { create: async (_body, opts) => ((options = opts), message([{ type: "text", text: "{}" }]) as Anthropic.Beta.Messages.BetaMessage) } } };
    await new AnthropicProvider({ client }).generate({ ...baseReq, signal });
    expect(options).toEqual({ timeout: 1000, maxRetries: 0, signal });
  });

  it("returns a refusal as a stop reason, not as text to parse", async () => {
    const p = new AnthropicProvider({ client: fakeClient(() => message([], "refusal")).client });
    expect(await p.generate(baseReq)).toMatchObject({ stopReason: "refusal", text: "" });
  });

  it("refuses to construct without a key or a client", () => {
    expect(() => new AnthropicProvider({})).toThrow(/apiKey/);
  });
});

describe("helpers", () => {
  it("strips schema keywords we validate ourselves", () => {
    expect(sanitiseSchema({ type: "string", minLength: 1, format: "email", $schema: "x" })).toEqual({ type: "string" });
  });
  it("keeps a property that happens to be named like a schema keyword", () => {
    const schema = { type: "object", properties: { format: { type: "string", maxLength: 5 }, pattern: { type: "string" } }, required: ["format", "pattern"] };
    expect(sanitiseSchema(schema)).toEqual({ type: "object", properties: { format: { type: "string" }, pattern: { type: "string" } }, required: ["format", "pattern"] });
  });
  it("estimates cost at list price", () => {
    expect(estimateCostUsd("claude-opus-5-5", 1_000_000, 0)).toBe(4);
    expect(estimateCostUsd("claude-opus-5-5", 0, 1_000_000)).toBe(20);
  });
});
