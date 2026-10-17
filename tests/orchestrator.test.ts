
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}));

import { CodeReviewOrchestrator } from '../src/orchestrator';
import { RateLimiter } from '../src/utils/rate-limiter';
import { ErrorCodes, ReviewError } from '../src/utils/error-handler';
import { ReviewReportSchema } from '../src/types/report-types';
import { ReportGenerator } from '../src/utils/report-generator';

function createValidReport() {
  return {
    pullRequest: { owner: 'owner', repo: 'repo', number: 1 },
    fileReviews: [
      {
        file: 'src/example.ts',
        codeQuality: {
          file: 'src/example.ts',
          issues: [],
          overallScore: 90,
          summary: 'No significant quality issues found.',
        },
        testCoverage: {
          file: 'src/example.ts',
          hasTests: true,
          testFiles: ['tests/example.test.ts'],
          untestedPaths: [],
          coverageEstimate: 90,
          summary: 'Core behavior is covered.',
        },
        refactorings: {
          file: 'src/example.ts',
          suggestions: [],
          summary: 'No refactoring required.',
        },
      },
    ],
    summary: {
      totalFiles: 1,
      overallScore: 90,
      criticalIssues: 0,
      highPriorityTests: 0,
      refactoringOpportunities: 0,
    },
    recommendations: [],
    metadata: {
      analyzedAt: new Date().toISOString(),
      duration: 1,
      agentVersions: {
        'code-quality-analyzer': 'test',
        'test-coverage-analyzer': 'test',
        'refactoring-suggester': 'test',
      },
    },
  };
}

function mockSuccessfulQuery(report = createValidReport()) {
  queryMock.mockReturnValue(
    (async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        structured_output: report,
      };
    })(),
  );
}

describe('CodeReviewOrchestrator', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  describe('Configuration', () => {
    it('initializes with default options', () => {
      expect(() => new CodeReviewOrchestrator()).not.toThrow();
    });

    it('accepts a custom rate limiter and timeout', () => {
      const rateLimiter = new RateLimiter({
        maxRequestsPerMinute: 2,
        maxTokensPerMinute: 1000,
        maxConcurrent: 1,
      });

      expect(
        () => new CodeReviewOrchestrator({
          rateLimiter,
          timeoutMs: 5000,
          maxRetries: 0,
        }),
      ).not.toThrow();
    });
  });

  describe('reviewPullRequest', () => {
    it('rejects invalid pull request arguments without calling the SDK', async () => {
      const orchestrator = new CodeReviewOrchestrator({ maxRetries: 0 });

      await expect(
        orchestrator.reviewPullRequest('', 'repo', 1),
      ).rejects.toMatchObject({
        code: ErrorCodes.INVALID_CONFIG,
      });

      expect(queryMock).not.toHaveBeenCalled();
    });

    it('returns a valid report from structured SDK output', async () => {
      mockSuccessfulQuery();
      const orchestrator = new CodeReviewOrchestrator({ maxRetries: 0 });

      const report = await orchestrator.reviewPullRequest('owner', 'repo', 1);

      expect(ReviewReportSchema.safeParse(report).success).toBe(true);
      expect(report.fileReviews).toHaveLength(1);
      expect(report.metadata.duration).toBeGreaterThanOrEqual(0);
      expect(queryMock).toHaveBeenCalledTimes(1);
    });

    it('rejects unsuccessful SDK results', async () => {
      queryMock.mockReturnValue(
        (async function* () {
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            errors: ['mock failure'],
          };
        })(),
      );

      const orchestrator = new CodeReviewOrchestrator({ maxRetries: 0 });

      await expect(
        orchestrator.reviewPullRequest('owner', 'repo', 1),
      ).rejects.toBeInstanceOf(ReviewError);
    });

    it('rejects reports with no file reviews', async () => {
      mockSuccessfulQuery({
        ...createValidReport(),
        fileReviews: [],
      });

      const orchestrator = new CodeReviewOrchestrator({ maxRetries: 0 });

      await expect(
        orchestrator.reviewPullRequest('owner', 'repo', 1),
      ).rejects.toMatchObject({
        code: ErrorCodes.RETRY_EXHAUSTED,
      });
    });

    it('rejects malformed structured output', async () => {
      mockSuccessfulQuery({ invalid: true });

      const orchestrator = new CodeReviewOrchestrator({ maxRetries: 0 });

      await expect(
        orchestrator.reviewPullRequest('owner', 'repo', 1),
      ).rejects.toThrow();
    });
  });

  it('rejects empty file reviews at schema level', () => {
    const report = createValidReport();
    const result = ReviewReportSchema.safeParse({
      ...report,
      fileReviews: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-positive pull request numbers at schema level', () => {
    const report = createValidReport();
    const result = ReviewReportSchema.safeParse({
      ...report,
      pullRequest: { ...report.pullRequest, number: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a summary totalFiles count that differs from fileReviews', () => {
    const report = createValidReport();
    const result = ReviewReportSchema.safeParse({
      ...report,
      summary: { ...report.summary, totalFiles: 2 },
    });
    expect(result.success).toBe(false);
  });

  it('offline mocked workflow generates all report formats', async () => {
    mockSuccessfulQuery();
    const orchestrator = new CodeReviewOrchestrator({ maxRetries: 0 });
    const report = await orchestrator.reviewPullRequest('owner', 'repo', 1);
    const generator = new ReportGenerator();

    const markdown = generator.generateMarkdownReport(report);
    const html = generator.generateHTMLReport(report);
    const json = generator.generateJSONReport(report);

    expect(markdown).toContain('Code Review Report');
    expect(html).toContain('<!DOCTYPE html>');
    expect(JSON.parse(json).pullRequest).toEqual({
      owner: 'owner',
      repo: 'repo',
      number: 1,
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });


describe('Integration', () => {
  it('completes a mocked PR review and validates all report formats', async () => {
    const expectedReport = createValidReport();
    mockSuccessfulQuery(expectedReport);

    const orchestrator = new CodeReviewOrchestrator({ maxRetries: 0 });
    const report = await orchestrator.reviewPullRequest('owner', 'repo', 1);
    const generator = new ReportGenerator();

    // Verify the reviewed pull request.
    expect(report.pullRequest).toEqual({
      owner: 'owner',
      repo: 'repo',
      number: 1,
    });

    // Verify report content and all three output formats.
    expect(report.fileReviews).toHaveLength(1);

    const json = JSON.parse(generator.generateJSONReport(report));
    const markdown = generator.generateMarkdownReport(report);
    const html = generator.generateHTMLReport(report);

    expect(json.pullRequest).toEqual(report.pullRequest);
    expect(json.fileReviews[0].file).toBe('src/example.ts');
    expect(markdown).toContain('Code Review Report');
    expect(markdown).toContain('src/example.ts');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('src/example.ts');

    // The SDK is mocked; no live API request is made.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});});
