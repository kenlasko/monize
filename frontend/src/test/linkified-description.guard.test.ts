import { describe, it, expect } from 'vitest';

/**
 * Every render of a stored description or memo is classified, in both
 * directions.
 *
 * A transaction's description is where a ticket, receipt or order page ends up,
 * and `LinkifiedText` is what makes the address in it clickable. The mistake
 * this guards is the one `AGENTS.md` names -- "the fix for one surface
 * is not the fix": the register was linkified and the three report tables that
 * show the same field were not, so the same description was a link on one
 * screen and inert text on another.
 *
 * So the rule is not "use the component"; it is "decide, per surface, and say
 * why". `LINKIFIED` names the surfaces that draw links; `PLAIN` names every
 * other place a description or memo reaches the screen as text, each with the
 * reason it stays inert. The scan below must find exactly `PLAIN` -- a new
 * render that is in neither list fails here rather than shipping as a silent
 * third answer.
 */

const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

function productionSources(): [string, string][] {
  return Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path));
}

/** As `ui-conventions.test.ts`: prose naming a banned shape must not trip it. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, before: string) => before + ' '.repeat(match.length - before.length),
    );
}

/** The surfaces that render a saved transaction description or split memo. */
const LINKIFIED = [
  '/src/components/transactions/TransactionRow.tsx',
  '/src/components/reports/UncategorizedTransactionsReport.tsx',
  '/src/components/reports/DuplicateGroupCard.tsx',
  '/src/components/reports/ReportChart.tsx',
];

/**
 * Everywhere else a `.description` or `.memo` is rendered as text, and why the
 * address in it is not drawn as a link. Three reasons recur, and each is a
 * decision rather than an oversight:
 *
 *  - it is not a transaction's description (an account's, a category's, a
 *    security's, a UI option's) -- a different field that happens to share a
 *    name;
 *  - the row is not saved yet, so the text is being approved or diagnosed
 *    rather than read back;
 *  - the text sits inside a control, where `docs/frontend/ui-conventions.md`'s rule against
 *    nesting anything interactive in a `<button>` settles it.
 */
const PLAIN: Record<string, string> = {
  '/src/components/accounts/AccountRow.tsx':
    "an account's own description, not a transaction's",
  '/src/components/transactions/AccountInfoWidget.tsx':
    "an account's own description, not a transaction's",
  '/src/components/reports/AccountBalancesReport.tsx':
    "an account's own description, not a transaction's",
  '/src/components/categories/CategoryList.tsx':
    "a category's own description, not a transaction's",
  '/src/components/transactions/CategoryInfoWidget.tsx':
    "a category's own description, not a transaction's",
  '/src/components/securities/SecurityListParts.tsx':
    "a security's profile text from the market-data provider",
  '/src/components/securities/detail/SecurityAboutCard.tsx':
    "a security's profile text from the market-data provider",
  '/src/components/admin/PushChannelsPanel.tsx':
    'a notification channel label, composed by the app',
  '/src/components/dashboard/GettingStarted.tsx':
    'onboarding copy, composed by the app',
  '/src/components/reports/InvestmentReportColumnChooser.tsx':
    'a column label, composed by the app',
  '/src/components/ai/ChatMessage.tsx':
    'a data-source label on an answer, not a transaction field',
  '/src/components/dashboard/InsightsWidget.tsx':
    'AI insight prose, already reduced by stripLinkMarkup for a compact card',
  '/src/components/reports/SpendingAnomaliesReport.tsx':
    'a sentence the server composed about a pattern, not the stored field',
  '/src/components/import/MnyWarningsPanel.tsx':
    'a row from a file being imported: not a transaction yet, and the panel is a diagnostic',
  '/src/components/transactions/RecentTransactionsPopover.tsx':
    'inside the <button> that selects the transaction -- nothing interactive nests in a button',
  '/src/components/ui/SplitSubmitButton.tsx':
    'a menu option label inside a button, and composed by the app besides',
};

