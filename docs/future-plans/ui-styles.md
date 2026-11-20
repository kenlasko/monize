# UI styles: Standard, Classic and Modern as selectable looks over every colour theme

> Companion task list: [`ui-styles-tasks.md`](./ui-styles-tasks.md).

Status: **phase 1 built** on branch `feat/ui-styles-classic-modern` (2026-11-20). Phase 2 is a proposal. The source designs are the "Monize UI directions" canvas: its *Ledger* page became **Classic**, its *Contemporary* page became **Modern**.

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

## 4. Phase 2: structure, not skin (proposal)

Parts of the designs are layouts, not styles, and CSS cannot honestly produce them. Each is a component branch on `useTheme().uiStyle`, added only where it earns its keep, one PR each:

- Classic register: separate Payment and Deposit columns and a balance rule under each running balance (`Register.dc.html`).
- Classic dashboard: net worth set as a statement figure with a stepped history line (`Main.dc.html`).
- Modern dashboard: the inverted hero block and the "next up" accent card (`ModernDashboard.dc.html`).
- Modern transactions: a side inspector for the selected row (`ModernTransactions.dc.html`).
- Modern quick add: type-to-enter with parsed chips (`ModernQuickAdd.dc.html`); this one is a feature in its own right and needs its own discussion.

Coverage to widen as screens are touched: tables that do not use `TABLE_CLASS` / `TH_CLASS` (about 140 `<table>` elements, against roughly 475 uses of the shared table constants) miss the Classic ruling, and `SortableHeader` deliberately does not take `TH_CLASS`.

## 5. Open questions

1. Should each style offer a companion palette (the ledger's green-and-gold, the contemporary lime)? They would be ordinary entries in `themes.css`, not part of the style.
2. Should the boot splash and the PWA manifest follow the style? Today they follow only the palette, which is correct because they are colour.
