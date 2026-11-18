// The decision behind the blocking half of the NPM Audit job: given what
// `npm audit --json` said, did we learn that the production dependencies are
// clean, that they carry an advisory, or nothing at all?
//
// `npm audit` exits 1 for a real advisory AND for an advisories endpoint it
// could not reach, so the exit code alone cannot separate "you shipped a
// vulnerability" from "npmjs is down". Both were indistinguishable red X's on
// PR #1308, twice, while `npm ci` in the same job resolved every package --
// only registry.npmjs.org's advisories endpoint was failing, first with a
// timeout and then with a 503.
//
// The discriminator is POSITIVE proof that an audit ran: a report carries
// `metadata.vulnerabilities`, and an endpoint failure carries a top-level
// `error` with no `metadata` at all. Keying on the report's presence rather
// than on the error's is what makes an unrecognised failure shape safe: it
// reads as "no answer", which is retried and then fails, instead of being
// mistaken for a clean audit.
//
// Only a no-answer is retried. An advisory fails on the first attempt, because
// a retry that could swallow a real finding is worse than no retry at all.
// And a no-answer that outlasts the retries still FAILS the build: "we could
// not verify" is not "verified clean". What changes is that it now says so.
//
// A finding is accepted only through ACCEPTED_ADVISORIES below: one advisory,
// in one directory, at the exact vulnerable range it was accepted at, until a
// date. Each entry stops applying on its own, so none can outlive its reason:
//
// - the advisory's range changes (GitHub widens or closes it when a patched
//   release ships): the finding no longer matches and fails again;
// - the date passes: it fails again, and the log says the exception expired;
// - the finding disappears (the patched release is installed): the unused
//   entry fails the directory until it is removed.
//
// Exercised by scripts/npm-audit-gate.test.mjs.

/** Directories audited, in order. Each is a package root with its own lockfile. */
export const AUDIT_TARGETS = ['backend', 'frontend'];

const BLOCKING = new Set(['high', 'critical']);
/** Below the audit level. An advisory of any other severity, or none, blocks. */
const BELOW_LEVEL = new Set(['info', 'low', 'moderate']);

/**
 * Advisories the gate lets through, each a reviewed decision. Shrink-only:
 * an entry is removed when its reason ends, never extended past it.
 */
export const ACCEPTED_ADVISORIES = [
  {
    // Dependabot alert 135. No patched release exists (4.0.7 is the newest).
    // picomatch reaches the production tree only through next-intl's
    // @parcel/watcher, a dev-time file watcher not traced into the
    // standalone server, and the ReDoS needs an attacker-supplied glob; every
    // glob Monize compiles is written in code or config. Accepted in #2264.
    target: 'frontend',
    ghsa: 'GHSA-fc5q-39xc-vjpf',
    name: 'picomatch',
    range: '<=4.0.7',
    expires: '2027-01-31',
  },
];

const todayUtc = () => new Date().toISOString().slice(0, 10);

/** The exceptions that apply to `cwd` today; expired ones are logged as such. */
function liveExceptions(cwd, exceptions, today, log) {
  const live = [];
  for (const exception of exceptions) {
    if (exception.target !== cwd) continue;
    if (today > exception.expires) {
      log(
        `::error::${cwd}: the accepted advisory ${exception.ghsa} (${exception.name}) expired on ${exception.expires}; fix it or review the exception again`,
      );
      continue;
    }
    live.push(exception);
  }
  return live;
}

function matching(advisory, exceptions) {
  return exceptions.find(
    (exception) =>
      advisory.name === exception.name &&
      advisory.range === exception.range &&
      typeof advisory.url === 'string' &&
      advisory.url.endsWith(`/${exception.ghsa}`),
  );
}

/**
 * The vulnerable packages of a report that no exception accounts for, and the
 * exceptions that were used. A package is accounted for when every
 * high-or-critical advisory it carries, directly or through the packages
 * named in its `via`, matches an exception.
 */
export function unacceptedFindings(report, exceptions) {
  const vulnerabilities = report?.vulnerabilities ?? {};
  const used = new Set();

  const blocked = (name, seen) => {
    if (seen.has(name)) return false;
    seen.add(name);
    const entry = vulnerabilities[name];
    // A package the report names but does not describe cannot be vouched for.
    if (!entry) return true;
    for (const via of entry.via ?? []) {
      if (typeof via === 'string') {
        if (blocked(via, seen)) return true;
        continue;
      }
      if (BELOW_LEVEL.has(via?.severity)) continue;
      const exception = matching(via, exceptions);
      if (!exception) return true;
      used.add(exception);
    }
    return false;
  };

  const unaccepted = Object.entries(vulnerabilities)
    .filter(([, entry]) => BLOCKING.has(entry?.severity))
    .filter(([name]) => blocked(name, new Set()))
    .map(([name]) => name);
  return { unaccepted, used };
}

