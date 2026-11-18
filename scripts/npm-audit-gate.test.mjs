// Self-test for scripts/lib/npm-audit-gate.mjs -- the decision that separates
// "you shipped a vulnerability" from "npmjs is down".
//
// Run: node --test scripts/npm-audit-gate.test.mjs
//
// The cases below are weighted toward the two ways this gate can be worse than
// useless: retrying (and so possibly swallowing) a real advisory, or reading an
// unanswered endpoint as a clean audit. Both would be a green check over
// dependencies nobody audited.
//
// The payloads are not invented. CLEAN_REPORT and ENDPOINT_FAILURE are the
// literal shapes `npm audit --json` emitted on this repository: a clean run in
// backend/, and a run pointed at a dead registry. The observed CI failures
// carried the same no-metadata shape behind `npm error audit endpoint returned
// an error`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCEPTED_ADVISORIES,
  AUDIT_TARGETS,
  MAX_ATTEMPTS,
  auditAll,
  auditDirectory,
  backoffMs,
  classifyAuditResult,
  formatCounts,
  unacceptedFindings,
} from './lib/npm-audit-gate.mjs';

const CLEAN_REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
      total: 0,
    },
    dependencies: {
      prod: 396,
      dev: 532,
      optional: 31,
      peer: 1,
      peerOptional: 0,
      total: 930,
    },
  },
};

// npm audit --json --registry=http://127.0.0.1:9, verbatim.
const ENDPOINT_FAILURE = {
  message:
    'request to http://127.0.0.1:9/-/npm/v1/security/audits/quick failed, reason: connect ECONNREFUSED 127.0.0.1:9',
  error: { summary: '', detail: '' },
};

const ADVISORY_REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {
    'some-package': {
      name: 'some-package',
      severity: 'high',
      via: [
        { title: 'Prototype pollution', url: 'https://example.test/advisory' },
      ],
    },
  },
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 1,
      critical: 0,
      total: 1,
    },
    dependencies: {
      prod: 396,
      dev: 0,
      optional: 0,
      peer: 0,
      peerOptional: 0,
      total: 396,
    },
  },
};

const said = (status, body) => ({
  status,
  stdout: typeof body === 'string' ? body : JSON.stringify(body),
});

/** A runner that replays a scripted sequence, and records how often it ran. */
function scriptedRunner(...results) {
  const calls = [];
  const run = (cwd) => {
    calls.push(cwd);
    return results[Math.min(calls.length - 1, results.length - 1)];
  };
  return { run, calls };
}

