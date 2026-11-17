import { describe, expect, it } from "vitest";
import { TransientModelError } from "../src/model/provider.js";
import { TimeoutError, withRetry, withTimeout } from "../src/reliability.js";

const noSleep = async () => {};

describe("withTimeout", () => {
  it("rejects with a retryable TimeoutError when the call hangs", async () => {
    const err = await withTimeout(() => new Promise<never>(() => {}), 20, "classify").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).toBeInstanceOf(TransientModelError);
  });

  it("aborts the in-flight call when the timeout fires, and not when the call finishes in time", async () => {
    let seen: AbortSignal | undefined;
    await withTimeout(
      (signal) => {
        seen = signal;
        return new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      },
      20,
      "classify",
    ).catch(() => {});
    expect(seen?.aborted).toBe(true);
    await withTimeout(async (signal) => void (seen = signal), 1000, "x");
    expect(seen?.aborted).toBe(false);
  });

  it("passes the value through when the call is fast enough", async () => {
    await expect(withTimeout(async () => 42, 1000, "x")).resolves.toBe(42);
  });
});

describe("withRetry", () => {
  it("retries transient errors, then succeeds", async () => {
    let calls = 0;
    const v = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new TransientModelError("busy");
        return "ok";
      },
      { retries: 2, baseDelayMs: 1, sleep: noSleep },
    );
    expect([v, calls]).toEqual(["ok", 3]);
  });

  it("gives up after N retries", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new TransientModelError("still busy");
        },
        { retries: 2, baseDelayMs: 1, sleep: noSleep },
      ),
    ).rejects.toThrow("still busy");
    expect(calls).toBe(3);
  });

  it("never retries a non-transient error", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("400 bad request");
        },
        { retries: 5, baseDelayMs: 1, sleep: noSleep },
      ),
    ).rejects.toThrow("400");
    expect(calls).toBe(1);
  });

  it("backs off exponentially", async () => {
    const delays: number[] = [];
    await withRetry(
      async (attempt) => {
        if (attempt < 4) throw new TransientModelError("x");
        return 1;
      },
      { retries: 3, baseDelayMs: 100, sleep: async (ms) => void delays.push(ms) },
    );
    expect(delays).toEqual([100, 200, 400]);
  });

  it("caps the delay and applies jitter when asked", async () => {
    const delays: number[] = [];
    await withRetry(
      async (attempt) => {
        if (attempt < 4) throw new TransientModelError("x");
        return 1;
      },
      { retries: 3, baseDelayMs: 100, maxDelayMs: 250, jitter: () => 0, sleep: async (ms) => void delays.push(ms) },
    );
    expect(delays).toEqual([50, 100, 125]);
  });
});
