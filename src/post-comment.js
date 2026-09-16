'use strict';

const MARKER = '<!-- whydidthisfail-action -->';

/**
 * Finds an open PR associated with the given commit, if any. Checked
 * before falling back to a commit comment, so a failure on a PR branch
 * gets the comment where its author will actually see it.
 */
async function findAssociatedPr(octokit, repo, sha) {
  const { data } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
    ...repo,
    commit_sha: sha,
  });
  const open = data.find((pr) => pr.state === 'open');
  return open ? open.number : null;
}

/**
 * Formats the diagnosis into a comment body: cause/explanation/fix, exact
 * commands as a copy-pasteable code block, a clear pattern-matched-vs-AI
 * badge (same distinction the CLI and website show), and a link to the
 * full shareable result page when one was created.
 *
 * @param {{ name: string }} job
 * @param {{ detected_format: string, error_signal: object, cause: string,
 *   explanation: string, fix: string, commands: string[],
 *   source: 'pattern' | 'llm', pattern_id: string | null }} diagnosis -
 *   the WhyDidThisFail diagnosis API's response shape.
 * @param {string | null} shareUrl
 */
function buildCommentBody(job, diagnosis, shareUrl) {
  const badge =
    diagnosis.source === 'pattern'
      ? `✓ **Known issue** — pattern matched${diagnosis.pattern_id ? ` (\`${diagnosis.pattern_id}\`)` : ''}`
      : "✨ **AI analysis** — no known pattern matched, this is Claude's best-effort diagnosis";

  const signal = diagnosis.error_signal || {};
  const errorLine = [signal.error_type, signal.message].filter(Boolean).join(': ');
  // Capped well below the website's own display length -- a PR/commit
  // comment should stay skimmable, and the share link covers the rest.
  const contextSnippet = signal.context ? signal.context.slice(0, 600) : null;

  const lines = [
    MARKER,
    `### 🔍 WhyDidThisFail? diagnosed \`${job.name}\``,
    '',
    badge,
    '',
    `**Format:** \`${diagnosis.detected_format}\``,
  ];

  if (errorLine || contextSnippet) {
    lines.push('', '**Error signal**');
    if (errorLine) lines.push(errorLine);
    if (signal.file) lines.push(`${signal.file}${signal.line ? `:${signal.line}` : ''}`);
    if (contextSnippet) lines.push('```', contextSnippet, '```');
  }

  lines.push(
    '',
    '**Cause**',
    diagnosis.cause,
    '',
    '**Explanation**',
    diagnosis.explanation,
    '',
    '**Fix**',
    diagnosis.fix
  );

  if (diagnosis.commands && diagnosis.commands.length > 0) {
    lines.push('', '**Commands**', '```bash', ...diagnosis.commands, '```');
  }

  if (shareUrl) {
    lines.push('', `[View the full diagnosis →](${shareUrl})`);
  }

  // Points at this Action's own repo, not process.env.GITHUB_REPOSITORY --
  // that env var is the *consumer's* repo (wherever this workflow runs),
  // which almost never has this README at all. An earlier version of this
  // link used GITHUB_REPOSITORY and only happened to work for the one
  // self-referencing test workflow that used `uses: ./action` from within
  // this action's own source repo; for every real external user it would
  // have built a link into their own repo pointing at a file that isn't
  // there.
  const sanitizationNote = 'Log content was sanitized before diagnosis and before any external submission.';
  const readmeUrl = 'https://github.com/adewale-codes/whydidthisfail-action#sanitization';
  lines.push('', `<sub>${sanitizationNote} See [README.md](${readmeUrl}).</sub>`);

  return lines.join('\n');
}

/**
 * Posts the comment: on the associated PR if one exists, otherwise as a
 * commit comment on the failing sha.
 *
 * @returns {Promise<{ posted: true, target: 'pull_request' | 'commit', number?: number, sha?: string }>}
 */
async function postComment(octokit, repo, sha, body) {
  const prNumber = await findAssociatedPr(octokit, repo, sha);

  if (prNumber) {
    await octokit.rest.issues.createComment({
      ...repo,
      issue_number: prNumber,
      body,
    });
    return { posted: true, target: 'pull_request', number: prNumber };
  }

  await octokit.rest.repos.createCommitComment({
    ...repo,
    commit_sha: sha,
    body,
  });
  return { posted: true, target: 'commit', sha };
}

module.exports = { findAssociatedPr, buildCommentBody, postComment, MARKER };
