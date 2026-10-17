import { ReviewReport } from '../types/report-types';

/**
 * Report Generator
 * Converts ReviewReport to various output formats (Markdown, HTML, JSON)
 */
export class ReportGenerator {
  /**
   * Generate a Markdown report for PR comments
   */
  generateMarkdownReport(report: ReviewReport): string {
    const { summary, recommendations, fileReviews } = report;

    const formattedRecs = recommendations.slice(0, 5).map((rec, idx) => {
      const emoji = {
        critical: '🚨',
        high: '⚠️',
        medium: '📝',
        low: '💡'
      }[rec.priority];

      return `${idx + 1}. ${emoji} **${rec.category}**: ${rec.description}
   - Files: ${rec.files.join(', ')}`;
    }).join('\n\n');

    const formattedFiles = fileReviews.map(review => {
      const { file, codeQuality, testCoverage, refactorings } = review;

      const issueList = codeQuality.issues.slice(0, 3)
        .map(i => `  - Line ${i.line}: \`${i.severity}\` ${i.description}`)
        .join('\n');

      const testList = testCoverage.untestedPaths.slice(0, 2)
        .map(p => `  - \`${p.location}\` (${p.priority} priority)`)
        .join('\n');

      const refactorList = refactorings.suggestions.slice(0, 2)
        .map(s => `  - **${s.type}**: ${s.description}`)
        .join('\n');

      return `### 📄 \`${file}\`

**Quality Score:** ${codeQuality.overallScore}/100 | **Coverage:** ~${testCoverage.coverageEstimate}%

#### Issues (${codeQuality.issues.length})
${issueList || '  None found'}
${codeQuality.issues.length > 3 ? `\n  *...and ${codeQuality.issues.length - 3} more*` : ''}

#### Test Gaps (${testCoverage.untestedPaths.length})
${testList || '  None found'}
${testCoverage.untestedPaths.length > 2 ? `\n  *...and ${testCoverage.untestedPaths.length - 2} more*` : ''}

#### Refactoring Opportunities (${refactorings.suggestions.length})
${refactorList || '  None found'}
${refactorings.suggestions.length > 2 ? `\n  *...and ${refactorings.suggestions.length - 2} more*` : ''}`;
    }).join('\n\n---\n\n');

    return `# 🔍 Code Review Report

## Summary

| Metric | Value |
|--------|-------|
| **Overall Score** | ${summary.overallScore}/100 |
| **Files Reviewed** | ${summary.totalFiles} |
| **Critical Issues** | ${summary.criticalIssues} |
| **High Priority Tests** | ${summary.highPriorityTests} |
| **Refactoring Opportunities** | ${summary.refactoringOpportunities} |

## 🎯 Top Recommendations

${formattedRecs || 'No recommendations at this time.'}

## 📁 File Details

${formattedFiles}

---

*Generated at ${report.metadata.analyzedAt} • Duration: ${report.metadata.duration}ms*
`;
  }

  /**
   * Generate an HTML report for web display
   */

  generateHTMLReport(report: ReviewReport): string {
    const { summary, recommendations, metadata, fileReviews } = report;

    const escapeHtml = (value: unknown): string =>
      String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const recList = recommendations.slice(0, 5).map((r) => `
      <li class="rec-${escapeHtml(r.priority)}">
        <strong>[${escapeHtml(r.priority.toUpperCase())}] ${escapeHtml(r.category)}</strong>:
        ${escapeHtml(r.description)}
        <br><small>Files: ${escapeHtml(r.files.join(', '))}</small>
      </li>
    `).join('');

    const fileSections = fileReviews.map((review) => {
      const quality = review.codeQuality;
      const coverage = review.testCoverage;
      const refactoring = review.refactorings;

      const issues = quality.issues.map((issue) => `
        <li><strong>Line ${escapeHtml(issue.line)} — ${escapeHtml(issue.severity)}</strong>:
          ${escapeHtml(issue.description)}
          <br><small>Suggestion: ${escapeHtml(issue.suggestion)}</small>
        </li>
      `).join('');

      const testGaps = coverage.untestedPaths.map((gap) => `
        <li><strong>${escapeHtml(gap.priority)} — ${escapeHtml(gap.location)}</strong>:
          ${escapeHtml(gap.reasoning)}
          <br><small>Suggested test: ${escapeHtml(gap.suggestedTest)}</small>
        </li>
      `).join('');

      const suggestions = refactoring.suggestions.map((item) => `
        <li><strong>${escapeHtml(item.type)} — ${escapeHtml(item.impact)}</strong>:
          ${escapeHtml(item.description)}
          <br><small>Benefit: ${escapeHtml(item.benefits)}</small>
        </li>
      `).join('');

      return `
        <section class="file-review">
          <h2>${escapeHtml(review.file)}</h2>
          <p>Quality score: ${quality.overallScore}/100 |
             Estimated coverage: ${coverage.coverageEstimate}% |
             Has tests: ${coverage.hasTests ? 'Yes' : 'No'}</p>
          <p>${escapeHtml(quality.summary)}</p>
          <h3>Code quality issues (${quality.issues.length})</h3>
          <ul>${issues || '<li>No issues reported.</li>'}</ul>
          <h3>Test gaps (${coverage.untestedPaths.length})</h3>
          <ul>${testGaps || '<li>No test gaps reported.</li>'}</ul>
          <h3>Refactoring suggestions (${refactoring.suggestions.length})</h3>
          <ul>${suggestions || '<li>No refactoring suggestions reported.</li>'}</ul>
        </section>
      `;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Code Review Report</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 1000px;
      margin: 0 auto; padding: 24px; background: #f8f9fa; color: #212529; }
    .summary, .file-review { background: white; padding: 20px;
      margin: 20px 0; border-radius: 8px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; }
    .metric { text-align: center; }
    .metric-value { font-size: 1.8em; font-weight: bold; }
    .rec-critical { border-left: 4px solid #e74c3c; }
    .rec-high { border-left: 4px solid #f39c12; }
    .rec-medium { border-left: 4px solid #3498db; }
    .rec-low { border-left: 4px solid #27ae60; }
    li { margin: 8px 0; padding: 8px; overflow-wrap: anywhere; }
    small { color: #555; }
  </style>
</head>
<body>
  <h1>Code Review Report</h1>
  <div class="summary">
    <div class="metric"><div class="metric-value">${summary.overallScore}</div>Overall score / 100</div>
    <div class="metric"><div class="metric-value">${summary.totalFiles}</div>Files reviewed</div>
    <div class="metric"><div class="metric-value">${summary.criticalIssues}</div>Critical issues</div>
    <div class="metric"><div class="metric-value">${summary.highPriorityTests}</div>High-priority tests</div>
    <div class="metric"><div class="metric-value">${summary.refactoringOpportunities}</div>Refactoring opportunities</div>
  </div>

  <h2>Top recommendations</h2>
  <ul>${recList || '<li>No recommendations reported.</li>'}</ul>

  <h2>File reviews</h2>
  ${fileSections || '<p>No file reviews available.</p>'}

  <footer>Generated at ${escapeHtml(metadata.analyzedAt)} · Duration: ${metadata.duration} ms</footer>
</body>
</html>`;
  }

  /**
   * Generate formatted JSON report
   */
  generateJSONReport(report: ReviewReport): string {
    return JSON.stringify(report, null, 2);
  }
}