/** Collects log lines instead of printing them. */
function recorder() {
  const lines = [];
  return {
    log: (line) => lines.push(line),
    lines,
    text: () => lines.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test('a report with no findings and exit 0 is clean', () => {
  const outcome = classifyAuditResult(said(0, CLEAN_REPORT));
  assert.equal(outcome.kind, 'clean');
  assert.equal(outcome.counts.total, 0);
});

test('a report with findings and exit 1 is advisories, not an outage', () => {
  const outcome = classifyAuditResult(said(1, ADVISORY_REPORT));
  assert.equal(outcome.kind, 'advisories');
  assert.equal(outcome.counts.high, 1);
});

test('an endpoint failure is a no-answer, and names the cause', () => {
  const outcome = classifyAuditResult(said(1, ENDPOINT_FAILURE));
  assert.equal(outcome.kind, 'no-answer');
  assert.match(outcome.reason, /ECONNREFUSED/);
});

// The discriminator is the report's presence, not the error's. An npm release
// that renames `error` must not thereby turn an outage into a clean audit.
test('an unrecognised failure shape is a no-answer, never clean', () => {
  const outcome = classifyAuditResult(
    said(1, { somethingNew: 'npmjs is down' }),
  );
  assert.equal(outcome.kind, 'no-answer');
});

test('non-JSON output is a no-answer, never clean', () => {
  const outcome = classifyAuditResult(
    said(1, 'npm error audit endpoint returned an error'),
  );
  assert.equal(outcome.kind, 'no-answer');
  assert.match(outcome.reason, /not JSON/);
});

test('empty output is a no-answer, never clean', () => {
  assert.equal(classifyAuditResult(said(1, '')).kind, 'no-answer');
});

// Exit 0 with no report would be the worst possible pass: nothing was audited.
test('exit 0 with no report is still a no-answer', () => {
  assert.equal(
    classifyAuditResult(said(0, ENDPOINT_FAILURE)).kind,
    'no-answer',
  );
});

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

test('a clean audit passes on the first attempt, with no retry', async () => {
  const { run, calls } = scriptedRunner(said(0, CLEAN_REPORT));
  const log = recorder();
  assert.equal(await auditDirectory('backend', { run, log: log.log }), true);
  assert.equal(calls.length, 1);
});

// The property this whole gate exists for: a finding fails NOW. A retry could
// see a later attempt fail to reach the endpoint and report an outage instead.
test('an advisory fails immediately and is never retried', async () => {
  const { run, calls } = scriptedRunner(said(1, ADVISORY_REPORT));
  const log = recorder();
  assert.equal(await auditDirectory('backend', { run, log: log.log }), false);
  assert.equal(calls.length, 1);
  assert.match(log.text(), /::error::backend: high-severity advisories/);
  // The names, not just the count -- the reader has to know what to fix.
  assert.match(log.text(), /some-package/);
});

test('a no-answer is retried, and a later answer decides', async () => {
  const { run, calls } = scriptedRunner(
    said(1, ENDPOINT_FAILURE),
    said(0, CLEAN_REPORT),
  );
  const log = recorder();
  assert.equal(await auditDirectory('backend', { run, log: log.log }), true);
  assert.equal(calls.length, 2);
  assert.match(
    log.text(),
    /::warning::backend: npm advisories endpoint did not answer \(attempt 1\/3\)/,
  );
});

test('an advisory found after a no-answer still fails', async () => {
  const { run, calls } = scriptedRunner(
    said(1, ENDPOINT_FAILURE),
    said(1, ADVISORY_REPORT),
  );
  assert.equal(
    await auditDirectory('backend', { run, log: recorder().log }),
    false,
  );
  assert.equal(calls.length, 2);
});

// An outage that outlasts the retries is NOT a pass: "we could not verify" is
// not "verified clean". It fails, and it says which endpoint and how often.
test('a persistent no-answer fails after the attempt budget, saying so', async () => {
  const { run, calls } = scriptedRunner(said(1, ENDPOINT_FAILURE));
  const log = recorder();
  assert.equal(await auditDirectory('backend', { run, log: log.log }), false);
  assert.equal(calls.length, MAX_ATTEMPTS);
  assert.match(log.text(), /were NOT audited/);
  assert.match(log.text(), /ECONNREFUSED/);
});

test('the backoff grows and is never zero', () => {
  assert.ok(backoffMs(1) > 0);
  assert.ok(backoffMs(2) > backoffMs(1));
});

// ---------------------------------------------------------------------------
// Every target is audited
// ---------------------------------------------------------------------------

test('a failure in one directory does not skip the next', async () => {
  const calls = [];
  const run = (cwd) => {
    calls.push(cwd);
    return cwd === 'backend' ? said(1, ADVISORY_REPORT) : said(0, CLEAN_REPORT);
  };
  const ok = await auditAll(['backend', 'frontend'], {
    run,
    log: recorder().log,
  });
  assert.equal(ok, false);
  assert.deepEqual(calls, ['backend', 'frontend']);
});

test('both directories clean passes', async () => {
  const run = () => said(0, CLEAN_REPORT);
  assert.equal(
    await auditAll(['backend', 'frontend'], {
      run,
      log: recorder().log,
      exceptions: [],
    }),
    true,
  );
});

test('formatCounts lists every severity', () => {
  assert.equal(formatCounts({ high: 1, critical: 0 }), 'high: 1, critical: 0');
});

// ---------------------------------------------------------------------------
// Accepted advisories
// ---------------------------------------------------------------------------

// What `npm audit --omit=dev --json` reported in frontend/ on PR #2264,
// verbatim but for the metadata's dependency counts.
const PICOMATCH_ADVISORY = {
  source: 1247710,
  name: 'picomatch',
  dependency: 'picomatch',
  title:
    'picomatch vulnerable to ReDoS through single-branch repeated extglobs',
  url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
  severity: 'high',
  cwe: ['CWE-1333'],
  cvss: {
    score: 7.5,
    vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H',
  },
  range: '<=4.0.7',
};

function picomatchReport(advisory = PICOMATCH_ADVISORY, extra = {}) {
  const high = 2 + Object.keys(extra).length;
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      '@parcel/watcher': {
        name: '@parcel/watcher',
        severity: 'high',
        isDirect: false,
        via: ['picomatch'],
        effects: [],
        range: '>=2.5.4',
        nodes: ['node_modules/@parcel/watcher'],
        fixAvailable: true,
      },
      picomatch: {
        name: 'picomatch',
        severity: 'high',
        isDirect: false,
        via: [advisory],
        effects: ['@parcel/watcher'],
        range: '*',
        nodes: ['node_modules/picomatch'],
        fixAvailable: true,
      },
      ...extra,
    },
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high,
        critical: 0,
        total: high,
      },
    },
  };
}

