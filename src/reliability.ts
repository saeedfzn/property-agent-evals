import { TransientModelError } from "./model/provider.js";

export class TimeoutError extends TransientModelError {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Rejects if the call does not settle within `ms`, and aborts it: the AbortSignal is
 * passed to the call, so a timed-out HTTP request is cancelled instead of being left
 * running (and billed) while the retry starts.
 */
export async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, label: string): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new TimeoutError(label, ms);
      reject(err);
      controller.abort(err);
    }, ms);
  });
  const call = run(controller.signal);
  // If the timeout wins, the aborted call rejects later; that rejection is handled here.
  call.catch(() => {});
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  /** Upper bound for one backoff delay. Default 10 s. */
  maxDelayMs?: number;
  /** Returns 0..1. When set, each delay is scaled to 50-100% of its value, so retries from many workers do not align. */
  jitter?: () => number;
  onRetry?: (attempt: number, err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Retries only TransientModelError (timeouts, rate limits, 5xx), with capped exponential backoff. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (!(err instanceof TransientModelError) || attempt > opts.retries) throw err;
      opts.onRetry?.(attempt, err);
      const capped = Math.min(opts.baseDelayMs * 2 ** (attempt - 1), opts.maxDelayMs ?? 10_000);
      await sleep(opts.jitter ? capped * (0.5 + 0.5 * opts.jitter()) : capped);
    }
  }
}
