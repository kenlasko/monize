---
title: "Transactions page: a folded Account Info widget becomes a slim bar, and on a desktop a folded chart shows that bar too"
author: Ken
date: 2026-11-18
branch: feat/transactions-account-info-bar
cost: { minutes: 94, tokens: 666973 }
id: l-3d752a12
scope: repo
status: active
src: agent
touches:
  - frontend/src/components/transactions/AccountIdentity.tsx
  - frontend/src/components/transactions/AccountInfoBar.tsx
  - website/docs/transactions.md
  - frontend/src/app/transactions/page.tsx
  - frontend/src/components/transactions/AccountInfoWidget.tsx
  - frontend/src/hooks/useAccountSwitcherItems.ts
  - frontend/src/store/mobileChromeStore.ts
  - frontend/src/components/layout/CollapsedHeaderTitleView.tsx
  - frontend/src/test/collapsing-title.ts
  - frontend/src/app/investments/page.tsx
---

## Decided
- Folding the Account Info widget no longer leaves a "Show account info" link. A full-width bar takes its place above the chart: logo, name and institution on the left, then the current balance, then the expand chevron. A desktop also gets the account-switch caret and the details and edit icons; a phone gets only the chevron.
- Folding the chart no longer folds the account widget (payee and category widgets still fold with the chart). On a desktop the widget shows as the bar, because the full widget's height comes from the chart beside it. On a phone the full widget stays open until it is folded itself.
- On a desktop, the bar's expand chevron also brings the chart back when the chart is folded. Without that the chevron would do nothing visible there. On a phone it opens only the widget.
- The widget's fold chevron points up below `lg` and left from `lg` up.
- The Transactions page hands the app header "Transactions – <account>" plus the account switcher once its title scrolls behind the header (below `xl`). It rides on the existing collapsed-title mechanism rather than a second one: `PageHeader` takes `collapsedContext` and `collapsedSwitcher`, the collapsing-title hook copies them into the mobile chrome store, and the header view draws them.
- The switcher is plain data in the store (`EntitySwitcher`'s props); the header renders the `EntitySwitcher` itself. The page memoizes the object, because the hook re-publishes whenever its identity changes.
- The header, the Account Info widget and its folded bar all build their rows from one hook, `useAccountSwitcherItems` (favourites first, then the rest, each under its section heading). That way the three menus cannot drift apart. The account detail page's `AccountSwitcher` still builds its own rows, from logical accounts.
- "{title} – {context}" is composed in the `layout.pageHeader.collapsedTitleWithContext` catalog entry, not in JSX.
- Correction to the earlier note on this branch: the maintainer asked for the switch caret beside the account name on phones as well. The bar now shows it at every width; only the details and edit icons are desktop-only.
- The account widget's fold chevron and the bar's expand chevron are single chevrons (ChevronUp/ChevronLeft, ChevronDown), "to match the rest of the UI". The payee and category widgets still use ChevronDoubleLeft, and so does the page's "Show payee/category info" link (ChevronDoubleRight); they were not part of the request.

In the code: frontend/src/components/transactions/AccountInfoBar.tsx, AccountInfoWidget.tsx.
- Investments: the collapsed header reads "Investments – <label>", where the label is the same text the Portfolio Summary shows in brackets (`buildAccountFilterLabel`: "All Accounts", "RRSP, TFSA", "All but X"). The page's picker is a multi-select, but the header caret is the single-pick account switcher with an "All Investment Accounts" row first (sentinel id `__all-investment-accounts__`). Picking a row narrows the page to that one account or back to all. The menu marks a row as current only when the selection is exactly one account or all of them.
- Report pages (ReportDetailHeader and the GEM header): "Reports – <report or scenario name>" plus the same report caret. `useReportSwitcher(currentId)` returns the caret's props, so the page caret and the header caret are one menu.
- When "<title> – <context>" is wider than the header leaves for it, the title is dropped and the context stands alone. The maintainer asked for this on Investments; it applies to every page that passes a context, Transactions included. It is measured off an invisible copy of the full line, so dropping the title never changes what is measured and the line cannot flicker.
- When the chart folds, the Transactions page no longer renders a separate copy of the account widget hidden by CSS (`lg:hidden` / `hidden lg:block`). The band keeps its structure: the widget column stays mounted and hides itself (`chartCollapsed && isLgUp` on a desktop), and the strip takes the chart's place in the right column. Folding no longer remounts the widget, so the loan projection is not fetched again. Tests now check that the element is the same one before and after (`toBe(widgetBefore)`), not the CSS classes.
- `useInvestmentData` memoizes `selectableAccounts` and wraps `handleAccountChange` in `useCallback`. The page used to read the handler through a ref, but the account list was still a new array on every render, so the header's switcher re-published every render anyway.
- The header view treats the caret as present only when `EntitySwitcher` will actually draw it: an item other than the current one, or `showCurrent`. The fit check also observes the caret.
- The unused `ReportSwitcher` component is gone. Callers use `useReportSwitcher` with `<EntitySwitcher {...switcher} />`, and docs/frontend/ui-conventions.md names the hook.
- From `xl` up (where there is no mobile tab bar), a copy of the account bar is fixed at the top of the page, under the header (`top-[calc(4rem+env(safe-area-inset-top)-var(--app-header-offset,0px))]`, z-30). It appears once the whole band (widget or bar, plus chart or strip) has scrolled behind the header, and hides again when the band returns. Below `xl` the collapsed header title already carries the account.
- It stays mounted and toggles opacity and translate over 300ms, so it slides both in and out. While hidden it is `inert` and `aria-hidden`. The wrapper is `pointer-events-none` so its gutters never block clicks on the register.
- Its chevron opens the widget and scrolls back to the top (smoothly, unless reduced motion is on). Opening an off-screen widget would otherwise change nothing the reader can see.
- `useScrolledPast` is the reusable hook: a callback ref plus a boolean, from an IntersectionObserver with the header's height as the top root margin.
- `FloatingPageBar` is the one pinned bar: fixed full width under the header (`--app-header-offset`), slides up and down over 300ms, inert while hidden, page gutters inside. Its surface is `HEADER_SURFACE_CLASS`, which the app header uses too: opaque without backdrop-filter, otherwise white/75 or gray-800/70 with blur. The maintainer asked for the bars to match the header's opacity, and one constant keeps them matching.
- Investments, desktop (no tab bar): once the wrapper around PageHeader scrolls behind the header, a bar pins with "Investments – <the Portfolio Summary bracket label>", the same MultiSelect, and Refresh. The controls are one `accountControls` element rendered in both places.
- `AccountInfoBar floating` draws no card of its own; the floating bar supplies the surface.
- The pinned bars appear as soon as the account name is off screen, not after the whole band. Transactions passes the observer's ref (`nameRef`, through AccountInfoWidget or AccountInfoBar to AccountIdentity's h3) to whichever copy of the name is shown: the widget's while it is open, the in-band bar's once it is folded. Investments puts the ref on the header's account picker.
- The Investments bar's account control is the same EntitySwitcher caret as the mobile header, not a second MultiSelect, beside "Investments – <label>".
- The Investments bar repeats the Portfolio Summary's Total Portfolio Value through `portfolioHeadline` (lib/portfolio-headline.ts), which the card also reads, under `PartialTotal` with `portfolioPartialTotal`. With one foreign account in view, the figure is that account's cash plus market value in its own currency (`sumMoney`), complete only over its own flags. No summary yet means no figure, never zero.
- `RoundAddButton` is the mobile tab bar's "+" at desktop size (blue follows the theme accent). Transactions passes it through AccountInfoBar's `trailing` slot; Investments uses `NewTransactionButton variant="round"`, which opens the same investment-or-cash menu. Both round buttons are named the plain "New Transaction" (the "+ New Transaction" labels would read the plus aloud).

