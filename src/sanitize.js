'use strict';

// Secret redaction -- a deliberate, faithful port of the WhyDidThisFail
// website's own sanitizer rule set to plain JS (the website is
// TypeScript/Next.js; this action runs as a standalone Node script with no
// build step, so it can't just `import` that module). Keep these two rule
// sets in sync.
//
// This exists because the Action does NOT go through the website's own
// /api/diagnose route at all when it calls the whyfail CLI directly against
// the diagnosis API -- and neither the CLI nor that API sanitize anything
// themselves (diagnosis is the API's job, not data hygiene; the CLI is a
// thin client). A real CI log can contain real secrets, so this module is
// applied to every fetched log BEFORE it touches the CLI, the diagnosis
// API, or (if configured) the website submission. See README.md's
// "Sanitization" section, and test/simulate.js for the test that proves
// this actually happens, not just assumes it.

const REDACTED = '[REDACTED]';

const RULES = [
  {
    name: 'private-key-block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => '[REDACTED PRIVATE KEY]',
  },
  {
    // postgres://user:pass@host, mongodb+srv://user:pass@host, redis://..., amqp(s)://...
    name: 'connection-string-credentials',
    pattern: /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/([^:/\s@]+):([^@/\s]+)@/gi,
    replace: (_m, scheme) => `${scheme}://${REDACTED}:${REDACTED}@`,
  },
  {
    // AWS access key IDs (all current prefixes), e.g. AKIAIOSFODNN7EXAMPLE
    name: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ABIA|ACCA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g,
    replace: () => REDACTED,
  },
  {
    name: 'openai-key',
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/g,
    replace: () => REDACTED,
  },
  {
    name: 'anthropic-key',
    pattern: /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g,
    replace: () => REDACTED,
  },
  {
    name: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replace: () => REDACTED,
  },
  {
    name: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: () => REDACTED,
  },
  {
    name: 'stripe-key',
    pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    replace: () => REDACTED,
  },
  {
    name: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
    replace: () => REDACTED,
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replace: () => REDACTED,
  },
  {
    name: 'bearer-token',
    pattern: /\bBearer\s+[A-Za-z0-9\-_.=]{10,}/gi,
    replace: () => `Bearer ${REDACTED}`,
  },
  {
    // generic key=value / key: value assignments, e.g. api_key=..., password: "...",
    // token='...', DB_PASSWORD=... -- keeps the key name visible, redacts the value.
    name: 'generic-assignment',
    pattern:
      /\b((?:[a-z0-9_]*(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?key|token|password|passwd|pwd|auth)[a-z0-9_]*))\s*[:=]\s*["']?([A-Za-z0-9\-_./+=]{6,})["']?/gi,
    replace: (_m, key) => `${key}=${REDACTED}`,
  },
];

/**
 * @param {string} input
 * @returns {{ sanitized: string, redactionCount: number, redactedKinds: string[] }}
 */
function sanitizeLog(input) {
  let text = input;
  let redactionCount = 0;
  const redactedKinds = new Set();

  for (const rule of RULES) {
    text = text.replace(rule.pattern, (...args) => {
      const match = args[0];
      const groups = args.slice(1, -2);
      redactionCount += 1;
      redactedKinds.add(rule.name);
      return rule.replace(match, ...groups);
    });
  }

  return { sanitized: text, redactionCount, redactedKinds: Array.from(redactedKinds) };
}

module.exports = { sanitizeLog, REDACTED };