/**
 * A JSX child whose whole body is a `.description` / `.memo` read, with an
 * optional fallback and at most one wrapping call. Attribute positions (`=`
 * before the brace) and template interpolations (`$` before it) are not
 * renders, so both are skipped by the caller.
 */
const RENDERS_DESCRIPTION =
  /^\{\s*(?:[A-Za-z_$][\w$]*\()?\s*[A-Za-z_$][\w$]*(?:(?:\?\.|\.)[\w$]+|\[[^\]]*\])*\.(?:description|memo)\b\s*\)?\s*(?:(?:\|\||\?\?)\s*(?:'[^']*'|"[^"]*"|null|undefined|t\([^()]*\)))?\s*\}$/;

function filesRenderingRawDescription(): string[] {
  const found: string[] = [];
  for (const [path, raw] of productionSources()) {
    const source = withoutComments(raw);
    for (const match of source.matchAll(/\{[^{}]*\}/g)) {
      const before = source[match.index - 1];
      if (before === '=' || before === '$') continue;
      if (!RENDERS_DESCRIPTION.test(match[0])) continue;
      found.push(path);
      break;
    }
  }
  return found.sort();
}

describe('a transaction description renders through LinkifiedText', () => {
  it('draws links on every surface that shows a saved description or memo', () => {
    for (const path of LINKIFIED) {
      const source = sources[path];
      expect(source, `${path} not found -- update this list`).toBeTruthy();
      expect(source, `${path} no longer renders LinkifiedText`).toContain(
        '<LinkifiedText',
      );
    }
  });

  it('leaves no raw description render unclassified', () => {
    const unclassified = filesRenderingRawDescription().filter(
      (path) => !(path in PLAIN),
    );
    expect(
      unclassified,
      'render a saved transaction description through LinkifiedText, or record here why this one stays inert',
    ).toEqual([]);
  });

  it('keeps the recorded reasons pointing at real renders', () => {
    // The other direction: a file that stopped rendering a description, or was
    // linkified, must leave the list rather than sit there justifying nothing.
    const found = new Set(filesRenderingRawDescription());
    expect(Object.keys(PLAIN).filter((path) => !found.has(path))).toEqual([]);
  });

  it('records a reason for every exemption', () => {
    for (const [path, reason] of Object.entries(PLAIN)) {
      expect(reason.length, `${path} has no reason`).toBeGreaterThan(20);
    }
  });

  it('still finds raw renders, so the scan cannot pass by an empty set', () => {
    expect(filesRenderingRawDescription().length).toBeGreaterThan(10);
  });

  it('reads a render but not an attribute or an interpolation', () => {
    // The three shapes the scan has to tell apart, pinned so a later tweak to
    // the pattern cannot quietly stop finding renders.
    expect(RENDERS_DESCRIPTION.test('{tx.description}')).toBe(true);
    expect(RENDERS_DESCRIPTION.test("{item.memo || '-'}")).toBe(true);
    expect(RENDERS_DESCRIPTION.test('{stripLinkMarkup(insight.description)}')).toBe(true);
    expect(RENDERS_DESCRIPTION.test('{t(\'form.fields.description\')}')).toBe(false);
    expect(RENDERS_DESCRIPTION.test('{errors.description.message}')).toBe(false);
  });
});

/**
 * A note being EDITED cannot have its links drawn in place -- a `<textarea>`
 * renders no elements -- so `NoteLinks` offers them beneath the field. Which
 * editors do that is the same kind of decision as which readers linkify, and is
 * recorded the same way.
 */
const LINKS_UNDER_FIELD = [
  '/src/components/transactions/TransactionForm.tsx',
  '/src/components/transactions/SplitTransactionFields.tsx',
];

/** The other note editors, and why the field there carries no link row. */
const NO_LINKS_UNDER_FIELD: Record<string, string> = {
  '/src/components/transactions/SplitEditor.tsx':
    'a dense table of one-line memo inputs; a link row under each would double the row height',
  '/src/components/transactions/BulkUpdateModal.tsx':
    'writes one description across a selection rather than reading an existing note back',
  '/src/components/scheduled-transactions/ScheduledTransactionForm.tsx':
    'not yet offered here -- the same affordance would fit, it is simply not built',
  '/src/components/scheduled-transactions/PostTransactionDialog.tsx':
    'not yet offered here -- the same affordance would fit, it is simply not built',
  '/src/components/scheduled-transactions/OverrideEditorDialog.tsx':
    'not yet offered here -- the same affordance would fit, it is simply not built',
  '/src/components/investments/InvestmentTransactionForm.tsx':
    'not yet offered here -- the same affordance would fit, it is simply not built',
};

describe('a note being edited offers its links beside the field', () => {
  it('offers them on the New/Edit Transaction modal, in both its modes', () => {
    // The modal renders the description textarea normally and
    // SplitTransactionFields in split mode, so covering only one leaves the
    // link unreachable for half the transactions a user creates.
    for (const path of LINKS_UNDER_FIELD) {
      const source = sources[path];
      expect(source, `${path} not found -- update this list`).toBeTruthy();
      expect(source, `${path} no longer renders NoteLinks`).toContain('<NoteLinks');
    }
  });

  it('records why the other note editors do not', () => {
    const offering = Object.keys(NO_LINKS_UNDER_FIELD).filter((path) =>
      sources[path]?.includes('<NoteLinks'),
    );
    expect(
      offering,
      'this editor now offers links -- move it to LINKS_UNDER_FIELD',
    ).toEqual([]);
    for (const [path, reason] of Object.entries(NO_LINKS_UNDER_FIELD)) {
      expect(sources[path], `${path} not found -- update this list`).toBeTruthy();
      expect(reason.length, `${path} has no reason`).toBeGreaterThan(20);
    }
  });

  it('covers every form that takes a note, between the two lists', () => {
    // The set comes from the length guard, which already names every note
    // editor: a new one has to be classified here rather than quietly shipping
    // with no way to reach the address in it.
    const block = /const NOTE_FORMS: Record<string, string> = \{([\s\S]*?)\n\};/.exec(
      sources['/src/test/transaction-note.guard.test.ts'],
    );
    expect(block, 'NOTE_FORMS not found -- has the length guard been renamed?').not.toBeNull();
    // The keys only. The reasons beside them are prose with apostrophes in it,
    // so anything that tries to parse the whole literal breaks on the first one.
    const noteForms = [...block![1].matchAll(/'(\/src\/[^']+\.tsx)':/g)].map(
      (match) => match[1],
    );
    expect(noteForms.length).toBeGreaterThan(0);
    expect([...LINKS_UNDER_FIELD, ...Object.keys(NO_LINKS_UNDER_FIELD)].sort()).toEqual(
      noteForms.sort(),
    );
  });
});