In the code: frontend/src/lib/portfolio-headline.ts, frontend/src/components/ui/RoundAddButton.tsx, `floatingHeadline` in frontend/src/app/investments/page.tsx.
- PageHeader draws the generic pinned bar itself (`floatingBar`, on by default; desktop only, from `xl` up): the section title, then `FloatingAddButton`. One h1 carries both watchers through a stable merged callback ref.
- `FloatingAddButton` reads the action the page already registered for the mobile tab bar's "+" (`useMobileAddAction` / `useMobileAddChoices`, registered at every width). So the desktop "+" and the phone "+" can never differ, and a page needs no new wiring. With choices it opens a small menu; with no action registered it draws nothing. Transactions and Investments use it in their own bars too, and NewTransactionButton went back to its single labelled form.
- Investments passes `floatingBar={false}` (its own bar). Transactions passes `floatingBar={!accountBandActive}`: the generic bar without an account filter, the account bar with one.
- FloatingPageBar mounts its contents on first show and unmounts them on the hide transition's end. Page tests that render the real PageHeader therefore see no second copy of the title.

## Watch out
- Which view is shown depends on the breakpoint and is done with CSS (`lg:hidden` / `hidden lg:block` wrappers), so jsdom renders both. Tests assert the wrapper classes, not visibility. Only the expand click reads `useIsLgUp`.
- Expanding writes a panel's localStorage key only when that panel is actually folded, so expanding never records a choice the user did not make.

