# Dashboard edit mode: add, remove, move and resize widgets on the dashboard

> Companion task list: [`dashboard-edit-mode-tasks.md`](./dashboard-edit-mode-tasks.md).

Status: **proposal**. It needs its own discussion with the `approved-to-build` label before any task starts. Written 2026-11-10 against `main` at `3e5dfe1e6`. Built on branch `feat/dashboard-edit-mode` on 2026-11-11 with the section 13 defaults; the task list records what is still unverified.

## 1. Goal

The reader arranges the dashboard on the dashboard. The Customize gear beside the greeting puts the page into an edit mode in which every widget can be removed, moved and resized where it stands, and hidden widgets can be added. Nothing is stored until **Done**; **Cancel** restores the layout the reader had.

The Dashboard Hero is not part of this. It stays above the grid, full width, and cannot be moved, resized or removed in edit mode. Its own settings (its show/hide toggle among them) stay in a dialog.

The feature is frontend-only: no migration, no endpoint, no DTO change.

## 2. What exists, and what this composes

| Thing | Where | Role here |
|---|---|---|
| Widget registry | `DASHBOARD_WIDGETS`, `resolveDashboardWidgets`, `delegateDashboardWidgets` in `frontend/src/components/dashboard/widget-registry.tsx` | Gains a size declaration per widget. Stays the one list of widgets. |
| Stored order and visibility | `dashboardWidgets` (`dashboard_widgets TEXT[]`), ordered visible ids, `[]` = never customized | Unchanged in shape and meaning. `DashboardTriviaService` reads it for `'trivia'`. |
| Stored per-widget settings | `dashboardWidgetConfig` (`dashboard_widget_config JSONB`), a map of widget id to a flat object, bounded by `backend/src/users/validators/is-dashboard-widget-config.validator.ts` | Carries each widget's size as two more flat keys. The validator already accepts them. |
| Per-widget settings hook | `frontend/src/hooks/useWidgetConfig.ts` | Unchanged. Its merge keeps keys it does not know, so a gear edit never drops a size. |
| The grid | `grid grid-cols-1 lg:grid-cols-2 gap-6` in the Dashboard page (`frontend/src/app/dashboard/page.tsx`) | Replaced by `DashboardGrid`. |
| Card height | `minHeightClass` on `WidgetCard`, a literal `lg:min-h-[...]` on the nine widgets that draw their own card, and `widgetSkeleton` in the registry | The floor moves to the grid item (section 6.3). |
| Customize dialog | `frontend/src/components/dashboard/CustomizeDashboardModal.tsx` | Loses its layout mock-up and hidden-widget list; what is left is the hero's settings. |
| HTML5 reorder | `frontend/src/hooks/useDragReorder.tsx` | Not used here: HTML5 drag does not fire on touch. It stays for Favourite Accounts and the column chooser. |
| Pointer drag handle | `frontend/src/components/ui/DragHandle.tsx` (pointer capture, offsets from the press, arrow-key nudge) | The grip for both moving and resizing. |
| Discard prompt | `frontend/src/components/ui/UnsavedChangesDialog.tsx` | Asked on Cancel when the draft differs. |
| Card stretch rule | `docs/frontend/ui-conventions.md`, "A dashboard widget card stretches to its row, and never sets `h-full`", and its guard in `frontend/src/test/ui-conventions.test.ts` | Kept, and extended to the grid item. |

## 3. Product decisions

Decided with Ken on 2026-11-10:

1. **Resize is by presets, not free-form.** A widget has a width preset and a height preset. Widgets flow in their stored order and wrap; nobody places a widget at a coordinate.
2. **Edit mode with Done and Cancel.** The gear enters it. Nothing is stored until Done. Widget content is inert while editing.
3. **On a phone: add, remove and reorder.** Sizes set on a wide screen are kept and have no visible effect in one column. Size controls appear from the `lg` breakpoint up.
4. **The Customize dialog becomes hero settings only.** There is one place to arrange widgets.

Decided in this plan (each is the recorded default; section 13 lists the ones Ken may want to overrule):

5. **A size is a named preset, stored by name.** The grid's column count can change later without rewriting stored layouts.
6. **A height is a floor, never a clip.** Content that needs more room grows the card and its row. No widget learns to scroll or truncate for this feature.
7. **Sizes live in `dashboardWidgetConfig`**, next to the settings of the widget they belong to. The hero's placement settings already live there for the same reason.
8. **Moving is by a visible grip**, with move-earlier and move-later buttons beside it. The card body is never a drag surface, so a touch on a card scrolls the page.
9. **The page does not reflow while a card is dragged.** An insertion line shows where it will land and a small chip follows the pointer. Charts are not re-laid-out sixty times a second.
10. **The edit-mode code is loaded on demand** (`next/dynamic`), so the dashboard's first load does not grow.

