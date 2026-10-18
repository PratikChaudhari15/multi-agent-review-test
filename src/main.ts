
import * as dotenv from 'dotenv';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CodeReviewOrchestrator } from './orchestrator';
import { ReportGenerator } from './utils/report-generator';

dotenv.config();

async function main(): Promise<void> {
  const [owner, repo, prStr] = process.argv.slice(2);

  if (
    !owner?.trim() ||
    !repo?.trim() ||
    !prStr ||
    !/^[1-9]\d*$/.test(prStr)
  ) {
    console.error(
      'Usage: npm run dev -- <owner> <repo> <pr-number>'
    );
    process.exitCode = 1;
    return;
  }

  const prNumber = Number(prStr);

  if (!Number.isSafeInteger(prNumber)) {
    console.error('Error: Pull request number must be a valid positive integer.');
    process.exitCode = 1;
    return;
  }

  const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasAwsCredentials = Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY
  );

  if (hasAwsCredentials) {
    if (!process.env.AWS_REGION) {
      console.error(
        'Error: AWS_REGION is required when using AWS Bedrock authentication.'
      );
      process.exitCode = 1;
      return;
    }

    console.log('🔐 Using AWS Bedrock authentication');
  } else if (hasAnthropicKey) {
    console.log('🔐 Using Anthropic API authentication');
  } else {
    console.error(
      'Error: Configure either ANTHROPIC_API_KEY or both ' +
      'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.'
    );
    process.exitCode = 1;
    return;
  }

  if (!process.env.ANTHROPIC_MODEL?.trim()) {
    console.error(
      'Error: ANTHROPIC_MODEL must be configured in the environment.'
    );
    process.exitCode = 1;
    return;
  }

  const reportsDirectory = path.resolve(process.cwd(), 'reports');
  const filenamePrefix = `${owner}_${repo}_${prNumber}`;

  try {
    const orchestrator = new CodeReviewOrchestrator({
      timeoutMs: 600_000,
      maxTurns: 30,
    });
    const report = await orchestrator.reviewPullRequest(
      owner,
      repo,
      prNumber
    );

    if (
      report.pullRequest.owner !== owner ||
      report.pullRequest.repo !== repo ||
      report.pullRequest.number !== prNumber
    ) {
      throw new Error(
        'Report PR metadata does not match the requested pull request.'
      );
    }

    const generator = new ReportGenerator();

    const outputs = [
      {
        extension: 'json',
        content: generator.generateJSONReport(report),
      },
      {
        extension: 'md',
        content: generator.generateMarkdownReport(report),
      },
      {
        extension: 'html',
        content: generator.generateHTMLReport(report),
      },
    ];

    await mkdir(reportsDirectory, { recursive: true });

    const outputPaths = outputs.map((output) =>
      path.join(reportsDirectory, `${filenamePrefix}.${output.extension}`)
    );

    for (const outputPath of outputPaths) {
      try {
        await access(outputPath);
        throw new Error(`Report already exists; refusing to overwrite: ${outputPath}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Report already exists;')) {
          throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }

    for (const [i, output] of outputs.entries()) {
      const outputPath = outputPaths[i];
      if (!outputPath) {
        throw new Error(`Missing output path for ${output.extension} report.`);
      }

      await writeFile(outputPath, output.content, { encoding: 'utf8', flag: 'wx' });
      console.log(`Report saved: ${outputPath}`);
    }

    console.log(
      `\nReview completed for ${owner}/${repo} PR #${prNumber}.`
    );
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Review failed: ${error.message}`);

      if ('code' in error) {
        console.error('Error code:', error.code);
      }

      if ('metadata' in error && error.metadata) {
        console.error(
          'Error metadata:',
          JSON.stringify(error.metadata, null, 2)
        );
      }

      if (error.stack) {
        console.error(error.stack);
      }
    } else {
      console.error('Review failed:', String(error));
    }

    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(
    'Unexpected CLI error:',
    error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
});
