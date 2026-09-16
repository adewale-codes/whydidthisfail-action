# WhyDidThisFail? Action

**Automatically diagnoses your failed CI runs and posts the cause,
explanation, and fix as a comment -- zero copy-pasting, zero manual steps
after you add it once.**

This is the lowest-friction way to use [WhyDidThisFail?](https://github.com/adewale-codes/WhyDidThisFail):
its website and CLI both still need someone to paste a log in; this needs
nothing. It does not implement any diagnosis logic itself -- it fetches the
failed job's log, sanitizes it, shells out to the [`whyfail`](https://www.npmjs.com/package/whyfail)
CLI (which calls the WhyDidThisFail diagnosis API), and posts the result.
See "Sanitization" below for why the sanitizing step matters even though
the CLI is reused.

## Usage: add a watcher workflow (the only pattern confirmed to work)

Add one new workflow file -- no edits to any existing workflow needed. It
watches for your other workflows completing, and diagnoses any that failed:

```yaml
# .github/workflows/diagnose-failures.yml
name: Diagnose failures
on:
  workflow_run:
    workflows: [CI]        # <- replace with your actual workflow name(s),
    types: [completed]     #    e.g. [CI, "Build and Test"] -- GitHub's
                            #    workflow_run trigger needs exact names,
                            #    there's no wildcard for "all workflows"

jobs:
  diagnose:
    if: github.event.workflow_run.conclusion == 'failure'
    runs-on: ubuntu-latest
    steps:
      - uses: adewale-codes/whydidthisfail-action@v1
        with:
          website-url: https://whyfail.example.com   # optional, for a shareable link
```

The only required edit is `workflows:` -- point it at the name(s) of the
workflow(s) you want diagnosed (the `name:` field of that workflow file,
not its filename). Everything else above works as-is.

This correctly handles a run with more than one failed job (each gets its
own comment), and was confirmed working end-to-end against a real repo,
unattended: a real failure, real logs fetched from the completed run, a
real diagnosis posted as a commit comment, with no manual steps.

## Usage (do NOT use: `if: failure()` self-fetch)

An earlier version of this Action recommended adding a step with
`if: failure()` directly inside the job you want diagnosed, so it could
fetch and diagnose its own job's logs with no second workflow file. **This
does not work, and can't be made to work** -- confirmed against a real
GitHub repo and GitHub's actual API behavior, not assumed. See "Why
`if: failure()` doesn't work" below before considering it. The code path
still exists (`fetch-logs.js`'s `findCurrentJob`) but is not a supported or
documented usage; it will reliably fail with a 404, now with a clear
explanation instead of a bare `Unknown error`.

### Why `if: failure()` doesn't work

Fetching job logs via `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs`
(`downloadJobLogsForWorkflowRun` in Octokit) requires the job to have
reached `completed` status. GitHub's own docs don't state this explicitly,
but real-world reports do: the API returns a plain `404` while a job is
still `in_progress` ([community report, confirmed 404-while-running,
resolves after completion](https://github.com/orgs/community/discussions/154834)).

That alone would just make this *flaky*. What makes it a hard, unconditional
limitation is a step further: a job can only reach `completed` status after
*every one of its own steps finishes* -- including a diagnosis step running
with `if: failure()` inside that same job. That step is, by definition,
still executing while the job is `in_progress`. So the job it wants its own
logs for can never have reached `completed` yet, at the exact moment it
asks. This isn't timing-sensitive or occasionally unlucky; it fails every
time, for every job, unconditionally, as a direct consequence of how "job
completion" is defined -- not something a retry or a delay works around.

`workflow_run` fires on a *different* run's completion (the one you're
watching, not the watcher's own run), so by the time the watcher job asks
for that run's job logs, they're genuinely finalized. That's the entire
reason it's the primary pattern.

## Inputs

| Input | Required | Default | Purpose |
| --- | --- | --- | --- |
| `github-token` | no | `${{ github.token }}` | Used to fetch job logs and post comments. |
| `whyfail-api-url` | no | (CLI's own default) | Diagnosis API base URL, if not the public default. |
| `website-url` | no | _(unset)_ | Base URL of the WhyDidThisFail website, used to create a shareable result-page link in the comment. When unset, the comment is posted without one -- this never blocks posting the diagnosis itself. |
| `whyfail-cli` | no | `npx --yes whyfail@latest` | How to invoke the `whyfail` CLI. Override for local testing against an unpublished/local CLI build, e.g. `node /path/to/cli/bin/cli.js`. |
| `job-name` | no | _(unset, = all)_ | `workflow_run` pattern only: restrict diagnosis to a specific job name. |

## Outputs

| Output | Description |
| --- | --- |
| `posted` | `"true"` if at least one comment was posted, `"false"` otherwise. |

## Permissions

The default `GITHUB_TOKEN` needs:

```yaml
permissions:
  contents: write        # read for checkout; write is needed for the commit-comment fallback
  actions: read          # to fetch job logs
  pull-requests: write   # to post PR comments
  issues: write          # PR comments are posted via the issues API
```

If you don't set `permissions:` explicitly, most repos' defaults already
cover this; private repos with restrictive default token permissions may
need to add the block above.

## Sanitization

Real CI logs frequently contain real secrets by accident. This is worth
stating explicitly rather than assuming it's inherited for free: **neither
the `whyfail` CLI nor the diagnosis API it calls sanitize anything** -- the
CLI is a thin client by design, and the API's job is diagnosis, not data
hygiene. Sanitization was originally built as a step the WhyDidThisFail
website's own submission route runs before persisting anything.

This action does not go through the website's submission route to get its
primary diagnosis (it shells out to the CLI directly, so it doesn't
duplicate diagnosis logic). So it carries its own copy of that same
sanitization rule set (`src/sanitize.js` -- a straight port of the
website's sanitizer, kept in sync deliberately) and runs it on every
fetched log **before** that log touches the CLI, the diagnosis API, or (if
`website-url` is set) the website submission used to build the share link.
Nothing fetched by this action reaches any of those three places
unsanitized.

`test/simulate.js` proves this isn't just an assumption: it feeds a log
containing a fake AWS key and a fake token through the real pipeline (real
sanitizer, real CLI subprocess, real diagnosis API) and asserts the posted
comment's error-signal snippet shows `[REDACTED]`, not the secret.

## Testing

GitHub Actions' own APIs (job logs, PR/commit comments) can't be exercised
against a real repo from a local sandbox. `test/simulate.js` mocks the
octokit client (and the relevant `GITHUB_*`/`INPUT_*` env vars) and
exercises the *entire rest of the pipeline for real*: real sanitization, a
real `whyfail` CLI subprocess against the live diagnosis API, real
comment-body formatting, and the real PR-vs-commit-comment routing
decision.

Run it yourself:

```bash
npm install
node test/simulate.js
```

If you change anything in `src/`, rebuild the committed bundle before
committing that change too -- `action.yml` runs `dist/index.js`, not
`src/index.js` directly, so an unrebuilt `dist/` silently ships stale code:

```bash
npx @vercel/ncc build src/index.js -o dist
```

**What this proves:**
- The action correctly identifies its own job from a run's job list (by
  name, and by runner name when a matrix build reuses a job name).
- A fetched log is sanitized before it reaches the CLI -- verified by
  inspecting the actual diagnosis response's error-signal content, not
  just the final comment text.
- The CLI subprocess integration genuinely works end-to-end against the
  live diagnosis API, for both a pattern-matched and an LLM-escalated
  result.
- Comment routing: PR comment when a PR is associated with the commit,
  commit comment otherwise.
- The `workflow_run` pattern correctly uses the *watched* run's id, not
  its own watcher run's id.
- The website share-link integration builds the right URL on success and
  degrades to no link (never a crash) on failure or when unconfigured.
- A 404 from `downloadJobLogsForWorkflowRun` during self-fetch gets turned
  into the "confirmed GitHub API limitation, use workflow_run" explanation,
  not left as a bare `Unknown error` or misapplied to the `workflow_run`
  path where a 404 would mean something else entirely.

**Confirmed against a real GitHub repo, not just simulated** (in the main
[WhyDidThisFail?](https://github.com/adewale-codes/WhyDidThisFail) repo,
using a pair of test workflows there -- a deliberately-failing target
workflow and a `workflow_run` watcher, both manual-`workflow_dispatch`-
trigger only):
- That `if: failure()` self-fetch reliably fails with a 404, not just in
  theory -- this is what prompted "Why `if: failure()` doesn't work" above.
- That the `workflow_run` pattern itself works end to end: a real failure,
  real logs fetched from the now-completed target run, a real comment
  posted, with zero manual steps.

**What real-repo testing did NOT specifically exercise** (the core
fetch/sanitize/diagnose/post path is proven; these are narrower,
lower-risk edges that just haven't come up yet):
- The exact response shape of `downloadJobLogsForWorkflowRun` on some
  other octokit/Node version combination (documented as a redirect;
  `fetch-logs.js` handles both a direct string body and a `{ url }`
  pointer -- the real test confirmed *one* of those shapes works, not
  that both paths have been exercised).
- Real `listPullRequestsAssociatedWithCommit` behavior across edge cases
  (forked PRs, multiple open PRs on one commit) -- the real test's commit
  had no associated PR, exercising the commit-comment fallback, not the
  PR-comment path, against real data.
- How the posted Markdown actually renders on github.com when viewed in a
  browser (not just the API accepting the POST).

## Publishing

`action.yml` is at this repository's root with complete metadata (`name`,
`description`, `author`, and a `branding` block -- `icon: help-circle`,
`color: purple`, both verified against GitHub's current docs as valid,
non-excluded values) and `dist/index.js` is a committed, self-contained
bundle (built via `npx @vercel/ncc build src/index.js -o dist`, every
dependency inlined -- confirmed by running it with `node_modules` removed
entirely). GitHub Marketplace requires the action metadata file at the
repo root, which is exactly where it is here -- this repository was
created specifically so that would be true, after the action originally
lived in a subdirectory of a larger monorepo where it couldn't be
auto-listed.

**Remaining manual steps, in order:**

1. Create and push a semver-tagged release (e.g. `v1.0.0`, plus a floating
   `v1` tag per GitHub's convention) -- no tags exist yet.
2. Publish via this repository's Releases page with "Publish this Action
   to the GitHub Marketplace" checked -- done through GitHub's web UI by a
   repo admin, not something scriptable.
