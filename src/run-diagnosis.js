'use strict';

const { spawn } = require('node:child_process');

/**
 * Shells out to the `whyfail` CLI to get a diagnosis -- this is the *only*
 * place diagnosis logic is invoked from. The action never talks to the
 * diagnosis API or an LLM directly, so there is nothing here to keep in
 * sync with that pipeline as it evolves.
 *
 * The log is piped over stdin (the CLI's own piped-input mode -- the same
 * path `some-failing-command 2>&1 | npx whyfail` uses) rather than written
 * to a temp file or passed as an argument, so it's never placed on disk or
 * in a process argument list where it could leak into shell history or a
 * process listing.
 *
 * @param {string} sanitizedLog - already sanitized; see sanitize.js. This
 *   function does not sanitize -- callers must have done that first.
 * @param {{ cliCommand: string, apiUrl?: string }} options
 * @returns {Promise<{ detected_format: string, error_signal: object,
 *   cause: string, explanation: string, fix: string, commands: string[],
 *   source: 'pattern' | 'llm', pattern_id: string | null }>} the
 *   WhyDidThisFail diagnosis API's response shape.
 */
function runDiagnosis(sanitizedLog, { cliCommand, apiUrl }) {
  return new Promise((resolve, reject) => {
    const [cmd, ...baseArgs] = cliCommand.split(' ');
    const args = [...baseArgs, '--json'];
    if (apiUrl) {
      args.push('--api-url', apiUrl);
    }

    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`whyfail CLI exited with code ${code}: ${stderr.trim() || '(no stderr)'}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`Could not parse whyfail CLI output as JSON: ${err.message}\nOutput: ${stdout}`));
      }
    });

    child.stdin.write(sanitizedLog);
    child.stdin.end();
  });
}

/**
 * Submits the (already sanitized) log to the WhyDidThisFail website's own
 * /api/diagnose route purely to get a shareable /r/{id} link for the
 * comment -- the website re-sanitizes and re-diagnoses independently
 * (harmless on already-redacted text) and persists its own record. This is
 * a second, separate diagnosis pass from runDiagnosis() above; for an
 * LLM-escalated log the website's analysis of the same input could differ
 * slightly in wording from what's shown in the comment. Documented as a
 * known tradeoff in README.md rather than silently accepted.
 *
 * Returns null (and never throws) if websiteUrl isn't configured, or if
 * the submission fails for any reason -- a missing share link should never
 * be the reason the whole diagnosis comment doesn't get posted.
 *
 * @param {string} sanitizedLog
 * @param {string | undefined} websiteUrl
 * @returns {Promise<string | null>}
 */
async function getShareUrl(sanitizedLog, websiteUrl) {
  if (!websiteUrl) return null;

  const base = websiteUrl.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/api/diagnose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ log: sanitizedLog }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.id ? `${base}/r/${data.id}` : null;
  } catch {
    return null;
  }
}

module.exports = { runDiagnosis, getShareUrl };
