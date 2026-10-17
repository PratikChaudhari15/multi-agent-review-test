/**
 * Rate Limiter for API requests and token usage
 * Prevents exceeding Anthropic API rate limits
 *
 * This implements a token bucket algorithm with sliding window.
 *
 * Concepts:
 * - Tracks requests and tokens used in the last 60 seconds (sliding window)
 * - Limits concurrent requests to prevent overwhelming the API
 * - Uses token estimation to prevent exceeding token-per-minute limits
 */

export interface RateLimiterConfig {
  /** Maximum requests per minute */
  maxRequestsPerMinute: number;
  /** Maximum tokens per minute */
  maxTokensPerMinute: number;
  /** Maximum concurrent requests */
  maxConcurrent: number;
}

export const DEFAULT_RATE_LIMITS: RateLimiterConfig = {
  maxRequestsPerMinute: 50,      // Conservative default
  maxTokensPerMinute: 100000,    // ~100k tokens/min
  maxConcurrent: 5               // Max parallel requests
};

interface RequestRecord {
  timestamp: number;
  tokens: number;
}

/**
 * Token bucket rate limiter with sliding window
 */
export class RateLimiter {
  private config: RateLimiterConfig;
  private requestHistory: RequestRecord[] = [];
  private activeRequests: number = 0;
  private waitQueue: Array<() => void> = [];

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.config = { ...DEFAULT_RATE_LIMITS, ...config };

    for (const key of [
      'maxRequestsPerMinute',
      'maxTokensPerMinute',
      'maxConcurrent'
    ] as const) {
      const value = this.config[key];

      if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError(`${key} must be a positive finite number`);
      }

      if (key !== 'maxTokensPerMinute' && !Number.isInteger(value)) {
        throw new RangeError(`${key} must be a positive integer`);
      }
    }
  }

  /**
   * Wait until a request can be made within rate limits
   *
   * This is the main entry point for rate limiting.
   * It ensures:
   * 1. Concurrent request limit is not exceeded
   * 2. Request and token rate limits are respected
   * 3. The request is recorded for future rate limit calculations
   *
   * @param estimatedTokens - Estimated tokens for this request
   */
  async acquire(estimatedTokens: number = 1000): Promise<void> {
    if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0) {
      throw new RangeError('estimatedTokens must be a non-negative finite number');
    }

    if (estimatedTokens > this.config.maxTokensPerMinute) {
      throw new RangeError('estimatedTokens exceeds the configured token limit');
    }

    while (this.activeRequests >= this.config.maxConcurrent) {
      await this.waitForSlot();
    }

    await this.waitForRateLimit(estimatedTokens);

    // Recheck concurrency because another request may have acquired a slot
    // while this request was waiting for rate limits.
    while (this.activeRequests >= this.config.maxConcurrent) {
      await this.waitForSlot();
    }

    this.activeRequests += 1;
    this.requestHistory.push({
      timestamp: Date.now(),
      tokens: estimatedTokens
    });
  }

  /**
   * Release a request slot after completion
   * @param actualTokens - Actual tokens used (updates estimate)
   */
  release(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);

    // Wake up the next waiting request.
    const next = this.waitQueue.shift();
    if (next) next();
  }

  /**
   * Get current rate limit status
   */
  getStatus(): {
    activeRequests: number;
    requestsInWindow: number;
    tokensInWindow: number;
    availableRequests: number;
    availableTokens: number;
  } {
    this.pruneOldRecords();

    const requestsInWindow = this.requestHistory.length;
    const tokensInWindow = this.requestHistory.reduce((sum, r) => sum + r.tokens, 0);

    return {
      activeRequests: this.activeRequests,
      requestsInWindow,
      tokensInWindow,
      availableRequests: Math.max(0, this.config.maxRequestsPerMinute - requestsInWindow),
      availableTokens: Math.max(0, this.config.maxTokensPerMinute - tokensInWindow)
    };
  }

  /**
   * Check if request can proceed immediately
   *
   * @param estimatedTokens - Estimated tokens for the request
   * @returns true if the request can proceed without waiting
   */
  canProceed(estimatedTokens: number = 1000): boolean {
    this.pruneOldRecords();

    const requestsInWindow = this.requestHistory.length;
    const tokensInWindow = this.requestHistory.reduce(
      (sum, request) => sum + request.tokens,
      0
    );

    return (
      this.activeRequests < this.config.maxConcurrent &&
      requestsInWindow < this.config.maxRequestsPerMinute &&
      tokensInWindow + estimatedTokens <= this.config.maxTokensPerMinute
    );
  }

  /**
   * Wait for a concurrent request slot to become available
   *
   * This creates a Promise that resolves when release() is called
   * and there's a queued waiter.
   */
  private async waitForSlot(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  /**
   * Wait until rate limits allow the request to proceed
   *
   * This implements the sliding window algorithm.
   * If we can't proceed immediately, we calculate how long to wait
   * until the oldest request expires (falls out of the 60-second window).
   *
   * @param estimatedTokens - Estimated tokens for the request
   */
  private async waitForRateLimit(estimatedTokens: number): Promise<void> {
    while (true) {
      this.pruneOldRecords();

      const requestsInWindow = this.requestHistory.length;
      const tokensInWindow = this.requestHistory.reduce(
        (sum, request) => sum + request.tokens,
        0
      );

      const requestLimitReached =
        requestsInWindow >= this.config.maxRequestsPerMinute;
      const tokenLimitReached =
        tokensInWindow + estimatedTokens > this.config.maxTokensPerMinute;

      if (!requestLimitReached && !tokenLimitReached) {
        return;
      }

      const oldestRequest = this.requestHistory[0];
      if (!oldestRequest) {
        return;
      }

      const waitTime = Math.min(
        5000,
        Math.max(100, oldestRequest.timestamp + 60000 - Date.now() + 100)
      );

      await new Promise<void>((resolve) => {
        setTimeout(resolve, waitTime);
      });
    }
  }

  /**
   * Remove request records older than 60 seconds (sliding window)
   *
   * This is called before checking rate limits to ensure we only
   * count requests in the current 60-second window.
   */
  private pruneOldRecords(): void {
    const cutoff = Date.now() - 60000;
    this.requestHistory = this.requestHistory.filter(
      (request) => request.timestamp > cutoff
    );
  }
}

/**
 * Wrap an async function with rate limiting
 *
 * This is a convenience function for applying rate limiting to any async operation.
 */
export async function withRateLimit<T>(
  rateLimiter: RateLimiter,
  fn: () => Promise<T>,
  estimatedTokens: number = 1000
): Promise<T> {
  let acquired = false;

  try {
    await rateLimiter.acquire(estimatedTokens);
    acquired = true;
    return await fn();
  } finally {
    if (acquired) {
      rateLimiter.release();
    }
  }
}

// Global rate limiter instance
export const globalRateLimiter = new RateLimiter();