const PICOMATCH_EXCEPTION = {
  target: 'frontend',
  ghsa: 'GHSA-fc5q-39xc-vjpf',
  name: 'picomatch',
  range: '<=4.0.7',
  expires: '2027-01-31',
};

const gate = (report, options = {}) => {
  const log = recorder();
  const { run, calls } = scriptedRunner(
    report === null ? said(0, CLEAN_REPORT) : said(1, report),
  );
  return auditDirectory(options.cwd ?? 'frontend', {
    run,
    log: log.log,
    exceptions: [PICOMATCH_EXCEPTION],
    today: () => options.today ?? '2026-11-18',
  }).then((ok) => ({ ok, log, calls }));
};

test('an accepted advisory, and the package it reaches through, pass with a warning', async () => {
  const { ok, log } = await gate(picomatchReport());
  assert.equal(ok, true);
  assert.match(
    log.text(),
    /::warning::frontend: accepted advisory GHSA-fc5q-39xc-vjpf \(picomatch <=4\.0\.7\) until 2027-01-31/,
  );
});

test('an accepted advisory does not cover another high finding beside it', async () => {
  const { ok, log } = await gate(
    picomatchReport(PICOMATCH_ADVISORY, {
      'some-package': ADVISORY_REPORT.vulnerabilities['some-package'],
    }),
  );
  assert.equal(ok, false);
  assert.match(log.text(), /some-package/);
});

// The property that ends the exception when a patched release ships: GitHub
// moves the advisory's range off the one that was accepted.
test('the advisory at another range is not accepted', async () => {
  const { ok } = await gate(
    picomatchReport({ ...PICOMATCH_ADVISORY, range: '<4.0.8' }),
  );
  assert.equal(ok, false);
});

test('another advisory of the same package is not accepted', async () => {
  const { ok } = await gate(
    picomatchReport({
      ...PICOMATCH_ADVISORY,
      url: 'https://github.com/advisories/GHSA-xxxx-xxxx-xxxx',
    }),
  );
  assert.equal(ok, false);
});

test('the exception applies only in its own directory', async () => {
  const { ok } = await gate(picomatchReport(), { cwd: 'backend' });
  assert.equal(ok, false);
});

test('an expired exception fails, and says it expired', async () => {
  const { ok, log } = await gate(picomatchReport(), { today: '2027-02-01' });
  assert.equal(ok, false);
  assert.match(log.text(), /expired on 2027-01-31/);
});

test('the exception holds through its last day', async () => {
  const { ok } = await gate(picomatchReport(), { today: '2027-01-31' });
  assert.equal(ok, true);
});

// Once the patched release is installed the finding is gone; the entry must go too.
test('an exception no finding needs fails the directory until it is removed', async () => {
  const { ok, log } = await gate(null);
  assert.equal(ok, false);
  assert.match(log.text(), /no longer matches any finding/);
});

test('a package that reaches an undescribed package is not vouched for', () => {
  const report = picomatchReport();
  report.vulnerabilities['@parcel/watcher'].via = ['picomatch', 'ghost'];
  const { unaccepted } = unacceptedFindings(report, [PICOMATCH_EXCEPTION]);
  assert.deepEqual(unaccepted, ['@parcel/watcher']);
});

test('a moderate advisory beside an accepted one does not block', () => {
  const report = picomatchReport();
  report.vulnerabilities.picomatch.via = [
    PICOMATCH_ADVISORY,
    {
      ...PICOMATCH_ADVISORY,
      url: 'https://example.test/x',
      severity: 'moderate',
    },
  ];
  assert.deepEqual(
    unacceptedFindings(report, [PICOMATCH_EXCEPTION]).unaccepted,
    [],
  );
});

test('every accepted advisory names an audited directory, a GHSA, a range and a date', () => {
  for (const exception of ACCEPTED_ADVISORIES) {
    assert.ok(
      [...AUDIT_TARGETS, 'desktop'].includes(exception.target),
      exception.target,
    );
    assert.match(exception.ghsa, /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/);
    assert.ok(exception.name && exception.range);
    assert.match(exception.expires, /^\d{4}-\d{2}-\d{2}$/);
  }
});
