# Shared expenses UI consistency captures

Captured on 29 October 2026 from the running native production builds with
synthetic users and data. These are Playwright screenshots, with no image editing.
The common Modal title/header still uses the upstream component; its chrome is
separate work.

| Capture | Scenario |
| --- | --- |
| `groups-overview.png` | Saved dinner, overview totals, live group search and status counts. |
| `unified-split.png` | Three-person expense, fixed 80 and equal 110/110 remainder, followed by persistence checks. |
| `group-detail.png` | The saved expense, summary cards, visible filters, navigation and export. |
| `trip-mobile.png` | Six-person trip, payer independent of beneficiaries, fixed coffee and zero shares, 390px. |
| `repayments-mobile.png` | Partial repayment retained after reload, distinct custom repayment action. |
| `group-files.png` | A standalone group file attached to a saved expense without duplication. |

The expense/file journeys are in `e2e/tests/shared-expenses.spec.ts`; the trip
journey is in `e2e/tests/shared-expenses-review.spec.ts`. The overview comes from
the corrected ordinary-save run; split/detail/phone/repayment captures come from
the final split run. The file capture comes from the initial passing file journey;
its rendered screen was unaffected by the later split-input correction.

See `docs/future-plans/shared-expenses-ui-consistency-tasks.md` for the verification
ledger, including failed attempts and focused corrections. The browser fixture
uses RLS off; separate PostgreSQL integration tests verify enforced RLS.