## 4. Definitions

- **Layout**: the ordered list of `{ id, width, height }` for the widgets on the dashboard.
- **Default layout**: the registry's `defaultEnabled` widgets in registry order, each at its default size.
- **Draft**: the layout being edited. It exists only while edit mode is on.
- **Width preset**: `third`, `half`, `twoThirds`, `full`: 4, 6, 8 and 12 of the grid's 12 columns at `lg` and up. Below `lg` the grid is one column and every widget fills it.
- **Height preset**: `auto` (no floor), `compact` (390px), `standard` (540px), `tall` (720px). Applied at `lg` and up only, as today's min-heights are.
- **Default size**: `half` wide, and the height the widget has today (section 6.2).

## 5. Invariants

Plan-local ids. None is a financial invariant, so none is added to `docs/system-invariants.md`.

| ID | Statement | Mechanism |
|---|---|---|
| DASH-1 | A reader who never customized sees the default layout, and follows later changes to it. | `serializeDashboardLayout` stores `dashboardWidgets: []` whenever the draft's ids, in order, are the default layout's, whatever their sizes; a size that differs from its default is stored as its own key in `dashboardWidgetConfig`, which `resolveDashboardLayout` reads with `[]` ids, so a reader who only resized still follows later changes to the default order and membership. Unit-tested truth table (section 7). |
| DASH-2 | A stored layout from before this feature renders as it did. | A widget with no stored size resolves to its default size; `resolveDashboardLayout` is the only reader. The one accepted difference is in section 6.2. |
| DASH-3 | Screen order, DOM order and stored order are the same order. | The grid uses row flow without `dense`; items render in draft order. A row may therefore end short when the next widget does not fit; that gap is honest, and tab order follows what the eye sees. |
| DASH-4 | Leaving edit mode by Cancel, Escape or the browser's Back stores nothing. | The draft lives in a reducer inside the page. The only `userSettingsApi.updatePreferences` call for layout is in the Done handler. Component test asserts no call on each exit. |
| DASH-5 | Done is one write. | One `updatePreferences({ dashboardWidgets, dashboardWidgetConfig })` request, which the server applies in one `withScopedDb` transaction (`UsersService`). A refused request leaves edit mode open with the draft intact and shows a toast. |
| DASH-6 | Saving a layout never loses a widget's settings. | The Done handler reads the settings map from the store at that moment (`usePreferencesStore.getState()`), and changes only the `gridWidth` and `gridHeight` keys. Unit test with a populated map. |
| DASH-7 | A height never hides content. | The floor is a `min-height` on the grid item. Nothing sets `height`, `max-height` or `h-full` on the item or the card; the guard in `ui-conventions.test.ts` is extended to the item. |
| DASH-8 | In edit mode every widget in the draft is on screen. | A widget whose `shouldRender` is false is drawn as a placeholder tile with its name, so it can still be moved or removed. |
| DASH-9 | A delegate never enters edit mode. | The gear is not rendered for a delegate (as today) and the edit-mode components are not mounted when `isDelegateView`. |
| DASH-10 | The hero is not in the layout. | `DASHBOARD_HERO_WIDGET_ID` is not a `DashboardWidgetId`; the hero renders outside `DashboardGrid`. |

## 6. Data contracts

### 6.1 Stored shape

No new column. Two existing preference fields:

```jsonc
{
  "dashboardWidgets": ["favourite-accounts", "net-worth", "expenses-pie"],
  "dashboardWidgetConfig": {
    "net-worth":     { "range": "2y", "barStyle": "accountType", "gridWidth": "full", "gridHeight": "tall" },
    "expenses-pie":  { "gridWidth": "third" },
    "dashboard-hero": { "enabled": true, "set": "auto" }
  }
}
```

Rules, all in one new pure module, `frontend/src/components/dashboard/dashboard-layout.ts`:

