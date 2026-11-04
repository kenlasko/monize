import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Guard tests for the UI conventions in `docs/frontend/ui-conventions.md`.
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

/**
 * Blank out comment bodies, keeping the file's length and line breaks so
 * reported line numbers still point at the source. Prose in this repo discusses
 * the very patterns these scans ban -- `<button>`, `role="switch"` -- and a scan
 * that reads its own explanation as a violation is worse than no scan, because
 * the cheap way out of it is a weaker comment.
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

describe("a platform capability is not decided by the window's width", () => {
  /**
   * `useIsMobile` is a 639px media query, so a narrow desktop window answers
   * yes to it. That is fine for choosing a LAYOUT -- the register's card rows
   * show the same figures either way -- and wrong for anything that changes
   * what a control can do, which is what `isTouchDevice` (`lib/touch-device.ts`)
   * is for.
   *
   * `capture` is the case that made this a scan: on a browser that honours it
   * the OS file picker is replaced by the camera, so keyed off the viewport it
   * took "choose an existing photo" away from anyone with a narrow window and
   * handed it back when they widened it.
   */
  function filesUsing(pattern: RegExp): string[] {
    return productionSources()
      .filter(([, source]) => pattern.test(withoutComments(source)))
      .map(([path]) => path);
  }

  it("keeps the camera handoff off the viewport hook", () => {
    const offenders = productionSources()
      .filter(([, source]) => {
        const code = withoutComments(source);
        return /\bcapture\s*[:=]/.test(code) && /useIsMobile/.test(code);
      })
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it("asks the pointer through one helper", () => {
    // A third hand-rolled copy is how the two existing ones came to be worth
    // extracting; the media query belongs in `lib/touch-device.ts` alone.
    const offenders = filesUsing(/pointer:\s*coarse/).filter(
      (path) => path !== "/src/lib/touch-device.ts",
    );

    expect(offenders).toEqual([]);
  });

  it("catches the pattern it bans", () => {
    const bad = 'const m = useIsMobile();\n<input capture="environment" />';
    expect(/\bcapture\s*[:=]/.test(withoutComments(bad))).toBe(true);
    expect(/useIsMobile/.test(withoutComments(bad))).toBe(true);
    // ...and reads its own explanation as prose, not as a violation.
    expect(
      /pointer:\s*coarse/.test(withoutComments("// never (pointer: coarse)")),
    ).toBe(false);
  });
});

