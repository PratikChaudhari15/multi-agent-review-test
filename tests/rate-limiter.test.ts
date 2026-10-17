import { describe, it, expect, vi } from 'vitest';
import {
  RateLimiter,
  withRateLimit,
} from '../src/utils/rate-limiter';

describe('RateLimiter', () => {
  it('uses default limits', () => {
    const limiter = new RateLimiter();
    expect(limiter.getStatus()).toMatchObject({
      activeRequests: 0,
      requestsInWindow: 0,
      tokensInWindow: 0,
      availableRequests: 50,
      availableTokens: 100000,
    });
  });

  it('accepts custom limits', () => {
    const limiter = new RateLimiter({
      maxRequestsPerMinute: 2,
      maxTokensPerMinute: 500,
      maxConcurrent: 1,
    });

    expect(limiter.getStatus().availableRequests).toBe(2);
    expect(limiter.getStatus().availableTokens).toBe(500);
  });

  it('rejects invalid limits', () => {
    expect(() => new RateLimiter({ maxConcurrent: 0 })).toThrow(RangeError);
    expect(() => new RateLimiter({ maxRequestsPerMinute: 1.5 })).toThrow(RangeError);
  });

  it('rejects invalid token estimates', async () => {
    const limiter = new RateLimiter();

    await expect(limiter.acquire(-1)).rejects.toThrow(RangeError);
    await expect(limiter.acquire(100001)).rejects.toThrow(RangeError);
  });

  it('records and releases a request', async () => {
    const limiter = new RateLimiter();
    await limiter.acquire(250);

    expect(limiter.getStatus()).toMatchObject({
      activeRequests: 1,
      requestsInWindow: 1,
      tokensInWindow: 250,
    });

    limiter.release();

    expect(limiter.getStatus().activeRequests).toBe(0);
  });

  it('releases the slot when the wrapped operation fails', async () => {
    const limiter = new RateLimiter();

    await expect(
      withRateLimit(limiter, async () => {
        throw new Error('operation failed');
      }),
    ).rejects.toThrow('operation failed');

    expect(limiter.getStatus().activeRequests).toBe(0);
  });

  it('returns the wrapped operation result', async () => {
    const limiter = new RateLimiter();
    const result = await withRateLimit(limiter, async () => 'success', 100);

    expect(result).toBe('success');
    expect(limiter.getStatus().activeRequests).toBe(0);
    expect(limiter.getStatus().tokensInWindow).toBe(100);
  });
});
