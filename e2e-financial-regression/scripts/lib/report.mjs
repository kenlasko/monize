// Rendering of the comparison result: a console table, a Markdown report, and
// a self-contained HTML report. Pure formatting -- classification lives in
// compare.mjs.

// Verdict metadata: label, whether it fails the run, and a one-line meaning.
export const VERDICTS = {
  identical: { fail: false, label: 'identical', blurb: 'value unchanged' },
  expected_fix: {
    fail: false,
    label: 'EXPECTED (0 -> unknown)',
    blurb: 'a wrong zero became an explicit unknown -- the intended fix',
  },
  resolved: { fail: false, label: 'unknown -> known', blurb: 'an unknown became a known value' },
  new_after: { fail: false, label: 'new (after only)', blurb: 'not present in BEFORE' },
  missing_after: {
    fail: false,
    label: 'gone (before only)',
    blurb: 'present in BEFORE, absent in AFTER (often just a poll that did not fire)',
  },
  both_unknown: { fail: false, label: 'both unknown', blurb: 'unknown in both revisions' },
  changed: { fail: true, label: 'CHANGED', blurb: 'a known value changed -- a regression' },
  lost_value: {
    fail: true,
    label: 'LOST VALUE',
    blurb: 'a known non-zero value became unknown -- data lost',
  },
  new_zero: {
    fail: true,
    label: 'NEW ZERO',
    blurb: 'an unknown became a known zero -- the anti-pattern this PR fixes against',
  },
};

function cell(sig) {
  if (!sig) return '(none)';
  if (sig.status === 'missing') return '(absent)';
  if (sig.status === 'unknown') return sig.rawText ? `unknown "${sig.rawText}"` : 'unknown';
  return sig.rawText ?? String(sig.numeric);
}

function diffText(row) {
  const { before, after } = row;
  if (before?.status === 'value' && after?.status === 'value') {
    const d = Number(after.numeric) - Number(before.numeric);
    if (d === 0) return '0';
    const rounded = Math.round(d * 10000) / 10000;
    return rounded > 0 ? `+${rounded}` : String(rounded);
  }
  return `${before?.status ?? 'none'} -> ${after?.status ?? 'none'}`;
}

const pad = (s, n) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));

export function renderConsole(rows, summary) {
  const failing = rows.filter((r) => VERDICTS[r.verdict].fail);
  const expected = rows.filter((r) => r.verdict === 'expected_fix');
  const lines = [];
  lines.push('');
  lines.push('='.repeat(96));
  lines.push('  Monize financial regression -- BEFORE vs AFTER');
  lines.push(`  before: ${summary.beforeRef}   after: ${summary.afterRef}`);
  lines.push('='.repeat(96));

  const show = (title, subset) => {
    if (subset.length === 0) return;
    lines.push('');
    lines.push(`  ${title} (${subset.length})`);
    lines.push(
      `  ${pad('SCREEN', 30)} ${pad('FIELD', 26)} ${pad('BEFORE', 14)} ${pad('AFTER', 14)} DIFF`,
    );
    lines.push(`  ${'-'.repeat(94)}`);
    for (const r of subset) {
      lines.push(
        `  ${pad(r.screen, 30)} ${pad(r.field, 26)} ${pad(cell(r.before), 14)} ` +
          `${pad(cell(r.after), 14)} ${diffText(r)}`,
      );
    }
  };

  show('FAILURES -- values that must be identical but are not', failing);
  show('Expected fixes -- wrong zeros that became unknown', expected);

  lines.push('');
  lines.push(
    `  Totals: ${summary.total} signals | ${summary.failCount} failing | ` +
      `${expected.length} expected fixes | ${summary.identical} identical`,
  );
  lines.push(
    failing.length === 0
      ? '  RESULT: PASS -- every complete-data value matches.'
      : `  RESULT: FAIL -- ${failing.length} value(s) differ where they must not.`,
  );
  lines.push('='.repeat(96));
  return lines.join('\n');
}