- `resolveDashboardLayout(dashboardWidgets, dashboardWidgetConfig)` returns the layout. Order and membership come from `resolveDashboardWidgets`. A `gridWidth` or `gridHeight` that is absent, not a string or not a known preset resolves to the widget's default. A stored width narrower than the widget's `minWidth` resolves to `minWidth`.
- `serializeDashboardLayout(draft, configBefore)` returns `{ dashboardWidgets, dashboardWidgetConfig }`.
  - A size equal to the widget's default is stored as an absent key.
  - A widget not in the draft has its two size keys removed, so a widget added back later arrives at its default size. Its other settings are kept.
  - A slice left with no keys is omitted from the map.
  - Every other key of every slice, and every slice of an id the registry does not know, is passed through untouched.
  - When the draft's ids, in order, are the default layout's, `dashboardWidgets` is `[]`, whatever the sizes; the sizes are in the map.
- `layoutReducer(draft, action)` with `add`, `remove`, `move`, `resize` and `reset`. It never mutates.

The server never reads the size keys and does not validate their values; the client resolves defensively, as `resolveDashboardHeroConfig` does. An older client (a cached tab) ignores the keys, and its settings writes keep them, because `useWidgetConfig` and the old dialog both spread the stored slice.

Support backups blank `dashboard_widget_config` (it can hold account ids), so a support backup carries the order and not the sizes. That is acceptable: sizes are presentation.

### 6.2 Size declaration in the registry

`DashboardWidgetDefinition` gains:

```ts
/** The narrowest width the widget is legible at. Wider presets are always offered. */
minWidth: 'third' | 'half';
/** The height floor the widget has when the reader chose none. */
defaultHeight: 'auto' | 'compact' | 'standard' | 'tall';
```

Every height preset is offered for every widget (DASH-7 makes any of them safe).

| Widgets | `minWidth` | `defaultHeight` | Today |
|---|---|---|---|
| `favourite-accounts`, `upcoming-bills`, `favourite-reports` | `third` | `auto` | no floor |
| `budget-status`, `insights`, `warranties-expiring`, `trivia` | `third` | `compact` | 390px |
| `top-movers` | `third` | `standard` | 500px |
| `favourite-securities` | `half` | `standard` | 500px |
| `net-worth` | `half` | `standard` | 500px |
| `assets-liabilities` | `third` | `standard` | 500px |
| `expenses-pie`, `income-by-source`, `credit-utilization-total`, `sector-weightings`, `security-type-allocation`, `geographic-allocation`, `recurring-expenses` | `third` | `standard` | 540px |
| `portfolio-value`, `cash-flow-forecast`, `income-expenses`, `spending-by-payee`, `monthly-spending-trend`, `credit-utilization-accounts`, `weekend-weekday`, `cash-flow-sankey` | `half` | `standard` | 540px |

The `minWidth` column is a starting judgement. Task F2 checks each widget at its narrowest offered width at 1024px and 1440px and raises `minWidth` where a widget is not legible.

**The one accepted visible change (DASH-2).** Four widgets have a 500px floor today. They take `standard`, 540px. In the default layout Top Movers already shares a row with a 540px widget, so only the Net Worth and Assets vs Liabilities row grows, by 40px. Trivia's floor also applies on a phone today; it keeps that by carrying the floor on its own content area, not its card.

### 6.3 The grid item

`DashboardGrid` is `grid grid-cols-1 lg:grid-cols-12 gap-6` and keeps the `dashboardWidgets` tour anchor. `DashboardGridItem` is the grid item for one widget:

- its span and floor come from two static class maps keyed by preset (`lg:col-span-4` and so on; `lg:min-h-[540px]` and so on), so Tailwind sees every class;
- it is itself a one-cell grid. The widget's card and, in edit mode, the edit overlay are both placed in that cell. The card therefore fills the item by grid stretch, the mechanism the card stretch rule already relies on, and no percentage height is introduced;
- it carries `data-widget-id` for the reorder hit test and for tests.

The widgets' own floors are deleted in the same task: `minHeightClass` on `WidgetCard`, the literal `lg:min-h-[...]` on the nine self-drawn cards, and the argument to `widgetSkeleton`. A floor exists in one place.

## 7. Truth tables

### A. What Done stores

| Draft order | Any size differs from its default | `dashboardWidgets` | Size keys |
|---|---|---|---|
| equals default | no | `[]` | none |
| equals default | yes | `[]` | only the differing ones |
| differs | no | the ids | none |
| differs | yes | the ids | only the differing ones |
| empty | n/a | Done is disabled | n/a |

### B. What a stored size resolves to

