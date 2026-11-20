# UI styles: Standard, Classic and Modern as selectable looks over every colour theme

> Companion task list: [`ui-styles-tasks.md`](./ui-styles-tasks.md).

Status: **phase 1 built**, **phase 2 in progress** on branch `feat/ui-styles-classic-modern` (2026-11-20). The source designs are the "Monize UI directions" canvas: its *Ledger* page became **Classic**, its *Contemporary* page became **Modern**.

## 1. Goal

A reader picks a UI style (Standard, Classic, Modern) in Settings > Preferences, independently of the colour theme and the light/dark mode. Any style can be paired with any palette: Classic on Nord, Modern on Latte, and so on.

## 2. The rule that keeps this repeatable

**A palette decides colour, a style decides shape, and neither names the other's values.** `themes.css` redefines the gray/blue ramps; `ui-styles.css` redefines typefaces, radii, card treatment, table chrome and navigation, and every colour it uses is a ramp token. So a new palette works with every style on the day it lands, and a new style works with every palette.

A style reaches components in this order of preference (the header of `frontend/src/app/ui-styles.css` is the authority):

1. **Tailwind tokens**: `--radius-*`, `--font-sans`, `--font-mono`, `--shadow-card(-dark)`. One redefinition reaches every call site.
2. **`--ui-*` tokens** read by the shared primitives (`rounded-(--ui-radius-card)` on `CARD_CLASS`, `--ui-radius-control` on `Button`, `--ui-radius-field` on `inputBaseClasses`, `--ui-radius-dialog` on `Modal`, `--ui-radius-pill` on `Badge`, `--ui-card-border`). Standard values live in `globals.css` and equal what the primitives carried before, so Standard renders unchanged. These are ordinary utilities, so a call site's own `rounded-none` still wins through `cn()`.
3. **Marker classes** on primitives (`ui-card`, `ui-btn`, `ui-field`, `ui-table`, `ui-th`, `ui-dialog`, `ui-page-title`, `ui-nav`, `ui-nav-link`), styled in `@layer components` so page utilities keep winning.
4. **Unlayered rules**, only where a style must beat a primitive's own utility (body font set by next/font's class, the active nav link, header-cell case), always scoped to a marker class.

## 3. What phase 1 delivered

| Layer | Change |
|---|---|
| Database | `user_preferences.ui_style VARCHAR(20) NOT NULL DEFAULT 'standard'` |
| Backend | entity, DTO validation against the list, service patch, support-backup rule |
| Frontend plumbing | `lib/ui-styles.ts` (the list), `ThemeContext` `uiStyle` / `setUiStyle`, `data-ui-style` on `<html>`, the `monize-ui-style` cookie, the server-stamped attribute in `layout.tsx`, `PreferencesLoader` sync, `UiStyleSelector` in Preferences |
| Styling | `app/ui-styles.css`, `app/ui-style-fonts.ts` (Bodoni Moda, IBM Plex Sans/Mono, Bricolage Grotesque, Instrument Sans; self-hosted by next/font, `preload: false` so Standard downloads none of them), tokens and markers on the primitives above |

Classic: serif display headings, Plex body with tabular figures, 2-4px corners, flat hairline cards, registers ruled top and bottom in ink with an accent-tinted band on every other row, the active section underlined in the menu.

Modern: grotesque display headings with tight tracking, 24px cards with no visible edge and a soft drop, pill buttons and badges, sentence-case table headers, the main menu as one segmented pill.

## 4. Phase 2: the mockup layouts

Decided with Ken on 2026-11-20: the styles must look like the mockups, not only re-type and re-round the Standard layout. Each style gets a **companion palette** (`ledger` for Classic, `studio` for Modern) that the style picker offers to switch to; every other palette still works with either style. All four areas are in scope: app shell and dashboard, the transactions register, the entry forms, and phone layouts. Each screen is checked against its mockup with screenshots in every style before it is called done.

### 4.1 The variant pattern

A screen whose structure differs by style keeps ONE owner component that computes its data, and renders through `renderForStyle(useUiStyle(), VARIANTS, props)` (`frontend/src/hooks/useUiStyle.ts`):

- The data (fetches, store reads, derived figures, handlers) stays where it is today: in the owner, or in a `use<Thing>Model()` hook extracted from it when a variant needs the same values. **A variant renders; it never fetches or derives a figure.** A fix to the data then reaches every style at once, and a fourth style is markup only.
- The Standard markup moves, unchanged, into `<Thing>Standard`; `Classic<Thing>` and `Modern<Thing>` sit beside it (`components/<feature>/variants/`). `VARIANTS` is a module constant; a style without its own variant falls back to Standard.
- Shared money typesetting is `MoneyFigure` (`components/ui/MoneyFigure.tsx`, `display` for a headline figure), styled per style in `ui-styles.css`. Colours in a variant are ramp utilities only (`bg-gray-900`, `text-blue-600`), so a variant still follows the palette.
- Prefer CSS (section 2) when the difference is a skin; a variant is for a different arrangement. Each variant gets a render test per style.

### 4.2 Areas and the mockups they follow

| Area | Classic mockup | Modern mockup | Main components |
|---|---|---|---|
| Shell | header and nav of `Main.dc.html` / `Register.dc.html` | header of `ModernDashboard.dc.html` | `AppHeader`, `PageHeader`, `WidgetCard` |
| Dashboard | `Main.dc.html`: statement net worth, stepped history line, ruled sections for favourites and the next fourteen days | `ModernDashboard.dc.html`: inverted hero block, next-up accent card, white blocks | `DashboardHero`, `NetWorthHero`, `FavouriteAccounts`, `UpcomingBills`, `WidgetCard` |
| Register | `Register.dc.html`: Payment / Deposit columns, date group rows, green-bar bands, balance rule; `Mobile.dc.html` | `ModernTransactions.dc.html`: list with a selected-row inspector; `ModernMobile.dc.html` | `TransactionList`, `TransactionRow`, the account page |
| Entry | `EntrySlip.dc.html`: the transaction form as a ruled slip | `ModernQuickAdd.dc.html`: the existing quick add, restyled | `TransactionForm` dialog, `quick-add/*` |
| Vocabulary | `Vocabulary.dc.html`: figures, marks and meters | (the same pieces in Modern dress) | `Badge`, status marks, progress meters |

The mockups live in the "Monize UI directions" canvas (`project/*.dc.html`).

### 4.3 Coverage still to widen

About 140 `<table>` elements do not use `TABLE_CLASS` / `TH_CLASS` and miss the Classic ruling; `SortableHeader` deliberately does not take `TH_CLASS`. Move them as their screens are touched.

## 5. Open questions

1. Should the boot splash and the PWA manifest follow the style? Today they follow only the palette, which is correct because they are colour.