describe("contextual help opens on a touch device", () => {
  /**
   * `InfoTooltip` is the one help popover: hover and keyboard focus on a
   * desktop, a tap on a phone, the same `text` either way. A help popover
   * written anywhere else was, every time, hover-only -- so the explanation
   * of TWR, MWR or an incomplete valuation existed on a desktop and not on a
   * phone. `InfoTooltip.touch.test.tsx` holds the tap behaviour; this holds
   * that nothing routes around it.
   */
  const SHARED = "/src/components/ui/InfoTooltip.tsx";
  const TOOLTIP_ROLE = /role=\{?["']tooltip["']\}?/;
  /**
   * Shrink-only. Each is hover-only on purpose and loses nothing on a phone:
   * the date shortcuts are keystrokes, which a touch screen has no keyboard
   * for; the page-header icon is a link that opens the help page on a tap,
   * and its popover only names that link.
   */
  const HOVER_ONLY = new Set([
    "/src/components/ui/DateInput.tsx",
    "/src/components/layout/PageHeader.tsx",
  ]);

  it("has no hand-rolled help popover outside InfoTooltip", () => {
    const offenders = productionSources()
      .filter(([path]) => path !== SHARED && !HOVER_ONLY.has(path))
      .filter(([, raw]) => TOOLTIP_ROLE.test(withoutComments(raw)))
      .map(([path]) => `${path}: use InfoTooltip, which opens on a tap as well as a hover`);

    expect(offenders).toEqual([]);
  });

  it("still finds the shared component, so the rule cannot pass by accident", () => {
    const shared = sources[SHARED];
    expect(shared, `${SHARED} not found -- update SHARED in this test`).toBeTruthy();
    expect(TOOLTIP_ROLE.test(shared)).toBe(true);
    for (const path of HOVER_ONLY) {
      expect(sources[path], `${path} is gone -- remove it from HOVER_ONLY`).toBeTruthy();
    }
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

describe("the mobile-table chrome constants live once in Table.tsx", () => {
  /**
   * `PHONE_HEADER_CLASS` (the phone sort strip's control) and `CAPTION_CLASS`
   * (the phone-only cell caption) are one class list each, worn by two dozen
   * wrapped tables, so they are exported from `components/ui/Table.tsx` and
   * imported.
   *
   * The reason is REACH, not repair. All fourteen of the local declarations
   * this replaced were byte-identical on `origin/main`: nothing had drifted.
   * What one home buys is that the next change to the caption's breakpoint or
   * the strip's padding lands in every table at once, instead of in whichever
   * files somebody remembered -- twenty-odd call sites is well past the number
   * a person edits reliably. (An earlier version of this comment justified the
   * scan with three copies that had already drifted by a lost tracking token.
   * That never happened, and a future reader must not reason from it. The
   * constant that genuinely differs per report is `HEADER_CLASS`, whose
   * `tracking-wider` this guard deliberately does not police, because those
   * track budgets are a per-report decision.)
   *
   * Two shapes break the rule and both are scanned, because closing one leaves
   * the other doing the same damage: re-declaring the constant locally, and
   * inlining its VALUE at a call site. `<CellLabel className="sm:hidden">` IS
   * `CAPTION_CLASS`, spelled out and importing nothing, so a change to the
   * constant skips it in silence.
   */
  const LOCAL_DECL = /\bconst\s+(PHONE_HEADER_CLASS|CAPTION_CLASS)\s*=/;
  const HOME = "/src/components/ui/Table.tsx";
  /** `CAPTION_CLASS`'s value written out on a `CellLabel` instead of imported. */
  const INLINE_CAPTION = /<CellLabel[^>]*className=\{?["'`][^"'`]*\bsm:hidden\b/;

  /**
   * Call sites that still inline it, with the reason each is here. Shrink-only:
   * fixing one means DELETING its line, and the second test below fails while a
   * listed file no longer offends, so the register cannot outlive its subjects.
   */
  const INLINE_CAPTION_BASELINE: ReadonlyArray<{ file: string; reason: string }> = [];

  const inliningFiles = () => {
    const found = new Set<string>();
    for (const [path, content] of productionSources()) {
      if (path === HOME) continue;
      for (const line of withoutComments(content).split("\n")) {
        if (INLINE_CAPTION.test(line)) found.add(path);
      }
    }
    return found;
  };

  it("no file re-declares the shared chrome classes locally", () => {
    const offenders: string[] = [];
    for (const [path, content] of productionSources()) {
      if (path === HOME) continue;
      withoutComments(content)
        .split("\n")
        .forEach((line, i) => {
          const match = line.match(LOCAL_DECL);
          if (match) offenders.push(`${path}:${i + 1} re-declares ${match[1]}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("no new call site inlines the caption class instead of importing it", () => {
    const allowed = new Set(INLINE_CAPTION_BASELINE.map((entry) => entry.file));
    const offenders: string[] = [];
    for (const [path, content] of productionSources()) {
      if (path === HOME || allowed.has(path)) continue;
      withoutComments(content)
        .split("\n")
        .forEach((line, i) => {
          if (INLINE_CAPTION.test(line)) {
            offenders.push(`${path}:${i + 1} inlines CAPTION_CLASS`);
          }
        });
    }

    expect(
      offenders,
      'Pass CAPTION_CLASS from @/components/ui/Table, not the literal "sm:hidden".',
    ).toEqual([]);
  });

  it("keeps the inline-caption baseline shrink-only", () => {
    const offending = inliningFiles();
    expect(
      INLINE_CAPTION_BASELINE.map((entry) => entry.file).filter(
        (file) => !offending.has(file),
      ),
      "This file no longer inlines the caption class -- delete its baseline line.",
    ).toEqual([]);
  });

  it("reads an inlined caption in markup but not one named in a comment", () => {
    // Both directions: the shape the scan exists for is caught, and this
    // block's own prose -- which has to name `className="sm:hidden"` to explain
    // itself -- is not a violation.
    expect(INLINE_CAPTION.test('<CellLabel className="sm:hidden">Total</CellLabel>')).toBe(
      true,
    );
    expect(INLINE_CAPTION.test("<CellLabel className={CAPTION_CLASS}>Total</CellLabel>")).toBe(
      false,
    );
    expect(
      INLINE_CAPTION.test(
        withoutComments('// never write <CellLabel className="sm:hidden">'),
      ),
    ).toBe(false);
  });
});

describe("a phone-wrapped cell restores the desktop font size it had", () => {
  /**
   * A cell converted for the phone card zeroes its padding at base and hands it
   * back at `sm` (`p-0 ... sm:px-4 sm:py-3`), and the claim that comes with that
   * is "from `sm` up this resolves identically to today". The font size is part
   * of the claim, and it is one token wide: `PortfolioValueReport`'s account
   * cell shipped `sm:text-sm` where the unwrapped cell had carried no size class
   * at all, so an inherited 16px became 14px on every desktop. It was corrected
   * by hand to `sm:text-base` and the suite never noticed either state -- of the
   * 27 `*.mobileWrapped` specs only seven assert any `sm:text-*`.
   *
   * The class string cannot tell you WHICH size is right: that is a fact about
   * the table before the conversion, and it differs. Every wrapped table in the
   * tree gave its cells `text-sm` (so `text-xs` on the phone restores
   * `sm:text-sm`), and exactly one cell inherited the page's 16px instead. So
   * the convention is what is scanned, and the exception is declared below with
   * the reason it is one -- which is what fails when that cell's `sm:text-base`
   * turns back into `sm:text-sm`.
   *
   * What this scan CANNOT see, so nobody over-trusts it:
   *
   *  - A size set once on the `<table>` and inherited by every cell. The three
   *    MonteCarlo tables legitimately do that (`text-xs` on the table element),
   *    and their cells name no size for this to read.
   *  - A size composed on another line -- through a module constant like
   *    `MONEY_CELL` or a helper like `cellPadding(columns.x)`. Matching is per
   *    line, so a base size in one place and its `sm:` restoration in another
   *    are invisible as a pair. (A constant that declares both on its own
   *    declaration line, as most do, IS covered.)
   *  - Whether the restored size is what the reader actually gets. jsdom
   *    applies no Tailwind stylesheet, so no test here can assert a computed
   *    font size; this is a claim about the class list.
   */
  const PADDING_RESTORED = /\bsm:p[xy]?-/;
  const BASE_TEXT = /(?:^|[\s"'`])text-(xs|sm|base|lg|xl)\b/g;
  const SM_TEXT = /\bsm:text-(xs|sm|base|lg|xl)\b/g;
  /** What a wrapped cell restores unless its table says otherwise. */
  const CONVENTION = "text-sm";

  /**
   * The cells whose desktop size is NOT the convention, each with the fact about
   * the pre-conversion table that decides it. Adding an entry is a decision:
   * check what the unwrapped cell rendered at before writing one.
   */
  const INHERITED_DESKTOP_SIZE: ReadonlyArray<{
    file: string;
    restores: string;
    count: number;
    reason: string;
  }> = [
    {
      file: "/src/components/reports/PortfolioValueReport.tsx",
      restores: "text-base",
      count: 1,
      reason:
        "The breakdown's account cell was `px-4 py-3 font-medium ...` with no " +
        "size class, so it inherited 16px while the four figure cells beside " +
        "it were `text-sm`. `text-base` is that inherited size written down; " +
        "`sm:text-sm` shrinks the row identity on every desktop.",
    },
  ];

  /** `{ file -> { restoredSize -> [line, ...] } }` for every shrink-and-restore cell. */
  function restorations(): Map<string, Map<string, number[]>> {
    const found = new Map<string, Map<string, number[]>>();
    for (const [path, content] of productionSources()) {
      withoutComments(content)
        .split("\n")
        .forEach((line, i) => {
          if (!PADDING_RESTORED.test(line)) return;
          BASE_TEXT.lastIndex = 0;
          SM_TEXT.lastIndex = 0;
          const base = new Set(
            [...line.matchAll(BASE_TEXT)].map((m) => `text-${m[1]}`),
          );
          const restored = [...line.matchAll(SM_TEXT)].map((m) => `text-${m[1]}`);
          // No base size, or no `sm:` size, is not a restoration: the cell's
          // size does not change across the breakpoint and this rule has
          // nothing to say about it.
          for (const size of restored) {
            if (base.size === 0 || base.has(size)) continue;
            const perFile = found.get(path) ?? new Map<string, number[]>();
            perFile.set(size, [...(perFile.get(size) ?? []), i + 1]);
            found.set(path, perFile);
          }
        });
    }
    return found;
  }

  it("finds the wrapped cells, so the checks below are not vacuous", () => {
    // Two dozen tables were converted; were the class shape to change, every
    // check here would pass over an empty set.
    const total = [...restorations().values()].flatMap((sizes) =>
      [...sizes.values()].flat(),
    ).length;
    expect(total).toBeGreaterThan(20);
  });

  it("restores the convention everywhere it is not declared otherwise", () => {
    const declared = new Map(
      INHERITED_DESKTOP_SIZE.map((entry) => [entry.file, entry.restores]),
    );
    const offenders: string[] = [];
    for (const [path, sizes] of restorations()) {
      for (const [size, lines] of sizes) {
        if (size === CONVENTION || declared.get(path) === size) continue;
        for (const line of lines) {
          offenders.push(`${path}:${line} restores sm:${size}`);
        }
      }
    }

    expect(
      offenders,
      `A phone-shrunk cell restores sm:${CONVENTION} unless its unwrapped table ` +
        "gave it another size -- if it did, add it to INHERITED_DESKTOP_SIZE " +
        "with that fact as the reason.",
    ).toEqual([]);
  });

  it("keeps every declared exception present, at its own size", () => {
    // The half that catches the regression: the account cell going back to
    // `sm:text-sm` leaves this expecting one `text-base` site and finding none.
    // Both directions, because a stale entry is a rule protecting nothing.
    const found = restorations();
    const actual = INHERITED_DESKTOP_SIZE.map((entry) => ({
      file: entry.file,
      restores: entry.restores,
      count: (found.get(entry.file)?.get(entry.restores) ?? []).length,
    }));

    expect(
      actual,
      "A declared exception must still be in the source at the size it declares.",
    ).toEqual(
      INHERITED_DESKTOP_SIZE.map((entry) => ({
        file: entry.file,
        restores: entry.restores,
        count: entry.count,
      })),
    );
  });

  it("reads a restoration, and reads no restoration where the size is unchanged", () => {
    const restored = (line: string) => {
      BASE_TEXT.lastIndex = 0;
      SM_TEXT.lastIndex = 0;
      const base = new Set(
        [...line.matchAll(BASE_TEXT)].map((m) => `text-${m[1]}`),
      );
      return [...line.matchAll(SM_TEXT)]
        .map((m) => `text-${m[1]}`)
        .filter((size) => base.size > 0 && !base.has(size));
    };

    // The corrected cell, and the mutation this guard exists to fail.
    expect(
      restored('className="p-0 text-xs break-words sm:px-4 sm:py-3 sm:text-base"'),
    ).toEqual(["text-base"]);
    expect(
      restored('className="p-0 text-xs break-words sm:px-4 sm:py-3 sm:text-sm"'),
    ).toEqual(["text-sm"]);
    // A cell that keeps one size at every width restores nothing...
    expect(restored('className="p-0 text-sm sm:px-4 sm:py-3 sm:text-sm"')).toEqual([]);
    // ...and neither does one that names no size of its own.
    expect(restored('className="min-w-0 p-0 sm:px-4 sm:py-3 sm:break-normal"')).toEqual([]);
    // `sm:text-sm` must not be read as a base size by the base matcher.
    expect(restored('className="p-0 sm:px-4 sm:text-sm"')).toEqual([]);
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
    // Comments stripped, like the other scans whose banned pattern has to be
    // NAMED to explain itself: a call site that deliberately uses two buttons
    // instead says so, and quoting the role it avoided is not a violation.
    const offenders = productionSources()
      .filter(([path]) => path !== SHARED)
      .filter(([, source]) => TABLIST.test(withoutComments(source)))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it("reads a tablist in code but not one named in a comment", () => {
    // Both directions, so the stripping cannot quietly disarm the rule.
    expect(TABLIST.test(withoutComments('<div role="tablist">'))).toBe(true);
    expect(
      TABLIST.test(withoutComments('// never hand-roll role="tablist"')),
    ).toBe(false);
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
   * in the last hundred pixels (`docs/frontend/financial-figures.md`,
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

  it("draws the column only while the register is in date order", () => {
    // A running balance is a figure about the row above it, so beside rows
    // ordered by payee or amount it is arithmetic nobody can read -- and the
    // server withholds the seed there, so the column would render "-" on every
    // row. The two conditions are one expression rather than two branches
    // because dropping either one silently brings the column back.
    // INV-REGISTER-001.
    const list = sources[LIST];
    expect(
      /\(isSingleAccountView \|\| startingBalance !== undefined\) && sortedByDate/.test(
        list,
      ),
      `${LIST} must gate the Balance column on the register being date-sorted`,
    ).toBe(true);
    // And the walk it feeds is the shared one, not a second copy in the
    // component: the two directions have to agree on one arithmetic.
    expect(/walkRunningBalances\(/.test(list)).toBe(true);
    expect(/let cumulativeCents/.test(list)).toBe(false);
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
    "/src/components/notifications/NotificationList.tsx",
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
    // Keeps an inline surface for its chart TOOLTIP -- a floating panel with
    // its own stronger shadow, not the widget card. Its widget surface now
    // comes from CARD_CLASS; the tooltip shape is hand-rolled in ~44 files
    // and is a separate drift from this one.
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

describe("a toggle is ToggleSwitch", () => {
  /**
   * `components/ui/ToggleSwitch.tsx` is the project's one on/off control, and a
   * hand-rolled one is not merely duplicated markup: the admin push panel's came
   * out 44px wide against the shared 36, with its own focus-ring offset colour,
   * so one switch in Settings was visibly a different control from every other.
   *
   * The scan keys on `role="switch"` on an element that is not the shared
   * component -- the attribute a hand-rolled toggle cannot omit without losing
   * the accessibility the shared one provides.
   *
   * The baseline is **shrink-only**: each entry predates this rule. Converting a
   * file to `ToggleSwitch` means deleting its line here; new code takes the
   * shared component from the start.
   */
  const TOGGLE = "/src/components/ui/ToggleSwitch.tsx";
  const HAND_ROLLED = /role=["']switch["']/;

  const BASELINE: ReadonlyArray<string> = [
    "/src/components/reports/DividendIncomeReport.tsx",
    "/src/components/settings/NotificationsSection.tsx",
  ];

  function filesWithHandRolledToggle(): string[] {
    return productionSources()
      .filter(([path]) => path !== TOGGLE)
      .filter(([, source]) => HAND_ROLLED.test(withoutComments(source)))
      .map(([path]) => path)
      .sort();
  }

  it("has no hand-rolled switch outside the recorded baseline", () => {
    const allowed = new Set(BASELINE);
    const offenders = filesWithHandRolledToggle().filter(
      (path) => !allowed.has(path),
    );
    expect(offenders).toEqual([]);
  });

  // A scan that reads prose is a scan whose cheapest fix is a weaker comment,
  // so it reads code only -- and that has to hold in BOTH directions, or the
  // stripper silently blinds the rule it protects.
  it("ignores the attribute in a comment and still catches it in markup", () => {
    const explained = [
      "/**",
      ' * A second tree would double every role="switch" in the a11y tree.',
      " */",
      "export const x = 1;",
    ].join("\n");
    expect(HAND_ROLLED.test(withoutComments(explained))).toBe(false);
    expect(
      HAND_ROLLED.test(withoutComments('<button role="switch" />')),
    ).toBe(true);
  });

  it("keeps the baseline shrink-only", () => {
    const offending = new Set(filesWithHandRolledToggle());
    expect(BASELINE.filter((file) => !offending.has(file))).toEqual([]);
  });

  it("still finds the shared component, so the rule cannot pass by accident", () => {
    const toggle = sources[TOGGLE];
    expect(toggle, `${TOGGLE} not found -- update TOGGLE in this test`).toBeTruthy();
    expect(HAND_ROLLED.test(toggle)).toBe(true);
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
    "/src/app/confirm-email-change/page.tsx",
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

  /**
   * The reports grew their own variant: a bare grey paragraph with
   * `text-center py-8`, in some thirty report components. Scoped to the
   * report directories, where every one of them was converted; the same class
   * pair elsewhere in the tree is tracked by the other UI consistency issues.
   */
  const REPORT_DIRS = ["/src/components/reports/", "/src/app/reports/"];
  const REPORT_FINGERPRINT = /\btext-center py-8\b/;

  it("has no hand-rolled empty-state paragraph in a report", () => {
    const offenders = productionSources()
      .filter(([path]) => REPORT_DIRS.some((dir) => path.startsWith(dir)))
      .filter(([, content]) => REPORT_FINGERPRINT.test(withoutComments(content)))
      .map(([path]) => path);
    expect(offenders, "Render EmptyState from @/components/ui/EmptyState.").toEqual([]);
  });

  it("still scans the reports, so the rule cannot pass by accident", () => {
    expect(
      productionSources().filter(([path]) => path.startsWith(REPORT_DIRS[0])).length,
    ).toBeGreaterThan(0);
    expect(
      REPORT_FINGERPRINT.test('<p className="text-gray-500 text-center py-8">'),
    ).toBe(true);
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
   * but class-attribute order means nothing to CSS -- only stylesheet order
   * decides, and Tailwind emits the display utilities in a fixed sequence with
   * `.hidden` FIRST. Two mistakes follow from forgetting that:
   *
   * - `hidden sm:block` on the payee list left every letter jammed against
   *   the top-left of its circle (`block` beat `inline-flex`), which reads as
   *   a rendering fault rather than a class conflict.
   * - `hidden sm:inline-flex` on the register never hid the badge on phones
   *   at all: the badge's own base `inline-flex` beats the earlier-emitted
   *   `hidden`, so the letter circles stayed visible on mobile.
   *
   * Responsive hiding of a logo is therefore spelled `max-sm:hidden` -- a
   * variant sorts after every base utility, so it wins below the breakpoint
   * and applies nothing above it.
   */
  const LOGO_TAGS = /<(?:BrandLogo|PayeeLogo|InstitutionLogo)\b[\s\S]{0,400}?\/>/g;
  /** A display utility, at any breakpoint, inside that element's className. */
  const DISPLAY_UTILITY =
    /className="[^"]*\b(?:[a-z]+:)?(?:block|grid|inline-block|flow-root)\b[^"]*"/;
  /**
   * A bare `hidden` token (no variant prefix) in that element's className --
   * it sorts before the badge's own `inline-flex` and so never hides it.
   */
  const BARE_HIDDEN = /className="(?:[^"]*\s)?hidden(?:\s[^"]*)?"/;

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

  it("has no call site trying to hide a logo with a bare `hidden`", () => {
    const offenders: string[] = [];
    for (const [path, content] of productionSources()) {
      for (const match of content.matchAll(LOGO_TAGS)) {
        if (BARE_HIDDEN.test(match[0])) {
          offenders.push(path);
        }
      }
    }
    expect(
      [...new Set(offenders)],
      "a bare `hidden` loses to the badge's own `inline-flex`; spell responsive hiding `max-sm:hidden`",
    ).toEqual([]);
  });

  it("still finds the badge's centring, so the rule cannot pass by accident", () => {
    const brandLogo = sources["/src/components/ui/BrandLogo.tsx"];
    expect(brandLogo, "BrandLogo.tsx not found -- update this test").toBeTruthy();
    expect(brandLogo).toContain("inline-flex items-center justify-center");
  });

  it("recognises the shapes it is looking for", () => {
    // Were the tag regex to stop matching, the scans above would police an
    // empty set.
    const sample = '<PayeeLogo payee={p} size={20} className="hidden sm:block" />';
    const [found] = [...sample.matchAll(LOGO_TAGS)];
    expect(found).toBeTruthy();
    expect(DISPLAY_UTILITY.test(found[0])).toBe(true);
    expect(BARE_HIDDEN.test(found[0])).toBe(true);
    expect(
      BARE_HIDDEN.test('<PayeeLogo className="hidden sm:inline-flex" />'),
    ).toBe(true);
    expect(BARE_HIDDEN.test('<PayeeLogo className="hidden" />')).toBe(true);
    // The sanctioned spelling: the variant prefix keeps `hidden` from being a
    // bare token, and neither scan flags it.
    const sanctioned = '<PayeeLogo className="mt-0.5 max-sm:hidden" />';
    expect(DISPLAY_UTILITY.test(sanctioned)).toBe(false);
    expect(BARE_HIDDEN.test(sanctioned)).toBe(false);
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
    "/src/components/ui/DragHandle.tsx",
    "/src/components/ui/IconPicker.tsx",
    "/src/components/ui/MultiSelect.tsx",
    "/src/components/ui/Pagination.tsx",
    "/src/components/ui/Select.tsx",
    "/src/components/ui/ThemeToggle.tsx",
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
    "/src/app/budgets/[id]/edit/page.tsx",
    "/src/app/error.tsx",
    "/src/app/not-found.tsx",
    "/src/app/reports/page.tsx",
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
    "/src/components/notifications/NotificationBell.tsx",
    "/src/components/notifications/NotificationList.tsx",
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
    "/src/components/transactions/TransactionForm.tsx",
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
    "/src/app/budgets/[id]/edit/page.tsx",
    "/src/app/categories/[id]/page.tsx",
    "/src/app/categories/page.tsx",
    "/src/app/institutions/page.tsx",
    "/src/app/payees/[id]/page.tsx",
    "/src/app/payees/page.tsx",
    "/src/app/reconcile/page.tsx",
    "/src/app/securities/[id]/page.tsx",
    "/src/app/settings/emergency-access/page.tsx",
    "/src/app/tags/page.tsx",
    "/src/components/accounts/AccountFormModal.tsx",
    "/src/components/accounts/shared/ForeignCurrencyFeesSection.tsx",
    "/src/components/accounts/shared/RecurringChargesPanel.tsx",
    "/src/components/categories/detail/CategoryTransactionsTab.tsx",
    "/src/components/investments/InvestmentTransactionForm.tsx",
    "/src/components/layout/MobileNavDrawer.tsx",
    "/src/components/payees/detail/PayeeTransactionsTab.tsx",
    "/src/components/reports/ForeignCurrencyFeesReport.tsx",
    "/src/components/scheduled-transactions/ScheduledTransactionForm.tsx",
    "/src/components/securities/SecurityForm.tsx",
    "/src/components/securities/SecurityTransactionHistory.tsx",
    "/src/components/settings/ApiAccessSection.tsx",
    "/src/components/settings/BackupRestoreSection.tsx",
    "/src/components/settings/SecuritySection.tsx",
    "/src/components/settings/SharedAccessSection.tsx",
    "/src/components/settings/SupportBackupModal.tsx",
    "/src/components/settings/ai/ProviderConfigForm.tsx",
    "/src/components/transactions/CurrencyPickerButton.tsx",
    "/src/components/transactions/TransactionActionSheet.tsx",
    "/src/components/transactions/TransactionForm.tsx",
    "/src/components/ui/ConfirmDialog.tsx",
    "/src/components/ui/UnsavedChangesDialog.tsx",
    "/src/components/ui/row-actions/RowActionSheet.tsx",
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
    "/src/components/budgets/BudgetCategoryTrend.tsx",
    "/src/components/budgets/BudgetPeriodDetail.tsx",
    "/src/components/budgets/BudgetWizard.tsx",
    "/src/components/categories/detail/CategoryDetailHeader.tsx",
    "/src/components/payees/AutoMergePayeesDialog.tsx",
    "/src/components/payees/CategoryAutoAssignDialog.tsx",
    "/src/components/payees/detail/PayeeDetailHeader.tsx",
    "/src/components/reconcile/ReconcileTable.tsx",
    "/src/components/reports/DuplicateTransactionReport.tsx",
    "/src/components/reports/FilterBuilder.tsx",
    "/src/components/reports/RecurringExpensesReport.tsx",
    "/src/components/reports/SpendingAnomaliesReport.tsx",
    "/src/components/scheduled-transactions/ScheduledTransactionList.tsx",
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

describe("a date-only string reaches formatDate unwrapped", () => {
  /**
   * `formatDate` takes `Date | string` and parses a string through
   * `parseLocalDate`, which reads `YYYY-MM-DD` as a LOCAL day. Wrapping the same
   * string in `new Date(...)` first parses it as UTC midnight, and the local
   * getters that format it then report the day before for every viewer west of
   * Greenwich -- the loan and mortgage previews printed "Dec 14, 2026" over a
   * payoff date of 2026-12-15.
   *
   * The scan is scoped to the account surfaces because the pattern is correct
   * elsewhere: `formatDate(new Date(token.createdAt))` formats an *instant*, and
   * for an instant `new Date` is the right reading. What distinguishes them is
   * the field's type, not its spelling -- so the rule is enforced where the
   * fields are date-only (`AmortizationPreview.endDate`,
   * `MortgagePreview.endDate`, and the account dates beside them) rather than
   * repository-wide, where it would report seven correct call sites.
   *
   * CI runs in UTC, where the two readings agree, so no rendering test can see
   * this difference. A source scan is the only mechanism left.
   */
  const SCOPE = /^\/src\/components\/accounts\//;
  const WRAPPED = /formatDate\(\s*new Date\(/;

  it("has no formatDate(new Date(...)) on an account surface", () => {
    const offenders = productionSources()
      .filter(([path]) => SCOPE.test(path))
      .filter(([, content]) => WRAPPED.test(content))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("still scans a non-empty set of account surfaces", () => {
    const scanned = productionSources().filter(([path]) => SCOPE.test(path));
    expect(scanned.length).toBeGreaterThan(10);
    // And the pattern really does match, so an empty offender list means the
    // rule holds rather than that the regex stopped working.
    expect(WRAPPED.test("{formatDate(new Date(preview.endDate))}")).toBe(true);
    expect(WRAPPED.test("{formatDate(preview.endDate)}")).toBe(false);
  });
});

describe("a payee contact lookup surface asks whether a lookup can run", () => {
  /**
   * `useAiConfigured` answers "does this user have an AI provider", which was
   * the whole question while AI was the only lookup source. Google Places now
   * answers the same lookup, so a surface gated on the AI hook hides its
   * button from exactly the user this feature exists for -- one who configured
   * Places and no AI. `useContactLookupAvailable` is the question those
   * surfaces have to ask.
   *
   * The assistant is deliberately unaffected: a chat genuinely needs a model,
   * so `AiChatBubble` and `AiBubbleToggle` keep the AI hook.
   */
  const LOOKUP_CALLERS =
    /payeesApi\.lookupContact|usePayeeContactLookup|ContactLookupDialog/;
  const AI_HOOK = /useAiConfigured/;

  function lookupSurfaces(): [string, string][] {
    return productionSources()
      .map(([path, content]) => [path, withoutComments(content)] as [string, string])
      .filter(([path, content]) => {
        // The hook and the dialog's own module define these names rather than
        // consuming them.
        if (path.endsWith("/useContactLookupAvailable.ts")) return false;
        if (path.endsWith("/ContactLookupDialog.tsx")) return false;
        return LOOKUP_CALLERS.test(content);
      });
  }

  it("finds the lookup surfaces, so the rule below is not vacuous", () => {
    // A scan that silently matched nothing is the failure mode of every guard
    // here, so it asserts its own subject first.
    expect(lookupSurfaces().length).toBeGreaterThan(1);
  });

  it("gates no lookup surface on the AI-only hook", () => {
    const offenders = lookupSurfaces()
      .filter(([, content]) => AI_HOOK.test(content))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("still recognises the pattern it bans", () => {
    // Comments are stripped first, so the paragraph above -- which has to name
    // the banned hook to explain itself -- cannot fail its own rule.
    const offending = `import { useAiConfigured } from '@/hooks/useAiConfigured';
      const x = usePayeeContactLookup();`;
    expect(LOOKUP_CALLERS.test(offending)).toBe(true);
    expect(AI_HOOK.test(withoutComments(offending))).toBe(true);
    expect(AI_HOOK.test(withoutComments("// useAiConfigured is banned here"))).toBe(
      false,
    );
  });
});

describe("a random value comes from the Web Crypto API", () => {
  /**
   * `Math.random()` is not a security primitive, and every use of it in the
   * client so far has been an id: a list key, a removal handle, a temporary
   * split row. Those want uniqueness, which `crypto.randomUUID()` gives with
   * no argument about strength -- and Bearer flags the alternative as
   * CWE-330, which cost an exception with a review date rather than a fix
   * (issue #1323). `lib/ai-attachments.ts` is the pattern; `SplitEditor` was
   * the last holdout.
   */
  const WEAK_RANDOM = /\bMath\.random\b/;

  it("never calls Math.random in a production source", () => {
    const offenders = productionSources()
      .filter(([, source]) => WEAK_RANDOM.test(withoutComments(source)))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it("still finds the sanctioned helper, so the rule cannot pass by accident", () => {
    const users = productionSources().filter(([, source]) =>
      /crypto\.randomUUID\(\)/.test(withoutComments(source)),
    );
    expect(users.length).toBeGreaterThan(0);
  });

  it("catches the pattern it bans", () => {
    expect(
      WEAK_RANDOM.test(withoutComments("id: `temp-${Date.now()}-${Math.random()}`")),
    ).toBe(true);
    // ...and reads its own explanation as prose, not as a violation.
    expect(WEAK_RANDOM.test(withoutComments("// not Math.random"))).toBe(false);
  });
});

describe("a report's export and refresh are one actions row", () => {
  /**
   * Every report toolbar laid its trailing buttons out for itself, and a dozen
   * of them got it wrong the same way: an unwrapped row carried the export off
   * the right of a phone. `ReportToolbarActions` is the one answer -- a
   * full-width row below every selector on a phone, two equal halves when the
   * report also refreshes prices, the toolbar's trailing group from `sm` up.
   * A report that renders `ExportDropdown` or `RefreshPricesButton` itself is
   * writing that layout a second time. `ExportDropdown` draws all three shapes
   * -- CSV and PDF, PDF alone, CSV alone -- so a report exporting one format is
   * not a reason to hand-roll a button either.
   *
   * The rule is about REPORTS. `components/ui/ExportDropdown.tsx` is the button
   * itself, `RefreshPricesButton.tsx` wraps the refresh hook for callers
   * outside this tree (an account detail header), and `ReportToolbarActions`
   * composes both -- those three are the mechanism, not instances of it.
   */
  const ACTIONS_OWNER = "/src/components/reports/ReportToolbarActions.tsx";
  const MECHANISM = new Set([
    ACTIONS_OWNER,
    "/src/components/ui/ExportDropdown.tsx",
    "/src/components/reports/RefreshPricesButton.tsx",
  ]);
  const RENDERS_ACTION = /<(ExportDropdown|RefreshPricesButton)\b/;

  function reportsRenderingTheirOwn(): string[] {
    return productionSources()
      .filter(([path]) => path.startsWith("/src/components/reports/"))
      .filter(([path]) => !MECHANISM.has(path))
      .filter(([, source]) => RENDERS_ACTION.test(withoutComments(source)))
      .map(([path]) => path);
  }

  it("has no report laying out its own export or refresh button", () => {
    expect(reportsRenderingTheirOwn()).toEqual([]);
  });

  it("still finds the shared row in use, so the rule cannot pass by accident", () => {
    const users = productionSources().filter(([path, source]) =>
      path.startsWith("/src/components/reports/") &&
      path !== ACTIONS_OWNER &&
      /<ReportToolbarActions\b/.test(withoutComments(source)),
    );
    expect(users.length).toBeGreaterThan(20);
  });

  it("catches the pattern it bans", () => {
    expect(RENDERS_ACTION.test(withoutComments("<ExportDropdown onExportPdf={x} />"))).toBe(
      true,
    );
    expect(RENDERS_ACTION.test(withoutComments("<RefreshPricesButton />"))).toBe(true);
    // ...and reads its own explanation as prose, not as a violation.
    expect(
      RENDERS_ACTION.test(withoutComments("// wired to the <ExportDropdown /> above")),
    ).toBe(false);
  });
});

/**
 * A dashboard widget shows the same figures a report does, so it asks the
 * report rather than aggregating the ledger beside it.
 *
 * Expenses by Category summed paged transactions in the browser under its own
 * rules: no VOID check, no asset-category exclusion, and investment rows decided
 * by the account TYPE, which is INV-REPORT-001's exact failure. It disagreed
 * with the Spending by Category report about the same period, and every guard
 * that holds those rules scans the server, where the widget's arithmetic was
 * not. The server-side answer is now the only one.
 */
describe("a dashboard widget reads a report rather than re-deriving it", () => {
  /**
   * Widgets that still aggregate the transaction ledger themselves, each one a
   * breakdown that can drift from the report it sits beside. Empty, and
   * SHRINK-ONLY: the fix is to read the report's endpoint, never to add a name
   * here.
   */
  const BASELINE: ReadonlyArray<string> = [];
  const READS_LEDGER = /from\s+["']@\/lib\/transactions["']/;

  function widgetsAggregatingTheLedger(): string[] {
    return productionSources()
      .filter(([path]) => path.startsWith("/src/components/dashboard/"))
      .filter(([, source]) => READS_LEDGER.test(withoutComments(source)))
      .map(([path]) => path);
  }

  it("has no widget aggregating transactions outside the recorded baseline", () => {
    const allowed = new Set(BASELINE);
    expect(
      widgetsAggregatingTheLedger().filter((path) => !allowed.has(path)),
    ).toEqual([]);
  });

  it("keeps the baseline shrink-only", () => {
    const offending = new Set(widgetsAggregatingTheLedger());
    expect(BASELINE.filter((file) => !offending.has(file))).toEqual([]);
  });

  it("still reads the widgets, so an empty baseline is not an empty scan", () => {
    // With nothing left on the baseline the rule passes trivially if the sweep
    // finds no files at all, so the sweep itself is checked.
    const widgets = productionSources().filter(([path]) =>
      path.startsWith("/src/components/dashboard/"),
    );
    expect(widgets.length).toBeGreaterThan(15);
  });

  it("catches the import it bans, and reads a mention of it as prose", () => {
    expect(
      READS_LEDGER.test(
        withoutComments("import { transactionsApi } from '@/lib/transactions';"),
      ),
    ).toBe(true);
    expect(
      READS_LEDGER.test(
        withoutComments("// it used to import from '@/lib/transactions'"),
      ),
    ).toBe(false);
  });
});

/**
 * The Cash Flow Sankey draws a merged "Other" node, and that merge is drawing
 * only (SANKEY-005, INV-REPORT-002): the table and the summary cards read the
 * server's unmerged response. A report component that imported a sum helper
 * could build a figure from the merged drawing; the merge itself lives in
 * `sankey-layout.ts`, which returns new arrays and never touches the response.
 */
describe("the Cash Flow Sankey sums nothing beside the server", () => {
  // The report, the diagram it shares with the dashboard widget, and the widget.
  const SANKEY_COMPONENT =
    /^\/src\/components\/(?:reports\/CashFlowSankey[^/]*|dashboard\/CashFlowSankeyWidget)\.tsx$/;
  const LAYOUT = "/src/components/reports/sankey-layout.ts";
  const AGGREGATES =
    /from\s+["']@\/components\/transactions\/widget-shared["']|\b(?:sumMoney|sumConverted|sumEffectiveOccurrences|netEntityTotal|summarizeInDisplayCurrency)\b|\.reduce\(/;

  function offenders(): string[] {
    return productionSources()
      .filter(([path]) => SANKEY_COMPONENT.test(path))
      .filter(([, source]) => AGGREGATES.test(withoutComments(source)))
      .map(([path]) => path);
  }

  it("imports no aggregation helper into the report component", () => {
    expect(offenders()).toEqual([]);
  });

  it("still finds the Sankey components, so the rule cannot pass by accident", () => {
    expect(
      productionSources()
        .filter(([path]) => SANKEY_COMPONENT.test(path))
        .map(([path]) => path)
        .sort(),
    ).toEqual([
      "/src/components/dashboard/CashFlowSankeyWidget.tsx",
      "/src/components/reports/CashFlowSankeyDiagram.tsx",
      "/src/components/reports/CashFlowSankeyReport.tsx",
    ]);
  });

  it("never assigns into the response it lays out", () => {
    const source = withoutComments(sources[LAYOUT] ?? "");
    expect(source.length).toBeGreaterThan(0);
    expect(/response\.(?:nodes|links)\.(?:push|splice|sort|reverse)\(/.test(source)).toBe(false);
    expect(/response\.[\w.[\]]+\s*=[^=]/.test(source)).toBe(false);
  });

  it("catches the shapes it bans, and reads a mention of them as prose", () => {
    expect(AGGREGATES.test(withoutComments("const t = sumMoney(values);"))).toBe(true);
    expect(AGGREGATES.test(withoutComments("const t = links.reduce((a, l) => a + l.value, 0);"))).toBe(true);
    expect(
      AGGREGATES.test(withoutComments("import { netEntityTotal } from '@/components/transactions/widget-shared';")),
    ).toBe(true);
    expect(AGGREGATES.test(withoutComments("// it must not call sumMoney here"))).toBe(false);
  });
});

describe("a dashboard card stretches to its row, never `h-full`", () => {
  /**
   * A widget card is an item of the dashboard's auto-sized grid rows, and a
   * grid item with `height: 100%` is asking for a percentage of a track whose
   * size it is itself supposed to decide. Chromium and Gecko resolve the cycle
   * by measuring the item's content first, so the row grows and nothing shows;
   * WebKit -- every browser on iPad, whatever its badge says -- takes the row
   * from the item's SIBLING instead. One widget per row is the same answer
   * either way, which is why a phone and a portrait tablet look right and a
   * landscape tablet does not: the card keeps its neighbour's height while its
   * own content, the Expense by Category chart with its Other list opened,
   * spills out of the box it is drawn in.
   *
   * `align-items: stretch` is the grid's default, so the card fills its row
   * with `h-full` deleted rather than in spite of it. The scan keys on the card
   * shell specifically -- a class list that carries the card surface, the
   * widget min-height, or WidgetCard's `minHeightClass` -- so an `h-full` on
   * something inside a widget, which is not a grid item, is not the subject.
   */
  const CARD_SHELL = /CARD_CLASS|minHeightClass|min-h-\[/;
  const FULL_HEIGHT = /(?<![\w:-])h-full\b/;

  function widgetShellsPinningTheirHeight(): string[] {
    const offenders: string[] = [];
    for (const [path, content] of productionSources()) {
      if (!path.startsWith("/src/components/dashboard/")) continue;
      withoutComments(content)
        .split("\n")
        .forEach((line, i) => {
          if (CARD_SHELL.test(line) && FULL_HEIGHT.test(line)) {
            offenders.push(`${path}:${i + 1}`);
          }
        });
    }
    return offenders;
  }

  it("has no widget card shell setting h-full", () => {
    expect(
      widgetShellsPinningTheirHeight(),
      "Delete `h-full`: the grid stretches the card to its row already, and a percentage height there is read from the neighbouring widget on WebKit.",
    ).toEqual([]);
  });

  it("still reads the widgets, so the rule cannot pass over an empty sweep", () => {
    const shells = productionSources().filter(
      ([path, content]) =>
        path.startsWith("/src/components/dashboard/") &&
        CARD_SHELL.test(withoutComments(content)),
    );
    expect(shells.length).toBeGreaterThan(5);
  });

  it("catches a planted shell and ignores an inner fill or a prose mention", () => {
    expect(
      CARD_SHELL.test("`${CARD_CLASS} lg:min-h-[500px] flex flex-col h-full`") &&
        FULL_HEIGHT.test("`${CARD_CLASS} lg:min-h-[500px] flex flex-col h-full`"),
    ).toBe(true);
    expect(
      CARD_SHELL.test('<div className="flex-1 min-h-0 h-full">'),
    ).toBe(false);
    expect(FULL_HEIGHT.test('<div className="lg:h-full">')).toBe(false);
    expect(
      FULL_HEIGHT.test(withoutComments("// the shell used to carry h-full")),
    ).toBe(false);
  });
});

describe("a segmented control wears the chrome in segmented-control.ts", () => {
  /**
   * A pill holding two or more buttons where exactly one is pressed is one
   * appearance, and `components/ui/segmented-control.ts` is where it is
   * written. The reason here IS repair, not only reach: `ViewModeToggle` was
   * added as a copy of `InvestmentViewToggle`'s three class constants and had
   * already drifted by a `motion-reduce:transition-none` before either shipped,
   * so the Investments toolbar would have carried two switches side by side and
   * animated only one of them for a reader who asked for reduced motion.
   *
   * Two shapes break the rule and both are scanned: re-declaring a constant
   * locally, and inlining the pressed segment's VALUE at a call site, which
   * imports nothing and so silently skips the next change to it.
   */
  const HOME = "/src/components/ui/segmented-control.ts";
  const LOCAL_DECL =
    /\bconst\s+(BUTTON_BASE|BUTTON_ACTIVE|BUTTON_INACTIVE|SEGMENT_BASE_CLASS|SEGMENT_ACTIVE_CLASS|SEGMENT_INACTIVE_CLASS|SEGMENTED_GROUP_CLASS)\s*=/;
  /** `SEGMENT_ACTIVE_CLASS`'s value spelled out instead of imported. */
  const INLINE_ACTIVE =
    /["'`]bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm/;

  /**
   * Call sites that still inline it, with the reason each is here. Shrink-only:
   * fixing one means DELETING its line, and the third test fails while a listed
   * file no longer offends, so the register cannot outlive its subjects.
   */
  const INLINE_ACTIVE_BASELINE: ReadonlyArray<{ file: string; reason: string }> = [
    {
      file: "/src/components/bills/CashFlowForecastChart.tsx",
      reason:
        "predates the shared chrome: a range switcher built before segmented-control.ts existed.",
    },
  ];

  const inliningFiles = () => {
    const found = new Set<string>();
    for (const [path, content] of productionSources()) {
      if (path === HOME) continue;
      for (const line of withoutComments(content).split("\n")) {
        if (INLINE_ACTIVE.test(line)) found.add(path);
      }
    }
    return found;
  };

  it("no file re-declares the segmented-control classes locally", () => {
    const offenders: string[] = [];
    for (const [path, content] of productionSources()) {
      if (path === HOME) continue;
      withoutComments(content)
        .split("\n")
        .forEach((line, i) => {
          const match = line.match(LOCAL_DECL);
          if (match) offenders.push(`${path}:${i + 1} re-declares ${match[1]}`);
        });
    }

    expect(
      offenders,
      "Import segmentClass and SEGMENTED_GROUP_CLASS from @/components/ui/segmented-control.",
    ).toEqual([]);
  });

  it("no new call site inlines the pressed segment's classes", () => {
    const allowed = new Set(INLINE_ACTIVE_BASELINE.map((entry) => entry.file));
    const offenders: string[] = [];
    for (const [path, content] of productionSources()) {
      if (path === HOME || allowed.has(path)) continue;
      withoutComments(content)
        .split("\n")
        .forEach((line, i) => {
          if (INLINE_ACTIVE.test(line)) {
            offenders.push(`${path}:${i + 1} inlines SEGMENT_ACTIVE_CLASS`);
          }
        });
    }

    expect(
      offenders,
      "Call segmentClass(isActive) from @/components/ui/segmented-control.",
    ).toEqual([]);
  });

  it("keeps the inlined-segment baseline shrink-only", () => {
    const offending = inliningFiles();
    expect(
      INLINE_ACTIVE_BASELINE.map((entry) => entry.file).filter(
        (file) => !offending.has(file),
      ),
      "This file no longer inlines the pressed segment -- delete its baseline line.",
    ).toEqual([]);
  });

  it("reads the inlined classes in markup but not a mention of them in prose", () => {
    // Both directions: this block's own explanation names the constants it
    // bans re-declaring, and must not itself be a violation.
    expect(
      INLINE_ACTIVE.test(
        "className={active ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm' : ''}",
      ),
    ).toBe(true);
    expect(
      LOCAL_DECL.test(withoutComments("// const BUTTON_BASE = 'px-3 py-1';")),
    ).toBe(false);
    expect(LOCAL_DECL.test("const BUTTON_BASE = 'px-3 py-1';")).toBe(true);
  });
});

describe("a month grid is MonthGrid", () => {
  /**
   * `components/ui/MonthGrid.tsx` is the month layout: whole weeks from
   * `monthGridDays`, `common.weekdaysMin` rotated to the reader's
   * `weekStartsOn`, `role="grid"` with one roving tab stop, arrow keys,
   * `aria-current="date"` on the day the SERVER calls today.
   *
   * A hand-rolled copy is not merely duplicated markup. The two that predate
   * it hardcode Sunday as the week start, key their cells by a `Date` built
   * from a calendar string (the last day of the previous month west of UTC),
   * and expose no grid semantics at all, so a keyboard reader tabs through
   * every day of the month one stop at a time. Each of those is invisible in
   * the one timezone and the one locale CI runs in.
   *
   * The scan keys on an unprefixed `grid-cols-7`: seven columns with no
   * responsive prefix is a week, and a week laid out outside `MonthGrid` is a
   * second month grid being born. A responsive `lg:grid-cols-7` is a card
   * shelf that happens to hold seven cards and is not caught.
   */
  const GRID = "/src/components/ui/MonthGrid.tsx";
  const SEVEN_COLUMNS = /(?<![\w:-])grid-cols-7\b/;

  /**
   * The month grids that predate `MonthGrid`. Shrink-only: task M1 migrates
   * both onto the shared grid, and migrating one means DELETING its line --
   * the third test fails while a listed file no longer offends, so the list
   * cannot outlive its subjects.
   */
  const BASELINE: ReadonlyArray<{ file: string; reason: string }> = [
    {
      file: "/src/components/bills/ScheduledCalendarGrid.tsx",
      reason:
        "the Bills & Deposits calendar and the Upcoming Bills widget; migrates in M1, which is also what retires its browser-side recurrence walk.",
    },
    {
      file: "/src/components/reports/UpcomingBillsReport.tsx",
      reason:
        "the report's own calendar view, a third copy of the same markup; migrates in M1 onto ScheduledCalendarGrid's replacement.",
    },
  ];

  /**
   * Seven columns that are not a month, recorded as decisions rather than as
   * debt: neither draws weeks of a month, so neither is the thing the rule is
   * about.
   */
  const NOT_A_MONTH: ReadonlyArray<{ file: string; reason: string }> = [
    {
      file: "/src/components/ui/CalendarPopover.tsx",
      reason:
        "the date-entry popover behind DateInput. It picks one day rather than displaying a month of content, and it is the one grid a MonthGrid cell may itself sit beside.",
    },
    {
      file: "/src/components/reports/WeekendVsWeekdayReport.tsx",
      reason:
        "seven weekday tiles under the chart -- one per day of the week, no month, no dates.",
    },
  ];

  function filesWithSevenColumns(): string[] {
    return productionSources()
      .filter(([path]) => path !== GRID)
      .filter(([, source]) => SEVEN_COLUMNS.test(withoutComments(source)))
      .map(([path]) => path)
      .sort();
  }

  it("has no second month grid outside the recorded baseline", () => {
    const allowed = new Set([
      ...BASELINE.map((entry) => entry.file),
      ...NOT_A_MONTH.map((entry) => entry.file),
    ]);

    expect(
      filesWithSevenColumns().filter((path) => !allowed.has(path)),
      "Render the month through <MonthGrid> (components/ui/MonthGrid.tsx) and pass a renderDay.",
    ).toEqual([]);
  });

  it("keeps the baseline shrink-only", () => {
    const offending = new Set(filesWithSevenColumns());
    expect(
      [...BASELINE, ...NOT_A_MONTH]
        .map((entry) => entry.file)
        .filter((file) => !offending.has(file)),
      "This file no longer lays out seven columns -- delete its line here.",
    ).toEqual([]);
  });

  it("still finds the shared grid, so the rule cannot pass by accident", () => {
    const grid = sources[GRID];
    expect(grid, `${GRID} not found -- update GRID in this test`).toBeTruthy();
    expect(SEVEN_COLUMNS.test(grid)).toBe(true);
  });

  it("catches a planted week and ignores a responsive seven-card shelf", () => {
    expect(SEVEN_COLUMNS.test('<div className="grid grid-cols-7">')).toBe(true);
    expect(SEVEN_COLUMNS.test("'lg:grid-cols-7',")).toBe(false);
    expect(SEVEN_COLUMNS.test('<div className="md:grid-cols-7">')).toBe(false);
    expect(
      SEVEN_COLUMNS.test(withoutComments("// a second grid-cols-7 is the defect")),
    ).toBe(false);
  });
});

/**
 * An investment transaction's `price`, `commission` and `totalAmount` are in the
 * SECURITY's currency, and `formatCurrency(value)` with no second argument
 * formats in the READER's. One-argument formatting of those three fields is
 * therefore a mislabel every time, and it is a mechanical one: the call names
 * the field it is about. Issue #1394 shipped exactly this, twice, in one file.
 *
 * `docs/frontend/financial-figures.md` ("An investment row's money is in the
 * row's own currency") has the rule and what to pass instead.
 */
describe("an investment amount is formatted with its own currency", () => {
  /**
   * A `formatCurrency*` call whose single argument mentions one of the three
   * fields. The argument list is matched up to the first top-level `)` or `,`
   * (one level of nesting is allowed, for `Math.abs(tx.totalAmount)`), so a
   * call that DOES pass a currency has a comma and does not match.
   */
  const SINGLE_ARGUMENT_FORMAT_CALL =
    /\b(?:formatCurrency\w*|fmtValue)\(\s*((?:[^,()]|\([^()]*\))*)\)/g;
  const INVESTMENT_MONEY_FIELD = /\b(?:totalAmount|\.price|\.commission)\b/;
  const UNLABELLED_INVESTMENT_MONEY = {
    test(line: string): boolean {
      for (const match of line.matchAll(SINGLE_ARGUMENT_FORMAT_CALL)) {
        if (INVESTMENT_MONEY_FIELD.test(match[1])) return true;
      }
      return false;
    },
  };

  /**
   * Only a file that handles investment rows is in scope: `totalAmount` is
   * also the name of an ordinary transaction aggregate (the recurring-expense
   * surfaces), which is in the account's currency and is not this rule's.
   */
  const INVESTMENT_ROW_TYPES = /\b(?:InvestmentTransaction|RealizedGain)\w*\b/;

  function offendingLines(): string[] {
    const found: string[] = [];
    for (const [path, content] of productionSources()) {
      if (!INVESTMENT_ROW_TYPES.test(content)) continue;
      withoutComments(content)
        .split("\n")
        .forEach((line, index) => {
          if (UNLABELLED_INVESTMENT_MONEY.test(line)) {
            found.push(`${path}:${index + 1}`);
          }
        });
    }
    return found;
  }

  it("never formats a price, commission or total amount in the reader's currency", () => {
    expect(
      offendingLines(),
      "Pass the row's own currency: formatCurrency(value, tx.amountCurrencyCode ?? tx.security?.currencyCode), and render UnknownAmount when it is null.",
    ).toEqual([]);
  });

  it("catches the mislabel and passes a labelled call", () => {
    expect(
      UNLABELLED_INVESTMENT_MONEY.test("formatCurrency(Math.abs(tx.totalAmount))"),
    ).toBe(true);
    expect(UNLABELLED_INVESTMENT_MONEY.test("formatCurrencyFull(tx.price)")).toBe(
      true,
    );
    // The wrapper shape, which is how the defect actually shipped: a local
    // `fmtValue` that formats in one report-wide display currency.
    expect(UNLABELLED_INVESTMENT_MONEY.test("fmtValue(entry.price)")).toBe(true);
    expect(
      UNLABELLED_INVESTMENT_MONEY.test(
        "formatCurrency(tx.totalAmount, tx.amountCurrencyCode)",
      ),
    ).toBe(false);
    expect(
      UNLABELLED_INVESTMENT_MONEY.test(
        withoutComments("// formatCurrency(tx.totalAmount) is the defect"),
      ),
    ).toBe(false);
  });
});

describe("a relative time is read through useRelativeTime", () => {
  /**
   * `formatRelativeTime` in `lib/format.ts` hardcoded English ("5m ago",
   * "Yesterday") and a browser-locale date, so a Polish reader got English
   * beside a translated page. It had no caller left and was removed;
   * `useRelativeTime()` goes through `Intl.RelativeTimeFormat` in the reader's
   * language.
   */
  const RAW_RELATIVE_TIME_IMPORT =
    /import\s*\{[^}]*\bformatRelativeTime\b[^}]*\}\s*from\s*["']@\/lib\/format["']/;
  const UI_FILE = /^\/src\/(components|app|hooks)\//;

  it("has no UI file importing formatRelativeTime from @/lib/format", () => {
    const offenders = productionSources()
      .filter(([path]) => UI_FILE.test(path))
      .filter(([, content]) => RAW_RELATIVE_TIME_IMPORT.test(withoutComments(content)))
      .map(([path]) => path);

    // Use `useRelativeTime()` (hooks/useRelativeTime.ts).
    expect(offenders).toEqual([]);
  });

  it("still recognises the import it bans", () => {
    expect(
      RAW_RELATIVE_TIME_IMPORT.test(
        "import { formatDate, formatRelativeTime } from '@/lib/format';",
      ),
    ).toBe(true);
    expect(
      RAW_RELATIVE_TIME_IMPORT.test("import { useRelativeTime } from '@/hooks/useRelativeTime';"),
    ).toBe(false);
  });

  it("has no English-only relative-time helper in lib/format.ts to import", () => {
    expect(sources["/src/lib/format.ts"]).not.toContain("formatRelativeTime");
  });
});
