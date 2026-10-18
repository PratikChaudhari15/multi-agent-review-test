
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  ReviewReport,
  ReviewReportSchema,
  ReviewReportJSONSchema,
} from './types/report-types';
import { mcpServersConfig } from './config/mcp.config';
import {
  codeQualityAnalyzer,
  testCoverageAnalyzer,
  refactoringSuggester,
} from './agents';
import { buildOrchestratorPrompt } from './prompts';
import {
  RateLimiter,
  DEFAULT_RATE_LIMITS,
  withRateLimit,
} from './utils/rate-limiter';
import {
  ReviewError,
  ErrorCodes,
  withRetry,
  withTimeout,
} from './utils/error-handler';

export interface OrchestratorOptions {
  rateLimiter?: RateLimiter;
  timeoutMs?: number;
  maxRetries?: number;
  maxTurns?: number;
}

export class CodeReviewOrchestrator {
  private readonly rateLimiter: RateLimiter;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxTurns: number;

  constructor(options: OrchestratorOptions = {}) {
    this.rateLimiter =
      options.rateLimiter ?? new RateLimiter(DEFAULT_RATE_LIMITS);
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.maxRetries = options.maxRetries ?? 0;
    this.maxTurns = options.maxTurns ?? 20;
  }

  async reviewPullRequest(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<ReviewReport> {
    if (!owner.trim() || !repo.trim() ||
        !Number.isInteger(prNumber) || prNumber < 1) {
      throw new ReviewError(
        'A valid repository owner, repository name, and pull request number are required.',
        ErrorCodes.INVALID_CONFIG
      );
    }

    const startedAt = Date.now();

    const result = await withRetry(
      () =>
        withRateLimit(
          this.rateLimiter,
          async () => {
            const abortController = new AbortController();

            return withTimeout(
              async () => {
                let structuredOutput: unknown;

                const response = query({
                  prompt: buildOrchestratorPrompt(owner, repo, prNumber),
                  options: {
                    abortController,
                    model: process.env.ANTHROPIC_MODEL,
                    maxTurns: this.maxTurns,
                    maxBudgetUsd: 1.0,
                    agents: {
                      'code-quality-analyzer': codeQualityAnalyzer,
                      'test-coverage-analyzer': testCoverageAnalyzer,
                      'refactoring-suggester': refactoringSuggester,
                    },
                    mcpServers: mcpServersConfig,
                    allowedTools: [
                      'Task',
                      'Skill',
                      'Read',
                      'Grep',
                      'Glob',
                      'mcp__github__get_pull_request',
                      'mcp__github__get_pull_request_files',
                      'mcp__github__get_file_contents',
                      'mcp__github__search_code',
                      'mcp__eslint__*',
                    ],
                    permissionMode: 'dontAsk',
                    settingSources: ['project'],
                    stderr: (data: string) => {
                      process.stderr.write(`[Claude SDK] ${data}`);
                    },
                    outputFormat: {
                      type: 'json_schema',
                      schema: ReviewReportJSONSchema,
                    },
                  },
                });

                for await (const message of response) {
                  if (message.type === 'system' && message.subtype === 'init') {
                    console.log('[MCP status]', JSON.stringify(message.mcp_servers));
                    console.log('[SDK tools]', message.tools.join(', '));
                    continue;
                  }

                  if (message.type !== 'result') continue;

                  console.log('[SDK cost USD]', message.total_cost_usd);
                  const permissionDenials = message.permission_denials ?? [];

                  if (permissionDenials.length > 0) {
                    console.error(
                      '[SDK permission denials]',
                      JSON.stringify(permissionDenials)
                    );
                  }

                  if (message.subtype !== 'success') {
                    const details =
                      message.errors?.join('; ') || 'No SDK error details provided.';

                    throw new ReviewError(
                      `Review execution failed (${message.subtype}): ${details}`,
                      ErrorCodes.AGENT_FAILED,
                      {
                        subtype: message.subtype,
                        permissionDenials: message.permission_denials,
                        totalCostUsd: message.total_cost_usd,
                      }
                    );
                  }

                  structuredOutput = message.structured_output;
                }

                if (structuredOutput === undefined) {
                  throw new ReviewError(
                    'The SDK did not return structured report output.',
                    ErrorCodes.STRUCTURED_OUTPUT_FAILED
                  );
                }

                const report = ReviewReportSchema.parse(structuredOutput);

                if (report.fileReviews.length === 0) {
                  throw new ReviewError(
                    'Review produced zero file reviews. Check GitHub MCP access and agent execution.',
                    ErrorCodes.AGENT_FAILED
                  );
                }

                return report;
              },
              this.timeoutMs,
              'Pull request review timed out',
              () => abortController.abort()
            );
          },
          5000
        ),
      this.maxRetries,
      1000
    );
    return ReviewReportSchema.parse({
      ...result,
      metadata: {
        ...result.metadata,
        duration: Date.now() - startedAt,
      },
    });
  }
}
