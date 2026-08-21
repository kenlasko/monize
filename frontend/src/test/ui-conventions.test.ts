import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Guard tests for the UI conventions in `frontend/CLAUDE.md`.
 *
 * These exist because a documented rule is only as good as its enforcement. Each
 * one was added after an agent reached for the generic solution, a human spotted
 * it in the running app, and the fix landed in a single file. A test that scans
 * the whole source tree catches the next instance wherever it appears, which a
 * test around the one component that was fixed cannot.
 *
 * Add a case here whenever a *mechanical* mistake gets corrected -- a raw element
 * used where a shared component exists. Judgement calls (is this list long enough
 * to need paging?) stay in prose; only checkable rules belong here.
 *
 * Modelled on `src/lib/tours/anchors.uniqueness.test.ts`, which scans the tree the
 * same way for detached tour anchors.
 */
const sources = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw",
  eager: true,
  import: "default",
}) as Record<string, string>;

/** Source files only: tests legitimately contain the markup they assert on. */
function productionSources(): [string, string][] {
  return Object.entries(sources).filter(
    ([path]) => !/\.test\.tsx?$/.test(path),
  );
}

describe("date entry goes through DateInput", () => {
  /** The one file allowed to hold a raw date input -- it *is* the wrapper. */
  const WRAPPER = "/src/components/ui/DateInput.tsx";
  const RAW_DATE_INPUT = /type=["']date["']/;

  it('has no raw <input type="date"> outside the shared component', () => {
    const offenders = productionSources()
      .filter(([path]) => path !== WRAPPER)
      .filter(([, content]) => RAW_DATE_INPUT.test(content))
      .map(([path]) => path);

    // A bare date input misses the lenient parsing, the shortcuts and
    // `CalendarPopover`, and hands the user the browser's own segment-jumping
    // entry -- which is the thing issue #1201 was about.
    expect(offenders).toEqual([]);
  });

  it("still finds the wrapper, so the rule cannot pass by accident", () => {
    // Were DateInput renamed, or were it to stop using a native date input, the
    // check above would trivially pass over an empty set. This fails first and
    // says what to update.
    const wrapper = sources[WRAPPER];
    expect(
      wrapper,
      `${WRAPPER} not found -- update WRAPPER in this test`,
    ).toBeTruthy();
    expect(RAW_DATE_INPUT.test(wrapper)).toBe(true);
  });
});

describe('numeric entry goes through NumericInput or CurrencyInput', () => {
  /**
   * `type="number"` is not exclusive to inputs -- recharts' `<XAxis type="number">`
   * declares a continuous scale and appears in roughly twenty chart components.
   * So the check is not "does this file contain the string": it walks back from
   * each occurrence to the tag it belongs to and only complains about `input`
   * (the raw element) and `Input` (the shared text field). Anything else --
   * `XAxis`, `YAxis`, a future chart prop -- is left alone.
   */
  const TYPE_NUMBER = /type=["']number["']/g;

  /** The JSX tag an attribute at `index` belongs to, or null if unparseable. */
  function owningTag(content: string, index: number): string | null {
    const open = content.lastIndexOf('<', index);
    if (open === -1) return null;
    return /^<\s*([A-Za-z][\w.]*)/.exec(content.slice(open, index))?.[1] ?? null;
  }

  const NUMERIC_ENTRY_TAGS = new Set(['input', 'Input']);

  it('has no <input type="number"> anywhere in the source tree', () => {
    const offenders: string[] = [];
    for (const [path, content] of productionSources()) {
      for (const match of content.matchAll(TYPE_NUMBER)) {
        const tag = owningTag(content, match.index);
        if (tag && NUMERIC_ENTRY_TAGS.has(tag)) {
          offenders.push(`${path}: <${tag} type="number">`);
        }
      }
    }

    // A native number input adds spinner arrows, changes value on scroll wheel,
    // and hands the form a locale-dependent parse of what was typed. Money goes
    // through `CurrencyInput` (thousands separators, rounding to cents, the
    // inline calculator); every other number -- share counts, rates, day-of-month,
    // retention counts -- through `NumericInput` with `decimalPlaces`.
    expect(offenders).toEqual([]);
  });

  it('still resolves the tag an attribute belongs to', () => {
    // Were `owningTag` to start returning null -- a bad edit, a JSX form it
    // cannot walk -- the check above would pass over an empty set. Assert both
    // halves: the raw input is caught, the recharts axis is not.
    const sample = [
      '<input type="number" min={0} />',
      '<XAxis dataKey="t" type="number" scale="time" />',
    ].join('\n');
    const tags = [...sample.matchAll(TYPE_NUMBER)].map((m) => owningTag(sample, m.index));
    expect(tags).toEqual(['input', 'XAxis']);
  });
});

describe('every password field says what may be autofilled into it', () => {
  /**
   * A `type="password"` box with no `autoComplete` is an open invitation to the
   * browser's saved credential for this origin, and the field is not always
   * asking for that credential. The AI provider's API key is the case that bit:
   * the edit form sends `apiKey` whenever the box is non-empty, so a manager
   * filling it silently replaced the stored provider key on the next save -- the
   * user sees "saved" and the provider stops working. The backup export password
   * is the same shape and worse, because the artifact is then encrypted under a
   * password nobody knows.
   *
   * So every password input declares its intent. Three answers, and which one is
   * right is a judgement about the field, not something a scan can decide:
   *
   *   - `current-password` -- it really is this account's password (a re-auth
   *     prompt, the confirm-before-delete box). Autofill is correct and helpful.
   *   - `new-password`     -- a password being set or changed here.
   *   - `off`              -- not a credential of this site at all: an API key,
   *     a backup artifact's password.
   *
   * The scan only insists that the decision was made and written down.
   */
  const PASSWORD_TYPE = /type=["']password["']/g;

  /** Values that answer the question. Anything else is a typo or a guess. */
  const DECLARED = new Set(['off', 'new-password', 'current-password']);

  /**
   * The source of the JSX element an attribute at `index` belongs to.
   *
   * Walks back to the element's `<` and forward to the `>` that closes its
   * opening tag, skipping any `>` inside a `{...}` expression (an arrow function
   * in an `onKeyDown` handler is the common one, and `owningTag` above stops at
   * the tag name so it cannot be reused here). Returns null when the tag cannot
   * be delimited, which the paired test below proves does not happen silently.
   */
  function owningElement(content: string, index: number): string | null {
    const open = content.lastIndexOf('<', index);
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < content.length; i += 1) {
      const ch = content[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) return content.slice(open, i + 1);
    }
    return null;
  }

  const passwordElements = (): { path: string; element: string }[] => {
    const found: { path: string; element: string }[] = [];
    for (const [path, content] of productionSources()) {
      for (const match of content.matchAll(PASSWORD_TYPE)) {
        const element = owningElement(content, match.index);
        found.push({ path, element: element ?? '' });
      }
    }
    return found;
  };

  it('declares an autoComplete on every password input', () => {
    const offenders = passwordElements()
      .filter(({ element }) => !/\bautoComplete\s*=/.test(element))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('uses only the three values that answer the question', () => {
    const offenders: string[] = [];
    for (const { path, element } of passwordElements()) {
      const value = /\bautoComplete\s*=\s*["']([^"']*)["']/.exec(element)?.[1];
      if (value !== undefined && !DECLARED.has(value)) {
        offenders.push(`${path}: autoComplete="${value}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('finds the password fields, so the rule cannot pass over an empty set', () => {
    // Were the shared `Input` to stop taking `type="password"`, or were the
    // regex to rot, both checks above would trivially pass. The app has a
    // login, a change-password form and a re-auth modal at minimum.
    expect(passwordElements().length).toBeGreaterThan(5);
    expect(passwordElements().every(({ element }) => element !== '')).toBe(true);
  });

  it('delimits an element whose props contain a `>` inside an expression', () => {
    // The restore and export boxes both carry an `onKeyDown` arrow function, so
    // a naive "first `>` after the `<`" would cut the element short and report a
    // false offender. Assert the walker handles it.
    const sample =
      '<Input type="password" onKeyDown={(e) => run(e)} autoComplete="off" />';
    const element = owningElement(sample, sample.indexOf('type='));
    expect(element).toBe(sample);
    expect(/\bautoComplete\s*=/.test(element ?? '')).toBe(true);
  });
});

describe("a scrollbar you need is not hidden", () => {
  /**
   * `scrollbar-hide` is for a horizontal strip of chips, where the content being
   * cut off is itself the signal that there is more. On a vertical list it hides
   * the only indication that rows exist below the fold, which is strictly worse
   * than the plain bar someone was trying to get rid of. The fix for an ugly bar
   * is `scrollbar-slim`, not no bar.
   *
   * Matched per class attribute rather than per file, so an unrelated
   * `scrollbar-hide` elsewhere in the same component does not trip it.
   */
  const CLASS_ATTR = /class(?:Name)?=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g;

  it("never puts scrollbar-hide on a vertically scrolling element", () => {
    const offenders: string[] = [];
    for (const [path, content] of productionSources()) {
      for (const match of content.matchAll(CLASS_ATTR)) {
        const classes = match[1] ?? match[2] ?? match[3] ?? "";
        if (
          classes.includes("scrollbar-hide") &&
          /\boverflow-y-(auto|scroll)\b/.test(classes)
        ) {
          offenders.push(`${path}: ${classes.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("chart colours come from the theme tokens", () => {
  /**
   * `src/lib/chart-colors.ts` exposes `var(--chart-*)` strings so a chart
   * follows the active colour theme and light/dark mode with no JS. A literal
   * `fill="#22c55e"` looks correct on the default palette and then stays that
   * exact green on all twenty-odd themes -- the charts were the last thing on
   * screen still doing it.
   *
   * Matched per colour prop rather than per file, because the same components
   * legitimately hold hex for the PDF export: `pdf-export.ts` parses
   * `summaryCards[].color` as hex, and a `var(...)` there produces NaN. Those
   * are `color:` keys and never reach a chart.
   *
   * The value is captured whole (`{...}`, `"..."`, `'...'`) so a conditional
   * like `fill={up ? '#16a34a' : '#dc2626'}` is caught too, not just the
   * literal-valued form.
   */
  const COLOUR_PROP =
    /\b(fill|stroke|stopColor)\s*[=:]\s*(\{[^{}]*\}|"[^"]*"|'[^']*')/g;
  const HEX = /#[0-9a-fA-F]{3,8}\b/;

  /**
   * Drawn on top of a filled flag bubble rather than on the card, so these are
   * contrast against the fill -- white is the point. `chartColors.surface`
   * would make them the card colour and so invisible on the bubble in dark
   * mode. The only exemption; anything new needs its own reason here.
   */
  const ON_FILL_WHITE = "/src/components/investments/portfolio-chart-utils.tsx";

  it("never hardcodes a hex colour on a chart fill or stroke", () => {
    const offenders: string[] = [];
    for (const [path, content] of productionSources()) {
      if (!/from ['"]recharts['"]/.test(content)) continue;
      for (const match of content.matchAll(COLOUR_PROP)) {
        if (!HEX.test(match[2])) continue;
        // The bubble text/divider/cross, and nothing else in that file.
        if (path === ON_FILL_WHITE && /#fff\b/.test(match[2])) continue;
        offenders.push(`${path}: ${match[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still matches the colour props it is meant to police", () => {
    // Were the regex to stop matching -- a Recharts rename, a bad edit -- the
    // check above would pass over an empty set. This fails first and says so.
    const sample = `fill="#22c55e" stroke={up ? '#16a34a' : '#dc2626'}`;
    const hits = [...sample.matchAll(COLOUR_PROP)].filter((m) =>
      HEX.test(m[2]),
    );
    expect(hits).toHaveLength(2);
  });
});

describe('a control sitting beside an input is the height of that input', () => {
  /**
   * `CurrencyPickerButton` is the square button left of an Amount field. It has
   * no vertical padding and no height of its own, so its height comes entirely
   * from the flex row. That made it a two-part rule that was easy to half-apply:
   * the button needs `self-stretch`, and the row it sits in needs
   * `items-stretch` with a `min-w-0` sibling. Getting either wrong renders a
   * squat button beside a full-height input, which is what a human had to point
   * out on the Bills & Deposits form.
   *
   * Both halves are checked: `self-stretch` on the button makes it correct
   * whatever the wrapper does, and the row check keeps the two existing call
   * sites (and any new one) on the same layout.
   */
  const BUTTON = '/src/components/transactions/CurrencyPickerButton.tsx';

  it('gives CurrencyPickerButton self-stretch, so any wrapper renders it full height', () => {
    const source = sources[BUTTON];
    expect(source, `${BUTTON} not found -- update BUTTON in this test`).toBeTruthy();
    // Guard against the class being dropped in a future restyle: align-self
    // beats the parent's align-items, so this is what makes the button
    // independent of how it is laid out.
    expect(source).toMatch(/className="[^"]*\bself-stretch\b/);
  });

  it('renders the picker only inside an items-stretch row', () => {
    const ROW = /<div className="flex items-stretch space-x-2">/;
    // Building the picker and handing it down as `currencyPickerSlot={...}` is
    // not laying it out -- TransactionForm does exactly that, and the row lives
    // in NormalTransactionFields / SplitTransactionFields, which receive it. So
    // a file that passes the slot on is a producer, and the check applies to
    // whoever actually renders it beside an input.
    const HANDS_OFF = /currencyPickerSlot=\{/;
    const offenders = productionSources()
      .filter(([path]) => path !== BUTTON)
      .filter(
        ([, content]) =>
          /<CurrencyPickerButton\b/.test(content) || /\{currencyPickerSlot\}/.test(content),
      )
      .filter(([, content]) => !HANDS_OFF.test(content))
      .filter(([, content]) => !ROW.test(content))
      .map(([path]) => path);

    // `items-start` (or the default `stretch` being overridden) leaves the
    // button at its content height. Use the same row the other call sites do.
    expect(offenders).toEqual([]);
  });
});

describe('the GEM report links through its shared wrappers', () => {
  /**
   * Every account and instrument the report names is a way into that account
   * or instrument, and they all have to look the same doing it. A hand-rolled
   * `<Link>` in one card gets its own colour and its own hover, which is how
   * the report ended up with permanently blue anchors in one tab and plain
   * text everywhere else. `GemSecurityLink` / `GemAccountLink` in
   * `GemPrimitives.tsx` are the only place that markup lives.
   */
  const WRAPPERS = "/src/components/strategies/GemPrimitives.tsx";

  it("has no ad-hoc security or account link in a strategy component", () => {
    const offenders = productionSources()
      .filter(
        ([path]) =>
          path.startsWith("/src/components/strategies/") && path !== WRAPPERS,
      )
      .filter(([, source]) => /href={`\/(securities|accounts)\//.test(source))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});

describe("a tab bar is the shared Tabs component", () => {
  /**
   * `ui/Tabs.tsx` is the only tablist in the app. It carries the roving
   * tabindex, the arrow/Home/End keys, the horizontal scroll and the `pb-px`
   * that keeps a stray vertical scrollbar off the row, plus the id convention
   * (`tabId`/`tabPanelId`) a panel points back at.
   *
   * The rule is a scan because a second tablist is never wrong on its own file's
   * terms -- it simply re-derives all of that, and drops some of it. The GEM
   * report's hand-rolled bar set `aria-controls` on all five tabs while only the
   * selected tab's panel is rendered, so four of them named an element that was
   * not in the document. `Tabs.tsx` sets the attribute for the selected tab
   * only, with a comment saying why; that is the fix a call site inherits by
   * using it.
   */
  const SHARED = "/src/components/ui/Tabs.tsx";
  const TABLIST = /role=["']tablist["']/;

  it("declares role=tablist in exactly one place", () => {
    const offenders = productionSources()
      .filter(([path]) => path !== SHARED)
      .filter(([, source]) => TABLIST.test(source))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it("still finds the shared tablist, so the rule cannot pass by accident", () => {
    const shared = sources[SHARED];
    expect(
      shared,
      `${SHARED} not found -- update SHARED in this test`,
    ).toBeTruthy();
    expect(TABLIST.test(shared)).toBe(true);
  });
});

describe("the way back to a section list is the shared link", () => {
  /**
   * Every report page returns to the list the same way: a chevron and "Back to
   * Reports" above the title, matching the account, payee, category and
   * security detail pages. `BackToReportsLink` is that control. The rule is a
   * scan because a hand-rolled one is never wrong on its own file's terms --
   * the GEM report had a breadcrumb, the two report viewers had an outline
   * button among their actions, and each looked deliberate until they were on
   * screen next to each other.
   *
   * Matched on the pair (a back chevron *and* a link to `/reports`), so the
   * editor pages' "Back to Reports" cancel button -- which is an action on a
   * form, not the way out of a detail page -- is deliberately left alone.
   */
  const SHARED = "/src/components/reports/BackToReportsLink.tsx";
  const REPORTS_HREF = /href=["']\/reports["']/;
  const BACK_CHEVRON = /<ChevronLeftIcon\b/;

  it("has no hand-rolled back-to-reports link", () => {
    const offenders = productionSources()
      .filter(([path]) => path !== SHARED)
      .filter(
        ([, source]) => REPORTS_HREF.test(source) && BACK_CHEVRON.test(source),
      )
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it("still finds the shared link, so the rule cannot pass by accident", () => {
    const shared = sources[SHARED];
    expect(shared, `${SHARED} not found -- update SHARED in this test`).toBeTruthy();
    expect(REPORTS_HREF.test(shared)).toBe(true);
    expect(BACK_CHEVRON.test(shared)).toBe(true);
  });
});

describe("nothing interactive is nested inside a button", () => {
  /**
   * `<button>`'s content model forbids interactive descendants, and the
   * failure is not cosmetic: the parser closes the outer button at the inner
   * tag, so the click target is truncated to whatever preceded it and the
   * server's markup no longer matches what React builds on the client.
   *
   * This landed the moment `InfoTooltip`'s trigger changed from a `<span>` to
   * a `<button>` -- correct in isolation, and it broke the one card that had
   * put a tooltip inside a clickable card. That is the shape of mistake a
   * scan catches and a component test cannot: neither file is wrong on its
   * own, only the pair is, and the pair is discovered by grepping.
   *
   * Fix it at the call site by making the two siblings, not by demoting the
   * inner control to a non-focusable element -- a tab stop that announces
   * nothing is how `InfoTooltip` got here in the first place.
   */
  const INTERACTIVE = /<(button|a|select|textarea|input|InfoTooltip)[\s/>]/g;

  /**
   * Blank out comment bodies, keeping the file's length and line breaks so
   * reported line numbers still point at the source. Prose in this repo
   * discusses `<button>` constantly, and a scan that reads its own
   * explanation as a violation is worse than no scan.
   */
  function withoutComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
      .replace(
        /(^|[^:])\/\/[^\n]*/g,
        (match, before: string) =>
          before + " ".repeat(match.length - before.length),
      );
  }

  /** [start, end) of every non-self-closing `<button>` element's children. */
  function buttonBodies(source: string): Array<[number, number]> {
    const bodies: Array<[number, number]> = [];
    const opens = /<button(?=[\s/>])/g;
    let open: RegExpExecArray | null;
    while ((open = opens.exec(source))) {
      const tagEnd = source.indexOf(">", open.index);
      if (tagEnd === -1) continue;
      // `<button ... />` has no children to search.
      if (source[tagEnd - 1] === "/") continue;
      let depth = 1;
      let cursor = tagEnd + 1;
      while (depth > 0) {
        const close = source.indexOf("</button>", cursor);
        if (close === -1) break;
        const nested = source.slice(cursor).search(/<button(?=[\s/>])/);
        const nestedAt = nested === -1 ? Infinity : cursor + nested;
        if (nestedAt < close) {
          const nestedEnd = source.indexOf(">", nestedAt);
          if (source[nestedEnd - 1] !== "/") depth += 1;
          cursor = nestedEnd + 1;
          continue;
        }
        depth -= 1;
        cursor = close + "</button>".length;
        if (depth === 0) bodies.push([tagEnd + 1, close]);
      }
    }
    return bodies;
  }

  it("puts no control, link or tooltip inside a <button>", () => {
    const offenders: string[] = [];
    for (const [path, raw] of productionSources()) {
      if (!path.endsWith(".tsx")) continue;
      const source = withoutComments(raw);
      for (const [start, end] of buttonBodies(source)) {
        const body = source.slice(start, end);
        INTERACTIVE.lastIndex = 0;
        let hit: RegExpExecArray | null;
        while ((hit = INTERACTIVE.exec(body))) {
          const line = source.slice(0, start + hit.index).split("\n").length;
          offenders.push(`${path}:${line} nests <${hit[1]}> in a <button>`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("still recognises a nested control, so the rule cannot pass by accident", () => {
    // The scanner skips self-closing buttons and blanks out comments, and
    // both of those could silently grow into "skips everything". This is the
    // markup the guard exists for.
    const sample = `
      {/* a <button> inside a comment is not a violation */}
      <button type="button" />
      <button onClick={go}>
        <span>Account</span>
        <InfoTooltip text={help} />
      </button>
    `;
    const bodies = buttonBodies(withoutComments(sample));
    expect(bodies).toHaveLength(1);
    const body = sample.slice(bodies[0][0], bodies[0][1]);
    expect(/<InfoTooltip[\s/>]/.test(body)).toBe(true);
  });
});

describe("an unknown value is not drawn as measured data", () => {
  /**
   * `connectNulls` draws a straight segment across a gap. It is
   * indistinguishable from measured data, and a tooltip saying "unknown" under
   * the cursor does not undo it -- so the server's careful `null` is thrown away
   * in the last hundred pixels (`frontend/CLAUDE.md`,
   * `docs/time-series-contract.md` rule 3).
   *
   * The rule is `connectNulls={false}`. This scan is what tells you which files
   * broke it: the Security Performance comparison chart carried a bare
   * `connectNulls` for its whole life and nothing said so.
   *
   * The baseline is **shrink-only**. Each entry is a chart that predates the
   * guard, with the reason it is tolerated; fixing one means deleting its line.
   */
  const BASELINE: ReadonlyArray<{ file: string; reason: string }> = [
    {
      file: "/src/components/accounts/loan-detail/PayoffComparisonChart.tsx",
      reason:
        "Amortization curves are computed, not observed: every point exists by " +
        "construction, so a null there is a series that has ended rather than a " +
        "month nobody measured.",
    },
  ];

  /** A `connectNulls` with no `={false}` beside it. */
  const BARE_CONNECT_NULLS = /connectNulls(?!\s*=\s*\{\s*false\s*\})/;

  it("has no bare connectNulls outside the recorded baseline", () => {
    const allowed = new Set(BASELINE.map((entry) => entry.file));
    const offenders = productionSources()
      .filter(([, content]) => content.includes("recharts"))
      .filter(([, content]) =>
        content
          .split("\n")
          .some((line) => BARE_CONNECT_NULLS.test(line)),
      )
      .map(([path]) => path)
      .filter((path) => !allowed.has(path));

    expect(offenders).toEqual([]);
  });

  it("keeps the baseline shrink-only", () => {
    const offending = new Set(
      productionSources()
        .filter(([, content]) =>
          content.split("\n").some((line) => BARE_CONNECT_NULLS.test(line)),
        )
        .map(([path]) => path),
    );
    expect(
      BASELINE.map((entry) => entry.file).filter((file) => !offending.has(file)),
    ).toEqual([]);
  });
});

describe("an account picker labels its options through the shared hook", () => {
  /**
   * A linked investment pair is one account, stored as two rows whose names
   * carry a " - Cash"/" - Brokerage" suffix the user never chose. A picker that
   * builds its label from `account.name` shows that suffix, so money pickers
   * offered "TFSA - Cash" while every other surface called it "TFSA".
   *
   * `useAccountOptionLabel` is the one place that label is built. The scan is
   * what makes it stick: a new picker looks perfectly reasonable on its own.
   */
  const PICKER_TREES = [
    "/src/components/transactions/",
    "/src/components/scheduled-transactions/",
  ];
  /** A label built straight from the stored name, e.g. `(a) => `${a.name}...`. */
  const RAW_NAME_LABEL = /\(\s*\w+\s*\)\s*=>\s*`\$\{\s*\w+\.name\s*\}/;

  it("builds no account option label from the stored account name", () => {
    const offenders = productionSources()
      .filter(([path]) => PICKER_TREES.some((tree) => path.startsWith(tree)))
      .filter(([, content]) => content.includes("buildAccountDropdownOptions"))
      .filter(([, content]) => RAW_NAME_LABEL.test(content))
      .map(([path]) => path);

    expect(
      offenders,
      "Label account options with useAccountOptionLabel() so a linked cash " +
        "half reads as the account the user knows, not its stored ledger name.",
    ).toEqual([]);
  });

  it("passes the shared labeller wherever it builds account options", () => {
    const missing = productionSources()
      .filter(([path]) => PICKER_TREES.some((tree) => path.startsWith(tree)))
      .filter(([, content]) => content.includes("buildAccountDropdownOptions("))
      .filter(([, content]) => !content.includes("useAccountOptionLabel"))
      .map(([path]) => path);

    expect(
      missing,
      "Every account picker in these trees labels through useAccountOptionLabel().",
    ).toEqual([]);
  });
});

describe("a CSV file is written by the shared exporter", () => {
  /** The one file allowed to build a CSV -- it *is* the writer. */
  const WRITER = "/src/lib/csv-export.ts";
  /** A `text/csv` Blob: the last step of writing one by hand. */
  const CSV_BLOB = /new Blob\([\s\S]{0,200}?text\/csv/;
  /** RFC 4180 quoting, doubled quotes and all. */
  const CSV_QUOTING = /replace\(\/"\/g,\s*['"]""['"]\)/;

  it("builds no CSV outside the shared writer", () => {
    const offenders = productionSources()
      .filter(([path]) => path !== WRITER)
      .filter(
        ([, content]) => CSV_BLOB.test(content) || CSV_QUOTING.test(content),
      )
      .map(([path]) => path);

    // A second writer is a second set of answers to the questions this one
    // already answers: the BOM, CRLF line endings, quoting, and which values a
    // spreadsheet would evaluate rather than display. MonteCarloReport had one,
    // and it applied no formula-injection guard at all -- while the shared
    // writer applied it to every negative amount (issue #1134). Neither file
    // looked wrong on its own, which is why this is a scan.
    expect(
      offenders,
      "Write CSV through exportToCsv/exportCsvSections in @/lib/csv-export.",
    ).toEqual([]);
  });

  it("still finds the writer, so the rule cannot pass by accident", () => {
    const writer = sources[WRITER];
    expect(writer, `${WRITER} not found -- update WRITER in this test`).toBeTruthy();
    expect(CSV_BLOB.test(writer)).toBe(true);
    expect(CSV_QUOTING.test(writer)).toBe(true);
  });
});

describe("a transfer's direction is decided in one place", () => {
  /** The one file allowed to turn an amount's sign into a direction. */
  const HELPER = "/src/lib/transfer-label.ts";
  const DIRECTION_TERNARY = /['"]to['"]\s*:\s*['"]from['"]|['"]from['"]\s*:\s*['"]to['"]/;

  it("derives to/from from an amount nowhere else", () => {
    const offenders = productionSources()
      .filter(([path]) => path !== HELPER)
      .filter(([, content]) => DIRECTION_TERNARY.test(content))
      .map(([path]) => path);

    // Money leaving an account went *to* the counterpart and money arriving
    // came *from* it, so both legs of one transfer read differently and each
    // line -- a split line included -- is asked with its own amount. That rule
    // was written out four times in TransactionRow and omitted from both CSV
    // exports, which is how the register showed a counterpart the export did
    // not mention. Call transferDirection().
    expect(
      offenders,
      "Decide a transfer's direction with transferDirection() from @/lib/transfer-label.",
    ).toEqual([]);
  });

  it("still finds the helper, so the rule cannot pass by accident", () => {
    const helper = sources[HELPER];
    expect(helper, `${HELPER} not found -- update HELPER in this test`).toBeTruthy();
    expect(DIRECTION_TERNARY.test(helper)).toBe(true);
  });
});

describe("a transaction status cell is the shared StatusCellButton", () => {
  /** The one file allowed to render the dense status letters -- it IS the cell. */
  const WRAPPER = "/src/components/transactions/StatusCellButton.tsx";
  // The dense-label catalog keys fingerprint a hand-rolled status cell: any
  // second copy has to read them to draw the C/R/V/pending letters.
  const DENSE_LABEL_KEY =
    /list\.status\.(?:reconciledDense|clearedDense|voidDense|pendingDense)/;

  it("reads the dense status labels only inside the shared cell", () => {
    const offenders = productionSources()
      .filter(([path]) => path !== WRAPPER)
      .filter(([, content]) => DENSE_LABEL_KEY.test(content))
      .map(([path]) => path);

    // The cash register and the investment register share one status cell so
    // the two cannot drift on colours, labels, or what a click means. A second
    // inline copy is the mistake this rule was written after: the investment
    // register would have grown its own near-copy of TransactionRow's cell.
    expect(offenders).toEqual([]);
  });

  it("still finds the shared cell, so the rule cannot pass by accident", () => {
    const wrapper = sources[WRAPPER];
    expect(
      wrapper,
      `${WRAPPER} not found -- update WRAPPER in this test`,
    ).toBeTruthy();
    expect(DENSE_LABEL_KEY.test(wrapper)).toBe(true);
  });
});

describe("a category typed into a picker is created by one helper", () => {
  /** The one module allowed to turn typed picker text into a category. */
  const HELPER = "/src/lib/category-create.ts";
  /**
   * The Categories page's own create form is a different thing: it collects a
   * name, parent, colour and icon from real fields, so there is no typed text
   * to parse and no `Parent: Child` shorthand to honour.
   */
  const FULL_FORM = "/src/app/categories/page.tsx";
  /**
   * Both doors: the caller's own ledger, and the owner's ledger behind a joint
   * account. A second call site for either is a second set of rules.
   */
  const CREATE_CALL =
    /categoriesApi\.create\(|delegationApi\.createJointCategory\(/;

  it("has no second inline category-creation path", () => {
    const offenders = productionSources()
      .filter(([path]) => path !== HELPER && path !== FULL_FORM)
      .filter(([, content]) => CREATE_CALL.test(content))
      .map(([path]) => path);

    // Three copies of this existed -- the transaction form, the account form's
    // asset category, and the scheduled transaction form -- and the third had
    // neither title casing nor the `Parent: Child` shorthand, so `travel:
    // hotels` became a child of Travel in two fields and a single flat category
    // named "Travel: Hotels" in the other. Use `createCategoryFromInput`.
    expect(offenders).toEqual([]);
  });

  it("still finds the helper, so the rule cannot pass by accident", () => {
    const helper = sources[HELPER];
    expect(helper, `${HELPER} not found -- update HELPER in this test`).toBeTruthy();
    expect(/export async function createCategoryFromInput\(/.test(helper)).toBe(true);
  });

  it("the helper itself holds both ledgers' create calls", () => {
    // A joint account's picker creates on the OWNER's ledger, so the helper
    // owns that call too -- if it moves out, the rule above is scanning for a
    // string nothing writes any more and passes for the wrong reason.
    const helper = sources[HELPER];
    expect(/categoriesApi\.create/.test(helper)).toBe(true);
    expect(/delegationApi\.createJointCategory\(/.test(helper)).toBe(true);
  });
});

describe("a register that draws a Balance column is given the balance", () => {
  /** The list that renders the column and computes the running balances. */
  const LIST = "/src/components/transactions/TransactionList.tsx";

  /** The attribute text of every `<TransactionList ...>` opening tag in a file. */
  function transactionListTags(content: string): string[] {
    const tags: string[] = [];
    const open = /<TransactionList[\s>]/g;
    let match: RegExpExecArray | null;
    while ((match = open.exec(content)) !== null) {
      let depth = 0;
      for (let i = match.index; i < content.length; i++) {
        if (content[i] === "{") depth++;
        else if (content[i] === "}") depth--;
        else if (content[i] === ">" && depth === 0) {
          tags.push(content.slice(match.index, i));
          break;
        }
      }
    }
    return tags;
  }

  it("supplies startingBalance wherever isSingleAccountView is set", () => {
    const offenders = productionSources()
      .flatMap(([path, content]) =>
        transactionListTags(content).map((tag) => [path, tag] as const),
      )
      .filter(([, tag]) => /\bisSingleAccountView\b/.test(tag))
      .filter(([, tag]) => !/\bstartingBalance\b/.test(tag))
      .map(([path]) => path);

    // `isSingleAccountView` alone draws the Balance column, and the number in
    // it comes from the backend's `startingBalance` run down the page. The
    // investment register panel read the rows off the response and dropped that
    // field, so the column it had just asked for rendered "-" on every row
    // (issue #1188). The two are one decision: ask for the column, supply the
    // balance, and take both from the same response.
    expect(offenders).toEqual([]);
  });

  it("still needs the balance to draw the column, so the rule cannot pass by accident", () => {
    // Were the list to start deriving the running balance itself, this check
    // would be demanding a prop nothing reads. This fails first and says so.
    const list = sources[LIST];
    expect(list, `${LIST} not found -- update LIST in this test`).toBeTruthy();
    expect(/isSingleAccountView \|\| startingBalance !== undefined/.test(list)).toBe(
      true,
    );
  });
});

describe("TransactionList performs its own delete", () => {
  /** The list that owns the confirmation, the API call and the toast. */
  const LIST = "/src/components/transactions/TransactionList.tsx";
  /** Every way a caller could delete the row a second time. */
  const DELETES =
    /(?:transactionsApi\.(?:delete|deleteTransfer)|investmentsApi\.deleteTransaction)\(/;

  /**
   * The expression a file hands to `<TransactionList onDeleted={...}>`, resolved
   * to the callback's own source where it is passed by name. Brace-matched
   * rather than regex-terminated, because the handler is usually a `useCallback`
   * whose body contains braces of its own.
   */
  function deletedHandlerSources(content: string): string[] {
    const bodies: string[] = [];
    const prop = /onDeleted=\{/g;
    while (prop.exec(content) !== null) {
      const expression = braceMatched(content, prop.lastIndex - 1);
      const identifier = expression.trim();
      bodies.push(
        /^[A-Za-z_$][\w$]*$/.test(identifier)
          ? definitionOf(content, identifier)
          : expression,
      );
    }
    return bodies;
  }

  /** The text between `{` at `open` and its matching `}`. */
  function braceMatched(content: string, open: number): string {
    let depth = 0;
    for (let i = open; i < content.length; i++) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}" && --depth === 0)
        return content.slice(open + 1, i);
    }
    return content.slice(open + 1);
  }

  /**
   * The initialiser of `const <name> = ...`, taken to the `;` at nesting depth
   * zero. Returns the empty string when the name is not defined in this file --
   * an imported handler is out of reach of a source scan, and saying so by
   * finding nothing is better than guessing.
   */
  function definitionOf(content: string, name: string): string {
    const start = content.search(
      new RegExp(`\\bconst\\s+${name}\\s*=`),
    );
    if (start < 0) return "";
    let depth = 0;
    for (let i = start; i < content.length; i++) {
      const c = content[i];
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") depth--;
      else if (c === ";" && depth === 0) return content.slice(start, i);
    }
    return content.slice(start);
  }

  it("is never asked to delete a row twice", () => {
    const offenders = productionSources()
      .filter(([, content]) => content.includes("<TransactionList"))
      .filter(([, content]) => deletedHandlerSources(content).some((body) => DELETES.test(body)))
      .map(([path]) => path);

    // `onDeleted` reports a delete this list has already performed; it is not a
    // request to perform one. The investment register panel gave it a handler
    // shaped like `InvestmentTransactionList`'s -- whose `onDelete` *is* the
    // performer -- so every cash row was deleted twice and the 404 from the
    // second attempt landed beside the success toast (issue #1192). Reach for
    // `onRefresh` to reload after a delete.
    expect(offenders).toEqual([]);
  });

  it("still owns the delete, so the rule cannot pass by accident", () => {
    // Were the contract to flip -- the list asking its parent to delete -- the
    // check above would be policing the opposite of the truth. This fails first
    // and says what to update.
    const list = sources[LIST];
    expect(list, `${LIST} not found -- update LIST in this test`).toBeTruthy();
    expect(DELETES.test(list)).toBe(true);
    expect(/onDeleted\?\.\(/.test(list)).toBe(true);
  });
});

describe("a report never unmounts the date field being typed into", () => {
  /**
   * A component that answers a load with `if (isLoading) return <Skeleton/>`
   * returns a *different tree*, and React unmounts whatever the previous tree
   * held at that position -- including the date input the user is mid-way
   * through typing. On the Net Worth report every keystroke that completed a
   * date started a reload, so focus was ejected after two characters and the
   * year could never be finished (issue #1201).
   *
   * The rule is narrow on purpose: it applies to a component that both hosts a
   * date control **and** takes its loading flag from `useReportData`, whose
   * fetch is re-run by the very date change being typed. A one-shot
   * prerequisite load -- `isLoadingData` on the report *forms*, the register's
   * first page -- is not the same thing: it resolves before the date field
   * exists and never fires again, so an early return there costs nothing.
   *
   * The fix is to render the load and error states inside the one tree the
   * component always returns. Duplicating the controls block into a second
   * `return` is not a fix, and looked like one for a while: `CashFlowReport`
   * did exactly that, but its two trees put the controls at different child
   * indexes, so React reconciled the block against the summary cards and
   * unmounted it anyway. That is why a second `<DateRangeSelector`/`<DateInput`
   * in one file fails too.
   */
  const DATE_CONTROL = /<DateInput\b|showCustom/;
  // Negated classes already cross newlines, so no dotAll flag is needed (and
  // the ES2017 target would reject one).
  const REPORT_DATA_LOADING = /\{[^}]*\bisLoading\b[^}]*\}\s*=\s*useReportData\(/;
  const EARLY_RETURN =
    /\bif \(\s*!?(?:isLoading|error)\b[^)\n]*\)\s*\{?\s*(?:\/\/[^\n]*\n\s*)*return/;

  const reportsWithDateControls = () =>
    productionSources().filter(
      ([, source]) => DATE_CONTROL.test(source) && REPORT_DATA_LOADING.test(source),
    );

  it("renders one tree, with the load and error states inside it", () => {
    const offenders = reportsWithDateControls()
      .filter(([, source]) => EARLY_RETURN.test(source))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it("renders its date controls in exactly one place", () => {
    // A report legitimately holds two date *inputs* -- a range has two ends --
    // so the thing to count is the controls block itself.
    const offenders = reportsWithDateControls()
      .filter(([, source]) => (source.match(/showCustom/g) ?? []).length > 1)
      .map(([path]) => path);

    // Two copies of the same controls block means two trees, whatever the
    // second one was added to fix.
    expect(offenders).toEqual([]);
  });

  it("still recognizes the reports it is meant to police", () => {
    // Were `useReportData` renamed, or the date controls moved behind another
    // component, both checks above would pass over an empty set. The reports
    // with a custom date range are the subject; there are several.
    const subjects = reportsWithDateControls().map(([path]) => path);
    expect(subjects.length).toBeGreaterThan(4);
    expect(subjects).toContain("/src/components/reports/NetWorthReport.tsx");
  });
});

describe("the pager below a table is the shared ListBottomPager", () => {
  /** The one file allowed to build that pager -- it *is* the pager. */
  const PAGER = "/src/components/ui/ListBottomPager.tsx";
  /** Its sibling above the rows, and the control both of them wrap. */
  const TOOLBAR_PATH = "/src/components/ui/ListTopToolbar.tsx";
  const PAGINATION_PATH = "/src/components/ui/Pagination.tsx";
  /**
   * Rendering the raw pager. Composing `ListTopToolbar` or `ListBottomPager`
   * puts a pager on a table without matching this; dropping a `<Pagination>`
   * under a table by hand does.
   */
  const RAW_PAGER = /<Pagination\b/;
  /**
   * The standalone list pages, which draw their own pager and predate both
   * wrappers. Their rows are not a register: there is no top strip, no density
   * toggle and no single-page count, so there is nothing here for them to
   * compose. Listed rather than pattern-matched, so adding a fifth is a
   * decision somebody makes on purpose.
   */
  const STANDALONE_LISTS = [
    "/src/app/currencies/page.tsx",
    "/src/app/institutions/page.tsx",
    "/src/app/payees/page.tsx",
    "/src/app/securities/page.tsx",
  ];

  it("has no hand-placed pager under a register's table", () => {
    const offenders = productionSources()
      .filter(([path]) => path !== PAGER && path !== TOOLBAR_PATH && path !== PAGINATION_PATH)
      .filter(([path]) => !STANDALONE_LISTS.includes(path))
      .filter(([, content]) => RAW_PAGER.test(content))
      .map(([path]) => path);

    // The Transactions page drew this block inline, and the two investment
    // registers -- which page exactly the same way -- drew nothing at all, so
    // the end of a page of trades had no controls on it. One component, and
    // every register ends the same way.
    expect(offenders).toEqual([]);
  });

  it("still finds the pager, so the rule cannot pass by accident", () => {
    const pager = sources[PAGER];
    expect(pager, `${PAGER} not found -- update PAGER in this test`).toBeTruthy();
    expect(RAW_PAGER.test(pager)).toBe(true);
    for (const path of STANDALONE_LISTS) {
      expect(
        sources[path],
        `${path} not found -- update STANDALONE_LISTS in this test`,
      ).toBeTruthy();
    }
  });

  /**
   * Every register that pages from the strip above its rows pages from below
   * them too. The two ends are one decision, and it was the halves disagreeing
   * -- top on one register, bottom on the other -- that this whole family of
   * rules exists to stop.
   */
  it("gives every surface that draws the top strip a bottom pager as well", () => {
    // The surfaces that own a register's paging state -- the file that hands
    // the list its `onPageChange` is the one that must also draw the far end of
    // it, because the top strip lives inside the list and this does not.
    //
    // Deliberately not every paging surface: a tab inside a detail panel ends
    // with the next tab rather than with a pager, and the standalone lists
    // above compose `Pagination` under their own cards.
    const REGISTERS = [
      "/src/app/transactions/page.tsx",
      "/src/app/investments/page.tsx",
      "/src/components/investments/InvestmentRegisterPanel.tsx",
    ];

    const missing = REGISTERS.filter((path) => {
      expect(
        sources[path],
        `${path} not found -- update REGISTERS in this test`,
      ).toBeTruthy();
      return !/ListBottomPager/.test(sources[path]);
    });

    expect(missing).toEqual([]);
  });
});

describe("the bar above a table is the shared ListTopToolbar", () => {
  /** The one file allowed to build that bar -- it *is* the bar. */
  const TOOLBAR = "/src/components/ui/ListTopToolbar.tsx";
  /** Where the bar's buttons ride: `Pagination`'s slot for them. */
  const SLOT = /infoRight\s*\??[=:]/;
  /** The component that defines the slot, which must keep naming it. */
  const PAGINATION = "/src/components/ui/Pagination.tsx";

  it("hands the pager its toolbar buttons from one place", () => {
    const offenders = productionSources()
      .filter(([path]) => path !== TOOLBAR && path !== PAGINATION)
      .filter(([, content]) => SLOT.test(content))
      .map(([path]) => path);

    // A hand-rolled strip is how the two registers of one investment account
    // drifted apart: the cash side paged from above its rows with the density
    // toggle beside the pager, and the brokerage side paged from below the
    // table with the toggle up in the heading -- one toggle apart, on the same
    // page. Compose the bar from `ListTopToolbar` instead of rebuilding it.
    expect(offenders).toEqual([]);
  });

  it("still finds the bar and its slot, so the rule cannot pass by accident", () => {
    // Were either renamed, the check above would police an empty set. This
    // fails first and says what to update.
    const toolbar = sources[TOOLBAR];
    expect(toolbar, `${TOOLBAR} not found -- update TOOLBAR in this test`).toBeTruthy();
    expect(SLOT.test(toolbar)).toBe(true);
    const pagination = sources[PAGINATION];
    expect(pagination, `${PAGINATION} not found -- update PAGINATION in this test`).toBeTruthy();
    expect(SLOT.test(pagination)).toBe(true);
  });
});

describe("a panel card is the shared Card surface", () => {
  /**
   * `CARD_CLASS` in `components/ui/Card.tsx` is the one card surface --
   * background, radius, shadow and (new with it) the border that keeps a card
   * legible on the colour themes where the weakest shadow disappears. Before
   * it existed the same trio was inlined hundreds of times, in at least three
   * different orderings, and no two surfaces could be restyled together.
   *
   * The scan keys on the fingerprint every ordering shares: one className line
   * carrying `bg-white dark:bg-gray-800`, `rounded-lg` and a `shadow`. A menu
   * or tooltip on `rounded-md` is deliberately out of scope.
   *
   * The baseline is **shrink-only**: each entry predates the primitive.
   * Converting a file to `Card` / `CARD_CLASS` means deleting its line here.
   * New code takes the primitive from the start.
   */
  const CARD = "/src/components/ui/Card.tsx";
  const CARD_FINGERPRINT = (line: string) =>
    line.includes("bg-white dark:bg-gray-800") &&
    line.includes("rounded-lg") &&
    line.includes("shadow");

  const BASELINE: ReadonlyArray<string> = [
    "/src/app/accounts/[id]/page.tsx",
    "/src/app/bills/page.tsx",
    "/src/app/budgets/[id]/edit/page.tsx",
    "/src/app/budgets/[id]/page.tsx",
    "/src/app/budgets/create/page.tsx",
    "/src/app/budgets/page.tsx",
    "/src/app/dashboard/loading.tsx",
    "/src/app/investments/page.tsx",
    "/src/app/reconcile/page.tsx",
    "/src/app/reports/[reportId]/page.tsx",
    "/src/app/reports/loading.tsx",
    "/src/app/reports/page.tsx",
    "/src/app/settings/emergency-access/page.tsx",
    "/src/app/settings/loading.tsx",
    "/src/app/settings/page.tsx",
    "/src/components/accounts/asset-detail/AssetDetailView.tsx",
    "/src/components/accounts/asset-detail/EquityPanel.tsx",
    "/src/components/accounts/banking-detail/BankingDetailView.tsx",
    "/src/components/accounts/banking-detail/CashFlowMiniReport.tsx",
    "/src/components/accounts/credit-card-detail/CreditCardDetailView.tsx",
    "/src/components/accounts/credit-card-detail/InterestAndFeesPanel.tsx",
    "/src/components/accounts/credit-card-detail/PayoffCalculator.tsx",
    "/src/components/accounts/credit-card-detail/SpendingBreakdown.tsx",
    "/src/components/accounts/credit-card-detail/StatementPanel.tsx",
    "/src/components/accounts/investment-detail/InvestmentIncomePanel.tsx",
    "/src/components/accounts/loan-detail/AmortizationScheduleTable.tsx",
    "/src/components/accounts/loan-detail/ComparisonSummaryCards.tsx",
    "/src/components/accounts/loan-detail/LineOfCreditView.tsx",
    "/src/components/accounts/loan-detail/OverpaymentSimulator.tsx",
    "/src/components/accounts/loan-detail/PayoffComparisonChart.tsx",
    "/src/components/accounts/loan-detail/RateHistorySidebar.tsx",
    "/src/components/accounts/loan-detail/ScenarioComparisonChart.tsx",
    "/src/components/accounts/shared/ForeignCurrencyFeeChart.tsx",
    "/src/components/accounts/shared/ForeignCurrencyFeesSection.tsx",
    "/src/components/accounts/shared/RecurringChargesPanel.tsx",
    "/src/components/accounts/shared/SummaryCardGrid.tsx",
    "/src/components/accounts/shared/TopGroupsPanel.tsx",
    "/src/components/ai/ResultChart.tsx",
    "/src/components/bills/CashFlowForecastChart.tsx",
    "/src/components/budgets/Budget503020Summary.tsx",
    "/src/components/budgets/BudgetAlertList.tsx",
    "/src/components/budgets/BudgetCategoryList.tsx",
    "/src/components/budgets/BudgetCategoryTrend.tsx",
    "/src/components/budgets/BudgetFlexGroupCard.tsx",
    "/src/components/budgets/BudgetHealthGauge.tsx",
    "/src/components/budgets/BudgetHeatmap.tsx",
    "/src/components/budgets/BudgetPeriodDetail.tsx",
    "/src/components/budgets/BudgetScenarioPlanner.tsx",
    "/src/components/budgets/BudgetTrendChart.tsx",
    "/src/components/budgets/BudgetUpcomingBills.tsx",
    "/src/components/budgets/BudgetVelocityWidget.tsx",
    "/src/components/budgets/BudgetWizardCategories.tsx",
    "/src/components/budgets/BudgetWizardReview.tsx",
    "/src/components/budgets/BudgetWizardStrategy.tsx",
    "/src/components/budgets/BudgetZeroBasedBar.tsx",
        "/src/components/dashboard/ExpensesPieChart.tsx",
            "/src/components/dashboard/IncomeExpensesBarChart.tsx",
            "/src/components/import/CompleteStep.tsx",
    "/src/components/import/CsvColumnMappingStep.tsx",
    "/src/components/import/MapAccountsStep.tsx",
    "/src/components/import/MapCategoriesStep.tsx",
    "/src/components/import/MapSecuritiesStep.tsx",
    "/src/components/import/ReviewStep.tsx",
    "/src/components/import/SelectAccountStep.tsx",
    "/src/components/import/UploadStep.tsx",
    "/src/components/investments/AssetAllocationChart.tsx",
    "/src/components/investments/GroupedHoldingsList.tsx",
    "/src/components/investments/HoldingsList.tsx",
    "/src/components/investments/InvestmentRegisterPanel.tsx",
    "/src/components/investments/InvestmentTransactionList.tsx",
    "/src/components/investments/InvestmentValueChart.tsx",
    "/src/components/investments/PortfolioSummaryCard.tsx",
    "/src/components/layout/ActionHistoryPanel.tsx",
    "/src/components/payees/detail/PayeeRecurringPanel.tsx",
    "/src/components/reconcile/ReconciliationReminderBadge.tsx",
    // Both keep an inline surface for their chart TOOLTIP -- a floating panel
    // with its own stronger shadow, not the widget card. Their widget
    // surfaces now come from CARD_CLASS; the tooltip shape is hand-rolled in
    // ~44 files and is a separate drift from this one.
    "/src/components/dashboard/AssetsVsLiabilities.tsx",
    "/src/components/dashboard/NetWorthChart.tsx",
    "/src/components/reports/AccountBalancesReport.tsx",
    "/src/components/reports/BillPaymentHistoryReport.tsx",
    "/src/components/reports/BudgetHealthScoreReport.tsx",
    "/src/components/reports/BudgetSeasonalPatternsReport.tsx",
    "/src/components/reports/BudgetTrendReport.tsx",
    "/src/components/reports/BudgetVsActualReport.tsx",
    "/src/components/reports/CashFlowReport.tsx",
    "/src/components/reports/CategoryPerformanceReport.tsx",
    "/src/components/reports/ChartTooltip.tsx",
    "/src/components/reports/CreditUtilizationReport.tsx",
    "/src/components/reports/CurrencyExposureReport.tsx",
    "/src/components/reports/CustomReportForm.tsx",
    "/src/components/reports/CustomReportViewer.tsx",
    "/src/components/reports/DebtPayoffTimelineReport.tsx",
    "/src/components/reports/DividendIncomeReport.tsx",
    "/src/components/reports/DividendYieldGrowthReport.tsx",
    "/src/components/reports/DuplicateTransactionReport.tsx",
    "/src/components/reports/FlexGroupAnalysisReport.tsx",
    "/src/components/reports/ForeignCurrencyFeesReport.tsx",
    "/src/components/reports/GeographicAllocationReport.tsx",
    "/src/components/reports/HealthScoreHistoryReport.tsx",
    "/src/components/reports/IncomeBySourceReport.tsx",
    "/src/components/reports/IncomeVsExpensesReport.tsx",
    "/src/components/reports/InvestmentPerformanceReport.tsx",
    "/src/components/reports/InvestmentReportForm.tsx",
    "/src/components/reports/InvestmentReportViewer.tsx",
    "/src/components/reports/InvestmentTransactionHistoryReport.tsx",
    "/src/components/reports/LoanAmortizationReport.tsx",
    "/src/components/reports/LoanOverpaymentSimulatorReport.tsx",
    "/src/components/reports/MonteCarloChartParts.tsx",
    "/src/components/reports/MonteCarloReport.tsx",
    "/src/components/reports/MonteCarloResultsTable.tsx",
    "/src/components/reports/MonthlyCategoryBreakdownReport.tsx",
    "/src/components/reports/MonthlyComparisonReport.tsx",
    "/src/components/reports/MonthlySpendingTrendReport.tsx",
    "/src/components/reports/NetWorthReport.tsx",
    "/src/components/reports/PortfolioValueReport.tsx",
    "/src/components/reports/RealizedGainsReport.tsx",
    "/src/components/reports/RecurringExpensesReport.tsx",
    "/src/components/reports/ReportChart.tsx",
    "/src/components/reports/ReportError.tsx",
    "/src/components/reports/SavingsRateReport.tsx",
    "/src/components/reports/SeasonalSpendingMapReport.tsx",
    "/src/components/reports/SectorWeightingsReport.tsx",
    "/src/components/reports/SecurityComparisonChart.tsx",
    "/src/components/reports/SecurityPerformanceReport.tsx",
    "/src/components/reports/SecurityTypeAllocationReport.tsx",
    "/src/components/reports/SpendingAnomaliesReport.tsx",
    "/src/components/reports/SpendingByCategoryReport.tsx",
    "/src/components/reports/SpendingByPayeeReport.tsx",
    "/src/components/reports/TaxSummaryReport.tsx",
    "/src/components/reports/UncategorizedTransactionsReport.tsx",
    "/src/components/reports/UpcomingBillsReport.tsx",
    "/src/components/reports/WeekendVsWeekdayReport.tsx",
    "/src/components/reports/YearOverYearReport.tsx",
    "/src/components/reports/account-balances/AccountBalancesControls.tsx",
    "/src/components/reports/monte-carlo/CompareMetricTable.tsx",
    "/src/components/reports/monte-carlo/CompareScenariosView.tsx",
    "/src/components/scheduled-transactions/BillsFilterPanel.tsx",
    "/src/components/settings/AboutSection.tsx",
    "/src/components/settings/ApiAccessSection.tsx",
    "/src/components/settings/AutoBackupSection.tsx",
    "/src/components/settings/BackupRestoreSection.tsx",
    "/src/components/settings/DangerZoneSection.tsx",
    "/src/components/settings/HelpSection.tsx",
    "/src/components/settings/NotificationsSection.tsx",
    "/src/components/settings/PreferencesSection.tsx",
    "/src/components/settings/ProfileSection.tsx",
    "/src/components/settings/SecuritySection.tsx",
    "/src/components/settings/SettingsNav.tsx",
    "/src/components/settings/SharedAccessSection.tsx",
    "/src/components/settings/TourCatalog.tsx",
    "/src/components/settings/ai/AiBubbleToggle.tsx",
    "/src/components/settings/ai/ProviderList.tsx",
    "/src/components/settings/ai/UsageDashboard.tsx",
    "/src/components/transactions/AccountBalancesBarChart.tsx",
    "/src/components/transactions/AccountInfoWidget.tsx",
    "/src/components/transactions/BalanceHistoryChart.tsx",
    "/src/components/transactions/CategoryInfoWidget.tsx",
    "/src/components/transactions/CategoryPayeeBarChart.tsx",
    "/src/components/transactions/PayeeInfoWidget.tsx",
    "/src/components/transactions/TagKeyBreakdownChart.tsx",
    "/src/components/transactions/TransactionFilterPanel.tsx",
    "/src/components/ui/CalendarPopover.tsx",
    "/src/components/ui/Modal.tsx",
    "/src/components/ui/Pagination.tsx",
  ];

  function filesWithInlineCard(): string[] {
    return productionSources()
      .filter(([path]) => path !== CARD)
      .filter(([, content]) => content.split("\n").some(CARD_FINGERPRINT))
      .map(([path]) => path);
  }

  it("has no inline card surface outside the recorded baseline", () => {
    const allowed = new Set(BASELINE);
    const offenders = filesWithInlineCard().filter((path) => !allowed.has(path));
    expect(offenders).toEqual([]);
  });

  it("keeps the baseline shrink-only", () => {
    const offending = new Set(filesWithInlineCard());
    expect(BASELINE.filter((file) => !offending.has(file))).toEqual([]);
  });

  it("still finds the shared surface, so the rule cannot pass by accident", () => {
    const card = sources[CARD];
    expect(card, `${CARD} not found -- update CARD in this test`).toBeTruthy();
    expect(card.split("\n").some(CARD_FINGERPRINT)).toBe(true);
  });
});

describe("an auth page renders inside AuthShell", () => {
  /**
   * The centered logo-plus-form shell used to be duplicated across every auth
   * branch -- six near-identical copies, each drifting on its own -- and the
   * form sat bare on the page background, the one surface in the app without
   * a card. `AuthShell` (components/auth/AuthShell.tsx) is the single shell:
   * transparent brand mark (the boxed logo bakes in a white rect and rendered
   * as a white square in dark mode), title, notices, and the shared Card
   * around the body.
   */
  const SHELL = "/src/components/auth/AuthShell.tsx";
  const AUTH_ROUTES = [
    "/src/app/login/page.tsx",
    "/src/app/register/page.tsx",
    "/src/app/forgot-password/page.tsx",
    "/src/app/reset-password/page.tsx",
    "/src/app/change-password/page.tsx",
    "/src/app/verify-email/page.tsx",
    "/src/app/setup-2fa/page.tsx",
  ];
  const HAND_ROLLED_SHELL = "min-h-screen flex items-center justify-center";

  it("imports AuthShell on every auth route", () => {
    const missing = AUTH_ROUTES.filter(
      (path) => !sources[path]?.includes("components/auth/AuthShell"),
    );
    expect(missing).toEqual([]);
  });

  it("has no hand-rolled centered shell on an auth route", () => {
    const offenders = AUTH_ROUTES.filter((path) =>
      sources[path]?.includes(HAND_ROLLED_SHELL),
    );
    // A new branch that rebuilds the wrapper is the drift this rule exists to
    // stop -- render the branch through AuthShell (plain, if it has no card).
    expect(offenders).toEqual([]);
  });

  it("still finds the shell, so the rule cannot pass by accident", () => {
    const shell = sources[SHELL];
    expect(shell, `${SHELL} not found -- update SHELL in this test`).toBeTruthy();
    expect(shell.includes(HAND_ROLLED_SHELL)).toBe(true);
    expect(shell.includes("monize-logo-transparent")).toBe(true);
  });
});

describe("nav links and their icons come from lib/nav-links", () => {
  /**
   * The link arrays and the per-route icon map live together in
   * `lib/nav-links.ts`, so `nav-links.test.ts` can hold "every nav route has
   * an icon". A nav surface that declares its own links (or reaches for
   * Heroicons directly per row) re-opens the drift this closed: a route added
   * in one place, bare in the other.
   */
  const NAV_SOURCES = [
    "/src/components/layout/AppHeader.tsx",
    "/src/components/layout/MobileNavDrawer.tsx",
  ];

  it("keeps both nav surfaces on the shared module", () => {
    const missing = NAV_SOURCES.filter(
      (path) => !sources[path]?.includes("@/lib/nav-links"),
    );
    expect(missing).toEqual([]);
  });

  it("still finds the module, so the rule cannot pass by accident", () => {
    const mod = sources["/src/lib/nav-links.ts"];
    expect(mod, "lib/nav-links.ts not found -- update this test").toBeTruthy();
    expect(mod.includes("NAV_ICONS")).toBe(true);
  });
});

describe("account-type colours and icons come from lib/account-type-meta", () => {
  /**
   * The type-to-pill-colour switch lived inside `AccountList` and the type had
   * no icon anywhere; any other surface wanting the treatment had to copy the
   * switch. `lib/account-type-meta.tsx` is the one mapping now (pill class +
   * icon per type). A second mapping drifts the moment either changes.
   *
   * Fingerprint: an AccountType literal within reach of a `bg-*-100
   * text-*-800` pill class, in either order.
   */
  const MODULE = "/src/lib/account-type-meta.tsx";
  const SECOND_MAPPING =
    /\bCHEQUING\b[\s\S]{0,600}bg-\w+-100 text-\w+-800|bg-\w+-100 text-\w+-800[\s\S]{0,600}\bCHEQUING\b/;

  it("has no second account-type colour mapping", () => {
    const offenders = productionSources()
      .filter(([path]) => path !== MODULE)
      .filter(([, content]) => SECOND_MAPPING.test(content))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("still finds the mapping, so the rule cannot pass by accident", () => {
    const mod = sources[MODULE];
    expect(mod, `${MODULE} not found -- update MODULE in this test`).toBeTruthy();
    expect(SECOND_MAPPING.test(mod)).toBe(true);
  });
});

describe("an empty state is the shared EmptyState", () => {
  /**
   * The centered grey-glyph empty block was hand-rolled in fourteen files,
   * each drifting on its own (some with a heading, some a bare paragraph,
   * three different text tones). `components/ui/EmptyState.tsx` is the one
   * layout now; the fingerprint of a hand-rolled copy is its container
   * class.
   */
  const EMPTY_STATE = "/src/components/ui/EmptyState.tsx";
  const FINGERPRINT = "text-center py-12";

  it("has no hand-rolled empty-state container", () => {
    const offenders = productionSources()
      .filter(([path]) => path !== EMPTY_STATE)
      .filter(([, content]) => content.includes(FINGERPRINT))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("still finds the shared component, so the rule cannot pass by accident", () => {
    const component = sources[EMPTY_STATE];
    expect(component, `${EMPTY_STATE} not found -- update this test`).toBeTruthy();
    expect(component.includes(FINGERPRINT)).toBe(true);
  });
});

describe("a brand logo keeps the display mode its badge centres with", () => {
  /**
   * `BrandLogo`'s fallback badge centres its letter with `inline-flex` +
   * `items-center justify-center`. The caller's `className` is appended last,
   * so a display utility in it wins: `hidden sm:block` on the payee list left
   * every letter jammed against the top-left of its circle, which reads as a
   * rendering fault rather than a class conflict. Responsive hiding is spelled
   * `hidden sm:inline-flex`.
   */
  const LOGO_TAGS = /<(?:BrandLogo|PayeeLogo|InstitutionLogo)\b[\s\S]{0,400}?\/>/g;
  /** A display utility, at any breakpoint, inside that element's className. */
  const DISPLAY_UTILITY =
    /className="[^"]*\b(?:[a-z]+:)?(?:block|grid|inline-block|flow-root)\b[^"]*"/;

  it("has no call site whose className overrides the badge's display", () => {
    const offenders: string[] = [];
    for (const [path, content] of productionSources()) {
      for (const match of content.matchAll(LOGO_TAGS)) {
        if (DISPLAY_UTILITY.test(match[0])) {
          offenders.push(path);
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("still finds the badge's centring, so the rule cannot pass by accident", () => {
    const brandLogo = sources["/src/components/ui/BrandLogo.tsx"];
    expect(brandLogo, "BrandLogo.tsx not found -- update this test").toBeTruthy();
    expect(brandLogo).toContain("inline-flex items-center justify-center");
  });

  it("recognises the shape it is looking for", () => {
    // Were the tag regex to stop matching, the scan above would police an
    // empty set.
    const sample = '<PayeeLogo payee={p} size={20} className="hidden sm:block" />';
    const [found] = [...sample.matchAll(LOGO_TAGS)];
    expect(found).toBeTruthy();
    expect(DISPLAY_UTILITY.test(found[0])).toBe(true);
    expect(
      DISPLAY_UTILITY.test('<PayeeLogo className="hidden sm:inline-flex" />'),
    ).toBe(false);
  });
});

describe("an icon name is never rendered as text", () => {
  /**
   * `category.icon` (and `tag.icon`) hold an icon *name* -- "shopping-cart" --
   * that `getIconComponent` turns into an SVG. A surface that puts one in a
   * text position renders the literal string beside the category name, which
   * reads as a typo rather than as a missing feature. It happened three times
   * before this scan existed: the detail header, the subcategory table, and
   * the transactions page's category sidebar.
   *
   * Two shapes are policed, and only one of them can be caught generally:
   *
   *  - **Inside a template literal.** Always wrong whatever the property
   *    holds: a name renders as text, and a ReactNode icon stringifies to
   *    "[object Object]". Zero false positives, so it is scanned everywhere.
   *  - **As a bare JSX child** (`{category.icon}`). Only wrong for the
   *    entities whose `icon` is a name string -- `report.icon`, `card.icon`
   *    and `step.icon` are genuine ReactNodes and are correct that way -- so
   *    this half is limited to the identifiers that carry names.
   *
   * Draw them with `CategoryGlyph`, or with `getIconComponent` where a bespoke
   * wrapper is genuinely needed.
   */
  const ICON_IN_TEMPLATE_LITERAL = /\$\{[^}]*\.icon\b[^}]*\}/;
  /** Identifiers whose `.icon` is an icon *name*, not a ReactNode. */
  const NAME_CARRYING = [
    "category",
    "parentCategory",
    "subcategory",
    "child",
    "cat",
    "tag",
  ];
  const NAME_ICON_AS_JSX_CHILD = new RegExp(
    `(?<![=\\w])\\{\\s*(?:${NAME_CARRYING.join("|")})\\.icon\\s*\\}`,
  );

  it("never interpolates an icon into a template literal", () => {
    const offenders = productionSources()
      .filter(([, content]) => ICON_IN_TEMPLATE_LITERAL.test(content))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it("never renders a name-carrying icon as a bare JSX child", () => {
    const offenders = productionSources()
      .filter(([, content]) => NAME_ICON_AS_JSX_CHILD.test(content))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it("still catches both shapes, so the rules cannot pass by accident", () => {
    // The exact line this scan was written for, plus the JSX-child form.
    expect(
      ICON_IN_TEMPLATE_LITERAL.test("{category.icon ? `${category.icon} ` : ''}"),
    ).toBe(true);
    expect(NAME_ICON_AS_JSX_CHILD.test("<h3>{category.icon}</h3>")).toBe(true);
    // ...and leaves the legitimate shapes alone.
    expect(NAME_ICON_AS_JSX_CHILD.test("<Glyph icon={category.icon} />")).toBe(
      false,
    );
    expect(NAME_ICON_AS_JSX_CHILD.test("<span>{report.icon}</span>")).toBe(
      false,
    );
  });
});

describe("a keyboard focus ring is focus-visible, never focus", () => {
  /**
   * `focus:ring-2` paints the ring on a mouse click as well as on a Tab, so
   * every button in the app flashed a 2px offset halo when clicked. That is
   * the single most visible "unfinished" tell in a UI, and the fix is one
   * pseudo-class: `focus-visible` fires only when the browser judges the
   * focus worth showing -- keyboard, not pointer.
   *
   * Text inputs are deliberately exempt, both here and in `inputBaseClasses`
   * and the element selectors in `globals.css`: a field that shows its
   * focused border after a click is telling the user where their typing will
   * go, which is the opposite of noise.
   *
   * The baseline is **shrink-only**. Converting a file means deleting its
   * line here; new code uses `focus-visible:` from the start.
   */
  const FOCUS_RING = /focus:ring-/;

  /** The shared input styling, where a click-visible focus ring is correct. */
  const INPUT_EXEMPT = new Set([
    "/src/lib/utils.ts",
    "/src/components/ui/Input.tsx",
  ]);

  const BASELINE: ReadonlyArray<string> = [
    "/src/app/categories/page.tsx",
    "/src/app/currencies/page.tsx",
    "/src/app/error.tsx",
    "/src/app/institutions/page.tsx",
    "/src/app/login/page.tsx",
    "/src/app/not-found.tsx",
    "/src/app/payees/page.tsx",
    "/src/app/reports/page.tsx",
    "/src/app/securities/page.tsx",
    "/src/app/tags/page.tsx",
    "/src/components/accounts/AccountForm.tsx",
    "/src/components/accounts/LoanPaymentSetupDialog.tsx",
    "/src/components/accounts/MortgageFields.tsx",
    "/src/components/accounts/credit-card-detail/PaymentSetupDialog.tsx",
    "/src/components/accounts/loan-detail/OverpaymentSimulator.tsx",
    "/src/components/admin/UserManagementTable.tsx",
    "/src/components/ai/ChatInterface.tsx",
    "/src/components/auth/BackupCodesDisplay.tsx",
    "/src/components/auth/TwoFactorVerify.tsx",
    "/src/components/budgets/BudgetForm.tsx",
    "/src/components/budgets/BudgetWizardCategories.tsx",
    "/src/components/budgets/BudgetWizardStrategy.tsx",
    "/src/components/categories/CategoryForm.tsx",
    "/src/components/categories/DeleteCategoryDialog.tsx",
    "/src/components/dashboard/TourBanner.tsx",
    "/src/components/dashboard/UpcomingBills.tsx",
    "/src/components/dashboard/WidgetCard.tsx",
    "/src/components/import/CategoryMappingRow.tsx",
    "/src/components/investments/InvestmentTransactionList.tsx",
    "/src/components/layout/AppHeader.tsx",
    "/src/components/layout/DelegationBanner.tsx",
    "/src/components/payees/AutoMergePayeesDialog.tsx",
    "/src/components/payees/CategoryAutoAssignDialog.tsx",
    "/src/components/payees/MergePayeeDialog.tsx",
    "/src/components/reconcile/ReconcileTable.tsx",
    "/src/components/reports/CustomReportForm.tsx",
    "/src/components/reports/FilterBuilder.tsx",
    "/src/components/reports/MonteCarloReport.tsx",
    "/src/components/reports/MonteCarloSaveAsDialog.tsx",
    "/src/components/reports/ReportError.tsx",
    "/src/components/scheduled-transactions/PostTransactionDialog.tsx",
    "/src/components/scheduled-transactions/ScheduledTransactionForm.tsx",
    "/src/components/securities/SecurityForm.tsx",
    "/src/components/settings/ApiAccessSection.tsx",
    "/src/components/settings/AutoBackupSection.tsx",
    "/src/components/settings/DangerZoneSection.tsx",
    "/src/components/settings/NotificationsSection.tsx",
    "/src/components/strategies/GemInstrumentSelect.tsx",
    "/src/components/tags/TagForm.tsx",
    "/src/components/transactions/AccountInfoWidget.tsx",
    "/src/components/transactions/BulkUpdateModal.tsx",
    "/src/components/transactions/CategoryInfoWidget.tsx",
    "/src/components/transactions/CurrencyPickerButton.tsx",
    "/src/components/transactions/NormalTransactionFields.tsx",
    "/src/components/transactions/PayeeInfoWidget.tsx",
    "/src/components/transactions/SplitTransactionFields.tsx",
    "/src/components/transactions/TransactionForm.tsx",
    "/src/components/transactions/TransactionList.tsx",
    "/src/components/transactions/TransactionRow.tsx",
    "/src/components/ui/ColorPicker.tsx",
    "/src/components/ui/ConfirmDialog.tsx",
    "/src/components/ui/DragHandle.tsx",
    "/src/components/ui/IconPicker.tsx",
    "/src/components/ui/MultiSelect.tsx",
    "/src/components/ui/Pagination.tsx",
    "/src/components/ui/Select.tsx",
    "/src/components/ui/ThemeToggle.tsx",
    "/src/components/ui/UnsavedChangesDialog.tsx",
  ];

  function filesWithFocusRing(): string[] {
    return productionSources()
      .filter(([path]) => !INPUT_EXEMPT.has(path))
      .filter(([, content]) => FOCUS_RING.test(content))
      .map(([path]) => path);
  }

  it("has no focus:ring outside the recorded baseline", () => {
    const allowed = new Set(BASELINE);
    const offenders = filesWithFocusRing().filter((path) => !allowed.has(path));
    expect(offenders).toEqual([]);
  });

  it("keeps the baseline shrink-only", () => {
    const offending = new Set(filesWithFocusRing());
    expect(BASELINE.filter((file) => !offending.has(file))).toEqual([]);
  });

  it("the shared primitives are converted, so the rule has real subjects", () => {
    // Button and Tabs are the two every screen renders; if either regressed to
    // `focus:`, the baseline above would be hiding it rather than the rule
    // catching it.
    for (const path of ["/src/components/ui/Button.tsx", "/src/components/ui/Tabs.tsx"]) {
      const content = sources[path];
      expect(content, `${path} not found -- update this test`).toBeTruthy();
      expect(FOCUS_RING.test(content), `${path} still uses focus:ring-`).toBe(false);
      expect(content).toContain("focus-visible:ring-");
    }
  });
});

describe("text-md is not a Tailwind size", () => {
  /**
   * There is no `text-md` in Tailwind -- the scale runs `text-sm`,
   * `text-base`, `text-lg`. A heading carrying it silently renders at the
   * inherited size, so it looks like a heading that forgot to be one. Three
   * of them sat in the Security settings section.
   *
   * No baseline: the class never does anything, so there is nothing to
   * grandfather.
   */
  it("appears nowhere in the source", () => {
    const offenders = productionSources()
      .filter(([, content]) => /\btext-md\b/.test(content))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});

describe("row hover comes from the shared pair, not a hand-picked grey", () => {
  /**
   * The same light hover value appeared with eight different darks -- plain
   * `gray-700`, `gray-600`, `gray-800`, and `gray-700` at /20, /30, /40, /50
   * and /60 -- across twelve variants. Two lists side by side highlighted
   * differently, and nobody could say which was intended.
   *
   * `HOVER_ROW_ON_CARD` / `HOVER_ROW_ON_PAGE` in `Card.tsx` are the two that
   * mean something, and both carry the transition that most call sites
   * omitted: 180 files had a `hover:bg-*` that snapped, which reads as a
   * redraw rather than a response.
   *
   * The baseline is **shrink-only**. Converting a file to one of the
   * constants removes the literal, so its line here must go in the same
   * commit.
   */
  const HOVER_OWNER = "/src/components/ui/Card.tsx";
  const HOVER_FINGERPRINT = /hover:bg-gray-(50|100)[^"'`]*dark:hover:bg-gray-/;

  const BASELINE: ReadonlyArray<string> = [
    "/src/app/bills/page.tsx",
    "/src/app/budgets/[id]/edit/page.tsx",
    "/src/app/categories/page.tsx",
    "/src/app/currencies/page.tsx",
    "/src/app/error.tsx",
    "/src/app/institutions/page.tsx",
    "/src/app/not-found.tsx",
    "/src/app/payees/page.tsx",
    "/src/app/reports/page.tsx",
    "/src/app/securities/page.tsx",
    "/src/app/settings/page.tsx",
    "/src/components/accounts/AccountForm.tsx",
    "/src/components/accounts/AccountList.tsx",
    "/src/components/accounts/AccountRow.tsx",
    "/src/components/accounts/credit-card-detail/SpendingBreakdown.tsx",
    "/src/components/accounts/loan-detail/SavedScenariosPanel.tsx",
    "/src/components/accounts/loan-detail/ScheduleTableRow.tsx",
    "/src/components/accounts/shared/RecurringChargesPanel.tsx",
    "/src/components/accounts/shared/SummaryCardGrid.tsx",
    "/src/components/accounts/shared/TopGroupsPanel.tsx",
    "/src/components/admin/UserManagementTable.tsx",
    "/src/components/ai/AiChatBubble.tsx",
    "/src/components/ai/AssistantTable.tsx",
    "/src/components/ai/ResultChart.tsx",
    "/src/components/budgets/BudgetAlertBadge.tsx",
    "/src/components/budgets/BudgetAlertList.tsx",
    "/src/components/budgets/BudgetCategoryList.tsx",
    "/src/components/budgets/BudgetCategoryRow.tsx",
    "/src/components/budgets/BudgetWizardCategories.tsx",
    "/src/components/budgets/BudgetWizardStrategy.tsx",
    "/src/components/categories/CategoryList.tsx",
    "/src/components/categories/detail/CategorySubcategoriesTab.tsx",
    "/src/components/currencies/CurrencyList.tsx",
    "/src/components/dashboard/CustomizeDashboardModal.tsx",
    "/src/components/dashboard/FavouriteAccounts.tsx",
    "/src/components/dashboard/FavouriteReportsWidget.tsx",
    "/src/components/dashboard/FavouriteSecurities.tsx",
    "/src/components/dashboard/GettingStarted.tsx",
    "/src/components/dashboard/PortfolioValueWidget.tsx",
    "/src/components/dashboard/TopMovers.tsx",
    "/src/components/dashboard/UpcomingBills.tsx",
    "/src/components/dashboard/WidgetCard.tsx",
    "/src/components/institutions/InstitutionAccountsManager.tsx",
    "/src/components/institutions/InstitutionList.tsx",
    "/src/components/investments/CashRegisterFilters.tsx",
    "/src/components/investments/GroupedHoldingsList.tsx",
    "/src/components/investments/HoldingsList.tsx",
    "/src/components/investments/InvestmentTransactionList.tsx",
    "/src/components/investments/NewTransactionButton.tsx",
    "/src/components/layout/ActionHistoryPanel.tsx",
    "/src/components/layout/AppHeader.tsx",
    "/src/components/layout/MobileNavDrawer.tsx",
    "/src/components/payees/CategoryAutoAssignDialog.tsx",
    "/src/components/payees/DeactivateUnusedPayeesDialog.tsx",
    "/src/components/payees/PayeeList.tsx",
    "/src/components/payees/detail/PayeeDetailHeader.tsx",
    "/src/components/payees/detail/PayeeRecurringPanel.tsx",
    "/src/components/reconcile/ReconcileTable.tsx",
    "/src/components/reconcile/ReconciliationReminderBadge.tsx",
    "/src/components/reports/AccountBalancesReport.tsx",
    "/src/components/reports/BillPaymentHistoryReport.tsx",
    "/src/components/reports/BudgetSeasonalPatternsReport.tsx",
    "/src/components/reports/CashFlowReport.tsx",
    "/src/components/reports/CreditUtilizationReport.tsx",
    "/src/components/reports/CurrencyExposureReport.tsx",
    "/src/components/reports/CustomReportViewer.tsx",
    "/src/components/reports/DividendIncomeReport.tsx",
    "/src/components/reports/DividendYieldGrowthReport.tsx",
    "/src/components/reports/GeographicAllocationReport.tsx",
    "/src/components/reports/IncomeBySourceReport.tsx",
    "/src/components/reports/IncomeVsExpensesReport.tsx",
    "/src/components/reports/InvestmentPerformanceReport.tsx",
    "/src/components/reports/InvestmentReportViewer.tsx",
    "/src/components/reports/InvestmentTransactionHistoryReport.tsx",
    "/src/components/reports/LoanAmortizationReport.tsx",
    "/src/components/reports/MonteCarloReport.tsx",
    "/src/components/reports/MonthlyCategoryBreakdownReport.tsx",
    "/src/components/reports/MonthlyComparisonReport.tsx",
    "/src/components/reports/MonthlySpendingTrendReport.tsx",
    "/src/components/reports/NetWorthReport.tsx",
    "/src/components/reports/NewReportButton.tsx",
    "/src/components/reports/PortfolioValueReport.tsx",
    "/src/components/reports/RealizedGainsReport.tsx",
    "/src/components/reports/RecurringExpensesReport.tsx",
    "/src/components/reports/ReportChart.tsx",
    "/src/components/reports/SectorWeightingsReport.tsx",
    "/src/components/reports/SecurityPerformanceReport.tsx",
    "/src/components/reports/SecurityTypeAllocationReport.tsx",
    "/src/components/reports/SpendingByCategoryReport.tsx",
    "/src/components/reports/SpendingByPayeeReport.tsx",
    "/src/components/reports/UncategorizedTransactionsReport.tsx",
    "/src/components/reports/UpcomingBillsReport.tsx",
    "/src/components/reports/YearOverYearReport.tsx",
    "/src/components/reports/account-balances/AccountBalancesControls.tsx",
    "/src/components/scheduled-transactions/OccurrenceDatePicker.tsx",
    "/src/components/scheduled-transactions/PostTransactionDialog.tsx",
    "/src/components/scheduled-transactions/ScheduledTransactionForm.tsx",
    "/src/components/scheduled-transactions/ScheduledTransactionList.tsx",
    "/src/components/securities/SecurityForm.tsx",
    "/src/components/securities/SecurityList.tsx",
    "/src/components/securities/SecurityLookupPicker.tsx",
    "/src/components/securities/SecurityPriceHistory.tsx",
    "/src/components/securities/SecurityTransactionHistory.tsx",
    "/src/components/securities/detail/SecurityAccountsTable.tsx",
    "/src/components/securities/detail/SecurityChartSection.tsx",
    "/src/components/securities/detail/SecurityDocumentsTab.tsx",
    "/src/components/securities/detail/SecuritySummaryCards.tsx",
    "/src/components/settings/AboutSection.tsx",
    "/src/components/settings/ApiAccessSection.tsx",
    "/src/components/settings/HelpSection.tsx",
    "/src/components/settings/SettingsNav.tsx",
    "/src/components/settings/ai/UsageDashboard.tsx",
    "/src/components/strategies/GemInstrumentSelect.tsx",
    "/src/components/strategies/GemSignalHistoryTable.tsx",
    "/src/components/tags/TagList.tsx",
    "/src/components/transactions/AccountInfoWidget.tsx",
    "/src/components/transactions/CategoryInfoWidget.tsx",
    "/src/components/transactions/CurrencyPickerButton.tsx",
    "/src/components/transactions/NormalTransactionFields.tsx",
    "/src/components/transactions/PayeeInfoWidget.tsx",
    "/src/components/transactions/RecentTransactionsPopover.tsx",
    "/src/components/transactions/SplitEditor.tsx",
    "/src/components/transactions/SplitTransactionFields.tsx",
    "/src/components/transactions/StatusCellButton.tsx",
    "/src/components/transactions/TransactionActionSheet.tsx",
    "/src/components/transactions/TransactionFilterPanel.tsx",
    "/src/components/transactions/TransactionForm.tsx",
    "/src/components/transactions/TransactionList.tsx",
    "/src/components/transactions/TransactionRow.tsx",
    "/src/components/ui/ActionMenu.tsx",
    "/src/components/ui/Button.tsx",
    "/src/components/ui/CalendarPopover.tsx",
    "/src/components/ui/ChartDownloadButton.tsx",
    "/src/components/ui/ColorPicker.tsx",
    "/src/components/ui/CurrencyInput.tsx",
    "/src/components/ui/DensityToggle.tsx",
    "/src/components/ui/DragHandle.tsx",
    "/src/components/ui/EntitySwitcher.tsx",
    "/src/components/ui/ExportDropdown.tsx",
    "/src/components/ui/ExportIconButton.tsx",
    "/src/components/ui/IconPicker.tsx",
    "/src/components/ui/MultiSelect.tsx",
    "/src/components/ui/Pagination.tsx",
    "/src/components/ui/SortableHeader.tsx",
    "/src/components/ui/SplitSubmitButton.tsx",
    "/src/components/ui/SummaryCard.tsx",
    "/src/components/ui/ThemeToggle.tsx",
    "/src/components/ui/row-actions/RowActionSheet.tsx",
    "/src/components/ui/row-actions/RowActions.tsx",
    "/src/components/ui/row-actions/RowActionsOverflow.tsx",
  ];

  function filesWithInlineHover(): string[] {
    return productionSources()
      .filter(([path]) => path !== HOVER_OWNER)
      .filter(([, content]) => HOVER_FINGERPRINT.test(content))
      .map(([path]) => path);
  }

  it("has no hand-rolled row hover outside the recorded baseline", () => {
    const allowed = new Set(BASELINE);
    const offenders = filesWithInlineHover().filter((path) => !allowed.has(path));
    expect(offenders).toEqual([]);
  });

  it("keeps the baseline shrink-only", () => {
    const offending = new Set(filesWithInlineHover());
    expect(BASELINE.filter((file) => !offending.has(file))).toEqual([]);
  });

  it("still finds both constants, so the rule cannot pass by accident", () => {
    const owner = sources[HOVER_OWNER];
    expect(owner, `${HOVER_OWNER} not found -- update HOVER_OWNER here`).toBeTruthy();
    expect(owner).toContain("HOVER_ROW_ON_CARD");
    expect(owner).toContain("HOVER_ROW_ON_PAGE");
    // Both must animate: the missing transition is half the defect.
    for (const line of owner.split("\n")) {
      if (line.includes("hover:bg-gray-")) {
        expect(line).toContain("transition-colors");
      }
    }
  });
});

describe("a dialog is titled through Modal, not by a hand-rolled heading", () => {
  /**
   * `Modal` had no `title`, so all 74 call sites drew their own header. That
   * produced eight different treatments of one slot -- `text-lg font-semibold`
   * (32), `text-2xl font-bold` (22), `text-lg font-medium` (17) and more --
   * and, more seriously, a dialog with no `aria-labelledby`: screen readers
   * announced an unnamed region and the visible heading was decoration.
   *
   * Passing `title` draws the standard header and wires the label. The
   * baseline is **shrink-only**: converting a call site removes its line.
   *
   * A modal whose header is genuinely bespoke -- ConfirmDialog puts an icon
   * beside the heading -- stays on the baseline deliberately rather than
   * being flattened into the standard one.
   */
  const MODAL = "/src/components/ui/Modal.tsx";

  const BASELINE: ReadonlyArray<string> = [
    "/src/app/bills/page.tsx",
    "/src/app/budgets/[id]/edit/page.tsx",
    "/src/app/categories/[id]/page.tsx",
    "/src/app/categories/page.tsx",
    "/src/app/currencies/page.tsx",
    "/src/app/institutions/page.tsx",
    "/src/app/investments/page.tsx",
    "/src/app/payees/[id]/page.tsx",
    "/src/app/payees/page.tsx",
    "/src/app/reconcile/page.tsx",
    "/src/app/reports/custom/[id]/edit/page.tsx",
    "/src/app/reports/investment/[id]/edit/page.tsx",
    "/src/app/securities/[id]/page.tsx",
    "/src/app/securities/page.tsx",
    "/src/app/settings/emergency-access/page.tsx",
    "/src/app/tags/page.tsx",
    "/src/app/transactions/page.tsx",
    "/src/components/accounts/AccountExportModal.tsx",
    "/src/components/accounts/AccountForm.tsx",
    "/src/components/accounts/AccountFormModal.tsx",
    "/src/components/accounts/LoanPaymentSetupDialog.tsx",
    "/src/components/accounts/asset-detail/UpdateValueDialog.tsx",
    "/src/components/accounts/credit-card-detail/PaymentSetupDialog.tsx",
    "/src/components/accounts/loan-detail/LoanRateControls.tsx",
    "/src/components/accounts/loan-detail/SavedScenariosPanel.tsx",
    "/src/components/accounts/shared/ForeignCurrencyFeesSection.tsx",
    "/src/components/accounts/shared/RecurringChargesPanel.tsx",
    "/src/components/admin/CreateUserModal.tsx",
    "/src/components/admin/ResetPasswordModal.tsx",
    "/src/components/auth/StepUpAuthModal.tsx",
    "/src/components/categories/DeleteCategoryDialog.tsx",
    "/src/components/categories/ImportDefaultCategoriesDialog.tsx",
    "/src/components/categories/detail/CategoryTransactionsTab.tsx",
    "/src/components/dashboard/CustomizeDashboardModal.tsx",
    "/src/components/dashboard/WidgetCard.tsx",
    "/src/components/import/MnyPasswordDialog.tsx",
    "/src/components/import/MnyWipeConfirmDialog.tsx",
    "/src/components/institutions/InstitutionAccountsManager.tsx",
    "/src/components/investments/InvestmentRegisterPanel.tsx",
    "/src/components/investments/InvestmentTransactionForm.tsx",
    "/src/components/layout/MobileNavDrawer.tsx",
    "/src/components/payees/AutoMergePayeesDialog.tsx",
    "/src/components/payees/CategoryAutoAssignDialog.tsx",
    "/src/components/payees/DeactivateUnusedPayeesDialog.tsx",
    "/src/components/payees/MergePayeeDialog.tsx",
    "/src/components/payees/ReactivatePayeeDialog.tsx",
    "/src/components/payees/detail/PayeeTransactionsTab.tsx",
    "/src/components/reports/ForeignCurrencyFeesReport.tsx",
    "/src/components/reports/MonteCarloSaveAsDialog.tsx",
    "/src/components/scheduled-transactions/OccurrenceDatePicker.tsx",
    "/src/components/scheduled-transactions/OverrideEditorDialog.tsx",
    "/src/components/scheduled-transactions/PostTransactionDialog.tsx",
    "/src/components/scheduled-transactions/ScheduledTransactionForm.tsx",
    "/src/components/securities/SecurityForm.tsx",
    "/src/components/securities/SecurityLookupPicker.tsx",
    "/src/components/securities/SecurityTransactionHistory.tsx",
    "/src/components/securities/detail/SecurityDocumentsTab.tsx",
    "/src/components/settings/ApiAccessSection.tsx",
    "/src/components/settings/BackupRestoreSection.tsx",
    "/src/components/settings/SecuritySection.tsx",
    "/src/components/settings/SharedAccessSection.tsx",
    "/src/components/settings/SupportBackupModal.tsx",
    "/src/components/settings/ai/ProviderConfigForm.tsx",
    "/src/components/strategies/GemScenarioSwitcher.tsx",
    "/src/components/strategies/GemSettingsForm.tsx",
    "/src/components/transactions/BulkUpdateModal.tsx",
    "/src/components/transactions/CurrencyPickerButton.tsx",
    "/src/components/transactions/TransactionActionSheet.tsx",
    "/src/components/transactions/TransactionForm.tsx",
    "/src/components/ui/ConfirmDialog.tsx",
    "/src/components/ui/UnsavedChangesDialog.tsx",
    "/src/components/ui/row-actions/RowActionSheet.tsx",
    "/src/components/whats-new/WhatsNewModal.tsx",
    "/src/hooks/useFormModal.ts",
  ];

  /** Opening `<Modal ...>` tags, tolerating `>` inside `{...}` expressions. */
  function modalTagsIn(content: string): string[] {
    const tags: string[] = [];
    for (const match of content.matchAll(/<Modal\b/g)) {
      let i = match.index + match[0].length;
      let depth = 0;
      while (i < content.length) {
        const ch = content[i];
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
        else if (ch === ">" && depth === 0) break;
        i += 1;
      }
      tags.push(content.slice(match.index, i));
    }
    return tags;
  }

  function filesWithUntitledModal(): string[] {
    return productionSources()
      .filter(([path]) => path !== MODAL)
      .filter(([, content]) => modalTagsIn(content).some((tag) => !tag.includes("title=")))
      .map(([path]) => path);
  }

  it("has no untitled Modal outside the recorded baseline", () => {
    const allowed = new Set(BASELINE);
    const offenders = filesWithUntitledModal().filter((path) => !allowed.has(path));
    expect(offenders).toEqual([]);
  });

  it("keeps the baseline shrink-only", () => {
    const offending = new Set(filesWithUntitledModal());
    expect(BASELINE.filter((file) => !offending.has(file))).toEqual([]);
  });

  it("Modal still wires the label, so the rule cannot pass by accident", () => {
    const modal = sources[MODAL];
    expect(modal, `${MODAL} not found -- update MODAL in this test`).toBeTruthy();
    expect(modal).toContain("aria-labelledby");
    // Absent title must mean no attribute, never a reference to nothing.
    expect(modal).toContain("aria-labelledby={title ? titleId : undefined}");
  });
});

describe("a status pill is Badge, not a hand-rolled rounded-full", () => {
  /**
   * The same pill shape -- `rounded-full` + `text-xs` + `font-medium` -- was
   * written out about fifty times, in six padding combinations, with each
   * colour pair spelled out at the call site. Two lists side by side
   * disagreed on how big a pill was and how strong its tint.
   *
   * The exemptions are pills whose colour carries meaning of its own, each
   * already a single source of truth: `CategoryPill` mixes the category's own
   * colour, `ACCOUNT_TYPE_META` maps a type to its classes, and
   * `SCHEDULED_KIND_CHIP_CLASSES` maps the four scheduled kinds. Flattening
   * any of them into a generic variant would throw that mapping away.
   *
   * The baseline is **shrink-only**: converting a file removes its line.
   */
  const BADGE = "/src/components/ui/Badge.tsx";
  const MEANINGFUL_PILLS = new Set([
    "/src/components/transactions/CategoryPill.tsx",
    "/src/lib/account-type-meta.tsx",
    "/src/lib/scheduled-kind.ts",
  ]);
  const PILL_FINGERPRINT =
    /rounded-full[^"'`]*(?:text-xs|text-\[10px\])[^"'`]*font-medium|(?:text-xs|text-\[10px\])[^"'`]*font-medium[^"'`]*rounded-full|rounded-full[^"'`]*font-medium[^"'`]*(?:text-xs|text-\[10px\])/;

  const BASELINE: ReadonlyArray<string> = [
    "/src/app/budgets/page.tsx",
    "/src/components/budgets/BudgetCategoryTrend.tsx",
    "/src/components/budgets/BudgetPeriodDetail.tsx",
    "/src/components/budgets/BudgetWizard.tsx",
    "/src/components/categories/detail/CategoryDetailHeader.tsx",
    "/src/components/insights/InsightsList.tsx",
    "/src/components/payees/AutoMergePayeesDialog.tsx",
    "/src/components/payees/CategoryAutoAssignDialog.tsx",
    "/src/components/payees/detail/PayeeDetailHeader.tsx",
    "/src/components/reconcile/ReconcileTable.tsx",
    "/src/components/reports/DuplicateTransactionReport.tsx",
    "/src/components/reports/FilterBuilder.tsx",
    "/src/components/reports/RecurringExpensesReport.tsx",
    "/src/components/reports/SpendingAnomaliesReport.tsx",
    "/src/components/scheduled-transactions/BillsFilterPanel.tsx",
    "/src/components/scheduled-transactions/ScheduledTransactionList.tsx",
    "/src/components/securities/SecurityList.tsx",
    "/src/components/securities/detail/SecurityDetailHeader.tsx",
    "/src/components/securities/detail/SecurityPositionInfoCard.tsx",
    "/src/components/securities/detail/SecurityPositionState.tsx",
    "/src/components/settings/BackupRestoreSection.tsx",
    "/src/components/settings/SecuritySection.tsx",
    "/src/components/transactions/AccountInfoWidget.tsx",
    "/src/components/transactions/CategoryInfoWidget.tsx",
    "/src/components/transactions/PayeeInfoWidget.tsx",
    "/src/components/transactions/TransactionFilterPanel.tsx",
    "/src/components/transactions/TransactionForm.tsx",
    "/src/components/transactions/TransactionRow.tsx",
  ];

  function filesWithInlinePill(): string[] {
    return productionSources()
      .filter(([path]) => path !== BADGE && !MEANINGFUL_PILLS.has(path))
      .filter(([, content]) => PILL_FINGERPRINT.test(content))
      .map(([path]) => path);
  }

  it("has no hand-rolled pill outside the recorded baseline", () => {
    const allowed = new Set(BASELINE);
    const offenders = filesWithInlinePill().filter((path) => !allowed.has(path));
    expect(offenders).toEqual([]);
  });

  it("keeps the baseline shrink-only", () => {
    const offending = new Set(filesWithInlinePill());
    expect(BASELINE.filter((file) => !offending.has(file))).toEqual([]);
  });

  it("still finds the primitive, so the rule cannot pass by accident", () => {
    const badge = sources[BADGE];
    expect(badge, `${BADGE} not found -- update BADGE in this test`).toBeTruthy();
    expect(badge).toContain("rounded-full");
    expect(badge).toContain("font-medium");
  });

  it("every Badge variant stays on the theme ramps", () => {
    // A literal hex here would look right on the default palette and stay
    // that colour on the other fourteen.
    const badge = sources[BADGE];
    const variants = badge.slice(
      badge.indexOf("const BADGE_VARIANTS"),
      badge.indexOf("const BADGE_SIZES"),
    );
    expect(variants).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});

describe("table chrome comes from Table.tsx, not a repeated divide string", () => {
  /**
   * `divide-y divide-gray-200 dark:divide-gray-700` was written out 147 times
   * across 81 files, and the header cell existed in at least six paddings.
   * None of it could be restyled together.
   *
   * `Table.tsx` is constants plus two thin cells rather than a `<Table>`
   * wrapper, because these tables are hand-laid -- colspans, sticky cells,
   * per-density padding -- and a component owning the markup would be fought
   * at every call site. What drifted was the chrome, so that is what is
   * shared.
   *
   * The baseline is **shrink-only**: converting a file removes its line.
   */
  const TABLE = "/src/components/ui/Table.tsx";
  const DIVIDE_FINGERPRINT = "divide-y divide-gray-200 dark:divide-gray-700";

  const BASELINE: ReadonlyArray<string> = [
    "/src/app/reports/page.tsx",
    "/src/components/accounts/AccountList.tsx",
    "/src/components/accounts/loan-detail/AmortizationScheduleTable.tsx",
    "/src/components/accounts/loan-detail/SavedScenariosPanel.tsx",
    "/src/components/admin/UserManagementTable.tsx",
    "/src/components/budgets/BudgetPeriodDetail.tsx",
    "/src/components/categories/CategoryList.tsx",
    "/src/components/categories/detail/CategorySubcategoriesTab.tsx",
    "/src/components/currencies/CurrencyList.tsx",
    "/src/components/institutions/InstitutionAccountsManager.tsx",
    "/src/components/institutions/InstitutionList.tsx",
    "/src/components/investments/GroupedHoldingsList.tsx",
    "/src/components/investments/HoldingsList.tsx",
    "/src/components/investments/InvestmentTransactionList.tsx",
    "/src/components/payees/CategoryAutoAssignDialog.tsx",
    "/src/components/payees/DeactivateUnusedPayeesDialog.tsx",
    "/src/components/payees/PayeeList.tsx",
    "/src/components/reconcile/ReconcileTable.tsx",
    "/src/components/reconcile/ReconciliationReminderBadge.tsx",
    "/src/components/reports/AccountBalancesReport.tsx",
    "/src/components/reports/BillPaymentHistoryReport.tsx",
    "/src/components/reports/CashFlowReport.tsx",
    "/src/components/reports/CreditUtilizationReport.tsx",
    "/src/components/reports/CurrencyExposureReport.tsx",
    "/src/components/reports/DividendIncomeReport.tsx",
    "/src/components/reports/DividendYieldGrowthReport.tsx",
    "/src/components/reports/DuplicateTransactionReport.tsx",
    "/src/components/reports/GeographicAllocationReport.tsx",
    "/src/components/reports/IncomeBySourceReport.tsx",
    "/src/components/reports/IncomeVsExpensesReport.tsx",
    "/src/components/reports/InvestmentPerformanceReport.tsx",
    "/src/components/reports/InvestmentReportColumnChooser.tsx",
    "/src/components/reports/InvestmentReportViewer.tsx",
    "/src/components/reports/InvestmentTransactionHistoryReport.tsx",
    "/src/components/reports/LoanAmortizationReport.tsx",
    "/src/components/reports/MonteCarloHoldingStatsTable.tsx",
    "/src/components/reports/MonteCarloPerformanceSummary.tsx",
    "/src/components/reports/MonteCarloResultsTable.tsx",
    "/src/components/reports/MonthlyComparisonReport.tsx",
    "/src/components/reports/MonthlySpendingTrendReport.tsx",
    "/src/components/reports/NetWorthReport.tsx",
    "/src/components/reports/PortfolioValueReport.tsx",
    "/src/components/reports/RealizedGainsReport.tsx",
    "/src/components/reports/RecurringExpensesReport.tsx",
    "/src/components/reports/ReportChart.tsx",
    "/src/components/reports/SectorWeightingsReport.tsx",
    "/src/components/reports/SecurityPerformanceReport.tsx",
    "/src/components/reports/SecurityTypeAllocationReport.tsx",
    "/src/components/reports/SpendingByCategoryReport.tsx",
    "/src/components/reports/SpendingByPayeeReport.tsx",
    "/src/components/reports/TaxSummaryReport.tsx",
    "/src/components/reports/UncategorizedTransactionsReport.tsx",
    "/src/components/reports/UpcomingBillsReport.tsx",
    "/src/components/reports/YearOverYearReport.tsx",
    "/src/components/reports/monte-carlo/CompareMetricTable.tsx",
    "/src/components/scheduled-transactions/ScheduledTransactionList.tsx",
    "/src/components/securities/SecurityList.tsx",
    "/src/components/securities/SecurityLookupPicker.tsx",
    "/src/components/securities/SecurityPriceHistory.tsx",
    "/src/components/securities/SecurityTransactionHistory.tsx",
    "/src/components/securities/detail/SecurityAccountsTable.tsx",
    "/src/components/securities/detail/SecurityDocumentsTab.tsx",
    "/src/components/securities/detail/SecurityNewsTab.tsx",
    "/src/components/settings/TourCatalog.tsx",
    "/src/components/tags/TagList.tsx",
    "/src/components/transactions/SplitEditor.tsx",
    "/src/components/transactions/TransactionList.tsx",
    "/src/components/ui/LoadingSkeleton.tsx",
    "/src/components/whats-new/WhatsNewModal.tsx",
  ];

  function filesWithInlineDivide(): string[] {
    return productionSources()
      .filter(([path]) => path !== TABLE)
      .filter(([, content]) => content.includes(DIVIDE_FINGERPRINT))
      .map(([path]) => path);
  }

  it("has no inline divide string outside the recorded baseline", () => {
    const allowed = new Set(BASELINE);
    const offenders = filesWithInlineDivide().filter((path) => !allowed.has(path));
    expect(offenders).toEqual([]);
  });

  it("keeps the baseline shrink-only", () => {
    const offending = new Set(filesWithInlineDivide());
    expect(BASELINE.filter((file) => !offending.has(file))).toEqual([]);
  });

  it("still finds the shared chrome, so the rule cannot pass by accident", () => {
    const table = sources[TABLE];
    expect(table, `${TABLE} not found -- update TABLE in this test`).toBeTruthy();
    expect(table).toContain(DIVIDE_FINGERPRINT);
  });

  it("the skeletons use the real card, so nothing shifts when data arrives", () => {
    // Every LoadingSkeleton export hand-rolled the card trio, so a skeleton
    // was missing the 1px border a real card draws and the layout moved on
    // load.
    const skeleton = sources["/src/components/ui/LoadingSkeleton.tsx"];
    expect(skeleton).toContain("CARD_CLASS");
    expect(skeleton).not.toContain("bg-white dark:bg-gray-800");
  });
});

describe("the card shadow is a named token, not a redefined shadow-sm", () => {
  /**
   * A Tailwind v4 trap that cost this branch a wrong commit, verified against
   * the compiled CSS rather than assumed: the bare `shadow` utility is a
   * legacy alias with the stock value hardcoded into it. Redefining
   * `--shadow-sm` in `@theme` does not touch it -- it changes `shadow-sm`,
   * which here is worn almost entirely by form fields. So that override
   * puffed up every input and left every card exactly as flat, which is the
   * opposite of what it was written to do.
   *
   * `--shadow-card` is the token that actually reaches the cards, through
   * `CARD_CLASS`. This test fails if someone reaches for `--shadow-sm` again.
   */
  it("defines --shadow-card and leaves --shadow-sm alone", () => {
    const globals = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
    expect(globals).toContain("--shadow-card:");
    expect(
      globals.includes("--shadow-sm:"),
      "redefining --shadow-sm restyles form fields, not cards -- use --shadow-card",
    ).toBe(false);
  });

  it("CARD_CLASS wears it, so the one card surface is the one that changed", () => {
    const card = sources["/src/components/ui/Card.tsx"];
    expect(card).toContain("shadow-card");
  });
});
