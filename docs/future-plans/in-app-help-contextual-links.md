# Plan: help where the question arises (in-app help, plan 5)

Part of `docs/future-plans/in-app-help.md`; needs plan 2's panel. Tooltips,
empty screens and error messages gain a "Learn more" link that opens the panel
at the exact section. The mechanism is one small PR. The links themselves are
editorial work, added in batches by feature area, each batch its own PR.

## Assumptions (verified against the tree, 2026-11)

- `InfoTooltip` (`frontend/src/components/ui/InfoTooltip.tsx`) is the one way to
  explain a figure or a setting. It opens on hover, focus and tap, takes `text`,
  `placement`, `align`, `iconClassName`, `usePortal`, and is used in about 60
  components.
- `EmptyState` (`frontend/src/components/ui/EmptyState.tsx`) takes `icon`,
  `title`, `description`, `action` and is used in about 80 components.
- `docs-links.ts` destinations are page plus optional section, and
  `docs-links.test.ts` checks each against the generated website. Sections exist
  at h2 and h3 (for example `currency-management#rates-on-individual-transactions`,
  `transactions#foreign-currency-transactions`).
- `AGENTS.md` requires that a message withholding a figure name what is missing
  and where the reader obtains it (`docs/financial-calculation-contract.md`,
  section 1.3). A link to the section that explains the repair is the natural
  "where".

## Design

### The mechanism (first PR)

- `InfoTooltip` gains `learnMore?: DocsLink`. With it, the popover ends with a
  "Learn more" link, and the tooltip stays open long enough on hover to reach it
  (it already stays open on tap and focus). Clicking opens the panel at
  `helpTarget(learnMore)` and closes the tooltip. Without it, nothing changes.
- `EmptyState` gains `help?: DocsLink`, rendered as a quiet "How this works" link
  under the description. An `action` and `help` can sit together.
- `frontend/src/components/help/HelpLink.tsx` is the one inline "Learn more"
  link, for places that are neither (an error banner, a wizard step, a setting's
  description). It is an `<a href={docsUrl(key)}>` that opens the panel on a
  plain click, the same pattern as plan 2's header icon. Use it in place of the
  inline docs links that exist today (`UploadStep.tsx`, `CurrencyForm.tsx`,
  `PayeeLookupSection.tsx`, `InsightsList.tsx`).
- `ui-conventions.test.ts` (or a guard beside it) fails on a docs URL used
  outside `HelpLink`, `PageHeader` and `HelpSection`. Copy keys for "Learn more"
  and "How this works" go in the `help` namespace.

### The links (batches)

Each batch picks the confusing spots in one area, adds `DOCS_LINKS` keys for
their sections, and where no section answers the question, adds one to the
guide in the same PR (the guide is the fix, not the link). Suggested order, most
questions first:

1. Transactions: transfer versus category, splits, foreign-currency rate on a
   row, VOID, reconcile.
2. Currencies: the rate direction, missing-rate disclosures (each names the
   pair and links to the section on adding a rate), home currency.
3. Investments: cost basis, the per-share price derived from the total,
   period change versus return, cash versus investments (INV-PORTRESULT-001
   and -002 are exactly the distinctions readers ask about).
4. Bills and deposits: an occurrence override versus the schedule, the
   settlement account.
5. Budgets: velocity, rollover, excluded accounts.
6. Rules: conditions, testing a rule, running it on existing transactions.
7. Import: each wizard error links to the section that fixes it; CSV column
   mapping; QIF and OFX quirks.
8. Backups and security: encryption passphrase, restore, 2FA recovery codes.
9. Empty first-run screens: every feature's empty list gets `help`.

A batch also checks the existing tooltip text against the guide and fixes
whichever is wrong.

## Tests

- `InfoTooltip`: no link without `learnMore`; with it, the link opens the panel
  at the target and closes the popover; keyboard reachable; tap on phones.
- `EmptyState`: `help` renders the link and leaves `action` intact.
- `HelpLink`: plain click opens the panel; modified click is the browser's.
- The source guard above, with a self-test.
- `docs-links.test.ts` already covers every new key's page and anchor; nothing
  new is needed per batch.

## Docs

- `docs/frontend/ui-conventions.md`: "a tooltip that can say more takes
  `learnMore`; an empty first-run screen takes `help`; an inline guide link is
  `HelpLink`". Update the `frontend/CLAUDE.md` table row for `InfoTooltip` and
  the docs-link row.
- Guide sections added by a batch follow `website/README.md`, "Documentation".

## What to run

`frontend/` gates per `AGENTS.md`; `npm run docs:build` and `docs:check` when a
batch adds a guide section.

## Observable when done

The tooltip on a foreign-currency transaction's rate says what the rate means
and offers "Learn more", which opens the currency guide at "Rates on Individual
Transactions" beside the form, with what the reader typed still there.
