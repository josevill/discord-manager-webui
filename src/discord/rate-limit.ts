export interface RateLimitBucket {
  remaining: number;
  resetAt: number;
  limit: number;
}

export interface RateLimitedRequestOptions {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  formData?: FormData;
}

/** Statuses Discord may return transiently; retried with bounded backoff. */
const RETRYABLE_5XX = new Set([500, 502, 504]);
const MAX_5XX_RETRIES = 3;
const MAX_5XX_BACKOFF_MS = 4000;

function fiveXxBackoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, MAX_5XX_BACKOFF_MS);
}

export class RateLimitedClient {
  private buckets = new Map<string, RateLimitBucket>();
  private routeToBucket = new Map<string, string>();
  private globalResetAt = 0;
  private delayMs = 100;
  private consecutiveSuccesses = 0;
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(token: string, baseUrl = "https://discord.com/api/v10") {
    this.token = token;
    this.baseUrl = baseUrl;
  }

  getDelayMs(): number {
    return this.delayMs;
  }

  async request<T = unknown>(options: RateLimitedRequestOptions, attempt = 0): Promise<T> {
    await this.waitForGlobal();
    await this.waitForRoute(options.method, options.path);
    await sleep(this.delayMs);

    const headers: Record<string, string> = {
      Authorization: `Bot ${this.token}`,
      ...options.headers,
    };

    let body: string | FormData | undefined;
    if (options.formData) {
      body = options.formData;
    } else if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const url = `${this.baseUrl}${options.path}`;
    const response = await fetch(url, {
      method: options.method,
      headers,
      body,
    });

    this.updateFromHeaders(options.method, options.path, response.headers);

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After") ?? "1");
      const isGlobal = response.headers.get("X-RateLimit-Global") === "true";
      this.delayMs = Math.min(this.delayMs + 50, 2000);
      this.consecutiveSuccesses = 0;
      if (isGlobal) {
        this.globalResetAt = Date.now() + retryAfter * 1000;
      }
      await sleep(retryAfter * 1000);
      return this.request(options);
    }

    if (RETRYABLE_5XX.has(response.status) && attempt < MAX_5XX_RETRIES) {
      this.consecutiveSuccesses = 0;
      await response.text().catch(() => undefined);
      await sleep(fiveXxBackoffMs(attempt));
      return this.request(options, attempt + 1);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new DiscordApiError(response.status, options.method, options.path, text);
    }

    this.consecutiveSuccesses += 1;
    if (this.consecutiveSuccesses >= 10 && this.delayMs > 100) {
      this.delayMs = Math.max(100, this.delayMs - 10);
      this.consecutiveSuccesses = 0;
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const contentType = response.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json")) {
      return (await response.json()) as T;
    }
    return undefined as T;
  }

  private updateFromHeaders(method: string, path: string, headers: Headers): void {
    const bucket = headers.get("X-RateLimit-Bucket");
    const remaining = headers.get("X-RateLimit-Remaining");
    const resetAfter = headers.get("X-RateLimit-Reset-After");
    const limit = headers.get("X-RateLimit-Limit");
    const routeKey = `${method}:${normalizeRoute(path)}`;

    if (bucket) {
      this.routeToBucket.set(routeKey, bucket);
      this.buckets.set(bucket, {
        remaining: remaining !== null ? Number(remaining) : 1,
        resetAt: Date.now() + Number(resetAfter ?? 0) * 1000,
        limit: limit !== null ? Number(limit) : 50,
      });
    }
  }

  private async waitForGlobal(): Promise<void> {
    const wait = this.globalResetAt - Date.now();
    if (wait > 0) await sleep(wait);
  }

  private async waitForRoute(method: string, path: string): Promise<void> {
    const routeKey = `${method}:${normalizeRoute(path)}`;
    const bucketHash = this.routeToBucket.get(routeKey);
    if (!bucketHash) return;
    const bucket = this.buckets.get(bucketHash);
    if (!bucket) return;
    if (bucket.remaining <= 0 && bucket.resetAt > Date.now()) {
      await sleep(bucket.resetAt - Date.now());
    }
  }
}

export class DiscordApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`Discord API ${method} ${path} failed (${status}): ${body}`);
    this.name = "DiscordApiError";
  }

  /** Discord JSON error `code` from the response body, when present. */
  get discordCode(): number | undefined {
    try {
      const parsed = JSON.parse(this.body) as { code?: unknown };
      return typeof parsed.code === "number" ? parsed.code : undefined;
    } catch {
      return undefined;
    }
  }
}

function normalizeRoute(path: string): string {
  return path.replace(/\d{17,20}/g, ":id");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
