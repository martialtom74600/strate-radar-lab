import { StrateRadarError, isRetryableHttpStatus } from './errors.js';

export type RetryOptions = {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
};

const defaultRetryOptions: RetryOptions = {
  maxAttempts: 4,
  baseDelayMs: 400,
  maxDelayMs: 15_000,
  jitterRatio: 0.25,
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDelayMs(
  attemptIndex: number,
  retryAfterMs: number | undefined,
  opts: RetryOptions,
): number {
  if (retryAfterMs !== undefined && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, opts.maxDelayMs);
  }
  const exp = opts.baseDelayMs * 2 ** attemptIndex;
  const capped = Math.min(exp, opts.maxDelayMs);
  const jitter = capped * opts.jitterRatio * Math.random();
  return capped + jitter;
}

export type RetryContext = {
  readonly attempt: number;
  readonly maxAttempts: number;
};

export async function withRetry<T>(
  fn: (ctx: RetryContext) => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts: RetryOptions = { ...defaultRetryOptions, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await fn({ attempt: attempt + 1, maxAttempts: opts.maxAttempts });
    } catch (err) {
      lastError = err;
      const retryable = classifyRetryable(err);
      if (!retryable.ok) throw err;
      if (attempt >= opts.maxAttempts - 1) break;
      await sleep(computeDelayMs(attempt, retryable.retryAfterMs, opts));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new StrateRadarError('RETRY_EXHAUSTED', 'Échec après plusieurs tentatives', {
        cause: lastError,
      });
}

type RetryableResult =
  | { readonly ok: true; readonly retryAfterMs?: number }
  | { readonly ok: false };

function classifyRetryable(err: unknown): RetryableResult {
  if (err instanceof StrateRadarError && err.code === 'HTTP_STATUS') {
    const status = err.status;
    if (status === 429) {
      return { ok: false };
    }
    if (typeof status === 'number' && isRetryableHttpStatus(status)) {
      return { ok: true };
    }
    return { ok: false };
  }
  if (err instanceof TypeError && err.message.includes('fetch')) {
    return { ok: true };
  }
  const msg = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
      ? err.code
      : '';
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket/i.test(`${code} ${msg}`)) {
    return { ok: true };
  }
  return { ok: false };
}
