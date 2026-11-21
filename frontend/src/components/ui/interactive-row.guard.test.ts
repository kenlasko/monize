import { describe, it, expect } from 'vitest';
import { blankComments } from '@/test/blank-comments';

/**
 * Guard for B4: keyboard activation of a non-button control is written once,
 * in `ui/interactive-row.ts`.
 *
 * The mistake this catches is mechanical and had already happened four times.
 * A `<tr>` with `onClick` and `cursor-pointer` needs `tabIndex` plus an
 * Enter/Space handler to be reachable at all, and a focus ring to be followable
 * -- three tables wrote both out by hand, character for character, and the
 * copies that came before them each drifted (a `focus:` ring that paints on a
 * mouse click, a ring with no inset offset). One copy that forgets the handler
 * is a row nothing but a mouse can use, and nothing fails.
 *
 * Two fingerprints, one per half:
 *
 *   1. a `key` comparison against BOTH `'Enter'` and `' '` in the same block --
 *      the activation contract, in either the negated-early-return or the
 *      positive-`if` form, since both shipped here;
 *   2. the inset focus ring's `outline-offset-[-2px]`, which is the ring's
 *      fingerprint (the colour and width utilities appear on their own
 *      elsewhere and mean other things).
 *
 * The comparison scan needs an offender list, because three call sites this
 * package does not own still hold a near-copy. They are recorded below with the
 * reason, and the list is SHRINK-ONLY: a file that no longer holds the pattern
 * fails its own entry, so a fix cannot leave a stale exemption covering the
 * next copy.
 */

const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** The module that is allowed to hold both halves: it is the one home for them. */
const MODULE = '/src/components/ui/interactive-row.ts';

/** Source files only: a test may legitimately spell the pattern it asserts on. */
function productionSources(): [string, string][] {
  return Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path));
}

/** 1-indexed line number of a character offset, for an offender report. */
function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * A `key` comparison against `'Enter'` and one against a single space, within
 * one short window -- the whole activation block in either direction, so the
 * order the two keys are tested in does not matter.
 */
const ACTIVATION_BLOCK = [
  /key\s*(?:===|!==)\s*(['"])Enter\1[\s\S]{0,160}?key\s*(?:===|!==)\s*(['"]) \2/g,
  /key\s*(?:===|!==)\s*(['"]) \1[\s\S]{0,160}?key\s*(?:===|!==)\s*(['"])Enter\2/g,
];

/**
 * The un-converted near-copies, with why each is still here. Every one is a
 * `role="button"` element rather than a table row, carries its own focus-ring
 * spelling, and belongs to a surface outside this change -- so converting them
 * is a follow-up, not a silent exemption. Delete an entry when its file moves
 * onto `activateOnKey`; leaving it fails the staleness check below.
 */
const UNCONVERTED: Record<string, string> = {
  '/src/components/accounts/loan-detail/SavedScenariosPanel.tsx':
    'pre-existing near-copy on a role="button" row with a `focus-visible:ring-*` ring; not owned by this change',
  '/src/app/reports/page.tsx':
    'pre-existing near-copy on the favourite-star role="button" overlay, whose handler re-casts the event; not owned by this change',
};

describe('the comment stripper', () => {
  it('blanks a comment while preserving line numbers', () => {
    const stripped = blankComments("const a = 1;\n// key === 'Enter' || key === ' '\nconst b = 2;");
    expect(stripped).not.toContain('Enter');
    expect(stripped.split('\n')).toHaveLength(3);
  });

  it('leaves code alone, so a real offender is still found', () => {
    const stripped = blankComments("if (e.key === 'Enter' || e.key === ' ') act();");
    expect(stripped).toContain("'Enter'");
  });
});

describe('keyboard activation lives in one module', () => {
  function offenders(): string[] {
    const found: string[] = [];
    for (const [path, raw] of productionSources()) {
      if (path === MODULE || path in UNCONVERTED) continue;
      const content = blankComments(raw);
      for (const pattern of ACTIVATION_BLOCK) {
        for (const match of content.matchAll(pattern)) {
          found.push(`${path}:${lineOf(content, match.index)}`);
        }
      }
    }
    return found;
  }

  it('has no hand-rolled Enter/Space activation block', () => {
    // Use `activateOnKey(handler)` from `@/components/ui/interactive-row` for
    // the `onKeyDown`, and `INTERACTIVE_ROW_FOCUS_CLASS` for the ring beside it.
    expect(offenders()).toEqual([]);
  });

  it('still finds the module, so the rule cannot pass by accident', () => {
    // Were the module renamed or its exports moved, the scan above would pass
    // trivially over a codebase with no shared helper at all.
    const helper = sources[MODULE];
    expect(helper, `${MODULE} not found -- update this guard`).toBeTruthy();
    expect(helper).toContain('export function activateOnKey');
    expect(helper).toContain('export const INTERACTIVE_ROW_FOCUS_CLASS');
  });

  it('finds the canonical block inside the module', () => {
    // The scan is only worth its allowlist if it matches the real thing. The
    // module's own body is the positive control.
    const content = blankComments(sources[MODULE]);
    const matched = ACTIVATION_BLOCK.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(content);
    });
    expect(matched, 'the scan no longer matches the helper it was written for').toBe(true);
  });

  it('keeps every recorded near-copy honest', () => {
    for (const path of Object.keys(UNCONVERTED)) {
      expect(sources[path], `${path} is recorded as un-converted but does not exist`).toBeTruthy();
      const content = blankComments(sources[path]);
      const stillThere = ACTIVATION_BLOCK.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(content);
      });
      expect(
        stillThere,
        `${path} no longer hand-rolls the activation block -- delete its entry`,
      ).toBe(true);
    }
  });
});

describe('the inset focus ring lives in one module', () => {
  /**
   * The ring's fingerprint. `focus-visible:outline-2` and the blue colour
   * utilities appear on their own elsewhere for other elements; the negative
   * offset is what makes this ring the table one.
   */
  const INSET_RING = /outline-offset-\[-2px\]/g;

  it('is not spelled out anywhere else', () => {
    const found: string[] = [];
    for (const [path, raw] of productionSources()) {
      if (path === MODULE) continue;
      const content = blankComments(raw);
      for (const match of content.matchAll(INSET_RING)) {
        found.push(`${path}:${lineOf(content, match.index)}`);
      }
    }

    // Compose the ring as `${INTERACTIVE_ROW_FOCUS_CLASS}` instead. There is no
    // allowlist here on purpose: the three files that held it are converted.
    expect(found).toEqual([]);
  });

  it('is still in the module', () => {
    expect(blankComments(sources[MODULE])).toContain('outline-offset-[-2px]');
  });
});