/** Attempts allowed when the advisories endpoint does not answer. */
export const MAX_ATTEMPTS = 3;

/** Backoff before the attempt after `attempt`, in ms. Attempts count from 1. */
export const backoffMs = (attempt) => attempt * 30_000;

/**
 * What one `npm audit --json` run actually told us.
 *
 * - `clean`      -- a report, nothing at or above the audit level.
 * - `advisories` -- a report, with findings. Never retried.
 * - `no-answer`  -- no report: the endpoint failed, or npm emitted something
 *                   this does not recognise.
 */
export function classifyAuditResult({ status, stdout }) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return { kind: 'no-answer', reason: describeUnparseable(stdout) };
  }

  const counts = report?.metadata?.vulnerabilities;
  if (!counts || typeof counts !== 'object') {
    return { kind: 'no-answer', reason: describeError(report) };
  }

  // The report is authoritative about what was found; the exit code only
  // repeats whether anything reached the requested audit level.
  return status === 0
    ? { kind: 'clean', counts }
    : { kind: 'advisories', counts, report };
}

/** A one-line cause from an endpoint-failure payload, for the log. */
function describeError(report) {
  const parts = [
    typeof report?.message === 'string' ? report.message : '',
    typeof report?.error?.summary === 'string' ? report.error.summary : '',
    typeof report?.error?.detail === 'string' ? report.error.detail : '',
  ].filter(Boolean);
  return (
    parts.join(' -- ') ||
    'npm returned no vulnerability report and no error detail'
  );
}

function describeUnparseable(stdout) {
  const text = String(stdout ?? '').trim();
  return text
    ? `npm emitted output that is not JSON: ${text.slice(0, 200)}`
    : 'npm emitted no output';
}

/** `high: 0, critical: 0` style summary, for the log. */
export function formatCounts(counts) {
  return Object.entries(counts)
    .map(([severity, count]) => `${severity}: ${count}`)
    .join(', ');
}

const never = () => Promise.resolve();

/**
 * Audit one directory, retrying only a no-answer. Returns true when the gate
 * passes for that directory.
 *
 * `run` and `wait` are injected so the self-test drives the real policy
 * without a network or a thirty-second sleep.
 */
export async function auditDirectory(
  cwd,
  {
    run,
    wait = never,
    log = console.log,
    exceptions = ACCEPTED_ADVISORIES,
    today = todayUtc,
  } = {},
) {
  const live = liveExceptions(cwd, exceptions, today(), log);
  const expired = exceptions.some(
    (exception) => exception.target === cwd && !live.includes(exception),
  );
  /** Every live exception was needed; an unused one is a stale reason. */
  const allUsed = (used) => {
    const stale = live.filter((exception) => !used.has(exception));
    for (const exception of stale) {
      log(
        `::error::${cwd}: the accepted advisory ${exception.ghsa} (${exception.name} ${exception.range}) no longer matches any finding; remove it from ACCEPTED_ADVISORIES`,
      );
    }
    return stale.length === 0;
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const outcome = classifyAuditResult(await run(cwd));

    if (outcome.kind === 'clean') {
      log(`${cwd}: ${formatCounts(outcome.counts)}`);
      return allUsed(new Set()) && !expired;
    }

    if (outcome.kind === 'advisories') {
      const { unaccepted, used } = unacceptedFindings(outcome.report, live);
      if (unaccepted.length === 0 && used.size > 0) {
        for (const exception of used) {
          log(
            `::warning::${cwd}: accepted advisory ${exception.ghsa} (${exception.name} ${exception.range}) until ${exception.expires}`,
          );
        }
        return allUsed(used) && !expired;
      }
      // A real finding. Print the whole report -- whoever reads this needs the
      // package names, not a count -- and do not try again.
      log(JSON.stringify(outcome.report, null, 2));
      log(
        `::error::${cwd}: high-severity advisories in production dependencies (${formatCounts(outcome.counts)})`,
      );
      return false;
    }

    if (attempt < MAX_ATTEMPTS) {
      log(
        `::warning::${cwd}: npm advisories endpoint did not answer (attempt ${attempt}/${MAX_ATTEMPTS}): ${outcome.reason}`,
      );
      await wait(backoffMs(attempt));
      continue;
    }

    log(
      `::error::${cwd}: npm advisories endpoint did not answer after ${MAX_ATTEMPTS} attempts, so the production dependencies were NOT audited: ${outcome.reason}`,
    );
    return false;
  }
  return false;
}

/**
 * Audit every target. Every directory is audited even after one fails, so a
 * single run reports every problem rather than only the first.
 */
export async function auditAll(targets, options) {
  let ok = true;
  for (const target of targets) {
    if (!(await auditDirectory(target, options))) ok = false;
  }
  return ok;
}
