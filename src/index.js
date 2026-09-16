'use strict';

const core = require('@actions/core');
const github = require('@actions/github');

const { sanitizeLog } = require('./sanitize');
const { findCurrentJob, findFailedJobs, fetchJobLogText } = require('./fetch-logs');
const { runDiagnosis, getShareUrl } = require('./run-diagnosis');
const { buildCommentBody, postComment } = require('./post-comment');
const { describeError } = require('./errors');

/**
 * Diagnoses a single failed job and posts a comment for it. Shared by both
 * trigger patterns (if: failure() has exactly one job to handle; workflow_run
 * may have several).
 *
 * @param {boolean} isSelfFetch - true for the if: failure() pattern (fetching
 *   the *current*, still-executing job's own logs). Confirmed against GitHub's
 *   real API behavior (see README.md's "Why if: failure() doesn't work"
 *   section) that this always 404s: a job can only reach status "completed"
 *   after every one of its own steps finishes, including this diagnosis step
 *   itself, so the job-logs endpoint necessarily still sees it as in-progress.
 *   Used only to turn a resulting 404 into an explanation instead of a bare
 *   status code.
 */
async function diagnoseAndPostForJob(octokit, repo, job, sha, options, isSelfFetch = false) {
  core.info(`Fetching logs for job "${job.name}" (id ${job.id})...`);

  let rawLog;
  try {
    rawLog = await fetchJobLogText(octokit, repo, job.id);
  } catch (err) {
    if (isSelfFetch && err && err.status === 404) {
      throw new Error(
        `Could not fetch this job's own logs (${describeError(err)}). This is a confirmed GitHub API ` +
          'limitation, not a bug in this action: job logs are unavailable via the API until the job ' +
          'reaches "completed" status, and a step running with "if: failure()" is, by definition, still ' +
          'part of a job that has not completed yet (it can\'t, until this very step finishes). Use the ' +
          'workflow_run trigger pattern instead -- see README.md.'
      );
    }
    throw err;
  }

  const { sanitized, redactionCount } = sanitizeLog(rawLog);
  if (redactionCount > 0) {
    core.info(`Sanitized ${redactionCount} possible secret(s) out of the fetched log before diagnosis.`);
  }

  const diagnosis = await runDiagnosis(sanitized, {
    cliCommand: options.cliCommand,
    apiUrl: options.apiUrl,
  });

  const shareUrl = await getShareUrl(sanitized, options.websiteUrl);

  const body = buildCommentBody(job, diagnosis, shareUrl);
  const result = await postComment(octokit, repo, sha, body);

  core.info(
    `Posted diagnosis for "${job.name}" as a ${result.target} comment` +
      (result.number ? ` (PR #${result.number}).` : ` (${result.sha}).`)
  );
  return result;
}

/**
 * @param {{ octokit?: object, context?: object }} [overrides] - injection
 *   point for tests (see test/simulate.js): pass a fake octokit/context to
 *   run the exact same orchestration logic without hitting the real GitHub
 *   API. Production use (the `require.main === module` call below) passes
 *   nothing, and gets the real @actions/github client + context.
 */
async function run(overrides = {}) {
  try {
    const token = core.getInput('github-token', { required: true });
    const apiUrl = core.getInput('whyfail-api-url') || undefined;
    const websiteUrl = core.getInput('website-url') || undefined;
    const cliCommand = core.getInput('whyfail-cli') || 'npx --yes whyfail@latest';
    const jobNameFilter = core.getInput('job-name') || undefined;

    const octokit = overrides.octokit || github.getOctokit(token);
    const context = overrides.context || github.context;
    const repo = context.repo;
    const options = { apiUrl, websiteUrl, cliCommand };

    let posted = false;

    if (context.eventName === 'workflow_run') {
      // Separate watcher workflow: the target run has already fully
      // completed, so there may be several failed jobs to diagnose.
      const run = context.payload.workflow_run;
      const failedJobs = await findFailedJobs(octokit, repo, run.id, jobNameFilter);

      if (failedJobs.length === 0) {
        core.info('No failed jobs found on the watched workflow run.');
      }

      for (const job of failedJobs) {
        await diagnoseAndPostForJob(octokit, repo, job, run.head_sha, options);
        posted = true;
      }
    } else {
      // Self-fetch pattern: this step runs with `if: failure()` inside the
      // same job that just failed. Confirmed unreliable -- see
      // diagnoseAndPostForJob's isSelfFetch handling and README.md.
      // Kept working (rather than removed) in case a specific setup somehow
      // avoids the limitation, but no longer the documented/recommended
      // usage; workflow_run is.
      const jobName = process.env.GITHUB_JOB;
      const job = await findCurrentJob(octokit, repo, context.runId, jobName, process.env.RUNNER_NAME);

      if (!job) {
        core.setFailed(`Could not find the current job ("${jobName}") in this workflow run.`);
        return;
      }

      await diagnoseAndPostForJob(octokit, repo, job, context.sha, options, /* isSelfFetch */ true);
      posted = true;
    }

    core.setOutput('posted', String(posted));
  } catch (err) {
    core.setFailed(describeError(err));
  }
}

module.exports = { run, diagnoseAndPostForJob, describeError };

if (require.main === module) {
  run();
}