In the code: frontend/src/components/transactions/AccountInfoBar.tsx, AccountIdentity.tsx (shared logo/name/switcher block, plus `accountWidgetBalance`), and `expandAccountInfo` plus the chart band in frontend/src/app/transactions/page.tsx.
- The collapsed title text is `aria-hidden` (it repeats the page's heading). The caret is a control, so it sits beside that hidden div, never inside it.
- The test "stays pinned where the tab bar is" in AppHeader.mobile.test.tsx already fails on main (`translateY(-0px)`); it is not caused by this change.

In the code: frontend/src/hooks/useAccountSwitcherItems.ts, frontend/src/store/mobileChromeStore.ts (`CollapsedHeaderSwitcher`), frontend/src/components/layout/CollapsedHeaderTitleView.tsx, and `collapsedSwitcher` in frontend/src/app/transactions/page.tsx.
- `handleAccountChange` from useInvestmentData is a new function on every render, so the page reads it through a ref. Otherwise the memoized switcher, and with it the header, would change on every render.
- Tests drive the collapse with `stubCollapsingTitle()` (frontend/src/test/collapsing-title.ts). It only drives observers watching an `<h1>`.

In the code: frontend/src/components/layout/CollapsedHeaderTitleView.tsx (`CollapsedTitleLine`), frontend/src/app/investments/page.tsx (`collapsedSwitcher`), frontend/src/components/reports/ReportSwitcher.tsx (`useReportSwitcher`).
- Moving JSX between files trips the per-file baselines in src/test/ui-conventions.test.ts. The "Closed" pill moved from AccountInfoWidget into AccountIdentity; it is now a `Badge`, and AccountInfoWidget came off the pill baseline (shrink-only). Run `npm run test:changed`, which includes every guard, after moving markup.
- Locally, public-scripts.guard fails on `public/vendor/opencv/opencv.js` because the git-ignored host copy differs from the Docker volume's node_modules. This is environmental, not a code problem.

In the code: frontend/src/app/transactions/page.tsx (`chartHidesWidget`, `showAccountBar`), frontend/src/hooks/useInvestmentData.ts, frontend/src/components/layout/CollapsedHeaderTitleView.tsx (`hasCaret`).
- The floating copy repeats the balance text. In page tests, read the widget's figures through `inAccountWidget()` (the widget column); a bare `getByText('$5000.00')` finds two.
- Docs pictures with the dev stack running: that stack holds 127.0.0.1:3000/3001, so the e2e compose fails to bind. Run the docs stack under its own project with an override that uses `ports: !override` (3010/3011) and sets PUBLIC_APP_URL/CORS_ORIGIN to :3011, then pass BASE_URL=http://localhost:3011.
- Host Chromium in WSL lacks libglib, so run Playwright in `mcr.microsoft.com/playwright:v<version>-noble` with `--network host --ipc=host -u 1000:1000`, with the repo mounted at its host path.
- `mirror.gcr.io` can return 429 on the pinned postgres digest; retry after a few minutes.

In the code: frontend/src/hooks/useScrolledPast.ts, `accountBandRef` and `account-info-floating` in frontend/src/app/transactions/page.tsx, e2e/docs-screenshots/transactions.spec.ts (`transactions-floating-bar`).
- The floating copies stay mounted, so in jsdom (where no media query matches, which counts as a desktop) the Investments page renders two pickers. investments/page.test.tsx sets a tab-bar viewport in its top-level beforeEach (`setViewport({ tabBar: true })`) and switches to desktop only in the floating-bar block.

In the code: frontend/src/components/layout/FloatingPageBar.tsx, `headerRef` and `accountControls` in frontend/src/app/investments/page.tsx.
- Docs captures: `docShot` hides `[data-floating-page-bar]` unless called with `{ floatingBars: true }`. Without that, every picture scrolled to a card under the header would show the pinned bar across the card's top. The README captures (e2e/readme, `shoot()`) do not hide it yet.
- New markup in a component trips the per-file UI guards (a row hover is `HOVER_ROW_ON_CARD`).

In the code: frontend/src/components/layout/PageHeader.tsx (`pinsBar`, `headingRef`), frontend/src/components/layout/FloatingAddButton.tsx, e2e/docs-screenshots/capture.ts (`floatingBars`).

## Tried and ruled out
- Building the switcher rows once in the Transactions page and passing them down to the widget and the bar: they come from one memoized hook over a small list, so the only gain was skipping two cheap memo runs, at the cost of changing the widget's API and its many tests.