| Stored `gridWidth` | Widget `minWidth` | Resolved |
|---|---|---|
| absent | any | `half` |
| `third` | `third` | `third` |
| `third` | `half` | `half` |
| `full` | any | `full` |
| `"huge"`, `7`, `null` | any | `half` |

`gridHeight` resolves the same way against `defaultHeight`, with no minimum.

### C. What edit mode offers by viewport

| Viewport | Add | Remove | Move (grip and buttons) | Width | Height |
|---|---|---|---|---|---|
| below `lg` (one column) | yes | yes | yes | no | no |
| `lg` and up | yes | yes | yes | yes | yes |

Below `lg` the edit bar says that sizes apply on wider screens.

## 8. Worked examples

Content width at a 1440px viewport is 1344px (the page's `lg:px-12`), the gap 24px, so one column is (1344 - 11 x 24) / 12 = 90px and a span of n is 90n + 24(n - 1).

| Preset | Columns | Width at 1440px | Width at 1024px |
|---|---|---|---|
| `third` | 4 | 432px | 293px |
| `half` | 6 | 660px | 452px |
| `twoThirds` | 8 | 888px | 611px |
| `full` | 12 | 1344px | 928px |

Flow, with a layout of A `twoThirds`, B `half`, C `third`, D `third`, E `third`:

- Row 1: A (8). B (6) does not fit in the 4 left, so the row ends short.
- Row 2: B (6), C (4). D (4) does not fit in the 2 left.
- Row 3: D (4), E (4).

Moving C before B gives row 1: A (8), C (4), with no gap. The reader fixes a gap by moving or resizing; the grid does not reorder for them (DASH-3).

## 9. Failure and edge policy

- **Done fails.** Toast with the existing `customize.toasts.saveFailed` message; edit mode stays open with the draft.
- **The store changes under the draft** (another tab saved a layout). The draft was seeded on entry and is not re-seeded; Done writes the draft's order and sizes over the newer layout. Settings other than size are read at Done time, so they are not overwritten (DASH-6). This is the last-write-wins the settings map already has.
- **A widget id the registry does not know** is dropped from the layout on read (as today) and so is not written back to `dashboardWidgets` on Done. Its settings slice is passed through.
- **A widget's chunk is still loading in edit mode.** The item shows the skeleton; the overlay's controls work regardless.
- **A dashboard reload during edit mode** (undo, redo, an assistant write) refreshes the data under the draft; the draft is untouched.
- **Zero widgets.** Done is disabled and the grid shows the existing `customize.atLeastOne` message beside the Add tile.

## 10. Frontend structure

All under `frontend/src/components/dashboard/` unless a path says otherwise.

| File | New | What it is |
|---|---|---|
| `dashboard-layout.ts` | yes | Presets, class maps, `resolveDashboardLayout`, `serializeDashboardLayout`, `layoutReducer`. Pure. |
| `widget-registry.tsx` | | `minWidth`, `defaultHeight` on every definition; `widgetSkeleton` loses its argument. |
| `DashboardGrid.tsx`, `DashboardGridItem.tsx` | yes | Section 6.3. |
| `frontend/src/hooks/useDashboardLayoutDraft.ts` | yes | Edit-mode state: `editing`, `draft`, `dirty`, `enter`, `cancel`, `dispatch`, `save`. Owns the one layout write. |
| `DashboardEditBar.tsx` | yes | Sticky under the pinned header while editing: Add widget, Hero settings, Reset to default, Cancel, Done. Wraps on a phone by the toolbar rule. |
| `WidgetEditOverlay.tsx` | yes | Over each item while editing: the grip (`DragHandle`), move earlier and later, width and height choices (`segmentClass`), remove. Sets the card `inert`. |
| `AddWidgetDialog.tsx` | yes | A `Modal` listing the widgets not in the draft. Choosing one appends it at its default size and scrolls it into view. |
| `widget-glyphs.tsx` | yes | `WidgetTint` and `WidgetTypeIcon`, moved out of the Customize dialog so the Add dialog and placeholder tiles share them. |
| `frontend/src/hooks/useGridReorder.ts` | yes | Pointer reorder over the grid items (section 10.1). |
| `WidgetResizeGrip.tsx` | yes | Corner grip that snaps to presets (section 10.2). |
| `DashboardHeroSettingsModal.tsx` | yes | The hero section of today's dialog, saving `dashboardWidgetConfig['dashboard-hero']` only. `CustomizeDashboardModal.tsx` and its test are deleted. |
| The Dashboard page | | Renders `DashboardGrid` from the draft while editing, otherwise from the stored layout. The gear keeps its accessible name "Customize" and its tour anchor, and enters edit mode. |

The edit bar, overlay (with its grip and resize grip), Add dialog, placeholder tile and hero dialog are imported with `next/dynamic` behind `editing`. The reorder hook (`useGridReorder`) is imported statically: a hook cannot be loaded with `next/dynamic` without wrapping the whole grid in a loaded component, and it is small.

### 10.1 Moving

`useGridReorder` is driven by the overlay's `DragHandle`:

- on press, it records the pointer position and each item's rectangle (`[data-widget-id]`);
- on move, it finds the item under the pointer and takes the gap before it or after it by which half of the item the pointer is in, in flow direction (horizontal at `lg` and up, vertical below). This is `useDragReorder`'s gap model, so a gap that would not move the card shows no line;
- the gap is drawn with `DropIndicatorLine`; a chip with the widget's tint and name follows the pointer; the dragged card stays where it is, dimmed;
- within 80px of the top or bottom of the viewport the page scrolls, one step per animation frame, and the rectangles are re-read; a scroll the reader makes during the drag (wheel, trackpad) re-reads them too, and the gap is taken again on the next frame;
- on release it dispatches one `move`. Escape or a cancelled pointer dispatches nothing;
- arrow keys on the grip dispatch `move` by one place (Left and Up earlier, Right and Down later). Each move is announced through a polite live region: "{name} moved to position {n} of {count}";
- the grip has `touch-action: none`; nothing else in the overlay does.

### 10.2 Resizing

Two ways, the first sufficient on its own:

- **Choices in the overlay.** Width: the presets from the widget's `minWidth` up. Height: the four presets. One press dispatches `resize`. These are the accessible path.
- **The corner grip** (`lg` and up). Dragging it previews an outline at the nearest width preset for the pointer's x and the nearest height preset for its y, and dispatches one `resize` on release. An axis the pointer has not moved along by more than 4px keeps its preset, because an item's real height comes from its content and its row, not its preset. Arrow keys on it step the width (Left, Right) and height (Up, Down) by one preset.

### 10.3 Leaving edit mode

Done saves and leaves; with nothing changed it leaves without a request. While the save is in flight, Back puts edit mode's entry back and nothing else leaves; the save leaves when it lands. Cancel, Escape and Back leave without saving; when the draft differs from the layout it was seeded from, `UnsavedChangesDialog` asks first. Edit mode pushes a history entry on entry, as a `Modal` with `pushHistory` does, so Back on a phone leaves edit mode and not the dashboard. Unmounted while editing, it pops that entry only while it is still the current one, as `Modal` does on unmount; after a link's navigation the next page's entry is already over it, a `history.back()` would undo the navigation, and the stale entry is left (one extra Back on return).

- **Token.** The entry's `dashboardEdit` value is a token drawn by `newClientId()` on each entry. Back ignores a landing only on this visit's token (a dialog above it closed), so a stale entry from an earlier visit is a Back like any other and leaves in one press; the entry is popped only while it carries this visit's token and is not a `Modal` entry. Unmounted with a dialog open, the dialog's entry is on top: edit mode waits for that `Modal`'s own pop to land (`afterModalHistoryPop`) and then pops its own.
- **Escape scope.** Escape is edit mode's unless a modal dialog is open or the key was typed inside a `[role="dialog"]`, `[role="complementary"]` or `[aria-modal="true"]` element (the AI sheet, the docked help panel). Scoped by the key's target rather than by focus being in the dashboard, so Escape with focus on the page body still leaves.
- **Focus.** Every way out (Done, Cancel, Discard, Escape, Back) puts focus back on the Customize gear. After a remove, focus goes to the next widget's grip, else the previous one's, else the Add widget tile; after an add, to the new widget's grip. Remove, add and resize are announced through the grid's one polite live region, which is cleared on each entry.
- **Saving gate.** While Done's save is in flight the draft takes no layout change (the reducer refuses it), the grid is `inert`, and the bar's actions are disabled, so nothing is edited that the landing save would drop. Hero settings cannot be closed while their own save is in flight, so Done, which is under that dialog, never reads the settings map before the hero's answer lands.

## 11. Test matrix

| Subject | Kind | Cases |
|---|---|---|
| `resolveDashboardLayout` | unit | truth table B; unknown ids dropped; empty and missing preference give the default layout; pre-feature stored layouts resolve to default sizes |
| `serializeDashboardLayout` | unit | truth table A; a removed widget loses only its size keys; other keys and unknown slices pass through; an emptied slice is omitted; output passes a port of the server validator's bounds |
| `layoutReducer` | unit | each action; out-of-range `move` is a no-op; `resize` below `minWidth` is refused; inputs are not mutated |
| `DashboardGridItem` | component | span and floor classes per preset; no `h-full`, `height` or `max-height` |
| Card stretch guard | source scan | `ui-conventions.test.ts` covers the item; no widget file sets its own `lg:min-h-` on a card |
| Edit mode | component (Dashboard page) | gear enters; content is `inert`; remove, add, move buttons, size choices change the grid; Cancel restores and calls nothing (DASH-4); Escape and Back the same; Done sends one request with the expected body (DASH-5); a default draft sends `[]`; a failed Done keeps the draft; zero widgets disables Done; a `shouldRender: false` widget shows its placeholder (DASH-8); a delegate has no gear (DASH-9); below `lg` no size controls |
| `useGridReorder` | hook | gap from pointer position with mocked rectangles, both axes; no-op gaps; one `move` on release; none on Escape; arrow keys |
| `WidgetResizeGrip` | component | snaps to the nearest presets; never below `minWidth`; one `resize` on release; arrow keys |
| `DashboardHeroSettingsModal` | component | the hero cases moved from `CustomizeDashboardModal.test.tsx`; saving leaves `dashboardWidgets` and other slices alone |
| WebKit | manual, recorded in the PR | landscape tablet width, two widgets in a row, Expenses by Category's Other list opened: the row grows and nothing spills (the issue 1382 case) |
| E2E | Playwright | `e2e/docs-screenshots/dashboard.spec.ts` drives the hero settings through the new dialog and retakes the customize screenshot in edit mode; `e2e/tests/shared-expenses-tour.spec.ts` still finds the "Customize" button |

A green suite after F2 with no changed assertion would be a finding: the tests that pin `lg:min-h-[...]` on a card must move to the item.

## 12. Scope cuts

- No free placement, no overlapping, no per-breakpoint layouts.
- No second copy of a widget; the registry id stays the key.
- No two-column layout between `md` and `lg`; one column below `lg`, as today.
- No sharing or exporting of a layout.
- `useDragReorder` and its other callers are not migrated to pointer events.
- The hero is not movable (stated in the goal).

## 13. Open questions

Each has a recorded default, which the tasks implement unless Ken says otherwise.

1. **Width steps.** Default: thirds and halves on 12 columns (`third`, `half`, `twoThirds`, `full`). The alternative discussed was quarters on 4 columns; a quarter is 214px at a 1024px viewport, too narrow for any current widget, and it gives no three-across row.
2. **The 40px growth** of the Net Worth and Assets vs Liabilities row (section 6.2). Default: accept it. The alternative is a fifth height preset that exists only to preserve 500px.
3. **Hand-written pointer reorder or a library.** Default: hand-written on `DragHandle`, about one hook, because the layout is a single ordered flow and the gap model exists. `@dnd-kit` would save the auto-scroll and hit-test code at the cost of a dependency, which needs Ken's agreement under `AGENTS.md`.
4. **A release-tour step** pointing at edit mode. Default: none; the two existing tour bodies that describe Customize are reworded in F3.
5. **Row-end gaps** (DASH-3). Default: leave them. The alternative, `grid-auto-flow: dense`, fills gaps by showing widgets out of their stored order.

## 14. What to run, and what should be observed

Per task, from `frontend/`: `npm run lint && npm run type-check && npm run i18n:check`, `npm run test -- <the changed specs>`, `npm run test:changed`, `npm run build`. From the root, when a doc changed: `node scripts/check-docs-manifests.mjs`, and the doc-path guard (`npx jest src/common/doc-paths.spec.ts` in `backend/`). Stage new files first (`git add -N`).

Observed when all tasks are in:

- The dashboard of a reader who never customized is unchanged apart from section 6.2's 40px.
- The gear turns the page into edit mode: a bar appears under the header, each widget dims and shows a grip, arrows, size choices and a remove button, and a dashed Add tile ends the grid.
- Dragging a grip, by mouse or by finger, shows an insertion line and drops the widget there. Choosing a width or height, or dragging the corner, changes the card at once.
- Cancel puts everything back. Done keeps it, on this device and the next one signed in.
- On a phone the same mode offers add, remove and move.
- The hero is untouched by all of it; Hero settings in the edit bar opens its dialog.
