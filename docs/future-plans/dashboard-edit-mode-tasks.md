# Dashboard edit mode: task list

> Companion to [`dashboard-edit-mode.md`](./dashboard-edit-mode.md) (the design). One task per session and per PR, each based on `main` and opened once its dependencies have merged. Section references point at the design. Re-locate code by symbol, never by line.

## Read first, every session

- **Frontend only.** A task that finds itself editing `backend/`, `database/` or a DTO is off the plan; stop and say why.
- **The hero is not in the layout** (DASH-10). No task adds it to the grid, the draft or the registry.
- **A height is a floor** (DASH-7). No task sets `height`, `max-height` or `h-full` on a grid item or a card.
- **One layout write** (DASH-4, DASH-5): the Done handler in `useDashboardLayoutDraft`. A second call site is off the plan.
- **Open questions** (design section 13) are implemented at their recorded default unless the tracker says Ken decided otherwise.
- Read `frontend/CLAUDE.md`, then `docs/frontend/ui-conventions.md` (the dashboard sections) and `docs/frontend/screens-and-dialogs.md` before F2 and later.
- **Definition of done for every task**, besides its own acceptance: `npm run lint && npm run type-check && npm run i18n:check`, the changed specs, `npm run test:changed`, `npm run build`, from `frontend/`. New files staged before the guards run. English strings only, then `npm run i18n:pseudo`; the other locales are the last commit of the PR that adds the strings. A changed user-facing screen updates `website/docs/dashboard.md` and its screenshots in the same PR.

## Deployment safety

| Class | Meaning |
|---|---|
| **none** | Code nothing calls yet, tests, docs. |
| **neutral** | Rewrites a live path and is designed to look the same. The dashboard page's own suite is the gate. |
| **visible** | Changes what a reader sees or can do. |

No task changes stored data until a reader presses Done, and what Done stores is readable by every earlier version of the client (design section 6.1), so any task can be reverted on its own.

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
|---|---|---|---|---|
| F1 | Layout model and registry sizes | none | none | Built (3d01e4177) |
| F2 | Grid renders from the layout; the height floor moves to the grid item | F1 | neutral (40px, design 6.2) | Built (eff82dcbb) |
| F3 | Edit mode: bar, remove, move buttons, add, Done and Cancel; hero settings dialog | F2 | visible | Built (cb5fddd20) |
| F4 | Width and height choices in the overlay | F3 | visible | Built (f9f161e2f) |
| F5 | Pointer reorder by the grip, mouse and touch | F3 | visible | Built (94be4c261) |
| F6 | Corner resize grip | F4 | visible | Built (0402fda04) |

F4 and F5 are independent of each other. The feature is complete for a reader at F5; F6 is the direct-manipulation extra and can be dropped without leaving anything half-built.

"Built" means implemented on branch `feat/dashboard-edit-mode` with its unit tests, lint and type-check passing; translations are commit a15fbffc9. Open on every visible task, to be recorded in the PR before merge (none could run where the work was done):

- the manual browser checks each task names: WebKit row stretch at a landscape-tablet width, each widget at its `minWidth` at 1024px and 1440px, mouse and touch drag with edge scrolling, a touch on a card body still scrolling the page, Back leaving edit mode, the corner grip's outline;
- the dashboard route's first-load size before and after (`npm run build`);
- the dashboard screenshots (`npm run docs:screenshots` in `e2e/`) and a run of `e2e/docs-screenshots/dashboard.spec.ts`.

## F1. Layout model and registry sizes

**Goal.** The pure rules of design sections 6.1, 6.2 and 7, with nothing rendering from them yet.

**Files.**
- New `frontend/src/components/dashboard/dashboard-layout.ts` and `dashboard-layout.test.ts`.
- `frontend/src/components/dashboard/widget-registry.tsx`: `minWidth` and `defaultHeight` on `DashboardWidgetDefinition` and on every entry, from the table in design 6.2.
- `frontend/src/components/dashboard/widget-registry.test.tsx`: every widget declares both.

**Acceptance.**
- `resolveDashboardLayout`, `serializeDashboardLayout`, `layoutReducer`, the preset lists and the two static class maps are exported.
- Truth tables A and B are tests, row for row.
- A test feeds `serializeDashboardLayout`'s output for a full 26-widget layout through the bounds of `is-dashboard-widget-config.validator.ts` (50 slices, 20 keys, flat primitives), ported into the test.
- `resolveDashboardLayout(prefs)` over a layout stored today (ids only, settings without size keys) returns default sizes for every widget.

## F2. Grid renders from the layout

**Goal.** The dashboard looks the same and is drawn by `DashboardGrid` from `resolveDashboardLayout`. The floor has one home.

**Files.**
- New `DashboardGrid.tsx`, `DashboardGridItem.tsx` and their tests, in `frontend/src/components/dashboard/`.
- The Dashboard page (`frontend/src/app/dashboard/page.tsx`) and `page.test.tsx`.
- `WidgetCard.tsx`: `minHeightClass` removed. Its callers (`NetWorthChart.tsx`, `AssetsVsLiabilities.tsx`) stop passing it.
- The nine self-drawn cards lose their `lg:min-h-[...]`: `BudgetStatusWidget.tsx`, `InsightsWidget.tsx`, `WarrantiesExpiringWidget.tsx`, `TriviaWidget.tsx`, `TopMovers.tsx`, `FavouriteSecurities.tsx` (and `FavouriteAccounts.tsx`, `UpcomingBills.tsx`, `FavouriteReportsWidget.tsx` where a floor is found). Trivia keeps its phone floor on its content area.
- `widget-registry.tsx`: `widgetSkeleton` takes no height.
- `frontend/src/test/ui-conventions.test.ts`: the card stretch guard covers the item, and fails a widget card that sets its own `lg:min-h-`.
- `docs/frontend/ui-conventions.md`: the card stretch section now says the item carries the floor and why the item is a one-cell grid.

