# Shared expenses final review captures

Captured on 30 October 2026 by Playwright from the running native application,
using synthetic users and data. These are unedited screenshots. The frontend
runs in Next development mode (its indicator is visible); the backend is a
production build. The browser fixture database has RLS off. Separate integration
tests verify enforced RLS. These captures do not establish a frontend production
build result.

| Capture | Scenario |
| --- | --- |
| `group-desktop.png` | Spacing below group tabs, standard top paging/count/export controls and a saved expense. |
| `group-phone.png` | The same persisted group at 390px, with responsive filters, pager and expense row. |
| `expense-attachments.png` | Common upstream Modal, explicit Close/Edit actions and space above attachments; the focused review help is open. |
| `filtered-groups.png` | One matching group out of 26, a correct filtered count and disabled single-page navigation. |

The source is `e2e/tests/shared-expenses-final-review.spec.ts`. Its layout case
measures the rendered gaps at 1280px and 390px and exercises Cancel and Close.
Its paging case navigates with both top and bottom controls and repeats after
reload. The first layout attempt hit the development server's cold-route offline
fallback; the subsequent layout run passed. The paging case passed initially.

See `docs/future-plans/shared-expenses-ui-consistency-tasks.md` for the full
verification ledger and the local frontend build limitation. Earlier screenshots
and the original video retain their original revision dates.
