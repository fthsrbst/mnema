import type { AdapterTelemetry } from "../types.js";

export interface HttpRequestResult<T> {
  status: number;
  data: T | null;
}

export interface BenchmarkHttpClientOptions {
  provider: string;
  baseUrl: string;
  headers?: Record<string, string>;
  requestTimeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  telemetry: () => AdapterTelemetry;
  redactValues?: string[];
}

interface RequestOptions {
  body?: Record<string, unknown>;
  expectedStatuses: number[];
  safeToRetry?: boolean;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTransientProviderError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    /timed out|HTTP 408|HTTP 409|HTTP 429|HTTP 5\d\d/.test(error.message)
  );
}

export class BenchmarkHttpClient {
  constructor(private readonly options: BenchmarkHttpClientOptions) {}

  async request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    pathname: string,
    options: RequestOptions
  ): Promise<HttpRequestResult<T>> {
    const url = new URL(pathname, `${this.options.baseUrl}/`);
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const bodyBytes = body === undefined ? 0 : Buffer.byteLength(body);
    for (let attempt = 0; ; attempt++) {
      const telemetry = this.options.telemetry();
      telemetry.requestCount++;
      telemetry.requestBytes += bodyBytes;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
      let response: Response;
      let text: string;
      try {
        response = await fetch(url, {
          method,
          headers: {
            ...this.options.headers,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
        });
        text = await response.text();
      } catch (error) {
        clearTimeout(timeout);
        if (controller.signal.aborted) {
          if (options.safeToRetry && attempt < this.options.maxRetries) {
            telemetry.retryCount++;
            await sleep(this.options.retryBaseDelayMs * (attempt + 1));
            continue;
          }
          throw new Error(
            `${this.options.provider} ${method} ${url.pathname} timed out after ${this.options.requestTimeoutMs}ms`
          );
        }
        if (options.safeToRetry && attempt < this.options.maxRetries) {
          telemetry.retryCount++;
          await sleep(this.options.retryBaseDelayMs * (attempt + 1));
          continue;
        }
        throw new Error(
          `${this.options.provider} ${method} ${url.pathname} failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      clearTimeout(timeout);
      telemetry.responseBytes += Buffer.byteLength(text);
      const retryableStatus =
        response.status === 408 ||
        response.status === 409 ||
        response.status === 429 ||
        response.status >= 500;
      if (retryableStatus && options.safeToRetry && attempt < this.options.maxRetries) {
        telemetry.retryCount++;
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterSeconds = retryAfterHeader === null ? null : Number(retryAfterHeader);
        const delay =
          retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds)
            ? Math.min(2_000, Math.max(0, retryAfterSeconds * 1_000))
            : this.options.retryBaseDelayMs * (attempt + 1);
        await sleep(delay);
        continue;
      }
      if (!options.expectedStatuses.includes(response.status)) {
        const detail = this.redact(text).slice(0, 300);
        throw new Error(
          `${this.options.provider} ${method} ${url.pathname} returned HTTP ${response.status}${
            detail ? `: ${detail}` : ""
          }`
        );
      }
      let data: unknown = null;
      if (text.trim() !== "") {
        try {
          data = JSON.parse(text) as unknown;
        } catch {
          throw new Error(
            `${this.options.provider} ${method} ${url.pathname} returned invalid JSON (HTTP ${response.status})`
          );
        }
      }
      return { status: response.status, data: data as T | null };
    }
  }

  private redact(value: string): string {
    let redacted = value;
    for (const secret of this.options.redactValues ?? []) {
      if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
    }
    return redacted;
  }
}
