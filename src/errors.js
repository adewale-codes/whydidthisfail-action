'use strict';

/**
 * Builds a detailed, diagnosable description of a caught error -- in
 * particular an Octokit RequestError, whose bare `.message` is frequently
 * unhelpful (GitHub's API sometimes returns an error body Octokit can't
 * extract a real message from, and it falls back to the literal string
 * "Unknown error"). Surfacing `.status` and the raw response body is the
 * difference between an undiagnosable failure and an actionable one.
 */
function describeError(err) {
  if (!(err instanceof Error)) return String(err);

  const parts = [err.message];
  if (typeof err.status === 'number') {
    parts.push(`status=${err.status}`);
  }
  const responseData = err.response && err.response.data;
  if (responseData !== undefined) {
    const detail = typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
    parts.push(`response=${detail.slice(0, 500)}`);
  }
  return parts.join(' | ');
}

module.exports = { describeError };
