export type StrateRadarErrorOptions = {
  readonly cause?: unknown;
  readonly status?: number;
};

export class StrateRadarError extends Error {
  readonly code: string;
  readonly cause?: unknown;
  readonly status?: number;

  constructor(code: string, message: string, options?: StrateRadarErrorOptions) {
    super(message);
    this.name = 'StrateRadarError';
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
    if (options?.status !== undefined) {
      this.status = options.status;
    }
  }
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || (status >= 500 && status <= 599);
}
