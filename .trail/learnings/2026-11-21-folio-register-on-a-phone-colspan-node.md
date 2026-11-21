---
title: "Folio register on a phone: colSpan over colCount widens the tier table; WebKit repro recipe"
author: Node
date: 2026-11-21
branch: claude/issue-2305
cost: { minutes: 35, tokens: 223358 }
touches:
  - frontend/src/hooks/useTableDensity.ts
  - docs/frontend/tables-and-registers.md
  - frontend/src/app/ui-styles-register.css
  - frontend/src/components/transactions/TransactionList.tsx
  - frontend/src/components/transactions/TransactionList.uiStyles.test.tsx
  - frontend/src/components/transactions/variants/FolioRegisterFoot.tsx
---

## Decided
- Any row laid under the register's tier-table columns (Folio totals) is built cell for cell from REGISTER_COLUMN_ORDER with registerColumnClass(id) (`variants/FolioRegisterFoot.tsx`). colCount counts columns the container tiers hide by class, so colSpan arithmetic over it put totals past the table edge on a phone (table 566px in a 356px wrapper, payee 24px) and under Status/Actions at an 1100px register.
- Folio uses the `wide` density scale (half the phone inset; identical from sm up). Below a 40rem register container, Folio's thead tracking drops to 0.04em and the payee header's flex div wraps with `overflow-wrap: anywhere`.
- Label rows (date group, today divider) may keep colSpan={colCount}: the phantom grid columns hold no cells and measured at zero width.

## Tried and ruled out
- Hand-writing footer cells with registerColumnClass('<id>') literals in TransactionList.tsx: register-columns.guard.test.ts requires each file to name the literals once, in column order, and gated on the line before.
- `overflow-wrap: break-word` (and `hyphens: auto`) for a long one-word header ("Zahlungsempfaenger"): the label is an anonymous flex item whose min-width:auto is its longest word, so nothing breaks; `anywhere` lowers min-content and does.

## Watch out
- Phone repro that works here: e2e compose with an override (ports !reset [], backend NODE_OPTIONS=4096, DISABLE_HTTPS_HEADERS=true on backend AND frontend, `./frontend/src:/app/src` bind mount for hot reload), Playwright image on the issue-N_e2e-network with a node TCP proxy localhost:3001 -> frontend:3000. Register via API, then log in through the /login form (API cookies alone left the page on /login). Density is localStorage `monize-density` = {state:{densities:{transactions:'dense'}},version:0}. The same Folio defect shows in Chromium, so it is not WebKit-only.
