'use strict';

/**
 * Finds the job that this action itself is running as part of (the
 * `if: failure()` pattern -- a step in the same job that just failed).
 *
 * There's no direct "give me my own job id" API, so this lists the run's
 * jobs and matches by name (GITHUB_JOB) and, when that's ambiguous (matrix
 * builds reuse the same job name), by runner name (RUNNER_NAME) too.
 *
 * @param {import('@actions/github').GitHub} octokit
 * @param {{owner: string, repo: string}} repo
 * @param {number} runId
 * @param {string} jobName - process.env.GITHUB_JOB
 * @param {string | undefined} runnerName - process.env.RUNNER_NAME
 */
async function findCurrentJob(octokit, repo, runId, jobName, runnerName) {
  const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
    ...repo,
    run_id: runId,
    filter: 'latest',
  });

  const candidates = data.jobs.filter((j) => j.name === jobName);
  if (candidates.length <= 1) return candidates[0] || null;

  // Matrix build: multiple jobs share a name. Narrow by runner.
  return candidates.find((j) => j.runner_name === runnerName) || candidates[0];
}

/**
 * Lists every job in a run that ended in failure -- used by the
 * workflow_run trigger pattern, which runs in a separate, already-complete
 * workflow and may need to diagnose more than one failed job.
 */
async function findFailedJobs(octokit, repo, runId, jobNameFilter) {
  const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
    ...repo,
    run_id: runId,
    filter: 'latest',
  });

  return data.jobs.filter(
    (j) => j.conclusion === 'failure' && (!jobNameFilter || j.name === jobNameFilter)
  );
}

/**
 * Downloads the raw log text for one job.
 *
 * NOTE: GitHub's REST API serves this endpoint as a redirect to a
 * time-limited log archive URL. Octokit's `downloadJobLogsForWorkflowRun`
 * follows that redirect and is documented to return the raw log as
 * `response.data`; this function trusts that but falls back to treating
 * `data` as a `{ url }` pointer (fetching it manually) in case a given
 * octokit version doesn't auto-follow. This exact behavior -- especially
 * whether a job's logs are available *while that job is still running*,
 * which is exactly the situation for the `if: failure()` pattern -- is one
 * of the things this project could not verify without a real GitHub repo
 * and a real failing workflow; see README.md's Testing section.
 */
async function fetchJobLogText(octokit, repo, jobId) {
  const response = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
    ...repo,
    job_id: jobId,
  });

  if (typeof response.data === 'string') {
    return response.data;
  }

  if (response.data && typeof response.data.url === 'string') {
    const res = await fetch(response.data.url);
    if (!res.ok) {
      throw new Error(`Failed to download job log archive: HTTP ${res.status}`);
    }
    return await res.text();
  }

  throw new Error('Unexpected response shape from downloadJobLogsForWorkflowRun.');
}

module.exports = { findCurrentJob, findFailedJobs, fetchJobLogText };