describe('LinkifiedText is the only renderer of linkified segments', () => {
  const RENDERER = '/src/components/ui/LinkifiedText.tsx';

  it('draws its anchor in exactly one place', () => {
    // `LinkifiedText` and `NoteLinks` share one `NoteLink`, so the target, rel
    // and event-stopping cannot drift between reading a note and editing one.
    const anchors = withoutComments(sources[RENDERER]).match(/<a\b/g) ?? [];
    expect(anchors).toHaveLength(1);
  });

  it('calls linkifySegments nowhere else', () => {
    // A second hand-rolled renderer is how the anchor's rel, target and
    // event-stopping drift apart between two screens.
    const callers = productionSources()
      .filter(([path]) => path !== '/src/lib/linkify.ts')
      .filter(([, content]) => /\blinkifySegments\s*\(/.test(withoutComments(content)))
      .map(([path]) => path);
    expect(callers).toEqual([RENDERER]);
  });

  it('builds its href through the shared external-URL guard', () => {
    // `toSafeExternalUrl` is the one door from a stored string to an href; a
    // parser that decided for itself would be a second, unreviewed policy.
    expect(sources['/src/lib/linkify.ts']).toContain('toSafeExternalUrl');
  });

  it('opens a link away from this tab without handing over the opener', () => {
    const source = sources[RENDERER];
    expect(source).toContain('rel="noopener noreferrer"');
    expect(source).toContain('target="_blank"');
  });
});
