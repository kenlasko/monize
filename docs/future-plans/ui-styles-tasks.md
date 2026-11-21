# UI styles: task list

> Companion to [`ui-styles.md`](./ui-styles.md) (the design). One task per PR.

## Read first, every task

- A style names no colour: every colour in `frontend/src/app/ui-styles.css` is a gray/blue ramp token or a `color-mix` of one.
- Reach a component through a token first, a marker class second, an unlayered rule last (design section 2).
- Definition of done: from `frontend/`, `npm run lint && npm run type-check && npm run i18n:check`, the changed specs, `npm run test:changed`, `npm run build`. A changed screen updates its `website/docs/*.md` page and screenshots.

## Tasks

| Id | Task | Status |
|---|---|---|
| UIS-1 | Preference plumbing across database, backend and frontend; `UiStyleSelector` | built |
| UIS-2 | `ui-styles.css`, `ui-style-fonts.ts`, tokens and markers on the shared primitives | built |
| UIS-3 | Regenerate the Settings screenshots in `website/docs/settings-and-security.md` | open |
| UIS-4 | Foundation: `useUiStyle` / `renderForStyle`, `MoneyFigure`, the variant pattern (design 4.1) | built |
| UIS-5 | Companion palettes `ledger` and `studio`; each style offers only its own palettes (`UI_STYLE_PALETTES`) | built |
| UIS-6 | Shell and dashboard variants, checked against `Main` / `ModernDashboard` | built |
| UIS-7 | Register variants (desktop and phone), checked against `Register` / `Mobile` / `ModernTransactions` / `ModernMobile` | built |
| UIS-8 | Entry variants, checked against `EntrySlip` / `ModernQuickAdd` | built |
| UIS-9 | Vocabulary: badges, marks and meters in each style | open |
| UIS-10 | Move remaining hand-rolled tables onto `TABLE_CLASS` / `TH_CLASS` as their screens are touched | ongoing |
