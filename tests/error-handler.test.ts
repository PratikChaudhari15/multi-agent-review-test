import { describe, it, expect, vi } from 'vitest';
import {
  ReviewError,
  ErrorCodes,
  withRetry,
  withTimeout,
  isReviewError,
  formatError,
} from '../src/utils/error-handler';

describe('Error handler', () => {
  it('identifies ReviewError instances', () => {
    const error = new ReviewError('Invalid config', ErrorCodes.INVALID_CONFIG);

    expect(isReviewError(error)).toBe(true);
    expect(isReviewError(new Error('ordinary error'))).toBe(false);
  });

  it('formats ReviewError with its code', () => {
    const error = new ReviewError('Review failed', ErrorCodes.AGENT_FAILED);

    expect(formatError(error)).toBe('[AGENT_FAILED] Review failed');
    expect(formatError(new Error('ordinary error'))).toBe('ordinary error');
    expect(formatError('plain failure')).toBe('plain failure');
  });

  it('returns a successful retry operation result', async () => {
    await expect(withRetry(async () => 'ok', 0)).resolves.toBe('ok');
  });

  it('retries a failed operation and succeeds', async () => {
    vi.useFakeTimers();

    let attempts = 0;
    const promise = withRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary failure');
      return 'recovered';
    }, 1, 10);

    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe('recovered');
    expect(attempts).toBe(2);

    vi.useRealTimers();
  });

  it('throws RETRY_EXHAUSTED after all attempts fail', async () => {
    await expect(
      withRetry(async () => {
        throw new Error('permanent failure');
      }, 0),
    ).rejects.toMatchObject({
      code: ErrorCodes.RETRY_EXHAUSTED,
    });
  });

  it('returns before the timeout', async () => {
    await expect(
      withTimeout(async () => 'completed', 1000),
    ).resolves.toBe('completed');
  });

  it('throws a ReviewError when an operation times out', async () => {
    vi.useFakeTimers();

    const promise = withTimeout(
      () => new Promise<string>(() => {}),
      50,
      'test timeout',
    );

    const assertion = expect(promise).rejects.toMatchObject({
      code: ErrorCodes.AGENT_TIMEOUT,
      message: 'test timeout',
    });

    await vi.advanceTimersByTimeAsync(50);
    await assertion;

    vi.useRealTimers();
  });
});