**Acceptance.**
- The delegate layout renders through the same grid at default sizes.
- With the default layout at 1440px, every row's height equals `main`'s except the Net Worth row (+40px). Measured in the browser and stated in the PR.
- Each widget is checked at its `minWidth` at 1024px and 1440px by setting `gridWidth` in the stored settings by hand; a widget that is not legible has its `minWidth` raised, in this PR, with design 6.2's table edited to match.
- The WebKit check of design section 11 is done and recorded in the PR.
- Tests that pinned a card's `lg:min-h-` now pin the item's.

## F3. Edit mode

**Goal.** Design sections 10 and 10.3 without the size controls and without pointer drag: the reader can enter edit mode, remove, add, move with buttons, reset, cancel and save.

**Files.**
- New `frontend/src/hooks/useDashboardLayoutDraft.ts`; new `DashboardEditBar.tsx`, `WidgetEditOverlay.tsx`, `AddWidgetDialog.tsx`, `widget-glyphs.tsx`, `DashboardHeroSettingsModal.tsx` in `frontend/src/components/dashboard/`, each with its test.
- Deleted: `CustomizeDashboardModal.tsx` and `CustomizeDashboardModal.test.tsx`. Its hero cases move to the new dialog's test.
- The Dashboard page and its test; `DashboardGridItem.tsx` takes the overlay.
- `frontend/src/i18n/messages/en/dashboard.json`: an `edit` section (bar labels, overlay labels with `{name}`, placeholder tile, live-region sentence, the phone note); the `customize` keys only the old mock-up used are removed. Grep each key before adding it.
- `frontend/src/i18n/messages/en/tours.json`: the intro and the 1.20.0 warranties bodies say what Customize now does (Customize, then Add widget).
- `e2e/docs-screenshots/dashboard.spec.ts`: the hero set is switched through the new dialog; the customize screenshot is taken in edit mode. `e2e/tests/shared-expenses-tour.spec.ts` is read, and left alone if the "Customize" button name still resolves.
- `website/docs/dashboard.md` ("Customizing Your Dashboard", the hero paragraph, the optional-widgets lead-in), `website/docs/warranties.md`, `website/docs/ai.md`: "the Customize dialog" becomes edit mode and Add widget. `npm run docs:screenshots` in `e2e/`, then `npm run docs:build`.
- `docs/frontend/ui-conventions.md`: a short section, "The dashboard is arranged in edit mode", naming the hook, the single write and the hero's dialog. `docs/frontend/screens-and-dialogs.md` where it describes Customize.

**Acceptance.**
- The edit-mode row of the test matrix (design section 11) passes, DASH-4, DASH-5, DASH-6, DASH-8 and DASH-9 each by a named test.
- The edit-mode components are behind `next/dynamic`; the PR states the dashboard route's first-load size before and after from `npm run build`.
- Every control in the overlay and the bar has an accessible name; nothing interactive sits inside another button; focus rings are `focus-visible:`.
- Cancel with a changed draft asks through `UnsavedChangesDialog`; with an unchanged draft it leaves at once.
- Reset to default sets the draft to the default layout and stores nothing until Done.

## F4. Width and height choices

**Goal.** Design section 10.2, first bullet.

**Files.** `WidgetEditOverlay.tsx` and its test; `en/dashboard.json` (preset labels); `website/docs/dashboard.md` and the edit-mode screenshot.

**Acceptance.**
- Width offers the presets from the widget's `minWidth` up; height offers all four. The pressed one is `aria-pressed`.
- One press changes the card at once and dispatches one `resize`.
- Below `lg` neither group is rendered and the bar shows the note (truth table C).
- A size saved here is stored as design 6.1 says: absent when default.

## F5. Pointer reorder

**Goal.** Design section 10.1.

**Files.** New `frontend/src/hooks/useGridReorder.ts` and its test; `WidgetEditOverlay.tsx`; `DashboardGrid.tsx` (the insertion line and the chip); `en/dashboard.json` (grip label); `website/docs/dashboard.md`.

**Acceptance.**
- The `useGridReorder` row of the test matrix passes.
- Tried by hand with a mouse at 1440px and by touch on a phone-width viewport with a layout taller than the screen: the page scrolls near the edges while dragging and a touch on a card body still scrolls the page. Recorded in the PR.
- The move buttons from F3 stay.
- If Ken chose `@dnd-kit` (open question 3), this task is rewritten on the tracker before it starts; the acceptance above still holds.

## F6. Corner resize grip

**Goal.** Design section 10.2, second bullet.

**Files.** New `frontend/src/components/dashboard/WidgetResizeGrip.tsx` and its test; `WidgetEditOverlay.tsx`; `en/dashboard.json`; `website/docs/dashboard.md`.

**Acceptance.**
- The `WidgetResizeGrip` row of the test matrix passes.
- The preview is an outline; the card itself changes once, on release.
- Not rendered below `lg`.