function mdRow(r) {
  return `| ${r.screen} | \`${r.field}\` | ${cell(r.before)} | ${cell(r.after)} | ${diffText(r)} | ${VERDICTS[r.verdict].label} |`;
}

export function renderMarkdown(rows, summary) {
  const failing = rows.filter((r) => VERDICTS[r.verdict].fail);
  const expected = rows.filter((r) => r.verdict === 'expected_fix');
  const other = rows.filter((r) => !VERDICTS[r.verdict].fail && r.verdict !== 'expected_fix');
  const header = '| Screen | Field | BEFORE | AFTER | Difference | Verdict |\n|---|---|---|---|---|---|';
  const section = (title, subset) =>
    subset.length ? `\n### ${title} (${subset.length})\n\n${header}\n${subset.map(mdRow).join('\n')}\n` : '';

  return [
    '# Monize financial regression report',
    '',
    `- **BEFORE**: \`${summary.beforeRef}\``,
    `- **AFTER**: \`${summary.afterRef}\``,
    `- **Result**: ${failing.length === 0 ? 'PASS' : `FAIL (${failing.length} differing value(s))`}`,
    `- **Signals**: ${summary.total} total, ${summary.failCount} failing, ${expected.length} expected fixes, ${summary.identical} identical`,
    '',
    'The comparison asserts that every complete-data financial value is **identical**',
    'BEFORE and AFTER. A "wrong zero becoming unknown" is expected and listed separately.',
    section('Failures -- must be identical but differ', failing),
    section('Expected fixes -- wrong zeros that became unknown', expected),
    section('Other differences (informational)', other),
  ].join('\n');
}

export function renderHtml(rows, summary) {
  const failing = rows.filter((r) => VERDICTS[r.verdict].fail);
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const trs = rows
    .map((r) => {
      const v = VERDICTS[r.verdict];
      const cls = v.fail ? 'fail' : r.verdict === 'expected_fix' ? 'fix' : 'ok';
      return `<tr class="${cls}"><td>${esc(r.screen)}</td><td><code>${esc(r.field)}</code></td><td>${esc(cell(r.before))}</td><td>${esc(cell(r.after))}</td><td>${esc(diffText(r))}</td><td>${esc(v.label)}</td></tr>`;
    })
    .join('\n');
  const result = failing.length === 0 ? 'PASS' : `FAIL (${failing.length})`;
  return `<!doctype html><meta charset="utf-8"><title>Monize financial regression</title>
<style>
 body{font:14px/1.5 system-ui,sans-serif;margin:2rem;color:#111;background:#fff}
 h1{margin-bottom:.2rem} .meta{color:#555;margin-bottom:1rem}
 table{border-collapse:collapse;width:100%} th,td{border:1px solid #ddd;padding:.35rem .5rem;text-align:left;vertical-align:top}
 th{background:#f3f4f6;position:sticky;top:0}
 tr.fail{background:#fee2e2} tr.fix{background:#fef9c3} tr.ok{background:#fff}
 .badge{font-weight:700;padding:.2rem .5rem;border-radius:.3rem}
 .PASS{background:#dcfce7} .FAIL{background:#fecaca}
 code{background:#f3f4f6;padding:0 .2rem;border-radius:.2rem}
</style>
<h1>Monize financial regression</h1>
<div class="meta">BEFORE <code>${esc(summary.beforeRef)}</code> vs AFTER <code>${esc(summary.afterRef)}</code>
 &mdash; <span class="badge ${result.startsWith('PASS') ? 'PASS' : 'FAIL'}">${esc(result)}</span>
 &mdash; ${summary.total} signals, ${summary.failCount} failing, ${summary.identical} identical</div>
<table><thead><tr><th>Screen</th><th>Field</th><th>BEFORE</th><th>AFTER</th><th>Difference</th><th>Verdict</th></tr></thead>
<tbody>${trs}</tbody></table>`;
}
